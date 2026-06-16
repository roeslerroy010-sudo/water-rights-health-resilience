# Wuhan Real-Data Bake Pipeline

This directory contains the offline-bake scaffold for the research data layer. It implements the T0.1/T0.3/T0.4/T1.0 code and documentation pieces from `REAL-DATA-WORK-ORDER.md`.

## Default Path

The default full run is **A. local download and clip-on-ingest**.

Reason:

- It preserves the complete raw-data audit trail required by `research/data/provenance.json`.
- It matches the work order's full-run requirement: CLCD plus 10 m WorldCover and original VIIRS/MERIT/HydroSHEDS source files are retained under `raw/`.
- It lets the final validator and human reviewer confirm that `synthetic:false` is backed by real inputs, not by metadata flipping.

Google Earth Engine is a fallback only. Use it when local disk or memory is not enough, or when a dataset is materially easier to subset in the cloud. GEE-derived outputs must still preserve script names, asset IDs, export dates, and checksums in provenance before replacing `research/data`.

## Environment

Recommended conda setup from the `hackathon/` directory:

```bash
conda create -n water-bake -c conda-forge python=3.11 geopandas rasterio rioxarray xarray pyflwdir shapely numpy pandas pyproj fiona pyogrio rasterstats gdal
conda activate water-bake
pip install -r research/tools/bake/requirements.txt
npm install mapshaper
python -c "import geopandas,rasterio,rioxarray,xarray,pyflwdir,shapely,numpy,pandas,fitz; print('env ok')"
```

Venv fallback:

```bash
python -m venv .venv-bake
source .venv-bake/bin/activate
python -m pip install --upgrade pip
python -m pip install -r research/tools/bake/requirements.txt
npm install mapshaper
```

Current local status as of 2026-06-14: `conda`, `mamba`, and `micromamba` are not available, so Codex created the workspace-local `.venv-bake/` environment and installed the Python GIS stack there. Use `.venv-bake/bin/python` for real bake commands that need rasterio/geopandas/pyflwdir. `mapshaper@0.7.23` is installed as a local npm dependency; use `./node_modules/.bin/mapshaper` or `npx mapshaper`. Verification:

```bash
.venv-bake/bin/python -c "import geopandas,rasterio,rioxarray,xarray,pyflwdir,shapely,numpy,pandas,fitz; print('env ok')"
./node_modules/.bin/mapshaper -v
```

`sharp@0.35.1` is installed, and both `require("sharp")` and a tiny PNG transform passed locally. GIS zonal processing still uses the Python rasterio/geopandas/rasterstats path because it is already wired to the bake pipeline.

## Hardware Assumptions

Full local bake expects:

- Disk: at least 50 GB free before download.
- Memory: 16 GB minimum, 16-32 GB preferred when 10 m WorldCover is processed locally.
- CRS: source rasters and outputs are normalized to EPSG:4326 for the front-end contract unless an intermediate projected CRS is explicitly documented.

If these checks fail, do not fake full-bake outputs. Record `BLOCKED` and use `--stub` only for synthetic logic integration.

Preflight command:

```bash
python research/tools/bake/bake.py hardware
```

This prints disk and physical-memory evidence for T0.2. It writes no data files.

## Directory Contract

All paths below are relative to `hackathon/research/tools/bake/`.

```text
bake.py                 Main CLI entrypoint.
requirements.txt        Python dependencies for the offline bake.
fetch_data.md           Public-download and credential checklist; Codex attempts public downloads first.
download_attempts.md    Audit trail for download attempts, successes, and credential blocks.
industrial_proxy_decision.md
                        T1.3 nightlight/industrial-weight decision log.
raw/                    Real source files, never synthetic placeholders.
  clcd/
  worldcover/
  worldpop/
  viirs/
  merit/
  hydrosheds/
  climate/
  gadm/
  bulletin/
intermediate/           Derived working files for AOI, topology, tables, and checks.
out/                    Stub or preview bake outputs; safe to delete and regenerate.
```

Only a real, provenance-backed run may replace:

```text
hackathon/research/data/wuhan-subbasins.geojson
hackathon/research/data/wuhan-rivers.geojson
hackathon/research/data/wuhan-attrs.json
hackathon/research/data/provenance.json
```

The current scaffold intentionally refuses to write those `research/data` files when source data are missing.

## CLI

List steps:

```bash
python research/tools/bake/bake.py --help
```

Inspect one step:

```bash
python research/tools/bake/bake.py aoi --help
```

Run a real step after raw data are present:

