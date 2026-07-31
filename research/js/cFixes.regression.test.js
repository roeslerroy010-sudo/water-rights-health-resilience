// 2026-07-29 C 组缺陷修复的回归测试。
//
// 覆盖：C1 地图取景、C3 气候→健康产出、C4 三栏定高、C5 交易摩擦计费基数、
// C7 求解器回退文案、C8 圈选键盘可达性。
//
// 说明：main.js / map.js 是不导出任何东西的 IIFE，无法在 node 里直接调用；
// 对这两个文件沿用本仓库既有做法（见 richPanels.test.js）做源码级断言，
// 能行为验证的部分（C3、C5 的成交量口径）则跑真模块与真数据。

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ResearchNetworkModel = require("./networkModel");
const TradeAggregate = require("./tradeAggregate");

const RESEARCH_DIR = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(...parts), "utf8");

const mainSource = read(__dirname, "main.js");
const mapSource = read(__dirname, "map.js");
const indexHtml = read(RESEARCH_DIR, "index.html");
const styleCss = read(RESEARCH_DIR, "css", "style.css");
const attrs = JSON.parse(read(RESEARCH_DIR, "data", "wuhan-attrs.json"));

const { solveNetwork } = ResearchNetworkModel;

const BASE_PARAMS = {
  tau: 0.24,
  healthFloor: 0.26,
  ecoFloor: 0.15,
  tradingCost: 0.1,
  demandElasticity: 0.9,
};

const failures = [];
const deferred = [];
function check(label, fn) {
  try {
    fn();
    console.log("OK   " + label);
  } catch (error) {
    failures.push(label + " — " + error.message);
    console.log("FAIL " + label + " — " + error.message);
  }
}

// ---------------------------------------------------------------------------
// C3 — 气候情景必须真正改变健康产出
// ---------------------------------------------------------------------------

// 四档情景按「气候压力」递增排列。压力 = 1 - climateAvailability，
// networkModel 的 CLIMATE_AVAILABILITY: historical 1.0 > ssp245 0.86
// > dry 0.82 > ssp585 0.70。
const CLIMATE_BY_RISING_STRESS = ["historical", "ssp245", "dry", "ssp585"];

function solveWithClimate(climate) {
  return solveNetwork({ network: attrs, ...BASE_PARAMS, climate });
}

// 2026-07-30：健康产出改为「负担」口径（剂量—反应链），dalyAvoided 已移到比较层。
// C3 的意图是「气候情景必须影响健康产出」，该意图在此以 dalyBurden 检验。
check("C3 每档气候情景都算出有限的 dalyBurden", () => {
  CLIMATE_BY_RISING_STRESS.forEach((climate) => {
    const result = solveWithClimate(climate);
    const total = result.aggregate && result.aggregate.dalyBurden;
    assert.ok(Number.isFinite(total) && total > 0, climate + " 的 dalyBurden 应为正有限值，实际 " + total);
    assert.ok(
      result.nodes.every((node) => Number.isFinite(node.dalyBurden)),
      climate + " 的每个子流域都应带 dalyBurden"
    );
  });
});

// 新口径下气候通过配水影响健康：径流减少 → 河道稀释流量下降 → 浓度上升 → 负担上升。
// 必须走 LP（生产路径）。启发式回退路径在 SSP5-8.5 下会因 riverRetentionValue(1.296)
// 高于农业部门用水价值(1.15) 而把农业全部挤掉、出流反而暴涨，导致负担不升反降——
// 那是回退路径既有的缺陷（LP 用的是按下游节点数归一化后的留存权重），
// 与本项健康口径无关，另见 docs/economics-audit.md「已知问题」。
let lpClimateSeries = null;
deferred.push({ label: "C3 dalyBurden 随气候压力严格单调上升（LP 生产路径）", fn: () => {
  assert.ok(lpClimateSeries, "LP 气候序列应已求解");
  const summary = lpClimateSeries.map((item) => item.climate + "=" + item.daly.toFixed(1)).join(", ");
  lpClimateSeries.slice(1).forEach((item, index) => {
    assert.ok(
      item.daly > lpClimateSeries[index].daly,
      "气候压力上升时 dalyBurden 必须上升；" + summary
    );
  });
} });

