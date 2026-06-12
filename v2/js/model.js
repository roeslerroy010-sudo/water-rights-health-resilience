// model.js — Core computation engine for the water rights market simulator
// Computes: water allocation, market price, health impact, incentive compatibility

// Compute effective water availability after climate shock and trading friction
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

// Compute market-clearing price per m³
function computeMarketPrice(water) {
  const utilization = water.tradable / BASIN_INFO.tradableWater;
  const basePrice = 0.35; // RMB/m³ baseline
  const scarcityPremium = Math.max(0, (1 - utilization)) * 0.50;
  return Math.round((basePrice + scarcityPremium) * 100) / 100;
}

// Compute health tax for a specific water user
function computeHealthTax(user, params) {
  const hLoss = HEALTH_LOSS_COEFF[user.type] ?? 0.25;
  return Math.round(params.healthTaxRate * hLoss * DOSE_RESPONSE.baselineDALY / 100 * 1000) / 1000;
}

// Full simulation: run the model for given params
function runSimulation(params) {
  const water = computeEffectiveWater(params);
  const marketPrice = computeMarketPrice(water);

  // Per-user results
  const userResults = WATER_USERS.map(user => {
    const healthTax = computeHealthTax(user, params);
    const effectiveAllocation = user.type === 'health'
      ? (user.allocation / 100) * water.total   // health users get priority
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

  // Aggregate health metrics
  const totalHealthImpact = userResults.reduce((sum, u) => sum + Math.max(0, u.healthImpact), 0);
  const baselineDALY = DOSE_RESPONSE.baselineDALY * BASIN_INFO.population / 100000;
  const dalyAvoided = Math.round(baselineDALY * (totalHealthImpact / (WATER_USERS.length * 10)));
  const diseaseReduction = Math.min(35, Math.round((params.healthTaxRate * 80 + params.healthFloor * 40) * 10) / 10);
  const economicNPV = Math.round(dalyAvoided * DOSE_RESPONSE.valuePerDALY / 1000000) / 100; // in 100M RMB

  // Health quota gap
  const healthAllocation = userResults
    .filter(u => u.type === 'health')
    .reduce((s, u) => s + u.effectiveAllocation, 0);
  const healthQuotaGap = Math.round(water.healthReserved - healthAllocation);

  // Incentive compatibility check
  // Tolerance shrinks as health floor drops — low protection = easier to defect
  const tolerance = 1 + (params.healthFloor * 0.5); // 1.05 at 10%, 1.20 at 40%
  const incentiveCompatible = userResults.every(u => {
    if (u.type === 'health') return true; // health users always compatible
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

// Get comparison: with-market vs without-market (no health tax, no floor, high friction)
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
