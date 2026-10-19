/* ==========================================================================
   Módulo de Histórico de Preços & Comparador - Meu Mercado PWA (Fase 3)
   Cálculo de estatísticas (menor/maior/último), comparativo de mercados,
   gerador de gráficos SVG em vetor puro e motor de sugestões de preços
   ========================================================================== */

import { getAllPrecos, savePreco, deletePreco, getConfig, setConfig } from './db.js';

/**
 * Normaliza o nome do produto para buscas insensíveis a maiúsculas e acentos
 */
export function normalizeProductName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Busca todos os registros de preço associados a um produto, ordenados por data
 */
export async function getPricesForProduct(productName) {
  const targetNorm = normalizeProductName(productName);
  if (!targetNorm) return [];

  const all = await getAllPrecos();
  return all
    .filter((p) => {
      const pNorm = normalizeProductName(p.nomeItem);
      if (!pNorm) return false;
      return pNorm === targetNorm || pNorm.includes(targetNorm) || targetNorm.includes(pNorm);
    })
    .sort((a, b) => new Date(a.data).getTime() - new Date(b.data).getTime());
}

/**
 * Calcula todas as estatísticas de preço de um produto e compara os supermercados
 */
export async function getProductPriceStats(productName) {
  const records = await getPricesForProduct(productName);
  if (!records || records.length === 0) return null;

  let menorValor = Infinity;
  let menorRecord = null;
  let maiorValor = -Infinity;
  let maiorRecord = null;
  let soma = 0;

  // Agrupamento por mercado
  const porMercadoMap = {};

  records.forEach((r) => {
    const val = Number(r.valor) || 0;
    soma += val;

    if (val < menorValor) {
      menorValor = val;
      menorRecord = r;
    }
    if (val > maiorValor) {
      maiorValor = val;
      maiorRecord = r;
    }

    const mercadoKey = (r.mercado || 'Mercado Geral').trim();
    if (!porMercadoMap[mercadoKey]) {
      porMercadoMap[mercadoKey] = {
        mercado: mercadoKey,
        menor: val,
        maior: val,
        ultimo: val,
        dataUltimo: r.data,
        quantidadeTotal: 0,
        contagem: 0,
        registros: []
      };
    }

    const m = porMercadoMap[mercadoKey];
    m.contagem++;
    m.quantidadeTotal += Number(r.quantidade) || 1;
    if (val < m.menor) m.menor = val;
    if (val > m.maior) m.maior = val;
    m.ultimo = val;
    m.dataUltimo = r.data;
    m.registros.push(r);
  });

  const ultimoRecord = records[records.length - 1];
  const primeiroRecord = records[0];
  const media = soma / records.length;

  // Ordena os mercados pelo menor preço para apontar onde é mais vantajoso comprar
  const porMercado = Object.values(porMercadoMap).sort((a, b) => a.menor - b.menor);

  // Variação percentual entre a primeira e a última compra
  const variacaoPercentual =
    primeiroRecord && primeiroRecord.valor > 0
      ? ((ultimoRecord.valor - primeiroRecord.valor) / primeiroRecord.valor) * 100
      : 0;

  return {
    nome: records[0].nomeItem || productName,
    totalCompras: records.length,
    menorPreco: menorValor !== Infinity ? menorValor : 0,
    menorMercado: menorRecord ? menorRecord.mercado : 'Mercado Geral',
    menorData: menorRecord ? menorRecord.data : null,
    maiorPreco: maiorValor !== -Infinity ? maiorValor : 0,
    maiorMercado: maiorRecord ? maiorRecord.mercado : 'Mercado Geral',
    maiorData: maiorRecord ? maiorRecord.data : null,
    ultimoPreco: ultimoRecord.valor,
    ultimoMercado: ultimoRecord.mercado || 'Mercado Geral',
    ultimoData: ultimoRecord.data,
    mediaPreco: media,
    variacaoPercentual: Number(variacaoPercentual.toFixed(1)),
    porMercado,
    historicoAsc: records, // Ordem cronológica para gráficos
    historicoDesc: [...records].reverse() // Ordem mais recente primeiro para listas
  };
}

