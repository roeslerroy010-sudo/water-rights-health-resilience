const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ResearchNetworkModel = require("./networkModel");
const ResearchRegionSelect = require("./regionSelect");

const {
  normalizeInputs,
  topologicalSort,
  computeDownstreamReach,
  solveNetwork,
  solveAutarky,
  computeHealthTax,
  buildLpProblemInterface,
  estimateProblemSize,
  resolveLpSolverAdapter,
  solveNetworkLpAsync,
  _internals,
} = ResearchNetworkModel;
const Benchmark = require("./networkModel.benchmark");

const WATER_SECTORS = ["urban", "agri", "industry"];
// 健康底线罚则为 100 元/m³；影子价格若接近或超过它，说明价格被罚项污染而非真实稀缺租金。
const HEALTH_FLOOR_PENALTY_PROBE = 100;
const WUHAN_ATTRS_PATH = path.resolve(__dirname, "../data/wuhan-attrs.json");
const HEALTH_TAX_TAU_GRID = [0, 0.1, 0.24, 0.3, 0.4, 0.5];
const HEALTH_TAX_FULL_BAKE_PARAMS = Object.freeze({
  climate: "ssp245",
  ecoFloor: 0.15,
  healthFloor: 0.26,
  tradingCost: 0.1,
});

const fixture = {
  meta: {
    region: "unit-test-basin",
    synthetic: true,
  },
  topology: {
    A: "B",
    B: "C",
    C: "OUTLET",
  },
  subbasins: [
    {
      id: "A",
      name: "Headwater industry",
      population: 10000,
      demand: { urban: 10, eco: 0, agri: 20, industry: 10 },
      supply: { qLocal: 240, runoffCoeff: 0.4 },
      healthWeight: { urban: 1, eco: 0.7, agri: 0.1, industry: -0.25 },
    },
    {
      id: "B",
      name: "Midstream city",
      population: 180000,
      demand: { urban: 95, eco: 10, agri: 25, industry: 5 },
      supply: { qLocal: 10, runoffCoeff: 0.35 },
      healthWeight: { urban: 1, eco: 0.7, agri: 0.1, industry: -0.25 },
    },
    {
      id: "C",
      name: "Downstream intake",
      population: 320000,
      demand: { urban: 80, eco: 20, agri: 10, industry: 0 },
      supply: { qLocal: 5, runoffCoeff: 0.3 },
      healthWeight: { urban: 1, eco: 0.7, agri: 0.1, industry: -0.25 },
    },
  ],
};

function assertNonNegative(value, label) {
  assert.ok(value >= -1e-9, label + " should be non-negative, got " + value);
}

function assertApprox(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    label + " expected " + expected + " ± " + tolerance + ", got " + actual
  );
}

function sumSectorValues(values) {
  return WATER_SECTORS.reduce((sum, sector) => sum + (values[sector] || 0), 0);
}

function assertSectorUnmetNearZero(result, label, tolerance) {
  for (const sector of WATER_SECTORS) {
    assert.ok(
      result.totals.unmet[sector] <= tolerance,
      label + " " + sector + " unmet should be near zero, got " + result.totals.unmet[sector]
    );
  }
}

// 干流取水许可口径下，正常年份不再要求「所有部门都不缺水」。
// 可配置水量 = 本地水资源总量 + 取水许可，过境客水不计入，因此缺口会出现。
// 有经济含义的断言是缺口的**次序**：生活用水优先保障，工业按税后有效需求满足，
// 农业作为边际用户承担调节。见 docs/economics-audit.md F1。
function assertCurtailmentOrder(result, label, tolerance, maxIndustryRate) {
  const rate = (sector) => {
    const cap = result.totals.demandCap[sector] || 0;
    return cap > 0 ? result.totals.unmet[sector] / cap : 0;
  };
  const urbanRate = rate("urban");
  const industryRate = rate("industry");
  const agriRate = rate("agri");
  assert.ok(
    urbanRate <= tolerance,
    label + " urban demand must be fully met (health floor binds first), shortfall rate " + urbanRate
  );
  assert.ok(
    agriRate > industryRate,
    label + " agriculture must absorb curtailment ahead of industry, got agri " + agriRate + " vs industry " + industryRate
  );
  const industryCeiling = maxIndustryRate === undefined ? 0.01 : maxIndustryRate;
  assert.ok(
    industryRate < industryCeiling,
    label + " industry stays within " + (industryCeiling * 100) + "% of its tax-adjusted effective demand cap, got " + industryRate
  );
}

function assertNoEcoAllocation(node, label) {
  assert.ok(!Object.prototype.hasOwnProperty.call(node.allocation, "eco"), label + " allocation should not expose eco as a withdrawal sector");
  assert.ok(!Object.prototype.hasOwnProperty.call(node.unmet, "eco"), label + " unmet should not expose eco as a withdrawal sector");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(node.demand, "eco"), true, label + " keeps legacy demand.eco for ecoBaseFlow");
}

function assertEcoFlowNode(node, label) {
  assertNoEcoAllocation(node, label);
  assertNonNegative(node.ecoBaseFlow, label + " ecoBaseFlow");
  assertNonNegative(node.inStreamFlow, label + " inStreamFlow");
  assertNonNegative(node.ecoSurplus, label + " ecoSurplus");
  const localSupply = Number.isFinite(node.localRunoff) ? node.localRunoff : node.qLocalRaw;
  if (Number.isFinite(localSupply)) {
    const expectedEcoBaseFlow = Math.min(
      Math.max(node.ecoFloor * localSupply, node.legacyEcoDemand),
      0.95 * localSupply
    );
    assertApprox(node.naturalFlow, localSupply, Math.max(1e-5, Math.abs(localSupply) * 1e-9), label + " eco naturalFlow uses local runoff only");
    assert.ok(node.ecoBaseFlow <= 0.95 * localSupply + 1e-6, label + " ecoBaseFlow is capped at 95% of local runoff");
    assertApprox(node.ecoBaseFlow, expectedEcoBaseFlow, Math.max(1e-5, Math.abs(expectedEcoBaseFlow) * 1e-9), label + " ecoBaseFlow excludes transit and routed water");
  }
  assert.ok(node.qOutflow + 1e-6 >= node.ecoBaseFlow, label + " qOutflow preserves ecoBaseFlow");
  assert.ok(node.inStreamFlow === node.qOutflow, label + " inStreamFlow aliases qOutflow");
  assert.ok(node.qWithdrawn <= Math.max(0, node.qAvail - node.ecoBaseFlow) + 1e-6, label + " withdrawal respects ecoBaseFlow cap");
  assertApprox(node.ecoSurplus, Math.max(0, node.qOutflow - node.ecoBaseFlow), Math.max(1e-5, Math.abs(node.qOutflow) * 1e-9), label + " ecoSurplus is outflow above ecoBaseFlow");
  assertApprox(node.environmentalFlow, node.ecoBaseFlow + node.ecoSurplus, Math.max(1e-5, Math.abs(node.environmentalFlow) * 1e-9), label + " environmentalFlow equals ecoBaseFlow plus ecoSurplus");
  assertApprox(node.environmentalFlow, node.inStreamFlow, Math.max(1e-5, Math.abs(node.inStreamFlow) * 1e-9), label + " environmentalFlow aliases inStreamFlow when base-flow constraint holds");
  assert.ok(node.waterBalance, label + " exposes waterBalance");
  assert.ok(Math.abs(node.waterBalance.residual) <= 1e-5, label + " waterBalance closes");
}

function assertEcoFlowResult(result, label) {
  for (const node of result.nodes) {
    assertEcoFlowNode(node, label + " " + node.id);
  }
  assert.ok(result.totals.outflow + 1e-6 >= result.totals.ecoBaseFlow, label + " totals outflow preserves ecoBaseFlow");
  assert.strictEqual(result.totals.inStreamFlow, result.totals.outflow, label + " totals inStreamFlow aliases outflow");
  assert.ok(Math.abs(result.totals.environmentalFlow - result.totals.inStreamFlow) <= 1e-6, label + " totals environmentalFlow aliases inStreamFlow");
  assert.ok(!Object.prototype.hasOwnProperty.call(result.totals.allocation, "eco"), label + " totals allocation excludes eco");
}

function makeTransitFixture(mainstemInflow) {
  return {
    topology: {
      IN: "DOWN",
      DOWN: "OUTLET",
    },
    subbasins: [
      {
        id: "IN",
        name: "Mainstem entry",
        population: 1000,
        demand: { urban: 5, eco: 0, agri: 0, industry: 0 },
        supply: { qLocal: 10, mainstemInflow, runoffCoeff: 0.4 },
        healthWeight: { urban: 1, eco: 0.7, agri: 0.1, industry: -0.25 },
      },
      {
        id: "DOWN",
        name: "Downstream demand",
        population: 240000,
        demand: { urban: 70, eco: 10, agri: 0, industry: 0 },
        supply: { qLocal: 0, runoffCoeff: 0.32 },
        healthWeight: { urban: 1, eco: 0.7, agri: 0.1, industry: -0.25 },
      },
    ],
  };
}

