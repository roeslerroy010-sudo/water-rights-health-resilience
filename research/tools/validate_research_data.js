#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.resolve(__dirname, "../data");
const ATTRS_PATH = path.join(DATA_DIR, "wuhan-attrs.json");
const SUBBASINS_PATH = path.join(DATA_DIR, "wuhan-subbasins.geojson");
const RIVERS_PATH = path.join(DATA_DIR, "wuhan-rivers.geojson");
const PROVENANCE_PATH = path.join(DATA_DIR, "provenance.json");
const PROVENANCE_SAMPLE_PATH = path.join(DATA_DIR, "provenance.sample.json");
const BBOX = { minLng: 112.5, minLat: 29.0, maxLng: 116.0, maxLat: 31.5 };
const SECTORS = ["agri", "industry", "urban", "eco"];
const REQUIRED_CITIES = [
  "Wuhan",
  "Huangshi",
  "Ezhou",
  "Xiaogan",
  "Huanggang",
  "Xianning",
  "Xiantao",
  "Tianmen",
  "Qianjiang",
];
const SIZE_TARGET_BYTES = 3 * 1024 * 1024;
const MODES = {
  SAMPLE: "sample",
  FULL_BAKE: "full-bake",
};
const PLACEHOLDER_SOURCE_PATTERN = /\b(hand-authored|mvp|sample|no files have been downloaded)\b/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const REQUIRED_PROVENANCE_CATEGORIES = [
  "clcd",
  "worldcover",
  "worldpop",
  "viirs",
  "merit",
  "hydrosheds",
  "climate",
  "gadm",
  "bulletin",
];
const PRE1_MAINSTEM_INJECTIONS = [
  { id: "PF_465500", externalInflow: 355275000000, label: "Yangtze mainstem entry" },
  { id: "PF_465610", externalInflow: 17553000000, label: "Han River mainstem entry" },
];
const PRE1_EXPECTED_EXTERNAL_INFLOW = PRE1_MAINSTEM_INJECTIONS.reduce((sum, item) => sum + item.externalInflow, 0);
const PRE1_RELATIVE_TOLERANCE = 0.001;
const EXPECTED_NAME_SUBBASIN_COUNT = 66;
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

function printHelp() {
  console.log(`Usage: node research/tools/validate_research_data.js [--sample|--full-bake|--help]

Modes:
  --sample     Validate the current hand-authored MVP sample. This is the default.
  --full-bake  Validate a future real-data offline bake.
  --help       Show this help message.

Sample mode requires meta.demoSample=true, meta.estimated=true,
meta.synthetic=true, and meta.realDataReady=false. It accepts 8-12
subbasins as the small scaffold and warns below the full 30-subbasin target.

Full-bake mode requires meta.demoSample=false, meta.synthetic=false,
meta.realDataReady=true, 66 named subbasins, non-placeholder source text,
data/provenance.json with source files for every required input category,
exact Wuhan 1+8 citySectorDemand coverage, finite supply qLocal/qAvail/
externalInflow/mainstemInflow fields, Chinese readable subbasin.name values
that are not Pfaf/PF code labels, preserved id/pfafId/code technical IDs,
and non-empty river flowThrough arrays.`);
}

function parseArgs(argv) {
  let mode = MODES.SAMPLE;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--sample") {
      mode = MODES.SAMPLE;
      continue;
    }
    if (arg === "--full-bake") {
      mode = MODES.FULL_BAKE;
      continue;
    }
    console.error(`Unknown option: ${arg}\n`);
    printHelp();
    process.exit(1);
  }
  return mode;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`Cannot parse ${path.relative(process.cwd(), filePath)}: ${error.message}`);
    return null;
  }
}

function relativeToCwd(filePath) {
  return path.relative(process.cwd(), filePath);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function walk(value, visitor, keyPath = "$") {
  visitor(value, keyPath);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visitor, `${keyPath}[${index}]`));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      walk(child, visitor, `${keyPath}.${key}`);
    }
  }
}

