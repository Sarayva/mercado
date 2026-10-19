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

/**
 * Compara o preço atual com o valor pago há aproximadamente 1 mês (~20 a 45 dias atrás)
 * Informa se o produto subiu, caiu ou se manteve estável (inflação pessoal)
 */
export async function getMonthlyComparison(productName, currentPrice) {
  const price = Number(currentPrice) || 0;
  if (!productName || price <= 0) return null;

  const records = await getPricesForProduct(productName);
  if (!records || records.length === 0) return null;

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  // Procura compras feitas há ~30 dias (janela ideal de 18 a 50 dias atrás)
  const candidates = records
    .map((r) => {
      const recordTime = new Date(r.data).getTime();
      const daysAgo = (now - recordTime) / dayMs;
      return {
        record: r,
        daysAgo: Math.round(daysAgo),
        distanceTo30: Math.abs(daysAgo - 30)
      };
    })
    .filter((c) => c.daysAgo >= 14 && c.record.valor > 0);

  if (candidates.length === 0) {
    if (records.length > 1) {
      const oldest = records[0];
      const daysAgo = Math.max(1, Math.round((now - new Date(oldest.data).getTime()) / dayMs));
      const precoAnt = Number(oldest.valor) || 0;
      const diff = price - precoAnt;
      const pct = precoAnt > 0 ? (diff / precoAnt) * 100 : 0;
      return {
        encontrado: true,
        precoAnterior: precoAnt,
        dataAnterior: oldest.data,
        mercadoAnterior: oldest.mercado || 'Mercado Geral',
        diasAtras: daysAgo,
        diferenca: Math.round(diff * 100) / 100,
        percentual: Number(pct.toFixed(1)),
        status: diff > 0.05 ? 'mais_caro' : (diff < -0.05 ? 'mais_barato' : 'estavel'),
        rotuloPeriodo: `${daysAgo}d atrás`
      };
    }
    return null;
  }

  // Ordena pelo mais próximo de 30 dias
  candidates.sort((a, b) => a.distanceTo30 - b.distanceTo30);
  const best = candidates[0];
  const precoAnt = Number(best.record.valor) || 0;
  const diff = price - precoAnt;
  const pct = precoAnt > 0 ? (diff / precoAnt) * 100 : 0;

  return {
    encontrado: true,
    precoAnterior: precoAnt,
    dataAnterior: best.record.data,
    mercadoAnterior: best.record.mercado || 'Mercado Geral',
    diasAtras: best.daysAgo,
    diferenca: Math.round(diff * 100) / 100,
    percentual: Number(pct.toFixed(1)),
    status: diff > 0.05 ? 'mais_caro' : (diff < -0.05 ? 'mais_barato' : 'estavel'),
    rotuloPeriodo: best.daysAgo >= 22 && best.daysAgo <= 38 ? 'mês passado' : `há ${best.daysAgo} dias`
  };
}

/**
 * Analisa a melhor época para comprar um determinado produto
 * - 1ª Quinzena (dias 1-15) vs 2ª Quinzena (dias 16-31)
 * - Melhor dia da semana com menor média de preço
 */
export async function getBestBuyingPeriod(productName) {
  const records = await getPricesForProduct(productName);
  if (!records || records.length < 2) {
    return {
      temDados: false,
      mensagem: 'Histórico com poucas compras. Conforme você cadastrar mais compras, a melhor quinzena será calculada.'
    };
  }

  let soma1a = 0, count1a = 0;
  let soma2a = 0, count2a = 0;

  const diasSemanaMap = {
    0: { nome: 'Domingo', soma: 0, count: 0 },
    1: { nome: 'Segunda-feira', soma: 0, count: 0 },
    2: { nome: 'Terça-feira', soma: 0, count: 0 },
    3: { nome: 'Quarta-feira', soma: 0, count: 0 },
    4: { nome: 'Quinta-feira', soma: 0, count: 0 },
    5: { nome: 'Sexta-feira', soma: 0, count: 0 },
    6: { nome: 'Sábado', soma: 0, count: 0 }
  };

  records.forEach(r => {
    const val = Number(r.valor) || 0;
    if (val <= 0) return;

    const date = new Date(r.data);
    const diaDoMes = date.getDate();
    const diaDaSemana = date.getDay();

    if (diaDoMes <= 15) {
      soma1a += val;
      count1a++;
    } else {
      soma2a += val;
      count2a++;
    }

    if (diasSemanaMap[diaDaSemana]) {
      diasSemanaMap[diaDaSemana].soma += val;
      diasSemanaMap[diaDaSemana].count++;
    }
  });

  const media1a = count1a > 0 ? soma1a / count1a : null;
  const media2a = count2a > 0 ? soma2a / count2a : null;

  let melhorQuinzena = null;
  let economiaPct = 0;
  let diferencaMedia = 0;

  if (media1a !== null && media2a !== null) {
    if (Math.abs(media1a - media2a) < 0.1) {
      melhorQuinzena = 'Ambas as quinzenas com preços similares';
    } else if (media1a < media2a) {
      melhorQuinzena = '1ª Quinzena (dias 1 a 15)';
      diferencaMedia = media2a - media1a;
      economiaPct = (diferencaMedia / media2a) * 100;
    } else {
      melhorQuinzena = '2ª Quinzena (dias 16 a 31)';
      diferencaMedia = media1a - media2a;
      economiaPct = (diferencaMedia / media1a) * 100;
    }
  } else if (media1a !== null) {
    melhorQuinzena = '1ª Quinzena (registros atuais)';
  } else {
    melhorQuinzena = '2ª Quinzena (registros atuais)';
  }

  // Melhor dia da semana
  let melhorDia = null;
  let menorMediaDia = Infinity;
  Object.values(diasSemanaMap).forEach(d => {
    if (d.count > 0) {
      const m = d.soma / d.count;
      if (m < menorMediaDia) {
        menorMediaDia = m;
        melhorDia = d.nome;
      }
    }
  });

  return {
    temDados: true,
    totalCompras: records.length,
    melhorQuinzena,
    media1a: media1a !== null ? Number(media1a.toFixed(2)) : null,
    count1a,
    media2a: media2a !== null ? Number(media2a.toFixed(2)) : null,
    count2a,
    economiaPct: Number(economiaPct.toFixed(1)),
    diferencaMedia: Number(diferencaMedia.toFixed(2)),
    melhorDiaSemana: melhorDia,
    menorMediaDia: menorMediaDia !== Infinity ? Number(menorMediaDia.toFixed(2)) : null
  };
}

