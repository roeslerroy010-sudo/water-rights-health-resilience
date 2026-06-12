# Water Rights Trading for Health Resilience — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an interactive single-page web tool (water rights market simulator + health dashboard) + 12-slide PPT, deployed to GitHub Pages, by June 16.

**Architecture:** Pure static frontend — no backend, no framework. Data layer (JSON config) → Model layer (JS computation with pre-computed lookup tables) → Three UI panels (parameters, map, dashboard) wired by a thin controller. PPT built separately with pptx skill.

**Tech Stack:** HTML5, CSS3, Vanilla JS (ES6), Leaflet (CDN), Chart.js (CDN), GitHub Pages

---

## File Structure

```
hackathon/
├── index.html              # Single-page app shell
├── css/
│   └── style.css           # All styles
├── js/
│   ├── config.js           # Data: parameters, scenarios, mock watershed data, lookup tables
│   ├── model.js            # Computation: market equilibrium, health impact, incentive check
│   ├── map.js              # Leaflet map: render watershed, user nodes, trade flows
│   ├── dashboard.js        # Charts + metrics panel
│   └── main.js             # Controller: wire sliders → model → UI updates
├── images/                 # Nature/water photos for visual polish
├── data/                   # Optional: source data files
├── ppt/
│   └── action-pitch.pptx   # Final presentation
└── docs/
    └── superpowers/
        ├── specs/          # Design spec
        └── plans/          # This plan
```

---

### Task 1: Project Scaffolding + HTML Shell

**Files:**
- Create: `index.html`
- Create: `css/style.css`
- Create: `js/config.js`, `js/model.js`, `js/map.js`, `js/dashboard.js`, `js/main.js`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p css js images data ppt
```

- [ ] **Step 2: Write index.html shell — three-column layout, CDN links, script includes**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Water Rights Trading for Health Resilience | ACTION Hackathon</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <link rel="stylesheet" href="css/style.css">
</head>
<body>
  <div id="app">
    <header id="header">
      <h1>Water Rights Trading for Health Resilience</h1>
      <p class="subtitle">An interactive decision-support tool for health-prioritized water markets</p>
    </header>
    <main id="main">
      <aside id="panel-left">
        <h2>Parameters</h2>
        <div id="controls"></div>
      </aside>
      <section id="panel-center">
        <div id="map"></div>
        <div id="map-stats"></div>
      </section>
      <aside id="panel-right">
        <h2>Health Dashboard</h2>
        <div id="dashboard"></div>
      </aside>
    </main>
  </div>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <script src="js/config.js"></script>
  <script src="js/model.js"></script>
  <script src="js/map.js"></script>
  <script src="js/dashboard.js"></script>
  <script src="js/main.js"></script>
</body>
</html>
```

- [ ] **Step 3: Write minimal style.css — CSS variables, three-column grid**

```css
:root {
  --color-primary: #1a6b8a;
  --color-health: #16a34a;
  --color-warning: #d97706;
  --color-danger: #dc2626;
  --color-bg: #f5f7fa;
  --color-surface: #ffffff;
  --color-text: #1e293b;
  --color-muted: #64748b;
  --radius: 8px;
  --shadow: 0 1px 3px rgba(0,0,0,0.1);
  --transition: 0.3s ease;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  background: var(--color-bg);
  color: var(--color-text);
  line-height: 1.5;
}

#header {
  padding: 16px 24px;
  background: linear-gradient(135deg, #0c4a6e 0%, #1a6b8a 50%, #0e7490 100%);
  color: white;
}
#header h1 { font-size: 1.4rem; font-weight: 600; }
#header .subtitle { font-size: 0.85rem; opacity: 0.85; margin-top: 4px; }

#main {
  display: grid;
  grid-template-columns: 260px 1fr 280px;
  height: calc(100vh - 72px);
  gap: 0;
}

#panel-left {
  background: var(--color-surface);
  border-right: 1px solid #e2e8f0;
  padding: 16px;
  overflow-y: auto;
}
#panel-left h2 { font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-muted); margin-bottom: 16px; }

#panel-center { position: relative; }
#map { height: 65%; }
#map-stats { height: 35%; padding: 12px 16px; background: var(--color-surface); border-top: 1px solid #e2e8f0; display: flex; gap: 16px; align-items: center; }

#panel-right {
  background: var(--color-surface);
  border-left: 1px solid #e2e8f0;
  padding: 16px;
  overflow-y: auto;
}
#panel-right h2 { font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-muted); margin-bottom: 16px; }
```

