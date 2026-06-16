#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const RESEARCH_DIR = path.resolve(__dirname, "..");
const HACKATHON_DIR = path.resolve(RESEARCH_DIR, "..");
const ATTRS_PATH = path.join(RESEARCH_DIR, "data", "wuhan-attrs.json");
const INDEX_PATH = path.join(RESEARCH_DIR, "index.html");
const MAIN_JS_PATH = path.join(RESEARCH_DIR, "js", "main.js");
const MAP_JS_PATH = path.join(RESEARCH_DIR, "js", "map.js");
const DASHBOARD_JS_PATH = path.join(RESEARCH_DIR, "js", "dashboard.js");
const RICH_PANELS_JS_PATH = path.join(RESEARCH_DIR, "js", "richPanels.js");
const TAU_RESPONSE_JS_PATH = path.join(RESEARCH_DIR, "js", "tauResponseChart.js");
const CSS_PATH = path.join(RESEARCH_DIR, "css", "style.css");
const METHODOLOGY_PATH = path.join(RESEARCH_DIR, "docs", "methodology.md");
const VALIDATE_DATA_PATH = path.join(RESEARCH_DIR, "tools", "validate_research_data.js");
const NETWORK_MODEL_JS_PATH = path.join(RESEARCH_DIR, "js", "networkModel.js");
const REGION_SELECT_JS_PATH = path.join(RESEARCH_DIR, "js", "regionSelect.js");
const NETWORK_MODEL_TEST_PATH = path.join(RESEARCH_DIR, "js", "networkModel.test.js");
const REGION_SELECT_TEST_PATH = path.join(RESEARCH_DIR, "js", "regionSelect.test.js");
const RICH_PANELS_TEST_PATH = path.join(RESEARCH_DIR, "js", "richPanels.test.js");
const TRADE_AGGREGATE_JS_PATH = path.join(RESEARCH_DIR, "js", "tradeAggregate.js");
const TRADE_AGGREGATE_TEST_PATH = path.join(RESEARCH_DIR, "js", "tradeAggregate.test.js");
const SANKEY_JS_PATH = path.join(RESEARCH_DIR, "js", "sankey.js");
const MARKET_CHART_JS_PATH = path.join(RESEARCH_DIR, "js", "marketChart.js");

const PRE1_INJECTIONS = [
  { id: "PF_465500", externalInflow: 355275000000, label: "Yangtze mainstem entry" },
  { id: "PF_465610", externalInflow: 17553000000, label: "Han River mainstem entry" },
];
const PRE1_EXPECTED_EXTERNAL_INFLOW = PRE1_INJECTIONS.reduce((sum, item) => sum + item.externalInflow, 0);
const PRE1_RELATIVE_TOLERANCE = 0.001;
const TRADE_FLOW_NOISE_THRESHOLD = 300000000000;
const TRADE_FLOW_SENTINEL_BULK_VOLUME = 355275000000;
const TRADE_VIZ_PRICE_EPS = 1e-9;
const ROUND2_EXPECTED_LOCAL_RUNOFF = 28542353226;
const ROUND2_EXPECTED_LOCAL_RUNOFF_YI = 285.42;
const ROUND2_EXPECTED_EXTERNAL_INFLOW = PRE1_EXPECTED_EXTERNAL_INFLOW;
const ROUND2_EXPECTED_TRANSIT_SHARE = 0.9288877392249033;
const ROUND2_EXPECTED_RUNOFF_COEFF = 0.4;
const ROUND2_EXPECTED_SANKEY_UNREALLOCATED = 22.24;
const ECO_FLOW_TAU_GRID = [0, 0.1, 0.24, 0.3, 0.4, 0.5];
const REALISTIC_MODEL_SECTORS = ["urban", "agri", "industry"];
const REALISTIC_MODEL_DEFAULT_PARAMS = Object.freeze({
  tau: 0.24,
  healthFloor: 0.26,
  ecoFloor: 0.15,
  climate: "ssp245",
  tradingCost: 0.1,
});
const REALISTIC_MODEL_STRESS_CLIMATES = ["ssp585", "dry"];
const REALISTIC_MODEL_STRESS_LOW_TAU = 0;
const REALISTIC_MODEL_STRESS_HIGH_TAU = 0.5;
const HEALTH_TAX_DEFAULT_PARAMS = Object.freeze({
  tau: 0.24,
  healthFloor: 0.26,
  ecoFloor: 0.15,
  climate: "ssp245",
  tradingCost: 0.1,
});
const POLICY_DEFAULT_INDUSTRY_WITHDRAWAL_MAX = 4800000000;
const NAME_CITY_LABELS = ["武汉", "黄冈", "孝感", "咸宁", "天门", "潜江", "鄂州", "黄石", "仙桃"];
const NAME_FEATURE_LABELS = ["城区", "农业区", "农业丘陵", "丘陵"];

let failures = 0;
let warnings = 0;

function ok(message) {
  console.log(`OK   ${message}`);
}

function warn(message) {
  warnings += 1;
  console.warn(`WARN ${message}`);
}

