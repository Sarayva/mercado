/* ==========================================================================
   Integração com IA de Visão Computacional - Meu Mercado PWA
   Extração inteligente de dados da etiqueta de preço no supermercado
   
   DIRETRIZ DE SEGURANÇA:
   - NUNCA expor chaves de API de IA no front-end.
   - Chamadas são sempre roteadas para a Cloud Function com autenticação.
   ========================================================================== */

import { getConfig } from './db.js';
import { getAuthToken } from './firebase-config.js';

// URL padrão da Cloud Function (configurável no app pelo usuário)
const DEFAULT_FUNCTION_URL = '/api/analyze-tag';
const REQUEST_TIMEOUT_MS = 15000; // 15 segundos de timeout

/**
 * Envia a imagem da etiqueta para a Cloud Function de visão.
 * Em qualquer caso de erro (sem internet, timeout, etiqueta ilegível),
 * retorna um resultado seguro com campos em branco e aviso amigável,
 * permitindo o preenchimento manual na tela de confirmação sem perder a foto.
 */
export async function analyzePriceTag(imageBase64) {
  // 1. Flag de Desenvolvimento (opcional, desligada por padrão)
  const isDevSimulation = (await getConfig('devVisionSimulation')) === true;
  if (isDevSimulation) {
    console.info('[Vision] Modo de simulação de desenvolvimento ativo.');
    await new Promise((r) => setTimeout(r, 1200));
    return getSimulatedVisionResult();
  }

  // 2. Verificação prévia de conexão de rede
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    console.warn('[Vision] Dispositivo offline.');
    return createFallbackResult('Sem conexão de internet no momento. Preencha os dados da etiqueta abaixo:');
  }

  const endpointUrl = (await getConfig('visionFunctionUrl')) || (await getConfig('visionProxyUrl')) || DEFAULT_FUNCTION_URL;

  // 3. Chamada à Cloud Function com Timeout e Token de Autenticação
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const idToken = await getAuthToken();
    const headers = {
      'Content-Type': 'application/json'
    };

    if (idToken) {
      headers['Authorization'] = `Bearer ${idToken}`;
    }

    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ image: imageBase64 }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json();
      return sanitizeVisionResult(data);
    }

    // Tratamento de respostas de erro da Cloud Function
    if (response.status === 429) {
      const errJson = await response.json().catch(() => ({}));
      return createFallbackResult(errJson.error || 'Limite diário de leituras atingido. Preencha manualmente:');
    }

    if (response.status === 401) {
      return createFallbackResult('Autenticação necessária na Cloud Function. Preencha manualmente:');
    }

    if (response.status === 413) {
      return createFallbackResult('A foto ficou muito grande. Tente novamente ou preencha manualmente:');
    }

    console.warn(`[Vision] Servidor retornou status ${response.status}.`);
    return createFallbackResult('Não foi possível ler a etiqueta automaticamente. Preencha os campos abaixo:');
  } catch (err) {
    clearTimeout(timeoutId);

    if (err.name === 'AbortError') {
      console.warn('[Vision] Timeout na leitura da etiqueta (mais de 15s).');
      return createFallbackResult('Tempo de resposta esgotado. A conexão pode estar lenta. Preencha manualmente:');
    }

    console.warn('[Vision] Falha na comunicação com a Cloud Function:', err.message);
    return createFallbackResult('Não foi possível conectar ao serviço de visão. Preencha manualmente:');
  }
}

/**
 * Normaliza e valida os dados retornados pela IA
 */
function sanitizeVisionResult(raw) {
  const precoNum = parseFloat(raw.preco);
  const confiancaNum = typeof raw.confianca === 'number' ? raw.confianca : 0.8;
  const isIlegivel = !raw.nome && (!precoNum || precoNum <= 0);

  return {
    sucesso: !isIlegivel,
    nome: raw.nome ? String(raw.nome).trim() : '',
    preco: !isNaN(precoNum) && precoNum > 0 ? Number(precoNum.toFixed(2)) : 0,
    peso: raw.peso ? String(raw.peso).trim() : '',
    unidade: raw.unidade ? String(raw.unidade).trim() : 'un',
    precoPorKgLitro: raw.precoPorKgLitro ? String(raw.precoPorKgLitro).trim() : '',
    mercado: raw.mercado ? String(raw.mercado).trim() : '',
    confianca: confiancaNum,
    aviso: isIlegivel ? 'Etiqueta com leitura parcial ou ilegível. Por favor, confira os valores abaixo:' : null
  };
}

/**
 * Objeto de fallback padrão quando a IA não consegue ler ou ocorre falha de conexão
 */
function createFallbackResult(mensagemAviso) {
  return {
    sucesso: false,
    nome: '',
    preco: 0,
    peso: '',
    unidade: 'un',
    precoPorKgLitro: '',
    mercado: '',
    confianca: 0.0,
    aviso: mensagemAviso
  };
}

/**
 * Simulação de desenvolvimento para testes de interface offline
 * ATIVADA SOMENTE se a flag `devVisionSimulation: true` estiver salva no IndexedDB
 */
function getSimulatedVisionResult() {
  const mockOptions = [
    {
      nome: 'Arroz Branco Tipo 1 5kg',
      preco: 27.99,
      peso: '5kg',
      unidade: 'kg',
      precoPorKgLitro: 'R$ 5,60/kg',
      mercado: 'Supermercado Central',
      confianca: 0.95
    },
    {
      nome: 'Leite Integral UHT 1L',
      preco: 4.69,
      peso: '1L',
      unidade: 'L',
      precoPorKgLitro: 'R$ 4,69/L',
      mercado: 'Supermercado Central',
      confianca: 0.92
    },
    {
      nome: 'Café Torrado e Moído 500g',
      preco: 19.9,
      peso: '500g',
      unidade: 'g',
      precoPorKgLitro: 'R$ 39,80/kg',
      mercado: 'Supermercado Central',
      confianca: 0.88
    }
  ];

  const random = mockOptions[Math.floor(Math.random() * mockOptions.length)];
  return {
    sucesso: true,
    ...random,
    aviso: null
  };
}
