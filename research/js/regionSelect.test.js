const assert = require("assert");
const ResearchRegionSelect = require("./regionSelect");
const ResearchNetworkModel = require("./networkModel");

const fullNetwork = {
  topology: {
    UP: "DOWN",
    DOWN: "OUTLET",
  },
  subbasins: [
    {
      id: "UP",
      name: "External upstream",
      centroid: [114.1, 30.6],
      population: 1000,
      demand: { urban: 5, eco: 0, agri: 0, industry: 10 },
      supply: { qLocal: 200, qAvail: 200, qOutflow: 123 },
      healthWeight: { urban: 1, eco: 0.7, agri: 0.1, industry: -0.25 },
      downstream: "DOWN",
    },
    {
      id: "DOWN",
      name: "Selected downstream",
      centroid: [114.4, 30.5],
      population: 50000,
      demand: { urban: 20, eco: 5, agri: 0, industry: 0 },
      supply: { qLocal: 7, qAvail: 7, externalInflow: 2 },
      healthWeight: { urban: 1, eco: 0.7, agri: 0.1, industry: -0.25 },
      downstream: "OUTLET",
    },
  ],
};

function run() {
  const emptySelection = ResearchRegionSelect.selectSubbasins(
    { bbox: [113.0, 29.0, 113.1, 29.1] },
    fullNetwork.subbasins
  );
  assert.deepStrictEqual(emptySelection, [], "empty rectangle is detectable as no selected subbasins");

  const selected = ResearchRegionSelect.selectSubbasins(
    { bbox: [114.3, 30.4, 114.5, 30.6] },
    fullNetwork.subbasins
  );
  assert.deepStrictEqual(selected, ["DOWN"], "single-subbasin rectangle uses centroid bbox");

  const selectedFromLeafletRect = ResearchRegionSelect.selectSubbasins(
    { type: "bbox", sw: [30.4, 114.3], ne: [30.6, 114.5] },
    fullNetwork.subbasins
  );
  assert.deepStrictEqual(selectedFromLeafletRect, ["DOWN"], "Leaflet-style sw/ne rectangle uses centroid bbox");

  const fullSelection = ResearchRegionSelect.selectSubbasins(
    { bbox: [114.0, 30.4, 114.5, 30.7] },
    fullNetwork.subbasins
  );
  assert.deepStrictEqual(fullSelection.sort(), ["DOWN", "UP"], "full-region rectangle is detectable");

  const subNetwork = ResearchRegionSelect.extractSubNetwork(selected, fullNetwork);
  assert.deepStrictEqual(subNetwork.topology, { DOWN: "OUTLET" }, "downstream-only subnetwork drains to OUTLET");

  const down = subNetwork.subbasins.find((item) => item.id === "DOWN");
  assert.ok(down, "selected downstream node is present");
  assert.strictEqual(down.supply.boundaryExternalInflow, 123, "upstream qOutflow is injected at the boundary");
  assert.strictEqual(down.supply.externalInflow, 125, "existing external inflow is preserved and boundary inflow is added");
  assert.deepStrictEqual(subNetwork.meta.boundaryLinks, [
    { from: "UP", to: "DOWN", volume: 123, source: "qOutflow" },
  ]);

  const solved = ResearchNetworkModel.solveNetwork({
    network: subNetwork,
    climate: "baseline",
    healthFloor: 0,
    tradingCost: "none",
  });
  assert.strictEqual(solved.nodeById.DOWN.qAvail, 132, "solver sees local plus boundary inflow as available water");
}

run();
console.log("regionSelect tests passed");
