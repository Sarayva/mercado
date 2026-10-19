/* ==========================================================================
   Camada de Interface do Usuário (UI) - Meu Mercado PWA (Mobile-First)
   Renderização fluida, Modais deslizantes, Toasts e Toque com uma mão
   ========================================================================== */

import {
  state,
  calculateTotals,
  setMode,
  addItem,
  updateItem,
  markItemAsTaken,
  returnItemToPending,
  removeItem,
  clearCart,
  performUndo,
  setCurrentList,
  addPriceEntryAndCartItem
} from './state.js';

import { getAllLists, saveList, setConfig } from './db.js';
import { capturePriceTagPhoto } from './camera.js';
import { analyzePriceTag } from './vision.js';
import { getSyncStatus, triggerSync, onSyncStatusChange } from './sync.js';
import { saveActiveFirebaseConfig, getActiveFirebaseConfig, isFirestoreActive } from './firebase-config.js';
import {
  getProductPriceStats,
  getAllTrackedProducts,
  getKnownSupermarkets,
  renderPriceTrendSVG,
  removePriceRecord
} from './prices.js';

// Utilitário para formatar moeda Real (BRL)
export function formatCurrency(value) {
  const num = Number(value) || 0;
  return num.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

// Utilitário para escapar HTML contra XSS
function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Feedback háptico (vibração sutil no celular se suportado)
function triggerHaptic() {
  if ('vibrate' in navigator) {
    try {
      navigator.vibrate(25);
    } catch (e) {
      // Ignora silenciosamente se o navegador não permitir
    }
  }
}

let toastTimeout = null;

/**
 * Exibe um Toast Snackbar com botão "DESFAZER"
 */
export function showToast(message, canUndo = true) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  if (toastTimeout) {
    clearTimeout(toastTimeout);
  }

  container.innerHTML = `
    <div class="toast">
      <span class="toast-message">${escapeHTML(message)}</span>
      ${canUndo ? `<button id="btn-undo" class="toast-undo-btn">DESFAZER</button>` : ''}
    </div>
  `;

  if (canUndo) {
    const btnUndo = document.getElementById('btn-undo');
    if (btnUndo) {
      btnUndo.addEventListener('click', async () => {
        triggerHaptic();
        const desc = await performUndo();
        container.innerHTML = '';
        if (desc) {
          showToast(`Ação desfeita!`, false);
        }
      });
    }
  }

  toastTimeout = setTimeout(() => {
    container.innerHTML = '';
  }, 5000);
}

/**
 * Renderiza o Header Slim Fixo com os totais ao vivo e progresso
 */
export function renderHeader() {
  const totals = calculateTotals();
  const listNameEl = document.getElementById('header-list-name');
  const totalValueEl = document.getElementById('header-total-live');
  const estimatedValueEl = document.getElementById('header-estimated-value');
  const diffBadgeEl = document.getElementById('header-diff-badge');
  const progressTextEl = document.getElementById('header-progress-text');
  const progressFillEl = document.getElementById('header-progress-fill');

  if (listNameEl) {
    listNameEl.textContent = state.currentList ? state.currentList.nome : 'Minha Lista';
  }

  if (totalValueEl) {
    totalValueEl.textContent = formatCurrency(totals.totalCarrinho);
  }

  if (estimatedValueEl) {
    estimatedValueEl.textContent = `Est: ${formatCurrency(totals.totalEstimado)}`;
  }

  if (diffBadgeEl) {
    if (totals.itensPegos === 0) {
      diffBadgeEl.textContent = 'Estimativa';
      diffBadgeEl.className = 'diff-tag neutral';
    } else if (totals.diferenca < 0) {
      diffBadgeEl.textContent = `-${formatCurrency(Math.abs(totals.diferenca))}`;
      diffBadgeEl.className = 'diff-tag saving';
    } else if (totals.diferenca > 0) {
      diffBadgeEl.textContent = `+${formatCurrency(totals.diferenca)}`;
      diffBadgeEl.className = 'diff-tag exceeded';
    } else {
      diffBadgeEl.textContent = 'No valor';
      diffBadgeEl.className = 'diff-tag neutral';
    }
  }

  if (progressTextEl) {
    progressTextEl.textContent = `${totals.itensPegos} de ${totals.itensTotal} (${totals.porcentagem}%)`;
  }

  if (progressFillEl) {
    progressFillEl.style.width = `${totals.porcentagem}%`;
  }
}

/**
 * Renderiza o Seletor de Modo (Segmented Control no Header)
 */
export function renderModeSwitcher() {
  const tabComprando = document.getElementById('tab-mode-comprando');
  const tabPlanejando = document.getElementById('tab-mode-planejando');

  if (tabComprando && tabPlanejando) {
    if (state.mode === 'comprando') {
      tabComprando.classList.add('active');
      tabPlanejando.classList.remove('active');
    } else {
      tabComprando.classList.remove('active');
      tabPlanejando.classList.add('active');
    }
  }
}

/**
 * Renderiza o corpo da lista de acordo com o modo atual
 */