```bash
python research/tools/bake/bake.py hardware
python research/tools/bake/bake.py aoi
python research/tools/bake/bake.py subbasins
python research/tools/bake/bake.py zonal
python research/tools/bake/bake.py demand
python research/tools/bake/bake.py supply
python research/tools/bake/bake.py health
python research/tools/bake/bake.py bake-preflight
python research/tools/bake/bake.py bake
python research/tools/bake/bake.py name --real
python research/tools/bake/bake.py provenance
python research/tools/bake/bake.py bulletin-draft
python research/tools/bake/bake.py mainstem-inflow-draft
python research/tools/bake/bake.py mainstem-node-mapping-draft
python research/tools/bake/bake.py demand-draft
python research/tools/bake/bake.py city-demand-allocation-draft
python research/tools/bake/bake.py supply-draft
python research/tools/bake/bake.py health-reach-draft
python research/tools/bake/bake.py validate
python research/tools/bake/calibrate.py
```

Run synthetic logic stubs without touching `research/data`:

```bash
python research/tools/bake/bake.py --stub run-all
```

`--stub` writes only to `intermediate/` and `out/`. It is for wiring checks, not research claims.

## Step Map

| CLI step | Work-order step | Real input gate | Output |
| --- | --- | --- | --- |
| `aoi` | T1.1 | `raw/gadm/` | `intermediate/aoi.geojson`, `intermediate/aoi_metadata.json` |
| `subbasins` | T1.2 | `raw/merit/Basin_Asia.gdb.zip`, AOI | `intermediate/subbasins_raw.geojson`, `intermediate/topology.json`, `intermediate/subbasins_metadata.json` |
| `zonal` | T1.3 | public land cover, population, climate, subbasins; approved WB LEN fallback clips | `intermediate/zonal_climate.csv`, `intermediate/zonal_landpop.csv`, `intermediate/zonal_nightlight_draft.csv`, formal `intermediate/zonal.csv`, `intermediate/zonal_metadata.json` |
| `demand` | T1.4 | completed zonal metadata with `rasterStatsReady:true`, `formalOutputWritten:true`, `industrialProxyApprovedForFullBake:true`, `fullBakeReady:true`, bulletin, city allocation draft, and topology-matching `zonal.csv` | `intermediate/demand.csv`, `intermediate/demand_metadata.json` |
| `supply` | T1.5 | real demand metadata, topology, climate, and approved conservative mainstem treatment | `intermediate/supply.csv`, `intermediate/supply_metadata.json` |
| `health` | T1.6 | real demand and supply metadata, topology | `intermediate/health.json`, `intermediate/health_metadata.json` |
| `bake-preflight` | T1.7 support | formal subbasins, zonal, demand, supply, health, bake, and provenance metadata plus audit drafts | `intermediate/bake_preflight_report.json`, `intermediate/bake_preflight_metadata.json`; never writes `research/data` itself |
| `bake` | T1.7 | final-approved subbasins metadata plus real zonal/demand/supply/health metadata | writes `research/data/wuhan-attrs.json`, `wuhan-subbasins.geojson`, `wuhan-rivers.geojson`, and `intermediate/bake_metadata.json`; stub writes `out/` |
| `name` | T1.7 support | existing `research/data/wuhan-attrs.json` | rewrites readable Chinese subbasin labels while preserving Pfaf technical ids |
| `provenance` | T1.8 | raw files, real baked `research/data`, and bake metadata | `research/data/provenance.json`, `intermediate/provenance_metadata.json` |
| `provenance-draft` | T1.8 support | `intermediate/raw_sha256.txt`, `download_attempts.md` | audit-only `intermediate/provenance_draft.json`, `intermediate/provenance_draft_metadata.json` |
| `bulletin-draft` | T1.4/Phase 4 support | downloaded Hubei Water Resources Bulletin 2022 PDF plus PyMuPDF | audit-only `intermediate/bulletin_table12_draft.csv`, `intermediate/bulletin_table12_draft_metadata.json` |
| `mainstem-inflow-draft` | T1.5 support | downloaded Hubei Water Resources Bulletin 2022 PDF plus PyMuPDF | audit-only `intermediate/mainstem_inflow_draft.csv`, `intermediate/mainstem_inflow_draft_metadata.json` |
| `mainstem-node-mapping-draft` | T1.5 support | `mainstem-inflow-draft`, HydroRIVERS, current Pfafstetter subbasins, topology | audit-only `intermediate/mainstem_node_mapping_draft.csv`, `intermediate/mainstem_node_mapping_draft_metadata.json` |
| `rivers-flowthrough-draft` | T1.7 support | HydroRIVERS, current Pfafstetter subbasins, topology | audit-only `intermediate/rivers_flowthrough_draft.geojson`, `intermediate/rivers_flowthrough_draft_metadata.json` |
| `mainstem-injection-plan-draft` | T1.5 support | `mainstem-inflow-draft`, `mainstem-node-mapping-draft`, topology | audit-only `intermediate/mainstem_injection_plan_draft.csv`, `.json`, and metadata; no qAvail injection |
| `demand-draft` | T1.4 support | partial land/pop zonal output, bulletin draft, topology | audit-only `intermediate/demand_draft.csv`, `intermediate/demand_draft_metadata.json` |
| `city-demand-allocation-draft` | T1.4 support | GADM level-2 cities, current Pfafstetter subbasins, land/pop zonal output, bulletin draft, demand draft metadata | audit-only `intermediate/city_basin_weights_draft.csv`, `intermediate/city_demand_allocation_draft.csv`, `intermediate/city_demand_allocation_draft_metadata.json` |
| `supply-draft` | T1.5 support | partial climate zonal output, subbasins metadata, topology | audit-only `intermediate/supply_draft.csv`, `intermediate/supply_draft_metadata.json` |
| `health-reach-draft` | T1.6 support | partial WorldPop zonal output, zonal metadata, topology | audit-only `intermediate/health_reach_draft.json`, `intermediate/health_reach_draft_metadata.json` |
| `validate` | T1.8 | real `research/data` files plus bake and provenance metadata | runs the existing full-bake validator |
| `run-all` | T1.1-T1.8 | all of the above | orchestrates all steps |
| `calibrate.py` | T4.1 support | demand/supply drafts plus formal metadata | audit-only `intermediate/calibration_audit_report.json`, `intermediate/calibration_audit_report.md` |

