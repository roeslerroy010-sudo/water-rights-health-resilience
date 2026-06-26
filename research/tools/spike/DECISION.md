# Phase 2a LP Spike Decision Gate

Status: **PATH A SELECTED - browser real-time LP solve**

Decision date: 2026-06-14

The Phase 2a spike now runs a real `glpk.js` LP solve on deterministic 30/50/80-node synthetic hydrologic DAG fixtures. All three fixtures solved to `optimal`, produced no NaN values, kept LP numeric outputs non-negative, and stayed well below the 300 ms target threshold.

## Evidence Produced

Source report: `research/tools/spike/benchmark-report.json`

Environment result:

- `solverStatus`: `glpk-js-wired`
- `lpSolveStatus`: `all-cases-solved`
- `decisionEligible`: `true`
- `thresholdMs`: `300`
- `maxLpSolveMs`: `4.743`

| Nodes | LP interface variables | Estimated constraints | GLPK variables | GLPK constraints | Interface median ms | Heuristic median ms | True LP median ms | GLPK status |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 30 | 353 | 736 | 180 | 60 | 0.196 | 0.973 | 1.740 | optimal |
| 50 | 778 | 1606 | 300 | 100 | 0.152 | 1.416 | 2.384 | optimal |
| 80 | 1835 | 3750 | 480 | 160 | 0.205 | 3.276 | 4.743 | optimal |

The true LP timing is the median of five repeated runs per fixture. Raw run timings are preserved in the benchmark report as `lpSolveRunsMs`.

## Decision

Choose **Path A: browser real-time LP solve** for the 30-80 subbasin target.

Rationale:

- The largest fixture solved in 4.743 ms median time in Node, far below the 300 ms decision threshold.
- `networkModel.js` now has a real `glpk.js` path for water balance, non-negative routed outflow, demand caps, and health-floor constraints.
- The existing heuristic solver remains as a fallback when no ready synchronous GLPK instance is available.

## Phase 3 Impact

Phase 3 may proceed with real-time LP integration rather than an offline pre-baked scenario grid, but the frontend integration must still verify:

- Browser loading strategy for `glpk.js` or a worker-backed equivalent.
- Bundle size and initialization latency on the demo device.
- UI behavior when GLPK fails to load, using the existing heuristic fallback.

## License Risk

The cleaned repository vendors the minimal `glpk.js` runtime under `research/vendor/glpk.js/`, whose license is `GPL-3.0`. Before shipping, distributing, or using this in a closed-source/public demo package, the project owner must confirm GPL-3.0 compatibility or replace the solver with a license-compatible LP engine.

This decision selects Path A for engineering direction; it does not close the licensing review or browser-loading validation.
