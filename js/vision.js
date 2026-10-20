/* ==========================================================================
   Integração com IA de Visão Computacional (Google Gemini) - Meu Mercado PWA
   Extração inteligente de dados da etiqueta de preço no supermercado
   Suporte a Gemini 1.5/2.0 Flash direto do navegador e Cloud Functions
   ========================================================================== */

import { getConfig, setConfig } from './db.js';
import { getAuthToken } from './firebase-config.js';

// Tempo máximo de resposta por tentativa da IA (15 segundos)
const REQUEST_TIMEOUT_PER_ATTEMPT_MS = 15000;

/**
 * Salva uma foto que não pôde ser processada (ex: erro 429 de cota ou sem rede)
 * na fila de pendentes para não perder nada.
 */
export async function savePendingVisionPhoto(photoDataUrl) {
  try {
    const list = (await getConfig('pendingVisionPhotos')) || [];
    list.push({
      id: 'tag_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      dataUrl: photoDataUrl,
      createdAt: new Date().toISOString()
    });
    // Limite preventivo para não estourar o armazenamento local (últimas 20 fotos)
    const trimmed = list.slice(-20);
    await setConfig('pendingVisionPhotos', trimmed);
    console.log('[Vision] Foto guardada na fila de pendentes com sucesso. Total:', trimmed.length);
  } catch (err) {
    console.warn('[Vision] Falha ao guardar foto pendente:', err);
  }
}

export async function getPendingVisionPhotos() {
  try {
    return (await getConfig('pendingVisionPhotos')) || [];
  } catch (e) {
    return [];
  }
}

export async function removePendingVisionPhoto(id) {
  try {
    const list = (await getConfig('pendingVisionPhotos')) || [];
    const filtered = list.filter(item => item.id !== id);
    await setConfig('pendingVisionPhotos', filtered);
  } catch (e) {}
}

/**
 * Envia a imagem da etiqueta para análise via OCR nativo do celular
 * ou Google Gemini 3.6 Flash em nuvem.
 */
export async function analyzePriceTag(imageBase64) {
  // 1. Flag de Desenvolvimento / Simulação Offline (opcional)
  const isDevSimulation = (await getConfig('devVisionSimulation')) === true;
  if (isDevSimulation) {
    console.info('[Vision] Modo de simulação de desenvolvimento ativo.');
    await new Promise((r) => setTimeout(r, 600));
    return getSimulatedVisionResult();
  }

  // 2. Tenta primeiro o leitor nativo do próprio celular (0,2 segundos, sem internet)
  try {
    const localResult = await tryNativeDeviceOCR(imageBase64);
    if (localResult && localResult.sucesso && localResult.preco > 0) {
      console.log('[Vision] Reconhecido instantaneamente via OCR Nativo:', localResult);
      return localResult;
    }
  } catch (ocrErr) {
    console.warn('[Vision] Erro no OCR nativo do aparelho:', ocrErr);
  }

  // 3. Verificação prévia de conexão de rede
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    console.warn('[Vision] Dispositivo offline.');
    return createFallbackResult('Sem conexão de internet no momento. Preencha os dados da etiqueta abaixo:');
  }

  // 4. Busca a chave do Gemini configurada no IndexedDB
  const geminiApiKey = (await getConfig('geminiApiKey')) || (await getConfig('visionApiKey'));
  const customFunctionUrl = await getConfig('visionFunctionUrl');

  // Se tem a chave do Gemini configurada, chama diretamente o Gemini 3.6 Flash ultra-rápido
  if (geminiApiKey && geminiApiKey.trim().length > 0) {
    return await callGeminiVision(imageBase64, geminiApiKey.trim());
  }

  // Se não tem chave do Gemini mas tem uma Cloud Function personalizada
  if (customFunctionUrl && customFunctionUrl.trim().length > 0 && !customFunctionUrl.startsWith('/api/')) {
    return await callCustomCloudFunction(imageBase64, customFunctionUrl.trim());
  }

  // Caso nenhuma chave esteja configurada
  return createFallbackResult('Chave do Google Gemini não encontrada. Adicione sua chave gratuita nas configurações para leitura automática:');
}

/**
 * Tenta executar o OCR nativo do próprio aparelho via TextDetector (Google Play Services / Shape Detection API)
 * Roda 100% offline no celular em ~100ms
 */
async function tryNativeDeviceOCR(imageBase64) {
  if (typeof window === 'undefined' || !('TextDetector' in window)) {
    return null;
  }

  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = imageBase64;
    });

    const detector = new window.TextDetector();
    const detectedTexts = await detector.detect(img);
    if (!detectedTexts || detectedTexts.length === 0) return null;

    const rawLines = detectedTexts.map(t => (t.rawValue || '').trim()).filter(Boolean);
    console.log('[NativeOCR] Linhas detectadas pelo aparelho:', rawLines);

    return parsePriceTagLines(rawLines);
  } catch (err) {
    console.warn('[NativeOCR] OCR nativo indisponível ou falhou:', err);
    return null;
  }
}

