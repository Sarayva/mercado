/* ==========================================================================
   Gerenciamento de Estado Reativo & Cálculos ao Vivo - Meu Mercado PWA
   Controla a lista atual, totais em tempo real e pilha de Desfazer (Undo)
   ========================================================================== */

import { saveList, getListById, savePreco } from './db.js';

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
      diferenca: 0,
      orcamento: 0,
      saldoRestante: 0,
      percentualOrcamento: 0,
      totalEssenciais: 0,
      itensEssenciaisTotal: 0,
      itensEssenciaisPegos: 0
    };
  }

  const itens = state.currentList.itens;
  const orcamento = Number(state.currentList.orcamento) || 0;
  let totalCarrinho = 0;
  let totalEstimado = 0;
  let totalEstimadoItensPegos = 0;
  let itensPegos = 0;
  const itensTotal = itens.length;

  let totalEssenciais = 0;
  let itensEssenciaisTotal = 0;
  let itensEssenciaisPegos = 0;

  for (const item of itens) {
    const qtdPlan = Number(item.qtdPlanejada) || 0;
    const precoEst = Number(item.precoEstimado) || 0;
    totalEstimado += (qtdPlan * precoEst);

    const isEssencial = Boolean(item.essencial);
    if (isEssencial) {
      itensEssenciaisTotal++;
    }

    if (item.pego) {
      itensPegos++;
      const qtdReal = Number(item.qtdReal) || 0;
      const precoReal = Number(item.precoReal) || 0;
      const subtotalReal = (qtdReal * precoReal);
      totalCarrinho += subtotalReal;
      totalEstimadoItensPegos += (qtdReal * precoEst);

      if (isEssencial) {
        itensEssenciaisPegos++;
        totalEssenciais += subtotalReal;
      }
    } else {
      if (isEssencial) {
        // Se ainda não pego, soma a estimativa de gasto essencial
        totalEssenciais += (qtdPlan * precoEst);
      }
    }
  }

  const porcentagem = itensTotal > 0 ? Math.round((itensPegos / itensTotal) * 100) : 0;
  // Diferença: se compararmos o que já pegamos em relação ao estimado para esses itens
  const diferenca = totalCarrinho - totalEstimadoItensPegos;

  const saldoRestante = orcamento > 0 ? (orcamento - totalCarrinho) : 0;
  const percentualOrcamento = orcamento > 0 ? Math.round((totalCarrinho / orcamento) * 100) : 0;

  return {
    totalCarrinho: Math.round(totalCarrinho * 100) / 100,
    totalEstimado: Math.round(totalEstimado * 100) / 100,
    itensPegos,
    itensTotal,
    porcentagem,
    diferenca: Math.round(diferenca * 100) / 100,
    orcamento,
    saldoRestante: Math.round(saldoRestante * 100) / 100,
    percentualOrcamento,
    totalEssenciais: Math.round(totalEssenciais * 100) / 100,
    itensEssenciaisTotal,
    itensEssenciaisPegos
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
    essencial: Boolean(itemData.essencial),
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
 * Define ou atualiza o teto de gastos (orçamento) da lista atual
 */
export async function setListBudget(budgetAmount) {
  if (!state.currentList) return;
  const num = Math.max(0, Number(budgetAmount) || 0);
  state.currentList.orcamento = num;
  await persistCurrentList();
  notify();
}

/**
 * Alterna rapidamente a prioridade de um item entre Essencial e Normal
 */
export async function toggleItemEssential(itemId) {
  if (!state.currentList || !state.currentList.itens) return false;
  const item = state.currentList.itens.find(i => i.id === itemId);
  if (!item) return false;

  item.essencial = !item.essencial;
  await persistCurrentList();
  notify();
  return item.essencial;
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
export async function markItemAsTaken(itemId, qtdReal, precoReal, mercado = 'Mercado Geral') {
  const index = state.currentList.itens.findIndex(i => i.id === itemId);
  if (index === -1) return;

  const previousState = { ...state.currentList.itens[index] };
  const item = state.currentList.itens[index];

  item.pego = true;
  item.qtdReal = Number(qtdReal) || 1;
  item.precoReal = Number(precoReal) || 0;
  item.dataPego = new Date().toISOString();
  item.mercado = mercado || item.mercado || 'Mercado Geral';

  await persistCurrentList();

  // Alimenta automaticamente o histórico de preços
  if (item.precoReal > 0) {
    try {
      await savePreco({
        itemId: item.id,
        nomeItem: item.nome,
        categoria: item.categoria || 'Geral',
        valor: item.precoReal,
        quantidade: item.qtdReal,
        data: item.dataPego,
        mercado: item.mercado,
        origem: 'carrinho'
      });
    } catch (precoErr) {
      console.warn('[State] Não foi possível salvar histórico de preço:', precoErr);
    }
  }

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

/**
 * Remove todos os itens já comprados (pego === true) da lista atual
 */
export async function clearTakenItems() {
  const previous = JSON.parse(JSON.stringify(state.currentList.itens));
  const count = state.currentList.itens.filter(i => i.pego).length;
  if (count === 0) return 0;

  state.currentList.itens = state.currentList.itens.filter(i => !i.pego);
  await persistCurrentList();
  registerUndo(`${count} itens comprados removidos`, async () => {
    state.currentList.itens = previous;
    await persistCurrentList();
  });
  notify();
  return count;
}

/**
 * Adiciona um item capturado via etiqueta de preço:
 * 1. Grava no histórico de preços (IndexedDB)
 * 2. Adiciona ou atualiza no carrinho da lista atual
 * 3. Notifica para atualizar total ao vivo e progresso
 */
export async function addPriceEntryAndCartItem(data) {
  if (!state.currentList.itens) {
    state.currentList.itens = [];
  }

  // 1. Grava no histórico de preços
  const precoEntry = await savePreco({
    itemId: data.itemId || null,
    nomeItem: data.nome,
    valor: data.preco,
    peso: data.peso || '',
    unidade: data.unidade || 'un',
    precoPorKgLitro: data.precoPorKgLitro || null,
    quantidade: data.quantidade || 1,
    mercado: data.mercado || 'Mercado Geral',
    fotoUrl: data.fotoUrl || null,
    origem: 'etiqueta'
  });

  // 2. Procura se o item já existia na lista atual
  const existingIndex = state.currentList.itens.findIndex(
    i => i.nome.toLowerCase().trim() === data.nome.toLowerCase().trim()
  );

  let affectedItem;
  let previousState = null;
  let isNew = false;

  if (existingIndex !== -1) {
    previousState = { ...state.currentList.itens[existingIndex] };
    state.currentList.itens[existingIndex].pego = true;
    state.currentList.itens[existingIndex].qtdReal = Number(data.quantidade) || 1;
    state.currentList.itens[existingIndex].precoReal = Number(data.preco) || 0;
    state.currentList.itens[existingIndex].dataPego = new Date().toISOString();
    affectedItem = state.currentList.itens[existingIndex];
  } else {
    isNew = true;
    affectedItem = {
      id: 'item_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      nome: data.nome.trim(),
      categoria: data.categoria || 'Geral',
      qtdPlanejada: Number(data.quantidade) || 1,
      precoEstimado: Number(data.preco) || 0,
      pego: true,
      essencial: Boolean(data.essencial),
      qtdReal: Number(data.quantidade) || 1,
      precoReal: Number(data.preco) || 0,
      dataPego: new Date().toISOString()
    };
    state.currentList.itens.unshift(affectedItem);
  }

  await persistCurrentList();

  // 3. Suporte a Desfazer (Undo)
  registerUndo(`Item "${data.nome}" adicionado da etiqueta`, async () => {
    if (isNew) {
      state.currentList.itens = state.currentList.itens.filter(i => i.id !== affectedItem.id);
    } else {
      const idx = state.currentList.itens.findIndex(i => i.id === affectedItem.id);
      if (idx !== -1) {
        state.currentList.itens[idx] = previousState;
      }
    }
    await persistCurrentList();
  });

  notify();
  return affectedItem;
}

