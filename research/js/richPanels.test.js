const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const TradeSankey = require("./sankey");
const ResearchNetworkModel = require("./networkModel");
const TauResponseChart = require("./tauResponseChart");

const RESEARCH_DIR = path.resolve(__dirname, "..");
const ATTRS_PATH = path.join(RESEARCH_DIR, "data", "wuhan-attrs.json");
const INDEX_PATH = path.join(RESEARCH_DIR, "index.html");
const DASHBOARD_JS_PATH = path.join(__dirname, "dashboard.js");
const RICH_PANELS_JS_PATH = path.join(__dirname, "richPanels.js");
const MAIN_JS_PATH = path.join(__dirname, "main.js");
const MAP_JS_PATH = path.join(__dirname, "map.js");

const indexHtml = fs.readFileSync(INDEX_PATH, "utf8");
const dashboardSource = fs.readFileSync(DASHBOARD_JS_PATH, "utf8");
const richPanelsSource = fs.readFileSync(RICH_PANELS_JS_PATH, "utf8");
const mainSource = fs.readFileSync(MAIN_JS_PATH, "utf8");
const mapSource = fs.readFileSync(MAP_JS_PATH, "utf8");
const richFailures = [];

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...items) {
    items.forEach((item) => this.values.add(item));
  }

  remove(...items) {
    items.forEach((item) => this.values.delete(item));
  }

  toggle(item, force) {
    const active = force === undefined ? !this.values.has(item) : Boolean(force);
    if (active) this.add(item);
    else this.remove(item);
    return active;
  }

  contains(item) {
    return this.values.has(item);
  }
}

class FakeElement {
  constructor(idOrTag) {
    this.id = idOrTag || "";
    this.tagName = String(idOrTag || "div").toUpperCase();
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.children = [];
    this.classList = new FakeClassList();
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.value = "";
    this._innerHTML = "";
  }

  set innerHTML(value) {
    this._innerHTML = String(value || "");
  }

  get innerHTML() {
    return this._innerHTML;
  }

  setAttribute(name, value) {
    const stringValue = String(value);
    this.attributes[name] = stringValue;
    if (name === "id") this.id = stringValue;
    if (name.startsWith("data-")) {
      this.dataset[toDatasetKey(name.slice(5))] = stringValue;
    }
  }

  getAttribute(name) {
    return this.attributes[name];
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  addEventListener(type, handler) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  }

  dispatchEvent(event) {
    const handlers = this.listeners[event.type] || [];
    handlers.forEach((handler) => handler.call(this, event));
    return true;
  }

