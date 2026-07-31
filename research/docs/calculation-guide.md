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

### 2.1b 干流取水许可（2026-07-30 新增）

过境客水在中国水资源核算中**不计入水资源总量**，干流水须凭取水许可按量取用。
模型据此把过境水拆成两部分：

```
permittedTransit_i = transitShare_i × min(1, quota / totalTransit)
passThrough_i      = transitShare_i − permittedTransit_i
qSupply_i          = qLocal_i + permittedTransit_i          # 进入优化，可被取用
```

`passThrough` 仍在河道物理下泄，单独报告，**不计入 `environmentalFlow`**
（后者是本地可配置水量的河道留存，口径见 methodology.md）。

`quota` 默认 **40 亿 m³/yr**，UI 可调。改此参数前请先读
[`parameter-dossier.md`](parameter-dossier.md) §1——旧版把全部 3,552.8 亿 m³
过境水当作可配置供给，是导致模型全域无稀缺的根因。

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

**出清价 = LP 水量平衡约束的对偶值**（2026-07-30 起）。对偶值 λᵢ 的量纲是
元/m³，经济含义是节点 i 水的稀缺租金，即水权市场的出清价。这是求解器直接
解出的均衡价格，不是外生假定。展示的单一价格取按取水量加权的平均值，
同时报告空间价差区间与稀缺节点数。

```
λ_i        = dual(balance_i)                     # 元/m³，LP 直接给出
P_market   = Σ_i λ_i · withdrawn_i / Σ_i withdrawn_i
```

默认参数（τ=24%、摩擦 0.10 元/m³、SSP2-4.5、干流许可 40 亿 m³）下
`P_market = 0.1612 元/m³`，空间价差 0.000–1.172 元/m³，8/66 节点稀缺。
SSP5-8.5 下升至 0.7946 元/m³，66/66 节点稀缺。

> **外部验证**：该值落在《水资源税改革试点实施办法》（财税〔2024〕28 号）
> 湖北地表水最低平均税额 0.1 元/m³ 与试点期平均 0.43 元/m³ 之间。
> 见 [`parameter-dossier.md`](parameter-dossier.md) §3。

**旧公式**（保留为启发式回退路径的取值，`marketPriceFormula`）：
`0.35 + scarcity×0.9 + τ×0.04 + tradingCost×0.5`。该式在默认参数下报价
0.4096 元/m³，而同一次求解的真实影子价格为 0——因为当时整条长江被当作
可自由配置供给注入，全域不存在稀缺。详见
[`economics-audit.md`](economics-audit.md) F1/F2。

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

## 6. 健康产出（2026-07-30 重构）

**政策旋钮 τ 与 healthFloor 不出现在本节任何公式里。** 它们只能通过改变配水
结果间接影响健康。旧实现 `avoidedPer100k = 9 + 28·climateStress + 11·healthFloor
+ 18·τSignal` 把 τ 直接写进健康收益，属循环论证；且城市供水覆盖率恒为 1，
公式实际塌缩为「人口 × 政策旋钮多项式」，与配水完全无关。
详见 [`economics-audit.md`](economics-audit.md) F3/F4。

### 6.1 因果链

```
τ ↑ → 工业取水 ↓ → 废水负荷 ↓ / 河道流量 ↑ → 浓度 ↓ → PAF ↓ → DALY 负担 ↓
```

### 6.2 两条暴露通路（均只以配水结果为自变量）

**通路 A — 生活供水缺口**

```
serviceGap_i = clamp(1 − x_urban_i / D_urban_i, 0, 1)
RR_i         = 1 + 2.0 × serviceGap_i
PAF_i        = (RR_i − 1) / RR_i
burden_A_i   = pop_i/1e5 × 1244.29 × PAF_i
```

1244.29 = 全球「不安全 WaSH」年 DALY 率（GBD 2019；JOGH 2024;14:04162），
用作「生活供水完全失效」的满暴露上限。

**通路 B — 河道稀释能力**（当前的主导通路）

```
effluent_i      = 0.151 × x_industry_i
cumEffluent_i   = effluent_i + Σ(上游 cumEffluent)      ← 污染沿河道累积
loadRatio_i     = cumEffluent_i / inStreamFlow_i
excess_i        = max(0, loadRatio_i / 0.0625 − 1)
RR_i            = 1 + 1.0 × excess_i
burden_B_i      = pop_i/1e5 × 92.42 × PAF(RR_i)
```

- `0.151` = 工业废水排放量 / 工业取水量（2022 全国：146.7 亿 t / 968.4 亿 m³）
- `0.0625` = 临界负荷比，由两项国标推出：受纳水体达 GB 3838-2002 III 类
  （COD ≤ 20 mg/L），工业废水按 GB 8978-1996 一级标准（COD ≤ 100 mg/L）
  排放、本底 15 mg/L，解 `(100E + 15F)/(E+F) = 20` 得 `E/F = 0.0625`