function fail(message) {
  failures += 1;
  console.error(`FAIL ${message}`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function withinTolerance(actual, expected) {
  return Math.abs(actual - expected) <= Math.abs(expected) * PRE1_RELATIVE_TOLERANCE;
}

function yiM3(value) {
  return (value / 100000000).toFixed(2);
}

function hasChinese(text) {
  return /[\u3400-\u9fff]/.test(String(text || ""));
}

function isPfafLikeLabel(name, id, pfafId, code) {
  const value = String(name || "").trim();
  if (!value) return true;
  const normalized = value.toLowerCase();
  const identifiers = [id, pfafId, code].filter(Boolean).map((item) => String(item).trim().toLowerCase());
  if (identifiers.includes(normalized)) return true;
  return /\bpfaf(?:stetter)?\b/i.test(value) || /\bPF_\d+\b/.test(value);
}

function hasNamePattern(name) {
  const value = String(name || "");
  return NAME_CITY_LABELS.some((city) => value.includes(city)) &&
    NAME_FEATURE_LABELS.some((feature) => value.includes(feature));
}

function sampleList(items, limit) {
  const shown = items.slice(0, limit).join("; ");
  return items.length > limit ? `${shown}; ... +${items.length - limit} more` : shown;
}

function functionBlock(source, functionName) {
  const start = source.indexOf(`function ${functionName}`);
  if (start < 0) return "";
  const rest = source.slice(start);
  const next = rest.slice(1).search(/\n\s*function\s+\w+/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

function constArrayBlock(source, constName) {
  const start = source.indexOf(`const ${constName}`);
  if (start < 0) return "";
  const end = source.indexOf("];", start);
  return end < 0 ? source.slice(start, start + 1000) : source.slice(start, end + 2);
}

function sourceWindow(source, pattern, radius) {
  const match = pattern.exec(source);
  if (!match) return "";
  const start = Math.max(0, match.index - radius);
  const end = Math.min(source.length, match.index + radius);
  return source.slice(start, end);
}

function checkThreeWithdrawalSectorBlock(label, block) {
  if (!block) {
    fail(`ECO-FLOW could not find ${label} sector block.`);
    return;
  }
  const required = ["urban", "agri", "industry"];
  const missing = required.filter((sector) => !new RegExp(`['"]${sector}['"]`).test(block));
  if (missing.length) {
    fail(`ECO-FLOW ${label} sector block missing required withdrawal sectors: ${missing.join(", ")}.`);
  } else {
    ok(`ECO-FLOW ${label} sector block keeps urban/agri/industry withdrawal sectors`);
  }
  if (/['"]eco['"]/.test(block)) {
    fail(`ECO-FLOW ${label} sector block must not include eco as a withdrawal/allocation sector.`);
  } else {
    ok(`ECO-FLOW ${label} sector block excludes eco as a withdrawal/allocation sector`);
  }
}

function makeFullBakeEcoFlowNetwork() {
  const attrs = readJson(ATTRS_PATH);
  const subbasins = Array.isArray(attrs.subbasins) ? attrs.subbasins : [];
  return {
    meta: attrs.meta || {},
    topology: attrs.topology || {},
    subbasins,
  };
}

function summarizeEcoFlowTauResult(result, tau) {
  const totals = result && result.totals ? result.totals : {};
  const aggregate = result && result.aggregate ? result.aggregate : {};
  const allocation = totals.allocation && typeof totals.allocation === "object" ? totals.allocation : {};
  const demand = totals.demand && typeof totals.demand === "object" ? totals.demand : {};
  const effectiveDemand = totals.effectiveDemand || totals.demandCap || aggregate.effectiveDemand || {};
  const ecoBaseFlow = numberOr(totals.ecoBaseFlow, 0);
  const ecoSurplus = numberOr(totals.ecoSurplus, 0);
  const inStreamFlow = firstNumber(totals.inStreamFlow, totals.outflow, totals.environmentalFlow);
  const environmentalFlow = firstNumber(totals.environmentalFlow, ecoBaseFlow + ecoSurplus, inStreamFlow);
  const hasEcoAllocation = Object.prototype.hasOwnProperty.call(allocation, "eco") ||
    (Array.isArray(result && result.nodes) && result.nodes.some((node) => {
      return node && node.allocation && Object.prototype.hasOwnProperty.call(node.allocation, "eco");
    }));
  return {
    tau,
    industryWithdrawal: numberOr(allocation.industry, NaN),
    industryDemand: numberOr(demand.industry, NaN),
    industryEffectiveDemand: numberOr(effectiveDemand.industry, NaN),
    environmentalFlow,
    inStreamFlow,
    ecoBaseFlow,
    ecoSurplus,
    dalyAvoided: firstNumber(totals.dalyAvoided, totals.totalDalyAvoided, aggregate.dalyAvoided),
    dalyBurden: firstNumber(totals.dalyBurden, aggregate.dalyBurden),
    hasEcoAllocation,
    solverType: result && result.solver && result.solver.type,
    nodeCount: Array.isArray(result && result.nodes) ? result.nodes.length : 0,
  };
}

function formatEcoTauPoint(point) {
  return `tau=${point.tau}: industry=${yiM3(point.industryWithdrawal)}亿m3, env=${yiM3(point.environmentalFlow)}亿m3, inStream=${yiM3(point.inStreamFlow)}亿m3, daly=${point.dalyAvoided}`;
}

function checkDefaultDemandElasticityAcceptance(model) {
  const getter = model && model._internals && model._internals.getDemandElasticity;
  if (typeof getter !== "function") {
    ok("POLICY-NARRATIVE P3 demandElasticity helper is not implemented; default elasticity runtime check is skipped");
    return;
  }
  const actual = getter({});
  if (closeTo(actual, 0.9, 1e-9)) {
    ok("POLICY-NARRATIVE P3 default demandElasticity is 0.9");
  } else {
    fail(`POLICY-NARRATIVE P3 default demandElasticity must be 0.9 when implemented; got ${actual}.`);
  }
}

function meaningfulVolumeDelta(value) {
  return Math.max(Math.abs(numberOr(value, 0)) * 1e-6, 1e-6);
}

function isStrictlyDecreasing(points, key) {
  return points.slice(1).every((point, index) => {
    const previous = numberOr(points[index][key], NaN);
    const current = numberOr(point[key], NaN);
    return Number.isFinite(previous) && Number.isFinite(current) && current < previous - meaningfulVolumeDelta(previous);
  });
}

function isStrictlyIncreasing(points, key) {
  return points.slice(1).every((point, index) => {
    const previous = numberOr(points[index][key], NaN);
    const current = numberOr(point[key], NaN);
    return Number.isFinite(previous) && Number.isFinite(current) && current > previous + meaningfulVolumeDelta(previous);
  });
}

function hasImprovingDalySequence(points) {
  const avoidedImproves = points.every((point) => Number.isFinite(point.dalyAvoided)) &&
    points.slice(1).every((point, index) => point.dalyAvoided >= points[index].dalyAvoided - 1e-6) &&
    points[points.length - 1].dalyAvoided > points[0].dalyAvoided + meaningfulVolumeDelta(points[0].dalyAvoided);
  const burdenDeclines = points.every((point) => Number.isFinite(point.dalyBurden)) &&
    points.slice(1).every((point, index) => point.dalyBurden <= points[index].dalyBurden + 1e-6) &&
    points[points.length - 1].dalyBurden < points[0].dalyBurden - meaningfulVolumeDelta(points[0].dalyBurden);
  return avoidedImproves || burdenDeclines;
}

function checkEcoFlowDynamicTauGridAcceptance() {
  let model;
  try {
    delete require.cache[require.resolve(NETWORK_MODEL_JS_PATH)];
    model = require(NETWORK_MODEL_JS_PATH);
  } catch (error) {
    fail(`ECO-FLOW dynamic tau-grid could not require networkModel.js: ${error.message}`);
    return;
  }
  if (!model || typeof model.solveNetwork !== "function") {
    fail("ECO-FLOW dynamic tau-grid requires networkModel.solveNetwork().");
    return;
  }
  checkDefaultDemandElasticityAcceptance(model);

  const network = makeFullBakeEcoFlowNetwork();
  if (network.subbasins.length === 66) {
    ok("ECO-FLOW dynamic tau-grid uses full-bake wuhan-attrs.json with 66 subbasins");
  } else {
    fail(`ECO-FLOW dynamic tau-grid must use real wuhan-attrs.json full-bake data; got ${network.subbasins.length} subbasins.`);
    return;
  }

  let points;
  try {
    points = ECO_FLOW_TAU_GRID.map((tau) => {
      const result = model.solveNetwork({
        network,
        ...HEALTH_TAX_DEFAULT_PARAMS,
        tau,
      });
      return summarizeEcoFlowTauResult(result, tau);
    });
  } catch (error) {
    fail(`ECO-FLOW dynamic tau-grid full-bake solve threw: ${error.message}`);
    return;
  }

  const summary = points.map(formatEcoTauPoint).join("; ");
  if (points.every((point) => point.nodeCount === 66)) {
    ok("ECO-FLOW dynamic tau-grid solved all 66 real subbasins at each tau point");
  } else {
    fail(`ECO-FLOW dynamic tau-grid should solve 66 nodes at every tau point; ${summary}.`);
  }

  if (points.every((point) => !point.hasEcoAllocation)) {
    ok("ECO-FLOW dynamic tau-grid allocation sectors exclude eco for real full-bake solves");
  } else {
    fail(`ECO-FLOW dynamic tau-grid real solves must not expose allocation.eco; ${summary}.`);
  }

  if (isStrictlyDecreasing(points, "industryWithdrawal")) {
    ok("HEALTH-TAX full-bake industry withdrawal strictly and smoothly declines across the tau grid");
  } else {
    fail(`HEALTH-TAX full-bake industryWithdrawal must strictly decline at tau=[${ECO_FLOW_TAU_GRID.join(",")}]; ${summary}.`);
  }

  const first = points[0];
  const last = points[points.length - 1];
  const current = points.find((point) => point.tau === 0.24);
  if (current && current.industryWithdrawal < first.industryWithdrawal - meaningfulVolumeDelta(first.industryWithdrawal)) {
    ok("HEALTH-TAX default tau=0.24 reduces full-bake industry withdrawal versus tau=0");
  } else {
    fail(`HEALTH-TAX default tau=0.24 must reduce industry versus tau=0; ${summary}.`);
  }
  if (current && current.industryWithdrawal <= POLICY_DEFAULT_INDUSTRY_WITHDRAWAL_MAX + meaningfulVolumeDelta(POLICY_DEFAULT_INDUSTRY_WITHDRAWAL_MAX)) {
    ok(`POLICY-NARRATIVE P3 default tau=0.24 industry withdrawal is <=48亿m3 (${yiM3(current.industryWithdrawal)}亿m3)`);
  } else {
    fail(`POLICY-NARRATIVE P3 default tau=0.24 industry withdrawal must be <=48亿m3; ${summary}.`);
  }

  const maxAdjacentDrop = points.slice(1).reduce((max, point, index) => {
    return Math.max(max, points[index].industryWithdrawal - point.industryWithdrawal);
  }, 0);
  if (last.industryWithdrawal > 0 && last.industryWithdrawal > first.industryWithdrawal * 0.35 && maxAdjacentDrop < first.industryWithdrawal * 0.25) {
    ok("HEALTH-TAX high tau keeps positive non-cliff industry allocation");
  } else {
    fail(`HEALTH-TAX tau=0.5 must remain positive and avoid cliff-to-zero behavior; maxAdjacentDrop=${yiM3(maxAdjacentDrop)}亿m3; ${summary}.`);
  }

  if (isStrictlyIncreasing(points, "environmentalFlow") && isStrictlyIncreasing(points, "inStreamFlow")) {
    ok("HEALTH-TAX full-bake environmentalFlow/inStreamFlow strictly increase across the tau grid");
  } else {
    fail(`HEALTH-TAX full-bake environmentalFlow/inStreamFlow must strictly rise as tau increases; ${summary}.`);
  }

  if (hasImprovingDalySequence(points)) {
    ok("HEALTH-TAX full-bake DALY avoided rises or DALY burden falls across the tau grid");
  } else {
    fail(`HEALTH-TAX full-bake DALY avoided/burden must improve monotonically as tau increases; ${summary}.`);
  }

  let stressPoints;
  try {
    stressPoints = ECO_FLOW_TAU_GRID.map((tau) => {
      const result = model.solveNetwork({
        network,
        ...HEALTH_TAX_DEFAULT_PARAMS,
        climate: "ssp585",
        tau,
      });
      return summarizeEcoFlowTauResult(result, tau);
    });
  } catch (error) {
    fail(`HEALTH-TAX SSP5-8.5 dynamic tau-grid solve threw: ${error.message}`);
    return;
  }
  const stressSummary = stressPoints.map(formatEcoTauPoint).join("; ");
  const stressFirst = stressPoints[0];
  const stressLast = stressPoints[stressPoints.length - 1];
  const stressMaxAdjacentDrop = stressPoints.slice(1).reduce((max, point, index) => {
    return Math.max(max, stressPoints[index].industryWithdrawal - point.industryWithdrawal);
  }, 0);
  if (isStrictlyDecreasing(stressPoints, "industryWithdrawal") &&
      stressLast.industryWithdrawal > 0 &&
      stressLast.industryWithdrawal > stressFirst.industryWithdrawal * 0.35 &&
      stressMaxAdjacentDrop < stressFirst.industryWithdrawal * 0.25) {
    ok("HEALTH-TAX SSP5-8.5 industry withdrawal declines smoothly and stays positive at high tau");
  } else {
    fail(
      "HEALTH-TAX SSP5-8.5 tau grid must avoid cliff-to-zero industrial withdrawal; " +
      `maxAdjacentDrop=${yiM3(stressMaxAdjacentDrop)}亿m3; ${stressSummary}.`
    );
  }
  if (isStrictlyIncreasing(stressPoints, "environmentalFlow") && hasImprovingDalySequence(stressPoints)) {
    ok("HEALTH-TAX SSP5-8.5 environmental flow and DALY response improve across the tau grid");
  } else {
    fail(`HEALTH-TAX SSP5-8.5 environmental/DALY response must improve monotonically; ${stressSummary}.`);
  }
}

function solveHealthTaxDefaultScenario(model, params) {
  return model.solveNetwork({
    network: makeFullBakeEcoFlowNetwork(),
    ...HEALTH_TAX_DEFAULT_PARAMS,
    ...(params || {}),
  });
}

function checkHealthTaxDefaultNoTaxAcceptance() {
  let model;
  try {
    delete require.cache[require.resolve(NETWORK_MODEL_JS_PATH)];
    model = require(NETWORK_MODEL_JS_PATH);
  } catch (error) {
    fail(`HEALTH-TAX default noTax acceptance could not require networkModel.js: ${error.message}`);
    return;
  }

  let noTax;
  let current;
  try {
    noTax = summarizeEcoFlowTauResult(solveHealthTaxDefaultScenario(model, { tau: 0 }), 0);
    current = summarizeEcoFlowTauResult(solveHealthTaxDefaultScenario(model, { tau: 0.24 }), 0.24);
  } catch (error) {
    fail(`HEALTH-TAX default noTax comparison solve threw: ${error.message}`);
    return;
  }

  const industryDelta = current.industryWithdrawal - noTax.industryWithdrawal;
  const environmentDelta = current.environmentalFlow - noTax.environmentalFlow;
  const dalyDelta = current.dalyAvoided - noTax.dalyAvoided;
  if (industryDelta < -meaningfulVolumeDelta(noTax.industryWithdrawal)) {
    ok(`HEALTH-TAX default current-vs-noTax industry delta is negative (${yiM3(industryDelta)} yi m3)`);
  } else {
    fail(`HEALTH-TAX default current-vs-noTax industry delta must be negative; got ${yiM3(industryDelta)} yi m3.`);
  }
  if (environmentDelta > meaningfulVolumeDelta(noTax.environmentalFlow)) {
    ok(`HEALTH-TAX default current-vs-noTax environmental delta is positive (${yiM3(environmentDelta)} yi m3)`);
  } else {
    fail(`HEALTH-TAX default current-vs-noTax environmental delta must be positive; got ${yiM3(environmentDelta)} yi m3.`);
  }
  if (dalyDelta > meaningfulVolumeDelta(noTax.dalyAvoided)) {
    ok(`HEALTH-TAX default current-vs-noTax DALY avoided delta is positive (${dalyDelta})`);
  } else {
    fail(`HEALTH-TAX default current-vs-noTax DALY avoided delta must be positive; got ${dalyDelta}.`);
  }
}

function checkHealthTaxAutarkyAcceptance() {
  let model;
  try {
    delete require.cache[require.resolve(NETWORK_MODEL_JS_PATH)];
    model = require(NETWORK_MODEL_JS_PATH);
  } catch (error) {
    fail(`HEALTH-TAX autarky acceptance could not require networkModel.js: ${error.message}`);
    return;
  }

  let noTax;
  let current;
  try {
    noTax = summarizeEcoFlowTauResult(solveHealthTaxDefaultScenario(model, { tau: 0, trade: "autarky" }), 0);
    current = summarizeEcoFlowTauResult(solveHealthTaxDefaultScenario(model, { tau: 0.24, trade: "autarky" }), 0.24);
  } catch (error) {
    fail(`HEALTH-TAX autarky solve threw: ${error.message}`);
    return;
  }

  const industryDelta = current.industryWithdrawal - noTax.industryWithdrawal;
  if (industryDelta < -meaningfulVolumeDelta(noTax.industryWithdrawal)) {
    ok(`HEALTH-TAX autarky tau=0.24 lowers industry versus tau=0 (${yiM3(industryDelta)} yi m3)`);
  } else {
    fail(`HEALTH-TAX autarky must lower industry at tau=0.24; delta=${yiM3(industryDelta)} yi m3.`);
  }
  if (
    Number.isFinite(current.industryEffectiveDemand) &&
    Number.isFinite(current.industryDemand) &&
    current.industryEffectiveDemand < current.industryDemand - meaningfulVolumeDelta(current.industryDemand) &&
    current.industryWithdrawal <= current.industryEffectiveDemand + meaningfulVolumeDelta(current.industryEffectiveDemand)
  ) {
    ok("HEALTH-TAX autarky respects effective industry demand instead of raw full demand");
  } else {
    fail(
      "HEALTH-TAX autarky must expose and respect an effective industry demand below raw demand; " +
      `allocation=${current.industryWithdrawal}, effective=${current.industryEffectiveDemand}, demand=${current.industryDemand}.`
    );
  }
}

function makeHealthTaxTradeScopeFixture() {
  return {
    topology: {
      OUTSIDE: "A",
      A: "B",
      B: "OUTLET",
    },
    subbasins: [
      {
        id: "OUTSIDE",
        name: "External upstream donor",
        downstream: "A",
        demand: { urban: 0, eco: 0, agri: 0, industry: 0 },
        supply: { qLocal: 100, qOutflow: 100 },
      },
      {
        id: "A",
        name: "Selected industrial basin",
        downstream: "B",
        population: 10000,
        demand: { urban: 10, eco: 0, agri: 5, industry: 100 },
        supply: { qLocal: 200, runoffCoeff: 0.4 },
        healthWeight: { urban: 1, eco: 0.7, agri: 0.1, industry: -0.25 },
      },
      {
        id: "B",
        name: "Selected downstream city",
        downstream: "OUTLET",
        population: 100000,
        demand: { urban: 10, eco: 0, agri: 0, industry: 0 },
        supply: { qLocal: 20, runoffCoeff: 0.4 },
        healthWeight: { urban: 1, eco: 0.7, agri: 0.1, industry: -0.25 },
      },
    ],
  };
}

function sumBoundaryInflow(subnet) {
  const map = subnet && (
    subnet.boundaryInflowByNode ||
    (subnet.meta && subnet.meta.boundaryInflowById) ||
    subnet.boundaryInflow
  ) || {};
  return Object.keys(map).reduce((sum, key) => sum + numberOr(map[key], 0), 0);
}

function solveTradeScopeHealthTaxPoint(model, regionSelect, tradeScope, tau) {
  const subnet = regionSelect.extractSubNetwork(["A", "B"], makeHealthTaxTradeScopeFixture(), { tradeScope });
  const result = model.solveNetwork({
    network: subnet,
    ...HEALTH_TAX_DEFAULT_PARAMS,
    tau,
  });
  return {
    subnet,
    result,
    boundaryInflow: sumBoundaryInflow(subnet),
    summary: summarizeEcoFlowTauResult(result, tau),
  };
}

function checkHealthTaxTradeScopeDynamicAcceptance() {
  let model;
  let regionSelect;
  try {
    delete require.cache[require.resolve(NETWORK_MODEL_JS_PATH)];
    delete require.cache[require.resolve(REGION_SELECT_JS_PATH)];
    model = require(NETWORK_MODEL_JS_PATH);
    regionSelect = require(REGION_SELECT_JS_PATH);
  } catch (error) {
    fail(`HEALTH-TAX tradeScope dynamic acceptance could not require model/regionSelect: ${error.message}`);
    return;
  }
  if (!regionSelect || typeof regionSelect.extractSubNetwork !== "function") {
    fail("HEALTH-TAX tradeScope dynamic acceptance requires ResearchRegionSelect.extractSubNetwork().");
    return;
  }

  let externalNoTax;
  let externalCurrent;
  let internalNoTax;
  let internalCurrent;
  try {
    externalNoTax = solveTradeScopeHealthTaxPoint(model, regionSelect, "external", 0);
    externalCurrent = solveTradeScopeHealthTaxPoint(model, regionSelect, "external", 0.24);
    internalNoTax = solveTradeScopeHealthTaxPoint(model, regionSelect, "internal", 0);
    internalCurrent = solveTradeScopeHealthTaxPoint(model, regionSelect, "internal", 0.24);
  } catch (error) {
    fail(`HEALTH-TAX tradeScope dynamic solve threw: ${error.message}`);
    return;
  }

  if (externalCurrent.boundaryInflow > 0 && externalCurrent.result.totals.externalInflow > 0) {
    ok("HEALTH-TAX tradeScope=external retains boundary inflow and solves");
  } else {
    fail("HEALTH-TAX tradeScope=external must retain positive boundary/external inflow.");
  }
  if (internalCurrent.boundaryInflow === 0 && internalCurrent.result.totals.externalInflow === 0) {
    ok("HEALTH-TAX tradeScope=internal zeros boundary inflow and solves");
  } else {
    fail(
      "HEALTH-TAX tradeScope=internal must zero boundary/external inflow; " +
      `boundary=${internalCurrent.boundaryInflow}, external=${internalCurrent.result.totals.externalInflow}.`
    );
  }
  if (externalCurrent.summary.industryWithdrawal < externalNoTax.summary.industryWithdrawal - meaningfulVolumeDelta(externalNoTax.summary.industryWithdrawal)) {
    ok("HEALTH-TAX tradeScope=external tax reduces industry");
  } else {
    fail("HEALTH-TAX tradeScope=external must reduce industry at tau=0.24.");
  }
  if (internalCurrent.summary.industryWithdrawal < internalNoTax.summary.industryWithdrawal - meaningfulVolumeDelta(internalNoTax.summary.industryWithdrawal)) {
    ok("HEALTH-TAX tradeScope=internal tax reduces industry");
  } else {
    fail("HEALTH-TAX tradeScope=internal must reduce industry at tau=0.24.");
  }
}

function solveRealisticModelScenario(model, params) {
  return model.solveNetwork({
    network: makeFullBakeEcoFlowNetwork(),
    ...REALISTIC_MODEL_DEFAULT_PARAMS,
    ...(params || {}),
  });
}

function resultRows(result) {
  if (Array.isArray(result && result.nodes)) return result.nodes;
  if (Array.isArray(result && result.basinResults)) return result.basinResults;
  if (result && result.raw && Array.isArray(result.raw.nodes)) return result.raw.nodes;
  return [];
}

function sectorMapFromResult(result, fieldName) {
  const direct = result && result.totals && result.totals[fieldName];
  const aggregateDirect = result && result.aggregate && result.aggregate[fieldName];
  const source = direct && typeof direct === "object"
    ? direct
    : (aggregateDirect && typeof aggregateDirect === "object" ? aggregateDirect : null);
  const totals = { urban: 0, agri: 0, industry: 0 };
  if (source) {
    REALISTIC_MODEL_SECTORS.forEach((sector) => {
      totals[sector] = numberOr(source[sector], 0);
    });
    return totals;
  }

  resultRows(result).forEach((row) => {
    const map = row && row[fieldName] && typeof row[fieldName] === "object" ? row[fieldName] : {};
    REALISTIC_MODEL_SECTORS.forEach((sector) => {
      totals[sector] += numberOr(map[sector], 0);
    });
  });
  return totals;
}

function sectorMapSum(map) {
  return REALISTIC_MODEL_SECTORS.reduce((sum, sector) => sum + numberOr(map && map[sector], 0), 0);
}

function readTransitInflow(node) {
  const supply = node && node.supply ? node.supply : {};
  return Math.max(
    0,
    numberOr(node && node.externalInflow, 0),
    numberOr(supply.externalInflow, 0),
    numberOr(node && node.mainstemInflow, 0),
    numberOr(supply.mainstemInflow, 0),
    numberOr(node && node.boundaryInflow, 0),
    numberOr(supply.boundaryInflow, 0)
  );
}

function readLocalEcoBasis(node) {
  const supply = node && node.supply ? node.supply : {};
  const explicit = firstNumber(
    node && node.localRunoff,
    node && node.qLocalRaw,
    node && node.localSupply,
    supply.localRunoff,
    supply.qLocalRaw,
    supply.localSupply
  );
  if (Number.isFinite(explicit)) return Math.max(0, explicit);

  const qLocal = firstNumber(node && node.qLocal, supply.qLocal);
  const transit = readTransitInflow(node);
  if (!Number.isFinite(qLocal)) return NaN;
  if (transit > 0 && qLocal > transit * 1.05) return Math.max(0, qLocal - transit);
  return Math.max(0, qLocal);
}

function readEcoNaturalFlowEvidence(node) {
  const ecoFlow = node && (node.ecoFlow || node.environment || node.ecoBaseFlowDetail);
  return firstNumber(
    node && node.ecoNaturalFlow,
    node && node.ecoBaseFlowNaturalFlow,
    node && node.ecoBaseFlowBasis,
    node && node.naturalFlow,
    ecoFlow && ecoFlow.naturalFlow,
    ecoFlow && ecoFlow.basisFlow,
    ecoFlow && ecoFlow.localSupply
  );
}

function sumMetricIfPresent(rows, keys) {
  let found = false;
  const total = rows.reduce((sum, row) => {
    for (const key of keys) {
      const value = numberOr(row && row[key], NaN);
      if (Number.isFinite(value)) {
        found = true;
        return sum + value;
      }
    }
    return sum;
  }, 0);
  return found ? total : NaN;
}

function resultMetric(result, keys) {
  const rows = resultRows(result);
  const candidates = [];
  keys.forEach((key) => {
    candidates.push(result && result[key]);
    candidates.push(result && result.totals && result.totals[key]);
    candidates.push(result && result.aggregate && result.aggregate[key]);
  });
  candidates.push(sumMetricIfPresent(rows, keys));
  return firstNumber.apply(null, candidates);
}

function summarizeRealisticModelResult(result, params) {
  const allocation = sectorMapFromResult(result, "allocation");
  const demand = sectorMapFromResult(result, "demand");
  const unmet = sectorMapFromResult(result, "unmet");
  const dalyAvoided = resultMetric(result, ["dalyAvoided", "totalDalyAvoided", "dalyAvoidance", "healthGain"]);
  const directDalyBurden = resultMetric(result, ["dalyBurden", "healthBurden", "diseaseBurden"]);
  const dalyBurden = Number.isFinite(directDalyBurden)
    ? directDalyBurden
    : (Number.isFinite(dalyAvoided) ? -dalyAvoided : NaN);
  return {
    params: params || {},
    nodeCount: resultRows(result).length,
    allocation,
    demand,
    unmet,
    totalDemand: sectorMapSum(demand),
    totalUnmet: sectorMapSum(unmet),
    industryWithdrawal: numberOr(allocation.industry, 0),
    environmentalFlow: firstNumber(
      result && result.totals && result.totals.environmentalFlow,
      result && result.totals && result.totals.inStreamFlow,
      result && result.aggregate && (result.aggregate.environmentalFlow || result.aggregate.environmentFlow),
      sumMetricIfPresent(resultRows(result), ["environmentalFlow", "environmentFlow", "inStreamFlow"])
    ),
    dalyAvoided,
    dalyBurden,
  };
}

function formatSectorMapYi(map) {
  return REALISTIC_MODEL_SECTORS
    .map((sector) => `${sector}=${yiM3(numberOr(map && map[sector], 0))}`)
    .join(", ");
}

function checkRealisticModelBaselineAcceptance(model) {
  let result;
  try {
    result = solveRealisticModelScenario(model, REALISTIC_MODEL_DEFAULT_PARAMS);
  } catch (error) {
    fail(`REALISTIC-MODEL baseline solve threw under SSP2-4.5/ecoFloor=0.15: ${error.message}`);
    return null;
  }

  const summary = summarizeRealisticModelResult(result, REALISTIC_MODEL_DEFAULT_PARAMS);
  if (summary.nodeCount === 66) {
    ok("REALISTIC-MODEL baseline uses real wuhan-attrs.json with 66 subbasins");
  } else {
    fail(`REALISTIC-MODEL baseline must solve all 66 real subbasins; got ${summary.nodeCount}.`);
  }

  REALISTIC_MODEL_SECTORS.forEach((sector) => {
    const demand = numberOr(summary.demand[sector], 0);
    const unmet = numberOr(summary.unmet[sector], 0);
    const tolerance = Math.max(demand * 0.05, 1000000);
    if (unmet <= tolerance) {
      ok(`REALISTIC-MODEL baseline ${sector} unmet is near zero (${yiM3(unmet)} yi m3, tolerance ${yiM3(tolerance)} yi m3)`);
    } else {
      fail(
        `REALISTIC-MODEL baseline ${sector} unmet should be near zero under SSP2-4.5/ecoFloor=0.15; ` +
        `demand=${yiM3(demand)} yi m3, unmet=${yiM3(unmet)} yi m3.`
      );
    }
  });

  const overDemand = [];
  resultRows(result).forEach((node) => {
    REALISTIC_MODEL_SECTORS.forEach((sector) => {
      const allocation = numberOr(node && node.allocation && node.allocation[sector], 0);
      const demand = numberOr(node && node.demand && node.demand[sector], 0);
      const tolerance = Math.max(1e-6, demand * 1e-9);
      if (allocation > demand + tolerance) {
        overDemand.push(`${node.id || "(missing id)"}:${sector} alloc=${allocation} demand=${demand}`);
      }
    });
  });
  REALISTIC_MODEL_SECTORS.forEach((sector) => {
    const allocation = numberOr(summary.allocation[sector], 0);
    const demand = numberOr(summary.demand[sector], 0);
    if (allocation > demand + Math.max(1e-6, demand * 1e-9)) {
      overDemand.push(`totals:${sector} alloc=${allocation} demand=${demand}`);
    }
  });

  if (overDemand.length) {
    fail(`REALISTIC-MODEL withdrawals must not exceed demand caps; examples: ${sampleList(overDemand, 8)}`);
  } else {
    ok("REALISTIC-MODEL baseline withdrawals respect demand caps at node and total level");
  }

  return result;
}

function checkRealisticModelEcoBaseLocalBasis(result) {
  if (!result) return;
  const externalNodes = resultRows(result).filter((node) => readTransitInflow(node) > 0);
  if (!externalNodes.length) {
    fail("REALISTIC-MODEL eco-base local-basis check requires at least one externalInflow/mainstem node.");
    return;
  }

  const overLocalCap = [];
  const pollutedEvidence = [];
  const missingEvidence = [];
  externalNodes.forEach((node) => {
    const local = readLocalEcoBasis(node);
    const transit = readTransitInflow(node);
    const ecoBaseFlow = numberOr(node && node.ecoBaseFlow, NaN);
    const naturalEvidence = readEcoNaturalFlowEvidence(node);
    const label = node && node.id ? node.id : "(missing id)";
    if (!Number.isFinite(local) || !Number.isFinite(ecoBaseFlow)) {
      missingEvidence.push(`${label}: local=${local}, ecoBaseFlow=${ecoBaseFlow}`);
      return;
    }

    const cap = local > 0 ? local * 0.95 : 0;
    const capTolerance = Math.max(1e-6, local * 1e-6);
    if (ecoBaseFlow > cap + capTolerance) {
      overLocalCap.push(`${label}: eco=${yiM3(ecoBaseFlow)} yi, local=${yiM3(local)} yi, transit=${yiM3(transit)} yi`);
    }

    if (!Number.isFinite(naturalEvidence)) {
      missingEvidence.push(`${label}: missing naturalFlow/eco-base basis evidence`);
      return;
    }
    const localOnlyTolerance = Math.max(1000000, local * 0.05);
    if (naturalEvidence > local + localOnlyTolerance) {
      pollutedEvidence.push(`${label}: naturalFlow=${yiM3(naturalEvidence)} yi, local=${yiM3(local)} yi, transit=${yiM3(transit)} yi`);
    }
  });

  if (overLocalCap.length) {
    fail(`REALISTIC-MODEL ecoBaseFlow must be <= 0.95 * local runoff for external-inflow nodes; examples: ${sampleList(overLocalCap, 6)}`);
  } else {
    ok("REALISTIC-MODEL external-inflow nodes cap ecoBaseFlow at 95% of local runoff");
  }

  if (pollutedEvidence.length) {
    fail(`REALISTIC-MODEL naturalFlow/eco-base evidence must not include transit or routed qSupply; examples: ${sampleList(pollutedEvidence, 6)}`);
  } else if (missingEvidence.length) {
    fail(`REALISTIC-MODEL eco-base local-basis evidence missing or nonnumeric; examples: ${sampleList(missingEvidence, 6)}`);
  } else {
    ok("REALISTIC-MODEL eco-base naturalFlow evidence is local-runoff based, not qSupply plus transit");
  }
}

function stressScenarioHasDeficit(summary) {
  return REALISTIC_MODEL_SECTORS.some((sector) => {
    const demand = numberOr(summary.demand[sector], 0);
    const unmet = numberOr(summary.unmet[sector], 0);
    return unmet > Math.max(demand * 0.01, 1000000);
  });
}

function checkRealisticModelStressTauAcceptance(model) {
  const stressSummaries = [];
  REALISTIC_MODEL_STRESS_CLIMATES.forEach((climate) => {
    try {
      const params = { ...REALISTIC_MODEL_DEFAULT_PARAMS, climate };
      const result = solveRealisticModelScenario(model, params);
      stressSummaries.push({ climate, result, summary: summarizeRealisticModelResult(result, params) });
    } catch (error) {
      fail(`REALISTIC-MODEL stress solve threw for ${climate}: ${error.message}`);
    }
  });

  const deficitCase = stressSummaries.find((item) => stressScenarioHasDeficit(item.summary));
  const stressSummaryText = stressSummaries
    .map((item) => `${item.climate}: unmet ${formatSectorMapYi(item.summary.unmet)} yi m3`)
    .join("; ");
  if (deficitCase) {
    ok(`REALISTIC-MODEL stress scenario creates sector deficits (${deficitCase.climate}; ${formatSectorMapYi(deficitCase.summary.unmet)} yi m3)`);
  } else {
    fail(`REALISTIC-MODEL SSP5-8.5 or dry scenario must create at least one meaningful sector deficit; ${stressSummaryText}.`);
  }

  const climate = deficitCase ? deficitCase.climate : REALISTIC_MODEL_STRESS_CLIMATES[0];
  let low;
  let high;
  try {
    const lowResult = solveRealisticModelScenario(model, {
      ...REALISTIC_MODEL_DEFAULT_PARAMS,
      climate,
      tau: REALISTIC_MODEL_STRESS_LOW_TAU,
    });
    const highResult = solveRealisticModelScenario(model, {
      ...REALISTIC_MODEL_DEFAULT_PARAMS,
      climate,
      tau: REALISTIC_MODEL_STRESS_HIGH_TAU,
    });
    low = summarizeRealisticModelResult(lowResult, { climate, tau: REALISTIC_MODEL_STRESS_LOW_TAU });
    high = summarizeRealisticModelResult(highResult, { climate, tau: REALISTIC_MODEL_STRESS_HIGH_TAU });
  } catch (error) {
    fail(`REALISTIC-MODEL stress tau response solve threw for ${climate}: ${error.message}`);
    return;
  }

  const industryDelta = high.industryWithdrawal - low.industryWithdrawal;
  const environmentDelta = high.environmentalFlow - low.environmentalFlow;
  const dalyAvoidedImproves = Number.isFinite(low.dalyAvoided) &&
    Number.isFinite(high.dalyAvoided) &&
    high.dalyAvoided > low.dalyAvoided + 1e-6;
  const dalyBurdenDeclines = Number.isFinite(low.dalyBurden) &&
    Number.isFinite(high.dalyBurden) &&
    high.dalyBurden < low.dalyBurden - 1e-6;

  if (industryDelta < -Math.max(1000000, low.industryWithdrawal * 0.001)) {
    ok(`REALISTIC-MODEL stress tau response lowers industrial withdrawal in ${climate} (${yiM3(low.industryWithdrawal)} -> ${yiM3(high.industryWithdrawal)} yi m3)`);
  } else {
    fail(`REALISTIC-MODEL tau increase must lower industrial withdrawal under ${climate}; delta=${yiM3(industryDelta)} yi m3.`);
  }

  if (environmentDelta > Math.max(1000000, Math.abs(low.environmentalFlow) * 0.001)) {
    ok(`REALISTIC-MODEL stress tau response raises environmental flow in ${climate} (${yiM3(low.environmentalFlow)} -> ${yiM3(high.environmentalFlow)} yi m3)`);
  } else {
    fail(`REALISTIC-MODEL tau increase must raise environmental flow under ${climate}; delta=${yiM3(environmentDelta)} yi m3.`);
  }

  if (dalyAvoidedImproves || dalyBurdenDeclines) {
    ok("REALISTIC-MODEL stress tau response improves DALY avoided or lowers DALY burden");
  } else {
    fail(
      "REALISTIC-MODEL tau response must expose and improve DALY avoided or burden under stress; " +
      `low avoided=${low.dalyAvoided}, high avoided=${high.dalyAvoided}, low burden=${low.dalyBurden}, high burden=${high.dalyBurden}.`
    );
  }
}

function checkRealisticModelDynamicAcceptance() {
  let model;
  try {
    delete require.cache[require.resolve(NETWORK_MODEL_JS_PATH)];
    model = require(NETWORK_MODEL_JS_PATH);
  } catch (error) {
    fail(`REALISTIC-MODEL could not require networkModel.js: ${error.message}`);
    return;
  }
  if (!model || typeof model.solveNetwork !== "function") {
    fail("REALISTIC-MODEL dynamic acceptance requires networkModel.solveNetwork().");
    return;
  }

  const baselineResult = checkRealisticModelBaselineAcceptance(model);
  checkRealisticModelEcoBaseLocalBasis(baselineResult);
  checkRealisticModelStressTauAcceptance(model);
}

function numberOr(value, fallback) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function firstNumber() {
  for (let index = 0; index < arguments.length; index += 1) {
    const number = numberOr(arguments[index], NaN);
    if (Number.isFinite(number)) return number;
  }
  return NaN;
}

function getObjectValue(source, key) {
  if (!source || typeof source !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
  if (source instanceof Map) return source.get(key);
  return undefined;
}

function getDeltaValue(map, id) {
  const value = getObjectValue(map, id);
  return numberOr(value, NaN);
}

function closeTo(actual, expected, tolerance) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

function closeToRelative(actual, expected, relativeTolerance) {
  return Number.isFinite(actual) &&
    Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * relativeTolerance;
}

function sumFlowVolumes(flows) {
  return (Array.isArray(flows) ? flows : []).reduce((sum, flow) => {
    return sum + Math.max(0, numberOr(flow && flow.volume, 0));
  }, 0);
}

function maxFlowVolume(flows) {
  return (Array.isArray(flows) ? flows : []).reduce((max, flow) => {
    return Math.max(max, Math.max(0, numberOr(flow && flow.volume, 0)));
  }, 0);
}

function firstArray() {
  for (let index = 0; index < arguments.length; index += 1) {
    if (Array.isArray(arguments[index])) return arguments[index];
  }
  return [];
}

function readSource(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function checkNameFeatureData() {
  const attrs = readJson(ATTRS_PATH);
  const subbasins = attrs.subbasins || [];

  if (subbasins.length !== 66) {
    fail(`NAME data expected 66 subbasins in wuhan-attrs.json, got ${subbasins.length}.`);
  } else {
    ok("NAME data contains 66 subbasins");
  }

  const missingName = [];
  const nonChineseName = [];
  const pfafLikeName = [];
  const weakPattern = [];
  const missingTechnicalId = [];
  const invalidPfafId = [];
  const invalidCode = [];

  for (const item of subbasins) {
    const id = String(item.id || "");
    const pfafId = item.pfafId;
    const code = item.code;
    const name = item.name;
    const label = id || "(missing id)";

    if (!id || !/^PF_\d+$/.test(id)) {
      missingTechnicalId.push(`${label}: id=${JSON.stringify(item.id)}`);
    }
    if (pfafId === undefined || pfafId === null || String(pfafId).trim() === "") {
      missingTechnicalId.push(`${label}: missing pfafId`);
    } else if (![id, id.replace(/^PF_/, "")].includes(String(pfafId))) {
      invalidPfafId.push(`${label}: pfafId=${JSON.stringify(pfafId)} should preserve ${id} or ${id.replace(/^PF_/, "")}`);
    }
    if (code === undefined || code === null || String(code).trim() === "") {
      missingTechnicalId.push(`${label}: missing code`);
    } else if (![id, String(pfafId)].includes(String(code))) {
      invalidCode.push(`${label}: code=${JSON.stringify(code)} should preserve ${id} or pfafId ${JSON.stringify(pfafId)}`);
    }

    if (!name || !String(name).trim()) {
      missingName.push(label);
    } else {
      if (!hasChinese(name)) nonChineseName.push(`${label}: ${JSON.stringify(name)}`);
      if (isPfafLikeLabel(name, id, pfafId, code)) pfafLikeName.push(`${label}: ${JSON.stringify(name)}`);
      if (!hasNamePattern(name)) weakPattern.push(`${label}: ${JSON.stringify(name)} lacks city+land-use derived pattern`);
    }
  }

  if (missingName.length) fail(`NAME missing subbasin.name for ${missingName.length} basin(s): ${sampleList(missingName, 8)}`);
  if (nonChineseName.length) fail(`NAME labels must be Chinese-derived labels; non-Chinese examples: ${sampleList(nonChineseName, 8)}`);
  if (pfafLikeName.length) fail(`NAME labels must not be Pfaf/PF code labels; offending examples: ${sampleList(pfafLikeName, 8)}`);
  if (weakPattern.length) fail(`NAME labels should follow city + land-use feature pattern; examples: ${sampleList(weakPattern, 8)}`);
  if (missingTechnicalId.length) fail(`NAME must preserve id/pfafId/code technical identifiers; gaps: ${sampleList(missingTechnicalId, 10)}`);
  if (invalidPfafId.length) fail(`NAME pfafId values do not preserve the Pfaf identifier: ${sampleList(invalidPfafId, 8)}`);
  if (invalidCode.length) fail(`NAME code values do not preserve the Pfaf identifier: ${sampleList(invalidCode, 8)}`);

  if (!missingName.length && !nonChineseName.length && !pfafLikeName.length && !weakPattern.length) {
    ok("NAME labels are Chinese derived labels, not Pfaf/PF code labels");
  }
  if (!missingTechnicalId.length && !invalidPfafId.length && !invalidCode.length) {
    ok("NAME preserves id, pfafId, and code technical identifiers");
  }
}

function checkNameFrontendEvidence() {
  const mapJs = fs.readFileSync(MAP_JS_PATH, "utf8");
  const richPanelsJs = fs.readFileSync(RICH_PANELS_JS_PATH, "utf8");
  const popupSource = functionBlock(mapJs, "renderPopup");
  const displayNameSource = functionBlock(mapJs, "displayNameForEntity");
  const flowSource = functionBlock(richPanelsJs, "renderFlowRow");
  const basinRowSource = functionBlock(richPanelsJs, "renderBasinRow");
  const marketPanelSource = functionBlock(richPanelsJs, "renderMarketPanel");

  if (!popupSource) {
    fail("NAME frontend map popup check could not find renderPopup() in research/js/map.js.");
  } else {
    const directNameEvidence = /\bitem\.name\b|\bentity\.name\b/.test(popupSource);
    const displayNameHelperEvidence = /displayNameForEntity\s*\(\s*item\b/.test(popupSource) &&
      /\bentity\s*&&\s*entity\.name\b|\bentity\.name\b|\bitem\.name\b/.test(displayNameSource);
    if (directNameEvidence || displayNameHelperEvidence) {
      ok("NAME map popup renders a Chinese-priority subbasin name");
    } else {
      fail("NAME map popup should render a Chinese-priority name via item.name, displayNameForEntity(), or entity.name.");
    }
    if (/(item\.(?:code|pfafId|id)|Pfaf|PF编码|编码|技术ID|code)/i.test(popupSource)) {
      ok("NAME map popup exposes Pfaf/code secondary identifier");
    } else {
      fail("NAME map popup should show a secondary Pfaf/code/id line alongside the Chinese name.");
    }
  }

  if (!flowSource) {
    fail("NAME frontend trade-flow check could not find renderFlowRow() in research/js/richPanels.js.");
  } else {
    const flowHasNames = /(fromName|originName)/.test(flowSource) && /(toName|targetName)/.test(flowSource);
    const flowHasTechnicalIds = /(fromCode|originCode|fromId|originId|flow\.from|flow\.origin)/.test(flowSource) &&
      /(toCode|targetCode|toId|targetId|flow\.to|flow\.target)/.test(flowSource) &&
      /(Pfaf|PF编码|编码|技术ID|code|basin-code|sub-id)/i.test(flowSource);
    if (flowHasNames) {
      ok("NAME trade-flow rows render origin/target names");
    } else {
      fail("NAME trade-flow rows should render origin/target Chinese names from fromName/originName and toName/targetName.");
    }
    if (flowHasTechnicalIds) {
      ok("NAME trade-flow rows expose Pfaf/code secondary identifiers");
    } else {
      fail("NAME trade-flow rows should visibly show Pfaf/code/id as secondary text for both origin and target.");
    }
  }

  if (!basinRowSource || !marketPanelSource) {
    fail("NAME frontend basin-detail check could not find renderBasinRow() and renderMarketPanel() in research/js/richPanels.js.");
  } else {
    const basinHasName = /row\.name/.test(basinRowSource) && /sortableHead\('name',\s*'名称'\)/.test(marketPanelSource);
    const basinHasTechnicalId = /(row\.(?:code|pfafId|id))/.test(basinRowSource) &&
      /(basin-code|sub-id|title=|<small|secondary|副|编码|Pfaf|Code|ID)/i.test(basinRowSource) &&
      /code:\s*[^,\n]*(item|model|row|base|node)\.(code|pfafId|id)|pfafId:\s*/.test(richPanelsJs);
    if (basinHasName) {
      ok("NAME basin detail table renders Chinese name column");
    } else {
      fail("NAME basin detail table should render row.name under the 名称 column.");
    }
    if (basinHasTechnicalId) {
      ok("NAME basin detail table exposes Pfaf/code secondary identifier");
    } else {
      fail("NAME basin detail table should visibly show Pfaf/code/id as a secondary column or sublabel.");
    }
  }
}

function checkNameMethodologyNote() {
  const methodology = fs.readFileSync(METHODOLOGY_PATH, "utf8");
  if (/派生标签/.test(methodology) && /非官方地名/.test(methodology)) {
    ok("NAME methodology states labels are derived and not official place names");
  } else {
    fail("NAME methodology.md must state the subbasin names are 派生标签，非官方地名.");
  }
}

function checkNameFeature() {
  checkNameFeatureData();
  checkNameFrontendEvidence();
  checkNameMethodologyNote();
}

function checkPre1ExternalInflow() {
  const attrs = readJson(ATTRS_PATH);
  const subbasins = attrs.subbasins || [];
  const byId = new Map(subbasins.map((item) => [item.id, item]));
  const total = subbasins.reduce((sum, item) => {
    const value = item.supply?.externalInflow;
    return sum + (isFiniteNumber(value) ? value : 0);
  }, 0);

  if (!withinTolerance(total, PRE1_EXPECTED_EXTERNAL_INFLOW)) {
    fail(
      `PRE-1 externalInflow total expected about ${PRE1_EXPECTED_EXTERNAL_INFLOW} m3 ` +
      `(${yiM3(PRE1_EXPECTED_EXTERNAL_INFLOW)} yi m3), got ${total} m3 (${yiM3(total)} yi m3). ` +
      "Re-run the bake after writing Yangtze/Han transit injections into supply.externalInflow."
    );
  } else {
    ok(`PRE-1 externalInflow total is ${total} m3 (${yiM3(total)} yi m3)`);
  }

  for (const injection of PRE1_INJECTIONS) {
    const subbasin = byId.get(injection.id);
    if (!subbasin) {
      fail(`PRE-1 injection node missing: ${injection.id} (${injection.label})`);
      continue;
    }
    const actual = subbasin.supply?.externalInflow;
    if (!isFiniteNumber(actual) || !withinTolerance(actual, injection.externalInflow)) {
      fail(
        `PRE-1 ${injection.id} ${injection.label} externalInflow expected about ` +
        `${injection.externalInflow} m3, got ${actual}.`
      );
    } else {
      ok(`PRE-1 ${injection.id} injection is present`);
    }
  }
}

function checkPre1NoTransitDoubleCount() {
  const attrs = readJson(ATTRS_PATH);
  const subbasins = attrs.subbasins || [];
  const chosenTransit = subbasins.reduce((sum, item) => {
    const supply = item.supply || {};
    return sum + Number(supply.externalInflow || supply.mainstemInflow || 0);
  }, 0);
  const naiveTransit = subbasins.reduce((sum, item) => {
    const supply = item.supply || {};
    return sum + Number(supply.externalInflow || 0) + Number(supply.mainstemInflow || 0);
  }, 0);

  if (!withinTolerance(chosenTransit, PRE1_EXPECTED_EXTERNAL_INFLOW)) {
    fail(
      `PRE-1 selected transit inflow should be ${PRE1_EXPECTED_EXTERNAL_INFLOW} m3 ` +
      `(${yiM3(PRE1_EXPECTED_EXTERNAL_INFLOW)} yi m3), got ${chosenTransit} m3.`
    );
  } else {
    ok(`PRE-1 selected transit inflow is not double counted (${chosenTransit} m3)`);
  }

  if (withinTolerance(naiveTransit, PRE1_EXPECTED_EXTERNAL_INFLOW)) {
    warn("PRE-1 duplicate-field guard is inactive because externalInflow + mainstemInflow equals the expected total.");
  } else {
    ok(`PRE-1 duplicate-field guard would catch naive external+mainstem total ${naiveTransit} m3`);
  }

  const mainJs = fs.readFileSync(MAIN_JS_PATH, "utf8");
  const toParamsMatch = mainJs.match(/function toResearchModelParams\(input\) \{[\s\S]*?\n  \}/);
  if (!toParamsMatch) {
    fail("main.js does not expose a recognizable toResearchModelParams function for PRE-1 double-count audit.");
    return;
  }
  const toParamsBody = toParamsMatch[0];
  if (/externalInflow\s*\+\s*mainstemInflow/.test(toParamsBody)) {
    fail("toResearchModelParams adds externalInflow + mainstemInflow; PRE-1 transit water would be double counted.");
  } else if (/supply\.externalInflow\s*\|\|\s*supply\.mainstemInflow/.test(toParamsBody)) {
    ok("toResearchModelParams passes PRE-1 transit inflow as externalInflow || mainstemInflow");
  } else {
    warn("toResearchModelParams no-double-count formula was not matched exactly; inspect PRE-1 transit handling if edited.");
  }
}

function tailOutput(text, maxLines) {
  const lines = String(text || "").trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(-maxLines).join("\n");
}

function runNode(label, scriptPath, args) {
  const result = spawnSync(process.execPath, [scriptPath, ...(args || [])], {
    cwd: HACKATHON_DIR,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 8,
  });

  if (result.status === 0) {
    ok(`${label} passed`);
    return;
  }

  const status = result.status === null ? result.signal : result.status;
  fail(`${label} failed with exit ${status}`);
  const output = tailOutput(`${result.stdout || ""}\n${result.stderr || ""}`, 40);
  if (output) {
    console.error(output.split(/\r?\n/).map((line) => `  ${line}`).join("\n"));
  }
}

function scriptTagIndex(html, scriptName) {
  const escaped = scriptName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<script\\b[^>]*src=["'][^"']*${escaped}(?:\\?[^"']*)?["'][^>]*>`, "i");
  const match = html.match(pattern);
  return match ? match.index : -1;
}

function extractAssetUrls(html) {
  const urls = [];
  const pattern = /<(script|link)\b[^>]*(?:src|href)=["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    urls.push(match[2]);
  }
  return urls;
}

function checkIndexSmoke() {
  const html = fs.readFileSync(INDEX_PATH, "utf8");
  const requiredScripts = [
    "js/glpkLoader.js",
    "js/networkModel.js",
    "js/regionSelect.js",
    "js/map.js",
    "js/dashboard.js",
    "js/richPanels.js",
    "js/main.js",
  ];

  const positions = {};
  for (const script of requiredScripts) {
    positions[script] = scriptTagIndex(html, script);
    if (positions[script] < 0) {
      fail(`index.html does not load ${script}; browser smoke will miss the region selection API.`);
    }
  }

  if (positions["js/regionSelect.js"] >= 0 && positions["js/main.js"] >= 0) {
    if (positions["js/regionSelect.js"] > positions["js/main.js"]) {
      fail("index.html should load js/regionSelect.js before js/main.js.");
    } else {
      ok("index.html loads regionSelect.js before main.js");
    }
  }

  if (positions["js/glpkLoader.js"] >= 0 && positions["js/main.js"] >= 0) {
    if (positions["js/glpkLoader.js"] > positions["js/main.js"]) {
      fail("index.html should load js/glpkLoader.js before js/main.js.");
    } else {
      ok("index.html loads glpkLoader.js before main.js");
    }
  }

  if (positions["js/richPanels.js"] >= 0 && positions["js/main.js"] >= 0) {
    if (positions["js/richPanels.js"] > positions["js/main.js"]) {
      fail("index.html should load js/richPanels.js before js/main.js.");
    } else {
      ok("index.html loads richPanels.js before main.js");
    }
  }

  if (!/id=["']map["']/.test(html)) {
    fail("index.html is missing #map for frontend smoke.");
  } else {
    ok("index.html exposes #map for browser smoke");
  }

  if (!/id=["']dashboard["']/.test(html)) {
    fail("index.html is missing #dashboard for frontend smoke.");
  } else {
    ok("index.html exposes #dashboard for browser smoke");
  }

  if (positions["js/regionSelect.js"] < 0) {
    warn("After FEAT-1/2 wiring, add a browser smoke that draws/sets a rectangle and checks selected basin feedback.");
  }
}

function checkTradeVizIndexWiring() {
  const html = fs.readFileSync(INDEX_PATH, "utf8");
  const urls = extractAssetUrls(html);
  const externalAssets = urls.filter((url) => /^(?:https?:)?\/\//i.test(url));
  if (externalAssets.length) {
    fail(`TV index.html must not add external CDN script/style assets; external asset refs found: ${sampleList(externalAssets, 6)}`);
  } else {
    ok("TV index.html script/style assets are local");
  }

  const tradeAggregateIndex = scriptTagIndex(html, "js/tradeAggregate.js");
  if (tradeAggregateIndex < 0) {
    fail("TV-0 index.html must load js/tradeAggregate.js before views that consume trade aggregates.");
  } else {
    ok("TV-0 index.html loads tradeAggregate.js");
    ["js/map.js", "js/dashboard.js", "js/richPanels.js", "js/main.js"].forEach((script) => {
      const consumerIndex = scriptTagIndex(html, script);
      if (consumerIndex >= 0 && tradeAggregateIndex > consumerIndex) {
        fail(`TV-0 index.html should load js/tradeAggregate.js before ${script}.`);
      }
    });
  }

  [
    { filePath: SANKEY_JS_PATH, script: "js/sankey.js", label: "TV-4 sankey.js" },
    { filePath: MARKET_CHART_JS_PATH, script: "js/marketChart.js", label: "TV-6 marketChart.js" },
  ].forEach(({ filePath, script, label }) => {
    if (!fs.existsSync(filePath)) return;
    const position = scriptTagIndex(html, script);
    if (position < 0) {
      fail(`${label} exists but index.html does not load ${script}.`);
      return;
    }
    const mainIndex = scriptTagIndex(html, "js/main.js");
    if (mainIndex >= 0 && position > mainIndex) {
      fail(`${label} should be loaded before js/main.js so renderAll can call it.`);
    } else {
      ok(`${label} is locally loaded before main.js`);
    }
  });

  if (/data-layer=["']netTrade["']/.test(html)) {
    ok("TV-1 index.html exposes a netTrade layer button");
  } else {
    fail("TV-1 index.html must add a map layer button with data-layer=\"netTrade\".");
  }

  if (/sankey|桑基/i.test(html)) {
    ok("TV-4 index.html/rich panel has a Sankey container hook");
  } else {
    fail("TV-4 UI must expose a Sankey container/hook in index.html or a rendered panel.");
  }

  if (/marketChart|market-chart|供需|出清图|出清曲线/i.test(html)) {
    ok("TV-6 index.html/rich panel has a market chart container hook");
  } else {
    fail("TV-6 UI must expose a market-clearing chart container/hook in index.html or a rendered panel.");
  }
}

function checkTradeAggregateApi() {
  if (!fs.existsSync(TRADE_AGGREGATE_JS_PATH)) {
    fail("TV-0 missing research/js/tradeAggregate.js shared aggregation utility.");
    return;
  }

  const source = fs.readFileSync(TRADE_AGGREGATE_JS_PATH, "utf8");
  const apiFunctionEvidence = /(function|const|let|var)\s+(aggregateTradeFlows|createTradeAggregate|computeTradeAggregate|summarizeTradeFlows)\b/.test(source) ||
    /(aggregateTradeFlows|createTradeAggregate|computeTradeAggregate|summarizeTradeFlows)\s*[:=]\s*(?:function|\()/m.test(source);
  if (apiFunctionEvidence) {
    ok("TV-0 tradeAggregate.js exposes a named aggregation API");
  } else {
    fail("TV-0 tradeAggregate.js should expose a named pure API such as aggregateTradeFlows().");
  }

  [
    "perNodeNet",
    "sellers",
    "buyers",
    "totalTraded",
    "partnersByNode",
    "sectorReallocation",
  ].forEach((key) => {
    if (new RegExp(`\\b${key}\\b`).test(source)) {
      ok(`TV-0 tradeAggregate.js includes ${key}`);
    } else {
      fail(`TV-0 tradeAggregate.js output must include ${key}.`);
    }
  });

  if (/module\.exports|exports\.|export\s+(?:function|const|\{)|window\.(?:TradeAggregate|ResearchTradeAggregate)/.test(source)) {
    ok("TV-0 tradeAggregate.js publishes its API for tests and browser views");
  } else {
    fail("TV-0 tradeAggregate.js should publish its API via module.exports/export or a window namespace.");
  }
}

function checkTradeVizMapEvidence() {
  const html = fs.readFileSync(INDEX_PATH, "utf8");
  const mapJs = fs.readFileSync(MAP_JS_PATH, "utf8");
  const css = fs.existsSync(CSS_PATH) ? fs.readFileSync(CSS_PATH, "utf8") : "";
  const popupSource = functionBlock(mapJs, "renderPopup");
  const styleSource = functionBlock(mapJs, "styleFeature");
  const flowSource = functionBlock(mapJs, "renderFlowLines");

  if (/\bnetTrade\b/.test(mapJs) && /netTrade\s*:\s*\{[^}]*label\s*:\s*['"][^'"]*(交易净额|净交易)/s.test(mapJs)) {
    ok("TV-1 map.js defines netTrade layer metadata");
  } else {
    fail("TV-1 map.js must add netTrade to layer metadata with a 交易净额/净交易 label.");
  }

  if (/\bnetTrade\b[\s\S]*#(?:2f9e44|1f7a8c|adb5bd)|#(?:2f9e44|1f7a8c|adb5bd)[\s\S]*\bnetTrade\b/i.test(mapJs)) {
    ok("TV-1 map.js includes netTrade diverging palette evidence");
  } else {
    fail("TV-1 map.js must define netTrade colors for net seller, net buyer, and neutral basins.");
  }

  if (styleSource && /\bnetTrade\b|perNodeNet|net\s*交易|净交易/.test(styleSource + mapJs)) {
    ok("TV-1 styleFeature has netTrade coloring logic");
  } else {
    fail("TV-1 styleFeature/color logic must use per-node net trade values when activeLayer is netTrade.");
  }

  if (popupSource && /(净交易|净卖出|净买入|netTrade|perNodeNet)/.test(popupSource)) {
    ok("TV-1 map popup exposes net trade value/role");
  } else {
    fail("TV-1 renderPopup() must show 净交易 with net seller/net buyer wording and volume.");
  }

  if (!flowSource) {
    fail("TV-2 could not find renderFlowLines() in research/js/map.js.");
    return;
  }

  if (/arrow|箭头|▶|triangle|divIcon|marker-end|L\.marker|rotate/i.test(flowSource)) {
    ok("TV-2 renderFlowLines includes direction arrow evidence");
  } else {
    fail("TV-2 renderFlowLines must draw direction arrows from seller/from basin to buyer/to basin.");
  }

  if (/interactive\s*:\s*true/.test(flowSource)) {
    ok("TV-2 flow lines are interactive");
  } else {
    fail("TV-2 renderFlowLines must set interactive:true on trade flow paths.");
  }

  if (/bindTooltip|tooltip|悬停|hover/i.test(flowSource)) {
    ok("TV-2 flow lines expose tooltip details");
  } else {
    fail("TV-2 renderFlowLines must bind a tooltip with seller → buyer, volume, and price/cost.");
  }

  if (/(opacity\s*:\s*0\.[6-9]|opacity\s*:\s*1|#1f7a8c|#1c6dd0|#2f9e44)/i.test(flowSource)) {
    ok("TV-2 flow styling is visibly brighter than the old grey 0.28 lines");
  } else {
    fail("TV-2 renderFlowLines should replace pale grey opacity 0.28 lines with bright directional styling.");
  }

  const animationHook = /className\s*:\s*['"][^'"]*(flow|trade)|trade-flow|flow-line|animated/i.test(flowSource);
  const animationCss = /@keyframes[\s\S]*(dash|flow|trade)|stroke-dash(?:offset|array)[\s\S]*animation|animation[\s\S]*stroke-dash/i.test(css);
  if (animationHook && animationCss) {
    ok("TV-2 flow lines have CSS animation hook and keyframes");
  } else {
    fail("TV-2 renderFlowLines must attach an animated class and css/style.css must animate stroke-dashoffset for flow direction.");
  }

  if (/tradeAggregate|TradeAggregate|perNodeNet|partnersByNode/.test(mapJs + html)) {
    ok("TV map/index has evidence of using shared trade aggregate data");
  } else {
    fail("TV map/index should consume the shared tradeAggregate output instead of duplicating or omitting net-trade aggregation.");
  }
}

function checkTradeVizPanels() {
  const richPanelsJs = fs.readFileSync(RICH_PANELS_JS_PATH, "utf8");
  const dashboardJs = fs.readFileSync(DASHBOARD_JS_PATH, "utf8");
  const html = fs.readFileSync(INDEX_PATH, "utf8");
  const combined = `${richPanelsJs}\n${dashboardJs}\n${html}`;

  if (/sectorReallocation|部门再配|再配|减用|增配/.test(combined) && /→|->|增配/.test(combined) && /←|<-|减用/.test(combined)) {
    ok("TV-3 panels include sector reallocation narrative evidence");
  } else {
    fail("TV-3 richPanels/dashboard must render a sector reallocation narrative such as 工业减用 -> 生活增配/环境流量留存.");
  }

  if (/(交易效率|有无交易)/.test(combined) &&
      /(?:有交易|有市场)/.test(combined) &&
      /(?:自给自足|无交易|无市场)/.test(combined) &&
      /(comparison|market|trade).*bar|bar.*(comparison|market|trade)|对比柱|柱状|market-comparison|allocation-bars/i.test(combined)) {
    ok("TV-5 panels include trade-efficiency with/without-trade comparison bar evidence");
  } else {
    fail("TV-5 richPanels/dashboard must render 交易效率（有交易/自给自足）配水对比柱, not only summary deltas.");
  }

  if (/sankey|桑基/i.test(combined) && /(模型推导|OD 调度|非真实成交|非实测成交)/.test(combined)) {
    ok("TV-4 panels include Sankey container and model-derived label");
  } else {
    fail("TV-4 richPanels/dashboard must include a Sankey container and label it as model-derived dispatch.");
  }

  if (/marketChart|market-chart|供需曲线|出清图|出清价|market clearing/i.test(combined) && /教学示意/.test(combined) && /非逐笔|逐笔撮合/.test(combined)) {
    ok("TV-6 panels include market-clearing chart and honest teaching-schematic label");
  } else {
    fail("TV-6 richPanels/dashboard must include a market-clearing chart container and label it 教学示意、非逐笔撮合曲线.");
  }
}

function checkTradeFlowFixAggregateContract() {
  if (!fs.existsSync(TRADE_AGGREGATE_JS_PATH)) {
    fail("TRADE-FLOW-FIX missing research/js/tradeAggregate.js for true-trade aggregation.");
    return;
  }

  const source = fs.readFileSync(TRADE_AGGREGATE_JS_PATH, "utf8");
  const readsRawResultFlows = /resultLike\s*&&\s*resultLike\.tradeFlows/.test(source) ||
    /Array\.isArray\(\s*resultLike[\s\S]{0,80}\.tradeFlows/.test(source);
  const usesRawFlowsForTrade = /normalized\.sourceFlows[\s\S]{0,160}(?:forEach|map|reduce|buildPairBuckets|buildTradeFlows|totalTraded)|sourceFlows[\s\S]{0,160}(?:perNodeNet|nodeDelta|partnersByNode|totalTraded|generatedFlows)/.test(source);
  if (readsRawResultFlows && usesRawFlowsForTrade) {
    fail("TRADE-FLOW-FIX tradeAggregate.js still generates visible trade output from result.tradeFlows; bulk-routed-outflow would be counted as trading.");
  } else {
    ok("TRADE-FLOW-FIX tradeAggregate.js does not generate trade output directly from result.tradeFlows");
  }

  if (/\bautarky\b/i.test(source) && /\bnodeDelta\b/.test(source)) {
    ok("TRADE-FLOW-FIX tradeAggregate.js references autarky and nodeDelta true-trade fields");
  } else {
    fail("TRADE-FLOW-FIX tradeAggregate.js must derive nodeDelta from withTrade - autarky, not only summarize supplied flow arrays.");
  }

  runTradeAggregateBulkSentinel();
}

function runTradeAggregateBulkSentinel() {
  let api;
  try {
    delete require.cache[require.resolve(TRADE_AGGREGATE_JS_PATH)];
    api = require(TRADE_AGGREGATE_JS_PATH);
  } catch (error) {
    fail(`TRADE-FLOW-FIX could not require tradeAggregate.js for bulk-routed-outflow sentinel: ${error.message}`);
    return;
  }

  const candidate = api && (
    api.computeTradeAggregate
    || api.buildTradeAggregate
    || api.createTradeAggregate
    || api.aggregateTradeFlows
  );
  if (typeof candidate !== "function") {
    fail("TRADE-FLOW-FIX tradeAggregate.js must expose compute/build/create/aggregate true-trade API.");
    return;
  }

  const autarky = {
    kind: "autarky",
    meta: {
      mode: "autarky",
      transitAllocationRule: "demand-proportional",
      ownWaterRightFormula: "qLocal + transitShare",
    },
    basinResults: [
      {
        id: "SELLER",
        name: "上游自给区",
        code: "SELLER-01",
        supply: { qLocal: 70, transitShare: 30, ownWaterRight: 100 },
        allocation: { agri: 70, industry: 20, urban: 10, total: 100 },
      },
      {
        id: "BUYER",
        name: "下游需求区",
        code: "BUYER-01",
        supply: { qLocal: 40, transitShare: 10, ownWaterRight: 50 },
        allocation: { agri: 20, industry: 10, urban: 20, total: 50 },
      },
    ],
  };
  const withTrade = {
    kind: "with-trade",
    basinResults: [
      {
        id: "SELLER",
        name: "上游自给区",
        code: "SELLER-01",
        allocation: { agri: 55, industry: 15, urban: 10, total: 80 },
      },
      {
        id: "BUYER",
        name: "下游需求区",
        code: "BUYER-01",
        allocation: { agri: 30, industry: 15, urban: 25, total: 70 },
      },
    ],
  };
  const bulkFlow = {
    origin: "SELLER",
    target: "BUYER",
    from: "SELLER",
    to: "BUYER",
    sector: "bulk-routed-outflow",
    direction: "upstream-to-downstream",
    volume: TRADE_FLOW_SENTINEL_BULK_VOLUME,
  };

  let aggregate;
  try {
    aggregate = candidate({
      withTrade,
      autarky,
      baseline: autarky,
      withoutMarket: autarky,
      noMarketResult: autarky,
      basinResults: withTrade.basinResults,
      result: withTrade,
      tradeFlows: [bulkFlow],
      raw: { tradeFlows: [bulkFlow] },
    }, {
      withMarket: withTrade,
      autarky,
      withoutMarket: autarky,
      noMarketResult: autarky,
      basinResults: withTrade.basinResults,
    });
  } catch (error) {
    fail(`TRADE-FLOW-FIX tradeAggregate bulk-routed-outflow sentinel threw: ${error.message}`);
    return;
  }

  const outputFlows = firstArray(
    aggregate && aggregate.tradeFlows,
    aggregate && aggregate.flows,
    aggregate && aggregate.marketTradeFlows,
    aggregate && aggregate.trueTradeFlows
  );
  const totalTraded = numberOr(aggregate && aggregate.totalTraded, sumFlowVolumes(outputFlows));
  const largestFlow = maxFlowVolume(outputFlows);
  const hasBulkSector = outputFlows.some((flow) => /bulk-routed-outflow/i.test(String(flow && flow.sector)));

  if (totalTraded >= TRADE_FLOW_NOISE_THRESHOLD || largestFlow >= TRADE_FLOW_NOISE_THRESHOLD || hasBulkSector) {
    fail(
      "TRADE-FLOW-FIX tradeAggregate counted the 3552.75 yi m3 bulk-routed-outflow sentinel as trade; " +
      `totalTraded=${totalTraded}, largestFlow=${largestFlow}, hasBulkSector=${hasBulkSector}.`
    );
  } else {
    ok("TRADE-FLOW-FIX tradeAggregate rejects 3000+ yi m3 bulk-routed-outflow noise as trade");
  }

  if (closeTo(totalTraded, 20, 1e-6)) {
    ok("TRADE-FLOW-FIX tradeAggregate derives totalTraded from withTrade - autarky delta");
  } else {
    fail(`TRADE-FLOW-FIX tradeAggregate should derive 20 m3 of true trade from the sentinel autarky delta, got ${totalTraded}.`);
  }

  const deltaMap = aggregate && (aggregate.nodeDelta || aggregate.perNodeDelta || aggregate.perNodeNet);
  const sellerDelta = getDeltaValue(deltaMap, "SELLER");
  const buyerDelta = getDeltaValue(deltaMap, "BUYER");
  if (closeTo(sellerDelta, -20, 1e-6) && closeTo(buyerDelta, 20, 1e-6)) {
    ok("TRADE-FLOW-FIX nodeDelta sign matches workorder: seller<0, buyer>0");
  } else {
    fail(
      "TRADE-FLOW-FIX nodeDelta must use withTrade - autarky sign convention " +
      `(SELLER=-20, BUYER=20); got SELLER=${sellerDelta}, BUYER=${buyerDelta}.`
    );
  }
}

function checkTradeFlowFixUiWiring() {
  const mainJs = readSource(MAIN_JS_PATH);
  const mapJs = readSource(MAP_JS_PATH);
  const richPanelsJs = readSource(RICH_PANELS_JS_PATH);
  const sankeyJs = readSource(SANKEY_JS_PATH);
  const mainTradeSource = [
    functionBlock(mainJs, "buildTradeAggregateContext"),
    functionBlock(mainJs, "getTradeFlows"),
    functionBlock(mainJs, "callExternalTradeAggregate"),
    functionBlock(mainJs, "buildFallbackTradeAggregate"),
    functionBlock(mainJs, "normalizeTradeAggregate"),
  ].join("\n");
  const mapFlowSource = [
    functionBlock(mapJs, "getAllFlows"),
    functionBlock(mapJs, "getVisibleFlows"),
    functionBlock(mapJs, "renderFlowLines"),
  ].join("\n");
  const richFlowSource = [
    functionBlock(richPanelsJs, "buildTradeVisuals"),
    functionBlock(richPanelsJs, "getTradeFlows"),
    functionBlock(richPanelsJs, "renderFlowRow"),
  ].join("\n");
  const uiFlowSource = `${mapFlowSource}\n${richFlowSource}\n${sankeyJs}`;

  if (/result\s*&&\s*result\.tradeFlows|result\.tradeFlows|result\s*&&\s*result\.raw\s*&&\s*Array\.isArray\(\s*result\.raw\.tradeFlows/.test(mainTradeSource)) {
    fail("TRADE-FLOW-FIX main.js still builds visible trade aggregates from result.tradeFlows/raw.tradeFlows.");
  } else if (/\bautarky\b|nodeDelta|trueTrade|marketTradeFlows|tradeAggregate\.(?:tradeFlows|flows)/i.test(mainTradeSource)) {
    ok("TRADE-FLOW-FIX main.js trade context is wired to true-trade/autarky aggregate fields");
  } else {
    fail("TRADE-FLOW-FIX main.js must pass autarky-derived tradeAggregate fields to map and panels.");
  }

  if (/result\s*&&\s*result\.(?:tradeFlows|flows)|result\.(?:tradeFlows|flows)/.test(uiFlowSource)) {
    fail("TRADE-FLOW-FIX map/richPanels still read visible flows directly from result.tradeFlows/result.flows.");
  } else {
    ok("TRADE-FLOW-FIX map/richPanels do not directly consume raw result tradeFlows/flows");
  }

  if (/tradeAggregate/i.test(uiFlowSource) && /(nodeDelta|trueTrade|marketTradeFlows|tradeAggregate\.(?:tradeFlows|flows)|context\.tradeAggregate)/i.test(uiFlowSource)) {
    ok("TRADE-FLOW-FIX UI uses tradeAggregate true-trade fields for arrows/table/Sankey inputs");
  } else {
    fail("TRADE-FLOW-FIX UI arrows, Sankey, and trade table must use context/result.tradeAggregate true-trade fields.");
  }
}

function checkTradeFlowFixHonestLabels() {
  const html = readSource(INDEX_PATH);
  const mapJs = readSource(MAP_JS_PATH);
  const richPanelsJs = readSource(RICH_PANELS_JS_PATH);
  const sankeyJs = readSource(SANKEY_JS_PATH);
  const marketChartJs = readSource(MARKET_CHART_JS_PATH);
  const combined = `${html}\n${mapJs}\n${richPanelsJs}\n${sankeyJs}\n${marketChartJs}`;

  const hasAutarkyTradeLabel = /(有交易|with\s*trade)[\s\S]{0,80}(自给自足|autarky)|(?:自给自足|autarky)[\s\S]{0,80}(市场再配|交易)/i.test(combined);
  const hasModelDerivedLabel = /模型推导/.test(combined) && /非真实成交记录/.test(combined);
  if (hasAutarkyTradeLabel && hasModelDerivedLabel) {
    ok("TRADE-FLOW-FIX UI labels trade flows as withTrade - autarky model-derived, not real transactions");
  } else {
    fail("TRADE-FLOW-FIX UI must label trade flows as 基于'有交易-自给自足'的市场再配估算，模型推导，非真实成交记录.");
  }

  if (/教学示意/.test(combined) && /非逐笔|逐笔撮合/.test(combined)) {
    ok("TRADE-FLOW-FIX market/Sankey labels retain teaching-schematic wording");
  } else {
    fail("TRADE-FLOW-FIX Sankey/clearing visuals must retain 教学示意/非逐笔撮合 or equivalent honest labels.");
  }

  if (/bulk-routed-outflow/i.test(combined) && !/(物理下泄|河网输水|非交易|not\s+trade)/i.test(combined)) {
    fail("TRADE-FLOW-FIX UI references bulk-routed-outflow without clearly labeling it physical routing, not trade.");
  } else {
    ok("TRADE-FLOW-FIX UI does not present bulk-routed-outflow as market trading");
  }
}

function checkTradeFlowFixAutarkyMethodology() {
  const methodology = readSource(METHODOLOGY_PATH);
  const implementation = [
    readSource(NETWORK_MODEL_JS_PATH),
    readSource(MAIN_JS_PATH),
    readSource(TRADE_AGGREGATE_JS_PATH),
    readSource(NETWORK_MODEL_TEST_PATH),
    readSource(TRADE_AGGREGATE_TEST_PATH),
  ].join("\n");

  const methodologyRequirements = [
    { label: "口径 R", pattern: /口径\s*R|R\s*口径/i },
    { label: "autarky/self-sufficiency", pattern: /autarky|自给自足|无交易/i },
    { label: "demand-proportional transit rule", pattern: /过境水[\s\S]{0,80}(需求比例|按需求)|demand[-\s]?proportional/i },
    { label: "own water right formula", pattern: /自有水权[\s\S]{0,80}qLocal[\s\S]{0,80}(transit\s*share|过境水份额|过境份额)|qLocal[\s\S]{0,80}\+[\s\S]{0,80}(transit\s*share|过境水份额|过境份额)/i },
  ];
  const missingMethodology = methodologyRequirements.filter((item) => !item.pattern.test(methodology));
  if (missingMethodology.length) {
    fail(`TRADE-FLOW-FIX methodology.md missing autarky 口径 R details: ${missingMethodology.map((item) => item.label).join(", ")}.`);
  } else {
    ok("TRADE-FLOW-FIX methodology.md documents autarky 口径 R and qLocal + transit share formula");
  }

  if (/\bautarky\b|自给自足|无交易/.test(implementation) && /(meta|metadata)/i.test(implementation) && /(demand[-\s]?proportional|需求比例|transitShare|ownWaterRight|口径\s*R|qLocal)/i.test(implementation)) {
    ok("TRADE-FLOW-FIX implementation/test sources include autarky metadata evidence");
  } else {
    fail("TRADE-FLOW-FIX model/aggregate/tests must expose autarky metadata: rule=口径R/demand-proportional, ownWaterRight=qLocal+transitShare.");
  }
}

function checkTradeFlowFixNoiseEvidence() {
  const evidence = [
    readSource(__filename),
    readSource(TRADE_AGGREGATE_TEST_PATH),
    readSource(NETWORK_MODEL_TEST_PATH),
  ].join("\n");
  if (/bulk-routed-outflow/i.test(evidence) && /(355275000000|300000000000|3000\+?亿|3000\+\s*yi|TRADE_FLOW_SENTINEL_BULK_VOLUME)/i.test(evidence)) {
    ok("TRADE-FLOW-FIX validator/tests include static sentinel evidence for 3000+ yi m3 bulk-flow noise");
  } else {
    fail("TRADE-FLOW-FIX validator/tests must include a bulk-routed-outflow sentinel proving 3000+ yi m3 physical flow is not counted as trade.");
  }
}

function loadTradeAggregateCandidate(label) {
  let api;
  try {
    delete require.cache[require.resolve(TRADE_AGGREGATE_JS_PATH)];
    api = require(TRADE_AGGREGATE_JS_PATH);
  } catch (error) {
    fail(`${label} could not require tradeAggregate.js: ${error.message}`);
    return null;
  }

  const candidate = api && (
    api.computeTradeAggregate
    || api.buildTradeAggregate
    || api.createTradeAggregate
    || api.aggregateTradeFlows
  );
  if (typeof candidate !== "function") {
    fail(`${label} tradeAggregate.js must expose compute/build/create/aggregate API.`);
    return null;
  }
  return candidate;
}

function buildPriceSentinelScenario(marketPrice, tradingCost) {
  const autarky = {
    kind: "autarky",
    basinResults: [
      {
        id: "PRICE_SELLER",
        name: "价格哨兵卖方",
        code: "PRICE-S",
        allocation: { agri: 70, industry: 20, urban: 10 },
      },
      {
        id: "PRICE_BUYER",
        name: "价格哨兵买方",
        code: "PRICE-B",
        allocation: { agri: 10, industry: 10, urban: 20 },
      },
    ],
  };
  const withTrade = {
    kind: "with-trade",
    marketPrice,
    tradingCost,
    tradeCost: tradingCost,
    transactionCost: tradingCost,
    params: { tradingCost, tradeCost: tradingCost, transactionCost: tradingCost },
    basinResults: [
      {
        id: "PRICE_SELLER",
        name: "价格哨兵卖方",
        code: "PRICE-S",
        allocation: { agri: 50, industry: 12, urban: 8 },
      },
      {
        id: "PRICE_BUYER",
        name: "价格哨兵买方",
        code: "PRICE-B",
        allocation: { agri: 20, industry: 20, urban: 30 },
      },
    ],
  };
  return { autarky, withTrade, marketPrice, tradingCost };
}

function runTradeAggregatePriceScenario(candidate, marketPrice, tradingCost) {
  const scenario = buildPriceSentinelScenario(marketPrice, tradingCost);
  return candidate({
    withTrade: scenario.withTrade,
    withMarket: scenario.withTrade,
    autarky: scenario.autarky,
    withoutMarket: scenario.autarky,
    noMarketResult: scenario.autarky,
    baseline: scenario.autarky,
    basinResults: scenario.withTrade.basinResults,
    params: scenario.withTrade.params,
    tradingCost,
    tradeCost: tradingCost,
    transactionCost: tradingCost,
  }, {
    withTrade: scenario.withTrade,
    withMarket: scenario.withTrade,
    autarky: scenario.autarky,
    withoutMarket: scenario.autarky,
    noMarketResult: scenario.autarky,
    baseline: scenario.autarky,
    basinResults: scenario.withTrade.basinResults,
    params: scenario.withTrade.params,
    tradingCost,
    tradeCost: tradingCost,
    transactionCost: tradingCost,
  });
}

function flowUiPrice(flow) {
  return firstNumber(
    flow && flow.averageUnitCost,
    flow && flow.price,
    flow && flow.marketPrice
  );
}

function averageFlowUiPrice(flows) {
  const values = (Array.isArray(flows) ? flows : [])
    .map(flowUiPrice)
    .filter(Number.isFinite);
  if (!values.length) return NaN;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function checkTradeVizFixAFlowPrices() {
  const candidate = loadTradeAggregateCandidate("FIX-A price-field sentinel");
  if (!candidate) return;

  let aggregateA;
  let aggregateB;
  try {
    aggregateA = runTradeAggregatePriceScenario(candidate, 0.42, 0.04);
    aggregateB = runTradeAggregatePriceScenario(candidate, 0.61, 0.02);
  } catch (error) {
    fail(`FIX-A price-field sentinel threw while building generated trade flows: ${error.message}`);
    return;
  }

  const flowsA = firstArray(
    aggregateA && aggregateA.tradeFlows,
    aggregateA && aggregateA.flows,
    aggregateA && aggregateA.marketTradeFlows,
    aggregateA && aggregateA.trueTradeFlows
  );
  const flowsB = firstArray(
    aggregateB && aggregateB.tradeFlows,
    aggregateB && aggregateB.flows,
    aggregateB && aggregateB.marketTradeFlows,
    aggregateB && aggregateB.trueTradeFlows
  );

  if (!flowsA.length || !flowsB.length) {
    fail("FIX-A generated trade flow sentinel produced no flows; cannot verify hidden prices for the trade table.");
    return;
  }

  const missingPrice = flowsA.filter((flow) => !Number.isFinite(flowUiPrice(flow)));
  const zeroPrice = flowsA.filter((flow) => Math.abs(flowUiPrice(flow)) <= TRADE_VIZ_PRICE_EPS);
  if (missingPrice.length) {
    fail(`FIX-A every generated trade flow should expose averageUnitCost, price, or marketPrice; ${missingPrice.length} flow(s) missing.`);
  } else if (zeroPrice.length) {
    fail(`FIX-A generated trade flows should not all render as 0.000 yuan/m3; ${zeroPrice.length} flow(s) have zero UI price.`);
  } else {
    ok("FIX-A generated trade flows expose non-zero UI price fields");
  }

  const expectedA = 0.42 + 0.04;
  const allInMatches = flowsA.every((flow) => closeTo(flowUiPrice(flow), expectedA, 1e-6));
  if (allInMatches) {
    ok("FIX-A generated trade flow UI price reflects marketPrice + tradingCost");
  } else if (!missingPrice.length) {
    fail(`FIX-A generated trade flow UI price should be close to marketPrice + tradingCost (${expectedA}), got ${flowsA.map(flowUiPrice).join(", ")}.`);
  }

  const averageA = averageFlowUiPrice(flowsA);
  const averageB = averageFlowUiPrice(flowsB);
  if (Number.isFinite(averageA) && Number.isFinite(averageB) && Math.abs(averageA - averageB) > 0.05) {
    ok("FIX-A generated trade flow prices respond to market price/trading cost inputs");
  } else {
    fail(`FIX-A generated trade flow prices should change with market price/trading cost inputs; got ${averageA} and ${averageB}.`);
  }
}

function checkTradeVizFixBSankeyDisclosure() {
  const sankeySource = readSource(SANKEY_JS_PATH);
  const panelSource = [
    readSource(RICH_PANELS_JS_PATH),
    readSource(DASHBOARD_JS_PATH),
    readSource(INDEX_PATH),
  ].join("\n");
  let rendered = "";
  let links = [];
  let capturedWarnings = [];
  const reallocation = [
    { key: "agri", label: "农业", delta: -768000000 },
    { key: "industry", label: "工业", delta: -1871000000 },
    { key: "urban", label: "生活", delta: 415000000 },
  ];
  const reduced = 768000000 + 1871000000;
  const increased = 415000000;
  const expectedGap = reduced - increased;

  function uniqueNodes(side) {
    const nodes = new Map();
    links.forEach((link) => {
      if (link && link[side] && link[side].key) nodes.set(link[side].key, link[side]);
    });
    return Array.from(nodes.values());
  }

  function nodeAmount(node, side) {
    const raw = Number(node && (node.value !== undefined ? node.value : node.delta)) || 0;
    if (side === "from" && !(node && node.isSupplementalSource)) return Math.abs(raw);
    return Math.max(0, raw);
  }

  function sideTotal(side) {
    return uniqueNodes(side).reduce((sum, node) => sum + nodeAmount(node, side), 0);
  }

  try {
    delete require.cache[require.resolve(SANKEY_JS_PATH)];
    const api = require(SANKEY_JS_PATH);
    if (api && typeof api.renderToString === "function" && typeof api.buildSectorDispatchLinks === "function") {
      const originalWarn = console.warn;
      console.warn = (...args) => capturedWarnings.push(args.map(String).join(" "));
      try {
        links = api.buildSectorDispatchLinks(reallocation, 1518000000);
        rendered = api.renderToString({ reallocation, unreallocated: 1518000000 });
      } finally {
        console.warn = originalWarn;
      }
    } else {
      fail("FIX-B sankey.js should export renderToString() and buildSectorDispatchLinks() so QA can verify imbalance disclosure.");
    }
  } catch (error) {
    fail(`FIX-B could not render sankey imbalance sentinel: ${error.message}`);
  }

  const sink = uniqueNodes("to").find((node) => node && node.isUnreallocated);
  const sinkValue = Number(sink && (sink.value !== undefined ? sink.value : sink.delta));
  const leftTotal = sideTotal("from");
  const rightTotal = sideTotal("to");
  const hasCorrectLabel = /留在河道\/未取用/.test(rendered) && sink && sink.label === "留在河道/未取用";
  const rejectsOldLabel = !/原未取用\/新增配水/.test(rendered) && !/留在河道\/未再配/.test(rendered);
  const footnoteExplainsGap = /减用的水未必全部再配[\s\S]{0,80}差额[\s\S]{0,80}留在河道\/未取用/.test(rendered);
  const warnsOnStaleExplicit = capturedWarnings.some((warning) => /忽略不守恒的 unreallocated/.test(warning));

  if (hasCorrectLabel) {
    ok("FIX-B Sankey uses 留在河道/未取用 for the unreallocated sink");
  } else {
    fail("FIX-B Sankey must label the unreallocated sink as 留在河道/未取用.");
  }
  if (Number.isFinite(sinkValue) && Math.abs(sinkValue - expectedGap) < 1e-3) {
    ok("FIX-B Sankey sink value equals R-G, rejecting the stale 15.18亿 value");
  } else {
    fail(`FIX-B Sankey sink value should equal R-G (${expectedGap}), got ${sinkValue}.`);
  }
  if (Math.abs(leftTotal - rightTotal) < 1e-3) {
    ok("FIX-B Sankey left and right node totals conserve water");
  } else {
    fail(`FIX-B Sankey node totals must conserve water; left=${leftTotal}, right=${rightTotal}.`);
  }
  if (footnoteExplainsGap) {
    ok("FIX-B Sankey footnote explains the reduction gap goes to 留在河道/未取用");
  } else if (/(留在河道\/未取用|差额|未取用)/.test(panelSource + sankeySource)) {
    fail("FIX-B Sankey rendered footnote must explicitly say the R-G difference stays in 留在河道/未取用.");
  } else {
    fail("FIX-B Sankey must disclose the unreallocated water destination.");
  }
  if (rejectsOldLabel) {
    ok("FIX-B Sankey rejects old unreallocated/supplemental labels for the reduction-gap case");
  } else {
    fail("FIX-B Sankey must not render 原未取用/新增配水 or 留在河道/未再配 for the reduction-gap case.");
  }
  if (warnsOnStaleExplicit && /console\.warn/.test(sankeySource)) {
    ok("FIX-B Sankey warns when stale explicit unreallocated would break conservation");
  } else {
    fail("FIX-B Sankey should console.warn when stale explicit unreallocated conflicts with R-G.");
  }
}

function checkTradeVizFixDMapGuards() {
  const html = readSource(INDEX_PATH);
  const mapJs = readSource(MAP_JS_PATH);
  const css = readSource(CSS_PATH);
  const renderLeafletSource = functionBlock(mapJs, "renderLeaflet");
  const layerTabsSource = functionBlock(mapJs, "bindLayerTabs");
  const boundsKeySource = functionBlock(mapJs, "getNetworkBoundsKey");
  const flowSource = functionBlock(mapJs, "renderFlowLines");
  const legendSource = functionBlock(mapJs, "updateLegend");

  if (/fitBounds/.test(layerTabsSource)) {
    fail("FIX-D layer tab switching must not call fitBounds directly.");
  } else if (/fitBounds/.test(renderLeafletSource) && /boundsKey\s*!==\s*fittedBoundsKey|fittedBoundsKey\s*!==\s*boundsKey/.test(renderLeafletSource) && !/\bactiveLayer\b/.test(boundsKeySource)) {
    ok("FIX-D map fitBounds is guarded by network bounds, not activeLayer changes");
  } else {
    fail("FIX-D map fitBounds should only run when network bounds change, not when activeLayer/netTrade changes.");
  }

  const coordinateGuardEvidence = /(isValidFlowCoordinate|isValidCentroid|validFlowCoordinate|centroidInAoi|withinAoi|withinAOI|withinBounds|isInsideAoi|flowCoordinateIsValid)/i.test(mapJs) ||
    (/visibleFlows[\s\S]{0,120}\.filter[\s\S]{0,240}(centroid|lat|lng|longitude|latitude)[\s\S]{0,160}(bbox|bounds|AOI|aoi|112\.5|116(?:\.0|\.1)|31(?:\.3|\.5))/i.test(flowSource)) ||
    (/if\s*\([^)]*(?:centroid|lat|lng|coordinate)[^)]*\)\s*return/.test(flowSource) && /(bbox|bounds|AOI|aoi|112\.5|116(?:\.0|\.1)|31(?:\.3|\.5))/i.test(flowSource));
  if (coordinateGuardEvidence) {
    ok("FIX-D renderFlowLines filters invalid or AOI-outside flow coordinates");
  } else {
    fail("FIX-D renderFlowLines should filter from/to centroids outside the Wuhan AOI bbox before drawing arrows.");
  }

  const legendEvidence = `${legendSource}\n${html}\n${css}`;
  if (/灰\s*[=＝:：]?\s*自给|自给[\s\S]{0,80}(灰|少数|城市|净买卖|无净交易|净交易为\s*0)|neutral[\s\S]{0,80}self/i.test(legendEvidence)) {
    ok("FIX-D netTrade legend explains grey/self-sufficient basins");
  } else {
    fail("FIX-D netTrade legend should explain 灰=自给 / only a few urban basins have net buy/sell values.");
  }
}

function checkTradeVizQaFixListCoverage() {
  checkTradeVizFixAFlowPrices();
  checkTradeVizFixBSankeyDisclosure();
  checkTradeVizFixDMapGuards();
}

function sumTransitInflowFromAttrs(subbasins) {
  return (subbasins || []).reduce((sum, item) => {
    const supply = item && item.supply ? item.supply : {};
    return sum + Number(supply.externalInflow || supply.mainstemInflow || supply.boundaryInflow || 0);
  }, 0);
}

function weightedRunoffCoeffFromAttrs(subbasins) {
  let weighted = 0;
  let areaTotal = 0;
  (subbasins || []).forEach((item) => {
    const supply = item && item.supply ? item.supply : {};
    const runoffCoeff = numberOr(supply.runoffCoeff, NaN);
    const areaKm2 = numberOr(item && (item.areaKm2 || item.area_km2 || item.area), 0);
    if (Number.isFinite(runoffCoeff) && areaKm2 > 0) {
      weighted += runoffCoeff * areaKm2;
      areaTotal += areaKm2;
    }
  });
  return areaTotal > 0 ? weighted / areaTotal : NaN;
}

function checkRound2HydrologyDataAnchors() {
  const attrs = readJson(ATTRS_PATH);
  const subbasins = attrs.subbasins || [];
  const localRunoff = subbasins.reduce((sum, item) => {
    return sum + Number((item.supply || {}).qLocal || 0);
  }, 0);
  const transitInflow = sumTransitInflowFromAttrs(subbasins);
  const transitShare = transitInflow + localRunoff > 0
    ? transitInflow / (transitInflow + localRunoff)
    : NaN;
  const runoffCoeff = weightedRunoffCoeffFromAttrs(subbasins);

  if (closeToRelative(localRunoff, ROUND2_EXPECTED_LOCAL_RUNOFF, 0.05)) {
    ok(`ROUND2 data local runoff anchor is ${yiM3(localRunoff)} yi m3, about ${ROUND2_EXPECTED_LOCAL_RUNOFF_YI} yi m3`);
  } else {
    fail(`ROUND2 data local runoff should be about ${ROUND2_EXPECTED_LOCAL_RUNOFF_YI} yi m3, got ${yiM3(localRunoff)} yi m3.`);
  }

  if (closeToRelative(transitInflow, ROUND2_EXPECTED_EXTERNAL_INFLOW, 0.001)) {
    ok(`ROUND2 data boundary/transit inflow stays ${yiM3(transitInflow)} yi m3`);
  } else {
    fail(`ROUND2 boundary/transit inflow should stay ${yiM3(ROUND2_EXPECTED_EXTERNAL_INFLOW)} yi m3, got ${yiM3(transitInflow)} yi m3.`);
  }

  if (closeTo(transitShare, ROUND2_EXPECTED_TRANSIT_SHARE, 0.01)) {
    ok(`ROUND2 data transit share anchor is ${(transitShare * 100).toFixed(1)}% using transit/(local+transit)`);
  } else {
    fail(`ROUND2 transit share should be about 93% using transit/(local+transit), got ${(transitShare * 100).toFixed(1)}%.`);
  }

  if (closeTo(runoffCoeff, ROUND2_EXPECTED_RUNOFF_COEFF, 1e-6)) {
    ok("ROUND2 data area-weighted runoff coefficient is 0.40");
  } else {
    fail(`ROUND2 data area-weighted runoff coefficient should be 0.40, got ${runoffCoeff}.`);
  }
}

function checkRound2RichPanelsFunctionalAcceptance() {
  let api;
  try {
    delete require.cache[require.resolve(RICH_PANELS_JS_PATH)];
    api = require(RICH_PANELS_JS_PATH);
  } catch (error) {
    fail(`ROUND2 could not require richPanels.js for functional acceptance: ${error.message}`);
    return;
  }
  if (!api || typeof api.aggregateRichData !== "function") {
    fail("ROUND2 richPanels.js should export aggregateRichData() for hydrology acceptance tests.");
    return;
  }

  const basinResults = [
    {
      id: "ROUND2_A",
      name: "ROUND2 上游",
      areaKm2: 80,
      supply: { qLocal: 110, externalInflow: 35, qAvail: 145, runoffCoeff: 0.4 },
      demand: { agri: 0, industry: 0, urban: 0 },
      allocation: { agri: 0, industry: 0, urban: 0 },
    },
    {
      id: "ROUND2_B",
      name: "ROUND2 下游",
      areaKm2: 120,
      supply: { qLocal: 90, mainstemInflow: 55, qAvail: 145, runoffCoeff: 0.4 },
      demand: { agri: 0, industry: 0, urban: 0 },
      allocation: { agri: 0, industry: 0, urban: 0 },
    },
  ];

  let aggregate;
  try {
    aggregate = api.aggregateRichData({ basinResults }, { modelInput: { basins: basinResults } });
  } catch (error) {
    fail(`ROUND2 richPanels aggregateRichData sentinel threw: ${error.message}`);
    return;
  }

  const localRunoff = aggregate && aggregate.totals && numberOr(aggregate.totals.localRunoff, NaN);
  const pollutedLocal = aggregate && aggregate.totals && numberOr(aggregate.totals.qLocal, NaN);
  const transitShare = aggregate && numberOr(aggregate.transitShare, NaN);
  const runoffCoeff = aggregate && numberOr(aggregate.runoffCoeff, NaN);

  if (closeTo(localRunoff, 110, 1e-6)) {
    ok("ROUND2 richPanels computes localRunoff as qLocal - transitInflow");
  } else {
    fail(`ROUND2 richPanels should expose totals.localRunoff=110 for polluted qLocal sentinel, got ${localRunoff}; qLocal total was ${pollutedLocal}.`);
  }

  if (closeTo(transitShare, 0.45, 1e-6)) {
    ok("ROUND2 richPanels computes transit share as transit/(localRunoff+transit)");
  } else {
    fail(`ROUND2 richPanels transitShare should be 0.45 for sentinel, got ${transitShare}.`);
  }

  if (closeTo(runoffCoeff, 0.4, 1e-9)) {
    ok("ROUND2 richPanels preserves area-weighted runoff coefficient 0.40");
  } else {
    fail(`ROUND2 richPanels runoffCoeff should be 0.40 for sentinel, got ${runoffCoeff}.`);
  }
}

function checkRound2TradeAggregateUnreallocatedFormula() {
  const candidate = loadTradeAggregateCandidate("ROUND2 unreallocated formula sentinel");
  if (!candidate) return;

  let aggregate;
  let noRetained;
  try {
    aggregate = candidate([], {
      withMarket: {
        allocation: { agri: 92.32, industry: 81.29, urban: 14.15 },
      },
      withoutMarket: {
        allocation: { agri: 100, industry: 100, urban: 10 },
      },
    });
    noRetained = candidate([], {
      withMarket: {
        allocation: { agri: 90, industry: 15, urban: 40 },
      },
      withoutMarket: {
        allocation: { agri: 100, industry: 20, urban: 20 },
      },
    });
  } catch (error) {
    fail(`ROUND2 tradeAggregate unreallocated sentinel threw: ${error.message}`);
    return;
  }

  const unreallocated = numberOr(aggregate && aggregate.sectorReallocation && aggregate.sectorReallocation.unreallocated, NaN);
  if (closeTo(unreallocated, ROUND2_EXPECTED_SANKEY_UNREALLOCATED, 1e-6)) {
    ok("ROUND2 tradeAggregate unreallocated equals reductions minus gains for the 26.39 vs 4.15 yi sentinel");
  } else {
    fail(`ROUND2 tradeAggregate unreallocated should be 22.24, not the old 15.18; got ${unreallocated}.`);
  }

  const clamped = numberOr(noRetained && noRetained.sectorReallocation && noRetained.sectorReallocation.unreallocated, NaN);
  if (Number.isFinite(clamped) && clamped >= -1e-9) {
    ok("ROUND2 tradeAggregate unreallocated is non-negative when gains exceed reductions");
  } else {
    fail(`ROUND2 tradeAggregate unreallocated should be clamped to >=0 when gains exceed reductions, got ${clamped}.`);
  }
}

function checkRound2SankeyAcceptance() {
  const richPanelsSource = readSource(RICH_PANELS_JS_PATH);
  let api;
  try {
    delete require.cache[require.resolve(SANKEY_JS_PATH)];
    api = require(SANKEY_JS_PATH);
  } catch (error) {
    fail(`ROUND2 could not require sankey.js: ${error.message}`);
    return;
  }
  if (!api || typeof api.renderToString !== "function" || typeof api.buildSectorDispatchLinks !== "function") {
    fail("ROUND2 sankey.js should export renderToString() and buildSectorDispatchLinks() for conservation acceptance.");
    return;
  }

  const reallocation = [
    { key: "agri", label: "农业", delta: -7.68 },
    { key: "industry", label: "工业", delta: -18.71 },
    { key: "urban", label: "生活", delta: 4.15 },
  ];
  const expectedGap = ROUND2_EXPECTED_SANKEY_UNREALLOCATED;
  const rendered = api.renderToString({ reallocation });
  const links = api.buildSectorDispatchLinks(reallocation);
  const totalReduce = reallocation.reduce((sum, item) => item.delta < 0 ? sum + Math.abs(item.delta) : sum, 0);
  const totalGain = reallocation.reduce((sum, item) => item.delta > 0 ? sum + item.delta : sum, 0);
  const linkTotal = links.reduce((sum, link) => sum + numberOr(link.value, 0), 0);
  const sinkIncoming = links
    .filter((link) => link.to && link.to.label === "留在河道/未取用")
    .reduce((sum, link) => sum + numberOr(link.value, 0), 0);

  if (/留在河道\/未取用/.test(rendered)) {
    ok("ROUND2 Sankey renders the exact sink label 留在河道/未取用");
  } else {
    fail("ROUND2 Sankey must use the exact sink label 留在河道/未取用.");
  }

  if (!/留在河道\/未再配|原未取用\/新增配水/.test(rendered)) {
    ok("ROUND2 Sankey no longer renders old ambiguous unreallocated labels");
  } else {
    fail("ROUND2 Sankey should not render old labels 留在河道/未再配 or 原未取用/新增配水 for the reduction-gap case.");
  }

  if (/UNREALLOCATED_LABEL\s*=\s*['"]留在河道\/未取用['"]/.test(richPanelsSource)) {
    ok("ROUND2 richPanels fallback Sankey uses the exact sink label 留在河道/未取用");
  } else {
    fail("ROUND2 richPanels fallback Sankey must update UNREALLOCATED_LABEL to 留在河道/未取用.");
  }

  if (!/UNREALLOCATED_LABEL\s*=\s*['"]留在河道\/未再配['"]|SUPPLEMENTAL_SOURCE_LABEL\s*=\s*['"]原未取用\/新增配水['"]/.test(richPanelsSource)) {
    ok("ROUND2 richPanels fallback removed old ambiguous Sankey constants");
  } else {
    fail("ROUND2 richPanels fallback should remove old labels 留在河道/未再配 and 原未取用/新增配水.");
  }

  if (closeTo(totalReduce - totalGain, expectedGap, 1e-6) && closeTo(sinkIncoming, expectedGap, 1e-6)) {
    ok("ROUND2 Sankey sink equals reduction total minus gain total");
  } else {
    fail(`ROUND2 Sankey sink should equal ${expectedGap}; reductions=${totalReduce}, gains=${totalGain}, sink=${sinkIncoming}.`);
  }

  if (closeTo(linkTotal, totalReduce, 1e-6) && closeTo(totalGain + sinkIncoming, totalReduce, 1e-6)) {
    ok("ROUND2 Sankey conserves left and right totals after adding the sink node");
  } else {
    fail(`ROUND2 Sankey should conserve totals; left=${totalReduce}, right=${totalGain + sinkIncoming}, linkTotal=${linkTotal}.`);
  }
}

function checkPolicyNarrativeFixAcceptance(sources) {
  const richPanelsSource = sources.richPanelsSource || "";
  const richPanelsTestSource = sources.richPanelsTestSource || "";
  const networkSource = sources.networkSource || "";
  const updateSource = functionBlock(richPanelsSource, "update");
  const comparisonSource = functionBlock(richPanelsSource, "renderComparisonPanel");
  const noTaxIndex = updateSource.indexOf("renderNoTaxComparisonPanel");
  const comparisonIndex = updateSource.indexOf("renderComparisonPanel");

  if (noTaxIndex >= 0 && comparisonIndex >= 0 && noTaxIndex < comparisonIndex) {
    ok("POLICY-NARRATIVE P1 keeps the health-tax comparison before the trade-efficiency comparison");
  } else {
    fail("POLICY-NARRATIVE P1 richPanels.update must render 有/无健康税对比 before 交易效率对比.");
  }

  if (/交易效率对比（有无交易）/.test(comparisonSource)) {
    ok("POLICY-NARRATIVE P2 renames the comparison title to 交易效率对比（有无交易）");
  } else {
    fail("POLICY-NARRATIVE P2 renderComparisonPanel title must be 交易效率对比（有无交易）.");
  }

  if (!/有\/无市场对比/.test(comparisonSource)) {
    ok("POLICY-NARRATIVE P2 removes the old title 有/无市场对比 from renderComparisonPanel");
  } else {
    fail("POLICY-NARRATIVE P2 renderComparisonPanel must not keep the old title 有/无市场对比.");
  }

  const explainsIndustrialIncrease =
    /交易效率/.test(comparisonSource) &&
    /工业(?:在此)?(?:增加|上升)|工业(?:用水|取水|配水)(?:增加|上升)/.test(comparisonSource) &&
    /效率改善/.test(comparisonSource) &&
    /非政策效应|非健康税政策效应|不是政策效应/.test(comparisonSource) &&
    /健康税[\s\S]{0,120}(?:见上方|上方)/.test(comparisonSource);
  if (explainsIndustrialIncrease) {
    ok("POLICY-NARRATIVE P2 explains industrial increase as efficiency improvement, not policy effect, and points to the health-tax panel");
  } else {
    fail("POLICY-NARRATIVE P2 trade-efficiency note must say 工业增加=效率改善/非政策效应 and 健康税见上方.");
  }

  if (/function\s+getDemandElasticity/.test(networkSource)) {
    const demandElasticitySource = functionBlock(networkSource, "getDemandElasticity");
    if (/,\s*0\.9\s*\)\s*\)?\s*;?\s*\}/.test(demandElasticitySource) || /0\.9/.test(demandElasticitySource)) {
      ok("POLICY-NARRATIVE P3 source default demandElasticity is anchored at 0.9");
    } else {
      fail("POLICY-NARRATIVE P3 getDemandElasticity default must be 0.9 when demandElasticity is implemented.");
    }
  } else {
    ok("POLICY-NARRATIVE P3 demandElasticity helper is not implemented in source; source default check is skipped");
  }

  if (/assertPolicyNarrativeTradeEfficiencySentinel/.test(richPanelsTestSource) &&
      /交易效率对比（有无交易）/.test(richPanelsTestSource) &&
      /有\/无市场对比/.test(richPanelsTestSource)) {
    ok("POLICY-NARRATIVE richPanels.test.js includes title/order/explanation sentinels");
  } else {
    fail("POLICY-NARRATIVE richPanels.test.js must include sentinels for trade-efficiency title/order/explanation and old-title rejection.");
  }
}

function checkEcoFlowUpgradeAcceptance() {
  const networkSource = readSource(NETWORK_MODEL_JS_PATH);
  const mainSource = readSource(MAIN_JS_PATH);
  const richPanelsSource = readSource(RICH_PANELS_JS_PATH);
  const regionSelectSource = readSource(REGION_SELECT_JS_PATH);
  const tauResponseSource = readSource(TAU_RESPONSE_JS_PATH);
  const indexSource = readSource(INDEX_PATH);
  const dashboardSource = readSource(DASHBOARD_JS_PATH);
  const sankeySource = readSource(SANKEY_JS_PATH);
  const tradeAggregateSource = readSource(TRADE_AGGREGATE_JS_PATH);
  const networkModelTestSource = readSource(NETWORK_MODEL_TEST_PATH);
  const richPanelsTestSource = readSource(RICH_PANELS_TEST_PATH);
  const uiSource = `${richPanelsSource}\n${dashboardSource}\n${readSource(INDEX_PATH)}`;

  checkThreeWithdrawalSectorBlock("networkModel.js SECTORS", constArrayBlock(networkSource, "SECTORS"));
  checkThreeWithdrawalSectorBlock("richPanels.js SECTORS", constArrayBlock(richPanelsSource, "SECTORS"));
  checkThreeWithdrawalSectorBlock("tradeAggregate.js SECTORS", constArrayBlock(tradeAggregateSource, "SECTORS"));
  checkThreeWithdrawalSectorBlock("sankey.js DEFAULT_SECTORS", constArrayBlock(sankeySource, "DEFAULT_SECTORS"));

  if (!/(生态取水|生态部门配水|生态配水部门)/.test(uiSource)) {
    ok("ECO-FLOW UI copy removes old ecological-withdrawal wording");
  } else {
    fail("ECO-FLOW UI copy must not contain 生态取水/生态部门配水/生态配水部门 wording.");
  }

  if (!/健康权重：生活 1\.0\s*\/\s*生态 0\.7/.test(uiSource) && !/四部门/.test(uiSource)) {
    ok("ECO-FLOW RICH/trade copy no longer describes ecology as a fourth allocation department");
  } else {
    fail("ECO-FLOW RICH/trade copy must remove old four-department and 生态健康权重 allocation wording.");
  }

  const hasEcoFlowFields = /ecoBaseFlow/.test(networkSource) &&
    /inStreamFlow/.test(networkSource) &&
    /ecoSurplus/.test(networkSource);
  if (hasEcoFlowFields) {
    ok("ECO-FLOW model result exposes ecoBaseFlow, inStreamFlow, and ecoSurplus fields");
  } else {
    fail("ECO-FLOW model result must expose ecoBaseFlow, inStreamFlow, and ecoSurplus fields.");
  }

  const outflowBoundUsesEcoBase = /lpOutflowVar\([^)]*\)[\s\S]{0,160}lb:\s*ecoBaseFlow/.test(networkSource) ||
    /lb:\s*ecoBaseFlow[\s\S]{0,160}lpOutflowVar\(/.test(networkSource) ||
    /lpOutflowVar\([^)]*\)[\s\S]{0,200}lb:\s*[^,\n;]*\.ecoBaseFlow/.test(networkSource) ||
    /out_i\s*>=?\s*E_i|生态基流硬约束|ecoBaseFlow\[[^\]]+\][\s\S]{0,220}GLP_LO/.test(networkSource);
  if (outflowBoundUsesEcoBase) {
    ok("ECO-FLOW model bounds outflow by ecological base flow");
  } else {
    fail("ECO-FLOW model must enforce outflow/inStreamFlow >= ecoBaseFlow rather than lb=0.");
  }

  const autarkyEcoFlowEvidence = /autarky[\s\S]{0,5000}ecoBaseFlow|ecoBaseFlow[\s\S]{0,5000}autarky/i.test(networkSource);
  if (autarkyEcoFlowEvidence) {
    ok("ECO-FLOW autarky baseline carries the same ecological-flow fields/constraint");
  } else {
    fail("ECO-FLOW autarky baseline must carry the ecological-flow fields/constraint so comparisons share one口径.");
  }

  const richEcoFlowEvidence = /生态基流/.test(uiSource) &&
    /环境流量/.test(uiSource) &&
    /ecoBaseFlow/.test(richPanelsSource) &&
    /ecoSurplus/.test(richPanelsSource) &&
    /(environmentFlow|environmentalFlow|inStreamFlow)/.test(richPanelsSource);
  if (richEcoFlowEvidence) {
    ok("ECO-FLOW RICH panels aggregate and label ecological base flow plus environmental flow");
  } else {
    fail("ECO-FLOW RICH panels must aggregate ecoBaseFlow + ecoSurplus and label 生态基流/环境流量.");
  }

  if (/assertEcoFlowAggregationContract/.test(richPanelsTestSource) &&
      /assertEcoFlowUpgradeSentinels/.test(richPanelsTestSource) &&
      /assertNoTaxComparisonSentinel/.test(richPanelsTestSource)) {
    ok("ECO-FLOW richPanels.test.js includes environmental-flow, sector-removal, and noTax sentinels");
  } else {
    fail("ECO-FLOW richPanels.test.js must include environmental-flow, sector-removal, and noTax sentinels.");
  }

  if (/assertHealthTaxFullBakeTauGridAcceptance/.test(networkModelTestSource) &&
      /assertHealthTaxDefaultNoTaxComparison/.test(networkModelTestSource) &&
      /assertHealthTaxAutarkyAcceptance/.test(networkModelTestSource) &&
      /assertTradeScopeHealthTaxAcceptance/.test(networkModelTestSource)) {
    ok("HEALTH-TAX networkModel.test.js covers tau-grid, noTax, autarky, and tradeScope acceptance");
  } else {
    fail("HEALTH-TAX networkModel.test.js must cover E1/E2/E3 tau-grid, noTax, autarky, and tradeScope acceptance.");
  }

  if (/assertHealthTaxEffectivenessCopy/.test(richPanelsTestSource) &&
      /健康税\/庇古税有效|健康税（庇古税）是有效的|健康税[\s\S]{0,40}庇古税[\s\S]{0,40}有效/.test(richPanelsTestSource) &&
      /断崖归零/.test(richPanelsTestSource)) {
    ok("HEALTH-TAX richPanels.test.js includes effectiveness copy and cliff-to-zero sentinels");
  } else {
    fail("HEALTH-TAX richPanels.test.js must assert effectiveness copy and reject cliff-to-zero narration.");
  }

  const noTaxInputSource = [
    functionBlock(mainSource, "updateNoTaxBaseline"),
    functionBlock(mainSource, "buildNoTaxModelInput"),
    functionBlock(mainSource, "getNoTaxCacheKey"),
  ].join("\n");
  const noTaxPanelSource = [
    functionBlock(mainSource, "buildNoTaxComparison"),
    functionBlock(richPanelsSource, "renderNoTaxComparisonPanel"),
    functionBlock(richPanelsSource, "buildNoTaxComparison"),
  ].join("\n");
  const noTaxSource = `${mainSource}\n${richPanelsSource}`;
  if (/noTaxResult/.test(noTaxSource) &&
      /tau\s*:\s*0/.test(noTaxInputSource) &&
      !/trade\s*:\s*['"]autarky['"]|marketMode\s*:\s*['"]autarky['"]/.test(noTaxInputSource)) {
    ok("ECO-FLOW main/RICH source includes a noTaxResult solved at tau=0");
  } else {
    fail("ECO-FLOW main.js must solve/cache noTaxResult with tau=0 while keeping the current non-tau settings.");
  }

  if (/(工业取水|industryWithdrawal)/.test(noTaxPanelSource) &&
      /(环境流量|environmentalFlow|environmentFlow)/.test(noTaxPanelSource) &&
      /(DALY|dalyAvoided|dalyBurden)/i.test(noTaxPanelSource) &&
      /Δ|delta|变化|差值/.test(noTaxPanelSource)) {
    ok("ECO-FLOW noTax comparison exposes industrial withdrawal, environmental-flow, and DALY deltas");
  } else {
    fail("ECO-FLOW noTax comparison must expose 工业取水 Δ、环境流量 Δ、DALY Δ.");
  }

  if (/交易保持开启|均含交易|同一交易口径|交易仍开启|含交易/.test(noTaxPanelSource) &&
      (/不是自给自足对照|非自给自足|非无市场|not\s+autarky/i.test(noTaxPanelSource) ||
        !/(autarky|自给自足|无市场)/i.test(noTaxPanelSource))) {
    ok("ECO-FLOW noTax comparison keeps noTax semantics separate from autarky/no-market");
  } else {
    fail("ECO-FLOW noTax comparison must state trade remains enabled and must not mix noTax with autarky/no-market semantics.");
  }
  checkPolicyNarrativeFixAcceptance({ networkSource, richPanelsSource, richPanelsTestSource });

  const tradeScopeSource = `${indexSource}\n${mainSource}\n${richPanelsSource}\n${regionSelectSource}`;
  const readParamsSource = functionBlock(mainSource, "readParams");
  const scopedModelSource = [
    functionBlock(mainSource, "buildScopedModelInput"),
    functionBlock(mainSource, "extractSubNetwork"),
    functionBlock(mainSource, "normalizeSubNetwork"),
  ].join("\n");
  if (/tradeScope/.test(tradeScopeSource) &&
      /external/.test(tradeScopeSource) &&
      /internal/.test(tradeScopeSource) &&
      /外部调水/.test(tradeScopeSource) &&
      /内部解决/.test(tradeScopeSource)) {
    ok("HEALTH-TAX source exposes tradeScope external/internal labels");
  } else {
    fail("HEALTH-TAX source must expose tradeScope external/internal with 外部调水/内部解决 labels.");
  }
  if (/tradeScope/.test(readParamsSource) &&
      /tradeScope/.test(scopedModelSource) &&
      /extractSubNetwork[\s\S]{0,180}tradeScope|tradeScope[\s\S]{0,180}extractSubNetwork/.test(scopedModelSource)) {
    ok("HEALTH-TAX main.js reads tradeScope and passes it into scoped subnetwork extraction");
  } else {
    fail("HEALTH-TAX main.js must read tradeScope and pass it to extractSubNetwork/buildScopedModelInput.");
  }

  const tauScriptIndex = scriptTagIndex(indexSource, "js/tauResponseChart.js");
  const richPanelsIndex = scriptTagIndex(indexSource, "js/richPanels.js");
  const mainIndex = scriptTagIndex(indexSource, "js/main.js");
  if (tauScriptIndex >= 0 &&
      (richPanelsIndex < 0 || tauScriptIndex < richPanelsIndex) &&
      (mainIndex < 0 || tauScriptIndex < mainIndex)) {
    ok("ECO-FLOW tauResponseChart.js is loaded before RICH/main consumers");
  } else {
    fail("ECO-FLOW index.html must load js/tauResponseChart.js before richPanels.js and main.js.");
  }

  const tauResponseWired = /function\s+updateTauResponse/.test(mainSource) &&
    /TauResponseChart\.scanTau/.test(mainSource) &&
    /tauResponse:\s*state\.tauResponse/.test(mainSource) &&
    /context\.tauResponse/.test(richPanelsSource) &&
    /renderTauResponsePanel/.test(richPanelsSource) &&
    /function\s+scanTau/.test(tauResponseSource) &&
    /renderToString/.test(tauResponseSource);
  if (tauResponseWired) {
    ok("ECO-FLOW tau response scan is wired from main.js into RICH panels");
  } else {
    fail("ECO-FLOW tau response curve must be scanned in main.js and passed as context.tauResponse to RICH.");
  }

  checkEcoFlowDynamicTauGridAcceptance();
  checkHealthTaxDefaultNoTaxAcceptance();
  checkHealthTaxAutarkyAcceptance();
  checkHealthTaxTradeScopeDynamicAcceptance();
}

function checkRound3RichPanelStaticAcceptance() {
  const validatorSource = readSource(__filename);
  const mainSource = readSource(MAIN_JS_PATH);
  const richPanelsSource = readSource(RICH_PANELS_JS_PATH);
  const richPanelsTestSource = readSource(RICH_PANELS_TEST_PATH);
  const comparisonSource = functionBlock(richPanelsSource, "renderComparisonPanel");
  const allocationBarsSource = functionBlock(richPanelsSource, "renderAllocationComparisonBars");
  const tradeVisualsSource = functionBlock(richPanelsSource, "buildTradeVisuals");
  const mainComparisonSource = functionBlock(mainSource, "buildNoMarketComparison");
  const renderedComparisonTextSources = `${comparisonSource}\n${allocationBarsSource}\n${mainComparisonSource}`;

  if (/τ\s*=\s*0|健康底线\s*=\s*0|交易成本\s*=\s*最高/.test(renderedComparisonTextSources)) {
    fail("ROUND3 RICH comparison text must not describe the comparison baseline as τ=0 / healthFloor=0 / highest trading cost.");
  } else {
    ok("ROUND3 RICH comparison text no longer exposes the old τ=0 / healthFloor=0 / highest-cost baseline");
  }

  if (/自给自足|autarky/i.test(comparisonSource + allocationBarsSource) &&
      /(?:有交易|有市场)[\s\S]{0,120}(自给自足|autarky)|(自给自足|autarky)[\s\S]{0,120}(?:有交易|有市场)/i.test(comparisonSource + allocationBarsSource)) {
    ok("ROUND3 RICH comparison labels use the self-sufficiency/autarky baseline against the with-trade scenario");
  } else {
    fail("ROUND3 RICH comparison labels and legend should identify the baseline as 自给自足/autarky against 有交易, not generic τ=0 no-market.");
  }

  const autarkyIndex = tradeVisualsSource.search(/autarkyResult|autarky/i);
  const noMarketIndex = tradeVisualsSource.search(/noMarketResult|noMarket/i);
  if (autarkyIndex >= 0 && (noMarketIndex < 0 || autarkyIndex < noMarketIndex)) {
    ok("ROUND3 RICH buildTradeVisuals prefers autarkyResult before noMarketResult for comparison bars");
  } else {
    fail("ROUND3 RICH buildTradeVisuals must prefer autarkyResult before noMarketResult so τ=0 results cannot shadow the autarky baseline.");
  }

  const deltaUsesRenderedBaseline = /withMarket\[(?:sector\.key|key)\]\s*-\s*withoutMarket\[(?:sector\.key|key)\]/.test(tradeVisualsSource);
  const staleExternalDeltaOverride = /hasExternalDelta\s*\?[\s\S]{0,120}externalDelta/.test(tradeVisualsSource) ||
    /externalDelta\s*=\s*normalizeSectorMap\(\s*sectorReallocation\s*\)/.test(tradeVisualsSource);
  if (deltaUsesRenderedBaseline && !staleExternalDeltaOverride) {
    ok("ROUND3 RICH sector deltas are derived from withMarket - withoutMarket for each rendered department");
  } else {
    fail("ROUND3 RICH sector deltas must equal withMarket - withoutMarket and must not be overridden by stale sectorReallocation values.");
  }

  if (/makeRound3AutarkyBaselineFixture/.test(richPanelsTestSource) &&
      /noMarketResult/.test(richPanelsTestSource) &&
      /autarkyResult/.test(richPanelsTestSource) &&
      /withMarket\s*-\s*autarky|自给自足/.test(richPanelsTestSource)) {
    ok("ROUND3 richPanels.test.js includes the noMarket=current and autarky-different sentinel fixture");
  } else {
    fail("ROUND3 richPanels.test.js must include a fixture where noMarketResult equals current result while autarkyResult differs.");
  }

  const round2Chain = functionBlock(validatorSource, "checkRound2QaFixes");
  const round2Checks = [
    "checkRound2HydrologyDataAnchors",
    "checkRound2RichPanelsFunctionalAcceptance",
    "checkRound2TradeAggregateUnreallocatedFormula",
    "checkRound2SankeyAcceptance",
  ];
  const missingRound2Checks = round2Checks.filter((name) => !round2Chain.includes(name));
  if (missingRound2Checks.length) {
    fail(`ROUND3 validator must keep Round2 acceptance anchors wired; missing ${missingRound2Checks.join(", ")}.`);
  } else {
    ok("ROUND3 validator keeps the Round2 hydrology, rich-panel, tradeAggregate, and Sankey anchors wired");
  }
}

function checkRound2QaFixes() {
  checkRound2HydrologyDataAnchors();
  checkRound2RichPanelsFunctionalAcceptance();
  checkRound2TradeAggregateUnreallocatedFormula();
  checkRound2SankeyAcceptance();
}

function checkTradeFlowFixFeature() {
  checkTradeFlowFixAggregateContract();
  checkTradeFlowFixUiWiring();
  checkTradeFlowFixHonestLabels();
  checkTradeFlowFixAutarkyMethodology();
  checkTradeFlowFixNoiseEvidence();
}

function checkTradeVizFeature() {
  checkTradeVizIndexWiring();
  checkTradeAggregateApi();
  runNode("trade aggregate regression", TRADE_AGGREGATE_TEST_PATH);
  checkTradeVizMapEvidence();
  checkTradeVizPanels();
  checkTradeFlowFixFeature();
  checkTradeVizQaFixListCoverage();
}

function main() {
  console.log("Region feature DoD validation");
  checkPre1ExternalInflow();
  checkPre1NoTransitDoubleCount();
  runNode("full-bake data validator", VALIDATE_DATA_PATH, ["--full-bake"]);
  runNode("network model regression", NETWORK_MODEL_TEST_PATH);
  runNode("region selection and boundary inflow regression", REGION_SELECT_TEST_PATH);
  checkNameFeature();
  runNode("RICH panels, tables, externality, autarky comparison, and comparison regression", RICH_PANELS_TEST_PATH);
  checkEcoFlowUpgradeAcceptance();
  checkRealisticModelDynamicAcceptance();
  checkRound3RichPanelStaticAcceptance();
  checkRound2QaFixes();
  checkIndexSmoke();
  checkTradeVizFeature();

  if (warnings > 0) {
    fail(`Validation emitted ${warnings} warning(s); RICH acceptance requires 0 warnings.`);
  }

  if (failures > 0) {
    console.error(`\nValidation failed with ${failures} failure(s) and ${warnings} warning(s).`);
    process.exit(1);
  }
  console.log(`\nValidation passed with ${warnings} warning(s).`);
}

main();
