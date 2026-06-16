# Download Attempts Audit

Date: 2026-06-14

Working directory: `hackathon/`

Policy: Codex attempts every required public download first. A dataset is marked credential-gated only after direct links, official pages, or APIs are tried and fail because of account, password, token, registration, or manual terms acceptance.

## Raw State

Downloaded into `research/tools/bake/raw/`:

| Category | Status | Local files |
| --- | --- | --- |
| CLCD | Downloaded | `raw/clcd/CLCD_v01_2022_albert.tif`, `raw/clcd/CLCD_classificationsystem.xlsx` |
| WorldCover | Downloaded | four 2021 v200 map tiles: `N27E111`, `N27E114`, `N30E111`, `N30E114` |
| WorldPop | Downloaded | `raw/worldpop/chn_pop_2022_CN_100m_R2025A_v1.tif` |
| GADM | Downloaded | `raw/gadm/gadm41_CHN.gpkg`, `raw/gadm/gadm41_CHN_2.json.zip` |
| HydroSHEDS | Downloaded | `HydroRIVERS_v10_as_shp.zip`, `hybas_as_lev01-12_v1c.zip`, `hyd_as_dir_15s.zip`, `hyd_as_acc_15s.zip` |
| Climate | Downloaded fallback | NASA POWER 2022 daily regional CSVs for precipitation and ET0-support variables |
| Bulletin | Downloaded | `raw/bulletin/hubei_water_resources_bulletin_2022.pdf` |
| VIIRS / night lights | Audit candidate downloaded | World Bank / AWS Light Every Night public S3 BBox clips downloaded for 10 available 2022 monthly composites (`avg_rade9` + `n_cf`); EOG Annual VNL, NASA Black Marble LAADS, and GEE remain credential-gated |
| MERIT-Hydro | Credential-gated | Official Dropbox folder redirects to password page; registration form required |

## Successful Public Downloads

### CLCD 2022

Source:
`https://zenodo.org/records/18180184`

Commands:

```bash
curl --fail --location --continue-at - --output research/tools/bake/raw/clcd/CLCD_v01_2022_albert.tif 'https://zenodo.org/records/18180184/files/CLCD_v01_2022_albert.tif?download=1'
curl --fail --location --continue-at - --output research/tools/bake/raw/clcd/CLCD_classificationsystem.xlsx 'https://zenodo.org/records/18180184/files/CLCD_classificationsystem.xlsx?download=1'
```

Evidence: official Zenodo latest record lists `CLCD_v01_2022_albert.tif`; direct download succeeded. File type check reports TIFF for the raster and spreadsheet bytes for the classification file.

### ESA WorldCover 2021 v200

Source:
`https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/`

Commands:

```bash
curl --fail --location --continue-at - --output research/tools/bake/raw/worldcover/ESA_WorldCover_10m_2021_v200_N27E111_Map.tif https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N27E111_Map.tif
curl --fail --location --continue-at - --output research/tools/bake/raw/worldcover/ESA_WorldCover_10m_2021_v200_N27E114_Map.tif https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N27E114_Map.tif
curl --fail --location --continue-at - --output research/tools/bake/raw/worldcover/ESA_WorldCover_10m_2021_v200_N30E111_Map.tif https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N30E111_Map.tif
curl --fail --location --continue-at - --output research/tools/bake/raw/worldcover/ESA_WorldCover_10m_2021_v200_N30E114_Map.tif https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N30E114_Map.tif
```

Evidence: `curl -I -L` returned `200 OK` for the public S3 object; all four TIFF files are present and recognized as TIFF.

### WorldPop China 2022

Source:
`https://hub.worldpop.org/geodata/summary?id=72924`

Command:

```bash
curl --fail --location --continue-at - --output research/tools/bake/raw/worldpop/chn_pop_2022_CN_100m_R2025A_v1.tif https://data.worldpop.org/GIS/Population/Global_2015_2030/R2025A/2022/CHN/v1/100m/constrained/chn_pop_2022_CN_100m_R2025A_v1.tif
```

Evidence: official WorldPop resource page gives the file as `Download Entire Dataset / 884.79 MB`. The completed local byte count is `927765329`, matching the official `Content-Length` observed by `curl -I -L`. SHA256 in `intermediate/raw_sha256.txt`: `4bbca922fc1973ced8763dd5282e8b3d792e1b93b27a5015f62a75f116cfba57`.

## Checksum Manifest

Generated command:

```bash
find research/tools/bake/raw -maxdepth 4 -type f -print0 | xargs -0 shasum -a 256 > research/tools/bake/intermediate/raw_sha256.txt
```