## Current Status

T1.1 AOI generation is now implemented with Python standard library only. It reads `raw/gadm/gadm41_CHN_2.json.zip`, selects the Wuhan 1+8 cities by exact GADM `GID_2`, writes a real non-synthetic AOI to `intermediate/aoi.geojson`, and prints the area check. Current acceptance evidence:

```text
AOI cities: Wuhan, Huangshi, Ezhou, Xiaogan, Huanggang, Xianning, Xiantao, Tianmen, Qianjiang
AOI area: 57988.5 km2 (-0.02% vs 58,000 km2 target)
```

The approved formal route is now implemented through `demand`, `supply`, `health`, `bake`, and `provenance`. Publicly downloadable raw files were fetched by Codex first and recorded in `download_attempts.md`; only unadopted preferred routes blocked by account, password, API token, license form, or manual terms acceptance remain credential-gated. The current formal run passes `node research/tools/validate_research_data.js --full-bake` with 0 warnings.

T1.2 now uses the project-approved Pfafstetter multi-level basin vector in `raw/merit/Basin_Asia.gdb.zip`, layer `level_6`. The file is project-provided and its upstream original source has not been independently verified, so final methodology must disclose that custody limitation. The step clips the layer to the GADM AOI, keeps AOI edge fragments with explicit flags, and builds topology from `Down_ID`. Current acceptance evidence:

```text
Pfafstetter level_6 AOI-clipped subbasins: 66
Topology check: OK, every selected basin reaches OUTLET through Down_ID topology
```

`subbasins_metadata.json` sets `subbasinsReady:true`, `formalPfafstetterVectorReady:true`, `geometryClippedToAoi:true`, `fullBakeReady:true`, `sourceVerified:false`, and `sourceDisclosureRequired:true`. It also records 44 AOI edge fragments and 17 small clipped fragments for audit.

T1.3 now writes formal zonal statistics for the 66 Pfafstetter units. It summarizes NASA POWER climate, uses rasterio/geopandas/rasterstats to summarize CLCD, WorldCover, and WorldPop, and derives the approved World Bank Light Every Night industrial proxy from 10 observed 2022 monthly BBox clips plus adjacent-month interpolation for `202206` and `202208`:

```text
intermediate/zonal_climate.csv
intermediate/zonal_landpop.csv
intermediate/zonal_nightlight_draft.csv
intermediate/viirs_wb_len_2022_bbox_weighted_avg_rade9.tif
intermediate/wb_len_202206_bbox_avg_rade9_interpolated.tif
intermediate/wb_len_202208_bbox_avg_rade9_interpolated.tif
intermediate/zonal.csv
intermediate/zonal_metadata.json
```

Current evidence:

```text
Climate rows: 66 subbasins from NASA POWER daily CSVs
Land/pop raster partial: CLCD, WorldCover, and WorldPop zonal summaries written
Nightlight proxy: 66 subbasins from 12 WB LEN monthly composites; missing after interpolation=
REAL wrote intermediate/zonal.csv
Formal zonal.csv is approved for downstream demand drafts with WB LEN 12-month interpolated industrial proxy.
```