/**
 * Previsão de Reabastecimento Inteligente baseada no histórico de consumo:
 * Calcula o intervalo médio (em dias) entre compras de cada produto e compara
 * com a data da última compra. Se estiver no prazo ou atrasado, sugere para a próxima lista!
 */
export async function getReplenishmentSuggestions() {
  const allPrices = await getAllPrecos();
  if (!allPrices || allPrices.length === 0) return [];

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  // Agrupa por produto normalizado
  const map = {};
  allPrices.forEach(p => {
    const norm = normalizeProductName(p.nomeItem);
    if (!norm) return;
    if (!map[norm]) {
      map[norm] = {
        nome: p.nomeItem,
        categoria: p.categoria || 'Geral',
        compras: []
      };
    }
    map[norm].compras.push(p);
  });

  const suggestions = [];

  for (const norm in map) {
    const item = map[norm];
    // Ordena cronologicamente
    item.compras.sort((a, b) => new Date(a.data).getTime() - new Date(b.data).getTime());
    const count = item.compras.length;
    const ultimaCompra = item.compras[count - 1];
    const diasDesdeUltima = Math.max(0, Math.round((now - new Date(ultimaCompra.data).getTime()) / dayMs));

    let intervaloMedioDias = 30; // default 1 mês
    let confiancaPrevisao = 'estimada';

    if (count >= 2) {
      let somaIntervalos = 0;
      let totalIntervalos = 0;
      for (let i = 1; i < count; i++) {
        const prev = new Date(item.compras[i - 1].data).getTime();
        const curr = new Date(item.compras[i].data).getTime();
        const diffDays = (curr - prev) / dayMs;
        if (diffDays > 0) {
          somaIntervalos += diffDays;
          totalIntervalos++;
        }
      }
      if (totalIntervalos > 0) {
        intervaloMedioDias = Math.max(3, Math.round(somaIntervalos / totalIntervalos));
        confiancaPrevisao = 'alta';
      }
    }

    // Média de quantidade comprada
    const somaQtd = item.compras.reduce((acc, c) => acc + (Number(c.quantidade) || 1), 0);
    const qtdSugerida = Math.max(1, Math.round(somaQtd / count));
    const precoEst = Number(ultimaCompra.valor) || 0;

    // Condição de sugestão:
    // Se o tempo decorrido atingiu >= 70% do ciclo de consumo, ou se é item básico e passou >= 18 dias
    const pctCiclo = (diasDesdeUltima / intervaloMedioDias) * 100;

    if (pctCiclo >= 70 || diasDesdeUltima >= 20) {
      let urgencia = 'baixa';
      let motivo = '';

      if (diasDesdeUltima >= intervaloMedioDias) {
        const atraso = diasDesdeUltima - intervaloMedioDias;
        urgencia = 'alta';
        motivo = atraso === 0 
          ? `No prazo do ciclo de consumo (${intervaloMedioDias} dias)` 
          : `Provavelmente já acabou (${atraso}d além do ciclo de ${intervaloMedioDias}d)`;
      } else {
        urgencia = 'media';
        const faltam = intervaloMedioDias - diasDesdeUltima;
        motivo = `Quase acabando (restam aprox. ${faltam} dias do ciclo de ${intervaloMedioDias}d)`;
      }

      suggestions.push({
        nome: item.nome,
        norm,
        categoria: item.categoria,
        qtdSugerida,
        precoEstimado: precoEst,
        subtotalEstimado: qtdSugerida * precoEst,
        diasDesdeUltima,
        intervaloMedioDias,
        pctCiclo: Math.round(pctCiclo),
        urgencia, // 'alta' | 'media' | 'baixa'
        motivo,
        confiancaPrevisao,
        essencial: count >= 2 || ['Arroz', 'Feijão', 'Leite', 'Café', 'Óleo', 'Detergente'].some(s => item.nome.toLowerCase().includes(s.toLowerCase()))
      });
    }
  }

  // Ordena por urgência (alta primeiro) e depois por maior percentual de ciclo
  const urgenciaPeso = { alta: 3, media: 2, baixa: 1 };
  return suggestions.sort((a, b) => {
    const diffUrg = urgenciaPeso[b.urgencia] - urgenciaPeso[a.urgencia];
    if (diffUrg !== 0) return diffUrg;
    return b.pctCiclo - a.pctCiclo;
  });
}