Result: `intermediate/raw_sha256.txt` contains checksums for the current partial raw state, including the 20 World Bank Light Every Night BBox clips under `raw/viirs/`. This file is ignored as an intermediate artifact, but it is available locally for processing and provenance generation.

### GADM China

Source:
`https://geodata.ucdavis.edu/gadm/gadm4.1/`

Commands:

```bash
curl --fail --location --continue-at - --output research/tools/bake/raw/gadm/gadm41_CHN.gpkg https://geodata.ucdavis.edu/gadm/gadm4.1/gpkg/gadm41_CHN.gpkg
curl --fail --location --continue-at - --output research/tools/bake/raw/gadm/gadm41_CHN_2.json.zip https://geodata.ucdavis.edu/gadm/gadm4.1/json/gadm41_CHN_2.json.zip
```

Evidence: `HEAD` was slow on this server, but direct downloads succeeded. `file` reports the GPKG as an OGC GeoPackage and the level-2 file as a ZIP archive.

### HydroSHEDS / HydroRIVERS / HydroBASINS

Sources:
`https://www.hydrosheds.org/products/hydrorivers`
`https://www.hydrosheds.org/products/hydrobasins`
`https://www.hydrosheds.org/hydrosheds-core-downloads`

Commands:

```bash
curl --fail --location --continue-at - --output research/tools/bake/raw/hydrosheds/HydroRIVERS_v10_as_shp.zip https://data.hydrosheds.org/file/HydroRIVERS/HydroRIVERS_v10_as_shp.zip
curl --fail --location --continue-at - --output research/tools/bake/raw/hydrosheds/hybas_as_lev01-12_v1c.zip https://data.hydrosheds.org/file/hydrobasins/standard/hybas_as_lev01-12_v1c.zip
curl --fail --location --continue-at - --output research/tools/bake/raw/hydrosheds/hyd_as_dir_15s.zip https://data.hydrosheds.org/file/hydrosheds-v1-dir/hyd_as_dir_15s.zip
curl --fail --location --continue-at - --output research/tools/bake/raw/hydrosheds/hyd_as_acc_15s.zip https://data.hydrosheds.org/file/hydrosheds-v1-acc/hyd_as_acc_15s.zip
```

Evidence: direct downloads succeeded; `file` reports all four as ZIP archives.

### Climate Fallback: NASA POWER

Source:
`https://power.larc.nasa.gov/docs/services/api/temporal/daily/`

BBox:
`latitude-min=29`, `latitude-max=31.5`, `longitude-min=112.5`, `longitude-max=116`

Downloaded daily regional CSVs:

```text
nasa_power_prectotcorr_2022_daily_bbox.csv
nasa_power_evptrns_2022_daily_bbox.csv
nasa_power_t2m_2022_daily_bbox.csv
nasa_power_t2m_max_2022_daily_bbox.csv
nasa_power_t2m_min_2022_daily_bbox.csv
nasa_power_rh2m_2022_daily_bbox.csv
nasa_power_ws2m_2022_daily_bbox.csv
nasa_power_ps_2022_daily_bbox.csv
nasa_power_allsky_sfc_sw_dwn_2022_daily_bbox.csv
```

Evidence: regional API requests succeeded for `PRECTOTCORR`, `EVPTRNS`, and ET0-support variables. The invalid `PET` parameter was also tried and returned `422`, so it was not retained. POWER headers state the source/resolution and parameter definitions.

### Hubei Water Resources Bulletin 2022

Source:
`http://slt.hubei.gov.cn/bsfw/cxfw/szygb/202307/P020230720530853000978.pdf`

Command:

```bash
curl --fail --location --continue-at - --output research/tools/bake/raw/bulletin/hubei_water_resources_bulletin_2022.pdf 'http://slt.hubei.gov.cn/bsfw/cxfw/szygb/202307/P020230720530853000978.pdf'
```

Evidence: PDF direct link downloaded successfully; `file` reports PDF version 1.7.

### World Bank / AWS Light Every Night 2022 Monthly Night Lights

Source:
`https://registry.opendata.aws/wb-light-every-night/`
`https://globalnightlight.s3.amazonaws.com/`

Checked public object listing:

```bash
curl -sS 'https://globalnightlight.s3.amazonaws.com/?list-type=2&prefix=composites/npp_2022&max-keys=60'
curl -I -L 'https://globalnightlight.s3.amazonaws.com/composites/npp_202201_ops/DNB_npp_20220101-20220131_global_ecm-slcorr_v10_ops.avg_rade9.tif'
```

Downloaded by BBox clipping with rasterio's `rio clip` from the public COG URLs into `raw/viirs/`:

