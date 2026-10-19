/* ==========================================================================
   Motor de Sincronização em Segundo Plano - Meu Mercado PWA
   IndexedDB (Offline Cache) <== Bidirecional (LWW) ==> Cloud Firestore & Storage
   ========================================================================== */

import {
  initDB,
  getSyncQueue,
  removeSyncQueueItem,
  getAllLists,
  saveList,
  getListById,
  getAllPrecos,
  savePreco,
  getAllNotas,
  saveNota,
  getConfig,
  setConfig,
  registerLocalChangeListener
} from './db.js';

import {
  isFirestoreActive,
  getFirestoreInstance,
  getFirebaseUserId,
  uploadPhotoToStorage
} from './firebase-config.js';

import { state } from './state.js';

// Estados possíveis: 'sincronizado', 'pendente', 'sincronizando', 'offline'
let currentSyncState = 'offline';
let lastSyncTimestamp = null;
let isSyncing = false;
let syncListeners = [];
let firestoreUnsubscribers = [];

/**
 * Registra um callback para ser notificado sobre mudanças no status de sincronização
 */
export function onSyncStatusChange(callback) {
  syncListeners.push(callback);
  // Notifica o estado atual imediatamente
  notifySyncState();
}

/**
 * Notifica todos os ouvintes sobre o estado atual
 */
async function notifySyncState() {
  const queue = await getSyncQueue().catch(() => []);
  const pendingCount = queue.length;

  let computedState = currentSyncState;
  if (!navigator.onLine) {
    computedState = 'offline';
  } else if (isSyncing) {
    computedState = 'sincronizando';
  } else if (pendingCount > 0) {
    computedState = 'pendente';
  } else if (isFirestoreActive()) {
    computedState = 'sincronizado';
  } else {
    computedState = 'offline';
  }

  currentSyncState = computedState;

  const payload = {
    state: computedState,
    pendingCount,
    lastSyncTimestamp,
    isOnline: navigator.onLine,
    isFirestoreActive: isFirestoreActive()
  };

  syncListeners.forEach((listener) => {
    try {
      listener(payload);
    } catch (e) {
      console.warn('[Sync] Erro no ouvinte de status:', e);
    }
  });
}

/**
 * Retorna o status atual da sincronização
 */
export async function getSyncStatus() {
  const queue = await getSyncQueue().catch(() => []);
  return {
    state: currentSyncState,
    pendingCount: queue.length,
    lastSyncTimestamp,
    isOnline: navigator.onLine,
    isFirestoreActive: isFirestoreActive()
  };
}

/**
 * Inicializa o motor de sincronização
 */
export async function initSync() {
  // 1. Escuta eventos nativos de conectividade
  window.addEventListener('online', () => {
    console.info('[Sync] Dispositivo voltou a ficar ONLINE. Iniciando sincronização...');
    triggerSync();
  });

  window.addEventListener('offline', () => {
    console.info('[Sync] Dispositivo OFFLINE. Modo 100% cache local ativado.');
    notifySyncState();
  });

  // 2. Escuta alterações locais no IndexedDB
  registerLocalChangeListener(() => {
    notifySyncState();
    if (navigator.onLine && isFirestoreActive()) {
      debouncedSync();
    }
  });

  // 3. Executa migração inicial se houver dados locais não sincronizados
  await checkAndPerformInitialMigration();

  // 4. Inicia primeira sincronização se estiver online
  if (navigator.onLine && isFirestoreActive()) {
    await triggerSync();
    setupRealtimeListeners();
  } else {
    notifySyncState();
  }

  // 5. Polling leve a cada 60 segundos ou quando a aba volta ao foco
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && navigator.onLine && isFirestoreActive()) {
      triggerSync();
    }
  });

  setInterval(() => {
    if (navigator.onLine && isFirestoreActive() && !isSyncing) {
      triggerSync();
    }
  }, 60000);
}

let syncTimeout = null;
function debouncedSync() {
  if (syncTimeout) clearTimeout(syncTimeout);
  syncTimeout = setTimeout(() => {
    triggerSync();
  }, 2000);
}

/**
 * Força a execução imediata da sincronização bidirecional
 */
export async function triggerSync() {
  if (isSyncing) return;
  if (!navigator.onLine || !isFirestoreActive()) {
    notifySyncState();
    return;
  }

  isSyncing = true;
  notifySyncState();

  try {
    // 1. Envia mutações locais pendentes para o Firestore
    await processSyncQueue();

    // 2. Puxa alterações remotas feitas em outros aparelhos (Last-Write-Wins)
    await pullRemoteChanges();

    lastSyncTimestamp = new Date();
  } catch (error) {
    console.warn('[Sync] Falha durante sincronização com Firestore:', error);
  } finally {
    isSyncing = false;
    notifySyncState();
  }
}

/**
 * Processa a fila de envio (Local -> Nuvem)
 */
async function processSyncQueue() {
  const queue = await getSyncQueue();
  if (queue.length === 0) return;

  const db = getFirestoreInstance();
  const uid = getFirebaseUserId();
  if (!db || !uid) return;

  const { doc, setDoc, deleteDoc } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

  for (const item of queue) {
    try {
      const docRef = doc(db, 'users', uid, item.collection, item.docId);

      if (item.action === 'delete') {
        // Soft delete no Firestore para sincronizar a deleção com outros aparelhos
        await setDoc(
          docRef,
          {
            id: item.docId,
            userId: uid,
            _deleted: true,
            updatedAt: new Date().toISOString()
          },
          { merge: true }
        );
      } else {
        const docData = { ...item.data, userId: uid };

        // Upload de foto pendente para o Firebase Storage
        if (docData.fotoUrl && docData.fotoUrl.startsWith('data:image')) {
          const storagePath = `users/${uid}/fotos/${item.docId}_${Date.now()}.jpg`;
          const uploadedUrl = await uploadPhotoToStorage(docData.fotoUrl, storagePath);
          if (uploadedUrl) {
            docData.fotoUrl = uploadedUrl;
            // Atualiza o registro local com a URL na nuvem
            if (item.collection === 'precos') {
              await savePreco(docData, true);
            } else if (item.collection === 'notas') {
              await saveNota(docData, true);
            }
          }
        }

        await setDoc(docRef, docData, { merge: true });
      }

      // Remove da fila com sucesso
      await removeSyncQueueItem(item.id);
    } catch (itemErr) {
      console.warn(`[Sync] Erro ao sincronizar item ${item.id}:`, itemErr);
      // Mantém na fila para tentar novamente
    }
  }
}

