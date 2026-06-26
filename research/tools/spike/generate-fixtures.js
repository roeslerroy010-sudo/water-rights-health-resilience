const fs = require("fs");
const path = require("path");

const SIZES = [30, 50, 80];
const BASE_SEED = 20260201;
const SECTORS = ["urban", "eco", "agri", "industry"];
const FIXTURE_DIR = path.join(__dirname, "fixtures");

function createRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function round(value, digits = 3) {
  const factor = Math.pow(10, digits);
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function nodeId(index) {
  return "SB" + String(index + 1).padStart(3, "0");
}

function chooseDownstream(index, nodeCount, rng) {
  if (index === nodeCount - 1) return "OUTLET";

  const remaining = nodeCount - index - 1;
  const maxJump = Math.min(remaining, index % 9 === 0 ? 5 : index % 5 === 0 ? 4 : 3);
  const jump = 1 + Math.floor(rng() * maxJump);
  return nodeId(index + jump);
}

function generateSyntheticNetwork(nodeCount, options = {}) {
  if (!Number.isInteger(nodeCount) || nodeCount < 2) {
    throw new Error("generateSyntheticNetwork requires an integer nodeCount >= 2");
  }

  const seed = options.seed || BASE_SEED + nodeCount;
  const rng = createRng(seed);
  const topology = {};
  const subbasins = [];

  for (let i = 0; i < nodeCount; i += 1) {
    const id = nodeId(i);
    const downstream = chooseDownstream(i, nodeCount, rng);
    topology[id] = downstream;

    const downstreamFactor = i / Math.max(1, nodeCount - 1);
    const basinBand = i % 8;
    const areaKm2 = round(82 + rng() * 54 + downstreamFactor * 58, 2);
    const population = Math.round(18000 + downstreamFactor * 188000 + rng() * 42000 + (basinBand === 6 ? 65000 : 0));
    const irrigationIntensity = basinBand <= 2 ? 1.35 : basinBand === 3 ? 1.08 : 0.72;
    const industryIntensity = basinBand === 5 || basinBand === 6 ? 1.55 : basinBand === 7 ? 1.2 : 0.82;
    const ecoIntensity = i % 11 === 0 || i === nodeCount - 1 ? 1.45 : 1;

    const demand = {
      urban: round(5.5 + population / 19000 + rng() * 4.2, 3),
      eco: round((4.2 + areaKm2 * 0.038 + rng() * 2.2) * ecoIntensity, 3),
      agri: round((10 + areaKm2 * 0.16 + rng() * 7.5) * irrigationIntensity, 3),
      industry: round((5.2 + population / 42000 + rng() * 5.5) * industryIntensity, 3),
    };

    const headwaterBoost = i < Math.max(3, Math.floor(nodeCount * 0.08)) ? 15 + rng() * 18 : 0;
    const localSupply = round(32 + areaKm2 * 0.19 + rng() * 13 + headwaterBoost, 3);
    const transitInjection = i === 0 || i === Math.floor(nodeCount * 0.33) || i === Math.floor(nodeCount * 0.66)
      ? round(28 + nodeCount * 0.72 + rng() * 18, 3)
      : 0;

    subbasins.push({
      id,
      name: "Synthetic phase2a subbasin " + (i + 1),
      areaKm2,
      population,
      demand,
      supply: {
        qLocal: localSupply,
        externalInflow: transitInjection,
        transitInjection,
      },
      transitInjection,
      healthWeight: {
        urban: 1,
        eco: 0.7,
        agri: 0.1,
        industry: -0.25,
      },
      sectorValue: {
        urban: round(3.05 + downstreamFactor * 0.35, 3),
        eco: round(2.15 + ecoIntensity * 0.18, 3),
        agri: round(1.02 + irrigationIntensity * 0.12, 3),
        industry: round(1.34 + industryIntensity * 0.16, 3),
      },
      complianceCost: {
        urban: round(0.22 + rng() * 0.06, 3),
        eco: round(0.05 + rng() * 0.05, 3),
        agri: round(0.13 + rng() * 0.08, 3),
        industry: round(0.42 + industryIntensity * 0.08 + rng() * 0.11, 3),
      },
    });
  }

  return {
    meta: {
      region: "synthetic-phase2a-spike",
      fixture: "phase2a-synthetic-" + nodeCount,
      generatedBy: "research/tools/spike/generate-fixtures.js",
      generatedAt: "deterministic",
      seed,
      synthetic: true,
      nodeCount,
      topology: "branching-hydrologic-dag",
      sectors: SECTORS,
      units: {
        demand: "million m3/year",
        supply: "million m3/year",
        transitInjection: "million m3/year",
      },
    },
    topology,
    subbasins,
  };
}

function writeFixtures(options = {}) {
  const outDir = options.outDir || FIXTURE_DIR;
  fs.mkdirSync(outDir, { recursive: true });

  return SIZES.map((size) => {
    const fixture = generateSyntheticNetwork(size);
    const filePath = path.join(outDir, "synthetic-" + size + ".json");
    fs.writeFileSync(filePath, JSON.stringify(fixture, null, 2) + "\n");
    return filePath;
  });
}

if (require.main === module) {
  const files = writeFixtures();
  for (const file of files) {
    console.log(file);
  }
}

module.exports = {
  BASE_SEED,
  SIZES,
  FIXTURE_DIR,
  generateSyntheticNetwork,
  writeFixtures,
};
