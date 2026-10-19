/* ==========================================================================
   Configuração e Integração com Firebase / Firestore - Meu Mercado PWA
   Conexão opcional com Firestore + Offline First
   
   IMPORTANTE DE SEGURANÇA:
   - Chaves de API de IA (ex: Claude API / Gemini) NUNCA devem estar aqui.
   - Chamadas de visão computacional da Fase 2 usarão o endpoint de proxy seguro abaixo.
   ========================================================================== */

// Configuração padrão do Firebase (pode ser sobrescrita pelo usuário nas configurações do App)
export const DEFAULT_FIREBASE_CONFIG = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};

// URL do Backend / Proxy seguro (Cloud Function) para IA de Visão na Fase 2
export const API_VISION_PROXY_URL = "/api/vision-etiqueta";

let firestoreInstance = null;
let authInstance = null;
let isFirebaseInitialized = false;

/**
 * Inicializa o Firestore e Auth se as credenciais estiverem preenchidas
 */
export async function initFirebase(customConfig = null) {
  const config = customConfig || DEFAULT_FIREBASE_CONFIG;
  
  if (!config.projectId || !config.apiKey) {
    console.info('[Firebase] Credenciais não informadas. Operando 100% no modo local (IndexedDB offline-first).');
    return null;
  }

  try {
    // Importação dinâmica do Firebase v10 modular via ESM CDN
    const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js');
    const { persistentLocalCache, initializeFirestore } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    const { getAuth, signInAnonymously } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js');

    const app = initializeApp(config);
    
    // Inicializa o Firestore já com cache persistente local
    firestoreInstance = initializeFirestore(app, {
      localCache: persistentLocalCache()
    });

    // Inicializa Firebase Auth para proteção das Cloud Functions e regras de segurança
    authInstance = getAuth(app);
    if (!authInstance.currentUser) {
      await signInAnonymously(authInstance);
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
 * Verifica se o Firestore está configurado e ativo
 */
export function isFirestoreActive() {
  return isFirebaseInitialized && firestoreInstance !== null;
}