- [ ] **Step 4: Verify — open index.html in browser, confirm three-column layout renders**

```bash
open index.html
```

Expected: Empty three-column layout with dark header, no console errors.

---

### Task 2: Data Layer (config.js)

**Files:**
- Create: `js/config.js`

- [ ] **Step 1: Write config.js — parameter defaults, watershed mock data, climate scenarios, lookup tables**

```javascript
// config.js — All data and scenario parameters for the water rights simulator

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
  },
  ssp585: {
    label: 'SSP5-8.5 (High Emission)',
    waterAvailability: 0.72,     // 28% less water
    droughtFrequency: 0.35,
    floodFrequency: 0.20,
  },
};

// ---- Trading cost multipliers ----
const TRADING_COSTS = {
  low:    { label: 'Low', multiplier: 0.95 },
  medium: { label: 'Medium', multiplier: 0.85 },
  high:   { label: 'High', multiplier: 0.70 },
};

// ---- Mock watershed: 6 water user nodes ----
const WATER_USERS = [
  { id: 'muni',   name: 'Municipal Water',      lat: 30.55, lng: 114.30, type: 'health',  allocation: 40, healthWeight: 1.0 },
  { id: 'agri1',  name: 'Agriculture (Upstream)', lat: 30.70, lng: 114.10, type: 'agri',   allocation: 25, healthWeight: 0.1 },
  { id: 'agri2',  name: 'Agriculture (Downstream)', lat: 30.35, lng: 114.50, type: 'agri', allocation: 20, healthWeight: 0.1 },
  { id: 'ind1',   name: 'Industry (Chemical)',  lat: 30.60, lng: 114.45, type: 'industry', allocation: 10, healthWeight: -0.3 },
  { id: 'ind2',   name: 'Industry (Textile)',   lat: 30.45, lng: 114.20, type: 'industry', allocation: 5,  healthWeight: -0.15 },
  { id: 'hydro',  name: 'Hydropower',            lat: 30.80, lng: 114.15, type: 'energy',  allocation: 0,  healthWeight: 0.0 },
];

// ---- Health loss coefficients by water use type ----
const HEALTH_LOSS_COEFF = {
  health:    0.0,   // no health loss from health-priority use
  agri:      0.25,  // agricultural runoff
  industry:  0.60,  // industrial pollution
  energy:    0.05,  // minor thermal pollution
};

// ---- Water-health dose-response: DALY per million m³ degraded ----
const DOSE_RESPONSE = {
  baselineDALY: 45,       // DALY per 100k people, baseline water-borne disease burden
  elasticity: 0.8,        // % change DALY per % change water quality
};

// ---- Pre-computed lookup table: τ × H_loss × DALY for each user type ----
// Generated at init time by model.js
function buildLookupTable() {
  const table = {};
  const tauValues = [0, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50];
  WATER_USERS.forEach(user => {
    const hLoss = HEALTH_LOSS_COEFF[user.type] || 0.25;
    table[user.id] = tauValues.map(tau => ({
      tau,
      healthTax: tau * hLoss * DOSE_RESPONSE.baselineDALY / 100,
    }));
  });
  return table;
}

// ---- Basin metadata ----
const BASIN_INFO = {
  name: 'Middle Yangtze Basin (Demonstration)',
  totalWater: 5800,           // million m³/year
  ecologicalBaseFlow: 1740,   // 30% reserved for ecology
  tradableWater: 4060,        // totalWater - ecologicalBaseFlow
  population: 8500000,
};
```

- [ ] **Step 2: Verify — load in browser console, check objects exist**

Open index.html → DevTools Console:
```javascript
console.log(DEFAULT_PARAMS);
console.log(WATER_USERS);
console.log(CLIMATE_SCENARIOS);
```
Expected: All objects defined, no errors.

---

