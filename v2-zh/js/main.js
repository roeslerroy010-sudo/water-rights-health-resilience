// main.js — 控制器：构建参数面板 + 绑定模型 + 触发UI更新

// ---- 构建参数控制面板 ----
function buildControls() {
  const container = document.getElementById('controls');

  // 健康税率滑块
  const tauGroup = document.createElement('div');
  tauGroup.className = 'control-group';
  tauGroup.innerHTML = `
    <label for="tau-slider">
      <span>健康税率 (τ)</span>
      <span class="value" id="tau-value">${Math.round(DEFAULT_PARAMS.healthTaxRate * 100)}%</span>
    </label>
    <input type="range" id="tau-slider" min="0" max="50" value="${DEFAULT_PARAMS.healthTaxRate * 100}" step="1">
    <p class="hint">对损害健康的用水行为征收的庇古税</p>
    <div class="slider-labels"><span>0%</span><span>25%</span><span>50%</span></div>
  `;

  // 气候情景
  const climateGroup = document.createElement('div');
  climateGroup.className = 'control-group';
  climateGroup.innerHTML = `
    <label for="climate-select">气候情景</label>
    <select id="climate-select">
      <option value="ssp245" selected>${CLIMATE_SCENARIOS.ssp245.label}</option>
      <option value="ssp585">${CLIMATE_SCENARIOS.ssp585.label}</option>
    </select>
    <p class="hint" id="climate-desc">${CLIMATE_SCENARIOS.ssp245.description}</p>
  `;

  // 健康优先配额
  const floorGroup = document.createElement('div');
  floorGroup.className = 'control-group';
  floorGroup.innerHTML = `
    <label for="floor-slider">
      <span>健康优先配额</span>
      <span class="value" id="floor-value">${Math.round(DEFAULT_PARAMS.healthFloor * 100)}%</span>
    </label>
    <input type="range" id="floor-slider" min="10" max="40" value="${DEFAULT_PARAMS.healthFloor * 100}" step="1">
    <p class="hint">预留给健康优先用户的最低水量占比</p>
    <div class="slider-labels"><span>10%</span><span>25%</span><span>40%</span></div>
  `;

  // 交易成本
  const costGroup = document.createElement('div');
  costGroup.className = 'control-group';
  costGroup.innerHTML = `
    <label for="cost-select">交易成本</label>
    <select id="cost-select">
      <option value="low">${TRADING_COSTS.low.label}</option>
      <option value="medium" selected>${TRADING_COSTS.medium.label}</option>
      <option value="high">${TRADING_COSTS.high.label}</option>
    </select>
    <p class="hint" id="cost-desc">${TRADING_COSTS.medium.description}</p>
  `;

  // 运行按钮
  const runBtn = document.createElement('button');
  runBtn.id = 'run-btn';
  runBtn.className = 'btn-primary';
  runBtn.textContent = '运行模拟';
  runBtn.addEventListener('click', handleRun);

  // 分隔线
  const divider = document.createElement('hr');
  divider.className = 'control-divider';

  // 情景信息框
  const infoBox = document.createElement('div');
  infoBox.id = 'scenario-info';
  infoBox.className = 'info-box';

  container.append(tauGroup, climateGroup, floorGroup, costGroup, divider, runBtn, infoBox);
}

// ---- 从UI读取当前参数 ----
function getCurrentParams() {
  return {
    healthTaxRate: parseInt(document.getElementById('tau-slider').value) / 100,
    climateScenario: document.getElementById('climate-select').value,
    healthFloor: parseInt(document.getElementById('floor-slider').value) / 100,
    tradingCost: document.getElementById('cost-select').value,
  };
}

// ---- 执行模拟 ----
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

// ---- 更新情景信息框 ----
function updateScenarioInfo(result) {
  const info = document.getElementById('scenario-info');
  if (!info) return;
  info.innerHTML = `
    <div class="info-title">当前情景</div>
    <div class="info-row"><span>可用水量</span><strong>${Math.round(result.water.total)}M m³</strong></div>
    <div class="info-row"><span>可交易量</span><strong>${Math.round(result.water.tradable)}M m³</strong></div>
    <div class="info-row"><span>干旱风险</span><strong>${Math.round(result.water.droughtFreq * 100)}%</strong></div>
    <div class="info-row"><span>市场价格</span><strong>¥${result.marketPrice}/m³</strong></div>
  `;
}

// ---- 实时更新事件绑定 ----
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

// ---- 页面加载初始化 ----
document.addEventListener('DOMContentLoaded', () => {
  buildControls();
  initMap();
  attachLiveUpdates();
  // 延迟首次运行，确保所有脚本加载完毕
  setTimeout(() => {
    if (typeof updateMap === 'function' && typeof updateDashboard === 'function') {
      handleRun();
    }
  }, 200);
});
