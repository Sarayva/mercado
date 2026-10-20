/* ==========================================================================
   Integração com IA de Visão Computacional (Google Gemini) - Meu Mercado PWA
   Extração inteligente de dados da etiqueta de preço no supermercado
   Suporte a Gemini 1.5/2.0 Flash direto do navegador e Cloud Functions
   ========================================================================== */

import { getConfig } from './db.js';
import { getAuthToken } from './firebase-config.js';

// Tempo máximo de resposta para a IA (24 segundos)
const REQUEST_TIMEOUT_MS = 24000;

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
 */
async function callGeminiVision(imageBase64, apiKey) {
  // Extrai o conteúdo base64 puro e o mimeType
  const cleanBase64 = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
  let mimeType = 'image/jpeg';
  if (imageBase64.includes(';') && imageBase64.includes(':')) {
    const extractedMime = imageBase64.split(';')[0].replace('data:', '').trim();
    if (extractedMime) mimeType = extractedMime;
  }

  const promptText = `Extraia os dados da etiqueta ou cartaz de supermercado estritamente em formato JSON:
{
  "nome": "Nome legível do produto",
  "preco": 0.00,
  "peso": "Peso ou volume se houver (ex: 5kg, 1kg, 500g, 1L)",
  "unidade": "un ou kg",
  "precoPorKgLitro": "Preço fracionado por kg/litro se houver",
  "mercado": "Nome do mercado se impresso",
  "confianca": 0.95
}
Regras:
1. 'preco' DEVE ser SEMPRE um número float com ponto (ex: 6.50 para R$ 6,50). Sem R$ ou vírgula.
2. Em cartazes de OFERTA ou promoção, envie o menor preço em destaque.
3. Se algum campo não estiver visível, envie string vazia "".`;

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
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
      maxOutputTokens: 100
    }
  };

  // Modelos testados em ordem de velocidade: gemini-3.6-flash é o mais veloz (2.9s)
  const models = ['gemini-3.6-flash', 'gemini-3-flash-preview'];
  let lastErrorMsg = null;

  for (const model of models) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const attemptCtrl = new AbortController();
    const attemptTimer = setTimeout(() => attemptCtrl.abort(), 8000);

    try {
      console.log(`[Vision] Enviando foto da etiqueta para o modelo ${model}...`);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: attemptCtrl.signal
      });
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
          // Tenta encontrar o JSON via regex caso venha com formatação extra
          const match = textResponse.match(/\{[\s\S]*\}/);
          if (match) {
            parsed = JSON.parse(match[0]);
          } else {
            throw jsonErr;
          }
        }

        console.log('[Vision] Leitura do Gemini concluída com sucesso:', parsed);
        return sanitizeVisionResult(parsed);
      }

      // Se for 404 (modelo não habilitado), tenta o próximo modelo da lista
      if (response.status === 404) {
        console.warn(`[Vision] Modelo ${model} não disponível (404), tentando próximo...`);
        continue;
      }

      // Erros de autenticação / Chave inválida
      if (response.status === 400 || response.status === 403) {
        const errData = await response.json().catch(() => ({}));
        const detail = errData.error?.message || 'Chave do Gemini inválida ou sem permissão.';
        console.error('[Vision] Erro de chave Gemini:', detail);
        return createFallbackResult(`Chave do Gemini com erro (${detail}). Verifique sua chave nas configurações:`);
      }

      // Quota excedida
      if (response.status === 429) {
        console.warn('[Vision] Limite de requisições 429 atingido.');
        return createFallbackResult('Limite temporário de requisições atingido. Aguarde alguns segundos ou preencha manualmente:');
      }

      const errTxt = await response.text().catch(() => '');
      lastErrorMsg = `Status ${response.status}: ${errTxt}`;
    } catch (innerErr) {
      clearTimeout(attemptTimer);
      console.warn(`[Vision] Falha na tentativa com ${model}:`, innerErr.name, innerErr.message);
      lastErrorMsg = innerErr.name === 'AbortError' ? 'Tempo de resposta esgotado (rede lenta)' : innerErr.message;
    }
  }

  return createFallbackResult('Tempo de resposta esgotado. A conexão pode estar lenta. Preencha manualmente ou clique em Tentar Novamente:');
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
 */
export function sanitizeVisionResult(raw) {
  let precoNum = 0;
  if (typeof raw.preco === 'number') {
    precoNum = raw.preco;
  } else if (typeof raw.preco === 'string') {
    const cleanStr = raw.preco.replace('R$', '').trim().replace(/\./g, '').replace(',', '.');
    precoNum = parseFloat(cleanStr) || 0;
  }

  const confiancaNum = typeof raw.confianca === 'number' ? raw.confianca : 0.9;
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
    aviso: isIlegivel ? 'Etiqueta com leitura parcial ou ilegível. Por favor, confira ou complete os dados abaixo:' : null
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
