/* ==========================================================================
   Configuração e Integração com Firebase / Firestore - Meu Mercado PWA
   Conexão opcional com Firestore + Storage + Offline First
   
   IMPORTANTE DE SEGURANÇA:
   - Chaves de API de IA (ex: Claude API / Gemini) NUNCA devem estar aqui.
   - A configuração Web do Firebase é pública por design e protegida por Security Rules.
   ========================================================================== */

import { getConfig, setConfig } from './db.js';

// Configuração padrão do Firebase (pode ser sobrescrita pelo usuário nas configurações do App)
export const DEFAULT_FIREBASE_CONFIG = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};

let firestoreInstance = null;
let authInstance = null;
let storageInstance = null;
let isFirebaseInitialized = false;

/**
 * Carrega a configuração salva pelo usuário no IndexedDB ou usa a padrão
 */
export async function getActiveFirebaseConfig() {
  const customConfig = await getConfig('firebaseConfig');
  if (customConfig && customConfig.projectId && customConfig.apiKey) {
    return customConfig;
  }
  return DEFAULT_FIREBASE_CONFIG;
}

/**
 * Salva uma nova configuração do Firebase no IndexedDB
 */
export async function saveActiveFirebaseConfig(newConfig) {
  await setConfig('firebaseConfig', newConfig);
  // Reinicia a conexão
  isFirebaseInitialized = false;
  firestoreInstance = null;
  authInstance = null;
  storageInstance = null;
  return await initFirebase(newConfig);
}

/**
 * Inicializa o Firestore, Auth e Storage se as credenciais estiverem preenchidas
 */
export async function initFirebase(customConfig = null) {
  const config = customConfig || (await getActiveFirebaseConfig());

  if (!config.projectId || !config.apiKey) {
    console.info('[Firebase] Configuração ausente. Operando 100% no modo local (IndexedDB offline-first).');
    return null;
  }

  try {
    // Importação dinâmica dos módulos oficiais do Firebase v10 via ESM CDN
    const { initializeApp, getApps } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js');
    const { persistentLocalCache, initializeFirestore, getFirestore } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    const { getAuth, signInAnonymously } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js');

    const app = getApps().length > 0 ? getApps()[0] : initializeApp(config);

    // 1. Inicializa o Firestore com cache persistente local
    try {
      firestoreInstance = initializeFirestore(app, {
        localCache: persistentLocalCache()
      });
    } catch (fsErr) {
      firestoreInstance = getFirestore(app);
    }

    // 2. Inicializa Firebase Auth para proteção das chamadas e regras
    authInstance = getAuth(app);
    if (!authInstance.currentUser) {
      await signInAnonymously(authInstance);
    }

    // 3. Inicializa Firebase Storage (para fotos de etiquetas e notas)
    if (config.storageBucket) {
      try {
        const { getStorage } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js');
        storageInstance = getStorage(app);
      } catch (stErr) {
        console.warn('[Firebase Storage] Não foi possível carregar o módulo de Storage:', stErr);
      }
    }

    isFirebaseInitialized = true;
    console.info('[Firebase] Firestore e Auth conectados com sucesso!');
    return firestoreInstance;
  } catch (error) {
    console.warn('[Firebase] Não foi possível conectar ao Firebase online. Usando IndexedDB local.', error);
    return null;
  }
}

/**
 * Retorna o ID Token do usuário autenticado para envio nos headers de APIs seguras
 */
export async function getAuthToken() {
  if (!authInstance) return null;
  try {
    if (!authInstance.currentUser) {
      const { signInAnonymously } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js');
      await signInAnonymously(authInstance);
    }
    return authInstance.currentUser ? await authInstance.currentUser.getIdToken() : null;
  } catch (err) {
    console.warn('[Firebase Auth] Erro ao obter token:', err);
    return null;
  }
}

/**
 * Retorna o UID do usuário autenticado no Firebase
 */
export function getFirebaseUserId() {
  return authInstance && authInstance.currentUser ? authInstance.currentUser.uid : null;
}

/**
 * Retorna a instância ativa do Firestore
 */
export function getFirestoreInstance() {
  return firestoreInstance;
}

/**
 * Retorna a instância ativa do Storage
 */
export function getStorageInstance() {
  return storageInstance;
}

/**
 * Verifica se o Firestore está configurado e ativo
 */
export function isFirestoreActive() {
  return isFirebaseInitialized && firestoreInstance !== null;
}

/**
 * Envia uma imagem Base64 para o Firebase Storage e retorna sua URL pública/autenticada
 */
export async function uploadPhotoToStorage(base64DataUrl, storagePath) {
  if (!storageInstance) {
    console.warn('[Storage] Firebase Storage não configurado.');
    return null;
  }

  try {
    const { ref, uploadString, getDownloadURL } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js');
    const imageRef = ref(storageInstance, storagePath);
    
    // Faz o upload direto do formato data_url base64
    await uploadString(imageRef, base64DataUrl, 'data_url');
    const downloadUrl = await getDownloadURL(imageRef);
    return downloadUrl;
  } catch (err) {
    console.warn('[Storage] Falha no upload da foto para o Firebase Storage:', err);
    return null;
  }
}