/**
 * Analisa as linhas de texto detectadas localmente para extrair nome, preço e unidade
 */
function parsePriceTagLines(lines) {
  if (!lines || lines.length === 0) return null;

  let preco = 0;
  let unidade = 'un';
  let nomeCandidatos = [];

  const noiseKeywords = [
    'OFERTA', 'OFERTAS', 'PREÇO', 'PRECO', 'LEVE', 'PAGUE', 'ECONOMIZE',
    'VALIDADE', 'CÓDIGO', 'CODIGO', 'TOTAL', 'SUBTOTAL', 'ATACADO', 'VAREJO',
    'SUPERMERCADO', 'SUPERMERCADOS', 'CLUBE', 'DESCONTO'
  ];

  for (const line of lines) {
    const clean = line.trim();

    // Detecta preço com vírgula ou ponto (ex: R$ 6,50 ou 6,50 ou 24.90)
    const priceMatch = clean.match(/(?:R\$|RS|\$)?\s*(\d{1,4}[.,]\d{2})(?!\d)/i);
    if (priceMatch) {
      const val = parseFloat(priceMatch[1].replace(',', '.'));
      if (val > 0 && (preco === 0 || val < preco)) {
        preco = val;
      }
    }

    // Detecta unidade (kg ou un)
    if (/\b(kg|quilo|quilos)\b/i.test(clean)) {
      unidade = 'kg';
    } else if (/\b(un|und|unid|unidade)\b/i.test(clean)) {
      unidade = 'un';
    }

    // Filtra palavras que são nomes de produtos válidos
    const upperClean = clean.toUpperCase();
    const isNoise = noiseKeywords.some(w => upperClean.includes(w)) || /^\d+[.,]?\d*$/.test(clean) || /^R\$/i.test(clean);
    if (!isNoise && clean.length >= 3 && /[a-zA-ZÀ-ÿ]/.test(clean)) {
      nomeCandidatos.push(clean);
    }
  }

  if (preco > 0) {
    // Escolhe a linha mais descritiva como nome do produto
    let nome = nomeCandidatos.length > 0 
      ? nomeCandidatos.reduce((a, b) => (b.length > a.length ? b : a), '')
      : 'Produto identificado';

    return sanitizeVisionResult({
      nome,
      preco,
      unidade,
      peso: unidade === 'kg' ? '1kg' : '',
      confianca: 0.96
    });
  }

  return null;
}

/**
 * Chama a API oficial do Google Gemini (Multimodal Vision)
 * Modelo: Gemini Flash / Flash-Lite com tier gratuito
 * Sem 'thinking' para máxima velocidade (3 a 4 segundos)
 */
