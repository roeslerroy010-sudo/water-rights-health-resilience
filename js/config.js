// config.js — All data and scenario parameters for the water rights simulator
// ACTION Hackathon — Theme 4: Water-related technologies for climate and health adaptation

// ---- Parameter defaults ----
const DEFAULT_PARAMS = {
  healthTaxRate: 0.15,        // τ: 0 to 0.50
  climateScenario: 'ssp245',  // 'ssp245' | 'ssp585'
  healthFloor: 0.25,          // fraction of total water reserved for health-priority users
  tradingCost: 'medium',      // 'low' | 'medium' | 'high'
};

// ---- Climate scenarios: water availability shock ----
const CLIMATE_SCENARIOS = {
  ssp245: {
    label: 'SSP2-4.5 (Moderate)',
    waterAvailability: 1.0,      // baseline
    droughtFrequency: 0.15,
    floodFrequency: 0.10,
    description: 'Moderate emissions pathway. Peak warming ~2.5°C by 2100.',
  },
  ssp585: {
    label: 'SSP5-8.5 (High Emission)',
    waterAvailability: 0.72,     // 28% less water
    droughtFrequency: 0.35,
    floodFrequency: 0.20,
    description: 'Fossil-fueled development. Peak warming ~4.4°C by 2100.',
  },
};

// ---- Trading cost multipliers ----
const TRADING_COSTS = {
  low:    { label: 'Low', multiplier: 0.95, description: 'Efficient market with minimal friction' },
  medium: { label: 'Medium', multiplier: 0.85, description: 'Typical transaction costs' },
  high:   { label: 'High', multiplier: 0.70, description: 'Significant regulatory and search costs' },
};

// ---- Mock watershed: 6 water user nodes (Middle Yangtze demonstration) ----
const WATER_USERS = [
  { id: 'muni',   name: 'Municipal Water',       lat: 30.55, lng: 114.30, type: 'health',   allocation: 40, healthWeight: 1.0,  popServed: 3500000 },
  { id: 'agri1',  name: 'Agriculture (Upstream)',  lat: 30.70, lng: 114.10, type: 'agri',    allocation: 25, healthWeight: 0.1,  popServed: 0 },
  { id: 'agri2',  name: 'Agriculture (Downstream)', lat: 30.35, lng: 114.50, type: 'agri',    allocation: 20, healthWeight: 0.1,  popServed: 0 },
  { id: 'ind1',   name: 'Industry (Chemical)',     lat: 30.60, lng: 114.45, type: 'industry', allocation: 10, healthWeight: -0.3, popServed: 0 },
  { id: 'ind2',   name: 'Industry (Textile)',      lat: 30.45, lng: 114.20, type: 'industry', allocation: 5,  healthWeight: -0.15, popServed: 0 },
  { id: 'hydro',  name: 'Hydropower',              lat: 30.80, lng: 114.15, type: 'energy',   allocation: 0,  healthWeight: 0.0,  popServed: 0 },
];

// ---- Health loss coefficients by water use type ----
const HEALTH_LOSS_COEFF = {
  health:    0.0,   // no health loss from health-priority use
  agri:      0.25,  // agricultural runoff (nutrients, pesticides)
  industry:  0.60,  // industrial pollution (chemicals, heavy metals)
  energy:    0.05,  // minor thermal pollution
};

// ---- Water-health dose-response parameters ----
const DOSE_RESPONSE = {
  baselineDALY: 45,       // DALY per 100k population, baseline water-borne disease burden
  elasticity: 0.8,        // % change in DALY per % change in water quality
  valuePerDALY: 185000,   // RMB per DALY (WHO guideline for cost-effectiveness)
};

// ---- Basin metadata (Middle Yangtze, demonstration) ----
const BASIN_INFO = {
  name: 'Middle Yangtze Basin (Demonstration)',
  totalWater: 5800,           // million m³/year total water resource
  ecologicalBaseFlow: 1740,   // 30% reserved for ecosystem
  tradableWater: 4060,        // totalWater - ecologicalBaseFlow
  population: 8500000,        // basin population
  area: 68000,               // km²
  annualRainfall: 1200,      // mm/year
};

// ---- Pre-computed lookup: τ × H_loss × DALY for each user type ----
function buildLookupTable() {
  const table = {};
  const tauValues = [0, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50];
  WATER_USERS.forEach(user => {
    const hLoss = HEALTH_LOSS_COEFF[user.type] ?? 0.25;
    table[user.id] = tauValues.map(tau => ({
      tau,
      healthTax: Math.round(tau * hLoss * DOSE_RESPONSE.baselineDALY / 100 * 1000) / 1000,
    }));
  });
  return table;
}

// ---- Type display configuration ----
const TYPE_CONFIG = {
  health:   { color: '#16a34a', label: 'Health Priority', icon: '💧' },
  agri:     { color: '#d97706', label: 'Agriculture',     icon: '🌾' },
  industry: { color: '#dc2626', label: 'Industry',         icon: '🏭' },
  energy:   { color: '#6366f1', label: 'Energy',           icon: '⚡' },
};

// ---- Chart color palette ----
const CHART_COLORS = {
  withMarket:    { bg: '#16a34a', border: '#15803d' },
  withoutMarket: { bg: '#94a3b8', border: '#64748b' },
  healthTax:     { bg: '#2563eb', border: '#1d4ed8' },
  disease:       { bg: '#d97706', border: '#b45309' },
};
