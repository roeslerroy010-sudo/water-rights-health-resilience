# Methodology Notes

## PRE-1 Transit Supply Injection

The formal supply bake treats two Hubei Water Resources Bulletin 2022 table 5
mainstem provincial-boundary inflows as Wuhan 1+8 AOI transit proxies:

- Yangtze mainstem inflow: `355275000000` m3/yr injected at `PF_465500`.
- Han mainstem inflow: `17553000000` m3/yr injected at `PF_465610`.

The province-total inflow and Han-system aggregate are excluded to avoid double
counting. The same values are written to `supply.externalInflow` and
`supply.mainstemInflow`; routed `qAvail` adds `externalInflow` once and carries
the added volume downstream along the approved topology.

This is an estimated research-data treatment rather than an observed Wuhan 1+8
boundary-flow measurement. Injection-node assignment remains low confidence
because the HydroRIVERS routing evidence does not independently verify river
names at the selected Pfafstetter nodes.

## Environmental Base-Flow Scope and Baseline Calibration

The ecological base-flow floor is scoped to local runoff and tributary
environmental safeguards. Yangtze and Han mainstem transit inflows are natural
river flow passing through the AOI; they are not multiplied by `ecoFloor` and
reserved again as a local environmental claim. The modeled floor is therefore:

`ecoBaseFlow_i = min(0.95 * localRunoff_i, max(ecoFloor * localRunoff_i, legacyEcoNeed_i))`.

Operationally, this means the environmental constraint protects local streams
and tributary nodes from over-withdrawal, while unwithdrawn mainstem transit
water remains in the river as natural downstream flow. Ecological base flow is
not modeled as a withdrawal sector.

The calibrated baseline reflects the Wuhan 1+8 water-accounting premise that
normal-year total supply is ample: local runoff plus accessible Yangtze/Han
transit water is sufficient for urban, agricultural, and industrial demands to
be basically met. Markets, health taxes, and ecological base-flow safeguards are
therefore interpreted as marginal allocation mechanisms for drought and SSP5
stress periods, when available water tightens and the allocation trade-offs
become visible. In normal SSP2-style years, large sectoral deficits are treated
as a calibration failure rather than a substantive result.

## Derived Subbasin Labels

The `subbasins[].name` values in `wuhan-attrs.json` are derived readable labels,
not official place names. The bake assigns each subbasin a Chinese label from
the primary overlapping Wuhan 1+8 city, a land-use feature inferred from
`zonalProxy`, `areaKm2`, and `population`, and a north-to-south sequence number
within repeated city-feature groups.

中文展示名为派生标签，非官方地名；它们只用于让地图、弹窗和表格更容易阅读。
Pfafstetter identifiers remain the technical IDs in `id` and `code`, with
`pfafId` retained when available from the source vector.

## Autarky Baseline for Trade-Flow Correction

The trade-flow correction uses an autarky, or self-sufficiency, baseline rather
than routed physical outflow. A water-rights trade is defined as the allocation
difference between the solved market case and this no-trade baseline:

`nodeDelta_i = allocation_withTrade_i - allocation_autarky_i`.

In Chinese project notes this is `口径 R`. Transit water is not treated as a
market transaction merely because it physically passes through a downstream
reach. Before solving autarky, each mainstem transit injection is preallocated
to eligible downstream nodes by a fixed default rule:

`transitShare_{i,k} = transitVolume_k * demand_i / sum(demand_j for j in D_k)`.

Here `D_k` is the downstream recipient set for transit injection `k`; `demand_i`
is the node's total modeled sector demand for the same scenario. If the
recipient demand sum is zero, the share is zero rather than creating a trade.

The node's own water right under autarky is therefore:

`ownWaterRight_i = qLocal_i + sum_k(transitShare_{i,k})`.

The autarky solve constrains each node's total withdrawal to its own water right
and does not allow cross-node market reallocation. Before sector withdrawals are
allocated, the node reserves its local-runoff ecological base flow; the remaining
available water is then allocated to the withdrawal sectors in a
health-protective order: urban, agriculture, and industry. The resulting metadata
should expose the baseline as `autarky`, the transit rule as demand-proportional
`口径 R`, and the per-node `transitShare` and `ownWaterRight` values used by the
trade aggregate.

Any map arrows, Sankey rows, or trade tables labeled as water-rights trading
must use this `withTrade - autarky` market reallocation. Physical routed outflow,
including `bulk-routed-outflow`, is river transport and must not be counted or
displayed as a market trade unless it is placed in a separately labeled physical
routing layer.

The no-tax comparison remains a separate policy counterfactual from the autarky
or no-market comparison. `noTax` keeps the market allocation architecture but
removes the health-tax wedge, isolating the tax's effect on sector allocation
and health damages. `autarky`/`noMarket` removes cross-node market reallocation,
isolating the value of trading relative to self-sufficiency. This distinction is
unchanged by the ecological base-flow scope correction.

## Health-Tax Effectiveness and Trade-Scope Interpretation

The health tax is interpreted as a Pigouvian tax on the downstream health
externality of industrial water use. It internalizes that external cost into
industrial water demand, so industrial withdrawals should fall smoothly as
`tau` rises rather than staying flat until a cliff-like shutdown. In the
display panels, the intended response is therefore:

`tau up -> industrial withdrawal down smoothly; environmental flow up; DALY avoided up`.

The no-tax counterfactual keeps trading enabled and changes only `tau`: the
reported delta is always `current - tau0`. Under the default parameterization,
policy effectiveness is shown when industrial withdrawal is negative, while
environmental flow and DALY avoided are positive. This comparison is separate
from the autarky/no-market baseline, which remains the `withTrade - autarky`
test of market reallocation.

The two dashboard comparisons therefore answer different questions. The
health-tax panel is a policy-effect comparison:
`withTrade(tau_current) - withTrade(tau0)`. Its expected signs are industrial
withdrawal down, environmental flow up, and DALY avoided up. The trade-efficiency
panel is an allocation-efficiency comparison:
`withTrade(tau_current) - autarky(tau_current)`. If industrial allocation rises
there, the result means water-rights trading lets water-short industrial users
buy water from the market relative to self-sufficiency. It is an efficiency
effect of trade, not evidence that the health tax failed.

Water freed by the health tax is first interpreted as internal regional
reallocation or water left in the channel for ecological flow. External transfer
is a switchable supplement, not a required condition for the health-tax result:
in `external` mode the model may include boundary/mainstem inflow, while in
`internal` mode boundary inflow is closed and the market resolves scarcity
inside the selected region.

中文结论：健康税（庇古税）将工业下游健康外部性内化为用水成本，促使工业随税率
平滑减少取水；腾出的水在本区域内部再配给健康用途，或留在河道形成生态/环境
流量。外部调水只是可切换补充，不是政策有效性的前提。健康税面板衡量的是
`有交易且当前税率 - 有交易且零税率` 的政策效应；交易效率面板衡量的是
`有交易 - 自给自足` 的配置效率。后一面板若出现工业用水增加，含义是交易让
缺水部门买到水，不能解读为健康税政策失效。
