# Water Rights Trading for Health Resilience — Design Spec

**Hackathon for Next-generation (ACTION)** | Seed Track | Theme 4: Water-related technologies for climate and health adaptation
**Team:** 2 members, Master's in Population, Resources and Environmental Economics, Peking University
**Deadline:** June 16, 2026 (1-hour presentation)

---

## 1. Product Positioning

**One-liner:** An interactive decision-support tool that helps watershed managers design water rights markets that prioritize health outcomes under climate uncertainty.

**Target users (for demo):** Competition judges — the tool demonstrates how economic mechanism design can solve a climate-health problem that technology alone cannot.

**Differentiator:** Traditional water markets optimize for economic efficiency. Our design embeds health externalities into the price mechanism, making water allocation health-aware by construction.

---

## 2. Core Mechanism

### 2.1 The Problem

Climate change → extreme droughts/floods → water scarcity → water-borne disease + unsafe drinking water → health crisis.

Command-and-control water management fails because it cannot dynamically reallocate water to where health value is highest. Standard water rights markets fail because they ignore health externalities.

### 2.2 The Solution: Health-Prioritized Water Rights Market

Three layers:

1. **Cap Setting:** Total basin extraction cap = ecological base flow + climate scenario adjustment. Dynamically updated each year based on drought index.
2. **Initial Allocation:** Each water user receives an initial quota. Health-sensitive users (drinking water plants, hospitals) receive priority weighting.
3. **Trading + Health Tax:** Free trading, but polluting water uses pay a health externality tax (Pigouvian tax).

### 2.3 Core Equation

```
P_trade = P_market + τ × H_loss × DALY(Q)
```

Where:
- **P_trade**: actual transaction price
- **P_market**: market-clearing price from supply/demand
- **τ**: health tax rate (user-adjustable parameter)
- **H_loss**: health loss coefficient by water use type
- **DALY(Q)**: disease burden as a function of water quality

### 2.4 User-Adjustable Parameters

| Parameter | Economic Meaning | Range |
|-----------|-----------------|-------|
| τ (health tax rate) | Pigouvian tax internalizing health externality | 0% – 50% |
| Climate scenario | Supply shock to water availability | SSP2-4.5 / SSP5-8.5 |
| Health floor (quota %) | Minimum allocation reserved for health-priority users | 10% – 40% |
| Trading cost | Transaction friction affecting market efficiency | Low / Medium / High |

---

## 3. Interactive Demo Tool

### 3.1 Layout

Three-column single-page layout:
- **Left (25%):** Parameter panel — sliders and dropdowns
- **Center (45%):** Watershed map — water rights visualization, user locations, health risk hotspots
- **Right (30%):** Health dashboard — DALY avoided, disease reduction, economic NPV, quota gap

### 3.2 Three User Flows

1. **Parameter Tuning:** Drag τ from 0%→30%, observe how health outcomes change. Demonstrates optimal tax rate concept.
2. **Scenario Comparison:** Switch between SSP2-4.5 and SSP5-8.5 to see how climate impacts market performance.
3. **Incentive Diagnosis:** Check whether any water user has incentive to deviate from rules under current parameters (incentive compatibility).

### 3.3 Tech Stack

- **Frontend:** HTML + CSS + JavaScript (static, no framework)
- **Map:** Mapbox GL JS or Leaflet (free tier)
- **Model:** Pre-computed lookup tables + parameter interpolation (all client-side JS)
- **Data:** Public data + scenario parameters hardcoded as JSON
- **Deployment:** GitHub Pages (free, one-click)

**No backend, no database, no API.**

### 3.4 Visual Quality

- Nature/water-themed imagery for premium feel
- Smooth transitions and polished interactions
- Reference sites: high-end environmental dashboards, climate data portals

---

## 4. Data Strategy

| Layer | Content | Sources |
|-------|---------|---------|
| **Real Data** | Basin hydrology, climate projections, health statistics | China Water Resources Bulletin, CMIP6, China Health Statistics Yearbook, GBD |
| **Literature-Calibrated** | Water-health dose-response, market elasticity parameters | Lancet, EHP, JEEM, China water rights pilot reports |
| **Design Scenarios** | User-adjustable ranges, demo case | Based on real data ranges with reasonable assumptions; clearly labeled |

All data processed in Stata → exported as JSON for the tool.

---

## 5. Presentation Structure (1 Hour)

| Part | Time | Slides | Content |
|------|------|--------|---------|
| 1: The Problem | 10 min | 1-4 | Climate→water→health chain, command-control failure, why water markets |
| 2: Our Solution | **20 min** | 5-8 | Market design, health tax mechanism, **live demo**, scenario comparison |
| 3: Impact + Roadmap | 10 min | 9-11 | Health gains quantified, scalability, implementation roadmap |
| 4: Close + Q&A | 10 min | 12 | Team + thank you + QR code → Q&A |

**Key principle:** Show, don't tell. Live demo is the centerpiece (Slide 7).

---

## 6. Deliverables

1. **Interactive web tool** — deployed on GitHub Pages, accessible via QR code
2. **PPT deck** — 12 slides, polished design, embedded Stata charts
3. **Demo script** — 5-minute walkthrough of the tool for the live demo segment

---

## 7. Constraints & Assumptions

- All model outputs are illustrative (demonstrates mechanism, not calibrated to a specific real basin)
- The tool is a proof-of-concept for seed track — not a production system
- 4-day timeline (June 12–16)
- Team has strong Stata/Econ skills but no web development experience — all web code will be generated
