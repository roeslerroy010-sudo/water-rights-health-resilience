(function () {
  'use strict';

  const DATA_URLS = {
    subbasins: 'data/wuhan-subbasins.geojson',
    rivers: 'data/wuhan-rivers.geojson',
    attrs: 'data/wuhan-attrs.json',
  };

  const CLIMATE = {
    historical: { label: '历史校准', waterFactor: 1.00, dalyFactor: 0.92 },
    ssp245: { label: 'SSP2-4.5', waterFactor: 0.90, dalyFactor: 1.08 },
    ssp585: { label: 'SSP5-8.5', waterFactor: 0.76, dalyFactor: 1.26 },
    dry: { label: '连续干旱', waterFactor: 0.64, dalyFactor: 1.42 },
  };

  const TRADE_SCOPE_LABELS = {
    external: '外部调水',
    internal: '内部解决',
  };

  const LAYER_LABELS = {
    healthGain: '健康收益',
    stressIndex: '水压力',
    taxIntensity: '税强度',
    inequity: '不公平',
    netTrade: '交易净额',
  };

  const VALUE_PER_DALY = 125000;
  const DISEASE_CASE_DALY = 0.18;
  const SAMPLE_NOTE = '研究级·真实数据；部门用水为遥感+统计反演估算；生态底线按本地产流/支流口径；长江过境水不作为保留比例基数';
  const TRADE_BASIS_NOTE = "基于'有交易 − 自给自足'的市场再配估算，模型推导，非真实成交记录";
  const WATER_USE_SECTORS = ['urban', 'agri', 'industry'];

  const state = {
    network: null,
    result: null,
    params: null,
    activeLayer: 'healthGain',
    selectedId: null,
    region: null,
    regionSelectedIds: null,
    scope: null,
    fullNetworkResult: null,
    currentModelInput: null,
    noMarketEnabled: true,
    noMarketResult: null,
    noMarketComparison: null,
    autarkyResult: null,
    autarkyCache: null,
    noTaxResult: null,
    noTaxComparison: null,
    noTaxCache: null,
    tauResponse: null,
    tauResponseCache: null,
    tradeAggregate: null,
    changedFlowKeys: [],
    previousTradeFlowVolumes: null,
    solveRunId: 0,
    timer: null,
  };

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    bindControls();
    setText('data-status', '加载中');
    setText('model-status', '等待模型');
    setText('solver-status', '--');
    setText('region-status', '全域');

    if (window.ResearchMap && typeof window.ResearchMap.init === 'function') {
      window.ResearchMap.init(handleBasinSelect);
    }

    state.network = await loadNetworkData();
    state.params = readParams();
    setText('basin-count', String(state.network.basins.length));
    setText('source-label', state.network.source === 'baked' ? 'research/data' : '内置示例');
    setText('data-status', state.network.source === 'baked' ? '已加载' : '示例网络');

    await waitForGlpkReady();
    await runAndRender();
  }

  function bindControls() {
    const controls = document.getElementById('controls');
    if (controls) {
      controls.addEventListener('input', handleParamChange);
      controls.addEventListener('change', handleParamChange);
    }

    document.querySelectorAll('.layer-tab').forEach((button) => {
      button.addEventListener('click', () => {
        state.activeLayer = button.dataset.layer || 'healthGain';
        document.querySelectorAll('.layer-tab').forEach((item) => {
          item.classList.toggle('active', item === button);
        });
        setText('active-layer-label', LAYER_LABELS[state.activeLayer] || state.activeLayer);
        renderAll();
      });
    });

    bindRegionEvents();
    bindRichEvents();
    updateControlReadouts();
  }

  function bindRichEvents() {
    if (!window.__researchBasinSelectBound) {
      window.__researchBasinSelectBound = true;
      window.addEventListener('research:basin-select', (event) => {
        const detail = event && event.detail ? event.detail : {};
        const id = detail.id || detail.basinId || detail.subbasinId;
        if (id) handleBasinSelect(String(id), { force: detail.force !== false });
      });
    }

    const noMarketToggle = document.getElementById('no-market-toggle');
    if (noMarketToggle && !noMarketToggle.dataset.richBound) {
      noMarketToggle.dataset.richBound = 'true';
      noMarketToggle.addEventListener('click', () => {
        state.noMarketEnabled = !state.noMarketEnabled;
        updateNoMarketToggle();
        scheduleRunAndRender(0);
      });
      updateNoMarketToggle();
    }
  }

  function updateNoMarketToggle() {
    const noMarketToggle = document.getElementById('no-market-toggle');
    if (!noMarketToggle) return;
    noMarketToggle.setAttribute('aria-pressed', state.noMarketEnabled ? 'true' : 'false');
    noMarketToggle.textContent = state.noMarketEnabled ? '隐藏交易效率对照' : '生成交易效率对照';
  }

  function bindRegionEvents() {
    [
      'research:region-change',
      'research:region:selected',
      'research-region-change',
      'region:change',
      'regionchange',
    ].forEach((eventName) => {
      window.addEventListener(eventName, handleRegionEvent);
    });

    [
      'research:region-clear',
      'research-region-clear',
      'region:clear',
    ].forEach((eventName) => {
      window.addEventListener(eventName, clearRegionSelection);
    });
  }

  function handleRegionEvent(event) {
    const detail = event && event.detail !== undefined ? event.detail : event;
    setRegionSelection(detail);
  }

  function setRegionSelection(payload) {
    const normalized = normalizeRegionPayload(payload);
    if (normalized.clear) {
      clearRegionSelection();
      return;
    }
    state.region = normalized.region !== undefined ? normalized.region : null;
    state.regionSelectedIds = Array.isArray(normalized.selectedIds) ? normalized.selectedIds.map(String) : null;
    state.selectedId = null;
    scheduleRunAndRender(0);
  }

  function clearRegionSelection() {
    state.region = null;
    state.regionSelectedIds = null;
    state.selectedId = null;
    scheduleRunAndRender(0);
  }

  function normalizeRegionPayload(payload) {
    if (!payload) return { clear: true };
    if (payload.clear === true) return { clear: true };
    if (Array.isArray(payload)) return { selectedIds: payload };
    if (payload.detail !== undefined) return normalizeRegionPayload(payload.detail);
    if (Array.isArray(payload.selectedIds)) {
      return {
        region: payload.region,
        selectedIds: payload.selectedIds,
      };
    }
    if (payload.region !== undefined) {
      return {
        region: payload.region,
        selectedIds: Array.isArray(payload.ids) ? payload.ids : null,
      };
    }
    if (Array.isArray(payload.ids)) return { selectedIds: payload.ids };
    if (looksLikeRegion(payload)) return { region: payload };
    return { clear: true };
  }

  function looksLikeRegion(value) {
    return Boolean(
      value && typeof value === 'object'
      && (
        (value.sw && value.ne)
        || (value.southWest && value.northEast)
        || (value.bounds && (value.bounds.sw || value.bounds.southWest))
        || value.type === 'Feature'
        || value.type === 'Polygon'
        || value.type === 'MultiPolygon'
        || (value.type === 'polygon' && Array.isArray(value.coordinates))
        || (value.type === 'ids' && Array.isArray(value.ids))
        || value.geometry
      )
    );
  }

  function handleParamChange() {
    updateControlReadouts();
    state.params = readParams();
    scheduleRunAndRender(90);
  }

  function scheduleRunAndRender(delay) {
    window.clearTimeout(state.timer);
    state.timer = window.setTimeout(runAndRender, delay || 0);
  }

  function updateControlReadouts() {
    const tau = document.getElementById('tau');
    const demandElasticity = document.getElementById('demand-elasticity');
    const floor = document.getElementById('health-floor');
    const ecoFloor = document.getElementById('eco-floor');
    const cost = document.getElementById('trading-cost');
    if (tau) setText('tau-value', `${tau.value}%`);
    if (demandElasticity) setText('elasticity-value', Number(demandElasticity.value).toFixed(2));
    if (floor) setText('floor-value', `${floor.value}%`);
    if (ecoFloor) setText('eco-floor-value', `${ecoFloor.value}%`);
    if (cost) setText('cost-value', `${cost.value}%`);
  }

  function readParams() {
    const tradeScope = normalizeTradeScope(getSelectValue('trade-scope', 'external'));
    return {
      tau: getNumericInput('tau', 24) / 100,
      demandElasticity: clampValue(getNumericInput('demand-elasticity', 0.9), 0.3, 1.2),
      climate: getSelectValue('climate', 'ssp245'),
      tradeScope,
      healthFloor: getNumericInput('health-floor', 26) / 100,
      ecoFloor: getNumericInput('eco-floor', 15) / 100,
      tradingCost: getNumericInput('trading-cost', 10) / 100,
    };
  }

  function normalizeTradeScope(value) {
    return value === 'internal' ? 'internal' : 'external';
  }

  function getTradeScopeLabel(tradeScope) {
    return TRADE_SCOPE_LABELS[normalizeTradeScope(tradeScope)] || TRADE_SCOPE_LABELS.external;
  }

  function getInputTradeScope(input, scope) {
    return normalizeTradeScope(
      (scope && scope.tradeScope)
      || (input && input.params && input.params.tradeScope)
      || (input && input.meta && input.meta.tradeScope)
      || 'external'
    );
  }

  async function runAndRender() {
    if (!state.network) return;
    const runId = ++state.solveRunId;
    setText('model-status', '求解中');
    setText('solver-status', '求解中');

    const startedAt = performance.now();
    state.params = state.params || readParams();
    const baseInput = buildBaseModelInput(state.params);
    let modelInput = baseInput;
    let scope = null;

    try {
      let preSolvedBaseResult = null;
      if (hasActiveRegionSelection()) {
        preSolvedBaseResult = await solveModelInput(baseInput);
        if (runId !== state.solveRunId) return;
        state.fullNetworkResult = preSolvedBaseResult;
      } else {
        state.fullNetworkResult = null;
      }

      const scoped = buildScopedModelInput(modelInput);
      modelInput = scoped.modelInput;
      scope = scoped.scope;
      state.scope = scope;

      if (scoped.skipSolve) {
        state.result = createScopeNoticeResult(modelInput, scope);
        state.currentModelInput = modelInput;
        state.noMarketResult = null;
        state.noMarketComparison = null;
        state.autarkyResult = null;
        state.noTaxResult = null;
        state.noTaxComparison = null;
        state.tauResponse = null;
        finalizeResult(startedAt);
        return;
      }

      if (preSolvedBaseResult && modelInput === baseInput) {
        state.result = preSolvedBaseResult;
      } else {
        state.result = await solveModelInput(modelInput);
        if (runId !== state.solveRunId) return;
      }
    } catch (error) {
      console.warn('ResearchNetworkModel.solveNetwork failed; fallback solver used.', error);
      state.result = solveFallbackNetwork(modelInput, error);
    }

    annotateResultScope(state.result, modelInput, scope || makeGlobalScope(modelInput));
    state.currentModelInput = modelInput;
    await updateAutarkyBaseline(modelInput, state.result.meta.scope, runId);
    if (runId !== state.solveRunId) return;
    await updateNoTaxBaseline(modelInput, state.result.meta.scope, runId);
    if (runId !== state.solveRunId) return;
    await updateNoMarketComparison(modelInput, state.result.meta.scope, runId);
    if (runId !== state.solveRunId) return;
    await updateTauResponse(modelInput, state.result.meta.scope, runId);
    finalizeResult(startedAt);
  }

  async function updateAutarkyBaseline(modelInput, scope, runId) {
    state.autarkyResult = null;
    if (!modelInput || !state.result || (state.result.meta && state.result.meta.skipSolve)) return;

    const cacheKey = getAutarkyCacheKey(modelInput, scope);
    if (state.autarkyCache && state.autarkyCache.key === cacheKey) {
      state.autarkyResult = state.autarkyCache.result;
      return;
    }

    const autarkyInput = buildAutarkyModelInput(modelInput);
    try {
      const autarkyResult = await solveModelInput(autarkyInput);
      if (runId !== state.solveRunId) return;
      annotateResultScope(autarkyResult, autarkyInput, {
        ...(scope || makeGlobalScope(modelInput)),
        comparison: 'autarky',
      });
      autarkyResult.meta = {
        ...(autarkyResult.meta || {}),
        comparison: 'autarky',
        trade: 'autarky',
        tradeBaseline: 'autarky',
        tradeBasisNote: TRADE_BASIS_NOTE,
      };
      state.autarkyResult = autarkyResult;
      state.autarkyCache = {
        key: cacheKey,
        result: autarkyResult,
      };
    } catch (error) {
      console.warn('Autarky baseline failed; trade aggregate will wait for a valid baseline.', error);
      state.autarkyCache = null;
      state.autarkyResult = null;
    }
  }

  function buildAutarkyModelInput(modelInput) {
    return {
      ...modelInput,
      trade: 'autarky',
      marketMode: 'autarky',
      params: {
        ...(modelInput.params || {}),
      },
      meta: {
        ...(modelInput.meta || {}),
        comparisonScenario: 'autarky',
        trade: 'autarky',
        tradeBaseline: 'autarky',
      },
    };
  }

  function getAutarkyCacheKey(modelInput, scope) {
    return JSON.stringify({
      ids: (modelInput.basins || []).map((basin) => basin.id),
      params: modelInput.params || {},
      tradeScope: getInputTradeScope(modelInput, scope),
      scopeMode: scope && scope.mode,
      selectedIds: scope && scope.selectedIds,
    });
  }

  async function updateNoTaxBaseline(modelInput, scope, runId) {
    state.noTaxResult = null;
    state.noTaxComparison = null;
    if (!modelInput || !state.result || (state.result.meta && state.result.meta.skipSolve)) return;

    const cacheKey = getNoTaxCacheKey(modelInput, scope);
    if (state.noTaxCache && state.noTaxCache.key === cacheKey) {
      state.noTaxResult = state.noTaxCache.result;
      state.noTaxComparison = buildNoTaxComparison(state.result, state.noTaxResult);
      attachNoTaxComparison(state.result, state.noTaxResult, state.noTaxComparison);
      return;
    }

    const noTaxInput = buildNoTaxModelInput(modelInput);
    try {
      const noTaxResult = await solveModelInput(noTaxInput);
      if (runId !== state.solveRunId) return;
      annotateResultScope(noTaxResult, noTaxInput, {
        ...(scope || makeGlobalScope(modelInput)),
        comparison: 'no-health-tax',
      });
      noTaxResult.meta = {
        ...(noTaxResult.meta || {}),
        comparison: 'no-health-tax',
        healthTaxRate: 0,
        taxBaseline: 'tau-0-with-market',
        taxBasisNote: '隔离健康税效应：交易、生态底线、气候、健康底线、交易成本和选区保持一致，仅将 tau 设为 0。',
      };
      state.noTaxResult = noTaxResult;
      state.noTaxComparison = buildNoTaxComparison(state.result, noTaxResult);
      state.noTaxCache = {
        key: cacheKey,
        result: noTaxResult,
      };
      attachNoTaxComparison(state.result, noTaxResult, state.noTaxComparison);
    } catch (error) {
      console.warn('No-tax baseline failed; health-tax comparison will wait for a valid baseline.', error);
      state.noTaxCache = null;
      state.noTaxResult = null;
      state.noTaxComparison = null;
    }
  }

  function buildNoTaxModelInput(modelInput) {
    return {
      ...modelInput,
      params: {
        ...(modelInput.params || {}),
        tau: 0,
      },
      meta: {
        ...(modelInput.meta || {}),
        comparisonScenario: 'no-health-tax',
        taxBaseline: 'tau-0-with-market',
      },
    };
  }

  function getNoTaxCacheKey(modelInput, scope) {
    const params = {
      ...(modelInput.params || {}),
      tau: 0,
    };
    return JSON.stringify({
      ids: (modelInput.basins || []).map((basin) => basin.id),
      params,
      tradeScope: getInputTradeScope(modelInput, scope),
      trade: modelInput.trade || (modelInput.meta && modelInput.meta.trade) || 'market',
      marketMode: modelInput.marketMode || (modelInput.meta && modelInput.meta.tradeBaseline) || 'market',
      scopeMode: scope && scope.mode,
      selectedIds: scope && scope.selectedIds,
    });
  }

  function buildNoTaxComparison(current, noTax) {
    const currentSummary = summarizeTaxComparisonResult(current);
    const baselineSummary = summarizeTaxComparisonResult(noTax);
    return {
      enabled: true,
      label: '有/无健康税对比',
      note: '隔离健康税效应：交易保持开启，仅比较当前 tau 与 tau=0；模型推导，非真实政策实验。',
      current: currentSummary,
      baseline: baselineSummary,
      noTax,
      delta: {
        industryWithdrawal: currentSummary.industryWithdrawal - baselineSummary.industryWithdrawal,
        environmentalFlow: currentSummary.environmentalFlow - baselineSummary.environmentalFlow,
        dalyAvoided: currentSummary.dalyAvoided - baselineSummary.dalyAvoided,
      },
    };
  }

  function summarizeTaxComparisonResult(result) {
    const aggregate = result && result.aggregate ? result.aggregate : {};
    return {
      industryWithdrawal: numberOr(aggregate.industryWithdrawal, industryWithdrawalTotal(result)),
      environmentalFlow: numberOr(aggregate.environmentalFlow, environmentalFlowTotal(result)),
      dalyAvoided: numberOr(aggregate.dalyAvoided, 0),
    };
  }

  function attachNoTaxComparison(current, noTaxResult, comparison) {
    if (!current) return;
    current.noTaxResult = noTaxResult;
    current.noTaxComparison = comparison;
    current.aggregate = {
      ...(current.aggregate || {}),
      noTaxDelta: comparison ? comparison.delta : null,
    };
  }

  async function updateTauResponse(modelInput, scope, runId) {
    state.tauResponse = null;
    if (!modelInput || !state.result || (state.result.meta && state.result.meta.skipSolve)) return;
    if (!window.TauResponseChart || typeof window.TauResponseChart.scanTau !== 'function') return;

    const cacheKey = getTauResponseCacheKey(modelInput, scope);
    if (state.tauResponseCache && state.tauResponseCache.key === cacheKey) {
      state.tauResponse = state.tauResponseCache.result;
      attachTauResponse(state.result, state.tauResponse);
      return;
    }

    try {
      const tauResponse = await window.TauResponseChart.scanTau({
        modelInput,
        params: modelInput.params,
        scope,
        selectedIds: scope && scope.selectedIds,
        solveModelInput,
      });
      if (runId !== state.solveRunId) return;
      state.tauResponse = tauResponse;
      state.tauResponseCache = {
        key: cacheKey,
        result: tauResponse,
      };
      attachTauResponse(state.result, tauResponse);
    } catch (error) {
      console.warn('Tau response scan failed; RICH panel will show the integration hint.', error);
      state.tauResponseCache = null;
      state.tauResponse = null;
    }
  }

  function getTauResponseCacheKey(modelInput, scope) {
    const params = { ...(modelInput.params || {}) };
    delete params.tau;
    return JSON.stringify({
      ids: (modelInput.basins || []).map((basin) => basin.id),
      params,
      tradeScope: getInputTradeScope(modelInput, scope),
      trade: modelInput.trade || (modelInput.meta && modelInput.meta.trade) || 'market',
      marketMode: modelInput.marketMode || (modelInput.meta && modelInput.meta.tradeBaseline) || 'market',
      scopeMode: scope && scope.mode,
      selectedIds: scope && scope.selectedIds,
    });
  }

  function attachTauResponse(current, tauResponse) {
    if (!current) return;
    current.tauResponse = tauResponse;
  }

  async function updateNoMarketComparison(modelInput, scope, runId) {
    state.noMarketResult = null;
    state.noMarketComparison = null;
    if (!state.noMarketEnabled || !modelInput || !state.result || (state.result.meta && state.result.meta.skipSolve)) return;
    if (runId !== state.solveRunId) return;

    const autarkyBaseline = state.autarkyResult;
    if (!autarkyBaseline) return;

    state.noMarketResult = autarkyBaseline;
    state.noMarketComparison = buildNoMarketComparison(state.result, autarkyBaseline, {
      baselineKind: 'autarky',
    });
  }

  function buildNoMarketComparison(current, baseline, options = {}) {
    const currentAggregate = current && current.aggregate ? current.aggregate : {};
    const baselineAggregate = baseline && baseline.aggregate ? baseline.aggregate : {};
    const baselineKind = options.baselineKind || 'autarky';
    return {
      enabled: true,
      baselineKind,
      autarky: baselineKind === 'autarky' ? baseline : null,
      label: baselineKind === 'autarky' ? '自给自足/无交易对照' : '无市场对照',
      note: '模型情景对照：同一选区在自给自足/无交易状态下的基线；非真实政策实验或真实成交记录。',
      current: summarizeComparisonResult(current),
      baseline: summarizeComparisonResult(baseline),
      delta: {
        dalyAvoided: numberOr(currentAggregate.dalyAvoided, 0) - numberOr(baselineAggregate.dalyAvoided, 0),
        marketPrice: numberOr(currentAggregate.marketPrice, 0) - numberOr(baselineAggregate.marketPrice, 0),
        healthAllocation: healthAllocationTotal(current) - healthAllocationTotal(baseline),
        unmet: unmetTotal(current) - unmetTotal(baseline),
      },
    };
  }

  function summarizeComparisonResult(result) {
    const aggregate = result && result.aggregate ? result.aggregate : {};
    return {
      dalyAvoided: numberOr(aggregate.dalyAvoided, 0),
      marketPrice: numberOr(aggregate.marketPrice, 0),
      healthAllocation: healthAllocationTotal(result),
      unmet: unmetTotal(result),
    };
  }

  function healthAllocationTotal(result) {
    return (result && result.basinResults ? result.basinResults : []).reduce((sum, item) => {
      const allocation = item.allocation || {};
      return sum + numberOr(allocation.urban, 0);
    }, 0);
  }

  function industryWithdrawalTotal(result) {
    return (result && result.basinResults ? result.basinResults : []).reduce((sum, item) => {
      const allocation = item.allocation || {};
      return sum + numberOr(item.industryWithdrawal, numberOr(allocation.industry, 0));
    }, 0);
  }

  function environmentalFlowTotal(result) {
    return (result && result.basinResults ? result.basinResults : []).reduce((sum, item) => {
      return sum + numberOr(item.environmentalFlow, numberOr(item.environmentFlow, 0));
    }, 0);
  }

  function unmetTotal(result) {
    return (result && result.basinResults ? result.basinResults : []).reduce((sum, item) => {
      const unmet = item.unmet || (item.modelNode && item.modelNode.unmet) || {};
      return sum + sumSectorMap(unmet);
    }, 0);
  }

  async function solveModelInput(modelInput) {
    if (window.ResearchNetworkModel && typeof window.ResearchNetworkModel.solveNetwork === 'function') {
      const modelParams = toResearchModelParams(modelInput);
      if (
        modelParams.trade !== 'autarky'
        &&
        window.glpk
        && typeof window.glpk.solve === 'function'
        && typeof window.ResearchNetworkModel.solveNetworkLpAsync === 'function'
      ) {
        try {
          const lpResult = await window.ResearchNetworkModel.solveNetworkLpAsync({
            ...modelParams,
            glpk: window.glpk,
          });
          return normalizeModelResult(lpResult, modelInput, 'ResearchNetworkModel');
        } catch (error) {
          console.warn('Async GLPK solve failed; fallback solver used.', error);
          return solveFallbackNetwork(modelInput, error);
        }
      }

      const externalResult = await window.ResearchNetworkModel.solveNetwork(modelParams);
      return normalizeModelResult(externalResult, modelInput, 'ResearchNetworkModel');
    }
    return solveFallbackNetwork(modelInput);
  }

  async function waitForGlpkReady() {
    if (window.glpk && typeof window.glpk.solve === 'function') return;
    if (!window.glpkReady || typeof window.glpkReady.then !== 'function') return;
    setText('model-status', '加载 LP');
    try {
      await Promise.race([
        window.glpkReady,
        new Promise((resolve) => window.setTimeout(resolve, 1800)),
      ]);
    } catch (error) {
      console.warn('GLPK readiness check failed; heuristic fallback remains available.', error);
    }
  }

  function hasActiveRegionSelection() {
    return Boolean(state.region || Array.isArray(state.regionSelectedIds));
  }

  function finalizeResult(startedAt) {
    state.result.meta.elapsedMs = Math.round(performance.now() - startedAt);
    state.result.meta.modelLabel = getModelLabel(state.result);
    state.result.meta.solverEngine = getSolverEngine(state.result);
    state.result.meta.lpSpikePending = hasLpSpikePending(state.result);
    state.tradeAggregate = buildTradeAggregateContext();
    state.result.tradeAggregate = state.tradeAggregate;
    reconcileTradingCost(state.result);
    setText('model-status', state.result.meta.modelLabel);
    updateSolverStatus(state.result);
    updateScopeStatus(state.result.meta.scope);
    renderAll();
  }

  // 交易摩擦只应对「真正换手的水」计费。此前 tradingCostCny 回退到
  // tradableWater（= 全域取水量 ~186 亿 m³）× 单位成本，等于给每一方
  // 未参与交易的水都收一遍过路费，使 NPV 在整个 τ 区间恒为负。
  // 成交量口径与 methodology 的「口径 R」一致：withTrade − autarky
  // 的净买方增量，即 tradeFlows 的成交总量。
  function computeTradedVolume(result) {
    const flows = (result && result.tradeAggregate && result.tradeAggregate.tradeFlows) || [];
    return flows.reduce((sum, flow) => sum + Math.max(0, numberOr(flow.volume, 0)), 0);
  }

  function reconcileTradingCost(result) {
    const aggregate = result && result.aggregate;
    if (!aggregate) return;
    const unitCost = Math.max(0, numberOr(state.params && state.params.tradingCost, 0));
    const tradedVolume = computeTradedVolume(result);
    const tradingCostCny = tradedVolume * unitCost;
    aggregate.tradedVolume = tradedVolume;
    aggregate.tradingCostCny = tradingCostCny;
    aggregate.economicNpvCny = numberOr(aggregate.healthBenefitCny, 0) - tradingCostCny;
  }

  function buildBaseModelInput(params) {
    return {
      params,
      subbasinsGeojson: state.network.subbasinsGeojson,
      riversGeojson: state.network.riversGeojson,
      attrs: state.network.attrs,
      basins: state.network.basins,
      topology: state.network.topology,
      meta: state.network.meta,
    };
  }

  function buildScopedModelInput(baseInput) {
    const tradeScope = getInputTradeScope(baseInput);
    const tradeScopeLabel = getTradeScopeLabel(tradeScope);
    if (!state.region && !Array.isArray(state.regionSelectedIds)) {
      return {
        modelInput: baseInput,
        scope: makeGlobalScope(baseInput),
      };
    }

    const selectedIds = resolveRegionSelectedIds(baseInput);
    const totalCount = baseInput.basins.length;
    const regionSourceLabel = state.region && typeof state.region.label === 'string' && state.region.label
      ? ` · ${state.region.label}`
      : '';
    const selectionLabel = selectedIds.length
      ? `选区 ${selectedIds.length} 个子流域${regionSourceLabel}`
      : '选区为空';
    const scopeBase = {
      mode: 'region',
      selectedIds,
      totalCount,
      label: selectedIds.length ? `${selectionLabel} · ${tradeScopeLabel}` : selectionLabel,
      message: selectedIds.length ? `${selectionLabel} · ${tradeScopeLabel}` : '请圈选更大区域',
      warning: selectedIds.length ? null : '请圈选更大区域',
      region: state.region || null,
      tradeScope,
      tradeScopeLabel,
    };

    if (!selectedIds.length) {
      return {
        modelInput: baseInput,
        scope: scopeBase,
        skipSolve: true,
      };
    }

    if (selectedIds.length === 1) {
      scopeBase.warning = `区域过小，无内部交易 · ${tradeScopeLabel}`;
      scopeBase.message = scopeBase.warning;
    }

    if (coversFullNetwork(selectedIds, baseInput.basins)) {
      const globalScope = makeGlobalScope(baseInput);
      return {
        modelInput: baseInput,
        scope: {
          ...scopeBase,
          ...globalScope,
          mode: 'global',
          label: globalScope.label,
          message: `全域（选区覆盖全部子流域） · ${tradeScopeLabel}`,
          warning: null,
          region: state.region || null,
        },
      };
    }

    const boundarySourceInput = buildBoundarySourceInput(baseInput, state.fullNetworkResult, { tradeScope });
    const subnet = normalizeSubNetwork(
      extractSubNetwork(selectedIds, boundarySourceInput, { tradeScope }),
      selectedIds,
      baseInput,
      { tradeScope }
    );

    return {
      modelInput: {
        ...baseInput,
        basins: subnet.subbasins,
        topology: subnet.topology,
        meta: {
          ...(baseInput.meta || {}),
          scope: scopeBase,
          boundaryInflowByNode: subnet.boundaryInflowByNode || {},
          tradeScope,
          tradeScopeLabel,
        },
      },
      scope: scopeBase,
    };
  }

  function makeGlobalScope(input) {
    const tradeScope = getInputTradeScope(input);
    const tradeScopeLabel = getTradeScopeLabel(tradeScope);
    return {
      mode: 'global',
      selectedIds: input.basins.map((basin) => basin.id),
      totalCount: input.basins.length,
      label: `全域 · ${tradeScopeLabel}`,
      message: `全域 · ${tradeScopeLabel}`,
      warning: null,
      region: null,
      tradeScope,
      tradeScopeLabel,
    };
  }

  function resolveRegionSelectedIds(baseInput) {
    if (Array.isArray(state.regionSelectedIds)) {
      return sanitizeSelectedIds(state.regionSelectedIds, baseInput.basins);
    }

    if (!state.region) return [];

    if (state.region.type === 'ids' && Array.isArray(state.region.ids)) {
      return sanitizeSelectedIds(state.region.ids, baseInput.basins);
    }

    const api = getRegionSelectApi();
    const selector = api && typeof api.selectSubbasins === 'function'
      ? api.selectSubbasins
      : fallbackSelectSubbasins;
    let selectedIds = selector(toSelectorRegion(state.region), baseInput.basins, baseInput.attrs);
    if ((!Array.isArray(selectedIds) || !selectedIds.length) && selector !== fallbackSelectSubbasins) {
      selectedIds = fallbackSelectSubbasins(state.region, baseInput.basins);
    }
    return sanitizeSelectedIds(selectedIds, baseInput.basins);
  }

  function sanitizeSelectedIds(ids, basins) {
    const selected = new Set((Array.isArray(ids) ? ids : [])
      .map((item) => typeof item === 'object' && item ? item.id : item)
      .filter((id) => id !== undefined && id !== null && id !== '')
      .map(String));
    return basins.filter((basin) => selected.has(basin.id)).map((basin) => basin.id);
  }

  function coversFullNetwork(selectedIds, basins) {
    if (selectedIds.length !== basins.length) return false;
    const selected = new Set(selectedIds);
    return basins.every((basin) => selected.has(basin.id));
  }

  function buildBoundarySourceInput(baseInput, fullResult, options = {}) {
    const tradeScope = getInputTradeScope(baseInput, options);
    const tradeScopeLabel = getTradeScopeLabel(tradeScope);
    const solvedById = new Map();
    if (fullResult && fullResult.raw && Array.isArray(fullResult.raw.nodes)) {
      fullResult.raw.nodes.forEach((node) => solvedById.set(String(node.id), node));
    }
    if (fullResult && Array.isArray(fullResult.basinResults)) {
      fullResult.basinResults.forEach((item) => {
        if (item && item.modelNode) solvedById.set(String(item.id), item.modelNode);
      });
    }

    return {
      ...baseInput,
      params: {
        ...(baseInput.params || {}),
        tradeScope,
      },
      meta: {
        ...(baseInput.meta || {}),
        tradeScope,
        tradeScopeLabel,
      },
      basins: baseInput.basins.map((basin) => {
        const solved = solvedById.get(String(basin.id));
        if (!solved) return basin;
        const supply = {
          ...(basin.supply || {}),
          qAvail: numberOr(solved.qAvail, basin.supply && basin.supply.qAvail),
          qOutflow: numberOr(solved.qOutflow, 0),
          qWithdrawn: numberOr(solved.qWithdrawn, 0),
        };
        return {
          ...basin,
          qOutflow: supply.qOutflow,
          qWithdrawn: supply.qWithdrawn,
          modelNode: solved,
          supply,
        };
      }),
    };
  }

  function extractSubNetwork(selectedIds, baseInput, options = {}) {
    const tradeScope = getInputTradeScope(baseInput, options);
    const api = getRegionSelectApi();
    if (api && typeof api.extractSubNetwork === 'function') {
      const extracted = api.extractSubNetwork(selectedIds, baseInput, {
        ...options,
        tradeScope,
      });
      return extracted && extracted.network ? extracted.network : extracted;
    }
    return fallbackExtractSubNetwork(selectedIds, baseInput, { ...options, tradeScope });
  }

  function normalizeSubNetwork(rawSubnet, selectedIds, baseInput, options = {}) {
    const tradeScope = getInputTradeScope(baseInput, options);
    const allowBoundaryInflow = tradeScope !== 'internal';
    const subnet = rawSubnet || {};
    const selected = new Set(selectedIds);
    const baseById = new Map(baseInput.basins.map((basin) => [basin.id, basin]));
    const rawItems = Array.isArray(subnet.subbasins)
      ? subnet.subbasins
      : Array.isArray(subnet.basins)
        ? subnet.basins
        : [];
    const rawById = new Map(rawItems
      .map((item) => [String(item.id || item.subbasinId || ''), item])
      .filter(([id]) => selected.has(id)));
    const rawTopology = subnet.topology && typeof subnet.topology === 'object' ? subnet.topology : {};
    const topology = {};
    const subbasins = selectedIds.map((id) => {
      const base = baseById.get(id) || {};
      const raw = rawById.get(id) || {};
      const downstream = cleanDownstream(rawTopology[id] || raw.downstream || base.downstream || baseInput.topology[id], selected);
      topology[id] = downstream;
      return mergeModelBasin(base, raw, downstream, 0, { tradeScope });
    });

    const rawBoundaryInflowByNode = subnet.boundaryInflowByNode
      || subnet.boundaryInflow
      || (subnet.meta && subnet.meta.boundaryInflowById)
      || {};
    const boundaryInflowByNode = allowBoundaryInflow
      ? rawBoundaryInflowByNode
      : Object.fromEntries(selectedIds.map((id) => [id, 0]));

    return {
      subbasins,
      topology,
      boundaryInflowByNode,
    };
  }

  function fallbackExtractSubNetwork(selectedIds, baseInput, options = {}) {
    const tradeScope = getInputTradeScope(baseInput, options);
    const allowBoundaryInflow = tradeScope !== 'internal';
    const selected = new Set(selectedIds);
    const baseById = new Map(baseInput.basins.map((basin) => [basin.id, basin]));
    const boundaryInflowByNode = {};

    baseInput.basins.forEach((basin) => {
      const downstream = String(basin.downstream || baseInput.topology[basin.id] || '');
      if (!selected.has(basin.id) && selected.has(downstream)) {
        boundaryInflowByNode[downstream] = allowBoundaryInflow
          ? numberOr(boundaryInflowByNode[downstream], 0) + estimateFullOutflow(basin)
          : 0;
      }
    });

    const topology = {};
    const subbasins = selectedIds.map((id) => {
      const base = baseById.get(id) || {};
      const downstream = cleanDownstream(base.downstream || baseInput.topology[id], selected);
      topology[id] = downstream;
      return {
        ...base,
        downstream,
        supply: {
          ...(base.supply || {}),
          boundaryInflow: boundaryInflowByNode[id] || 0,
          boundaryExternalInflow: boundaryInflowByNode[id] || 0,
        },
      };
    });

    return {
      subbasins,
      topology,
      boundaryInflowByNode,
      meta: {
        tradeScope,
        tradeScopeLabel: getTradeScopeLabel(tradeScope),
        boundaryInflowEnabled: allowBoundaryInflow,
      },
    };
  }

  function mergeModelBasin(base, raw, downstream, extraExternalInflow, options = {}) {
    const tradeScope = normalizeTradeScope(options.tradeScope);
    const allowBoundaryInflow = tradeScope !== 'internal';
    const source = { ...base, ...raw };
    const rawSupply = raw.supply || {};
    const baseSupply = base.supply || {};
    const qLocal = numberOr(rawSupply.qLocal ?? raw.qLocal, numberOr(baseSupply.qLocal, numberOr(baseSupply.qAvail, 0)));
    const qLocalRaw = numberOr(
      rawSupply.qLocalRaw ?? rawSupply.localRunoff ?? raw.qLocalRaw ?? raw.localRunoff,
      numberOr(baseSupply.qLocalRaw ?? baseSupply.localRunoff, qLocal)
    );
    const rawBoundaryExternal = numberOr(
      rawSupply.boundaryExternalInflow ?? raw.boundaryExternalInflow,
      numberOr(rawSupply.boundaryInflow ?? raw.boundaryInflow, 0)
    );
    const externalInflowSource = numberOr(rawSupply.externalInflow ?? raw.externalInflow, numberOr(baseSupply.externalInflow, 0));
    const externalInflow = allowBoundaryInflow
      ? externalInflowSource
      : Math.max(0, externalInflowSource - rawBoundaryExternal);
    const mainstemInflow = numberOr(rawSupply.mainstemInflow ?? raw.mainstemInflow, numberOr(baseSupply.mainstemInflow, 0));
    const boundaryInflow = allowBoundaryInflow
      ? numberOr(rawSupply.boundaryInflow ?? raw.boundaryInflow, 0) + numberOr(extraExternalInflow, 0)
      : 0;
    const transitInflow = externalInflow || mainstemInflow;
    const totalExternal = transitInflow + boundaryInflow;
    const rawQAvail = numberOr(rawSupply.qAvail ?? raw.qAvail, NaN);
    const derivedQAvail = Math.max(qLocal + totalExternal, numberOr(baseSupply.qAvail, 0));
    const qAvail = Number.isFinite(rawQAvail)
      ? (allowBoundaryInflow ? Math.max(rawQAvail, derivedQAvail) : Math.max(qLocal + totalExternal, rawQAvail - rawBoundaryExternal))
      : derivedQAvail;
    const runoffCoeff = numberOr(rawSupply.runoffCoeff ?? raw.runoffCoeff, numberOr(baseSupply.runoffCoeff ?? base.runoffCoeff, NaN));

    return {
      id: String(source.id || base.id),
      name: source.name || source.nameZh || base.name || base.id,
      code: source.code || base.code || getSubbasinCode(source, source.id || base.id),
      pfafId: source.pfafId ?? source.pfaf_id ?? base.pfafId ?? null,
      areaKm2: numberOr(source.areaKm2 ?? source.area_km2, numberOr(base.areaKm2, 0)),
      population: numberOr(source.population ?? source.pop, numberOr(base.population, 0)),
      demand: normalizeDemand(source.demand || source.demands || base.demand || source),
      supply: {
        ...baseSupply,
        ...rawSupply,
        qLocal,
        qLocalRaw,
        localRunoff: qLocalRaw,
        qAvail,
        externalInflow: transitInflow + boundaryInflow,
        mainstemInflow,
        boundaryInflow,
        boundaryExternalInflow: boundaryInflow,
        ...(Number.isFinite(runoffCoeff) ? { runoffCoeff } : {}),
      },
      healthWeight: source.healthWeight || source.health_weight || base.healthWeight || {},
      downstream,
      downstreamReach: Array.isArray(source.downstreamReach) ? source.downstreamReach : [],
      centroid: Array.isArray(source.centroid) ? source.centroid : base.centroid,
      feature: base.feature,
    };
  }

  function cleanDownstream(downstream, selected) {
    const id = downstream === undefined || downstream === null || downstream === '' ? 'OUTLET' : String(downstream);
    return selected.has(id) ? id : 'OUTLET';
  }

  function estimateFullOutflow(basin) {
    const supply = basin.supply || {};
    const explicit = numberOr(supply.qOutflow ?? basin.qOutflow, NaN);
    if (Number.isFinite(explicit)) return Math.max(0, explicit);
    const available = numberOr(supply.qAvail, numberOr(supply.qLocal, 0) + numberOr(supply.externalInflow, 0));
    return Math.max(0, available - sumSectorMap(basin.demand));
  }

  function getRegionSelectApi() {
    return window.ResearchRegionSelect && typeof window.ResearchRegionSelect === 'object'
      ? window.ResearchRegionSelect
      : null;
  }

  function fallbackSelectSubbasins(region, basins) {
    if (!region) return [];
    return basins
      .filter((basin) => pointInRegion(basin.centroid, region))
      .map((basin) => basin.id);
  }

  function toSelectorRegion(region) {
    const rectangle = normalizeRectangleRegion(region);
    if (!rectangle) return region;
    return {
      bbox: [rectangle.minLng, rectangle.minLat, rectangle.maxLng, rectangle.maxLat],
    };
  }

  function pointInRegion(point, region) {
    if (!Array.isArray(point) || point.length < 2) return false;
    const rectangle = normalizeRectangleRegion(region);
    if (rectangle) {
      const [lng, lat] = point;
      return lat >= rectangle.minLat && lat <= rectangle.maxLat && lng >= rectangle.minLng && lng <= rectangle.maxLng;
    }

    const polygons = normalizePolygonRegion(region);
    return polygons.some((rings) => pointInPolygon(point, rings[0] || []));
  }

  function normalizeRectangleRegion(region) {
    const sw = region.sw || region.southWest || region._southWest || (region.bounds && (region.bounds.sw || region.bounds.southWest));
    const ne = region.ne || region.northEast || region._northEast || (region.bounds && (region.bounds.ne || region.bounds.northEast));
    if (!sw || !ne) return null;
    const a = normalizeLatLng(sw);
    const b = normalizeLatLng(ne);
    if (!a || !b) return null;
    return {
      minLat: Math.min(a.lat, b.lat),
      maxLat: Math.max(a.lat, b.lat),
      minLng: Math.min(a.lng, b.lng),
      maxLng: Math.max(a.lng, b.lng),
    };
  }

  function normalizeLatLng(value) {
    if (Array.isArray(value) && value.length >= 2) {
      const lat = Number(value[0]);
      const lng = Number(value[1]);
      return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    }
    if (value && typeof value === 'object') {
      const lat = value.lat ?? value.latitude;
      const lng = value.lng ?? value.lon ?? value.longitude;
      const parsedLat = Number(lat);
      const parsedLng = Number(lng);
      if (Number.isFinite(parsedLat) && Number.isFinite(parsedLng)) return { lat: parsedLat, lng: parsedLng };
    }
    return null;
  }

  function normalizePolygonRegion(region) {
    const geometry = region.type === 'Feature' ? region.geometry : region.geometry || region;
    if (!geometry || !Array.isArray(geometry.coordinates)) return [];
    if (geometry.type === 'Polygon') return [geometry.coordinates];
    if (geometry.type === 'MultiPolygon') return geometry.coordinates;
    return [];
  }

  function pointInPolygon(point, ring) {
    const [lng, lat] = point;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = Number(ring[i][0]);
      const yi = Number(ring[i][1]);
      const xj = Number(ring[j][0]);
      const yj = Number(ring[j][1]);
      const denominator = yj - yi || 1e-12;
      const intersects = ((yi > lat) !== (yj > lat))
        && (lng < ((xj - xi) * (lat - yi)) / denominator + xi);
      if (intersects) inside = !inside;
    }
    return inside;
  }

  function annotateResultScope(result, input, scope) {
    const tradeScope = getInputTradeScope(input, scope);
    const tradeScopeLabel = getTradeScopeLabel(tradeScope);
    const annotatedScope = {
      ...(scope || makeGlobalScope(input)),
      tradeScope,
      tradeScopeLabel,
    };
    const aggregate = result.aggregate || {};
    const rawTotals = result.raw && result.raw.totals ? result.raw.totals : {};
    const allocationTotals = rawTotals.allocation && typeof rawTotals.allocation === 'object'
      ? sumSectorMap(rawTotals.allocation)
      : sumBy(result.basinResults || [], 'allocationTotal');
    const allocatedWater = Number.isFinite(allocationTotals) && allocationTotals > 0
      ? allocationTotals
      : (result.basinResults || []).reduce((sum, item) => sum + numberOr(item.allocation && item.allocation.total, 0), 0);
    const tradableWater = numberOr(
      aggregate.tradableWater,
      numberOr(rawTotals.withdrawn, allocatedWater)
    );
    const marketPrice = numberOr(aggregate.marketPrice, numberOr(result.raw && result.raw.marketPrice, 0));
    const tradingCostCny = numberOr(aggregate.tradingCostCny, tradableWater * numberOr(input.params && input.params.tradingCost, 0));
    const dalyAvoided = numberOr(aggregate.dalyAvoided, sumBy(result.basinResults || [], 'dalyAvoided'));
    const healthBenefitCny = numberOr(aggregate.healthBenefitCny, dalyAvoided * VALUE_PER_DALY);
    const diseaseCasesAvoided = numberOr(aggregate.diseaseCasesAvoided, dalyAvoided / DISEASE_CASE_DALY);
    const economicNpvCny = numberOr(aggregate.economicNpvCny, healthBenefitCny - tradingCostCny);
    const incentiveFlags = collectIncentiveFlags(result);
    const environmentSummary = buildEnvironmentSummary(result, input);

    result.aggregate = {
      ...aggregate,
      tradableWater,
      marketPrice,
      dalyAvoided,
      diseaseCasesAvoided,
      healthBenefitCny,
      economicNpvCny,
      tradingCostCny,
      incentiveCompatible: aggregate.incentiveCompatible !== undefined
        ? aggregate.incentiveCompatible
        : incentiveFlags.length === 0,
      compatibleShare: numberOr(
        aggregate.compatibleShare,
        result.basinResults && result.basinResults.length
          ? result.basinResults.filter((item) => item.incentiveCompatible).length / result.basinResults.length
          : 1
      ),
      violatingIds: incentiveFlags.map((flag) => flag.nodeId).filter(Boolean),
      ecoBaseFlow: environmentSummary.ecoBaseFlow,
      ecoSurplus: environmentSummary.ecoSurplus,
      inStreamFlow: environmentSummary.inStreamFlow,
      environmentalFlow: environmentSummary.environmentalFlow,
      environmentFlow: environmentSummary.environmentalFlow,
      industryWithdrawal: environmentSummary.industryWithdrawal,
      totalWithdrawal: environmentSummary.totalWithdrawal,
      tradeScope,
      tradeScopeLabel,
    };

    result.params = {
      ...(result.params || input.params || {}),
      tradeScope,
    };

    result.meta = {
      ...(result.meta || {}),
      scope: annotatedScope,
      selectedIds: annotatedScope.selectedIds,
      scopeMode: annotatedScope.mode,
      scopeMessage: annotatedScope.message,
      scopeWarning: annotatedScope.warning,
      tradeScope,
      tradeScopeLabel,
      source: input.meta && input.meta.source,
      note: SAMPLE_NOTE,
      incentiveFlags,
    };
  }

  function buildEnvironmentSummary(result, input) {
    const params = input.params || {};
    const ecoFloor = clampValue(numberOr(params.ecoFloor, 0.15), 0.10, 0.40);
    const baseById = new Map((input.basins || []).map((basin) => [String(basin.id), basin]));
    const totals = {
      ecoBaseFlow: 0,
      ecoSurplus: 0,
      inStreamFlow: 0,
      environmentalFlow: 0,
      industryWithdrawal: 0,
      totalWithdrawal: 0,
    };

    (result.basinResults || []).forEach((item) => {
      if (!item) return;
      const id = String(item.id || '');
      const base = baseById.get(id) || {};
      const modelNode = item.modelNode || {};
      const supply = item.supply || modelNode.supply || base.supply || {};
      const demand = item.demand || modelNode.demand || base.demand || {};
      const allocation = item.allocation || modelNode.allocation || {};
      const totalWithdrawal = Math.max(0, firstFiniteNumber([
        item.qWithdrawn,
        modelNode.qWithdrawn,
        allocation.total,
        sumSectorMap(allocation),
      ], 0));
      const naturalFlow = Math.max(0, firstFiniteNumber([
        item.qAvail,
        modelNode.qAvail,
        supply.qAvail,
        base.qAvail,
        base.supply && base.supply.qAvail,
        totalWithdrawal,
      ], totalWithdrawal));
      const localFlowReference = Math.max(0, firstFiniteNumber([
        item.ecoReferenceFlow,
        modelNode.ecoReferenceFlow,
        supply.localRunoff,
        supply.qLocalRaw,
        supply.qLocal,
        base.localRunoff,
        base.qLocalRaw,
        base.qLocal,
        base.supply && base.supply.localRunoff,
        base.supply && base.supply.qLocalRaw,
        base.supply && base.supply.qLocal,
        naturalFlow,
      ], naturalFlow));
      const inStreamFlow = Math.max(0, firstFiniteNumber([
        item.inStreamFlow,
        modelNode.inStreamFlow,
        item.qOutflow,
        modelNode.qOutflow,
        supply.qOutflow,
        naturalFlow - totalWithdrawal,
      ], Math.max(0, naturalFlow - totalWithdrawal)));
      const legacyEcoDemand = Math.max(0, firstFiniteNumber([
        item.legacyEcoDemand,
        modelNode.legacyEcoDemand,
        demand.eco,
        base.demand && base.demand.eco,
      ], 0));
      const derivedBaseFlow = Math.min(localFlowReference * 0.95, Math.max(ecoFloor * localFlowReference, legacyEcoDemand));
      const ecoBaseFlow = Math.max(0, firstFiniteNumber([
        item.ecoBaseFlow,
        modelNode.ecoBaseFlow,
        supply.ecoBaseFlow,
      ], derivedBaseFlow));
      const ecoSurplus = Math.max(0, firstFiniteNumber([
        item.ecoSurplus,
        modelNode.ecoSurplus,
        supply.ecoSurplus,
      ], inStreamFlow - ecoBaseFlow));
      const environmentalFlow = ecoBaseFlow + ecoSurplus;
      const industryWithdrawal = Math.max(0, firstFiniteNumber([
        item.industryWithdrawal,
        modelNode.industryWithdrawal,
        allocation.industry,
      ], 0));

      item.ecoBaseFlow = roundMetric(ecoBaseFlow);
      item.inStreamFlow = roundMetric(inStreamFlow);
      item.qOutflow = roundMetric(inStreamFlow);
      item.ecoSurplus = roundMetric(ecoSurplus);
      item.environmentalFlow = roundMetric(environmentalFlow);
      item.environmentFlow = item.environmentalFlow;
      item.industryWithdrawal = roundMetric(industryWithdrawal);
      item.qWithdrawn = roundMetric(totalWithdrawal);
      item.ecoFloor = ecoFloor;
      item.ecoReferenceFlow = roundMetric(localFlowReference);

      totals.ecoBaseFlow += ecoBaseFlow;
      totals.ecoSurplus += ecoSurplus;
      totals.inStreamFlow += inStreamFlow;
      totals.environmentalFlow += environmentalFlow;
      totals.industryWithdrawal += industryWithdrawal;
      totals.totalWithdrawal += totalWithdrawal;
    });

    return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, roundMetric(value)]));
  }

  function collectIncentiveFlags(result) {
    if (result.raw && result.raw.incentive && Array.isArray(result.raw.incentive.flags)) {
      return result.raw.incentive.flags;
    }
    return (result.basinResults || [])
      .filter((item) => item.incentiveCompatible === false)
      .map((item) => ({
        type: 'incentive',
        nodeId: item.id,
        nodeName: item.name,
      }));
  }

  function createScopeNoticeResult(input, scope) {
    const tradeScope = getInputTradeScope(input, scope);
    const tradeScopeLabel = getTradeScopeLabel(tradeScope);
    const annotatedScope = {
      ...(scope || makeGlobalScope(input)),
      tradeScope,
      tradeScopeLabel,
    };
    return {
      params: {
        ...(input.params || {}),
        tradeScope,
      },
      basinResults: [],
      flows: [],
      aggregate: {
        tradableWater: 0,
        marketPrice: 0,
        dalyAvoided: 0,
        diseaseCasesAvoided: 0,
        healthBenefitCny: 0,
        economicNpvCny: 0,
        tradingCostCny: 0,
        downstreamPopulationAffected: 0,
        upstreamDownstreamInequity: 0,
        incentiveCompatible: true,
        compatibleShare: 1,
        waterStress: 0,
        violatingIds: [],
        tradeScope,
        tradeScopeLabel,
      },
      meta: {
        solver: 'region-scope',
        solverEngine: 'not-run',
        lpSpikePending: false,
        skipSolve: true,
        modelLabel: scope.warning || '等待选区',
        scope: annotatedScope,
        selectedIds: annotatedScope.selectedIds,
        scopeMode: annotatedScope.mode,
        scopeMessage: annotatedScope.message,
        scopeWarning: annotatedScope.warning,
        tradeScope,
        tradeScopeLabel,
        source: input.meta && input.meta.source,
        note: SAMPLE_NOTE,
        incentiveFlags: [],
      },
    };
  }

  function updateScopeStatus(scope) {
    if (!scope) return;
    const total = state.network && state.network.basins ? state.network.basins.length : scope.totalCount;
    const selectedCount = scope.mode === 'global' ? total : scope.selectedIds.length;
    const message = scope.warning || scope.message || scope.label;
    setText('region-status', message);
    setText('basin-count', scope.mode === 'global' ? String(total) : `${selectedCount}/${total}`);
    if (!state.selectedId) {
      setText('selected-basin', scope.mode === 'global' ? '全域' : message);
    }
  }

  function updateSolverStatus(result) {
    if (result.meta && result.meta.skipSolve) {
      setText('solver-status', result.meta.scopeWarning || '等待选区');
      const note = document.getElementById('solver-note');
      if (note) note.hidden = true;
      return;
    }

    const elapsed = Number.isFinite(result.meta.elapsedMs) ? `${result.meta.elapsedMs}ms` : '--';
    const parts = [result.meta.modelLabel, result.meta.solverEngine, elapsed].filter(Boolean);
    setText('solver-status', parts.join(' · '));

    const note = document.getElementById('solver-note');
    if (note) note.hidden = !result.meta.lpSpikePending;
  }

  function renderAll() {
    if (!state.result || !state.network) return;
    const context = buildRenderContext();

    if (window.ResearchMap && typeof window.ResearchMap.update === 'function') {
      const mapSelectedIds = state.scope && state.scope.mode === 'region' ? state.scope.selectedIds : [];
      window.ResearchMap.update({
        ...context,
        network: state.network,
        result: state.result,
        activeLayer: state.activeLayer,
        selectedId: state.selectedId,
        selectedIds: mapSelectedIds,
        downstreamHighlightIds: getDownstreamHighlightIds(),
        scope: state.scope,
      });
    }

    if (window.ResearchDashboard && typeof window.ResearchDashboard.update === 'function') {
      window.ResearchDashboard.update(state.result, state.selectedId, context);
    }

    if (window.ResearchRichPanels && typeof window.ResearchRichPanels.update === 'function') {
      window.ResearchRichPanels.update(state.result, context);
      bindRichEvents();
      updateNoMarketToggle();
    }
  }

  function buildRenderContext() {
    if (!state.tradeAggregate) {
      state.tradeAggregate = buildTradeAggregateContext({ preservePrevious: true });
      if (state.result) state.result.tradeAggregate = state.tradeAggregate;
    }
    return {
      network: state.network,
      modelInput: state.currentModelInput,
      params: state.params,
      scope: state.scope,
      selectedId: state.selectedId,
      selectedIds: state.scope && state.scope.selectedIds,
      downstreamFocus: buildDownstreamFocus(state.selectedId),
      noMarketEnabled: state.noMarketEnabled,
      noMarketComparison: state.noMarketComparison,
      noMarketResult: state.noMarketResult,
      noTaxComparison: state.noTaxComparison,
      noTaxResult: state.noTaxResult,
      tauResponse: state.tauResponse,
      autarkyResult: state.autarkyResult,
      tradeAggregate: state.tradeAggregate,
      changedFlowKeys: Array.isArray(state.changedFlowKeys) ? [...state.changedFlowKeys] : [],
    };
  }

  function buildTradeAggregateContext(options = {}) {
    const result = state.result || {};
    const basinResults = Array.isArray(result.basinResults) ? result.basinResults : [];
    const baselineResult = getTradeBaselineResult();
    const marketReallocationFlows = buildMarketReallocationFlows(result, baselineResult, basinResults);
    const aggregate = computeTradeAggregate({
      tradeFlows: marketReallocationFlows,
      basinResults,
      withMarket: result,
      autarkyResult: state.autarkyResult,
      autarky: state.autarkyResult,
      baselineResult,
      withoutMarket: baselineResult,
      noMarketResult: state.noMarketResult,
      sectorBaseline: baselineResult,
      noMarketComparison: state.noMarketComparison,
      modelInput: state.currentModelInput,
      params: state.params,
      scope: state.scope,
      tradeBasisNote: TRADE_BASIS_NOTE,
    });
    const normalized = normalizeTradeAggregate(aggregate, marketReallocationFlows, basinResults, baselineResult);
    applyNetTradeToBasinResults(basinResults, normalized);
    if (!options.preservePrevious) {
      state.changedFlowKeys = getChangedFlowKeys(normalized.tradeFlows);
    }
    return normalized;
  }

  function getTradeBaselineResult() {
    return state.autarkyResult || state.noMarketResult || null;
  }

  function buildMarketReallocationFlows(withMarket, baseline, basinResults) {
    const rows = buildNodeDeltaRows(withMarket, baseline, basinResults);
    const sellers = rows.filter((row) => row.nodeDelta < -1e-6);
    const buyers = rows.filter((row) => row.nodeDelta > 1e-6);
    const totalSell = sellers.reduce((sum, row) => sum + Math.abs(row.nodeDelta), 0);
    const totalBuy = buyers.reduce((sum, row) => sum + row.nodeDelta, 0);
    const dispatchTotal = Math.min(totalSell, totalBuy);
    if (!dispatchTotal) return [];

    const marketPrice = numberOr(
      withMarket && withMarket.aggregate && withMarket.aggregate.marketPrice,
      numberOr(withMarket && withMarket.marketPrice, 0)
    );
    return sellers.flatMap((seller) => buyers.map((buyer) => {
      const volume = Math.abs(seller.nodeDelta) * (buyer.nodeDelta / totalBuy) * (dispatchTotal / totalSell);
      return {
        from: seller.id,
        fromName: seller.name,
        fromCode: seller.code,
        to: buyer.id,
        toName: buyer.name,
        toCode: buyer.code,
        volume,
        sector: 'market-reallocation',
        direction: 'seller-to-buyer',
        price: marketPrice,
        marketPrice,
        averageUnitCost: marketPrice,
        basis: TRADE_BASIS_NOTE,
      };
    })).filter((flow) => flow.volume > 1e-6);
  }

  function buildNodeDeltaRows(withMarket, baseline, basinResults) {
    if (!withMarket || !baseline || !Array.isArray(withMarket.basinResults) || !Array.isArray(baseline.basinResults)) {
      return [];
    }
    const baselineById = new Map(baseline.basinResults.map((item) => [String(item.id), item]));
    const displayById = new Map((basinResults || []).map((item) => [String(item.id), item]));
    return withMarket.basinResults.map((item) => {
      const id = String(item.id || '');
      const baselineItem = baselineById.get(id);
      const display = displayById.get(id) || item;
      return {
        id,
        name: display.name || item.name || id,
        code: display.code || item.code || id,
        nodeDelta: allocationTotal(item) - allocationTotal(baselineItem),
      };
    }).filter((row) => row.id && Number.isFinite(row.nodeDelta));
  }

  function allocationTotal(item) {
    if (!item) return 0;
    const allocation = item.allocation || {};
    return numberOr(allocation.total, sumSectorMap(allocation));
  }

  function computeTradeAggregate(input) {
    const external = callExternalTradeAggregate(input);
    return external || buildFallbackTradeAggregate(input);
  }

  function callExternalTradeAggregate(input) {
    const api = window.ResearchTradeAggregate || window.TradeAggregate || {};
    const candidates = [
      api.aggregateTradeFlows,
      api.buildTradeAggregate,
      api.computeTradeAggregate,
      api.createTradeAggregate,
      window.aggregateTradeFlows,
      window.buildTradeAggregate,
      window.computeTradeAggregate,
    ].filter((candidate) => typeof candidate === 'function');

    for (const candidate of candidates) {
      const aggregateOptions = {
        basinResults: input.basinResults,
        withMarket: input.withMarket,
        autarkyResult: input.autarkyResult,
        autarky: input.autarkyResult,
        baselineResult: input.baselineResult,
        withoutMarket: input.baselineResult || input.noMarketResult,
        noMarketResult: input.noMarketResult,
        sectorBaseline: input.sectorBaseline || input.noMarketResult || input.baselineResult,
        noMarketComparison: input.noMarketComparison,
        modelInput: input.modelInput,
        params: input.params,
        scope: input.scope,
        tradeBasisNote: input.tradeBasisNote,
      };
      const attempts = [
        () => candidate(input.tradeFlows, aggregateOptions),
        () => candidate({
          ...input,
          flows: input.tradeFlows,
          withoutMarket: input.baselineResult || input.noMarketResult,
          sectorBaseline: input.sectorBaseline || input.noMarketResult || input.baselineResult,
        }),
        () => candidate(input.tradeFlows, input.basinResults, aggregateOptions),
      ];
      for (const attempt of attempts) {
        try {
          const aggregate = attempt();
          if (looksLikeTradeAggregate(aggregate)) return aggregate;
        } catch (error) {
          console.warn('tradeAggregate external adapter failed; fallback remains available.', error);
        }
      }
    }
    return null;
  }

  function buildFallbackTradeAggregate(input) {
    const nodeDelta = buildNodeDeltaMap(input.withMarket, input.baselineResult || input.autarkyResult || input.noMarketResult);
    const perNodeNet = hasNumberMapValues(nodeDelta) ? { ...nodeDelta } : {};
    const partnersByNode = {};
    let totalTraded = 0;

    input.tradeFlows.forEach((flow) => {
      const from = flow.from;
      const to = flow.to;
      const volume = Math.max(0, numberOr(flow.volume, 0));
      if (!from || !to || !volume) return;

      totalTraded += volume;

      if (!partnersByNode[from]) partnersByNode[from] = { buyers: [], sellers: [] };
      if (!partnersByNode[to]) partnersByNode[to] = { buyers: [], sellers: [] };
      addUnique(partnersByNode[from].buyers, to);
      addUnique(partnersByNode[to].sellers, from);
    });

    input.basinResults.forEach((item) => {
      if (!item || !item.id) return;
      if (!partnersByNode[item.id]) partnersByNode[item.id] = { buyers: [], sellers: [] };
      perNodeNet[item.id] = numberOr(perNodeNet[item.id], 0);
    });

    return {
      nodeDelta: hasNumberMapValues(nodeDelta) ? nodeDelta : { ...perNodeNet },
      perNodeNet,
      sellers: Object.keys(perNodeNet).filter((id) => perNodeNet[id] < -1e-6),
      buyers: Object.keys(perNodeNet).filter((id) => perNodeNet[id] > 1e-6),
      totalTraded,
      partnersByNode,
      sectorReallocation: buildSectorReallocation(input.withMarket, input.sectorBaseline || input.noMarketResult || input.baselineResult || input.autarkyResult),
      tradeFlows: input.tradeFlows,
      flows: input.tradeFlows,
      tradeBasisNote: TRADE_BASIS_NOTE,
    };
  }

  function normalizeTradeAggregate(aggregate, tradeFlows, basinResults, baselineResult) {
    const fallback = buildFallbackTradeAggregate({
      tradeFlows,
      basinResults,
      withMarket: state.result,
      autarkyResult: state.autarkyResult,
      baselineResult,
      noMarketResult: state.noMarketResult,
      sectorBaseline: baselineResult,
    });
    const providedNodeDelta = readAggregateNumberMap(aggregate, ['nodeDelta', 'node_delta']);
    const providedPerNodeNet = readAggregateNumberMap(aggregate, ['perNodeNet', 'per_node_net', 'netTradeByNode']);
    const nodeDelta = hasNumberMapValues(providedNodeDelta)
      ? providedNodeDelta
      : hasNumberMapValues(providedPerNodeNet)
        ? providedPerNodeNet
        : fallback.nodeDelta;
    const perNodeNet = hasNumberMapValues(providedPerNodeNet)
      ? providedPerNodeNet
      : hasNumberMapValues(nodeDelta)
        ? { ...nodeDelta }
        : fallback.perNodeNet;
    const partnersByNode = aggregate && aggregate.partnersByNode && typeof aggregate.partnersByNode === 'object'
      ? normalizePartnersByNode(aggregate.partnersByNode, fallback.partnersByNode)
      : fallback.partnersByNode;
    const normalizedFlows = normalizeTradeFlows(getAggregateFlows(aggregate, tradeFlows), basinResults);
    const sectorReallocation = normalizeSectorDeltaMap(
      aggregate && aggregate.sectorReallocation,
      fallback.sectorReallocation
    );
    return {
      ...(aggregate || {}),
      nodeDelta,
      perNodeNet,
      sellers: normalizeIdList(aggregate && aggregate.sellers, fallback.sellers),
      buyers: normalizeIdList(aggregate && aggregate.buyers, fallback.buyers),
      totalTraded: numberOr(aggregate && aggregate.totalTraded, fallback.totalTraded),
      partnersByNode,
      sectorReallocation,
      unreallocated: numberOr(
        aggregate && (aggregate.unreallocated ?? aggregate.unreallocatedWater),
        sectorReallocation.unreallocated
      ),
      tradeFlows: normalizedFlows,
      flows: normalizedFlows,
      tradeBasisNote: (aggregate && aggregate.tradeBasisNote) || TRADE_BASIS_NOTE,
    };
  }

  function looksLikeTradeAggregate(value) {
    return Boolean(value && typeof value === 'object' && (
      value.nodeDelta
      || value.perNodeNet
      || Array.isArray(value.tradeFlows)
      || Array.isArray(value.flows)
      || value.partnersByNode
      || value.sectorReallocation
      || Array.isArray(value.sellers)
      || Array.isArray(value.buyers)
    ));
  }

  function getAggregateFlows(aggregate, fallbackFlows) {
    if (Array.isArray(aggregate && aggregate.tradeFlows)) return aggregate.tradeFlows;
    if (Array.isArray(aggregate && aggregate.flows)) return aggregate.flows;
    if (Array.isArray(aggregate && aggregate.marketFlows)) return aggregate.marketFlows;
    return fallbackFlows;
  }

  function readAggregateNumberMap(source, keys) {
    const key = keys.find((item) => source && source[item] && typeof source[item] === 'object');
    return key ? normalizeNumberMap(source[key]) : {};
  }

  function buildNodeDeltaMap(withMarket, baseline) {
    const rows = buildNodeDeltaRows(withMarket, baseline, withMarket && withMarket.basinResults);
    return rows.reduce((map, row) => {
      map[row.id] = row.nodeDelta;
      return map;
    }, {});
  }

  function invertNumberMap(map) {
    return Object.entries(map || {}).reduce((out, [key, value]) => {
      out[key] = -numberOr(value, 0);
      return out;
    }, {});
  }

  function hasNumberMapValues(map) {
    return Object.keys(map || {}).some((key) => Math.abs(numberOr(map[key], 0)) > 1e-9);
  }

  function applyNetTradeToBasinResults(basinResults, tradeAggregate) {
    basinResults.forEach((item) => {
      if (!item || !item.id) return;
      item.netTrade = numberOr(tradeAggregate.perNodeNet && tradeAggregate.perNodeNet[item.id], 0);
      item.nodeDelta = numberOr(tradeAggregate.nodeDelta && tradeAggregate.nodeDelta[item.id], -item.netTrade);
      item.tradeRole = item.netTrade < -1e-6 ? 'seller' : item.netTrade > 1e-6 ? 'buyer' : 'balanced';
      item.tradePartners = tradeAggregate.partnersByNode && tradeAggregate.partnersByNode[item.id]
        ? tradeAggregate.partnersByNode[item.id]
        : { buyers: [], sellers: [] };
    });
  }

  function getChangedFlowKeys(tradeFlows) {
    const current = flowVolumeMap(tradeFlows);
    const previous = state.previousTradeFlowVolumes;
    state.previousTradeFlowVolumes = current;
    if (!previous) return [];

    const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
    return Array.from(keys).filter((key) => Math.abs(numberOr(current[key], 0) - numberOr(previous[key], 0)) > 1e-6);
  }

  function flowVolumeMap(tradeFlows) {
    return tradeFlows.reduce((map, flow) => {
      const key = getFlowKey(flow);
      if (!key) return map;
      map[key] = numberOr(map[key], 0) + Math.max(0, numberOr(flow.volume, 0));
      return map;
    }, {});
  }

  function getFlowKey(flow) {
    const from = flow && flow.from !== undefined && flow.from !== null ? String(flow.from) : '';
    const to = flow && flow.to !== undefined && flow.to !== null ? String(flow.to) : '';
    if (!from || !to) return '';
    const sector = flow.sector || flow.sourceSector || flow.targetSector || 'all';
    return `${from}->${to}:${sector}`;
  }

  function normalizeTradeFlows(flows, basinResults) {
    const basinById = new Map((basinResults || []).map((item) => [String(item.id), item]));
    return (Array.isArray(flows) ? flows : []).map((flow) => {
      const from = flow.from ?? flow.origin ?? flow.source;
      const to = flow.to ?? flow.target ?? flow.destination;
      const fromId = from !== undefined && from !== null ? String(from) : '';
      const toId = to !== undefined && to !== null ? String(to) : '';
      const fromBasin = basinById.get(fromId);
      const toBasin = basinById.get(toId);
      return {
        ...flow,
        from: fromId,
        to: toId,
        fromName: flow.fromName || flow.originName || (fromBasin && fromBasin.name) || fromId,
        toName: flow.toName || flow.targetName || (toBasin && toBasin.name) || toId,
        volume: Math.max(0, numberOr(flow.volume ?? flow.amount ?? flow.q, 0)),
      };
    }).filter((flow) => flow.from && flow.to && flow.volume > 0);
  }

  function buildSectorReallocation(withMarket, withoutMarket) {
    if (!withoutMarket || !Array.isArray(withoutMarket.basinResults)) {
      return withUnreallocatedDelta(waterUseSectorMap());
    }
    const withTotals = allocationTotalsBySector(withMarket);
    const withoutTotals = allocationTotalsBySector(withoutMarket);
    return withUnreallocatedDelta(Object.fromEntries(WATER_USE_SECTORS.map((sector) => [
      sector,
      numberOr(withTotals[sector], 0) - numberOr(withoutTotals[sector], 0),
    ])));
  }

  function allocationTotalsBySector(result) {
    const totals = waterUseSectorMap();
    const rows = result && Array.isArray(result.basinResults) ? result.basinResults : [];
    rows.forEach((item) => {
      const allocation = item && item.allocation ? item.allocation : {};
      WATER_USE_SECTORS.forEach((sector) => {
        totals[sector] += numberOr(allocation[sector], 0);
      });
    });
    return totals;
  }

  function normalizeNumberMap(map) {
    return Object.entries(map || {}).reduce((out, [key, value]) => {
      out[String(key)] = numberOr(value, 0);
      return out;
    }, {});
  }

  function normalizePartnersByNode(partners, fallback) {
    const normalized = { ...(fallback || {}) };
    Object.entries(partners || {}).forEach(([id, item]) => {
      normalized[String(id)] = {
        buyers: normalizeIdList(item && item.buyers, []),
        sellers: normalizeIdList(item && item.sellers, []),
      };
    });
    return normalized;
  }

  function normalizeIdList(items, fallback) {
    const source = Array.isArray(items) ? items : fallback;
    return Array.from(new Set((Array.isArray(source) ? source : [])
      .map(getItemId)
      .filter((id) => id !== '')));
  }

  function getItemId(item) {
    if (item === undefined || item === null || item === '') return '';
    if (typeof item === 'object') {
      const id = item.id ?? item.nodeId ?? item.subbasinId ?? item.code;
      return id === undefined || id === null ? '' : String(id);
    }
    return String(item);
  }

  function normalizeSectorDeltaMap(map, fallback) {
    const provided = map && typeof map === 'object' ? map : null;
    const fallbackHasSignal = hasSectorDeltaSignal(fallback);
    const source = provided && (hasSectorDeltaSignal(provided) || !fallbackHasSignal)
      ? provided
      : fallback;
    const delta = Object.fromEntries(WATER_USE_SECTORS.map((sector) => [
      sector,
      numberOr(source && source[sector], 0),
    ]));
    return withUnreallocatedDelta(delta, source);
  }

  function hasSectorDeltaSignal(map) {
    return WATER_USE_SECTORS.some((sector) => Math.abs(numberOr(map && map[sector], 0)) > 1e-9);
  }

  function withUnreallocatedDelta(delta, source) {
    const reduced = WATER_USE_SECTORS.reduce((sum, sector) => {
      const value = numberOr(delta && delta[sector], 0);
      return value < -1e-6 ? sum + Math.abs(value) : sum;
    }, 0);
    const gained = WATER_USE_SECTORS.reduce((sum, sector) => {
      const value = numberOr(delta && delta[sector], 0);
      return value > 1e-6 ? sum + value : sum;
    }, 0);
    const explicit = Number(source && (source.unreallocated ?? source.unreallocatedWater));
    return {
      ...delta,
      unreallocated: Math.max(0, numberOr(Number.isFinite(explicit) ? explicit : reduced - gained, 0)),
    };
  }

  function addUnique(items, value) {
    const id = String(value);
    if (id && !items.includes(id)) items.push(id);
  }

  function handleBasinSelect(basinId, options = {}) {
    state.selectedId = basinId === state.selectedId && !options.force ? null : basinId;
    const selected = state.result && state.result.basinResults.find((item) => item.id === state.selectedId);
    if (selected) {
      setText('selected-basin', selected.name);
    } else {
      updateScopeStatus(state.scope);
    }
    renderAll();
  }

  function getDownstreamHighlightIds() {
    const focus = buildDownstreamFocus(state.selectedId);
    return focus ? focus.downstreamIds : [];
  }

  function buildDownstreamFocus(basinId) {
    if (!basinId || !state.currentModelInput) return null;
    const modelBasins = state.currentModelInput.basins || [];
    const resultBasins = state.result && Array.isArray(state.result.basinResults) ? state.result.basinResults : [];
    const basin = resultBasins.find((item) => item.id === basinId) || modelBasins.find((item) => item.id === basinId);
    if (!basin) return null;
    const downstreamIds = Array.isArray(basin.downstreamReach)
      ? basin.downstreamReach.map(String).filter((id) => id && id !== 'OUTLET')
      : [];
    const modelById = new Map(modelBasins.map((item) => [item.id, item]));
    const population = downstreamIds.reduce((sum, id) => {
      const downstream = modelById.get(id);
      return sum + numberOr(downstream && downstream.population, 0);
    }, 0);
    return {
      id: basinId,
      name: basin.name || basinId,
      downstreamIds,
      downstreamCount: downstreamIds.length,
      downstreamPopulation: population,
    };
  }

  async function loadNetworkData() {
    const responses = await Promise.allSettled([
      fetchJson(DATA_URLS.subbasins),
      fetchJson(DATA_URLS.rivers),
      fetchJson(DATA_URLS.attrs),
    ]);

    const [subbasinsResult, riversResult, attrsResult] = responses;
    const hasCoreData = subbasinsResult.status === 'fulfilled' && attrsResult.status === 'fulfilled';

    if (!hasCoreData) {
      const fallback = createFallbackNetwork();
      const errors = responses
        .filter((item) => item.status === 'rejected')
        .map((item) => item.reason && item.reason.message)
        .filter(Boolean);
      fallback.meta.loadWarnings = errors;
      return fallback;
    }

    const network = normalizeNetwork({
      subbasinsGeojson: subbasinsResult.value,
      riversGeojson: riversResult.status === 'fulfilled' ? riversResult.value : { type: 'FeatureCollection', features: [] },
      attrs: attrsResult.value,
      source: 'baked',
    });

    if (!network.basins.length) return createFallbackNetwork();
    return network;
  }

  async function fetchJson(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${url} ${response.status}`);
    return response.json();
  }

  function normalizeNetwork(raw) {
    const features = Array.isArray(raw.subbasinsGeojson && raw.subbasinsGeojson.features)
      ? raw.subbasinsGeojson.features
      : [];
    const attrItems = getAttrItems(raw.attrs);
    const attrById = new Map(attrItems.map((item) => [String(item.id), item]));
    const topology = raw.attrs && raw.attrs.topology ? raw.attrs.topology : {};

    const basins = features.map((feature, index) => {
      const props = feature.properties || {};
      const id = String(props.id || props.subbasinId || props.basin_id || props.SB_ID || `SB${String(index + 1).padStart(2, '0')}`);
      const attr = attrById.get(id) || {};
      const merged = { ...props, ...attr, id };
      const centroid = getFeatureCentroid(feature);
      const technicalCode = getSubbasinCode(merged, id);
      return {
        id,
        name: merged.nameZh || merged.name || merged.label || id,
        code: technicalCode,
        pfafId: merged.pfafId ?? merged.pfaf_id ?? null,
        areaKm2: numberOr(merged.areaKm2 || merged.area_km2 || merged.area, 0),
        population: numberOr(merged.population || merged.pop, 0),
        demand: normalizeDemand(merged.demand || merged.demands || merged),
        supply: normalizeSupply(merged.supply || merged),
        healthWeight: merged.healthWeight || merged.health_weight || {},
        downstream: merged.downstream || topology[id] || null,
        downstreamReach: Array.isArray(merged.downstreamReach) ? merged.downstreamReach : [],
        adminCities: Array.isArray(merged.adminCities) ? merged.adminCities.slice() : [],
        centroid,
        feature,
      };
    });

    return {
      source: raw.source || 'baked',
      subbasinsGeojson: {
        ...raw.subbasinsGeojson,
        features: features.map((feature, index) => ({
          ...feature,
          properties: {
            ...(feature.properties || {}),
            id: basins[index] && basins[index].id,
            name: basins[index] && basins[index].name,
            code: basins[index] && basins[index].code,
            pfafId: basins[index] && basins[index].pfafId,
          },
        })),
      },
      riversGeojson: raw.riversGeojson || { type: 'FeatureCollection', features: [] },
      attrs: raw.attrs || {},
      basins,
      topology,
      meta: {
        ...(raw.attrs && raw.attrs.meta ? raw.attrs.meta : {}),
        source: raw.source || 'baked',
        note: SAMPLE_NOTE,
      },
    };
  }

  function getAttrItems(attrs) {
    if (!attrs) return [];
    if (Array.isArray(attrs.subbasins)) return attrs.subbasins;
    if (Array.isArray(attrs.basins)) return attrs.basins;
    if (Array.isArray(attrs.features)) return attrs.features.map((feature) => ({ ...(feature.properties || {}), id: feature.id }));
    if (attrs.byId && typeof attrs.byId === 'object') {
      return Object.entries(attrs.byId).map(([id, value]) => ({ ...(value || {}), id }));
    }
    return Object.entries(attrs)
      .filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value))
      .map(([id, value]) => ({ ...value, id: value.id || id }));
  }

  function normalizeDemand(source) {
    return {
      agri: numberOr(source.agri || source.agriculture || source.W_agri || source.demandAgri, 0),
      industry: numberOr(source.industry || source.industrial || source.W_ind || source.demandIndustry, 0),
      urban: numberOr(source.urban || source.domestic || source.municipal || source.W_urban || source.demandUrban, 0),
      eco: numberOr(source.eco || source.ecological || source.environment || source.W_eco, 0),
    };
  }

  function normalizeSupply(source) {
    const externalInflow = numberOr(source.externalInflow || source.inflow || source.qExternal, 0);
    const mainstemInflow = numberOr(source.mainstemInflow || source.transitInjection || source.qTransit, 0);
    const qLocal = numberOr(source.qLocal || source.Q_local || source.local || source.localRunoff, 0);
    const qLocalRaw = numberOr(source.qLocalRaw || source.localRunoff || source.Q_local_raw, qLocal);
    const runoffCoeff = numberOr(source.runoffCoeff || source.runoffCoefficient || source.runoff_coeff, NaN);
    return {
      qLocal,
      qLocalRaw,
      localRunoff: qLocalRaw,
      qAvail: numberOr(source.qAvail || source.Q_avail || source.available || source.supply || 0, 0),
      externalInflow,
      mainstemInflow,
      ...(Number.isFinite(runoffCoeff) ? { runoffCoeff } : {}),
    };
  }

  function getSubbasinCode(source, fallbackId) {
    const raw = source && (source.code ?? source.pfafId ?? source.pfaf_id ?? source.Pfaf_ID ?? source.pfaf);
    if (raw !== undefined && raw !== null && raw !== '') {
      const text = String(raw);
      return text.startsWith('PF_') ? text : `PF_${text}`;
    }
    return String(fallbackId || '');
  }

  function toResearchModelParams(input) {
    return {
      network: {
        meta: input.meta,
        topology: input.topology,
        subbasins: input.basins.map((basin) => {
          const supply = basin.supply || {};
          const externalInflow = supply.externalInflow || supply.mainstemInflow || 0;
          return {
            id: basin.id,
            name: basin.name,
            code: basin.code,
            pfafId: basin.pfafId,
            areaKm2: basin.areaKm2,
            population: basin.population,
            demand: basin.demand,
            supply: {
              qLocal: supply.qLocal || supply.qAvail || 0,
              qLocalRaw: supply.qLocalRaw ?? supply.localRunoff ?? supply.qLocal ?? 0,
              localRunoff: supply.localRunoff ?? supply.qLocalRaw ?? supply.qLocal ?? 0,
              qAvail: supply.qAvail || supply.qLocal || 0,
              externalInflow,
              mainstemInflow: supply.mainstemInflow || 0,
              ...(Number.isFinite(Number(supply.runoffCoeff)) ? { runoffCoeff: Number(supply.runoffCoeff) } : {}),
            },
            healthWeight: basin.healthWeight,
            downstream: basin.downstream,
          };
        }),
      },
      tau: input.params.tau,
      healthTaxRate: input.params.tau,
      climate: input.params.climate,
      climateScenario: input.params.climate,
      healthFloor: input.params.healthFloor,
      ecoFloor: input.params.ecoFloor,
      ecologicalFlowFloor: input.params.ecoFloor,
      environmentalFlowFloor: input.params.ecoFloor,
      tradingCost: input.params.tradingCost,
      demandElasticity: input.params.demandElasticity,
      tradeScope: getInputTradeScope(input),
      tradeScopeLabel: getTradeScopeLabel(getInputTradeScope(input)),
      trade: input.trade || (input.meta && input.meta.trade),
      marketMode: input.marketMode || (input.meta && input.meta.tradeBaseline),
      comparisonScenario: input.meta && input.meta.comparisonScenario,
      preferLp: true,
      solver: 'lp',
    };
  }

  function normalizeModelResult(result, input, solverName) {
    if (!result || typeof result !== 'object') {
      return solveFallbackNetwork(input);
    }

    if (result.kind === 'research-network-solution' && Array.isArray(result.nodes)) {
      return normalizeResearchNetworkSolution(result, input, solverName);
    }

    const basinResults = Array.isArray(result.basinResults)
      ? result.basinResults
      : Array.isArray(result.subbasins)
        ? result.subbasins
        : Array.isArray(result.nodes)
          ? result.nodes
          : [];

    const normalizedBasins = basinResults.length
      ? basinResults.map((item) => normalizeBasinResult(item, input.basins))
      : solveFallbackNetwork(input).basinResults;

    const aggregate = normalizeAggregate(result.aggregate || result.metrics || result, normalizedBasins);

    return {
      params: input.params,
      basinResults: normalizedBasins,
      flows: [],
      hydrologicFlows: normalizeFlows(result.flows, input.basins),
      aggregate,
      meta: {
        ...(result.meta || {}),
        solver: solverName,
        solverEngine: getSolverEngineFromRaw(result),
        lpSpikePending: hasLpSpikePendingRaw(result),
        source: input.meta && input.meta.source,
        note: SAMPLE_NOTE,
      },
    };
  }

  function normalizeResearchNetworkSolution(solution, input, solverName) {
    const flags = (solution.incentive && Array.isArray(solution.incentive.flags)) ? solution.incentive.flags : [];
    const flagsByNode = new Map();
    flags.forEach((flag) => {
      const id = String(flag.nodeId || '');
      if (!flagsByNode.has(id)) flagsByNode.set(id, []);
      flagsByNode.get(id).push(flag);
    });

    const basinResults = solution.nodes.map((node) => {
      const base = input.basins.find((basin) => basin.id === node.id) || {};
      const allocation = waterUseSectorMap(node.allocation);
      const unmet = waterUseSectorMap(node.unmet);
      const demandTotal = sumSectorMap(node.demand);
      const unmetTotal = sumSectorMap(unmet);
      const allocationTotal = sumSectorMap(allocation);
      const qAvail = numberOr(node.qAvail, allocationTotal);
      const qOutflow = numberOr(node.inStreamFlow ?? node.qOutflow, Math.max(0, qAvail - allocationTotal));
      const qWithdrawn = allocationTotal;
      const urbanCoverage = clamp01(
        numberOr(allocation.urban, 0) / Math.max(numberOr(node.demand && node.demand.urban, 0), 1)
      );
      const stressIndex = clamp01(unmetTotal / Math.max(demandTotal, 1));
      const downstreamPopulation = numberOr(node.healthTax && node.healthTax.downstreamPopulation, 0);
      const healthTax = numberOr(node.healthTax && node.healthTax.taxPerM3, 0);
      const taxIntensity = clamp01(healthTax / Math.max((solution.marketPrice || 0) + healthTax, 1));
      // 优先采用求解器自己算出的 dalyAvoided：它含气候压力项
      // （networkModel.computeNodeDalyAvoided），本地兜底公式没有，
      // 若在此覆盖会让气候情景对健康产出完全失效。
      const dalyAvoided = numberOr(
        node.dalyAvoided ?? node.totalDalyAvoided,
        Math.max(0, node.population / 100000 * 16 * urbanCoverage
          * (0.72 + input.params.healthFloor + input.params.tau * 0.55))
      );
      const inequity = clamp01(stressIndex * 0.62 + (downstreamPopulation / 9000000) * 0.22 + taxIntensity * 0.16 - input.params.healthFloor * 0.18);

      return {
        id: node.id,
        name: base.name || node.name || node.id,
        code: base.code || getSubbasinCode(node, node.id),
        pfafId: base.pfafId ?? node.pfafId ?? node.pfaf_id ?? null,
        population: node.population,
        demand: node.demand,
        supply: {
          qAvail,
          qLocal: node.qLocal,
          qOutflow,
          qWithdrawn,
          ecoBaseFlow: node.ecoBaseFlow,
          ecoSurplus: node.ecoSurplus,
        },
        allocation: { ...allocation, total: allocationTotal },
        unmet,
        qAvail,
        qOutflow,
        inStreamFlow: qOutflow,
        qWithdrawn,
        ecoBaseFlow: node.ecoBaseFlow,
        ecoSurplus: node.ecoSurplus,
        downstream: node.downstream,
        downstreamReach: node.downstreamReach,
        downstreamPopulationAffected: downstreamPopulation,
        dalyAvoided,
        healthBenefitCny: dalyAvoided * VALUE_PER_DALY,
        healthTax: node.healthTax,
        stressIndex,
        taxIntensity,
        inequity,
        marketPrice: solution.marketPrice,
        incentiveCompatible: !flagsByNode.has(node.id),
        modelNode: node,
      };
    });

    const compatibleCount = basinResults.filter((item) => item.incentiveCompatible).length;
    const aggregate = {
      dalyAvoided: sumBy(basinResults, 'dalyAvoided'),
      healthBenefitCny: sumBy(basinResults, 'healthBenefitCny'),
      downstreamPopulationAffected: Math.max(...basinResults.map((item) => item.downstreamPopulationAffected || 0), 0),
      upstreamDownstreamInequity: weightedMean(basinResults, 'inequity', 'population') * 100,
      incentiveCompatible: solution.incentive ? Boolean(solution.incentive.compatible) : compatibleCount === basinResults.length,
      compatibleShare: basinResults.length ? compatibleCount / basinResults.length : 1,
      waterStress: weightedMean(basinResults, 'stressIndex', 'population'),
      marketPrice: numberOr(solution.marketPrice, 0),
      totals: solution.totals,
    };

    const hydrologicFlows = normalizeFlows(Array.isArray(solution.tradeFlows)
      ? solution.tradeFlows.map((flow) => ({
        from: flow.origin,
        fromName: flow.originName,
        to: flow.target,
        toName: flow.targetName,
        volume: flow.volume,
        price: flow.averageUnitCost || flow.marketPrice,
        marketPrice: flow.marketPrice,
        tradingCostPerM3: flow.tradingCostPerM3,
        averageUnitCost: flow.averageUnitCost,
        sector: flow.sector,
      }))
      : [], input.basins);

    return {
      params: input.params,
      basinResults,
      flows: [],
      hydrologicFlows,
      aggregate,
      raw: solution,
      meta: {
        solver: solverName,
        solverEngine: getSolverEngineFromRaw(solution),
        lpSpikePending: hasLpSpikePendingRaw(solution),
        lpReady: solution.solver && solution.solver.lpReady,
        source: input.meta && input.meta.source,
        note: SAMPLE_NOTE,
      },
    };
  }

  function normalizeBasinResult(item, basins) {
    const id = String(item.id || item.subbasinId || item.node || '');
    const base = basins.find((basin) => basin.id === id) || {};
    return {
      ...item,
      id,
      name: item.name || base.name || id,
      code: item.code || base.code || getSubbasinCode(item, id),
      pfafId: item.pfafId ?? item.pfaf_id ?? base.pfafId ?? null,
      population: numberOr(item.population, base.population || 0),
      dalyAvoided: numberOr(item.dalyAvoided || item.daly || item.healthGain, 0),
      healthBenefitCny: numberOr(item.healthBenefitCny || item.healthBenefit || item.benefit, 0),
      downstreamPopulationAffected: numberOr(item.downstreamPopulationAffected || item.affectedDownstreamPopulation, 0),
      stressIndex: clamp01(numberOr(item.stressIndex || item.waterStress || item.stress, 0)),
      taxIntensity: clamp01(numberOr(item.taxIntensity || item.healthTaxIntensity || item.tax, 0)),
      inequity: clamp01(numberOr(item.inequity || item.unfairnessContribution || item.unfairness, 0)),
      incentiveCompatible: item.incentiveCompatible !== false,
    };
  }

  function normalizeFlows(flows, basins) {
    if (!Array.isArray(flows)) return [];
    const basinById = new Map((basins || []).map((basin) => [String(basin.id), basin]));
    return flows.map((flow) => {
      const from = flow.from ?? flow.origin ?? flow.source;
      const to = flow.to ?? flow.target ?? flow.destination;
      const fromBasin = basinById.get(String(from));
      const toBasin = basinById.get(String(to));
      return {
        ...flow,
        from,
        to,
        fromName: flow.fromName || flow.originName || (fromBasin && fromBasin.name) || from,
        toName: flow.toName || flow.targetName || (toBasin && toBasin.name) || to,
        fromCode: flow.fromCode || (fromBasin && fromBasin.code) || getSubbasinCode({}, from),
        toCode: flow.toCode || (toBasin && toBasin.code) || getSubbasinCode({}, to),
      };
    });
  }

  function normalizeAggregate(source, basinResults) {
    const dalyAvoided = numberOr(source.dalyAvoided || source.daly || source.totalDalyAvoided, sumBy(basinResults, 'dalyAvoided'));
    const healthBenefitCny = numberOr(source.healthBenefitCny || source.healthBenefit || source.benefitCny, dalyAvoided * VALUE_PER_DALY);
    const affected = numberOr(
      source.downstreamPopulationAffected || source.affectedDownstreamPopulation,
      Math.max(...basinResults.map((item) => item.downstreamPopulationAffected || 0), 0)
    );
    const compatibleShare = numberOr(
      source.compatibleShare,
      basinResults.length ? basinResults.filter((item) => item.incentiveCompatible).length / basinResults.length : 1
    );
    const inequity = numberOr(
      source.upstreamDownstreamInequity || source.inequityIndex || source.unfairnessIndex,
      weightedMean(basinResults, 'inequity', 'population') * 100
    );

    return {
      dalyAvoided,
      healthBenefitCny,
      downstreamPopulationAffected: affected,
      upstreamDownstreamInequity: inequity,
      incentiveCompatible: source.incentiveCompatible !== undefined ? Boolean(source.incentiveCompatible) : compatibleShare >= 0.92,
      compatibleShare,
      waterStress: numberOr(source.waterStress, weightedMean(basinResults, 'stressIndex', 'population')),
      marketPrice: numberOr(source.marketPrice, 0),
    };
  }

  function solveFallbackNetwork(input, error) {
    const params = input.params;
    const climate = CLIMATE[params.climate] || CLIMATE.ssp245;
    const topology = input.topology || {};
    const basinById = new Map(input.basins.map((basin) => [basin.id, basin]));
    const downstreamPopulation = buildDownstreamPopulation(input.basins, topology);

    const basinResults = input.basins.map((basin) => {
      const demand = basin.demand;
      const demandUrban = numberOr(demand.urban, 0);
      const demandAgri = numberOr(demand.agri, 0);
      const demandIndustry = numberOr(demand.industry, 0);
      const legacyEcoDemand = numberOr(demand.eco, 0);
      const withdrawalDemand = demandUrban + demandAgri + demandIndustry;
      const supplyDemandAnchor = withdrawalDemand + legacyEcoDemand;
      const qAvailBase = basin.supply.qAvail || basin.supply.qLocal || supplyDemandAnchor * 0.92 || 1;
      const available = qAvailBase * climate.waterFactor;
      const localRunoffBase = Math.max(0, firstFiniteNumber([
        basin.supply.localRunoff,
        basin.supply.qLocalRaw,
        basin.supply.qLocal,
        qAvailBase,
      ], qAvailBase));
      const localRunoffAvailable = localRunoffBase * climate.waterFactor;
      const ecoFloor = clampValue(numberOr(params.ecoFloor, 0.15), 0.10, 0.40);
      const ecoBaseFlow = Math.min(localRunoffAvailable * 0.95, Math.max(ecoFloor * localRunoffAvailable, legacyEcoDemand));
      const allocatableWater = Math.max(0, available - ecoBaseFlow);
      const healthFloor = clampValue(numberOr(params.healthFloor, 0.25), 0, 0.95);
      const healthReserve = allocatableWater * healthFloor;
      const urbanAllocation = Math.min(demandUrban, allocatableWater, healthReserve + allocatableWater * 0.28);
      const remainingAfterUrban = Math.max(0, allocatableWater - urbanAllocation);
      const demandElasticity = clampValue(numberOr(params.demandElasticity, 0.9), 0.3, 1.2);
      const taxAdjustedIndustryDemand = demandIndustry * Math.max(0.45, 1 - numberOr(params.tau, 0) * 0.8 * demandElasticity);
      const nonHealthNeed = demandAgri + taxAdjustedIndustryDemand;
      const nonHealthWater = remainingAfterUrban * Math.max(0.55, 1 - numberOr(params.tradingCost, 0));
      const agriAllocation = Math.min(demandAgri, nonHealthWater * safeShare(demandAgri, nonHealthNeed));
      const industryAllocation = Math.min(demandIndustry, nonHealthWater * safeShare(taxAdjustedIndustryDemand, nonHealthNeed));
      const allocatedTotal = urbanAllocation + agriAllocation + industryAllocation;
      const qWithdrawn = allocatedTotal;
      const inStreamFlow = Math.max(0, available - qWithdrawn);
      const ecoSurplus = Math.max(0, inStreamFlow - ecoBaseFlow);
      const environmentalFlow = ecoBaseFlow + ecoSurplus;
      const stressIndex = clamp01((withdrawalDemand - qWithdrawn) / Math.max(withdrawalDemand, 1));
      const downstreamPop = downstreamPopulation.get(basin.id) || 0;
      const urbanCoverage = clamp01(urbanAllocation / Math.max(demandUrban, 1));
      const industryPressure = clamp01(industryAllocation / Math.max(available, 1));
      const taxIntensity = clamp01(params.tau * (0.35 + industryPressure) * (1 + downstreamPop / 5000000));
      const dalyAvoided = Math.max(0, basin.population / 100000 * 16 * climate.dalyFactor * urbanCoverage * (0.72 + params.healthFloor + params.tau * 0.55));
      const inequity = clamp01((stressIndex * 0.58) + (industryPressure * 0.22) + (downstreamPop / 9000000 * 0.20) - params.healthFloor * 0.26);
      const marketPrice = 0.32 + stressIndex * 0.72 + params.tradingCost * 1.4 + params.tau * 0.18;
      const incentiveCompatible = taxIntensity < 0.58 && params.tradingCost < 0.22 && stressIndex < 0.72;

      return {
        id: basin.id,
        name: basin.name,
        code: basin.code,
        pfafId: basin.pfafId,
        population: basin.population,
        demand,
        supply: {
          qAvail: available,
          ecoBaseFlow,
          qOutflow: inStreamFlow,
          qWithdrawn,
          ecoSurplus,
          environmentalFlow,
          ecoReferenceFlow: localRunoffAvailable,
        },
        allocation: {
          agri: agriAllocation,
          industry: industryAllocation,
          urban: urbanAllocation,
          total: allocatedTotal,
        },
        unmet: {
          agri: Math.max(0, demandAgri - agriAllocation),
          industry: Math.max(0, demandIndustry - industryAllocation),
          urban: Math.max(0, demandUrban - urbanAllocation),
        },
        legacyEcoDemand,
        ecoFloor,
        ecoReferenceFlow: localRunoffAvailable,
        ecoBaseFlow,
        inStreamFlow,
        qOutflow: inStreamFlow,
        qWithdrawn,
        ecoSurplus,
        environmentalFlow,
        environmentFlow: environmentalFlow,
        downstream: basin.downstream || topology[basin.id] || null,
        downstreamPopulationAffected: downstreamPop,
        dalyAvoided,
        healthBenefitCny: dalyAvoided * VALUE_PER_DALY,
        healthTax: { taxPerM3: taxIntensity * marketPrice, downstreamPopulation: downstreamPop },
        stressIndex,
        taxIntensity,
        inequity,
        marketPrice,
        incentiveCompatible,
      };
    });

    const flows = basinResults
      .filter((item) => item.downstream && item.downstream !== 'OUTLET')
      .map((item) => ({
        from: item.id,
        fromName: item.name,
        fromCode: item.code,
        to: item.downstream,
        toName: (basinById.get(String(item.downstream)) || {}).name || item.downstream,
        toCode: (basinById.get(String(item.downstream)) || {}).code || item.downstream,
        volume: Math.max(0, item.qOutflow),
        price: item.marketPrice,
      }));

    const compatibleCount = basinResults.filter((item) => item.incentiveCompatible).length;
    const aggregate = {
      dalyAvoided: sumBy(basinResults, 'dalyAvoided'),
      healthBenefitCny: sumBy(basinResults, 'healthBenefitCny'),
      downstreamPopulationAffected: Math.max(...basinResults.map((item) => item.downstreamPopulationAffected), 0),
      upstreamDownstreamInequity: weightedMean(basinResults, 'inequity', 'population') * 100,
      incentiveCompatible: compatibleCount === basinResults.length,
      compatibleShare: basinResults.length ? compatibleCount / basinResults.length : 1,
      waterStress: weightedMean(basinResults, 'stressIndex', 'population'),
      marketPrice: weightedMean(basinResults, 'marketPrice', 'population'),
    };

    return {
      params,
      basinResults,
      flows,
      aggregate,
      meta: {
        solver: 'fallback-network',
        solverEngine: 'fallback-network',
        lpSpikePending: false,
        source: input.meta && input.meta.source,
        note: SAMPLE_NOTE,
        fallbackReason: error ? error.message : 'ResearchNetworkModel.solveNetwork not available',
      },
    };
  }

  function buildDownstreamPopulation(basins, topology) {
    const basinById = new Map(basins.map((basin) => [basin.id, basin]));
    const result = new Map();

    basins.forEach((basin) => {
      let total = 0;
      const seen = new Set([basin.id]);
      let next = basin.downstream || topology[basin.id];
      while (next && next !== 'OUTLET' && !seen.has(next)) {
        seen.add(next);
        const downstream = basinById.get(String(next));
        if (!downstream) break;
        total += downstream.population || 0;
        next = downstream.downstream || topology[downstream.id];
      }
      result.set(basin.id, total);
    });

    return result;
  }

  function createFallbackNetwork() {
    const subbasinsGeojson = {
      type: 'FeatureCollection',
      features: [
        polygonFeature('SB01', '汉江上游入境', [[112.72, 31.17], [113.62, 31.25], [113.72, 30.78], [112.86, 30.66]]),
        polygonFeature('SB02', '武汉主城汇流区', [[113.72, 30.78], [114.66, 30.84], [114.76, 30.28], [113.88, 30.18]]),
        polygonFeature('SB03', '梁子湖-鄂州片区', [[114.72, 30.52], [115.54, 30.58], [115.62, 30.06], [114.82, 29.96]]),
        polygonFeature('SB04', '黄冈下游片区', [[115.36, 30.92], [116.10, 30.82], [116.02, 30.22], [115.46, 30.12]]),
        polygonFeature('SB05', '江汉平原灌区', [[112.52, 30.48], [113.52, 30.58], [113.68, 29.92], [112.64, 29.78]]),
        polygonFeature('SB06', '咸宁丘陵源区', [[113.72, 29.92], [114.72, 30.04], [114.64, 29.32], [113.82, 29.20]]),
      ],
    };

    const attrs = {
      meta: {
        region: '武汉都市圈（内置小型示例）',
        source: 'UI fallback sample',
        note: SAMPLE_NOTE,
      },
      topology: {
        SB01: 'SB02',
        SB02: 'SB04',
        SB03: 'SB04',
        SB04: 'OUTLET',
        SB05: 'SB02',
        SB06: 'SB03',
      },
      subbasins: [
        basinAttr('SB01', '汉江上游入境', 920, 880000, 2.6e8, 7.8e7, 5.2e7, 1.2e7, 4.6e8),
        basinAttr('SB02', '武汉主城汇流区', 760, 4200000, 6.8e7, 1.95e8, 2.72e8, 2.5e7, 5.6e8),
        basinAttr('SB03', '梁子湖-鄂州片区', 690, 1180000, 1.36e8, 1.12e8, 7.3e7, 2.2e7, 3.4e8),
        basinAttr('SB04', '黄冈下游片区', 820, 1550000, 2.18e8, 8.6e7, 9.4e7, 2.4e7, 4.2e8),
        basinAttr('SB05', '江汉平原灌区', 1120, 1320000, 3.84e8, 5.1e7, 8.6e7, 2.8e7, 4.8e8),
        basinAttr('SB06', '咸宁丘陵源区', 740, 760000, 1.58e8, 4.8e7, 4.9e7, 2.0e7, 2.7e8),
      ],
    };

    const riversGeojson = {
      type: 'FeatureCollection',
      features: [
        lineFeature('R01', [[112.92, 30.96], [113.6, 30.7], [114.28, 30.54], [115.0, 30.5], [115.84, 30.48]]),
        lineFeature('R02', [[113.08, 30.16], [113.72, 30.36], [114.28, 30.54]]),
        lineFeature('R03', [[114.18, 29.46], [114.56, 29.88], [115.12, 30.24]]),
      ],
    };

    return normalizeNetwork({
      subbasinsGeojson,
      riversGeojson,
      attrs,
      source: 'fallback',
    });
  }

  function basinAttr(id, name, areaKm2, population, agri, industry, urban, eco, qAvail) {
    return {
      id,
      name,
      areaKm2,
      population,
      demand: { agri, industry, urban, eco },
      supply: { qLocal: qAvail * 0.72, qAvail },
      healthWeight: { agri: 0.1, industry: -0.3, urban: 1.0, eco: 0.75 },
    };
  }

  function polygonFeature(id, name, coords) {
    return {
      type: 'Feature',
      properties: { id, name },
      geometry: { type: 'Polygon', coordinates: [[...coords, coords[0]]] },
    };
  }

  function lineFeature(id, coords) {
    return {
      type: 'Feature',
      properties: { id },
      geometry: { type: 'LineString', coordinates: coords },
    };
  }

  function getFeatureCentroid(feature) {
    const coords = flattenCoordinates(feature.geometry && feature.geometry.coordinates);
    if (!coords.length) return [114.3, 30.55];
    const sum = coords.reduce((acc, point) => [acc[0] + point[0], acc[1] + point[1]], [0, 0]);
    return [sum[0] / coords.length, sum[1] / coords.length];
  }

  function flattenCoordinates(coords) {
    if (!Array.isArray(coords)) return [];
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') return [coords];
    return coords.flatMap(flattenCoordinates);
  }

  function getNumericInput(id, fallback) {
    const element = document.getElementById(id);
    const value = element ? Number(element.value) : fallback;
    return Number.isFinite(value) ? value : fallback;
  }

  function getSelectValue(id, fallback) {
    const element = document.getElementById(id);
    return element && element.value ? element.value : fallback;
  }

  function getModelLabel(result) {
    if (!result || !result.meta) return '未知';
    if (result.meta.skipSolve && result.meta.modelLabel) return result.meta.modelLabel;
    if (result.meta.solver === 'ResearchNetworkModel') return '外部模型';
    if (result.meta.solver === 'fallback-network') return '前端兜底';
    return result.meta.solver || '未知';
  }

  function getSolverEngine(result) {
    return getSolverEngineFromRaw(result && result.raw) || (result && result.meta && result.meta.solverEngine) || '';
  }

  function getSolverEngineFromRaw(raw) {
    return raw && raw.solver && raw.solver.type ? raw.solver.type : '';
  }

  function hasLpSpikePending(result) {
    return Boolean(
      (result && result.meta && result.meta.lpSpikePending)
      || (result && result.raw && hasLpSpikePendingRaw(result.raw))
    );
  }

  function hasLpSpikePendingRaw(raw) {
    const solver = raw && raw.solver;
    return Boolean(solver && (solver.lpReady === false || solver.type === 'heuristic-routing-market'));
  }

  function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  }

  function numberOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function firstFiniteNumber(values, fallback) {
    for (const value of values || []) {
      const number = Number(value);
      if (Number.isFinite(number)) return number;
    }
    return fallback;
  }

  function clampValue(value, min, max) {
    return Math.min(max, Math.max(min, numberOr(value, min)));
  }

  function roundMetric(value) {
    return Math.round((numberOr(value, 0) + Number.EPSILON) * 1000000) / 1000000;
  }

  function safeShare(value, total) {
    return total > 0 ? value / total : 0;
  }

  function clamp01(value) {
    return Math.max(0, Math.min(1, numberOr(value, 0)));
  }

  function waterUseSectorMap(map = {}) {
    return Object.fromEntries(WATER_USE_SECTORS.map((sector) => [sector, numberOr(map && map[sector], 0)]));
  }

  function sumBy(items, key) {
    return items.reduce((sum, item) => sum + numberOr(item[key], 0), 0);
  }

  function sumSectorMap(map) {
    if (!map || typeof map !== 'object') return 0;
    return WATER_USE_SECTORS.reduce((sum, sector) => sum + numberOr(map[sector], 0), 0);
  }

  function weightedMean(items, key, weightKey) {
    const totalWeight = items.reduce((sum, item) => sum + Math.max(0, numberOr(item[weightKey], 0)), 0);
    if (!totalWeight) return items.length ? sumBy(items, key) / items.length : 0;
    return items.reduce((sum, item) => sum + numberOr(item[key], 0) * Math.max(0, numberOr(item[weightKey], 0)), 0) / totalWeight;
  }

  window.ResearchApp = {
    getState: () => ({
      ...state,
      regionSelectedIds: Array.isArray(state.regionSelectedIds) ? [...state.regionSelectedIds] : null,
    }),
    runAndRender,
    render: renderAll,
    setRegion: setRegionSelection,
    setRegionSelection,
    setSelectedIds: (selectedIds) => setRegionSelection({ selectedIds }),
    clearRegion: clearRegionSelection,
  };
})();
