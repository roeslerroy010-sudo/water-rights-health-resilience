// dashboard.js — Health metrics dashboard with cards and Chart.js bar chart

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
      <div class="metric-label">DALY Avoided</div>
      <div class="metric-value" id="metric-daly">${h.dalyAvoided.toLocaleString()}</div>
      <div class="metric-delta">vs no-market baseline (${h.baselineDALY.toLocaleString()} DALY)</div>
    </div>
    <div class="metric-card disease">
      <div class="metric-label">Water-borne Disease</div>
      <div class="metric-value" id="metric-disease">-${h.diseaseReduction}%</div>
      <div class="metric-delta">reduction in incidence rate</div>
    </div>
    <div class="metric-card economic">
      <div class="metric-label">Economic NPV</div>
      <div class="metric-value" id="metric-npv">¥${h.economicNPV} (100M)</div>
      <div class="metric-delta">health benefit monetized (¥${DOSE_RESPONSE.valuePerDALY.toLocaleString()}/DALY)</div>
    </div>
    <div class="metric-card quota">
      <div class="metric-label">Health Quota Gap</div>
      <div class="metric-value" id="metric-gap">${Math.abs(h.healthQuotaGap).toLocaleString()}M m³</div>
      <div class="metric-delta">${h.healthQuotaGap > 0 ? 'Surplus — health users have enough' : 'Shortfall — health users under-supplied'}</div>
    </div>
    <div class="incentive-status ${incentive.compatible ? 'compatible' : 'violated'}" id="incentive-status">
      ${incentive.compatible
        ? '✓ Incentive Compatible — all users follow the rules'
        : '⚠ Violation: ' + incentive.violatingUsers.join(', ') + ' may deviate'}
    </div>
    <div class="chart-container">
      <p class="chart-title">Market Impact Comparison</p>
      <div class="chart-wrapper">
        <canvas id="comparison-chart"></canvas>
      </div>
    </div>
  `;

  // Animate metric values
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
      labels: ['DALY Avoided', 'Disease Reduction (%)', 'Econ NPV (¥100M)'],
      datasets: [
        {
          label: 'With Market',
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
          label: 'Without Market',
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
