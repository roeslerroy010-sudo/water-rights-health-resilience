(function () {
  'use strict';

  function update(result, selectedId, context) {
    const dashboard = document.getElementById('dashboard');
    if (!dashboard || !result) return;

    const aggregate = result.aggregate || {};
    const scopeMeta = (context && context.scope) || (result.meta && result.meta.scope) || {};
    const scopeLabel = scopeMeta.message || scopeMeta.label || '全域';
    const compatible = aggregate.incentiveCompatible !== false;
    const compatibleShare = Number(aggregate.compatibleShare || 0);
    const solverNotice = result.meta && result.meta.lpSpikePending
      ? '<div class="solver-chip">启发式求解，LP spike 待完成</div>'
      : '';
    const scopeNotice = scopeMeta.warning && !(result.meta && result.meta.skipSolve)
      ? `<div class="solver-chip">${escapeHtml(scopeMeta.warning)}</div>`
      : '';

    if (result.meta && result.meta.skipSolve) {
      dashboard.innerHTML = `<div class="empty-state">${escapeHtml(result.meta.scopeWarning || '请圈选更大区域')}</div>`;
      return;
    }

    dashboard.innerHTML = `
      ${solverNotice}
      ${scopeNotice}

      <section class="metric-card">
        <div class="metric-label">可交易水量</div>
        <div class="metric-value">${formatWater(aggregate.tradableWater)}</div>
        <p class="metric-sub">${escapeHtml(scopeLabel)}</p>
      </section>

      ${renderWaterPricePanel(aggregate)}

      <section class="metric-card health">
        <div class="metric-label">DALY 避免</div>
        <div class="metric-value">${formatNumber(aggregate.dalyAvoided, 1)}</div>
        <p class="metric-sub">当前范围健康损失减少量</p>
      </section>

      <section class="metric-card environment">
        <div class="metric-label">生态/环境流量</div>
        <div class="metric-value">${formatWater(aggregate.environmentalFlow)}</div>
        <p class="metric-sub">本地产流/支流基流 ${formatWater(aggregate.ecoBaseFlow)} + 额外留存 ${formatWater(aggregate.ecoSurplus)}</p>
      </section>

      <section class="metric-card health">
        <div class="metric-label">疾病减少</div>
        <div class="metric-value">${formatCases(aggregate.diseaseCasesAvoided)}</div>
        <p class="metric-sub">由 DALY 结果折算的前端代理值</p>
      </section>

      <section class="metric-card inequity">
        <div class="metric-label">年度净社会收益</div>
        <div class="metric-value">${formatMoney(aggregate.netSocialBenefitCny)}</div>
        <p class="metric-sub">健康收益 ${formatMoney(aggregate.healthBenefitCny)} − 无谓损失 ${formatMoney(aggregate.deadweightLossCny)} − 交易摩擦 ${formatMoney(aggregate.tradingCostCny)}（摩擦按实际成交量 ${formatWater(aggregate.tradedVolume)} 计）。单年口径，未贴现</p>
      </section>

      <section class="metric-card incentive ${compatible ? '' : 'bad'}">
        <div class="metric-label">激励相容</div>
        <div class="metric-value">${compatible ? '通过' : '预警'}</div>
        <p class="metric-sub">当前范围相容率 ${formatPercent(compatibleShare)}</p>
      </section>

      ${renderNoTaxEffectPanel(context && context.noTaxComparison)}
      ${renderViolationPanel(result)}
    `;
  }

  // 水权出清价来自 LP 水量平衡约束的对偶值（水的稀缺租金），不是外生公式。
  // 空间价差是交易收益的来源；税收收入是转移支付，单独展示。
  function renderWaterPricePanel(aggregate) {
    const shadow = aggregate && aggregate.shadowPrice;
    if (!shadow) return '';
    const fromDual = aggregate.marketPriceSource === 'lp-dual-shadow-price';
    const scope = aggregate.supplyScope || {};
    const quotaNote = scope.quotaBinding
      ? `干流取水许可 ${formatWater(scope.abstractionQuota)} / 过境水量 ${formatWater(scope.transitAvailable)}`
      : '干流取水许可未成为约束';
    return `
      <section class="metric-card market">
        <div class="metric-label">水权出清价</div>
        <div class="metric-value">${formatNumber(aggregate.marketPrice, 4)} 元/m³</div>
        <p class="metric-sub">
          ${fromDual ? 'LP 水量平衡约束对偶值（水的稀缺租金），按取水量加权' : '启发式回退估值，非对偶解'}
          · 空间价差 ${formatNumber(shadow.min, 3)}–${formatNumber(shadow.max, 3)} 元/m³
          · 稀缺节点 ${shadow.scarceNodeCount}/${shadow.nodeCount}
          · ${quotaNote}
        </p>
      </section>

      <section class="metric-card market">
        <div class="metric-label">健康税收入</div>
        <div class="metric-value">${formatMoney(aggregate.taxRevenueCny)}</div>
        <p class="metric-sub">转移支付，不计入社会成本；可定向用于供水管网与 WASH 投资。对应工业减少取水 ${formatWater(aggregate.industrialWaterForgoneM3)}</p>
      </section>
    `;
  }

  function renderNoTaxEffectPanel(comparison) {
    if (!comparison || !comparison.enabled) return '';
    const delta = comparison.delta || {};
    const note = '这是健康税政策效应：两种情景均含交易、只改变 τ，Δ=当前−τ0；工业取水下降、环境流量上升、DALY avoided 增加才是政策有效性的判断口径。若交易效率面板出现工业增加，那是有交易相对自给自足让缺水部门买到水，不代表健康税失效。';
    return `
      <section class="bar-panel tax-effect-panel">
        <h3>有/无健康税对比</h3>
        <div class="tax-effect-row">
          <span>工业取水 Δ（当前−τ0）</span>
          <strong class="${directionalClass(delta.industryWithdrawal, 'negative')}">${formatSignedWater(delta.industryWithdrawal)}</strong>
        </div>
        <div class="tax-effect-row">
          <span>环境流量 Δ（当前−τ0）</span>
          <strong class="${directionalClass(delta.environmentalFlow, 'positive')}">${formatSignedWater(delta.environmentalFlow)}</strong>
        </div>
        <div class="tax-effect-row">
          <span>DALY avoided Δ（当前−τ0）</span>
          <strong class="${directionalClass(delta.dalyAvoided, 'positive')}">${formatSignedNumber(delta.dalyAvoided, 1)}</strong>
        </div>
        <p class="metric-sub">${escapeHtml(note)}</p>
      </section>
    `;
  }

  function renderViolationPanel(result) {
    const flags = result.meta && Array.isArray(result.meta.incentiveFlags)
      ? result.meta.incentiveFlags
      : [];
    if (!flags.length) {
      return `
        <section class="bar-panel">
          <h3>违规子流域定位</h3>
          <div class="empty-state">暂无激励相容违规</div>
        </section>
      `;
    }

    const names = new Map((result.basinResults || []).map((item) => [item.id, item.name]));
    return `
      <section class="bar-panel">
        <h3>违规子流域定位</h3>
        ${flags.slice(0, 6).map((flag) => {
          const id = String(flag.nodeId || '');
          const label = flag.nodeName || names.get(id) || id || '未知子流域';
          const detail = flag.sector || (Array.isArray(flag.sectors) ? flag.sectors.join('+') : flag.type || 'incentive');
          return `
            <div class="bar-row risk">
              <span class="bar-label">${escapeHtml(label)}</span>
              <span class="bar-track"><span class="bar-fill" style="width:100%"></span></span>
              <span class="bar-value">${escapeHtml(detail)}</span>
            </div>
          `;
        }).join('')}
      </section>
    `;
  }

  function renderRankPanel(items, field, title, riskStyle) {
    const sorted = [...items]
      .sort((a, b) => (Number(b[field]) || 0) - (Number(a[field]) || 0))
      .slice(0, 5);
    const max = Math.max(...sorted.map((item) => Number(item[field]) || 0), 1);

    return `
      <section class="bar-panel">
        <h3>${escapeHtml(title)}</h3>
        ${sorted.map((item) => {
          const value = Number(item[field]) || 0;
          const width = Math.max(2, value / max * 100);
          const display = field === 'stressIndex' ? formatPercent(value) : formatNumber(value, 1);
          return `
            <div class="bar-row ${riskStyle ? 'risk' : ''}">
              <span class="bar-label">${escapeHtml(item.name)}</span>
              <span class="bar-track"><span class="bar-fill" style="width:${width.toFixed(1)}%"></span></span>
              <span class="bar-value">${display}</span>
            </div>
          `;
        }).join('')}
      </section>
    `;
  }

  function formatNumber(value, digits) {
    return (Number(value) || 0).toLocaleString('zh-CN', {
      maximumFractionDigits: digits,
      minimumFractionDigits: digits,
    });
  }

  function formatPercent(value) {
    return `${Math.round((Number(value) || 0) * 100)}%`;
  }

  function formatWater(value) {
    const number = Number(value) || 0;
    if (number >= 100000000) return `${(number / 100000000).toFixed(2)}亿m³`;
    if (number >= 10000) return `${(number / 10000).toFixed(1)}万m³`;
    return `${Math.round(number)}m³`;
  }

  function formatPrice(value) {
    return `${(Number(value) || 0).toFixed(3)}元/m³`;
  }

  function formatCases(value) {
    const number = Number(value) || 0;
    if (number >= 10000) return `${(number / 10000).toFixed(1)}万例`;
    return `${Math.round(number)}例`;
  }

  function formatMoney(value) {
    const number = Number(value) || 0;
    if (number >= 100000000) return `${(number / 100000000).toFixed(2)}亿元`;
    if (number >= 10000) return `${(number / 10000).toFixed(1)}万元`;
    return `${Math.round(number)}元`;
  }

  function formatSignedWater(value) {
    const number = Number(value) || 0;
    const sign = number > 0 ? '+' : number < 0 ? '-' : '';
    return `${sign}${formatWater(Math.abs(number))}`;
  }

  function formatSignedNumber(value, digits) {
    const number = Number(value) || 0;
    const sign = number > 0 ? '+' : '';
    return `${sign}${number.toLocaleString('zh-CN', {
      maximumFractionDigits: digits,
      minimumFractionDigits: digits,
    })}`;
  }

  function signedClass(value) {
    const number = Number(value) || 0;
    if (number > 1e-9) return 'positive';
    if (number < -1e-9) return 'negative';
    return 'neutral';
  }

  function directionalClass(value, goodDirection) {
    const number = Number(value) || 0;
    if (Math.abs(number) <= 1e-9) return 'neutral';
    return (goodDirection === 'negative' ? number < 0 : number > 0) ? 'positive' : 'negative';
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  window.ResearchDashboard = {
    update,
  };
})();