function checkNoInvalidNumbers(label, value) {
  let bad = 0;
  walk(value, (node, keyPath) => {
    if (typeof node === "number" && !Number.isFinite(node)) {
      bad += 1;
      fail(`${label} has non-finite number at ${keyPath}`);
    }
    if (typeof node === "string" && /(^|[^a-z])nan([^a-z]|$)/i.test(node)) {
      bad += 1;
      fail(`${label} has string that looks like NaN at ${keyPath}`);
    }
  });
  if (bad === 0) ok(`${label} contains no NaN or non-finite values`);
}

function flattenCoordinates(geometry) {
  const coords = [];
  function visit(node) {
    if (!Array.isArray(node)) return;
    if (node.length >= 2 && isFiniteNumber(node[0]) && isFiniteNumber(node[1])) {
      coords.push([node[0], node[1]]);
      return;
    }
    node.forEach(visit);
  }
  if (geometry && geometry.coordinates) visit(geometry.coordinates);
  return coords;
}

function insideBbox([lng, lat]) {
  return lng >= BBOX.minLng && lng <= BBOX.maxLng && lat >= BBOX.minLat && lat <= BBOX.maxLat;
}

function checkGeojsonBbox(label, geojson) {
  let checked = 0;
  for (const feature of geojson.features || []) {
    for (const coord of flattenCoordinates(feature.geometry)) {
      checked += 1;
      if (!insideBbox(coord)) {
        fail(`${label} coordinate outside Wuhan metro bbox: ${JSON.stringify(coord)} in ${feature.id || feature.properties?.id || "unknown feature"}`);
      }
    }
  }
  if (checked > 0) ok(`${label} coordinates are inside spec bbox (${checked} coordinate pairs checked)`);
  else fail(`${label} has no coordinates`);
}

function checkRequiredSectorObject(label, obj) {
  if (!obj || typeof obj !== "object") {
    fail(`${label} is missing`);
    return;
  }
  for (const sector of SECTORS) {
    if (!isFiniteNumber(obj[sector])) {
      fail(`${label}.${sector} must be a finite number`);
    }
  }
}

