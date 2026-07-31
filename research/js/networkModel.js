// networkModel.js
// Research MVP for spatially explicit water-rights allocation on a hydrologic DAG.
// No external dependencies. Exports CommonJS in Node and window.ResearchNetworkModel in browsers.

(function attachResearchNetworkModel(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ResearchNetworkModel = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this, function createApi() {
  "use strict";

  const EPS = 1e-9;
  const SECTORS = ["urban", "agri", "industry"];

  const DEFAULT_HEALTH_WEIGHT = {
    urban: 1.0,
    eco: 0.7,
    agri: 0.1,
    industry: -0.25,
  };

  const DEFAULT_SECTOR_VALUE = {
    urban: 3.2,
    eco: 2.4,
    industry: 1.45,
    agri: 1.15,
  };

  const DEFAULT_COMPLIANCE_COST = {
    urban: 0.28,
    eco: 0.08,
    agri: 0.18,
    industry: 0.52,
  };

  const HEALTH_LOSS_COEFF = {
    industry: 0.52,
  };

  const INDUSTRY_DEMAND_FLOOR_FRACTION = 0.40;

  // 生活用水健康底线未达标的惩罚（元/m³）。这是「保障性供水失败」的社会成本，
  // 是政策性罚则而非边际价值。取值比最高部门用水价值（生活 3.2 元/m³）高约一个
  // 数量级，既能让底线真正约束住配置，又不会像原来的 big-M(1e6) 那样把影子价格
  // 污染到无法解释。见 docs/economics-audit.md F2。
  const HEALTH_FLOOR_SHORTFALL_PENALTY = 100;

  const CLIMATE_AVAILABILITY = {
    baseline: 1.0,
    current: 1.0,
    normal: 1.0,
    // UI 的「历史校准」选项值；显式列出，避免只靠未命中时的兜底返回 1
    historical: 1.0,
    wet: 1.08,
    dry: 0.82,
    drought: 0.72,
    severe: 0.58,
    ssp245: 0.86,
    ssp585: 0.70,
  };

  const TRADING_COST = {
    none: 0,
    low: 0.02,
    medium: 0.06,
    med: 0.06,
    high: 0.12,
    prohibitive: 0.25,
  };

  // 干流取水许可量（m3/yr）。中国水资源核算中「过境客水」不计入水资源总量，
  // 长江/汉江干流过境水只能凭取水许可按量取用，不是可自由配置的供给。
  // 默认 40 亿 m³/yr ≈ 过境水量的 1.2%，与武汉市 2024 年全市总用水量
  // 46.16 亿 m³ 同一量级（武汉市水务局《节约用水发展"十五五"规划》征求意见稿）。
  // 都市圈其余 8 市更依赖本地产流与支流，故区域干流取水许可取此量级。
  // 在该值下，正常年（SSP2-4.5）全域农业缺口 4.2%、水影子价格 0.161 元/m³，
  // 与湖北地表水水资源税率量级相符；SSP5-8.5 下农业缺口升至 19.0%。
  // 详见 docs/economics-audit.md F1 与 docs/parameter-dossier.md。
  const MAINSTEM_ABSTRACTION_QUOTA_DEFAULT = 4.0e9;

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function finiteNumber(value, fallback) {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function nonNegative(value, fallback) {
    return Math.max(0, finiteNumber(value, fallback));
  }

  function round(value, digits) {
    const factor = Math.pow(10, digits || 6);
    return Math.round((value + Number.EPSILON) * factor) / factor;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function firstNumber(values, fallback) {
    for (const value of values) {
      const n = finiteNumber(value, NaN);
      if (Number.isFinite(n)) return n;
    }
    return fallback;
  }

  function optionalNumber(value) {
    const n = finiteNumber(value, NaN);
    return Number.isFinite(n) ? n : null;
  }

  function roundOptional(value, digits) {
    const n = optionalNumber(value);
    return n === null ? null : round(n, digits || 6);
  }

  function cleanId(value, fieldName) {
    if (value === undefined || value === null || value === "") {
      throw new Error("Missing required subbasin " + fieldName);
    }
    return String(value);
  }

  function cleanOptionalId(value) {
    if (value === undefined || value === null || value === "") return null;
    return String(value);
  }

  function readDemand(raw) {
    const demand = isObject(raw.demand) ? raw.demand : raw;
    return {
      agri: nonNegative(firstNumber([
        demand.agri,
        demand.agriculture,
        demand.farm,
        raw.W_agri,
        raw.agriDemand,
      ], 0), 0),
      industry: nonNegative(firstNumber([
        demand.industry,
        demand.industrial,
        demand.ind,
        raw.W_ind,
        raw.industryDemand,
      ], 0), 0),
      urban: nonNegative(firstNumber([
        demand.urban,
        demand.domestic,
        demand.municipal,
        demand.living,
        demand.residential,
        raw.W_urban,
        raw.urbanDemand,
      ], 0), 0),
      eco: nonNegative(firstNumber([
        demand.eco,
        demand.ecology,
        demand.ecological,
        demand.environment,
        raw.W_eco,
        raw.ecoDemand,
      ], 0), 0),
    };
  }

  function readSectorMap(raw, fieldNames, defaults) {
    let source = {};
    for (const fieldName of fieldNames) {
      if (isObject(raw[fieldName])) {
        source = raw[fieldName];
        break;
      }
    }
    return {
      urban: finiteNumber(firstNumber([source.urban, source.domestic, source.municipal], defaults.urban), defaults.urban),
      eco: finiteNumber(firstNumber([source.eco, source.ecology, source.ecological, source.environment], defaults.eco), defaults.eco),
      agri: finiteNumber(firstNumber([source.agri, source.agriculture, source.farm], defaults.agri), defaults.agri),
      industry: finiteNumber(firstNumber([source.industry, source.industrial, source.ind], defaults.industry), defaults.industry),
    };
  }

  function readSupply(raw) {
    const supply = isObject(raw.supply) ? raw.supply : {};
    const qLocal = firstNumber([
      supply.qLocal,
      supply.local,
      supply.localSupply,
      raw.qLocal,
      raw.localSupply,
      typeof raw.supply === "number" ? raw.supply : undefined,
      supply.qAvail,
      raw.qAvail,
    ], 0);
    const externalInflow = firstNumber([
      supply.externalInflow,
      supply.transitInjection,
      supply.inflow,
      supply.mainstemInflow,
      raw.externalInflow,
      raw.transitInjection,
      raw.mainstemInflow,
      raw.qTransit,
      supply.qTransit,
      raw.qExternal,
    ], 0);
    const runoffCoeff = optionalNumber(firstNumber([
      supply.runoffCoeff,
      supply.runoffCoefficient,
      supply.runoff_coeff,
      raw.runoffCoeff,
      raw.runoffCoefficient,
      raw.runoff_coeff,
    ], NaN));
    return {
      qLocalBase: nonNegative(qLocal, 0),
      externalInflowBase: nonNegative(externalInflow, 0),
      runoffCoeff,
    };
  }

  function buildSupplySnapshot(node, values) {
    const qLocal = nonNegative(values && values.qLocal, 0);
    const qAvail = nonNegative(values && values.qAvail, qLocal);
    const qLocalRaw = nonNegative(
      values && values.qLocalRaw,
      Math.max(0, qLocal - nonNegative(values && values.externalInflow, 0))
    );
    const externalInflow = nonNegative(values && values.externalInflow, 0);
    const runoffCoeff = roundOptional(
      values && Object.prototype.hasOwnProperty.call(values, "runoffCoeff")
        ? values.runoffCoeff
        : node && node.runoffCoeff,
      6
    );
    const snapshot = {
      qLocal: round(qLocal, 6),
      qLocalRaw: round(qLocalRaw, 6),
      localRunoff: round(qLocalRaw, 6),
      qAvail: round(qAvail, 6),
      externalInflow: round(externalInflow, 6),
      mainstemInflow: round(externalInflow, 6),
    };
    if (runoffCoeff !== null) snapshot.runoffCoeff = runoffCoeff;
    return snapshot;
  }

  function normalizeInputs(rawInput) {
    if (!rawInput) {
      throw new Error("normalizeInputs requires a network object");
    }
    if (rawInput.normalized === true && Array.isArray(rawInput.nodes) && rawInput.nodeById instanceof Map) {
      return rawInput;
    }

    const rawNodes = rawInput.subbasins || rawInput.nodes || rawInput.basins;
    if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
      throw new Error("Network input must include a non-empty subbasins or nodes array");
    }

    const topology = isObject(rawInput.topology) ? rawInput.topology : {};
    const seen = new Set();
    const nodes = rawNodes.map((rawNode, index) => {
      const id = cleanId(rawNode.id || rawNode.subbasinId || rawNode.code || rawNode.name, "id");
      if (seen.has(id)) {
        throw new Error("Duplicate subbasin id: " + id);
      }
      seen.add(id);

      const supply = readSupply(rawNode);
      const downstream = cleanOptionalId(
        Object.prototype.hasOwnProperty.call(topology, id)
          ? topology[id]
          : rawNode.downstream || rawNode.downstreamId || rawNode.drainsTo
      );

      return {
        id,
        name: rawNode.name || id,
        index,
        areaKm2: nonNegative(rawNode.areaKm2 || rawNode.area_km2 || rawNode.area, 0),
        population: nonNegative(rawNode.population || rawNode.pop, 0),
        demand: readDemand(rawNode),
        healthWeight: readSectorMap(rawNode, ["healthWeight", "healthWeights"], DEFAULT_HEALTH_WEIGHT),
        sectorValue: readSectorMap(rawNode, ["sectorValue", "sectorValues", "benefit"], DEFAULT_SECTOR_VALUE),
        complianceCost: readSectorMap(rawNode, ["complianceCost", "complianceCosts"], DEFAULT_COMPLIANCE_COST),
        qLocalBase: supply.qLocalBase,
        externalInflowBase: supply.externalInflowBase,
        runoffCoeff: supply.runoffCoeff,
        supply: buildSupplySnapshot(null, {
          qLocal: supply.qLocalBase,
          qLocalRaw: supply.qLocalBase,
          qAvail: supply.qLocalBase + supply.externalInflowBase,
          externalInflow: supply.externalInflowBase,
          runoffCoeff: supply.runoffCoeff,
        }),
        downstream,
        downstreamInternal: null,
        externalDownstream: null,
        raw: rawNode,
      };
    });

    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const edges = [];
    const externalOutlets = new Map();
    const normalizedTopology = {};

    for (const node of nodes) {
      normalizedTopology[node.id] = node.downstream;
      if (!node.downstream) continue;
      if (nodeById.has(node.downstream)) {
        node.downstreamInternal = node.downstream;
        edges.push({ from: node.id, to: node.downstream });
      } else {
        node.externalDownstream = node.downstream;
        externalOutlets.set(node.id, node.downstream);
      }
    }

    return {
      normalized: true,
      meta: rawInput.meta || {},
      nodes,
      nodeById,
      edges,
      topology: normalizedTopology,
      externalOutlets,
    };
  }

  async function loadInputs(source, options) {
    if (typeof source !== "string") {
      return normalizeInputs(source);
    }

    const opts = options || {};
    const isHttp = /^https?:\/\//i.test(source);
    const canUseFs = typeof require === "function" && (opts.preferFs || (typeof window === "undefined" && !isHttp));

    if (canUseFs) {
      const fs = require("fs");
      const text = fs.readFileSync(source, "utf8");
      return normalizeInputs(JSON.parse(text));
    }

    if (typeof fetch !== "function") {
      throw new Error("fetch is unavailable; pass an object or run loadInputs in Node with a file path");
    }
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error("Failed to load network inputs: " + response.status + " " + response.statusText);
    }
    return normalizeInputs(await response.json());
  }

  function topologicalSort(input) {
    const network = normalizeInputs(input);
    const indegree = new Map(network.nodes.map((node) => [node.id, 0]));
    const adjacency = new Map(network.nodes.map((node) => [node.id, []]));

    for (const edge of network.edges) {
      adjacency.get(edge.from).push(edge.to);
      indegree.set(edge.to, indegree.get(edge.to) + 1);
    }

    const queue = network.nodes
      .filter((node) => indegree.get(node.id) === 0)
      .sort((a, b) => a.index - b.index)
      .map((node) => node.id);
    const order = [];

    while (queue.length) {
      const id = queue.shift();
      order.push(id);
      for (const downstreamId of adjacency.get(id)) {
        const next = indegree.get(downstreamId) - 1;
        indegree.set(downstreamId, next);
        if (next === 0) {
          queue.push(downstreamId);
        }
      }
    }

    if (order.length !== network.nodes.length) {
      const cyclicIds = network.nodes
        .filter((node) => indegree.get(node.id) > 0)
        .map((node) => node.id);
      throw new Error("Cycle detected in hydrological topology: " + cyclicIds.join(", "));
    }

    return order;
  }

  function computeDownstreamReach(input, options) {
    const network = normalizeInputs(input);
    const includeExternalOutlets = !options || options.includeExternalOutlets !== false;
    const order = topologicalSort(network).slice().reverse();
    const reach = {};

    for (const id of order) {
      const node = network.nodeById.get(id);
      const ids = [];
      const seen = new Set();

      function add(reachId) {
        if (reachId && !seen.has(reachId)) {
          seen.add(reachId);
          ids.push(reachId);
        }
      }

      if (node.downstreamInternal) {
        add(node.downstreamInternal);
        for (const downstreamId of reach[node.downstreamInternal] || []) {
          add(downstreamId);
        }
      } else if (includeExternalOutlets && node.externalDownstream) {
        add(node.externalDownstream);
      }

      reach[id] = ids;
    }

    return reach;
  }

  function resolveNetworkFromParams(params) {
    if (!params) return null;
    if (params.normalized === true || params.subbasins || params.nodes || params.basins) return params;
    return params.network || params.data || params.inputs || null;
  }

  function getTau(params) {
    return Math.max(0, finiteNumber(params && (params.tau ?? params.healthTaxRate ?? params.healthTax), 0));
  }

  function getDemandElasticity(params) {
    return Math.max(0, finiteNumber(params && (
      params.demandElasticity ??
      params.industrialDemandElasticity ??
      params.elasticity
    ), 0.9));
  }

  function getClimateAvailability(params) {
    if (!params) return 1;
    const raw = params.climate ?? params.climateScenario ?? params.waterAvailability ?? params.climateMultiplier;
    if (typeof raw === "number") return Math.max(0, raw);
    if (isObject(raw)) {
      return Math.max(0, finiteNumber(raw.waterAvailability ?? raw.availability ?? raw.multiplier, 1));
    }
    if (typeof raw === "string") {
      const key = raw.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(CLIMATE_AVAILABILITY, key)) {
        return CLIMATE_AVAILABILITY[key];
      }
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return Math.max(0, parsed);
    }
    return 1;
  }

  function getExternalInflowClimateMultiplier(params) {
    if (params && params.externalInflowClimateSensitive === false) return 1;
    const availability = getClimateAvailability(params || {});
    return Math.max(0, 1 - 0.6 * (1 - availability));
  }

  // 干流取水许可量。返回 Infinity 表示不设限（旧口径，把整条长江当作可配置供给）。
  function getMainstemAbstractionQuota(params) {
    const raw = params && (
      params.mainstemAbstractionQuota ??
      params.mainstemQuota ??
      params.transitAbstractionQuota
    );
    if (raw === "unlimited" || raw === Infinity) return Infinity;
    if (raw === undefined || raw === null || raw === "") {
      return MAINSTEM_ABSTRACTION_QUOTA_DEFAULT;
    }
    const n = finiteNumber(raw, MAINSTEM_ABSTRACTION_QUOTA_DEFAULT);
    return Math.max(0, n);
  }

  function getClimateStress(params) {
    const availability = getClimateAvailability(params);
    return 1 + Math.max(0, 1 - availability) * 0.75;
  }

  function getTradingCost(params) {
    if (!params) return TRADING_COST.medium;
    const raw = params.tradingCost ?? params.tradeCost ?? params.transportCost;
    if (typeof raw === "number") return Math.max(0, raw);
    if (isObject(raw)) {
      return Math.max(0, finiteNumber(raw.unitCost ?? raw.cost ?? raw.perM3, TRADING_COST.medium));
    }
    if (typeof raw === "string") {
      const key = raw.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(TRADING_COST, key)) return TRADING_COST[key];
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return Math.max(0, parsed);
    }
    return TRADING_COST.medium;
  }

  function getHealthFloor(params) {
    return clamp(finiteNumber(params && (params.healthFloor ?? params.floor), 0.25), 0, 0.95);
  }

  function getEcoFloor(params) {
    return clamp(finiteNumber(params && (params.ecoFloor ?? params.environmentalFlowFloor ?? params.envFlowFloor), 0.15), 0, 0.95);
  }

  function getRiverRetentionValue(params) {
    const explicit = params && (
      params.riverRetentionValue ??
      params.environmentalRetentionValue ??
      params.inStreamFlowValue ??
      params.noWithdrawalThreshold
    );
    if (explicit !== undefined && explicit !== null && explicit !== "") {
      return Math.max(0, finiteNumber(explicit, 0));
    }
    const scale = Math.max(0, finiteNumber(params && (
      params.riverRetentionValueScale ??
      params.environmentalRetentionValueScale ??
      params.inStreamFlowValueScale
    ), 5.4));
    const availability = getClimateAvailability(params || {});
    const stressMultiplier = clamp((0.86 - availability) / 0.16, 0, 1);
    return getTau(params || {}) * scale * stressMultiplier;
  }

  function getLegacyEcoDemand(node) {
    return nonNegative(node && node.demand && node.demand.eco, 0);
  }

  function getHealthLossCoeff(node, sector) {
    if (Object.prototype.hasOwnProperty.call(HEALTH_LOSS_COEFF, sector)) {
      return nonNegative(HEALTH_LOSS_COEFF[sector], 0);
    }
    const healthWeight = node && node.healthWeight
      ? node.healthWeight[sector] ?? DEFAULT_HEALTH_WEIGHT[sector] ?? 0
      : DEFAULT_HEALTH_WEIGHT[sector] ?? 0;
    return Math.max(0, -finiteNumber(healthWeight, 0));
  }

  function computeEffectiveDemandCap(node, sector, params) {
    const demand = nonNegative(node && node.demand && node.demand[sector], 0);
    if (sector !== "industry") return demand;
    const eps = getDemandElasticity(params || {});
    const tau = getTau(params || {});
    const loss = getHealthLossCoeff(node, sector);
    const factor = Math.max(INDUSTRY_DEMAND_FLOOR_FRACTION, 1 - eps * tau * loss);
    return demand * factor;
  }

  function computeEffectiveDemandCaps(node, params) {
    return SECTORS.reduce((acc, sector) => {
      acc[sector] = computeEffectiveDemandCap(node, sector, params || {});
      return acc;
    }, {});
  }

  function computeRawUnmet(node, allocation) {
    return SECTORS.reduce((acc, sector) => {
      acc[sector] = Math.max(0, nonNegative(node && node.demand && node.demand[sector], 0) - nonNegative(allocation && allocation[sector], 0));
      return acc;
    }, {});
  }

  function computeEcoBaseFlowDetail(naturalFlow, legacyEcoDemand, ecoFloor) {
    const natural = nonNegative(naturalFlow, 0);
    const floor = clamp(finiteNumber(ecoFloor, 0.15), 0, 0.95);
    const legacy = nonNegative(legacyEcoDemand, 0);
    const proportionalFloor = floor * natural;
    const uncapped = Math.max(proportionalFloor, legacy);
    const cap = 0.95 * natural;
    const ecoBaseFlow = Math.min(uncapped, cap);
    return {
      ecoFloor: floor,
      naturalFlow: natural,
      legacyEcoDemand: legacy,
      proportionalEcoFloor: proportionalFloor,
      ecoBaseFlow,
      ecoBaseFlowCapped: uncapped > cap + EPS,
    };
  }

  function computeNodeEcoBaseFlowDetail(node, naturalFlow, params) {
    return computeEcoBaseFlowDetail(naturalFlow, getLegacyEcoDemand(node), getEcoFloor(params || {}));
  }

  // ==========================================================================
  // 健康产出：剂量—反应链
  //
  // 政策旋钮（τ、healthFloor）**不得**出现在本节任何公式里。它们只能通过改变
  // 配水结果间接影响健康：
  //
  //   τ ↑ → 工业取水 ↓ → 废水负荷 ↓ / 河道流量 ↑ → 浓度 ↓ → PAF ↓ → DALY ↓
  //
  // 旧实现 `avoidedPer100k = 9 + 28·climateStress + 11·healthFloor + 18·τSignal`
  // 把 τ 直接写进健康收益，属循环论证；且城市供水覆盖率恒为 1，公式实际塌缩为
  // 「人口 × 政策旋钮多项式」，与配水完全无关。详见 docs/economics-audit.md F3/F4。
  //
  // 两条暴露通路，都只以配水结果为自变量：
  //   A 生活供水缺口 —— 供水不足导致的 WaSH 服务退化
  //   B 河道稀释能力 —— 工业废水负荷相对受纳水体流量的浓度，污染沿河道累积，
  //     上游排污由下游人口承担，这正是庇古税要内部化的外部性
  // ==========================================================================

  // 全球「不安全 WaSH」年 DALY 率（GBD 2019；JOGH 2024;14:04162）。
  // 用作「生活供水完全失效」时的满暴露上限。⚠️ B1 待校准。
  const WASH_DALY_RATE_PER_100K = 1244.29;

  // 东亚「不安全 WaSH」年 DALY 率（同源，95% UI 65.07–123.33）。
  // 用作水质通路的区域现况基准率。⚠️ B1 待校准。
  const WATERBORNE_DALY_RATE_PER_100K = 92.42;

  // 工业废水排放量 / 工业取水量。2022 年全国：146.7 亿 t / 968.4 亿 m³ = 0.151。
  const INDUSTRY_DISCHARGE_COEFF = 0.151;

  // 临界负荷比：废水体积占受纳水体流量的比例上限。
  // 由两项国标推出——受纳水体要达 GB 3838-2002 III 类（COD ≤ 20 mg/L），
  // 工业废水按 GB 8978-1996 一级标准排放（COD ≤ 100 mg/L），本底按 15 mg/L：
  //   (100E + 15F)/(E+F) = 20  →  E/F = 0.0625
  const CRITICAL_LOAD_RATIO = 0.0625;

  // 暴露—反应斜率。⚠️ 纯占位值，B1 必须以 GBD 分病种 RR 替换。
  const BETA_SERVICE_GAP = 2.0;
  const BETA_DILUTION = 1.0;

  // 废水沿拓扑向下游累积：上游排污由下游人口承担。order 为拓扑序，
  // 因此每个节点被处理时其上游贡献已经就位。
  function makeEffluentRouter() {
    const upstream = {};
    return {
      take(nodeId) {
        return upstream[nodeId] || 0;
      },
      push(node, cumulativeEffluent) {
        const downstreamId = node && node.downstream;
        if (!downstreamId || downstreamId === "OUTLET") return;
        upstream[downstreamId] = (upstream[downstreamId] || 0) + nonNegative(cumulativeEffluent, 0);
      },
    };
  }

  // 相对危险度 → 人群归因分值
  function riskToPaf(relativeRisk) {
    const rr = Math.max(1, finiteNumber(relativeRisk, 1));
    return (rr - 1) / rr;
  }

  // 通路 A：生活供水缺口
  function computeServiceGap(node, allocation) {
    const urbanDemand = nonNegative(node && node.demand && node.demand.urban, 0);
    if (urbanDemand <= EPS) return 0;
    const served = nonNegative(allocation && allocation.urban, 0);
    return clamp(1 - served / urbanDemand, 0, 1);
  }

  // 通路 B：累积废水负荷相对河道流量的浓度指数。
  // cumulativeEffluent 已含上游累积量，因此下游节点承担上游排污——不重复计人。
  function computeLoadRatio(cumulativeEffluent, inStreamFlow) {
    const flow = nonNegative(inStreamFlow, 0);
    if (flow <= EPS) return nonNegative(cumulativeEffluent, 0) > EPS ? Infinity : 0;
    return nonNegative(cumulativeEffluent, 0) / flow;
  }

  function computeNodeHealthBurdenDetail(node, allocation, context) {
    const population = Math.max(0, (node && node.population) || 0);
    const exposure = population / 100000;

    const serviceGap = computeServiceGap(node, allocation);
    const serviceRisk = 1 + BETA_SERVICE_GAP * serviceGap;
    const servicePaf = riskToPaf(serviceRisk);
    const serviceBurden = exposure * WASH_DALY_RATE_PER_100K * servicePaf;

    const localEffluent = INDUSTRY_DISCHARGE_COEFF * nonNegative(allocation && allocation.industry, 0);
    const cumulativeEffluent = nonNegative(context && context.upstreamEffluent, 0) + localEffluent;
    const loadRatio = computeLoadRatio(cumulativeEffluent, context && context.inStreamFlow);
    const excessLoad = Number.isFinite(loadRatio)
      ? Math.max(0, loadRatio / CRITICAL_LOAD_RATIO - 1)
      : 1e6;
    const dilutionRisk = 1 + BETA_DILUTION * excessLoad;
    const dilutionPaf = riskToPaf(dilutionRisk);
    const dilutionBurden = exposure * WATERBORNE_DALY_RATE_PER_100K * dilutionPaf;

    return {
      serviceGap: round(serviceGap, 6),
      servicePaf: round(servicePaf, 6),
      serviceBurden: round(serviceBurden, 6),
      localEffluent: round(localEffluent, 6),
      cumulativeEffluent: round(cumulativeEffluent, 6),
      loadRatio: Number.isFinite(loadRatio) ? round(loadRatio, 6) : null,
      excessLoad: Number.isFinite(loadRatio) ? round(excessLoad, 6) : null,
      dilutionPaf: round(dilutionPaf, 6),
      dilutionBurden: round(dilutionBurden, 6),
      dalyBurden: round(serviceBurden + dilutionBurden, 6),
    };
  }

  // context: { inStreamFlow, upstreamEffluent }
  // 「避免的 DALY」不在此计算——它需要一个反事实解（τ=0）才有意义，
  // 由比较层用 burden(反事实) − burden(当前) 得到。见 main.js buildNoTaxComparison。
  function healthOutcomeFields(node, allocation, context) {
    const detail = computeNodeHealthBurdenDetail(node, allocation, context || {});
    return {
      dalyBurden: detail.dalyBurden,
      health: detail,
    };
  }

  function addHealthOutcomesToTotals(acc, node) {
    acc.dalyBurden += node.dalyBurden || 0;
    acc.serviceBurden += (node.health && node.health.serviceBurden) || 0;
    acc.dilutionBurden += (node.health && node.health.dilutionBurden) || 0;
    acc.industrialEffluent += (node.health && node.health.localEffluent) || 0;
  }

  function roundHealthOutcomeTotals(totals) {
    totals.dalyBurden = round(totals.dalyBurden, 6);
    totals.serviceBurden = round(totals.serviceBurden, 6);
    totals.dilutionBurden = round(totals.dilutionBurden, 6);
    totals.industrialEffluent = round(totals.industrialEffluent, 6);
  }

  function aggregateSummary(totals) {
    return {
      dalyBurden: totals.dalyBurden,
      serviceBurden: totals.serviceBurden,
      dilutionBurden: totals.dilutionBurden,
      industrialEffluent: totals.industrialEffluent,
      environmentalFlow: totals.environmentalFlow,
    };
  }

  function ecoFlowResultFields(detail, inStreamFlow) {
    const flow = nonNegative(inStreamFlow, 0);
    const surplus = Math.max(0, flow - detail.ecoBaseFlow);
    return {
      ecoFloor: round(detail.ecoFloor, 6),
      naturalFlow: round(detail.naturalFlow, 6),
      legacyEcoDemand: round(detail.legacyEcoDemand, 6),
      ecoBaseFlow: round(detail.ecoBaseFlow, 6),
      ecoBaseFlowCapped: Boolean(detail.ecoBaseFlowCapped),
      inStreamFlow: round(flow, 6),
      ecoSurplus: round(surplus, 6),
      environmentalFlow: round(detail.ecoBaseFlow + surplus, 6),
    };
  }

  function buildWaterBalanceSnapshot(values) {
    const naturalFlow = nonNegative(values && values.naturalFlow, 0);
    const withdrawn = nonNegative(values && values.withdrawn, 0);
    const inStreamFlow = nonNegative(values && values.inStreamFlow, 0);
    const ecoBaseFlow = nonNegative(values && values.ecoBaseFlow, 0);
    const residual = naturalFlow - withdrawn - inStreamFlow;
    return {
      localSupply: round(nonNegative(values && values.localSupply, 0), 6),
      upstreamInflow: round(nonNegative(values && values.upstreamInflow, 0), 6),
      naturalFlow: round(naturalFlow, 6),
      withdrawn: round(withdrawn, 6),
      inStreamFlow: round(inStreamFlow, 6),
      ecoBaseFlow: round(ecoBaseFlow, 6),
      ecoSurplus: round(Math.max(0, inStreamFlow - ecoBaseFlow), 6),
      environmentalFlow: round(ecoBaseFlow + Math.max(0, inStreamFlow - ecoBaseFlow), 6),
      residual: Math.abs(residual) <= 1e-4 ? 0 : round(residual, 6),
    };
  }

  function sumDemand(node) {
    return SECTORS.reduce((sum, sector) => sum + node.demand[sector], 0);
  }

  function sectorMap(initialValue) {
    return {
      urban: initialValue || 0,
      agri: initialValue || 0,
      industry: initialValue || 0,
    };
  }

  function roundSectorMap(values) {
    return SECTORS.reduce((acc, sector) => {
      acc[sector] = round(values && values[sector], 6);
      return acc;
    }, {});
  }

  function computeMarketPrice(network, qSupplyByNode, params) {
    const totalDemand = network.nodes.reduce((sum, node) => sum + sumDemand(node), 0);
    const totalSupply = Object.keys(qSupplyByNode).reduce((sum, id) => sum + qSupplyByNode[id], 0);
    const scarcity = totalDemand > EPS ? Math.max(0, totalDemand - totalSupply) / totalDemand : 0;
    const tauPremium = getTau(params) * 0.04;
    const frictionPremium = getTradingCost(params) * 0.5;
    return round(0.35 + scarcity * 0.9 + tauPremium + frictionPremium, 6);
  }

  function computeHealthTaxDetail(subject, params, explicitNetwork) {
    const rawNetwork = explicitNetwork || resolveNetworkFromParams(params);
    if (!rawNetwork) {
      throw new Error("computeHealthTax requires params.network or an explicit network");
    }
    const network = normalizeInputs(rawNetwork);
    const nodeId = typeof subject === "string" ? subject : cleanId(subject.id || subject.subbasinId, "id");
    const node = network.nodeById.get(nodeId);
    if (!node) {
      throw new Error("Unknown subbasin for health tax: " + nodeId);
    }

    const sector = (typeof subject === "object" && subject.sector) || (params && params.sector) || "industry";
    const lossCoeff = getHealthLossCoeff(node, sector);
    const reach = computeDownstreamReach(network, { includeExternalOutlets: false })[nodeId] || [];
    const affectedSubbasins = reach.filter((id) => network.nodeById.has(id));
    const attenuation = finiteNumber(params && params.downstreamAttenuation, 0.35);
    const weightedPopulation = affectedSubbasins.reduce((sum, downstreamId, index) => {
      const downstream = network.nodeById.get(downstreamId);
      const distanceWeight = 1 / Math.pow(index + 1, attenuation);
      return sum + downstream.population * distanceWeight;
    }, 0);

    const tau = getTau(params || {});
    const climateStress = getClimateStress(params || {});
    const scale = finiteNumber(params && params.healthTaxScale, 0.02);
    const taxPerM3 = round(tau * lossCoeff * climateStress * (weightedPopulation / 100000) * scale, 6);

    return {
      nodeId,
      sector,
      taxPerM3,
      tau,
      lossCoeff,
      downstreamPopulation: round(weightedPopulation, 6),
      affectedSubbasins,
      climateStress: round(climateStress, 6),
    };
  }

  function computeHealthTax(subject, params, explicitNetwork) {
    return computeHealthTaxDetail(subject, params || {}, explicitNetwork).taxPerM3;
  }

  function computeSectorNetValue(node, sector, params, sectorTax) {
    const tau = getTau(params || {});
    const healthWeight = node.healthWeight[sector] || 0;
    const sectorValue = node.sectorValue[sector] || 0;
    const compliancePenalty = (node.complianceCost[sector] || 0) * 0.01;
    if (sector === "industry") {
      return sectorValue - compliancePenalty;
    }
    const penaltyScale = Math.max(1, finiteNumber(params && params.healthPenaltyScale, 12));
    const negativeHealthAmplifier = Math.max(0, -healthWeight) * tau * (penaltyScale - 1);
    return (
      sectorValue +
      tau * healthWeight -
      negativeHealthAmplifier -
      nonNegative(sectorTax, 0) -
      compliancePenalty
    );
  }

  function getEffectiveRiverRetentionValue(network, params) {
    const rawValue = getRiverRetentionValue(params || {});
    if (rawValue <= EPS) return 0;
    const nodes = network && Array.isArray(network.nodes) ? network.nodes : [];
    const industryScores = nodes
      .map((node) => computeSectorNetValue(node, "industry", params || {}, 0))
      .filter((score) => Number.isFinite(score) && score > EPS);
    if (!industryScores.length) return rawValue;
    const ceiling = Math.max(0, Math.min(...industryScores) - 1e-6);
    return Math.min(rawValue, ceiling);
  }

  function getRiverRetentionObjectiveValue(network, params) {
    const value = getEffectiveRiverRetentionValue(network, params || {});
    if (value <= EPS || !network || !Array.isArray(network.nodes)) return value;
    const reach = computeDownstreamReach(network, { includeExternalOutlets: false });
    const maxCountedOutflows = network.nodes.reduce((max, node) => {
      return Math.max(max, 1 + ((reach[node.id] || []).length));
    }, 1);
    return value / Math.max(maxCountedOutflows, 1);
  }

  function buildLpProblemInterface(network, params) {
    const normalized = normalizeInputs(network);
    const order = topologicalSort(normalized);
    const reach = computeDownstreamReach(normalized, { includeExternalOutlets: false });
    const size = estimateProblemSize(normalized, params);

    return {
      kind: "research-network-lp-interface",
      note: "Diagnostic LP interface mirror; production GLPK solve uses buildGlpkProblem() and solveWithGlpkInstance().",
      params: {
        tau: getTau(params || {}),
        climateAvailability: getClimateAvailability(params || {}),
        healthFloor: getHealthFloor(params || {}),
        ecoFloor: getEcoFloor(params || {}),
        riverRetentionValue: getEffectiveRiverRetentionValue(normalized, params || {}),
        rawRiverRetentionValue: getRiverRetentionValue(params || {}),
        riverRetentionObjectiveValue: getRiverRetentionObjectiveValue(normalized, params || {}),
        tradingCost: getTradingCost(params || {}),
        demandElasticity: getDemandElasticity(params || {}),
      },
      order,
      size,
      variables: {
        allocation: normalized.nodes.flatMap((node) => SECTORS.map((sector) => "x_" + node.id + "_" + sector)),
        outflow: normalized.nodes.map((node) => "out_" + node.id),
        trade: normalized.nodes.flatMap((origin) => (reach[origin.id] || []).map((targetId) => "t_" + origin.id + "_" + targetId)),
      },
      constraints: {
        demandCaps: "0 <= x_i_s <= effectiveD_i_s; industry effectiveD = D * max(0.40, 1 - elasticity * tau * healthLoss)",
        routingBalance: "Q_i = qLocal_i + qExternal_i + upstreamOutflow_i - sum_s x_i_s; out_i >= ecoBaseFlow_i; out_i earns riverRetentionValue in the objective",
        ecoBaseFlow: "ecoBaseFlow_i = max(ecoFloor * localRunoff_i, legacy demand.eco_i), capped at 0.95 * localRunoff_i",
        healthFloor: "urban allocation should meet the health floor subject to withdrawable availability",
        tradeDirection: "t_ij is allowed only when j is downstream-reachable from i",
      },
    };
  }

  function estimateProblemSize(network, params) {
    const normalized = normalizeInputs(network);
    const order = topologicalSort(normalized);
    const reach = computeDownstreamReach(normalized, { includeExternalOutlets: false });
    const nodeCount = normalized.nodes.length;
    const allocation = nodeCount * SECTORS.length;
    const outflow = nodeCount;
    const trade = normalized.nodes.reduce((sum, node) => sum + (reach[node.id] || []).length, 0);
    const totalVariables = allocation + outflow + trade;
    const constraintCounts = {
      demandCaps: allocation,
      routingBalance: nodeCount,
      healthFloor: nodeCount,
      tradeDirection: trade,
      nonNegativity: totalVariables,
    };
    const totalConstraints = Object.keys(constraintCounts).reduce((sum, key) => sum + constraintCounts[key], 0);

    return {
      kind: "research-network-problem-size",
      nodeCount,
      edgeCount: normalized.edges.length,
      sectorCount: SECTORS.length,
      reachableOdPairCount: trade,
      orderLength: order.length,
      variableCounts: {
        allocation,
        outflow,
        trade,
        total: totalVariables,
      },
      constraintCounts,
      totalConstraints,
      params: {
        tau: getTau(params || {}),
        climateAvailability: getClimateAvailability(params || {}),
        healthFloor: getHealthFloor(params || {}),
        ecoFloor: getEcoFloor(params || {}),
        riverRetentionValue: getEffectiveRiverRetentionValue(normalized, params || {}),
        rawRiverRetentionValue: getRiverRetentionValue(params || {}),
        riverRetentionObjectiveValue: getRiverRetentionObjectiveValue(normalized, params || {}),
        tradingCost: getTradingCost(params || {}),
        demandElasticity: getDemandElasticity(params || {}),
      },
    };
  }

  function lpAllocationVar(nodeId, sector) {
    return "x_" + nodeId + "_" + sector;
  }

  function lpOutflowVar(nodeId) {
    return "out_" + nodeId;
  }

  function lpSlackVar(nodeId) {
    return "hf_short_" + nodeId;
  }

  function glpkBound(glpk, lb, ub) {
    if (Math.abs(lb - ub) <= EPS) {
      return { type: glpk.GLP_FX, lb, ub };
    }
    return { type: glpk.GLP_DB, lb, ub };
  }

  function glpkStatusName(glpk, status) {
    const names = [
      ["GLP_OPT", "optimal"],
      ["GLP_FEAS", "feasible"],
      ["GLP_INFEAS", "infeasible"],
      ["GLP_NOFEAS", "no-feasible-solution"],
      ["GLP_UNBND", "unbounded"],
      ["GLP_UNDEF", "undefined"],
    ];
    for (const [key, label] of names) {
      if (glpk && glpk[key] === status) return label;
    }
    return "status-" + status;
  }

  function isGlpkSolvedStatus(glpk, status) {
    return status === glpk.GLP_OPT || status === glpk.GLP_FEAS;
  }

  function buildUpstreamIndex(network) {
    const upstreams = new Map(network.nodes.map((node) => [node.id, []]));
    for (const edge of network.edges) {
      upstreams.get(edge.to).push(edge.from);
    }
    return upstreams;
  }

  function computeTransitInflowShares(network, params, options) {
    const normalized = normalizeInputs(network);
    const externalMultiplier = getExternalInflowClimateMultiplier(params || {});
    const downstreamReach = computeDownstreamReach(normalized, { includeExternalOutlets: false });
    const transitShareByNode = {};
    const injectionAllocations = [];
    const marketScope = options && options.scope === "regional";

    for (const node of normalized.nodes) {
      transitShareByNode[node.id] = 0;
    }

    const allNodeIds = normalized.nodes.map((node) => node.id);
    const demandWeight = (nodeId) => sumDemand(normalized.nodeById.get(nodeId));

    // 过境客水在物理上继续沿河道下泄（进入水量平衡与出流），但法律上只有取水许可
    // 范围内的部分可以被取用。因此这里保留完整的过境水路由，另外按同一比例算出
    // 每个节点「可取用」的那部分，交给 LP 的取水许可约束使用。
    const quota = getMainstemAbstractionQuota(params || {});
    const totalTransit = normalized.nodes.reduce((sum, node) => {
      return sum + Math.max(0, node.externalInflowBase * externalMultiplier);
    }, 0);
    const quotaScale = (!Number.isFinite(quota) || totalTransit <= quota)
      ? 1
      : (totalTransit <= EPS ? 0 : quota / totalTransit);
    const permittedShareByNode = {};
    for (const node of normalized.nodes) {
      permittedShareByNode[node.id] = 0;
    }

    for (const node of normalized.nodes) {
      const transitVolume = Math.max(
        0,
        node.externalInflowBase * externalMultiplier
      );
      if (transitVolume <= EPS) continue;

      let eligibleIds = allNodeIds.slice();
      let basis = "all-region-demand-market";
      if (!marketScope) {
        const seen = new Set();
        eligibleIds = [node.id, ...(downstreamReach[node.id] || [])]
          .filter((id) => normalized.nodeById.has(id) && !seen.has(id) && seen.add(id));
        basis = "entry-plus-downstream-demand";
      }
      let totalWeight = eligibleIds.reduce((sum, id) => sum + demandWeight(id), 0);

      if (totalWeight <= EPS) {
        eligibleIds = allNodeIds.slice();
        basis = "all-region-demand-fallback";
        totalWeight = eligibleIds.reduce((sum, id) => sum + demandWeight(id), 0);
      }

      const equalShare = totalWeight <= EPS ? 1 / Math.max(eligibleIds.length, 1) : null;
      const shares = {};
      for (const id of eligibleIds) {
        const shareRatio = equalShare === null ? demandWeight(id) / totalWeight : equalShare;
        const volume = transitVolume * shareRatio;
        transitShareByNode[id] += volume;
        permittedShareByNode[id] += volume * quotaScale;
        shares[id] = round(volume, 6);
      }

      injectionAllocations.push({
        sourceNodeId: node.id,
        sourceNodeName: node.name,
        transitVolume: round(transitVolume, 6),
        basis,
        eligibleNodeIds: eligibleIds,
        shares,
      });
    }

    return {
      transitShareByNode,
      permittedShareByNode,
      injectionAllocations,
      abstractionQuota: Number.isFinite(quota) ? quota : null,
      transitAvailable: round(totalTransit, 6),
      transitAllocable: round(totalTransit * quotaScale, 6),
      quotaBinding: Number.isFinite(quota) && totalTransit > quota + EPS,
    };
  }

  function computeNodeSupplyBreakdown(network, params) {
    const normalized = normalizeInputs(network);
    const climateAvailability = getClimateAvailability(params || {});
    const qSupplyByNode = {};
    const localSupplyByNode = {};
    const externalByNode = {};
    const transitShares = computeTransitInflowShares(normalized, params || {}, { scope: "regional" });

    // 可配置水量 = 本地水资源量 + 获准取用的过境水份额。
    // 未获许可的过境水不进入优化（不可取用），但仍作为 passThrough 记录并计入
    // 展示口径的河道流量——长江不会因为不可取用就消失。
    const passThroughByNode = {};

    for (const node of normalized.nodes) {
      const qLocal = node.qLocalBase * climateAvailability;
      const permitted = transitShares.permittedShareByNode[node.id] || 0;
      const fullTransit = transitShares.transitShareByNode[node.id] || 0;
      localSupplyByNode[node.id] = Math.max(0, qLocal);
      externalByNode[node.id] = permitted;
      passThroughByNode[node.id] = Math.max(0, fullTransit - permitted);
      qSupplyByNode[node.id] = Math.max(0, localSupplyByNode[node.id] + permitted);
    }
    return {
      qSupplyByNode,
      localSupplyByNode,
      externalByNode,
      passThroughByNode,
      permittedTransitByNode: transitShares.permittedShareByNode,
      externalInflowAllocations: transitShares.injectionAllocations,
      abstractionQuota: transitShares.abstractionQuota,
      transitAvailable: transitShares.transitAvailable,
      transitAllocable: transitShares.transitAllocable,
      quotaBinding: transitShares.quotaBinding,
    };
  }

  function computeNodeSupply(network, params) {
    return computeNodeSupplyBreakdown(network, params).qSupplyByNode;
  }

  function computeAutarkyWaterRights(network, params) {
    const normalized = normalizeInputs(network);
    const climateAvailability = getClimateAvailability(params || {});
    const localSupplyByNode = {};
    const waterRightByNode = {};
    const transitShares = computeTransitInflowShares(normalized, params || {}, { scope: "downstream" });
    const transitShareByNode = transitShares.transitShareByNode;

    for (const node of normalized.nodes) {
      localSupplyByNode[node.id] = Math.max(0, node.qLocalBase * climateAvailability);
      waterRightByNode[node.id] = localSupplyByNode[node.id] + transitShareByNode[node.id];
    }

    return {
      localSupplyByNode,
      transitShareByNode,
      waterRightByNode,
      injectionAllocations: transitShares.injectionAllocations,
      rule: {
        id: "autarky-water-right-R",
        label: "口径 R：自有水权 = qLocal + 过境水默认份额",
        transitShareBasis: "entry node plus internal downstream nodes by total demand; all-region demand fallback; equal fallback only when all demand is zero",
        crossNodeReallocation: false,
        routedOutflowIsTrade: false,
      },
    };
  }

  function allocateAutarkyWater(node, waterRight, params) {
    const allocation = sectorMap(0);
    const unmet = sectorMap(0);
    const demandCap = computeEffectiveDemandCaps(node, params || {});
    for (const sector of SECTORS) {
      unmet[sector] = demandCap[sector];
    }
    let remaining = Math.max(0, waterRight);

    const take = (sector, requested) => {
      const volume = Math.min(remaining, unmet[sector], Math.max(0, requested));
      allocation[sector] += volume;
      unmet[sector] = Math.max(0, unmet[sector] - volume);
      remaining = Math.max(0, remaining - volume);
      return volume;
    };

    if (unmet.urban > EPS && remaining > EPS) {
      take("urban", unmet.urban);
    }

    take("agri", unmet.agri);
    take("industry", unmet.industry);

    return {
      allocation,
      unmet,
      demandCap,
      effectiveDemand: demandCap,
      rawUnmet: computeRawUnmet(node, allocation),
      unusedWaterRight: remaining,
    };
  }

  function solveAutarky(networkOrParams, maybeParams) {
    const params = maybeParams || (resolveNetworkFromParams(networkOrParams) ? networkOrParams : {});
    const rawNetwork = maybeParams ? networkOrParams : resolveNetworkFromParams(networkOrParams);
    if (!rawNetwork) {
      throw new Error("solveAutarky requires params.network, params.data, or a network-like params object");
    }
    const network = normalizeInputs(rawNetwork);
    const order = topologicalSort(network);
    const downstreamReach = computeDownstreamReach(network, { includeExternalOutlets: true });
    const climateAvailability = getClimateAvailability(params || {});
    const externalMultiplier = getExternalInflowClimateMultiplier(params || {});
    const healthFloor = getHealthFloor(params || {});
    const ecoFloor = getEcoFloor(params || {});
    const tradingCostPerM3 = getTradingCost(params || {});
    const tau = getTau(params || {});
    const riverRetentionValue = getEffectiveRiverRetentionValue(network, params || {});
    const rawRiverRetentionValue = getRiverRetentionValue(params || {});
    const waterRights = computeAutarkyWaterRights(network, params || {});
    const marketPrice = computeMarketPrice(network, waterRights.waterRightByNode, params || {});
    const healthTaxDetails = {};

    for (const node of network.nodes) {
      healthTaxDetails[node.id] = computeHealthTaxDetail(node.id, { ...(params || {}), network, sector: "industry" }, network);
    }

    const effluentRouter = makeEffluentRouter();
    const nodes = order.map((id) => {
      const node = network.nodeById.get(id);
      const waterRight = waterRights.waterRightByNode[id] || 0;
      const localSupply = waterRights.localSupplyByNode[id] || 0;
      const transitShare = waterRights.transitShareByNode[id] || 0;
      const externalInflow = node.externalInflowBase * externalMultiplier;
      const ecoDetail = computeEcoBaseFlowDetail(localSupply, getLegacyEcoDemand(node), ecoFloor);
      const withdrawableWaterRight = Math.max(0, waterRight - ecoDetail.ecoBaseFlow);
      const allocationResult = allocateAutarkyWater(node, withdrawableWaterRight, params || {});
      const allocation = allocationResult.allocation;
      const unmet = allocationResult.unmet;
      const demandCap = allocationResult.demandCap;
      const rawUnmet = allocationResult.rawUnmet;
      const qWithdrawn = SECTORS.reduce((sum, sector) => sum + allocation[sector], 0);
      const qOutflow = ecoDetail.ecoBaseFlow + allocationResult.unusedWaterRight;
      const healthDemand = node.demand.urban;
      const healthFloorTarget = Math.min(healthDemand, withdrawableWaterRight * healthFloor);
      const healthAllocation = allocation.urban;
      const healthFloorShortfall = Math.max(0, healthFloorTarget - healthAllocation);
      const supply = buildSupplySnapshot(node, {
        qLocal: localSupply,
        qLocalRaw: localSupply,
        qAvail: waterRight,
        externalInflow,
      });

      const healthFields = healthOutcomeFields(node, allocation, {
        inStreamFlow: qOutflow,
        upstreamEffluent: effluentRouter.take(id),
      });
      effluentRouter.push(node, healthFields.health.cumulativeEffluent);
      return {
        id,
        name: node.name,
        downstream: node.downstream,
        downstreamReach: downstreamReach[id] || [],
        population: node.population,
        qLocal: supply.qLocal,
        qLocalRaw: supply.qLocalRaw,
        localRunoff: supply.localRunoff,
        externalInflow: supply.externalInflow,
        runoffCoeff: supply.runoffCoeff,
        supply,
        qAvail: round(waterRight, 6),
        qWithdrawn: round(qWithdrawn, 6),
        qOutflow: round(qOutflow, 6),
        ...ecoFlowResultFields(ecoDetail, qOutflow),
        waterBalance: buildWaterBalanceSnapshot({
          localSupply,
          upstreamInflow: transitShare,
          naturalFlow: waterRight,
          withdrawn: qWithdrawn,
          inStreamFlow: qOutflow,
          ecoBaseFlow: ecoDetail.ecoBaseFlow,
        }),
        qUnusedWaterRight: round(allocationResult.unusedWaterRight, 6),
        autarkyWaterRight: round(waterRight, 6),
        qOwnWaterRight: round(waterRight, 6),
        defaultTransitShare: round(transitShare, 6),
        qTransitDefaultShare: round(transitShare, 6),
        demand: { ...node.demand },
        demandCap: roundSectorMap(demandCap),
        effectiveDemand: roundSectorMap(demandCap),
        allocation: roundSectorMap(allocation),
        unmet: roundSectorMap(unmet),
        rawUnmet: roundSectorMap(rawUnmet),
        healthFloorTarget: round(healthFloorTarget, 6),
        healthFloorShortfall: round(healthFloorShortfall, 6),
        ...healthFields,
        healthTax: healthTaxDetails[id],
      };
    });

    const totals = nodes.reduce((acc, node) => {
      acc.qLocal += node.qLocal;
      acc.localRunoff += node.localRunoff || 0;
      acc.externalInflow += node.externalInflow || 0;
      acc.qAvail += node.qAvail;
      acc.withdrawn += node.qWithdrawn;
      acc.outflow += node.qOutflow;
      acc.ecoBaseFlow += node.ecoBaseFlow;
      acc.inStreamFlow += node.inStreamFlow;
      acc.ecoSurplus += node.ecoSurplus;
      acc.environmentalFlow += node.environmentalFlow;
      acc.legacyEcoDemand += node.legacyEcoDemand;
      acc.defaultTransitShare += node.defaultTransitShare;
      acc.transitDefaultShare += node.defaultTransitShare;
      acc.qOwnWaterRight += node.autarkyWaterRight;
      acc.unusedWaterRight += node.qUnusedWaterRight;
      addHealthOutcomesToTotals(acc, node);
      for (const sector of SECTORS) {
        acc.demand[sector] += node.demand[sector];
        acc.demandCap[sector] += node.demandCap[sector];
        acc.effectiveDemand[sector] += node.effectiveDemand[sector];
        acc.allocation[sector] += node.allocation[sector];
        acc.unmet[sector] += node.unmet[sector];
        acc.rawUnmet[sector] += node.rawUnmet[sector];
      }
      return acc;
    }, {
      qLocal: 0,
      localRunoff: 0,
      externalInflow: 0,
      qAvail: 0,
      withdrawn: 0,
      outflow: 0,
      ecoBaseFlow: 0,
      inStreamFlow: 0,
      ecoSurplus: 0,
      environmentalFlow: 0,
      legacyEcoDemand: 0,
      defaultTransitShare: 0,
      transitDefaultShare: 0,
      qOwnWaterRight: 0,
      unusedWaterRight: 0,
      dalyBurden: 0,
      serviceBurden: 0,
      dilutionBurden: 0,
      industrialEffluent: 0,
      demand: sectorMap(0),
      demandCap: sectorMap(0),
      effectiveDemand: sectorMap(0),
      allocation: sectorMap(0),
      unmet: sectorMap(0),
      rawUnmet: sectorMap(0),
    });

    for (const sector of SECTORS) {
      totals.demand[sector] = round(totals.demand[sector], 6);
      totals.demandCap[sector] = round(totals.demandCap[sector], 6);
      totals.effectiveDemand[sector] = round(totals.effectiveDemand[sector], 6);
      totals.allocation[sector] = round(totals.allocation[sector], 6);
      totals.unmet[sector] = round(totals.unmet[sector], 6);
      totals.rawUnmet[sector] = round(totals.rawUnmet[sector], 6);
    }
    totals.qLocal = round(totals.qLocal, 6);
    totals.localRunoff = round(totals.localRunoff, 6);
    totals.externalInflow = round(totals.externalInflow, 6);
    totals.qAvail = round(totals.qAvail, 6);
    totals.withdrawn = round(totals.withdrawn, 6);
    totals.outflow = round(totals.outflow, 6);
    totals.ecoBaseFlow = round(totals.ecoBaseFlow, 6);
    totals.inStreamFlow = round(totals.inStreamFlow, 6);
    totals.ecoSurplus = round(totals.ecoSurplus, 6);
    totals.environmentalFlow = round(totals.environmentalFlow, 6);
    totals.legacyEcoDemand = round(totals.legacyEcoDemand, 6);
    totals.defaultTransitShare = round(totals.defaultTransitShare, 6);
    totals.transitDefaultShare = round(totals.transitDefaultShare, 6);
    totals.qOwnWaterRight = round(totals.qOwnWaterRight, 6);
    totals.unusedWaterRight = round(totals.unusedWaterRight, 6);
    roundHealthOutcomeTotals(totals);

    const result = {
      kind: "research-network-solution",
      solver: {
        type: "deterministic-autarky",
        lpReady: false,
        lpRequested: false,
        lpAttempted: false,
        lpSolverDetected: false,
        lpSolverAdapter: null,
        lpSolverSource: null,
        lpStatus: "not-requested",
        note: "Autarky mode disables cross-node water-right reallocation and allocates each node only from its own water right.",
      },
      params: {
        tau,
        climateAvailability: round(climateAvailability, 6),
        healthFloor,
        ecoFloor,
        riverRetentionValue,
        rawRiverRetentionValue,
        tradingCostPerM3,
        demandElasticity: getDemandElasticity(params || {}),
        trade: "autarky",
      },
      metadata: {
        tradeMode: "autarky",
        autarky: {
          enabled: true,
          scheme: "R",
          rule: "ownWaterRight = climate-adjusted qLocal + demand-proportional default share of each transit inflow among the entry node and its internal downstream nodes, with all-region demand fallback.",
          priority: ["urban", "agri", "industry"],
        },
        waterRightRule: waterRights.rule,
        allocationPriority: ["urban", "agri", "industry"],
        transitDefaultShares: Object.fromEntries(Object.keys(waterRights.transitShareByNode).map((id) => [id, round(waterRights.transitShareByNode[id], 6)])),
        localSupplyByNode: Object.fromEntries(Object.keys(waterRights.localSupplyByNode).map((id) => [id, round(waterRights.localSupplyByNode[id], 6)])),
        waterRightByNode: Object.fromEntries(Object.keys(waterRights.waterRightByNode).map((id) => [id, round(waterRights.waterRightByNode[id], 6)])),
        transitInjections: waterRights.injectionAllocations,
      },
      network,
      order,
      marketPrice,
      nodes,
      nodeById: Object.fromEntries(nodes.map((node) => [node.id, node])),
      tradeFlows: [],
      healthTaxes: healthTaxDetails,
      totals,
      aggregate: aggregateSummary(totals),
    };

    result.incentive = computeIncentiveFlags(result);
    return result;
  }

  function computeMaxRoutedSupply(network, qSupplyByNode, order) {
    const upstreams = buildUpstreamIndex(network);
    const maxSupply = {};
    for (const id of order) {
      maxSupply[id] = qSupplyByNode[id] + upstreams.get(id).reduce((sum, upstreamId) => sum + maxSupply[upstreamId], 0);
    }
    return maxSupply;
  }

  function computeMinimumEcoBaseFlowDetails(network, localSupplyByNode, order, params) {
    const details = {};
    for (const id of order) {
      const node = network.nodeById.get(id);
      const naturalFlow = localSupplyByNode[id] || 0;
      details[id] = computeNodeEcoBaseFlowDetail(node, naturalFlow, params || {});
    }
    return details;
  }

  function buildGlpkProblem(network, params, glpk) {
    const normalized = normalizeInputs(network);
    const order = topologicalSort(normalized);
    const upstreams = buildUpstreamIndex(normalized);
    const supplyBreakdown = computeNodeSupplyBreakdown(normalized, params || {});
    const qSupplyByNode = supplyBreakdown.qSupplyByNode;
    const localSupplyByNode = supplyBreakdown.localSupplyByNode;
    const maxRoutedSupply = computeMaxRoutedSupply(normalized, qSupplyByNode, order);
    const minimumEcoBaseFlowDetails = computeMinimumEcoBaseFlowDetails(normalized, localSupplyByNode, order, params || {});
    const healthFloor = getHealthFloor(params || {});
    const ecoFloor = getEcoFloor(params || {});
    const riverRetentionValue = getEffectiveRiverRetentionValue(normalized, params || {});
    const rawRiverRetentionValue = getRiverRetentionValue(params || {});
    const riverRetentionObjectiveValue = getRiverRetentionObjectiveValue(normalized, params || {});
    const tau = getTau(params || {});
    const healthTaxDetails = {};
    const objectiveVars = [];
    const bounds = [];
    const subjectTo = [];
    const healthFloorTargets = {};
    const demandCapsByNode = {};

    for (const node of normalized.nodes) {
      const industryTax = computeHealthTaxDetail(node.id, { ...(params || {}), network: normalized, sector: "industry" }, normalized);
      healthTaxDetails[node.id] = industryTax;
      demandCapsByNode[node.id] = computeEffectiveDemandCaps(node, params || {});
      for (const sector of SECTORS) {
        const name = lpAllocationVar(node.id, sector);
        const demandCap = demandCapsByNode[node.id][sector];
        const sectorTax = sector === "industry" ? industryTax.taxPerM3 : 0;
        const coef = computeSectorNetValue(node, sector, { ...(params || {}), tau }, sectorTax);
        objectiveVars.push({ name, coef });
        bounds.push({ name, ...glpkBound(glpk, 0, demandCap) });
      }
      objectiveVars.push({ name: lpOutflowVar(node.id), coef: riverRetentionObjectiveValue });
      bounds.push({ name: lpOutflowVar(node.id), type: glpk.GLP_LO, lb: minimumEcoBaseFlowDetails[node.id].ecoBaseFlow, ub: 0 });
      objectiveVars.push({ name: lpSlackVar(node.id), coef: -HEALTH_FLOOR_SHORTFALL_PENALTY });
      bounds.push({ name: lpSlackVar(node.id), type: glpk.GLP_LO, lb: 0, ub: 0 });
    }

    for (const id of order) {
      const node = normalized.nodeById.get(id);
      const balanceVars = SECTORS.map((sector) => ({ name: lpAllocationVar(id, sector), coef: 1 }));
      balanceVars.push({ name: lpOutflowVar(id), coef: 1 });
      for (const upstreamId of upstreams.get(id)) {
        balanceVars.push({ name: lpOutflowVar(upstreamId), coef: -1 });
      }
      subjectTo.push({
        name: "balance_" + id,
        vars: balanceVars,
        bnds: { type: glpk.GLP_FX, lb: qSupplyByNode[id], ub: qSupplyByNode[id] },
      });

      subjectTo.push({
        name: "eco_floor_" + id,
        vars: [{ name: lpOutflowVar(id), coef: 1 }],
        bnds: { type: glpk.GLP_LO, lb: ecoFloor * (localSupplyByNode[id] || 0), ub: 0 },
      });


      const maxEcoDetail = computeNodeEcoBaseFlowDetail(node, localSupplyByNode[id] || 0, params || {});
      const maxWithdrawableSupply = Math.max(0, maxRoutedSupply[id] - maxEcoDetail.ecoBaseFlow);
      const healthDemand = node.demand.urban;
      const healthTarget = Math.min(healthDemand, maxWithdrawableSupply * healthFloor);
      healthFloorTargets[id] = healthTarget;
      subjectTo.push({
        name: "health_floor_" + id,
        vars: [
          { name: lpAllocationVar(id, "urban"), coef: 1 },
          { name: lpSlackVar(id), coef: 1 },
        ],
        bnds: { type: glpk.GLP_LO, lb: healthTarget, ub: 0 },
      });
    }

    return {
      lp: {
        name: "research-network-lp",
        objective: {
          direction: glpk.GLP_MAX,
          name: "net_health_weighted_benefit",
          vars: objectiveVars,
        },
        subjectTo,
        bounds,
      },
      context: {
        network: normalized,
        order,
        qSupplyByNode,
        localSupplyByNode: supplyBreakdown.localSupplyByNode,
        externalByNode: supplyBreakdown.externalByNode,
        supplyBreakdown,
        upstreams,
        healthFloorTargets,
        healthTaxDetails,
        demandCapsByNode,
        riverRetentionValue,
        rawRiverRetentionValue,
        riverRetentionObjectiveValue,
        minimumEcoBaseFlowDetails,
        size: estimateProblemSize(normalized, params || {}),
      },
    };
  }

  function solutionFromGlpkResult(glpkResult, glpk, problemContext, params) {
    const vars = (glpkResult.result && glpkResult.result.vars) || glpkResult.vars || {};
    const duals = (glpkResult.result && glpkResult.result.dual) || glpkResult.dual || {};
    const status = glpkResult.result ? glpkResult.result.status : glpkResult.status;
    const objectiveValue = glpkResult.result ? glpkResult.result.z : glpkResult.z;
    const network = problemContext.network;
    const order = problemContext.order;
    const downstreamReach = computeDownstreamReach(network, { includeExternalOutlets: true });
    // 水量平衡约束的对偶值 = 该节点水的稀缺租金（元/m³），即水权市场的出清价。
    // 由 LP 对偶直接解出，不是外生假定的公式。
    const shadowPriceByNode = {};
    let hasDuals = false;
    for (const id of order) {
      const lambda = optionalNumber(duals["balance_" + id]);
      if (lambda === null) continue;
      hasDuals = true;
      shadowPriceByNode[id] = Math.max(0, lambda);
    }
    const formulaMarketPrice = computeMarketPrice(network, problemContext.qSupplyByNode, params || {});

    const effluentRouter = makeEffluentRouter();
    const nodes = order.map((id) => {
      const node = network.nodeById.get(id);
      const incoming = problemContext.upstreams.get(id).reduce((sum, upstreamId) => {
        return sum + nonNegative(vars[lpOutflowVar(upstreamId)], 0);
      }, 0);
      const qAvail = problemContext.qSupplyByNode[id] + incoming;
      const allocation = sectorMap(0);
      const unmet = sectorMap(0);
      const demandCap = problemContext.demandCapsByNode && problemContext.demandCapsByNode[id]
        ? problemContext.demandCapsByNode[id]
        : computeEffectiveDemandCaps(node, params || {});
      for (const sector of SECTORS) {
        allocation[sector] = nonNegative(vars[lpAllocationVar(id, sector)], 0);
        unmet[sector] = Math.max(0, demandCap[sector] - allocation[sector]);
      }
      const rawUnmet = computeRawUnmet(node, allocation);
      const qOutflow = nonNegative(vars[lpOutflowVar(id)], 0);
      const ecoDetail = computeNodeEcoBaseFlowDetail(node, problemContext.localSupplyByNode[id] || 0, params || {});
      const qWithdrawn = SECTORS.reduce((sum, sector) => sum + allocation[sector], 0);
      const healthFloorTarget = problemContext.healthFloorTargets[id] || 0;
      const healthAllocation = allocation.urban;
      const healthFloorShortfall = Math.max(0, nonNegative(vars[lpSlackVar(id)], 0), healthFloorTarget - healthAllocation);
      const qLocal = problemContext.qSupplyByNode[id];
      const qLocalRaw = problemContext.localSupplyByNode
        ? problemContext.localSupplyByNode[id]
        : Math.max(0, qLocal - ((problemContext.externalByNode && problemContext.externalByNode[id]) || 0));
      const externalInflow = problemContext.externalByNode
        ? problemContext.externalByNode[id]
        : Math.max(0, qLocal - qLocalRaw);
      const supply = buildSupplySnapshot(node, {
        qLocal,
        qLocalRaw,
        qAvail,
        externalInflow,
      });
      const healthFields = healthOutcomeFields(node, allocation, {
        inStreamFlow: qOutflow,
        upstreamEffluent: effluentRouter.take(id),
      });
      effluentRouter.push(node, healthFields.health.cumulativeEffluent);
      return {
        id,
        name: node.name,
        downstream: node.downstream,
        downstreamReach: downstreamReach[id] || [],
        population: node.population,
        qLocal: supply.qLocal,
        qLocalRaw: supply.qLocalRaw,
        localRunoff: supply.localRunoff,
        externalInflow: supply.externalInflow,
        runoffCoeff: supply.runoffCoeff,
        supply,
        qAvail: round(qAvail, 6),
        qWithdrawn: round(qWithdrawn, 6),
        qOutflow: round(qOutflow, 6),
        ...ecoFlowResultFields(ecoDetail, qOutflow),
        waterBalance: buildWaterBalanceSnapshot({
          localSupply: qLocal,
          upstreamInflow: incoming,
          naturalFlow: qAvail,
          withdrawn: qWithdrawn,
          inStreamFlow: qOutflow,
          ecoBaseFlow: ecoDetail.ecoBaseFlow,
        }),
        demand: { ...node.demand },
        demandCap: roundSectorMap(demandCap),
        effectiveDemand: roundSectorMap(demandCap),
        allocation: roundSectorMap(allocation),
        unmet: roundSectorMap(unmet),
        rawUnmet: roundSectorMap(rawUnmet),
        healthFloorTarget: round(healthFloorTarget, 6),
        healthFloorShortfall: round(healthFloorShortfall, 6),
        ...healthFields,
        healthTax: problemContext.healthTaxDetails[id],
        shadowPriceCny: hasDuals ? round(shadowPriceByNode[id] || 0, 6) : null,
        // 超出取水许可、不可取用但仍在河道中下泄的干流过境水。按 methodology.md
        // 的口径，它不计入 environmentalFlow（那是本地可配置水量的河道留存），
        // 只作为物理输运量单独报告。
        transitPassThrough: round(
          (problemContext.supplyBreakdown
            && problemContext.supplyBreakdown.passThroughByNode
            && problemContext.supplyBreakdown.passThroughByNode[id]) || 0,
          6
        ),
      };
    });

    // 出清价取按实际取水量加权的影子价格；同时报告空间价差，价差正是交易的收益来源。
    const shadowPriceStats = (() => {
      if (!hasDuals) return null;
      let weighted = 0;
      let volume = 0;
      let min = Infinity;
      let max = -Infinity;
      let scarceNodes = 0;
      for (const node of nodes) {
        const lambda = shadowPriceByNode[node.id] || 0;
        const withdrawn = node.qWithdrawn || 0;
        weighted += lambda * withdrawn;
        volume += withdrawn;
        min = Math.min(min, lambda);
        max = Math.max(max, lambda);
        if (lambda > EPS) scarceNodes += 1;
      }
      return {
        volumeWeighted: round(volume > EPS ? weighted / volume : 0, 6),
        min: round(Number.isFinite(min) ? min : 0, 6),
        max: round(Number.isFinite(max) ? max : 0, 6),
        spread: round(Number.isFinite(max) && Number.isFinite(min) ? max - min : 0, 6),
        scarceNodeCount: scarceNodes,
        nodeCount: nodes.length,
      };
    })();

    const marketPrice = shadowPriceStats ? shadowPriceStats.volumeWeighted : formulaMarketPrice;

    const tradeFlows = network.edges
      .map((edge) => {
        const volume = nonNegative(vars[lpOutflowVar(edge.from)], 0);
        const originNode = network.nodeById.get(edge.from);
        const targetNode = network.nodeById.get(edge.to);
        return {
          origin: edge.from,
          originName: originNode.name,
          target: edge.to,
          targetName: targetNode.name,
          sector: "bulk-routed-outflow",
          direction: "upstream-to-downstream",
          volume: round(volume, 6),
          averageHops: 1,
          marketPrice: round(marketPrice, 6),
          tradingCostPerM3: round(getTradingCost(params || {}), 6),
          averageUnitCost: round(marketPrice + getTradingCost(params || {}), 6),
        };
      })
      .filter((flow) => flow.volume > EPS);

    const totals = nodes.reduce((acc, node) => {
      acc.qLocal += node.qLocal;
      acc.localRunoff += node.localRunoff || 0;
      acc.externalInflow += node.externalInflow || 0;
      acc.qAvail += node.qAvail;
      acc.withdrawn += node.qWithdrawn;
      acc.outflow += node.qOutflow;
      acc.ecoBaseFlow += node.ecoBaseFlow;
      acc.inStreamFlow += node.inStreamFlow;
      acc.ecoSurplus += node.ecoSurplus;
      acc.environmentalFlow += node.environmentalFlow;
      acc.legacyEcoDemand += node.legacyEcoDemand;
      acc.transitPassThrough += node.transitPassThrough || 0;
      addHealthOutcomesToTotals(acc, node);
      for (const sector of SECTORS) {
        acc.demand[sector] += node.demand[sector];
        acc.demandCap[sector] += node.demandCap[sector];
        acc.effectiveDemand[sector] += node.effectiveDemand[sector];
        acc.allocation[sector] += node.allocation[sector];
        acc.unmet[sector] += node.unmet[sector];
        acc.rawUnmet[sector] += node.rawUnmet[sector];
      }
      return acc;
    }, {
      qLocal: 0,
      localRunoff: 0,
      externalInflow: 0,
      qAvail: 0,
      withdrawn: 0,
      outflow: 0,
      ecoBaseFlow: 0,
      inStreamFlow: 0,
      ecoSurplus: 0,
      environmentalFlow: 0,
      legacyEcoDemand: 0,
      transitPassThrough: 0,
      dalyBurden: 0,
      serviceBurden: 0,
      dilutionBurden: 0,
      industrialEffluent: 0,
      demand: sectorMap(0),
      demandCap: sectorMap(0),
      effectiveDemand: sectorMap(0),
      allocation: sectorMap(0),
      unmet: sectorMap(0),
      rawUnmet: sectorMap(0),
    });

    for (const sector of SECTORS) {
      totals.demand[sector] = round(totals.demand[sector], 6);
      totals.demandCap[sector] = round(totals.demandCap[sector], 6);
      totals.effectiveDemand[sector] = round(totals.effectiveDemand[sector], 6);
      totals.allocation[sector] = round(totals.allocation[sector], 6);
      totals.unmet[sector] = round(totals.unmet[sector], 6);
      totals.rawUnmet[sector] = round(totals.rawUnmet[sector], 6);
    }
    totals.qLocal = round(totals.qLocal, 6);
    totals.localRunoff = round(totals.localRunoff, 6);
    totals.externalInflow = round(totals.externalInflow, 6);
    totals.qAvail = round(totals.qAvail, 6);
    totals.withdrawn = round(totals.withdrawn, 6);
    totals.outflow = round(totals.outflow, 6);
    totals.ecoBaseFlow = round(totals.ecoBaseFlow, 6);
    totals.inStreamFlow = round(totals.inStreamFlow, 6);
    totals.ecoSurplus = round(totals.ecoSurplus, 6);
    totals.environmentalFlow = round(totals.environmentalFlow, 6);
    totals.legacyEcoDemand = round(totals.legacyEcoDemand, 6);
    totals.transitPassThrough = round(totals.transitPassThrough, 6);
    roundHealthOutcomeTotals(totals);

    // 庇古税的福利账：
    //  - 税收收入是转移支付，不计入社会成本，但必须单独报告（可定向用于供水/WASH 投资）
    //  - 社会成本是需求曲线下的无谓损失三角形 ½·Δq·t，不是被减掉的水的全价。
    //    弹性 ε 已经蕴含「企业可以通过节水与循环利用替代」，按全价计损失等于
    //    既承认弹性又假装没有弹性。详见 docs/economics-audit.md §4.1。
    const welfare = (() => {
      let forgone = 0;
      let revenue = 0;
      let dwl = 0;
      let taxedVolume = 0;
      for (const node of nodes) {
        const taxPerM3 = nonNegative(node.healthTax && node.healthTax.taxPerM3, 0);
        const baselineDemand = nonNegative(node.demand.industry, 0);
        const cappedDemand = nonNegative(node.demandCap.industry, 0);
        const reduction = Math.max(0, baselineDemand - cappedDemand);
        forgone += reduction;
        dwl += 0.5 * reduction * taxPerM3;
        revenue += taxPerM3 * nonNegative(node.allocation.industry, 0);
        taxedVolume += nonNegative(node.allocation.industry, 0);
      }
      return {
        industrialWaterForgoneM3: round(forgone, 6),
        deadweightLossCny: round(dwl, 6),
        taxRevenueCny: round(revenue, 6),
        averageTaxPerM3: round(taxedVolume > EPS ? revenue / taxedVolume : 0, 6),
        costBasis: "harberger-deadweight-loss",
        note: "税收收入为转移支付，不计入社会成本；社会成本按无谓损失三角形 ½·Δq·t 计。",
      };
    })();

    const result = {
      kind: "research-network-solution",
      solver: {
        type: "glpk.js",
        lpReady: isGlpkSolvedStatus(glpk, status),
        lpAttempted: true,
        lpSolverDetected: true,
        lpSolverAdapter: "glpk.js",
        lpSolverSource: "glpk.js",
        lpStatus: glpkStatusName(glpk, status),
        glpkStatus: status,
        objectiveValue: round(objectiveValue || 0, 6),
        solveTimeSeconds: glpkResult.time,
        lpInterfaceSize: problemContext.size,
      },
      params: {
        tau: getTau(params || {}),
        climateAvailability: round(getClimateAvailability(params || {}), 6),
        healthFloor: getHealthFloor(params || {}),
        ecoFloor: getEcoFloor(params || {}),
        riverRetentionValue: problemContext.riverRetentionValue,
        rawRiverRetentionValue: problemContext.rawRiverRetentionValue,
        riverRetentionObjectiveValue: problemContext.riverRetentionObjectiveValue,
        tradingCostPerM3: getTradingCost(params || {}),
        demandElasticity: getDemandElasticity(params || {}),
        mainstemAbstractionQuota: getMainstemAbstractionQuota(params || {}),
      },
      network,
      order,
      marketPrice,
      marketPriceSource: shadowPriceStats ? "lp-dual-shadow-price" : "heuristic-formula",
      marketPriceFormula: round(formulaMarketPrice, 6),
      shadowPrice: shadowPriceStats,
      supplyScope: problemContext.supplyBreakdown
        ? {
          abstractionQuota: problemContext.supplyBreakdown.abstractionQuota,
          transitAvailable: problemContext.supplyBreakdown.transitAvailable,
          transitAllocable: problemContext.supplyBreakdown.transitAllocable,
          quotaBinding: problemContext.supplyBreakdown.quotaBinding,
        }
        : null,
      welfare,
      nodes,
      nodeById: Object.fromEntries(nodes.map((node) => [node.id, node])),
      tradeFlows,
      healthTaxes: problemContext.healthTaxDetails,
      totals,
      aggregate: aggregateSummary(totals),
    };
    result.incentive = computeIncentiveFlags(result);
    return result;
  }

  function solveWithGlpkInstance(glpk, network, params) {
    if (!glpk || typeof glpk.solve !== "function") {
      throw new Error("A ready glpk.js instance with solve() is required");
    }
    const problem = buildGlpkProblem(network, params || {}, glpk);
    const glpkResult = glpk.solve(problem.lp, {
      msglev: glpk.GLP_MSG_OFF,
      presol: true,
      tmlim: finiteNumber(params && params.lpTimeLimitSeconds, 30),
    });
    return solutionFromGlpkResult(glpkResult, glpk, problem.context, params || {});
  }

  async function solveWithGlpkInstanceAsync(glpk, network, params) {
    if (!glpk || typeof glpk.solve !== "function") {
      throw new Error("A ready glpk.js instance with solve() is required");
    }
    const problem = buildGlpkProblem(network, params || {}, glpk);
    const glpkResult = await glpk.solve(problem.lp, {
      msglev: glpk.GLP_MSG_OFF,
      presol: true,
      tmlim: finiteNumber(params && params.lpTimeLimitSeconds, 30),
    });
    return solutionFromGlpkResult(glpkResult, glpk, problem.context, params || {});
  }

  async function loadNodeGlpkInstance() {
    if (typeof require === "function") {
      const path = require("path");
      const { pathToFileURL } = require("url");
      const vendorPath = path.join(__dirname, "..", "vendor", "glpk.js", "dist", "glpk.js");
      const mod = await import(pathToFileURL(vendorPath).href);
      const factory = mod.default || mod;
      return factory();
    }
    throw new Error("Automatic glpk.js/node loading is only available in Node; pass params.glpk in browsers.");
  }

  async function resolveGlpkInstanceAsync(params) {
    const opts = params || {};
    const explicit = opts.glpk || opts.glpkInstance;
    if (explicit) {
      return typeof explicit.then === "function" ? explicit : explicit;
    }
    return loadNodeGlpkInstance();
  }

  function getGlobalScope() {
    if (typeof globalThis !== "undefined") return globalThis;
    if (typeof window !== "undefined") return window;
    return null;
  }

  function resolveLpSolverAdapter(params) {
    const opts = params || {};

    if (typeof opts.lpSolver === "function") {
      return {
        type: "custom-lp-solver",
        source: "params.lpSolver",
        solve: opts.lpSolver,
      };
    }

    if (isObject(opts.lpSolver) && typeof opts.lpSolver.solve === "function") {
      return {
        type: opts.lpSolver.type || "custom-lp-solver-object",
        source: "params.lpSolver.solve",
        solve: (lpInterface, context) => opts.lpSolver.solve(lpInterface, context),
      };
    }

    const explicitGlpk = opts.glpk || opts.glpkInstance;
    const scope = getGlobalScope();
    const globalGlpk = scope && (scope.glpk || (scope.window && scope.window.glpk));
    const glpk = explicitGlpk || globalGlpk;
    if (glpk) {
      if (typeof glpk.solve === "function") {
        return {
          type: "glpk.js",
          source: explicitGlpk ? "params.glpk" : "globalThis.glpk",
          solve: (lpInterface, context) => solveWithGlpkInstance(glpk, context.network, context.params),
        };
      }
      return {
        type: "glpk-js-detected",
        source: explicitGlpk ? "params.glpk" : "globalThis.glpk",
        solve: null,
      };
    }

    return null;
  }

  function wantsLpPath(params, adapter) {
    const opts = params || {};
    return Boolean(
      opts.solver === "lp" ||
      opts.preferLp === true ||
      opts.useLp === true ||
      typeof opts.lpSolver === "function" ||
      isObject(opts.lpSolver) ||
      opts.glpk ||
      opts.glpkInstance ||
      (adapter && adapter.source === "globalThis.glpk")
    );
  }

  function emptyLpFallback(requestedLp, adapter, status) {
    return {
      lpRequested: Boolean(requestedLp),
      lpAttempted: false,
      lpSolverDetected: Boolean(adapter),
      lpSolverAdapter: adapter ? adapter.type : null,
      lpSolverSource: adapter ? adapter.source : null,
      lpStatus: status || (requestedLp ? "no-lp-solver-adapter" : "not-requested"),
    };
  }

  function solveWithLpAdapter(adapter, network, params) {
    if (!adapter) {
      return {
        solved: false,
        fallback: emptyLpFallback(true, null, "no-lp-solver-adapter"),
      };
    }

    const lpInterface = buildLpProblemInterface(network, params);
    if (typeof adapter.solve !== "function") {
      return {
        solved: false,
        fallback: {
          ...emptyLpFallback(true, adapter, "glpk-js-detected-interface-not-wired"),
          lpInterfaceKind: lpInterface.kind,
          lpInterfaceSize: lpInterface.size,
        },
      };
    }

    const context = {
      network,
      params: params || {},
      adapter: {
        type: adapter.type,
        source: adapter.source,
      },
      lpInterfaceSize: lpInterface.size,
    };
    const candidate = adapter.solve(lpInterface, context);
    if (candidate && typeof candidate.then === "function") {
      throw new Error("lpSolver returned a Promise; solveNetwork only supports synchronous LP adapters in the browser MVP");
    }
    if (!isObject(candidate)) {
      throw new Error("lpSolver must return a solution object");
    }

    const solverInfo = isObject(candidate.solver) ? candidate.solver : {};
    return {
      solved: true,
      result: {
        ...candidate,
        solver: {
          ...solverInfo,
          type: solverInfo.type || adapter.type,
          lpReady: solverInfo.lpReady === true,
          lpAttempted: true,
          lpSolverDetected: true,
          lpSolverAdapter: adapter.type,
          lpSolverSource: adapter.source,
          lpStatus: solverInfo.lpReady === true ? (solverInfo.lpStatus || "solved-by-adapter") : (solverInfo.lpStatus || "adapter-returned-unverified-solution"),
          lpInterfaceKind: lpInterface.kind,
          lpInterfaceSize: lpInterface.size,
        },
      },
    };
  }

  function recordTradeFlow(flowMap, lot, targetId, targetName, sector, volume, unitCost, marketPrice, tradingCostPerM3) {
    if (lot.origin === targetId || volume <= EPS) return;
    const key = lot.origin + "|" + targetId + "|" + sector;
    const existing = flowMap.get(key) || {
      origin: lot.origin,
      originName: lot.originName || lot.origin,
      target: targetId,
      targetName,
      sector,
      direction: "upstream-to-downstream",
      volume: 0,
      totalCost: 0,
      weightedHops: 0,
      marketPrice,
      tradingCostPerM3,
    };
    existing.volume += volume;
    existing.totalCost += volume * unitCost;
    existing.weightedHops += volume * lot.hops;
    flowMap.set(key, existing);
  }

  function consumeLots(lots, targetNode, sector, requested, context) {
    let remaining = Math.max(0, requested);
    let allocated = 0;
    const sectorTax = context.healthTaxByNodeSector[targetNode.id]?.[sector] || 0;

    for (const lot of lots) {
      if (remaining <= EPS) break;
      if (lot.volume <= EPS) continue;

      const take = Math.min(lot.volume, remaining);
      lot.volume = Math.max(0, lot.volume - take);
      remaining -= take;
      allocated += take;

      const tradeCost = lot.origin === targetNode.id ? 0 : context.tradingCostPerM3 * lot.hops;
      const unitCost = context.marketPrice + tradeCost + sectorTax;
      recordTradeFlow(
        context.flowMap,
        lot,
        targetNode.id,
        targetNode.name,
        sector,
        take,
        unitCost,
        context.marketPrice,
        context.tradingCostPerM3
      );
    }

    return allocated;
  }

  function solveNetwork(params) {
    const rawNetwork = resolveNetworkFromParams(params);
    if (!rawNetwork) {
      throw new Error("solveNetwork requires params.network, params.data, or a network-like params object");
    }
    const network = normalizeInputs(rawNetwork);
    if (isAutarkyMode(params || {})) {
      return solveAutarky(network, params || {});
    }

    const lpAdapter = resolveLpSolverAdapter(params || {});
    const requestedLp = wantsLpPath(params || {}, lpAdapter);
    let lpFallback = emptyLpFallback(requestedLp, lpAdapter);
    if (requestedLp) {
      const lpAttempt = solveWithLpAdapter(lpAdapter, network, params || {});
      if (lpAttempt.solved) {
        return lpAttempt.result;
      }
      lpFallback = lpAttempt.fallback;
    }

    const order = topologicalSort(network);
    const downstreamReach = computeDownstreamReach(network, { includeExternalOutlets: true });
    const climateAvailability = getClimateAvailability(params || {});
    const healthFloor = getHealthFloor(params || {});
    const ecoFloor = getEcoFloor(params || {});
    const tradingCostPerM3 = getTradingCost(params || {});
    const tau = getTau(params || {});
    const riverRetentionValue = getEffectiveRiverRetentionValue(network, params || {});
    const rawRiverRetentionValue = getRiverRetentionValue(params || {});
    const supplyBreakdown = computeNodeSupplyBreakdown(network, params || {});
    const qSupplyByNode = supplyBreakdown.qSupplyByNode;

    const marketPrice = computeMarketPrice(network, qSupplyByNode, params || {});
    const healthTaxDetails = {};
    const healthTaxByNodeSector = {};
    for (const node of network.nodes) {
      const detail = computeHealthTaxDetail(node.id, { ...(params || {}), network, sector: "industry" }, network);
      healthTaxDetails[node.id] = detail;
      healthTaxByNodeSector[node.id] = {
        urban: 0,
        agri: 0,
        industry: detail.taxPerM3,
      };
    }

    const incomingLots = new Map(network.nodes.map((node) => [node.id, []]));
    const resultById = new Map();
    const flowMap = new Map();
    const context = {
      flowMap,
      marketPrice,
      tradingCostPerM3,
      healthTaxByNodeSector,
    };

    const effluentRouter = makeEffluentRouter();
    for (const id of order) {
      const node = network.nodeById.get(id);
      const localVolume = qSupplyByNode[id];
      const lots = incomingLots.get(id).slice();
      if (localVolume > EPS) {
        lots.push({
          origin: id,
          originName: node.name,
          volume: localVolume,
          hops: 0,
        });
      }

      lots.sort((a, b) => {
        if (a.origin === id && b.origin !== id) return -1;
        if (a.origin !== id && b.origin === id) return 1;
        return a.hops - b.hops;
      });

      const qAvail = lots.reduce((sum, lot) => sum + lot.volume, 0);
      const upstreamInflow = Math.max(0, qAvail - localVolume);
      const ecoDetail = computeEcoBaseFlowDetail(supplyBreakdown.localSupplyByNode[id] || 0, getLegacyEcoDemand(node), ecoFloor);
      let withdrawableRemaining = Math.max(0, qAvail - ecoDetail.ecoBaseFlow);
      const allocation = sectorMap(0);
      const unmet = sectorMap(0);
      const demandCap = computeEffectiveDemandCaps(node, params || {});
      for (const sector of SECTORS) {
        unmet[sector] = demandCap[sector];
      }
      const consumeWithdrawable = (sector, requested) => {
        if (withdrawableRemaining <= EPS || requested <= EPS) return 0;
        const got = consumeLots(lots, node, sector, Math.min(requested, withdrawableRemaining), context);
        withdrawableRemaining = Math.max(0, withdrawableRemaining - got);
        allocation[sector] += got;
        unmet[sector] = Math.max(0, unmet[sector] - got);
        return got;
      };

      const healthDemand = node.demand.urban;
      const withdrawableFlow = Math.max(0, qAvail - ecoDetail.ecoBaseFlow);
      const healthFloorTarget = Math.min(healthDemand, withdrawableFlow * healthFloor);

      if (healthFloorTarget > EPS && healthDemand > EPS) {
        consumeWithdrawable("urban", Math.min(healthFloorTarget, unmet.urban));
        const deliveredFloor = allocation.urban;
        const floorRemainder = Math.max(0, healthFloorTarget - deliveredFloor);
        if (floorRemainder > EPS && unmet.urban > EPS) {
          consumeWithdrawable("urban", Math.min(floorRemainder, unmet.urban));
        }
      }

      const rankedSectors = SECTORS
        .map((sector) => {
          return {
            sector,
            score: computeSectorNetValue(node, sector, { ...(params || {}), tau }, healthTaxByNodeSector[id][sector] || 0),
          };
        })
        .sort((a, b) => b.score - a.score);

      for (const { sector, score } of rankedSectors) {
        if (unmet[sector] <= EPS) continue;
        if (score <= riverRetentionValue + EPS) break;
        consumeWithdrawable(sector, unmet[sector]);
      }

      const qOutflow = lots.reduce((sum, lot) => sum + lot.volume, 0);
      const qWithdrawn = SECTORS.reduce((sum, sector) => sum + allocation[sector], 0);
      const rawUnmet = computeRawUnmet(node, allocation);
      const healthAllocation = allocation.urban;
      const healthFloorShortfall = Math.max(0, healthFloorTarget - healthAllocation);
      const supply = buildSupplySnapshot(node, {
        qLocal: qSupplyByNode[id],
        qLocalRaw: supplyBreakdown.localSupplyByNode[id],
        qAvail,
        externalInflow: supplyBreakdown.externalByNode[id],
      });

      const healthFields = healthOutcomeFields(node, allocation, {
        inStreamFlow: qOutflow,
        upstreamEffluent: effluentRouter.take(id),
      });
      effluentRouter.push(node, healthFields.health.cumulativeEffluent);
      const state = {
        id,
        name: node.name,
        downstream: node.downstream,
        downstreamReach: downstreamReach[id] || [],
        population: node.population,
        qLocal: supply.qLocal,
        qLocalRaw: supply.qLocalRaw,
        localRunoff: supply.localRunoff,
        externalInflow: supply.externalInflow,
        runoffCoeff: supply.runoffCoeff,
        supply,
        qAvail: round(qAvail, 6),
        qWithdrawn: round(qWithdrawn, 6),
        qOutflow: round(qOutflow, 6),
        ...ecoFlowResultFields(ecoDetail, qOutflow),
        waterBalance: buildWaterBalanceSnapshot({
          localSupply: localVolume,
          upstreamInflow,
          naturalFlow: qAvail,
          withdrawn: qWithdrawn,
          inStreamFlow: qOutflow,
          ecoBaseFlow: ecoDetail.ecoBaseFlow,
        }),
        demand: { ...node.demand },
        demandCap: roundSectorMap(demandCap),
        effectiveDemand: roundSectorMap(demandCap),
        allocation: roundSectorMap(allocation),
        unmet: roundSectorMap(unmet),
        rawUnmet: roundSectorMap(rawUnmet),
        healthFloorTarget: round(healthFloorTarget, 6),
        healthFloorShortfall: round(healthFloorShortfall, 6),
        ...healthFields,
        healthTax: healthTaxDetails[id],
      };
      resultById.set(id, state);

      if (node.downstreamInternal && qOutflow > EPS) {
        const routed = lots
          .filter((lot) => lot.volume > EPS)
          .map((lot) => ({
            origin: lot.origin,
            originName: lot.originName,
            volume: lot.volume,
            hops: lot.hops + 1,
          }));
        incomingLots.get(node.downstreamInternal).push(...routed);
      }
    }

    const nodes = order.map((id) => resultById.get(id));
    const tradeFlows = Array.from(flowMap.values()).map((flow) => ({
      origin: flow.origin,
      originName: flow.originName,
      target: flow.target,
      targetName: flow.targetName,
      sector: flow.sector,
      direction: flow.direction,
      volume: round(flow.volume, 6),
      averageHops: round(flow.weightedHops / Math.max(flow.volume, EPS), 6),
      marketPrice: round(flow.marketPrice, 6),
      tradingCostPerM3: round(flow.tradingCostPerM3, 6),
      averageUnitCost: round(flow.totalCost / Math.max(flow.volume, EPS), 6),
    }));

    const totals = nodes.reduce((acc, node) => {
      acc.qLocal += node.qLocal;
      acc.localRunoff += node.localRunoff || 0;
      acc.externalInflow += node.externalInflow || 0;
      acc.qAvail += node.qAvail;
      acc.withdrawn += node.qWithdrawn;
      acc.outflow += node.qOutflow;
      acc.ecoBaseFlow += node.ecoBaseFlow;
      acc.inStreamFlow += node.inStreamFlow;
      acc.ecoSurplus += node.ecoSurplus;
      acc.environmentalFlow += node.environmentalFlow;
      acc.legacyEcoDemand += node.legacyEcoDemand;
      addHealthOutcomesToTotals(acc, node);
      for (const sector of SECTORS) {
        acc.demand[sector] += node.demand[sector];
        acc.demandCap[sector] += node.demandCap[sector];
        acc.effectiveDemand[sector] += node.effectiveDemand[sector];
        acc.allocation[sector] += node.allocation[sector];
        acc.unmet[sector] += node.unmet[sector];
        acc.rawUnmet[sector] += node.rawUnmet[sector];
      }
      return acc;
    }, {
      qLocal: 0,
      localRunoff: 0,
      externalInflow: 0,
      qAvail: 0,
      withdrawn: 0,
      outflow: 0,
      ecoBaseFlow: 0,
      inStreamFlow: 0,
      ecoSurplus: 0,
      environmentalFlow: 0,
      legacyEcoDemand: 0,
      dalyBurden: 0,
      serviceBurden: 0,
      dilutionBurden: 0,
      industrialEffluent: 0,
      demand: sectorMap(0),
      demandCap: sectorMap(0),
      effectiveDemand: sectorMap(0),
      allocation: sectorMap(0),
      unmet: sectorMap(0),
      rawUnmet: sectorMap(0),
    });

    for (const sector of SECTORS) {
      totals.demand[sector] = round(totals.demand[sector], 6);
      totals.demandCap[sector] = round(totals.demandCap[sector], 6);
      totals.effectiveDemand[sector] = round(totals.effectiveDemand[sector], 6);
      totals.allocation[sector] = round(totals.allocation[sector], 6);
      totals.unmet[sector] = round(totals.unmet[sector], 6);
      totals.rawUnmet[sector] = round(totals.rawUnmet[sector], 6);
    }
    totals.qLocal = round(totals.qLocal, 6);
    totals.localRunoff = round(totals.localRunoff, 6);
    totals.externalInflow = round(totals.externalInflow, 6);
    totals.qAvail = round(totals.qAvail, 6);
    totals.withdrawn = round(totals.withdrawn, 6);
    totals.outflow = round(totals.outflow, 6);
    totals.ecoBaseFlow = round(totals.ecoBaseFlow, 6);
    totals.inStreamFlow = round(totals.inStreamFlow, 6);
    totals.ecoSurplus = round(totals.ecoSurplus, 6);
    totals.environmentalFlow = round(totals.environmentalFlow, 6);
    totals.legacyEcoDemand = round(totals.legacyEcoDemand, 6);
    roundHealthOutcomeTotals(totals);

    const result = {
      kind: "research-network-solution",
      solver: {
        type: "heuristic-routing-market",
        lpReady: false,
        ...lpFallback,
        note: "Heuristic fallback for environments without a ready synchronous GLPK adapter.",
      },
      params: {
        tau,
        climateAvailability: round(climateAvailability, 6),
        healthFloor,
        ecoFloor,
        riverRetentionValue,
        rawRiverRetentionValue,
        tradingCostPerM3,
        demandElasticity: getDemandElasticity(params || {}),
      },
      network,
      order,
      marketPrice,
      nodes,
      nodeById: Object.fromEntries(nodes.map((node) => [node.id, node])),
      tradeFlows,
      healthTaxes: healthTaxDetails,
      totals,
      aggregate: aggregateSummary(totals),
    };

    result.incentive = computeIncentiveFlags(result);
    return result;
  }

  function isAutarkyMode(params) {
    const mode = String(params.trade || params.marketMode || params.scenario || "").toLowerCase();
    return mode === "autarky" || mode === "self-sufficient" || mode === "self_sufficient";
  }

  async function solveNetworkLpAsync(params) {
    const rawNetwork = resolveNetworkFromParams(params);
    if (!rawNetwork) {
      throw new Error("solveNetworkLpAsync requires params.network, params.data, or a network-like params object");
    }
    const network = normalizeInputs(rawNetwork);
    const glpk = await resolveGlpkInstanceAsync(params || {});
    return solveWithGlpkInstanceAsync(glpk, network, { ...(params || {}), solver: "lp" });
  }

  function computeIncentiveFlags(resultOrParams, maybeParams) {
    const result = resultOrParams && resultOrParams.kind === "research-network-solution"
      ? resultOrParams
      : solveNetwork(resultOrParams);
    const params = maybeParams || result.params || {};
    const tau = getTau(params);
    const tolerance = 1 + getHealthFloor(params) * 0.5;
    const flags = [];

    for (const nodeResult of result.nodes) {
      const sourceNode = result.network.nodeById.get(nodeResult.id);
      for (const sector of SECTORS) {
        const allocated = nodeResult.allocation[sector] || 0;
        if (allocated <= EPS) continue;
        const sectorTax = result.healthTaxes[nodeResult.id]?.sector === sector
          ? result.healthTaxes[nodeResult.id].taxPerM3
          : sector === "industry"
            ? result.healthTaxes[nodeResult.id]?.taxPerM3 || 0
            : 0;
        const referencePrice = result.marketPrice + sectorTax;
        const complianceCost = sourceNode.complianceCost[sector] || 0;
        if (complianceCost > referencePrice * tolerance) {
          flags.push({
            type: "incentive",
            nodeId: nodeResult.id,
            nodeName: nodeResult.name,
            sector,
            allocated: round(allocated, 6),
            complianceCost: round(complianceCost, 6),
            referencePrice: round(referencePrice, 6),
            tolerance: round(tolerance, 6),
            severity: round(complianceCost / Math.max(referencePrice * tolerance, EPS), 6),
            tau,
          });
        }
      }

      if (nodeResult.healthFloorShortfall > EPS) {
        flags.push({
          type: "health-floor-shortfall",
          nodeId: nodeResult.id,
          nodeName: nodeResult.name,
          sector: "urban",
          sectors: ["urban"],
          shortfall: nodeResult.healthFloorShortfall,
          target: nodeResult.healthFloorTarget,
        });
      }
    }

    return {
      compatible: flags.length === 0,
      flags,
      violatingNodeSectors: flags
        .filter((flag) => flag.type === "incentive")
        .map((flag) => flag.nodeId + ":" + flag.sector),
    };
  }

  return {
    loadInputs,
    load: loadInputs,
    normalizeInputs,
    normalize: normalizeInputs,
    topologicalSort,
    computeDownstreamReach,
    solveNetwork,
    solveAutarky,
    computeHealthTax,
    computeIncentiveFlags,
    buildLpProblemInterface,
    buildGlpkProblem,
    estimateProblemSize,
    resolveLpSolverAdapter,
    solveWithGlpkInstance,
    solveWithGlpkInstanceAsync,
    solveNetworkLpAsync,
    loadNodeGlpkInstance,
    _internals: {
      SECTORS,
      computeHealthTaxDetail,
      buildGlpkProblem,
      computeAutarkyWaterRights,
      solveAutarky,
      solveWithGlpkInstance,
      solveWithGlpkInstanceAsync,
      resolveGlpkInstanceAsync,
      getClimateAvailability,
      getTradingCost,
      getHealthFloor,
      getEcoFloor,
      getDemandElasticity,
      getExternalInflowClimateMultiplier,
      getRiverRetentionValue,
      getEffectiveRiverRetentionValue,
      getRiverRetentionObjectiveValue,
      getHealthLossCoeff,
      computeEffectiveDemandCap,
      computeEffectiveDemandCaps,
      computeEcoBaseFlowDetail,
      computeNodeEcoBaseFlowDetail,
    },
  };
});