```text
wb_len_202201_bbox_avg_rade9.tif  wb_len_202201_bbox_n_cf.tif
wb_len_202202_bbox_avg_rade9.tif  wb_len_202202_bbox_n_cf.tif
wb_len_202203_bbox_avg_rade9.tif  wb_len_202203_bbox_n_cf.tif
wb_len_202204_bbox_avg_rade9.tif  wb_len_202204_bbox_n_cf.tif
wb_len_202205_bbox_avg_rade9.tif  wb_len_202205_bbox_n_cf.tif
wb_len_202207_bbox_avg_rade9.tif  wb_len_202207_bbox_n_cf.tif
wb_len_202209_bbox_avg_rade9.tif  wb_len_202209_bbox_n_cf.tif
wb_len_202210_bbox_avg_rade9.tif  wb_len_202210_bbox_n_cf.tif
wb_len_202211_bbox_avg_rade9.tif  wb_len_202211_bbox_n_cf.tif
wb_len_202212_bbox_avg_rade9.tif  wb_len_202212_bbox_n_cf.tif
```

Evidence: public S3 `HEAD` returned `200 OK` for the monthly COG path, and local clips are valid EPSG:4326 GeoTIFFs. The public `composites/npp_2022` listing checked by Codex exposes 10 usable monthly composites for this route; `202206` and `202208` are absent. `bake.py zonal` therefore treats the derived annual light layer as an **audit-only 10-month proxy** and refuses to write formal `intermediate/zonal.csv` until the project explicitly approves this proxy or provides a preferred credentialed annual product.

Targeted missing-month recheck after user reminder:

```bash
curl -sS 'https://globalnightlight.s3.amazonaws.com/?list-type=2&prefix=composites/npp_202206_ops/&max-keys=100'
curl -I -L 'https://globalnightlight.s3.amazonaws.com/composites/npp_202206_ops/DNB_npp_20220601-20220630_global_ecm-slcorr_v10_ops.avg_rade9.tif'
curl -sS 'https://globalnightlight.s3.amazonaws.com/?list-type=2&prefix=composites/npp_202208_ops/&max-keys=100'
curl -I -L 'https://globalnightlight.s3.amazonaws.com/composites/npp_202208_ops/DNB_npp_20220801-20220831_global_ecm-slcorr_v10_ops.avg_rade9.tif'
curl -sS 'https://globalnightlight.s3.amazonaws.com/?list-type=2&prefix=composites/npp_202206&max-keys=20'
curl -sS 'https://globalnightlight.s3.amazonaws.com/?list-type=2&prefix=composites/npp_202208&max-keys=20'
```

Result: both `_ops/` prefix listings returned `KeyCount=0`, both broader `composites/npp_202206` and `composites/npp_202208` listings returned `KeyCount=0`, and the expected `avg_rade9` object HEAD checks returned `HTTP/1.1 404 Not Found`. No `202206` or `202208` WB LEN public S3 objects were available through this route.

## Credential-Gated After Attempts

### Preferred VIIRS Annual VNL 2022

Tried:

```bash
curl -I -L 'https://eogdata.mines.edu/nighttime_light/annual/v22/'
curl -I -L 'https://eogdata.mines.edu/nighttime_light/annual/v22/2022/'
curl -I -L 'https://eogdata.mines.edu/nighttime_light/annual/v22/2022/VNL_v22_npp_2022_global_vcmslcfg_c202303062300.average_masked.dat.tif.gz'
curl -I -L 'https://eogdata.mines.edu/nighttime_light/annual/v10/2022/'
```

Result: all annual data URLs return `302 Found` to an EOG OpenID Connect login page under `https://eogauth.mines.edu/`. This requires an EOG account. No anonymous raw VNL download was available through the official data path.

### NASA Black Marble VNP46A4 2022 Probe

Tried as a possible official public substitute for EOG VNL:

```bash
curl -sS 'https://cmr.earthdata.nasa.gov/search/granules.json?short_name=VNP46A4&version=2&temporal=2022-01-01T00:00:00Z,2023-01-01T00:00:00Z&bounding_box=112.5,29,116,31.5&page_size=10'
curl -I -L 'https://data.laadsdaac.earthdatacloud.nasa.gov/prod-lads/VNP46A4/VNP46A4.A2022001.h29v05.002.2025156215210.h5'
curl -I -L 'https://data.laadsdaac.earthdatacloud.nasa.gov/prod-lads/VNP46A4/VNP46A4.A2022001.h29v06.002.2025156215316.h5'
curl --fail --location --continue-at - --output research/tools/bake/raw/viirs/VNP46A4.A2022001.h29v05.002.2025156215210.h5 'https://data.laadsdaac.earthdatacloud.nasa.gov/prod-lads/VNP46A4/VNP46A4.A2022001.h29v05.002.2025156215210.h5'
```