### Task 3: Model Layer (model.js)

**Files:**
- Create: `js/model.js`

- [ ] **Step 1: Write model.js — market simulation, health impact calculation, incentive check**

```javascript
// model.js — Core computation engine for the water rights market simulator

// Compute effective water availability after climate shock and trading friction
function computeEffectiveWater(params) {
  const climate = CLIMATE_SCENARIOS[params.climateScenario];
  const trading = TRADING_COSTS[params.tradingCost];
  const available = BASIN_INFO.tradableWater * climate.waterAvailability;
  return {
    total: available,
    healthReserved: available * params.healthFloor,
    tradable: available * (1 - params.healthFloor) * trading.multiplier,
  };
}

// Compute market-clearing price per m³
function computeMarketPrice(water) {
  // Simple linear demand: price = basePrice * (1 - utilization)
  const utilization = water.tradable / BASIN_INFO.tradableWater;
  const basePrice = 0.35; // RMB/m³ baseline
  const scarcityPremium = Math.max(0, 1 - utilization) * 0.5;
  return basePrice + scarcityPremium;
}

// Compute health tax for a specific water user
function computeHealthTax(user, params) {
  const hLoss = HEALTH_LOSS_COEFF[user.type] || 0.25;
  return params.healthTaxRate * hLoss * DOSE_RESPONSE.baselineDALY / 100;
}

// Full simulation: run the model for given params
function runSimulation(params) {
  const water = computeEffectiveWater(params);
  const marketPrice = computeMarketPrice(water);

  // Per-user results
  const userResults = WATER_USERS.map(user => {
    const healthTax = computeHealthTax(user, params);
    const effectiveAllocation = user.type === 'health'
      ? user.allocation / 100 * water.total   // health users get priority
      : (user.allocation / 100 * water.tradable);

    const healthImpact = user.healthWeight * effectiveAllocation * (1 - params.healthTaxRate * HEALTH_LOSS_COEFF[user.type]);
    const tradePrice = marketPrice + healthTax;

    return {
      ...user,
      healthTax,
      effectiveAllocation,
      healthImpact,
      tradePrice,
      totalCost: effectiveAllocation * tradePrice,
    };
  });

  // Aggregate health metrics
  const totalHealthImpact = userResults.reduce((sum, u) => sum + Math.max(0, u.healthImpact), 0);
  const baselineDALY = DOSE_RESPONSE.baselineDALY * BASIN_INFO.population / 100000;
  const dalyAvoided = baselineDALY * (totalHealthImpact / (WATER_USERS.length * 25));
  const diseaseReduction = Math.min(0.35, params.healthTaxRate * 0.8 + params.healthFloor * 0.4);
  const economicNPV = dalyAvoided * 185000; // RMB per DALY (WHO guideline)

  // Incentive compatibility check
  const incentiveCompatible = userResults.every(u => {
    if (u.type === 'health') return true;
    return u.totalCost <= u.effectiveAllocation * marketPrice * 1.3; // 30% tolerance
  });
  const violatingUsers = incentiveCompatible ? [] : userResults.filter(u => {
    if (u.type === 'health') return false;
    return u.totalCost > u.effectiveAllocation * marketPrice * 1.3;
  }).map(u => u.name);

  return {
    water,
    marketPrice,
    userResults,
    health: {
      totalHealthImpact,
      baselineDALY,
      dalyAvoided: Math.round(dalyAvoided),
      diseaseReduction: Math.round(diseaseReduction * 1000) / 10, // percentage
      economicNPV: Math.round(economicNPV / 10000) / 100,  // in 100M RMB
      healthQuotaGap: Math.round(water.healthReserved - userResults
        .filter(u => u.type === 'health')
        .reduce((s, u) => s + u.effectiveAllocation, 0)),
    },
    incentive: {
      compatible: incentiveCompatible,
      violatingUsers,
    },
  };
}

// Get comparison: with-market vs without-market
function runComparison(params) {
  const withMarket = runSimulation(params);
  const noMarketParams = { ...params, healthTaxRate: 0, healthFloor: 0, tradingCost: 'high' };
  const withoutMarket = runSimulation(noMarketParams);
  return { withMarket, withoutMarket };
}
```