export function renderListContent() {
  const container = document.getElementById('list-content-container');
  if (!container) return;

  if (!state.currentList || !state.currentList.itens || state.currentList.itens.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🛒</div>
        <h3 style="font-size: 1.15rem; color: var(--text-primary);">Sua lista está vazia</h3>
        <p style="font-size: 0.9rem;">Toque no botão abaixo para adicionar itens.</p>
        <button id="btn-empty-add-item" class="btn-floating-action" style="margin-top: 14px; position: static;">
          + Adicionar Primeiro Item
        </button>
      </div>
    `;
    const btnAdd = document.getElementById('btn-empty-add-item');
    if (btnAdd) {
      btnAdd.addEventListener('click', () => openAddItemModal());
    }
    return;
  }

  if (state.mode === 'comprando') {
    renderShoppingMode(container);
  } else {
    renderPlanningMode(container);
  }
}

/**
 * Modo "Comprando": tela focada no corredor do mercado
 */
function renderShoppingMode(container) {
  const itens = state.currentList.itens;
  const pendentes = itens.filter(i => !i.pego);
  const noCarrinho = itens.filter(i => i.pego);

  let html = '';

  // Seção de Itens Pendentes (A Pegar)
  html += `
    <div class="section-header">
      <span class="section-title">
        <span>📋 A Pegar</span>
      </span>
      <span class="section-badge">${pendentes.length}</span>
    </div>
    <div class="items-group">
  `;

  if (pendentes.length === 0) {
    html += `
      <div class="empty-state" style="padding: 20px 14px;">
        <span style="font-size: 1.8rem;">🎉</span>
        <p class="fw-semibold text-success" style="font-size: 0.92rem;">Tudo pego! Nenhum item pendente.</p>
      </div>
    `;
  } else {
    pendentes.forEach(item => {
      const qtdText = item.qtdPlanejada > 1 ? `${item.qtdPlanejada}x` : '1 un';
      const precoEstText = item.precoEstimado > 0 ? ` • Est: ${formatCurrency(item.precoEstimado)}` : '';
      
      html += `
        <div class="item-card tap-highlight" data-item-id="${item.id}" data-action="pick">
          <div class="item-checkbox-wrapper" data-checkbox="true">
            <div class="item-checkbox">✓</div>
          </div>
          <div class="item-details">
            <div class="item-name-row">
              <span class="item-name">${escapeHTML(item.nome)}</span>
              ${item.categoria && item.categoria !== 'Geral' ? `<span class="item-category-tag">${escapeHTML(item.categoria)}</span>` : ''}
            </div>
            <span class="item-subtitle">${qtdText}${precoEstText}</span>
          </div>
          <div class="item-price-info" style="display: flex; align-items: center; gap: 6px;">
            <button class="action-icon-btn btn-history-direct" data-name="${escapeHTML(item.nome)}" title="Ver Histórico de Preços">📊</button>
            <span class="item-pick-hint">Pegar ➔</span>
          </div>
        </div>
      `;
    });
  }

  html += `</div>`;

  // Seção de Itens Já no Carrinho
  if (noCarrinho.length > 0) {
    html += `
      <div class="section-header" style="margin-top: 24px;">
        <span class="section-title">
          <span>✅ No Carrinho</span>
        </span>
        <div style="display: flex; gap: 8px; align-items: center;">
          <span class="section-badge">${noCarrinho.length}</span>
          <button id="btn-clear-cart" class="action-icon-btn" style="width: auto; padding: 2px 8px; font-size: 0.75rem; border: 1px solid var(--border);" title="Limpar Carrinho">
            Limpar
          </button>
        </div>
      </div>
      <div class="items-group">
    `;

    noCarrinho.forEach(item => {
      const subtotal = (Number(item.qtdReal) || 1) * (Number(item.precoReal) || 0);
      const detalhesPreco = `${item.qtdReal} x ${formatCurrency(item.precoReal)}`;

      html += `
        <div class="item-card taken tap-highlight" data-item-id="${item.id}" data-action="edit-cart">
          <div class="item-checkbox-wrapper" data-checkbox="true">
            <div class="item-checkbox">✓</div>
          </div>
          <div class="item-details">
            <div class="item-name-row">
              <span class="item-name">${escapeHTML(item.nome)}</span>
            </div>
            <span class="item-subtitle">${detalhesPreco} • ${escapeHTML(item.mercado || 'Mercado Geral')}</span>
          </div>
          <div class="item-price-info" style="display: flex; align-items: center; gap: 6px;">
            <button class="action-icon-btn btn-history-direct" data-name="${escapeHTML(item.nome)}" title="Ver Histórico de Preços">📊</button>
            <div style="text-align: right;">
              <span class="item-real-total">${formatCurrency(subtotal)}</span>
              <span class="item-unit-price">${formatCurrency(item.precoReal)}/un</span>
            </div>
          </div>
        </div>
      `;
    });

    html += `</div>`;
  }

  container.innerHTML = html;

  // Ouvintes de clique nos cards do modo Comprando
  container.querySelectorAll('.item-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn-history-direct')) return;
      const itemId = card.dataset.itemId;
      const action = card.dataset.action;
      const isCheckbox = e.target.closest('[data-checkbox="true"]');

      triggerHaptic();

      if (action === 'pick') {
        openCartSheet(itemId);
      } else if (action === 'edit-cart') {
        if (isCheckbox) {
          returnItemToPending(itemId);
          showToast(`Item devolvido para a lista.`);
        } else {
          openCartSheet(itemId, true);
        }
      }
    });
  });

  // Ouvintes de histórico direto nos cards
  container.querySelectorAll('.btn-history-direct').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      triggerHaptic();
      openProductHistoryModal(btn.dataset.name);
    });
  });

  const btnClear = document.getElementById('btn-clear-cart');
  if (btnClear) {
    btnClear.addEventListener('click', () => {
      triggerHaptic();
      if (confirm('Deseja desmarcar todos os itens e limpar o carrinho?')) {
        clearCart();
        showToast('Carrinho limpo.');
      }
    });
  }
}

/**
 * Modo "Planejando": Organização e edição de itens antes de ir ao mercado
 */
function renderPlanningMode(container) {
  const itens = state.currentList.itens;

  let html = `
    <div class="section-header">
      <span class="section-title">
        <span>📝 Itens Planejados</span>
      </span>
      <span class="section-badge">${itens.length}</span>
    </div>
    <div class="items-group">
  `;

  itens.forEach(item => {
    const qtdText = `${item.qtdPlanejada || 1} un`;
    const estTotal = (item.qtdPlanejada || 1) * (item.precoEstimado || 0);
    const precoText = item.precoEstimado > 0 
      ? `Est: ${formatCurrency(item.precoEstimado)} (Tot: ${formatCurrency(estTotal)})`
      : 'Sem estimativa';

    html += `
      <div class="item-card" data-item-id="${item.id}">
        <div class="item-details">
          <div class="item-name-row">
            <span class="item-name">${escapeHTML(item.nome)}</span>
            <span class="item-category-tag">${escapeHTML(item.categoria || 'Geral')}</span>
          </div>
          <span class="item-subtitle">${qtdText} • ${precoText}</span>
        </div>
        <div style="display: flex; gap: 4px; align-items: center;">
          <button class="action-icon-btn btn-history-direct" data-name="${escapeHTML(item.nome)}" title="Histórico de Preços">📊</button>
          <button class="action-icon-btn btn-edit-item" data-id="${item.id}" title="Editar">✏️</button>
          <button class="action-icon-btn btn-delete-item" data-id="${item.id}" style="color: var(--danger);" title="Excluir">🗑️</button>
        </div>
      </div>
    `;
  });

  html += `</div>`;
  container.innerHTML = html;

  // Ouvintes de histórico direto
  container.querySelectorAll('.btn-history-direct').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      triggerHaptic();
      openProductHistoryModal(btn.dataset.name);
    });
  });

  // Ouvintes de edição e remoção
  container.querySelectorAll('.btn-edit-item').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      triggerHaptic();
      openEditItemModal(btn.dataset.id);
    });
  });

  container.querySelectorAll('.btn-delete-item').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      triggerHaptic();
      removeItem(btn.dataset.id);
      showToast('Item removido da lista.');
    });
  });
}

/* ==========================================================================
   MODAIS & BOTTOM SHEETS
   ========================================================================== */

const modalContainer = document.getElementById('modal-container');

/**
 * Fecha qualquer modal aberto
 */
export function closeModal() {
  if (modalContainer) {
    modalContainer.innerHTML = '';
  }
}

/**
 * Bottom Sheet: Modo Comprando - Pegar item e informar preço/qtd real e mercado
 */
export async function openCartSheet(itemId, isEditing = false) {
  const item = state.currentList.itens.find(i => i.id === itemId);
  if (!item) return;

  let initialQtd = isEditing ? (item.qtdReal || item.qtdPlanejada || 1) : (item.qtdPlanejada || 1);
  let initialPrice = isEditing ? (item.precoReal || '') : (item.precoEstimado ? item.precoEstimado.toFixed(2) : '');

  // Busca dados de histórico de preços para conferência na gôndola
  const stats = await getProductPriceStats(item.nome);
  const knownMarkets = await getKnownSupermarkets();
  const currentMarket = item.mercado || window.lastUsedSupermarket || (knownMarkets[0] || 'Mercado Geral');

  let historyBannerHtml = '';
  if (stats && stats.totalCompras > 0) {
    historyBannerHtml = `
      <div style="background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.25); border-radius: var(--radius-sm); padding: 8px 10px; margin-top: 6px; display: flex; align-items: center; justify-content: space-between;">
        <span style="font-size: 0.74rem; color: var(--text-secondary);">
          Menor: <strong style="color: var(--success);">${formatCurrency(stats.menorPreco)}</strong> (${escapeHTML(stats.menorMercado)})
          • Último: <strong>${formatCurrency(stats.ultimoPreco)}</strong>
        </span>
        <button type="button" id="btn-cart-view-history" style="background: transparent; border: none; color: var(--primary-light); font-size: 0.75rem; font-weight: 700; cursor: pointer; padding: 2px 4px;">
          Ver 📊
        </button>
      </div>
    `;
  }

  modalContainer.innerHTML = `
    <div class="modal-overlay" id="sheet-overlay">
      <div class="bottom-sheet" id="cart-bottom-sheet">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <div>
            <h3 class="sheet-title">${escapeHTML(item.nome)}</h3>
            <span class="item-subtitle" style="font-size: 0.8rem;">${isEditing ? 'Ajustar valor ou quantidade' : 'Informar preço da prateleira'}</span>
          </div>
          <button class="sheet-close-btn" id="btn-close-sheet">✕</button>
        </div>

        <!-- Preço Unitário Real -->
        <div class="form-group">
          <label class="form-label">Preço Unitário (da etiqueta)</label>
          <div class="big-price-input-wrapper">
            <span class="currency-prefix">R$</span>
            <input 
              type="number" 
              step="0.01" 
              inputmode="decimal" 
              id="sheet-preco-real" 
              class="form-input big-price-input" 
              placeholder="0,00"
              value="${initialPrice}"
              autofocus
            />
          </div>
          ${item.precoEstimado > 0 ? `<span class="item-subtitle" style="display:block; margin-top:3px; font-size: 0.75rem;">Estimado na lista: ${formatCurrency(item.precoEstimado)}</span>` : ''}
          ${historyBannerHtml}
        </div>

        <!-- Supermercado -->
        <div class="form-group">
          <label class="form-label">Supermercado</label>
          <input 
            type="text" 
            id="sheet-item-mercado" 
            list="cart-supermarket-datalist" 
            class="form-input" 
            style="font-size: 0.92rem; padding: 10px 14px;" 
            placeholder="Ex: Assaí, Carrefour, Pão de Açúcar..." 
            value="${escapeHTML(currentMarket)}" 
          />
          <datalist id="cart-supermarket-datalist">
            ${knownMarkets.map(m => `<option value="${escapeHTML(m)}"></option>`).join('')}
          </datalist>
        </div>

        <!-- Stepper de Quantidade -->
        <div class="form-group">
          <label class="form-label">Quantidade Levada</label>
          <div class="quantity-stepper">
            <button type="button" class="stepper-btn" id="btn-qtd-minus">−</button>
            <input type="number" step="any" min="0.1" id="sheet-qtd-real" class="stepper-input" value="${initialQtd}">
            <button type="button" class="stepper-btn" id="btn-qtd-plus">+</button>
          </div>
        </div>

        <!-- Subtotal ao vivo do Item -->
        <div class="item-live-subtotal">
          <span class="subtotal-calc" id="sheet-subtotal-calc">1 x R$ 0,00</span>
          <span class="subtotal-amount" id="sheet-subtotal-val">R$ 0,00</span>
        </div>

        <div style="display: flex; gap: 8px; margin-top: 16px;">
          ${isEditing ? `
            <button type="button" id="btn-return-pending" class="sheet-btn-secondary" style="color: var(--danger);">
              Tirar
            </button>
          ` : ''}
          <button type="button" id="btn-confirm-cart" class="sheet-btn-primary">
            ✓ ${isEditing ? 'Atualizar Item' : 'Confirmar no Carrinho'}
          </button>
        </div>
      </div>
    </div>
  `;

  const inputPreco = document.getElementById('sheet-preco-real');
  const inputQtd = document.getElementById('sheet-qtd-real');
  const inputMercado = document.getElementById('sheet-item-mercado');
  const subtotalCalc = document.getElementById('sheet-subtotal-calc');
  const subtotalVal = document.getElementById('sheet-subtotal-val');
  const btnMinus = document.getElementById('btn-qtd-minus');
  const btnPlus = document.getElementById('btn-qtd-plus');
  const btnConfirm = document.getElementById('btn-confirm-cart');
  const btnClose = document.getElementById('btn-close-sheet');
  const overlay = document.getElementById('sheet-overlay');
  const btnReturn = document.getElementById('btn-return-pending');
  const btnViewHistory = document.getElementById('btn-cart-view-history');

  if (btnViewHistory) {
    btnViewHistory.addEventListener('click', () => {
      openProductHistoryModal(item.nome);
    });
  }

  function updateSheetSubtotal() {
    const p = parseFloat(inputPreco.value) || 0;
    const q = parseFloat(inputQtd.value) || 0;
    const tot = p * q;
    subtotalCalc.textContent = `${q} x ${formatCurrency(p)}`;
    subtotalVal.textContent = formatCurrency(tot);
  }

  updateSheetSubtotal();

  inputPreco.addEventListener('input', updateSheetSubtotal);
  inputQtd.addEventListener('input', updateSheetSubtotal);

  btnMinus.addEventListener('click', () => {
    triggerHaptic();
    let current = parseFloat(inputQtd.value) || 1;
    if (current > 1) {
      inputQtd.value = current - 1;
    } else if (current > 0.1) {
      inputQtd.value = (current - 0.1).toFixed(1);
    }
    updateSheetSubtotal();
  });

  btnPlus.addEventListener('click', () => {
    triggerHaptic();
    let current = parseFloat(inputQtd.value) || 0;
    inputQtd.value = current + 1;
    updateSheetSubtotal();
  });

  btnConfirm.addEventListener('click', async () => {
    triggerHaptic();
    const preco = parseFloat(inputPreco.value) || 0;
    const qtd = parseFloat(inputQtd.value) || 1;
    const mercado = (inputMercado ? inputMercado.value.trim() : '') || 'Mercado Geral';

    window.lastUsedSupermarket = mercado;

    await markItemAsTaken(itemId, qtd, preco, mercado);
    closeModal();
    showToast(`"${item.nome}" colocado no carrinho!`);
  });

  if (btnReturn) {
    btnReturn.addEventListener('click', async () => {
      triggerHaptic();
      await returnItemToPending(itemId);
      closeModal();
      showToast(`"${item.nome}" devolvido para a lista.`);
    });
  }

  btnClose.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
}

/**
 * Modal: Adicionar Novo Item à Lista (com sugestão de preço baseada em compras passadas)
 */
export async function openAddItemModal() {
  const categories = ['Geral', 'Mercearia', 'Hortifruti', 'Carnes', 'Laticínios', 'Bebidas', 'Limpeza', 'Higiene', 'Padaria'];
  let selectedCategory = 'Geral';

  const trackedProducts = await getAllTrackedProducts();

  modalContainer.innerHTML = `
    <div class="modal-overlay" id="sheet-overlay">
      <div class="bottom-sheet">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <h3 class="sheet-title">Novo Item</h3>
          <button class="sheet-close-btn" id="btn-close-sheet">✕</button>
        </div>

        <form id="form-add-item">
          <div class="form-group" style="margin-bottom: 6px;">
            <label class="form-label">Nome do Produto *</label>
            <input 
              type="text" 
              id="input-item-name" 
              list="datalist-tracked-products" 
              class="form-input" 
              placeholder="Ex: Café em Pó 500g" 
              required 
              autofocus 
              autocomplete="off"
            />
            <datalist id="datalist-tracked-products">
              ${trackedProducts.map(p => `<option value="${escapeHTML(p.nome)}"></option>`).join('')}
            </datalist>
          </div>

          <!-- Container de sugestão automática de preço -->
          <div id="add-item-price-suggestion-container"></div>

          <div class="form-group">
            <label class="form-label">Categoria</label>
            <div class="chips-container" id="category-chips">
              ${categories.map(cat => `
                <button type="button" class="chip ${cat === selectedCategory ? 'active' : ''}" data-cat="${cat}">${cat}</button>
              `).join('')}
            </div>
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
            <div class="form-group">
              <label class="form-label">Quantidade</label>
              <div class="quantity-stepper">
                <button type="button" class="stepper-btn" id="btn-add-minus">−</button>
                <input type="number" step="any" min="0.1" id="input-item-qtd" class="stepper-input" value="1">
                <button type="button" class="stepper-btn" id="btn-add-plus">+</button>
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">Preço Estimado</label>
              <div class="big-price-input-wrapper">
                <span class="currency-prefix" style="font-size: 0.95rem; left: 10px;">R$</span>
                <input type="number" step="0.01" inputmode="decimal" id="input-item-price-est" class="form-input" style="padding-left: 36px;" placeholder="0,00" />
              </div>
            </div>
          </div>

          <button type="submit" class="sheet-btn-primary" style="width: 100%; margin-top: 10px;">
            + Adicionar à Lista
          </button>
        </form>
      </div>
    </div>
  `;

  const form = document.getElementById('form-add-item');
  const inputName = document.getElementById('input-item-name');
  const inputQtd = document.getElementById('input-item-qtd');
  const inputPrice = document.getElementById('input-item-price-est');
  const suggestionContainer = document.getElementById('add-item-price-suggestion-container');
  const chips = document.querySelectorAll('#category-chips .chip');
  const btnMinus = document.getElementById('btn-add-minus');
  const btnPlus = document.getElementById('btn-add-plus');
  const btnClose = document.getElementById('btn-close-sheet');
  const overlay = document.getElementById('sheet-overlay');

  // Sugestão em tempo real ao digitar o nome do produto
  let debounceSuggestTimer = null;
  inputName.addEventListener('input', () => {
    if (debounceSuggestTimer) clearTimeout(debounceSuggestTimer);
    debounceSuggestTimer = setTimeout(async () => {
      const query = inputName.value.trim();
      if (query.length >= 2) {
        const stats = await getProductPriceStats(query);
        if (stats && stats.ultimoPreco > 0) {
          suggestionContainer.innerHTML = `
            <div class="price-suggestion-pill">
              <span>💡 Último pago: <strong>${formatCurrency(stats.ultimoPreco)}</strong> (${escapeHTML(stats.ultimoMercado)})</span>
              <button type="button" class="btn-use-suggested-price" id="btn-apply-suggested-price">Usar Preço</button>
            </div>
          `;
          const btnApply = document.getElementById('btn-apply-suggested-price');
          if (btnApply) {
            btnApply.addEventListener('click', () => {
              triggerHaptic();
              inputPrice.value = stats.ultimoPreco.toFixed(2);
              showToast(`Preço sugerido ${formatCurrency(stats.ultimoPreco)} aplicado!`);
            });
          }
        } else {
          suggestionContainer.innerHTML = '';
        }
      } else {
        suggestionContainer.innerHTML = '';
      }
    }, 150);
  });

  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      selectedCategory = chip.dataset.cat;
    });
  });

  btnMinus.addEventListener('click', () => {
    triggerHaptic();
    let val = parseFloat(inputQtd.value) || 1;
    if (val > 1) inputQtd.value = val - 1;
  });

  btnPlus.addEventListener('click', () => {
    triggerHaptic();
    let val = parseFloat(inputQtd.value) || 0;
    inputQtd.value = val + 1;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    triggerHaptic();
    const nome = inputName.value.trim();
    if (!nome) return;

    const qtd = parseFloat(inputQtd.value) || 1;
    const preco = parseFloat(inputPrice.value) || 0;

    await addItem({
      nome,
      categoria: selectedCategory,
      qtdPlanejada: qtd,
      precoEstimado: preco
    });

    closeModal();
    showToast(`"${nome}" adicionado!`);
  });

  btnClose.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
}

/**
 * Modal: Editar Item Planejado
 */
export async function openEditItemModal(itemId) {
  const item = state.currentList.itens.find(i => i.id === itemId);
  if (!item) return;

  const categories = ['Geral', 'Mercearia', 'Hortifruti', 'Carnes', 'Laticínios', 'Bebidas', 'Limpeza', 'Higiene', 'Padaria'];
  let selectedCategory = item.categoria || 'Geral';

  const stats = await getProductPriceStats(item.nome);

  modalContainer.innerHTML = `
    <div class="modal-overlay" id="sheet-overlay">
      <div class="bottom-sheet">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <h3 class="sheet-title">Editar Item</h3>
          <button class="sheet-close-btn" id="btn-close-sheet">✕</button>
        </div>

        <form id="form-edit-item">
          <div class="form-group" style="margin-bottom: 6px;">
            <label class="form-label">Nome do Produto</label>
            <input type="text" id="input-edit-name" class="form-input" value="${escapeHTML(item.nome)}" required />
          </div>

          ${stats && stats.ultimoPreco > 0 ? `
            <div class="price-suggestion-pill" style="margin-top: 4px; margin-bottom: 12px;">
              <span>💡 Histórico: <strong>${formatCurrency(stats.ultimoPreco)}</strong> (${escapeHTML(stats.ultimoMercado)})</span>
              <div style="display: flex; gap: 6px;">
                <button type="button" class="btn-use-suggested-price" id="btn-edit-use-suggested">Usar</button>
                <button type="button" class="btn-use-suggested-price" id="btn-edit-open-history" style="background: var(--bg-elevated); color: var(--text-primary); border: 1px solid var(--border);">📊 Ver</button>
              </div>
            </div>
          ` : ''}

          <div class="form-group">
            <label class="form-label">Categoria</label>
            <div class="chips-container" id="category-chips">
              ${categories.map(cat => `
                <button type="button" class="chip ${cat === selectedCategory ? 'active' : ''}" data-cat="${cat}">${cat}</button>
              `).join('')}
            </div>
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
            <div class="form-group">
              <label class="form-label">Quantidade</label>
              <input type="number" step="any" min="0.1" id="input-edit-qtd" class="form-input" value="${item.qtdPlanejada || 1}" />
            </div>

            <div class="form-group">
              <label class="form-label">Preço Estimado</label>
              <div class="big-price-input-wrapper">
                <span class="currency-prefix" style="font-size: 0.95rem; left: 10px;">R$</span>
                <input type="number" step="0.01" inputmode="decimal" id="input-edit-price" class="form-input" style="padding-left: 36px;" value="${item.precoEstimado || ''}" />
              </div>
            </div>
          </div>

          <div style="display: flex; gap: 8px; margin-top: 12px;">
            <button type="button" id="btn-delete-current-item" class="sheet-btn-secondary" style="color: var(--danger);">
              🗑️ Excluir
            </button>
            <button type="submit" class="sheet-btn-primary" style="flex: 1;">
              Salvar Alterações
            </button>
          </div>
        </form>
      </div>
    </div>
  `;

  const form = document.getElementById('form-edit-item');
  const inputName = document.getElementById('input-edit-name');
  const inputQtd = document.getElementById('input-edit-qtd');
  const inputPrice = document.getElementById('input-edit-price');
  const chips = document.querySelectorAll('#category-chips .chip');
  const btnDelete = document.getElementById('btn-delete-current-item');
  const btnClose = document.getElementById('btn-close-sheet');
  const overlay = document.getElementById('sheet-overlay');
  const btnUseSuggested = document.getElementById('btn-edit-use-suggested');
  const btnOpenHistory = document.getElementById('btn-edit-open-history');

  if (btnUseSuggested && stats) {
    btnUseSuggested.addEventListener('click', () => {
      triggerHaptic();
      inputPrice.value = stats.ultimoPreco.toFixed(2);
      showToast(`Preço estimado ajustado para ${formatCurrency(stats.ultimoPreco)}!`);
    });
  }

  if (btnOpenHistory) {
    btnOpenHistory.addEventListener('click', () => {
      openProductHistoryModal(item.nome);
    });
  }

  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      selectedCategory = chip.dataset.cat;
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    triggerHaptic();
    await updateItem(itemId, {
      nome: inputName.value.trim(),
      categoria: selectedCategory,
      qtdPlanejada: parseFloat(inputQtd.value) || 1,
      precoEstimado: parseFloat(inputPrice.value) || 0
    });
    closeModal();
    showToast(`Item "${inputName.value}" atualizado!`);
  });

  btnDelete.addEventListener('click', async () => {
    triggerHaptic();
    await removeItem(itemId);
    closeModal();
    showToast(`Item removido da lista.`);
  });

  btnClose.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
}

/**
 * Modal: Gerenciador de Listas de Compras
 */
export async function openListManagerModal() {
  const lists = await getAllLists();
  const currentVisionUrl = (await getConfig('visionFunctionUrl')) || '';
  const isDevSim = (await getConfig('devVisionSimulation')) === true;

  modalContainer.innerHTML = `
    <div class="modal-overlay" id="sheet-overlay">
      <div class="bottom-sheet">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <h3 class="sheet-title">Minhas Listas</h3>
          <button class="sheet-close-btn" id="btn-close-sheet">✕</button>
        </div>

        <div class="items-group" style="margin-bottom: 16px;">
          ${lists.map(list => `
            <div class="item-card tap-highlight ${state.currentList && state.currentList.id === list.id ? 'taken' : ''}" data-list-id="${list.id}" style="cursor: pointer;">
              <div class="item-details">
                <span class="item-name">${escapeHTML(list.nome)}</span>
                <span class="item-subtitle">${list.itens.length} itens cadastrados</span>
              </div>
              ${state.currentList && state.currentList.id === list.id ? '<span class="text-success fw-bold" style="font-size: 0.85rem;">Ativa</span>' : ''}
            </div>
          `).join('')}
        </div>

        <div style="border-top: 1px solid var(--border); padding-top: 14px;">
          <h4 style="font-size: 0.92rem; margin-bottom: 8px; color: var(--text-secondary);">Criar Nova Lista</h4>
          <div style="display: flex; gap: 8px;">
            <input type="text" id="input-new-list-name" class="form-input" placeholder="Ex: Churrasco de Domingo" />
            <button id="btn-create-list" class="sheet-btn-primary" style="white-space: nowrap; padding: 0 16px;">
              Criar
            </button>
          </div>
        </div>

        <!-- Configurações da IA de Visão -->
        <div style="border-top: 1px solid var(--border); padding-top: 14px; margin-top: 16px;">
          <h4 style="font-size: 0.92rem; margin-bottom: 10px; color: var(--text-secondary);">⚙️ Configurações da IA de Visão</h4>
          
          <div class="form-group" style="margin-bottom: 10px;">
            <label class="form-label" style="font-size: 0.78rem;">URL da Cloud Function (analyzePriceTag)</label>
            <input type="url" id="input-vision-url" class="form-input" style="font-size: 0.85rem; padding: 10px 12px;" placeholder="https://<regiao>-<projeto>.cloudfunctions.net/analyzePriceTag" value="${escapeHTML(currentVisionUrl)}" />
          </div>

          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; background: var(--bg); padding: 10px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border);">
            <div>
              <div style="font-size: 0.85rem; font-weight: 600; color: var(--text-primary);">Simulação Offline de Teste</div>
              <div style="font-size: 0.75rem; color: var(--text-muted);">Gera dados fictícios sem chamar a nuvem</div>
            </div>
            <input type="checkbox" id="check-dev-sim" ${isDevSim ? 'checked' : ''} style="width: 20px; height: 20px; cursor: pointer;" />
          </div>

          <button id="btn-save-vision-config" class="sheet-btn-secondary" style="width: 100%; font-size: 0.88rem; padding: 10px;">
            Salvar Configurações
          </button>
        </div>
      </div>
    </div>
  `;

  const overlay = document.getElementById('sheet-overlay');
  const btnClose = document.getElementById('btn-close-sheet');
  const btnCreate = document.getElementById('btn-create-list');
  const inputNewName = document.getElementById('input-new-list-name');
  const btnSaveVision = document.getElementById('btn-save-vision-config');
  const inputVisionUrl = document.getElementById('input-vision-url');
  const checkDevSim = document.getElementById('check-dev-sim');

  modalContainer.querySelectorAll('.item-card[data-list-id]').forEach(card => {
    card.addEventListener('click', async () => {
      triggerHaptic();
      const listId = card.dataset.listId;
      const selected = lists.find(l => l.id === listId);
      if (selected) {
        setCurrentList(selected);
        await setConfig('activeListId', selected.id);
        closeModal();
        showToast(`Lista alterada para "${selected.nome}"`);
      }
    });
  });

  btnCreate.addEventListener('click', async () => {
    const nome = inputNewName.value.trim();
    if (!nome) return;
    triggerHaptic();

    const newList = {
      id: 'lista_' + Date.now(),
      nome,
      dataCriacao: new Date().toISOString(),
      itens: []
    };

    await saveList(newList);
    setCurrentList(newList);
    await setConfig('activeListId', newList.id);
    closeModal();
    showToast(`Nova lista "${nome}" criada!`);
  });

  btnSaveVision.addEventListener('click', async () => {
    triggerHaptic();
    const url = inputVisionUrl.value.trim();
    const simEnabled = checkDevSim.checked;

    await setConfig('visionFunctionUrl', url);
    await setConfig('devVisionSimulation', simEnabled);

    showToast(simEnabled ? 'Simulação ativada!' : 'Configurações de IA salvas!');
    closeModal();
  });

  btnClose.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
}

/**
 * Inicia o fluxo de captura de foto da etiqueta e extração por IA (Fase 2)
 */
export async function handleCameraScan() {
  let photo = null;
  try {
    triggerHaptic();
    // 1. Abre a câmera e comprime a foto
    photo = await capturePriceTagPhoto();

    // 2. Exibe o modal de carregamento / leitura
    modalContainer.innerHTML = `
      <div class="modal-overlay">
        <div style="background: var(--bg-card); padding: 28px 20px; border-radius: var(--radius-lg); text-align: center; border: 1px solid var(--border); max-width: 320px; width: 88%; box-shadow: 0 10px 30px rgba(0,0,0,0.7);">
          <div class="scanning-spinner"></div>
          <h4 style="margin-top: 16px; font-size: 1.15rem; color: var(--text-primary);">Lendo Etiqueta...</h4>
          <p style="font-size: 0.85rem; color: var(--text-muted); margin-top: 6px;">Identificando produto, preço e peso pela foto.</p>
        </div>
      </div>
    `;

    // 3. Processa a imagem com IA de visão (ou recebe fallback seguro caso falhe)
    const extractedData = await analyzePriceTag(photo.dataUrl);

    // 4. Abre a tela de confirmação editável com a foto preservada
    openLabelConfirmSheet(extractedData, photo.dataUrl);
  } catch (err) {
    if (err.message && err.message.includes('Nenhuma foto')) {
      // Usuário cancelou ou fechou a câmera
      closeModal();
      return;
    }

    console.warn('[Camera/Vision] Falha durante o escaneamento:', err);
    // Em caso de qualquer erro imprevisto, se temos a foto, cai no preenchimento manual sem perder a foto
    if (photo && photo.dataUrl) {
      openLabelConfirmSheet({
        sucesso: false,
        nome: '',
        preco: 0,
        peso: '',
        unidade: 'un',
        precoPorKgLitro: '',
        mercado: '',
        confianca: 0.0,
        aviso: 'Não foi possível ler a etiqueta automaticamente. Digite os dados abaixo:'
      }, photo.dataUrl);
    } else {
      closeModal();
    }
  }
}

/**
 * TELA DE CONFIRMAÇÃO (Fase 2):
 * Mostra os campos preenchidos pela IA e editáveis antes de salvar
 */
export function openLabelConfirmSheet(extracted, photoDataUrl) {
  let precoUnit = Number(extracted.preco) || 0;
  const confiancaPct = extracted.confianca ? Math.round(extracted.confianca * 100) : 0;

  modalContainer.innerHTML = `
    <div class="modal-overlay" id="sheet-overlay">
      <div class="bottom-sheet" style="max-height: 92vh;">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <div>
            <h3 class="sheet-title">Confirmar Produto</h3>
            <span class="item-subtitle" style="font-size: 0.8rem;">
              ${extracted.sucesso && confiancaPct >= 80 
                ? `✓ Lido por IA (${confiancaPct}% de confiança)` 
                : 'Verifique e ajuste os dados da etiqueta'}
            </span>
          </div>
          <button class="sheet-close-btn" id="btn-close-sheet">✕</button>
        </div>

        ${extracted.aviso ? `
          <div style="background: rgba(234, 179, 8, 0.12); border: 1px solid rgba(234, 179, 8, 0.35); color: #facc15; padding: 10px 14px; border-radius: var(--radius-md); font-size: 0.84rem; margin-bottom: 14px; line-height: 1.4; display: flex; align-items: flex-start; gap: 8px;">
            <span style="font-size: 1.1rem; line-height: 1;">⚠️</span>
            <span>${escapeHTML(extracted.aviso)}</span>
          </div>
        ` : ''}

        <!-- Preview da Foto Tirada -->
        ${photoDataUrl ? `<img src="${photoDataUrl}" class="tag-preview-img" alt="Etiqueta capturada" />` : ''}

        <form id="form-confirm-label">
          <!-- Nome do Produto -->
          <div class="form-group">
            <label class="form-label">Nome do Produto *</label>
            <input type="text" id="confirm-item-name" class="form-input" value="${escapeHTML(extracted.nome)}" required />
          </div>

          <!-- Preço Unitário -->
          <div class="form-group">
            <label class="form-label">Preço Unitário da Etiqueta *</label>
            <div class="big-price-input-wrapper">
              <span class="currency-prefix">R$</span>
              <input 
                type="number" 
                step="0.01" 
                inputmode="decimal" 
                id="confirm-item-price" 
                class="form-input big-price-input" 
                value="${precoUnit > 0 ? precoUnit.toFixed(2) : ''}" 
                placeholder="0,00"
                required
              />
            </div>
          </div>

          <!-- Quantidade levada -->
          <div class="form-group">
            <label class="form-label">Quantidade Levada</label>
            <div class="quantity-stepper">
              <button type="button" class="stepper-btn" id="btn-confirm-minus">−</button>
              <input type="number" step="any" min="0.1" id="confirm-item-qtd" class="stepper-input" value="1">
              <button type="button" class="stepper-btn" id="btn-confirm-plus">+</button>
            </div>
          </div>

          <!-- Peso / Volume e Preço por kg/L -->
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
            <div class="form-group">
              <label class="form-label">Peso / Volume</label>
              <input type="text" id="confirm-item-peso" class="form-input" value="${escapeHTML(extracted.peso || '')}" placeholder="Ex: 5kg, 1L" />
            </div>

            <div class="form-group">
              <label class="form-label">Preço por kg/L</label>
              <input type="text" id="confirm-item-rate" class="form-input" value="${escapeHTML(extracted.precoPorKgLitro || '')}" placeholder="Ex: R$ 5,60/kg" />
            </div>
          </div>

          <!-- Mercado -->
          <div class="form-group">
            <label class="form-label">Supermercado</label>
            <input type="text" id="confirm-item-mercado" class="form-input" value="${escapeHTML(extracted.mercado || 'Supermercado Central')}" placeholder="Nome do mercado" />
          </div>

          <!-- Subtotal ao vivo do Item -->
          <div class="item-live-subtotal">
            <span class="subtotal-calc" id="confirm-subtotal-calc">1 x ${formatCurrency(precoUnit)}</span>
            <span class="subtotal-amount" id="confirm-subtotal-val">${formatCurrency(precoUnit)}</span>
          </div>

          <!-- Ações -->
          <div style="display: flex; gap: 8px; margin-top: 16px;">
            <button type="button" id="btn-retake-photo" class="sheet-btn-secondary" style="white-space: nowrap;">
              📷 Tirar Outra
            </button>
            <button type="submit" class="sheet-btn-primary">
              ✓ Adicionar ao Carrinho
            </button>
          </div>
        </form>
      </div>
    </div>
  `;

  const inputName = document.getElementById('confirm-item-name');
  const inputPrice = document.getElementById('confirm-item-price');
  const inputQtd = document.getElementById('confirm-item-qtd');
  const inputPeso = document.getElementById('confirm-item-peso');
  const inputRate = document.getElementById('confirm-item-rate');
  const inputMercado = document.getElementById('confirm-item-mercado');
  const subtotalCalc = document.getElementById('confirm-subtotal-calc');
  const subtotalVal = document.getElementById('confirm-subtotal-val');
  const btnMinus = document.getElementById('btn-confirm-minus');
  const btnPlus = document.getElementById('btn-confirm-plus');
  const btnRetake = document.getElementById('btn-retake-photo');
  const btnClose = document.getElementById('btn-close-sheet');
  const overlay = document.getElementById('sheet-overlay');
  const form = document.getElementById('form-confirm-label');

  function updateConfirmSubtotal() {
    const p = parseFloat(inputPrice.value) || 0;
    const q = parseFloat(inputQtd.value) || 0;
    subtotalCalc.textContent = `${q} x ${formatCurrency(p)}`;
    subtotalVal.textContent = formatCurrency(p * q);
  }

  inputPrice.addEventListener('input', updateConfirmSubtotal);
  inputQtd.addEventListener('input', updateConfirmSubtotal);

  btnMinus.addEventListener('click', () => {
    triggerHaptic();
    let current = parseFloat(inputQtd.value) || 1;
    if (current > 1) {
      inputQtd.value = current - 1;
    } else if (current > 0.1) {
      inputQtd.value = (current - 0.1).toFixed(1);
    }
    updateConfirmSubtotal();
  });

  btnPlus.addEventListener('click', () => {
    triggerHaptic();
    let current = parseFloat(inputQtd.value) || 0;
    inputQtd.value = current + 1;
    updateConfirmSubtotal();
  });

  btnRetake.addEventListener('click', () => {
    handleCameraScan();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    triggerHaptic();

    const nome = inputName.value.trim();
    const preco = parseFloat(inputPrice.value) || 0;
    const quantidade = parseFloat(inputQtd.value) || 1;
    const peso = inputPeso.value.trim();
    const precoPorKgLitro = inputRate.value.trim();
    const mercado = inputMercado.value.trim();

    // Grava entrada em precos e coloca direto no carrinho
    await addPriceEntryAndCartItem({
      nome,
      preco,
      quantidade,
      peso,
      precoPorKgLitro,
      mercado,
      fotoUrl: photoDataUrl
    });

    closeModal();
    showToast(`"${nome}" confirmado no carrinho!`);
  });

  btnClose.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
}

/**
 * Atualiza o badge discreto de status de sincronização no cabeçalho
 */
export function renderSyncBadge(payload) {
  const btn = document.getElementById('sync-status-btn');
  const text = document.getElementById('sync-status-text');
  if (!btn || !text) return;

  btn.classList.remove('sync-synced', 'sync-pending', 'sync-syncing', 'sync-offline');

  const syncState = payload ? payload.state : 'offline';
  const pendingCount = payload ? payload.pendingCount : 0;

  switch (syncState) {
    case 'sincronizado':
      btn.classList.add('sync-synced');
      text.textContent = 'sincronizado';
      btn.title = 'Tudo sincronizado na nuvem (toque para detalhes)';
      break;
    case 'sincronizando':
      btn.classList.add('sync-syncing');
      text.textContent = 'sincronizando...';
      btn.title = 'Sincronizando com a nuvem...';
      break;
    case 'pendente':
      btn.classList.add('sync-pending');
      text.textContent = `${pendingCount} pendente${pendingCount > 1 ? 's' : ''}`;
      btn.title = `${pendingCount} alteração(ões) aguardando sincronização (toque para detalhes)`;
      break;
    case 'offline':
    default:
      btn.classList.add('sync-offline');
      if (payload && payload.isFirestoreActive === false) {
        text.textContent = 'local';
        btn.title = 'Modo local (toque para configurar backup na nuvem)';
      } else {
        text.textContent = 'offline';
        btn.title = 'Dispositivo offline - dados salvos com segurança no celular';
      }
      break;
  }
}

/**
 * Modal Bottom Sheet: Detalhes da Sincronização & Configuração do Firebase
 */
export async function openSyncModal() {
  triggerHaptic();
  const status = await getSyncStatus();
  const config = await getActiveFirebaseConfig();
  const isConfigured = Boolean(config && config.projectId && config.apiKey);

  const formatLastSync = (date) => {
    if (!date) return 'Ainda não realizada';
    return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const getStatusLabel = (s) => {
    switch (s) {
      case 'sincronizado':
        return '<span style="color: var(--success); font-weight:700;">● Sincronizado</span>';
      case 'sincronizando':
        return '<span style="color: #38bdf8; font-weight:700;">● Sincronizando...</span>';
      case 'pendente':
        return `<span style="color: #facc15; font-weight:700;">● ${status.pendingCount} pendente(s)</span>`;
      default:
        return `<span style="color: var(--text-muted); font-weight:700;">● ${isConfigured ? 'Offline' : 'Modo 100% Local'}</span>`;
    }
  };

  modalContainer.innerHTML = `
    <div class="modal-overlay" id="sheet-overlay">
      <div class="bottom-sheet">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <div>
            <h3 class="sheet-title">Sincronização & Backup</h3>
            <span class="item-subtitle" style="font-size: 0.8rem;">IndexedDB + Cloud Firestore</span>
          </div>
          <button class="sheet-close-btn" id="btn-close-sheet">✕</button>
        </div>

        <!-- Card de Status Atual -->
        <div style="background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 14px; margin-bottom: 14px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 8px;">
            <span style="font-size: 0.85rem; color: var(--text-secondary);">Status atual:</span>
            <span id="modal-sync-badge-val" style="font-size: 0.85rem;">${getStatusLabel(status.state)}</span>
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 8px;">
            <span style="font-size: 0.85rem; color: var(--text-secondary);">Fila pendente:</span>
            <span id="modal-sync-queue-count" style="font-size: 0.85rem; font-weight: 600;">${status.pendingCount} alteração(ões)</span>
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 8px;">
            <span style="font-size: 0.85rem; color: var(--text-secondary);">Última sincronização:</span>
            <span id="modal-sync-last-time" style="font-size: 0.85rem; font-weight: 500;">${formatLastSync(status.lastSyncTimestamp)}</span>
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size: 0.85rem; color: var(--text-secondary);">Internet:</span>
            <span style="font-size: 0.85rem; font-weight: 600;">${status.isOnline ? '🟢 Online' : '⚪ Offline'}</span>
          </div>
        </div>

        <!-- Botão Sincronizar Agora -->
        <button id="btn-trigger-sync-now" class="sheet-btn-primary" style="width: 100%; margin-bottom: 16px;">
          🔄 Sincronizar Agora
        </button>

        <!-- Configuração do Firebase -->
        <div style="border-top: 1px solid var(--border); padding-top: 14px;">
          <h4 style="font-size: 0.92rem; margin-bottom: 6px; color: var(--text-secondary);">⚙️ Conexão Firebase (Backup e Multi-aparelho)</h4>
          <p style="font-size: 0.76rem; color: var(--text-muted); margin-bottom: 12px; line-height: 1.4;">
            O app funciona 100% offline no celular usando IndexedDB. Para sincronizar em mais de um aparelho ou manter backup na nuvem, insira a configuração Web do seu projeto Firebase.
          </p>

          <form id="form-firebase-config">
            <div class="form-group" style="margin-bottom: 8px;">
              <label class="form-label" style="font-size: 0.78rem;">Project ID</label>
              <input type="text" id="fb-project-id" class="form-input" style="font-size: 0.85rem; padding: 8px 10px;" placeholder="ex: meu-mercado-pwa" value="${escapeHTML(config.projectId || '')}" />
            </div>

            <div class="form-group" style="margin-bottom: 8px;">
              <label class="form-label" style="font-size: 0.78rem;">API Key</label>
              <input type="text" id="fb-api-key" class="form-input" style="font-size: 0.85rem; padding: 8px 10px;" placeholder="AIzaSy..." value="${escapeHTML(config.apiKey || '')}" />
            </div>

            <div class="form-group" style="margin-bottom: 8px;">
              <label class="form-label" style="font-size: 0.78rem;">Auth Domain</label>
              <input type="text" id="fb-auth-domain" class="form-input" style="font-size: 0.85rem; padding: 8px 10px;" placeholder="ex: meu-mercado-pwa.firebaseapp.com" value="${escapeHTML(config.authDomain || '')}" />
            </div>

            <div class="form-group" style="margin-bottom: 12px;">
              <label class="form-label" style="font-size: 0.78rem;">Storage Bucket (para fotos)</label>
              <input type="text" id="fb-storage-bucket" class="form-input" style="font-size: 0.85rem; padding: 8px 10px;" placeholder="ex: meu-mercado-pwa.appspot.com" value="${escapeHTML(config.storageBucket || '')}" />
            </div>

            <div style="display: flex; gap: 8px;">
              ${isConfigured ? `
                <button type="button" id="btn-clear-firebase" class="sheet-btn-secondary" style="color: var(--danger); font-size: 0.82rem; padding: 10px 12px;">
                  Remover
                </button>
              ` : ''}
              <button type="submit" class="sheet-btn-secondary" style="flex: 1; font-size: 0.85rem; padding: 10px;">
                💾 Salvar e Conectar
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  `;

  const overlay = document.getElementById('sheet-overlay');
  const btnClose = document.getElementById('btn-close-sheet');
  const btnSyncNow = document.getElementById('btn-trigger-sync-now');
  const formFb = document.getElementById('form-firebase-config');
  const btnClearFb = document.getElementById('btn-clear-firebase');

  btnSyncNow.addEventListener('click', async () => {
    triggerHaptic();
    btnSyncNow.textContent = '⏳ Sincronizando...';
    btnSyncNow.disabled = true;

    await triggerSync();

    const updated = await getSyncStatus();
    const badgeVal = document.getElementById('modal-sync-badge-val');
    const queueVal = document.getElementById('modal-sync-queue-count');
    const timeVal = document.getElementById('modal-sync-last-time');

    if (badgeVal) badgeVal.innerHTML = getStatusLabel(updated.state);
    if (queueVal) queueVal.textContent = `${updated.pendingCount} alteração(ões)`;
    if (timeVal) timeVal.textContent = formatLastSync(updated.lastSyncTimestamp);

    btnSyncNow.textContent = '🔄 Sincronizar Agora';
    btnSyncNow.disabled = false;
    showToast('Sincronização processada!');
  });

  formFb.addEventListener('submit', async (e) => {
    e.preventDefault();
    triggerHaptic();

    const newCfg = {
      projectId: document.getElementById('fb-project-id').value.trim(),
      apiKey: document.getElementById('fb-api-key').value.trim(),
      authDomain: document.getElementById('fb-auth-domain').value.trim(),
      storageBucket: document.getElementById('fb-storage-bucket').value.trim(),
      messagingSenderId: config.messagingSenderId || '',
      appId: config.appId || ''
    };

    await saveActiveFirebaseConfig(newCfg);
    await triggerSync();
    closeModal();
    showToast('Configuração do Firebase atualizada!');
  });

  if (btnClearFb) {
    btnClearFb.addEventListener('click', async () => {
      triggerHaptic();
      await saveActiveFirebaseConfig({
        apiKey: '',
        authDomain: '',
        projectId: '',
        storageBucket: '',
        messagingSenderId: '',
        appId: ''
      });
      closeModal();
      showToast('Configuração do Firebase removida. Modo 100% local.');
    });
  }

  btnClose.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
}

/**
 * Modal: Visualização ampliada da foto da etiqueta
 */
export function openImageZoomModal(imageUrl, title = 'Foto da Etiqueta') {
  triggerHaptic();
  const zoomEl = document.createElement('div');
  zoomEl.className = 'modal-overlay';
  zoomEl.id = 'zoom-modal-overlay';
  zoomEl.style.zIndex = '300';
  zoomEl.innerHTML = `
    <div style="background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); max-width: 92vw; max-height: 85vh; padding: 14px; display: flex; flex-direction: column; align-items: center; box-shadow: var(--shadow-lg);">
      <div style="width: 100%; display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
        <span style="font-size: 0.9rem; font-weight: 700; color: var(--text-primary);">${escapeHTML(title)}</span>
        <button id="btn-close-zoom" class="sheet-close-btn" style="width: 28px; height: 28px;">✕</button>
      </div>
      <div style="overflow: auto; max-height: 70vh; border-radius: var(--radius-sm); border: 1px solid var(--border);">
        <img src="${imageUrl}" style="max-width: 100%; height: auto; display: block;" alt="Foto da etiqueta" />
      </div>
    </div>
  `;
  document.body.appendChild(zoomEl);

  const closeZoom = () => {
    if (document.body.contains(zoomEl)) {
      document.body.removeChild(zoomEl);
    }
  };
  zoomEl.querySelector('#btn-close-zoom').addEventListener('click', closeZoom);
  zoomEl.addEventListener('click', (e) => {
    if (e.target === zoomEl) closeZoom();
  });
}

/**
 * Modal Bottom Sheet: Histórico de Preços por Produto (Fase 3)
 * Menor/Maior/Último preço, gráfico SVG de variação e comparativo entre mercados
 */
export async function openProductHistoryModal(productName) {
  triggerHaptic();
  const stats = await getProductPriceStats(productName);

  if (!stats || stats.totalCompras === 0) {
    modalContainer.innerHTML = `
      <div class="modal-overlay" id="sheet-overlay">
        <div class="bottom-sheet">
          <div class="sheet-handle"></div>
          <div class="sheet-header">
            <div>
              <h3 class="sheet-title">${escapeHTML(productName)}</h3>
              <span class="item-subtitle" style="font-size: 0.8rem;">Histórico de Preços</span>
            </div>
            <button class="sheet-close-btn" id="btn-close-sheet">✕</button>
          </div>
          <div class="empty-state" style="padding: 24px 14px;">
            <span style="font-size: 2.2rem;">📊</span>
            <h4 style="color: var(--text-primary); font-size: 1rem; margin-top: 6px;">Nenhum preço registrado ainda</h4>
            <p style="font-size: 0.82rem; color: var(--text-muted); margin-top: 4px;">
              Ao fotografar etiquetas ou marcar itens no carrinho, o histórico deste produto será gerado automaticamente.
            </p>
          </div>
        </div>
      </div>
    `;
    const btnClose = document.getElementById('btn-close-sheet');
    const overlay = document.getElementById('sheet-overlay');
    btnClose.addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });
    return;
  }

  const formatDate = (iso) => {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
  };

  // Comparativo de economia entre mercados
  let savingsHtml = '';
  if (stats.porMercado && stats.porMercado.length > 1) {
    const cheapest = stats.porMercado[0];
    const mostExpensive = stats.porMercado[stats.porMercado.length - 1];
    const diff = mostExpensive.menor - cheapest.menor;
    if (diff > 0) {
      savingsHtml = `
        <div style="background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.35); border-radius: var(--radius-md); padding: 10px 12px; margin-bottom: 12px; font-size: 0.82rem; color: var(--text-primary);">
          💡 <strong>Onde compensa mais?</strong> No <strong>${escapeHTML(cheapest.mercado)}</strong> você economiza até <strong>${formatCurrency(diff)}</strong> por unidade em comparação ao ${escapeHTML(mostExpensive.mercado)}.
        </div>
      `;
    }
  }

  // Gráfico SVG de evolução temporal
  const chartHtml = renderPriceTrendSVG(stats.historicoAsc);

  modalContainer.innerHTML = `
    <div class="modal-overlay" id="sheet-overlay">
      <div class="bottom-sheet" style="max-height: 92vh;">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <div>
            <h3 class="sheet-title" style="font-size: 1.15rem;">${escapeHTML(stats.nome)}</h3>
            <span class="item-subtitle" style="font-size: 0.78rem;">${stats.totalCompras} compra(s) registrada(s)</span>
          </div>
          <button class="sheet-close-btn" id="btn-close-sheet">✕</button>
        </div>

        <!-- 1. Grid de 4 KPIs -->
        <div class="price-stats-grid">
          <div class="price-stat-card">
            <span class="price-stat-label">Menor Preço</span>
            <span class="price-stat-val best">${formatCurrency(stats.menorPreco)}</span>
            <span class="price-stat-sub">${escapeHTML(stats.menorMercado)} • ${formatDate(stats.menorData)}</span>
          </div>

          <div class="price-stat-card">
            <span class="price-stat-label">Último Pago</span>
            <span class="price-stat-val latest">${formatCurrency(stats.ultimoPreco)}</span>
            <span class="price-stat-sub">${escapeHTML(stats.ultimoMercado)} • ${formatDate(stats.ultimoData)}</span>
          </div>

          <div class="price-stat-card">
            <span class="price-stat-label">Maior Preço</span>
            <span class="price-stat-val high">${formatCurrency(stats.maiorPreco)}</span>
            <span class="price-stat-sub">${escapeHTML(stats.maiorMercado)} • ${formatDate(stats.maiorData)}</span>
          </div>

          <div class="price-stat-card">
            <span class="price-stat-label">Preço Médio</span>
            <span class="price-stat-val">${formatCurrency(stats.mediaPreco)}</span>
            <span class="price-stat-sub">${stats.variacaoPercentual >= 0 ? '+' : ''}${stats.variacaoPercentual}% histórico</span>
          </div>
        </div>

        <!-- 2. Gráfico de Tendência SVG -->
        <div style="margin-bottom: 14px;">
          ${chartHtml}
        </div>

        <!-- 3. Comparativo entre Mercados -->
        <div style="margin-bottom: 16px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 8px;">
            <h4 style="font-size: 0.88rem; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700;">
              🏪 Comparativo por Mercado
            </h4>
            <span style="font-size: 0.75rem; color: var(--text-muted);">${stats.porMercado.length} mercado(s)</span>
          </div>

          ${savingsHtml}

          <div>
            ${stats.porMercado.map((m, idx) => `
              <div class="market-compare-card ${idx === 0 ? 'is-best' : ''}">
                <div class="market-name-wrap">
                  <div class="market-name-title">
                    <span>${escapeHTML(m.mercado)}</span>
                    ${idx === 0 ? '<span class="market-badge-best">Mais Barato</span>' : ''}
                  </div>
                  <span style="font-size: 0.74rem; color: var(--text-muted);">
                    ${m.contagem}x comprado • Última vez em ${formatDate(m.dataUltimo)}
                  </span>
                </div>
                <div class="market-price-details">
                  <span class="market-price-val">${formatCurrency(m.menor)}</span>
                  <span style="font-size: 0.72rem; color: var(--text-muted);">
                    ${m.ultimo !== m.menor ? `Último: ${formatCurrency(m.ultimo)}` : 'menor valor'}
                  </span>
                </div>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- 4. Lista Cronológica de Compras Passadas -->
        <div>
          <h4 style="font-size: 0.88rem; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700; margin-bottom: 8px;">
            📜 Histórico de Compras (${stats.historicoDesc.length})
          </h4>

          <div>
            ${stats.historicoDesc.map(rec => {
              const subtotal = (Number(rec.quantidade) || 1) * (Number(rec.valor) || 0);
              const originBadge = rec.origem === 'etiqueta' ? '📷 Foto' : (rec.origem === 'nota' ? '🧾 Nota' : '🛒 Carrinho');
              return `
                <div class="history-record-card">
                  <div style="display: flex; align-items: center;">
                    ${rec.fotoUrl ? `
                      <button class="history-thumb-btn btn-view-photo" data-url="${escapeHTML(rec.fotoUrl)}" data-name="${escapeHTML(rec.nomeItem)}" title="Ver foto">
                        <img src="${escapeHTML(rec.fotoUrl)}" alt="Etiqueta" />
                      </button>
                    ` : ''}
                    <div>
                      <div style="font-size: 0.88rem; font-weight: 700; color: var(--text-primary);">
                        ${formatCurrency(rec.valor)} <span style="font-size: 0.72rem; font-weight: 500; color: var(--text-muted);">/un</span>
                      </div>
                      <div style="font-size: 0.75rem; color: var(--text-secondary);">
                        ${escapeHTML(rec.mercado || 'Mercado Geral')} • ${formatDate(rec.data)}
                      </div>
                      <div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 1px;">
                        ${rec.quantidade || 1} un (Tot: ${formatCurrency(subtotal)}) • <span style="color: var(--primary-light);">${originBadge}</span>
                      </div>
                    </div>
                  </div>

                  <button class="action-icon-btn btn-delete-history-entry" data-id="${rec.id}" style="color: var(--danger); font-size: 0.85rem;" title="Remover este registro">
                    🗑️
                  </button>
                </div>
              `;
            }).join('')}
          </div>
        </div>

        <!-- 5. Ação Rápida: Adicionar à Lista Atual com Preço Sugerido -->
        <button id="btn-add-to-list-from-history" class="sheet-btn-primary" style="width: 100%; margin-top: 16px;">
          + Adicionar "${escapeHTML(stats.nome)}" à Lista (Est: ${formatCurrency(stats.ultimoPreco)})
        </button>
      </div>
    </div>
  `;

  const btnClose = document.getElementById('btn-close-sheet');
  const overlay = document.getElementById('sheet-overlay');
  const btnAddToList = document.getElementById('btn-add-to-list-from-history');

  btnClose.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  // Zoom da foto
  modalContainer.querySelectorAll('.btn-view-photo').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openImageZoomModal(btn.dataset.url, btn.dataset.name);
    });
  });

  // Remoção de registro
  modalContainer.querySelectorAll('.btn-delete-history-entry').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      triggerHaptic();
      if (confirm('Deseja excluir este registro de preço do histórico?')) {
        await removePriceRecord(btn.dataset.id);
        showToast('Registro de preço removido.');
        openProductHistoryModal(productName);
      }
    });
  });

  // Adicionar à lista ativa
  if (btnAddToList) {
    btnAddToList.addEventListener('click', async () => {
      triggerHaptic();
      await addItem({
        nome: stats.nome,
        categoria: 'Geral',
        qtdPlanejada: 1,
        precoEstimado: stats.ultimoPreco || stats.menorPreco || 0
      });
      closeModal();
      showToast(`"${stats.nome}" adicionado com estimativa de ${formatCurrency(stats.ultimoPreco)}!`);
    });
  }
}

