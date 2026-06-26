const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const ResearchNetworkModel = require("./networkModel");

const DEFAULT_SIZES = [30, 50, 80];
const DEFAULT_RUNS = 5;
const DEFAULT_PARAMS = {
  tau: 0.35,
  climate: "dry",
  healthFloor: 0.25,
  tradingCost: "medium",
};
const LP_TARGET_MS = 300;
const SPIKE_DIR = path.resolve(__dirname, "../tools/spike");
const FIXTURE_DIR = path.join(SPIKE_DIR, "fixtures");
const DEFAULT_REPORT_PATH = path.join(SPIKE_DIR, "benchmark-report.json");

function roundMs(value) {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

function round(value, digits = 6) {
  const factor = Math.pow(10, digits);
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function measureRepeated(fn, runs) {
  const timings = [];
  let value;
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    value = fn();
    timings.push(roundMs(performance.now() - start));
  }
  return {
    value,
    ms: roundMs(median(timings)),
    runsMs: timings,
  };
}

function fixturePathForSize(size, options = {}) {
  return path.join(options.fixtureDir || FIXTURE_DIR, "synthetic-" + size + ".json");
}

function loadFixtureNetwork(size, options = {}) {
  const filePath = fixturePathForSize(size, options);
  const text = fs.readFileSync(filePath, "utf8");
  return {
    filePath,
    network: JSON.parse(text),
  };
}

function detectLpSolverStatus(options = {}) {
  if (options.glpk && typeof options.glpk.solve === "function") {
    return {
      status: "glpk-js-wired",
      detail: "glpk.js is installed, loaded through glpk.js/node, and wired to the Phase 2a LP benchmark.",
    };
  }
  try {
    require.resolve("glpk.js/node");
    return {
      status: "glpk-js-installed-loadable",
      detail: "glpk.js is installed; use runBenchmarkAsync() or the CLI to load it and run true LP solves.",
    };
  } catch (error) {
    return {
      status: "lp-solver-not-installed",
      detail: "glpk.js is not installed; no true LP solve was run.",
    };
  }
}

async function loadGlpkForBenchmark(options = {}) {
  const explicit = options.glpk || options.glpkInstance;
  if (explicit) {
    return typeof explicit.then === "function" ? await explicit : explicit;
  }
  return ResearchNetworkModel.loadNodeGlpkInstance();
}

function summarizeTransitInjection(network) {
  const nodes = network.subbasins || network.nodes || [];
  let nodeCount = 0;
  let total = 0;
  for (const node of nodes) {
    const supply = node.supply || {};
    const value = Number(supply.transitInjection ?? node.transitInjection ?? supply.externalInflow ?? 0);
    if (Number.isFinite(value) && value > 0) {
      nodeCount += 1;
      total += value;
    }
  }
  return {
    nodeCount,
    total: round(total, 3),
  };
}

function summarizeCase(size, params, options = {}) {
  const runs = options.runs || DEFAULT_RUNS;
  const loaded = loadFixtureNetwork(size, options);
  const normalized = ResearchNetworkModel.normalizeInputs(loaded.network);
  const glpk = options.glpk || options.glpkInstance;

  const lpInterfaceTiming = measureRepeated(
    () => ResearchNetworkModel.buildLpProblemInterface(loaded.network, params),
    runs
  );
  const lpInterface = lpInterfaceTiming.value;
  const sizeEstimate = ResearchNetworkModel.estimateProblemSize(loaded.network, params);
  const heuristicTiming = measureRepeated(
    () => ResearchNetworkModel.solveNetwork({ network: loaded.network, ...params }),
    runs
  );
  const heuristic = heuristicTiming.value;

  let lpTiming = null;
  let lpResult = null;
  let glpkProblem = null;
  if (glpk && typeof glpk.solve === "function") {
    glpkProblem = ResearchNetworkModel.buildGlpkProblem(loaded.network, params, glpk);
    lpTiming = measureRepeated(
      () => ResearchNetworkModel.solveNetwork({ network: loaded.network, ...params, solver: "lp", glpk }),
      runs
    );
    lpResult = lpTiming.value;
  }
  const lpNumericValues = lpResult
    ? lpResult.nodes.flatMap((node) => [
        node.qLocal,
        node.qAvail,
        node.qWithdrawn,
        node.qOutflow,
        node.healthFloorTarget,
        node.healthFloorShortfall,
        ...Object.values(node.allocation),
        ...Object.values(node.unmet),
      ])
    : [];

  return {
    fixture: path.relative(SPIKE_DIR, loaded.filePath),
    synthetic: loaded.network.meta && loaded.network.meta.synthetic === true,
    nodeCount: normalized.nodes.length,
    edgeCount: sizeEstimate.edgeCount,
    sectorCount: sizeEstimate.sectorCount,
    transitInjection: summarizeTransitInjection(loaded.network),
    lpSolveMs: lpTiming ? lpTiming.ms : null,
    lpSolveRunsMs: lpTiming ? lpTiming.runsMs : [],
    lpSolveStatus: lpResult ? lpResult.solver.lpStatus : "not-run-no-glpk-adapter",
    lpGlpkStatus: lpResult ? lpResult.solver.glpkStatus : null,
    lpObjectiveValue: lpResult ? lpResult.solver.objectiveValue : null,
    interfaceGenerationMs: lpInterfaceTiming.ms,
    interfaceGenerationRunsMs: lpInterfaceTiming.runsMs,
    heuristicSolveMs: heuristicTiming.ms,
    heuristicSolveRunsMs: heuristicTiming.runsMs,
    variableCounts: {
      allocation: lpInterface.variables.allocation.length,
      outflow: lpInterface.variables.outflow.length,
      trade: lpInterface.variables.trade.length,
      total: lpInterface.variables.allocation.length + lpInterface.variables.outflow.length + lpInterface.variables.trade.length,
    },
    glpkProblem: glpkProblem
      ? {
          variables: glpkProblem.lp.bounds.length,
          constraints: glpkProblem.lp.subjectTo.length,
          objectiveDirection: "max",
        }
      : null,
    estimate: {
      reachableOdPairCount: sizeEstimate.reachableOdPairCount,
      constraintCounts: sizeEstimate.constraintCounts,
      totalConstraints: sizeEstimate.totalConstraints,
    },
    constraints: lpInterface.constraints,
    heuristicSummary: {
      tradeFlowCount: heuristic.tradeFlows.length,
      totalWithdrawn: heuristic.totals.withdrawn,
      outletOutflowApprox: heuristic.nodes[heuristic.nodes.length - 1].qOutflow,
      marketPrice: heuristic.marketPrice,
    },
    lpSummary: lpResult
      ? {
          tradeFlowCount: lpResult.tradeFlows.length,
          totalWithdrawn: lpResult.totals.withdrawn,
          outletOutflowApprox: lpResult.nodes[lpResult.nodes.length - 1].qOutflow,
          marketPrice: lpResult.marketPrice,
        }
      : null,
    checks: {
      syntheticFixture: loaded.network.meta && loaded.network.meta.synthetic === true,
      normalizedTopologyAcyclic: ResearchNetworkModel.topologicalSort(loaded.network).length === normalized.nodes.length,
      variableCountsMatchEstimate:
        lpInterface.variables.allocation.length === sizeEstimate.variableCounts.allocation &&
        lpInterface.variables.outflow.length === sizeEstimate.variableCounts.outflow &&
        lpInterface.variables.trade.length === sizeEstimate.variableCounts.trade,
      heuristicSolverType: heuristic.solver.type,
      lpReady: lpResult ? lpResult.solver.lpReady : false,
      lpStatus: lpResult ? lpResult.solver.lpStatus : heuristic.solver.lpStatus,
      lpSolverType: lpResult ? lpResult.solver.type : null,
      lpNoNaN: lpResult ? lpNumericValues.every(Number.isFinite) : false,
      lpNonNegative: lpResult ? lpNumericValues.every((value) => value >= -1e-9) : false,
    },
  };
}

function buildDecision(cases) {
  const solvedCases = cases.filter((item) => item.checks.lpReady && Number.isFinite(item.lpSolveMs));
  const decisionEligible = solvedCases.length === cases.length && cases.length > 0;
  if (!decisionEligible) {
    return {
      lpSolveStatus: "not-run-no-glpk-adapter",
      decisionEligible: false,
      decision: "NO FINAL A/B DECISION",
      nextStep: "Wire buildLpProblemInterface() to glpk.js, run true LP solve timings, then decide browser LP versus pre-baked scenario grid.",
      maxLpSolveMs: null,
    };
  }

  const maxSolveMs = Math.max(...cases.map((item) => item.lpSolveMs));
  if (maxSolveMs <= LP_TARGET_MS) {
    return {
      lpSolveStatus: "all-cases-solved",
      decisionEligible: true,
      decision: "PATH A: browser real-time LP solve is acceptable for the 30-80 node target.",
      nextStep: "Keep the real-time LP path and add browser bundle-size/worker loading checks before frontend release.",
      maxLpSolveMs: roundMs(maxSolveMs),
    };
  }

  return {
    lpSolveStatus: "all-cases-solved",
    decisionEligible: true,
    decision: "PATH B: pre-baked scenario grid is required because true LP solve time exceeds the 300 ms target.",
    nextStep: "Generate an offline scenario grid and keep browser interaction as interpolation/filtering over pre-baked results.",
    maxLpSolveMs: roundMs(maxSolveMs),
  };
}

function runBenchmark(options = {}) {
  const sizes = options.sizes || DEFAULT_SIZES;
  const params = { ...DEFAULT_PARAMS, ...(options.params || {}) };
  const runs = options.runs || DEFAULT_RUNS;
  const solver = detectLpSolverStatus(options);
  const cases = sizes.map((size) => summarizeCase(size, params, { ...options, runs }));
  const decision = buildDecision(cases);

  return {
    kind: "research-network-phase2a-spike-benchmark",
    generatedAt: options.generatedAt || new Date().toISOString(),
    fixtureDir: path.relative(SPIKE_DIR, options.fixtureDir || FIXTURE_DIR),
    runsPerCase: runs,
    solverStatus: solver.status,
    solverDetail: solver.detail,
    lpSolveStatus: decision.lpSolveStatus,
    decisionEligible: decision.decisionEligible,
    decision: decision.decision,
    nextStep: decision.nextStep,
    maxLpSolveMs: decision.maxLpSolveMs,
    thresholdMs: LP_TARGET_MS,
    targetLpSolveMs: LP_TARGET_MS,
    licenseNote: "glpk.js is GPL-3.0; any browser/distribution release must confirm license compatibility or replace the solver before shipping.",
    params,
    cases,
  };
}

async function runBenchmarkAsync(options = {}) {
  try {
    const glpk = await loadGlpkForBenchmark(options);
    return runBenchmark({ ...options, glpk });
  } catch (error) {
    const report = runBenchmark(options);
    return {
      ...report,
      solverStatus: "lp-solver-load-failed",
      solverDetail: String(error && error.message ? error.message : error),
      lpSolveStatus: "not-run-glpk-load-failed",
      decisionEligible: false,
      decision: "NO FINAL A/B DECISION",
      nextStep: "Fix glpk.js/node loading before reopening the Phase 2a decision gate.",
    };
  }
}

function writeBenchmarkReport(report, outPath = DEFAULT_REPORT_PATH) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
  return outPath;
}

if (require.main === module) {
  runBenchmarkAsync()
    .then((report) => {
      const outPath = writeBenchmarkReport(report);
      console.log(JSON.stringify({
        wrote: outPath,
        kind: report.kind,
        decision: report.decision,
        solverStatus: report.solverStatus,
        decisionEligible: report.decisionEligible,
        cases: report.cases.map((item) => ({
          nodeCount: item.nodeCount,
          interfaceGenerationMs: item.interfaceGenerationMs,
          heuristicSolveMs: item.heuristicSolveMs,
          lpSolveMs: item.lpSolveMs,
          lpSolveStatus: item.lpSolveStatus,
        })),
      }, null, 2));
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = {
  DEFAULT_SIZES,
  DEFAULT_RUNS,
  DEFAULT_PARAMS,
  LP_TARGET_MS,
  SPIKE_DIR,
  FIXTURE_DIR,
  DEFAULT_REPORT_PATH,
  detectLpSolverStatus,
  fixturePathForSize,
  loadFixtureNetwork,
  loadGlpkForBenchmark,
  runBenchmark,
  runBenchmarkAsync,
  summarizeCase,
  writeBenchmarkReport,
};
