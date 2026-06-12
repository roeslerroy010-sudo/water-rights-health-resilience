// model.js — 水权市场模拟器核心计算引擎
// 计算：水量分配、市场均衡价格、健康影响、激励相容性

// 计算气候冲击与交易摩擦后的有效可用水量
function computeEffectiveWater(params) {
  const climate = CLIMATE_SCENARIOS[params.climateScenario];
  const trading = TRADING_COSTS[params.tradingCost];
  const available = BASIN_INFO.tradableWater * climate.waterAvailability;
  return {
    total: available,
    healthReserved: available * params.healthFloor,
    tradable: available * (1 - params.healthFloor) * trading.multiplier,
    climateLabel: climate.label,
    droughtFreq: climate.droughtFrequency,
  };
}

// 计算市场出清价格（元/m³）
function computeMarketPrice(water) {
  const utilization = water.tradable / BASIN_INFO.tradableWater;
  const basePrice = 0.35; // 基准价格（元/m³）
  const scarcityPremium = Math.max(0, (1 - utilization)) * 0.50;
  return Math.round((basePrice + scarcityPremium) * 100) / 100;
}

// 计算单个用水户的健康税
function computeHealthTax(user, params) {
  const hLoss = HEALTH_LOSS_COEFF[user.type] ?? 0.25;
  return Math.round(params.healthTaxRate * hLoss * DOSE_RESPONSE.baselineDALY / 100 * 1000) / 1000;
}

// 完整模拟：给定参数运行模型
function runSimulation(params) {
  const water = computeEffectiveWater(params);
  const marketPrice = computeMarketPrice(water);

  // 逐户计算结果
  const userResults = WATER_USERS.map(user => {
    const healthTax = computeHealthTax(user, params);
    const effectiveAllocation = user.type === 'health'
      ? (user.allocation / 100) * water.total   // 健康用户获得优先配额
      : (user.allocation / 100) * water.tradable;

    const healthImpact = user.healthWeight * effectiveAllocation * (1 - params.healthTaxRate * (HEALTH_LOSS_COEFF[user.type] ?? 0.25));
    const tradePrice = marketPrice + healthTax;

    return {
      ...user,
      healthTax,
      effectiveAllocation: Math.round(effectiveAllocation * 100) / 100,
      healthImpact: Math.round(healthImpact * 100) / 100,
      tradePrice: Math.round(tradePrice * 100) / 100,
      totalCost: Math.round(effectiveAllocation * tradePrice * 100) / 100,
    };
  });

  // 汇总健康指标
  const totalHealthImpact = userResults.reduce((sum, u) => sum + Math.max(0, u.healthImpact), 0);
  const baselineDALY = DOSE_RESPONSE.baselineDALY * BASIN_INFO.population / 100000;
  const dalyAvoided = Math.round(baselineDALY * (totalHealthImpact / (WATER_USERS.length * 10)));
  const diseaseReduction = Math.min(35, Math.round((params.healthTaxRate * 80 + params.healthFloor * 40) * 10) / 10);
  const economicNPV = Math.round(dalyAvoided * DOSE_RESPONSE.valuePerDALY / 1000000) / 100; // 亿元

  // 健康配额缺口
  const healthAllocation = userResults
    .filter(u => u.type === 'health')
    .reduce((s, u) => s + u.effectiveAllocation, 0);
  const healthQuotaGap = Math.round(water.healthReserved - healthAllocation);

  // 激励相容性检验
  // 容忍度随健康配额下降而收紧——保护越弱，越容易偏离规则
  const tolerance = 1 + (params.healthFloor * 0.5); // 10%配额→1.05, 40%配额→1.20
  const incentiveCompatible = userResults.every(u => {
    if (u.type === 'health') return true; // 健康用户始终相容
    return u.totalCost <= u.effectiveAllocation * marketPrice * tolerance;
  });
  const violatingUsers = userResults.filter(u => {
    if (u.type === 'health') return false;
    return u.totalCost > u.effectiveAllocation * marketPrice * tolerance;
  }).map(u => u.name);

  return {
    params,
    water,
    marketPrice,
    userResults,
    health: {
      totalHealthImpact: Math.round(totalHealthImpact * 100) / 100,
      baselineDALY: Math.round(baselineDALY),
      dalyAvoided,
      diseaseReduction,
      economicNPV,
      healthQuotaGap,
    },
    incentive: {
      compatible: incentiveCompatible,
      violatingUsers,
    },
  };
}

// 对比分析：有水权市场 vs 无水权市场（无健康税、无优先配额、高交易摩擦）
function runComparison(params) {
  const withMarket = runSimulation(params);
  const noMarketParams = {
    ...params,
    healthTaxRate: 0,
    healthFloor: 0,
    tradingCost: 'high',
  };
  const withoutMarket = runSimulation(noMarketParams);
  return { withMarket, withoutMarket };
}
