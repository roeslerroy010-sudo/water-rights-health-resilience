# Demo Script — Water Rights Trading for Health Resilience

**Duration:** 5 minutes (within 20-min Part 2)  
**URL (EN):** https://roeslerroy010-sudo.github.io/water-rights-health-resilience/  
**URL (ZH):** https://roeslerroy010-sudo.github.io/water-rights-health-resilience/zh/

---

## Pre-flight (before presentation starts)

- [ ] Open browser, load the tool
- [ ] Confirm map renders, dashboard shows numbers
- [ ] Pre-set sliders to defaults: τ=15%, Health Floor=25%, SSP2-4.5, Medium cost
- [ ] Have a second tab ready with just the tool (no browser chrome if possible, F11 fullscreen)

---

## The Walkthrough

### Step 0 — Setup (15s)

> "This is our interactive decision-support tool. It simulates a water rights market in a watershed — in this case, the Middle Yangtze Basin. You see six water users on the map: municipal drinking water in green, agriculture in orange, industry in red, and hydropower in purple. The size of each node reflects how much water they receive."

**Action:** Point cursor at the map, hover over the green municipal water node to show the popup.

---

### Step 1 — The Baseline (45s)

> "Right now, we're looking at a moderate climate scenario — SSP2-4.5. The market price is ¥0.53 per cubic meter. The dashboard on the right shows we're avoiding about 110,000 DALYs and reducing water-borne disease by 22%, with an economic benefit of over 200 billion RMB. The incentive status is green — all users are following the rules."

**Action:** Point to each dashboard card as you mention them. Highlight the green "激励相容" badge.

---

### Step 2 — Introduce the Health Tax (1 min)

> "Now let me show you what happens when we introduce a health tax — our core mechanism. This slider controls τ, the Pigouvian tax rate on health-damaging water use. Watch what happens as I increase it."

**Action:** Slowly drag τ from 15% → 35%.

> "Look at the map. The industrial nodes — the red ones — are shrinking. That's because the health tax makes polluting water more expensive, so they use less. Meanwhile, the green municipal water node stays the same size — it's protected by the health floor. The red rings around the industrial nodes mean they're being taxed for their negative health impact."

> "On the dashboard: DALY avoided goes up, disease reduction increases. The market is redirecting water toward healthier outcomes — automatically, through the price mechanism."

**Action:** Point to the changing numbers on the dashboard.

---

### Step 3 — Climate Shock (1 min)

> "Now let's see what happens under a worse climate scenario. I'm switching from SSP2-4.5 to SSP5-8.5 — the high-emission pathway."

**Action:** Switch climate dropdown to SSP5-8.5.

> "Immediately, total water availability drops 28%. The tradable water shrinks, the market price jumps. But look — the health-priority quota still protects the municipal water supply. The system adapts automatically."

> "Without this market mechanism, in a drought, water would go to the highest bidder — probably industry. Our design ensures health comes first."

---

### Step 4 — Break the System (1 min)

> "Let me show you what happens when the mechanism is poorly designed. I'll lower the health priority quota to 10% and raise the health tax to 40%."

**Action:** Drag health floor to 10%, τ to 40%.

> "The incentive status turns red. It now says '激励不相容' — incentive incompatible. The tool tells us exactly which users might deviate: the chemical industry. The tolerance is too tight, they can't afford to comply."

> "This is the power of the tool — it doesn't just show happy paths. It helps policymakers avoid bad designs by flagging when the incentives don't work."

---

### Step 5 — The Comparison (45s)

> "Finally, look at the bar chart at the bottom right. Green bars are with our market design. Gray bars are without any market. The difference is stark — especially in DALY avoided and economic value."

**Action:** Point to the chart.

> "This is the core message of our project: well-designed water markets don't just allocate water efficiently — they save lives and generate enormous economic value. The key is getting the incentives right."

---

### Step 6 — Closing (15s)

> "The tool is live at this URL, and you can try it yourself after the presentation. Thank you."

**Action:** Point to the footer URL or have a QR code slide ready.

---

## Key Talking Points (if asked)

| Question | Answer |
|----------|--------|
| Is this based on real data? | Parameters are calibrated from China Water Resources Bulletin, CMIP6, and WHO DALY guidelines. The watershed is a stylized Middle Yangtze for demonstration. |
| Can this scale to real basins? | Yes — the model accepts any set of water users, allocations, and health coefficients. Replace the JSON config with real basin data. |
| What makes this different from existing water markets? | Existing markets optimize for economic efficiency. We embed health externalities into the price — water transactions carry a health tax calibrated to their pollution profile. |
| How did you build this? | Pure static frontend — HTML/CSS/JS with Leaflet and Chart.js. No backend, no database. Deployed on GitHub Pages. |
