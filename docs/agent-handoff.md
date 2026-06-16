# AGENT HANDOFF: Water Rights Trading for Health Resilience

> **目标读者：** 接手的 AI agent。你需要完全理解这个项目，并能够继续开发、修改、部署。
> **最后更新：** 2026-06-13
> **状态：** v1 稳定版本完成并部署。v2（队友自研）已作废。

---

## 1. 项目背景

### 比赛信息

- **比赛：** Hackathon for Next-generation (ACTION)
- **主办：** 清华大学、香港大学、新加坡国立大学、亚洲大学联盟
- **支持：** 世界气象组织 (WMO)、世界卫生组织 (WHO)
- **赛道：** 种子赛道（早期创意）
- **选题：** 主题四——气候与健康适应的水相关技术
- **团队：** 2 人，北京大学人口、资源与环境经济学硕士
- **汇报时间：** 2026 年 6 月 16 日（周二），1 小时

### 我们的方案

**一句话：** 一个交互式决策支持工具，帮助流域管理者设计以健康结果为导向的水权交易市场。

**核心经济学机制：**
- 水权交易市场 + 庇古健康税 (τ) + 健康优先配额
- 定价公式：P_trade = P_market + τ × H_loss × DALY(Q)
- 传统的命令控制手段无法动态再分配水资源；传统水权市场只优化经济效率而忽略健康外部性。我们把健康外部性嵌入价格机制，让市场自动把水导向健康价值最高的用途。

---

## 2. 已完成的交付物

### 2.1 交互式 Web 工具（核心产品）

| 文件 | 用途 |
|------|------|
| `index.html` | 英文版入口，三栏布局（参数面板 | 地图 | 仪表盘） |
| `zh/index.html` | 中文版入口（高德地图瓦片） |
| `css/style.css` | 全局样式，CSS 变量系统 |
| `js/config.js` | 数据层：参数默认值、气候情景、用水户、健康系数、流域信息 |
| `js/model.js` | 模型层：市场模拟、健康影响计算、激励相容检验 |
| `js/map.js` | 地图层：Leaflet 地图、彩色节点、健康光环、贸易流向线、图例 |
| `js/dashboard.js` | 仪表盘：4 张指标卡片 + Chart.js 柱状对比图 |
| `js/main.js` | 控制器：构建左栏参数面板、绑定滑块事件、协调 model→map→dashboard 更新 |

**技术栈：** 纯静态前端。HTML5 + CSS3 + Vanilla JS (ES6) + Leaflet 1.9.4 + Chart.js 4.4.0。无框架，无后端，无数据库。

**部署：** GitHub Pages — `https://roeslerroy010-sudo.github.io/water-rights-health-resilience/`

**仓库：** `https://github.com/roeslerroy010-sudo/water-rights-health-resilience`

### 2.2 文档

| 文件 | 内容 |
|------|------|
| `README.md` | 队友上手指南（中文，面向人类队友） |
| `demo-script.md` | 5 分钟中文演示走位脚本 |
| `docs/ppt-generation-guide.md` | 15 页 PPT 逐页方案 + 逐句讲稿 + 22 篇学术引用 |
| `docs/superpowers/specs/2026-06-12-water-rights-health-tool-design.md` | 原始设计文档 |
| `docs/superpowers/plans/2026-06-12-water-rights-health-tool-plan.md` | 原始实施计划 |

### 2.3 PPT

| 文件 | 内容 |
|------|------|
| `ppt/action-pitch.pptx` | 12 页路演 PPT（深青色主题） |

---

## 3. 技术架构详解

### 3.1 数据流

```
用户拖动滑块/切换下拉
  → main.js: attachLiveUpdates() 捕获 input/change 事件
  → main.js: handleRun() 读取当前参数
  → model.js: runSimulation(params) 计算市场均衡
  → model.js: runComparison(params) 计算有市场 vs 无市场
  → map.js: updateMap(result) 重绘地图节点和贸易线
  → dashboard.js: updateDashboard(result) 重绘指标卡片和图表
```

所有更新是实时的——不需要点击"运行"按钮（当然按钮也存在）。

### 3.2 核心模型 (model.js)

**函数清单：**

`computeEffectiveWater(params)` — 输入参数，输出有效水量对象：
- `total`: BASIN_INFO.tradableWater × 气候情景的 waterAvailability
- `healthReserved`: total × healthFloor
- `tradable`: total × (1 - healthFloor) × 交易成本 multiplier

`computeMarketPrice(water)` — 基于稀缺性定价：
- basePrice = 0.35 元/m³
- scarcityPremium = max(0, (1 - utilization)) × 0.50
- 返回 basePrice + scarcityPremium

`computeHealthTax(user, params)` — 单个用水户的健康税：
- hLoss = HEALTH_LOSS_COEFF[user.type] ?? 0.25
- 返回 τ × hLoss × baselineDALY / 100

`runSimulation(params)` — 完整模拟，返回：
```javascript
{
  params, water, marketPrice,
  userResults: [{...user, effectiveAllocation, healthTax, healthImpact, tradePrice, totalCost}],
  health: { totalHealthImpact, baselineDALY, dalyAvoided, diseaseReduction, economicNPV, healthQuotaGap },
  incentive: { compatible: bool, violatingUsers: [string] }
}
```

