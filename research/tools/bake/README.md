# Wuhan Real-Data Bake Pipeline

This directory keeps the offline pipeline used to produce the static `research/data/` files.

## Repository Policy

The cleaned GitHub version keeps pipeline code and audit notes, but not local raw data or generated intermediates:

```text
bake.py                 Main CLI entrypoint
calibrate.py            Calibration helper
requirements.txt        Python dependencies for offline bake work
fetch_data.md           Public-download and credential checklist
download_attempts.md    Audit trail for download attempts and credential blocks
industrial_proxy_decision.md
                        Nightlight/industrial-weight decision log
raw/                    Local-only source archives and rasters
intermediate/           Local-only derived working files
out/                    Local-only preview/stub outputs
```

`raw/`, `intermediate/`, and `out/` are ignored by Git. The frontend does not need them because it reads the generated static files under `research/data/`.

## Environment

Recommended conda setup from the repository root:

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

## Rebuild Flow

1. Recreate the required raw inputs using `fetch_data.md`.
2. Refresh checksums into `intermediate/raw_sha256.txt`.
3. Run the bake steps needed for the changed data.
4. Replace only the reviewed generated files under `research/data/`.
5. Run:

```bash
node research/tools/validate_research_data.js
node research/tools/validate_region_feature.js
```

## Main CLI Steps

```bash
python research/tools/bake/bake.py --help
python research/tools/bake/bake.py hardware
python research/tools/bake/bake.py aoi
python research/tools/bake/bake.py subbasins
python research/tools/bake/bake.py zonal
python research/tools/bake/bake.py demand
python research/tools/bake/bake.py supply
python research/tools/bake/bake.py health
python research/tools/bake/bake.py bake
python research/tools/bake/bake.py provenance
python research/tools/bake/bake.py bake-preflight
```

The CLI should keep printing blocked statuses when required real inputs are missing. Use `--stub` only for synthetic wiring checks, not for research claims.