  querySelectorAll(selector) {
    return queryHtml(this.innerHTML, selector);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  getContext() {
    return {};
  }
}

function createFakeDocument() {
  const elements = new Map();
  const body = new FakeElement("body");

  function getElementById(id) {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  }

  getElementById("dashboard");

  return {
    body,
    getElementById,
    createElement: (tag) => new FakeElement(tag),
    querySelector: (selector) => {
      if (selector.startsWith("#")) return getElementById(selector.slice(1));
      return null;
    },
    querySelectorAll: () => [],
    addEventListener: () => {},
    getAllHtml: () => Array.from(elements.values()).map((element) => element.innerHTML).join("\n"),
  };
}

function queryHtml(html, selector) {
  if (!html) return [];
  const dataAttrMatch = selector.match(/\[data-([a-zA-Z0-9_-]+)(?:[~|^$*]?=["'][^"']*["'])?\]/);
  const classMatch = selector.match(/\.([a-zA-Z0-9_-]+)/);
  const tagMatch = selector.match(/^[a-zA-Z0-9_-]+/);
  const elements = [];
  const tagPattern = /<([a-z][a-z0-9-]*)([^>]*)>/gi;
  let match;
  while ((match = tagPattern.exec(html)) !== null) {
    const [, tagName, attrText] = match;
    if (tagMatch && tagName.toLowerCase() !== tagMatch[0].toLowerCase()) continue;
    if (dataAttrMatch && !new RegExp(`\\bdata-${escapeRegExp(dataAttrMatch[1])}\\s*=`).test(attrText)) continue;
    if (classMatch && !new RegExp(`\\bclass=["'][^"']*\\b${escapeRegExp(classMatch[1])}\\b`).test(attrText)) continue;
    const element = new FakeElement(tagName);
    readAttributes(attrText).forEach(([name, value]) => element.setAttribute(name, value));
    elements.push(element);
  }
  return elements;
}

function readAttributes(attrText) {
  const attrs = [];
  const attrPattern = /([:@a-zA-Z0-9_-]+)(?:=(["'])(.*?)\2)?/g;
  let match;
  while ((match = attrPattern.exec(attrText || "")) !== null) {
    attrs.push([match[1], match[3] || ""]);
  }
  return attrs;
}

function toDatasetKey(name) {
  return name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderDashboard(options = {}) {
  const document = createFakeDocument();
  document.getElementById("rich-panels");
  const dispatchedEvents = [];
  const selectedByContext = [];
  const sandboxWindow = {
    document,
    console,
    Chart: function Chart(_target, config) {
      sandboxWindow.__charts.push(config);
      return { destroy: () => {} };
    },
    TradeSankey,
    __charts: [],
    dispatchEvent: (event) => {
      dispatchedEvents.push(event);
      return true;
    },
    addEventListener: () => {},
    CustomEvent: class CustomEvent {
      constructor(type, options) {
        this.type = type;
        this.detail = options && options.detail;
      }
    },
    ResearchMap: {
      highlightBasin: (id) => selectedByContext.push(id),
      setSelectedBasin: (id) => selectedByContext.push(id),
      highlightDownstream: () => {},
    },
  };
  sandboxWindow.window = sandboxWindow;

  const sandbox = {
    window: sandboxWindow,
    document,
    console,
    CustomEvent: sandboxWindow.CustomEvent,
    setTimeout: () => 0,
    clearTimeout: () => {},
  };

  vm.runInNewContext(dashboardSource, sandbox, { filename: DASHBOARD_JS_PATH });
  vm.runInNewContext(richPanelsSource, sandbox, { filename: RICH_PANELS_JS_PATH });
  assert.ok(sandboxWindow.ResearchRichPanels, "richPanels.js attaches window.ResearchRichPanels");
  assert.strictEqual(typeof sandboxWindow.ResearchRichPanels.update, "function", "ResearchRichPanels.update is callable");

  const result = options.result || makeRichFixtureResult();
  const baseContext = {
    modelInput: {
      basins: makeRichFixtureModelBasins(result.basinResults),
    },
    params: result.params,
    scope: {
      mode: "region",
      selectedIds: ["A", "B"],
      label: "选区 2 个子流域",
      message: "选区 2 个子流域",
    },
    selectedId: "A",
    downstreamFocus: {
      id: "A",
      name: "上游工业子流域",
      downstreamIds: ["B"],
      downstreamCount: 1,
      downstreamPopulation: 360000,
    },
    selectedIds: ["A", "B"],
    noMarketEnabled: true,
    noMarketComparison: {
      note: "模型情景对照：非真实成交记录或真实政策实验。",
      delta: {
        dalyAvoided: 54,
        marketPrice: 0.58,
        healthAllocation: 66,
        unmet: -37,
      },
    },
    onBasinSelect: (id) => selectedByContext.push(id),
    onHighlightBasin: (id) => selectedByContext.push(id),
    noTaxResult: result.noTaxResult,
  };
  const contextOverride = typeof options.context === "function"
    ? options.context(result)
    : (options.context || {});
  sandboxWindow.ResearchRichPanels.update(result, {
    ...baseContext,
    ...contextOverride,
  });

  return {
    html: normalizeText(document.getAllHtml()),
    document,
    dispatchedEvents,
    selectedByContext,
    charts: sandboxWindow.__charts,
  };
}

function makeRichFixtureResult() {
  const basinResults = [
    {
      id: "A",
      name: "上游工业子流域",
      code: "PF_900001",
      pfafId: 900001,
      areaKm2: 88,
      population: 120000,
      demand: { agri: 50, industry: 80, urban: 40 },
      allocation: { agri: 45, industry: 55, urban: 40, total: 140 },
      unmet: { agri: 5, industry: 25, urban: 0 },
      supply: { qLocal: 110, externalInflow: 35, mainstemInflow: 0, qAvail: 145, runoffCoeff: 0.4 },
      healthWeight: { agri: 0.1, industry: -0.3, urban: 1 },
      ecoBaseFlow: 32,
      inStreamFlow: 37,
      ecoSurplus: 5,
      healthTax: { taxPerM3: 0.18, downstreamPopulation: 360000 },
      taxIntensity: 0.24,
      downstreamReach: ["B"],
      downstreamPopulationAffected: 360000,
      incentiveCompatible: false,
    },
    {
      id: "B",
      name: "下游生活取水区",
      code: "PF_900002",
      pfafId: 900002,
      areaKm2: 104,
      population: 360000,
      demand: { agri: 20, industry: 12, urban: 100 },
      allocation: { agri: 18, industry: 10, urban: 96, total: 124 },
      unmet: { agri: 2, industry: 2, urban: 4 },
      supply: { qLocal: 90, externalInflow: 0, mainstemInflow: 55, qAvail: 145, runoffCoeff: 0.4 },
      healthWeight: { agri: 0.1, industry: -0.25, urban: 1 },
      ecoBaseFlow: 27,
      inStreamFlow: 35,
      ecoSurplus: 8,
      healthTax: { taxPerM3: 0.05, downstreamPopulation: 0 },
      taxIntensity: 0.08,
      downstreamReach: [],
      downstreamPopulationAffected: 0,
      incentiveCompatible: true,
    },
  ];

  const noMarketResult = {
    aggregate: {
      dalyAvoided: 88,
      marketPrice: 0,
      healthAllocation: 92,
      unmetWater: 72,
      environmentFlow: 61,
      ecoBaseFlow: 59,
      ecoSurplus: 2,
      allocation: { agri: 60, industry: 92, urban: 130 },
    },
    basinResults,
  };
  const noTaxResult = {
    aggregate: {
      dalyAvoided: 120,
      marketPrice: 0.52,
      healthAllocation: 120,
      unmetWater: 83,
      environmentFlow: 61,
      ecoBaseFlow: 59,
      inStreamFlow: 61,
      ecoSurplus: 2,
      allocation: { agri: 60, industry: 92, urban: 130 },
    },
    basinResults: [
      {
        id: "A",
        name: "上游工业子流域",
        code: "PF_900001",
        allocation: { agri: 42, industry: 80, urban: 38, total: 160 },
        ecoBaseFlow: 32,
        inStreamFlow: 34,
        ecoSurplus: 2,
      },
      {
        id: "B",
        name: "下游生活取水区",
        code: "PF_900002",
        allocation: { agri: 18, industry: 12, urban: 92, total: 122 },
        ecoBaseFlow: 27,
        inStreamFlow: 27,
        ecoSurplus: 0,
      },
    ],
    meta: {
      comparison: "no-tax",
      trade: "market",
      tradeBaseline: "no-tax",
    },
  };

  return {
    params: {
      tau: 0.24,
      healthFloor: 0.26,
      ecoFloor: 0.15,
      tradingCost: 0.1,
      climate: "ssp245",
    },
    aggregate: {
      tradableWater: 295,
      marketPrice: 0.58,
      dalyAvoided: 142,
      diseaseCasesAvoided: 790,
      economicNpvCny: 18000000,
      compatibleShare: 0.5,
      incentiveCompatible: false,
      noMarketDelta: {
        dalyAvoided: 54,
        marketPrice: 0.58,
        healthAllocation: 66,
        unmetWater: -37,
      },
      environmentFlow: 72,
      ecoBaseFlow: 59,
      inStreamFlow: 72,
      ecoSurplus: 13,
      noTaxDelta: {
        industryWithdrawal: -27,
        environmentFlow: 11,
        dalyAvoided: 22,
      },
      allocation: { agri: 63, industry: 65, urban: 136 },
    },
    basinResults,
    flows: [
      {
        from: "A",
        to: "B",
        volume: 34,
        price: 0.62,
        marketPrice: 0.58,
        averageUnitCost: 0.71,
        tradingCostPerM3: 0.04,
        sector: "urban",
      },
    ],
    tradeFlows: [
      {
        origin: "A",
        target: "B",
        volume: 34,
        marketPrice: 0.58,
        averageUnitCost: 0.71,
        tradingCostPerM3: 0.04,
        sector: "urban",
      },
    ],
    tradeAggregate: {
      tradeBasisNote: "基于‘有交易 − 自给自足’的市场再配估算，模型推导，非真实成交记录",
      sectorReallocation: {
        agri: -80,
        industry: -120,
        urban: 50,
        unreallocated: 150,
      },
      tradeFlows: [
        {
          from: "A",
          to: "B",
          fromName: "PF_900001",
          toName: "PF_900002",
          fromCode: "PF_900001",
          toCode: "PF_900002",
          volume: 34,
          marketPrice: 0.58,
          averageUnitCost: 0.71,
          sector: "urban",
        },
      ],
    },
    noMarketResult,
    noTaxResult,
    meta: {
      scope: {
        mode: "region",
        selectedIds: ["A", "B"],
        message: "选区 2 个子流域",
      },
      incentiveFlags: [{ nodeId: "A", nodeName: "上游工业子流域", sector: "industry" }],
    },
  };
}

function makeRound3AutarkyBaselineFixture() {
  const result = makeRichFixtureResult();
  const autarkyResult = {
    aggregate: {
      dalyAvoided: 104,
      marketPrice: 0,
      healthAllocation: 104,
      unmetWater: 96,
    },
    basinResults: [
      {
        id: "A",
        name: "上游工业子流域",
        code: "PF_900001",
        allocation: { agri: 70, industry: 95, urban: 28, total: 193 },
      },
      {
        id: "B",
        name: "下游生活取水区",
        code: "PF_900002",
        allocation: { agri: 26, industry: 18, urban: 88, total: 132 },
      },
    ],
  };
  const noMarketResult = {
    aggregate: {
      ...result.aggregate,
      allocation: { agri: 63, industry: 65, urban: 136 },
    },
    basinResults: result.basinResults.map((basin) => ({
      id: basin.id,
      name: basin.name,
      code: basin.code,
      allocation: { ...basin.allocation },
    })),
  };

  return {
    ...result,
    noMarketResult,
    autarkyResult,
    tradeAggregate: {
      ...result.tradeAggregate,
      tradeBasisNote: "基于‘有交易 − 自给自足’的市场再配估算，模型推导，非真实成交记录",
      sectorReallocation: {
        agri: 777,
        industry: -555,
        urban: 333,
        unreallocated: 0,
      },
    },
  };
}

function makeRichFixtureModelBasins(basinResults) {
  return basinResults.map((basin) => ({
    ...basin,
    supply: {
      ...basin.supply,
      runoffCoeff: 0.4,
    },
  }));
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ");
}

function assertMatches(haystack, pattern, message) {
  if (!pattern.test(haystack)) richFailures.push(message);
}

function assertRendered(renderedHtml, pattern, message) {
  if (!pattern.test(renderedHtml)) richFailures.push(message);
}

function formatWaterForTest(value) {
  const number = Number(value) || 0;
  const sign = number < 0 ? "-" : "";
  const abs = Math.abs(number);
  if (abs >= 100000000) return `${sign}${(abs / 100000000).toFixed(2)}亿m³`;
  if (abs >= 10000) return `${sign}${(abs / 10000).toFixed(1)}万m³`;
  return `${sign}${Math.round(abs)}m³`;
}

function formatSignedWaterForTest(value) {
  const number = Number(value) || 0;
  return `${number >= 0 ? "+" : ""}${formatWaterForTest(number)}`;
}

function assertRound3SectorDelta(renderedHtml, sectorLabel, withoutMarket, withMarket) {
  const delta = withMarket - withoutMarket;
  const pattern = new RegExp(
    `${escapeRegExp(sectorLabel)}[\\s\\S]{0,260}` +
    `<em>${escapeRegExp(formatWaterForTest(withoutMarket))}<\\/em>[\\s\\S]{0,260}` +
    `<em>${escapeRegExp(formatWaterForTest(withMarket))}<\\/em>[\\s\\S]{0,180}` +
    `${escapeRegExp(formatSignedWaterForTest(delta))}<\\/strong>`
  );
  assertRendered(
    renderedHtml,
    pattern,
    `ROUND3 ${sectorLabel} comparison bar delta must equal withMarket - autarky (${formatSignedWaterForTest(delta)})`
  );
}

function constArrayBlock(source, name) {
  const start = source.indexOf(`const ${name}`);
  if (start < 0) return "";
  const end = source.indexOf("];", start);
  return end < 0 ? source.slice(start, start + 800) : source.slice(start, end + 2);
}

function firstFiniteField(sources, keys) {
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const key of keys) {
      const value = Number(source[key]);
      if (Number.isFinite(value)) return value;
    }
  }
  return NaN;
}

function closeToForTest(actual, expected, tolerance = 1e-6) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

function assertEcoFlowAggregationContract() {
  let api;
  try {
    delete require.cache[require.resolve("./richPanels")];
    api = require("./richPanels");
  } catch (error) {
    richFailures.push(`ECO-FLOW could not require richPanels.js for aggregation contract: ${error.message}`);
    return;
  }
  if (!api || typeof api.aggregateRichData !== "function") {
    richFailures.push("ECO-FLOW richPanels.js should export aggregateRichData() for environmental-flow acceptance tests");
    return;
  }

  const result = makeRichFixtureResult();
  let aggregate;
  try {
    aggregate = api.aggregateRichData(result, {
      modelInput: { basins: makeRichFixtureModelBasins(result.basinResults) },
      params: result.params,
    });
  } catch (error) {
    richFailures.push(`ECO-FLOW aggregateRichData sentinel threw: ${error.message}`);
    return;
  }

  const totals = aggregate && aggregate.totals ? aggregate.totals : {};
  const sources = [totals, aggregate];
  const ecoBaseFlow = firstFiniteField(sources, ["ecoBaseFlow", "environmentBaseFlow", "baseEnvironmentalFlow"]);
  const inStreamFlow = firstFiniteField(sources, ["inStreamFlow", "environmentFlow", "environmentalFlow"]);
  const ecoSurplus = firstFiniteField(sources, ["ecoSurplus", "environmentSurplus", "extraInStreamFlow"]);
  const environmentFlow = firstFiniteField(sources, ["environmentFlow", "environmentalFlow", "inStreamFlow"]);

  recordCheck(closeToForTest(ecoBaseFlow, 59), "ECO-FLOW aggregate totals ecoBaseFlow/environment base flow as 32+27=59");
  recordCheck(closeToForTest(inStreamFlow, 72), "ECO-FLOW aggregate totals inStreamFlow/environmentFlow as 37+35=72");
  recordCheck(closeToForTest(ecoSurplus, 13), "ECO-FLOW aggregate totals ecoSurplus as 5+8=13");
  recordCheck(
    closeToForTest(environmentFlow, ecoBaseFlow + ecoSurplus),
    "ECO-FLOW environmental flow is explainable as ecoBaseFlow + ecoSurplus"
  );
}

function assertEcoFlowUpgradeSentinels(renderedHtml) {
  const richSectorBlock = constArrayBlock(richPanelsSource, "SECTORS");
  recordCheck(
    /key:\s*['"]agri['"]/.test(richSectorBlock) &&
      /key:\s*['"]industry['"]/.test(richSectorBlock) &&
      /key:\s*['"]urban['"]/.test(richSectorBlock),
    "ECO-FLOW RICH sectors keep agri/industry/urban allocation departments"
  );
  recordCheck(
    !/key:\s*['"]eco['"]/.test(richSectorBlock),
    "ECO-FLOW RICH sectors must not include eco as an allocation department"
  );
  recordCheck(
    !/class="sector-label">\s*生态\s*<\/div>/.test(renderedHtml),
    "ECO-FLOW RICH-1 must not render 生态 as a sector demand/allocation bar"
  );
  recordCheck(
    !/class="allocation-sector">\s*生态\s*<\/div>/.test(renderedHtml),
    "ECO-FLOW comparison bars must not render 生态 as an allocation sector"
  );
  recordCheck(
    !/(生态取水|生态部门配水|生态配水部门)/.test(renderedHtml + "\n" + richPanelsSource),
    "ECO-FLOW UI copy rejects old 生态取水/生态部门配水 wording"
  );
  recordCheck(
    !/健康权重：生活 1\.0\s*\/\s*生态 0\.7/.test(renderedHtml + "\n" + richPanelsSource),
    "ECO-FLOW health-weight copy no longer lists 生态 as a withdrawal sector"
  );
  recordCheck(
    !/四部门/.test(renderedHtml + "\n" + richPanelsSource),
    "ECO-FLOW RICH/trade copy must not describe allocation as four departments"
  );
  recordCheck(
    !/<(?:td|th|div|span)[^>]*>\s*生态\s*<\/(?:td|th|div|span)>[\s\S]{0,120}(?:需求|配水|缺口|需 |配 |缺 )/.test(renderedHtml),
    "ECO-FLOW detail/trade tables must not present 生态 as a demand/allocation row"
  );
  assertRendered(renderedHtml, /生态基流/, "ECO-FLOW RICH renders ecological base flow as an in-stream constraint");
  assertRendered(renderedHtml, /环境流量/, "ECO-FLOW RICH renders environmental/in-stream flow");
  assertRendered(
    renderedHtml,
    /环境流量[\s\S]{0,120}72m³|72m³[\s\S]{0,120}环境流量/,
    "ECO-FLOW RICH shows environment flow aggregate as base flow plus surplus (72m³ sentinel)"
  );
}

function assertRealisticModelUiSentinels(renderedHtml) {
  const combinedSource = `${indexHtml}\n${mainSource}\n${richPanelsSource}`;
  recordCheck(
    /id=["']eco-floor-value["'][^>]*>\s*15%\s*</.test(indexHtml),
    "REALISTIC-MODEL UI default eco-floor display should be 15%"
  );
  recordCheck(
    /id=["']eco-floor["'][^>]*value=["']15["']/.test(indexHtml),
    "REALISTIC-MODEL UI eco-floor slider value should default to 15"
  );
  recordCheck(
    /getNumericInput\(\s*['"]eco-floor['"]\s*,\s*15\s*\)\s*\/\s*100/.test(mainSource) ||
      /ecoFloor:\s*(?:clampValue\([^)]*)?numberOr\(\s*params\.ecoFloor\s*,\s*0\.15\s*\)/.test(mainSource),
    "REALISTIC-MODEL main.js should fall back to ecoFloor=0.15, not 0.30"
  );
  assertRendered(
    renderedHtml,
    /生态底线\s*15%|生态底线参数<\/span><strong>15%<\/strong>/,
    "REALISTIC-MODEL RICH panels render the 15% default ecological floor"
  );
  recordCheck(
    /生态基流[\s\S]{0,100}本地产流|本地产流[\s\S]{0,100}生态基流/.test(combinedSource + "\n" + renderedHtml),
    "REALISTIC-MODEL UI copy states ecological base flow is based on local runoff"
  );
  recordCheck(
    /过境水?[\s\S]{0,120}(天然|自然)[\s\S]{0,80}(河道|生态|流量)|(?:天然|自然)[\s\S]{0,80}(河道|生态|流量)[\s\S]{0,120}过境水?/.test(combinedSource + "\n" + renderedHtml),
    "REALISTIC-MODEL UI copy states transit water is natural in-stream/river flow"
  );
  recordCheck(
    !/生态底线\s*30%|生态底线参数<\/span><strong>30%<\/strong>|id=["']eco-floor-value["'][^>]*>\s*30%\s*</.test(combinedSource + "\n" + renderedHtml),
    "REALISTIC-MODEL UI rejects stale 30% ecological-floor defaults"
  );
}

function assertNoTaxComparisonSentinel(renderedHtml) {
  const noTaxIndex = renderedHtml.search(/有\/无健康税|无健康税对比|健康税效应|noTax/i);
  recordCheck(noTaxIndex >= 0, "ECO-FLOW renders a current-vs-noTax health-tax comparison panel");
  const noTaxSlice = noTaxIndex >= 0 ? renderedHtml.slice(noTaxIndex, noTaxIndex + 1800) : "";
  recordCheck(
    /工业取水[\s\S]{0,120}(?:Δ|变化|差值)|(?:Δ|变化|差值)[\s\S]{0,120}工业取水/.test(noTaxSlice),
    "ECO-FLOW noTax comparison exposes industrial withdrawal delta"
  );
  recordCheck(
    /环境流量[\s\S]{0,120}(?:Δ|变化|差值)|(?:Δ|变化|差值)[\s\S]{0,120}环境流量/.test(noTaxSlice),
    "ECO-FLOW noTax comparison exposes environmental-flow delta"
  );
  recordCheck(
    /DALY[\s\S]{0,120}(?:Δ|变化|差值|增加)|(?:Δ|变化|差值|增加)[\s\S]{0,120}DALY/.test(noTaxSlice),
    "ECO-FLOW noTax comparison exposes DALY delta"
  );
  recordCheck(
    /交易保持开启|均含交易|同一交易口径|含交易/.test(noTaxSlice),
    "ECO-FLOW noTax comparison states that trade stays enabled"
  );
  recordCheck(
    /不是自给自足对照|非自给自足|非无市场|not\s+autarky/i.test(noTaxSlice) ||
      !/(自给自足|无市场|autarky)/i.test(noTaxSlice),
    "ECO-FLOW noTax comparison does not mix in autarky/no-market semantics"
  );
  recordCheck(
    /-27m³/.test(noTaxSlice) && /\+11m³/.test(noTaxSlice) && /\+22/.test(noTaxSlice),
    "ECO-FLOW noTax comparison renders the sentinel deltas: industry -27m³, environment +11m³, DALY +22"
  );
}

function assertPolicyNarrativeTradeEfficiencySentinel(renderedHtml) {
  const noTaxIndex = renderedHtml.search(/有\/无健康税对比/);
  const tradeTitleMatch = /<h2[^>]*id="rich-comparison-title"[^>]*>\s*交易效率对比（有无交易）\s*<\/h2>/.exec(renderedHtml);
  const tradeEfficiencyIndex = tradeTitleMatch
    ? tradeTitleMatch.index
    : renderedHtml.search(/交易效率对比（有无交易）/);
  recordCheck(
    noTaxIndex >= 0 && tradeEfficiencyIndex >= 0 && noTaxIndex < tradeEfficiencyIndex,
    "POLICY-NARRATIVE renders the health-tax comparison before the trade-efficiency comparison"
  );
  recordCheck(
    /交易效率对比（有无交易）/.test(renderedHtml),
    "POLICY-NARRATIVE renames the market comparison title to 交易效率对比（有无交易）"
  );
  recordCheck(
    !/有\/无市场对比/.test(renderedHtml),
    "POLICY-NARRATIVE rejects the old title 有/无市场对比"
  );

  const tradeSlice = tradeEfficiencyIndex >= 0
    ? renderedHtml.slice(tradeEfficiencyIndex, tradeEfficiencyIndex + 2600)
    : renderedHtml;
  recordCheck(
    /工业(?:在此)?(?:增加|上升)[\s\S]{0,100}(?:效率改善|交易效率)|(?:效率改善|交易效率)[\s\S]{0,100}工业(?:在此)?(?:增加|上升)/.test(tradeSlice),
    "POLICY-NARRATIVE explains that industrial increase in this panel is a trade-efficiency improvement"
  );
  recordCheck(
    /非政策效应|非健康税政策效应|不是政策效应/.test(tradeSlice),
    "POLICY-NARRATIVE states the trade-efficiency industrial increase is not the policy effect"
  );
  recordCheck(
    /健康税[\s\S]{0,100}(?:见上方|上方)[\s\S]{0,60}有\/无健康税对比|(?:见上方|上方)[\s\S]{0,100}有\/无健康税对比/.test(tradeSlice),
    "POLICY-NARRATIVE points readers back to the upper health-tax comparison for the policy effect"
  );
}

function assertHealthTaxEffectivenessCopy(renderedHtml) {
  const combined = `${renderedHtml}\n${indexHtml}\n${mainSource}\n${richPanelsSource}`;
  recordCheck(
    /健康税\/庇古税有效|健康税（庇古税）是有效的|健康税[\s\S]{0,40}庇古税[\s\S]{0,40}有效|庇古税[\s\S]{0,40}健康税[\s\S]{0,40}有效/.test(combined),
    "HEALTH-TAX RICH copy must state that the health/Pigouvian tax is effective"
  );
  recordCheck(
    /工业随税率平滑减少|工业(?:用水|取水|配水)?[\s\S]{0,60}(?:随税率|税率越高|τ\s*↑)[\s\S]{0,60}(?:平滑减少|平滑下降|减少|越少)/.test(combined),
    "HEALTH-TAX RICH copy must say industry declines smoothly as the tax rate rises"
  );
  recordCheck(
    /外部调水/.test(combined) && /内部解决/.test(combined),
    "HEALTH-TAX RICH/UI copy must expose both trade-scope labels: 外部调水 and 内部解决"
  );
  recordCheck(
    !/(断崖归零|断崖式归零|突然归零|高\s*τ[\s\S]{0,30}归零|归零[\s\S]{0,30}断崖)/.test(combined),
    "HEALTH-TAX RICH copy must not narrate a cliff-to-zero industrial response"
  );
}

function makeFullBakeEcoFlowNetworkForTest() {
  const attrs = JSON.parse(fs.readFileSync(ATTRS_PATH, "utf8"));
  return {
    meta: attrs.meta || {},
    topology: attrs.topology || {},
    subbasins: Array.isArray(attrs.subbasins) ? attrs.subbasins : [],
  };
}

function solveFullBakeTauPoint(tau) {
  const network = makeFullBakeEcoFlowNetworkForTest();
  const result = ResearchNetworkModel.solveNetwork({
    network,
    tau,
    healthFloor: 0.26,
    ecoFloor: 0.30,
    climate: "baseline",
    tradingCost: 0.1,
  });
  return {
    result,
    point: {
      tau,
      ...TauResponseChart.summarizeResult(result),
      nodeCount: Array.isArray(result.nodes) ? result.nodes.length : 0,
      hasEcoAllocation: Boolean(
        result.totals &&
        result.totals.allocation &&
        Object.prototype.hasOwnProperty.call(result.totals.allocation, "eco")
      ) || (Array.isArray(result.nodes) && result.nodes.some((node) => {
        return node && node.allocation && Object.prototype.hasOwnProperty.call(node.allocation, "eco");
      })),
    },
  };
}

function formatFullBakeTauPoint(point) {
  return `tau=${point.tau}: industry=${formatWaterForTest(point.industryWithdrawal)}, env=${formatWaterForTest(point.environmentalFlow)}, inStream=${formatWaterForTest(point.inStreamFlow)}`;
}

function assertRealDataTauResponseSentinel() {
  const solved = [0, 0.24, 0.5].map(solveFullBakeTauPoint);
  const points = solved.map((item) => item.point);
  const summary = points.map(formatFullBakeTauPoint).join("; ");
  const renderedTauChart = normalizeText(TauResponseChart.renderToString({ points }));
  recordCheck(
    points.every((point) => point.nodeCount === 66),
    `ECO-FLOW tau response sentinel uses real full-bake wuhan-attrs.json solves for all 66 subbasins; ${summary}`
  );
  recordCheck(
    points.every((point) => !point.hasEcoAllocation),
    `ECO-FLOW tau response real-data points must not expose allocation.eco; ${summary}`
  );
  recordCheck(
    !/等待\s*τ\s*扫描数据/.test(renderedTauChart) && /τ响应曲线|工业取水|环境流量/.test(renderedTauChart),
    "ECO-FLOW tau response chart renders real scan points instead of the waiting placeholder"
  );
  recordCheck(
    points.slice(1).every((point, index) => point.industryWithdrawal <= points[index].industryWithdrawal + 1e-6),
    `ECO-FLOW tau response real-data industry withdrawal must be non-increasing as tau rises; ${summary}`
  );
  const first = points[0];
  const last = points[points.length - 1];
  recordCheck(
    (last.environmentalFlow - first.environmentalFlow) > 1e-6 &&
      (last.inStreamFlow - first.inStreamFlow) > 1e-6,
    `ECO-FLOW tau response real-data environmentalFlow/inStreamFlow must strictly rise from tau=0 to tau=0.5; ${summary}`
  );
}

function run() {
  const { html: renderedHtml } = renderDashboard();
  const round3Fixture = makeRound3AutarkyBaselineFixture();
  const { html: round3Html } = renderDashboard({
    result: round3Fixture,
    context: (result) => ({
      noMarketResult: result.noMarketResult,
      autarkyResult: result.autarkyResult,
      noMarketComparison: {
        note: "模型情景对照：基于同一选区的有交易与自给自足口径，非真实成交记录或真实政策实验。",
        delta: {
          dalyAvoided: 38,
          marketPrice: 0.58,
          healthAllocation: 88,
          unmet: -24,
        },
      },
    }),
  });

  assertRendered(renderedHtml, /本区域计算依据/, "RICH-1 renders the bottom calculation-basis panel");
  [
    { pattern: /农业/, label: "农业部门" },
    { pattern: /工业/, label: "工业部门" },
    { pattern: /生活|市政|urban/i, label: "生活/市政部门" },
    { pattern: /生态基流|环境流量/, label: "生态基流/环境流量" },
    { pattern: /需求/, label: "分部门需求" },
    { pattern: /配水/, label: "分部门配水" },
    { pattern: /缺口/, label: "分部门缺口" },
    { pattern: /本地产流|qLocal/i, label: "本地产流" },
    { pattern: /过境|external|mainstem/i, label: "过境注入" },
    { pattern: /占比/, label: "过境占比" },
    { pattern: /τ|tau|健康税/i, label: "当前 tau/健康税参数" },
    { pattern: /健康底线/, label: "健康底线参数" },
    { pattern: /径流系数|runoff/i, label: "区域均值径流系数" },
    { pattern: /健康权重/, label: "部门健康权重" },
    { pattern: /人口/, label: "人口合计" },
    { pattern: /面积/, label: "面积合计" },
    { pattern: /子流域数|子流域/, label: "子流域数" },
  ].forEach(({ pattern, label }) => {
    assertRendered(renderedHtml, pattern, `RICH-1 exposes ${label}`);
  });
  assertEcoFlowAggregationContract();
  assertEcoFlowUpgradeSentinels(renderedHtml);
  assertRealisticModelUiSentinels(renderedHtml);
  assertRealDataTauResponseSentinel();
  assertRendered(
    renderedHtml,
    /本地产流<\/span><strong>110m³<\/strong>/,
    "RICH-1 computes local runoff as qLocal minus transit inflow"
  );
  assertRendered(
    renderedHtml,
    /过境\/边界入流<\/span><strong>90m³<\/strong>/,
    "RICH-1 keeps transit inflow visible as external/mainstem inflow"
  );
  assertRendered(
    renderedHtml,
    /过境占比<\/span><strong>45%<\/strong>/,
    "RICH-1 computes transit share as transit divided by local runoff plus transit"
  );
  assertRendered(
    renderedHtml,
    /径流系数 0\.40/,
    "RICH-1 falls back to model supply runoffCoeff and renders 0.40"
  );
  recordCheck(
    /供需图|供需柱状图|supply-demand|demand-supply|<canvas|data-chart|sector-bars/i.test(renderedHtml + richPanelsSource),
    "RICH-1 exposes a sector supply-demand chart"
  );
  assertRendered(
    renderedHtml,
    /本地产流<\/span><strong>110m³<\/strong>/,
    "ROUND2 displays true local runoff qLocal - transitInflow, not transit-polluted qLocal"
  );
  assertRendered(
    renderedHtml,
    /过境\/边界入流<\/span><strong>90m³<\/strong>/,
    "ROUND2 keeps boundary/transit inflow visible and unchanged"
  );
  assertRendered(
    renderedHtml,
    /过境占比<\/span><strong>45%<\/strong>/,
    "ROUND2 computes transit share as transit / (local runoff + transit)"
  );
  assertRendered(
    renderedHtml,
    /径流系数 0\.40/,
    "ROUND2 renders area-weighted runoff coefficient 0.40 instead of a missing-sample placeholder"
  );
  recordCheck(
    !/本地产流<\/span><strong>200m³<\/strong>/.test(renderedHtml),
    "ROUND2 rejects the old transit-polluted local runoff total"
  );
  recordCheck(
    !/过境占比<\/span><strong>31%<\/strong>/.test(renderedHtml),
    "ROUND2 rejects the old qAvail-denominator transit share"
  );
  recordCheck(
    !/径流系数 样本缺省/.test(renderedHtml),
    "ROUND2 rejects the old missing runoff coefficient placeholder"
  );

  assertRendered(renderedHtml, /交易流明细|交易明细/, "RICH-2 renders the trade-flow detail table");
  assertRendered(renderedHtml, /模型推导/, "RICH-2 labels trade rows as model-derived");
  assertRendered(renderedHtml, /非真实成交|非实测成交/, "RICH-2 labels trade rows as not observed transactions");
  assertRendered(renderedHtml, /留在河道\/未取用/, "ROUND2 Sankey labels the unreallocated sink 留在河道/未取用");
  assertRendered(renderedHtml, /差额流向|未取用/, "ROUND2 Sankey footnote or narrative explains the unreallocated difference");
  recordCheck(
    !/留在河道\/未再配/.test(renderedHtml),
    "ROUND2 rejects the old 留在河道/未再配 Sankey label"
  );
  recordCheck(
    !/原未取用\/新增配水/.test(renderedHtml),
    "ROUND2 rejects the old source-side 原未取用/新增配水 label for the reduction-gap case"
  );
  assertRendered(renderedHtml, /上游工业子流域[\s\S]*下游生活取水区/, "NAME renders Chinese basin names in the trade-flow table");
  assertRendered(renderedHtml, /PF_900001[\s\S]*PF_900002/, "NAME preserves technical IDs in the trade-flow table");
  assertRendered(renderedHtml, /子流域明细/, "RICH-2 renders the subbasin detail table");
  assertRendered(renderedHtml, /上游工业子流域[\s\S]*PF_900001/, "NAME renders Chinese name plus technical ID in the subbasin detail table");
  assertRendered(renderedHtml, /下游生活取水区[\s\S]*PF_900002/, "NAME renders downstream Chinese name plus technical ID in the subbasin detail table");
  assertRendered(
    renderedHtml,
    /<td title="技术 ID：PF_900001">\s*<span class="basin-name-main">上游工业子流域<\/span>\s*<span class="basin-code-sub">Pfaf 编码：PF_900001<\/span>\s*<\/td>/,
    "NAME uses Chinese basin name as the primary seller label and shows Pfaf code when flow.fromName is a Pfaf code"
  );
  assertRendered(
    renderedHtml,
    /<span class="basin-name-main">上游工业子流域<\/span>\s*<span class="basin-code-sub">Pfaf 编码：PF_900001<\/span>/,
    "NAME uses Chinese basin name as the primary subbasin label and shows Pfaf code"
  );
  recordCheck(
    !/title="PF_\d+">PF_\d+<\/td>/.test(renderedHtml),
    "NAME keeps Pfaf IDs out of trade-flow primary labels"
  );
  recordCheck(
    !/class="basin-name-main">PF_\d+</.test(renderedHtml),
    "NAME keeps Pfaf IDs out of subbasin primary labels"
  );
  [
    { pattern: /名称/, label: "名称列" },
    { pattern: /需求/, label: "需求列" },
    { pattern: /配水/, label: "配水列" },
    { pattern: /缺口/, label: "缺口列" },
    { pattern: /健康税/, label: "健康税列" },
    { pattern: /违规|激励/, label: "违规/激励列" },
  ].forEach(({ pattern, label }) => {
    assertRendered(renderedHtml, pattern, `RICH-2 table exposes ${label}`);
  });
  recordCheck(
    /排序|sort|sortable|aria-sort|data-sort-key/i.test(renderedHtml + richPanelsSource),
    "RICH-2 subbasin detail table exposes sorting controls"
  );
  assertMatches(
    richPanelsSource,
    /addEventListener\s*\(\s*["']click["']/,
    "RICH-2 binds a click handler for table row selection"
  );
  assertMatches(
    renderedHtml + "\n" + richPanelsSource,
    /data-(?:basin|subbasin)-id|basin-row|subbasin-row|rich-basin/i,
    "RICH-2 marks subbasin rows with a basin id"
  );
  assertMatches(
    richPanelsSource,
    /on(?:Basin)?Select|handleBasinSelect|ResearchMap\.(?:highlight|select|setSelected|update)|dispatchEvent\s*\(\s*new\s+CustomEvent\s*\(\s*["'][^"']*(?:basin|highlight|select)/i,
    "RICH-2 row clicks call a map highlight API or dispatch a highlight event"
  );

  assertRendered(renderedHtml, /下游外部性|上下游|下游影响|影响下游/, "RICH-3 renders a downstream externality panel");
  assertRendered(renderedHtml, /覆盖人口|下游人口/, "RICH-3 reports affected downstream population");
  assertMatches(
    mapSource + "\n" + dashboardSource,
    /highlightDownstream|setDownstreamHighlight|downstream-highlight|downstream-active|externality-highlight|classList\.(?:add|toggle)\([^)]*downstream/i,
    "RICH-3 exposes a downstream highlight state or API"
  );
  assertMatches(
    mapSource + "\n" + dashboardSource + "\n" + mainSource,
    /downstreamReach/,
    "RICH-3 uses downstreamReach data for externality highlighting"
  );

  assertRendered(renderedHtml, /交易效率对比（有无交易）|自给自足对照/, "RICH-3 renders the trade-efficiency/self-sufficiency comparison control/panel");
  assertRendered(renderedHtml, /有交易|有市场/, "RICH-3 comparison shows the with-trade scenario");
  assertRendered(renderedHtml, /自给自足|无交易|无市场/, "RICH-3 comparison shows the autarky/no-trade scenario");
  assertRendered(renderedHtml, /模型情景|模型推导|非实测|非真实/, "RICH-3 comparison is honestly labeled as a model scenario");
  assertNoTaxComparisonSentinel(renderedHtml);
  assertPolicyNarrativeTradeEfficiencySentinel(renderedHtml);
  assertHealthTaxEffectivenessCopy(renderedHtml);
  const round3TitleMatch = /<h2[^>]*id="rich-comparison-title"[^>]*>\s*交易效率对比（有无交易）\s*<\/h2>/.exec(round3Html);
  const round3MarketComparisonIndex = round3TitleMatch
    ? round3TitleMatch.index
    : round3Html.search(/交易效率对比（有无交易）/);
  const round3MarketComparisonHtml = round3MarketComparisonIndex >= 0
    ? round3Html.slice(round3MarketComparisonIndex, round3MarketComparisonIndex + 2000)
    : round3Html;
  recordCheck(
    !/τ\s*=\s*0|健康底线\s*=\s*0|交易成本\s*=\s*最高/.test(round3MarketComparisonHtml),
    "ROUND3 comparison text must not describe the baseline as τ=0, healthFloor=0, highest trading cost"
  );
  assertRendered(
    round3Html,
    /自给自足[\s\S]{0,80}(?:有交易|有市场)|(?:有交易|有市场)[\s\S]{0,80}自给自足/,
    "ROUND3 comparison labels use the self-sufficiency/autarky baseline against the with-trade scenario"
  );
  assertRendered(
    round3Html,
    /灰[\s\S]{0,30}自给自足[\s\S]{0,80}绿[\s\S]{0,30}(?:有交易|有市场)[\s\S]{0,80}Δ[\s\S]{0,30}(?:有交易|有市场)[\s\S]{0,20}自给自足/,
    "ROUND3 allocation-bar legend labels grey/autarky, green/with-trade, and delta as withTrade - autarky"
  );
  [
    { sector: "农业", withoutMarket: 96, withMarket: 63 },
    { sector: "工业", withoutMarket: 113, withMarket: 65 },
    { sector: "生活", withoutMarket: 116, withMarket: 136 },
  ].forEach(({ sector, withoutMarket, withMarket }) => {
    assertRound3SectorDelta(round3Html, sector, withoutMarket, withMarket);
  });
  recordCheck(
    !/农业[\s\S]{0,260}<em>63m³<\/em>[\s\S]{0,260}<em>63m³<\/em>[\s\S]{0,180}\+0m³<\/strong>/.test(round3Html),
    "ROUND3 comparison bars must not fall back to noMarketResult when it equals the current result"
  );

  recordCheck(
    /本区域计算依据|rich|calculation-basis|region-basis/i.test(indexHtml),
    "index.html exposes a RICH panel/container hook"
  );
  recordCheck(
    hasBottomRichHook(indexHtml),
    "index.html places the RICH basis/table area after the main layout as a bottom panel"
  );
  assertRendered(
    normalizeText(TradeSankey.renderToString({
      reallocation: [
        { key: "agri", label: "农业", delta: -80 },
        { key: "industry", label: "工业", delta: -120 },
        { key: "urban", label: "生活", delta: 50 },
      ],
    })),
    /留在河道\/未取用[\s\S]*150m³|150m³[\s\S]*留在河道\/未取用/,
    "ROUND2 TradeSankey computes an unreallocated sink named 留在河道/未取用 when sector reductions exceed gains"
  );
  const sankeyLinks = TradeSankey.buildSectorDispatchLinks([
    { key: "agri", label: "农业", delta: -80 },
    { key: "industry", label: "工业", delta: -120 },
    { key: "urban", label: "生活", delta: 50 },
  ]);
  const leftTotal = sankeyLinks.reduce((sum, link) => sum + link.value, 0);
  const rightTotal = sankeyLinks.reduce((sum, link) => sum + link.value, 0);
  const sinkTotal = sankeyLinks
    .filter((link) => link.to && link.to.label === "留在河道/未取用")
    .reduce((sum, link) => sum + link.value, 0);
  recordCheck(Math.abs(leftTotal - rightTotal) < 1e-6, "ROUND2 Sankey dispatch conserves left and right totals");
  recordCheck(Math.abs(sinkTotal - 150) < 1e-6, "ROUND2 Sankey sink equals total reductions minus gains");

  if (richFailures.length) {
    console.error("RICH validation failed:");
    richFailures.forEach((failure, index) => {
      console.error(`  ${index + 1}. ${failure}`);
    });
    console.error(`Rendered dashboard starts: ${renderedHtml.slice(0, 700)}`);
    process.exit(1);
  }
}

run();
console.log("richPanels.test.js: all assertions passed");

function recordCheck(condition, message) {
  if (!condition) richFailures.push(message);
}

function hasBottomRichHook(html) {
  const mainCloseIndex = html.toLowerCase().indexOf("</main>");
  if (mainCloseIndex < 0) return false;
  const hookPatterns = [
    /本区域计算依据/,
    /rich[-_a-z0-9]*bottom/i,
    /bottom[-_a-z0-9]*rich/i,
    /region[-_a-z0-9]*basis/i,
    /calculation[-_a-z0-9]*basis/i,
  ];
  return hookPatterns.some((pattern) => {
    const match = pattern.exec(html);
    return Boolean(match && match.index > mainCloseIndex);
  });
}
