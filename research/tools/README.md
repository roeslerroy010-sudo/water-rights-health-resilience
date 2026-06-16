# Research Data Pipeline Tools

This directory contains the first offline-bake scaffold for the research version of the Wuhan Metropolitan Area data layer.

## Current MVP

- `../data/wuhan-attrs.json` is a hand-authored 10-subbasin demo sample that follows the Appendix C contract.
- `../data/wuhan-subbasins.geojson` is simplified polygon geometry with ids aligned to `wuhan-attrs.json`.
- `../data/wuhan-rivers.geojson` is a small river-network visualization layer with coordinate-order flow direction properties.
- `../data/provenance.sample.json` shows the provenance schema expected from a future real bake. It is a sample only, not full-bake evidence.
- `validate_research_data.js` validates the data contract without third-party dependencies.

The sample is intentionally marked as `demoSample`, `estimated`, `synthetic`, and `realDataReady: false`. It is for front-end integration and pipeline testing only, not for research claims.

## Validate

Run from the `hackathon` directory:

```bash
node research/tools/validate_research_data.js
```

This is equivalent to:

```bash
node research/tools/validate_research_data.js --sample
```

Use sample mode for the current hand-authored 10-subbasin scaffold. It requires:

- `meta.demoSample: true`;
- `meta.estimated: true`;
- `meta.synthetic: true`;
- `meta.realDataReady: false`;
- 8-12 subbasins as OK, with a warning that the full bake should move to 30-80.

For a future real-data offline bake, run:

```bash
node research/tools/validate_research_data.js --full-bake
```

Full-bake mode requires:

- `meta.demoSample: false`;
- `meta.synthetic: false`;
- `meta.realDataReady: true`;
- 30-80 subbasins;
- `meta.calibrationYear`, `meta.source`, and `meta.note`;
- `meta.source` without placeholder language such as `Hand-authored`, `MVP`, `sample`, or `no files have been downloaded`.
- `../data/provenance.json` with audited source records covering `clcd`, `worldcover`, `worldpop`, `viirs`, `merit`, `hydrosheds`, `climate`, `gadm`, and `bulletin`.

Each provenance item must include a real input file name, `path`, `sourceUrl`, `downloadDate`, 64-hex `sha256`, `license`, and `processingScript`. The current scaffold is expected to fail `--full-bake` until the real CLCD/WorldPop/VIIRS/HydroSHEDS/Hubei Water Bulletin pipeline replaces the sample files and an audited provenance file is added.

`--full-bake` is not satisfied by flipping metadata flags. Before accepting `synthetic:false` and `realDataReady:true`, a human reviewer must compare `provenance.json` against the raw files and provider pages, confirm checksums and licenses, and verify the listed processing scripts were the ones used.

For CLI help:

```bash
node research/tools/validate_research_data.js --help
```

The validator checks:

- invalid numbers or strings that look like `NaN`;
- id alignment across attrs and GeoJSON;
- acyclic downstream topology and `downstreamReach`;
- Wuhan metro bbox compliance (`lng 112.5-116.0`, `lat 29.0-31.5`);
- required sector demand totals and city-sector totals;
- required supply, centroid, health weight, downstream, and river flow-direction fields;
- full-bake provenance structure, required source-category coverage, checksums, URLs, dates, paths, licenses, and processing scripts;
- combined static data size against the 3 MB target.

## Replacement Path For Real Data

1. Build the AOI from Wuhan city circle "1+8" administrative boundaries and dissolve to one study polygon.
2. Download or cloud-subset CLCD/WorldCover, WorldPop or LandScan, VIIRS VNL, MERIT-Hydro/HydroBASINS/HydroRIVERS, precipitation/ET0, and Hubei Water Bulletin city-sector totals.
3. Delineate 30-80 subbasins inside the AOI using MERIT-Hydro or HydroBASINS and extract downstream adjacency as a DAG.
4. Run zonal statistics for cropland, built-up area, population, industrial proxy weight, precipitation, and ET0 by subbasin.
5. Estimate sectoral demand:
   - agriculture = cropland hectares times calibrated irrigation norm;
   - urban = population times calibrated per-capita use;
   - industry = city industrial total allocated by built-up area times VIIRS weight;
   - ecology = reserved baseflow fraction or calibrated ecological water target.
6. Estimate supply from local runoff and routed upstream inflow, then calibrate against bulletin or gauge-scale quantities.
7. Simplify geometry and emit the three static files with ids and topology preserved.
8. Write `../data/provenance.json` from the audited raw inputs. Use `../data/provenance.sample.json` only as a template.
9. Run `node research/tools/validate_research_data.js --full-bake` before handing real baked data to the front end.

## Known Boundaries

- This MVP does not download or process public source data.
- Geometry is intentionally coarse and may overlap; it only exercises data loading, bbox, topology, and map rendering paths.
- Demand and supply values are plausible placeholders, not bulletin-calibrated measurements.
- The full research bake should target 30-80 subbasins and a documented calibration report.
- The sample provenance file is intentionally not evidence for `--full-bake`; full-bake provenance requires manual review of files, source pages, checksums, licenses, and processing scripts.
