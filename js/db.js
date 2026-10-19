/* ==========================================================================
   Camada de Banco de Dados Local (IndexedDB) - Meu Mercado PWA
   Offline-first: Garante funcionamento veloz mesmo sem sinal no mercado
   Stores: listas, precos, notas, config, sync_queue
   ========================================================================== */

const DB_NAME = 'mercado_pwa_db';
const DB_VERSION = 2; // Versão 2: Adiciona store de notas e fila de sincronização

let dbInstance = null;

// Listener para notificar o sync manager de novas alterações locais
let onLocalChangeCallback = null;

export function registerLocalChangeListener(callback) {
  onLocalChangeCallback = callback;
}

function notifyLocalChange() {
  if (typeof onLocalChangeCallback === 'function') {
    try {
      onLocalChangeCallback();
    } catch (e) {
      console.warn('[DB] Erro no listener de sincronização:', e);
    }
  }
}

/**
 * Inicializa a conexão com o IndexedDB e cria os Object Stores
 */
export function initDB() {
  return new Promise((resolve, reject) => {
    if (dbInstance) {
      resolve(dbInstance);
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = (event) => {
      console.error('[DB] Erro ao abrir IndexedDB:', event.target.error);
      reject(event.target.error);
    };

    request.onsuccess = (event) => {
      dbInstance = event.target.result;
      resolve(dbInstance);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // 1. Store para Listas de Compras
      if (!db.objectStoreNames.contains('listas')) {
        const listasStore = db.createObjectStore('listas', { keyPath: 'id' });
        listasStore.createIndex('dataCriacao', 'dataCriacao', { unique: false });
        listasStore.createIndex('updatedAt', 'updatedAt', { unique: false });
      }

      // 2. Store para Histórico de Preços (Fases 2 e 3)
      if (!db.objectStoreNames.contains('precos')) {
        const precosStore = db.createObjectStore('precos', { keyPath: 'id' });
        precosStore.createIndex('itemId', 'itemId', { unique: false });
        precosStore.createIndex('data', 'data', { unique: false });
        precosStore.createIndex('updatedAt', 'updatedAt', { unique: false });
      }

      // 3. Store para Notas Fiscais (Fase 4 & Sincronização)
      if (!db.objectStoreNames.contains('notas')) {
        const notasStore = db.createObjectStore('notas', { keyPath: 'id' });
        notasStore.createIndex('data', 'data', { unique: false });
        notasStore.createIndex('status', 'status', { unique: false });
        notasStore.createIndex('updatedAt', 'updatedAt', { unique: false });
      }

      // 4. Store de Configurações gerais (lista ativa, sincronização, credenciais)
      if (!db.objectStoreNames.contains('config')) {
        db.createObjectStore('config', { keyPath: 'chave' });
      }

      // 5. Fila de Sincronização Offline -> Firestore
      if (!db.objectStoreNames.contains('sync_queue')) {
        const queueStore = db.createObjectStore('sync_queue', { keyPath: 'id' });
        queueStore.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
  });
}

/**
 * Enfileira uma mutação na fila de sincronização
 */
export async function enqueueSync(collection, docId, action, data = null) {
  const db = await initDB();
  const queueEntry = {
    id: `${collection}_${docId}`,
    collection,
    docId,
    action, // 'upsert' | 'delete'
    data: data ? JSON.parse(JSON.stringify(data)) : null,
    timestamp: Date.now()
  };

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['sync_queue'], 'readwrite');
    const store = transaction.objectStore('sync_queue');
    const request = store.put(queueEntry);

    request.onsuccess = () => {
      resolve(queueEntry);
      notifyLocalChange();
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Retorna todos os itens pendentes na fila de sincronização
 */
export async function getSyncQueue() {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['sync_queue'], 'readonly');
    const store = transaction.objectStore('sync_queue');
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Remove um item da fila após sincronizado com sucesso
 */
export async function removeSyncQueueItem(id) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['sync_queue'], 'readwrite');
    const store = transaction.objectStore('sync_queue');
    const request = store.delete(id);

    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Retorna todas as listas salvas
 */
export async function getAllLists() {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['listas'], 'readonly');
    const store = transaction.objectStore('listas');
    const request = store.getAll();

    request.onsuccess = () => {
      const results = (request.result || []).filter((l) => !l._deleted);
      resolve(results);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Busca uma lista pelo ID
 */
export async function getListById(id) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['listas'], 'readonly');
    const store = transaction.objectStore('listas');
    const request = store.get(id);

    request.onsuccess = () => {
      const res = request.result;
      resolve(res && !res._deleted ? res : null);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Salva ou atualiza uma lista inteira (com timestamp e enfileiramento de sync)
 */
export async function saveList(lista, skipQueue = false) {
  const db = await initDB();
  lista.updatedAt = lista.updatedAt || new Date().toISOString();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['listas'], 'readwrite');
    const store = transaction.objectStore('listas');
    const request = store.put(lista);

    request.onsuccess = async () => {
      if (!skipQueue && !lista._deleted) {
        await enqueueSync('listas', lista.id, 'upsert', lista);
      }
      resolve(lista);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Remove uma lista (com suporte a propagação de deleção via sync)
 */
export async function deleteList(id, skipQueue = false) {
  const db = await initDB();
  const now = new Date().toISOString();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['listas'], 'readwrite');
    const store = transaction.objectStore('listas');
    // Marca como soft-deleted localmente ou deleta
    const request = store.delete(id);

    request.onsuccess = async () => {
      if (!skipQueue) {
        await enqueueSync('listas', id, 'delete', { id, _deleted: true, updatedAt: now });
      }
      resolve(true);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Salva uma chave de configuração
 */
export async function setConfig(chave, valor) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['config'], 'readwrite');
    const store = transaction.objectStore('config');
    const request = store.put({ chave, valor });

    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Recupera uma chave de configuração
 */
export async function getConfig(chave) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['config'], 'readonly');
    const store = transaction.objectStore('config');
    const request = store.get(chave);

    request.onsuccess = () => resolve(request.result ? request.result.valor : null);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Grava uma entrada no histórico de preços (Fase 2 & Fase 3)
 */
export async function savePreco(precoData, skipQueue = false) {
  const db = await initDB();
  const entry = {
    id: precoData.id || 'preco_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
    itemId: precoData.itemId || null,
    nomeItem: precoData.nomeItem || '',
    valor: Number(precoData.valor) || 0,
    peso: precoData.peso || '',
    unidade: precoData.unidade || 'un',
    precoPorKgLitro: precoData.precoPorKgLitro || null,
    quantidade: Number(precoData.quantidade) || 1,
    data: precoData.data || new Date().toISOString(),
    updatedAt: precoData.updatedAt || new Date().toISOString(),
    mercado: precoData.mercado || 'Mercado Geral',
    fotoUrl: precoData.fotoUrl || null,
    origem: precoData.origem || 'etiqueta',
    _deleted: precoData._deleted || false
  };

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['precos'], 'readwrite');
    const store = transaction.objectStore('precos');
    const request = store.put(entry);

    request.onsuccess = async () => {
      if (!skipQueue && !entry._deleted) {
        await enqueueSync('precos', entry.id, 'upsert', entry);
      }
      resolve(entry);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Retorna todos os preços registrados no histórico
 */
export async function getAllPrecos() {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['precos'], 'readonly');
    const store = transaction.objectStore('precos');
    const request = store.getAll();

    request.onsuccess = () => {
      const results = (request.result || []).filter((p) => !p._deleted);
      resolve(results);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Remove um preço do histórico
 */
export async function deletePreco(id, skipQueue = false) {
  const db = await initDB();
  const now = new Date().toISOString();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['precos'], 'readwrite');
    const store = transaction.objectStore('precos');
    const request = store.delete(id);

    request.onsuccess = async () => {
      if (!skipQueue) {
        await enqueueSync('precos', id, 'delete', { id, _deleted: true, updatedAt: now });
      }
      resolve(true);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Grava uma nota fiscal (Fase 4 & Sincronização)
 */
export async function saveNota(notaData, skipQueue = false) {
  const db = await initDB();
  const entry = {
    id: notaData.id || 'nota_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
    data: notaData.data || new Date().toISOString(),
    updatedAt: notaData.updatedAt || new Date().toISOString(),
    fotoUrl: notaData.fotoUrl || null,
    qrUrl: notaData.qrUrl || null,
    status: notaData.status || 'pendente', // 'pendente' | 'processada'
    itens: notaData.itens || [],
    total: Number(notaData.total) || 0,
    mercado: notaData.mercado || '',
    _deleted: notaData._deleted || false
  };

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['notas'], 'readwrite');
    const store = transaction.objectStore('notas');
    const request = store.put(entry);

    request.onsuccess = async () => {
      if (!skipQueue && !entry._deleted) {
        await enqueueSync('notas', entry.id, 'upsert', entry);
      }
      resolve(entry);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Retorna todas as notas fiscais cadastradas
 */
export async function getAllNotas() {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['notas'], 'readonly');
    const store = transaction.objectStore('notas');
    const request = store.getAll();

    request.onsuccess = () => {
      const results = (request.result || []).filter((n) => !n._deleted);
      resolve(results);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Cria uma lista inicial de exemplo se o usuário for novo, para que ele possa testar na hora
 */
export async function createDefaultListIfEmpty() {
  const lists = await getAllLists();
  if (lists.length > 0) {
    return lists[0];
  }

  const defaultList = {
    id: 'lista_' + Date.now(),
    nome: 'Compras da Semana',
    dataCriacao: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    itens: [
      {
        id: 'item_1',
        nome: 'Arroz 5kg',
        categoria: 'Mercearia',
        qtdPlanejada: 1,
        precoEstimado: 28.9,
        pego: false,
        qtdReal: 1,
        precoReal: 0,
        dataPego: null
      },
      {
        id: 'item_2',
        nome: 'Feijão Preto 1kg',
        categoria: 'Mercearia',
        qtdPlanejada: 2,
        precoEstimado: 7.5,
        pego: false,
        qtdReal: 2,
        precoReal: 0,
        dataPego: null
      },
      {
        id: 'item_3',
        nome: 'Leite Integral 1L',
        categoria: 'Laticínios',
        qtdPlanejada: 6,
        precoEstimado: 4.89,
        pego: false,
        qtdReal: 6,
        precoReal: 0,
        dataPego: null
      },
      {
        id: 'item_4',
        nome: 'Banana Prata (kg)',
        categoria: 'Hortifruti',
        qtdPlanejada: 1.5,
        precoEstimado: 6.99,
        pego: false,
        qtdReal: 1.5,
        precoReal: 0,
        dataPego: null
      },
      {
        id: 'item_5',
        nome: 'Detergente Líquido',
        categoria: 'Limpeza',
        qtdPlanejada: 3,
        precoEstimado: 2.49,
        pego: false,
        qtdReal: 3,
        precoReal: 0,
        dataPego: null
      }
    ]
  };

  await saveList(defaultList);
  await setConfig('activeListId', defaultList.id);
  return defaultList;
}