/**
 * Modal Bottom Sheet: Catálogo Geral de Histórico de Preços (Fase 3)
 */
export async function openPriceHistoryCatalogModal() {
  triggerHaptic();
  const trackedProducts = await getAllTrackedProducts();

  const renderProductList = (items) => {
    if (!items || items.length === 0) {
      return `
        <div class="empty-state" style="padding: 24px 14px;">
          <span style="font-size: 2rem;">🔍</span>
          <p style="font-size: 0.88rem; color: var(--text-muted); margin-top: 6px;">
            Nenhum produto encontrado com este nome.
          </p>
        </div>
      `;
    }

    return items
      .map(
        (p) => `
      <div class="catalog-item-card" data-name="${escapeHTML(p.nome)}">
        <div>
          <div style="font-size: 0.95rem; font-weight: 700; color: var(--text-primary); margin-bottom: 2px;">
            ${escapeHTML(p.nome)}
          </div>
          <div style="font-size: 0.75rem; color: var(--text-muted);">
            ${p.totalCompras} compra(s) • Último no ${escapeHTML(p.ultimoMercado)}
          </div>
        </div>

        <div style="text-align: right; display: flex; align-items: center; gap: 8px;">
          <div>
            <div style="font-size: 1rem; font-weight: 800; color: var(--success);">
              ${formatCurrency(p.ultimoPreco)}
            </div>
            ${
              p.menorPreco && p.menorPreco < p.ultimoPreco
                ? `
              <div style="font-size: 0.7rem; color: var(--text-muted);">
                Menor: ${formatCurrency(p.menorPreco)}
              </div>
            `
                : ''
            }
          </div>
          <span style="color: var(--text-muted); font-size: 1.1rem;">➔</span>
        </div>
      </div>
    `
      )
      .join('');
  };

  modalContainer.innerHTML = `
    <div class="modal-overlay" id="sheet-overlay">
      <div class="bottom-sheet" style="max-height: 90vh;">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <div>
            <h3 class="sheet-title">Histórico de Preços</h3>
            <span class="item-subtitle" style="font-size: 0.8rem;">Comparador de Mercados e Evolução</span>
          </div>
          <button class="sheet-close-btn" id="btn-close-sheet">✕</button>
        </div>

        <!-- Barra de Busca -->
        <div style="margin-bottom: 14px;">
          <input 
            type="text" 
            id="catalog-search-input" 
            class="form-input" 
            style="padding: 10px 14px; font-size: 0.92rem;" 
            placeholder="🔍 Buscar produto no histórico..." 
            autofocus 
          />
        </div>

        <!-- Lista de Produtos -->
        <div id="catalog-products-container" style="max-height: 58vh; overflow-y: auto;">
          ${renderProductList(trackedProducts)}
        </div>
      </div>
    </div>
  `;

  const btnClose = document.getElementById('btn-close-sheet');
  const overlay = document.getElementById('sheet-overlay');
  const searchInput = document.getElementById('catalog-search-input');
  const container = document.getElementById('catalog-products-container');

  const attachCardListeners = () => {
    container.querySelectorAll('.catalog-item-card').forEach((card) => {
      card.addEventListener('click', () => {
        openProductHistoryModal(card.dataset.name);
      });
    });
  };

  attachCardListeners();

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.toLowerCase().trim();
      const filtered = trackedProducts.filter((p) => p.nome.toLowerCase().includes(q));
      container.innerHTML = renderProductList(filtered);
      attachCardListeners();
    });
  }

  btnClose.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
}

/**
 * Renderização completa da UI
 */
export function renderUI() {
  renderHeader();
  renderModeSwitcher();
  renderListContent();
}
