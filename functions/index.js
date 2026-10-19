/**
 * Firebase Cloud Function - Backend Seguro para IA de Visão (Meu Mercado PWA)
 * 
 * DIRETRIZES DE SEGURANÇA E CUSTO:
 * 1. NUNCA exponha chaves de API de IA no front-end.
 * 2. Autenticação obrigatória (Firebase Auth anônimo ou usuário autenticado).
 * 3. Limite de tamanho de imagem (máx 2.5MB em base64).
 * 4. Rate-limit diário por usuário (máximo 50 leituras/dia) para proteção contra abuso.
 * 5. Prompt rigoroso: JSON estrito com campos nulos caso haja dúvida (nunca inventa valores).
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

// Inicializa o Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp();
}

// Chave da API mantida como Secret no Google Secret Manager
const visionApiKey = defineSecret("VISION_API_KEY");

// Configurações de proteção
const MAX_BASE64_LENGTH = 3.5 * 1024 * 1024; // ~2.5 MB
const DAILY_LIMIT_PER_USER = 50; // 50 leituras por usuário/dia

exports.analyzePriceTag = onRequest(
  {
    cors: true,
    secrets: [visionApiKey],
    timeoutSeconds: 30,
    maxInstances: 10,
    memory: "256MiB"
  },
  async (req, res) => {
    // 1. Apenas método POST
    if (req.method !== "POST") {
      return res.status(405).json({
        error: "Método não permitido. Utilize POST."
      });
    }

    try {
      // 2. Autenticação Obrigatória (Firebase Auth)
      const authHeader = req.headers.authorization || "";
      if (!authHeader.startsWith("Bearer ")) {
        return res.status(401).json({
          error: "Não autorizado. Token de autenticação Bearer ausente ou inválido."
        });
      }

      const idToken = authHeader.split("Bearer ")[1].trim();
      let decodedToken;
      try {
        decodedToken = await admin.auth().verifyIdToken(idToken);
      } catch (authErr) {
        console.warn("[Auth] Falha na validação do token:", authErr.message);
        return res.status(401).json({
          error: "Token de autenticação expirado ou inválido."
        });
      }

      const uid = decodedToken.uid;

      // 3. Rate Limiting Diário (Proteção contra abuso e custos excessivos)
      const todayStr = new Date().toISOString().slice(0, 10); // "AAAA-MM-DD"
      const rateLimitRef = admin.firestore().collection("rate_limits").doc(`${uid}_${todayStr}`);
      
      const rateDoc = await rateLimitRef.get();
      const currentUsage = rateDoc.exists ? (rateDoc.data().count || 0) : 0;

      if (currentUsage >= DAILY_LIMIT_PER_USER) {
        return res.status(429).json({
          error: `Limite diário atingido (${DAILY_LIMIT_PER_USER} leituras/dia). Digite os dados da etiqueta manualmente.`
        });
      }

      // Incrementa o contador de uso
      await rateLimitRef.set(
        {
          uid,
          date: todayStr,
          count: admin.firestore.FieldValue.increment(1),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      // 4. Validação da Imagem
      const { image } = req.body || {};
      if (!image || typeof image !== "string") {
        return res.status(400).json({ error: "Imagem não fornecida ou formato inválido." });
      }

      if (image.length > MAX_BASE64_LENGTH) {
        return res.status(413).json({ error: "Imagem excede o limite máximo permitido (~2.5MB)." });
      }

      const cleanBase64 = image.replace(/^data:image\/[a-z]+;base64,/, "");

      // 5. Obtenção da Chave Secreta
      // Tenta obter do Secret Manager ou variável de ambiente
      let apiKey = "";
      try {
        apiKey = visionApiKey.value();
      } catch (e) {
        apiKey = process.env.VISION_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY || "";
      }

      if (!apiKey) {
        console.error("[Config] Chave VISION_API_KEY não configurada no servidor.");
        return res.status(500).json({
          error: "Serviço de visão temporariamente indisponível (chave não configurada no servidor)."
        });
      }

      // 6. Chamada à API de Visão (Claude 3.5 Haiku ou Gemini 1.5 Flash)
      const isGemini = apiKey.startsWith("AIza");
      let extractedData;

      if (isGemini) {
        extractedData = await callGeminiVision(cleanBase64, apiKey);
      } else {
        // Padrão: Anthropic Claude (chave sk-ant-...)
        extractedData = await callClaudeVision(cleanBase64, apiKey);
      }

      return res.status(200).json(extractedData);
    } catch (error) {
      console.error("[Error] Erro no processamento da etiqueta:", error);
      return res.status(500).json({
        error: "Falha interna ao analisar etiqueta: " + (error.message || "Erro desconhecido")
      });
    }
  }
);

/**
 * Prompt rigoroso de extração: JSON puro com campos nulos caso não consiga ler
 */
