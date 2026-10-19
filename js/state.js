/* ==========================================================================
   Gerenciamento de Estado Reativo & Cálculos ao Vivo - Meu Mercado PWA
   Controla a lista atual, totais em tempo real e pilha de Desfazer (Undo)
   ========================================================================== */

import { saveList, getListById } from './db.js';

// Estado global da aplicação
export const state = {
  currentList: null,
  mode: 'comprando', // 'comprando' | 'planejando'
  activeCategory: 'todas',
  undoAction: null, // Guarda a última ação para desfazer
  listeners: []
};

/**
 * Inscreve uma função para ser executada sempre que o estado mudar
 */
export function subscribe(listener) {
  state.listeners.push(listener);
  return () => {
    state.listeners = state.listeners.filter(l => l !== listener);
  };
}

/**
 * Notifica todos os ouvintes sobre mudanças de estado
 */
export function notify() {
  state.listeners.forEach(fn => fn(state));
}

/**
 * Define a lista atual e notifica
 */
export function setCurrentList(list) {
  state.currentList = list;
  notify();
}

/**
 * Alterna entre modo "Comprando" (foco no corredor) e "Planejando" (organizar lista)
 */
export function setMode(newMode) {
  state.mode = newMode;
  notify();
}

/**
 * Filtra por categoria
 */
export function setCategoryFilter(category) {
  state.activeCategory = category;
  notify();
}

/* ==========================================================================
   CÁLCULOS MATEMÁTICOS AO VIVO
   O total da compra é SEMPRE calculado pelo app, nunca digitado.
   ========================================================================== */

export function calculateTotals() {
  if (!state.currentList || !state.currentList.itens) {
    return {
      totalCarrinho: 0,
      totalEstimado: 0,
      itensPegos: 0,
      itensTotal: 0,
      porcentagem: 0,
      diferenca: 0
    };
  }

  const itens = state.currentList.itens;
  let totalCarrinho = 0;
  let totalEstimado = 0;
  let totalEstimadoItensPegos = 0;
  let itensPegos = 0;
  const itensTotal = itens.length;

  for (const item of itens) {
    const qtdPlan = Number(item.qtdPlanejada) || 0;
    const precoEst = Number(item.precoEstimado) || 0;
    totalEstimado += (qtdPlan * precoEst);

    if (item.pego) {
      itensPegos++;
      const qtdReal = Number(item.qtdReal) || 0;
      const precoReal = Number(item.precoReal) || 0;
      totalCarrinho += (qtdReal * precoReal);
      totalEstimadoItensPegos += (qtdReal * precoEst);
    }
  }

  const porcentagem = itensTotal > 0 ? Math.round((itensPegos / itensTotal) * 100) : 0;
  // Diferença: se compararmos o que já pegamos em relação ao estimado para esses itens
  const diferenca = totalCarrinho - totalEstimadoItensPegos;

  return {
    totalCarrinho: Math.round(totalCarrinho * 100) / 100,
    totalEstimado: Math.round(totalEstimado * 100) / 100,
    itensPegos,
    itensTotal,
    porcentagem,
    diferenca: Math.round(diferenca * 100) / 100
  };
}

/* ==========================================================================
   AÇÕES NA LISTA (COM SUPORTE A "DESFAZER")
   ========================================================================== */

/**
 * Registra uma ação reversível na pilha de Undo
 */
export function registerUndo(description, undoFunction) {
  state.undoAction = {
    description,
    execute: async () => {
      await undoFunction();
      state.undoAction = null;
      notify();
    }
  };
}

/**
 * Executa o desfazer da última ação
 */
export async function performUndo() {
  if (state.undoAction && typeof state.undoAction.execute === 'function') {
    const action = state.undoAction;
    await action.execute();
    return action.description;
  }
  return null;
}

/**
 * Salva o estado atual da lista no IndexedDB
 */
async function persistCurrentList() {
  if (state.currentList) {
    await saveList(state.currentList);
  }
}

/**
 * Adiciona um novo item à lista
 */