async function callGeminiVision(imageBase64, apiKey) {
  // Extrai o conteúdo base64 puro e o mimeType
  const cleanBase64 = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
  let mimeType = 'image/jpeg';
  if (imageBase64.includes(';') && imageBase64.includes(':')) {
    const extractedMime = imageBase64.split(';')[0].replace('data:', '').trim();
    if (extractedMime) mimeType = extractedMime;
  }

  // Prompt estrito de sistema da Etapa 2
  const promptText = `Você lê etiquetas de preço de supermercado brasileiro a partir de uma foto. Responda SOMENTE com JSON válido: descricao (nome completo do produto), preco (número em reais), peso_valor (número ou null), peso_unidade ('g','kg','ml','l','un' ou null), preco_por_kg_ou_l (número ou null), codigo_barras (string ou null), confianca ('alta','media','baixa'). Campo ilegível = null. Nunca invente valores.`;

  // Modelos testados no tier grátis em ordem de velocidade e alta cota (Flash-Lite = 1.500/dia)
  const models = ['gemini-flash-lite-latest', 'gemini-flash-latest'];
  let lastErrorMsg = null;

  for (const model of models) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

    // Suporte a 1 tentativa adicional em caso de erro 429
    for (let attempt = 1; attempt <= 2; attempt++) {
      const attemptCtrl = new AbortController();
      const attemptTimer = setTimeout(() => attemptCtrl.abort(), REQUEST_TIMEOUT_PER_ATTEMPT_MS);

      const generationConfig = {
        responseMimeType: 'application/json',
        temperature: 0.1
      };
      // Apenas modelos que suportam thinkingConfig recebem thinkingBudget: 0
      if (!model.includes('lite')) {
        generationConfig.thinkingConfig = {
          thinkingBudget: 0
        };
      }

      const payload = {
        contents: [
          {
            parts: [
              { text: promptText },
              {
                inlineData: {
                  mimeType: mimeType,
                  data: cleanBase64
                }
              }
            ]
          }
        ],
        generationConfig
      };

      try {
        console.log(`[Vision] Enviando foto da etiqueta para ${model} (tentativa ${attempt}/2)...`);
        let response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload),
          signal: attemptCtrl.signal
        });

        // Caso o modelo não suporte thinkingConfig (retorne 400), remove e tenta sem thinking
        if (response.status === 400 && payload.generationConfig.thinkingConfig) {
          console.warn(`[Vision] Modelo ${model} rejeitou thinkingConfig. Retentando sem...`);
          delete payload.generationConfig.thinkingConfig;
          response = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload),
            signal: attemptCtrl.signal
          });
        }

        clearTimeout(attemptTimer);

        if (response.ok) {
          const data = await response.json();
          const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;

          if (!textResponse) {
            throw new Error('O modelo não retornou texto na resposta.');
          }

          let parsed = null;
          try {
            parsed = JSON.parse(textResponse);
          } catch (jsonErr) {
            const match = textResponse.match(/\{[\s\S]*\}/);
            if (match) {
              parsed = JSON.parse(match[0]);
            } else {
              throw jsonErr;
            }
          }

          console.log('[Vision] Leitura da etiqueta concluída com sucesso:', parsed);
          return sanitizeVisionResult(parsed);
        }

        // Se for 404 (modelo não habilitado na conta), tenta o próximo modelo da lista
        if (response.status === 404) {
          console.warn(`[Vision] Modelo ${model} indisponível (404), tentando próximo...`);
          break;
        }

        // Erro 429: limite temporário atingido
        if (response.status === 429) {
          console.warn(`[Vision] Limite 429 no modelo ${model}. Tentativa ${attempt}/2.`);
          if (attempt === 1) {
            await new Promise(r => setTimeout(r, 1800));
            continue;
          } else {
            console.warn(`[Vision] Cota do modelo ${model} esgotada. Tentando próximo modelo...`);
            lastErrorMsg = 'Limite 429 em ' + model;
            break; // Tenta o próximo modelo da lista em vez de abortar tudo!
          }
        }

        // Erros de autenticação / Chave inválida
        if (response.status === 400 || response.status === 403) {
          const errData = await response.json().catch(() => ({}));
          const detail = errData.error?.message || 'Chave do Gemini inválida ou sem permissão.';
          console.error('[Vision] Erro de chave Gemini:', detail);
          return createFallbackResult(`Chave do Gemini com erro (${detail}). Verifique sua chave nas configurações:`);
        }

        const errTxt = await response.text().catch(() => '');
        lastErrorMsg = `Status ${response.status}: ${errTxt}`;
        break; // Outros erros HTTP não repetem na mesma tentativa
      } catch (innerErr) {
        clearTimeout(attemptTimer);
        console.warn(`[Vision] Falha na tentativa ${attempt} com ${model}:`, innerErr.name, innerErr.message);
        lastErrorMsg = innerErr.name === 'AbortError' ? 'Tempo de resposta esgotado (rede lenta)' : innerErr.message;
        if (innerErr.name === 'AbortError') {
          break;
        }
      }
    }
  }

  if (lastErrorMsg && lastErrorMsg.includes('429')) {
    await savePendingVisionPhoto(imageBase64);
    return createFallbackResult('Limite temporário de requisições atingido. A foto foi guardada como pendente e não foi perdida. Preencha manualmente ou aguarde:', { isPending: true });
  }

  return createFallbackResult('Não foi possível ler a etiqueta automaticamente no momento (' + (lastErrorMsg || 'tempo esgotado') + '). Preencha abaixo ou clique em Tentar Novamente:');
}

/**
 * Chamada a uma Cloud Function personalizada (legado ou backend próprio)
 */
async function callCustomCloudFunction(imageBase64, endpointUrl) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const idToken = await getAuthToken();
    const headers = { 'Content-Type': 'application/json' };
    if (idToken) headers['Authorization'] = `Bearer ${idToken}`;

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

    return createFallbackResult('Não foi possível ler a etiqueta automaticamente no servidor. Preencha abaixo:');
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      return createFallbackResult('Tempo de resposta esgotado no servidor. Preencha manualmente:');
    }
    return createFallbackResult('Falha ao conectar ao servidor de visão. Preencha manualmente:');
  }
}

/**
 * Normaliza e valida os dados retornados pela IA
 * Suporta o schema da Etapa 2 (descricao, preco, peso_valor, peso_unidade, etc)
 * e mantém compatibilidade retroativa com o resto da UI
 */