- `92.42` = 东亚「不安全 WaSH」年 DALY 率（同上文献，95% UI 65.07–123.33）
- **污染沿拓扑累积**，上游排污由下游人口承担——这正是庇古税要内部化的外部性。
  每个人只在自己所在节点被计一次，不重复计数。

⚠️ `BETA_SERVICE_GAP = 2.0` 与 `BETA_DILUTION = 1.0` 是**占位斜率**，
B1 必须以 GBD 分病种 RR 替换。

### 6.3 「避免的 DALY」需要反事实

模型本身只输出**负担**。「避免量」在比较层计算：

```
dalyAvoided = dalyBurden(τ=0，同气候同交易设置) − dalyBurden(当前 τ)
```

这样 τ 就只能通过配水影响健康，循环论证被消除。实现见
`main.js attachNoTaxComparison`。

### 6.4 实测（默认 SSP2-4.5、干流许可 40 亿 m³）

| τ | 工业废水 | DALY 负担 | 供水缺口通路 | 稀释通路 | DALY 避免 |
|---|---|---|---|---|---|
| 0% | 8.02 亿 m³ | 9,951.4 | 0.0 | 9,951.4 | — |
| 24% | 7.12 亿 m³ | 7,990.9 | 0.0 | 7,990.9 | **1,960.6** |
| 50% | 6.14 亿 m³ | 5,455.3 | 0.0 | 5,455.3 | **4,496.1** |

四档气候（τ=24%）：historical 3,994.4 < ssp245 7,990.9 < dry 9,198.0 < ssp585 10,725.1。
气候通过「径流减少 → 稀释流量下降 → 浓度上升」影响健康，不再有独立的气候系数。

> **供水缺口通路恒为 0 是真实结果**：武汉都市圈的生活用水在各情景下都能满足，
> 健康风险不来自「没水喝」，而来自**工业废水的稀释不足**。这也正是把庇古税
> 加在工业取水上的正当性所在。

### 疾病例数与货币化

```
diseaseCases     = dalyAvoided / 0.18       （DISEASE_CASE_DALY，前端代理折算）
healthBenefit    = dalyAvoided × ¥125,000   （VALUE_PER_DALY）
tradingCost      = tradedVolume × 单位交易成本(元/m³)
deadweightLoss   = Σ_i ½ · Δq_i · taxPerM3_i   ← 庇古税的社会成本
taxRevenue       = Σ_i taxPerM3_i · x_industry_i  ← 转移支付，不计入社会成本
netSocialBenefit = healthBenefit − tradingCost − deadweightLoss
```

**为什么社会成本是无谓损失三角形而不是被减掉的水的全价**：企业面对水价上涨
不会等比例减产，而是投资节水与循环利用。弹性 ε 已经蕴含「企业可以替代」，
按全价计损失等于既承认弹性又假装没有弹性。默认参数下两种口径相差 30 倍
（0.29 亿元 vs 8.65 亿元），详见 [`economics-audit.md`](economics-audit.md) §4.1。

**「NPV」已更名为「年度净社会收益」**：原口径是单年、无贴现、无年限，
叫 NPV 不成立。若要做真 NPV，社会折现率可引国家发改委《建设项目经济评价
方法与参数（第三版）》的 8%。

默认参数下：健康收益 9.92 亿元 − 无谓损失 0.29 亿元 − 摩擦 0 = **9.63 亿元/年**；
另有健康税收入 **4.60 亿元/年**（转移支付，可定向用于供水管网与 WASH 投资）。

---

## 7. 两个反事实必须分开读

| 面板 | 比较 | 回答的问题 | 预期方向 |
|---|---|---|---|
| 健康税效应 | `withTrade(τ) − withTrade(τ=0)` | 健康税本身的政策效应 | 工业取水↓、环境流量↑、DALY↑ |
| 交易效率 | `withTrade(τ) − autarky(τ)` | 允许交易相对自给自足的配置效率 | 工业配水可能↑ |

**交易效率面板里工业用水上升不等于健康税失效**——那是交易让缺水部门买到水的
效率效应。混读这两个面板是本项目最容易被误解的地方。

实测健康税方向（默认 SSP2-4.5、干流许可 40 亿 m³，全域；2026-07-30 复算）：

