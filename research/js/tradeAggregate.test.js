const assert = require('assert');
const TradeAggregate = require('./tradeAggregate');

const withTrade = {
  marketPrice: 0.58,
  basinResults: [
    {
      id: 'A',
      name: '上游农业区',
      code: 'A-01',
      allocation: { agri: 60, industry: 20, urban: 15, eco: 5 },
    },
    {
      id: 'B',
      name: '中游工业区',
      code: 'B-02',
      allocation: { agri: 18, industry: 34, urban: 28, eco: 15 },
    },
    {
      id: 'C',
      name: '下游生活区',
      code: 'C-03',
      allocation: { agri: 8, industry: 18, urban: 40, eco: 19 },
    },
  ],
};

const autarky = {
  basinResults: [
    {
      id: 'A',
      name: '上游农业区',
      code: 'A-01',
      allocation: { agri: 80, industry: 30, urban: 15, eco: 5 },
    },
    {
      id: 'B',
      name: '中游工业区',
      code: 'B-02',
      allocation: { agri: 20, industry: 30, urban: 20, eco: 10 },
    },
    {
      id: 'C',
      name: '下游生活区',
      code: 'C-03',
      allocation: { agri: 10, industry: 15, urban: 30, eco: 15 },
    },
  ],
};

function closeTo(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: expected ${expected}, got ${actual}`);
}

function testNodeDeltaAndSets() {
  const result = TradeAggregate.aggregateTradeFlows({ withTrade, autarky });

  closeTo(result.nodeDelta.A, -30, 'A should be net seller by allocation delta');
  closeTo(result.nodeDelta.B, 10, 'B should be net buyer by withdrawal allocation delta');
  closeTo(result.nodeDelta.C, 11, 'C should be net buyer by withdrawal allocation delta');
  assert.deepStrictEqual(result.perNodeNet, result.nodeDelta);

  const deltaSum = Object.values(result.nodeDelta).reduce((sum, value) => sum + value, 0);
  closeTo(deltaSum, -9, 'nodeDelta should leave non-withdrawal eco gains in the river');
  closeTo(result.totalTraded, 21, 'totalTraded should equal sum of positive withdrawal deltas');

  const sellerIds = new Set(result.sellers.map((item) => item.id));
  const buyerIds = new Set(result.buyers.map((item) => item.id));
  sellerIds.forEach((id) => {
    assert.ok(!buyerIds.has(id), `${id} should not be both seller and buyer`);
  });
  assert.deepStrictEqual([...sellerIds], ['A']);
  assert.deepStrictEqual([...buyerIds].sort(), ['B', 'C']);
  closeTo(result.sellers[0].net, -30, 'seller net keeps FIX-2 negative sign');
  closeTo(result.buyers[0].volume, 11, 'buyer volume should be absolute positive withdrawal delta');
}

function testProportionalMatchingAndPartners() {
  const result = TradeAggregate.aggregateTradeFlows([], {
    withMarket: withTrade,
    withoutMarket: autarky,
    params: { tradingCost: 0.04 },
  });

  assert.deepStrictEqual(result.tradeFlows.map((flow) => `${flow.from}->${flow.to}`).sort(), ['A->B', 'A->C']);
  result.tradeFlows.forEach((flow) => {
    const expectedVolume = flow.to === 'B' ? 10 : 11;
    closeTo(flow.volume, expectedVolume, `${flow.from}->${flow.to} should be matched by buyer withdrawal delta share`);
    closeTo(flow.marketPrice, 0.58, `${flow.from}->${flow.to} should carry market price`);
    closeTo(flow.tradingCostPerM3, 0.04, `${flow.from}->${flow.to} should carry trading cost`);
    closeTo(flow.averageUnitCost, 0.62, `${flow.from}->${flow.to} should carry average unit cost`);
    assert.strictEqual(flow.sector, 'market-reallocation');
    assert.strictEqual(flow.direction, 'seller-to-buyer');
    assert.ok(flow.fromName.includes('农业区'), 'flow should keep Chinese seller name');
    assert.ok(flow.toCode === 'B-02' || flow.toCode === 'C-03', 'flow should keep buyer code');
  });
  assert.deepStrictEqual(result.flows, result.tradeFlows);

  assert.deepStrictEqual(result.partnersByNode.A.buyers.map((item) => item.id).sort(), ['B', 'C']);
  assert.deepStrictEqual(result.partnersByNode.B.sellers.map((item) => item.id), ['A']);
  assert.deepStrictEqual(result.partnersByNode.C.sellers.map((item) => item.id), ['A']);
  closeTo(
    result.partnersByNode.A.buyers.reduce((sum, item) => sum + item.volume, 0),
    21,
    'partner volumes should mirror generated withdrawal trade flows'
  );
}

function testSectorReallocationUsesAllocationDelta() {
  const result = TradeAggregate.aggregateTradeFlows([], {
    basinResults: withTrade.basinResults,
    noMarketResult: autarky,
  });

  assert.deepStrictEqual(result.sectorReallocation, {
    urban: 18,
    agri: -24,
    industry: -3,
    unreallocated: 9,
  });
  closeTo(result.environmentFlow.delta.legacyEcoAllocation, 9, 'legacy eco allocation delta should be retained as environment metadata');

  const retained = TradeAggregate.aggregateTradeFlows([], {
    withMarket: {
      allocation: { agri: 76, industry: 72, urban: 77, eco: 34 },
    },
    withoutMarket: {
      allocation: { agri: 110, industry: 75, urban: 65, eco: 30 },
    },
  });

  assert.deepStrictEqual(retained.sectorReallocation, {
    urban: 12,
    agri: -34,
    industry: -3,
    unreallocated: 25,
  });
  closeTo(retained.unreallocated, 25, 'top-level unreallocated should mirror withdrawal sector reallocation gap');
  closeTo(retained.environmentFlow.delta.legacyEcoAllocation, 4, 'legacy eco delta should not be lost');

  const round2Example = TradeAggregate.aggregateTradeFlows([], {
    withMarket: {
      allocation: { agri: 92.32, industry: 81.29, urban: 13.99, eco: 0.16 },
    },
    withoutMarket: {
      allocation: { agri: 100, industry: 100, urban: 10, eco: 0 },
    },
  });
  closeTo(round2Example.sectorReallocation.agri, -7.68, 'ROUND2 agri reduction sentinel');
  closeTo(round2Example.sectorReallocation.industry, -18.71, 'ROUND2 industry reduction sentinel');
  closeTo(round2Example.sectorReallocation.urban, 3.99, 'ROUND2 urban gain sentinel');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(round2Example.sectorReallocation, 'eco'), false, 'ROUND2 eco should not be a withdrawal sector');
  closeTo(round2Example.environmentFlow.delta.legacyEcoAllocation, 0.16, 'ROUND2 eco gain should survive as environment metadata');
  closeTo(round2Example.sectorReallocation.unreallocated, 22.4, 'ROUND2 unreallocated should equal withdrawal reductions minus gains');
  closeTo(round2Example.unreallocated, 22.4, 'ROUND2 top-level unreallocated should mirror the withdrawal sector gap');

  const noRetained = TradeAggregate.aggregateTradeFlows([], {
    withMarket: {
      allocation: { agri: 90, industry: 15, urban: 34, eco: 11 },
    },
    withoutMarket: {
      allocation: { agri: 100, industry: 20, urban: 20, eco: 10 },
    },
  });
  closeTo(noRetained.sectorReallocation.unreallocated, 1, 'eco gain no longer offsets the withdrawal sector gap');
  closeTo(noRetained.unreallocated, 1, 'top-level unreallocated mirrors the withdrawal-only gap');

  const gainDominant = TradeAggregate.aggregateTradeFlows([], {
    withMarket: {
      allocation: { agri: 90, industry: 15, urban: 37, eco: 11 },
    },
    withoutMarket: {
      allocation: { agri: 100, industry: 20, urban: 20, eco: 10 },
    },
  });
  closeTo(gainDominant.sectorReallocation.unreallocated, 0, 'unreallocated is still clamped to zero when withdrawal gains exceed reductions');
}

function testEnvironmentFlowFieldsArePreserved() {
  const result = TradeAggregate.aggregateTradeFlows([], {
    withMarket: {
      basinResults: [
        {
          id: 'R1',
          allocation: { urban: 12, agri: 4, industry: 2, eco: 3 },
          ecoBaseFlow: 8,
          inStreamFlow: 11,
          ecoSurplus: 3,
        },
      ],
    },
    withoutMarket: {
      basinResults: [
        {
          id: 'R1',
          allocation: { urban: 10, agri: 5, industry: 3, eco: 2 },
          ecoBaseFlow: 7,
          inStreamFlow: 8,
          ecoSurplus: 1,
        },
      ],
    },
  });

  assert.strictEqual(Object.prototype.hasOwnProperty.call(result.sectorReallocation, 'eco'), false);
  closeTo(result.environmentFlow.withMarket.ecoBaseFlow, 8, 'ecoBaseFlow should be preserved');
  closeTo(result.environmentFlow.withMarket.inStreamFlow, 11, 'inStreamFlow should be preserved');
  closeTo(result.environmentFlow.withMarket.ecoSurplus, 3, 'ecoSurplus should be preserved');
  closeTo(result.environmentFlow.withMarket.legacyEcoAllocation, 3, 'legacy eco allocation should move to environment metadata');
  closeTo(result.environmentFlow.delta.total, 3, 'environment flow delta should be available');
}

function testBulkRoutedOutflowIsIgnored() {
  const result = TradeAggregate.aggregateTradeFlows({
    tradeFlows: [
      {
        from: 'Z',
        to: 'A',
        volume: 999,
        sector: 'bulk-routed-outflow',
        marketPrice: 99,
        averageUnitCost: 99,
        tradingCostPerM3: 99,
      },
    ],
    withTrade,
    autarky,
    params: { tradingCost: 0.04 },
  });

  assert.strictEqual(result.tradeFlows.length, 2);
  assert.ok(result.tradeFlows.every((flow) => flow.sector !== 'bulk-routed-outflow'));
  assert.ok(result.tradeFlows.every((flow) => flow.from === 'A'));
  assert.ok(result.tradeFlows.every((flow) => flow.to === 'B' || flow.to === 'C'));
  assert.ok(result.tradeFlows.every((flow) => flow.marketPrice === 0.58));
  assert.ok(result.tradeFlows.every((flow) => flow.averageUnitCost === 0.62));
  assert.ok(result.tradeFlows.every((flow) => flow.tradingCostPerM3 === 0.04));
  closeTo(result.totalTraded, 21, 'bulk routed outflow should not inflate withdrawal-only totalTraded');
  assert.strictEqual(result.perNodeNet.Z, undefined);
}

function testMissingAutarkyLeavesZeroTrade() {
  const result = TradeAggregate.aggregateTradeFlows({
    tradeFlows: [{ from: 'A', to: 'B', volume: 20 }],
    withTrade,
  });

  assert.deepStrictEqual(result.tradeFlows, []);
  assert.deepStrictEqual(result.sectorReallocation, {
    urban: 0,
    agri: 0,
    industry: 0,
    unreallocated: 0,
  });
  closeTo(result.totalTraded, 0, 'no autarky baseline means no true trade can be inferred');
  closeTo(result.perNodeNet.A, 0, 'known node should still be present with zero delta');
}

testNodeDeltaAndSets();
testProportionalMatchingAndPartners();
testSectorReallocationUsesAllocationDelta();
testEnvironmentFlowFieldsArePreserved();
testBulkRoutedOutflowIsIgnored();
testMissingAutarkyLeavesZeroTrade();

console.log('tradeAggregate tests passed');
