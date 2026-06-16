# Full Local Bake Data Fetch Checklist

BBox for all spatial subsets: `112.5,29.0,116.0,31.5` in `minLon,minLat,maxLon,maxLat` order, WGS84 / EPSG:4326.

Status: **APPROVED FULL-BAKE ROUTE DOWNLOADED BY CODEX**. Public datasets were tried by Codex first; only unadopted preferred routes that fail because of login, password, API token, registration, or manual terms acceptance remain credential-gated. Do not add empty dummy files to unblock the real pipeline.

All paths are relative to `hackathon/research/tools/bake/`.

Detailed attempt evidence is recorded in `download_attempts.md`.

## Required Datasets

| Dataset | Exact coverage needed | Source / link | Drop path | License / credential note | Status |
| --- | --- | --- | --- | --- | --- |
| CLCD land cover 30 m | Calibration year 2022, clip later to the BBox. | Zenodo CLCD latest record: <https://zenodo.org/records/18180184>; original family DOI from older record: `10.5281/zenodo.4417810`. | `raw/clcd/` | Zenodo record is CC BY 4.0; keep original filename and checksum. | **DOWNLOADED by Codex:** `CLCD_v01_2022_albert.tif` + classification table. |
| ESA WorldCover 10 m | Four 3x3 degree 2021 v200 map tiles covering the BBox: `N27E111`, `N27E114`, `N30E111`, `N30E114`. | ESA data access: <https://esa-worldcover.org/en/data-access>; S3 prefix `s3://esa-worldcover/v200/2021/map/`. | `raw/worldcover/` | Free of charge; CC BY 4.0 attribution required. No AWS credentials needed for public S3 map tiles. | **DOWNLOADED by Codex:** all four map tiles. |
| WorldPop population 100 m | China 2022 population count, 100 m, constrained R2025A v1. This replaces the old 2000-2020 `UNadj_constrained` naming, which does not cover 2022. | WorldPop resource page: <https://hub.worldpop.org/geodata/summary?id=72924>. | `raw/worldpop/` | WorldPop data are CC BY 4.0. R2025A is an alpha public release; document this in provenance. | **DOWNLOADED by Codex:** `chn_pop_2022_CN_100m_R2025A_v1.tif`; byte count `927765329`, checksum in `intermediate/raw_sha256.txt`. |
| VIIRS nighttime lights | Approved fallback is BBox-clipped World Bank / AWS Light Every Night monthly `avg_rade9` + `n_cf` composites for 2022, with `202206` and `202208` interpolated from adjacent observed months. Preferred EOG Annual VNL remains optional/credentialed. | EOG VNL: <https://eogdata.mines.edu/products/vnl/>. World Bank LEN registry: <https://registry.opendata.aws/wb-light-every-night/>; public S3 bucket `s3://globalnightlight/`. NASA Black Marble, Planetary Computer STAC, and GEE were also tested. | `raw/viirs/` | EOG redirects to OpenID login. NASA Black Marble actual LAADS GET returns Earthdata `401`. GEE asset API returns OAuth `401`. WB LEN public S3 has 10 available 2022 monthly composites for this route; `202206` and `202208` are absent from the public listing checked by Codex. | **APPROVED FALLBACK DOWNLOADED by Codex:** 20 BBox clips (`10` months x `avg_rade9/n_cf`) in `raw/viirs/`; interpolation rasters are generated under `intermediate/`, and `zonal.csv` is formal-ready for T1.3. |
| Pfafstetter basin vector / MERIT-Hydro 90 m | Current formal subbasins use project-provided `Basin_Asia.gdb.zip` layer `level_6`, clipped to the AOI and topologized with `Down_ID`. MERIT-Hydro `dir`/`upa` tiles remain a credentialed optional preferred route, not the active path. | Local project-provided file plus original MERIT-Hydro page for attempted credentialed route: <https://global-hydrodynamics.github.io/MERIT_Hydro/>. | `raw/merit/` | `Basin_Asia.gdb.zip` upstream origin is not independently verified and must be disclosed. Official MERIT-Hydro Dropbox still requires password after registration. | **FORMAL FALLBACK PRESENT:** `raw/merit/Basin_Asia.gdb.zip` used for 66 Pfafstetter level_6 subbasins; official MERIT-Hydro raster route remains credential-gated. |
| HydroSHEDS / HydroBASINS / HydroRIVERS | Asia HydroRIVERS plus Asia HydroBASINS standard levels sufficient for cross-checking basin topology; HydroSHEDS core `dir` and `acc` 15s layers as backup/cross-check. | HydroRIVERS: <https://www.hydrosheds.org/products/hydrorivers>; HydroBASINS: <https://www.hydrosheds.org/products/hydrobasins>; core downloads via `data.hydrosheds.org`. | `raw/hydrosheds/` | Free for scientific/educational/commercial use under HydroSHEDS terms; downloading implies acceptance. | **DOWNLOADED by Codex:** Asia rivers, basins, direction, accumulation. |
| Climate precipitation / ET0 | 2022 precipitation and ET0 or variables needed to compute ET0 over the BBox; daily aggregation accepted as fallback. | Preferred CMFD/TPDC static page did not expose anonymous files; ERA5-Land CDS API requires account/token/Terms. Public fallback downloaded from NASA POWER daily regional API: <https://power.larc.nasa.gov/docs/services/api/temporal/daily/>. | `raw/climate/` | NASA POWER is public; CDS/CMFD remain credential-gated if the project insists on those sources. | **DOWNLOADED fallback by Codex:** POWER precipitation, evapotranspiration energy flux, and ET0-support variables. |
| GADM administrative boundaries | China GADM level 2 or equivalent city-level boundary containing Wuhan, Huangshi, Ezhou, Xiaogan, Huanggang, Xianning, Xiantao, Tianmen, Qianjiang. | GADM: <https://gadm.org/download_country.html>. | `raw/gadm/` | GADM license terms apply; verify permitted use for the project. | **DOWNLOADED by Codex:** China GPKG plus level-2 JSON zip. |
| Hubei Water Resources Bulletin 2022 | PDF or table containing city/sector water use for the 1+8 cities, especially agriculture, industry, domestic/urban, ecology. | Hubei Department of Water Resources PDF: <http://slt.hubei.gov.cn/bsfw/cxfw/szygb/202307/P020230720530853000978.pdf>. | `raw/bulletin/` | Public bulletin; tables still require extraction and review. | **DOWNLOADED by Codex:** 2022 PDF. |