function makeAutarkyFixture() {
  return {
    topology: {
      HEAD: "MID",
      MID: "TAIL",
      TAIL: "OUTLET",
    },
    subbasins: [
      {
        id: "HEAD",
        name: "Transit entry",
        population: 12000,
        demand: { urban: 10, eco: 0, agri: 100, industry: 100 },
        supply: { qLocal: 10, mainstemInflow: 90, runoffCoeff: 0.42 },
        healthWeight: { urban: 1, eco: 0.7, agri: 0.1, industry: -0.25 },
      },
      {
        id: "MID",
        name: "Mid health demand",
        population: 200000,
        demand: { urban: 20, eco: 10, agri: 20, industry: 20 },
        supply: { qLocal: 5, runoffCoeff: 0.36 },
        healthWeight: { urban: 1, eco: 0.7, agri: 0.1, industry: -0.25 },
      },
      {
        id: "TAIL",
        name: "Tail health demand",
        population: 280000,
        demand: { urban: 30, eco: 10, agri: 60, industry: 60 },
        supply: { qLocal: 0, runoffCoeff: 0.31 },
        healthWeight: { urban: 1, eco: 0.7, agri: 0.1, industry: -0.25 },
      },
    ],
  };
}

function makeExposureFixture(options) {
  return {
    topology: {
      UP: "CITY",
      CITY: "OUTLET",
    },
    subbasins: [
      {
        id: "UP",
        name: "Upstream industry",
        population: 1000,
        demand: { urban: 0, eco: 0, agri: 0, industry: options.industryDemand },
        supply: { qLocal: 120 },
        healthWeight: { urban: 1, eco: 0.7, agri: 0.1, industry: -0.3 },
      },
      {
        id: "CITY",
        name: "Downstream city",
        population: options.downstreamPopulation,
        demand: { urban: 20, eco: 0, agri: 0, industry: 0 },
        supply: { qLocal: 0 },
        healthWeight: { urban: 1, eco: 0.7, agri: 0.1, industry: -0.25 },
      },
    ],
  };
}

function makeRiverRetentionFixture() {
  return {
    topology: {
      UP: "DOWN",
      DOWN: "OUTLET",
    },
    subbasins: [
      {
        id: "UP",
        name: "Industrial reach with optional instream retention",
        population: 1000,
        demand: { urban: 0, eco: 10, agri: 20, industry: 40 },
        supply: { qLocal: 100 },
        sectorValue: { urban: 3.2, agri: 1.15, industry: 1.45 },
        healthWeight: { urban: 1, eco: 0.7, agri: 0.1, industry: -0.25 },
      },
      {
        id: "DOWN",
        name: "Downstream city",
        population: 500000,
        demand: { urban: 20, eco: 0, agri: 0, industry: 0 },
        supply: { qLocal: 0 },
        sectorValue: { urban: 3.2, agri: 1.15, industry: 1.45 },
        healthWeight: { urban: 1, eco: 0.7, agri: 0.1, industry: -0.25 },
      },
    ],
  };
}

function makeClimateStressFixture() {
  return {
    subbasins: [
      {
        id: "STRESS",
        name: "Mainstem-access stress test node",
        population: 100000,
        demand: { urban: 30, eco: 0, agri: 70, industry: 60 },
        supply: { qLocal: 100, mainstemInflow: 100, runoffCoeff: 0.4 },
        healthWeight: { urban: 1, eco: 0.7, agri: 0.1, industry: -0.25 },
      },
    ],
  };
}

function assertTauRetentionResponse(lowTauResult, highTauResult, label) {
  assertEcoFlowResult(lowTauResult, label + " low tau");
  assertEcoFlowResult(highTauResult, label + " high tau");
  assert.ok(
    highTauResult.totals.allocation.industry <= lowTauResult.totals.allocation.industry + 1e-6,
    label + " industry withdrawal should be non-increasing as tau rises"
  );
  assert.ok(
    highTauResult.totals.inStreamFlow > lowTauResult.totals.inStreamFlow + 1e-6,
    label + " inStreamFlow should strictly increase as tau rises"
  );
  assert.ok(
    highTauResult.totals.environmentalFlow > lowTauResult.totals.environmentalFlow + 1e-6,
    label + " environmentalFlow should strictly increase as tau rises"
  );
}

function numberOr(value, fallback) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function firstFinite() {
  for (let index = 0; index < arguments.length; index += 1) {
    const number = numberOr(arguments[index], NaN);
    if (Number.isFinite(number)) return number;
  }
  return NaN;
}

function readFullBakeWuhanAttrs() {
  const attrs = JSON.parse(fs.readFileSync(WUHAN_ATTRS_PATH, "utf8"));
  assert.strictEqual(
    Array.isArray(attrs.subbasins) ? attrs.subbasins.length : 0,
    66,
    "health-tax acceptance uses the full-bake wuhan-attrs fixture"
  );
  return attrs;
}

function summarizeHealthTaxResult(result, tau) {
  const totals = result && result.totals ? result.totals : {};
  const aggregate = result && result.aggregate ? result.aggregate : {};
  const allocation = totals.allocation || aggregate.allocation || {};
  const demand = totals.demand || aggregate.demand || {};
  const effectiveDemand = totals.effectiveDemand || totals.demandCap || aggregate.effectiveDemand || {};
  return {
    tau,
    nodeCount: Array.isArray(result && result.nodes) ? result.nodes.length : 0,
    industryWithdrawal: numberOr(allocation.industry, NaN),
    industryDemand: numberOr(demand.industry, NaN),
    industryEffectiveDemand: numberOr(effectiveDemand.industry, NaN),
    environmentalFlow: firstFinite(
      totals.environmentalFlow,
      totals.inStreamFlow,
      aggregate.environmentalFlow,
      aggregate.environmentFlow
    ),
    dalyAvoided: firstFinite(totals.dalyAvoided, totals.totalDalyAvoided, aggregate.dalyAvoided),
    dalyBurden: firstFinite(totals.dalyBurden, aggregate.dalyBurden),
  };
}

function formatHealthTaxPoint(point) {
  return [
    "tau=" + point.tau,
    "industry=" + point.industryWithdrawal,
    "env=" + point.environmentalFlow,
    "dalyAvoided=" + point.dalyAvoided,
    "dalyBurden=" + point.dalyBurden,
  ].join(" ");
}

function healthTaxSummary(points) {
  return points.map(formatHealthTaxPoint).join("; ");
}

function meaningfulDelta(reference) {
  return Math.max(Math.abs(numberOr(reference, 0)) * 1e-6, 1e-6);
}

function assertStrictlyDecreasing(points, key, label) {
  const summary = healthTaxSummary(points);
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1][key];
    const current = points[index][key];
    assert.ok(
      Number.isFinite(previous) && Number.isFinite(current) && current < previous - meaningfulDelta(previous),
      label + " should strictly decrease at every tau step; " + summary
    );
  }
}

function assertStrictlyIncreasing(points, key, label) {
  const summary = healthTaxSummary(points);
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1][key];
    const current = points[index][key];
    assert.ok(
      Number.isFinite(previous) && Number.isFinite(current) && current > previous + meaningfulDelta(previous),
      label + " should strictly increase at every tau step; " + summary
    );
  }
}

function assertDalyHealthImproves(points, label) {
  const summary = healthTaxSummary(points);
  const avoidedMonotonic = points.every((point) => Number.isFinite(point.dalyAvoided)) &&
    points.slice(1).every((point, index) => point.dalyAvoided >= points[index].dalyAvoided - 1e-6) &&
    points[points.length - 1].dalyAvoided > points[0].dalyAvoided + meaningfulDelta(points[0].dalyAvoided);
  const burdenMonotonic = points.every((point) => Number.isFinite(point.dalyBurden)) &&
    points.slice(1).every((point, index) => point.dalyBurden <= points[index].dalyBurden + 1e-6) &&
    points[points.length - 1].dalyBurden < points[0].dalyBurden - meaningfulDelta(points[0].dalyBurden);
  assert.ok(
    avoidedMonotonic || burdenMonotonic,
    label + " should monotonically improve DALY avoided or DALY burden; " + summary
  );
}

function solveHealthTaxFullBake(tau, params) {
  const result = solveNetwork({
    network: readFullBakeWuhanAttrs(),
    ...HEALTH_TAX_FULL_BAKE_PARAMS,
    ...(params || {}),
    tau,
  });
  assertEcoFlowResult(result, "health-tax full-bake tau=" + tau);
  return summarizeHealthTaxResult(result, tau);
}

