(function attachTradeAggregate(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.TradeAggregate = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this, function createTradeAggregateApi() {
  'use strict';

  const EPS = 1e-9;
  const SECTORS = ['urban', 'agri', 'industry'];
  const ENVIRONMENT_FIELDS = ['ecoBaseFlow', 'inStreamFlow', 'ecoSurplus', 'legacyEcoAllocation'];
  const TRADING_COST = {
    none: 0,
    low: 0.02,
    medium: 0.06,
    med: 0.06,
    high: 0.12,
    prohibitive: 0.25,
  };

  function aggregateTradeFlows(tradeFlows, options) {
    const normalized = normalizeInput(tradeFlows, options);
    const nodeInfo = buildNodeInfo(normalized);
    const nodeDelta = computeNodeDelta(normalized.withTrade, normalized.autarky, nodeInfo);
    const pricing = extractTradePricing(normalized);
    const generatedFlows = buildTradeFlowsFromDelta(nodeDelta, nodeInfo, pricing.marketPrice, pricing.tradingCost);
    const pairBuckets = buildPairBuckets(generatedFlows, nodeInfo);
    const roundedDelta = roundMap(nodeDelta);
    const partnersByNode = buildPartnersByNode(pairBuckets, nodeInfo);
    const sellers = summarizeNodes(nodeDelta, nodeInfo, (net) => net < -EPS);
    const buyers = summarizeNodes(nodeDelta, nodeInfo, (net) => net > EPS);
    const baseline = normalized.sectorBaseline || normalized.autarky;
    const sectorReallocation = computeSectorReallocation(normalized.withTrade, baseline);
    const environmentFlow = computeEnvironmentFlow(normalized.withTrade, baseline);
    const totalTraded = Object.keys(nodeDelta).reduce((sum, id) => (
      nodeDelta[id] > EPS ? sum + nodeDelta[id] : sum
    ), 0);

    return {
      nodeDelta: roundedDelta,
      perNodeNet: roundedDelta,
      netSellers: sellers,
      netBuyers: buyers,
      sellers,
      buyers,
      totalTraded: round(totalTraded),
      partnersByNode,
      sectorReallocation,
      unreallocated: sectorReallocation.unreallocated,
      environmentFlow,
      environmentalFlow: environmentFlow,
      tradeFlows: generatedFlows,
      flows: generatedFlows,
    };
  }

  function normalizeInput(input, options) {
    const opts = options || {};
    const resultLike = isObject(input) && !Array.isArray(input) ? input : null;
    const flows = Array.isArray(input)
      ? input
      : Array.isArray(resultLike && resultLike.flows)
        ? resultLike.flows
        : Array.isArray(resultLike && resultLike.tradeFlows)
          ? resultLike.tradeFlows
          : [];

    const withTrade = firstDefined(
      opts.withTrade,
      opts.withMarket,
      opts.basinResults,
      resultLike && resultLike.withTrade,
      resultLike && resultLike.withMarket,
      resultLike && resultLike.basinResults,
      resultLike && resultLike.result,
      resultLike && resultLike.nodes,
      resultLike && resultLike.subbasins
    );
    const autarky = firstDefined(
      opts.autarky,
      opts.withoutMarket,
      opts.noMarketResult,
      opts.baseline,
      opts.autarkyResult,
      opts.baselineResult,
      resultLike && resultLike.autarky,
      resultLike && resultLike.withoutMarket,
      resultLike && resultLike.noMarketResult,
      resultLike && resultLike.baseline
    );
    const sectorBaseline = firstDefined(
      opts.sectorBaseline,
      opts.noMarketResult,
      opts.withoutMarket,
      opts.baselineResult,
      resultLike && resultLike.sectorBaseline,
      resultLike && resultLike.noMarketResult,
      resultLike && resultLike.withoutMarket,
      resultLike && resultLike.baseline,
      autarky
    );
    const params = firstDefined(
      opts.params,
      resultLike && resultLike.params,
      withTrade && withTrade.params,
      withTrade && withTrade.aggregate && withTrade.aggregate.params,
      withTrade && withTrade.raw && withTrade.raw.params
    );

    return {
      sourceFlows: flows,
      basinResults: firstDefined(opts.basinResults, resultLike && resultLike.basinResults, withTrade),
      withTrade,
      autarky,
      sectorBaseline,
      params,
      options: opts,
      resultLike,
    };
  }

  function buildNodeInfo(normalized) {
    const info = {};
    collectNodes(normalized.basinResults, info);
    collectNodes(normalized.withTrade, info);
    collectNodes(normalized.autarky, info);
    return info;
  }

  function collectNodes(source, target) {
    const rows = extractRows(source);
    rows.forEach((item) => {
      const id = cleanId(firstDefined(item.id, item.subbasinId, item.node, item.code));
      if (!id) return;
      target[id] = mergeNodeInfo(target[id], {
        id,
        name: firstDefined(item.name, item.label, item.displayName),
        code: firstDefined(item.code, item.pfafId, item.pfaf_id, item.id),
      });
    });
  }

  function computeNodeDelta(withTrade, autarky, nodeInfo) {
    const nodeDelta = {};
    Object.keys(nodeInfo).forEach((id) => ensureNode(nodeDelta, id));
    if (!hasAllocationSource(withTrade) || !hasAllocationSource(autarky)) {
      return nodeDelta;
    }

    const withAllocations = aggregateNodeAllocations(withTrade, nodeInfo);
    const autarkyAllocations = aggregateNodeAllocations(autarky, nodeInfo);
    const ids = new Set([
      ...Object.keys(nodeInfo),
      ...Object.keys(withAllocations),
      ...Object.keys(autarkyAllocations),
    ]);

    ids.forEach((id) => {
      ensureNode(nodeDelta, id);
      const withTotal = withAllocations[id] ? withAllocations[id].total : 0;
      const autarkyTotal = autarkyAllocations[id] ? autarkyAllocations[id].total : 0;
      const delta = withTotal - autarkyTotal;
      nodeDelta[id] = Math.abs(delta) <= EPS ? 0 : delta;
    });
    return nodeDelta;
  }

  function aggregateNodeAllocations(source, nodeInfo) {
    return extractRows(source).reduce((map, item) => {
      const id = cleanId(firstDefined(item.id, item.subbasinId, item.node, item.code));
      if (!id) return map;
      const allocation = normalizeSectorMap(firstDefined(item.allocation, item.allocated, item.waterAllocation, item.alloc));
      const total = allocationTotal(item, allocation);
      if (!map[id]) {
        map[id] = { total: 0, allocation: sectorMap(0) };
      }
      map[id].total += total;
      SECTORS.forEach((sector) => {
        map[id].allocation[sector] += allocation[sector];
      });
      nodeInfo[id] = mergeNodeInfo(nodeInfo[id], {
        id,
        name: firstDefined(item.name, item.label, item.displayName),
        code: firstDefined(item.code, item.pfafId, item.pfaf_id, item.id),
      });
      return map;
    }, {});
  }

  function allocationTotal(item, allocation) {
    const allocationSource = firstDefined(item && item.allocation, item && item.allocated, item && item.waterAllocation, item && item.alloc);
    if (isObject(allocationSource) && hasSectorAllocationKeys(allocationSource)) {
      return sumSectorMap(allocation);
    }
    const direct = firstDefined(
      item && item.allocationTotal,
      item && item.totalAllocation,
      item && item.totalAllocated,
      item && item.qWithdrawn,
      item && item.withdrawn,
      allocationSource && allocationSource.total,
      allocationSource && allocationSource.totalAllocation,
      allocationSource && allocationSource.withdrawn
    );
    if (direct !== undefined && direct !== null && direct !== '') {
      return finiteNumber(direct, sumSectorMap(allocation));
    }
    return sumSectorMap(allocation);
  }

  function buildTradeFlowsFromDelta(nodeDelta, nodeInfo, marketPrice, tradingCost) {
    const roundedMarketPrice = round(marketPrice || 0);
    const roundedTradingCost = round(tradingCost || 0);
    const averageUnitCost = round(roundedMarketPrice + roundedTradingCost);
    const sellers = Object.keys(nodeDelta)
      .filter((id) => nodeDelta[id] < -EPS)
      .map((id) => ({
        id,
        delta: nodeDelta[id],
        volume: Math.abs(nodeDelta[id]),
        meta: nodeInfo[id] || { id },
      }));
    const buyers = Object.keys(nodeDelta)
      .filter((id) => nodeDelta[id] > EPS)
      .map((id) => ({
        id,
        delta: nodeDelta[id],
        volume: nodeDelta[id],
        meta: nodeInfo[id] || { id },
      }));
    const totalSell = sellers.reduce((sum, item) => sum + item.volume, 0);
    const totalBuy = buyers.reduce((sum, item) => sum + item.volume, 0);
    const dispatchTotal = Math.min(totalSell, totalBuy);
    if (dispatchTotal <= EPS) return [];

    const sellerScale = dispatchTotal / totalSell;
    return sellers.flatMap((seller) => buyers.map((buyer) => {
      const volume = seller.volume * sellerScale * (buyer.volume / totalBuy);
      return {
        from: seller.id,
        to: buyer.id,
        volume: round(volume),
        fromName: (seller.meta && seller.meta.name) || seller.id,
        toName: (buyer.meta && buyer.meta.name) || buyer.id,
        fromCode: (seller.meta && seller.meta.code) || seller.id,
        toCode: (buyer.meta && buyer.meta.code) || buyer.id,
        sellerDelta: round(seller.delta),
        buyerDelta: round(buyer.delta),
        averageUnitCost,
        marketPrice: roundedMarketPrice,
        tradingCostPerM3: roundedTradingCost,
        sector: 'market-reallocation',
        direction: 'seller-to-buyer',
      };
    })).filter((flow) => flow.volume > EPS)
      .sort(compareByVolumeThenName);
  }

  function buildPairBuckets(flows, nodeInfo) {
    const pairBuckets = {};
    flows.forEach((flow) => {
      const from = cleanId(firstDefined(flow.from, flow.origin, flow.source, flow.seller));
      const to = cleanId(firstDefined(flow.to, flow.target, flow.destination, flow.buyer));
      const volume = nonNegative(firstDefined(flow.volume, flow.amount, flow.waterVolume, flow.q, flow.flow), 0);
      if (!from || !to || volume <= EPS) return;

      const fromMeta = mergeNodeInfo(nodeInfo[from], {
        id: from,
        name: firstDefined(flow.fromName, flow.originName, flow.sourceName, flow.sellerName),
        code: firstDefined(flow.fromCode, flow.originCode, flow.sourceCode, flow.sellerCode),
      });
      const toMeta = mergeNodeInfo(nodeInfo[to], {
        id: to,
        name: firstDefined(flow.toName, flow.targetName, flow.destinationName, flow.buyerName),
        code: firstDefined(flow.toCode, flow.targetCode, flow.destinationCode, flow.buyerCode),
      });
      nodeInfo[from] = fromMeta;
      nodeInfo[to] = toMeta;

      const pairKey = from + '\u0000' + to;
      if (!pairBuckets[pairKey]) {
        pairBuckets[pairKey] = {
          from,
          to,
          volume: 0,
          fromMeta,
          toMeta,
          flows: [],
        };
      }
      pairBuckets[pairKey].volume += volume;
      pairBuckets[pairKey].flows.push(flow);
    });
    return pairBuckets;
  }

  function buildPartnersByNode(pairBuckets, nodeInfo) {
    const partners = {};
    Object.keys(nodeInfo).forEach((id) => {
      partners[id] = { buyers: [], sellers: [] };
    });

    Object.keys(pairBuckets).forEach((key) => {
      const pair = pairBuckets[key];
      ensurePartnersNode(partners, pair.from);
      ensurePartnersNode(partners, pair.to);

      partners[pair.from].buyers.push(partnerRecord(pair.to, pair.toMeta || nodeInfo[pair.to], pair.volume));
      partners[pair.to].sellers.push(partnerRecord(pair.from, pair.fromMeta || nodeInfo[pair.from], pair.volume));
    });

    Object.keys(partners).forEach((id) => {
      partners[id].buyers.sort(compareByVolumeThenName);
      partners[id].sellers.sort(compareByVolumeThenName);
    });
    return partners;
  }

  function partnerRecord(id, meta, volume) {
    return {
      id,
      name: (meta && meta.name) || id,
      code: (meta && meta.code) || id,
      volume: round(volume),
    };
  }

  function computeSectorReallocation(withMarket, withoutMarket) {
    if (!hasAllocationSource(withMarket) || !hasAllocationSource(withoutMarket)) {
      return withUnreallocated(sectorMap(0));
    }
    const withTotals = aggregateAllocation(withMarket);
    const withoutTotals = aggregateAllocation(withoutMarket);
    const deltas = SECTORS.reduce((acc, sector) => {
      acc[sector] = round(withTotals[sector] - withoutTotals[sector]);
      return acc;
    }, {});
    return withUnreallocated(deltas);
  }

  function withUnreallocated(sectorDelta) {
    const reduced = SECTORS.reduce((sum, sector) => {
      const value = finiteNumber(sectorDelta && sectorDelta[sector], 0);
      return value < -EPS ? sum + Math.abs(value) : sum;
    }, 0);
    const increased = SECTORS.reduce((sum, sector) => {
      const value = finiteNumber(sectorDelta && sectorDelta[sector], 0);
      return value > EPS ? sum + value : sum;
    }, 0);
    return {
      ...sectorDelta,
      unreallocated: round(Math.max(0, reduced - increased)),
    };
  }

  function extractTradePricing(normalized) {
    return {
      marketPrice: extractMarketPrice(normalized),
      tradingCost: extractTradingCost(normalized),
    };
  }

  function extractMarketPrice(normalized) {
    const opts = normalized.options || {};
    const resultLike = normalized.resultLike || {};
    const withTrade = normalized.withTrade || {};
    return nonNegative(firstDefined(
      opts.marketPrice,
      opts.price,
      normalized.params && normalized.params.marketPrice,
      withTrade.marketPrice,
      withTrade.price,
      withTrade.aggregate && withTrade.aggregate.marketPrice,
      withTrade.result && withTrade.result.marketPrice,
      withTrade.raw && withTrade.raw.marketPrice,
      resultLike.marketPrice,
      resultLike.aggregate && resultLike.aggregate.marketPrice,
      resultLike.result && resultLike.result.marketPrice,
      resultLike.raw && resultLike.raw.marketPrice
    ), 0);
  }

  function extractTradingCost(normalized) {
    const opts = normalized.options || {};
    const resultLike = normalized.resultLike || {};
    const withTrade = normalized.withTrade || {};
    const params = normalized.params || {};
    return normalizeTradingCost(firstDefined(
      opts.tradingCostPerM3,
      opts.unitTradingCost,
      opts.tradingCost,
      opts.tradeCost,
      opts.transportCost,
      params.tradingCostPerM3,
      params.unitTradingCost,
      params.tradingCost,
      params.tradeCost,
      params.transportCost,
      withTrade.tradingCostPerM3,
      withTrade.unitTradingCost,
      withTrade.tradingCost,
      withTrade.tradeCost,
      withTrade.transportCost,
      withTrade.aggregate && withTrade.aggregate.tradingCostPerM3,
      withTrade.result && withTrade.result.tradingCostPerM3,
      withTrade.raw && withTrade.raw.tradingCostPerM3,
      resultLike.tradingCostPerM3,
      resultLike.unitTradingCost,
      resultLike.tradingCost,
      resultLike.tradeCost,
      resultLike.transportCost
    ));
  }

  function normalizeTradingCost(raw) {
    if (raw === undefined || raw === null || raw === '') return 0;
    if (typeof raw === 'number') return Math.max(0, raw);
    if (isObject(raw)) {
      return nonNegative(firstDefined(raw.tradingCostPerM3, raw.unitCost, raw.cost, raw.perM3, raw.value), 0);
    }
    if (typeof raw === 'string') {
      const key = raw.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(TRADING_COST, key)) return TRADING_COST[key];
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return Math.max(0, parsed);
    }
    return 0;
  }

  function hasAllocationSource(source) {
    if (Array.isArray(source)) return source.length > 0;
    if (!isObject(source)) return false;
    return Boolean(
      Array.isArray(source.basinResults)
      || Array.isArray(source.nodes)
      || Array.isArray(source.subbasins)
      || isObject(source.nodeById)
      || isObject(source.allocation)
      || isObject(source.totals && source.totals.allocation)
      || isObject(source.aggregate && source.aggregate.allocation)
    );
  }

  function aggregateAllocation(source) {
    const rows = extractRows(source);
    if (!rows.length && isObject(source)) {
      return normalizeSectorMap(firstDefined(source.allocation, source.totals && source.totals.allocation, source.aggregate && source.aggregate.allocation));
    }

    return rows.reduce((totals, item) => {
      const allocation = normalizeSectorMap(firstDefined(item.allocation, item.allocated, item.waterAllocation));
      SECTORS.forEach((sector) => {
        totals[sector] += allocation[sector];
      });
      return totals;
    }, sectorMap(0));
  }

  function extractRows(source) {
    if (Array.isArray(source)) return source;
    if (!isObject(source)) return [];
    if (Array.isArray(source.basinResults)) return source.basinResults;
    if (Array.isArray(source.nodes)) return source.nodes;
    if (Array.isArray(source.subbasins)) return source.subbasins;
    if (isObject(source.nodeById)) return Object.values(source.nodeById);
    return [];
  }

  function normalizeSectorMap(source) {
    const raw = isObject(source) ? source : {};
    return {
      urban: finiteNumber(firstDefined(raw.urban, raw.domestic, raw.municipal, raw.living), 0),
      agri: finiteNumber(firstDefined(raw.agri, raw.agriculture, raw.farm), 0),
      industry: finiteNumber(firstDefined(raw.industry, raw.industrial, raw.ind), 0),
    };
  }

  function sumSectorMap(map) {
    return SECTORS.reduce((sum, sector) => sum + finiteNumber(map && map[sector], 0), 0);
  }

  function hasSectorAllocationKeys(source) {
    if (!isObject(source)) return false;
    return [
      'urban', 'domestic', 'municipal', 'living',
      'agri', 'agriculture', 'farm',
      'industry', 'industrial', 'ind',
      'eco', 'ecology', 'ecological', 'environment',
    ].some((key) => Object.prototype.hasOwnProperty.call(source, key));
  }

  function computeEnvironmentFlow(withMarket, withoutMarket) {
    const withSummary = summarizeEnvironmentFlow(withMarket);
    const withoutSummary = summarizeEnvironmentFlow(withoutMarket);
    const delta = ENVIRONMENT_FIELDS.reduce((acc, field) => {
      acc[field] = round(withSummary[field] - withoutSummary[field]);
      return acc;
    }, {});
    delta.total = round(withSummary.total - withoutSummary.total);
    return {
      withMarket: withSummary,
      withoutMarket: withoutSummary,
      delta,
    };
  }

  function summarizeEnvironmentFlow(source) {
    const rows = extractRows(source);
    const fromRows = rows.reduce((totals, item) => addEnvironmentSignals(totals, item), environmentMap(0));
    const direct = readEnvironmentObject(source);
    const totals = hasEnvironmentSignal(fromRows) || !direct
      ? fromRows
      : addEnvironmentSignals(environmentMap(0), direct);
    if (totals.ecoSurplus <= EPS && totals.inStreamFlow > totals.ecoBaseFlow) {
      totals.ecoSurplus = round(totals.inStreamFlow - totals.ecoBaseFlow);
    }
    totals.total = round(totals.inStreamFlow || (totals.ecoBaseFlow + totals.ecoSurplus));
    ENVIRONMENT_FIELDS.forEach((field) => {
      totals[field] = round(totals[field]);
    });
    return totals;
  }

  function readEnvironmentObject(source) {
    if (!isObject(source)) return null;
    const direct = firstDefined(
      source.environmentFlow,
      source.environmentalFlow,
      source.ecoFlow,
      source.ecologicalFlow,
      source.eco,
      source.aggregate && source.aggregate.environmentFlow,
      source.aggregate && source.aggregate.environmentalFlow,
      source.aggregate && source.aggregate.ecoFlow,
      source.totals && source.totals.environmentFlow,
      source.totals && source.totals.environmentalFlow,
      source.totals && source.totals.ecoFlow
    );
    if (isObject(direct)) return direct;
    if (direct !== undefined && direct !== null && direct !== '') {
      return { inStreamFlow: direct };
    }
    return source;
  }

  function addEnvironmentSignals(totals, source) {
    if (!isObject(source)) return totals;
    const allocation = firstDefined(source.allocation, source.allocated, source.waterAllocation, source.alloc);
    totals.ecoBaseFlow += finiteNumber(firstDefined(
      source.ecoBaseFlow,
      source.eco_base_flow,
      source.environmentBaseFlow,
      source.environmentalBaseFlow,
      source.baseFlow
    ), 0);
    totals.inStreamFlow += finiteNumber(firstDefined(
      source.inStreamFlow,
      source.in_stream_flow,
      source.environmentFlow,
      source.environmentalFlow,
      source.riverFlow,
      source.qOutflow,
      source.q_outflow,
      source.outflow
    ), 0);
    totals.ecoSurplus += finiteNumber(firstDefined(
      source.ecoSurplus,
      source.eco_surplus,
      source.environmentSurplus,
      source.environmentalSurplus,
      source.riverSurplus
    ), 0);
    totals.legacyEcoAllocation += finiteNumber(firstDefined(
      allocation && allocation.eco,
      allocation && allocation.ecology,
      allocation && allocation.ecological,
      allocation && allocation.environment,
      source.legacyEcoAllocation,
      source.ecoAllocation
    ), 0);
    return totals;
  }

  function environmentMap(value) {
    return {
      ecoBaseFlow: value,
      inStreamFlow: value,
      ecoSurplus: value,
      legacyEcoAllocation: value,
      total: value,
    };
  }

  function hasEnvironmentSignal(map) {
    return ENVIRONMENT_FIELDS.some((field) => Math.abs(finiteNumber(map && map[field], 0)) > EPS);
  }

  function summarizeNodes(perNodeNet, nodeInfo, predicate) {
    return Object.keys(perNodeNet)
      .filter((id) => predicate(perNodeNet[id]))
      .map((id) => ({
        id,
        name: (nodeInfo[id] && nodeInfo[id].name) || id,
        code: (nodeInfo[id] && nodeInfo[id].code) || id,
        net: round(perNodeNet[id]),
        volume: round(Math.abs(perNodeNet[id])),
      }))
      .sort(compareByVolumeThenName);
  }

  function compareByVolumeThenName(a, b) {
    const volumeDiff = Math.abs(b.volume || b.net || 0) - Math.abs(a.volume || a.net || 0);
    if (Math.abs(volumeDiff) > EPS) return volumeDiff;
    return String(a.name || a.id).localeCompare(String(b.name || b.id));
  }

  function mergeNodeInfo(base, extra) {
    const merged = { ...(base || {}) };
    if (extra && extra.id !== undefined && extra.id !== null) merged.id = String(extra.id);
    if (extra && extra.name !== undefined && extra.name !== null && extra.name !== '') merged.name = String(extra.name);
    if (extra && extra.code !== undefined && extra.code !== null && extra.code !== '') merged.code = String(extra.code);
    if (merged.id && !merged.name) merged.name = merged.id;
    if (merged.id && !merged.code) merged.code = merged.id;
    return merged;
  }

  function ensureNode(map, id) {
    if (!Object.prototype.hasOwnProperty.call(map, id)) {
      map[id] = 0;
    }
  }

  function ensurePartnersNode(map, id) {
    if (!map[id]) {
      map[id] = { buyers: [], sellers: [] };
    }
  }

  function roundMap(map) {
    return Object.keys(map).reduce((acc, key) => {
      acc[key] = round(map[key]);
      return acc;
    }, {});
  }

  function sectorMap(value) {
    return SECTORS.reduce((acc, sector) => {
      acc[sector] = value;
      return acc;
    }, {});
  }

  function firstDefined() {
    for (let index = 0; index < arguments.length; index += 1) {
      if (arguments[index] !== undefined && arguments[index] !== null) return arguments[index];
    }
    return undefined;
  }

  function cleanId(value) {
    if (value === undefined || value === null || value === '') return '';
    return String(value);
  }

  function nonNegative(value, fallback) {
    return Math.max(0, finiteNumber(value, fallback));
  }

  function finiteNumber(value, fallback) {
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function round(value) {
    return Math.round((finiteNumber(value, 0) + Number.EPSILON) * 1e6) / 1e6;
  }

  function isObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  return {
    aggregateTradeFlows,
  };
});
