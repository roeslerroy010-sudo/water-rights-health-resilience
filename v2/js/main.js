// main.js — Controller: build controls + wire to model + trigger UI updates

// ---- Build parameter control panel ----
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
    <div class="slider-labels"><span>0%</span><span>25%</span><span>50%</span></div>
  `;

  // Climate scenario
  const climateGroup = document.createElement('div');
  climateGroup.className = 'control-group';
  climateGroup.innerHTML = `
    <label for="climate-select">Climate Scenario</label>
    <select id="climate-select">
      <option value="ssp245" selected>${CLIMATE_SCENARIOS.ssp245.label}</option>
      <option value="ssp585">${CLIMATE_SCENARIOS.ssp585.label}</option>
    </select>
    <p class="hint" id="climate-desc">${CLIMATE_SCENARIOS.ssp245.description}</p>
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
    <p class="hint">Minimum allocation reserved for health-priority users</p>
    <div class="slider-labels"><span>10%</span><span>25%</span><span>40%</span></div>
  `;

  // Trading cost
  const costGroup = document.createElement('div');
  costGroup.className = 'control-group';
  costGroup.innerHTML = `
    <label for="cost-select">Trading Cost</label>
    <select id="cost-select">
      <option value="low">${TRADING_COSTS.low.label}</option>
      <option value="medium" selected>${TRADING_COSTS.medium.label}</option>
      <option value="high">${TRADING_COSTS.high.label}</option>
    </select>
    <p class="hint" id="cost-desc">${TRADING_COSTS.medium.description}</p>
  `;

  // Run button
  const runBtn = document.createElement('button');
  runBtn.id = 'run-btn';
  runBtn.className = 'btn-primary';
  runBtn.textContent = 'Run Simulation';
  runBtn.addEventListener('click', handleRun);

  // Divider
  const divider = document.createElement('hr');
  divider.className = 'control-divider';

  // Scenario info box
  const infoBox = document.createElement('div');
  infoBox.id = 'scenario-info';
  infoBox.className = 'info-box';

  container.append(tauGroup, climateGroup, floorGroup, costGroup, divider, runBtn, infoBox);
}

// ---- Read current parameters from UI ----
function getCurrentParams() {
  return {
    healthTaxRate: parseInt(document.getElementById('tau-slider').value) / 100,
    climateScenario: document.getElementById('climate-select').value,
    healthFloor: parseInt(document.getElementById('floor-slider').value) / 100,
    tradingCost: document.getElementById('cost-select').value,
  };
}

// ---- Handle simulation run ----
function handleRun() {
  const params = getCurrentParams();
  const withMarket = runSimulation(params);
  const noMarketParams = { healthTaxRate: 0, healthFloor: 0, tradingCost: 'high', climateScenario: params.climateScenario };
  const withoutMarket = runSimulation(noMarketParams);
  const result = { ...withMarket, withMarket, withoutMarket };

  updateMap(result);
  updateDashboard(result);
  updateScenarioInfo(result);
}

// ---- Update scenario info box ----
function updateScenarioInfo(result) {
  const info = document.getElementById('scenario-info');
  if (!info) return;
  info.innerHTML = `
    <div class="info-title">Current Scenario</div>
    <div class="info-row"><span>Water Available</span><strong>${Math.round(result.water.total)}M m³</strong></div>
    <div class="info-row"><span>Tradable</span><strong>${Math.round(result.water.tradable)}M m³</strong></div>
    <div class="info-row"><span>Drought Risk</span><strong>${Math.round(result.water.droughtFreq * 100)}%</strong></div>
    <div class="info-row"><span>Market Price</span><strong>¥${result.marketPrice}/m³</strong></div>
  `;
}

// ---- Live update handlers ----
function attachLiveUpdates() {
  const tauSlider = document.getElementById('tau-slider');
  tauSlider.addEventListener('input', () => {
    document.getElementById('tau-value').textContent = tauSlider.value + '%';
    handleRun();
  });

  const floorSlider = document.getElementById('floor-slider');
  floorSlider.addEventListener('input', () => {
    document.getElementById('floor-value').textContent = floorSlider.value + '%';
    handleRun();
  });

  document.getElementById('climate-select').addEventListener('change', (e) => {
    const desc = document.getElementById('climate-desc');
    desc.textContent = CLIMATE_SCENARIOS[e.target.value].description;
    handleRun();
  });

  document.getElementById('cost-select').addEventListener('change', (e) => {
    const desc = document.getElementById('cost-desc');
    desc.textContent = TRADING_COSTS[e.target.value].description;
    handleRun();
  });
}

// ---- Init on page load ----
document.addEventListener('DOMContentLoaded', () => {
  buildControls();
  initMap();
  attachLiveUpdates();
  // Defer first run to let all scripts load
  setTimeout(() => {
    if (typeof updateMap === 'function' && typeof updateDashboard === 'function') {
      handleRun();
    }
  }, 200);
});