| τ | 水影子价格 | DALY 负担 | DALY 避免 | 健康收益 | 无谓损失 | 税收收入 | **年度净社会收益** |
|---|---|---|---|---|---|---|---|
| 0% | 0.3384 元/m³ | 9,951.4 | — | — | 0 | 0 | — |
| 24% | 0.1612 元/m³ | 7,990.9 | 1,960.6 | 2.45 亿 | 0.29 亿 | 4.60 亿 | **2.16 亿元** |
| 50% | 0.1243 元/m³ | 5,455.3 | 4,496.1 | 5.62 亿 | 1.26 亿 | 8.27 亿 | **4.36 亿元** |

> **一个内生结论**：健康税提高会**降低**水的影子价格（0.338 → 0.161 → 0.124）。
> 税压缩了工业需求，缓解了稀缺，租金随之下降。这不是假设出来的，是解出来的。

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
| Trading cost | 0.10 元/m³ | 0.02–0.24 元/m³ |
| 干流取水许可 | 40 亿 m³/yr | 可调 |

---

## 9. 参数出处状态

**物理与水文数据**溯源完整：`research/data/provenance.json` 共 41 条目，覆盖
CLCD / WorldCover / WorldPop / VIIRS / MERIT / HydroSHEDS / 气候 / GADM / 湖北水资源公报
九类来源，并显式标注 `estimated: true` 与低置信度字段。

**经济参数**已建档，见 [`parameter-dossier.md`](parameter-dossier.md)。摘要：

| 常量 | 值 | 状态 |
|---|---|---|
| 干流取水许可 | 40 亿 m³/yr | ✅ 依据武汉市水务局 2024 年过境客水与用水总量数据标定 |
| 工业弹性 `ε` | 0.90 | ✅ 文献区间 0.3–2.3，需报区间；武汉重复利用率已 94.2%，中心值宜下调 |
| 水影子价格（输出） | 0.1612 元/m³ | ✅ 落在财税〔2024〕28 号的 0.1–0.43 元/m³ 实际税率区间内 |
| `VALUE_PER_DALY` | ¥125,000 | ✅ ≈1.46× 人均 GDP，须报 ¥86k–¥257k 区间 |
| 交易摩擦 | 0.10 元/m³ | ⚠️ 量纲已修，取值待标定 |
| `CLIMATE_AVAILABILITY` | 0.86/0.82/0.70 | 🟡 待查 CMIP6 |
| `INDUSTRY_DEMAND_FLOOR_FRACTION` | 0.40 | 🟡 待查 DB42/T 用水定额 |
| `DEFAULT_SECTOR_VALUE` | 3.2/2.4/1.45/1.15 | 🟡 待查 |
| 健康底线罚则 | 100 元/m³ | ✅ 已从 big-M 1e6 改为可解释值 |
| `DEFAULT_COMPLIANCE_COST` | 0.28/0.08/0.18/0.52 | 🔴 定义不明 + 代码里乘 0.01 疑似 bug |
| `HEALTH_LOSS_COEFF.industry` | 0.52 | 🔴 同时充当税基与需求收缩系数，一值两用，须拆分 |
| 健康剂量—反应链 | 见 §6 | ✅ 结构已重构：政策旋钮不再进入健康函数，避免量改由 τ=0 反事实定义 |
| `INDUSTRY_DISCHARGE_COEFF` | 0.151 | ✅ 2022 全国工业废水排放量/工业用水量 |
| `CRITICAL_LOAD_RATIO` | 0.0625 | ✅ 由 GB 3838-2002 III 类与 GB 8978-1996 一级标准推出 |
| WaSH DALY 率 | 1244.29 / 92.42 每 10 万 | ✅ GBD 2019（JOGH 2024;14:04162）全球/东亚值 |
| `BETA_SERVICE_GAP` / `BETA_DILUTION` | 2.0 / 1.0 | 🔴 **占位斜率**，B1 必须以 GBD 分病种 RR 替换 |
| `DISEASE_CASE_DALY` | 0.18 | 🔴 需 GBD 分病种权重 |

✅ **F3/F4 已于 2026-07-30 修复**：健康产出改为剂量—反应链，政策旋钮只能通过
配水结果影响健康；「避免量」改由 τ=0 反事实定义。结构问题已解决，
**剩下的是两条暴露—反应斜率的校准（B1）**。

⚠️ 在斜率校准完成前，所有健康数值应表述为"选定参数下的模型模拟输出"，
不作为真实成交或因果评估结论。

⚠️ **另一个已知问题**：启发式回退路径（GLPK 未就绪时）在 SSP5-8.5 下会因
`riverRetentionValue`(1.296) 高于农业部门用水价值(1.15) 而把农业整体挤出配置、
出流反而暴涨，使健康负担不升反降。LP 生产路径用的是按下游节点数归一化后的
留存权重，无此问题。这是回退路径既有缺陷，待单独修复。

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