function sortedIds(values) {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function arraysEqual(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sampleList(items, limit) {
  const shown = items.slice(0, limit).join("; ");
  return items.length > limit ? `${shown}; ... +${items.length - limit} more` : shown;
}

function hasChinese(text) {
  return /[\u3400-\u9fff]/.test(String(text || ""));
}

function isPfafLikeLabel(name, id, pfafId, code) {
  const value = String(name || "").trim();
  if (!value) return true;
  const normalized = value.toLowerCase();
  const identifiers = [id, pfafId, code]
    .filter((item) => item !== undefined && item !== null && String(item).trim() !== "")
    .map((item) => String(item).trim().toLowerCase());
  if (identifiers.includes(normalized)) return true;
  return /\bpfaf(?:stetter)?\b/i.test(value) || /\bPF_\d+\b/.test(value);
}

function hasNamePattern(name) {
  const value = String(name || "");
  return NAME_CITY_LABELS.some((city) => value.includes(city)) &&
    NAME_FEATURE_LABELS.some((feature) => value.includes(feature));
}

function checkIdAlignment(attrs, subbasinsGeojson) {
  const attrIds = new Set((attrs.subbasins || []).map((subbasin) => subbasin.id));
  const geoIds = new Set((subbasinsGeojson.features || []).map((feature) => feature.properties?.id || feature.id));
  const topoIds = new Set(Object.keys(attrs.topology || {}));

  if (attrIds.size === 0) fail("attrs.subbasins is empty");
  if (!arraysEqual(sortedIds(attrIds), sortedIds(geoIds))) {
    fail(`Subbasin id mismatch between attrs and geojson. attrs=${sortedIds(attrIds).join(",")} geojson=${sortedIds(geoIds).join(",")}`);
  } else {
    ok(`attrs and wuhan-subbasins.geojson ids align (${attrIds.size} subbasins)`);
  }

  if (!arraysEqual(sortedIds(attrIds), sortedIds(topoIds))) {
    fail(`Topology keys must match attr ids. topology=${sortedIds(topoIds).join(",")}`);
  } else {
    ok("topology keys match attrs.subbasins ids");
  }

  return attrIds;
}

function downstreamReachFor(id, topology) {
  const reach = [];
  const seen = new Set([id]);
  let current = topology[id];
  while (current && current !== "OUTLET") {
    if (seen.has(current)) throw new Error(`cycle at ${current}`);
    reach.push(current);
    seen.add(current);
    current = topology[current];
  }
  reach.push("OUTLET");
  return reach;
}

function checkTopology(attrs, attrIds) {
  const topology = attrs.topology || {};
  for (const [id, downstream] of Object.entries(topology)) {
    if (downstream !== "OUTLET" && !attrIds.has(downstream)) {
      fail(`topology.${id} points to unknown downstream id ${downstream}`);
    }
  }

  let cycles = 0;
  for (const id of attrIds) {
    try {
      downstreamReachFor(id, topology);
    } catch (error) {
      cycles += 1;
      fail(`topology cycle detected from ${id}: ${error.message}`);
    }
  }
  if (cycles === 0) ok("topology is acyclic and every subbasin reaches OUTLET");
}

function checkSubbasinRecords(attrs, mode) {
  const topology = attrs.topology || {};
  const computedTotals = Object.fromEntries(SECTORS.map((sector) => [sector, 0]));

  for (const subbasin of attrs.subbasins || []) {
    if (!subbasin.id) fail("subbasin without id");
    if (!Array.isArray(subbasin.centroid) || subbasin.centroid.length !== 2 || !subbasin.centroid.every(isFiniteNumber)) {
      fail(`${subbasin.id} centroid must be [lng, lat]`);
    } else if (!insideBbox(subbasin.centroid)) {
      fail(`${subbasin.id} centroid outside Wuhan metro bbox`);
    }

    if (subbasin.downstream !== topology[subbasin.id]) {
      fail(`${subbasin.id} downstream does not match topology`);
    }

    let expectedReach = null;
    try {
      expectedReach = downstreamReachFor(subbasin.id, topology);
    } catch (error) {
      expectedReach = [];
    }
    if (!Array.isArray(subbasin.downstreamReach) || !arraysEqual(subbasin.downstreamReach, expectedReach)) {
      fail(`${subbasin.id} downstreamReach should be ${JSON.stringify(expectedReach)}`);
    }

    if (!Array.isArray(subbasin.adminCities) || subbasin.adminCities.length === 0) {
      fail(`${subbasin.id} must include adminCities`);
    }

    if (!isFiniteNumber(subbasin.areaKm2) || subbasin.areaKm2 <= 0) fail(`${subbasin.id} areaKm2 must be positive`);
    if (!isFiniteNumber(subbasin.population) || subbasin.population < 0) fail(`${subbasin.id} population must be non-negative`);

    checkRequiredSectorObject(`${subbasin.id}.demand`, subbasin.demand);
    checkRequiredSectorObject(`${subbasin.id}.healthWeight`, subbasin.healthWeight);
    if (!subbasin.supply || typeof subbasin.supply !== "object") {
      fail(`${subbasin.id}.supply is missing`);
    } else {
      for (const field of ["qLocal", "qAvail"]) {
        if (!isFiniteNumber(subbasin.supply[field])) fail(`${subbasin.id}.supply.${field} must be finite`);
      }
      if (mode === MODES.FULL_BAKE) {
        for (const field of ["externalInflow", "mainstemInflow"]) {
          if (!isFiniteNumber(subbasin.supply[field])) fail(`${subbasin.id}.supply.${field} must be finite in full-bake mode`);
        }
      }
    }

    for (const sector of SECTORS) {
      if (isFiniteNumber(subbasin.demand?.[sector])) computedTotals[sector] += subbasin.demand[sector];
    }
  }

  ok("subbasin records include centroid, demand, supply, healthWeight, downstream, and downstreamReach");
  return computedTotals;
}

function checkNameSubbasinLabels(attrs, mode) {
  if (mode !== MODES.FULL_BAKE) return;

  const subbasins = attrs.subbasins || [];
  if (subbasins.length !== EXPECTED_NAME_SUBBASIN_COUNT) {
    fail(`NAME full-bake data must contain exactly ${EXPECTED_NAME_SUBBASIN_COUNT} named subbasins; got ${subbasins.length}`);
  } else {
    ok(`NAME full-bake data contains ${EXPECTED_NAME_SUBBASIN_COUNT} named subbasins`);
  }

  const missingName = [];
  const nonChineseName = [];
  const pfafLikeName = [];
  const weakPattern = [];
  const missingTechnicalId = [];
  const invalidPfafId = [];
  const invalidCode = [];

  for (const subbasin of subbasins) {
    const id = String(subbasin.id || "");
    const pfafId = subbasin.pfafId;
    const code = subbasin.code;
    const name = subbasin.name;
    const label = id || "(missing id)";

    if (!id || !/^PF_\d+$/.test(id)) {
      missingTechnicalId.push(`${label}: id=${JSON.stringify(subbasin.id)}`);
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
      continue;
    }

    if (!hasChinese(name)) nonChineseName.push(`${label}: ${JSON.stringify(name)}`);
    if (isPfafLikeLabel(name, id, pfafId, code)) pfafLikeName.push(`${label}: ${JSON.stringify(name)}`);
    if (!hasNamePattern(name)) weakPattern.push(`${label}: ${JSON.stringify(name)} lacks city+land-use derived pattern`);
  }

  if (missingName.length) fail(`NAME missing subbasin.name for ${missingName.length} basin(s): ${sampleList(missingName, 8)}`);
  if (nonChineseName.length) fail(`NAME labels must be Chinese-readable derived labels; non-Chinese examples: ${sampleList(nonChineseName, 8)}`);
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

function withinRelativeTolerance(actual, expected, relativeTolerance) {
  return Math.abs(actual - expected) <= Math.abs(expected) * relativeTolerance;
}

function formatYiM3(value) {
  return (value / 100000000).toFixed(2);
}

function checkPre1ExternalInflow(attrs, mode) {
  if (mode !== MODES.FULL_BAKE) return;

  const byId = new Map((attrs.subbasins || []).map((subbasin) => [subbasin.id, subbasin]));
  const total = (attrs.subbasins || []).reduce((sum, subbasin) => {
    const value = subbasin.supply?.externalInflow;
    return sum + (isFiniteNumber(value) ? value : 0);
  }, 0);

  if (!withinRelativeTolerance(total, PRE1_EXPECTED_EXTERNAL_INFLOW, PRE1_RELATIVE_TOLERANCE)) {
    fail(
      `PRE-1 externalInflow total must be approximately ${PRE1_EXPECTED_EXTERNAL_INFLOW} m3 ` +
      `(${formatYiM3(PRE1_EXPECTED_EXTERNAL_INFLOW)} 亿 m3); got ${total} m3 (${formatYiM3(total)} 亿 m3)`
    );
  } else {
    ok(`PRE-1 externalInflow total is ${total} m3 (${formatYiM3(total)} 亿 m3)`);
  }

  for (const injection of PRE1_MAINSTEM_INJECTIONS) {
    const subbasin = byId.get(injection.id);
    if (!subbasin) {
      fail(`PRE-1 ${injection.label} injection node ${injection.id} is missing`);
      continue;
    }
    const actual = subbasin.supply?.externalInflow;
    if (!isFiniteNumber(actual) || !withinRelativeTolerance(actual, injection.externalInflow, PRE1_RELATIVE_TOLERANCE)) {
      fail(
        `PRE-1 ${injection.label} ${injection.id}.supply.externalInflow must be approximately ` +
        `${injection.externalInflow} m3; got ${actual}`
      );
    } else {
      ok(`PRE-1 ${injection.label} externalInflow is present at ${injection.id}`);
    }
  }
}

function checkSectorTotals(attrs, computedTotals, mode) {
  checkRequiredSectorObject("sectorTotals", attrs.sectorTotals);

  for (const sector of SECTORS) {
    const declared = attrs.sectorTotals?.[sector];
    const computed = computedTotals[sector];
    if (isFiniteNumber(declared) && Math.abs(declared - computed) > 1e-6) {
      fail(`sectorTotals.${sector}=${declared} does not equal subbasin sum ${computed}`);
    }
  }

  const cityDemand = attrs.citySectorDemand || {};
  const cityTotals = Object.fromEntries(SECTORS.map((sector) => [sector, 0]));
  for (const [city, demand] of Object.entries(cityDemand)) {
    checkRequiredSectorObject(`citySectorDemand.${city}`, demand);
    for (const sector of SECTORS) {
      if (isFiniteNumber(demand[sector])) cityTotals[sector] += demand[sector];
    }
  }
  for (const sector of SECTORS) {
    if (Math.abs((attrs.sectorTotals?.[sector] || 0) - cityTotals[sector]) > 1e-6) {
      fail(`citySectorDemand sum for ${sector}=${cityTotals[sector]} does not equal sectorTotals ${attrs.sectorTotals?.[sector]}`);
    }
  }
  if (mode === MODES.FULL_BAKE) {
    const cityNames = new Set(Object.keys(cityDemand));
    const missingCities = REQUIRED_CITIES.filter((city) => !cityNames.has(city));
    const extraCities = [...cityNames].filter((city) => !REQUIRED_CITIES.includes(city));
    if (missingCities.length > 0) {
      fail(`citySectorDemand must cover all Wuhan 1+8 cities in full-bake mode; missing ${missingCities.join(", ")}`);
    }
    if (extraCities.length > 0) {
      fail(`citySectorDemand must only contain the Wuhan 1+8 city set in full-bake mode; extra ${extraCities.join(", ")}`);
    }
    if (missingCities.length === 0 && extraCities.length === 0) {
      ok(`citySectorDemand covers required Wuhan 1+8 cities (${REQUIRED_CITIES.length})`);
    }
  }
  ok("sectorTotals and citySectorDemand totals are present and internally consistent");
}

function checkRivers(riversGeojson, attrIds, mode) {
  let checked = 0;
  for (const feature of riversGeojson.features || []) {
    checked += 1;
    if (feature.geometry?.type !== "LineString") fail(`${feature.id || "river"} must be a LineString`);
    const props = feature.properties || {};
    for (const field of ["flowDirection", "fromSubbasin", "toSubbasin", "downstreamSubbasin"]) {
      if (!props[field]) fail(`${feature.id || "river"} missing ${field}`);
    }
    if (props.fromSubbasin && !attrIds.has(props.fromSubbasin)) fail(`${feature.id} fromSubbasin unknown: ${props.fromSubbasin}`);
    if (props.toSubbasin && !attrIds.has(props.toSubbasin)) fail(`${feature.id} toSubbasin unknown: ${props.toSubbasin}`);
    if (mode === MODES.FULL_BAKE) {
      if (!Array.isArray(props.flowThrough) || props.flowThrough.length === 0) {
        fail(`${feature.id || "river"} properties.flowThrough must be a non-empty subbasin id array in full-bake mode`);
      } else {
        for (const basinId of props.flowThrough) {
          if (!attrIds.has(basinId)) fail(`${feature.id || "river"} flowThrough contains unknown subbasin: ${basinId}`);
        }
      }
    }
  }
  if (checked > 0) ok(`river features include flow direction properties (${checked} lines)`);
  else fail("wuhan-rivers.geojson has no features");
}

function checkMetaPresence(attrs, mode) {
  const requiredFields = ["calibrationYear", "source", "note"];
  for (const field of requiredFields) {
    const value = attrs.meta?.[field];
    const missing = value === undefined || value === null || value === "";
    if (missing && mode === MODES.FULL_BAKE) {
      fail(`meta.${field} must be present for full-bake validation`);
    } else if (missing) {
      warn(`meta.${field} should be present`);
    }
  }

  if (attrs.meta?.calibrationYear !== undefined && !Number.isInteger(attrs.meta.calibrationYear)) {
    fail("meta.calibrationYear must be an integer year when present");
  }

  if (attrs.meta?.source !== undefined && typeof attrs.meta.source !== "string") {
    fail("meta.source must be a string when present");
  }
  if (attrs.meta?.note !== undefined && typeof attrs.meta.note !== "string") {
    fail("meta.note must be a string when present");
  }
}

function checkMetaForSample(attrs) {
  if (attrs.meta?.demoSample !== true) fail("meta.demoSample must be true for sample mode");
  if (attrs.meta?.estimated !== true) fail("meta.estimated must be true for sample mode");
  if (attrs.meta?.synthetic !== true) fail("meta.synthetic must be true for sample mode");
  if (attrs.meta?.realDataReady !== false) fail("meta.realDataReady must be false for sample mode");
  if (attrs.meta?.demoSample === true && attrs.meta?.estimated === true && attrs.meta?.synthetic === true && attrs.meta?.realDataReady === false) {
    ok("sample metadata honestly marks this as a synthetic estimated demo sample, not downloaded real data");
  }
}

function checkMetaForFullBake(attrs) {
  if (attrs.meta?.demoSample !== false) fail("meta.demoSample must be false for full-bake mode");
  if (attrs.meta?.synthetic !== false) fail("meta.synthetic must be false for full-bake mode");
  if (attrs.meta?.realDataReady !== true) fail("meta.realDataReady must be true for full-bake mode");
  if (typeof attrs.meta?.source === "string" && PLACEHOLDER_SOURCE_PATTERN.test(attrs.meta.source)) {
    fail("meta.source must not contain placeholder sample language in full-bake mode");
  }
  if (attrs.meta?.demoSample === false && attrs.meta?.synthetic === false && attrs.meta?.realDataReady === true) {
    ok("full-bake metadata marks the data as real-data ready");
  }
}

function checkMetaHonesty(attrs, mode) {
  if (!attrs.meta || typeof attrs.meta !== "object") {
    fail("meta object is required");
    return;
  }
  checkMetaPresence(attrs, mode);
  if (mode === MODES.FULL_BAKE) checkMetaForFullBake(attrs);
  else checkMetaForSample(attrs);
}

function checkSubbasinCount(count, mode) {
  if (mode === MODES.FULL_BAKE) {
    if (count >= 30 && count <= 80) {
      ok(`full-bake subbasin count is ${count} (within 30-80 target)`);
    } else {
      fail(`full-bake subbasin count must be 30-80; got ${count}`);
    }
    return;
  }

  if (count >= 8 && count <= 12) ok(`sample subbasin count is ${count} (accepted small sample)`);
  else warn(`sample subbasin count is ${count}; expected 8-12 for this scaffold`);
  if (count < 30) warn("full research bake should replace this with 30-80 subbasins");
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isValidIsoDate(value) {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function looksLikeSourceUrl(value) {
  return /^https?:\/\/\S+$/i.test(value) || /^doi:\S+$/i.test(value) || /^local:\S+$/i.test(value);
}

function checkProvenanceItem(item, index) {
  const label = `provenance.items[${index}]`;
  if (!isPlainObject(item)) {
    fail(`${label} must be an object`);
    return null;
  }

  const requiredFields = [
    "category",
    "inputFileName",
    "path",
    "sourceUrl",
    "downloadDate",
    "sha256",
    "license",
    "processingScript",
  ];
  for (const field of requiredFields) {
    if (!isNonEmptyString(item[field])) {
      fail(`${label}.${field} must be a non-empty string`);
    }
  }

  if (isNonEmptyString(item.category) && !REQUIRED_PROVENANCE_CATEGORIES.includes(item.category)) {
    fail(`${label}.category must be one of ${REQUIRED_PROVENANCE_CATEGORIES.join(", ")}`);
  }
  if (isNonEmptyString(item.sha256) && !SHA256_PATTERN.test(item.sha256)) {
    fail(`${label}.sha256 must look like a 64-character hex SHA256`);
  }
  if (isNonEmptyString(item.downloadDate) && !isValidIsoDate(item.downloadDate)) {
    fail(`${label}.downloadDate must be a valid YYYY-MM-DD date`);
  }
  if (isNonEmptyString(item.sourceUrl) && !looksLikeSourceUrl(item.sourceUrl)) {
    fail(`${label}.sourceUrl must be an http(s), doi:, or local: URI`);
  }

  return item.category || null;
}

function checkProvenance(mode) {
  const provenanceExists = fs.existsSync(PROVENANCE_PATH);

  if (!provenanceExists) {
    if (mode === MODES.FULL_BAKE) {
      fail(`provenance.json is required for full-bake validation at ${relativeToCwd(PROVENANCE_PATH)}`);
    } else {
      warn(`provenance.json is optional in sample mode; use ${relativeToCwd(PROVENANCE_SAMPLE_PATH)} as a template, not as full-bake evidence`);
    }
    return;
  }

  const provenance = readJson(PROVENANCE_PATH);
  if (!provenance) return;
  if (!isPlainObject(provenance)) {
    fail("provenance.json must be a JSON object");
    return;
  }

  if (mode === MODES.FULL_BAKE && provenance.sample === true) {
    fail("provenance.json must not be marked sample:true in full-bake mode");
  }
  if (mode === MODES.FULL_BAKE && provenance.draft === true) {
    fail("provenance.json must not be marked draft:true in full-bake mode");
  }
  if (mode === MODES.FULL_BAKE && provenance.mustNotSatisfyFullBake === true) {
    fail("provenance.json must not carry mustNotSatisfyFullBake:true in full-bake mode");
  }
  if (
    mode === MODES.FULL_BAKE &&
    typeof provenance.schemaVersion === "string" &&
    provenance.schemaVersion.startsWith("provenance-draft/")
  ) {
    fail("provenance.schemaVersion must not use a provenance-draft schema in full-bake mode");
  }
  if (!isNonEmptyString(provenance.schemaVersion)) {
    fail("provenance.schemaVersion must be a non-empty string");
  }
  if (!Array.isArray(provenance.items)) {
    fail("provenance.items must be an array");
    return;
  }
  if (provenance.items.length === 0) {
    fail("provenance.items must include at least one source record");
    return;
  }

  const seenCategories = new Set();
  provenance.items.forEach((item, index) => {
    const category = checkProvenanceItem(item, index);
    if (category) seenCategories.add(category);
  });

  const missingCategories = REQUIRED_PROVENANCE_CATEGORIES.filter((category) => !seenCategories.has(category));
  if (missingCategories.length > 0) {
    const message = `provenance.items must cover required categories: missing ${missingCategories.join(", ")}`;
    if (mode === MODES.FULL_BAKE) fail(message);
    else warn(message);
  } else {
    ok(`provenance covers required categories (${REQUIRED_PROVENANCE_CATEGORIES.join(", ")})`);
  }

  ok(`provenance.json structure checked (${provenance.items.length} item(s)); manual source review is still required before full-bake acceptance`);
}

function checkFileSizes() {
  const files = [ATTRS_PATH, SUBBASINS_PATH, RIVERS_PATH];
  const total = files.reduce((sum, filePath) => sum + fs.statSync(filePath).size, 0);
  for (const filePath of files) {
    ok(`${path.basename(filePath)} size ${fs.statSync(filePath).size} bytes`);
  }
  if (total <= SIZE_TARGET_BYTES) {
    ok(`combined data size ${total} bytes is under 3 MB target`);
  } else {
    warn(`combined data size ${total} bytes exceeds 3 MB target`);
  }
}

function main() {
  const mode = parseArgs(process.argv.slice(2));
  ok(`validation mode: ${mode}`);

  const attrs = readJson(ATTRS_PATH);
  const subbasinsGeojson = readJson(SUBBASINS_PATH);
  const riversGeojson = readJson(RIVERS_PATH);
  if (!attrs || !subbasinsGeojson || !riversGeojson) process.exit(1);

  checkNoInvalidNumbers("wuhan-attrs.json", attrs);
  checkNoInvalidNumbers("wuhan-subbasins.geojson", subbasinsGeojson);
  checkNoInvalidNumbers("wuhan-rivers.geojson", riversGeojson);
  checkMetaHonesty(attrs, mode);
  checkProvenance(mode);

  const attrIds = checkIdAlignment(attrs, subbasinsGeojson);
  const count = attrIds.size;
  checkSubbasinCount(count, mode);

  checkTopology(attrs, attrIds);
  const computedTotals = checkSubbasinRecords(attrs, mode);
  checkNameSubbasinLabels(attrs, mode);
  checkPre1ExternalInflow(attrs, mode);
  checkSectorTotals(attrs, computedTotals, mode);
  checkGeojsonBbox("wuhan-subbasins.geojson", subbasinsGeojson);
  checkGeojsonBbox("wuhan-rivers.geojson", riversGeojson);
  checkRivers(riversGeojson, attrIds, mode);
  checkFileSizes();

  if (failures > 0) {
    console.error(`\nValidation failed with ${failures} failure(s) and ${warnings} warning(s).`);
    process.exit(1);
  }
  console.log(`\nValidation passed with ${warnings} warning(s).`);
}

main();
