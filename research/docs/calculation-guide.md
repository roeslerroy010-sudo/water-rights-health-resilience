# 研究页计算口径说明（RESEARCH-PAGE-CALCULATION-GUIDE）

> 本文件是汇报 PPT 末页所引用的 `RESEARCH-PAGE-CALCULATION-GUIDE`，逐条对应
> `research/js/` 里的实现，可作为 Full Submission 的 methodology annex 底稿。
>
> 与 [`methodology.md`](methodology.md) 的分工：那份讲**为什么**这样建模（过境水口径、
> autarky 基线、生态基流范围等方法论决策）；本份讲**具体怎么算**（公式、常量、
> 变量与约束、代码位置）。
>
> 末次核对：**2026-07-29**，对应 C 组缺陷修复之后的代码。文中每个公式都已与
> 源码逐一比对，行号为当次核对时的位置。

---

## 0. 一句话总览

给定气候情景与政策参数，先按水文拓扑把可用水量路由到 66 个子流域，预留河道生态
基流，再用线性规划在农业 / 工业 / 生活三类取水用途之间求解配置；健康税以庇古税
形式抬高工业用水的有效成本，输出配水、环境流量、健康收益与市场结果。

---

## 1. 水权与部门口径

| 项 | 口径 |
|---|---|
| 水权 | **模型化的年度取用水配置权**（m³/yr），不是已发生的真实合同 |
| 取水部门 | `agri`（农业）、`industry`（工业）、`urban`（生活） |
| 生态 | **不是取水部门**，而是必须留在河道内的约束（in-stream constraint），不可交易 |
| 空间单元 | 66 个 Pfafstetter level-6 子流域，拓扑无环且每个节点可达 OUTLET |

---

## 2. 供给侧

### 2.1 气候折减

`climateAvailability` 由情景查表得到（`networkModel.js` `CLIMATE_AVAILABILITY`）：

| 情景值 | UI 标签 | availability |
|---|---|---|
| `historical` | 历史校准 | 1.00 |
| `ssp245` | SSP2-4.5 中等压力 | 0.86 |
| `dry` | 连续干旱冲击 | 0.82 |
| `ssp585` | SSP5-8.5 高压力 | 0.70 |

本地产流与过境水折减系数**不同**：

```
qLocal_i        = qLocalBase_i × climateAvailability
externalInflow  = externalInflowBase × (1 − 0.6 × (1 − climateAvailability))
```

过境水只承担 60% 的折减幅度——长江与汉江干流过境水受本地气候影响弱于本地产流。

### 2.2 路由

沿拓扑排序自上游向下游累加：

```
qAvail_i = qLocal_i + externalInflow_i + Σ(上游 out_j)
out_i    = qAvail_i − Σ_s x_{i,s}
```

### 2.3 生态基流

```
ecoBaseFlow_i = min( 0.95 × localRunoff_i ,
                     max( ecoFloor × localRunoff_i , legacyEcoDemand_i ) )
```

- 只以**本地产流**为基数，过境水不再乘 `ecoFloor` 二次留存（理由见 methodology.md）
- `0.95 × localRunoff` 是硬上限，防止生态约束吃掉全部本地水
- `ecoFloor` 默认 0.15，UI 可调 10%–40%

---

## 3. 需求侧与健康税

### 3.1 有效需求上限

农业与生活按原始需求封顶；**工业**需求随健康税弹性收缩：

```
effectiveD_industry = D_industry × max( 0.40 , 1 − ε × τ × lossCoeff )
```

- `ε` = 工业用水弹性，默认 0.90，UI 可调 0.30–1.20
- `τ` = 健康税率，默认 0.24，UI 可调 0–50%
- `lossCoeff` = 部门健康损害系数，工业 **0.52**
- **0.40 是硬下限**（`INDUSTRY_DEMAND_FLOOR_FRACTION`）：工业用水不会被压到基准需求的 40% 以下

### 3.2 健康税（庇古税）

```
taxPerM3_i = τ × lossCoeff × climateStress × (weightedPopulation_i / 100000) × scale
```

其中

```
climateStress       = 1 + 0.75 × max(0, 1 − climateAvailability)
weightedPopulation_i = Σ_{j ∈ 下游可达集} population_j × (1 / (rank_j + 1)^0.35)
scale                = 0.02（healthTaxScale）
```

- **下游人口按距离衰减**：`rank_j` 是 j 在 i 的下游序列中的位次，衰减指数
  `downstreamAttenuation` 默认 0.35。PPT 公式里写的 `PopDown_i` 即此加权人口，
  展示时省略了衰减细节。
- ⚠️ **注意有两个不同的 climateStress**：本节税式用的是 `1 + 0.75(1−avail)`（≥1 的乘数）；
  第 6 节 DALY 用的是 `max(0, 1−avail)`（0 起步的强度）。两者同名但定义不同，
  读代码时容易混。

### 3.3 市场出清价

```
P_market = 0.35 + scarcity × 0.9 + τ × 0.04 + tradingCost × 0.5
scarcity = max(0, totalDemand − totalSupply) / totalDemand
```

