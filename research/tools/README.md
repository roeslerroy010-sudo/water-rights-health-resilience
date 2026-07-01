# Research Tools

This directory contains the validation and offline-bake tooling for the current research frontend.

## Current Data

The active frontend reads generated files from `../data/`:

- `wuhan-attrs.json`
- `wuhan-subbasins.geojson`
- `wuhan-rivers.geojson`
- `provenance.json`

These files are the current full-bake outputs and are small enough to keep in Git. Large raw downloads are intentionally excluded.

## Validate

Run from the repository root:

```bash
node research/tools/validate_research_data.js
node research/tools/validate_region_feature.js
```

`validate_research_data.js` now defaults to full-bake mode. It checks metadata flags, Wuhan 1+8 city-sector coverage, id alignment, topology, bbox compliance, source provenance categories, checksums, URLs, dates, paths, licenses, river flow-through fields, and static data size.

`validate_region_feature.js` checks the interactive policy mechanism, including the expected relationship that raising the health tax lowers industrial withdrawal while improving health and environmental-flow indicators.

## Offline Bake

`bake/` keeps the reproducible pipeline code and download notes. Its generated working folders are local-only:

```text
bake/raw/             source archives and rasters, excluded from Git
bake/intermediate/    derived working files, excluded from Git
bake/out/             preview or stub outputs, excluded from Git
```

To regenerate the research data, recreate the raw inputs from `bake/fetch_data.md`, run the bake CLI, then rerun both validators before replacing files under `research/data/`.