export async function addItem(itemData) {
  const newItem = {
    id: 'item_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
    nome: itemData.nome.trim(),
    categoria: itemData.categoria || 'Geral',
    qtdPlanejada: Number(itemData.qtdPlanejada) || 1,
    precoEstimado: Number(itemData.precoEstimado) || 0,
    pego: false,
    qtdReal: Number(itemData.qtdPlanejada) || 1,
    precoReal: 0,
    dataPego: null
  };

  state.currentList.itens.unshift(newItem);
  await persistCurrentList();

  registerUndo(`Item "${newItem.nome}" adicionado`, async () => {
    state.currentList.itens = state.currentList.itens.filter(i => i.id !== newItem.id);
    await persistCurrentList();
  });

  notify();
  return newItem;
}

/**
 * Atualiza os dados de planejamento de um item existente
 */
export async function updateItem(itemId, updatedData) {
  const index = state.currentList.itens.findIndex(i => i.id === itemId);
  if (index === -1) return;

  const previousCopy = { ...state.currentList.itens[index] };
  state.currentList.itens[index] = {
    ...state.currentList.itens[index],
    ...updatedData
  };

  await persistCurrentList();

  registerUndo(`Item "${previousCopy.nome}" restaurado`, async () => {
    const idx = state.currentList.itens.findIndex(i => i.id === itemId);
    if (idx !== -1) {
      state.currentList.itens[idx] = previousCopy;
      await persistCurrentList();
    }
  });

  notify();
}

/**
 * Marca um item como pego no carrinho com quantidade e preço real
 */
export async function markItemAsTaken(itemId, qtdReal, precoReal) {
  const index = state.currentList.itens.findIndex(i => i.id === itemId);
  if (index === -1) return;

  const previousState = { ...state.currentList.itens[index] };

  state.currentList.itens[index].pego = true;
  state.currentList.itens[index].qtdReal = Number(qtdReal) || 1;
  state.currentList.itens[index].precoReal = Number(precoReal) || 0;
  state.currentList.itens[index].dataPego = new Date().toISOString();

  await persistCurrentList();

  registerUndo(`Item "${previousState.nome}" tirado do carrinho`, async () => {
    const idx = state.currentList.itens.findIndex(i => i.id === itemId);
    if (idx !== -1) {
      state.currentList.itens[idx] = previousState;
      await persistCurrentList();
    }
  });

  notify();
}

/**
 * Devolve um item do carrinho para a lista de pendentes
 */
export async function returnItemToPending(itemId) {
  const index = state.currentList.itens.findIndex(i => i.id === itemId);
  if (index === -1) return;

  const previousState = { ...state.currentList.itens[index] };

  state.currentList.itens[index].pego = false;
  await persistCurrentList();

  registerUndo(`Item "${previousState.nome}" recolocado no carrinho`, async () => {
    const idx = state.currentList.itens.findIndex(i => i.id === itemId);
    if (idx !== -1) {
      state.currentList.itens[idx] = previousState;
      await persistCurrentList();
    }
  });

  notify();
}

/**
 * Remove um item completamente da lista
 */
export async function removeItem(itemId) {
  const index = state.currentList.itens.findIndex(i => i.id === itemId);
  if (index === -1) return;

  const removedItem = { ...state.currentList.itens[index] };
  const removedIndex = index;

  state.currentList.itens.splice(index, 1);
  await persistCurrentList();

  registerUndo(`Item "${removedItem.nome}" removido`, async () => {
    state.currentList.itens.splice(removedIndex, 0, removedItem);
    await persistCurrentList();
  });

  notify();
}

/**
 * Limpa todos os itens marcados como pegos (reseta o carrinho)
 */
export async function clearCart() {
  const previousItens = JSON.parse(JSON.stringify(state.currentList.itens));

  state.currentList.itens.forEach(item => {
    item.pego = false;
    item.precoReal = 0;
  });

  await persistCurrentList();

  registerUndo(`Carrinho restaurado`, async () => {
    state.currentList.itens = previousItens;
    await persistCurrentList();
  });

  notify();
}