/**
 * Puxa alterações remotas do Firestore e aplica localmente com estratégia Last-Write-Wins
 */
async function pullRemoteChanges() {
  const db = getFirestoreInstance();
  const uid = getFirebaseUserId();
  if (!db || !uid) return;

  const { collection, getDocs, query } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

  // Coleções para puxar
  const collectionsToSync = ['listas', 'precos', 'notas'];
  let hasUiUpdates = false;

  for (const colName of collectionsToSync) {
    try {
      const colRef = collection(db, 'users', uid, colName);
      const snapshot = await getDocs(query(colRef));

      for (const docSnap of snapshot.docs) {
        const remoteData = docSnap.data();
        if (!remoteData || !remoteData.id) continue;

        if (colName === 'listas') {
          const localList = await getListById(remoteData.id);
          if (!localList || shouldRemoteOverwrite(remoteData, localList)) {
            await saveList(remoteData, true);
            // Se for a lista ativa que mudou remotamente, atualiza o estado
            if (state.currentList && state.currentList.id === remoteData.id) {
              state.currentList = remoteData;
              hasUiUpdates = true;
            }
          }
        } else if (colName === 'precos') {
          const allPrecos = await getAllPrecos();
          const localPreco = allPrecos.find((p) => p.id === remoteData.id);
          if (!localPreco || shouldRemoteOverwrite(remoteData, localPreco)) {
            await savePreco(remoteData, true);
          }
        } else if (colName === 'notas') {
          const allNotas = await getAllNotas();
          const localNota = allNotas.find((n) => n.id === remoteData.id);
          if (!localNota || shouldRemoteOverwrite(remoteData, localNota)) {
            await saveNota(remoteData, true);
          }
        }
      }
    } catch (pullErr) {
      console.warn(`[Sync] Erro ao puxar coleção ${colName}:`, pullErr);
    }
  }

  // Se a lista ativa foi atualizada por outro aparelho, re-renderiza a tela suavemente
  if (hasUiUpdates && typeof window.renderActiveList === 'function') {
    window.renderActiveList();
  }
}

/**
 * Estratégia de Conflito: Last-Write-Wins (LWW) baseada em timestamp ISO
 */
function shouldRemoteOverwrite(remote, local) {
  if (!local.updatedAt) return true;
  if (!remote.updatedAt) return false;
  return new Date(remote.updatedAt).getTime() > new Date(local.updatedAt).getTime();
}

/**
 * Listeners em tempo real via Firestore onSnapshot
 */
async function setupRealtimeListeners() {
  const db = getFirestoreInstance();
  const uid = getFirebaseUserId();
  if (!db || !uid) return;

  // Limpa listeners antigos
  firestoreUnsubscribers.forEach((unsub) => unsub());
  firestoreUnsubscribers = [];

  try {
    const { collection, onSnapshot } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

    // Listener para Listas
    const listColRef = collection(db, 'users', uid, 'listas');
    const unsubLists = onSnapshot(listColRef, async (snapshot) => {
      let uiUpdated = false;
      for (const change of snapshot.docChanges()) {
        const remoteData = change.doc.data();
        if (!remoteData || !remoteData.id) continue;

        if (change.type === 'added' || change.type === 'modified') {
          const localList = await getListById(remoteData.id);
          if (!localList || shouldRemoteOverwrite(remoteData, localList)) {
            await saveList(remoteData, true);
            if (state.currentList && state.currentList.id === remoteData.id) {
              state.currentList = remoteData;
              uiUpdated = true;
            }
          }
        }
      }

      if (uiUpdated && typeof window.renderActiveList === 'function') {
        window.renderActiveList();
      }
    });

    firestoreUnsubscribers.push(unsubLists);
  } catch (err) {
    console.warn('[Sync] Falha ao configurar listeners em tempo real:', err);
  }
}

/**
 * Migração: Envia os dados que já existem no IndexedDB para o Firestore sem duplicar
 */
async function checkAndPerformInitialMigration() {
  const isMigrated = await getConfig('migracaoInicialConcluida');
  if (isMigrated) return;

  console.info('[Sync] Iniciando migração de dados do IndexedDB para o Firestore...');

  try {
    const allLists = await getAllLists();
    const allPrecos = await getAllPrecos();
    const allNotas = await getAllNotas();

    // Enfileira todas as listas existentes
    for (const list of allLists) {
      await saveList(list); // saveList já enfileira na sync_queue com timestamp
    }

    // Enfileira todos os preços existentes
    for (const preco of allPrecos) {
      await savePreco(preco);
    }

    // Enfileira todas as notas
    for (const nota of allNotas) {
      await saveNota(nota);
    }

    await setConfig('migracaoInicialConcluida', true);
    console.info(`[Sync] Migração concluída: ${allLists.length} listas, ${allPrecos.length} preços preparados para backup.`);
    notifySyncState();
  } catch (migErr) {
    console.warn('[Sync] Erro na migração inicial:', migErr);
  }
}
