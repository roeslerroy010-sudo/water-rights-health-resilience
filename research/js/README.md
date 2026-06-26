# Research Network Model

`networkModel.js` is a browser-safe network model for the current research frontend.

It exports CommonJS in Node and attaches the same API to `window.ResearchNetworkModel` in browsers:

- `loadInputs(source)` / `load(source)`
- `normalizeInputs(raw)` / `normalize(raw)`
- `topologicalSort(network)`
- `computeDownstreamReach(network, options)`
- `solveNetwork(params)`
- `computeHealthTax(nodeIdOrNode, params)`
- `computeIncentiveFlags(solutionOrParams)`
- `buildLpProblemInterface(network, params)`
- `buildGlpkProblem(network, params, glpk)`
- `estimateProblemSize(network, params)`
- `resolveLpSolverAdapter(params)`
- `solveWithGlpkInstance(glpk, network, params)`
- `solveNetworkLpAsync(params)`
- `loadNodeGlpkInstance()`

The primary path is a real `glpk.js` LP solve when a ready synchronous GLPK instance is supplied through `params.glpk`, `params.glpkInstance`, or `globalThis.glpk`. The LP includes demand caps, node water balance, non-negative routed outflow, and health-floor constraints. `solveNetworkLpAsync()` is the Node helper that loads the local `research/vendor/glpk.js` runtime and returns the same solution shape.

The deterministic heuristic is still kept as the fallback. It routes water lots through the DAG, so upstream withdrawals reduce downstream `qAvail`; downstream use of upstream-origin water is recorded as an OD trade flow only when the target is hydrologically downstream of the origin. Local runoff and pass-through mainstem water are both consumed into available supply: input aliases include `supply.externalInflow`, `supply.mainstemInflow`, top-level `externalInflow`, and top-level `mainstemInflow`. Both solvers include `tau`, climate availability, health floor, and trading cost parameters. Industrial health tax is based on downstream population-weighted exposure.

Model-side coverage in `networkModel.test.js` locks the following contracts:

- Mainstem/pass-through injection raises the entry subbasin `qAvail` and routes surplus water to downstream demand.
- Industrial health tax detail rises with downstream population-weighted exposure.
- Higher upstream industrial allocation raises the current tax-base proxy, `allocation.industry * healthTax.taxPerM3`.
- Incentive diagnostics locate violations by subbasin and sector via `flag.nodeId`, `flag.sector`, and `violatingNodeSectors`.

`buildLpProblemInterface()` and `estimateProblemSize()` remain diagnostic hooks for reporting the full downstream-OD interface size. The production LP path is `buildGlpkProblem()` plus `solveWithGlpkInstance()`. `solveNetwork()` enters the LP path when `solver:"lp"`, `preferLp`, `useLp`, a custom `lpSolver`, `glpk`, `glpkInstance`, or global `glpk`/`window.glpk` is detected; without a working adapter it keeps the heuristic fallback and reports `lpReady:false`.

## Benchmark Harness

`research/tools/spike/generate-fixtures.js` creates deterministic 30/50/80-node synthetic hydrologic DAG fixtures under `research/tools/spike/fixtures/`. Each fixture declares `synthetic:true` and includes four-sector demand, local supply, and explicit transit injection.

`networkModel.benchmark.js` reads those 30/50/80 fixtures and reports:

- LP interface generation time.
- Allocation, outflow, and downstream-only OD trade variable counts.
- Constraint descriptions and estimated constraint counts.
- Current heuristic `solveNetwork()` time.
- True `glpk.js` LP solve time and raw run timings.
- `solverStatus`, `lpSolveStatus`, `decisionEligible`, and the 300 ms decision threshold.

The 2026-06-14 benchmark selected browser real-time LP solve for the 30-80 node target. The measured true LP medians were 1.740 ms, 2.384 ms, and 4.743 ms for 30/50/80 nodes, all below the 300 ms threshold. `research/tools/spike/DECISION.md` records the evidence and the remaining risks.

Minimal input shape:

```json
{
  "topology": { "SB01": "SB02", "SB02": "OUTLET" },
  "subbasins": [
    {
      "id": "SB01",
      "population": 100000,
      "demand": { "agri": 120, "industry": 30, "urban": 40, "eco": 10 },
      "supply": { "qLocal": 180, "externalInflow": 0 },
      "healthWeight": { "agri": 0.1, "industry": -0.25, "urban": 1, "eco": 0.7 }
    }
  ]
}
```

Run the test:

```bash
node research/js/networkModel.test.js
```

Regenerate deterministic Phase 2a fixtures:

```bash
node research/tools/spike/generate-fixtures.js
```

Run the Phase 2a spike benchmark:

```bash
node research/js/networkModel.benchmark.js
```