`zonal_metadata.json` sets `climateStatsReady:true`, `landPopStatsReady:true`, `rasterEngineReady:true`, `nightlightProxyReady:true`, `industrialProxyApprovedForFullBake:true`, `worldBankLenProxyApprovedForFullBake:true`, `rasterStatsReady:true`, `formalOutputWritten:true`, and `fullBakeReady:true`. It also keeps `viirsReady:false`, `preferredViirsReady:false`, and `eogAnnualVnlReady:false` to avoid claiming EOG Annual VNL. `sharp@0.35.1` is installed and basic runtime checks pass; rasterio/geopandas/rasterstats remain the GIS raster engine for this bake implementation.

The current nightlight/industrial-weight decision state is tracked in `industrial_proxy_decision.md`: EOG, NASA Black Marble, Planetary Computer, and GEE routes have been tried and remain credential- or year-gated for Codex. World Bank Light Every Night is approved as the formal fallback with transparent missing-month interpolation; final methodology must state that EOG Annual VNL was not used.

T1.4 is now formal. The draft helpers still exist for audit, but `demand` writes `intermediate/demand.csv` plus `intermediate/demand_metadata.json` with `formalOutputWritten:true`, `demandReady:true`, and `fullBakeReady:true`. Current sector totals in the front-end contract are agriculture `9038000002` m3, industry `5312000001` m3, urban/domestic `4841000003` m3, and ecology `1615000003` m3. City-sector totals cover all nine Wuhan 1+8 cities and match the sector totals after rounding.

T1.5 is now formal under a conservative mainstem rule. `supply` writes `intermediate/supply.csv` plus `intermediate/supply_metadata.json` with `formalOutputWritten:true`, `supplyReady:true`, and `fullBakeReady:true`. Local runoff totals `28542353226` m3 and is routed through the 66-node DAG. The Hubei bulletin mainstem inflow extraction and HydroRIVERS candidate mapping remain available as audit evidence, but candidate provincial-boundary inflows are excluded from `qAvail` until an AOI spatial injection rule is approved; formal `externalInflow` and `mainstemInflow` are finite zeros, and the metadata records `mainstemCandidateInflowsExcludedFromQAvail:true`, `mainstemInjectionReady:false`, and `spatialInjectionAssigned:false`.

T1.6 is now formal. `health` writes `intermediate/health.json` plus `intermediate/health_metadata.json` with `formalOutputWritten:true`, `healthReady:true`, and `fullBakeReady:true`. `downstreamReach` aligns with topology for all 66 subbasins. The metadata keeps `healthWeightsCalibrated:false` because the weights are policy/model weights, not an externally calibrated epidemiological estimate.

T1.7 is now formal. `bake` writes:

```text
research/data/wuhan-attrs.json
research/data/wuhan-subbasins.geojson
research/data/wuhan-rivers.geojson
intermediate/bake_metadata.json
```

`bake_metadata.json` reports `dataContractReady:true`, `fullBakeReady:true`, 66 subbasins, 120 river features, ID alignment with topology, and `combinedBytes=651154`, under the 3 MB target. `wuhan-attrs.json` is marked `demoSample:false`, `synthetic:false`, `realDataReady:true`, and `estimated:true`; its source/note disclose the project-provided Pfafstetter vector, WB-LEN interpolation, and conservative exclusion of unapproved mainstem inflow candidates.

`bake-preflight` remains an audit report and does not write `research/data` by itself. Its latest output reports `idAlignmentAllMatch:true`, `blockers=0`, and `artifactRisks=0`, with `PREFLIGHT OK: current research/data matches the formal bake contract.`

T1.8 is now formal. `provenance-draft` reads `intermediate/raw_sha256.txt` and `download_attempts.md`; `provenance` writes `research/data/provenance.json` plus `intermediate/provenance_metadata.json`. Final provenance covers nine required categories (`clcd`, `worldcover`, `worldpop`, `viirs`, `merit`, `hydrosheds`, `climate`, `gadm`, `bulletin`) and 44 raw input items. `Basin_Asia.gdb.zip` is recorded as `local:project-provided/Basin_Asia.gdb.zip`; manual source review is still required before publication.

Full-bake validation evidence:

```text
node research/tools/validate_research_data.js --full-bake
Validation passed with 0 warning(s).

node research/js/networkModel.test.js
networkModel.test.js: all assertions passed
```

T4.1 still has an audit-only calibration harness:

```bash
.venv-bake/bin/python research/tools/bake/calibrate.py
```

It reads the draft and formal metadata, then writes `intermediate/calibration_audit_report.json` plus `intermediate/calibration_audit_report.md`. Current demand evidence matches the 1+8 old-caliber bulletin total with `0.0%` error, but this harness remains non-final because there is no AOI-local runoff target validation and no domain-approved mainstem spatial injection rule.