默认参数（τ=24%、交易成本 10%、SSP2-4.5）下供水充裕，`scarcity ≈ 0`，
故 `P_market ≈ 0.35 + 0.0096 + 0.05 = 0.4096 元/m³`。

---

## 4. 线性规划

由 `buildGlpkProblem()` 构造，GLPK 编译为 WebAssembly 在浏览器内求解
（66 节点实测 35–372 ms）。

### 变量

| 变量 | 含义 | 个数 |
|---|---|---|
| `x_{i,s}` | 节点 i 部门 s 的取水量 | 66 × 3 |
| `out_i` | 节点 i 的出流量 | 66 |
| `hf_short_i` | 健康底线松弛量 | 66 |

### 目标函数（最大化）

```
Σ_{i,s} netValue_{i,s} · x_{i,s}
  + Σ_i riverRetentionObjectiveValue · out_i
  − Σ_i 1e6 · hf_short_i
```

- `netValue` = 部门用水净价值 − 合规成本 − 该部门健康税
- 出流带正权重，使"把水留在河道"本身有价值（生态偏好内生化）
- 健康底线用**大罚项软约束**（系数 −10⁶）而非硬约束，避免极端参数下 LP 不可行

### 约束

| 约束 | 形式 |
|---|---|
| 需求上限 | `0 ≤ x_{i,s} ≤ effectiveD_{i,s}` |
| 水量平衡 | `qAvail_i = qLocal_i + qExternal_i + Σ上游out − Σ_s x_{i,s}` |
| 生态基流 | `out_i ≥ ecoBaseFlow_i` |
| 健康底线 | 生活用水应满足 `healthFloor`，不足计入 `hf_short_i` |
| 交易方向 | `t_{ij}` 仅在 j 为 i 的下游可达节点时允许 |

**回退路径**：若浏览器拿不到就绪的同步 GLPK 实例，退化为
`heuristic-routing-market` 启发式求解，此时 `solver.lpReady = false`，
界面会显示"本地 GLPK 未就绪，已回退启发式求解，结果为近似解"。

---

## 5. 交易口径（口径 R）

交易定义为**市场解与自给自足基线的配置差额**，不是河水物理流向：

```
nodeDelta_i = allocation_withTrade_i − allocation_autarky_i
```

`nodeDelta < 0` 为净卖方，`> 0` 为净买方。autarky 基线下每个节点只能用自己的水权：

```
ownWaterRight_i     = qLocal_i + Σ_k transitShare_{i,k}
transitShare_{i,k}  = transitVolume_k × demand_i / Σ_{j∈D_k} demand_j
```

### 实际成交量（2026-07-29 修正）

```
tradedVolume = Σ tradeFlows.volume = min( Σ|净卖方 delta| , Σ净买方 delta )
```

三个易混的量必须区分：

| 量 | 含义 | 能否作摩擦计费基数 |
|---|---|---|
| `totals.withdrawn` | 全域取水量（默认约 186 亿 m³） | ❌ 会给未换手的水收过路费 |
| `aggregate.totalTraded` | 净买方增量合计 | ❌ 会把过境水计成成交 |
| **成交流合计 `min(卖, 买)`** | 真正换手的水 | ✅ **当前采用** |

买方增量超过卖方释放量时，差额来自过境或新增可用水，不构成交易。默认全域外部
调水情景下无净卖方，成交量为 **0 m³**——此时交易明细表为空是正确的，不代表模型
没有再配置。SSP5-8.5 情景下才出现约 3.98 亿 m³ 真实换手。

---

## 6. 健康产出

```
dalyAvoided_i = (population_i / 100000) × urbanCoverage_i × avoidedPer100k

urbanCoverage_i = clamp( x_urban_i / D_urban_i , 0 , 1 )
avoidedPer100k  = 9 + 28 × climateStress + 11 × healthFloorSignal + 18 × tauSignal
climateStress   = max(0, 1 − climateAvailability)
tauSignal       = clamp( τ / 0.5 , 0 , 1 )
healthFloorSignal = clamp( healthFloor , 0 , 1 )
```

`28 × climateStress` 是权重最大的一项，因此**气候情景对健康产出影响显著**：
默认参数下四档情景的全域 DALY 避免量为
`historical 6,664 < ssp245 7,938 < dry 8,302 < ssp585 9,394`。

> **历史坑（已修）**：2026-07-29 之前，走真 LP 的主路径会用一个**不含气候项**的
> 公式覆盖上式，导致四档情景 DALY 恒为 5,783。现已改为优先采用求解器输出值。
> 回归测试见 `research/js/cFixes.regression.test.js`。

### 疾病例数与货币化

```
diseaseCases  = dalyAvoided / 0.18          （DISEASE_CASE_DALY，前端代理折算）
healthBenefit = dalyAvoided × ¥125,000      （VALUE_PER_DALY）
tradingCost   = tradedVolume × 单位交易成本
economicNpv   = healthBenefit − tradingCost
```

