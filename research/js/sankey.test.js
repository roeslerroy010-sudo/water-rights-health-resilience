const assert = require("assert");
const TradeSankey = require("./sankey");

const EPS = 1e-3;
const ROUND2_REALLOCATION = [
  { key: "agri", label: "农业", delta: -768000000 },
  { key: "industry", label: "工业", delta: -1871000000 },
  { key: "urban", label: "生活", delta: 399000000 },
  { key: "eco", label: "生态", delta: 16000000 },
];

function closeTo(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) <= EPS, `${label}: expected ${expected}, got ${actual}`);
}

function uniqueNodes(links, side) {
  const nodes = new Map();
  links.forEach((link) => nodes.set(link[side].key, link[side]));
  return Array.from(nodes.values());
}

function nodeAmount(node, side) {
  const raw = Number(node.value !== undefined ? node.value : node.delta) || 0;
  if (side === "from" && !node.isSupplementalSource) return Math.abs(raw);
  return Math.max(0, raw);
}

function sideTotal(links, side) {
  return uniqueNodes(links, side).reduce((sum, node) => sum + nodeAmount(node, side), 0);
}

function withCapturedWarn(run) {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    return { result: run(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

function testUnreallocatedEqualsReduceMinusGain() {
  const { result: links, warnings } = withCapturedWarn(() => (
    TradeSankey.buildSectorDispatchLinks(ROUND2_REALLOCATION, 1518000000)
  ));
  const rightNodes = uniqueNodes(links, "to");
  const sink = rightNodes.find((node) => node.isUnreallocated);

  assert.ok(sink, "Sankey should add an unreallocated sink when reductions exceed gains");
  assert.strictEqual(sink.label, "留在河道/未取用");
  closeTo(sink.value, 2240000000, "unreallocated sink should equal withdrawal-sector R-G, not stale explicit input");
  closeTo(sideTotal(links, "from"), sideTotal(links, "to"), "sector Sankey node totals should conserve water");
  assert.ok(
    ![...uniqueNodes(links, "from"), ...uniqueNodes(links, "to")].some((node) => node.key === "eco" || node.label === "生态"),
    "eco should not appear as a sector Sankey node"
  );
  assert.ok(
    warnings.some((warning) => /忽略不守恒的 unreallocated/.test(warning)),
    "Sankey should warn when an explicit unreallocated value would break R-G"
  );
}

function testRenderedLabelAndFootnote() {
  const markup = TradeSankey.renderToString({ reallocation: ROUND2_REALLOCATION });
  const compact = markup.replace(/\s+/g, " ");

  assert.ok(compact.includes("留在河道/未取用"), "rendered Sankey should use the corrected sink label");
  assert.ok(!compact.includes("生态"), "rendered sector Sankey should not include eco as a department");
  assert.ok(!compact.includes("原未取用/新增配水"), "rendered Sankey should not use the old label for R>G");
  assert.ok(
    /减用的水未必全部再配，差额 22\.40亿m³ 留在河道\/未取用/.test(compact),
    "footnote should explain the R-G difference goes to the river/unwithdrawn sink"
  );
}

function testGainDominantCaseStillConserves() {
  const links = TradeSankey.buildSectorDispatchLinks([
    { key: "agri", label: "农业", delta: -10 },
    { key: "industry", label: "工业", delta: 0 },
    { key: "urban", label: "生活", delta: 25 },
    { key: "eco", label: "生态", delta: 5 },
  ]);
  closeTo(sideTotal(links, "from"), sideTotal(links, "to"), "gain-dominant Sankey should still conserve water");
}

testUnreallocatedEqualsReduceMinusGain();
testRenderedLabelAndFootnote();
testGainDominantCaseStillConserves();

console.log("sankey tests passed");
