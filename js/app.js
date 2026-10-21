/* ==========================================================================
   Aplicação Principal - Meu Mercado PWA
   Ponto de entrada, inicialização offline, PWA e eventos
   ========================================================================== */

import { initDB, createDefaultListIfEmpty, getConfig, setConfig, getListById } from './db.js';
import { state, setCurrentList, setMode, subscribe } from './state.js';
import {
  renderUI,
  openAddItemModal,
  openListManagerModal,
  openSettingsModal,
  handleCameraScan,
  renderSyncBadge,
  openSyncModal,
  openPriceHistoryCatalogModal,
  initTheme,
  toggleTheme
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
  console.log('[App] 1. Inicializando Meu Mercado PWA...');
  try {
    // 0. Inicializa e sincroniza o tema da aplicação (Claro/Escuro)
    initTheme();

    // 1. Inicializa o banco local IndexedDB
    console.log('[App] 2. Chamando initDB()...');
    await initDB();
    console.log('[App] 3. initDB() concluído com sucesso.');

    // Suporte a configuração de chave via URL (ex: ?key=...)
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const geminiParam = urlParams.get('geminiKey') || urlParams.get('key');
      if (geminiParam && geminiParam.trim().length > 10) {
        await setConfig('geminiApiKey', geminiParam.trim());
        console.log('[App] Chave do Gemini configurada via URL com sucesso!');
        urlParams.delete('geminiKey');
        urlParams.delete('key');
        const newQuery = urlParams.toString();
        const newUrl = window.location.pathname + (newQuery ? '?' + newQuery : '') + window.location.hash;
        window.history.replaceState({}, '', newUrl);
      }
    } catch (paramErr) {
      console.warn('[App] Erro ao ler parâmetro de chave da URL:', paramErr);
    }

    // 2. Popula dados históricos de demonstração se o histórico for novo (Fase 3)
    try {
      console.log('[App] 4. Semeando histórico se necessário...');
      await seedInitialPriceHistoryIfEmpty();
      console.log('[App] 5. Semeamento verificado.');
    } catch (seedErr) {
      console.warn('[App] Erro ao verificar sementes históricas:', seedErr);
    }

    // 3. Busca lista ativa ou cria uma inicial de demonstração
    console.log('[App] 6. Obtendo lista ativa...');
    let savedActiveListId = null;
    try {
      savedActiveListId = await getConfig('activeListId');
    } catch (e) {
      console.warn('[App] Erro ao ler activeListId:', e);
    }

    let activeList = null;
    if (savedActiveListId) {
      try {
        activeList = await getListById(savedActiveListId);
      } catch (e) {
        console.warn('[App] Erro ao buscar lista ativa:', e);
      }
    }

    if (!activeList) {
      console.log('[App] 7. Criando lista padrão...');
      activeList = await createDefaultListIfEmpty();
    }

    console.log('[App] 8. Definindo lista ativa no estado:', activeList ? activeList.nome : 'null');
    setCurrentList(activeList);

    // 4. Inscreve a UI para renderizar sempre que o estado mudar
    subscribe(() => {
      renderUI();
    });

    // Exponibiliza renderActiveList para sincronizações remotas em segundo plano
    window.renderActiveList = () => renderUI();

    // Render inicial
    console.log('[App] 9. Chamando renderUI()...');
    renderUI();
    console.log('[App] 10. renderUI() finalizado com sucesso!');

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
  } catch (fatalErr) {
    console.error('[App] ERRO FATAL no bootstrap:', fatalErr);
    const errEl = document.getElementById('debug-fatal-error') || document.createElement('div');
    errEl.id = 'debug-fatal-error';
    errEl.style = 'color:#ff4d4f;background:#1e1014;padding:12px;border:1px solid #ff4d4f;margin:10px;border-radius:8px;font-family:monospace;font-size:12px;z-index:99999;';
    errEl.textContent = 'BOOTSTRAP ERROR: ' + (fatalErr.message || fatalErr);
    document.body.prepend(errEl);
  }
}

/**
 * Configura os ouvintes de clique globais
 */
function setupEventListeners() {
  // Botão de Alternância Rápida de Tema (Claro / Escuro) no Header
  const btnTheme = document.getElementById('btn-theme-toggle');
  if (btnTheme) {
    btnTheme.addEventListener('click', () => {
      toggleTheme();
    });
  }

  // Botão de Configurações no Header
  const btnSettings = document.getElementById('btn-header-settings');
  if (btnSettings) {
    btnSettings.addEventListener('click', () => {
      openSettingsModal();
    });
  }

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