- [ ] **Step 2: Verify — run simulation in console**

Open index.html → DevTools Console:
```javascript
const result = runSimulation(DEFAULT_PARAMS);
console.log(result.health);
console.log(result.incentive);
```
Expected: Health metrics object with dalyAvoided > 0, incentive object with compatible boolean.

---

### Task 4: Parameter Panel UI

**Files:**
- Create: (code goes in `js/main.js`)
- Modify: `index.html` → `#controls` div

- [ ] **Step 1: Write parameter panel HTML generation in main.js**

```javascript
// main.js — part 1: build controls

function buildControls() {
  const container = document.getElementById('controls');

  // Health tax rate slider
  const tauGroup = document.createElement('div');
  tauGroup.className = 'control-group';
  tauGroup.innerHTML = `
    <label for="tau-slider">
      <span>Health Tax Rate (τ)</span>
      <span class="value" id="tau-value">${Math.round(DEFAULT_PARAMS.healthTaxRate * 100)}%</span>
    </label>
    <input type="range" id="tau-slider" min="0" max="50" value="${DEFAULT_PARAMS.healthTaxRate * 100}" step="1">
    <p class="hint">Pigouvian tax on health-damaging water use</p>
  `;

  // Climate scenario
  const climateGroup = document.createElement('div');
  climateGroup.className = 'control-group';
  climateGroup.innerHTML = `
    <label for="climate-select">Climate Scenario</label>
    <select id="climate-select">
      <option value="ssp245" ${DEFAULT_PARAMS.climateScenario === 'ssp245' ? 'selected' : ''}>SSP2-4.5 (Moderate)</option>
      <option value="ssp585" ${DEFAULT_PARAMS.climateScenario === 'ssp585' ? 'selected' : ''}>SSP5-8.5 (High Emission)</option>
    </select>
    <p class="hint">Future climate pathway</p>
  `;

  // Health floor
  const floorGroup = document.createElement('div');
  floorGroup.className = 'control-group';
  floorGroup.innerHTML = `
    <label for="floor-slider">
      <span>Health Priority Quota</span>
      <span class="value" id="floor-value">${Math.round(DEFAULT_PARAMS.healthFloor * 100)}%</span>
    </label>
    <input type="range" id="floor-slider" min="10" max="40" value="${DEFAULT_PARAMS.healthFloor * 100}" step="1">
    <p class="hint">Minimum allocation reserved for health users</p>
  `;

  // Trading cost
  const costGroup = document.createElement('div');
  costGroup.className = 'control-group';
  costGroup.innerHTML = `
    <label for="cost-select">Trading Cost</label>
    <select id="cost-select">
      <option value="low" ${DEFAULT_PARAMS.tradingCost === 'low' ? 'selected' : ''}>Low</option>
      <option value="medium" ${DEFAULT_PARAMS.tradingCost === 'medium' ? 'selected' : ''}>Medium</option>
      <option value="high" ${DEFAULT_PARAMS.tradingCost === 'high' ? 'selected' : ''}>High</option>
    </select>
    <p class="hint">Transaction friction in the market</p>
  `;

  // Run button
  const runBtn = document.createElement('button');
  runBtn.id = 'run-btn';
  runBtn.className = 'btn-primary';
  runBtn.textContent = 'Run Simulation';
  runBtn.addEventListener('click', handleRun);

  container.append(tauGroup, climateGroup, floorGroup, costGroup, runBtn);
}

function getCurrentParams() {
  return {
    healthTaxRate: parseInt(document.getElementById('tau-slider').value) / 100,
    climateScenario: document.getElementById('climate-select').value,
    healthFloor: parseInt(document.getElementById('floor-slider').value) / 100,
    tradingCost: document.getElementById('cost-select').value,
  };
}
```

- [ ] **Step 2: Write CSS for controls in style.css**