---

## 7. 两个反事实必须分开读

| 面板 | 比较 | 回答的问题 | 预期方向 |
|---|---|---|---|
| 健康税效应 | `withTrade(τ) − withTrade(τ=0)` | 健康税本身的政策效应 | 工业取水↓、环境流量↑、DALY↑ |
| 交易效率 | `withTrade(τ) − autarky(τ)` | 允许交易相对自给自足的配置效率 | 工业配水可能↑ |

**交易效率面板里工业用水上升不等于健康税失效**——那是交易让缺水部门买到水的
效率效应。混读这两个面板是本项目最容易被误解的地方。

实测健康税方向（默认 SSP2-4.5，全域）：

| τ | 可交易水量 | DALY 避免 | 经济 NPV |
|---|---|---|---|
| 0% | 191.91 亿 m³ | 5,129.4 | 6.41 亿元 |
| 24% | 185.94 亿 m³ | 7,937.9 | 9.92 亿元 |
| 50% | 179.48 亿 m³ | 10,980.4 | 13.73 亿元 |

---

## 8. 默认参数

| 参数 | 默认 | UI 范围 |
|---|---|---|
| τ 健康税率 | 24% | 0–50% |
| 工业用水弹性 ε | 0.90 | 0.30–1.20 |
| 气候情景 | SSP2-4.5 | 四档 |
| 水权交易范围 | 外部调水 | 外部调水 / 内部解决 |
| Health floor | 26% | 10–45% |
| Local eco floor | 15% | 10–40% |
| Trading cost | 10% | 2–24% |

---

## 9. 参数出处状态 —— ⚠️ 待补

**物理与水文数据**溯源完整：`research/data/provenance.json` 共 41 条目，覆盖
CLCD / WorldCover / WorldPop / VIIRS / MERIT / HydroSHEDS / 气候 / GADM / 湖北水资源公报
九类来源，并显式标注 `estimated: true` 与低置信度字段。

**经济与健康行为参数目前没有文献出处**，均为代码内标定值：

| 常量 | 值 | 出处状态 |
|---|---|---|
| `DEFAULT_SECTOR_VALUE` | urban 3.2 / eco 2.4 / industry 1.45 / agri 1.15 元每 m³ | ⚠️ 无引用 |
| `HEALTH_LOSS_COEFF.industry` | 0.52 | ⚠️ 无引用 |
| `INDUSTRY_DEMAND_FLOOR_FRACTION` | 0.40 | ⚠️ 无引用 |
| `CLIMATE_AVAILABILITY` | ssp245 0.86 / ssp585 0.70 / dry 0.82 | ⚠️ 无引用 |
| `DEFAULT_COMPLIANCE_COST` | urban 0.28 / eco 0.08 / agri 0.18 / industry 0.52 | ⚠️ 无引用 |
| `avoidedPer100k` 各项系数 | 9 / 28 / 11 / 18 | ⚠️ 无引用 |
| `VALUE_PER_DALY` | ¥125,000 | ⚠️ 无引用 |
| `DISEASE_CASE_DALY` | 0.18 | ⚠️ 无引用 |

这是当前最需要补的一环：所有头条数字（DALY 避免、疾病减少、经济 NPV）都由上表
决定。第一轮表单 Q26 已承诺在 mentored phase 对 GBD 与中国环境健康文献校准，
并**报告不确定性区间而非点估计**。补完前，所有数值应表述为"选定参数下的模型
模拟输出"，不作为真实成交或因果评估结论。

---

## 10. 模型边界

- **年度尺度**，不含季节调蓄、地下水、水质动态
- 线性规划，不含非线性拥塞或博弈行为
- 子流域中文名为**派生标签**，非官方地名（`pfafId` / `code` 才是技术标识）
- 过境水注入节点（长江 `PF_465500`、汉江 `PF_465610`）为**低置信度**指认：
  HydroRIVERS 路由证据未能独立核验河名
- 工业需求降尺度用 World Bank Light Every Night，202206 与 202208 为邻月插值

---

## 附：源码位置速查

| 内容 | 位置 |
|---|---|
| 常量表（气候、部门价值、健康系数） | `research/js/networkModel.js` 开头 |
| 生态基流 | `computeEcoBaseFlowDetail()` |
| 有效需求上限 | `computeEffectiveDemandCap()` |
| 健康税 | `computeHealthTaxDetail()` |
| 市场价 | `computeMarketPrice()` |
| DALY | `computeNodeDalyAvoided()` / `computeNodeDalyBurden()` |
| LP 构造 | `buildGlpkProblem()` / `buildLpProblemInterface()` |
| autarky 基线 | `solveAutarky()` |
| 交易聚合与成交量 | `research/js/tradeAggregate.js` |
| NPV 与摩擦成本 | `research/js/main.js` `reconcileTradingCost()` |
| 数据校验 | `node validate`（22 项断言） |
| C 组修复回归 | `research/js/cFixes.regression.test.js`（15 项） |