`runComparison(params)` — 返回 `{ withMarket, withoutMarket }`，其中 withoutMarket 是把 τ=0, healthFloor=0, tradingCost='high' 的对照情景。

**激励相容逻辑：**
```javascript
const tolerance = 1 + (params.healthFloor * 0.5);
// 10% 配额 → tolerance = 1.05（严格）
// 40% 配额 → tolerance = 1.20（宽松）
```
非健康用户如果 `totalCost > effectiveAllocation × marketPrice × tolerance`，则视为可能违规。

### 3.3 已知局限

**需求响应缺失：** 当前 effectiveAllocation 是机械分配（`allocation/100 × water.tradable`），不随 τ 变化。提高健康税会让 tradePrice 上升、totalCost 上升，但用户的实际用水量不会减少。这意味着：
- 地图节点大小在拖动 τ 时不会变化（虽然演示脚本里说"会缩小"）
- 要修复的话：在 effectiveAllocation 上乘以 `marketPrice / tradePrice`，使得税后价格上升时需求响应式减少用水

### 3.4 数据层 (config.js)

**用水户（长江中游示范流域，6 个节点）：**
```
muni  — 市政供水        — health   — allocation: 40, healthWeight:  1.0
agri1 — 农业用水（上游）— agri     — allocation: 25, healthWeight:  0.1
agri2 — 农业用水（下游）— agri     — allocation: 20, healthWeight:  0.1
ind1  — 工业用水（化工）— industry — allocation: 10, healthWeight: -0.3
ind2  — 工业用水（纺织）— industry — allocation:  5, healthWeight: -0.15
hydro — 水力发电        — energy   — allocation:  0, healthWeight:  0.0
```

**健康损失系数：** health: 0, agri: 0.25, industry: 0.60, energy: 0.05

**流域参数（长江中游）：** 总水量 5800M m³/年，生态基流 30%，人口 850 万

### 3.5 地图可视化 (map.js)

- **瓦片：** 英文版用 CartoDB Voyager，中文版 (`zh/`) 用高德地图
- **节点：** 彩色圆形，大小基于 effectiveAllocation（16-44px），含健康光环（绿色=正向影响，红色=负面）
- **贸易流向线：** 非健康用户 → 健康用户，高税率时变红变粗
- **图例：** 左下角，显示节点颜色含义和光环含义
- **Stats 栏：** 市场价格、可交易水量、气候情景、激励状态（STABLE/RISK）

### 3.6 仪表盘 (dashboard.js)

4 张指标卡片 + 1 个激励状态横幅 + 1 个 Chart.js 柱状对比图：
- DALY Avoided（避免的伤残调整寿命年）
- Water-borne Disease Reduction（水媒疾病下降百分比）
- Economic NPV（经济净现值，亿元）
- Health Quota Gap（健康配额缺口）
- 激励相容/不相容状态
- 有水权市场 vs 无水权市场对比柱状图

---

## 4. 文件清单

```
hackathon/
├── index.html                    # 英文版工具入口
├── zh/index.html                 # 中文版工具入口（高德地图）
├── css/style.css                 # 全局样式
├── js/
│   ├── config.js                 # 数据与参数
│   ├── model.js                  # 核心计算引擎
│   ├── map.js                    # Leaflet 地图
│   ├── dashboard.js              # 健康仪表盘
│   └── main.js                   # 控制器
├── demo-script.md                # 中文演示脚本
├── README.md                     # 队友上手指南
├── docs/
│   ├── ppt-generation-guide.md   # PPT 生成规格文档
│   ├── agent-handoff.md          # 本文件
│   └── superpowers/
│       ├── specs/2026-06-12-water-rights-health-tool-design.md
│       └── plans/2026-06-12-water-rights-health-tool-plan.md
└── ppt/
    └── action-pitch.pptx
```

---

## 5. 你的任务

你接手的是一套**已完成并部署的 v1 稳定版本**。你需要在此基础上继续工作。以下是建议方向：

### 5.1 修复已知问题

**需求响应（高优先级）：** 让工业用水在 τ 升高时实际减少（见 3.3 节）。修改 `model.js` 的 `runSimulation` 函数，非健康用户的 `effectiveAllocation` 应该随 `tradePrice` 上升而下降。

### 5.2 增强演示效果

- 让地图节点在有变化时闪烁/脉冲动画
- 增加节点之间的数值标注（交易了多少水）
- 仪表盘指标变化时增加过渡动画

### 5.3 PPT 更新

当前 `ppt/action-pitch.pptx` 是 12 页版本。`docs/ppt-generation-guide.md` 描述了一个 15 页的丰富版本。你可以用 `pptx` skill 按指南重新生成 PPT。

### 5.4 独立探索

以上只是起点。你应该读取所有源文件，形成自己的判断，然后决定最优的下一步行动。

---

## 6. 操作约束

- **不要主动 commit/push** 除非明确要求
- 如果做破坏性修改，先备份或创建分支
- 中文回复，直接简洁
- 不确定就停下来问，不要假设