function assertHealthTaxFullBakeTauGridAcceptance() {
  const points = HEALTH_TAX_TAU_GRID.map((tau) => solveHealthTaxFullBake(tau));
  const summary = healthTaxSummary(points);
  assert.ok(points.every((point) => point.nodeCount === 66), "health-tax tau grid solves all 66 Wuhan subbasins; " + summary);
  assertStrictlyDecreasing(points, "industryWithdrawal", "health-tax full-bake industry allocation");
  assertStrictlyIncreasing(points, "environmentalFlow", "health-tax full-bake environmental flow");
  assertDalyHealthImproves(points, "health-tax full-bake DALY response");

  const tau0 = points.find((point) => point.tau === 0);
  const current = points.find((point) => point.tau === 0.24);
  const high = points.find((point) => point.tau === 0.5);
  assert.ok(
    current.industryWithdrawal < tau0.industryWithdrawal - meaningfulDelta(tau0.industryWithdrawal),
    "default tau=0.24 must reduce industry versus tau=0; " + summary
  );
  assert.ok(
    high.industryWithdrawal > 0 && high.industryWithdrawal > tau0.industryWithdrawal * 0.35,
    "tau=0.5 must keep positive non-cliff industry allocation; " + summary
  );
  const maxAdjacentDrop = points.slice(1).reduce((max, point, index) => {
    return Math.max(max, points[index].industryWithdrawal - point.industryWithdrawal);
  }, 0);
  assert.ok(
    maxAdjacentDrop < tau0.industryWithdrawal * 0.25,
    "industry allocation should decline smoothly without a single cliff-like drop; " + summary
  );

  const stressPoints = HEALTH_TAX_TAU_GRID.map((tau) => solveHealthTaxFullBake(tau, { climate: "ssp585" }));
  const stressSummary = healthTaxSummary(stressPoints);
  const stressTau0 = stressPoints.find((point) => point.tau === 0);
  const stressHigh = stressPoints.find((point) => point.tau === 0.5);
  assertStrictlyDecreasing(stressPoints, "industryWithdrawal", "health-tax SSP5-8.5 industry allocation");
  assertStrictlyIncreasing(stressPoints, "environmentalFlow", "health-tax SSP5-8.5 environmental flow");
  assertDalyHealthImproves(stressPoints, "health-tax SSP5-8.5 DALY response");
  assert.ok(
    stressHigh.industryWithdrawal > 0 && stressHigh.industryWithdrawal > stressTau0.industryWithdrawal * 0.35,
    "SSP5-8.5 tau=0.5 must keep positive non-cliff industry allocation; " + stressSummary
  );
  const stressMaxAdjacentDrop = stressPoints.slice(1).reduce((max, point, index) => {
    return Math.max(max, stressPoints[index].industryWithdrawal - point.industryWithdrawal);
  }, 0);
  assert.ok(
    stressMaxAdjacentDrop < stressTau0.industryWithdrawal * 0.25,
    "SSP5-8.5 industry allocation should decline smoothly without a single cliff-like drop; " + stressSummary
  );
}

function solveHealthTaxFullBakeLp(glpk, tau, params) {
  const result = ResearchNetworkModel.solveWithGlpkInstance(glpk, readFullBakeWuhanAttrs(), {
    ...HEALTH_TAX_FULL_BAKE_PARAMS,
    ...(params || {}),
    tau,
  });
  assert.strictEqual(result.solver.lpStatus, "optimal", "health-tax LP full-bake tau=" + tau + " is optimal");
  assertEcoFlowResult(result, "health-tax LP full-bake tau=" + tau);
  return summarizeHealthTaxResult(result, tau);
}

function assertHealthTaxLpStressTauGridAcceptance(glpk) {
  const points = HEALTH_TAX_TAU_GRID.map((tau) => solveHealthTaxFullBakeLp(glpk, tau, { climate: "ssp585" }));
  const summary = healthTaxSummary(points);
  const tau0 = points.find((point) => point.tau === 0);
  const high = points.find((point) => point.tau === 0.5);
  assertStrictlyDecreasing(points, "industryWithdrawal", "health-tax LP SSP5-8.5 industry allocation");
  assertStrictlyIncreasing(points, "environmentalFlow", "health-tax LP SSP5-8.5 environmental flow");
  assertDalyHealthImproves(points, "health-tax LP SSP5-8.5 DALY response");
  assert.ok(
    high.industryWithdrawal > 0 && high.industryWithdrawal > tau0.industryWithdrawal * 0.35,
    "LP SSP5-8.5 tau=0.5 must keep positive non-cliff industry allocation; " + summary
  );
  const maxAdjacentDrop = points.slice(1).reduce((max, point, index) => {
    return Math.max(max, points[index].industryWithdrawal - point.industryWithdrawal);
  }, 0);
  assert.ok(
    maxAdjacentDrop < tau0.industryWithdrawal * 0.25,
    "LP SSP5-8.5 industry allocation should decline smoothly without a cliff-like drop; " + summary
  );
}

function assertHealthTaxDefaultNoTaxComparison() {
  const noTax = solveHealthTaxFullBake(0);
  const current = solveHealthTaxFullBake(0.24);
  assert.ok(
    current.industryWithdrawal - noTax.industryWithdrawal < -meaningfulDelta(noTax.industryWithdrawal),
    "current tau=0.24 should have a negative industry delta versus noTax"
  );
  assert.ok(
    current.environmentalFlow - noTax.environmentalFlow > meaningfulDelta(noTax.environmentalFlow),
    "current tau=0.24 should have a positive environmental-flow delta versus noTax"
  );
  assert.ok(
    current.dalyAvoided - noTax.dalyAvoided > meaningfulDelta(noTax.dalyAvoided),
    "current tau=0.24 should have a positive DALY avoided delta versus noTax"
  );
}

function assertHealthTaxAutarkyAcceptance() {
  const noTaxResult = solveNetwork({
    network: readFullBakeWuhanAttrs(),
    ...HEALTH_TAX_FULL_BAKE_PARAMS,
    trade: "autarky",
    tau: 0,
  });
  const currentResult = solveNetwork({
    network: readFullBakeWuhanAttrs(),
    ...HEALTH_TAX_FULL_BAKE_PARAMS,
    trade: "autarky",
    tau: 0.24,
  });
  assertEcoFlowResult(noTaxResult, "health-tax autarky noTax");
  assertEcoFlowResult(currentResult, "health-tax autarky current");
  const noTax = summarizeHealthTaxResult(noTaxResult, 0);
  const current = summarizeHealthTaxResult(currentResult, 0.24);
  assert.ok(
    current.industryWithdrawal < noTax.industryWithdrawal - meaningfulDelta(noTax.industryWithdrawal),
    "autarky tau=0.24 should reduce industry versus autarky tau=0"
  );
  assert.ok(
    current.industryEffectiveDemand < current.industryDemand - meaningfulDelta(current.industryDemand),
    "autarky tau=0.24 should expose an effective industry demand below raw demand"
  );
  assert.ok(
    current.industryWithdrawal <= current.industryEffectiveDemand + meaningfulDelta(current.industryEffectiveDemand),
    "autarky allocation must respect effective industry demand rather than raw full demand"
  );
}

function makeTradeScopeFixture() {
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
  const map = (subnet && subnet.boundaryInflowByNode) ||
    (subnet && subnet.meta && subnet.meta.boundaryInflowById) ||
    {};
  return Object.keys(map).reduce((sum, key) => sum + numberOr(map[key], 0), 0);
}

function solveTradeScopePoint(tradeScope, tau) {
  assert.strictEqual(typeof ResearchRegionSelect.extractSubNetwork, "function", "regionSelect exposes extractSubNetwork");
  const subnet = ResearchRegionSelect.extractSubNetwork(["A", "B"], makeTradeScopeFixture(), { tradeScope });
  const result = solveNetwork({
    network: subnet,
    ...HEALTH_TAX_FULL_BAKE_PARAMS,
    tau,
  });
  assertEcoFlowResult(result, "tradeScope " + tradeScope + " tau=" + tau);
  return {
    tradeScope,
    subnet,
    boundaryInflow: sumBoundaryInflow(subnet),
    summary: summarizeHealthTaxResult(result, tau),
    result,
  };
}