```css
.control-group {
  margin-bottom: 20px;
}
.control-group label {
  display: flex;
  justify-content: space-between;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--color-text);
  margin-bottom: 6px;
}
.control-group .value {
  color: var(--color-primary);
  font-weight: 700;
}
.control-group input[type="range"] {
  width: 100%;
  accent-color: var(--color-primary);
}
.control-group select {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid #cbd5e1;
  border-radius: var(--radius);
  font-size: 0.85rem;
  background: white;
}
.control-group .hint {
  font-size: 0.7rem;
  color: var(--color-muted);
  margin-top: 4px;
}

.btn-primary {
  width: 100%;
  padding: 10px;
  background: linear-gradient(135deg, var(--color-primary), #0e7490);
  color: white;
  border: none;
  border-radius: var(--radius);
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  transition: transform var(--transition), box-shadow var(--transition);
}
.btn-primary:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(26, 107, 138, 0.4);
}
.btn-primary:active { transform: translateY(0); }
```

- [ ] **Step 3: Add init call — append to main.js**

```javascript
// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  buildControls();
  handleRun(); // Run with defaults on load
});
```

- [ ] **Step 4: Verify — open index.html, check controls render**

Expected: Four controls visible in left panel, Run Simulation button at bottom, clicking it prints result to console.

---

### Task 5: Map Visualization

**Files:**
- Create: `js/map.js`

- [ ] **Step 1: Write map.js — Leaflet initialization and user node rendering**

```javascript
// map.js — Leaflet-based watershed map visualization

let map;
let userMarkers = [];
let tradeFlowLines = [];

function initMap() {
  map = L.map('map').setView([30.55, 114.30], 10);

  // CartoDB Voyager tile layer (no API key needed, water-toned)
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
    maxZoom: 18,
  }).addTo(map);
}

function renderUserNodes(simulationResult) {
  // Clear existing markers
  userMarkers.forEach(m => map.removeLayer(m));
  userMarkers = [];

  const typeColors = {
    health: '#16a34a',
    agri: '#d97706',
    industry: '#dc2626',
    energy: '#6366f1',
  };

  simulationResult.userResults.forEach(user => {
    const color = typeColors[user.type] || '#64748b';
    const size = Math.max(12, Math.min(28, user.effectiveAllocation / 150 * 28));

    const icon = L.divIcon({
      className: 'water-node',
      html: `<div style="
        width:${size}px;height:${size}px;
        background:${color};
        border:2px solid white;
        border-radius:50%;
        box-shadow:0 2px 8px rgba(0,0,0,0.3);
        display:flex;align-items:center;justify-content:center;
        color:white;font-size:10px;font-weight:700;
      ">${user.name[0]}</div>`,
      iconSize: [size, size],
      iconAnchor: [size/2, size/2],
    });

    const marker = L.marker([user.lat, user.lng], { icon })
      .bindPopup(`
        <strong>${user.name}</strong><br>
        Type: ${user.type}<br>
        Allocation: ${Math.round(user.effectiveAllocation)}M m³<br>
        Health Tax: ¥${user.healthTax.toFixed(2)}/m³
      `)
      .addTo(map);
    userMarkers.push(marker);
  });
}