/**
 * Retorna todos os produtos distintos rastreados com seus resumos de preço
 */
export async function getAllTrackedProducts() {
  const all = await getAllPrecos();
  const map = {};

  all.forEach((p) => {
    const norm = normalizeProductName(p.nomeItem);
    if (!norm) return;
    if (!map[norm]) {
      map[norm] = {
        nomeDisplay: p.nomeItem,
        norm,
        categoria: p.categoria || 'Geral',
        registros: []
      };
    }
    map[norm].registros.push(p);
  });

  const list = Object.values(map).map((item) => {
    const sorted = item.registros.sort(
      (a, b) => new Date(a.data).getTime() - new Date(b.data).getTime()
    );
    const ultimo = sorted[sorted.length - 1];
    let menor = Infinity;
    sorted.forEach((r) => {
      const v = Number(r.valor) || 0;
      if (v < menor) menor = v;
    });

    return {
      nome: item.nomeDisplay,
      norm: item.norm,
      totalCompras: sorted.length,
      ultimoPreco: ultimo ? Number(ultimo.valor) || 0 : 0,
      ultimoMercado: ultimo ? ultimo.mercado : 'Mercado Geral',
      ultimoData: ultimo ? ultimo.data : null,
      menorPreco: menor !== Infinity ? menor : 0
    };
  });

  return list.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

/**
 * Retorna lista de supermercados já conhecidos para preenchimento rápido
 */
export async function getKnownSupermarkets() {
  const all = await getAllPrecos();
  const set = new Set(['Assaí Atacadista', 'Carrefour', 'Pão de Açúcar', 'Mercado Geral']);
  all.forEach((p) => {
    if (p.mercado && p.mercado.trim()) {
      set.add(p.mercado.trim());
    }
  });
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

/**
 * Remove um registro de preço específico
 */
export async function removePriceRecord(id) {
  return await deletePreco(id);
}

/**
 * Popula preços de demonstração se o histórico estiver vazio
 */
export async function seedInitialPriceHistoryIfEmpty() {
  const isSeeded = await getConfig('demoPricesSeeded');
  if (isSeeded) return;

  const existing = await getAllPrecos();
  if (existing && existing.length > 0) {
    await setConfig('demoPricesSeeded', true);
    return;
  }

  console.info('[Prices] Populando dados históricos de demonstração para Fase 3...');

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  const demoRecords = [
    // Arroz 5kg
    {
      nomeItem: 'Arroz 5kg',
      valor: 26.9,
      quantidade: 1,
      mercado: 'Assaí Atacadista',
      data: new Date(now - 45 * dayMs).toISOString(),
      origem: 'carrinho'
    },
    {
      nomeItem: 'Arroz 5kg',
      valor: 29.5,
      quantidade: 1,
      mercado: 'Carrefour',
      data: new Date(now - 25 * dayMs).toISOString(),
      origem: 'carrinho'
    },
    {
      nomeItem: 'Arroz 5kg',
      valor: 27.9,
      quantidade: 1,
      mercado: 'Assaí Atacadista',
      data: new Date(now - 12 * dayMs).toISOString(),
      origem: 'etiqueta'
    },
    {
      nomeItem: 'Arroz 5kg',
      valor: 28.9,
      quantidade: 1,
      mercado: 'Carrefour',
      data: new Date(now - 2 * dayMs).toISOString(),
      origem: 'carrinho'
    },

    // Feijão Preto 1kg
    {
      nomeItem: 'Feijão Preto 1kg',
      valor: 7.99,
      quantidade: 2,
      mercado: 'Carrefour',
      data: new Date(now - 40 * dayMs).toISOString(),
      origem: 'carrinho'
    },
    {
      nomeItem: 'Feijão Preto 1kg',
      valor: 6.89,
      quantidade: 2,
      mercado: 'Assaí Atacadista',
      data: new Date(now - 18 * dayMs).toISOString(),
      origem: 'etiqueta'
    },
    {
      nomeItem: 'Feijão Preto 1kg',
      valor: 7.5,
      quantidade: 2,
      mercado: 'Assaí Atacadista',
      data: new Date(now - 3 * dayMs).toISOString(),
      origem: 'carrinho'
    },

    // Leite Integral 1L
    {
      nomeItem: 'Leite Integral 1L',
      valor: 5.29,
      quantidade: 6,
      mercado: 'Pão de Açúcar',
      data: new Date(now - 30 * dayMs).toISOString(),
      origem: 'carrinho'
    },
    {
      nomeItem: 'Leite Integral 1L',
      valor: 4.69,
      quantidade: 6,
      mercado: 'Assaí Atacadista',
      data: new Date(now - 15 * dayMs).toISOString(),
      origem: 'etiqueta'
    },
    {
      nomeItem: 'Leite Integral 1L',
      valor: 4.89,
      quantidade: 6,
      mercado: 'Carrefour',
      data: new Date(now - 1 * dayMs).toISOString(),
      origem: 'carrinho'
    },

    // Banana Prata (kg)
    {
      nomeItem: 'Banana Prata (kg)',
      valor: 5.99,
      quantidade: 1.5,
      mercado: 'Mercado Geral',
      data: new Date(now - 35 * dayMs).toISOString(),
      origem: 'carrinho'
    },
    {
      nomeItem: 'Banana Prata (kg)',
      valor: 7.49,
      quantidade: 1.2,
      mercado: 'Carrefour',
      data: new Date(now - 14 * dayMs).toISOString(),
      origem: 'carrinho'
    },
    {
      nomeItem: 'Banana Prata (kg)',
      valor: 6.99,
      quantidade: 1.5,
      mercado: 'Assaí Atacadista',
      data: new Date(now - 2 * dayMs).toISOString(),
      origem: 'carrinho'
    },

    // Detergente Líquido
    {
      nomeItem: 'Detergente Líquido',
      valor: 2.29,
      quantidade: 3,
      mercado: 'Assaí Atacadista',
      data: new Date(now - 42 * dayMs).toISOString(),
      origem: 'carrinho'
    },
    {
      nomeItem: 'Detergente Líquido',
      valor: 2.69,
      quantidade: 3,
      mercado: 'Carrefour',
      data: new Date(now - 20 * dayMs).toISOString(),
      origem: 'carrinho'
    },
    {
      nomeItem: 'Detergente Líquido',
      valor: 2.49,
      quantidade: 3,
      mercado: 'Assaí Atacadista',
      data: new Date(now - 4 * dayMs).toISOString(),
      origem: 'carrinho'
    }
  ];

  for (const item of demoRecords) {
    await savePreco(item);
  }

  await setConfig('demoPricesSeeded', true);
  console.info(`[Prices] ${demoRecords.length} registros históricos semeados com sucesso.`);
}

/**
 * Renderiza gráfico SVG leve em vetor puro com linha de evolução, gradiente e pontos
 */
export function renderPriceTrendSVG(historicoAsc, width = 340, height = 155) {
  if (!historicoAsc || historicoAsc.length === 0) return '';

  if (historicoAsc.length === 1) {
    const single = historicoAsc[0];
    const valFormatted = Number(single.valor).toFixed(2).replace('.', ',');
    const dataFormatted = new Date(single.data).toLocaleDateString('pt-BR');
    return `
      <div style="text-align: center; padding: 18px 12px; background: var(--bg); border: 1px dashed var(--border); border-radius: var(--radius-md);">
        <span style="font-size: 1.5rem; display: block; margin-bottom: 4px;">📈</span>
        <div style="font-size: 0.85rem; font-weight: 700; color: var(--text-primary);">1 registro cadastrado: R$ ${valFormatted}</div>
        <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 3px;">
          (${single.mercado || 'Mercado Geral'} em ${dataFormatted}) — O gráfico de evolução traçará a curva conforme novas compras forem feitas.
        </div>
      </div>
    `;
  }

  const paddingLeft = 52;
  const paddingRight = 24;
  const paddingTop = 22;
  const paddingBottom = 26;
  const chartW = width - paddingLeft - paddingRight;
  const chartH = height - paddingTop - paddingBottom;

  const valores = historicoAsc.map((h) => Number(h.valor) || 0);
  const minVal = Math.min(...valores);
  const maxVal = Math.max(...valores);
  const valRange = maxVal === minVal ? (minVal || 1) * 0.2 : maxVal - minVal;
  const floorVal = Math.max(0, minVal - valRange * 0.18);
  const ceilVal = maxVal + valRange * 0.18;
  const spread = ceilVal - floorVal || 1;

  const points = historicoAsc.map((h, i) => {
    const x = paddingLeft + (i / (historicoAsc.length - 1)) * chartW;
    const y = paddingTop + chartH - ((Number(h.valor) - floorVal) / spread) * chartH;
    return {
      x,
      y,
      valor: Number(h.valor) || 0,
      data: new Date(h.data).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
      mercado: h.mercado || 'Mercado Geral'
    };
  });

  const pathD = points.reduce((acc, pt, i) => {
    return i === 0 ? `M ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}` : `${acc} L ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`;
  }, '');

  const areaD = `${pathD} L ${points[points.length - 1].x.toFixed(1)} ${(paddingTop + chartH).toFixed(1)} L ${points[0].x.toFixed(1)} ${(paddingTop + chartH).toFixed(1)} Z`;

  const yMinPos = paddingTop + chartH - ((minVal - floorVal) / spread) * chartH;
  const yMaxPos = paddingTop + chartH - ((maxVal - floorVal) / spread) * chartH;

  const dotsSVG = points
    .map(
      (p) => `
    <g class="chart-point">
      <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.5" fill="#10b981" stroke="#090d16" stroke-width="2" />
      <text x="${p.x.toFixed(1)}" y="${(p.y - 7).toFixed(1)}" text-anchor="middle" font-size="8.5" font-weight="700" fill="#f8fafc">
        ${p.valor.toFixed(2).replace('.', ',')}
      </text>
    </g>
  `
    )
    .join('');

  const xLabels = points
    .map((p, idx) => {
      if (historicoAsc.length > 5 && idx % 2 !== 0 && idx !== points.length - 1) return '';
      return `
      <text x="${p.x.toFixed(1)}" y="${height - 7}" text-anchor="middle" font-size="8.5" fill="#94a3b8">
        ${p.data}
      </text>
    `;
    })
    .join('');

  return `
    <div class="price-chart-container" style="width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 8px 4px 4px 4px; box-sizing: border-box;">
      <div style="font-size: 0.74rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; padding: 2px 8px 4px 8px; display: flex; justify-content: space-between;">
        <span>Variação de Preço (R$)</span>
        <span style="color: var(--success); font-weight: 600;">Evolução</span>
      </div>
      <svg viewBox="0 0 ${width} ${height}" style="width: 100%; height: auto; display: block; overflow: visible;">
        <defs>
          <linearGradient id="chartFillGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#10b981" stop-opacity="0.35" />
            <stop offset="100%" stop-color="#10b981" stop-opacity="0.0" />
          </linearGradient>
        </defs>

        <!-- Linhas de referência -->
        <line x1="${paddingLeft}" y1="${yMaxPos.toFixed(1)}" x2="${width - paddingRight}" y2="${yMaxPos.toFixed(1)}" stroke="rgba(239, 68, 68, 0.3)" stroke-dasharray="3,3" />
        <text x="${paddingLeft - 4}" y="${(yMaxPos + 3).toFixed(1)}" text-anchor="end" font-size="8.5" fill="#f87171" font-weight="600">
          ${maxVal.toFixed(2).replace('.', ',')}
        </text>

        <line x1="${paddingLeft}" y1="${yMinPos.toFixed(1)}" x2="${width - paddingRight}" y2="${yMinPos.toFixed(1)}" stroke="rgba(16, 185, 129, 0.3)" stroke-dasharray="3,3" />
        <text x="${paddingLeft - 4}" y="${(yMinPos + 3).toFixed(1)}" text-anchor="end" font-size="8.5" fill="#34d399" font-weight="600">
          ${minVal.toFixed(2).replace('.', ',')}
        </text>

        <!-- Preenchimento e linha da curva -->
        <path d="${areaD}" fill="url(#chartFillGradient)" />
        <path d="${pathD}" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />

        <!-- Pontos e datas -->
        ${dotsSVG}
        ${xLabels}
      </svg>
    </div>
  `;
}
