/* ==========================================================================
   Camada de Banco de Dados Local (IndexedDB) - Meu Mercado PWA
   Offline-first: Garante funcionamento veloz mesmo sem sinal no mercado
   ========================================================================== */

const DB_NAME = 'mercado_pwa_db';
const DB_VERSION = 1;

let dbInstance = null;

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

      // Store para Listas de Compras
      if (!db.objectStoreNames.contains('listas')) {
        const listasStore = db.createObjectStore('listas', { keyPath: 'id' });
        listasStore.createIndex('dataCriacao', 'dataCriacao', { unique: false });
      }

      // Store para Histórico de Preços (preparado para Fases 2 e 3)
      if (!db.objectStoreNames.contains('precos')) {
        const precosStore = db.createObjectStore('precos', { keyPath: 'id' });
        precosStore.createIndex('itemId', 'itemId', { unique: false });
        precosStore.createIndex('data', 'data', { unique: false });
      }

      // Store de Configurações gerais (lista ativa, sincronização)
      if (!db.objectStoreNames.contains('config')) {
        db.createObjectStore('config', { keyPath: 'chave' });
      }
    };
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

    request.onsuccess = () => resolve(request.result || []);
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

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Salva ou atualiza uma lista inteira
 */
export async function saveList(lista) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['listas'], 'readwrite');
    const store = transaction.objectStore('listas');
    const request = store.put(lista);

    request.onsuccess = () => resolve(lista);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Remove uma lista
 */
export async function deleteList(id) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['listas'], 'readwrite');
    const store = transaction.objectStore('listas');
    const request = store.delete(id);

    request.onsuccess = () => resolve(true);
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
    itens: [
      {
        id: 'item_1',
        nome: 'Arroz 5kg',
        categoria: 'Mercearia',
        qtdPlanejada: 1,
        precoEstimado: 28.90,
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
        precoEstimado: 7.50,
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