function renderTradeFlows(simulationResult) {
  // Clear existing flow lines
  tradeFlowLines.forEach(l => map.removeLayer(l));
  tradeFlowLines = [];

  // Draw lines from non-health users to health users
  const healthUsers = simulationResult.userResults.filter(u => u.type === 'health');
  const otherUsers = simulationResult.userResults.filter(u => u.type !== 'health');

  otherUsers.forEach(source => {
    healthUsers.forEach(target => {
      const flow = Math.min(source.effectiveAllocation * 0.2, target.effectiveAllocation * 0.3);
      if (flow < 1) return;

      const latlngs = [[source.lat, source.lng], [target.lat, target.lng]];
      const line = L.polyline(latlngs, {
        color: source.healthTax > 0.1 ? '#dc2626' : '#94a3b8',
        weight: Math.max(1, flow / 20),
        opacity: 0.5,
        dashArray: '5, 8',
      }).addTo(map);
      tradeFlowLines.push(line);
    });
  });
}
```

- [ ] **Step 2: Write CSS for map stats bar in style.css**

```css
#map-stats .stat-card {
  flex: 1;
  text-align: center;
  padding: 8px;
  background: #f8fafc;
  border-radius: var(--radius);
}
#map-stats .stat-card .stat-value {
  font-size: 1.2rem;
  font-weight: 700;
  color: var(--color-primary);
}
#map-stats .stat-card .stat-label {
  font-size: 0.7rem;
  color: var(--color-muted);
  text-transform: uppercase;
}
```

- [ ] **Step 3: Write update function — append to map.js**

```javascript
function updateMap(simulationResult) {
  renderUserNodes(simulationResult);
  renderTradeFlows(simulationResult);

  // Update stats bar
  document.getElementById('map-stats').innerHTML = `
    <div class="stat-card">
      <div class="stat-value">¥${simulationResult.marketPrice.toFixed(2)}</div>
      <div class="stat-label">Market Price /m³</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${Math.round(simulationResult.water.tradable)}M</div>
      <div class="stat-label">Tradable Water (m³)</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${simulationResult.userResults.length}</div>
      <div class="stat-label">Active Users</div>
    </div>
  `;
}
```

- [ ] **Step 4: Verify — open index.html, run simulation, check map renders nodes**

Expected: 6 colored circles on the Leaflet map, trade flow dashed lines, stats bar with market price.

---

### Task 6: Dashboard UI

**Files:**
- Create: `js/dashboard.js`

- [ ] **Step 1: Write dashboard.js — health metrics and incentive status**

```javascript
// dashboard.js — Health dashboard with metrics cards + Chart.js bar chart

let healthChart;

function updateDashboard(simulationResult) {
  const h = simulationResult.health;
  const incentive = simulationResult.incentive;

  const dashboard = document.getElementById('dashboard');
  dashboard.innerHTML = `
    <div class="metric-card health">
      <div class="metric-label">DALY Avoided</div>
      <div class="metric-value">${h.dalyAvoided.toLocaleString()}</div>
      <div class="metric-delta">vs no-market baseline</div>
    </div>
    <div class="metric-card disease">
      <div class="metric-label">Water-borne Disease</div>
      <div class="metric-value">-${h.diseaseReduction}%</div>
      <div class="metric-delta">reduction in incidence</div>
    </div>
    <div class="metric-card economic">
      <div class="metric-label">Economic NPV</div>
      <div class="metric-value">¥${h.economicNPV}亿</div>
      <div class="metric-delta">health benefit monetized</div>
    </div>
    <div class="metric-card gap">
      <div class="metric-label">Health Quota Gap</div>
      <div class="metric-value">${Math.abs(h.healthQuotaGap).toLocaleString()}M m³</div>
      <div class="metric-delta">${h.healthQuotaGap > 0 ? 'surplus' : 'shortfall'}</div>
    </div>
    <div class="incentive-status ${incentive.compatible ? 'compatible' : 'violated'}">
      <span>${incentive.compatible ? '✓ Incentive Compatible' : '⚠ Violation: ' + incentive.violatingUsers.join(', ')}</span>
    </div>
    <div style="margin-top:16px;">
      <canvas id="comparison-chart" width="240" height="180"></canvas>
    </div>
  `;

  drawComparisonChart(simulationResult);
}

