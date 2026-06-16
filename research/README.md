# Research Data Layer

This folder contains the research data layer for the post-hackathon version described in `../REAL-DATA-UPGRADE-SPEC.md`.

## Data Contract

The current files under `data/` are the formal Wuhan Metropolitan Area 1+8 full-bake outputs:

- `data/wuhan-attrs.json`: Appendix C-style attributes, 66-subbasin topology, city-sector demand totals, supply estimates, health weights, centroids, and downstream reach arrays.
- `data/wuhan-subbasins.geojson`: simplified Pfafstetter level_6 subbasin polygons whose ids align with `wuhan-attrs.json`.
- `data/wuhan-rivers.geojson`: simplified river lines with flow direction, `flowThrough`, and subbasin routing fields.
- `data/provenance.json`: final provenance for the raw inputs used by the full bake.
- `data/provenance.sample.json`: an example provenance schema retained for reference only; it is not full-bake evidence.

The full-bake metadata is deliberately conservative: `demoSample:false`, `synthetic:false`, `realDataReady:true`, and `estimated:true`. It discloses that the Pfafstetter vector is project-provided with upstream source still unverified, that industrial downscaling uses World Bank Light Every Night with interpolation for missing months, and that unapproved mainstem inflow candidates are excluded from `qAvail`.

## Validate

From `hackathon/`:

```bash
node research/tools/validate_research_data.js --full-bake
```

The current `data/` files are full-bake outputs, so use `--full-bake` for validation.

The default command still runs sample mode for the historical scaffold, equivalent to:

```bash
node research/tools/validate_research_data.js --sample
```

Sample mode is retained only for the historical 10-subbasin scaffold and is not the current acceptance gate.

Full-bake mode requires `demoSample:false`, `synthetic:false`, `realDataReady:true`, 30-80 subbasins, present `calibrationYear/source/note`, source text that no longer contains placeholder sample language, `data/provenance.json`, all nine Wuhan 1+8 `citySectorDemand` entries, finite `supply.qLocal/qAvail/externalInflow/mainstemInflow`, and river `flowThrough` arrays.

`data/provenance.json` covers `clcd`, `worldcover`, `worldpop`, `viirs`, `merit`, `hydrosheds`, `climate`, `gadm`, and `bulletin`. Every item includes a real input file name, `path`, `sourceUrl`, `downloadDate`, 64-hex `sha256`, `license`, and `processingScript`.

Current validation evidence:

```text
node research/tools/validate_research_data.js --full-bake
Validation passed with 0 warning(s).
```

Passing `--full-bake` still requires manual provenance/source review before publication. In particular, `Basin_Asia.gdb.zip` is project-provided and upstream source is not independently verified.

Current formal intermediates under `tools/bake/intermediate/` include 66 AOI-clipped Pfafstetter level_6 units, formal `zonal.csv` with approved WB-LEN 12-month interpolated industrial proxy, formal `demand.csv`, formal `supply.csv`, formal `health.json`, `bake_metadata.json`, and final provenance metadata. Audit drafts remain for review and traceability.

CLI help is available with:

```bash
node research/tools/validate_research_data.js --help
```

Across both modes, the validator checks id alignment, no invalid numbers, DAG topology, bbox compliance, required sector totals, river flow direction fields, and data-size targets. In `--full-bake`, it additionally enforces the formal city set, explicit external/mainstem inflow fields, and river `flowThrough`.

## Real Bake Status

The MVP sample has been replaced by the full offline pipeline:

1. Build and store the Wuhan "1+8" AOI.
2. Delineate 30-80 river subbasins and downstream topology from the approved Pfafstetter level_6 vector source.
3. Compute zonal statistics from land cover, population, approved WB-LEN night lights, precipitation, ET0/proxy climate fields, and other public raster sources.
4. Calibrate city-sector demand totals to the Hubei Water Bulletin.
5. Route local and upstream supply through the DAG; mainstem candidates are conservatively excluded until a spatial injection rule is approved.
6. Emit the three static front-end files.
7. Create `data/provenance.json` from audited raw inputs, not from `data/provenance.sample.json`.
8. Rerun validation with `--full-bake`.