function assertTradeScopeHealthTaxAcceptance() {
  const externalNoTax = solveTradeScopePoint("external", 0);
  const externalCurrent = solveTradeScopePoint("external", 0.24);
  const internalNoTax = solveTradeScopePoint("internal", 0);
  const internalCurrent = solveTradeScopePoint("internal", 0.24);

  assert.strictEqual(externalCurrent.subnet.meta.tradeScope, "external", "external tradeScope metadata is preserved");
  assert.strictEqual(internalCurrent.subnet.meta.tradeScope, "internal", "internal tradeScope metadata is preserved");
  assert.ok(externalCurrent.boundaryInflow > 0, "external tradeScope retains boundary inflow");
  assert.strictEqual(internalCurrent.boundaryInflow, 0, "internal tradeScope zeros boundary inflow");
  assert.ok(externalCurrent.result.totals.externalInflow > 0, "external tradeScope solve keeps boundary/external inflow available");
  assert.strictEqual(internalCurrent.result.totals.externalInflow, 0, "internal tradeScope solve has zero boundary/external inflow");
  assert.ok(
    externalCurrent.summary.industryWithdrawal < externalNoTax.summary.industryWithdrawal - meaningfulDelta(externalNoTax.summary.industryWithdrawal),
    "external tradeScope health tax reduces industry"
  );
  assert.ok(
    internalCurrent.summary.industryWithdrawal < internalNoTax.summary.industryWithdrawal - meaningfulDelta(internalNoTax.summary.industryWithdrawal),
    "internal tradeScope health tax reduces industry"
  );
}

