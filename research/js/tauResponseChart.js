(function attachTauResponseChart(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.TauResponseChart = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this, function createTauResponseChartApi() {
  'use strict';

  const DEFAULT_TAUS = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
  const SECTORS = ['urban', 'agri', 'industry'];

  async function scanTau(options = {}) {
    const modelInput = options.modelInput;
    const baseParams = { ...(options.params || (modelInput && modelInput.params) || {}) };
    const solve = options.solveModelInput || options.solve || resolveDefaultSolver();
    const taus = normalizeTauGrid(options.taus || options.tauGrid || DEFAULT_TAUS);
    if (!modelInput || typeof solve !== 'function') {
      throw new Error('TauResponseChart.scanTau requires { modelInput, solveModelInput }.');
    }

    const points = [];
    for (const tau of taus) {
      const input = {
        ...modelInput,
        params: {
          ...baseParams,
          tau,
        },
      };
      const result = await solve(input);
      const point = {
        tau,
        ...summarizeResult(result),
      };
      points.push(point);
      if (typeof options.onPoint === 'function') options.onPoint(point, result);
    }

    return {
      points,
      params: baseParams,
      selectedIds: options.selectedIds || (options.scope && options.scope.selectedIds) || null,
      scope: options.scope || null,
    };
  }

  function summarizeResult(result) {
    const allocation = allocationTotalsFromResult(result);
    const environment = aggregateEnvironmentFlow(result);
    const dalyAvoided = getDalyAvoided(result);
    return {
      industryWithdrawal: allocation.industry,
      urbanWithdrawal: allocation.urban,
      agriWithdrawal: allocation.agri,
      environmentalFlow: environment.environmentalFlow,
      ecoBaseFlow: environment.ecoBaseFlow,
      inStreamFlow: environment.inStreamFlow,
      ecoSurplus: environment.ecoSurplus,
      dalyAvoided,
      dalyBurden: -dalyAvoided,
    };
  }

  function render(host, data, options = {}) {
    const target = typeof host === 'string' && typeof document !== 'undefined'
      ? document.querySelector(host)
      : host;
    if (!target) return null;
    target.innerHTML = renderToString(data, options);
    return target;
  }

  function renderToString(data, options = {}) {
    const points = normalizePointList(data);
    if (points.length < 2) {
      return '<div class="rich-empty trade-chart-empty"><span>等待 τ 扫描数据</span></div>';
    }

    const sorted = points.slice().sort((a, b) => a.tau - b.tau);
    const metrics = [
      { key: 'industryWithdrawal', label: '工业取水', color: '#d9480f' },
      { key: 'environmentalFlow', label: '环境流量', color: '#1f7a8c' },
      { key: 'dalyBurden', label: 'DALY负担', color: '#6d5bd0' },
    ];
    const chart = makeChartGeometry(sorted);
    const lines = metrics.map((metric) => renderMetricLine(sorted, metric, chart)).join('');
    const endLabels = metrics.map((metric, index) => renderEndLabel(sorted, metric, chart, index)).join('');
    const ticks = sorted.map((point) => {
      const x = chart.scaleX(point.tau);
      return `
        <line x1="${x.toFixed(1)}" y1="238" x2="${x.toFixed(1)}" y2="243" stroke="#82919a" stroke-width="1"></line>
        <text x="${x.toFixed(1)}" y="258" class="axis-label" text-anchor="middle">${formatPercent(point.tau)}</text>
      `;
    }).join('');

    return `
      <svg class="market-chart-svg tau-response-svg" viewBox="0 0 620 300" role="img" aria-label="τ响应曲线">
        <line class="axis" x1="62" y1="238" x2="574" y2="238"></line>
        <line class="axis" x1="62" y1="238" x2="62" y2="38"></line>
        ${ticks}
        ${lines}
        ${endLabels}
        <text x="72" y="28" class="chart-title">${escapeHtml(options.title || 'τ 响应：工业取水、环境流量、DALY负担')}</text>
        <text x="14" y="58" class="axis-label">归一化趋势</text>
        <text x="62" y="286" class="chart-footnote">橙=工业取水，蓝=环境流量，紫=DALY负担；各线独立归一化以突出方向。</text>
      </svg>
    `;
  }

  function makeChartGeometry(points) {
    const minTau = Math.min(...points.map((point) => point.tau), 0);
    const maxTau = Math.max(...points.map((point) => point.tau), 0.5);
    const left = 62;
    const top = 42;
    const width = 500;
    const height = 174;
    const bottom = top + height;
    return {
      left,
      top,
      width,
      height,
      bottom,
      scaleX: (tau) => left + ((tau - minTau) / Math.max(maxTau - minTau, 1e-9)) * width,
    };
  }

  function renderMetricLine(points, metric, chart) {
    const values = points.map((point) => numberOr(point[metric.key], 0));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const scaleY = (value) => chart.bottom - ((value - min) / Math.max(max - min, 1e-9)) * chart.height;
    const path = points.map((point, index) => {
      const x = chart.scaleX(point.tau);
      const y = scaleY(numberOr(point[metric.key], 0));
      return `${index ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');
    const titles = points.map((point) => `${formatPercent(point.tau)} ${metric.label} ${formatMetricValue(metric.key, point[metric.key])}`).join('；');
    return `<path d="${path}" fill="none" stroke="${metric.color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><title>${escapeHtml(titles)}</title></path>`;
  }

  function renderEndLabel(points, metric, chart, index) {
    const values = points.map((point) => numberOr(point[metric.key], 0));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const last = points[points.length - 1];
    const x = Math.min(chart.scaleX(last.tau) + 8, 560);
    const y = chart.bottom - ((numberOr(last[metric.key], 0) - min) / Math.max(max - min, 1e-9)) * chart.height + index * 2;
    return `<text x="${x.toFixed(1)}" y="${Math.max(46, Math.min(226, y)).toFixed(1)}" fill="${metric.color}" font-size="11" font-weight="820">${escapeHtml(metric.label)}</text>`;
  }

  function allocationTotalsFromResult(result) {
    const totals = { urban: 0, agri: 0, industry: 0 };
    if (!result) return totals;
    const direct = result.allocation || (result.aggregate && result.aggregate.allocation) || (result.totals && result.totals.allocation);
    if (direct && typeof direct === 'object') {
      SECTORS.forEach((sector) => {
        totals[sector] += numberOr(direct[sector], 0);
      });
      return totals;
    }
    const rows = Array.isArray(result.basinResults)
      ? result.basinResults
      : result.raw && Array.isArray(result.raw.nodes)
        ? result.raw.nodes
        : Array.isArray(result.nodes)
          ? result.nodes
          : [];
    rows.forEach((row) => {
      const allocation = row && row.allocation ? row.allocation : {};
      SECTORS.forEach((sector) => {
        totals[sector] += numberOr(allocation[sector], 0);
      });
    });
    return totals;
  }

  function aggregateEnvironmentFlow(result) {
    const rows = Array.isArray(result && result.basinResults)
      ? result.basinResults
      : result && result.raw && Array.isArray(result.raw.nodes)
        ? result.raw.nodes
        : Array.isArray(result && result.nodes)
          ? result.nodes
          : [];
    return rows.reduce((totals, row) => {
      const environment = readEnvironmentalFlow(row);
      totals.ecoBaseFlow += environment.ecoBaseFlow;
      totals.inStreamFlow += environment.inStreamFlow;
      totals.ecoSurplus += environment.ecoSurplus;
      totals.environmentalFlow += environment.environmentalFlow;
      return totals;
    }, {
      ecoBaseFlow: 0,
      inStreamFlow: 0,
      ecoSurplus: 0,
      environmentalFlow: 0,
    });
  }

  function readEnvironmentalFlow(row) {
    const sources = [
      row,
      row && row.environment,
      row && row.ecoFlow,
      row && row.modelNode,
      row && row.supply,
    ];
    const ecoBaseFlow = firstFiniteFromSources(sources, ['ecoBaseFlow', 'environmentalBaseFlow', 'baseFlow']);
    const inStreamFlow = firstFiniteFromSources(sources, ['inStreamFlow', 'environmentalFlow', 'qOutflow', 'outflow']);
    const ecoSurplus = firstFiniteFromSources(sources, ['ecoSurplus', 'environmentalSurplus']);
    const base = Math.max(0, ecoBaseFlow === null ? 0 : ecoBaseFlow);
    const inStream = Math.max(0, inStreamFlow === null ? 0 : inStreamFlow);
    const surplus = Math.max(0, ecoSurplus === null ? Math.max(0, inStream - base) : ecoSurplus);
    return {
      ecoBaseFlow: base,
      inStreamFlow: inStream,
      ecoSurplus: surplus,
      environmentalFlow: base + surplus,
    };
  }

  function getDalyAvoided(result) {
    const aggregate = result && result.aggregate ? result.aggregate : {};
    const direct = firstFinite([
      aggregate.dalyAvoided,
      aggregate.totalDalyAvoided,
      aggregate.dalyAvoidance,
      result && result.dalyAvoided,
    ]);
    if (direct !== null) return direct;
    const rows = Array.isArray(result && result.basinResults) ? result.basinResults : [];
    return rows.reduce((sum, row) => sum + numberOr(row && row.dalyAvoided, 0), 0);
  }

  function resolveDefaultSolver() {
    const root = typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : null;
    if (!root || !root.ResearchNetworkModel || typeof root.ResearchNetworkModel.solveNetwork !== 'function') return null;
    return async function solveWithResearchNetworkModel(input) {
      const params = {
        ...(input.params || {}),
        network: input,
        basins: input.basins,
        topology: input.topology,
      };
      return root.ResearchNetworkModel.solveNetwork(params);
    };
  }

  function normalizeTauGrid(values) {
    return Array.from(new Set((Array.isArray(values) ? values : DEFAULT_TAUS)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
      .map((value) => value > 1 ? value / 100 : value)))
      .sort((a, b) => a - b);
  }

  function normalizePointList(data) {
    const source = Array.isArray(data)
      ? data
      : Array.isArray(data && data.points)
        ? data.points
        : [];
    return source.map((point) => ({
      tau: numberOr(point.tau, 0),
      industryWithdrawal: numberOr(point.industryWithdrawal ?? point.industry ?? point.allocationIndustry, 0),
      environmentalFlow: numberOr(point.environmentalFlow ?? point.inStreamFlow, 0),
      dalyBurden: numberOr(point.dalyBurden ?? point.daly, -numberOr(point.dalyAvoided, 0)),
      dalyAvoided: numberOr(point.dalyAvoided, 0),
    })).filter((point) => Number.isFinite(point.tau));
  }

  function firstFiniteFromSources(sources, keys) {
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      for (const key of keys) {
        const value = firstFinite([source[key]]);
        if (value !== null) return value;
      }
    }
    return null;
  }

  function firstFinite(candidates) {
    const found = (candidates || []).find((value) => {
      if (value === undefined || value === null || value === '' || value === false) return false;
      return Number.isFinite(Number(value));
    });
    return found === undefined ? null : Number(found);
  }

  function formatMetricValue(key, value) {
    if (key === 'dalyBurden') return formatNumber(value, 1);
    return formatWater(value);
  }

  function formatWater(value) {
    const number = Number(value) || 0;
    const sign = number < 0 ? '-' : '';
    const abs = Math.abs(number);
    if (abs >= 100000000) return `${sign}${(abs / 100000000).toFixed(2)}亿m³`;
    if (abs >= 10000) return `${sign}${(abs / 10000).toFixed(1)}万m³`;
    return `${sign}${Math.round(abs)}m³`;
  }

  function formatNumber(value, digits) {
    return (Number(value) || 0).toLocaleString('zh-CN', {
      maximumFractionDigits: digits,
      minimumFractionDigits: digits,
    });
  }

  function formatPercent(value) {
    return `${Math.round((Number(value) || 0) * 100)}%`;
  }

  function numberOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  return {
    DEFAULT_TAUS,
    scanTau,
    summarizeResult,
    render,
    renderToString,
    _internals: {
      normalizeTauGrid,
      allocationTotalsFromResult,
      aggregateEnvironmentFlow,
      readEnvironmentalFlow,
    },
  };
});