export function sanitizeVisionResult(raw) {
  // Trata descrição / nome
  const nomeIdentificado = raw.descricao || raw.nome || '';

  // Trata preço (float numérico ou string formatada)
  let precoNum = 0;
  if (typeof raw.preco === 'number') {
    precoNum = raw.preco;
  } else if (typeof raw.preco === 'string') {
    const cleanStr = raw.preco.replace('R$', '').trim().replace(/\./g, '').replace(',', '.');
    precoNum = parseFloat(cleanStr) || 0;
  }

  // Trata unidade
  let unidadeStr = 'un';
  if (raw.peso_unidade) {
    unidadeStr = String(raw.peso_unidade).toLowerCase().trim();
  } else if (raw.unidade) {
    unidadeStr = String(raw.unidade).toLowerCase().trim();
  }

  // Trata peso / volume
  let pesoStr = '';
  if (raw.peso_valor !== null && raw.peso_valor !== undefined && raw.peso_valor !== '') {
    pesoStr = `${raw.peso_valor}${raw.peso_unidade || ''}`;
  } else if (raw.peso) {
    pesoStr = String(raw.peso).trim();
  } else if (unidadeStr === 'kg') {
    pesoStr = '1kg';
  }

  // Preço por kg ou litro
  let precoPorKgLitro = '';
  if (raw.preco_por_kg_ou_l !== null && raw.preco_por_kg_ou_l !== undefined && raw.preco_por_kg_ou_l !== '') {
    const num = Number(raw.preco_por_kg_ou_l);
    if (!isNaN(num) && num > 0) {
      precoPorKgLitro = `R$ ${num.toFixed(2).replace('.', ',')}/${unidadeStr === 'l' || unidadeStr === 'ml' ? 'L' : 'kg'}`;
    } else {
      precoPorKgLitro = String(raw.preco_por_kg_ou_l);
    }
  } else if (raw.precoPorKgLitro) {
    precoPorKgLitro = String(raw.precoPorKgLitro).trim();
  }

  // Código de barras
  const codigoBarras = raw.codigo_barras ? String(raw.codigo_barras).trim() : null;

  // Nível de confiança: 'alta', 'media', 'baixa'
  let confiancaNivel = 'alta';
  let confiancaNum = 0.95;
  if (typeof raw.confianca === 'string') {
    confiancaNivel = raw.confianca.toLowerCase().trim();
    if (confiancaNivel === 'alta') confiancaNum = 0.95;
    else if (confiancaNivel === 'media') confiancaNum = 0.75;
    else if (confiancaNivel === 'baixa') confiancaNum = 0.40;
  } else if (typeof raw.confianca === 'number') {
    confiancaNum = raw.confianca;
    confiancaNivel = confiancaNum >= 0.85 ? 'alta' : (confiancaNum >= 0.6 ? 'media' : 'baixa');
  }

  const isIlegivel = !nomeIdentificado && (!precoNum || precoNum <= 0);

  return {
    sucesso: !isIlegivel,
    descricao: nomeIdentificado ? String(nomeIdentificado).trim() : '',
    nome: nomeIdentificado ? String(nomeIdentificado).trim() : '', // Compatibilidade retroativa
    preco: !isNaN(precoNum) && precoNum > 0 ? Number(precoNum.toFixed(2)) : 0,
    peso_valor: raw.peso_valor !== undefined ? raw.peso_valor : null,
    peso_unidade: raw.peso_unidade || unidadeStr,
    peso: pesoStr, // Compatibilidade retroativa
    unidade: unidadeStr, // Compatibilidade retroativa
    preco_por_kg_ou_l: raw.preco_por_kg_ou_l !== undefined ? raw.preco_por_kg_ou_l : null,
    precoPorKgLitro: precoPorKgLitro, // Compatibilidade retroativa
    codigo_barras: codigoBarras,
    confianca: confiancaNum,
    confianca_nivel: confiancaNivel,
    mercado: raw.mercado ? String(raw.mercado).trim() : '',
    aviso: isIlegivel ? 'Etiqueta com leitura parcial ou ilegível. Por favor, confira ou complete os dados abaixo:' : null
  };
}

/**
 * Objeto de fallback padrão quando a IA não consegue ler ou ocorre falha de conexão
 */
function createFallbackResult(mensagemAviso, extra = {}) {
  return {
    sucesso: false,
    descricao: '',
    nome: '',
    preco: 0,
    peso_valor: null,
    peso_unidade: 'un',
    peso: '',
    unidade: 'un',
    preco_por_kg_ou_l: null,
    precoPorKgLitro: '',
    codigo_barras: null,
    confianca: 0.0,
    confianca_nivel: 'baixa',
    mercado: '',
    aviso: mensagemAviso,
    ...extra
  };
}

/**
 * Simulação de desenvolvimento para testes de interface offline
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