async function run() {
  assert.deepStrictEqual(_internals.SECTORS, WATER_SECTORS, "withdrawal sectors exclude legacy eco demand");
  assert.strictEqual(_internals.getEcoFloor({}), 0.15, "ecoFloor defaults to 0.15");
  assertApprox(_internals.computeEcoBaseFlowDetail(100, 0).ecoBaseFlow, 15, 1e-9, "computeEcoBaseFlowDetail default ecoFloor is 0.15");
  assertApprox(_internals.getExternalInflowClimateMultiplier({ climate: "ssp245" }), 0.916, 1e-12, "SSP2-4.5 external inflow uses slower mainstem climate multiplier");
  assertApprox(_internals.getExternalInflowClimateMultiplier({ climate: "ssp585" }), 0.82, 1e-12, "SSP5-8.5 external inflow declines under climate stress");
  assert.strictEqual(_internals.getExternalInflowClimateMultiplier({ climate: "ssp585", externalInflowClimateSensitive: false }), 1, "external inflow climate sensitivity can be explicitly disabled");
  assert.strictEqual(_internals.getRiverRetentionValue({ tau: 0.5 }), 0, "river retention is muted in baseline climate");
  assert.strictEqual(_internals.getRiverRetentionValue({ tau: 0.5, climate: "ssp245" }), 0, "river retention is muted under SSP2-4.5");
  assert.strictEqual(_internals.getRiverRetentionValue({ tau: 0.5, climate: "ssp585" }), 2.7, "river retention rises with tau under climate stress");
  assert.strictEqual(_internals.getRiverRetentionValue({ tau: 0.5, riverRetentionValue: 1.1 }), 1.1, "explicit river retention value overrides climate-stress scaling");
  const cappedEcoFlow = _internals.computeEcoBaseFlowDetail(10, 100, 0.3);
  assert.strictEqual(cappedEcoFlow.ecoBaseFlow, 9.5, "legacy eco demand is capped at 95% of natural flow");
  assert.strictEqual(cappedEcoFlow.ecoBaseFlowCapped, true, "capped eco base flow records the cap flag");

  const network = normalizeInputs(fixture);
  assert.strictEqual(network.nodeById.get("A").runoffCoeff, 0.4, "normalizeInputs preserves runoffCoeff on normalized nodes");
  assert.strictEqual(network.nodeById.get("A").supply.runoffCoeff, 0.4, "normalizeInputs keeps runoffCoeff in normalized node supply");
  assert.strictEqual(network.nodeById.get("A").supply.qLocalRaw, 240, "normalized node supply exposes raw local runoff");

  assert.deepStrictEqual(topologicalSort(network), ["A", "B", "C"], "topological order follows upstream to downstream");

  const reachWithOutlet = computeDownstreamReach(network);
  assert.deepStrictEqual(reachWithOutlet.A, ["B", "C", "OUTLET"], "A reaches every downstream node and outlet");
  assert.deepStrictEqual(reachWithOutlet.B, ["C", "OUTLET"], "B reaches C and outlet");
  assert.deepStrictEqual(reachWithOutlet.C, ["OUTLET"], "C drains to external outlet");

  const cyclic = {
    subbasins: [
      { id: "X", downstream: "Y" },
      { id: "Y", downstream: "X" },
    ],
  };
  assert.throws(() => topologicalSort(cyclic), /cycle/i, "cycles are rejected");

  const lowTauTax = computeHealthTax("A", { network, tau: 0.1, climate: "baseline" });
  const highTauTax = computeHealthTax("A", { network, tau: 0.9, climate: "baseline" });
  assert.ok(highTauTax > lowTauTax, "health tax increases with tau");
  assert.ok(computeHealthTax("A", { network, tau: 0.5 }) > computeHealthTax("B", { network, tau: 0.5 }), "upstream industrial tax reflects larger downstream population exposure");

  const result = solveNetwork({
    network,
    tau: 0.4,
    climate: "baseline",
    healthFloor: 0.25,
    tradingCost: "medium",
  });

  assert.strictEqual(result.solver.type, "heuristic-routing-market", "MVP uses the explicit heuristic solver");
  assert.strictEqual(result.solver.lpReady, false, "default solve does not claim LP readiness");
  assert.strictEqual(result.solver.lpAttempted, false, "default solve does not attempt LP without an adapter");
  assert.strictEqual(result.solver.lpStatus, "not-requested", "default solve reports LP path as not requested");
  assert.ok(result.solver.note.includes("GLPK"), "heuristic fallback explains the missing GLPK adapter");
  assertEcoFlowResult(result, "heuristic result");

  const requestedLpWithoutSolver = solveNetwork({
    network,
    solver: "lp",
    tau: 0.4,
    climate: "baseline",
    healthFloor: 0.25,
    tradingCost: "medium",
  });
  assert.strictEqual(requestedLpWithoutSolver.solver.type, "heuristic-routing-market", "LP request falls back to heuristic without a solver adapter");
  assert.strictEqual(requestedLpWithoutSolver.solver.lpReady, false, "LP request without solver cannot report lpReady");
  assert.strictEqual(requestedLpWithoutSolver.solver.lpSolverDetected, false, "no custom/global solver is detected in the unit test");
  assert.strictEqual(requestedLpWithoutSolver.solver.lpAttempted, false, "no LP attempt happens without a solver adapter");
  assert.strictEqual(requestedLpWithoutSolver.solver.lpStatus, "no-lp-solver-adapter", "fallback explains the missing LP adapter");

  let lpAdapterCalled = false;
  const lpAdapterResult = solveNetwork({
    network,
    solver: "lp",
    lpSolver: (lpInterface, context) => {
      lpAdapterCalled = true;
      assert.strictEqual(lpInterface.kind, "research-network-lp-interface", "custom solver receives the LP interface");
      assert.strictEqual(context.lpInterfaceSize.nodeCount, 3, "custom solver receives interface size context");
      return {
        kind: "research-network-solution",
        solver: {
          type: "unit-test-lp-adapter",
          lpReady: true,
          lpStatus: "solved-by-unit-test",
        },
        nodes: [],
        tradeFlows: [],
        totals: {},
      };
    },
  });
  assert.strictEqual(lpAdapterCalled, true, "custom lpSolver adapter is called when supplied");
  assert.strictEqual(lpAdapterResult.solver.type, "unit-test-lp-adapter", "custom LP adapter result is returned");
  assert.strictEqual(lpAdapterResult.solver.lpReady, true, "custom LP adapter may report lpReady after it returns a solved result");
  assert.strictEqual(resolveLpSolverAdapter({ lpSolver: () => ({}) }).source, "params.lpSolver", "lpSolver adapter is discoverable");

  const glpk = await ResearchNetworkModel.loadNodeGlpkInstance();
  assert.strictEqual(typeof glpk.solve, "function", "glpk.js/node yields a ready solve() instance");
  const glpkAdapter = resolveLpSolverAdapter({ glpk });
  assert.strictEqual(glpkAdapter.type, "glpk.js", "ready glpk instance is discoverable as a synchronous adapter");
  assert.strictEqual(typeof glpkAdapter.solve, "function", "ready glpk adapter exposes solve()");
  const lpSolved = solveNetwork({
    network,
    solver: "lp",
    glpk,
    tau: 0.4,
    climate: "baseline",
    healthFloor: 0.25,
    tradingCost: "medium",
  });
  assert.strictEqual(lpSolved.solver.type, "glpk.js", "ready glpk instance uses the real LP solver");
  assert.strictEqual(lpSolved.solver.lpReady, true, "glpk LP solve reports lpReady");
  assert.strictEqual(lpSolved.solver.lpStatus, "optimal", "unit fixture LP solve is optimal");
  assert.ok(lpSolved.solver.objectiveValue > 0, "LP solve records an objective value");
  assert.ok(lpSolved.nodes.every((node) => node.qWithdrawn <= node.qAvail + 1e-6), "LP withdrawals respect available water");
  assertEcoFlowResult(lpSolved, "LP result");
  assert.strictEqual(lpSolved.nodeById.A.supply.runoffCoeff, 0.4, "LP result node supply carries runoffCoeff");
  assert.strictEqual(lpSolved.nodeById.A.runoffCoeff, 0.4, "LP result node exposes runoffCoeff at top level");
  assert.strictEqual(lpSolved.nodeById.A.qLocalRaw, 240, "LP result node exposes raw local runoff");
  assert.strictEqual(lpSolved.nodeById.A.localRunoff, 240, "LP result node aliases localRunoff to raw local runoff");
  const asyncLpSolved = await solveNetworkLpAsync({
    network,
    glpk,
    tau: 0.4,
    climate: "baseline",
    healthFloor: 0.25,
    tradingCost: "medium",
  });
  assert.strictEqual(asyncLpSolved.solver.type, "glpk.js", "solveNetworkLpAsync uses the glpk solver");
  assert.strictEqual(asyncLpSolved.solver.lpReady, true, "solveNetworkLpAsync returns a solved LP result");
  assertEcoFlowResult(asyncLpSolved, "async LP result");

  // 出清价来自 LP 对偶值（水的稀缺租金），不是外生公式。
  const realWuhanAttrs = readFullBakeWuhanAttrs();
  const lpBaseline = await solveNetworkLpAsync({
    network: realWuhanAttrs,
    glpk,
    tau: 0.24,
    climate: "ssp245",
    healthFloor: 0.26,
    ecoFloor: 0.15,
    tradingCost: 0.1,
    demandElasticity: 0.9,
  });
  assert.strictEqual(lpBaseline.marketPriceSource, "lp-dual-shadow-price", "market price comes from the LP dual, not the heuristic formula");
  assert.ok(lpBaseline.shadowPrice.scarceNodeCount > 0, "real Wuhan SSP2-4.5 has a positive water shadow price somewhere in the basin");
  assert.ok(lpBaseline.shadowPrice.spread > 0, "shadow prices differ across space, which is what creates gains from trade");
  assert.ok(lpBaseline.nodes.every((node) => node.shadowPriceCny !== null), "every node reports a shadow price");
  assert.ok(lpBaseline.supplyScope.quotaBinding, "the mainstem abstraction quota binds, so transit water is not freely allocable");
  assert.ok(
    lpBaseline.supplyScope.transitAllocable < lpBaseline.supplyScope.transitAvailable,
    "only the permitted share of mainstem transit enters the allocable pool"
  );

  // 庇古税的福利账：税收是转移支付，社会成本是无谓损失三角形。
  assert.ok(lpBaseline.welfare.industrialWaterForgoneM3 > 0, "a positive health tax reduces industrial water demand");
  assert.ok(lpBaseline.welfare.taxRevenueCny > 0, "the health tax raises revenue");
  assert.ok(
    lpBaseline.welfare.deadweightLossCny < lpBaseline.welfare.taxRevenueCny,
    "deadweight loss is far smaller than the transfer, which is why the tax is welfare-improving"
  );
  assert.ok(
    lpBaseline.welfare.deadweightLossCny
      < lpBaseline.welfare.industrialWaterForgoneM3 * 1.45 * 0.25,
    "social cost is the Harberger triangle, not the full value of the forgone water"
  );
  const lpNoTax = await solveNetworkLpAsync({
    network: realWuhanAttrs,
    glpk,
    tau: 0,
    climate: "ssp245",
    healthFloor: 0.26,
    ecoFloor: 0.15,
    tradingCost: 0.1,
    demandElasticity: 0.9,
  });
  assert.strictEqual(lpNoTax.welfare.taxRevenueCny, 0, "zero tax raises zero revenue");
  assert.strictEqual(lpNoTax.welfare.deadweightLossCny, 0, "zero tax creates zero deadweight loss");

  const lpStress = await solveNetworkLpAsync({
    network: realWuhanAttrs,
    glpk,
    tau: 0.24,
    climate: "ssp585",
    healthFloor: 0.26,
    ecoFloor: 0.15,
    tradingCost: 0.1,
    demandElasticity: 0.9,
  });
  assert.ok(
    lpStress.shadowPrice.scarceNodeCount > lpBaseline.shadowPrice.scarceNodeCount,
    "climate stress spreads scarcity to more of the basin"
  );
  assert.ok(
    lpStress.totals.unmet.agri > lpBaseline.totals.unmet.agri,
    "climate stress deepens agricultural curtailment"
  );
  // 默认取水许可标定在「生活用水健康底线处处达标」的水平，缺水集中在农业。
  assert.ok(
    lpBaseline.nodes.every((node) => node.healthFloorShortfall <= 1),
    "the default abstraction quota keeps every subbasin's domestic health floor satisfied"
  );
  assert.ok(
    lpBaseline.shadowPrice.max < HEALTH_FLOOR_PENALTY_PROBE,
    "shadow prices stay in an interpretable range and are not contaminated by the health-floor penalty"
  );

  assertHealthTaxLpStressTauGridAcceptance(glpk);

  const retentionNetwork = normalizeInputs(makeRiverRetentionFixture());
  const retentionLowTau = solveNetwork({
    network: retentionNetwork,
    tau: 0,
    climate: "ssp585",
    healthFloor: 0,
    ecoFloor: 0.3,
    tradingCost: "none",
  });
  const retentionHighTau = solveNetwork({
    network: retentionNetwork,
    tau: 0.5,
    climate: "ssp585",
    healthFloor: 0,
    ecoFloor: 0.3,
    tradingCost: "none",
  });
  assertTauRetentionResponse(retentionLowTau, retentionHighTau, "heuristic river retention");
  const retentionLpLowTau = solveNetwork({
    network: retentionNetwork,
    solver: "lp",
    glpk,
    tau: 0,
    climate: "ssp585",
    healthFloor: 0,
    ecoFloor: 0.3,
    tradingCost: "none",
  });
  const retentionLpHighTau = solveNetwork({
    network: retentionNetwork,
    solver: "lp",
    glpk,
    tau: 0.5,
    climate: "ssp585",
    healthFloor: 0,
    ecoFloor: 0.3,
    tradingCost: "none",
  });
  assert.strictEqual(retentionLpLowTau.solver.lpStatus, "optimal", "low-tau retention LP is optimal");
  assert.strictEqual(retentionLpHighTau.solver.lpStatus, "optimal", "high-tau retention LP is optimal");
  assertTauRetentionResponse(retentionLpLowTau, retentionLpHighTau, "LP river retention");

  assert.ok(result.nodeById.B.qAvail > result.nodeById.B.qLocal, "B receives routed upstream water");
  assert.ok(result.nodeById.C.qAvail > result.nodeById.C.qLocal, "C receives routed upstream water");
  assert.ok(result.nodeById.A.qOutflow < result.nodeById.A.qLocal, "A withdrawals reduce downstream release");

  const transitNetworkNoInflow = normalizeInputs(makeTransitFixture(0));
  const transitNetworkWithInflow = normalizeInputs(makeTransitFixture(90));
  assert.strictEqual(transitNetworkWithInflow.nodeById.get("IN").runoffCoeff, 0.4, "transit fixture preserves runoffCoeff in normalized node");
  assert.strictEqual(transitNetworkWithInflow.nodeById.get("IN").externalInflowBase, 90, "transit fixture preserves external inflow base");
  const noTransit = solveNetwork({
    network: transitNetworkNoInflow,
    tau: 0,
    climate: "baseline",
    healthFloor: 0,
    tradingCost: "none",
  });
  const withTransit = solveNetwork({
    network: transitNetworkWithInflow,
    tau: 0,
    climate: "baseline",
    healthFloor: 0,
    tradingCost: "none",
  });
  const transitEntry = withTransit.nodeById.IN;
  assertEcoFlowResult(noTransit, "no-transit heuristic");
  assertEcoFlowResult(withTransit, "transit heuristic");
  assert.strictEqual(transitEntry.supply.runoffCoeff, 0.4, "heuristic result node supply carries runoffCoeff");
  assert.strictEqual(transitEntry.runoffCoeff, 0.4, "heuristic result node exposes runoffCoeff at top level");
  assert.strictEqual(transitEntry.qLocal, 16, "heuristic market supply includes only the entry node's demand-proportional transit share");
  assert.strictEqual(transitEntry.qLocalRaw, 10, "heuristic qLocalRaw excludes external inflow");
  assert.strictEqual(transitEntry.localRunoff, 10, "heuristic localRunoff excludes external inflow");
  assert.strictEqual(transitEntry.externalInflow, 6, "heuristic result node exposes allocated external inflow share");
  assert.strictEqual(withTransit.nodeById.DOWN.qLocal, 84, "downstream node receives demand-proportional market access to transit inflow");
  assert.strictEqual(withTransit.nodeById.DOWN.externalInflow, 84, "downstream external inflow share is exposed without double counting");
  assert.strictEqual(transitEntry.supply.qLocalRaw, 10, "heuristic supply snapshot exposes raw local runoff");
  assert.strictEqual(transitEntry.supply.localRunoff, 10, "heuristic supply snapshot exposes localRunoff");
  assert.strictEqual(withTransit.totals.localRunoff, 10, "heuristic totals expose raw local runoff sum");
  assert.strictEqual(withTransit.totals.externalInflow, 90, "heuristic totals expose external inflow sum");
  assert.ok(
    withTransit.nodeById.IN.qAvail >= noTransit.nodeById.IN.qAvail + 5.999,
    "mainstemInflow entry qAvail reflects its allocated regional market share"
  );
  assert.ok(
    withTransit.nodeById.DOWN.qAvail >= noTransit.nodeById.DOWN.qAvail + 89.999,
    "regional transit allocation plus routed surplus reaches the downstream subbasin"
  );

  const stressNetwork = normalizeInputs(makeClimateStressFixture());
  const ssp245Default = solveNetwork({
    network: stressNetwork,
    climate: "ssp245",
    healthFloor: 0.25,
    tradingCost: "none",
  });
  const ssp585Stress = solveNetwork({
    network: stressNetwork,
    climate: "ssp585",
    tau: 0,
    healthFloor: 0.25,
    tradingCost: "none",
  });
  const ssp585HighTau = solveNetwork({
    network: stressNetwork,
    climate: "ssp585",
    tau: 0.55,
    healthFloor: 0.25,
    tradingCost: "none",
  });
  assertEcoFlowResult(ssp245Default, "SSP2-4.5 default stress fixture");
  assertEcoFlowResult(ssp585Stress, "SSP5-8.5 stress fixture");
  assertEcoFlowResult(ssp585HighTau, "SSP5-8.5 high-tau stress fixture");
  assertSectorUnmetNearZero(ssp245Default, "SSP2-4.5 default stress fixture", 1e-6);
  assert.ok(sumSectorValues(ssp585Stress.totals.unmet) > 1e-6, "SSP5-8.5 stress fixture exposes a visible sector shortfall");
  assertApprox(ssp245Default.nodeById.STRESS.localRunoff, 86, 1e-9, "SSP2-4.5 local runoff uses branch climate availability");
  assertApprox(ssp245Default.nodeById.STRESS.externalInflow, 91.6, 1e-9, "SSP2-4.5 external inflow uses slower mainstem multiplier");
  assertApprox(ssp245Default.nodeById.STRESS.ecoBaseFlow, 12.9, 1e-9, "SSP2-4.5 ecoBaseFlow is 15% of local runoff only");
  assert.ok(
    ssp245Default.nodeById.STRESS.qAvail > ssp245Default.nodeById.STRESS.localRunoff + 90,
    "SSP2-4.5 stress fixture has transit water in qAvail"
  );
  assert.ok(
    ssp245Default.nodeById.STRESS.ecoBaseFlow < 0.15 * ssp245Default.nodeById.STRESS.qAvail,
    "transit water is not included in ecoBaseFlow"
  );
  assertApprox(ssp585Stress.nodeById.STRESS.externalInflow, 82, 1e-9, "SSP5-8.5 external inflow declines but more slowly than local runoff");
  assert.ok(
    ssp585HighTau.totals.allocation.industry < ssp585Stress.totals.allocation.industry - 1e-6,
    "higher tau lowers industrial withdrawal under climate stress"
  );
  assert.ok(
    ssp585HighTau.totals.environmentalFlow > ssp585Stress.totals.environmentalFlow + 1e-6,
    "higher tau raises environmental flow under climate stress"
  );

  const realWuhanNetwork = normalizeInputs(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../data/wuhan-attrs.json"), "utf8")));
  const realBaselineDefault = solveNetwork({
    network: realWuhanNetwork,
    climate: "ssp245",
    tau: 0.24,
    ecoFloor: 0.15,
    healthFloor: 0.25,
    tradingCost: "medium",
  });
  const realStressTau0 = solveNetwork({
    network: realWuhanNetwork,
    climate: "ssp585",
    tau: 0,
    ecoFloor: 0.15,
    healthFloor: 0.25,
    tradingCost: "medium",
  });
  const realStressDefault = solveNetwork({
    network: realWuhanNetwork,
    climate: "ssp585",
    tau: 0.24,
    ecoFloor: 0.15,
    healthFloor: 0.25,
    tradingCost: "medium",
  });
  const realStressHighTau = solveNetwork({
    network: realWuhanNetwork,
    climate: "ssp585",
    tau: 0.55,
    ecoFloor: 0.15,
    healthFloor: 0.25,
    tradingCost: "medium",
  });
  assertEcoFlowResult(realBaselineDefault, "real Wuhan SSP2-4.5 baseline");
  assertEcoFlowResult(realStressDefault, "real Wuhan SSP5-8.5 stress");
  assertCurtailmentOrder(realBaselineDefault, "real Wuhan SSP2-4.5 baseline", 1e-3);
  assert.ok(
    realBaselineDefault.totals.unmet.agri > 1e8,
    "real Wuhan SSP2-4.5 baseline shows a real agricultural shortfall once mainstem transit is capped by an abstraction quota"
  );
  assert.strictEqual(realBaselineDefault.params.riverRetentionValue, 0, "real Wuhan SSP2-4.5 does not activate retention pressure");
  assert.ok(realStressDefault.params.riverRetentionValue > 1, "real Wuhan SSP5-8.5 activates retention pressure");
  const realStressEffectiveUnmet = realStressDefault.totals.unmet;
  const realStressRawUnmet = realStressDefault.totals.rawUnmet || realStressEffectiveUnmet;
  assert.ok(sumSectorValues(realStressEffectiveUnmet) > 1e9, "real Wuhan SSP5-8.5 default exposes a visible effective-demand sector shortfall");
  assert.ok(realStressEffectiveUnmet.agri > 1e9, "real Wuhan SSP5-8.5 default exposes agricultural shortfall");
  assert.ok(realStressRawUnmet.industry > 1e8, "real Wuhan SSP5-8.5 default exposes industrial raw-demand shortfall");
  // 极端气候压力下工业也会被削减，但农业仍应承担更大比例——次序不变。
  assertCurtailmentOrder(realStressTau0, "real Wuhan SSP5-8.5 tau=0", 1e-3, 0.15);
  assert.ok(
    realStressTau0.totals.unmet.agri > realBaselineDefault.totals.unmet.agri,
    "agricultural curtailment deepens as climate stress rises"
  );
  assert.ok(
    realStressHighTau.totals.allocation.industry < realStressTau0.totals.allocation.industry - 1e-6,
    "real Wuhan stress high tau lowers industrial withdrawal"
  );
  assert.ok(
    realStressHighTau.totals.environmentalFlow > realStressTau0.totals.environmentalFlow + 1e-6,
    "real Wuhan stress high tau raises environmental flow"
  );
  assertHealthTaxFullBakeTauGridAcceptance();
  assertHealthTaxDefaultNoTaxComparison();
  assertHealthTaxAutarkyAcceptance();
  assertTradeScopeHealthTaxAcceptance();

  const lpTransit = solveNetwork({
    network: transitNetworkWithInflow,
    solver: "lp",
    glpk,
    tau: 0,
    climate: "baseline",
    healthFloor: 0,
    tradingCost: "none",
  });
  assert.strictEqual(lpTransit.solver.type, "glpk.js", "transit fixture can solve through LP");
  assertEcoFlowResult(lpTransit, "transit LP");
  assert.strictEqual(lpTransit.nodeById.IN.supply.runoffCoeff, 0.4, "LP transit result node supply carries runoffCoeff");
  assert.strictEqual(lpTransit.nodeById.IN.qLocal, 16, "LP qLocal includes only the entry node's demand-proportional transit share");
  assert.strictEqual(lpTransit.nodeById.IN.qLocalRaw, 10, "LP qLocalRaw excludes external inflow");
  assert.strictEqual(lpTransit.nodeById.IN.localRunoff, 10, "LP localRunoff excludes external inflow");
  assert.strictEqual(lpTransit.nodeById.IN.externalInflow, 6, "LP result node exposes allocated external inflow share");
  assert.strictEqual(lpTransit.nodeById.DOWN.externalInflow, 84, "LP downstream node exposes its allocated external inflow share");
  assert.strictEqual(lpTransit.totals.localRunoff, 10, "LP totals expose raw local runoff sum");
  assert.strictEqual(lpTransit.totals.externalInflow, 90, "LP totals expose external inflow sum");

  const noTaxLp = await solveNetworkLpAsync({
    network,
    glpk,
    tau: 0,
    climate: "ssp585",
    healthFloor: 0.25,
    ecoFloor: 0.3,
    tradingCost: "none",
  });
  const highTaxLp = await solveNetworkLpAsync({
    network,
    glpk,
    tau: 0.5,
    climate: "ssp585",
    healthFloor: 0.25,
    ecoFloor: 0.3,
    tradingCost: "none",
  });
  assertEcoFlowResult(noTaxLp, "no-tax LP response");
  assertEcoFlowResult(highTaxLp, "high-tax LP response");
  assert.ok(
    highTaxLp.totals.allocation.industry <= noTaxLp.totals.allocation.industry + 1e-6,
    "higher tau does not increase industrial withdrawal"
  );
  assert.ok(
    highTaxLp.totals.inStreamFlow > noTaxLp.totals.inStreamFlow + 1e-6,
    "higher tau increases in-stream environmental flow"
  );

  const autarkyNetwork = normalizeInputs(makeAutarkyFixture());
  const autarky = solveNetwork({
    network: autarkyNetwork,
    trade: "autarky",
    tau: 0.4,
    climate: "baseline",
    healthFloor: 0.25,
    tradingCost: "medium",
  });
  const directAutarky = solveAutarky(autarkyNetwork, {
    tau: 0.4,
    climate: "baseline",
    healthFloor: 0.25,
    tradingCost: "medium",
  });
  assert.strictEqual(autarky.solver.type, "deterministic-autarky", "trade:autarky uses deterministic autarky solver");
  assert.strictEqual(directAutarky.solver.type, "deterministic-autarky", "solveAutarky exposes the same deterministic solver");
  assert.strictEqual(autarky.metadata.tradeMode, "autarky", "autarky metadata declares trade mode");
  assert.strictEqual(autarky.metadata.waterRightRule.id, "autarky-water-right-R", "metadata records口径 R water-right rule");
  assert.strictEqual(autarky.metadata.waterRightRule.crossNodeReallocation, false, "metadata says cross-node reallocation is disabled");
  assert.strictEqual(autarky.metadata.waterRightRule.routedOutflowIsTrade, false, "metadata says routed outflow is not a trade flow");
  assert.deepStrictEqual(autarky.tradeFlows, [], "autarky emits no cross-node trade flows");
  assertEcoFlowResult(autarky, "autarky");
  assert.ok(autarky.nodes.every((node) => node.qOutflow + 1e-6 >= node.ecoBaseFlow), "autarky preserves river qOutflow for ecological base flow");
  assert.ok(autarky.totals.withdrawn <= autarky.totals.qAvail + 1e-6, "total autarky withdrawal respects total own water rights");
  assert.strictEqual(autarky.nodeById.HEAD.supply.runoffCoeff, 0.42, "autarky result node supply carries runoffCoeff");
  assert.strictEqual(autarky.nodeById.HEAD.runoffCoeff, 0.42, "autarky result node exposes runoffCoeff at top level");
  assert.strictEqual(autarky.nodeById.HEAD.qLocalRaw, 10, "autarky qLocalRaw excludes external inflow");
  assert.strictEqual(autarky.nodeById.HEAD.localRunoff, 10, "autarky localRunoff excludes external inflow");
  assert.strictEqual(autarky.nodeById.HEAD.externalInflow, 90, "autarky result node exposes source external inflow");
  assert.strictEqual(autarky.totals.localRunoff, 15, "autarky totals expose raw local runoff sum");
  assert.strictEqual(autarky.totals.externalInflow, 90, "autarky totals expose source external inflow sum");
  for (const node of autarky.nodes) {
    assert.ok(node.qWithdrawn <= node.autarkyWaterRight - node.ecoBaseFlow + 1e-6, node.id + " withdrawal respects its own water right after ecoBaseFlow");
  }
  assert.ok(Math.abs(autarky.nodeById.HEAD.defaultTransitShare - 45) < 1e-5, "entry node receives demand-proportional transit share over withdrawal sectors");
  assert.ok(Math.abs(autarky.nodeById.MID.defaultTransitShare - 12.857143) < 1e-5, "midstream node receives demand-proportional transit share over withdrawal sectors");
  assert.ok(Math.abs(autarky.nodeById.TAIL.defaultTransitShare - 32.142857) < 1e-5, "tail node receives demand-proportional transit share over withdrawal sectors");
  assert.ok(autarky.nodeById.MID.allocation.urban > 0, "autarky allocates scarce water to urban health demand");
  assert.strictEqual(autarky.nodeById.MID.ecoBaseFlowCapped, true, "autarky caps legacy eco demand at 95% of local runoff");
  assert.strictEqual(autarky.nodeById.MID.allocation.agri, 0, "agriculture waits behind unmet health demand in autarky");
  assert.strictEqual(autarky.nodeById.MID.allocation.industry, 0, "industry waits behind unmet health demand in autarky");
  assert.strictEqual(autarky.nodeById.HEAD.allocation.urban, 10, "health demand is satisfied before agriculture when water is sufficient");
  assert.ok(autarky.nodeById.HEAD.allocation.agri > 0, "agriculture receives water before industry after health demand");
  assert.strictEqual(autarky.nodeById.HEAD.allocation.industry, 0, "industry is last in the autarky priority order");

  const reachInternal = computeDownstreamReach(network, { includeExternalOutlets: false });
  assert.ok(result.tradeFlows.length > 0, "OD trade flows are recorded when downstream uses upstream-origin water");
  for (const flow of result.tradeFlows) {
    assert.ok(reachInternal[flow.origin].includes(flow.target), "flow " + flow.origin + "->" + flow.target + " must follow hydrologic connectivity");
    assert.strictEqual(flow.direction, "upstream-to-downstream", "flow direction is explicitly downstream");
    assertNonNegative(flow.volume, "trade flow volume");
  }

  for (const node of result.nodes) {
    assertNonNegative(node.qLocal, node.id + " qLocal");
    assertNonNegative(node.qAvail, node.id + " qAvail");
    assertNonNegative(node.qWithdrawn, node.id + " qWithdrawn");
    assertNonNegative(node.qOutflow, node.id + " qOutflow");
    assert.ok(node.qWithdrawn <= node.qAvail + 1e-9, node.id + " withdrawal cannot exceed available water");
    for (const sector of WATER_SECTORS) {
      assertNonNegative(node.allocation[sector], node.id + " " + sector + " allocation");
      assertNonNegative(node.unmet[sector], node.id + " " + sector + " unmet");
      assert.ok(node.allocation[sector] <= node.demand[sector] + 1e-9, node.id + " " + sector + " allocation respects demand cap");
    }
  }

  const lowPopulationNetwork = normalizeInputs(makeExposureFixture({ downstreamPopulation: 100000, industryDemand: 30 }));
  const highPopulationNetwork = normalizeInputs(makeExposureFixture({ downstreamPopulation: 900000, industryDemand: 30 }));
  const lowPopulationTax = _internals.computeHealthTaxDetail("UP", { network: lowPopulationNetwork, tau: 0.5, climate: "baseline", sector: "industry" });
  const highPopulationTax = _internals.computeHealthTaxDetail("UP", { network: highPopulationNetwork, tau: 0.5, climate: "baseline", sector: "industry" });
  assert.ok(highPopulationTax.downstreamPopulation > lowPopulationTax.downstreamPopulation, "tax detail exposes larger downstream population");
  assert.ok(highPopulationTax.taxPerM3 > lowPopulationTax.taxPerM3, "health tax increases with downstream population-weighted exposure");

  const lowIndustry = solveNetwork({
    network: normalizeInputs(makeExposureFixture({ downstreamPopulation: 500000, industryDemand: 10 })),
    tau: 0.05,
    climate: "baseline",
    healthFloor: 0,
    tradingCost: "none",
  });
  const highIndustry = solveNetwork({
    network: normalizeInputs(makeExposureFixture({ downstreamPopulation: 500000, industryDemand: 45 })),
    tau: 0.05,
    climate: "baseline",
    healthFloor: 0,
    tradingCost: "none",
  });
  const lowIndustryTaxBase = lowIndustry.nodeById.UP.allocation.industry * lowIndustry.nodeById.UP.healthTax.taxPerM3;
  const highIndustryTaxBase = highIndustry.nodeById.UP.allocation.industry * highIndustry.nodeById.UP.healthTax.taxPerM3;
  assert.ok(highIndustry.nodeById.UP.allocation.industry > lowIndustry.nodeById.UP.allocation.industry, "higher upstream industry configuration increases industrial allocation");
  assert.ok(highIndustryTaxBase > lowIndustryTaxBase, "higher upstream industry configuration increases routed externality tax base proxy");

  const incentiveNetwork = normalizeInputs({
    subbasins: [
      {
        id: "IC1",
        name: "Incentive check industry",
        population: 1000,
        demand: { urban: 0, eco: 0, agri: 0, industry: 20 },
        supply: { qLocal: 30 },
        complianceCost: { urban: 0, eco: 0, agri: 0, industry: 5 },
        sectorValue: { urban: 0, eco: 0, agri: 0, industry: 3 },
        healthWeight: { urban: 1, eco: 0.7, agri: 0.1, industry: -0.25 },
      },
    ],
  });
  const incentiveResult = solveNetwork({
    network: incentiveNetwork,
    tau: 0,
    climate: "baseline",
    healthFloor: 0,
    tradingCost: "none",
  });
  assert.ok(!incentiveResult.incentive.compatible, "high compliance cost triggers incentive flag");
  assert.ok(
    incentiveResult.incentive.flags.some((flag) => flag.type === "incentive" && flag.nodeId === "IC1" && flag.sector === "industry"),
    "incentive flags locate the violating subbasin and sector"
  );
  for (const flag of incentiveResult.incentive.flags) {
    assert.ok(flag.nodeId, "flag includes nodeId");
    assert.ok(Object.prototype.hasOwnProperty.call(flag, "sector"), "flag includes sector");
  }
  assert.ok(incentiveResult.incentive.violatingNodeSectors.includes("IC1:industry"), "violatingNodeSectors keeps node:sector locator");

  const lpShape = buildLpProblemInterface(network, { tau: 0.4, climate: "baseline", healthFloor: 0.25, tradingCost: "medium" });
  assert.strictEqual(lpShape.kind, "research-network-lp-interface", "LP interface shape is exposed for the Phase 2a spike");
  assert.ok(lpShape.variables.allocation.includes("x_A_urban"), "LP allocation variables include withdrawal sectors");
  assert.ok(!lpShape.variables.allocation.includes("x_A_eco"), "LP allocation variables exclude legacy eco demand");
  assert.ok(lpShape.variables.trade.includes("t_A_B"), "LP trade variables are constrained to downstream-reachable OD pairs");
  assert.ok(!lpShape.variables.trade.includes("t_C_A"), "LP trade variables do not include upstream reverse trades");

  const size = estimateProblemSize(network, { tau: 0.4, climate: "baseline", healthFloor: 0.25, tradingCost: "medium" });
  assert.strictEqual(size.kind, "research-network-problem-size", "problem size estimator is exposed");
  assert.strictEqual(size.nodeCount, 3, "size estimator reports node count");
  assert.strictEqual(size.variableCounts.allocation, 9, "allocation variables are nodes x withdrawal sectors");
  assert.strictEqual(size.variableCounts.outflow, 3, "one outflow variable per node");
  assert.strictEqual(size.variableCounts.trade, 3, "trade variables are only downstream-reachable internal OD pairs");
  assert.strictEqual(size.variableCounts.total, 15, "total variable count sums allocation, outflow, and trade");
  assert.deepStrictEqual(lpShape.size.variableCounts, size.variableCounts, "LP interface embeds the same size estimate");

  const fixtureDir = path.resolve(__dirname, "../tools/spike/fixtures");
  for (const fixtureSize of [30, 50, 80]) {
    const fixturePath = path.join(fixtureDir, "synthetic-" + fixtureSize + ".json");
    assert.ok(fs.existsSync(fixturePath), "fixture exists for " + fixtureSize + " nodes");
    const spikeFixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    assert.strictEqual(spikeFixture.meta.synthetic, true, "fixture declares synthetic:true");
    assert.strictEqual(spikeFixture.meta.nodeCount, fixtureSize, "fixture meta nodeCount matches filename");
    assert.strictEqual(spikeFixture.subbasins.length, fixtureSize, "fixture subbasin count matches filename");

    const spikeNetwork = normalizeInputs(spikeFixture);
    assert.strictEqual(topologicalSort(spikeNetwork).length, fixtureSize, "fixture topology is acyclic for " + fixtureSize);
    assert.ok(spikeNetwork.nodes.some((node) => node.externalInflowBase > 0), "fixture includes transit injection for " + fixtureSize);
    for (const node of spikeFixture.subbasins) {
      assert.ok(node.supply && Number.isFinite(node.supply.qLocal), "fixture node has local supply");
      assert.ok(Object.prototype.hasOwnProperty.call(node.supply, "transitInjection"), "fixture node carries explicit transitInjection");
      for (const sector of ["urban", "eco", "agri", "industry"]) {
        assert.ok(Number.isFinite(node.demand[sector]), "fixture node has finite " + sector + " demand");
      }
    }
  }

  const benchmarkReport = Benchmark.runBenchmark({ sizes: [30], generatedAt: "test", runs: 1 });
  assert.strictEqual(benchmarkReport.kind, "research-network-phase2a-spike-benchmark", "benchmark report has stable kind");
  assert.ok(["lp-solver-not-installed", "glpk-js-installed-loadable"].includes(benchmarkReport.solverStatus), "sync benchmark reports LP solver status without auto-loading GLPK");
  assert.strictEqual(benchmarkReport.decision, "NO FINAL A/B DECISION", "benchmark does not make an A/B architecture decision without true LP timings");
  assert.strictEqual(benchmarkReport.decisionEligible, false, "benchmark report is not decision-eligible without LP solve timings");
  assert.ok(benchmarkReport.nextStep.includes("glpk.js"), "benchmark report says the next step is wiring glpk.js or a grid");
  assert.strictEqual(benchmarkReport.cases.length, 1, "test benchmark can run one synthetic size");
  assert.strictEqual(benchmarkReport.cases[0].nodeCount, 30, "benchmark case reports node count");
  assert.strictEqual(benchmarkReport.cases[0].synthetic, true, "benchmark case is sourced from a synthetic fixture");
  assert.strictEqual(benchmarkReport.cases[0].variableCounts.allocation, 90, "benchmark allocation count is nodes x withdrawal sectors");
  assert.strictEqual(benchmarkReport.cases[0].variableCounts.outflow, 30, "benchmark outflow count is one per node");
  assert.ok(benchmarkReport.cases[0].variableCounts.trade > 0, "fixture has downstream OD pairs");
  assert.strictEqual(benchmarkReport.cases[0].checks.variableCountsMatchEstimate, true, "benchmark cross-checks interface counts against estimate");
  assert.strictEqual(benchmarkReport.cases[0].checks.normalizedTopologyAcyclic, true, "benchmark confirms fixture topology is acyclic");
  assert.strictEqual(benchmarkReport.cases[0].checks.lpReady, false, "benchmark heuristic solve does not claim LP readiness");
  assert.strictEqual(benchmarkReport.cases[0].lpSolveMs, null, "benchmark leaves LP solve timing null until glpk.js is wired");
  assert.strictEqual(typeof benchmarkReport.cases[0].interfaceGenerationMs, "number", "benchmark records LP interface timing");
  assert.strictEqual(typeof benchmarkReport.cases[0].heuristicSolveMs, "number", "benchmark records heuristic solve timing");
  assert.ok(benchmarkReport.cases[0].constraints.routingBalance, "benchmark includes constraint descriptions");

  const asyncBenchmarkReport = await Benchmark.runBenchmarkAsync({ sizes: [30], generatedAt: "test", runs: 1, glpk });
  assert.strictEqual(asyncBenchmarkReport.solverStatus, "glpk-js-wired", "async benchmark wires glpk.js");
  assert.strictEqual(asyncBenchmarkReport.lpSolveStatus, "all-cases-solved", "async benchmark runs true LP solve");
  assert.strictEqual(asyncBenchmarkReport.decisionEligible, true, "async benchmark is decision-eligible after LP timings exist");
  assert.ok(asyncBenchmarkReport.decision.startsWith("PATH A:"), "30-node test fixture stays below the real-time LP threshold");
  assert.strictEqual(asyncBenchmarkReport.thresholdMs, 300, "benchmark records the 300 ms decision threshold");
  assert.strictEqual(asyncBenchmarkReport.cases[0].checks.lpReady, true, "async benchmark case is LP-ready");
  assert.strictEqual(asyncBenchmarkReport.cases[0].checks.lpStatus, "optimal", "async benchmark case is optimal");
  assert.strictEqual(asyncBenchmarkReport.cases[0].checks.lpSolverType, "glpk.js", "async benchmark records glpk solver type");
  assert.strictEqual(asyncBenchmarkReport.cases[0].checks.lpNoNaN, true, "async benchmark checks LP numeric values");
  assert.strictEqual(asyncBenchmarkReport.cases[0].checks.lpNonNegative, true, "async benchmark checks LP non-negativity");
  assert.strictEqual(typeof asyncBenchmarkReport.cases[0].lpSolveMs, "number", "async benchmark records LP solve timing");
  assert.strictEqual(asyncBenchmarkReport.cases[0].lpSolveRunsMs.length, 1, "async benchmark records raw LP timing runs");
  assert.strictEqual(typeof asyncBenchmarkReport.cases[0].lpGlpkStatus, "number", "async benchmark records GLPK status code");

  console.log("networkModel.test.js: all assertions passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