// 政策旋钮不得直接出现在健康函数里——这正是旧实现的循环论证。
check("C3 健康函数不得直接依赖 tau 或 healthFloor", () => {
  const modelSource = read(__dirname, "networkModel.js");
  const block = modelSource.match(/function computeNodeHealthBurdenDetail[\s\S]*?\n  \}/);
  assert.ok(block, "应存在 computeNodeHealthBurdenDetail");
  assert.ok(
    !/getTau\(|getHealthFloor\(|tauSignal|healthFloorSignal/.test(block[0]),
    "健康负担函数只能以配水结果为自变量，不得读取 tau/healthFloor（旧实现 18×τSignal 属循环论证）"
  );
});

check("C3 CLIMATE_AVAILABILITY 显式包含 historical", () => {
  const { getClimateAvailability } = ResearchNetworkModel._internals;
  assert.strictEqual(getClimateAvailability({ climate: "historical" }), 1);
  assert.ok(
    /historical:\s*1(\.0)?,/.test(read(__dirname, "networkModel.js")),
    "historical 应显式列出，而非依赖未命中时的兜底返回 1"
  );
});

check("C3 main.js 必须采用模型算出的 dalyBurden", () => {
  assert.ok(
    /const dalyBurden = numberOr\(node\.dalyBurden, 0\);/.test(mainSource),
    "normalizeResearchNetworkSolution 必须采用 node.dalyBurden，不得用本地公式覆盖"
  );
  assert.ok(
    /dalyAvoided = comparison \? Math\.max\(0, numberOr\(comparison\.delta\.dalyAvoided, 0\)\) : 0/.test(mainSource),
    "dalyAvoided 必须来自 τ=0 反事实比较，而不是节点局部公式"
  );
});

// ---------------------------------------------------------------------------
// C5 — 交易摩擦只按实际成交量计费
// ---------------------------------------------------------------------------

check("C5 成交量取 min(总卖出, 总买入)，既非净买方增量也非全域取水量", () => {
  // 故意让买卖不等：A 只释放 10，B 却多得 25（差额来自过境/新增水，
  // 不是有人卖给它）。三个候选基数因此可区分：
  //   全域取水量 175   ← 旧口径，等于给未换手的水也收摩擦费
  //   净买方增量 25    ← aggregate.totalTraded，会把过境水计成成交
  //   实际换手量 10    ← 成交流合计 min(卖,买)，本修复采用
  const withTrade = {
    marketPrice: 0.41,
    basinResults: [
      { id: "A", name: "上游", code: "A", allocation: { agri: 70, industry: 10, urban: 10 } },
      { id: "B", name: "中游", code: "B", allocation: { agri: 20, industry: 45, urban: 20 } },
    ],
  };
  const autarky = {
    basinResults: [
      { id: "A", name: "上游", code: "A", allocation: { agri: 80, industry: 10, urban: 10 } },
      { id: "B", name: "中游", code: "B", allocation: { agri: 20, industry: 20, urban: 20 } },
    ],
  };
  const aggregate = TradeAggregate.aggregateTradeFlows({ withTrade, autarky });
  const flows = aggregate.tradeFlows || [];
  const tradedVolume = flows.reduce((sum, flow) => sum + Math.max(0, flow.volume || 0), 0);
  const totalWithdrawn = 175;

  assert.ok(tradedVolume > 0, "构造用例应产生成交流，实际 flows=" + flows.length);
  assert.ok(
    Math.abs(tradedVolume - 10) < 1e-6,
    "实际换手量应为 min(卖 10, 买 25) = 10，实际 " + tradedVolume
  );
  assert.ok(
    Math.abs(aggregate.totalTraded - 25) < 1e-6,
    "净买方增量应为 25（用它当摩擦基数会把过境水计成成交），实际 " + aggregate.totalTraded
  );
  assert.ok(
    tradedVolume < totalWithdrawn,
    "成交量必须远小于全域取水量，否则摩擦计费基数又退回旧口径"
  );
});

check("C5 main.js 的 tradingCostCny 由成交量而非 tradableWater 推导", () => {
  assert.ok(
    /function reconcileTradingCost/.test(mainSource),
    "应存在 reconcileTradingCost 用成交量重算摩擦成本"
  );
  assert.ok(
    /aggregate\.tradingCostCny = tradingCostCny;/.test(mainSource)
      && /const tradingCostCny = tradedVolume \* unitCost;/.test(mainSource),
    "摩擦成本必须 = 成交量 × 单位成本"
  );
  // 2026-07-30：成本侧补齐后，净社会收益 = 健康收益 − 摩擦成本 − 庇古税的无谓损失。
  // 税收收入是转移支付，不进这条式子。见 docs/economics-audit.md §4.1。
  assert.ok(
    /aggregate\.netSocialBenefitCny = numberOr\(aggregate\.healthBenefitCny, 0\)\s*\n\s*- tradingCostCny\s*\n\s*- deadweightLossCny;/.test(mainSource),
    "年度净社会收益必须 = 健康收益 − 按成交量计的摩擦成本 − 无谓损失"
  );
  assert.ok(
    /aggregate\.taxRevenueCny = taxRevenueCny;/.test(mainSource),
    "税收收入必须单独报告，不得混入社会成本"
  );
  assert.ok(
    /reconcileTradingCost\(state\.result\);/.test(mainSource),
    "reconcileTradingCost 必须在 finalizeResult 里被调用（成交流此时才算好）"
  );
});

// ---------------------------------------------------------------------------
// C1 — 地图取景不得被首帧的错误容器尺寸锁死
// ---------------------------------------------------------------------------

check("C1 fitBounds 前重新量容器尺寸", () => {
  assert.ok(
    /function fitToBasins[\s\S]{0,400}invalidateSize\(\{ animate: false \}\)[\s\S]{0,200}fitBounds\(/.test(mapSource),
    "fitToBasins 必须先 invalidateSize 再 fitBounds"
  );
});

check("C1 容器尺寸变化会触发重新取景", () => {
  assert.ok(/ResizeObserver/.test(mapSource), "应监听容器尺寸变化");
  assert.ok(/function refitBoundsIfNeeded/.test(mapSource), "应有 refitBoundsIfNeeded");
  assert.ok(
    /const viewportChanged = !userAdjustedView && getViewportKey\(\) !== fittedViewportKey;/.test(mapSource),
    "取景条件必须包含容器尺寸变化，不能只看 boundsKey（旧代码因此把错误缩放锁死）"
  );
});

check("C1 用户手动操作地图后不再自动改动视野", () => {
  assert.ok(
    /if \(!programmaticViewChange\) userAdjustedView = true;/.test(mapSource),
    "用户主动缩放/平移应置 userAdjustedView"
  );
  assert.ok(
    /if \(userAdjustedView \|\| !basinLayer\) return;/.test(mapSource),
    "refitBoundsIfNeeded 必须在用户动过地图后让路"
  );
});

// ---------------------------------------------------------------------------
// C4 — 三栏钉死为一屏，各自内部滚动
// ---------------------------------------------------------------------------

check("C4 .layout 为定高而非 min-height", () => {
  const layoutBlock = styleCss.match(/\.layout \{[\s\S]*?\}/);
  assert.ok(layoutBlock, "应能找到 .layout 规则");
  assert.ok(
    /height:\s*calc\(100vh - 82px\)/.test(layoutBlock[0]),
    "必须定高，否则行高被最长的 dashboard 撑开、地图被推到折叠线以下"
  );
  assert.ok(/overflow:\s*hidden/.test(layoutBlock[0]), ".layout 应裁剪溢出，让三栏各自滚动");
  assert.ok(
    !/min-height:\s*calc\(100vh - 82px\)/.test(styleCss),
    "旧的 min-height 写法必须移除"
  );
});

check("C4 窄屏断点解除一屏约束", () => {
  const narrow = styleCss.match(/@media \(max-width: 1120px\) \{[\s\S]*?\n\}/);
  assert.ok(narrow, "应能找到 1120px 断点");
  assert.ok(
    /\.layout \{[\s\S]*?height:\s*auto/.test(narrow[0]),
    "窄屏必须把 .layout 改回内容驱动高度"
  );
});

check("C4 侧栏保留独立滚动", () => {
  assert.ok(
    /\.side-panel \{[\s\S]*?overflow-y:\s*auto/.test(styleCss),
    ".side-panel 应可独立滚动"
  );
});

// ---------------------------------------------------------------------------
// C7 / C8
// ---------------------------------------------------------------------------

check("C7 求解器回退文案不再声称 LP spike 未完成", () => {
  assert.ok(
    !/LP spike/i.test(indexHtml),
    "LP spike 已完成（见 tools/spike/DECISION.md），文案不得再这样写"
  );
  assert.ok(
    /id="solver-note"[\s\S]{0,200}GLPK 未就绪/.test(indexHtml),
    "回退提示应准确说明是 GLPK 未就绪导致的近似解"
  );
});

check("C8 Escape 可退出圈选绘制", () => {
  assert.ok(/function bindRegionKeyboardShortcuts/.test(mapSource), "应绑定键盘快捷键");
  assert.ok(
    /if \(event\.key !== 'Escape'\) return;/.test(mapSource),
    "应处理 Escape"
  );
  assert.ok(
    /setDrawMode\(false\);[\s\S]{0,160}activeButton\.focus\(\)/.test(mapSource),
    "退出绘制后应把焦点还给触发按钮"
  );
  assert.ok(
    /bindRegionKeyboardShortcuts\(\);/.test(mapSource),
    "bindRegionControls 必须真的调用它"
  );
});

check("C8 圈选按钮声明了键盘快捷键", () => {
  ["region-draw-toggle", "region-lasso-toggle"].forEach((id) => {
    const pattern = new RegExp('id="' + id + '"[^>]*aria-keyshortcuts="Escape"');
    assert.ok(pattern.test(indexHtml), id + " 应带 aria-keyshortcuts");
  });
});

// ---------------------------------------------------------------------------
// D4 — 计算口径文档必须存在，且与代码里的关键常量一致
// ---------------------------------------------------------------------------

check("D4 计算口径文档存在（PPT 末页引用它）", () => {
  const guidePath = path.join(RESEARCH_DIR, "docs", "calculation-guide.md");
  assert.ok(fs.existsSync(guidePath), "research/docs/calculation-guide.md 必须存在");
  const guide = read(guidePath);
  assert.ok(guide.length > 3000, "文档不应是占位空壳");
  return guide;
});

check("D4 文档记录的关键常量与代码一致", () => {
  const guide = read(RESEARCH_DIR, "docs", "calculation-guide.md");
  const model = read(__dirname, "networkModel.js");
  const main = read(__dirname, "main.js");

  // 文档里写死的数值，若代码改了必须同步改文档
  const pairs = [
    ["工业需求硬下限 0.40", /INDUSTRY_DEMAND_FLOOR_FRACTION = 0\.40/, model, /0\.40/],
    ["工业健康损害系数 0.52", /industry: 0\.52/, model, /0\.52/],
    ["生态基流上限系数 0.95", /cap = 0\.95 \* natural/, model, /0\.95 × localRunoff/],
    ["DALY 货币化 125000", /VALUE_PER_DALY = 125000/, main, /¥125,000/],
    ["疾病折算 0.18", /DISEASE_CASE_DALY = 0\.18/, main, /0\.18/],
  ];
  pairs.forEach(([label, codeRe, source, docRe]) => {
    assert.ok(codeRe.test(source), "代码里应能找到：" + label);
    assert.ok(docRe.test(guide), "文档里应记录：" + label);
  });

  // 气候情景四档取值
  ["1.0", "0.86", "0.82", "0.70"].forEach((v) => {
    assert.ok(guide.includes(v), "文档应记录气候 availability " + v);
  });
});

check("D4 PPT 与文档都不再指向 localhost", () => {
  const guide = read(RESEARCH_DIR, "docs", "calculation-guide.md");
  assert.ok(!/127\.0\.0\.1|localhost/.test(guide), "文档不应含本地地址");
});

// ---------------------------------------------------------------------------

async function main() {
  const glpk = await ResearchNetworkModel.loadNodeGlpkInstance();
  lpClimateSeries = [];
  for (const climate of CLIMATE_BY_RISING_STRESS) {
    const result = await ResearchNetworkModel.solveNetworkLpAsync({
      network: attrs,
      glpk,
      ...BASE_PARAMS,
      climate,
    });
    lpClimateSeries.push({ climate, daly: result.totals.dalyBurden });
  }
  deferred.forEach((item) => check(item.label, item.fn));

  if (failures.length) {
    console.error("\n" + failures.length + " 项回归检查失败：");
    failures.forEach((item) => console.error("  - " + item));
    process.exit(1);
  }
  console.log("\nC 组回归检查全部通过。");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
