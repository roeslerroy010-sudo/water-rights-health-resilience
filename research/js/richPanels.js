(function () {
  'use strict';

  const SECTORS = [
    { key: 'agri', label: '农业' },
    { key: 'industry', label: '工业' },
    { key: 'urban', label: '生活' },
  ];
  const UNREALLOCATED_LABEL = '留在河道/未取用';
  const SUPPLEMENTAL_SOURCE_LABEL = '其他水源/新增取用';

  const state = {
    sortKey: 'unmetTotal',
    sortDirection: 'desc',
  };

  function update(result, context = {}) {
    const root = document.getElementById('rich-panels');
    if (!root) return;
    if (!result || (result.meta && result.meta.skipSolve)) {
      root.innerHTML = '<div class="rich-empty">请圈选更大区域后查看本区域计算依据</div>';
      return;
    }

    const aggregate = aggregateRichData(result, context);
    const tradeVisuals = buildTradeVisuals(result, context, aggregate);
    const noTaxComparison = buildNoTaxComparison(result, context);
    root.innerHTML = `
      ${renderNoTaxComparisonPanel(noTaxComparison)}
      ${renderEvidencePanel(aggregate, context, tradeVisuals.tradeScope)}
      ${renderEnvironmentFlowPanel(aggregate)}
      ${renderTauResponsePanel(context, tradeVisuals.tradeScope)}
      ${renderTradeNarrativePanel(tradeVisuals)}
      ${renderMarketPanel(result, aggregate, tradeVisuals)}
      ${renderExternalityPanel(context.downstreamFocus)}
      ${renderComparisonPanel(context.noMarketComparison, context.noMarketEnabled, tradeVisuals)}
    `;

    bindTableInteractions(root);
    renderTradeVisualModules(root, tradeVisuals);
  }

  function aggregateRichData(result, context) {
    const basinResults = Array.isArray(result.basinResults) ? result.basinResults : [];
    const modelBasins = context.modelInput && Array.isArray(context.modelInput.basins)
      ? context.modelInput.basins
      : [];
    const modelById = new Map(modelBasins.map((basin) => [basin.id, basin]));
    const totals = {
      demand: sectorMap(),
      allocation: sectorMap(),
      unmet: sectorMap(),
      qLocal: 0,
      localRunoff: 0,
      transitInflow: 0,
      qAvail: 0,
      ecoBaseFlow: 0,
      inStreamFlow: 0,
      ecoSurplus: 0,
      environmentalFlow: 0,
      environmentalRowsWithFields: 0,
      population: 0,
      areaKm2: 0,
      runoffCoeffWeighted: 0,
      runoffWeight: 0,
    };

    const rows = basinResults.map((item) => {
      const model = modelById.get(item.id) || {};
      const demand = normalizeSectorMap(item.demand || model.demand);
      const allocation = normalizeSectorMap(item.allocation);
      const unmet = normalizeSectorMap(item.unmet || (item.modelNode && item.modelNode.unmet) || differenceSectorMap(demand, allocation));
      const modelSupply = model.supply || {};
      const itemSupply = item.supply || {};
      const supply = { ...modelSupply, ...itemSupply };
      const transitInflow = selectTransitInflow(modelSupply, itemSupply);
      const qLocal = numberOr(supply.qLocal, 0);
      const qAvail = numberOr(supply.qAvail, qLocal + transitInflow);
      const cleanLocalRunoff = firstFinite([
        modelSupply.localRunoff,
        modelSupply.qLocalRaw,
        itemSupply.localRunoff,
        itemSupply.qLocalRaw,
      ]);
      const localRunoff = cleanLocalRunoff === null
        ? Math.max(0, qLocal - transitInflow)
        : Math.max(0, cleanLocalRunoff);
      const runoffCoeff = firstFinite([
        modelSupply.runoffCoeff,
        itemSupply.runoffCoeff,
        model.runoffCoeff,
        item.runoffCoeff,
      ]);
      const population = numberOr(item.population, numberOr(model.population, 0));
      const areaKm2 = numberOr(model.areaKm2, numberOr(item.areaKm2, 0));
      const healthTax = item.healthTax || (item.modelNode && item.modelNode.healthTax) || {};
      const unmetTotal = sumSectorMap(unmet);
      const allocationTotal = sumSectorMap(allocation);
      const demandTotal = sumSectorMap(demand);
      const environment = readEnvironmentalFlow(item, model);

      SECTORS.forEach(({ key }) => {
        totals.demand[key] += demand[key];
        totals.allocation[key] += allocation[key];
        totals.unmet[key] += unmet[key];
      });
      totals.qLocal += qLocal;
      totals.localRunoff += localRunoff;
      totals.transitInflow += transitInflow;
      totals.qAvail += qAvail;
      totals.ecoBaseFlow += environment.ecoBaseFlow;
      totals.inStreamFlow += environment.inStreamFlow;
      totals.ecoSurplus += environment.ecoSurplus;
      totals.environmentalFlow += environment.environmentalFlow;
      totals.environmentalRowsWithFields += environment.hasEnvironmentalFields ? 1 : 0;
      totals.population += population;
      totals.areaKm2 += areaKm2;
      if (runoffCoeff !== null && runoffCoeff >= 0 && areaKm2 > 0) {
        totals.runoffCoeffWeighted += runoffCoeff * areaKm2;
        totals.runoffWeight += areaKm2;
      }

      const rowId = item.id;
      return {
        id: rowId,
        name: displayNameForItem(item, model, rowId),
        code: item.code || item.pfafId || model.code || model.pfafId || technicalCodeFor(item, model, rowId),
        demand,
        allocation,
        unmet,
        demandTotal,
        allocationTotal,
        unmetTotal,
        environment,
        population,
        areaKm2,
        healthTax: numberOr(healthTax.taxPerM3 || item.taxIntensity, 0),
        incentiveCompatible: item.incentiveCompatible !== false,
      };
    });

    return {
      basinCount: rows.length,
      rows,
      totals,
      transitShare: (totals.localRunoff + totals.transitInflow) > 0
        ? totals.transitInflow / (totals.localRunoff + totals.transitInflow)
        : 0,
      runoffCoeff: totals.runoffWeight > 0 ? totals.runoffCoeffWeighted / totals.runoffWeight : null,
      params: context.params || result.params || {},
      scope: context.scope || (result.meta && result.meta.scope) || {},
    };
  }

  function renderEvidencePanel(aggregate, context, tradeScope) {
    const params = aggregate.params || {};
    return `
      <section class="rich-section rich-evidence" aria-labelledby="rich-evidence-title">
        <div class="rich-section-heading">
          <div>
            <p class="panel-kicker">RICH-1</p>
            <h2 id="rich-evidence-title">本区域计算依据</h2>
          </div>
          <span class="rich-scope">${escapeHtml((aggregate.scope && (aggregate.scope.message || aggregate.scope.label)) || '全域')}</span>
        </div>

        <div class="rich-summary-grid">
          <div><span>子流域数</span><strong>${formatNumber(aggregate.basinCount, 0)}</strong></div>
          <div><span>人口合计</span><strong>${formatPeople(aggregate.totals.population)}</strong></div>
          <div><span>面积合计</span><strong>${formatNumber(aggregate.totals.areaKm2, 1)} km²</strong></div>
          <div><span>本地产流</span><strong>${formatWater(aggregate.totals.localRunoff)}</strong></div>
          <div><span>过境/边界入流</span><strong>${formatWater(aggregate.totals.transitInflow)}</strong></div>
          <div><span>过境占比</span><strong>${formatPercent(aggregate.transitShare)}</strong></div>
        </div>

        <div class="rich-param-row">
          <span>τ ${formatPercent(params.tau)}</span>
          <span>健康底线 ${formatPercent(params.healthFloor)}</span>
          <span>生态底线 ${formatOptionalPercent(params.ecoFloor)}</span>
          <span>交易摩擦 ${formatNumber(params.tradingCost, 2)} 元/m³</span>
          <span>交易范围 ${escapeHtml(tradeScope ? tradeScope.label : '外部调水（含边界入流）')}</span>
          <span>径流系数 ${aggregate.runoffCoeff === null ? '样本缺省' : aggregate.runoffCoeff.toFixed(2)}</span>
          <span>健康权重：生活 1.0 / 农业 0.1 / 工业 -0.25；生态基流按本地产流/支流口径约束</span>
        </div>

        <div class="sector-bars" role="img" aria-label="三类取水用途的需求、配水、缺口柱状图">
          ${SECTORS.map((sector) => renderSectorBar(sector, aggregate)).join('')}
        </div>
      </section>
    `;
  }

  function renderEnvironmentFlowPanel(aggregate) {
    const totals = aggregate.totals || {};
    const hasBaseFlow = totals.ecoBaseFlow > 0;
    const note = hasBaseFlow
      ? '环境流量 = ecoBaseFlow（按本地产流/支流口径强制留在河道的生态基流） + ecoSurplus（超过基流的额外留存）；长江过境水是巨量天然河道流量，不作为默认保留比例基数。'
      : '环境流量优先读取 ecoBaseFlow / inStreamFlow / ecoSurplus；当前结果尚未提供完整基流字段时，以可见 qOutflow 作为河道内流量占位。';
    return `
      <section class="rich-section rich-environment-flow" aria-labelledby="rich-environment-title">
        <div class="rich-section-heading">
          <div>
            <p class="panel-kicker">ECO-FLOW</p>
            <h2 id="rich-environment-title">支流生态基流与环境流量</h2>
          </div>
          <span class="rich-note">生态底线按本地产流口径</span>
        </div>
        <div class="rich-summary-grid">
          <div><span>环境流量</span><strong>${formatWater(totals.environmentalFlow)}</strong></div>
          <div><span>ecoBaseFlow 基流</span><strong>${formatWater(totals.ecoBaseFlow)}</strong></div>
          <div><span>ecoSurplus 额外留存</span><strong>${formatWater(totals.ecoSurplus)}</strong></div>
          <div><span>inStreamFlow 实际河道流量</span><strong>${formatWater(totals.inStreamFlow)}</strong></div>
          <div><span>工业取水</span><strong>${formatWater(totals.allocation.industry)}</strong></div>
          <div><span>生态底线参数</span><strong>${formatOptionalPercent(aggregate.params && aggregate.params.ecoFloor)}</strong></div>
        </div>
        <p class="rich-note block">${escapeHtml(note)}</p>
      </section>
    `;
  }

  function renderTauResponsePanel(context, tradeScope) {
    const response = context.tauResponse || context.tauResponseData || (context.result && context.result.tauResponse);
    const title = '健康税 τ 响应曲线';
    const note = '健康税（庇古税）是有效的：扫描同一选区、生态底线、气候与交易参数，仅改变 τ；工业随税率平滑减少取水，腾出的水留作生态流量或再配给健康用途。';
    const points = normalizeTauPoints(response);
    const chartHtml = points.length >= 2
      ? renderTauResponseSvg(points)
      : renderTauIntegrationHint();
    const scopeNote = tradeScope
      ? `当前交易范围：${tradeScope.label}；${tradeScope.mode === 'internal' ? '外部边界入流关闭，市场只在区域内部再配。' : '允许边界/过境水作为补充，税收效应仍由同一交易口径下 τ 的变化识别。'}`
      : '';
    return `
      <section class="rich-section rich-tau-response" aria-labelledby="rich-tau-title">
        <div class="rich-section-heading">
          <div>
            <p class="panel-kicker">TAU</p>
            <h2 id="rich-tau-title">${title}</h2>
          </div>
          <span class="rich-note">τ↑ → 工业取水平滑↓、环境流量↑、DALY avoided↑</span>
        </div>
        <p class="rich-note block">${escapeHtml(note)}</p>
        ${scopeNote ? `<p class="rich-note block">${escapeHtml(scopeNote)}</p>` : ''}
        <div class="market-chart-host" data-tau-response-chart>${chartHtml}</div>
      </section>
    `;
  }

  function renderSectorBar(sector, aggregate) {
    const demand = aggregate.totals.demand[sector.key];
    const allocation = aggregate.totals.allocation[sector.key];
    const unmet = aggregate.totals.unmet[sector.key];
    const max = Math.max(demand, allocation, unmet, 1);
    return `
      <div class="sector-bar-row">
        <div class="sector-label">${sector.label}</div>
        <div class="sector-bars-track">
          <span class="sector-bar demand" style="width:${barWidth(demand, max)}%"></span>
          <span class="sector-bar allocation" style="width:${barWidth(allocation, max)}%"></span>
          <span class="sector-bar unmet" style="width:${barWidth(unmet, max)}%"></span>
        </div>
        <div class="sector-values">
          <span>需 ${formatWater(demand)}</span>
          <span>配 ${formatWater(allocation)}</span>
          <span>缺 ${formatWater(unmet)}</span>
        </div>
      </div>
    `;
  }

  function renderTradeNarrativePanel(tradeVisuals) {
    const movers = tradeVisuals.reallocation;
    const reducers = movers.filter((item) => item.delta < -tradeVisuals.epsilon);
    const gainers = movers.filter((item) => item.delta > tradeVisuals.epsilon);
    const retainedText = tradeVisuals.unreallocated > tradeVisuals.epsilon
      ? `${UNREALLOCATED_LABEL} ${formatWater(tradeVisuals.unreallocated)}`
      : '';
    const reduceText = reducers.length
      ? reducers.map((item) => `${item.label}减用 ${formatWater(Math.abs(item.delta))}`).join('、')
      : '未识别明显减用部门';
    const gainText = gainers.length
      ? [gainers.map((item) => `${item.label}增配 ${formatWater(item.delta)}`).join('、'), retainedText].filter(Boolean).join('、')
      : retainedText || '未识别明显增配部门';
    const cleanedTone = reducers.length && gainers.length
      ? `市场把水从健康边际收益较低或受健康税约束的用途，转向生活等高健康价值用途${retainedText ? '，其余少取水量留在河道或未取用' : ''}。`
      : '当前参数下部门配水结构变化较小，市场主要表现为区域间调度。';

    return `
      <section class="rich-section trade-narrative-section" aria-labelledby="trade-narrative-title">
        <div class="rich-section-heading">
          <div>
            <p class="panel-kicker">TV-3</p>
            <h2 id="trade-narrative-title">部门再配叙事条</h2>
          </div>
          <span class="rich-note">与交易效率对比（有无交易）同口径</span>
        </div>
        <div class="trade-narrative" role="img" aria-label="部门减用与增配叙事">
          <div class="trade-narrative-flow">
            <div class="trade-narrative-side trade-reduce">
              <span>← 减用</span>
              <strong>${escapeHtml(reduceText)}</strong>
            </div>
            <div class="trade-narrative-arrow" aria-hidden="true">→</div>
            <div class="trade-narrative-side trade-gain">
              <span>→ 增配</span>
              <strong>${escapeHtml(gainText)}</strong>
            </div>
          </div>
          <p>${escapeHtml(cleanedTone)}</p>
        </div>
      </section>
    `;
  }

  function renderMarketPanel(result, aggregate, tradeVisuals) {
    const flows = Array.isArray(tradeVisuals.flows) ? tradeVisuals.flows : [];
    return `
      <section class="rich-section rich-market" aria-labelledby="rich-market-title">
        <div class="rich-section-heading">
          <div>
            <p class="panel-kicker">RICH-2</p>
            <h2 id="rich-market-title">市场可视化</h2>
          </div>
          <span class="rich-note">${escapeHtml(tradeVisuals.tradeBasisNote)}</span>
        </div>

        ${renderTradeScopeSummary(tradeVisuals.tradeScope)}

        <div class="trade-visual-grid">
          <div class="trade-chart-card">
            <div class="trade-chart-heading">
              <h3>部门交易桑基</h3>
              <span>市场再配估算</span>
            </div>
            <div class="trade-sankey-host" data-trade-sankey>${renderSankeyFallback(tradeVisuals)}</div>
          </div>
          <div class="trade-chart-card">
            <div class="trade-chart-heading">
              <h3>市场出清示意</h3>
              <span>教学示意，非逐笔撮合曲线</span>
            </div>
            <div class="market-chart-host" data-market-chart>${renderMarketChartFallback(tradeVisuals)}</div>
          </div>
        </div>

        <div class="rich-table-grid">
          <div class="rich-table-card">
            <h3>交易流明细（市场再配）</h3>
            <div class="rich-table-scroll">
              <table class="rich-table" id="trade-flow-table">
                <thead>
                  <tr><th>卖方</th><th>买方</th><th>水量</th><th>隐含价</th></tr>
                </thead>
                <tbody>
                  ${flows.length ? flows.slice(0, 80).map(renderFlowRow).join('') : '<tr><td colspan="4">当前选区暂无交易再配流</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>

          <div class="rich-table-card">
            <h3>子流域明细</h3>
            <div class="rich-table-scroll">
              <table class="rich-table sortable" id="basin-detail-table">
                <thead>
                  <tr>
                    ${sortableHead('name', '名称')}
                    ${sortableHead('demandTotal', '需求')}
                    ${sortableHead('allocationTotal', '配水')}
                    ${sortableHead('unmetTotal', '缺口')}
                    ${sortableHead('healthTax', '健康税')}
                    ${sortableHead('incentive', '违规')}
                  </tr>
                </thead>
                <tbody>
                  ${sortRows(aggregate.rows).map(renderBasinRow).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
    `;
  }

  function renderFlowRow(flow) {
    const fromCode = firstText([flow.fromCode, flow.originCode, flow.sourceCode, flow.sellerCode, flow.from, flow.origin]);
    const toCode = firstText([flow.toCode, flow.targetCode, flow.destinationCode, flow.buyerCode, flow.to, flow.target]);
    const from = chooseDisplayName([flow.fromName, flow.originName, flow.sourceName, flow.sellerName, flow.from, flow.origin], fromCode);
    const to = chooseDisplayName([flow.toName, flow.targetName, flow.destinationName, flow.buyerName, flow.to, flow.target], toCode);
    return `
      <tr>
        <td title="${escapeHtml(formatCodeTitle(fromCode))}">${renderNameWithCode(from, fromCode)}</td>
        <td title="${escapeHtml(formatCodeTitle(toCode))}">${renderNameWithCode(to, toCode)}</td>
        <td>${formatWater(flow.volume)}</td>
        <td>${formatPrice(flow.averageUnitCost || flow.price || flow.marketPrice)}</td>
      </tr>
    `;
  }

  function renderNameWithCode(name, code) {
    const codeLine = code ? `<span class="basin-code-sub">Pfaf 编码：${escapeHtml(code)}</span>` : '';
    return `<span class="basin-name-main">${escapeHtml(name)}</span>${codeLine}`;
  }

  function formatCodeTitle(code) {
    return code ? `技术 ID：${code}` : '';
  }

  function sortableHead(key, label) {
    const active = state.sortKey === key ? ` aria-sort="${state.sortDirection === 'asc' ? 'ascending' : 'descending'}"` : '';
    return `<th${active}><button type="button" class="rich-sort" data-sort-key="${key}">${label}</button></th>`;
  }

  function renderBasinRow(row) {
    const violating = row.incentiveCompatible ? '否' : '是';
    return `
      <tr class="basin-detail-row" data-basin-id="${escapeHtml(row.id)}" tabindex="0">
        <td title="${escapeHtml(formatCodeTitle(row.code))}">${renderNameWithCode(row.name, row.code)}</td>
        <td>${formatWater(row.demandTotal)}</td>
        <td>${formatWater(row.allocationTotal)}</td>
        <td>${formatWater(row.unmetTotal)}</td>
        <td>${formatPrice(row.healthTax)}</td>
        <td>${violating}</td>
      </tr>
    `;
  }

  function renderExternalityPanel(focus) {
    const hasFocus = focus && focus.id;
    return `
      <section class="rich-section rich-externality" aria-labelledby="rich-externality-title">
        <div class="rich-section-heading">
          <div>
            <p class="panel-kicker">RICH-3</p>
            <h2 id="rich-externality-title">空间外部性高亮</h2>
          </div>
          <span class="rich-note">点击子流域查看下游影响集</span>
        </div>
        <div id="downstream-impact" class="downstream-impact ${hasFocus ? '' : 'empty'}">
          ${hasFocus
            ? `<strong>${escapeHtml(focus.name)}</strong><span>影响下游 ${formatNumber(focus.downstreamCount, 0)} 个子流域，覆盖人口 ${formatPeople(focus.downstreamPopulation)}</span>`
            : '<span>尚未选中子流域</span>'}
        </div>
      </section>
    `;
  }

  function renderComparisonPanel(comparison, enabled, tradeVisuals) {
    const note = '本对比为交易效率（有交易 vs 自给自足）：工业在此增加，是因为交易让本地缺水的工业买到水，属效率改善，非健康税政策效应；健康税的环保效应见上方「有/无健康税对比」。模型推导，非真实成交。';
    return `
      <section class="rich-section rich-comparison" aria-labelledby="rich-comparison-title">
        <div class="rich-section-heading">
          <div>
            <p class="panel-kicker">RICH-3</p>
            <h2 id="rich-comparison-title">交易效率对比（有无交易）</h2>
          </div>
          <button type="button" id="no-market-toggle" class="region-tool ghost" aria-pressed="${enabled ? 'true' : 'false'}">${enabled ? '隐藏交易效率对照' : '生成交易效率对照'}</button>
        </div>
        <p class="rich-note block">${escapeHtml(note)}</p>
        ${comparison ? `
          <div class="comparison-scenario-labels">
            <span>有交易：当前选区与参数，缺水工业可通过交易买到水</span>
            <span>无交易：自给自足（各子流域只用自有水权）</span>
          </div>
          <div class="comparison-grid">
            <div><span>DALY 差值</span><strong>${formatSignedNumber(comparison.delta.dalyAvoided, 1)}</strong></div>
            <div><span>出清价差值</span><strong>${formatSignedPrice(comparison.delta.marketPrice)}</strong></div>
            <div><span>健康配水差值</span><strong>${formatSignedWater(comparison.delta.healthAllocation)}</strong></div>
            <div><span>缺口差值</span><strong>${formatSignedWater(comparison.delta.unmet)}</strong></div>
          </div>
          ${renderAllocationComparisonBars(tradeVisuals)}
        ` : '<div class="rich-empty">对照将在下一次求解后显示</div>'}
      </section>
    `;
  }

  function renderNoTaxComparisonPanel(comparison) {
    const note = '均含交易、只改变 τ：有健康税为当前参数，基线为 τ=0；Δ=当前−τ0。默认参数下政策已显效，判读方向为工业取水为负、环境流量与 DALY avoided 为正。';
    const headingNote = comparison
      ? '这是健康税政策的效应：工业取水↓、环境流量↑、DALY↑'
      : '等待 τ=0 有交易基线数据';
    return `
      <section class="rich-section rich-tax-comparison rich-tax-comparison-primary" aria-labelledby="rich-tax-comparison-title">
        <div class="rich-section-heading">
          <div>
            <p class="panel-kicker">主叙事</p>
            <h2 id="rich-tax-comparison-title">有/无健康税对比</h2>
          </div>
          <span class="rich-note">${escapeHtml(headingNote)}</span>
        </div>
        <p class="rich-note block">${escapeHtml(note)}</p>
        ${comparison ? `
          <div class="comparison-scenario-labels">
            <span>有健康税：当前 τ=${formatPercent(comparison.current.tau)}，交易开启</span>
            <span>无健康税：τ=0，交易仍开启，生态底线/气候/交易成本不变</span>
          </div>
          <div class="comparison-grid">
            <div><span>工业取水差（当前−τ0）</span><strong class="${directionalClass(comparison.delta.industryWithdrawal, 'negative')}">${formatSignedWater(comparison.delta.industryWithdrawal)}</strong></div>
            <div><span>环境流量差（当前−τ0）</span><strong class="${directionalClass(comparison.delta.environmentalFlow, 'positive')}">${formatSignedWater(comparison.delta.environmentalFlow)}</strong></div>
            <div><span>DALY avoided 差（当前−τ0）</span><strong class="${directionalClass(comparison.delta.dalyAvoided, 'positive')}">${formatSignedNumber(comparison.delta.dalyAvoided, 1)}</strong></div>
            <div><span>政策判读</span><strong class="${taxEffectClass(comparison.delta)}">${escapeHtml(taxEffectLabel(comparison.delta))}</strong></div>
          </div>
          ${renderTaxAllocationBars(comparison)}
        ` : '<div class="rich-empty">等待 main.js 传入 context.noTaxResult；该基线应为同一选区/生态底线/交易参数下 τ=0 的有交易求解结果。</div>'}
      </section>
    `;
  }

  function renderAllocationComparisonBars(tradeVisuals) {
    if (!tradeVisuals.hasComparison) {
      return '<div class="rich-empty trade-allocation-empty">交易效率部门配水柱将在对照求解后显示</div>';
    }
    const max = Math.max(
      ...tradeVisuals.reallocation.flatMap((item) => [item.withMarket, item.withoutMarket]),
      1
    );
    return `
      <div class="trade-allocation-chart" aria-label="三类取水用途有无交易配水对比柱">
        <div class="trade-chart-heading">
          <h3>交易效率配水对比柱</h3>
          <span>灰=自给自足（无交易），绿=有交易，Δ=有交易−自给自足</span>
        </div>
        <div class="allocation-bars">
          ${tradeVisuals.reallocation.map((item) => `
            <div class="allocation-bar-row">
              <div class="allocation-sector">${item.label}</div>
              <div class="allocation-pair">
                <span class="allocation-bar no-market" style="width:${barWidth(item.withoutMarket, max)}%"><em>${formatWater(item.withoutMarket)}</em></span>
                <span class="allocation-bar with-market" style="width:${barWidth(item.withMarket, max)}%"><em>${formatWater(item.withMarket)}</em></span>
              </div>
              <strong class="${item.delta >= 0 ? 'positive' : 'negative'}">${formatSignedWater(item.delta)}</strong>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function renderTaxAllocationBars(comparison) {
    const max = Math.max(
      ...comparison.sectors.flatMap((item) => [item.current, item.noTax]),
      1
    );
    return `
      <div class="trade-allocation-chart" aria-label="三类取水用途有无健康税配水对比柱">
        <div class="trade-chart-heading">
          <h3>健康税前后配水柱</h3>
          <span>灰=τ=0且有交易，绿=当前τ且有交易，Δ=当前−τ0</span>
        </div>
        <div class="allocation-bars">
          ${comparison.sectors.map((item) => `
            <div class="allocation-bar-row">
              <div class="allocation-sector">${item.label}</div>
              <div class="allocation-pair">
                <span class="allocation-bar no-market" style="width:${barWidth(item.noTax, max)}%"><em>${formatWater(item.noTax)}</em></span>
                <span class="allocation-bar with-market" style="width:${barWidth(item.current, max)}%"><em>${formatWater(item.current)}</em></span>
              </div>
              <strong class="${directionalClass(item.delta, item.key === 'industry' ? 'negative' : 'positive')}">${formatSignedWater(item.delta)}</strong>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function buildTradeVisuals(result, context, aggregate) {
    const tradeAggregate = context.tradeAggregate || (result && (result.tradeAggregate || result.trade_aggregate)) || {};
    const withMarket = allocationTotalsFromResult(result);
    const withoutMarket = allocationTotalsFromResult(
      context.autarkyResult || (result && result.autarkyResult) || (context.noMarketComparison && context.noMarketComparison.autarky)
    );
    const sectorReallocation = tradeAggregate.sectorReallocation;
    const hasComparison = sumSectorMap(withoutMarket) > 0;
    const rawDelta = Object.fromEntries(
      SECTORS.map(({ key }) => [key, withMarket[key] - withoutMarket[key]])
    );
    const delta = rawDelta;
    const reallocation = SECTORS.map((sector) => ({
      key: sector.key,
      label: sector.label,
      withMarket: withMarket[sector.key],
      withoutMarket: withoutMarket[sector.key],
      delta: delta[sector.key],
    }));
    const flows = getTradeFlows(result, context);
    const aggregateResult = result && result.aggregate ? result.aggregate : {};
    const unreallocated = resolveUnreallocatedFromAggregate(tradeAggregate, sectorReallocation, reallocation);
    const totalTraded = flows.reduce((sum, flow) => sum + numberOr(flow.volume, 0), 0);
    const tradeScope = resolveTradeScope(result, context, aggregate, tradeAggregate, flows, reallocation, unreallocated);
    return {
      sectors: SECTORS,
      reallocation,
      unreallocated,
      withMarket,
      withoutMarket,
      hasComparison,
      flows,
      params: aggregate.params || context.params || (result && result.params) || {},
      marketPrice: numberOr(result && result.marketPrice, numberOr(aggregateResult.marketPrice, 0)),
      totalTraded,
      aggregate: aggregateResult,
      tradeScope,
      tradeBasisNote: tradeAggregate.tradeBasisNote || '基于‘有交易 − 自给自足’的市场再配估算，模型推导，非真实成交记录',
      epsilon: 1e-6,
    };
  }

  function renderTradeScopeSummary(tradeScope) {
    if (!tradeScope) return '';
    // 边界入流只在圈选子区域时有定义：全域没有「区外流入」这个概念。
    // 此前一律显示「字段待接入」，会被误读为功能未完成。
    const boundaryText = tradeScope.boundaryKnown
      ? formatWater(tradeScope.boundaryInflow)
      : '全域口径不适用';
    const externalText = tradeScope.externalKnown
      ? formatWater(tradeScope.externalInflow)
      : '字段待接入';
    const internalText = tradeScope.internalKnown
      ? formatWater(tradeScope.internalReallocation)
      : '字段待接入';
    const retainedText = Number.isFinite(tradeScope.retainedWater)
      ? formatWater(tradeScope.retainedWater)
      : '字段待接入';
    return `
      <div class="rich-summary-grid" aria-label="交易范围与内外部水量拆分">
        <div><span>当前交易范围</span><strong>${escapeHtml(tradeScope.label)}</strong></div>
        <div><span>内部再配/交易流</span><strong>${internalText}</strong></div>
        <div><span>外部调入/过境水</span><strong>${externalText}</strong></div>
        <div><span>其中边界入流</span><strong>${boundaryText}</strong></div>
        <div><span>留河道/未取用</span><strong>${retainedText}</strong></div>
      </div>
      <p class="rich-note block">${escapeHtml(tradeScope.note)}</p>
    `;
  }

  function resolveTradeScope(result, context, aggregate, tradeAggregate, flows, reallocation, unreallocated) {
    const explicitMode = normalizeTradeScopeValue(findTradeScopeValue(result, context));
    const flagMode = normalizeTradeScopeFlag(findTradeScopeFlag(result, context));
    const mode = explicitMode || flagMode || 'external';
    const boundary = readBoundaryInflowVolume(result, context, tradeAggregate);
    const external = readExternalInflowVolume(result, context, aggregate, tradeAggregate);
    const internal = readInternalReallocationVolume(result, tradeAggregate, flows, reallocation);
    const label = mode === 'internal'
      ? '内部解决（边界入流关闭）'
      : '外部调水（含边界入流）';
    const note = mode === 'internal'
      ? '当前标注为内部解决：若模型提供 tradeScope/internal 或 boundaryInflowEnabled=false，则外部边界入流按关闭处理；市场流量解释为区域内部再配。'
      : '当前标注为外部调水：允许过境/边界入流作为补充；内部再配与外部调入分开列示，健康税结论仍看当前 τ 相对 τ=0 的差值。';
    return {
      mode,
      label,
      note,
      internalReallocation: internal.value,
      internalKnown: internal.known,
      externalInflow: external.value,
      externalKnown: external.known,
      boundaryInflow: boundary.value,
      boundaryKnown: boundary.known,
      retainedWater: numberOr(unreallocated, 0),
    };
  }

  function findTradeScopeValue(result, context) {
    const params = (context && context.params) || (result && result.params) || {};
    const scope = (context && context.scope) || (result && result.meta && result.meta.scope) || {};
    const meta = (result && result.meta) || {};
    const modelMeta = context && context.modelInput && context.modelInput.meta ? context.modelInput.meta : {};
    return firstDefined([
      context && context.tradeScope,
      context && context.waterTradeScope,
      params.tradeScope,
      params.waterTradeScope,
      params.trade_scope,
      params.marketScope,
      scope.tradeScope,
      scope.waterTradeScope,
      scope.trade_scope,
      scope.marketScope,
      scope.boundaryInflowMode,
      meta.tradeScope,
      meta.waterTradeScope,
      meta.trade_scope,
      meta.marketScope,
      meta.boundaryInflowMode,
      modelMeta.tradeScope,
      modelMeta.waterTradeScope,
      modelMeta.trade_scope,
      modelMeta.boundaryInflowMode,
    ]);
  }

  function findTradeScopeFlag(result, context) {
    const params = (context && context.params) || (result && result.params) || {};
    const scope = (context && context.scope) || (result && result.meta && result.meta.scope) || {};
    const meta = (result && result.meta) || {};
    const modelMeta = context && context.modelInput && context.modelInput.meta ? context.modelInput.meta : {};
    return firstDefined([
      params.allowExternalTransfers,
      params.externalTransferEnabled,
      params.boundaryInflowEnabled,
      scope.allowExternalTransfers,
      scope.externalTransferEnabled,
      scope.boundaryInflowEnabled,
      meta.allowExternalTransfers,
      meta.externalTransferEnabled,
      meta.boundaryInflowEnabled,
      modelMeta.allowExternalTransfers,
      modelMeta.externalTransferEnabled,
      modelMeta.boundaryInflowEnabled,
    ]);
  }

  function normalizeTradeScopeValue(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim().toLowerCase();
    if (!text) return null;
    if (/(internal|local|within|intra|self|closed|boundary[-_\s]?off|no[-_\s]?external|内部|边界入流关闭|关闭边界)/.test(text)) return 'internal';
    if (/(external|boundary|cross|open|with[-_\s]?external|region|外部|边界入流|调水|开启)/.test(text)) return 'external';
    return null;
  }

  function normalizeTradeScopeFlag(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'boolean') return value ? 'external' : 'internal';
    const text = String(value).trim().toLowerCase();
    if (!text) return null;
    if (['false', '0', 'off', 'closed', 'no'].includes(text)) return 'internal';
    if (['true', '1', 'on', 'open', 'yes'].includes(text)) return 'external';
    return null;
  }

  function readInternalReallocationVolume(result, tradeAggregate, flows, reallocation) {
    const aggregate = result && result.aggregate ? result.aggregate : {};
    const explicit = firstFinite([
      tradeAggregate && tradeAggregate.internalReallocation,
      tradeAggregate && tradeAggregate.internalReallocationVolume,
      tradeAggregate && tradeAggregate.internalTradeVolume,
      tradeAggregate && tradeAggregate.totalInternalTraded,
      aggregate.internalReallocation,
      aggregate.internalReallocationVolume,
      aggregate.internalTradeVolume,
    ]);
    if (explicit !== null) return { value: Math.max(0, explicit), known: true };
    const flowTotal = (Array.isArray(flows) ? flows : []).reduce((sum, flow) => sum + numberOr(flow.volume, 0), 0);
    if (flowTotal > 0) return { value: flowTotal, known: true };
    const totalReduce = (Array.isArray(reallocation) ? reallocation : []).reduce((sum, item) => item.delta < -1e-6 ? sum + Math.abs(item.delta) : sum, 0);
    const totalGain = (Array.isArray(reallocation) ? reallocation : []).reduce((sum, item) => item.delta > 1e-6 ? sum + item.delta : sum, 0);
    const fallback = Math.min(totalReduce, totalGain);
    return { value: fallback, known: totalReduce > 0 || totalGain > 0 };
  }

  function readExternalInflowVolume(result, context, aggregate, tradeAggregate) {
    const resultAggregate = result && result.aggregate ? result.aggregate : {};
    const meta = result && result.meta ? result.meta : {};
    const explicit = firstFinite([
      tradeAggregate && tradeAggregate.externalInflowVolume,
      tradeAggregate && tradeAggregate.externalTransferVolume,
      tradeAggregate && tradeAggregate.externalImportVolume,
      tradeAggregate && tradeAggregate.boundaryInflowTotal,
      resultAggregate.externalInflow,
      resultAggregate.externalInflowVolume,
      resultAggregate.externalTransferVolume,
      resultAggregate.boundaryInflowTotal,
      meta.externalInflowTotal,
      meta.boundaryInflowTotal,
      meta.scope && meta.scope.externalInflowTotal,
      meta.scope && meta.scope.boundaryInflowTotal,
    ]);
    if (explicit !== null) return { value: Math.max(0, explicit), known: true };
    const rows = primaryRowsForInflow(result, context);
    const fromRows = sumExternalInflowRows(rows);
    if (fromRows.known) return fromRows;
    const transit = firstFinite([
      aggregate && aggregate.totals && aggregate.totals.transitInflow,
      resultAggregate.transitInflow,
      resultAggregate.totalExternalInflow,
    ]);
    return transit === null
      ? { value: 0, known: false }
      : { value: Math.max(0, transit), known: true };
  }

  function readBoundaryInflowVolume(result, context, tradeAggregate) {
    const meta = result && result.meta ? result.meta : {};
    const scope = (context && context.scope) || meta.scope || {};
    const modelMeta = context && context.modelInput && context.modelInput.meta ? context.modelInput.meta : {};
    const explicit = firstFinite([
      tradeAggregate && tradeAggregate.boundaryInflowTotal,
      scope.boundaryInflowTotal,
      meta.boundaryInflowTotal,
      modelMeta.boundaryInflowTotal,
    ]);
    if (explicit !== null) return { value: Math.max(0, explicit), known: true };
    const fromMap = sumNumberMap(
      scope.boundaryInflowByNode
      || scope.boundaryInflowById
      || modelMeta.boundaryInflowByNode
      || modelMeta.boundaryInflowById
    );
    if (fromMap.known) return fromMap;
    const rows = primaryRowsForInflow(result, context);
    return sumBoundaryInflowRows(rows);
  }

  function primaryRowsForInflow(result, context) {
    if (context && context.modelInput && Array.isArray(context.modelInput.basins) && context.modelInput.basins.length) {
      return context.modelInput.basins;
    }
    if (result && Array.isArray(result.basinResults) && result.basinResults.length) return result.basinResults;
    if (result && result.raw && Array.isArray(result.raw.nodes)) return result.raw.nodes;
    return [];
  }

  function sumExternalInflowRows(rows) {
    let total = 0;
    let known = false;
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      const supply = supplyLike(row);
      const external = firstFinite([supply.externalInflow, row && row.externalInflow]);
      const mainstem = firstFinite([supply.mainstemInflow, row && row.mainstemInflow]);
      const boundary = firstFinite([supply.boundaryInflow, row && row.boundaryInflow]);
      if (external === null && mainstem === null && boundary === null) return;
      known = true;
      total += Math.max(numberOr(external, 0), numberOr(mainstem, 0) + numberOr(boundary, 0));
    });
    return { value: Math.max(0, total), known };
  }

  function sumBoundaryInflowRows(rows) {
    let total = 0;
    let known = false;
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      const supply = supplyLike(row);
      const boundary = firstFinite([supply.boundaryInflow, row && row.boundaryInflow]);
      if (boundary === null) return;
      known = true;
      total += numberOr(boundary, 0);
    });
    return { value: Math.max(0, total), known };
  }

  function supplyLike(row) {
    return (row && row.supply)
      || (row && row.modelNode && row.modelNode.supply)
      || (row && row.modelNode)
      || row
      || {};
  }

  function sumNumberMap(map) {
    if (!map || typeof map !== 'object') return { value: 0, known: false };
    const values = map instanceof Map ? Array.from(map.values()) : Object.values(map);
    let known = false;
    const value = values.reduce((sum, item) => {
      const number = Number(item);
      if (!Number.isFinite(number)) return sum;
      known = true;
      return sum + Math.max(0, number);
    }, 0);
    return { value, known };
  }

  function allocationTotalsFromResult(result) {
    const totals = sectorMap();
    if (!result) return totals;
    const direct = result.allocation || (result.aggregate && result.aggregate.allocation);
    if (direct && typeof direct === 'object') {
      const allocation = normalizeSectorMap(direct);
      SECTORS.forEach(({ key }) => {
        totals[key] += allocation[key];
      });
      return totals;
    }
    if (!Array.isArray(result.basinResults)) return totals;
    result.basinResults.forEach((item) => {
      const allocation = normalizeSectorMap(item && item.allocation);
      SECTORS.forEach(({ key }) => {
        totals[key] += allocation[key];
      });
    });
    return totals;
  }

  function getTradeFlows(result, context = {}) {
    const aggregate = context.tradeAggregate || (result && (result.tradeAggregate || result.trade_aggregate)) || {};
    const flows = Array.isArray(aggregate.tradeFlows)
      ? aggregate.tradeFlows
      : Array.isArray(aggregate.flows)
        ? aggregate.flows
        : Array.isArray(aggregate.marketFlows)
          ? aggregate.marketFlows
          : [];
    const basinById = new Map((Array.isArray(result && result.basinResults) ? result.basinResults : [])
      .map((item) => [String(item.id), item]));
    return flows.map((flow) => {
      const from = flow.from || flow.origin || flow.source || flow.seller;
      const to = flow.to || flow.target || flow.destination || flow.buyer;
      const fromId = from === undefined || from === null ? '' : String(from);
      const toId = to === undefined || to === null ? '' : String(to);
      const fromBasin = basinById.get(fromId);
      const toBasin = basinById.get(toId);
      const fromLabel = endpointLabel(flow, fromBasin, 'from', fromId);
      const toLabel = endpointLabel(flow, toBasin, 'to', toId);
      return {
        ...flow,
        from: fromId,
        to: toId,
        fromName: fromLabel.name,
        toName: toLabel.name,
        fromCode: fromLabel.code,
        toCode: toLabel.code,
        sector: flow.sector || flow.targetSector || flow.useSector,
        volume: numberOr(flow.volume || flow.amount || flow.q, 0),
        marketPrice: numberOr(flow.marketPrice || flow.price, 0),
        averageUnitCost: numberOr(flow.averageUnitCost || flow.unitCost || flow.price, 0),
      };
    }).filter((flow) => flow.from && flow.to && flow.volume > 0);
  }

  function renderTradeVisualModules(root, tradeVisuals) {
    const sankeyHost = root.querySelector('[data-trade-sankey]');
    const sectorLinks = buildSectorDispatchLinks(tradeVisuals.reallocation, tradeVisuals.unreallocated);
    if (sankeyHost && sectorLinks.length) {
      sankeyHost.innerHTML = renderSankeyFallback(tradeVisuals);
    } else if (sankeyHost && window.TradeSankey && typeof window.TradeSankey.render === 'function') {
      window.TradeSankey.render(sankeyHost, tradeVisuals);
    }
    const marketHost = root.querySelector('[data-market-chart]');
    if (marketHost && window.MarketChart && typeof window.MarketChart.render === 'function') {
      window.MarketChart.render(marketHost, tradeVisuals);
    }
  }

  function renderSankeyFallback(tradeVisuals) {
    let links = buildSectorDispatchLinks(tradeVisuals.reallocation, tradeVisuals.unreallocated);
    let mode = 'sector';
    if (!links.length) {
      links = buildFlowDispatchLinks(tradeVisuals.flows);
      mode = 'flow';
    }
    if (!links.length) {
      return '<div class="rich-empty trade-chart-empty">部门间净再配很小，暂无可绘制桑基流</div>';
    }
    const isFlowMode = mode === 'flow';
    const leftTitle = isFlowMode ? '净卖出区域' : '减用部门';
    const rightTitle = isFlowMode ? '净买入区域' : '增配部门';
    const ariaLabel = isFlowMode ? '区域水权交易流向桑基图' : '部门减用到增配的模型推导调度桑基图';
    const hasUnreallocated = links.some((link) => link.to && link.to.isUnreallocated);
    const hasSupplementalSource = links.some((link) => link.from && link.from.isSupplementalSource);
    const left = links.reduce((map, link) => ({ ...map, [link.from.key]: link.from }), {});
    const right = links.reduce((map, link) => ({ ...map, [link.to.key]: link.to }), {});
    const leftNodes = Object.values(left);
    const rightNodes = Object.values(right);
    const unreallocatedNode = hasUnreallocated ? rightNodes.find((node) => node.isUnreallocated) : null;
    const footnote = isFlowMode
      ? '基于‘有交易 − 自给自足’的市场再配估算，模型推导，非真实成交记录；带宽按卖方→买方水量。'
      : `基于‘有交易 − 自给自足’的市场再配估算，模型推导，非真实成交记录；带宽按部门净再配水量${hasUnreallocated ? `；减用的水未必全部再配，差额 ${formatWater(nodeSideValue(unreallocatedNode, 'right'))} ${UNREALLOCATED_LABEL}` : ''}${hasSupplementalSource ? `；增配差额来自“${SUPPLEMENTAL_SOURCE_LABEL}”` : ''}。`;
    const maxValue = Math.max(...links.map((link) => link.value), 1);
    const nodeY = (nodes, index) => 54 + index * (190 / Math.max(nodes.length - 1, 1));
    const leftPositions = Object.fromEntries(leftNodes.map((node, index) => [node.key, nodeY(leftNodes, index)]));
    const rightPositions = Object.fromEntries(rightNodes.map((node, index) => [node.key, nodeY(rightNodes, index)]));
    return `
      <svg class="trade-sankey-svg" viewBox="0 0 620 310" role="img" aria-label="${ariaLabel}">
        <text x="24" y="24" class="chart-title">${leftTitle}</text>
        <text x="502" y="24" class="chart-title">${rightTitle}</text>
        ${links.map((link) => {
          const y1 = leftPositions[link.from.key];
          const y2 = rightPositions[link.to.key];
          const width = 3 + (link.value / maxValue) * 24;
          const title = isFlowMode
            ? `${escapeHtml(link.from.label)}卖出 ${formatWater(link.value)} → ${escapeHtml(link.to.label)}买入`
            : link.to.isUnreallocated
              ? `${escapeHtml(link.from.label)}减用 ${formatWater(link.value)} → ${UNREALLOCATED_LABEL}`
              : link.from.isSupplementalSource
                ? `${SUPPLEMENTAL_SOURCE_LABEL} ${formatWater(link.value)} → ${escapeHtml(link.to.label)}增配`
              : `${escapeHtml(link.from.label)}减用 ${formatWater(link.value)} → ${escapeHtml(link.to.label)}增配`;
          return `<path class="sankey-link" d="M 118 ${y1} C 260 ${y1}, 360 ${y2}, 502 ${y2}" stroke-width="${width.toFixed(2)}"><title>${title}</title></path>`;
        }).join('')}
        ${leftNodes.map((node) => renderSankeyNode(28, leftPositions[node.key], node, 'reduce')).join('')}
        ${rightNodes.map((node) => renderSankeyNode(506, rightPositions[node.key], node, node.isUnreallocated ? 'gain unreallocated' : 'gain')).join('')}
        <text x="24" y="292" class="chart-footnote">${footnote}</text>
      </svg>
    `;
  }

  function renderSankeyNode(x, y, node, tone) {
    const width = node.isUnreallocated ? 108 : 86;
    return `
      <g class="sankey-node ${tone}">
        <rect x="${x}" y="${y - 17}" width="${width}" height="34" rx="7"></rect>
        <text x="${x + 10}" y="${y - 2}">${escapeHtml(node.label)}</text>
        <text x="${x + 10}" y="${y + 12}" class="node-value">${formatWater(Math.abs(numberOr(node.delta, node.value || 0)))}</text>
      </g>
    `;
  }

  function buildSectorDispatchLinks(reallocation, explicitUnreallocated) {
    const reducers = reallocation.filter((item) => item.delta < -1e-6);
    const gainers = reallocation.filter((item) => item.delta > 1e-6);
    const totalReduce = reducers.reduce((sum, item) => sum + Math.abs(item.delta), 0);
    const totalGain = gainers.reduce((sum, item) => sum + item.delta, 0);
    const unreallocated = resolveUnreallocatedValue(explicitUnreallocated, totalReduce, totalGain);
    const supplemental = Math.max(0, totalGain - totalReduce);
    const sources = supplemental > 1e-6
      ? [...reducers, {
        key: 'supplemental-source',
        label: SUPPLEMENTAL_SOURCE_LABEL,
        delta: supplemental,
        value: supplemental,
        isSupplementalSource: true,
      }]
      : reducers;
    const targets = unreallocated > 1e-6
      ? [...gainers, {
        key: 'unreallocated',
        label: UNREALLOCATED_LABEL,
        delta: unreallocated,
        value: unreallocated,
        isUnreallocated: true,
      }]
      : gainers;
    const totalSource = sources.reduce((sum, item) => sum + Math.max(0, item.isSupplementalSource ? item.delta : Math.abs(item.delta)), 0);
    const totalTarget = targets.reduce((sum, item) => sum + Math.max(0, item.delta), 0);
    if (!totalSource || !totalTarget) return [];
    return sources.flatMap((from) => targets.map((to) => ({
      from,
      to,
      value: (from.isSupplementalSource ? from.delta : Math.abs(from.delta)) * (to.delta / totalTarget),
    }))).filter((link) => link.value > 1e-6);
  }

  function buildFlowDispatchLinks(flows) {
    const buckets = new Map();
    (Array.isArray(flows) ? flows : []).forEach((flow) => {
      const from = String(flow.from || flow.origin || flow.source || flow.seller || '');
      const to = String(flow.to || flow.target || flow.destination || flow.buyer || '');
      const volume = numberOr(flow.volume || flow.amount || flow.q, 0);
      if (!from || !to || volume <= 0) return;
      const key = `${from}->${to}`;
      if (!buckets.has(key)) {
        const fromCode = firstText([flow.fromCode, flow.originCode, flow.sourceCode, flow.sellerCode, from]);
        const toCode = firstText([flow.toCode, flow.targetCode, flow.destinationCode, flow.buyerCode, to]);
        buckets.set(key, {
          from: {
            key: `from:${from}`,
            label: chooseDisplayName([flow.fromName, flow.originName, flow.sourceName, flow.sellerName, from], fromCode),
            value: 0,
          },
          to: {
            key: `to:${to}`,
            label: chooseDisplayName([flow.toName, flow.targetName, flow.destinationName, flow.buyerName, to], toCode),
            value: 0,
          },
          value: 0,
        });
      }
      const bucket = buckets.get(key);
      bucket.value += volume;
      bucket.from.value += volume;
      bucket.to.value += volume;
    });
    return Array.from(buckets.values())
      .sort((a, b) => b.value - a.value)
      .slice(0, 6);
  }

  function renderMarketChartFallback(tradeVisuals) {
    const price = numberOr(tradeVisuals.marketPrice, 0);
    const steps = buildDemandSteps(tradeVisuals);
    const maxQty = Math.max(steps.reduce((sum, step) => sum + step.quantity, 0), tradeVisuals.totalTraded, 1);
    const maxPrice = Math.max(price, ...steps.map((step) => step.price), 0.1);
    let x = 62;
    const yBase = 238;
    const width = 500;
    const height = 182;
    const stepPaths = steps.map((step) => {
      const x1 = x;
      const x2 = x + (step.quantity / maxQty) * width;
      const y = yBase - (step.price / maxPrice) * height;
      x = x2;
      return `<path class="market-demand-step" d="M ${x1.toFixed(1)} ${y.toFixed(1)} H ${x2.toFixed(1)} V ${yBase.toFixed(1)}"><title>${escapeHtml(step.label)} 需求阶梯 ${formatPrice(step.price)}</title></path>`;
    }).join('');
    const tradeX = 62 + (Math.min(tradeVisuals.totalTraded || maxQty * 0.56, maxQty) / maxQty) * width;
    const priceY = yBase - (price / maxPrice) * height;
    const tauText = formatPercent(tradeVisuals.params && tradeVisuals.params.tau);
    return `
      <svg class="market-chart-svg" viewBox="0 0 620 300" role="img" aria-label="市场出清教学示意图">
        <line class="axis" x1="62" y1="238" x2="574" y2="238"></line>
        <line class="axis" x1="62" y1="238" x2="62" y2="38"></line>
        ${stepPaths}
        <path class="market-supply-step" d="M 80 232 H ${tradeX.toFixed(1)} V 58 H 560"></path>
        <line class="market-price-line" x1="62" y1="${priceY.toFixed(1)}" x2="574" y2="${priceY.toFixed(1)}"></line>
        <line class="market-clear-line" x1="${tradeX.toFixed(1)}" y1="238" x2="${tradeX.toFixed(1)}" y2="${priceY.toFixed(1)}"></line>
        <circle class="market-clear-point" cx="${tradeX.toFixed(1)}" cy="${priceY.toFixed(1)}" r="5"></circle>
        <text x="72" y="28" class="chart-title">供需机制示意，τ=${tauText}</text>
        <text x="${Math.min(tradeX + 8, 444).toFixed(1)}" y="${Math.max(priceY - 10, 50).toFixed(1)}" class="market-label">出清价 ${formatPrice(price)}</text>
        <text x="62" y="266" class="axis-label">累计水量</text>
        <text x="14" y="52" class="axis-label">单位价</text>
        <text x="62" y="286" class="chart-footnote">教学示意，非逐笔撮合曲线；模型为网络调度，本图用于解释价格机制。</text>
      </svg>
    `;
  }

  function buildDemandSteps(tradeVisuals) {
    const weights = { urban: 1.16, agri: 0.56, industry: 0.48 };
    const tau = numberOr(tradeVisuals.params && tradeVisuals.params.tau, 0);
    return SECTORS.map((sector) => {
      const quantity = Math.max(tradeVisuals.withMarket[sector.key], tradeVisuals.withoutMarket[sector.key], 1);
      const healthShift = sector.key === 'industry' ? -0.22 * tau : sector.key === 'urban' ? 0.18 * tau : 0.03 * tau;
      return {
        key: sector.key,
        label: sector.label,
        quantity,
        price: Math.max(0.03, weights[sector.key] + healthShift),
      };
    }).sort((a, b) => b.price - a.price);
  }

  function bindTableInteractions(root) {
    root.querySelectorAll('[data-sort-key]').forEach((button) => {
      button.addEventListener('click', () => {
        const key = button.dataset.sortKey;
        if (state.sortKey === key) {
          state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
          state.sortKey = key;
          state.sortDirection = key === 'name' ? 'asc' : 'desc';
        }
        if (window.ResearchApp && typeof window.ResearchApp.render === 'function') {
          window.ResearchApp.render();
        }
      });
    });

    root.querySelectorAll('[data-basin-id]').forEach((row) => {
      const select = () => {
        window.dispatchEvent(new CustomEvent('research:basin-select', {
          detail: { id: row.dataset.basinId, force: true },
        }));
      };
      row.addEventListener('click', select);
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          select();
        }
      });
    });
  }

  function sortRows(rows) {
    const direction = state.sortDirection === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (state.sortKey === 'name') return direction * String(a.name).localeCompare(String(b.name), 'zh-CN');
      if (state.sortKey === 'incentive') {
        return direction * ((a.incentiveCompatible === b.incentiveCompatible) ? 0 : a.incentiveCompatible ? -1 : 1);
      }
      return direction * (numberOr(a[state.sortKey], 0) - numberOr(b[state.sortKey], 0));
    });
  }

  function normalizeSectorMap(map) {
    if (Array.isArray(map)) {
      return Object.fromEntries(SECTORS.map(({ key }) => {
        const item = map.find((row) => row && row.key === key);
        return [key, item ? numberOr(firstFinite([item.delta, item.value, item.amount, item.volume]), 0) : 0];
      }));
    }
    const source = map && typeof map === 'object' ? map : {};
    return Object.fromEntries(SECTORS.map(({ key }) => [key, numberOr(source[key], 0)]));
  }

  function differenceSectorMap(a, b) {
    return Object.fromEntries(SECTORS.map(({ key }) => [key, Math.max(0, numberOr(a[key], 0) - numberOr(b[key], 0))]));
  }

  function sectorMap() {
    return Object.fromEntries(SECTORS.map(({ key }) => [key, 0]));
  }

  function sumSectorMap(map) {
    return SECTORS.reduce((sum, { key }) => sum + numberOr(map && map[key], 0), 0);
  }

  function sumAbsSectorMap(map) {
    return SECTORS.reduce((sum, { key }) => sum + Math.abs(numberOr(map && map[key], 0)), 0);
  }

  function buildNoTaxComparison(currentResult, context = {}) {
    const noTaxResult = context.noTaxResult || context.noTaxComparisonResult || (currentResult && currentResult.noTaxResult);
    if (!currentResult || !noTaxResult) return null;
    const currentTotals = allocationTotalsFromResult(currentResult);
    const noTaxTotals = allocationTotalsFromResult(noTaxResult);
    const currentEnvironment = aggregateEnvironmentFlow(currentResult, context.modelInput);
    const noTaxEnvironment = aggregateEnvironmentFlow(noTaxResult, context.modelInput);
    const currentDalyAvoided = getDalyAvoided(currentResult);
    const noTaxDalyAvoided = getDalyAvoided(noTaxResult);
    const dalyAvoidedDelta = currentDalyAvoided - noTaxDalyAvoided;
    const tau = firstFinite([
      context.params && context.params.tau,
      currentResult.params && currentResult.params.tau,
      currentResult.aggregate && currentResult.aggregate.params && currentResult.aggregate.params.tau,
    ]);
    return {
      current: {
        tau: tau === null ? 0 : tau,
        allocation: currentTotals,
        environmentalFlow: currentEnvironment.environmentalFlow,
        dalyAvoided: currentDalyAvoided,
      },
      noTax: {
        tau: 0,
        allocation: noTaxTotals,
        environmentalFlow: noTaxEnvironment.environmentalFlow,
        dalyAvoided: noTaxDalyAvoided,
      },
      delta: {
        industryWithdrawal: currentTotals.industry - noTaxTotals.industry,
        environmentalFlow: currentEnvironment.environmentalFlow - noTaxEnvironment.environmentalFlow,
        dalyAvoided: dalyAvoidedDelta,
        dalyBurden: -dalyAvoidedDelta,
      },
      sectors: SECTORS.map((sector) => ({
        key: sector.key,
        label: sector.label,
        current: currentTotals[sector.key],
        noTax: noTaxTotals[sector.key],
        delta: currentTotals[sector.key] - noTaxTotals[sector.key],
      })),
    };
  }

  function aggregateEnvironmentFlow(result, modelInput) {
    const modelBasins = modelInput && Array.isArray(modelInput.basins) ? modelInput.basins : [];
    const modelById = new Map(modelBasins.map((basin) => [String(basin.id), basin]));
    const rows = result && Array.isArray(result.basinResults) ? result.basinResults : [];
    if (!rows.length && result && result.raw && Array.isArray(result.raw.nodes)) {
      return result.raw.nodes.reduce((totals, node) => addEnvironmentTotals(totals, readEnvironmentalFlow(node, modelById.get(String(node.id)))), emptyEnvironmentTotals());
    }
    return rows.reduce((totals, row) => addEnvironmentTotals(totals, readEnvironmentalFlow(row, modelById.get(String(row.id)))), emptyEnvironmentTotals());
  }

  function emptyEnvironmentTotals() {
    return {
      ecoBaseFlow: 0,
      inStreamFlow: 0,
      ecoSurplus: 0,
      environmentalFlow: 0,
      environmentalRowsWithFields: 0,
    };
  }

  function addEnvironmentTotals(totals, environment) {
    totals.ecoBaseFlow += environment.ecoBaseFlow;
    totals.inStreamFlow += environment.inStreamFlow;
    totals.ecoSurplus += environment.ecoSurplus;
    totals.environmentalFlow += environment.environmentalFlow;
    totals.environmentalRowsWithFields += environment.hasEnvironmentalFields ? 1 : 0;
    return totals;
  }

  function readEnvironmentalFlow(primary, secondary) {
    const sources = [
      primary,
      primary && primary.environment,
      primary && primary.ecoFlow,
      primary && primary.modelNode,
      primary && primary.supply,
      secondary,
      secondary && secondary.environment,
      secondary && secondary.ecoFlow,
      secondary && secondary.modelNode,
      secondary && secondary.supply,
    ];
    const ecoBaseFlow = firstFiniteFromSources(sources, ['ecoBaseFlow', 'environmentalBaseFlow', 'baseFlow']);
    const inStreamFlow = firstFiniteFromSources(sources, ['inStreamFlow', 'environmentalFlow', 'qOutflow', 'outflow']);
    const ecoSurplus = firstFiniteFromSources(sources, ['ecoSurplus', 'environmentalSurplus']);
    const cleanBase = Math.max(0, ecoBaseFlow === null ? 0 : ecoBaseFlow);
    const cleanInStream = Math.max(0, inStreamFlow === null ? 0 : inStreamFlow);
    const cleanSurplus = Math.max(0, ecoSurplus === null ? Math.max(0, cleanInStream - cleanBase) : ecoSurplus);
    const hasEnvironmentalFields = ecoBaseFlow !== null || inStreamFlow !== null || ecoSurplus !== null;
    return {
      ecoBaseFlow: cleanBase,
      inStreamFlow: cleanInStream,
      ecoSurplus: cleanSurplus,
      environmentalFlow: cleanBase + cleanSurplus,
      hasEnvironmentalFields,
    };
  }

  function firstFiniteFromSources(sources, keys) {
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      for (const key of keys) {
        const value = firstFinite([source[key]]);
        if (value !== null) return value;
      }
    }
    return null;
  }

  function getDalyAvoided(result) {
    const aggregate = result && result.aggregate ? result.aggregate : {};
    return numberOr(
      aggregate.dalyAvoided ?? aggregate.totalDalyAvoided ?? aggregate.dalyAvoidance,
      sumBy(result && result.basinResults, 'dalyAvoided')
    );
  }

  function normalizeTauPoints(response) {
    const points = Array.isArray(response)
      ? response
      : Array.isArray(response && response.points)
        ? response.points
        : [];
    return points.map((point) => ({
      tau: numberOr(point.tau, 0),
      industryWithdrawal: numberOr(point.industryWithdrawal ?? point.industry ?? point.allocationIndustry, 0),
      environmentalFlow: numberOr(point.environmentalFlow ?? point.inStreamFlow, 0),
      dalyAvoided: numberOr(
        point.dalyAvoided ?? point.totalDalyAvoided ?? point.dalyAvoidance,
        -numberOr(point.dalyBurden ?? point.daly, 0)
      ),
    })).filter((point) => Number.isFinite(point.tau));
  }

  function renderTauIntegrationHint() {
    return `
      <div class="rich-empty trade-chart-empty">
        <span>等待 τ 扫描数据。集成点：加载 research/js/tauResponseChart.js 后，在 main.js 用 TauResponseChart.scanTau({ modelInput, params, solveModelInput }) 生成 context.tauResponse。</span>
      </div>
    `;
  }

  function renderTauResponseSvg(points) {
    const normalized = points.slice().sort((a, b) => a.tau - b.tau);
    const metrics = [
      { key: 'industryWithdrawal', label: '工业取水', color: '#d9480f' },
      { key: 'environmentalFlow', label: '环境流量', color: '#1f7a8c' },
      { key: 'dalyAvoided', label: 'DALY avoided', color: '#6d5bd0' },
    ];
    const minTau = Math.min(...normalized.map((point) => point.tau), 0);
    const maxTau = Math.max(...normalized.map((point) => point.tau), 0.5);
    const width = 500;
    const height = 174;
    const left = 62;
    const top = 42;
    const bottom = top + height;
    const scaleX = (tau) => left + ((tau - minTau) / Math.max(maxTau - minTau, 1e-9)) * width;
    const lines = metrics.map((metric) => {
      const values = normalized.map((point) => point[metric.key]);
      const min = Math.min(...values);
      const max = Math.max(...values);
      const scaleY = (value) => bottom - ((value - min) / Math.max(max - min, 1e-9)) * height;
      const path = normalized.map((point, index) => `${index ? 'L' : 'M'} ${scaleX(point.tau).toFixed(1)} ${scaleY(point[metric.key]).toFixed(1)}`).join(' ');
      return `<path d="${path}" fill="none" stroke="${metric.color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><title>${metric.label}</title></path>`;
    }).join('');
    return `
      <svg class="market-chart-svg tau-response-svg" viewBox="0 0 620 300" role="img" aria-label="τ响应曲线">
        <line class="axis" x1="62" y1="238" x2="574" y2="238"></line>
        <line class="axis" x1="62" y1="238" x2="62" y2="38"></line>
        ${lines}
        <text x="72" y="28" class="chart-title">τ 响应：工业取水、环境流量、DALY avoided</text>
        <text x="62" y="266" class="axis-label">τ（健康税率）</text>
        <text x="14" y="58" class="axis-label">归一化趋势</text>
        <text x="62" y="286" class="chart-footnote">橙=工业取水，蓝=环境流量，紫=DALY avoided；各线独立归一化以突出平滑方向。</text>
      </svg>
    `;
  }

  function sumBy(rows, key) {
    return (Array.isArray(rows) ? rows : []).reduce((sum, item) => sum + numberOr(item && item[key], 0), 0);
  }

  function resolveUnreallocatedFromAggregate(aggregate, sectorReallocation, reallocation) {
    const explicit = firstFinite([
      aggregate && aggregate.unreallocated,
      aggregate && aggregate.unreallocatedWater,
      sectorReallocation && !Array.isArray(sectorReallocation) && sectorReallocation.unreallocated,
      sectorReallocation && !Array.isArray(sectorReallocation) && sectorReallocation.unreallocatedWater,
      Array.isArray(sectorReallocation) && readUnreallocatedFromRows(sectorReallocation),
    ]);
    const totalReduce = reallocation.reduce((sum, item) => item.delta < -1e-6 ? sum + Math.abs(item.delta) : sum, 0);
    const totalGain = reallocation.reduce((sum, item) => item.delta > 1e-6 ? sum + item.delta : sum, 0);
    const fallback = Math.max(0, totalReduce - totalGain);
    return explicit === null ? fallback : Math.max(fallback, explicit);
  }

  function resolveUnreallocatedValue(explicitUnreallocated, totalReduce, totalGain) {
    const fallback = Math.max(0, totalReduce - totalGain);
    const explicit = firstFinite([explicitUnreallocated]);
    return explicit === null ? fallback : Math.max(fallback, explicit);
  }

  function selectTransitInflow(...sources) {
    for (const source of sources) {
      const supply = source || {};
      const selected = firstPositiveFinite([
        supply.externalInflow,
        supply.mainstemInflow,
        supply.boundaryInflow,
      ]);
      if (selected !== null) return selected;
    }
    return 0;
  }

  function firstPositiveFinite(candidates) {
    const found = (candidates || []).find((value) => {
      const number = Number(value);
      return Number.isFinite(number) && number > 0;
    });
    return found === undefined ? null : Number(found);
  }

  function nodeSideValue(node, side) {
    if (!node) return 0;
    if (node.isUnreallocated || node.isSupplementalSource) {
      return Math.abs(numberOr(node.value, node.delta || 0));
    }
    return side === 'left'
      ? Math.abs(numberOr(node.delta, node.value || 0))
      : Math.max(0, numberOr(node.delta, node.value || 0));
  }

  function firstFinite(candidates) {
    const found = (candidates || []).find((value) => {
      if (value === undefined || value === null || value === '' || value === false) return false;
      return Number.isFinite(Number(value));
    });
    return found === undefined ? null : Number(found);
  }

  function firstDefined(candidates) {
    const found = (candidates || []).find((value) => value !== undefined && value !== null && value !== '');
    return found === undefined ? null : found;
  }

  function directionalClass(value, goodDirection) {
    const number = Number(value) || 0;
    if (Math.abs(number) <= 1e-9) return 'neutral';
    return (goodDirection === 'negative' ? number < 0 : number > 0) ? 'positive' : 'negative';
  }

  function taxEffectClass(delta) {
    return taxEffectIsVisible(delta) ? 'positive' : 'neutral';
  }

  function taxEffectLabel(delta) {
    return taxEffectIsVisible(delta) ? '默认已显效' : '等待确认';
  }

  function taxEffectIsVisible(delta) {
    const industry = Number(delta && delta.industryWithdrawal) || 0;
    const environment = Number(delta && delta.environmentalFlow) || 0;
    const daly = Number(delta && delta.dalyAvoided) || 0;
    return industry < -1e-9 && environment > 1e-9 && daly > 1e-9;
  }

  function readUnreallocatedFromRows(rows) {
    const item = (rows || []).find((row) => row && (
      row.key === 'unreallocated'
      || row.key === 'retained'
      || row.label === UNREALLOCATED_LABEL
    ));
    return item ? firstFinite([item.delta, item.value, item.amount, item.volume]) : null;
  }

  function barWidth(value, max) {
    return Math.max(1, Math.min(100, (numberOr(value, 0) / Math.max(max, 1)) * 100)).toFixed(1);
  }

  function numberOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function displayNameForItem(primary, secondary, fallback) {
    const code = technicalCodeFor(primary, secondary, fallback);
    return chooseDisplayName([
      primary && primary.name,
      primary && primary.nameZh,
      primary && primary.label,
      primary && primary.displayName,
      secondary && secondary.name,
      secondary && secondary.nameZh,
      secondary && secondary.label,
      secondary && secondary.displayName,
      fallback,
    ], code);
  }

  function technicalCodeFor(primary, secondary, fallback) {
    return firstText([
      primary && primary.code,
      primary && primary.pfafId,
      primary && primary.pfaf_id,
      secondary && secondary.code,
      secondary && secondary.pfafId,
      secondary && secondary.pfaf_id,
      fallback,
    ]);
  }

  function endpointLabel(flow, basin, side, fallbackId) {
    const isFrom = side === 'from';
    const basinCode = technicalCodeFor(basin, null, fallbackId);
    const code = firstText(isFrom
      ? [flow && flow.fromCode, flow && flow.originCode, flow && flow.sourceCode, flow && flow.sellerCode, basinCode, fallbackId]
      : [flow && flow.toCode, flow && flow.targetCode, flow && flow.destinationCode, flow && flow.buyerCode, basinCode, fallbackId]);
    const name = chooseDisplayName(isFrom
      ? [flow && flow.fromName, flow && flow.originName, flow && flow.sourceName, flow && flow.sellerName, basin && basin.name, basin && basin.nameZh, basin && basin.label, fallbackId]
      : [flow && flow.toName, flow && flow.targetName, flow && flow.destinationName, flow && flow.buyerName, basin && basin.name, basin && basin.nameZh, basin && basin.label, fallbackId], code);
    return { name, code };
  }

  function chooseDisplayName(candidates, fallbackCode) {
    const values = (candidates || []).map((value) => firstText([value])).filter(Boolean);
    const fallback = firstText([fallbackCode, '--']);
    const preferred = values.find((value) => !isTechnicalLabel(value) && value !== fallback);
    return preferred || values[0] || fallback;
  }

  function firstText(candidates) {
    const found = (candidates || []).find((value) => value !== undefined && value !== null && String(value).trim() !== '');
    return found === undefined ? '' : String(found);
  }

  function isTechnicalLabel(value) {
    const label = String(value || '').trim();
    return /^PF[_-]?\d+$/i.test(label) || /^\d{5,}$/.test(label);
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

  function formatOptionalPercent(value) {
    const number = Number(value);
    return Number.isFinite(number) ? formatPercent(number) : '待接入';
  }

  function formatWater(value) {
    const number = Number(value) || 0;
    const sign = number < 0 ? '-' : '';
    const abs = Math.abs(number);
    if (abs >= 100000000) return `${sign}${(abs / 100000000).toFixed(2)}亿m³`;
    if (abs >= 10000) return `${sign}${(abs / 10000).toFixed(1)}万m³`;
    return `${sign}${Math.round(abs)}m³`;
  }

  function formatSignedWater(value) {
    const number = Number(value) || 0;
    return `${number >= 0 ? '+' : ''}${formatWater(number)}`;
  }

  function formatPrice(value) {
    return `${(Number(value) || 0).toFixed(3)}元/m³`;
  }

  function formatSignedPrice(value) {
    const number = Number(value) || 0;
    return `${number >= 0 ? '+' : ''}${number.toFixed(3)}元/m³`;
  }

  function formatSignedNumber(value, digits) {
    const number = Number(value) || 0;
    return `${number >= 0 ? '+' : ''}${formatNumber(number, digits)}`;
  }

  function formatPeople(value) {
    const number = Number(value) || 0;
    if (number >= 10000) return `${(number / 10000).toFixed(1)}万人`;
    return `${Math.round(number)}人`;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  const api = {
    update,
    aggregateRichData,
  };

  if (typeof window !== 'undefined') {
    window.ResearchRichPanels = api;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      aggregateRichData,
      _internals: { normalizeSectorMap, differenceSectorMap, sumSectorMap },
    };
  }
})();