function drawComparisonChart(simulationResult) {
  const canvas = document.getElementById('comparison-chart');
  if (!canvas) return;

  const withM = simulationResult.withMarket || simulationResult;
  const withoutM = simulationResult.withoutMarket ||
    runSimulation({ healthTaxRate: 0, healthFloor: 0, tradingCost: 'high', climateScenario: DEFAULT_PARAMS.climateScenario });

  if (healthChart) healthChart.destroy();

  healthChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: ['DALY Avoided', 'Disease Reduction %', 'Econ NPV (100M ¥)'],
      datasets: [
        {
          label: 'With Market',
          data: [withM.health.dalyAvoided, withM.health.diseaseReduction, withM.health.economicNPV],
          backgroundColor: '#16a34a',
          borderRadius: 4,
        },
        {
          label: 'Without Market',
          data: [withoutM.health.dalyAvoided, withoutM.health.diseaseReduction, withoutM.health.economicNPV],
          backgroundColor: '#94a3b8',
          borderRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { boxWidth: 12, font: { size: 10 } } } },
      scales: { y: { beginAtZero: true, ticks: { font: { size: 9 } } }, x: { ticks: { font: { size: 9 } } } },
    },
  });
}
```

- [ ] **Step 2: Write CSS for dashboard cards in style.css**

```css
.metric-card {
  padding: 12px;
  border-radius: var(--radius);
  margin-bottom: 10px;
  border-left: 4px solid transparent;
}
.metric-card.health    { background: #f0fdf4; border-color: var(--color-health); }
.metric-card.disease   { background: #eff6ff; border-color: var(--color-primary); }
.metric-card.economic  { background: #fffbeb; border-color: var(--color-warning); }
.metric-card.gap       { background: #fef2f2; border-color: var(--color-danger); }
.metric-card .metric-label { font-size: 0.7rem; color: var(--color-muted); text-transform: uppercase; }
.metric-card .metric-value { font-size: 1.4rem; font-weight: 700; margin: 2px 0; }
.metric-card .metric-delta { font-size: 0.7rem; color: var(--color-muted); }

.incentive-status {
  padding: 10px;
  border-radius: var(--radius);
  font-size: 0.8rem;
  font-weight: 600;
  text-align: center;
}
.incentive-status.compatible { background: #dcfce7; color: #166534; }
.incentive-status.violated   { background: #fee2e2; color: #991b1b; }
```

- [ ] **Step 3: Verify — open index.html, run simulation, check dashboard cards**

Expected: Four metric cards with values, incentive status, bar chart comparing with/without market.

---

### Task 7: Main Controller + Wiring

**Files:**
- Modify: `js/main.js`

- [ ] **Step 1: Write the handleRun function and wire everything together**

```javascript
// main.js — complete controller

function handleRun() {
  const params = getCurrentParams();

  // Run both with-market and without-market for comparison
  const withMarket = runSimulation(params);
  const noMarketParams = { healthTaxRate: 0, healthFloor: 0, tradingCost: 'high', climateScenario: params.climateScenario };
  const withoutMarket = runSimulation(noMarketParams);

  const result = { ...withMarket, withMarket, withoutMarket };

  // Update all UI
  updateMap(result);
  updateDashboard(result);

  // Update display values on sliders
  document.getElementById('tau-value').textContent = Math.round(params.healthTaxRate * 100) + '%';
  document.getElementById('floor-value').textContent = Math.round(params.healthFloor * 100) + '%';
}

// Live update on slider/select change (no click needed)
function attachLiveUpdates() {
  document.getElementById('tau-slider').addEventListener('input', () => {
    document.getElementById('tau-value').textContent = document.getElementById('tau-slider').value + '%';
    handleRun();
  });
  document.getElementById('floor-slider').addEventListener('input', () => {
    document.getElementById('floor-value').textContent = document.getElementById('floor-slider').value + '%';
    handleRun();
  });
  document.getElementById('climate-select').addEventListener('change', handleRun);
  document.getElementById('cost-select').addEventListener('change', handleRun);
}

document.addEventListener('DOMContentLoaded', () => {
  buildControls();
  initMap();
  attachLiveUpdates();
  handleRun();
});
```

- [ ] **Step 2: Verify — open index.html, drag sliders, confirm real-time updates**

Expected: All three panels update in real-time when sliders move. Map nodes resize, dashboard metrics change, chart updates.

---

### Task 8: Visual Polish + Animations

**Files:**
- Modify: `css/style.css`
- Modify: `index.html`
- Add: `images/` — water/nature photos

- [ ] **Step 1: Search for water/nature reference designs and imagery**

Use `web-access` skill to:
1. Search for high-end environmental dashboard designs (e.g., "climate data dashboard UI design")
2. Download 2-3 free water/nature images from Unsplash for background/hero

- [ ] **Step 2: Add hero background image to header, smooth transitions**

```css
/* Add to style.css */

#header {
  position: relative;
  overflow: hidden;
}
#header::before {
  content: '';
  position: absolute;
  inset: 0;
  background: url('../images/water-bg.jpg') center/cover;
  opacity: 0.3;
  z-index: 0;
}
#header h1, #header .subtitle { position: relative; z-index: 1; }

/* Smooth panel transitions */
#panel-left, #panel-right {
  transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

/* Metric value animation */
.metric-value {
  transition: color 0.5s ease;
}
.metric-value.updated {
  color: var(--color-primary);
  animation: pulse 0.6s ease;
}

@keyframes pulse {
  0% { transform: scale(1); }
  50% { transform: scale(1.05); }
  100% { transform: scale(1); }
}

/* Slider track styling */
input[type="range"] {
  -webkit-appearance: none;
  height: 6px;
  background: linear-gradient(to right, #16a34a, #d97706, #dc2626);
  border-radius: 3px;
  outline: none;
}
input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: white;
  border: 2px solid var(--color-primary);
  box-shadow: 0 1px 4px rgba(0,0,0,0.2);
  cursor: pointer;
  transition: transform 0.15s ease;
}
input[type="range"]::-webkit-slider-thumb:hover {
  transform: scale(1.2);
}

/* Water node hover effect */
.water-node {
  transition: transform 0.2s ease;
}
.water-node:hover {
  transform: scale(1.3);
  z-index: 1000 !important;
}

/* Scrollbar styling */
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }

/* Responsive: stack panels on small screens */
@media (max-width: 900px) {
  #main {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr auto;
  }
  #panel-left, #panel-right { border: none; }
}
```

- [ ] **Step 3: Add loading shimmer and result feedback**

```css
/* Loading state */
.simulating #panel-center {
  opacity: 0.6;
  transition: opacity 0.2s;
}

/* Toast notification on parameter change */
.toast {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--color-text);
  color: white;
  padding: 8px 20px;
  border-radius: 20px;
  font-size: 0.8rem;
  animation: toast-in 0.3s ease, toast-out 0.3s ease 1.5s forwards;
  z-index: 9999;
}
@keyframes toast-in  { from { opacity: 0; transform: translateX(-50%) translateY(10px); } }
@keyframes toast-out { to { opacity: 0; transform: translateX(-50%) translateY(-10px); } }
```

- [ ] **Step 4: Verify — open index.html, check visual quality, smoothness**

Expected: Hero image in header, smooth slider animations, responsive layout at narrow widths, hover effects on map nodes.

---

### Task 9: PPT Creation

**Files:**
- Create: `ppt/action-pitch.pptx`

- [ ] **Step 1: Invoke pptx skill to create 12-slide deck**

Use `pptx` skill with these specs:
- 12 slides per Section 4 of the design spec
- Dark teal + white color scheme (matching web tool)
- Include placeholders for: Stata charts (slides 2, 9), tool screenshots (slides 6-7), QR code (slide 12)
- Font: Arial, clean and academic but modern

- [ ] **Step 2: Verify — open pptx in PowerPoint/Keynote, confirm 12 slides**

---

### Task 10: Deploy to GitHub Pages

**Files:**
- Create: (GitHub repo)

- [ ] **Step 1: Initialize git repo and push to GitHub**

```bash
cd /path/to/hackathon
git init
git add .
git commit -m "Initial commit: Water Rights Trading for Health Resilience"
```

Create GitHub repo (via `gh` CLI or web), then:
```bash
git remote add origin <repo-url>
git branch -M main
git push -u origin main
```

- [ ] **Step 2: Enable GitHub Pages**

Settings → Pages → Source: Deploy from branch → main → `/ (root)` → Save.

- [ ] **Step 3: Verify — open https://<username>.github.io/<repo>/ in browser**

Expected: Tool loads, all three panels functional, map renders.

---

### Task 11: Demo Script + Final Check

- [ ] **Step 1: Write 5-minute demo walkthrough script**

Script structure:
1. (30s) Context: "This watershed faces a drought..."
2. (1min) Parameter walk: Adjust τ from 0→30%, show health dashboard change
3. (1min) Scenario switch: SSP2-4.5 → SSP5-8.5, show water availability collapse
4. (1min) Incentive check: Show compatible status, then push health floor too low to trigger violation
5. (1min) Comparison: Show with-market vs without-market bar chart
6. (30s) Summary: "With the right incentives, water markets save lives"

- [ ] **Step 2: Full dry run — present to yourself, time each part**

- [ ] **Step 3: Fix any issues found during dry run**
