// dashboard.js — 健康指标仪表盘（指标卡片 + Chart.js柱状图）

let healthChart = null;

function updateDashboard(simulationResult) {
  const h = simulationResult.health;
  const incentive = simulationResult.incentive;
  const withM = simulationResult.withMarket;
  const withoutM = simulationResult.withoutMarket;

  const dashboard = document.getElementById('dashboard');
  if (!dashboard) return;

  dashboard.innerHTML = `
    <div class="metric-card health">
      <div class="metric-label">避免的伤残调整寿命年</div>
      <div class="metric-value" id="metric-daly">${h.dalyAvoided.toLocaleString()}</div>
      <div class="metric-delta">对比无市场基准（${h.baselineDALY.toLocaleString()} DALY）</div>
    </div>
    <div class="metric-card disease">
      <div class="metric-label">水媒疾病发病率</div>
      <div class="metric-value" id="metric-disease">-${h.diseaseReduction}%</div>
      <div class="metric-delta">发病率下降幅度</div>
    </div>
    <div class="metric-card economic">
      <div class="metric-label">经济净现值</div>
      <div class="metric-value" id="metric-npv">¥${h.economicNPV} 亿</div>
      <div class="metric-delta">健康收益货币化（¥${DOSE_RESPONSE.valuePerDALY.toLocaleString()}/DALY）</div>
    </div>
    <div class="metric-card quota">
      <div class="metric-label">健康配额缺口</div>
      <div class="metric-value" id="metric-gap">${Math.abs(h.healthQuotaGap).toLocaleString()}M m³</div>
      <div class="metric-delta">${h.healthQuotaGap > 0 ? '盈余——健康用户水源充足' : '缺口——健康用户供水不足'}</div>
    </div>
    <div class="incentive-status ${incentive.compatible ? 'compatible' : 'violated'}" id="incentive-status">
      ${incentive.compatible
        ? '✓ 激励相容——所有用水户遵守规则'
        : '⚠ 激励不相容：' + incentive.violatingUsers.join('、') + ' 可能偏离规则'}
    </div>
    <div class="chart-container">
      <p class="chart-title">市场影响对比</p>
      <div class="chart-wrapper">
        <canvas id="comparison-chart"></canvas>
      </div>
    </div>
  `;

  // 指标数值动画
  ['daly', 'disease', 'npv', 'gap'].forEach(id => {
    const el = document.getElementById('metric-' + id);
    if (el) {
      el.classList.add('updated');
      setTimeout(() => el.classList.remove('updated'), 600);
    }
  });

  drawComparisonChart(withM, withoutM);
}

function drawComparisonChart(withMarket, withoutMarket) {
  const canvas = document.getElementById('comparison-chart');
  if (!canvas) return;

  if (healthChart) {
    healthChart.destroy();
    healthChart = null;
  }

  healthChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: ['避免DALY', '疾病降幅（%）', '经济净现值（亿元）'],
      datasets: [
        {
          label: '有水权市场',
          data: [
            withMarket.health.dalyAvoided,
            withMarket.health.diseaseReduction,
            withMarket.health.economicNPV,
          ],
          backgroundColor: '#16a34a',
          borderColor: '#15803d',
          borderWidth: 1,
          borderRadius: 4,
          barPercentage: 0.7,
        },
        {
          label: '无水权市场',
          data: [
            withoutMarket.health.dalyAvoided,
            withoutMarket.health.diseaseReduction,
            withoutMarket.health.economicNPV,
          ],
          backgroundColor: '#94a3b8',
          borderColor: '#64748b',
          borderWidth: 1,
          borderRadius: 4,
          barPercentage: 0.7,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            boxWidth: 12,
            padding: 12,
            font: { size: 10 },
            usePointStyle: true,
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { font: { size: 9 }, maxTicksLimit: 5 },
          grid: { color: '#f1f5f9' },
        },
        x: {
          ticks: { font: { size: 9 } },
          grid: { display: false },
        },
      },
    },
  });
}
