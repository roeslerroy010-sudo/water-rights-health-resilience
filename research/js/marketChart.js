(function () {
  'use strict';

  const DEFAULT_SECTORS = [
    { key: 'urban', label: '生活' },
    { key: 'agri', label: '农业' },
    { key: 'industry', label: '工业' },
  ];
  const WITHDRAWAL_SECTOR_KEYS = new Set(DEFAULT_SECTORS.map((sector) => sector.key));

  const BASE_WILLINGNESS = {
    urban: 1.16,
    agri: 0.56,
    industry: 0.48,
  };

  function render(container, payload) {
    if (!container) return '';
    const markup = renderToString(payload || {});
    container.innerHTML = markup;
    return markup;
  }

  function renderToString(payload) {
    const sectors = normalizeWithdrawalSectors(payload.sectors);
    const withMarket = normalizeSectorMap(payload.withMarket, sectors);
    const withoutMarket = normalizeSectorMap(payload.withoutMarket, sectors);
    const params = payload.params || {};
    const steps = buildDemandSteps({ sectors, withMarket, withoutMarket, params });
    const marketPrice = numberOr(payload.marketPrice, numberOr(payload.aggregate && payload.aggregate.marketPrice, 0));
    const totalTraded = numberOr(payload.totalTraded, 0);
    const maxQty = Math.max(steps.reduce((sum, step) => sum + step.quantity, 0), totalTraded, 1);
    const maxPrice = Math.max(marketPrice, ...steps.map((step) => step.price), 0.1);
    const geometry = {
      x0: 62,
      y0: 238,
      width: 500,
      height: 182,
    };
    const demandSteps = renderDemandSteps(steps, maxQty, maxPrice, geometry);
    const clearQuantity = Math.min(totalTraded || maxQty * 0.56, maxQty);
    const clearX = geometry.x0 + (clearQuantity / maxQty) * geometry.width;
    const priceY = geometry.y0 - (marketPrice / maxPrice) * geometry.height;
    const tauText = formatPercent(params.tau);

    return `
      <svg class="market-chart-svg" viewBox="0 0 620 300" role="img" aria-label="市场出清教学示意图">
        <line class="axis" x1="62" y1="238" x2="574" y2="238"></line>
        <line class="axis" x1="62" y1="238" x2="62" y2="38"></line>
        ${demandSteps}
        <path class="market-supply-step" d="M 80 232 H ${clearX.toFixed(1)} V 58 H 560"></path>
        <line class="market-price-line" x1="62" y1="${priceY.toFixed(1)}" x2="574" y2="${priceY.toFixed(1)}"></line>
        <line class="market-clear-line" x1="${clearX.toFixed(1)}" y1="238" x2="${clearX.toFixed(1)}" y2="${priceY.toFixed(1)}"></line>
        <circle class="market-clear-point" cx="${clearX.toFixed(1)}" cy="${priceY.toFixed(1)}" r="5"></circle>
        <text x="72" y="28" class="chart-title">供需机制示意，τ=${tauText}</text>
        <text x="${Math.min(clearX + 8, 444).toFixed(1)}" y="${Math.max(priceY - 10, 50).toFixed(1)}" class="market-label">出清价 ${formatPrice(marketPrice)}</text>
        <text x="62" y="266" class="axis-label">累计水量</text>
        <text x="14" y="52" class="axis-label">单位价</text>
        <text x="62" y="286" class="chart-footnote">教学示意，非逐笔撮合曲线；模型为网络调度，本图用于解释价格机制。</text>
      </svg>
    `;
  }

  function renderDemandSteps(steps, maxQty, maxPrice, geometry) {
    let x = geometry.x0;
    return steps.map((step) => {
      const x1 = x;
      const x2 = x + (step.quantity / maxQty) * geometry.width;
      const y = geometry.y0 - (step.price / maxPrice) * geometry.height;
      x = x2;
      return `<path class="market-demand-step" d="M ${x1.toFixed(1)} ${y.toFixed(1)} H ${x2.toFixed(1)} V ${geometry.y0.toFixed(1)}"><title>${escapeHtml(step.label)} 需求阶梯 ${formatPrice(step.price)}</title></path>`;
    }).join('');
  }

  function buildDemandSteps(payload) {
    const source = payload || {};
    const tau = numberOr(source.params && source.params.tau, 0);
    const sectors = normalizeWithdrawalSectors(source.sectors);
    const withMarket = source.withMarket || {};
    const withoutMarket = source.withoutMarket || {};
    return sectors.map((sector) => {
      const quantity = Math.max(numberOr(withMarket[sector.key], 0), numberOr(withoutMarket[sector.key], 0), 1);
      const healthShift = sector.key === 'industry'
        ? -0.22 * tau
        : sector.key === 'urban' ? 0.18 * tau : 0.03 * tau;
      return {
        key: sector.key,
        label: sector.label,
        quantity,
        price: Math.max(0.03, BASE_WILLINGNESS[sector.key] + healthShift),
      };
    }).sort((a, b) => b.price - a.price);
  }

  function normalizeWithdrawalSectors(sectors) {
    const source = Array.isArray(sectors) && sectors.length ? sectors : DEFAULT_SECTORS;
    const byKey = new Map(source
      .filter((sector) => sector && WITHDRAWAL_SECTOR_KEYS.has(sector.key))
      .map((sector) => [sector.key, {
        key: sector.key,
        label: sector.label || sector.key,
      }]));
    DEFAULT_SECTORS.forEach((sector) => {
      if (!byKey.has(sector.key)) byKey.set(sector.key, sector);
    });
    return Array.from(byKey.values());
  }

  function normalizeSectorMap(map, sectors) {
    const source = map && typeof map === 'object' ? map : {};
    return Object.fromEntries(sectors.map((sector) => [sector.key, numberOr(source[sector.key], 0)]));
  }

  function numberOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function formatPercent(value) {
    return `${Math.round((Number(value) || 0) * 100)}%`;
  }

  function formatPrice(value) {
    return `${(Number(value) || 0).toFixed(3)}元/m³`;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  const api = {
    render,
    renderToString,
    buildDemandSteps,
  };

  if (typeof window !== 'undefined') {
    window.MarketChart = api;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
