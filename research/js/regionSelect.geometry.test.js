const assert = require("assert");
const ResearchRegionSelect = require("./regionSelect");

const unitSquare = {
  type: "Polygon",
  coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
};

function squareAt(minLng, minLat, size) {
  return {
    type: "Polygon",
    coordinates: [[
      [minLng, minLat],
      [minLng + size, minLat],
      [minLng + size, minLat + size],
      [minLng, minLat + size],
      [minLng, minLat],
    ]],
  };
}

function run() {
  const { pointInGeometry } = ResearchRegionSelect._internals;

  // --- buildSamplePoints ---
  const samples = ResearchRegionSelect.buildSamplePoints(unitSquare);
  assert.ok(samples.length >= 100, "unit square yields a dense sample (" + samples.length + ")");
  samples.forEach((point) => {
    assert.ok(pointInGeometry(point, unitSquare), "sample point stays inside the polygon");
  });

  const sliver = {
    type: "Polygon",
    coordinates: [[[0, 0], [1e-12, 0], [1e-12, 1e-12], [0, 1e-12], [0, 0]]],
  };
  const fallbackSamples = ResearchRegionSelect.buildSamplePoints(sliver);
  assert.strictEqual(fallbackSamples.length, 1, "degenerate polygon falls back to a single point");

  // --- coverageFraction ---
  const sample = {
    points: samples,
    bbox: ResearchRegionSelect.geometryBbox(unitSquare),
  };
  const rightHalf = {
    type: "Polygon",
    coordinates: [[[0.5, -1], [2, -1], [2, 2], [0.5, 2], [0.5, -1]]],
  };
  const half = ResearchRegionSelect.coverageFraction(sample, rightHalf);
  assert.ok(Math.abs(half - 0.5) < 0.08, "right-half region covers ~50% (" + half.toFixed(3) + ")");

  const disjoint = squareAt(10, 10, 1);
  assert.strictEqual(ResearchRegionSelect.coverageFraction(sample, disjoint), 0, "disjoint region covers 0%");

  const containing = squareAt(-1, -1, 3);
  assert.strictEqual(ResearchRegionSelect.coverageFraction(sample, containing), 1, "containing region covers 100%");

  // --- selectSubbasins with geometry: threshold hit / miss ---
  const basins = [
    { id: "A", centroid: [0.5, 0.5], feature: { geometry: unitSquare } },
    { id: "B", centroid: [3.5, 0.5], feature: { geometry: squareAt(3, 0, 1) } },
  ];
  // Lasso covering all of A but only ~10% of B.
  const lasso = {
    type: "Polygon",
    coordinates: [[[-0.5, -0.5], [3.1, -0.5], [3.1, 1.5], [-0.5, 1.5], [-0.5, -0.5]]],
  };
  const hit = ResearchRegionSelect.selectSubbasins(lasso, basins, { threshold: 0.3 });
  assert.deepStrictEqual(hit, ["A"], "30% threshold keeps A, drops the barely-touched B");
  const loose = ResearchRegionSelect.selectSubbasins(lasso, basins, { threshold: 0.05 });
  assert.deepStrictEqual(loose.sort(), ["A", "B"], "5% threshold also selects the barely-touched B");

  // bbox region against geometry basins takes the coverage path too.
  const bboxHit = ResearchRegionSelect.selectSubbasins(
    { type: "bbox", sw: [-0.5, -0.5], ne: [1.5, 3.1] },
    basins,
    { threshold: 0.3 }
  );
  assert.deepStrictEqual(bboxHit, ["A"], "bbox region honours the coverage threshold");

  // ids region resolves directly.
  const idsHit = ResearchRegionSelect.selectSubbasins({ type: "ids", ids: ["B", "MISSING"] }, basins);
  assert.deepStrictEqual(idsHit, ["B"], "ids region keeps only known basins");

  // --- buildSampleIndex + selectByCoverage over a FeatureCollection ---
  const geojson = {
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { id: "A" }, geometry: unitSquare },
      { type: "Feature", properties: { id: "B" }, geometry: squareAt(3, 0, 1) },
    ],
  };
  const index = ResearchRegionSelect.buildSampleIndex(geojson);
  assert.strictEqual(index.size, 2, "sample index covers both features");
  assert.strictEqual(ResearchRegionSelect.buildSampleIndex(geojson), index, "sample index is cached per geojson");
  const covered = ResearchRegionSelect.selectByCoverage(lasso, geojson, { threshold: 0.3 });
  assert.deepStrictEqual(covered, ["A"], "selectByCoverage matches selectSubbasins");

  // --- topology expansion on {A:B, B:C, C:OUTLET, D:B} ---
  const topology = { A: "B", B: "C", C: "OUTLET", D: "B" };
  const upstreamIndex = ResearchRegionSelect.buildUpstreamIndex(topology);
  assert.deepStrictEqual(upstreamIndex.B.sort(), ["A", "D"], "upstream index inverts topology");

  const upstream = ResearchRegionSelect.expandUpstream(["C"], topology);
  assert.deepStrictEqual(upstream.sort(), ["A", "B", "C", "D"], "expandUpstream reaches the whole catchment");

  const downstream = ResearchRegionSelect.expandDownstream(["A"], topology);
  assert.deepStrictEqual(downstream.sort(), ["A", "B", "C"], "expandDownstream follows the chain to OUTLET (exclusive)");

  const both = ResearchRegionSelect.expandUpstream(["B"], topology);
  assert.deepStrictEqual(both.sort(), ["A", "B", "D"], "expandUpstream from mid-chain excludes downstream C");

  // --- selectByCity ---
  const cityItems = [
    { id: "A", adminCities: ["Wuhan"] },
    { id: "B", adminCities: ["Wuhan", "Ezhou"] },
    { id: "C", adminCities: ["Huanggang"] },
  ];
  assert.deepStrictEqual(
    ResearchRegionSelect.selectByCity("Wuhan", cityItems).sort(),
    ["A", "B"],
    "selectByCity includes cross-city basins"
  );
  assert.deepStrictEqual(
    ResearchRegionSelect.selectByCity("Ezhou", cityItems),
    ["B"],
    "selectByCity matches secondary admin city"
  );

  console.log("regionSelect geometry tests passed");
}

run();
