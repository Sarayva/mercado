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
          <div class="item-price-info">
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
            <span class="item-subtitle">${detalhesPreco}</span>
          </div>
          <div class="item-price-info">
            <span class="item-real-total">${formatCurrency(subtotal)}</span>
            <span class="item-unit-price">${formatCurrency(item.precoReal)}/un</span>
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
          <button class="action-icon-btn btn-edit-item" data-id="${item.id}" title="Editar">✏️</button>
          <button class="action-icon-btn btn-delete-item" data-id="${item.id}" style="color: var(--danger);" title="Excluir">🗑️</button>
        </div>
      </div>
    `;
  });

  html += `</div>`;
  container.innerHTML = html;

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
 * Bottom Sheet: Modo Comprando - Pegar item e informar preço/qtd real
 */
export function openCartSheet(itemId, isEditing = false) {
  const item = state.currentList.itens.find(i => i.id === itemId);
  if (!item) return;

  let initialQtd = isEditing ? (item.qtdReal || item.qtdPlanejada || 1) : (item.qtdPlanejada || 1);
  let initialPrice = isEditing ? (item.precoReal || '') : (item.precoEstimado ? item.precoEstimado.toFixed(2) : '');

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
          ${item.precoEstimado > 0 ? `<span class="item-subtitle" style="display:block; margin-top:3px; font-size: 0.75rem;">Estimado: ${formatCurrency(item.precoEstimado)}</span>` : ''}
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
  const subtotalCalc = document.getElementById('sheet-subtotal-calc');
  const subtotalVal = document.getElementById('sheet-subtotal-val');
  const btnMinus = document.getElementById('btn-qtd-minus');
  const btnPlus = document.getElementById('btn-qtd-plus');
  const btnConfirm = document.getElementById('btn-confirm-cart');
  const btnClose = document.getElementById('btn-close-sheet');
  const overlay = document.getElementById('sheet-overlay');
  const btnReturn = document.getElementById('btn-return-pending');

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

    await markItemAsTaken(itemId, qtd, preco);
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
 * Modal: Adicionar Novo Item à Lista
 */
export function openAddItemModal() {
  const categories = ['Geral', 'Mercearia', 'Hortifruti', 'Carnes', 'Laticínios', 'Bebidas', 'Limpeza', 'Higiene', 'Padaria'];
  let selectedCategory = 'Geral';

  modalContainer.innerHTML = `
    <div class="modal-overlay" id="sheet-overlay">
      <div class="bottom-sheet">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <h3 class="sheet-title">Novo Item</h3>
          <button class="sheet-close-btn" id="btn-close-sheet">✕</button>
        </div>

        <form id="form-add-item">
          <div class="form-group">
            <label class="form-label">Nome do Produto *</label>
            <input type="text" id="input-item-name" class="form-input" placeholder="Ex: Café em Pó 500g" required autofocus />
          </div>

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
  const chips = document.querySelectorAll('#category-chips .chip');
  const btnMinus = document.getElementById('btn-add-minus');
  const btnPlus = document.getElementById('btn-add-plus');
  const btnClose = document.getElementById('btn-close-sheet');
  const overlay = document.getElementById('sheet-overlay');

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
export function openEditItemModal(itemId) {
  const item = state.currentList.itens.find(i => i.id === itemId);
  if (!item) return;

  const categories = ['Geral', 'Mercearia', 'Hortifruti', 'Carnes', 'Laticínios', 'Bebidas', 'Limpeza', 'Higiene', 'Padaria'];
  let selectedCategory = item.categoria || 'Geral';

  modalContainer.innerHTML = `
    <div class="modal-overlay" id="sheet-overlay">
      <div class="bottom-sheet">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <h3 class="sheet-title">Editar Item</h3>
          <button class="sheet-close-btn" id="btn-close-sheet">✕</button>
        </div>

        <form id="form-edit-item">
          <div class="form-group">
            <label class="form-label">Nome do Produto</label>
            <input type="text" id="input-edit-name" class="form-input" value="${escapeHTML(item.nome)}" required />
          </div>

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
      </div>
    </div>
  `;

  const overlay = document.getElementById('sheet-overlay');
  const btnClose = document.getElementById('btn-close-sheet');
  const btnCreate = document.getElementById('btn-create-list');
  const inputNewName = document.getElementById('input-new-list-name');

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

  btnClose.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
}

/**
 * Inicia o fluxo de captura de foto da etiqueta e extração por IA (Fase 2)
 */
export async function handleCameraScan() {
  try {
    triggerHaptic();
    // 1. Abre a câmera e comprime a foto
    const photo = await capturePriceTagPhoto();

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

    // 3. Processa a imagem com IA de visão
    const extractedData = await analyzePriceTag(photo.dataUrl);

    // 4. Abre a tela de confirmação editável
    openLabelConfirmSheet(extractedData, photo.dataUrl);
  } catch (err) {
    closeModal();
    if (err.message && !err.message.includes('Nenhuma foto')) {
      alert('Não foi possível ler a etiqueta: ' + err.message);
    }
  }
}

/**
 * TELA DE CONFIRMAÇÃO (Fase 2):
 * Mostra os campos preenchidos pela IA e editáveis antes de salvar
 */
export function openLabelConfirmSheet(extracted, photoDataUrl) {
  let precoUnit = Number(extracted.preco) || 0;

  modalContainer.innerHTML = `
    <div class="modal-overlay" id="sheet-overlay">
      <div class="bottom-sheet" style="max-height: 92vh;">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <div>
            <h3 class="sheet-title">Confirmar Produto</h3>
            <span class="item-subtitle" style="font-size: 0.8rem;">Verifique e ajuste os dados da etiqueta</span>
          </div>
          <button class="sheet-close-btn" id="btn-close-sheet">✕</button>
        </div>

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
 * Renderização completa da UI
 */
export function renderUI() {
  renderHeader();
  renderModeSwitcher();
  renderListContent();
}
