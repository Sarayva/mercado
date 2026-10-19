/* ==========================================================================
   Aplicação Principal - Meu Mercado PWA
   Ponto de entrada, inicialização offline, PWA e eventos
   ========================================================================== */

import { initDB, createDefaultListIfEmpty, getConfig, getListById } from './db.js';
import { state, setCurrentList, setMode, subscribe } from './state.js';
import {
  renderUI,
  openAddItemModal,
  openListManagerModal,
  handleCameraScan,
  renderSyncBadge,
  openSyncModal,
  openPriceHistoryCatalogModal
} from './ui.js';
import { initFirebase } from './firebase-config.js';
import { initSync, onSyncStatusChange } from './sync.js';
import { seedInitialPriceHistoryIfEmpty } from './prices.js';

/**
 * Registra o Service Worker para habilitar o PWA e suporte offline
 */
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js')
        .then((reg) => {
          console.log('[PWA] Service Worker registrado com sucesso! Escopo:', reg.scope);
        })
        .catch((err) => {
          console.warn('[PWA] Falha ao registrar Service Worker:', err);
        });
    });
  }
}

/**
 * Inicialização do App
 */
async function bootstrap() {
  console.log('[App] Inicializando Meu Mercado PWA...');

  // 1. Inicializa o banco local IndexedDB
  await initDB();

  // 2. Popula dados históricos de demonstração se o histórico for novo (Fase 3)
  try {
    await seedInitialPriceHistoryIfEmpty();
  } catch (seedErr) {
    console.warn('[App] Erro ao verificar sementes históricas:', seedErr);
  }

  // 3. Busca lista ativa ou cria uma inicial de demonstração
  const savedActiveListId = await getConfig('activeListId');
  let activeList = null;

  if (savedActiveListId) {
    activeList = await getListById(savedActiveListId);
  }

  if (!activeList) {
    activeList = await createDefaultListIfEmpty();
  }

  setCurrentList(activeList);

  // 4. Inscreve a UI para renderizar sempre que o estado mudar
  subscribe(() => {
    renderUI();
  });

  // Exponibiliza renderActiveList para sincronizações remotas em segundo plano
  window.renderActiveList = () => renderUI();

  // Render inicial
  renderUI();

  // 5. Configura ouvintes de eventos da barra superior e botões fixos
  setupEventListeners();

  // 6. Registra o Service Worker PWA
  registerServiceWorker();

  // 7. Inicializa o Firebase e o motor de sincronização em segundo plano
  try {
    await initFirebase();
    onSyncStatusChange((payload) => {
      renderSyncBadge(payload);
    });
    await initSync();
  } catch (syncErr) {
    console.warn('[App] Sincronização em segundo plano iniciará quando possível:', syncErr);
  }
}

/**
 * Configura os ouvintes de clique globais
 */
function setupEventListeners() {
  // Botão do Histórico de Preços & Comparador no Header (Fase 3)
  const btnHistory = document.getElementById('btn-header-history');
  if (btnHistory) {
    btnHistory.addEventListener('click', () => {
      openPriceHistoryCatalogModal();
    });
  }

  // Badge de status de sincronização no header
  const btnSync = document.getElementById('sync-status-btn');
  if (btnSync) {
    btnSync.addEventListener('click', () => {
      openSyncModal();
    });
  }

  // Troca de lista (clique no nome da lista no header)
  const btnSelect = document.getElementById('header-list-select-btn');
  if (btnSelect) {
    btnSelect.addEventListener('click', () => {
      openListManagerModal();
    });
  }

  // Abas de Modo (Comprando vs Planejando)
  const tabComprando = document.getElementById('tab-mode-comprando');
  const tabPlanejando = document.getElementById('tab-mode-planejando');

  if (tabComprando) {
    tabComprando.addEventListener('click', () => {
      setMode('comprando');
    });
  }

  if (tabPlanejando) {
    tabPlanejando.addEventListener('click', () => {
      setMode('planejando');
    });
  }

  // Botão Fixo Inferior de Fotografar Etiqueta com IA
  const btnCameraBottom = document.getElementById('btn-camera-bottom');
  if (btnCameraBottom) {
    btnCameraBottom.addEventListener('click', () => {
      handleCameraScan();
    });
  }

  // Botão Fixo Inferior de Adicionar Item
  const btnAddBottom = document.getElementById('btn-add-item-bottom');
  if (btnAddBottom) {
    btnAddBottom.addEventListener('click', () => {
      openAddItemModal();
    });
  }

  // Previne zoom indesejado em toques duplos acidentais no mobile
  document.addEventListener('dblclick', (e) => {
    e.preventDefault();
  }, { passive: false });
}

// Inicia o app assim que o DOM estiver pronto (suporta carregamento deferido de módulos ES)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}