## Suggested Raw Layout

```text
raw/
  clcd/
    CLCD_*2022*.tif
    source.txt
  worldcover/
    ESA_WorldCover_10m_2021_v200_N27E111_Map.tif
    ESA_WorldCover_10m_2021_v200_N27E114_Map.tif
    ESA_WorldCover_10m_2021_v200_N30E111_Map.tif
    ESA_WorldCover_10m_2021_v200_N30E114_Map.tif
  worldpop/
    chn_pop_2022_CN_100m_R2025A_v1.tif
  viirs/
    wb_len_202201_bbox_avg_rade9.tif
    wb_len_202201_bbox_n_cf.tif
    ...
    wb_len_202212_bbox_avg_rade9.tif
    wb_len_202212_bbox_n_cf.tif
    <optional original EOG annual VNL archive or GeoTIFF, after EOG login>
  merit/
    Basin_Asia.gdb.zip
    <optional MERIT-Hydro package or extracted dir/upa/elv tiles, after registration password>
  hydrosheds/
    hydrorivers_asia/
    hydrobasins_asia/
  climate/
    nasa_power_prectotcorr_2022_daily_bbox.csv
    nasa_power_evptrns_2022_daily_bbox.csv
    nasa_power_*_2022_daily_bbox.csv
  gadm/
    gadm41_CHN.gpkg
  bulletin/
    hubei_water_resources_bulletin_2022.pdf
```

## After Download

Record checksums before processing:

```bash
find research/tools/bake/raw -maxdepth 4 -type f -print0 | xargs -0 shasum -a 256 > research/tools/bake/intermediate/raw_sha256.txt
```

For the current raw state, this checksum file feeds final `research/data/provenance.json`. `bake.py subbasins` uses `raw/merit/Basin_Asia.gdb.zip` layer `level_6` and writes 66 AOI-clipped Pfafstetter units plus `Down_ID` topology. `bake.py zonal` writes formal `intermediate/zonal.csv` from NASA POWER, CLCD, WorldCover, WorldPop, and the approved WB-LEN 12-month interpolated industrial proxy; metadata has `formalOutputWritten:true`, `rasterStatsReady:true`, `industrialProxyApprovedForFullBake:true`, and `worldBankLenProxyApprovedForFullBake:true`, while `preferredViirsReady:false` and `eogAnnualVnlReady:false` remain explicit. Targeted public S3 checks for `202206` and `202208` returned `KeyCount=0` for both broader monthly prefixes and `404 Not Found` for the expected `avg_rade9` objects, so interpolated rasters are stored only under `intermediate/`.

Formal downstream steps are implemented: `demand`, `supply`, `health`, `bake`, and `provenance` write full-bake outputs and metadata. Audit draft steps (`bulletin-draft`, `demand-draft`, `city-demand-allocation-draft`, `supply-draft`, `health-reach-draft`, `rivers-flowthrough-draft`, `mainstem-*`, and `provenance-draft`) remain for traceability. The formal supply contract conservatively excludes unapproved mainstem inflow candidates from `qAvail` until a Wuhan 1+8 AOI spatial injection rule is approved. The `.venv-bake` rasterio/geopandas/PyMuPDF runtime is installed; `mapshaper@0.7.23` and `sharp@0.35.1` are installed in the Node tree, with sharp basic runtime checks passing.

Then run the reproducible formal route from `hackathon/` after raw checksums are refreshed:

```bash
python research/tools/bake/bake.py aoi
python research/tools/bake/bake.py subbasins
python research/tools/bake/bake.py zonal
python research/tools/bake/bake.py bulletin-draft
python research/tools/bake/bake.py demand-draft
python research/tools/bake/bake.py city-demand-allocation-draft
python research/tools/bake/bake.py supply-draft
python research/tools/bake/bake.py mainstem-inflow-draft
python research/tools/bake/bake.py mainstem-node-mapping-draft
python research/tools/bake/bake.py mainstem-injection-plan-draft
python research/tools/bake/bake.py rivers-flowthrough-draft
python research/tools/bake/bake.py health-reach-draft
python research/tools/bake/bake.py demand
python research/tools/bake/bake.py supply
python research/tools/bake/bake.py health
python research/tools/bake/bake.py bake
python research/tools/bake/bake.py provenance-draft
python research/tools/bake/bake.py provenance
python research/tools/bake/bake.py bake-preflight
node research/tools/validate_research_data.js --full-bake
```

If a project switches back to a preferred credentialed route, the real CLI should keep printing `BLOCKED` until the required files and provenance are present; use `--stub` only for synthetic wiring checks.
