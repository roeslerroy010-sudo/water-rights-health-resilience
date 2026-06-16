(function () {
  'use strict';

  const DEFAULT_SECTORS = [
    { key: 'urban', label: '生活' },
    { key: 'agri', label: '农业' },
    { key: 'industry', label: '工业' },
  ];
  const WITHDRAWAL_SECTOR_KEYS = new Set(DEFAULT_SECTORS.map((sector) => sector.key));
  const CONSERVATION_EPS = 1e-3;
  const UNREALLOCATED_LABEL = '留在河道/未取用';
  const SUPPLEMENTAL_SOURCE_LABEL = '其他水源/新增取用';

  function render(container, payload) {
    if (!container) return '';
    const markup = renderToString(payload || {});
    container.innerHTML = markup;
    return markup;
  }

  function renderToString(payload) {
    const sectors = normalizeWithdrawalSectors(payload.sectors);
    const reallocation = normalizeReallocation(payload.reallocation || payload.sectorReallocation, sectors);
    const unreallocated = resolveUnreallocated(payload, reallocation);
    let links = buildSectorDispatchLinks(reallocation, unreallocated);
    let mode = 'sector';
    if (!links.length) {
      links = buildFlowDispatchLinks(payload.flows);
      mode = 'flow';
    }
    if (!links.length) {
      return '<div class="rich-empty trade-chart-empty">部门间净再配很小，暂无可绘制桑基流</div>';
    }
    const isFlowMode = mode === 'flow';
    const leftTitle = isFlowMode ? '净卖出区域' : '减用部门';
    const rightTitle = isFlowMode ? '净买入区域' : '增配部门';
    const ariaLabel = isFlowMode ? '区域水权交易流向桑基图' : '部门减用到增配的模型推导调度桑基图';

    const maxValue = Math.max(...links.map((link) => link.value), 1);
    const leftNodes = uniqueNodes(links, 'from');
    const rightNodes = uniqueNodes(links, 'to');
    const leftPositions = positionNodes(leftNodes);
    const rightPositions = positionNodes(rightNodes);
    if (!isFlowMode) {
      warnIfSankeyNotConserved(sumNodeSide(leftNodes, 'left'), sumNodeSide(rightNodes, 'right'), {
        phase: 'renderToString',
        leftTitle,
        rightTitle,
      });
    }
    const unreallocatedNode = rightNodes.find((node) => node.isUnreallocated);
    const supplementalSourceNode = leftNodes.find((node) => node.isSupplementalSource);
    const footnote = isFlowMode
      ? '基于‘有交易 − 自给自足’的市场再配估算，模型推导，非真实成交记录；带宽按卖方→买方水量。'
      : `基于‘有交易 − 自给自足’的市场再配估算，模型推导，非真实成交记录；带宽按部门净再配水量${unreallocatedNode ? `；减用的水未必全部再配，差额 ${formatWater(nodeSideValue(unreallocatedNode, 'right'))} ${UNREALLOCATED_LABEL}` : ''}${supplementalSourceNode ? `；增配差额来自“${SUPPLEMENTAL_SOURCE_LABEL}”` : ''}。`;

    return `
      <svg class="trade-sankey-svg" viewBox="0 0 620 310" role="img" aria-label="${ariaLabel}">
        <text x="24" y="24" class="chart-title">${leftTitle}</text>
        <text x="502" y="24" class="chart-title">${rightTitle}</text>
        ${links.map((link) => {
          const y1 = leftPositions[link.from.key];
          const y2 = rightPositions[link.to.key];
          const width = 3 + (link.value / maxValue) * 24;
          const title = isFlowMode
            ? `${escapeHtml(link.from.label)}卖出 ${formatWater(link.value)} → ${escapeHtml(link.to.label)}买入`
            : link.to.isUnreallocated
              ? `${escapeHtml(link.from.label)}减用 ${formatWater(link.value)} → ${UNREALLOCATED_LABEL}`
              : link.from.isSupplementalSource
                ? `${SUPPLEMENTAL_SOURCE_LABEL} ${formatWater(link.value)} → ${escapeHtml(link.to.label)}增配`
              : `${escapeHtml(link.from.label)}减用 ${formatWater(link.value)} → ${escapeHtml(link.to.label)}增配`;
          return `<path class="sankey-link" d="M 118 ${y1} C 260 ${y1}, 360 ${y2}, 502 ${y2}" stroke-width="${width.toFixed(2)}"><title>${title}</title></path>`;
        }).join('')}
        ${leftNodes.map((node) => renderNode(28, leftPositions[node.key], node, 'reduce')).join('')}
        ${rightNodes.map((node) => renderNode(506, rightPositions[node.key], node, node.isUnreallocated ? 'gain unreallocated' : 'gain')).join('')}
        <text x="24" y="292" class="chart-footnote">${footnote}</text>
      </svg>
    `;
  }

  function normalizeReallocation(reallocation, sectors) {
    const byKey = new Map();
    if (Array.isArray(reallocation)) {
      reallocation.forEach((item) => {
        if (item && item.key) byKey.set(item.key, item);
      });
    } else if (reallocation && typeof reallocation === 'object') {
      sectors.forEach((sector) => {
        byKey.set(sector.key, { key: sector.key, delta: reallocation[sector.key] });
      });
    }
    return sectors.map((sector) => {
      const source = byKey.get(sector.key) || {};
      return {
        key: sector.key,
        label: source.label || sector.label || sector.key,
        delta: numberOr(source.delta, 0),
        withMarket: numberOr(source.withMarket, 0),
        withoutMarket: numberOr(source.withoutMarket, 0),
      };
    });
  }

  function buildSectorDispatchLinks(reallocation, explicitUnreallocated) {
    const withdrawalReallocation = filterWithdrawalReallocation(reallocation);
    const reducers = withdrawalReallocation.filter((item) => item.delta < -1e-6);
    const gainers = withdrawalReallocation.filter((item) => item.delta > 1e-6);
    const totalReduce = reducers.reduce((sum, item) => sum + Math.abs(item.delta), 0);
    const totalGain = gainers.reduce((sum, item) => sum + item.delta, 0);
    const unreallocated = resolveUnreallocatedValue(explicitUnreallocated, totalReduce, totalGain);
    const supplemental = Math.max(0, totalGain - totalReduce);
    const sources = supplemental > 1e-6
      ? [...reducers, {
        key: 'supplemental-source',
        label: SUPPLEMENTAL_SOURCE_LABEL,
        delta: supplemental,
        value: supplemental,
        isSupplementalSource: true,
      }]
      : reducers;
    const targets = unreallocated > 1e-6
      ? [...gainers, {
        key: 'unreallocated',
        label: UNREALLOCATED_LABEL,
        delta: unreallocated,
        value: unreallocated,
        isUnreallocated: true,
      }]
      : gainers;
    const totalSource = sources.reduce((sum, item) => sum + Math.max(0, item.isSupplementalSource ? item.delta : Math.abs(item.delta)), 0);
    const totalTarget = targets.reduce((sum, item) => sum + Math.max(0, item.delta), 0);
    warnIfSankeyNotConserved(totalSource, totalTarget, {
      phase: 'buildSectorDispatchLinks',
      totalReduce,
      totalGain,
      unreallocated,
      supplemental,
    });
    if (!totalSource || !totalTarget) return [];
    return sources.flatMap((from) => targets.map((to) => ({
      from,
      to,
      value: (from.isSupplementalSource ? from.delta : Math.abs(from.delta)) * (to.delta / totalTarget),
    }))).filter((link) => link.value > 1e-6);
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

  function filterWithdrawalReallocation(reallocation) {
    return (Array.isArray(reallocation) ? reallocation : [])
      .filter((item) => item && WITHDRAWAL_SECTOR_KEYS.has(item.key));
  }

  function resolveUnreallocated(payload, reallocation) {
    const sectorReallocation = payload && payload.sectorReallocation;
    const reallocationSource = payload && payload.reallocation;
    const explicit = firstFinite([
      payload && payload.unreallocated,
      payload && payload.unreallocatedWater,
      sectorReallocation && sectorReallocation.unreallocated,
      sectorReallocation && sectorReallocation.unreallocatedWater,
      reallocationSource && !Array.isArray(reallocationSource) && reallocationSource.unreallocated,
      reallocationSource && !Array.isArray(reallocationSource) && reallocationSource.unreallocatedWater,
      Array.isArray(reallocationSource) && readUnreallocatedFromRows(reallocationSource),
    ]);
    const totalReduce = reallocation.reduce((sum, item) => item.delta < -1e-6 ? sum + Math.abs(item.delta) : sum, 0);
    const totalGain = reallocation.reduce((sum, item) => item.delta > 1e-6 ? sum + item.delta : sum, 0);
    return resolveUnreallocatedValue(explicit, totalReduce, totalGain);
  }

  function resolveUnreallocatedValue(explicitUnreallocated, totalReduce, totalGain) {
    const computed = Math.max(0, totalReduce - totalGain);
    const explicit = firstFinite([explicitUnreallocated]);
    if (explicit !== null && Math.abs(explicit - computed) > CONSERVATION_EPS) {
      warnSankey(`忽略不守恒的 unreallocated=${explicit}，改用 R-G=${computed}`, {
        totalReduce,
        totalGain,
        explicitUnreallocated: explicit,
        computedUnreallocated: computed,
      });
    }
    return computed;
  }

  function buildFlowDispatchLinks(flows) {
    const buckets = new Map();
    (Array.isArray(flows) ? flows : []).forEach((flow) => {
      const from = String(flow.from || flow.origin || flow.source || flow.seller || '');
      const to = String(flow.to || flow.target || flow.destination || flow.buyer || '');
      const volume = numberOr(flow.volume || flow.amount || flow.q, 0);
      if (!from || !to || volume <= 0) return;
      const key = `${from}->${to}`;
      if (!buckets.has(key)) {
        buckets.set(key, {
          from: {
            key: `from:${from}`,
            label: flow.fromName || flow.originName || flow.sourceName || flow.sellerName || from,
            value: 0,
          },
          to: {
            key: `to:${to}`,
            label: flow.toName || flow.targetName || flow.destinationName || flow.buyerName || to,
            value: 0,
          },
          value: 0,
        });
      }
      const bucket = buckets.get(key);
      bucket.value += volume;
      bucket.from.value += volume;
      bucket.to.value += volume;
    });
    return Array.from(buckets.values())
      .sort((a, b) => b.value - a.value)
      .slice(0, 6);
  }

  function uniqueNodes(links, side) {
    const map = new Map();
    links.forEach((link) => {
      map.set(link[side].key, link[side]);
    });
    return Array.from(map.values());
  }

  function positionNodes(nodes) {
    return Object.fromEntries(nodes.map((node, index) => {
      const y = 54 + index * (190 / Math.max(nodes.length - 1, 1));
      return [node.key, y];
    }));
  }

  function renderNode(x, y, node, tone) {
    const width = node.isUnreallocated ? 108 : 86;
    return `
      <g class="sankey-node ${tone}">
        <rect x="${x}" y="${y - 17}" width="${width}" height="34" rx="7"></rect>
        <text x="${x + 10}" y="${y - 2}">${escapeHtml(node.label)}</text>
        <text x="${x + 10}" y="${y + 12}" class="node-value">${formatWater(Math.abs(numberOr(node.delta, node.value || 0)))}</text>
      </g>
    `;
  }

  function sumNodeSide(nodes, side) {
    return (nodes || []).reduce((sum, node) => sum + nodeSideValue(node, side), 0);
  }

  function nodeSideValue(node, side) {
    if (!node) return 0;
    const raw = numberOr(node.value !== undefined ? node.value : node.delta, 0);
    if (side === 'left' && !node.isSupplementalSource) return Math.abs(raw);
    return Math.max(0, raw);
  }

  function warnIfSankeyNotConserved(leftTotal, rightTotal, context) {
    if (Math.abs(leftTotal - rightTotal) <= CONSERVATION_EPS) return;
    warnSankey('部门桑基左右总量不守恒', {
      ...(context || {}),
      leftTotal,
      rightTotal,
      diff: leftTotal - rightTotal,
    });
  }

  function warnSankey(message, context) {
    if (typeof console === 'undefined' || typeof console.warn !== 'function') return;
    console.warn(`[TradeSankey] ${message}`, context || {});
  }

  function numberOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function firstFinite(candidates) {
    const found = (candidates || []).find((value) => {
      if (value === undefined || value === null || value === '' || value === false) return false;
      const number = Number(value);
      return Number.isFinite(number);
    });
    return found === undefined ? null : Number(found);
  }

  function readUnreallocatedFromRows(rows) {
    const item = (rows || []).find((row) => row && (
      row.key === 'unreallocated'
      || row.key === 'retained'
      || row.label === UNREALLOCATED_LABEL
    ));
    return item ? firstFinite([item.delta, item.value, item.amount, item.volume]) : null;
  }

  function formatWater(value) {
    const number = Number(value) || 0;
    const sign = number < 0 ? '-' : '';
    const abs = Math.abs(number);
    if (abs >= 100000000) return `${sign}${(abs / 100000000).toFixed(2)}亿m³`;
    if (abs >= 10000) return `${sign}${(abs / 10000).toFixed(1)}万m³`;
    return `${sign}${Math.round(abs)}m³`;
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
    buildSectorDispatchLinks,
    buildFlowDispatchLinks,
  };

  if (typeof window !== 'undefined') {
    window.TradeSankey = api;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
