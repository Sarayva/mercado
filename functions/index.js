/**
 * Firebase Cloud Function - Backend Seguro para IA de Visão (Fase 2)
 * 
 * NUNCA exponha sua chave da API (Claude ou Gemini) no front-end!
 * Esta função roda em ambiente de servidor seguro do Firebase e
 * recebe a foto comprimida do app, processa com o modelo de visão
 * e retorna os dados estruturados para o celular.
 * 
 * Como fazer o deploy:
 * 1. Instale o Firebase CLI: npm install -g firebase-tools
 * 2. Configure a chave secreta: firebase functions:secrets:set VISION_API_KEY
 * 3. Faça o deploy: firebase deploy --only functions
 */

const functions = require("firebase-functions");
const cors = require("cors")({ origin: true });

exports.analyzePriceTag = functions.https.onRequest((req, res) => {
  return cors(req, res, async () => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Método não permitido. Utilize POST." });
    }

    try {
      const { image } = req.body;
      if (!image) {
        return res.status(400).json({ error: "Imagem não fornecida." });
      }

      // Obtém a chave de API segura configurada no ambiente da nuvem
      const apiKey = process.env.VISION_API_KEY || functions.config().vision?.key;
      if (!apiKey) {
        return res.status(500).json({ error: "Chave VISION_API_KEY não configurada no servidor." });
      }

      const cleanBase64 = image.replace(/^data:image\/[a-z]+;base64,/, "");

      // Exemplo com API do Claude (Anthropic Messages API com suporte a imagem):
      // POST https://api.anthropic.com/v1/messages
      // header: x-api-key: apiKey, anthropic-version: 2023-06-01
      const prompt = `Analise a foto desta etiqueta de preço de supermercado brasileiro e extraia as seguintes informações em JSON estrito:
{
  "nome": "Nome completo e marca legível do produto",
  "preco": 0.00,
  "peso": "Peso ou volume ex: 1kg, 500g, 1L",
  "unidade": "kg, g, L, ml ou un",
  "precoPorKgLitro": "Preço por kg/litro se indicado",
  "mercado": "Nome do mercado se indicado"
}`;

      const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "claude-3-5-haiku-20241022",
          max_tokens: 400,
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
                  text: prompt
                }
              ]
            }
          ]
        })
      });

      if (!anthropicResponse.ok) {
        const errText = await anthropicResponse.text();
        return res.status(502).json({ error: "Erro na API de visão: " + errText });
      }

      const data = await anthropicResponse.json();
      const rawText = data.content[0].text;
      
      // Extrai JSON limpo da resposta
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

      return res.status(200).json(parsed);
    } catch (error) {
      console.error("Erro interno:", error);
      return res.status(500).json({ error: error.message });
    }
  });
});