Result: NASA CMR confirms two 2022 VNP46A4 v2 granules for the study BBox: `VNP46A4.A2022001.h29v05.002.2025156215210.h5` and `VNP46A4.A2022001.h29v06.002.2025156215316.h5`. `HEAD -L` can follow the LAADS redirect to a CloudFront URL and report `200`, but actual `GET` without Earthdata credentials returns `401` with `WWW-Authenticate: Basic realm="Earthdata Login"`. This actual GET failure was reproduced with `curl --fail --location --continue-at - --output raw/viirs/VNP46A4.A2022001.h29v05.002.2025156215210.h5 ...`; no file was downloaded. There is no local `~/.netrc` or `~/.urs_cookies` in this environment, so Black Marble remains credential-gated for Codex-run downloads.

### Microsoft Planetary Computer / HREA Probe

Tried:

```bash
curl -sS https://planetarycomputer.microsoft.com/api/stac/v1/collections
curl -sS https://planetarycomputer.microsoft.com/api/stac/v1/collections/hrea
curl -sS 'https://planetarycomputer.microsoft.com/api/stac/v1/search' -H 'Content-Type: application/json' --data '{"collections":["hrea"],"bbox":[112.5,29,116,31.5],"datetime":"2022-01-01/2022-12-31","limit":5}'
```

Result: Planetary Computer exposes `hrea` as the only nightlight-adjacent collection found in STAC. Its temporal interval is `2012-12-31` to `2019-12-31`, and a 2022 BBox STAC search returns `0` features. It cannot satisfy the 2022 VIIRS requirement.

### Google Earth Engine Public Asset Probe

Tried:

```bash
curl -sS 'https://earthengine.googleapis.com/v1alpha/projects/earthengine-public/assets/NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG'
curl -sS 'https://earthengine.googleapis.com/v1alpha/projects/earthengine-public/assets/NOAA/VIIRS/DNB/ANNUAL_V22'
curl -sS 'https://earthengine.googleapis.com/v1alpha/projects/earthengine-public/assets/NASA/VIIRS/002/VNP46A4'
```

Result: Earth Engine API returned `401 UNAUTHENTICATED` for asset metadata requests without an OAuth token. GEE remains a viable cloud-processing route only after user/account authentication, not an anonymous Codex-run download path.

### MERIT-Hydro

Tried:

```bash
curl -I -L 'https://www.dropbox.com/scl/fo/fw8qrf73zhzmo6p92gbxv/AIlVRfnQVEWOyXEimsK2qKk?dl=0&rlkey=a0be5opyb2kpkf0ssbvau8y9q&st=t8rtowe9'
```

Result: official MERIT-Hydro page states that users must complete a Google Form license agreement, receive a password by email, then access the Dropbox folder. The Dropbox URL redirects to `/sm/password`. No anonymous MERIT tile download was available through the official path.

Current fallback action: `python research/tools/bake/bake.py subbasins` uses the already downloaded public HydroBASINS Asia package as an intermediate fallback. It writes 64 level-7 subbasins and topology to `intermediate/subbasins_raw.geojson`, `intermediate/topology.json`, and `intermediate/subbasins_metadata.json`. This is progress toward T1.2, not final MERIT/pyflwdir acceptance.

### ERA5-Land / CDS Climate

Tried:

```bash
ls -la ~/.cdsapirc ~/.ecmwfapirc
python -c 'import cdsapi; print("cdsapi installed")'
curl -i -X POST https://cds.climate.copernicus.eu/api/retrieve/v1/processes/reanalysis-era5-land-monthly-means/execute -H 'Content-Type: application/json' --data '{"inputs":{"product_type":["monthly_averaged_reanalysis"],"variable":["total_precipitation"],"year":["2022"],"month":["01"],"time":["00:00"],"data_format":"netcdf","download_format":"unarchived"}}'
```

Result: no local CDS token file was present, `cdsapi` was not installed, and the official CDS retrieve API returned `401 authentication required`. CDS documentation also requires a user account, personal access token, and manual dataset Terms acceptance before retrieval. NASA POWER public CSVs were downloaded as the no-account fallback.

### CMFD / TPDC

Tried:

```bash
curl -I -L 'https://data.tpdc.ac.cn/en/data/8028b944-daaa-4511-8769-965612652c49/'
curl -i 'https://data.tpdc.ac.cn/en/data/8028b944-daaa-4511-8769-965612652c49/'
```

Result: the page returns a JavaScript shell for the National Tibetan Plateau Data Center application; no anonymous file URL was exposed by the static response. Because NASA POWER fallback succeeded, no TPDC credential request is needed for the current fallback path.