const EXTRACTION_SYSTEM_PROMPT = `Você é um extrator especialista de dados de etiquetas de preços de supermercados brasileiros.
Sua missão é extrair com precisão absoluta os dados da etiqueta fotografada.

REGRAS CRÍTICAS E OBRIGATÓRIAS:
1. Responda ESTRITAMENTE um objeto JSON válido, sem qualquer texto adicional, sem formatação markdown (NÃO use blocos de código ou markdown como \`\`\`json).
2. NUNCA invente, presuma, adivinhe ou complete valores ausentes.
3. Se um campo não estiver perfeitamente visível na imagem ou se você tiver dúvida, use null.
4. "preco": Retorne o preço à vista como número float (ex: 24.99). NUNCA envie texto, "R$" ou vírgula. Se ilegível, null.
5. "nome": Nome comercial legível do produto com marca. Se ilegível, null.
6. "peso": Peso ou volume comercial (ex: "1kg", "500g", "1L"). Se não informado, null.
7. "unidade": Unidade de medida correspondente ("kg", "g", "L", "ml" ou "un"). Se incerto, "un".
8. "precoPorKgLitro": Valor por kg ou litro se estiver impresso na etiqueta (ex: "R$ 49,90/kg"). Se ausente, null.
9. "mercado": Nome do supermercado se o logotipo/nome estiver impresso na etiqueta. Se ausente, null.
10. "confianca": Um número decimal entre 0.0 e 1.0 indicando o grau de nitidez e certeza da leitura (ex: 0.95 se nítido, 0.4 se embaçado).
11. Se a imagem NÃO for uma etiqueta de preço ou estiver totalmente ilegível, retorne todos os campos como null e confianca: 0.0.

Estrutura JSON:
{
  "nome": string | null,
  "preco": number | null,
  "peso": string | null,
  "unidade": string | null,
  "precoPorKgLitro": string | null,
  "mercado": string | null,
  "confianca": number
}`;

/**
 * Chamada à API da Anthropic Claude (Claude 3.5 Haiku)
 */
async function callClaudeVision(cleanBase64, apiKey) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 450,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: cleanBase64
              }
            },
            {
              type: "text",
              text: "Extraia os dados desta etiqueta de preço seguindo estritamente o formato JSON solicitado."
            }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Erro na API Claude (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  const rawText = data.content && data.content[0] ? data.content[0].text : "";
  return parseAndSanitizeVisionOutput(rawText);
}

/**
 * Chamada alternativa à API do Google Gemini (Gemini 1.5 Flash)
 */
async function callGeminiVision(cleanBase64, apiKey) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: EXTRACTION_SYSTEM_PROMPT }]
        },
        contents: [
          {
            parts: [
              { text: "Extraia os dados desta etiqueta de preço em JSON estrito." },
              { inline_data: { mime_type: "image/jpeg", data: cleanBase64 } }
            ]
          }
        ],
        generationConfig: {
          response_mime_type: "application/json",
          temperature: 0.1
        }
      })
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Erro na API Gemini (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  const rawText =
    data.candidates &&
    data.candidates[0] &&
    data.candidates[0].content &&
    data.candidates[0].content.parts[0]
      ? data.candidates[0].content.parts[0].text
      : "";

  return parseAndSanitizeVisionOutput(rawText);
}

/**
 * Sanitiza a resposta recebida para garantir integridade e tipos corretos
 */
function parseAndSanitizeVisionOutput(rawText) {
  let parsed = {};
  try {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    } else {
      parsed = JSON.parse(rawText.trim());
    }
  } catch (err) {
    console.warn("[Parser] Não foi possível converter texto da IA em JSON:", rawText);
    return {
      nome: null,
      preco: null,
      peso: null,
      unidade: null,
      precoPorKgLitro: null,
      mercado: null,
      confianca: 0.0
    };
  }

  const precoNum = parseFloat(parsed.preco);

  return {
    nome: parsed.nome ? String(parsed.nome).trim() : null,
    preco: !isNaN(precoNum) && precoNum > 0 ? Number(precoNum.toFixed(2)) : null,
    peso: parsed.peso ? String(parsed.peso).trim() : null,
    unidade: parsed.unidade ? String(parsed.unidade).trim() : null,
    precoPorKgLitro: parsed.precoPorKgLitro ? String(parsed.precoPorKgLitro).trim() : null,
    mercado: parsed.mercado ? String(parsed.mercado).trim() : null,
    confianca: typeof parsed.confianca === "number" ? Math.max(0, Math.min(1, parsed.confianca)) : 0.85
  };
}
