# Research Frontend And Data Layer

This folder is the current formal implementation of the water-rights and health-resilience demo.

## What Runs

- `index.html`: Chinese research UI for Wuhan Metropolitan Area subbasins.
- `css/`: layout, map, dashboard, and rich-panel styling.
- `js/`: spatial rendering, region selection, market solver, GLPK loader, charts, and tests.
- `vendor/leaflet/`: local Leaflet runtime used by the static page.
- `vendor/glpk.js/`: minimal local GLPK runtime used by the LP solver path.
- `data/`: generated static data consumed directly by the frontend.

## Data Contract

The current files under `data/` are Wuhan Metropolitan Area 1+8 full-bake outputs:

- `data/wuhan-attrs.json`: 66-subbasin topology, city-sector demand totals, supply estimates, health weights, centroids, and downstream reach arrays.
- `data/wuhan-subbasins.geojson`: simplified Pfafstetter level_6 subbasin polygons whose ids align with `wuhan-attrs.json`.
- `data/wuhan-rivers.geojson`: simplified river lines with flow direction, `flowThrough`, and subbasin routing fields.
- `data/provenance.json`: provenance for the raw inputs used by the full bake.

The metadata is deliberately conservative: `demoSample:false`, `synthetic:false`, `realDataReady:true`, and `estimated:true`. It discloses that the Pfafstetter vector is project-provided with upstream source still unverified, that industrial downscaling uses World Bank Light Every Night with interpolation for missing months, and that unapproved mainstem inflow candidates are excluded from `qAvail`.

## Validate

From the repository root:

```bash
node research/tools/validate_research_data.js
node research/tools/validate_region_feature.js
```

`validate_research_data.js` defaults to full-bake validation for this cleaned repository. Passing validation still requires human review of provenance and source licensing before public research claims. In particular, `Basin_Asia.gdb.zip` is project-provided and upstream source is not independently verified.

## Bake Status

The frontend does not need local raw archives. The large source files formerly under `tools/bake/raw/` were removed from the repository working tree to keep the GitHub version lean. Rebuilds should recreate `raw/`, `intermediate/`, and `out/` locally from the instructions in `tools/bake/fetch_data.md` and `tools/bake/download_attempts.md`.
