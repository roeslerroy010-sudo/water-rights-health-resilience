# Industrial Proxy Decision Log

Date: 2026-06-14

Status: **APPROVED FORMAL FALLBACK IMPLEMENTED FOR T1.3**. Codex attempted the public/no-login nightlight routes found so far. The preferred EOG/NASA/GEE annual products still require credentials, but the project owner approved World Bank / AWS Light Every Night as the formal fallback. Codex clipped the 10 available 2022 monthly composites to the Wuhan 1+8 BBox, confirmed `202206` and `202208` are absent on the public route, interpolated those months from adjacent observed months under `intermediate/`, and wrote formal `intermediate/zonal.csv`.

## Current Evidence

| Candidate | Result | Can satisfy formal `ind_weight = built-up x nightlight`? |
| --- | --- | --- |
| NOAA/EOG Annual VNL 2022 | Official data URLs redirect to EOG OpenID Connect login. | No, credential-gated. |
| NASA Black Marble `VNP46A4` 2022 | NASA CMR lists h29v05 and h29v06 granules, but actual LAADS GET returns Earthdata `401` without credentials. | No, credential-gated. |
| Microsoft Planetary Computer `hrea` | Public STAC collection exists, but temporal extent is 2012-2019 and 2022 BBox search returns zero features. | No, wrong year. |
| Google Earth Engine VIIRS assets | Earth Engine asset API returns OAuth `401` without credentials. | No for Codex-only anonymous run; viable after GEE auth. |
| World Bank / AWS Light Every Night monthly 2022 | Public S3 COGs were clipped for 10 available months: `202201-202205`, `202207`, `202209-202212`; targeted S3 prefix and HEAD checks confirmed `202206` and `202208` are absent/404 on this public route. Missing months are interpolated from adjacent observed months. | Yes, as the approved formal fallback, with metadata/methodology disclosing WB-LEN, interpolation, and non-use of EOG Annual VNL. |

Detailed commands and responses are recorded in `download_attempts.md`.

## Approved Ways Forward

1. **Credential path:** provide Earthdata, EOG, or GEE authentication, then rerun T1.3 with the preferred annual nightlight product. This remains the cleanest route for formal full-bake.
2. **Explicit proxy approval path:** completed. Project owner approved the World Bank Light Every Night `n_cf`-weighted annual proxy for formal use, with `202206` and `202208` interpolated and preserved in metadata/methodology.
3. **Alternative documented fallback path:** project owner explicitly approves another non-VIIRS industrial proxy, such as built-up area only or built-up area combined with external city-level industrial totals. This must remain labeled as a fallback in metadata and methodology.
4. **No-op path:** keep `zonal_metadata.json:rasterStatsReady=false` and do not write formal `intermediate/zonal.csv`.

## Current Implementation Boundary

`bake.py zonal` writes:

- `intermediate/zonal_climate.csv`
- `intermediate/zonal_landpop.csv`
- `intermediate/zonal_metadata.json`
- `intermediate/zonal_nightlight_draft.csv`
- `intermediate/viirs_wb_len_2022_bbox_weighted_avg_rade9.tif`
- `intermediate/wb_len_202206_bbox_avg_rade9_interpolated.tif`
- `intermediate/wb_len_202208_bbox_avg_rade9_interpolated.tif`
- `intermediate/zonal.csv`

It writes formal `intermediate/zonal.csv`, and current readiness flags are:

```json
{
  "formalOutputWritten": true,
  "rasterStatsReady": true,
  "viirsReady": false,
  "preferredViirsReady": false,
  "eogAnnualVnlReady": false,
  "nightlightProxyReady": true,
  "industrialProxyApprovedForFullBake": true,
  "worldBankLenProxyApprovedForFullBake": true,
  "fullBakeReady": true
}
```

`demand-draft` may consume this approved fallback for review, but downstream formal `demand`, `supply`, `bake`, `provenance`, and `validate` gates remain locked until those formal steps are implemented. Do not describe this output as EOG Annual VNL.
