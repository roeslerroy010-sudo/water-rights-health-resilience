#!/usr/bin/env python3
"""Offline bake entrypoint for the Wuhan research data layer.

This file is intentionally stdlib-only at import time. Heavy geospatial
dependencies are loaded by future step implementations after real source data
are present.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import subprocess
import re
import shutil
import sys
import zipfile
from datetime import datetime, timezone
from importlib.util import find_spec
from pathlib import Path
from typing import Callable, Iterable


BAKE_DIR = Path(__file__).resolve().parent
TOOLS_DIR = BAKE_DIR.parent
RESEARCH_DIR = TOOLS_DIR.parent
DATA_DIR = RESEARCH_DIR / "data"
RAW_DIR = BAKE_DIR / "raw"
INTERMEDIATE_DIR = BAKE_DIR / "intermediate"
OUT_DIR = BAKE_DIR / "out"

BBOX = [112.5, 29.0, 116.0, 31.5]
EARTH_RADIUS_M = 6_371_008.8
CITIES = [
    "Wuhan",
    "Huangshi",
    "Ezhou",
    "Xiaogan",
    "Huanggang",
    "Xianning",
    "Xiantao",
    "Tianmen",
    "Qianjiang",
]
CITY_ZH_BY_EN = {
    "Wuhan": "武汉",
    "Huanggang": "黄冈",
    "Xiaogan": "孝感",
    "Xianning": "咸宁",
    "Tianmen": "天门",
    "Qianjiang": "潜江",
    "Ezhou": "鄂州",
    "Huangshi": "黄石",
    "Xiantao": "仙桃",
}
CITY_ORDER = {city: index for index, city in enumerate(CITIES)}
SECTORS = ["agri", "industry", "urban", "eco"]
HEALTH_DRAFT_WEIGHTS = {"urban": 1.0, "eco": 0.7, "agri": 0.1, "industry": -0.25}
DOWNSTREAM_EXPOSURE_ATTENUATION = 0.35
TARGET_GID_BY_CITY = {
    "Wuhan": "CHN.13.12_1",
    "Huangshi": "CHN.13.4_1",
    "Ezhou": "CHN.13.2_1",
    "Xiaogan": "CHN.13.16_1",
    "Huanggang": "CHN.13.3_1",
    "Xianning": "CHN.13.14_1",
    "Xiantao": "CHN.13.15_1",
    "Tianmen": "CHN.13.11_1",
    "Qianjiang": "CHN.13.7_1",
}
TARGET_GID_SET = set(TARGET_GID_BY_CITY.values())
BULLETIN_TARGET_CITIES = [
    ("Wuhan", "武汉市"),
    ("Huangshi", "黄石市"),
    ("Ezhou", "鄂州市"),
    ("Xiaogan", "孝感市"),
    ("Huanggang", "黄冈市"),
    ("Xianning", "咸宁市"),
    ("Xiantao", "仙桃市"),
    ("Qianjiang", "潜江市"),
    ("Tianmen", "天门市"),
]
BULLETIN_TABLE12_OTHER_ROW_LABELS = [
    "十堰市",
    "宜昌市",
    "襄阳市",
    "荆门市",
    "荆州市",
    "随州市",
    "恩施州",
    "神农架",
    "全　省",
    "全省",
]
BULLETIN_TABLE12_COLUMNS = [
    "old_industry",
    "old_agri",
    "old_life",
    "new_production",
    "new_life",
    "new_ecology",
    "total",
    "change_pct",
    "assessment_total",
]
BULLETIN_TABLE12_TOTAL_TOLERANCE = 0.02
BULLETIN_TABLE5_INFLOW_ROWS = [
    ("yangtze_mainstem", "长江干流", "重庆"),
    ("dongting_lake_system", "洞庭湖水系", "湖南"),
    ("han_mainstem", "汉江干流", "陕西"),
    ("danjiang_system", "丹江水系", "河南"),
    ("tangbai_river_system", "唐白河水系", "河南"),
    ("duhe_nanhe", "堵河南江", "陕西"),
    ("tianhe", "天河", "陕西"),
    ("xiaoqinghe_etc", "小清河等", "河南"),
    ("fushui_system", "富水水系", "江西"),
    ("huanggai_lake_system", "黄盖湖水系", "湖南"),
    ("huanshui", "澴水", "河南"),
    ("daoshui", "倒水", "河南"),
    ("jushui", "举水", "河南"),
]
BULLETIN_TABLE5_HAN_SYSTEM_IDS = {
    "han_mainstem",
    "danjiang_system",
    "tangbai_river_system",
    "duhe_nanhe",
    "tianhe",
    "xiaoqinghe_etc",
}
BULLETIN_TABLE5_MINOR_FIVE_IDS = {
    "fushui_system",
    "huanggai_lake_system",
    "huanshui",
    "daoshui",
    "jushui",
}
APPROVED_MAINSTEM_TRANSIT_INJECTIONS = {
    "PF_465500": {
        "sourceFlowId": "yangtze_mainstem_entry",
        "sourceLabel": "Yangtze mainstem provincial-boundary inflow",
        "annualInflowM3": 355_275_000_000,
        "basis": "Hubei Water Resources Bulletin 2022 table 5, Yangtze mainstem inflow row; province total excluded.",
        "confidence": "low_node_assignment_provincial_boundary_proxy",
    },
    "PF_465610": {
        "sourceFlowId": "han_mainstem_entry",
        "sourceLabel": "Han mainstem provincial-boundary inflow",
        "annualInflowM3": 17_553_000_000,
        "basis": "Hubei Water Resources Bulletin 2022 table 5, Han mainstem inflow row; Han-system aggregate excluded.",
        "confidence": "low_node_assignment_provincial_boundary_proxy",
    },
}
APPROVED_MAINSTEM_TRANSIT_INFLOW_TOTAL_M3 = sum(
    item["annualInflowM3"] for item in APPROVED_MAINSTEM_TRANSIT_INJECTIONS.values()
)


class BakeBlocked(RuntimeError):
    """Raised when a real-data step cannot run honestly yet."""

    def __init__(self, step: str, missing: Iterable[Path | str], note: str):
        self.step = step
        self.missing = [str(item) for item in missing]
        self.note = note
        super().__init__(note)


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(BAKE_DIR))
    except ValueError:
        try:
            return str(path.relative_to(RESEARCH_DIR.parent))
        except ValueError:
            return str(path)


def ensure_dirs() -> None:
    INTERMEDIATE_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)


def has_files(path: Path) -> bool:
    return path.exists() and any(child.is_file() for child in path.rglob("*"))


def command_available(name: str) -> bool:
    return shutil.which(name) is not None


def local_node_bin_available(name: str) -> bool:
    return (RESEARCH_DIR.parent / "node_modules" / ".bin" / name).exists()


def python_module_available(name: str) -> bool:
    return find_spec(name) is not None


def require_paths(step: str, paths: Iterable[Path], note: str) -> None:
    missing = []
    for path in paths:
        if path.suffix:
            if not path.exists():
                missing.append(path)
        elif not has_files(path):
            missing.append(path)
    if missing:
        raise BakeBlocked(step, missing, note)


def require_metadata_flag(step: str, path: Path, flag: str, note: str) -> None:
    if not path.exists():
        raise BakeBlocked(step, [path], note)
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get(flag) is not True:
        raise BakeBlocked(step, [f"{rel(path)}:{flag}=true"], note)


def require_metadata_flag_not_true(step: str, path: Path, flag: str, note: str) -> None:
    if not path.exists():
        raise BakeBlocked(step, [path], note)
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get(flag) is True:
        raise BakeBlocked(step, [f"{rel(path)}:{flag} must not be true"], note)


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_csv(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def file_size(path: Path) -> int | None:
    return path.stat().st_size if path.exists() else None


def read_json_if_exists(path: Path) -> object | None:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def count_coordinate_positions(value: object) -> int:
    if isinstance(value, list):
        if len(value) >= 2 and all(isinstance(item, (int, float)) for item in value[:2]):
            return 1
        return sum(count_coordinate_positions(item) for item in value)
    if isinstance(value, dict):
        return sum(count_coordinate_positions(item) for item in value.values())
    return 0


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def bytes_to_gib(value: int | float) -> float:
    return round(float(value) / (1024 ** 3), 2)


def physical_memory_bytes() -> int | None:
    try:
        page_size = os.sysconf("SC_PAGE_SIZE")
        page_count = os.sysconf("SC_PHYS_PAGES")
    except (AttributeError, OSError, ValueError):
        return None
    if not isinstance(page_size, int) or not isinstance(page_count, int):
        return None
    return page_size * page_count


def step_hardware(_: argparse.Namespace) -> list[Path]:
    disk = shutil.disk_usage(RESEARCH_DIR)
    memory = physical_memory_bytes()
    disk_free_gib = bytes_to_gib(disk.free)
    memory_gib = bytes_to_gib(memory) if memory is not None else None

    print("Hardware gate for full local bake")
    print(f"Disk free: {disk_free_gib} GiB at {RESEARCH_DIR}")
    if memory_gib is None:
        print("Memory: UNKNOWN (manual confirmation required; target >= 16 GiB)")
    else:
        print(f"Memory: {memory_gib} GiB physical")

    disk_ok = disk_free_gib >= 50
    memory_ok = memory_gib is not None and memory_gib >= 16
    print(f"Disk target >= 50 GiB: {'OK' if disk_ok else 'BLOCKED'}")
    print(f"Memory target >= 16 GiB: {'OK' if memory_ok else 'BLOCKED'}")
    if not disk_ok or not memory_ok:
        raise BakeBlocked(
            "hardware",
            [],
            "Full local bake hardware preflight is not satisfied; use GEE fallback or expand resources before real run.",
        )
    return []


def stub_aoi() -> dict[str, object]:
    min_lng, min_lat, max_lng, max_lat = BBOX
    return {
        "type": "FeatureCollection",
        "name": "stub_aoi",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "id": "AOI_STUB",
                    "name": "Synthetic Wuhan 1+8 AOI stub",
                    "synthetic": True,
                    "areaKm2Placeholder": 58000,
                },
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        [
                            [min_lng, min_lat],
                            [max_lng, min_lat],
                            [max_lng, max_lat],
                            [min_lng, max_lat],
                            [min_lng, min_lat],
                        ]
                    ],
                },
            }
        ],
    }


def stub_subbasins() -> tuple[dict[str, object], dict[str, str]]:
    cells = [
        ("SB_STUB_01", 112.7, 29.2, 113.7, 30.1, "SB_STUB_03"),
        ("SB_STUB_02", 113.7, 29.2, 114.9, 30.1, "SB_STUB_03"),
        ("SB_STUB_03", 114.1, 30.1, 115.0, 30.9, "SB_STUB_04"),
        ("SB_STUB_04", 115.0, 30.3, 115.8, 31.2, "OUTLET"),
    ]
    features = []
    topology = {}
    for basin_id, min_lng, min_lat, max_lng, max_lat, downstream in cells:
        topology[basin_id] = downstream
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "id": basin_id,
                    "downstream": downstream,
                    "synthetic": True,
                },
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        [
                            [min_lng, min_lat],
                            [max_lng, min_lat],
                            [max_lng, max_lat],
                            [min_lng, max_lat],
                            [min_lng, min_lat],
                        ]
                    ],
                },
            }
        )
    return {"type": "FeatureCollection", "features": features}, topology


def downstream_reach(basin_id: str, topology: dict[str, str]) -> list[str]:
    reach: list[str] = []
    seen = {basin_id}
    current = topology.get(basin_id)
    while current and current != "OUTLET":
        if current in seen:
            raise ValueError(f"cycle detected at {current}")
        reach.append(current)
        seen.add(current)
        current = topology.get(current)
    reach.append("OUTLET")
    return reach


def validate_topology_dict(topology: object, step: str) -> dict[str, str]:
    if not isinstance(topology, dict) or not topology:
        raise BakeBlocked(step, [INTERMEDIATE_DIR / "topology.json"], "Topology must be a non-empty JSON object.")
    normalized: dict[str, str] = {}
    for basin_id, downstream in topology.items():
        if not isinstance(basin_id, str) or not isinstance(downstream, str):
            raise BakeBlocked(step, [INTERMEDIATE_DIR / "topology.json"], "Topology ids and downstream values must be strings.")
        normalized[basin_id] = downstream
    missing_downstream = sorted(
        downstream for downstream in set(normalized.values()) if downstream != "OUTLET" and downstream not in normalized
    )
    if missing_downstream:
        raise BakeBlocked(
            step,
            [f"{rel(INTERMEDIATE_DIR / 'topology.json')} downstream={item}" for item in missing_downstream[:10]],
            "Topology downstream ids must exist in the selected graph or be OUTLET.",
        )
    topology_order(normalized, step)
    return normalized


def read_topology(required: bool = False, step: str = "topology") -> dict[str, str]:
    path = INTERMEDIATE_DIR / "topology.json"
    if not path.exists():
        if required:
            raise BakeBlocked(step, [path], "Need topology.json; real/audit steps must not fall back to stub topology.")
        return stub_subbasins()[1]
    return validate_topology_dict(json.loads(path.read_text(encoding="utf-8")), step)


def read_metadata(path: Path) -> dict[str, object]:
    if not path.exists():
        raise BakeBlocked("metadata", [path], f"Need metadata file {rel(path)}.")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise BakeBlocked("metadata", [path], f"Metadata file {rel(path)} is not a JSON object.")
    return payload


def require_csv_ids_match_topology(step: str, csv_path: Path, topology_path: Path = INTERMEDIATE_DIR / "topology.json") -> None:
    if not csv_path.exists():
        raise BakeBlocked(step, [csv_path], f"Need {rel(csv_path)} before {step}.")
    topology = validate_topology_dict(json.loads(topology_path.read_text(encoding="utf-8")), step)
    rows = load_csv_rows(csv_path)
    ids = {row.get("id", "") for row in rows}
    missing = sorted(set(topology) - ids)
    extra = sorted(ids - set(topology))
    stub_like = sorted(item for item in ids if str(item).startswith("SB_STUB_"))
    if missing or extra or stub_like:
        evidence = []
        evidence.extend(f"missing:{item}" for item in missing[:10])
        evidence.extend(f"extra:{item}" for item in extra[:10])
        evidence.extend(f"stub:{item}" for item in stub_like[:10])
        raise BakeBlocked(
            step,
            evidence or [csv_path],
            f"{rel(csv_path)} ids must exactly match topology and must not contain stub ids before formal {step}.",
        )


def topology_order(topology: dict[str, str], step: str) -> list[str]:
    nodes = set(topology)
    indegree = {node: 0 for node in nodes}
    children: dict[str, list[str]] = {node: [] for node in nodes}
    for node, downstream in topology.items():
        if downstream in nodes:
            children[node].append(downstream)
            indegree[downstream] += 1

    queue = sorted(node for node, degree in indegree.items() if degree == 0)
    order: list[str] = []
    while queue:
        node = queue.pop(0)
        order.append(node)
        for child in sorted(children[node]):
            indegree[child] -= 1
            if indegree[child] == 0:
                queue.append(child)
                queue.sort()

    if len(order) != len(nodes):
        raise BakeBlocked(step, [], "Topology cycle detected while sorting upstream-to-downstream order.")
    return order


def upstream_index(topology: dict[str, str]) -> dict[str, list[str]]:
    upstreams: dict[str, list[str]] = {node: [] for node in topology}
    for node, downstream in topology.items():
        if downstream in upstreams:
            upstreams[downstream].append(node)
    return upstreams


def load_csv_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def csv_float(row: dict[str, object], key: str, default: float = 0.0) -> float:
    value = row.get(key)
    if value in (None, ""):
        return default
    return float(value)


def csv_int(row: dict[str, object], key: str, default: int = 0) -> int:
    return int(round(csv_float(row, key, float(default))))


def number_value(value: object, default: float = 0.0) -> float:
    if value in (None, ""):
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def city_overlap_by_basin(rows: list[dict[str, str]]) -> dict[str, dict[str, float]]:
    overlaps: dict[str, dict[str, float]] = {}
    for row in rows:
        basin_id = row.get("basin_id") or row.get("id")
        city = row.get("city")
        if not basin_id or not city:
            continue
        weight = number_value(row.get("basin_area_fraction"), 0.0)
        basin_overlaps = overlaps.setdefault(basin_id, {})
        basin_overlaps[city] = basin_overlaps.get(city, 0.0) + weight
    return overlaps


def load_city_overlap_by_basin() -> dict[str, dict[str, float]]:
    path = INTERMEDIATE_DIR / "city_demand_allocation_draft.csv"
    if not path.exists():
        return {}
    return city_overlap_by_basin(load_csv_rows(path))


def load_pfaf_id_by_basin() -> dict[str, object]:
    path = DATA_DIR / "wuhan-subbasins.geojson"
    if not path.exists():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    pfaf_by_id: dict[str, object] = {}
    for feature in payload.get("features", []):
        props = feature.get("properties", {}) if isinstance(feature, dict) else {}
        basin_id = props.get("id") or feature.get("id")
        if basin_id and props.get("pfafId") is not None:
            pfaf_by_id[str(basin_id)] = props.get("pfafId")
    return pfaf_by_id


def primary_city(subbasin: dict[str, object], overlaps: dict[str, dict[str, float]]) -> str:
    basin_id = str(subbasin.get("id") or "")
    admin_cities = [str(city) for city in subbasin.get("adminCities", []) if city]
    weighted = overlaps.get(basin_id, {})
    candidates = admin_cities or list(weighted) or ["Wuhan"]
    return sorted(
        candidates,
        key=lambda city: (-weighted.get(city, 0.0), CITY_ORDER.get(city, len(CITY_ORDER)), city),
    )[0]


def land_feature_label(subbasin: dict[str, object]) -> str:
    zonal = subbasin.get("zonalProxy")
    zonal = zonal if isinstance(zonal, dict) else {}
    area_km2 = number_value(subbasin.get("areaKm2"), 0.0)
    area_ha = area_km2 * 100.0
    population = number_value(subbasin.get("population"), 0.0)
    cropland_ha = number_value(zonal.get("croplandHa"), 0.0)
    builtup_ha = number_value(zonal.get("builtupHa"), 0.0)
    builtup_share = builtup_ha / area_ha if area_ha > 0 else 0.0
    population_density = population / area_km2 if area_km2 > 0 else 0.0
    cropland_share = cropland_ha / area_ha if area_ha > 0 else 0.0

    if builtup_share >= 0.08 or population_density >= 400.0:
        return "城区"
    if cropland_ha > builtup_ha and cropland_share >= 0.05:
        return "农业区"
    if cropland_ha > 0:
        return "农业丘陵"
    return "丘陵"


def centroid_sort_key(record: dict[str, object]) -> tuple[float, float, str]:
    centroid = record.get("centroid")
    if isinstance(centroid, list) and len(centroid) >= 2:
        lng = number_value(centroid[0], 0.0)
        lat = number_value(centroid[1], 0.0)
    elif isinstance(centroid, dict):
        lng = number_value(centroid.get("lng", centroid.get("lon", centroid.get("x"))), 0.0)
        lat = number_value(centroid.get("lat", centroid.get("y")), 0.0)
    else:
        lng = 0.0
        lat = 0.0
    return (-lat, lng, str(record.get("id") or ""))


def apply_readable_subbasin_names(
    subbasins: list[dict[str, object]],
    overlaps: dict[str, dict[str, float]] | None = None,
    pfaf_id_by_basin: dict[str, object] | None = None,
) -> None:
    overlaps = overlaps or {}
    pfaf_id_by_basin = pfaf_id_by_basin or {}
    groups: dict[tuple[str, str], list[dict[str, object]]] = {}
    for subbasin in subbasins:
        code = str(subbasin.get("id") or subbasin.get("pfafId") or subbasin.get("code") or "")
        if code:
            subbasin["code"] = code
        if code in pfaf_id_by_basin:
            subbasin["pfafId"] = pfaf_id_by_basin[code]
        elif "pfafId" not in subbasin and code:
            subbasin["pfafId"] = code
        city_en = primary_city(subbasin, overlaps)
        city_zh = CITY_ZH_BY_EN.get(city_en, city_en)
        feature = land_feature_label(subbasin)
        subbasin["_nameGroup"] = (city_zh, feature)
        groups.setdefault((city_zh, feature), []).append(subbasin)

    for (city_zh, feature), records in groups.items():
        ordered = sorted(records, key=centroid_sort_key)
        for index, record in enumerate(ordered, start=1):
            suffix = str(index) if len(ordered) > 1 else ""
            record["name"] = f"{city_zh}·{feature}{suffix}"
            record.pop("_nameGroup", None)


def sync_subbasin_geojson_names(
    subbasins_geojson: dict[str, object],
    subbasin_records: list[dict[str, object]],
) -> None:
    record_by_id = {str(record.get("id")): record for record in subbasin_records if record.get("id")}
    for feature in subbasins_geojson.get("features", []):
        if not isinstance(feature, dict):
            continue
        properties = feature.setdefault("properties", {})
        if not isinstance(properties, dict):
            continue
        basin_id = str(properties.get("id") or feature.get("id") or "")
        record = record_by_id.get(basin_id)
        if not record:
            continue
        properties["id"] = basin_id
        properties["name"] = record.get("name")
        properties["code"] = record.get("code") or basin_id
        if record.get("pfafId") is not None:
            properties["pfafId"] = record.get("pfafId")
        feature["id"] = basin_id


def step_name_real(_: argparse.Namespace) -> list[Path]:
    attrs_path = DATA_DIR / "wuhan-attrs.json"
    subbasins_path = DATA_DIR / "wuhan-subbasins.geojson"
    if not attrs_path.exists():
        raise BakeBlocked("name", [attrs_path], "Need existing wuhan-attrs.json before writing readable labels.")
    attrs = json.loads(attrs_path.read_text(encoding="utf-8"))
    subbasins = attrs.get("subbasins") if isinstance(attrs, dict) else None
    if not isinstance(subbasins, list) or not subbasins:
        raise BakeBlocked("name", [attrs_path], "wuhan-attrs.json must contain a non-empty subbasins array.")
    apply_readable_subbasin_names(subbasins, load_city_overlap_by_basin(), load_pfaf_id_by_basin())
    write_json(attrs_path, attrs)
    outputs = [attrs_path]
    if subbasins_path.exists():
        subbasins_geojson = json.loads(subbasins_path.read_text(encoding="utf-8"))
        sync_subbasin_geojson_names(subbasins_geojson, subbasins)
        write_json(subbasins_path, subbasins_geojson)
        outputs.append(subbasins_path)
    print(f"REAL wrote readable subbasin labels to {rel(attrs_path)}")
    if subbasins_path in outputs:
        print(f"REAL synced readable subbasin labels to {rel(subbasins_path)}")
    return outputs


def round_coord(value: float, places: int = 5) -> float:
    return round(float(value), places)


def round_coordinates(value: object, places: int = 5) -> object:
    if isinstance(value, list):
        if len(value) >= 2 and all(isinstance(item, (int, float)) for item in value[:2]):
            return [round_coord(float(value[0]), places), round_coord(float(value[1]), places)]
        return [round_coordinates(item, places) for item in value]
    return value


def round_geometry_coordinates(geometry: dict[str, object], places: int = 5) -> dict[str, object]:
    rounded = dict(geometry)
    rounded["coordinates"] = round_coordinates(geometry.get("coordinates"), places)
    return rounded


def parse_number_token(token: str) -> float:
    return float(token.strip().replace("−", "-").replace("－", "-"))


def normalize_bulletin_label(value: str) -> str:
    return value.strip().replace(" ", "").replace("　", "")


def assert_bulletin_row_totals(row: dict[str, object], label: str) -> None:
    old_sum = round(float(row["old_industry"]) + float(row["old_agri"]) + float(row["old_life"]), 2)
    new_sum = round(float(row["new_production"]) + float(row["new_life"]) + float(row["new_ecology"]), 2)
    total = float(row["total"])
    if (
        abs(old_sum - total) > BULLETIN_TABLE12_TOTAL_TOLERANCE
        or abs(new_sum - total) > BULLETIN_TABLE12_TOTAL_TOLERANCE
    ):
        raise BakeBlocked(
            "bulletin-draft",
            [f"table12 total check for {label}"],
            f"Bulletin table 12 row total mismatch for {label}: old={old_sum}, new={new_sum}, total={total}.",
        )


def extract_bulletin_page_text(pdf_path: Path, page_index: int) -> str:
    try:
        import fitz  # PyMuPDF
    except ModuleNotFoundError as exc:
        raise BakeBlocked(
            "bulletin-draft",
            ["PyMuPDF/fitz module in the Python interpreter used for this command"],
            "Need PyMuPDF to extract the text layer from the Hubei Water Resources Bulletin PDF. "
            "Install requirements into .venv-bake or rerun with the Codex Python that already has fitz.",
        ) from exc

    document = fitz.open(pdf_path)
    if page_index >= document.page_count:
        raise BakeBlocked(
            "bulletin-draft",
            [pdf_path],
            f"Bulletin PDF has only {document.page_count} pages; cannot read page index {page_index}.",
        )
    return document[page_index].get_text("text")


def parse_bulletin_table12_rows(text: str) -> list[dict[str, object]]:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    city_lookup = {city_zh: city_en for city_en, city_zh in BULLETIN_TARGET_CITIES}
    row_label_set = {
        normalize_bulletin_label(city_zh)
        for _, city_zh in BULLETIN_TARGET_CITIES
    } | {normalize_bulletin_label(label) for label in BULLETIN_TABLE12_OTHER_ROW_LABELS}
    rows: list[dict[str, object]] = []
    number_pattern = re.compile(r"^-?\d+(?:\.\d+)?$")
    index = 0
    while index < len(lines):
        city_zh = lines[index]
        if city_zh not in city_lookup:
            index += 1
            continue
        cursor = index + 1
        while cursor < len(lines) and normalize_bulletin_label(lines[cursor]) not in row_label_set:
            cursor += 1
        row_segment = lines[index + 1 : cursor]
        values = [
            parse_number_token(candidate.replace(" ", ""))
            for candidate in row_segment
            if number_pattern.match(candidate.replace(" ", ""))
        ]
        if len(values) != len(BULLETIN_TABLE12_COLUMNS):
            raise BakeBlocked(
                "bulletin-draft",
                [f"table12 row for {city_zh}"],
                f"Expected {len(BULLETIN_TABLE12_COLUMNS)} numeric columns before the next city label, got {len(values)}; manual review is required.",
            )
        row = {
            "row_type": "city",
            "city": city_lookup[city_zh],
            "city_zh": city_zh,
            "unit": "亿立方米",
            "source_table": "表12 2022年湖北省各市州用水量",
            "source_pdf_page": 16,
            "draft": True,
            "needs_human_review": True,
        }
        row.update({column: values[column_index] for column_index, column in enumerate(BULLETIN_TABLE12_COLUMNS)})
        assert_bulletin_row_totals(row, city_zh)
        rows.append(row)
        index = cursor

    expected = {city_en for city_en, _ in BULLETIN_TARGET_CITIES}
    parsed = {str(row["city"]) for row in rows}
    missing = sorted(expected - parsed)
    if missing:
        raise BakeBlocked(
            "bulletin-draft",
            [f"missing table12 target cities: {', '.join(missing)}"],
            "Could not parse all Wuhan 1+8 target-city rows from bulletin table 12.",
        )
    return rows


def append_bulletin_target_total(rows: list[dict[str, object]]) -> dict[str, object]:
    total = {
        "row_type": "target_total",
        "city": "Wuhan 1+8 total",
        "city_zh": "武汉城市圈1+8合计",
        "unit": "亿立方米",
        "source_table": "表12 2022年湖北省各市州用水量",
        "source_pdf_page": 16,
        "draft": True,
        "needs_human_review": True,
    }
    for column in BULLETIN_TABLE12_COLUMNS:
        if column == "change_pct":
            total[column] = ""
        else:
            total[column] = round(sum(float(row[column]) for row in rows), 2)
    assert_bulletin_row_totals(total, str(total["city_zh"]))
    rows.append(total)
    return total


def parse_bulletin_table5_mainstem_rows(text: str) -> tuple[list[dict[str, object]], dict[str, float]]:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    normalized_lines = [normalize_bulletin_label(line) for line in lines]
    number_pattern = re.compile(r"^-?\d+(?:\.\d+)?$")
    cursor = 0
    rows: list[dict[str, object]] = []
    values_by_id: dict[str, float] = {}
    parent_flow_id = {row_id: "province_total" for row_id, _, _ in BULLETIN_TABLE5_INFLOW_ROWS}
    parent_flow_id.update(
        {
            "han_mainstem": "han_system_entry",
            "danjiang_system": "han_system_entry",
            "tangbai_river_system": "han_system_entry",
            "duhe_nanhe": "han_system_entry",
            "tianhe": "han_system_entry",
            "xiaoqinghe_etc": "han_system_entry",
            "fushui_system": "minor_five_rivers_entry",
            "huanggai_lake_system": "minor_five_rivers_entry",
            "huanshui": "minor_five_rivers_entry",
            "daoshui": "minor_five_rivers_entry",
            "jushui": "minor_five_rivers_entry",
        }
    )

    for row_id, river_system_zh, upstream_province_zh in BULLETIN_TABLE5_INFLOW_ROWS:
        label = normalize_bulletin_label(river_system_zh)
        try:
            index = next(i for i in range(cursor, len(lines)) if normalized_lines[i] == label)
        except StopIteration as exc:
            raise BakeBlocked(
                "mainstem-inflow-draft",
                [f"表5 row label: {river_system_zh}"],
                "Could not locate an expected inflow row in Hubei bulletin table 5.",
            ) from exc
        value_index = None
        for candidate_index in range(index + 1, min(index + 5, len(lines))):
            if number_pattern.match(lines[candidate_index].replace(" ", "")):
                value_index = candidate_index
                break
        if value_index is None:
            raise BakeBlocked(
                "mainstem-inflow-draft",
                [f"表5 value for: {river_system_zh}"],
                "Could not locate a numeric inflow value after an expected table 5 row label.",
            )
        value_1e8_m3 = round(parse_number_token(lines[value_index]), 2)
        values_by_id[row_id] = value_1e8_m3
        page_hint = "9" if row_id in BULLETIN_TABLE5_MINOR_FIVE_IDS else "8"
        rows.append(
            {
                "id": f"MS_INFLOW_{row_id.upper()}",
                "flow_id": row_id,
                "row_type": "table5_inflow",
                "year": 2022,
                "label": f"{river_system_zh}入境",
                "parent_flow_id": parent_flow_id.get(row_id, ""),
                "river_system": river_system_zh,
                "component": "province_boundary_inflow",
                "upstream_province": upstream_province_zh,
                "boundary_scope": "Hubei provincial boundary",
                "annual_inflow_1e8_m3": value_1e8_m3,
                "value_100million_m3": value_1e8_m3,
                "annual_inflow_m3": round(value_1e8_m3 * 100_000_000, 3),
                "value_m3": round(value_1e8_m3 * 100_000_000, 3),
                "annual_inflow_million_m3": round(value_1e8_m3 * 100, 6),
                "source_url": "http://slt.hubei.gov.cn/bsfw/cxfw/szygb/202307/P020230720530853000978.pdf",
                "source_file": rel(RAW_DIR / "bulletin" / "hubei_water_resources_bulletin_2022.pdf"),
                "source_pdf_page": page_hint,
                "source_page": page_hint,
                "source_locator": "表5 2022年湖北省入出境水量",
                "source_table": "表5 2022年湖北省入出境水量",
                "source_line_hint": f"{river_system_zh}/{upstream_province_zh}/{value_1e8_m3}",
                "audit_scope": "湖北省省界入境",
                "spatial_scope_warning": "Provincial-boundary inflow; not a Wuhan 1+8 AOI or subbasin injection amount.",
                "candidate_injection_node_id": "",
                "injectable_to_wuhan_1plus8": False,
                "injection_ready": False,
                "is_aggregate": False,
                "do_not_sum_with_children": False,
                "draft": True,
                "needs_human_review": True,
                "method": "audit_only_pdf_table5_text_extraction",
            }
        )
        cursor = value_index + 1

    try:
        total_index = next(i for i in range(cursor, len(lines)) if normalize_bulletin_label(lines[i]) == "入境合计")
        table_total_1e8_m3 = parse_number_token(lines[total_index + 1])
    except (StopIteration, IndexError, ValueError) as exc:
        raise BakeBlocked(
            "mainstem-inflow-draft",
            ["表5 入境合计"],
            "Could not locate table 5 inflow total; manual review is required.",
        ) from exc

    derived = {
        "tableInflowTotal1e8M3": round(table_total_1e8_m3, 2),
        "sumParsedInflowRows1e8M3": round(sum(values_by_id.values()), 2),
        "yangtzeMainstem1e8M3": values_by_id["yangtze_mainstem"],
        "hanSystem1e8M3": round(sum(values_by_id[row_id] for row_id in BULLETIN_TABLE5_HAN_SYSTEM_IDS), 2),
        "hanMainstem1e8M3": values_by_id["han_mainstem"],
        "dongtingLakeSystem1e8M3": values_by_id["dongting_lake_system"],
        "minorFiveRivers1e8M3": round(sum(values_by_id[row_id] for row_id in BULLETIN_TABLE5_MINOR_FIVE_IDS), 2),
    }
    if abs(derived["sumParsedInflowRows1e8M3"] - derived["tableInflowTotal1e8M3"]) > 0.02:
        raise BakeBlocked(
            "mainstem-inflow-draft",
            ["表5 parsed inflow total check"],
            f"Parsed table 5 inflow rows sum to {derived['sumParsedInflowRows1e8M3']} but table total is {derived['tableInflowTotal1e8M3']}.",
        )

    compact_text = re.sub(r"\s+", "", text)
    paragraph_checks = {
        "paragraphTotal1e8M3": r"全省入境水量(\d+(?:\.\d+)?)亿立方米",
        "paragraphYangtzeMainstem1e8M3": r"长江干流入境水量(\d+(?:\.\d+)?)亿立方米",
        "paragraphHanSystem1e8M3": r"汉江水系入境水量(\d+(?:\.\d+)?)亿立方米",
        "paragraphDongtingLakeSystem1e8M3": r"洞庭湖水系入境水量(\d+(?:\.\d+)?)亿立方米",
        "paragraphMinorFiveRivers1e8M3": r"五条中小河流入境水量(\d+(?:\.\d+)?)亿立方米",
    }
    for key, pattern in paragraph_checks.items():
        match = re.search(pattern, compact_text)
        if match:
            derived[key] = round(float(match.group(1)), 2)
    paragraph_cross_checks = [
        ("paragraphTotal1e8M3", "tableInflowTotal1e8M3"),
        ("paragraphYangtzeMainstem1e8M3", "yangtzeMainstem1e8M3"),
        ("paragraphHanSystem1e8M3", "hanSystem1e8M3"),
        ("paragraphDongtingLakeSystem1e8M3", "dongtingLakeSystem1e8M3"),
        ("paragraphMinorFiveRivers1e8M3", "minorFiveRivers1e8M3"),
    ]
    for paragraph_key, table_key in paragraph_cross_checks:
        if paragraph_key in derived and abs(derived[paragraph_key] - derived[table_key]) > 0.02:
            raise BakeBlocked(
                "mainstem-inflow-draft",
                [f"{paragraph_key} vs {table_key}"],
                f"Bulletin paragraph value {derived[paragraph_key]} does not match table-derived value {derived[table_key]}.",
            )

    summary_rows = [
        (
            "province_total",
            "全省入境合计",
            "table5_total",
            "",
            derived["tableInflowTotal1e8M3"],
            "Table 5 inflow total.",
        ),
        (
            "yangtze_mainstem_entry",
            "长江干流",
            "mainstem_entry_candidate",
            "重庆",
            derived["yangtzeMainstem1e8M3"],
            "Table 5 row and paragraph both identify Yangtze mainstem provincial-boundary inflow.",
        ),
        (
            "han_system_entry",
            "汉江水系",
            "system_entry_candidate",
            "陕西|河南",
            derived["hanSystem1e8M3"],
            "Derived from table 5 Han-system component rows; paragraph reports the same system total.",
        ),
        (
            "han_mainstem_entry",
            "汉江干流",
            "mainstem_entry_candidate",
            "陕西",
            derived["hanMainstem1e8M3"],
            "Table 5 Han mainstem component row.",
        ),
        (
            "minor_five_rivers_entry",
            "富水、倒水等五条中小河流",
            "minor_river_entry_candidate",
            "江西|湖南|河南",
            derived["minorFiveRivers1e8M3"],
            "Derived from table 5 five small-river component rows; paragraph reports the same group total.",
        ),
    ]
    for row_id, river_system_zh, component, upstream, value_1e8_m3, hint in summary_rows:
        is_aggregate = row_id in {"province_total", "han_system_entry", "minor_five_rivers_entry"}
        rows.append(
            {
                "id": f"MS_SUMMARY_{row_id.upper()}",
                "flow_id": row_id,
                "row_type": "derived_summary",
                "year": 2022,
                "label": river_system_zh if "入境" in river_system_zh else f"{river_system_zh}入境",
                "parent_flow_id": "province_total" if row_id != "province_total" else "",
                "river_system": river_system_zh,
                "component": component,
                "upstream_province": upstream,
                "boundary_scope": "Hubei provincial boundary",
                "annual_inflow_1e8_m3": value_1e8_m3,
                "value_100million_m3": value_1e8_m3,
                "annual_inflow_m3": round(value_1e8_m3 * 100_000_000, 3),
                "value_m3": round(value_1e8_m3 * 100_000_000, 3),
                "annual_inflow_million_m3": round(value_1e8_m3 * 100, 6),
                "source_url": "http://slt.hubei.gov.cn/bsfw/cxfw/szygb/202307/P020230720530853000978.pdf",
                "source_file": rel(RAW_DIR / "bulletin" / "hubei_water_resources_bulletin_2022.pdf"),
                "source_pdf_page": "8-9",
                "source_page": "8-9",
                "source_locator": "地表水资源量正文汇总及表5子项加总",
                "source_table": "表5 2022年湖北省入出境水量",
                "source_line_hint": hint,
                "audit_scope": "湖北省省界入境汇总",
                "spatial_scope_warning": "Provincial-boundary inflow; not a Wuhan 1+8 AOI or subbasin injection amount.",
                "candidate_injection_node_id": "",
                "injectable_to_wuhan_1plus8": False,
                "injection_ready": False,
                "is_aggregate": is_aggregate,
                "do_not_sum_with_children": is_aggregate,
                "draft": True,
                "needs_human_review": True,
                "method": "audit_only_table5_summary_for_mainstem_inflow_review",
            }
        )

    return rows, derived


def allocate_total_by_weight(total: float, weights_by_id: dict[str, float]) -> dict[str, float]:
    clean_weights = {basin_id: max(0.0, float(weight)) for basin_id, weight in weights_by_id.items()}
    weight_total = sum(clean_weights.values())
    if weight_total <= 0:
        equal = total / len(clean_weights) if clean_weights else 0.0
        return {basin_id: equal for basin_id in clean_weights}
    return {basin_id: total * weight / weight_total for basin_id, weight in clean_weights.items()}


def load_power_daily_rows(path: Path) -> list[dict[str, str]]:
    """Read NASA POWER CSVs, skipping the descriptive header block."""
    with path.open("r", newline="", encoding="utf-8") as handle:
        for line in handle:
            if line.strip() == "-END HEADER-":
                break
        return list(csv.DictReader(handle))


def load_power_annual_grid(variable: str) -> dict[tuple[float, float], dict[str, float | int]]:
    path = RAW_DIR / "climate" / f"nasa_power_{variable.lower()}_2022_daily_bbox.csv"
    if not path.exists():
        raise BakeBlocked("zonal", [path], f"Need NASA POWER {variable} daily CSV for climate zonal summary.")
    grouped: dict[tuple[float, float], dict[str, float | int]] = {}
    for row in load_power_daily_rows(path):
        value = float(row[variable])
        if value <= -900:
            continue
        key = (float(row["LAT"]), float(row["LON"]))
        bucket = grouped.setdefault(key, {"sum": 0.0, "count": 0})
        bucket["sum"] = float(bucket["sum"]) + value
        bucket["count"] = int(bucket["count"]) + 1
    return grouped


def bbox_centroid(bbox: list[float]) -> tuple[float, float]:
    return ((bbox[1] + bbox[3]) / 2, (bbox[0] + bbox[2]) / 2)


def annual_grid_value(
    grid: dict[tuple[float, float], dict[str, float | int]], bbox: list[float], reducer: str
) -> tuple[float, int, str]:
    selected = [
        values
        for (lat, lon), values in grid.items()
        if bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]
    ]
    method = "power_points_inside_subbasin_bbox"
    if not selected:
        center_lat, center_lon = bbox_centroid(bbox)
        nearest_key = min(grid, key=lambda key: (key[0] - center_lat) ** 2 + (key[1] - center_lon) ** 2)
        selected = [grid[nearest_key]]
        method = "nearest_power_point_to_subbasin_bbox_centroid"

    if reducer == "sum":
        values = [float(item["sum"]) for item in selected]
    elif reducer == "mean":
        values = [float(item["sum"]) / max(1, int(item["count"])) for item in selected]
    else:
        raise ValueError(f"unsupported reducer: {reducer}")
    return round(sum(values) / len(values), 3), len(selected), method


def load_subbasin_features() -> list[dict[str, object]]:
    path = INTERMEDIATE_DIR / "subbasins_raw.geojson"
    if not path.exists():
        raise BakeBlocked("zonal", [path], "Run the real subbasins step before zonal statistics.")
    payload = json.loads(path.read_text(encoding="utf-8"))
    features = payload.get("features")
    if not isinstance(features, list):
        raise BakeBlocked("zonal", [path], "Subbasins GeoJSON does not contain a feature list.")
    return features


def normalize_subbasin_gdf(gdf):
    """Keep downstream audit code source-neutral across old and current basin sources."""
    gdf = gdf.copy()
    if "sourceBasinId" not in gdf.columns:
        if "pfafId" in gdf.columns:
            gdf["sourceBasinId"] = gdf["pfafId"]
        elif "hybasId" in gdf.columns:
            gdf["sourceBasinId"] = gdf["hybasId"]
        else:
            gdf["sourceBasinId"] = gdf["id"]
    if "pfafId" not in gdf.columns:
        gdf["pfafId"] = None
    if "hybasId" not in gdf.columns:
        gdf["hybasId"] = None
    if "subAreaKm2" not in gdf.columns:
        if "clipAreaKm2" in gdf.columns:
            gdf["subAreaKm2"] = gdf["clipAreaKm2"]
        else:
            gdf["subAreaKm2"] = None
    if "fallback" not in gdf.columns:
        gdf["fallback"] = False
    return gdf


def compute_landpop_partial(climate_rows: list[dict[str, object]]) -> tuple[Path, dict[str, object]]:
    """Compute honest non-VIIRS raster partials with the optional GIS stack."""
    import geopandas as gpd
    import rasterio
    from shapely.geometry import box
    from rasterstats import zonal_stats

    subbasins_path = INTERMEDIATE_DIR / "subbasins_raw.geojson"
    clcd_path = RAW_DIR / "clcd" / "CLCD_v01_2022_albert.tif"
    worldpop_path = RAW_DIR / "worldpop" / "chn_pop_2022_CN_100m_R2025A_v1.tif"
    worldcover_paths = sorted((RAW_DIR / "worldcover").glob("*.tif"))
    missing = [path for path in [subbasins_path, clcd_path, worldpop_path] if not path.exists()]
    if not worldcover_paths:
        missing.append(RAW_DIR / "worldcover")
    if missing:
        raise BakeBlocked("zonal", missing, "Need CLCD, WorldCover, WorldPop, and subbasins for land/pop zonal partial.")

    def raster_audit(path: Path) -> dict[str, object]:
        with rasterio.open(path) as src:
            return {
                "path": rel(path),
                "crs": str(src.crs),
                "bounds": [round(value, 8) for value in src.bounds],
                "resolution": [src.res[0], src.res[1]],
                "nodata": src.nodata,
                "dtype": src.dtypes[0],
                "bandCount": src.count,
            }

    gdf = gpd.read_file(subbasins_path)
    if gdf.crs is None:
        gdf = gdf.set_crs("EPSG:4326")
    gdf = normalize_subbasin_gdf(gdf)
    gdf = gdf.sort_values("id").reset_index(drop=True)
    climate_by_id = {str(row["id"]): row for row in climate_rows}
    all_touched = False

    with rasterio.open(clcd_path) as src:
        clcd_pixel_area_ha = abs(src.res[0] * src.res[1]) / 10_000
        clcd_stats = zonal_stats(
            gdf.to_crs(src.crs).geometry,
            clcd_path,
            categorical=True,
            nodata=src.nodata,
            all_touched=all_touched,
        )

    worldcover_stats = [dict() for _ in range(len(gdf))]
    worldcover_tile_boxes = []
    for tile_path in worldcover_paths:
        with rasterio.open(tile_path) as src:
            worldcover_tile_boxes.append((tile_path.name, box(*src.bounds)))
        tile_stats = zonal_stats(gdf.geometry, tile_path, categorical=True, nodata=0, all_touched=all_touched)
        for index, stats in enumerate(tile_stats):
            for key, value in stats.items():
                category = int(key)
                worldcover_stats[index][category] = worldcover_stats[index].get(category, 0) + int(value)

    with rasterio.open(worldpop_path) as src:
        worldpop_stats = zonal_stats(
            gdf.geometry,
            worldpop_path,
            stats=["sum", "count"],
            nodata=src.nodata,
            all_touched=all_touched,
        )

    worldcover_union = gpd.GeoSeries([tile_box for _, tile_box in worldcover_tile_boxes], crs="EPSG:4326").union_all()

    rows: list[dict[str, object]] = []
    for index, feature in gdf.iterrows():
        basin_id = str(feature["id"])
        climate = climate_by_id.get(basin_id, {})
        clcd_counts = {int(key): int(value) for key, value in clcd_stats[index].items()}
        wc_counts = {int(key): int(value) for key, value in worldcover_stats[index].items()}
        wp = worldpop_stats[index]
        clcd_cropland_pixels = clcd_counts.get(1, 0)
        clcd_builtup_pixels = clcd_counts.get(8, 0)
        wc_cropland_pixels = wc_counts.get(40, 0)
        wc_builtup_pixels = wc_counts.get(50, 0)
        clcd_valid_pixels = sum(clcd_counts.values())
        worldcover_valid_pixels = sum(wc_counts.values())
        used_worldcover_tiles = [
            tile_name for tile_name, tile_box in worldcover_tile_boxes if feature.geometry.intersects(tile_box)
        ]
        missing_worldcover_geometry = feature.geometry.difference(worldcover_union)
        missing_worldcover_area_km2 = 0.0
        if not missing_worldcover_geometry.is_empty:
            missing_worldcover_area_km2 = (
                gpd.GeoSeries([missing_worldcover_geometry], crs="EPSG:4326").to_crs("EPSG:6933").area.iloc[0]
                / 1_000_000
            )
        rows.append(
            {
                "id": basin_id,
                "hybas_id": feature.get("hybasId"),
                "pfaf_id": feature.get("pfafId"),
                "source_basin_id": feature.get("sourceBasinId"),
                "level": feature.get("level"),
                "sub_area_km2": feature.get("subAreaKm2"),
                "fallback": feature.get("fallback"),
                "selection_method": feature.get("selectionMethod"),
                "geometry_crs_assumed": "EPSG:4326",
                "all_touched": all_touched,
                "worldcover_tiles_used": "|".join(used_worldcover_tiles),
                "worldcover_missing_area_km2": round(missing_worldcover_area_km2, 3),
                "clcd_cropland_ha": round(clcd_cropland_pixels * clcd_pixel_area_ha, 3),
                "clcd_builtup_ha": round(clcd_builtup_pixels * clcd_pixel_area_ha, 3),
                "clcd_valid_pixels": clcd_valid_pixels,
                "clcd_cropland_share": round(clcd_cropland_pixels / clcd_valid_pixels, 6)
                if clcd_valid_pixels
                else 0,
                "clcd_builtup_share": round(clcd_builtup_pixels / clcd_valid_pixels, 6)
                if clcd_valid_pixels
                else 0,
                "worldcover_cropland_ha_nominal": round(wc_cropland_pixels * 0.01, 3),
                "worldcover_builtup_ha_nominal": round(wc_builtup_pixels * 0.01, 3),
                "worldcover_valid_pixels": worldcover_valid_pixels,
                "worldcover_cropland_share": round(wc_cropland_pixels / worldcover_valid_pixels, 6)
                if worldcover_valid_pixels
                else 0,
                "worldcover_builtup_share": round(wc_builtup_pixels / worldcover_valid_pixels, 6)
                if worldcover_valid_pixels
                else 0,
                "worldpop_population": round(float(wp.get("sum") or 0), 3),
                "worldpop_valid_cells": int(wp.get("count") or 0),
                "precip_mm": climate.get("precip_mm"),
                "evptrns_mj_m2_proxy": climate.get("evptrns_mj_m2_proxy"),
                "t2m_c_mean": climate.get("t2m_c_mean"),
                "ind_weight_status": "missing_viirs",
                "formal_zonal_ready": False,
                "method": "rasterstats_polygon_zonal_partial_no_viirs",
            }
        )

    path = INTERMEDIATE_DIR / "zonal_landpop.csv"
    write_csv(path, rows)
    metadata = {
        "output": rel(path),
        "rowCount": len(rows),
        "sources": {
            "clcd": rel(clcd_path),
            "worldcover": [rel(path) for path in worldcover_paths],
            "worldpop": rel(worldpop_path),
        },
        "rasterAudit": {
            "clcd": raster_audit(clcd_path),
            "worldcover": [raster_audit(path) for path in worldcover_paths],
            "worldpop": raster_audit(worldpop_path),
        },
        "sourceWarnings": [
            "WorldPop file is the public R2025A constrained alpha release for China 2022; provenance must preserve this source/version caveat.",
            "WorldCover is a 2021 v200 land-cover cross-check for a 2022 calibration workflow.",
        ],
        "classes": {
            "clcdCropland": 1,
            "clcdBuiltupImpervious": 8,
            "worldcoverCropland": 40,
            "worldcoverBuiltup": 50,
        },
        "totals": {
            "clcdCroplandHa": round(sum(float(row["clcd_cropland_ha"]) for row in rows), 3),
            "clcdBuiltupHa": round(sum(float(row["clcd_builtup_ha"]) for row in rows), 3),
            "worldcoverCroplandHaNominal": round(sum(float(row["worldcover_cropland_ha_nominal"]) for row in rows), 3),
            "worldcoverBuiltupHaNominal": round(sum(float(row["worldcover_builtup_ha_nominal"]) for row in rows), 3),
            "worldpopPopulation": round(sum(float(row["worldpop_population"]) for row in rows), 3),
        },
        "pixelArea": {
            "clcdHa": clcd_pixel_area_ha,
            "worldcoverHaNominal": 0.01,
        },
        "geometryCrsAssumed": "EPSG:4326",
        "allTouched": all_touched,
        "worldcoverMissingAreaKm2": round(sum(float(row["worldcover_missing_area_km2"]) for row in rows), 3),
        "method": "rasterstats categorical/sum zonal statistics on AOI-clipped Pfafstetter level_6 polygons; CLCD geometries reprojected to the raster Albers CRS.",
        "limitations": [
            "This is a land/population zonal product for the project-approved Pfafstetter level_6 AOI-clipped subbasins.",
            "The Pfafstetter vector source is project-provided and upstream provenance is not independently verified; methodology and final metadata must disclose this limitation.",
            "WorldCover area uses nominal 10 m pixel area for cross-checking, not geodesic per-pixel area.",
        ],
    }
    return path, metadata


def compute_wb_len_nightlight_partial() -> tuple[Path, dict[str, object]]:
    """Create the approved WB LEN annual nightlight proxy with adjacent-month interpolation."""
    import geopandas as gpd
    import numpy as np
    import rasterio
    from rasterstats import zonal_stats

    expected_months = [f"2022{month:02d}" for month in range(1, 13)]
    avg_paths = {path.name.split("_")[2]: path for path in sorted((RAW_DIR / "viirs").glob("wb_len_*_bbox_avg_rade9.tif"))}
    ncf_paths = {path.name.split("_")[2]: path for path in sorted((RAW_DIR / "viirs").glob("wb_len_*_bbox_n_cf.tif"))}
    months = sorted(set(avg_paths) & set(ncf_paths))
    if not months:
        raise BakeBlocked(
            "zonal",
            [RAW_DIR / "viirs"],
            "Need World Bank Light Every Night avg_rade9 and n_cf BBox clips before nightlight draft.",
        )

    def read_month_arrays(month: str) -> tuple[object, object, dict[str, object], Path, Path]:
        avg_path = avg_paths[month]
        ncf_path = ncf_paths[month]
        with rasterio.open(avg_path) as avg_src, rasterio.open(ncf_path) as ncf_src:
            avg = avg_src.read(1, masked=True).astype("float64")
            ncf = ncf_src.read(1, masked=True).astype("float64")
            if avg.shape != ncf.shape or avg_src.transform != ncf_src.transform:
                raise BakeBlocked("zonal", [avg_path, ncf_path], f"WB LEN avg/n_cf grid mismatch for {month}.")
            profile = avg_src.profile.copy()
        radiance = np.maximum(avg.filled(0.0), 0.0)
        counts = np.maximum(ncf.filled(0.0), 0.0)
        return radiance, counts, profile, avg_path, ncf_path

    observed_months = months[:]
    interpolated_months: dict[str, dict[str, str]] = {
        "202206": {"previous": "202205", "next": "202207"},
        "202208": {"previous": "202207", "next": "202209"},
    }
    month_arrays: dict[str, dict[str, object]] = {}
    first_profile = None
    for month in observed_months:
        radiance, counts, profile, avg_path, ncf_path = read_month_arrays(month)
        first_profile = profile if first_profile is None else first_profile
        month_arrays[month] = {
            "radiance": radiance,
            "counts": counts,
            "profile": profile,
            "status": "observed",
            "avgPath": rel(avg_path),
            "nCfPath": rel(ncf_path),
        }

    interpolation_outputs = []
    for month, sources in interpolated_months.items():
        if month in month_arrays:
            continue
        previous = month_arrays.get(sources["previous"])
        following = month_arrays.get(sources["next"])
        if previous is None or following is None:
            raise BakeBlocked(
                "zonal",
                [f"WB LEN interpolation {month}: {sources['previous']} and {sources['next']}"],
                "Need adjacent observed months before interpolating missing WB LEN month.",
            )
        radiance = (previous["radiance"] + following["radiance"]) / 2.0
        counts = (previous["counts"] + following["counts"]) / 2.0
        profile = dict(previous["profile"])
        profile.update(dtype="float32", count=1, nodata=None, compress="DEFLATE", tiled=True)
        avg_interp_path = INTERMEDIATE_DIR / f"wb_len_{month}_bbox_avg_rade9_interpolated.tif"
        ncf_interp_path = INTERMEDIATE_DIR / f"wb_len_{month}_bbox_n_cf_interpolated.tif"
        for output_path, array in [(avg_interp_path, radiance), (ncf_interp_path, counts)]:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            with rasterio.open(output_path, "w", **profile) as dst:
                dst.write(array.astype("float32"), 1)
        month_arrays[month] = {
            "radiance": radiance,
            "counts": counts,
            "profile": profile,
            "status": "interpolated_adjacent_month_midpoint",
            "avgPath": rel(avg_interp_path),
            "nCfPath": rel(ncf_interp_path),
            "interpolationSources": sources,
        }
        interpolation_outputs.append(
            {
                "month": month,
                "avgPath": rel(avg_interp_path),
                "nCfPath": rel(ncf_interp_path),
                "previousMonth": sources["previous"],
                "nextMonth": sources["next"],
                "method": "pixelwise midpoint of adjacent observed WB LEN monthly clips",
            }
        )

    missing_after_interpolation = [month for month in expected_months if month not in month_arrays]
    if missing_after_interpolation:
        raise BakeBlocked(
            "zonal",
            [f"WB LEN missing after interpolation: {month}" for month in missing_after_interpolation],
            "All 12 WB LEN months must be observed or interpolated before approved formal fallback zonal output.",
        )

    numerator = None
    denominator = None
    profile = None
    month_summaries = []
    for month in expected_months:
        item = month_arrays[month]
        radiance = item["radiance"]
        counts = item["counts"]
        numerator = radiance * counts if numerator is None else numerator + radiance * counts
        denominator = counts if denominator is None else denominator + counts
        if profile is None:
            profile = dict(item["profile"])
        month_summaries.append(
            {
                "month": month,
                "status": item["status"],
                "avgPath": item["avgPath"],
                "nCfPath": item["nCfPath"],
                "interpolationSources": item.get("interpolationSources"),
                "meanRadiance": round(float(radiance.mean()), 6),
                "meanNCf": round(float(counts.mean()), 6),
                "maxNCf": round(float(counts.max()), 6),
            }
        )

    assert numerator is not None and denominator is not None and profile is not None
    annual = np.divide(numerator, denominator, out=np.zeros_like(numerator, dtype="float64"), where=denominator > 0)
    annual = np.maximum(annual, 0.0).astype("float32")
    annual_path = INTERMEDIATE_DIR / "viirs_wb_len_2022_bbox_weighted_avg_rade9.tif"
    profile.update(dtype="float32", count=1, nodata=None, compress="DEFLATE", tiled=True)
    annual_path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(annual_path, "w", **profile) as dst:
        dst.write(annual, 1)

    subbasins_path = INTERMEDIATE_DIR / "subbasins_raw.geojson"
    landpop_path = INTERMEDIATE_DIR / "zonal_landpop.csv"
    gdf = gpd.read_file(subbasins_path)
    if gdf.crs is None:
        gdf = gdf.set_crs("EPSG:4326")
    gdf = gdf.sort_values("id").reset_index(drop=True)
    stats = zonal_stats(gdf.geometry, annual_path, stats=["mean", "max", "sum", "count"], all_touched=False)
    landpop_by_id = {row["id"]: row for row in load_csv_rows(landpop_path)}
    rows = []
    for index, feature in gdf.iterrows():
        basin_id = str(feature["id"])
        landpop = landpop_by_id.get(basin_id, {})
        stat = stats[index]
        mean_radiance = max(0.0, float(stat.get("mean") or 0.0))
        clcd_builtup = float(landpop.get("clcd_builtup_ha", 0) or 0)
        worldcover_builtup = float(landpop.get("worldcover_builtup_ha_nominal", 0) or 0)
        builtup_mean_ha = (clcd_builtup + worldcover_builtup) / 2
        rows.append(
            {
                "id": basin_id,
                "wb_len_mean_radiance": round(mean_radiance, 9),
                "wb_len_max_radiance": round(max(0.0, float(stat.get("max") or 0.0)), 9),
                "wb_len_sum_radiance": round(max(0.0, float(stat.get("sum") or 0.0)), 9),
                "wb_len_pixel_count": int(stat.get("count") or 0),
                "clcd_builtup_ha": round(clcd_builtup, 6),
                "worldcover_builtup_ha_nominal": round(worldcover_builtup, 6),
                "builtup_mean_ha": round(builtup_mean_ha, 6),
                "ind_weight_wb_len": round(builtup_mean_ha * mean_radiance, 9),
                "ind_weight_status": "approved_wb_len_12month_interpolated_formal_fallback",
                "months_used": "|".join(expected_months),
                "observed_months": "|".join(observed_months),
                "interpolated_months": "|".join(sorted(interpolated_months)),
                "missing_months": "",
                "method": "world_bank_light_every_night_ncf_weighted_12month_mean_with_adjacent_month_interpolation_x_builtup",
            }
        )

    output_path = INTERMEDIATE_DIR / "zonal_nightlight_draft.csv"
    write_csv(output_path, rows)
    missing_months = [month for month in expected_months if month not in observed_months]
    metadata = {
        "output": rel(output_path),
        "annualRaster": rel(annual_path),
        "rowCount": len(rows),
        "source": {
            "provider": "World Bank / AWS Light Every Night",
            "registry": "https://registry.opendata.aws/wb-light-every-night/",
            "bucket": "s3://globalnightlight/",
            "product": "NPP 2022 monthly global ecm-slcorr avg_rade9 and n_cf COGs",
            "unit": "nanowatts/cm^2/sr radiance",
            "formalUseStatement": "Industrial water downscaling uses World Bank Light Every Night nightlight proxy; EOG Annual VNL was not used; missing months are interpolated from adjacent observed months.",
        },
        "monthsUsed": expected_months,
        "observedMonths": observed_months,
        "interpolatedMonths": sorted(interpolated_months),
        "interpolationOutputs": interpolation_outputs,
        "missingMonthsBeforeInterpolation": missing_months,
        "missingMonthsAfterInterpolation": missing_after_interpolation,
        "monthSummaries": month_summaries,
        "checks": {
            "clipCountAvgRade9": len(avg_paths),
            "clipCountNCf": len(ncf_paths),
            "observedMonthCount": len(observed_months),
            "interpolatedMonthCount": len(interpolated_months),
            "weightedPixelsWithObservations": int((denominator > 0).sum()),
            "annualMeanRadiance": round(float(annual.mean()), 9),
            "annualMaxRadiance": round(float(annual.max()), 9),
            "indWeightTotal": round(sum(float(row["ind_weight_wb_len"]) for row in rows), 9),
        },
        "nightlightProxyReady": True,
        "industrialWeightDraftReady": True,
        "industrialProxyApprovedForFullBake": True,
        "worldBankLenProxyApprovedForFullBake": True,
        "preferredViirsReady": False,
        "eogAnnualVnlReady": False,
        "formalOutputWritten": False,
        "rasterStatsReady": False,
        "fullBakeReady": False,
        "mustNotSatisfyFullBake": True,
        "limitations": [
            "Approved fallback nightlight proxy from 10 observed 2022 monthly composites plus adjacent-month interpolation for 202206 and 202208.",
            "This is not the EOG Annual VNL product originally specified in the work order.",
            "Industrial weight is mean subbasin radiance times mean built-up area, not a pixel-level built-up masked radiance sum.",
            "Interpolated rasters are written under intermediate/ and must not be represented as raw downloaded source files.",
        ],
    }
    return output_path, metadata


SOURCE_INFO_BY_CATEGORY = {
    "clcd": {
        "sourceUrl": "https://zenodo.org/records/18180184",
        "license": "CC BY 4.0 per Zenodo record",
        "processingStep": "T1.3 zonal land cover",
    },
    "worldcover": {
        "sourceUrl": "https://esa-worldcover.org/en/data-access",
        "license": "CC BY 4.0",
        "processingStep": "T1.3 WorldCover cross-check",
    },
    "worldpop": {
        "sourceUrl": "https://hub.worldpop.org/geodata/summary?id=72924",
        "license": "CC BY 4.0",
        "processingStep": "T1.3 population zonal sum",
    },
    "viirs": {
        "sourceUrl": "https://registry.opendata.aws/wb-light-every-night/",
        "license": "World Bank Light Every Night public AWS open-data access; underlying VIIRS-DNB from NOAA/NCEI",
        "processingStep": "T1.3 approved WB LEN nightlight industrial proxy with adjacent-month interpolation",
    },
    "merit": {
        "sourceUrl": "local:project-provided/Basin_Asia.gdb.zip",
        "license": "upstream license not independently verified; disclose before publication",
        "processingStep": "T1.2 approved Pfafstetter level_6 vector subbasin clipping and Down_ID topology",
    },
    "gadm": {
        "sourceUrl": "https://gadm.org/download_country.html",
        "license": "GADM license terms apply",
        "processingStep": "T1.1 AOI",
    },
    "hydrosheds": {
        "sourceUrl": "https://www.hydrosheds.org/",
        "license": "HydroSHEDS terms",
        "processingStep": "T1.2 subbasins/topology fallback",
    },
    "climate": {
        "sourceUrl": "https://power.larc.nasa.gov/docs/services/api/temporal/daily/",
        "license": "NASA POWER public data terms",
        "processingStep": "T1.3/T1.5 climate fallback",
    },
    "bulletin": {
        "sourceUrl": "http://slt.hubei.gov.cn/bsfw/cxfw/szygb/202307/P020230720530853000978.pdf",
        "license": "Public Hubei Water Resources Bulletin",
        "processingStep": "T1.4 demand calibration",
    },
}


def step_bulletin_draft(_: argparse.Namespace) -> list[Path]:
    ensure_dirs()
    pdf_path = RAW_DIR / "bulletin" / "hubei_water_resources_bulletin_2022.pdf"
    page_index = 15
    text = extract_bulletin_page_text(pdf_path, page_index)
    rows = parse_bulletin_table12_rows(text)
    target_total = append_bulletin_target_total(rows)

    output_path = INTERMEDIATE_DIR / "bulletin_table12_draft.csv"
    metadata_path = INTERMEDIATE_DIR / "bulletin_table12_draft_metadata.json"
    write_csv(output_path, rows)
    metadata = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "step": "bulletin-draft",
        "output": rel(output_path),
        "sourcePdf": rel(pdf_path),
        "sourcePdfSha256": sha256_file(pdf_path),
        "sourcePageIndex": page_index,
        "sourcePageNumber": 16,
        "sourceTable": "表12 2022年湖北省各市州用水量",
        "unit": "亿立方米",
        "rowCount": len(rows),
        "targetCityCount": len(BULLETIN_TARGET_CITIES),
        "targetTotals": {column: target_total[column] for column in BULLETIN_TABLE12_COLUMNS},
        "consistencyChecks": {
            "rowBoundary": "each target city is parsed only until the next table-12 row label",
            "rowTotals": "old and new caliber component sums must match the row total",
            "targetTotal": "Wuhan 1+8 component sums must match the summed total",
            "tolerance": BULLETIN_TABLE12_TOTAL_TOLERANCE,
        },
        "draft": True,
        "needsHumanReview": True,
        "formalOutputWritten": False,
        "demandReady": False,
        "mustNotSatisfyFullBake": True,
        "limitations": [
            "This is a machine-extracted audit draft from the bulletin PDF text layer, not formal demand.csv.",
            "Table 12 mixes old-caliber, new-caliber, total, comparison, and assessment-caliber values; downstream demand/calibration must choose the correct caliber explicitly.",
            "Industrial subbasin downscaling still needs explicit approval of the World Bank Light Every Night draft or another documented fallback.",
            "This draft must not set demandReady or unlock supply/health/bake/provenance gates.",
        ],
    }
    write_json(metadata_path, metadata)
    print(f"REAL-DRAFT wrote {rel(output_path)}")
    print(f"REAL-DRAFT wrote {rel(metadata_path)}")
    print(
        "Wuhan 1+8 bulletin table 12 totals: "
        f"old industry={target_total['old_industry']}, old agri={target_total['old_agri']}, "
        f"old life={target_total['old_life']}, total={target_total['total']}, "
        f"assessment={target_total['assessment_total']} 亿立方米"
    )
    print("DRAFT ONLY: demand.csv and demandReady remain locked pending formal zonal and industrial-proxy approval.")
    return [output_path, metadata_path]


def step_mainstem_inflow_draft(_: argparse.Namespace) -> list[Path]:
    ensure_dirs()
    pdf_path = RAW_DIR / "bulletin" / "hubei_water_resources_bulletin_2022.pdf"
    page_indices = [7, 8]
    text = "\n".join(extract_bulletin_page_text(pdf_path, page_index) for page_index in page_indices)
    rows, checks = parse_bulletin_table5_mainstem_rows(text)
    flow_ids = {str(row["flow_id"]) for row in rows}
    missing_parent_flow_ids = sorted(
        {
            str(row["parent_flow_id"])
            for row in rows
            if str(row.get("parent_flow_id", "")).strip()
            and str(row.get("parent_flow_id", "")).strip() not in flow_ids
        }
    )
    if missing_parent_flow_ids:
        raise BakeBlocked(
            "mainstem-inflow-draft",
            [f"missing parent flow_id: {flow_id}" for flow_id in missing_parent_flow_ids],
            "Mainstem inflow draft parent_flow_id values must resolve to existing flow_id values.",
        )

    output_path = INTERMEDIATE_DIR / "mainstem_inflow_draft.csv"
    metadata_path = INTERMEDIATE_DIR / "mainstem_inflow_draft_metadata.json"
    write_csv(output_path, rows)
    metadata = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "step": "mainstem-inflow-draft",
        "output": rel(output_path),
        "sourcePdf": rel(pdf_path),
        "sourcePdfSha256": sha256_file(pdf_path),
        "sourcePageIndices": page_indices,
        "sourcePageNumbers": [8, 9],
        "sourceTable": "表5 2022年湖北省入出境水量",
        "unit": "亿立方米",
        "rowCount": len(rows),
        "spatialScope": "Hubei provincial boundary inflow, not Wuhan 1+8 AOI/subbasin inflow",
        "allowedUse": "audit, reconciliation, and calibration candidate only",
        "aggregateRows": {
            "han_system_entry": "Derived from Han-system child rows; do not sum together with child rows.",
            "minor_five_rivers_entry": "Derived from five small-river child rows; do not sum together with child rows.",
            "province_total": "Table total; do not sum together with component rows.",
        },
        "checks": checks,
        "parentFlowIdsResolve": True,
        "draft": True,
        "auditOnly": True,
        "needsHumanReview": True,
        "formalOutputWritten": False,
        "mainstemInflowDraftReady": True,
        "mainstemInjectionReady": False,
        "spatialInjectionAssigned": False,
        "supplyReady": False,
        "fullBakeReady": False,
        "mustNotSatisfyFullBake": True,
        "candidateFormalUse": {
            "yangtzeMainstemEntry1e8M3": checks["yangtzeMainstem1e8M3"],
            "hanSystemEntry1e8M3": checks["hanSystem1e8M3"],
            "hanMainstemEntry1e8M3": checks["hanMainstem1e8M3"],
        },
        "limitations": [
            "Audit-only T1.5 support draft: values are Hubei provincial-boundary inflows, not Wuhan 1+8 AOI inflows.",
            "No candidate injection subbasin is assigned; mainstemInjectionReady remains false.",
            "Does not write intermediate/supply.csv and does not set supplyReady.",
            "Formal supply still needs real demand metadata, final-approved subbasins, mainstem reach tagging, and an approved spatial injection rule.",
        ],
    }
    write_json(metadata_path, metadata)
    print(f"REAL-DRAFT wrote {rel(output_path)}")
    print(f"REAL-DRAFT wrote {rel(metadata_path)}")
    print(
        "Mainstem inflow draft: "
        f"Yangtze={checks['yangtzeMainstem1e8M3']} 亿 m3, "
        f"Han-system={checks['hanSystem1e8M3']} 亿 m3, "
        f"Han-mainstem={checks['hanMainstem1e8M3']} 亿 m3"
    )
    print("DRAFT ONLY: supply.csv and mainstemInjectionReady remain locked pending spatial injection approval.")
    return [output_path, metadata_path]


def step_mainstem_node_mapping_draft(_: argparse.Namespace) -> list[Path]:
    ensure_dirs()
    try:
        import geopandas as gpd
    except ModuleNotFoundError as exc:
        raise BakeBlocked(
            "mainstem-node-mapping-draft",
            ["geopandas in .venv-bake"],
            "Need geopandas to intersect HydroRIVERS with the current subbasin polygons for mapping candidates.",
        ) from exc

    subbasins_path = INTERMEDIATE_DIR / "subbasins_raw.geojson"
    topology_path = INTERMEDIATE_DIR / "topology.json"
    inflow_path = INTERMEDIATE_DIR / "mainstem_inflow_draft.csv"
    inflow_metadata_path = INTERMEDIATE_DIR / "mainstem_inflow_draft_metadata.json"
    rivers_zip = RAW_DIR / "hydrosheds" / "HydroRIVERS_v10_as_shp.zip"
    for path in [subbasins_path, topology_path, inflow_path, inflow_metadata_path, rivers_zip]:
        if not path.exists():
            raise BakeBlocked(
                "mainstem-node-mapping-draft",
                [path],
                "Need subbasins, topology, mainstem inflow draft, and HydroRIVERS before node mapping draft.",
            )

    inflow_metadata = read_metadata(inflow_metadata_path)
    if inflow_metadata.get("mainstemInjectionReady") is True or inflow_metadata.get("supplyReady") is True:
        raise BakeBlocked(
            "mainstem-node-mapping-draft",
            [inflow_metadata_path],
            "Mainstem inflow source draft should remain audit-only before node mapping review.",
        )

    topology = read_topology(required=True, step="mainstem-node-mapping-draft")

    def route_to_outlet(start: str) -> str:
        seen = set()
        route = [start]
        current = start
        while current in topology and current not in seen:
            seen.add(current)
            downstream = topology[current]
            route.append(downstream)
            if downstream == "OUTLET":
                break
            current = downstream
        return "|".join(route)

    subbasins = gpd.read_file(subbasins_path)
    if subbasins.crs is None:
        subbasins = subbasins.set_crs("EPSG:4326")
    subbasins = normalize_subbasin_gdf(subbasins)
    subbasins = subbasins.sort_values("id").reset_index(drop=True)
    subbasin_by_id = {str(row["id"]): row for _, row in subbasins.iterrows()}
    bounds = tuple(float(value) for value in subbasins.total_bounds)
    rivers_uri = f"zip://{rivers_zip.resolve()}!HydroRIVERS_v10_as_shp/HydroRIVERS_v10_as.shp"
    rivers = gpd.read_file(rivers_uri, bbox=bounds)
    if rivers.crs is None:
        rivers = rivers.set_crs("EPSG:4326")

    projection = "EPSG:6933"
    subbasins_proj = subbasins[
        ["id", "sourceBasinId", "pfafId", "hybasId", "downstream", "subAreaKm2", "fallback", "geometry"]
    ].to_crs(projection)
    rivers_proj = rivers[
        [
            "HYRIV_ID",
            "NEXT_DOWN",
            "MAIN_RIV",
            "LENGTH_KM",
            "DIST_DN_KM",
            "DIST_UP_KM",
            "CATCH_SKM",
            "UPLAND_SKM",
            "DIS_AV_CMS",
            "ORD_STRA",
            "ORD_CLAS",
            "ORD_FLOW",
            "geometry",
        ]
    ].to_crs(projection)
    sub_geom_by_id = {str(row["id"]): row.geometry for _, row in subbasins_proj.iterrows()}

    filter_specs = {
        "yangtze_mainstem_entry": {
            "name": "hydrorivers_high_discharge_yangtze_like",
            "description": "HydroRIVERS segments with DIS_AV_CMS >= 10000, intended only as Yangtze-like high-discharge geometry candidates.",
            "mask": (rivers_proj["DIS_AV_CMS"] >= 10000),
            "maxCandidates": 5,
        },
        "han_mainstem_entry": {
            "name": "hydrorivers_mid_discharge_han_like",
            "description": "HydroRIVERS segments with 500 <= DIS_AV_CMS < 10000 and ORD_STRA >= 6, intended only as Han-like mid-discharge geometry candidates.",
            "mask": ((rivers_proj["DIS_AV_CMS"] >= 500) & (rivers_proj["DIS_AV_CMS"] < 10000) & (rivers_proj["ORD_STRA"] >= 6)),
            "maxCandidates": 5,
        },
        "han_system_entry": {
            "name": "hydrorivers_mid_discharge_han_system_like",
            "description": "Same geometry proxy as han_mainstem_entry; aggregate row must not be summed with its child rows.",
            "mask": ((rivers_proj["DIS_AV_CMS"] >= 500) & (rivers_proj["DIS_AV_CMS"] < 10000) & (rivers_proj["ORD_STRA"] >= 6)),
            "maxCandidates": 5,
        },
        "minor_five_rivers_entry": {
            "name": "not_mapped_group_aggregate",
            "description": "Group aggregate from bulletin table 5; no named-to-geometry mapping is attempted in this draft.",
            "mask": None,
            "maxCandidates": 1,
        },
    }
    min_intersection_length_km = 5.0

    inflow_rows = {row["flow_id"]: row for row in load_csv_rows(inflow_path)}
    target_flow_ids = ["yangtze_mainstem_entry", "han_system_entry", "han_mainstem_entry", "minor_five_rivers_entry"]
    rows: list[dict[str, object]] = []
    filter_audit: dict[str, object] = {}

    for source_flow_id in target_flow_ids:
        source = inflow_rows.get(source_flow_id)
        if source is None:
            raise BakeBlocked(
                "mainstem-node-mapping-draft",
                [f"{rel(inflow_path)}:{source_flow_id}"],
                "Need expected source flow rows from mainstem inflow draft before node mapping.",
            )
        source_is_aggregate = source.get("is_aggregate") == "True"
        source_do_not_sum_with_children = source.get("do_not_sum_with_children") == "True"
        spec = filter_specs[source_flow_id]
        if spec["mask"] is None:
            rows.append(
                {
                    "id": f"MS_NODEMAP_{source_flow_id.upper()}_NO_GEOMETRY",
                    "source_flow_id": source_flow_id,
                    "source_label": source["label"],
                    "source_component": source["component"],
                    "source_value_100million_m3": source["value_100million_m3"],
                    "source_is_aggregate": source_is_aggregate,
                    "source_do_not_sum_with_children": source_do_not_sum_with_children,
                    "candidate_rank": "",
                    "candidate_subbasin_id": "",
                    "candidate_source_basin_id": "",
                    "candidate_pfaf_id": "",
                    "candidate_hybas_id": "",
                    "candidate_downstream": "",
                    "route_to_outlet": "",
                    "river_filter": spec["name"],
                    "river_filter_description": spec["description"],
                    "hydrorivers_segment_count": 0,
                    "intersection_length_km": 0,
                    "max_dis_av_cms": "",
                    "mean_dis_av_cms": "",
                    "max_ord_stra": "",
                    "main_riv_ids": "",
                    "candidate_centroid_lon": "",
                    "candidate_centroid_lat": "",
                    "mapping_status": "not_attempted_group_aggregate",
                    "candidate_confidence": "none",
                    "injection_ready": False,
                    "mainstem_injection_ready": False,
                    "formal_use_approved": False,
                    "draft": True,
                    "method": "audit_only_no_named_minor_river_mapping",
                    "limitations": "Aggregate group; do not assign or inject without a separate named river mapping.",
                }
            )
            continue

        selected_rivers = rivers_proj[spec["mask"]].copy()
        filter_audit[source_flow_id] = {
            "filter": spec["name"],
            "description": spec["description"],
            "segmentCount": int(len(selected_rivers)),
        }
        if selected_rivers.empty:
            rows.append(
                {
                    "id": f"MS_NODEMAP_{source_flow_id.upper()}_NO_CANDIDATE",
                    "source_flow_id": source_flow_id,
                    "source_label": source["label"],
                    "source_component": source["component"],
                    "source_value_100million_m3": source["value_100million_m3"],
                    "source_is_aggregate": source_is_aggregate,
                    "source_do_not_sum_with_children": source_do_not_sum_with_children,
                    "candidate_rank": "",
                    "candidate_subbasin_id": "",
                    "candidate_source_basin_id": "",
                    "candidate_pfaf_id": "",
                    "candidate_hybas_id": "",
                    "candidate_downstream": "",
                    "route_to_outlet": "",
                    "river_filter": spec["name"],
                    "river_filter_description": spec["description"],
                    "hydrorivers_segment_count": 0,
                    "intersection_length_km": 0,
                    "max_dis_av_cms": "",
                    "mean_dis_av_cms": "",
                    "max_ord_stra": "",
                    "main_riv_ids": "",
                    "candidate_centroid_lon": "",
                    "candidate_centroid_lat": "",
                    "mapping_status": "no_candidate_segments",
                    "candidate_confidence": "none",
                    "injection_ready": False,
                    "mainstem_injection_ready": False,
                    "formal_use_approved": False,
                    "draft": True,
                    "method": "audit_only_hydrorivers_subbasin_intersection",
                    "limitations": "No HydroRIVERS segment passed the conservative filter.",
                }
            )
            continue

        joined = gpd.sjoin(
            selected_rivers,
            subbasins_proj[["id", "geometry"]],
            predicate="intersects",
            how="inner",
        )
        candidate_metrics: dict[str, dict[str, object]] = {}
        for _, joined_row in joined.iterrows():
            basin_id = str(joined_row["id"])
            basin_geom = sub_geom_by_id[basin_id]
            intersection_length_km = joined_row.geometry.intersection(basin_geom).length / 1000.0
            if intersection_length_km <= 0:
                continue
            item = candidate_metrics.setdefault(
                basin_id,
                {
                    "segmentIds": set(),
                    "mainRivs": set(),
                    "lengthKm": 0.0,
                    "weightedDis": 0.0,
                    "maxDis": 0.0,
                    "maxOrd": 0,
                },
            )
            item["segmentIds"].add(int(joined_row["HYRIV_ID"]))
            item["mainRivs"].add(int(joined_row["MAIN_RIV"]))
            item["lengthKm"] = float(item["lengthKm"]) + intersection_length_km
            item["weightedDis"] = float(item["weightedDis"]) + float(joined_row["DIS_AV_CMS"]) * intersection_length_km
            item["maxDis"] = max(float(item["maxDis"]), float(joined_row["DIS_AV_CMS"]))
            item["maxOrd"] = max(int(item["maxOrd"]), int(joined_row["ORD_STRA"]))

        ranked_all = sorted(
            candidate_metrics.items(),
            key=lambda item: (float(item[1]["maxDis"]), float(item[1]["lengthKm"])),
            reverse=True,
        )
        ranked = [
            (basin_id, metric)
            for basin_id, metric in ranked_all
            if float(metric["lengthKm"]) >= min_intersection_length_km
        ][: int(spec["maxCandidates"])]
        for rank, (basin_id, metric) in enumerate(ranked, start=1):
            basin = subbasin_by_id[basin_id]
            centroid = basin.geometry.centroid
            length_km = float(metric["lengthKm"])
            mean_dis = float(metric["weightedDis"]) / length_km if length_km > 0 else 0.0
            rows.append(
                {
                    "id": f"MS_NODEMAP_{source_flow_id.upper()}_{rank}",
                    "source_flow_id": source_flow_id,
                    "source_label": source["label"],
                    "source_component": source["component"],
                    "source_value_100million_m3": source["value_100million_m3"],
                    "source_is_aggregate": source_is_aggregate,
                    "source_do_not_sum_with_children": source_do_not_sum_with_children,
                    "candidate_rank": rank,
                    "candidate_subbasin_id": basin_id,
                    "candidate_source_basin_id": basin["sourceBasinId"],
                    "candidate_pfaf_id": basin["pfafId"],
                    "candidate_hybas_id": basin["hybasId"],
                    "candidate_downstream": topology.get(basin_id, ""),
                    "route_to_outlet": route_to_outlet(basin_id),
                    "river_filter": spec["name"],
                    "river_filter_description": spec["description"],
                    "hydrorivers_segment_count": len(metric["segmentIds"]),
                    "intersection_length_km": round(length_km, 6),
                    "max_dis_av_cms": round(float(metric["maxDis"]), 6),
                    "mean_dis_av_cms": round(mean_dis, 6),
                    "max_ord_stra": int(metric["maxOrd"]),
                    "main_riv_ids": "|".join(str(value) for value in sorted(metric["mainRivs"])),
                    "candidate_centroid_lon": round(float(centroid.x), 6),
                    "candidate_centroid_lat": round(float(centroid.y), 6),
                    "mapping_status": "audit_candidate_unapproved",
                    "candidate_confidence": "low",
                    "candidate_role": "geometry_intersection_candidate_not_entry_node",
                    "min_intersection_length_km": min_intersection_length_km,
                    "injection_ready": False,
                    "mainstem_injection_ready": False,
                    "formal_use_approved": False,
                    "draft": True,
                    "method": "audit_only_hydrorivers_subbasin_intersection",
                    "limitations": "HydroRIVERS has no river names here; candidate is based on discharge/stream-order filters and subbasin intersection only.",
                }
            )

    output_path = INTERMEDIATE_DIR / "mainstem_node_mapping_draft.csv"
    metadata_path = INTERMEDIATE_DIR / "mainstem_node_mapping_draft_metadata.json"
    write_csv(output_path, rows)
    candidate_rows = [row for row in rows if row["mapping_status"] == "audit_candidate_unapproved"]
    metadata = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "step": "mainstem-node-mapping-draft",
        "draft": True,
        "auditOnly": True,
        "needsHumanReview": True,
        "formalOutputWritten": False,
        "mainstemNodeMappingDraftReady": True,
        "spatialInjectionAssigned": False,
        "mainstemInjectionReady": False,
        "supplyReady": False,
        "fullBakeReady": False,
        "mustNotSatisfyFullBake": True,
        "output": rel(output_path),
        "sourceInputs": {
            "subbasins": rel(subbasins_path),
            "topology": rel(topology_path),
            "mainstemInflowDraft": rel(inflow_path),
            "mainstemInflowMetadata": rel(inflow_metadata_path),
            "hydroRivers": rel(rivers_zip),
        },
        "rowCount": len(rows),
        "candidateRowCount": len(candidate_rows),
        "minIntersectionLengthKm": min_intersection_length_km,
        "sourceFlowIds": target_flow_ids,
        "filterAudit": filter_audit,
        "riversBboxReadCount": int(len(rivers)),
        "subbasinCount": int(len(subbasins)),
        "method": "Audit-only HydroRIVERS/subbasin intersection ranking with >=5 km projected intersection length; no named river confirmation and no injection assignment.",
        "limitations": [
            "HydroRIVERS Asia shapefile used here does not provide river names, so Yangtze/Han labels are inferred only from discharge and stream-order filters.",
            "The current subbasins are AOI-clipped Pfafstetter level_6 polygons with project-provided, upstream-unverified source custody.",
            "Candidates identify possible local subbasin intersections, not Hubei provincial-boundary entry points and not Wuhan 1+8 AOI inflow nodes.",
            "This draft does not trace HydroRIVERS NEXT_DOWN upstream entry paths; it is a candidate screening table only.",
            "Does not write intermediate/supply.csv and does not set mainstemInjectionReady or supplyReady.",
        ],
    }
    write_json(metadata_path, metadata)
    print(f"DRAFT wrote {rel(output_path)}")
    print(f"DRAFT wrote {rel(metadata_path)}")
    print(
        "Mainstem node mapping draft: "
        f"{len(candidate_rows)} audit candidates from {metadata['riversBboxReadCount']} HydroRIVERS bbox segments"
    )
    print("DRAFT ONLY: no qAvail injection and mainstemInjectionReady remains false.")
    return [output_path, metadata_path]


def step_rivers_flowthrough_draft(_: argparse.Namespace) -> list[Path]:
    ensure_dirs()
    try:
        import geopandas as gpd
        from shapely.geometry import mapping
    except ModuleNotFoundError as exc:
        raise BakeBlocked(
            "rivers-flowthrough-draft",
            ["geopandas + shapely in .venv-bake"],
            "Need geopandas and shapely to intersect HydroRIVERS with the current subbasins.",
        ) from exc

    subbasins_path = INTERMEDIATE_DIR / "subbasins_raw.geojson"
    topology_path = INTERMEDIATE_DIR / "topology.json"
    rivers_zip = RAW_DIR / "hydrosheds" / "HydroRIVERS_v10_as_shp.zip"
    for path in [subbasins_path, topology_path, rivers_zip]:
        if not path.exists():
            raise BakeBlocked(
                "rivers-flowthrough-draft",
                [path],
                "Need current subbasins, topology, and HydroRIVERS before writing the flowThrough draft.",
            )

    topology = read_topology(required=True, step="rivers-flowthrough-draft")
    order = topology_order(topology, "rivers-flowthrough-draft")
    order_index = {basin_id: index for index, basin_id in enumerate(order)}
    subbasins = gpd.read_file(subbasins_path)
    if subbasins.crs is None:
        subbasins = subbasins.set_crs("EPSG:4326")
    bounds = tuple(float(value) for value in subbasins.total_bounds)
    rivers_uri = f"zip://{rivers_zip.resolve()}!HydroRIVERS_v10_as_shp/HydroRIVERS_v10_as.shp"
    rivers = gpd.read_file(rivers_uri, bbox=bounds)
    if rivers.crs is None:
        rivers = rivers.set_crs("EPSG:4326")

    projection = "EPSG:6933"
    subbasins_proj = subbasins[["id", "geometry"]].to_crs(projection)
    rivers_proj = rivers[
        ["HYRIV_ID", "NEXT_DOWN", "MAIN_RIV", "LENGTH_KM", "DIS_AV_CMS", "ORD_STRA", "ORD_FLOW", "geometry"]
    ].to_crs(projection)
    selected_rivers = rivers_proj[(rivers_proj["DIS_AV_CMS"] >= 500) | (rivers_proj["ORD_STRA"] >= 6)].copy()
    joined = gpd.sjoin(selected_rivers, subbasins_proj[["id", "geometry"]], predicate="intersects", how="inner")
    sub_geom_by_id = {str(row["id"]): row.geometry for _, row in subbasins_proj.iterrows()}
    original_by_hyriv = {int(row["HYRIV_ID"]): row for _, row in rivers.iterrows()}

    metrics: dict[int, dict[str, object]] = {}
    for _, joined_row in joined.iterrows():
        basin_id = str(joined_row["id"])
        if basin_id not in topology:
            continue
        hyriv_id = int(joined_row["HYRIV_ID"])
        basin_geom = sub_geom_by_id[basin_id]
        intersection_length_km = joined_row.geometry.intersection(basin_geom).length / 1000.0
        if intersection_length_km <= 0:
            continue
        item = metrics.setdefault(
            hyriv_id,
            {
                "basins": set(),
                "intersectionLengthKm": 0.0,
                "disAvCms": float(joined_row["DIS_AV_CMS"]),
                "ordStra": int(joined_row["ORD_STRA"]),
                "ordFlow": int(joined_row["ORD_FLOW"]),
                "mainRiv": int(joined_row["MAIN_RIV"]),
                "nextDown": int(joined_row["NEXT_DOWN"]),
                "sourceLengthKm": float(joined_row["LENGTH_KM"]),
            },
        )
        item["basins"].add(basin_id)
        item["intersectionLengthKm"] = float(item["intersectionLengthKm"]) + intersection_length_km

    max_features = 120
    ranked = sorted(
        metrics.items(),
        key=lambda item: (float(item[1]["disAvCms"]), float(item[1]["intersectionLengthKm"])),
        reverse=True,
    )[:max_features]
    features = []
    unknown_id_count = 0
    for hyriv_id, metric in ranked:
        basins = sorted(metric["basins"], key=lambda basin_id: order_index.get(basin_id, 10**9))
        unknown_id_count += sum(1 for basin_id in basins if basin_id not in topology)
        if not basins:
            continue
        last_basin = basins[-1]
        downstream = topology.get(last_basin, "OUTLET")
        original = original_by_hyriv[hyriv_id]
        properties = {
            "id": f"HR_{hyriv_id}",
            "flowDirection": "topology_ordered_audit",
            "fromSubbasin": basins[0],
            "toSubbasin": basins[1] if len(basins) > 1 else downstream,
            "downstreamSubbasin": downstream,
            "flowThrough": basins,
            "sourceHydroRiverId": hyriv_id,
            "nextDownHydroRiverId": int(metric["nextDown"]),
            "mainRiverId": int(metric["mainRiv"]),
            "sourceLengthKm": round(float(metric["sourceLengthKm"]), 6),
            "intersectionLengthKm": round(float(metric["intersectionLengthKm"]), 6),
            "disAvCms": round(float(metric["disAvCms"]), 6),
            "ordStra": int(metric["ordStra"]),
            "ordFlow": int(metric["ordFlow"]),
            "draft": True,
            "auditOnly": True,
            "formalUseApproved": False,
            "method": "audit_only_hydrorivers_intersection_topology_ordered_flowthrough",
        }
        features.append({"type": "Feature", "properties": properties, "geometry": mapping(original.geometry)})

    output_path = INTERMEDIATE_DIR / "rivers_flowthrough_draft.geojson"
    metadata_path = INTERMEDIATE_DIR / "rivers_flowthrough_draft_metadata.json"
    payload = {
        "type": "FeatureCollection",
        "name": "rivers_flowthrough_draft",
        "features": features,
    }
    non_empty_count = sum(1 for feature in features if feature["properties"].get("flowThrough"))
    metadata = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "step": "rivers-flowthrough-draft",
        "draft": True,
        "auditOnly": True,
        "needsHumanReview": True,
        "formalOutput": rel(DATA_DIR / "wuhan-rivers.geojson"),
        "formalOutputWritten": False,
        "riversFlowThroughDraftReady": True,
        "riversReady": False,
        "fullBakeReady": False,
        "mustNotSatisfyFullBake": True,
        "sourceInputs": {
            "subbasins": rel(subbasins_path),
            "topology": rel(topology_path),
            "hydroRivers": rel(rivers_zip),
        },
        "riversBboxReadCount": int(len(rivers)),
        "selectedRiverCount": int(len(selected_rivers)),
        "featureCount": len(features),
        "maxFeatures": max_features,
        "flowThroughChecks": {
            "nonEmptyFeatureCount": non_empty_count,
            "allFeaturesHaveFlowThrough": non_empty_count == len(features),
            "unknownSubbasinIdCount": unknown_id_count,
            "allFlowThroughIdsInTopology": unknown_id_count == 0,
        },
        "filters": {
            "disAvCmsMinOr": 500,
            "ordStraMinOr": 6,
            "rankBy": "DIS_AV_CMS desc, intersectionLengthKm desc",
        },
        "limitations": [
            "Audit-only HydroRIVERS flowThrough draft; it is not simplified, not clipped to final AOI geometry, and not written to research/data.",
            "Current flowThrough ordering uses the approved Pfafstetter level_6 topology and remains a draft HydroRIVERS overlay.",
            "The Pfafstetter vector source is project-provided and upstream provenance is not independently verified.",
            "Formal wuhan-rivers.geojson still requires final subbasin approval, simplification, and provenance review.",
        ],
    }
    write_json(output_path, payload)
    write_json(metadata_path, metadata)
    print(f"DRAFT wrote {rel(output_path)}")
    print(f"DRAFT wrote {rel(metadata_path)}")
    print(
        "Rivers flowThrough draft: "
        f"{len(features)} features, allFlowThroughIdsInTopology={metadata['flowThroughChecks']['allFlowThroughIdsInTopology']}"
    )
    print("DRAFT ONLY: wuhan-rivers.geojson and riversReady remain locked.")
    return [output_path, metadata_path]


def step_mainstem_injection_plan_draft(_: argparse.Namespace) -> list[Path]:
    ensure_dirs()
    inflow_path = INTERMEDIATE_DIR / "mainstem_inflow_draft.csv"
    inflow_metadata_path = INTERMEDIATE_DIR / "mainstem_inflow_draft_metadata.json"
    mapping_path = INTERMEDIATE_DIR / "mainstem_node_mapping_draft.csv"
    mapping_metadata_path = INTERMEDIATE_DIR / "mainstem_node_mapping_draft_metadata.json"
    topology_path = INTERMEDIATE_DIR / "topology.json"
    for path in [inflow_path, inflow_metadata_path, mapping_path, mapping_metadata_path, topology_path]:
        if not path.exists():
            raise BakeBlocked(
                "mainstem-injection-plan-draft",
                [path],
                "Need inflow evidence, node mapping candidates, and topology before writing an injection plan draft.",
            )

    topology = read_topology(required=True, step="mainstem-injection-plan-draft")
    inflow_metadata = read_metadata(inflow_metadata_path)
    mapping_metadata = read_metadata(mapping_metadata_path)
    inflow_by_id = {row["flow_id"]: row for row in load_csv_rows(inflow_path)}
    mapping_rows = load_csv_rows(mapping_path)
    non_additive_formal_candidates = {"yangtze_mainstem_entry", "han_mainstem_entry"}
    excluded_aggregates = {"han_system_entry", "minor_five_rivers_entry"}
    plan_rows: list[dict[str, object]] = []
    for row in mapping_rows:
        flow_id = row.get("source_flow_id", "")
        source = inflow_by_id.get(flow_id, {})
        source_is_aggregate = str(row.get("source_is_aggregate", "")).lower() == "true"
        candidate_subbasin_id = row.get("candidate_subbasin_id", "")
        candidate_rank = row.get("candidate_rank", "")
        rank_int = int(candidate_rank) if str(candidate_rank).isdigit() else None
        can_be_non_additive_candidate = (
            flow_id in non_additive_formal_candidates
            and not source_is_aggregate
            and candidate_subbasin_id in topology
            and row.get("mapping_status") == "audit_candidate_unapproved"
        )
        value_1e8_m3 = float(source.get("value_100million_m3") or row.get("source_value_100million_m3") or 0)
        candidate_inflow_m3 = value_1e8_m3 * 100_000_000 if can_be_non_additive_candidate else ""
        if flow_id in excluded_aggregates:
            plan_status = "excluded_aggregate_do_not_sum_with_children"
        elif can_be_non_additive_candidate:
            plan_status = "candidate_unapproved_primary" if rank_int == 1 else "candidate_unapproved_alternative"
        elif row.get("mapping_status") == "not_attempted_group_aggregate":
            plan_status = "not_mapped_group_aggregate"
        else:
            plan_status = "not_formal_candidate"
        plan_rows.append(
            {
                "source_flow_id": flow_id,
                "source_label": row.get("source_label", ""),
                "source_value_100million_m3": row.get("source_value_100million_m3", ""),
                "source_is_aggregate": source_is_aggregate,
                "source_do_not_sum_with_children": str(row.get("source_do_not_sum_with_children", "")).lower() == "true",
                "candidate_rank": candidate_rank,
                "candidate_subbasin_id": candidate_subbasin_id,
                "candidate_downstream": row.get("candidate_downstream", ""),
                "route_to_outlet": row.get("route_to_outlet", ""),
                "candidate_confidence": row.get("candidate_confidence", ""),
                "candidate_inflow_m3_if_approved": round(candidate_inflow_m3, 3) if candidate_inflow_m3 != "" else "",
                "candidate_inflow_million_m3_if_approved": round(candidate_inflow_m3 / 1_000_000, 6)
                if candidate_inflow_m3 != ""
                else "",
                "plan_status": plan_status,
                "injection_ready": False,
                "mainstem_injection_ready": False,
                "formal_use_approved": False,
                "draft": True,
                "method": "audit_only_non_additive_candidate_plan_no_injection",
            }
        )

    output_csv = INTERMEDIATE_DIR / "mainstem_injection_plan_draft.csv"
    output_json = INTERMEDIATE_DIR / "mainstem_injection_plan_draft.json"
    metadata_path = INTERMEDIATE_DIR / "mainstem_injection_plan_draft_metadata.json"
    candidate_rows = [row for row in plan_rows if str(row["plan_status"]).startswith("candidate_unapproved")]
    primary_rows = [row for row in candidate_rows if row["plan_status"] == "candidate_unapproved_primary"]
    payload = {
        "kind": "mainstem-injection-plan-draft",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "draft": True,
        "auditOnly": True,
        "formalUseApproved": False,
        "mainstemInjectionReady": False,
        "spatialInjectionAssigned": False,
        "nonAdditiveCandidateFlowIds": sorted(non_additive_formal_candidates),
        "excludedAggregateFlowIds": sorted(excluded_aggregates),
        "candidatePlans": plan_rows,
        "blockedFinalReasons": [
            "Candidate flows are Hubei provincial-boundary inflows, not approved Wuhan 1+8 AOI injection quantities.",
            "HydroRIVERS/subbasin candidates have low confidence and lack named river confirmation.",
            "The current subbasin source is project-provided and upstream provenance is not independently verified.",
            "No candidate is allowed to change qAvail until a non-additive spatial injection rule is reviewed and approved.",
        ],
        "sourceMetadata": {
            "mainstemInflowDraft": {
                "path": rel(inflow_metadata_path),
                "mainstemInflowDraftReady": inflow_metadata.get("mainstemInflowDraftReady"),
                "spatialInjectionAssigned": inflow_metadata.get("spatialInjectionAssigned"),
            },
            "mainstemNodeMappingDraft": {
                "path": rel(mapping_metadata_path),
                "mainstemNodeMappingDraftReady": mapping_metadata.get("mainstemNodeMappingDraftReady"),
                "spatialInjectionAssigned": mapping_metadata.get("spatialInjectionAssigned"),
            },
        },
    }
    metadata = {
        "createdAt": payload["createdAt"],
        "step": "mainstem-injection-plan-draft",
        "draft": True,
        "auditOnly": True,
        "needsHumanReview": True,
        "formalOutputWritten": False,
        "mainstemInjectionPlanDraftReady": True,
        "spatialInjectionAssigned": False,
        "mainstemInjectionReady": False,
        "supplyReady": False,
        "fullBakeReady": False,
        "mustNotSatisfyFullBake": True,
        "outputs": {
            "csv": rel(output_csv),
            "json": rel(output_json),
        },
        "sourceInputs": {
            "mainstemInflowDraft": rel(inflow_path),
            "mainstemInflowMetadata": rel(inflow_metadata_path),
            "mainstemNodeMappingDraft": rel(mapping_path),
            "mainstemNodeMappingMetadata": rel(mapping_metadata_path),
            "topology": rel(topology_path),
        },
        "rowCount": len(plan_rows),
        "candidateRowCount": len(candidate_rows),
        "primaryCandidateRowCount": len(primary_rows),
        "nonAdditiveCandidateFlowIds": sorted(non_additive_formal_candidates),
        "excludedAggregateFlowIds": sorted(excluded_aggregates),
        "limitations": payload["blockedFinalReasons"],
    }
    write_csv(output_csv, plan_rows)
    write_json(output_json, payload)
    write_json(metadata_path, metadata)
    print(f"DRAFT wrote {rel(output_csv)}")
    print(f"DRAFT wrote {rel(output_json)}")
    print(f"DRAFT wrote {rel(metadata_path)}")
    print(
        "Mainstem injection plan draft: "
        f"{len(candidate_rows)} unapproved non-additive candidates, {len(primary_rows)} primary candidates"
    )
    print("DRAFT ONLY: no qAvail injection and mainstemInjectionReady remains false.")
    return [output_csv, output_json, metadata_path]


def step_demand_draft(_: argparse.Namespace) -> list[Path]:
    ensure_dirs()
    landpop_path = INTERMEDIATE_DIR / "zonal_landpop.csv"
    zonal_metadata_path = INTERMEDIATE_DIR / "zonal_metadata.json"
    bulletin_path = INTERMEDIATE_DIR / "bulletin_table12_draft.csv"
    bulletin_metadata_path = INTERMEDIATE_DIR / "bulletin_table12_draft_metadata.json"
    topology_path = INTERMEDIATE_DIR / "topology.json"
    for path in [landpop_path, zonal_metadata_path, bulletin_path, bulletin_metadata_path, topology_path]:
        if not path.exists():
            raise BakeBlocked(
                "demand-draft",
                [path],
                "Need partial land/pop zonal evidence, bulletin draft, and topology before writing a demand audit draft.",
            )

    zonal_metadata = read_metadata(zonal_metadata_path)
    bulletin_metadata = read_metadata(bulletin_metadata_path)
    if zonal_metadata.get("landPopStatsReady") is not True:
        raise BakeBlocked(
            "demand-draft",
            [f"{rel(zonal_metadata_path)}:landPopStatsReady=true"],
            "Need landPopStatsReady metadata before demand draft.",
        )
    if bulletin_metadata.get("demandReady") is True or bulletin_metadata.get("formalOutputWritten") is True:
        raise BakeBlocked(
            "demand-draft",
            [bulletin_metadata_path],
            "Bulletin draft metadata should stay audit-only; formal demand must be produced by the locked demand step.",
        )

    topology = read_topology(required=True, step="demand-draft")
    order = topology_order(topology, "demand-draft")
    landpop_by_id = {row["id"]: row for row in load_csv_rows(landpop_path)}
    missing_rows = [basin_id for basin_id in order if basin_id not in landpop_by_id]
    if missing_rows:
        raise BakeBlocked(
            "demand-draft",
            [f"{rel(landpop_path)} missing {basin_id}" for basin_id in missing_rows[:10]],
            "Every topology node needs a land/population row before demand draft.",
        )

    bulletin_rows = load_csv_rows(bulletin_path)
    total_rows = [row for row in bulletin_rows if row.get("row_type") == "target_total"]
    if len(total_rows) != 1:
        raise BakeBlocked(
            "demand-draft",
            [bulletin_path],
            "Need exactly one target_total row from bulletin_table12_draft.csv before demand draft.",
        )
    target = total_rows[0]
    unit_multiplier = 100_000_000.0
    target_totals_m3 = {
        "agri": float(target["old_agri"]) * unit_multiplier,
        "industry": float(target["old_industry"]) * unit_multiplier,
        "urban": float(target["old_life"]) * unit_multiplier,
        "ecoNewCaliber": float(target["new_ecology"]) * unit_multiplier,
    }
    bulletin_total_old_caliber_m3 = float(target["total"]) * unit_multiplier
    cropland_weights = {basin_id: float(landpop_by_id[basin_id]["clcd_cropland_ha"]) for basin_id in order}
    population_weights = {basin_id: float(landpop_by_id[basin_id]["worldpop_population"]) for basin_id in order}
    builtup_weights = {basin_id: float(landpop_by_id[basin_id]["clcd_builtup_ha"]) for basin_id in order}
    nightlight_path = INTERMEDIATE_DIR / "zonal_nightlight_draft.csv"
    nightlight_by_id = {row["id"]: row for row in load_csv_rows(nightlight_path)} if nightlight_path.exists() else {}
    natural_weights = {
        basin_id: max(
            float(landpop_by_id[basin_id]["sub_area_km2"]) * 100.0
            - float(landpop_by_id[basin_id]["clcd_cropland_ha"])
            - float(landpop_by_id[basin_id]["clcd_builtup_ha"]),
            0.0,
        )
        for basin_id in order
    }
    cropland_total = sum(cropland_weights.values())
    population_total = sum(population_weights.values())
    builtup_total = sum(builtup_weights.values())
    agri_defaults = {basin_id: cropland_weights[basin_id] * 5500.0 for basin_id in order}
    urban_defaults = {basin_id: population_weights[basin_id] * 73.0 for basin_id in order}
    agri_default_total = sum(agri_defaults.values())
    urban_default_total = sum(urban_defaults.values())
    agri_scale = target_totals_m3["agri"] / agri_default_total if agri_default_total else 0.0
    urban_scale = target_totals_m3["urban"] / urban_default_total if urban_default_total else 0.0
    if not all(value > 0 for value in [cropland_total, population_total, builtup_total, agri_default_total, urban_default_total]):
        raise BakeBlocked(
            "demand-draft",
            ["nonzero crop/pop/built-up/default demand denominators"],
            "Need positive crop, population, built-up, and default demand totals before demand draft allocation.",
        )

    crop_shares = {basin_id: cropland_weights[basin_id] / cropland_total for basin_id in order}
    pop_shares = {basin_id: population_weights[basin_id] / population_total for basin_id in order}
    built_shares = {basin_id: builtup_weights[basin_id] / builtup_total for basin_id in order}
    industry_proxy_raw = {
        basin_id: max(1e-12, 0.70 * built_shares[basin_id] + 0.25 * pop_shares[basin_id] - 0.15 * crop_shares[basin_id])
        for basin_id in order
    }
    industry_proxy_source = "builtup_population_cropland_fallback_no_nightlight"
    nightlight_ids_match = set(nightlight_by_id) == set(order)
    if nightlight_ids_match:
        industry_proxy_raw = {
            basin_id: max(1e-12, float(nightlight_by_id[basin_id].get("ind_weight_wb_len", 0) or 0))
            for basin_id in order
        }
        industry_proxy_source = "world_bank_light_every_night_12month_interpolated_ind_weight_wb_len"
    demand_method = (
        "audit_only_bulletin_total_downscale_wb_len_12month_interpolated_proxy"
        if nightlight_ids_match
        else "audit_only_bulletin_total_downscale_builtup_population_cropland_fallback"
    )
    industry_proxy_raw_total = sum(industry_proxy_raw.values())
    industry_proxy_shares = {basin_id: industry_proxy_raw[basin_id] / industry_proxy_raw_total for basin_id in order}
    allocations = {
        "agri": allocate_total_by_weight(target_totals_m3["agri"], cropland_weights),
        "industry": {basin_id: target_totals_m3["industry"] * industry_proxy_shares[basin_id] for basin_id in order},
        "urban": allocate_total_by_weight(target_totals_m3["urban"], population_weights),
        "ecoNewCaliber": allocate_total_by_weight(target_totals_m3["ecoNewCaliber"], natural_weights),
    }

    rows: list[dict[str, object]] = []
    for basin_id in order:
        landpop = landpop_by_id[basin_id]
        agri_default = agri_defaults[basin_id]
        urban_default = urban_defaults[basin_id]
        agri_calibrated = allocations["agri"][basin_id]
        industry_calibrated = allocations["industry"][basin_id]
        urban_calibrated = allocations["urban"][basin_id]
        eco_new_caliber = allocations["ecoNewCaliber"][basin_id]
        old_caliber_total = agri_calibrated + industry_calibrated + urban_calibrated
        rows.append(
            {
                "id": basin_id,
                "downstream": topology[basin_id],
                "sub_area_km2": landpop["sub_area_km2"],
                "fallback": landpop["fallback"],
                "clcd_cropland_ha": landpop["clcd_cropland_ha"],
                "clcd_builtup_ha": landpop["clcd_builtup_ha"],
                "worldcover_cropland_ha_nominal": landpop["worldcover_cropland_ha_nominal"],
                "worldcover_builtup_ha_nominal": landpop["worldcover_builtup_ha_nominal"],
                "worldpop_population": landpop["worldpop_population"],
                "agri_default_m3": round(agri_default, 3),
                "urban_default_m3": round(urban_default, 3),
                "agri_scale_to_bulletin": round(agri_scale, 12),
                "urban_scale_to_bulletin": round(urban_scale, 12),
                "agri_calibrated_m3": round(agri_calibrated, 3),
                "industry_proxy_raw": round(industry_proxy_raw[basin_id], 15),
                "industry_proxy_share": round(industry_proxy_shares[basin_id], 15),
                "industry_proxy_source": industry_proxy_source,
                "industry_calibrated_m3": round(industry_calibrated, 3),
                "urban_calibrated_m3": round(urban_calibrated, 3),
                "eco_new_caliber_proxy_share": round(
                    natural_weights[basin_id] / sum(natural_weights.values()) if sum(natural_weights.values()) else 0.0,
                    15,
                ),
                "eco_new_caliber_draft_m3": round(eco_new_caliber, 3),
                "old_caliber_total_m3": round(old_caliber_total, 3),
                "agri_10k_m3": round(agri_calibrated / 10_000.0, 6),
                "industry_10k_m3": round(industry_calibrated / 10_000.0, 6),
                "urban_10k_m3": round(urban_calibrated / 10_000.0, 6),
                "eco_new_caliber_10k_m3": round(eco_new_caliber / 10_000.0, 6),
                "method": demand_method,
                "audit_only_flag": True,
            }
        )

    sector_sums = {
        "agri": round(sum(float(row["agri_calibrated_m3"]) for row in rows), 3),
        "industry": round(sum(float(row["industry_calibrated_m3"]) for row in rows), 3),
        "urban": round(sum(float(row["urban_calibrated_m3"]) for row in rows), 3),
        "ecoNewCaliber": round(sum(float(row["eco_new_caliber_draft_m3"]) for row in rows), 3),
    }
    old_caliber_sum_m3 = sector_sums["agri"] + sector_sums["industry"] + sector_sums["urban"]
    old_caliber_error_pct = (
        abs(old_caliber_sum_m3 - bulletin_total_old_caliber_m3) / bulletin_total_old_caliber_m3 * 100
        if bulletin_total_old_caliber_m3
        else 0.0
    )
    finite_nonnegative = all(
        math.isfinite(float(row[column])) and float(row[column]) >= 0
        for row in rows
        for column in [
            "agri_default_m3",
            "urban_default_m3",
            "agri_calibrated_m3",
            "industry_calibrated_m3",
            "urban_calibrated_m3",
            "eco_new_caliber_draft_m3",
            "old_caliber_total_m3",
        ]
    )
    output_path = INTERMEDIATE_DIR / "demand_draft.csv"
    metadata_path = INTERMEDIATE_DIR / "demand_draft_metadata.json"
    write_csv(output_path, rows)
    city_rows = [row for row in bulletin_rows if row.get("row_type") == "city"]
    sorted_industry_proxy = sorted(
        (
            {
                "id": basin_id,
                "proxyShare": industry_proxy_shares[basin_id],
                "proxyRaw": industry_proxy_raw[basin_id],
                "builtupOnlyShare": built_shares[basin_id],
                "shareAbsDiffVsBuiltupOnly": abs(industry_proxy_shares[basin_id] - built_shares[basin_id]),
            }
            for basin_id in order
        ),
        key=lambda item: item["proxyShare"],
        reverse=True,
    )
    top5_proxy_share = sum(item["proxyShare"] for item in sorted_industry_proxy[:5])
    builtup_share_diff_l1 = sum(item["shareAbsDiffVsBuiltupOnly"] for item in sorted_industry_proxy)
    builtup_top5 = {basin_id for basin_id, _ in sorted(built_shares.items(), key=lambda item: item[1], reverse=True)[:5]}
    proxy_top5 = {item["id"] for item in sorted_industry_proxy[:5]}
    nightlight_zero_weight_count = (
        sum(1 for basin_id in order if float(nightlight_by_id[basin_id].get("ind_weight_wb_len", 0) or 0) <= 0)
        if nightlight_ids_match
        else None
    )
    zero_or_tiny_industry_allocation_count = sum(
        1 for row in rows if float(row["industry_calibrated_m3"]) <= 0.001
    )
    nightlight_partial = zonal_metadata.get("nightlightPartial", {}) if isinstance(zonal_metadata.get("nightlightPartial"), dict) else {}
    world_bank_len_approved = bool(
        nightlight_ids_match
        and zonal_metadata.get("industrialProxyApprovedForFullBake") is True
        and zonal_metadata.get("worldBankLenProxyApprovedForFullBake") is True
    )
    industrial_proxy_qa = {
        "proxySource": industry_proxy_source,
        "proxyMethod": demand_method,
        "preferredViirsReady": False,
        "nightlightDraftIdsMatchTopology": nightlight_ids_match,
        "worldBankLen10MonthProxyUsed": False,
        "worldBankLen12MonthInterpolatedProxyUsed": nightlight_ids_match,
        "worldBankLenProxyApprovedForFullBake": world_bank_len_approved,
        "monthsUsed": nightlight_partial.get("monthsUsed", []),
        "observedMonths": nightlight_partial.get("observedMonths", []),
        "interpolatedMonths": nightlight_partial.get("interpolatedMonths", []),
        "missingMonthsAfterInterpolation": nightlight_partial.get("missingMonthsAfterInterpolation", []),
        "zeroNightlightWeightCount": nightlight_zero_weight_count,
        "zeroOrTinyIndustryAllocationCount": zero_or_tiny_industry_allocation_count,
        "topProxyShare": round(sorted_industry_proxy[0]["proxyShare"], 12) if sorted_industry_proxy else 0,
        "topProxySubbasin": sorted_industry_proxy[0]["id"] if sorted_industry_proxy else None,
        "top5ProxyShare": round(top5_proxy_share, 12),
        "top5ProxySubbasins": [item["id"] for item in sorted_industry_proxy[:5]],
        "builtupOnlySensitivity": {
            "shareL1Distance": round(builtup_share_diff_l1, 12),
            "maxAbsShareDiff": round(max((item["shareAbsDiffVsBuiltupOnly"] for item in sorted_industry_proxy), default=0), 12),
            "maxAbsShareDiffSubbasin": max(sorted_industry_proxy, key=lambda item: item["shareAbsDiffVsBuiltupOnly"])["id"]
            if sorted_industry_proxy
            else None,
            "top5OverlapCount": len(proxy_top5 & builtup_top5),
            "top5OverlapSubbasins": sorted(proxy_top5 & builtup_top5),
        },
        "top10ProxyRows": [
            {
                "id": item["id"],
                "proxyShare": round(item["proxyShare"], 12),
                "proxyRaw": round(item["proxyRaw"], 12),
                "builtupOnlyShare": round(item["builtupOnlyShare"], 12),
                "shareAbsDiffVsBuiltupOnly": round(item["shareAbsDiffVsBuiltupOnly"], 12),
            }
            for item in sorted_industry_proxy[:10]
        ],
        "approvalWarning": "Industrial proxy approval applies only to the documented WB LEN 12-month interpolated fallback; do not describe it as EOG Annual VNL.",
    }
    metadata = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "step": "demand-draft",
        "draft": True,
        "auditOnly": True,
        "needsHumanReview": True,
        "formalOutput": rel(INTERMEDIATE_DIR / "demand.csv"),
        "formalMetadata": rel(INTERMEDIATE_DIR / "demand_metadata.json"),
        "formalOutputWritten": False,
        "demandReady": False,
        "fullBakeReady": False,
        "mustNotSatisfyFullBake": True,
        "cityAllocationReady": False,
        "industrialViirsReady": False,
        "preferredViirsReady": False,
        "nightlightDraftIdsMatchTopology": nightlight_ids_match,
        "worldBankLen10MonthProxyUsed": False,
        "worldBankLen12MonthInterpolatedProxyUsed": nightlight_ids_match,
        "industrialNightlightDraftReady": nightlight_ids_match,
        "industrialProxyReady": world_bank_len_approved,
        "industrialProxyApprovedForFullBake": world_bank_len_approved,
        "worldBankLenProxyApprovedForFullBake": world_bank_len_approved,
        "calibrationScope": "Wuhan 1+8 total only, not per-city allocation",
        "subbasinCount": len(rows),
        "sourceInputs": {
            "landpop": rel(landpop_path),
            "zonalMetadata": rel(zonal_metadata_path),
            "nightlightDraft": rel(nightlight_path) if nightlight_path.exists() else None,
            "bulletinDraft": rel(bulletin_path),
            "bulletinMetadata": rel(bulletin_metadata_path),
            "topology": rel(topology_path),
        },
        "targetTotalsM3": {sector: round(value, 3) for sector, value in target_totals_m3.items()},
        "targetTotalsHundredMillionM3": {
            "agri": float(target["old_agri"]),
            "industry": float(target["old_industry"]),
            "urban": float(target["old_life"]),
            "ecoNewCaliber": float(target["new_ecology"]),
            "oldCaliberTotal": float(target["total"]),
        },
        "citySectorDemandDraftHundredMillionM3": {
            row["city"]: {
                "agri": float(row["old_agri"]),
                "industry": float(row["old_industry"]),
                "urban": float(row["old_life"]),
                "eco": float(row["new_ecology"]),
            }
            for row in city_rows
        },
        "weights": {
            "agri": "CLCD cropland ha",
            "industry": "World Bank Light Every Night 12-month interpolated ind_weight_wb_len if present; otherwise max(1e-12, 0.70*built_share + 0.25*population_share - 0.15*cropland_share)",
            "urban": "WorldPop 2022 population",
            "ecoNewCaliber": "max(sub_area_km2*100 - CLCD cropland ha - CLCD built-up ha, 0)",
        },
        "checks": {
            "topologyOrderLength": len(order),
            "topologyAcyclic": True,
            "sectorSumsM3": sector_sums,
            "defaultFormulaTotalsM3": {
                "agriDefault": round(agri_default_total, 3),
                "urbanDefault": round(urban_default_total, 3),
            },
            "defaultFormulaTotalsHundredMillionM3": {
                "agriDefault": round(agri_default_total / unit_multiplier, 6),
                "urbanDefault": round(urban_default_total / unit_multiplier, 6),
            },
            "scaleToBulletin": {
                "agri": round(agri_scale, 12),
                "urban": round(urban_scale, 12),
            },
            "oldCaliberSumM3": round(old_caliber_sum_m3, 3),
            "bulletinOldCaliberTotalM3": round(bulletin_total_old_caliber_m3, 3),
            "oldCaliberErrorPct": round(old_caliber_error_pct, 9),
            "allDemandValuesFiniteNonnegative": finite_nonnegative,
            "allWeightTotalsPositive": {
                "cropland": cropland_total > 0,
                "builtup": builtup_total > 0,
                "population": population_total > 0,
                "industryProxyRaw": industry_proxy_raw_total > 0,
                "naturalProxy": sum(natural_weights.values()) > 0,
            },
            "nightlightDraftIdsMatchTopology": nightlight_ids_match,
            "industryProxySource": industry_proxy_source,
        },
        "industrialProxyQa": industrial_proxy_qa,
        "viirsReady": False,
        "limitations": [
            "Audit-only T1.4 draft: it downscales bulletin totals to the approved Pfafstetter level_6 units for QA, not for formal research/data.",
            "Industrial demand uses the approved World Bank Light Every Night 12-month interpolated fallback when available, otherwise a built-up/population/cropland fallback.",
            "The bulletin table mixes old-caliber and new-caliber sectors; agri/industry/urban use old-caliber values, while ecology is carried as a separate new-caliber audit column only.",
            "City-level bulletin rows are preserved in metadata; formal per-city spatial allocation remains a separate review step.",
            "Does not write intermediate/demand.csv and does not set demandReady.",
        ],
    }
    write_json(metadata_path, metadata)
    print(f"DRAFT wrote {rel(output_path)}")
    print(f"DRAFT wrote {rel(metadata_path)}")
    print(
        "Demand draft totals: "
        f"old-caliber={round(old_caliber_sum_m3 / 100_000_000, 6)} 亿 m3, "
        f"bulletin={target['total']} 亿 m3, error={metadata['checks']['oldCaliberErrorPct']}%, "
        f"agriDefault={metadata['checks']['defaultFormulaTotalsHundredMillionM3']['agriDefault']} 亿 m3, "
        f"urbanDefault={metadata['checks']['defaultFormulaTotalsHundredMillionM3']['urbanDefault']} 亿 m3"
    )
    print("DRAFT ONLY: demand.csv and demandReady remain locked pending the formal demand step.")
    return [output_path, metadata_path]


def step_city_demand_allocation_draft(_: argparse.Namespace) -> list[Path]:
    ensure_dirs()
    try:
        import geopandas as gpd
    except ModuleNotFoundError as exc:
        raise BakeBlocked(
            "city-demand-allocation-draft",
            ["geopandas in .venv-bake"],
            "Need geopandas to intersect GADM city boundaries with the current subbasins.",
        ) from exc

    gadm_path = RAW_DIR / "gadm" / "gadm41_CHN.gpkg"
    subbasins_path = INTERMEDIATE_DIR / "subbasins_raw.geojson"
    topology_path = INTERMEDIATE_DIR / "topology.json"
    landpop_path = INTERMEDIATE_DIR / "zonal_landpop.csv"
    zonal_metadata_path = INTERMEDIATE_DIR / "zonal_metadata.json"
    nightlight_path = INTERMEDIATE_DIR / "zonal_nightlight_draft.csv"
    bulletin_path = INTERMEDIATE_DIR / "bulletin_table12_draft.csv"
    demand_metadata_path = INTERMEDIATE_DIR / "demand_draft_metadata.json"
    for path in [gadm_path, subbasins_path, topology_path, landpop_path, zonal_metadata_path, bulletin_path, demand_metadata_path]:
        if not path.exists():
            raise BakeBlocked(
                "city-demand-allocation-draft",
                [path],
                "Need GADM cities, subbasins, topology, zonal land/pop, bulletin rows, and demand draft metadata before city allocation audit.",
            )

    topology = read_topology(required=True, step="city-demand-allocation-draft")
    order = topology_order(topology, "city-demand-allocation-draft")
    landpop_by_id = {row["id"]: row for row in load_csv_rows(landpop_path)}
    missing_landpop = [basin_id for basin_id in order if basin_id not in landpop_by_id]
    if missing_landpop:
        raise BakeBlocked(
            "city-demand-allocation-draft",
            [f"{rel(landpop_path)} missing {basin_id}" for basin_id in missing_landpop[:10]],
            "Every topology node needs land/population evidence before city demand allocation.",
        )

    nightlight_by_id = {row["id"]: row for row in load_csv_rows(nightlight_path)} if nightlight_path.exists() else {}
    nightlight_ids_match = set(nightlight_by_id) == set(order)
    city_rows = [row for row in load_csv_rows(bulletin_path) if row.get("row_type") == "city"]
    city_rows_by_city = {row["city"]: row for row in city_rows}
    missing_cities = sorted(set(CITIES) - set(city_rows_by_city))
    if missing_cities:
        raise BakeBlocked(
            "city-demand-allocation-draft",
            [f"{rel(bulletin_path)} missing {city}" for city in missing_cities],
            "Need all Wuhan 1+8 city rows from bulletin table 12 before city allocation audit.",
        )

    subbasins = gpd.read_file(subbasins_path)
    if subbasins.crs is None:
        subbasins = subbasins.set_crs("EPSG:4326")
    subbasins = normalize_subbasin_gdf(subbasins)
    sub_attrs_by_id = {
        str(row["id"]): {
            "sourceBasinId": row.get("sourceBasinId"),
            "pfafId": row.get("pfafId"),
            "hybasId": row.get("hybasId"),
        }
        for _, row in subbasins.iterrows()
    }
    cities = gpd.read_file(gadm_path, layer="ADM_ADM_2")
    target_gid_to_city = {gid: city for city, gid in TARGET_GID_BY_CITY.items()}
    cities = cities[cities["GID_2"].isin(target_gid_to_city)].copy()
    cities["city"] = cities["GID_2"].map(target_gid_to_city)
    if set(cities["city"]) != set(CITIES):
        raise BakeBlocked(
            "city-demand-allocation-draft",
            [f"GADM missing {city}" for city in sorted(set(CITIES) - set(cities["city"]))],
            "Need all Wuhan 1+8 GADM level-2 city geometries before city allocation audit.",
        )

    projection = "EPSG:6933"
    sub_proj = subbasins[["id", "sourceBasinId", "pfafId", "hybasId", "geometry"]].to_crs(projection).copy()
    city_proj = cities[["city", "NAME_2", "GID_2", "geometry"]].to_crs(projection).copy()
    sub_proj["geometry"] = sub_proj.geometry.buffer(0)
    city_proj["geometry"] = city_proj.geometry.buffer(0)
    sub_area_m2 = {str(row["id"]): float(row.geometry.area) for _, row in sub_proj.iterrows()}
    city_area_m2 = {str(row["city"]): float(row.geometry.area) for _, row in city_proj.iterrows()}
    sub_geom_by_id = {str(row["id"]): row.geometry for _, row in sub_proj.iterrows()}

    def basin_proxy(basin_id: str, key: str, basin_fraction: float) -> float:
        landpop = landpop_by_id[basin_id]
        if key == "agri":
            return max(0.0, float(landpop["clcd_cropland_ha"]) * basin_fraction)
        if key == "urban":
            return max(0.0, float(landpop["worldpop_population"]) * basin_fraction)
        if key == "industry":
            if nightlight_ids_match:
                return max(0.0, float(nightlight_by_id[basin_id].get("ind_weight_wb_len", 0) or 0) * basin_fraction)
            return max(0.0, float(landpop["clcd_builtup_ha"]) * basin_fraction)
        if key == "eco":
            natural_ha = max(
                float(landpop["sub_area_km2"]) * 100.0
                - float(landpop["clcd_cropland_ha"])
                - float(landpop["clcd_builtup_ha"]),
                0.0,
            )
            return natural_ha * basin_fraction
        raise ValueError(key)

    weight_rows: list[dict[str, object]] = []
    proxy_by_city_sector: dict[tuple[str, str], float] = {}
    city_intersection_area_m2 = {city: 0.0 for city in CITIES}
    for _, city in city_proj.sort_values("city").iterrows():
        city_name = str(city["city"])
        city_geom = city.geometry
        for basin_id in order:
            sub_geom = sub_geom_by_id[basin_id]
            if not city_geom.intersects(sub_geom):
                continue
            intersection = city_geom.intersection(sub_geom)
            area_m2 = float(intersection.area)
            if area_m2 <= 1.0:
                continue
            basin_fraction = area_m2 / sub_area_m2[basin_id] if sub_area_m2[basin_id] else 0.0
            city_fraction = area_m2 / city_area_m2[city_name] if city_area_m2[city_name] else 0.0
            proxies = {
                sector: basin_proxy(basin_id, sector, basin_fraction)
                for sector in SECTORS
            }
            city_intersection_area_m2[city_name] += area_m2
            for sector, value in proxies.items():
                proxy_by_city_sector[(city_name, sector)] = proxy_by_city_sector.get((city_name, sector), 0.0) + value
            weight_rows.append(
                {
                    "city": city_name,
                    "city_gid": city["GID_2"],
                    "city_name_gadm": city["NAME_2"],
                    "basin_id": basin_id,
                    "candidate_source_basin_id": sub_attrs_by_id[basin_id]["sourceBasinId"],
                    "candidate_pfaf_id": sub_attrs_by_id[basin_id]["pfafId"],
                    "candidate_hybas_id": sub_attrs_by_id[basin_id]["hybasId"],
                    "intersection_area_km2": round(area_m2 / 1_000_000.0, 6),
                    "city_area_fraction": round(city_fraction, 12),
                    "basin_area_fraction": round(basin_fraction, 12),
                    "agri_proxy": round(proxies["agri"], 12),
                    "industry_proxy": round(proxies["industry"], 12),
                    "urban_proxy": round(proxies["urban"], 12),
                    "eco_proxy": round(proxies["eco"], 12),
                    "industry_proxy_source": "world_bank_light_every_night_12month_interpolated_ind_weight_wb_len"
                    if nightlight_ids_match
                    else "clcd_builtup_ha_fallback",
                    "draft": True,
                }
            )

    if not weight_rows:
        raise BakeBlocked(
            "city-demand-allocation-draft",
            [subbasins_path, gadm_path],
            "No city/subbasin intersections were found for the allocation audit.",
        )

    unit_multiplier = 100_000_000.0
    allocation_rows: list[dict[str, object]] = []
    city_target_by_sector = {
        city: {
            "agri": float(row["old_agri"]) * unit_multiplier,
            "industry": float(row["old_industry"]) * unit_multiplier,
            "urban": float(row["old_life"]) * unit_multiplier,
            "eco": float(row["new_ecology"]) * unit_multiplier,
        }
        for city, row in city_rows_by_city.items()
    }
    for weight in weight_rows:
        city = str(weight["city"])
        basin_id = str(weight["basin_id"])
        allocations: dict[str, float] = {}
        for sector in SECTORS:
            proxy_total = proxy_by_city_sector.get((city, sector), 0.0)
            sector_proxy = float(weight[f"{sector}_proxy"])
            if proxy_total <= 0:
                proxy_total = city_intersection_area_m2[city]
                sector_proxy = float(weight["intersection_area_km2"]) * 1_000_000.0
            allocations[sector] = city_target_by_sector[city][sector] * sector_proxy / proxy_total if proxy_total > 0 else 0.0
        allocation_rows.append(
            {
                "city": city,
                "basin_id": basin_id,
                "agri_m3": round(allocations["agri"], 3),
                "industry_m3": round(allocations["industry"], 3),
                "urban_m3": round(allocations["urban"], 3),
                "eco_new_caliber_m3": round(allocations["eco"], 3),
                "old_caliber_total_m3": round(allocations["agri"] + allocations["industry"] + allocations["urban"], 3),
                "city_area_fraction": weight["city_area_fraction"],
                "basin_area_fraction": weight["basin_area_fraction"],
                "industry_proxy_source": weight["industry_proxy_source"],
                "draft": True,
                "method": "audit_only_city_bulletin_to_hydrobasins_overlay_proxy",
            }
        )

    city_checks = {}
    for city in CITIES:
        city_allocations = [row for row in allocation_rows if row["city"] == city]
        target = city_target_by_sector[city]
        city_checks[city] = {
            "intersectionAreaKm2": round(city_intersection_area_m2[city] / 1_000_000.0, 6),
            "gadmAreaKm2": round(city_area_m2[city] / 1_000_000.0, 6),
            "coverageFraction": round(city_intersection_area_m2[city] / city_area_m2[city], 12) if city_area_m2[city] else 0,
            "intersectingSubbasinCount": len({row["basin_id"] for row in city_allocations}),
            "sectorAllocatedM3": {
                "agri": round(sum(float(row["agri_m3"]) for row in city_allocations), 3),
                "industry": round(sum(float(row["industry_m3"]) for row in city_allocations), 3),
                "urban": round(sum(float(row["urban_m3"]) for row in city_allocations), 3),
                "eco": round(sum(float(row["eco_new_caliber_m3"]) for row in city_allocations), 3),
            },
            "sectorTargetM3": {sector: round(value, 3) for sector, value in target.items()},
        }
        city_checks[city]["maxAbsSectorErrorM3"] = round(
            max(
                abs(city_checks[city]["sectorAllocatedM3"][sector] - city_checks[city]["sectorTargetM3"][sector])
                for sector in SECTORS
            ),
            6,
        )

    basin_totals = {}
    for basin_id in order:
        basin_allocations = [row for row in allocation_rows if row["basin_id"] == basin_id]
        basin_totals[basin_id] = {
            "agriM3": round(sum(float(row["agri_m3"]) for row in basin_allocations), 3),
            "industryM3": round(sum(float(row["industry_m3"]) for row in basin_allocations), 3),
            "urbanM3": round(sum(float(row["urban_m3"]) for row in basin_allocations), 3),
            "ecoNewCaliberM3": round(sum(float(row["eco_new_caliber_m3"]) for row in basin_allocations), 3),
            "cityCount": len({row["city"] for row in basin_allocations}),
        }

    weights_path = INTERMEDIATE_DIR / "city_basin_weights_draft.csv"
    allocation_path = INTERMEDIATE_DIR / "city_demand_allocation_draft.csv"
    metadata_path = INTERMEDIATE_DIR / "city_demand_allocation_draft_metadata.json"
    zonal_metadata = read_metadata(zonal_metadata_path)
    world_bank_len_approved = bool(
        nightlight_ids_match
        and zonal_metadata.get("industrialProxyApprovedForFullBake") is True
        and zonal_metadata.get("worldBankLenProxyApprovedForFullBake") is True
    )
    write_csv(weights_path, weight_rows)
    write_csv(allocation_path, allocation_rows)
    metadata = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "step": "city-demand-allocation-draft",
        "draft": True,
        "auditOnly": True,
        "needsHumanReview": True,
        "formalOutputWritten": False,
        "cityAllocationDraftReady": True,
        "cityAllocationReady": False,
        "demandReady": False,
        "fullBakeReady": False,
        "mustNotSatisfyFullBake": True,
        "outputs": {
            "weights": rel(weights_path),
            "allocation": rel(allocation_path),
        },
        "sourceInputs": {
            "gadm": rel(gadm_path),
            "subbasins": rel(subbasins_path),
            "topology": rel(topology_path),
            "landpop": rel(landpop_path),
            "zonalMetadata": rel(zonal_metadata_path),
            "nightlightDraft": rel(nightlight_path) if nightlight_path.exists() else None,
            "bulletinDraft": rel(bulletin_path),
            "demandDraftMetadata": rel(demand_metadata_path),
        },
        "subbasinCount": len(order),
        "cityCount": len(CITIES),
        "weightRowCount": len(weight_rows),
        "allocationRowCount": len(allocation_rows),
        "industryProxySource": "world_bank_light_every_night_12month_interpolated_ind_weight_wb_len"
        if nightlight_ids_match
        else "clcd_builtup_ha_fallback",
        "preferredViirsReady": False,
        "nightlightDraftIdsMatchTopology": nightlight_ids_match,
        "worldBankLen10MonthProxyUsed": False,
        "worldBankLen12MonthInterpolatedProxyUsed": nightlight_ids_match,
        "industrialProxyApprovedForFullBake": world_bank_len_approved,
        "worldBankLenProxyApprovedForFullBake": world_bank_len_approved,
        "missingNightlightMonthsAfterInterpolation": (
            sorted({month for row in nightlight_by_id.values() for month in row.get("missing_months", "").split("|") if month})
            if nightlight_ids_match
            else []
        ),
        "cityChecks": city_checks,
        "basinTotalsPreview": basin_totals,
        "limitations": [
            "Audit-only city allocation draft over the current AOI-clipped Pfafstetter level_6 subbasins.",
            "Sector proxies use basin-level totals multiplied by city/basin overlap fraction, not raster class totals recomputed inside each intersection.",
            "Industrial allocation uses the documented WB LEN 12-month interpolated fallback when nightlight IDs match the topology.",
            "Does not write intermediate/demand.csv and does not set demandReady.",
        ],
    }
    write_json(metadata_path, metadata)
    print(f"DRAFT wrote {rel(weights_path)}")
    print(f"DRAFT wrote {rel(allocation_path)}")
    print(f"DRAFT wrote {rel(metadata_path)}")
    print(
        "City demand allocation draft: "
        f"{len(CITIES)} cities, {len(order)} topology nodes, {len(allocation_rows)} city-basin allocation rows"
    )
    print("DRAFT ONLY: demand.csv and cityAllocationReady remain locked pending formal approval.")
    return [weights_path, allocation_path, metadata_path]


def step_demand_real(_: argparse.Namespace) -> list[Path]:
    ensure_dirs()
    topology_path = INTERMEDIATE_DIR / "topology.json"
    zonal_metadata_path = INTERMEDIATE_DIR / "zonal_metadata.json"
    demand_draft_path = INTERMEDIATE_DIR / "demand_draft.csv"
    demand_draft_metadata_path = INTERMEDIATE_DIR / "demand_draft_metadata.json"
    city_allocation_path = INTERMEDIATE_DIR / "city_demand_allocation_draft.csv"
    city_allocation_metadata_path = INTERMEDIATE_DIR / "city_demand_allocation_draft_metadata.json"
    for path in [
        topology_path,
        zonal_metadata_path,
        demand_draft_path,
        demand_draft_metadata_path,
        city_allocation_path,
        city_allocation_metadata_path,
    ]:
        if not path.exists():
            raise BakeBlocked("demand", [path], "Need formal zonal output plus demand/city allocation drafts before demand.")

    zonal_metadata = read_metadata(zonal_metadata_path)
    draft_metadata = read_metadata(demand_draft_metadata_path)
    city_metadata = read_metadata(city_allocation_metadata_path)
    for flag in ["formalOutputWritten", "rasterStatsReady", "industrialProxyApprovedForFullBake", "fullBakeReady"]:
        if zonal_metadata.get(flag) is not True:
            raise BakeBlocked("demand", [f"{rel(zonal_metadata_path)}:{flag}=true"], "Need formal zonal readiness before demand.")
    if draft_metadata.get("industrialProxyApprovedForFullBake") is not True:
        raise BakeBlocked("demand", [demand_draft_metadata_path], "Need approved industrial proxy in demand draft metadata.")
    if city_metadata.get("cityAllocationDraftReady") is not True:
        raise BakeBlocked("demand", [city_allocation_metadata_path], "Need city allocation draft before formal demand.")

    topology = read_topology(required=True, step="demand")
    order = topology_order(topology, "demand")
    allocation_rows = load_csv_rows(city_allocation_path)
    demand_draft_by_id = {row["id"]: row for row in load_csv_rows(demand_draft_path)}
    basin_totals = {basin_id: {sector: 0 for sector in SECTORS} for basin_id in order}
    city_sector_demand = {city: {sector: 0 for sector in SECTORS} for city in CITIES}
    basin_cities: dict[str, set[str]] = {basin_id: set() for basin_id in order}
    for row in allocation_rows:
        city = str(row.get("city", ""))
        basin_id = str(row.get("basin_id", ""))
        if city not in city_sector_demand or basin_id not in basin_totals:
            continue
        values = {
            "agri": csv_int(row, "agri_m3"),
            "industry": csv_int(row, "industry_m3"),
            "urban": csv_int(row, "urban_m3"),
            "eco": csv_int(row, "eco_new_caliber_m3"),
        }
        for sector, value in values.items():
            basin_totals[basin_id][sector] += value
            city_sector_demand[city][sector] += value
        if any(value > 0 for value in values.values()):
            basin_cities[basin_id].add(city)

    missing = [basin_id for basin_id, totals in basin_totals.items() if basin_id not in demand_draft_by_id or not any(totals.values())]
    if missing:
        raise BakeBlocked("demand", [f"missing demand for {basin_id}" for basin_id in missing[:10]], "Every topology node needs demand.")

    rows: list[dict[str, object]] = []
    for basin_id in order:
        draft = demand_draft_by_id[basin_id]
        totals = basin_totals[basin_id]
        rows.append(
            {
                "id": basin_id,
                "downstream": topology[basin_id],
                "agri": totals["agri"],
                "industry": totals["industry"],
                "urban": totals["urban"],
                "eco": totals["eco"],
                "agri_m3": totals["agri"],
                "industry_m3": totals["industry"],
                "urban_m3": totals["urban"],
                "eco_m3": totals["eco"],
                "old_caliber_total_m3": totals["agri"] + totals["industry"] + totals["urban"],
                "admin_cities": "|".join(sorted(basin_cities[basin_id])),
                "industry_proxy_source": draft.get("industry_proxy_source", ""),
                "method": "formal_city_bulletin_overlay_downscale_wb_len_12month_interpolated",
            }
        )

    sector_totals = {sector: sum(row[sector] for row in rows) for sector in SECTORS}
    city_sector_sums = {sector: sum(city_sector_demand[city][sector] for city in CITIES) for sector in SECTORS}
    if sector_totals != city_sector_sums:
        raise BakeBlocked("demand", ["sector total mismatch"], "Basin and city demand totals must be identical.")

    output_path = INTERMEDIATE_DIR / "demand.csv"
    metadata_path = INTERMEDIATE_DIR / "demand_metadata.json"
    write_csv(output_path, rows)
    metadata = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "step": "demand",
        "formalOutputWritten": True,
        "demandReady": True,
        "cityAllocationReady": True,
        "industrialProxyApprovedForFullBake": True,
        "worldBankLenProxyApprovedForFullBake": True,
        "fullBakeReady": True,
        "subbasinCount": len(rows),
        "sourceInputs": {
            "zonalMetadata": rel(zonal_metadata_path),
            "demandDraft": rel(demand_draft_path),
            "cityAllocationDraft": rel(city_allocation_path),
            "topology": rel(topology_path),
        },
        "sectorTotalsM3": sector_totals,
        "citySectorDemandM3": city_sector_demand,
        "checks": {
            "idsMatchTopology": set(row["id"] for row in rows) == set(order),
            "citySetComplete": sorted(city_sector_demand) == sorted(CITIES),
            "citySectorSumsMatchSectorTotals": sector_totals == city_sector_sums,
        },
        "limitations": [
            "Formal demand uses city-level bulletin totals overlaid onto Pfafstetter subbasins with basin-level proxies.",
            "Industrial distribution uses the approved WB LEN 12-month interpolated fallback, not EOG Annual VNL.",
        ],
    }
    write_json(metadata_path, metadata)
    print(f"REAL wrote {rel(output_path)}")
    print(f"REAL wrote {rel(metadata_path)}")
    print(f"Demand formal totals: {sector_totals}")
    return [output_path, metadata_path]


def step_supply_draft(_: argparse.Namespace) -> list[Path]:
    ensure_dirs()
    climate_path = INTERMEDIATE_DIR / "zonal_climate.csv"
    topology_path = INTERMEDIATE_DIR / "topology.json"
    zonal_metadata_path = INTERMEDIATE_DIR / "zonal_metadata.json"
    subbasins_metadata_path = INTERMEDIATE_DIR / "subbasins_metadata.json"
    for path in [climate_path, topology_path, zonal_metadata_path, subbasins_metadata_path]:
        if not path.exists():
            raise BakeBlocked(
                "supply-draft",
                [path],
                "Need subbasins, topology, and partial climate zonal evidence before writing a supply audit draft.",
            )

    zonal_metadata = read_metadata(zonal_metadata_path)
    subbasins_metadata = read_metadata(subbasins_metadata_path)
    if zonal_metadata.get("climateStatsReady") is not True:
        raise BakeBlocked(
            "supply-draft",
            [f"{rel(zonal_metadata_path)}:climateStatsReady=true"],
            "Need climateStatsReady metadata before supply draft.",
        )
    if subbasins_metadata.get("subbasinsReady") is not True:
        raise BakeBlocked(
            "supply-draft",
            [f"{rel(subbasins_metadata_path)}:subbasinsReady=true"],
            "Need subbasinsReady metadata before supply draft.",
        )

    topology = read_topology(required=True, step="supply-draft")
    order = topology_order(topology, "supply-draft")
    upstreams = upstream_index(topology)
    climate_by_id = {row["id"]: row for row in load_csv_rows(climate_path)}
    missing_rows = [basin_id for basin_id in order if basin_id not in climate_by_id]
    if missing_rows:
        raise BakeBlocked(
            "supply-draft",
            [f"{rel(climate_path)} missing {basin_id}" for basin_id in missing_rows[:10]],
            "Every topology node needs a zonal climate row before supply draft.",
        )

    runoff_coeff = 0.40
    q_local: dict[str, float] = {}
    q_avail: dict[str, float] = {}
    rows: list[dict[str, object]] = []
    for basin_id in order:
        climate = climate_by_id[basin_id]
        area_km2 = float(climate["area_km2"])
        precip_mm = float(climate["precip_mm"])
        local_m3 = max(0.0, area_km2 * precip_mm * 1000.0 * runoff_coeff)
        upstream_inflow_m3 = sum(q_avail[upstream_id] for upstream_id in upstreams.get(basin_id, []))
        avail_no_mainstem_m3 = local_m3 + upstream_inflow_m3
        q_local[basin_id] = local_m3
        q_avail[basin_id] = avail_no_mainstem_m3
        rows.append(
            {
                "id": basin_id,
                "area_km2": round(area_km2, 3),
                "precip_mm": round(precip_mm, 3),
                "runoff_coeff": runoff_coeff,
                "q_local_m3": round(local_m3, 3),
                "q_local_million_m3": round(local_m3 / 1_000_000, 6),
                "upstream_inflow_m3": round(upstream_inflow_m3, 3),
                "q_avail_no_mainstem_m3": round(avail_no_mainstem_m3, 3),
                "q_avail_no_mainstem_million_m3": round(avail_no_mainstem_m3 / 1_000_000, 6),
                "mainstem_inflow_m3": 0,
                "q_avail_with_documented_mainstem_m3": round(avail_no_mainstem_m3, 3),
                "downstream": topology[basin_id],
                "method": "audit_only_precip_area_runoff_no_withdrawals_no_mainstem",
            }
        )

    outlet_facing = [basin_id for basin_id, downstream in topology.items() if downstream == "OUTLET"]
    outlet_no_mainstem_m3 = sum(q_avail[basin_id] for basin_id in outlet_facing)
    q_local_total_m3 = sum(q_local.values())
    output_path = INTERMEDIATE_DIR / "supply_draft.csv"
    metadata_path = INTERMEDIATE_DIR / "supply_draft_metadata.json"
    mainstem_inflow_draft_path = INTERMEDIATE_DIR / "mainstem_inflow_draft.csv"
    mainstem_inflow_metadata_path = INTERMEDIATE_DIR / "mainstem_inflow_draft_metadata.json"
    mainstem_node_mapping_draft_path = INTERMEDIATE_DIR / "mainstem_node_mapping_draft.csv"
    mainstem_node_mapping_metadata_path = INTERMEDIATE_DIR / "mainstem_node_mapping_draft_metadata.json"
    write_csv(output_path, rows)
    metadata = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "step": "supply-draft",
        "draft": True,
        "needsHumanReview": True,
        "formalOutput": rel(INTERMEDIATE_DIR / "supply.csv"),
        "formalOutputWritten": False,
        "supplyReady": False,
        "fullBakeReady": False,
        "mustNotSatisfyFullBake": True,
        "subbasinCount": len(rows),
        "runoffCoeff": runoff_coeff,
        "sourceInputs": {
            "climate": rel(climate_path),
            "topology": rel(topology_path),
            "zonalMetadata": rel(zonal_metadata_path),
            "subbasinsMetadata": rel(subbasins_metadata_path),
            "mainstemInflowDraft": rel(mainstem_inflow_draft_path) if mainstem_inflow_draft_path.exists() else None,
            "mainstemInflowMetadata": rel(mainstem_inflow_metadata_path) if mainstem_inflow_metadata_path.exists() else None,
            "mainstemNodeMappingDraft": rel(mainstem_node_mapping_draft_path) if mainstem_node_mapping_draft_path.exists() else None,
            "mainstemNodeMappingMetadata": rel(mainstem_node_mapping_metadata_path) if mainstem_node_mapping_metadata_path.exists() else None,
        },
        "checks": {
            "topologyOrderLength": len(order),
            "topologyAcyclic": True,
            "qLocalTotalM3": round(q_local_total_m3, 3),
            "qLocalTotalMillionM3": round(q_local_total_m3 / 1_000_000, 6),
            "outletNoMainstemM3": round(outlet_no_mainstem_m3, 3),
            "outletNoMainstemMillionM3": round(outlet_no_mainstem_m3 / 1_000_000, 6),
            "outletFacingSubbasins": outlet_facing,
        },
        "limitations": [
            "Audit-only T1.5 draft from NASA POWER precipitation, approved Pfafstetter level_6 topology, and RUNOFF_COEFF=0.40.",
            "No demand or withdrawals are consumed; this is a no-withdrawal routed availability diagnostic.",
            "Mainstem external inflow is not injected here; mainstem-inflow-draft is source evidence only and mainstemInjectionReady remains false.",
            "Does not write intermediate/supply.csv and does not set supplyReady.",
            "Formal supply remains gated on real demand metadata, documented mainstem inflow handling, and final-approved subbasins.",
        ],
        "mainstemInjectionReady": False,
        "mainstemInflowDraftAvailable": mainstem_inflow_draft_path.exists(),
        "mainstemNodeMappingDraftAvailable": mainstem_node_mapping_draft_path.exists(),
        "demandConsumed": False,
    }
    write_json(metadata_path, metadata)
    print(f"DRAFT wrote {rel(output_path)}")
    print(f"DRAFT wrote {rel(metadata_path)}")
    print(
        "Supply draft totals: "
        f"local={metadata['checks']['qLocalTotalMillionM3']} million m3, "
        f"outlet-no-mainstem={metadata['checks']['outletNoMainstemMillionM3']} million m3"
    )
    print("DRAFT ONLY: supply.csv and supplyReady remain locked pending real demand and mainstem inflow treatment.")
    return [output_path, metadata_path]


def step_supply_real(_: argparse.Namespace) -> list[Path]:
    ensure_dirs()
    demand_path = INTERMEDIATE_DIR / "demand.csv"
    demand_metadata_path = INTERMEDIATE_DIR / "demand_metadata.json"
    supply_draft_path = INTERMEDIATE_DIR / "supply_draft.csv"
    supply_draft_metadata_path = INTERMEDIATE_DIR / "supply_draft_metadata.json"
    injection_plan_path = INTERMEDIATE_DIR / "mainstem_injection_plan_draft.csv"
    injection_plan_metadata_path = INTERMEDIATE_DIR / "mainstem_injection_plan_draft_metadata.json"
    topology_path = INTERMEDIATE_DIR / "topology.json"
    for path in [
        demand_path,
        demand_metadata_path,
        supply_draft_path,
        supply_draft_metadata_path,
        injection_plan_path,
        injection_plan_metadata_path,
        topology_path,
    ]:
        if not path.exists():
            raise BakeBlocked("supply", [path], "Need formal demand and mainstem injection evidence before supply.")
    demand_metadata = read_metadata(demand_metadata_path)
    if demand_metadata.get("demandReady") is not True or demand_metadata.get("formalOutputWritten") is not True:
        raise BakeBlocked("supply", [demand_metadata_path], "Need formal demand metadata before supply.")

    topology = read_topology(required=True, step="supply")
    order = topology_order(topology, "supply")
    upstreams = upstream_index(topology)
    supply_draft_by_id = {row["id"]: row for row in load_csv_rows(supply_draft_path)}
    missing_supply = [basin_id for basin_id in order if basin_id not in supply_draft_by_id]
    if missing_supply:
        raise BakeBlocked("supply", [f"missing supply draft {basin_id}" for basin_id in missing_supply[:10]], "Every node needs supply draft.")

    missing_injection_nodes = sorted(set(APPROVED_MAINSTEM_TRANSIT_INJECTIONS) - set(topology))
    if missing_injection_nodes:
        raise BakeBlocked(
            "supply",
            missing_injection_nodes,
            "Approved PRE-1 mainstem transit injection nodes must exist in topology before supply routing.",
        )

    approved_source_node_pairs = {
        (str(item["sourceFlowId"]), basin_id) for basin_id, item in APPROVED_MAINSTEM_TRANSIT_INJECTIONS.items()
    }
    excluded_injection_candidates = []
    for row in load_csv_rows(injection_plan_path):
        source_flow_id = str(row.get("source_flow_id", ""))
        if not str(row.get("plan_status", "")).startswith("candidate_unapproved"):
            continue
        basin_id = row.get("candidate_subbasin_id", "")
        if (source_flow_id, basin_id) in approved_source_node_pairs:
            continue
        if basin_id not in topology:
            continue
        inflow = csv_int(row, "candidate_inflow_m3_if_approved")
        excluded_injection_candidates.append(
            {
                "sourceFlowId": source_flow_id,
                "sourceLabel": row.get("source_label"),
                "candidateSubbasinId": basin_id,
                "inflowM3": inflow,
                "confidence": row.get("candidate_confidence", "low"),
                "planStatus": row.get("plan_status"),
                "exclusionReason": "Alternative provincial-boundary injection candidate is not selected by the PRE-1 approved two-node rule.",
            }
        )

    q_local_by_id = {basin_id: csv_int(supply_draft_by_id[basin_id], "q_local_m3") for basin_id in order}
    mainstem_injection_by_id = {
        basin_id: int(item["annualInflowM3"]) for basin_id, item in APPROVED_MAINSTEM_TRANSIT_INJECTIONS.items()
    }
    outlet_facing = [basin_id for basin_id, downstream in topology.items() if downstream == "OUTLET"]

    def routed_availability_with_transit_scale(scale: float) -> dict[str, object]:
        scaled_q_avail: dict[str, int] = {}
        for basin_id in order:
            upstream_inflow = sum(scaled_q_avail[upstream_id] for upstream_id in upstreams.get(basin_id, []))
            scaled_external_inflow = int(round(mainstem_injection_by_id.get(basin_id, 0) * scale))
            scaled_q_avail[basin_id] = q_local_by_id[basin_id] + upstream_inflow + scaled_external_inflow
        selected_nodes = [
            basin_id
            for basin_id in ["PF_465610", "PF_465500", "PF_465309", "PF_465100", "PF_463099"]
            if basin_id in scaled_q_avail
        ]
        return {
            "transitScale": scale,
            "externalInflowTotalM3": int(round(APPROVED_MAINSTEM_TRANSIT_INFLOW_TOTAL_M3 * scale)),
            "selectedQAvailM3": {basin_id: scaled_q_avail[basin_id] for basin_id in selected_nodes},
            "outletFacingQAvailTotalM3": sum(scaled_q_avail[basin_id] for basin_id in outlet_facing),
        }

    q_avail: dict[str, int] = {}
    rows: list[dict[str, object]] = []
    for basin_id in order:
        draft = supply_draft_by_id[basin_id]
        q_local = q_local_by_id[basin_id]
        upstream_inflow = sum(q_avail[upstream_id] for upstream_id in upstreams.get(basin_id, []))
        mainstem_inflow = mainstem_injection_by_id.get(basin_id, 0)
        external_inflow = mainstem_inflow
        q_avail_value = q_local + upstream_inflow + external_inflow
        q_avail[basin_id] = q_avail_value
        rows.append(
            {
                "id": basin_id,
                "qLocal": q_local,
                "qAvail": q_avail_value,
                "externalInflow": external_inflow,
                "mainstemInflow": mainstem_inflow,
                "q_local_m3": q_local,
                "upstream_inflow_m3": upstream_inflow,
                "q_avail_m3": q_avail_value,
                "runoffCoeff": csv_float(draft, "runoff_coeff"),
                "downstream": topology[basin_id],
                "method": "formal_local_runoff_with_pre1_provincial_boundary_transit_injection"
                if external_inflow
                else "formal_local_runoff_routed_with_pre1_upstream_transit",
            }
        )

    output_path = INTERMEDIATE_DIR / "supply.csv"
    metadata_path = INTERMEDIATE_DIR / "supply_metadata.json"
    write_csv(output_path, rows)
    metadata = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "step": "supply",
        "formalOutputWritten": True,
        "supplyReady": True,
        "mainstemTreatmentApprovedForFullBake": True,
        "mainstemInjectionReady": True,
        "spatialInjectionAssigned": True,
        "mainstemCandidateInflowsExcludedFromQAvail": False,
        "fullBakeReady": True,
        "subbasinCount": len(rows),
        "sourceInputs": {
            "demand": rel(demand_path),
            "demandMetadata": rel(demand_metadata_path),
            "supplyDraft": rel(supply_draft_path),
            "mainstemInjectionPlanDraft": rel(injection_plan_path),
            "topology": rel(topology_path),
        },
        "mainstemInjectionRule": {
            "method": "PRE-1 approved two-node non-additive transit injection using Hubei Bulletin 2022 table 5 provincial-boundary mainstem inflows.",
            "confidence": "low_node_assignment_provincial_boundary_proxy",
            "externalInflowPolicy": "inject_approved_yangtze_and_han_mainstem_entries",
            "mainstemInflowPolicy": "duplicate_external_inflow_for_documentation_only",
            "candidateInflowsExcludedFromQAvail": False,
            "approvedInjections": [
                {
                    "subbasinId": basin_id,
                    "sourceFlowId": item["sourceFlowId"],
                    "sourceLabel": item["sourceLabel"],
                    "annualInflowM3": item["annualInflowM3"],
                    "basis": item["basis"],
                    "confidence": item["confidence"],
                }
                for basin_id, item in APPROVED_MAINSTEM_TRANSIT_INJECTIONS.items()
            ],
            "excludedAggregates": [
                "province_total",
                "han_system_entry",
            ],
            "excludedCandidates": excluded_injection_candidates,
        },
        "checks": {
            "idsMatchTopology": set(row["id"] for row in rows) == set(order),
            "mainstemInflowTotalM3": sum(row["mainstemInflow"] for row in rows),
            "externalInflowTotalM3": sum(row["externalInflow"] for row in rows),
            "expectedExternalInflowTotalM3": APPROVED_MAINSTEM_TRANSIT_INFLOW_TOTAL_M3,
            "externalInflowMatchesApprovedTotal": sum(row["externalInflow"] for row in rows)
            == APPROVED_MAINSTEM_TRANSIT_INFLOW_TOTAL_M3,
            "excludedCandidateInflowTotalM3": sum(item["inflowM3"] for item in excluded_injection_candidates),
            "qLocalTotalM3": sum(row["qLocal"] for row in rows),
            "outletFacingSubbasins": outlet_facing,
            "transitSensitivityQAvail": {
                "minus50pct": routed_availability_with_transit_scale(0.5),
                "baseline": routed_availability_with_transit_scale(1.0),
                "plus50pct": routed_availability_with_transit_scale(1.5),
            },
        },
        "limitations": [
            "PRE-1 uses Hubei bulletin provincial-boundary mainstem inflows as AOI transit proxies; these are not measured Wuhan 1+8 boundary flows.",
            "The province-total, Han-system aggregate, and alternative candidate nodes are excluded to avoid double counting.",
            "Injection nodes are low-confidence HydroRIVERS/topology matches because river names are not independently available in the routing vector.",
            "externalInflow duplicates mainstemInflow because the front-end model consumes externalInflow as the routed transit injection field.",
            "No withdrawals are subtracted in qAvail; market allocation handles withdrawals in the front-end model.",
        ],
    }
    write_json(metadata_path, metadata)
    print(f"REAL wrote {rel(output_path)}")
    print(f"REAL wrote {rel(metadata_path)}")
    print(
        "Supply formal totals: "
        f"qLocal={metadata['checks']['qLocalTotalM3']} m3, "
        f"mainstem={metadata['checks']['mainstemInflowTotalM3']} m3"
    )
    return [output_path, metadata_path]


def step_health_reach_draft(_: argparse.Namespace) -> list[Path]:
    ensure_dirs()
    landpop_path = INTERMEDIATE_DIR / "zonal_landpop.csv"
    topology_path = INTERMEDIATE_DIR / "topology.json"
    zonal_metadata_path = INTERMEDIATE_DIR / "zonal_metadata.json"
    for path in [landpop_path, topology_path, zonal_metadata_path]:
        if not path.exists():
            raise BakeBlocked(
                "health-reach-draft",
                [path],
                "Need topology and partial WorldPop zonal evidence before writing a health reach audit draft.",
            )

    zonal_metadata = read_metadata(zonal_metadata_path)
    if zonal_metadata.get("landPopStatsReady") is not True:
        raise BakeBlocked(
            "health-reach-draft",
            [f"{rel(zonal_metadata_path)}:landPopStatsReady=true"],
            "Need landPopStatsReady metadata before health reach draft.",
        )

    topology = read_topology(required=True, step="health-reach-draft")
    order = topology_order(topology, "health-reach-draft")
    landpop_by_id = {row["id"]: row for row in load_csv_rows(landpop_path)}
    missing_rows = [basin_id for basin_id in order if basin_id not in landpop_by_id]
    if missing_rows:
        raise BakeBlocked(
            "health-reach-draft",
            [f"{rel(landpop_path)} missing {basin_id}" for basin_id in missing_rows[:10]],
            "Every topology node needs a land/population row before health reach draft.",
        )

    population_by_id = {basin_id: float(landpop_by_id[basin_id]["worldpop_population"]) for basin_id in order}
    records: dict[str, dict[str, object]] = {}
    weighted_values: list[float] = []
    for basin_id in order:
        reach = downstream_reach(basin_id, topology)
        affected = [target_id for target_id in reach if target_id != "OUTLET" and target_id in population_by_id]
        weighted_population = 0.0
        unweighted_population = 0.0
        exposure_terms = []
        for index, target_id in enumerate(affected):
            population = population_by_id[target_id]
            distance_weight = 1 / math.pow(index + 1, DOWNSTREAM_EXPOSURE_ATTENUATION)
            weighted_population += population * distance_weight
            unweighted_population += population
            exposure_terms.append(
                {
                    "target": target_id,
                    "population": round(population, 3),
                    "distanceWeight": round(distance_weight, 6),
                    "weightedPopulation": round(population * distance_weight, 3),
                }
            )
        weighted_values.append(weighted_population)
        records[basin_id] = {
            "id": basin_id,
            "population": round(population_by_id[basin_id], 3),
            "healthWeight": HEALTH_DRAFT_WEIGHTS,
            "downstreamReach": reach,
            "affectedSubbasins": affected,
            "affectedSubbasinCount": len(affected),
            "downstreamPopulation": round(unweighted_population, 3),
            "downstreamWeightedPopulation": round(weighted_population, 3),
            "downstreamExposureTerms": exposure_terms,
            "method": "audit_only_downstream_reach_worldpop_weighted_exposure",
        }

    output_path = INTERMEDIATE_DIR / "health_reach_draft.json"
    metadata_path = INTERMEDIATE_DIR / "health_reach_draft_metadata.json"
    payload = {
        "kind": "health-reach-draft",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "records": records,
    }
    write_json(output_path, payload)
    metadata = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "step": "health-reach-draft",
        "draft": True,
        "needsHumanReview": True,
        "formalOutput": rel(INTERMEDIATE_DIR / "health.json"),
        "formalMetadata": rel(INTERMEDIATE_DIR / "health_metadata.json"),
        "formalOutputWritten": False,
        "healthReady": False,
        "fullBakeReady": False,
        "mustNotSatisfyFullBake": True,
        "subbasinCount": len(records),
        "sourceInputs": {
            "landpop": rel(landpop_path),
            "topology": rel(topology_path),
            "zonalMetadata": rel(zonal_metadata_path),
        },
        "healthWeightDefault": HEALTH_DRAFT_WEIGHTS,
        "downstreamExposureAttenuation": DOWNSTREAM_EXPOSURE_ATTENUATION,
        "checks": {
            "topologyOrderLength": len(order),
            "topologyAcyclic": True,
            "worldpopPopulationTotal": round(sum(population_by_id.values()), 3),
            "maxDownstreamWeightedPopulation": round(max(weighted_values) if weighted_values else 0, 3),
            "nodesWithDownstreamPopulation": sum(1 for value in weighted_values if value > 0),
        },
        "limitations": [
            "Audit-only T1.6 draft from topology plus WorldPop partial zonal population.",
            "Health weights are model-default placeholders for reach/exposure QA, not final calibrated health burden coefficients.",
            "No real demand or supply metadata is consumed, and no formal health.json or health_metadata.json is written.",
            "Reach/exposure uses the approved Pfafstetter level_6 topology but remains a documented intermediate diagnostic.",
        ],
    }
    write_json(metadata_path, metadata)
    print(f"DRAFT wrote {rel(output_path)}")
    print(f"DRAFT wrote {rel(metadata_path)}")
    print(
        "Health reach draft: "
        f"{len(records)} subbasins, total population={metadata['checks']['worldpopPopulationTotal']}, "
        f"max weighted downstream population={metadata['checks']['maxDownstreamWeightedPopulation']}"
    )
    print("DRAFT ONLY: health.json and healthReady remain locked pending real demand/supply and final health weighting.")
    return [output_path, metadata_path]


def step_health_real(_: argparse.Namespace) -> list[Path]:
    ensure_dirs()
    demand_metadata_path = INTERMEDIATE_DIR / "demand_metadata.json"
    supply_metadata_path = INTERMEDIATE_DIR / "supply_metadata.json"
    health_draft_path = INTERMEDIATE_DIR / "health_reach_draft.json"
    health_draft_metadata_path = INTERMEDIATE_DIR / "health_reach_draft_metadata.json"
    topology_path = INTERMEDIATE_DIR / "topology.json"
    for path in [demand_metadata_path, supply_metadata_path, health_draft_path, health_draft_metadata_path, topology_path]:
        if not path.exists():
            raise BakeBlocked("health", [path], "Need formal demand/supply and health reach draft before health.")
    demand_metadata = read_metadata(demand_metadata_path)
    supply_metadata = read_metadata(supply_metadata_path)
    if demand_metadata.get("demandReady") is not True or demand_metadata.get("formalOutputWritten") is not True:
        raise BakeBlocked("health", [demand_metadata_path], "Need formal demand metadata before health.")
    if supply_metadata.get("supplyReady") is not True or supply_metadata.get("formalOutputWritten") is not True:
        raise BakeBlocked("health", [supply_metadata_path], "Need formal supply metadata before health.")

    topology = read_topology(required=True, step="health")
    health_payload = json.loads(health_draft_path.read_text(encoding="utf-8"))
    records = health_payload.get("records") if isinstance(health_payload, dict) else None
    if not isinstance(records, dict):
        raise BakeBlocked("health", [health_draft_path], "Health reach draft must contain records.")
    missing = sorted(set(topology) - set(records))
    extra = sorted(set(records) - set(topology))
    if missing or extra:
        raise BakeBlocked("health", [f"missing:{missing[:5]}", f"extra:{extra[:5]}"], "Health records must match topology.")

    output_records: dict[str, dict[str, object]] = {}
    for basin_id in sorted(topology):
        record = records[basin_id]
        output_records[basin_id] = {
            "healthWeight": record.get("healthWeight", HEALTH_DRAFT_WEIGHTS),
            "downstreamReach": downstream_reach(basin_id, topology),
            "affectedSubbasins": record.get("affectedSubbasins", []),
            "downstreamPopulation": record.get("downstreamPopulation", 0),
            "downstreamWeightedPopulation": record.get("downstreamWeightedPopulation", 0),
            "method": "formal_downstream_reach_worldpop_exposure_default_health_weights",
        }

    output_path = INTERMEDIATE_DIR / "health.json"
    metadata_path = INTERMEDIATE_DIR / "health_metadata.json"
    write_json(output_path, output_records)
    metadata = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "step": "health",
        "formalOutputWritten": True,
        "healthReady": True,
        "downstreamReachReady": True,
        "worldPopExposureReady": True,
        "healthWeightsCalibrated": False,
        "healthWeightPolicyApprovedForFullBake": True,
        "fullBakeReady": True,
        "subbasinCount": len(output_records),
        "sourceInputs": {
            "demandMetadata": rel(demand_metadata_path),
            "supplyMetadata": rel(supply_metadata_path),
            "healthReachDraft": rel(health_draft_path),
            "topology": rel(topology_path),
        },
        "checks": {
            "idsMatchTopology": set(output_records) == set(topology),
            "allReachMatchesTopology": all(output_records[basin_id]["downstreamReach"] == downstream_reach(basin_id, topology) for basin_id in topology),
        },
        "limitations": [
            "Health weights are policy/default weights used for the model demonstration; they are not calibrated epidemiological burden coefficients.",
            "Downstream population exposure uses WorldPop zonal totals and topology reach attenuation.",
        ],
    }
    write_json(metadata_path, metadata)
    print(f"REAL wrote {rel(output_path)}")
    print(f"REAL wrote {rel(metadata_path)}")
    return [output_path, metadata_path]


def step_bake_preflight(_: argparse.Namespace) -> list[Path]:
    ensure_dirs()
    required_paths = [
        INTERMEDIATE_DIR / "subbasins_raw.geojson",
        INTERMEDIATE_DIR / "subbasins_metadata.json",
        INTERMEDIATE_DIR / "topology.json",
        INTERMEDIATE_DIR / "zonal_climate.csv",
        INTERMEDIATE_DIR / "zonal_landpop.csv",
        INTERMEDIATE_DIR / "zonal_metadata.json",
        INTERMEDIATE_DIR / "demand_draft.csv",
        INTERMEDIATE_DIR / "demand_draft_metadata.json",
        INTERMEDIATE_DIR / "city_demand_allocation_draft.csv",
        INTERMEDIATE_DIR / "city_demand_allocation_draft_metadata.json",
        INTERMEDIATE_DIR / "supply_draft.csv",
        INTERMEDIATE_DIR / "supply_draft_metadata.json",
        INTERMEDIATE_DIR / "mainstem_inflow_draft.csv",
        INTERMEDIATE_DIR / "mainstem_inflow_draft_metadata.json",
        INTERMEDIATE_DIR / "mainstem_node_mapping_draft.csv",
        INTERMEDIATE_DIR / "mainstem_node_mapping_draft_metadata.json",
        INTERMEDIATE_DIR / "rivers_flowthrough_draft.geojson",
        INTERMEDIATE_DIR / "rivers_flowthrough_draft_metadata.json",
        INTERMEDIATE_DIR / "mainstem_injection_plan_draft.csv",
        INTERMEDIATE_DIR / "mainstem_injection_plan_draft.json",
        INTERMEDIATE_DIR / "mainstem_injection_plan_draft_metadata.json",
        INTERMEDIATE_DIR / "health_reach_draft.json",
        INTERMEDIATE_DIR / "health_reach_draft_metadata.json",
    ]
    missing_required = [path for path in required_paths if not path.exists()]
    if missing_required:
        raise BakeBlocked(
            "bake-preflight",
            missing_required,
            "Need existing audit-only subbasin, zonal, demand, supply, and health reach products before bake preflight.",
        )

    subbasins = json.loads((INTERMEDIATE_DIR / "subbasins_raw.geojson").read_text(encoding="utf-8"))
    features = subbasins.get("features")
    if not isinstance(features, list):
        raise BakeBlocked("bake-preflight", [INTERMEDIATE_DIR / "subbasins_raw.geojson"], "Subbasin GeoJSON has no features.")
    subbasin_ids = {
        str(feature.get("properties", {}).get("id"))
        for feature in features
        if isinstance(feature, dict) and feature.get("properties", {}).get("id")
    }
    topology = read_topology(required=True, step="bake-preflight")
    topology_ids = set(topology)
    climate_rows = load_csv_rows(INTERMEDIATE_DIR / "zonal_climate.csv")
    landpop_rows = load_csv_rows(INTERMEDIATE_DIR / "zonal_landpop.csv")
    demand_rows = load_csv_rows(INTERMEDIATE_DIR / "demand_draft.csv")
    city_demand_rows = load_csv_rows(INTERMEDIATE_DIR / "city_demand_allocation_draft.csv")
    city_demand_metadata = read_metadata(INTERMEDIATE_DIR / "city_demand_allocation_draft_metadata.json")
    supply_rows = load_csv_rows(INTERMEDIATE_DIR / "supply_draft.csv")
    rivers_flowthrough_payload = json.loads((INTERMEDIATE_DIR / "rivers_flowthrough_draft.geojson").read_text(encoding="utf-8"))
    rivers_flowthrough_features = (
        rivers_flowthrough_payload.get("features", []) if isinstance(rivers_flowthrough_payload, dict) else []
    )
    rivers_flowthrough_metadata = read_metadata(INTERMEDIATE_DIR / "rivers_flowthrough_draft_metadata.json")
    mainstem_injection_plan_rows = load_csv_rows(INTERMEDIATE_DIR / "mainstem_injection_plan_draft.csv")
    mainstem_injection_plan_metadata = read_metadata(INTERMEDIATE_DIR / "mainstem_injection_plan_draft_metadata.json")
    health_payload = json.loads((INTERMEDIATE_DIR / "health_reach_draft.json").read_text(encoding="utf-8"))
    health_records = health_payload.get("records") if isinstance(health_payload, dict) else None
    if not isinstance(health_records, dict):
        raise BakeBlocked("bake-preflight", [INTERMEDIATE_DIR / "health_reach_draft.json"], "Health reach draft has no records object.")

    id_sets = {
        "subbasins": subbasin_ids,
        "topology": topology_ids,
        "zonalClimate": {row["id"] for row in climate_rows},
        "zonalLandPop": {row["id"] for row in landpop_rows},
        "demandDraft": {row["id"] for row in demand_rows},
        "supplyDraft": {row["id"] for row in supply_rows},
        "healthReachDraft": set(health_records),
    }
    canonical = topology_ids
    id_alignment = {}
    for name, ids in id_sets.items():
        id_alignment[name] = {
            "count": len(ids),
            "matchesTopology": ids == canonical,
            "missingFromTopology": sorted(canonical - ids)[:20],
            "extraNotInTopology": sorted(ids - canonical)[:20],
        }

    landpop_by_id = {row["id"]: row for row in landpop_rows}
    demand_by_id = {row["id"]: row for row in demand_rows}
    city_demand_basin_ids = {row["basin_id"] for row in city_demand_rows}
    city_demand_cities = {row["city"] for row in city_demand_rows}
    supply_by_id = {row["id"]: row for row in supply_rows}
    formal_demand_rows = load_csv_rows(INTERMEDIATE_DIR / "demand.csv") if (INTERMEDIATE_DIR / "demand.csv").exists() else []
    formal_supply_rows = load_csv_rows(INTERMEDIATE_DIR / "supply.csv") if (INTERMEDIATE_DIR / "supply.csv").exists() else []
    formal_health_payload = read_json_if_exists(INTERMEDIATE_DIR / "health.json")
    formal_health_ids = set(formal_health_payload) if isinstance(formal_health_payload, dict) else set()
    current_attrs = read_json_if_exists(DATA_DIR / "wuhan-attrs.json")
    current_attrs_meta = current_attrs.get("meta", {}) if isinstance(current_attrs, dict) else {}
    current_attrs_subbasins = current_attrs.get("subbasins", []) if isinstance(current_attrs, dict) else []

    contract_required = {
        "attrsTopLevel": ["meta", "topology", "sectorTotals", "citySectorDemand", "subbasins"],
        "subbasinFields": [
            "id",
            "name",
            "areaKm2",
            "population",
            "centroid",
            "adminCities",
            "demand",
            "supply",
            "healthWeight",
            "downstream",
            "downstreamReach",
        ],
        "demandSectors": SECTORS,
        "supplyFields": ["qLocal", "qAvail", "externalInflow", "mainstemInflow"],
        "healthWeightSectors": SECTORS,
        "citySet": CITIES,
        "riverProperties": ["id", "flowDirection", "fromSubbasin", "toSubbasin", "flowThrough", "downstreamSubbasin"],
    }
    current_bake_metadata = read_json_if_exists(INTERMEDIATE_DIR / "bake_metadata.json")
    final_data_contract_ready = (
        isinstance(current_bake_metadata, dict)
        and current_bake_metadata.get("dataContractReady") is True
        and current_bake_metadata.get("fullBakeReady") is True
        and current_attrs_meta.get("realDataReady") is True
        and current_attrs_meta.get("synthetic") is False
        and isinstance(current_attrs_subbasins, list)
        and len(current_attrs_subbasins) == len(canonical)
    )
    contract_gaps = [] if final_data_contract_ready else [
        "formal sectorTotals cannot be computed until real demand.csv is written.",
        "formal citySectorDemand cannot be computed until bulletin-calibrated city demand is joined.",
        "subbasin name/centroid/adminCities are not finalized in the audit-only partials.",
        f"formal demand.{{agri,industry,urban,eco}} is missing for all {len(canonical)} audit subbasins.",
        "formal supply.externalInflow/mainstemInflow is missing pending mainstem injection.",
        "formal health weights are draft-only until real demand/supply metadata are ready.",
        "formal wuhan-rivers.geojson has not been baked from the current HydroRIVERS/subbasin flowThrough draft.",
    ]
    city_allocation_audit = {
        "cityAllocationDraftReady": city_demand_metadata.get("cityAllocationDraftReady"),
        "cityAllocationReady": city_demand_metadata.get("cityAllocationReady"),
        "cityCount": city_demand_metadata.get("cityCount"),
        "allocationRowCount": city_demand_metadata.get("allocationRowCount"),
        "basinsWithCityAllocation": len(city_demand_basin_ids & canonical),
        "citiesCovered": sorted(city_demand_cities & set(CITIES)),
        "minCityCoverageFraction": min(
            (
                float(item.get("coverageFraction", 0) or 0)
                for item in city_demand_metadata.get("cityChecks", {}).values()
                if isinstance(item, dict)
            ),
            default=0,
        ),
        "maxCitySectorErrorM3": max(
            (
                float(item.get("maxAbsSectorErrorM3", 0) or 0)
                for item in city_demand_metadata.get("cityChecks", {}).values()
                if isinstance(item, dict)
            ),
            default=0,
        ),
        "mustNotSatisfyFullBake": city_demand_metadata.get("mustNotSatisfyFullBake"),
    }
    flowthrough_ids: set[str] = set()
    non_empty_flowthrough_count = 0
    for feature in rivers_flowthrough_features:
        props = feature.get("properties", {}) if isinstance(feature, dict) else {}
        flow_through = props.get("flowThrough") if isinstance(props, dict) else None
        if isinstance(flow_through, list) and flow_through:
            non_empty_flowthrough_count += 1
            flowthrough_ids.update(str(item) for item in flow_through)
    rivers_flowthrough_audit = {
        "riversFlowThroughDraftReady": rivers_flowthrough_metadata.get("riversFlowThroughDraftReady"),
        "riversReady": rivers_flowthrough_metadata.get("riversReady"),
        "featureCount": len(rivers_flowthrough_features),
        "nonEmptyFeatureCount": non_empty_flowthrough_count,
        "allFeaturesHaveFlowThrough": non_empty_flowthrough_count == len(rivers_flowthrough_features),
        "unknownSubbasinIds": sorted(flowthrough_ids - canonical)[:20],
        "allFlowThroughIdsInTopology": not (flowthrough_ids - canonical),
        "mustNotSatisfyFullBake": rivers_flowthrough_metadata.get("mustNotSatisfyFullBake"),
    }
    mainstem_injection_plan_audit = {
        "mainstemInjectionPlanDraftReady": mainstem_injection_plan_metadata.get("mainstemInjectionPlanDraftReady"),
        "mainstemInjectionReady": mainstem_injection_plan_metadata.get("mainstemInjectionReady"),
        "spatialInjectionAssigned": mainstem_injection_plan_metadata.get("spatialInjectionAssigned"),
        "rowCount": len(mainstem_injection_plan_rows),
        "candidateRowCount": mainstem_injection_plan_metadata.get("candidateRowCount"),
        "primaryCandidateRowCount": mainstem_injection_plan_metadata.get("primaryCandidateRowCount"),
        "excludedAggregateFlowIds": mainstem_injection_plan_metadata.get("excludedAggregateFlowIds"),
        "mustNotSatisfyFullBake": mainstem_injection_plan_metadata.get("mustNotSatisfyFullBake"),
    }
    field_coverage = {
        "auditInputs": {
            "geometry": len(subbasin_ids & canonical),
            "topology": len(topology_ids),
            "population": sum(
                1 for basin_id in canonical if basin_id in landpop_by_id and landpop_by_id[basin_id].get("worldpop_population") not in {"", None}
            ),
            "demandDraft": sum(1 for basin_id in canonical if basin_id in demand_by_id),
            "cityDemandAllocationDraftBasins": len(city_demand_basin_ids & canonical),
            "cityDemandAllocationDraftCities": len(city_demand_cities & set(CITIES)),
            "supplyDraft": sum(1 for basin_id in canonical if basin_id in supply_by_id),
            "riversFlowThroughDraftFeatures": len(rivers_flowthrough_features),
            "mainstemInjectionPlanDraftRows": len(mainstem_injection_plan_rows),
            "healthReachDraft": sum(1 for basin_id in canonical if basin_id in health_records),
        },
        "formalOutputs": {
            "demandRowsMatchingTopology": len({row.get("id", "") for row in formal_demand_rows} & canonical),
            "supplyRowsMatchingTopology": len({row.get("id", "") for row in formal_supply_rows} & canonical),
            "healthRecordsMatchingTopology": len(formal_health_ids & canonical),
        },
        "contractRequired": contract_required,
        "contractGaps": contract_gaps,
        "cityAllocationAudit": city_allocation_audit,
        "riversFlowThroughAudit": rivers_flowthrough_audit,
        "mainstemInjectionPlanAudit": mainstem_injection_plan_audit,
    }

    def metadata_status(path: Path, flags: list[str]) -> dict[str, object]:
        if not path.exists():
            return {"exists": False, "path": rel(path)}
        payload = read_metadata(path)
        return {
            "exists": True,
            "path": rel(path),
            "flags": {flag: payload.get(flag) for flag in flags},
        }

    formal_metadata = {
        "subbasins": metadata_status(
            INTERMEDIATE_DIR / "subbasins_metadata.json",
            ["subbasinsReady", "formalPfafstetterVectorReady", "geometryClippedToAoi", "fullBakeReady"],
        ),
        "zonal": metadata_status(
            INTERMEDIATE_DIR / "zonal_metadata.json",
            [
                "formalOutputWritten",
                "rasterStatsReady",
                "nightlightProxyReady",
                "preferredViirsReady",
                "eogAnnualVnlReady",
                "worldBankLenProxyApprovedForFullBake",
                "industrialWeightDraftReady",
                "industrialProxyApprovedForFullBake",
                "fullBakeReady",
            ],
        ),
        "demand": metadata_status(INTERMEDIATE_DIR / "demand_metadata.json", ["formalOutputWritten", "demandReady", "fullBakeReady"]),
        "demandDraft": metadata_status(
            INTERMEDIATE_DIR / "demand_draft_metadata.json",
            ["formalOutputWritten", "demandReady", "fullBakeReady", "mustNotSatisfyFullBake"],
        ),
        "cityDemandAllocationDraft": metadata_status(
            INTERMEDIATE_DIR / "city_demand_allocation_draft_metadata.json",
            [
                "formalOutputWritten",
                "cityAllocationDraftReady",
                "cityAllocationReady",
                "demandReady",
                "fullBakeReady",
                "mustNotSatisfyFullBake",
            ],
        ),
        "supply": metadata_status(INTERMEDIATE_DIR / "supply_metadata.json", ["formalOutputWritten", "supplyReady", "fullBakeReady"]),
        "supplyDraft": metadata_status(
            INTERMEDIATE_DIR / "supply_draft_metadata.json",
            [
                "formalOutputWritten",
                "supplyReady",
                "mainstemInjectionReady",
                "mainstemInflowDraftAvailable",
                "mainstemNodeMappingDraftAvailable",
                "mustNotSatisfyFullBake",
            ],
        ),
        "mainstemInflowDraft": metadata_status(
            INTERMEDIATE_DIR / "mainstem_inflow_draft_metadata.json",
            [
                "formalOutputWritten",
                "mainstemInflowDraftReady",
                "mainstemInjectionReady",
                "spatialInjectionAssigned",
                "supplyReady",
                "mustNotSatisfyFullBake",
            ],
        ),
        "mainstemNodeMappingDraft": metadata_status(
            INTERMEDIATE_DIR / "mainstem_node_mapping_draft_metadata.json",
            [
                "formalOutputWritten",
                "mainstemNodeMappingDraftReady",
                "spatialInjectionAssigned",
                "mainstemInjectionReady",
                "supplyReady",
                "fullBakeReady",
                "mustNotSatisfyFullBake",
            ],
        ),
        "riversFlowThroughDraft": metadata_status(
            INTERMEDIATE_DIR / "rivers_flowthrough_draft_metadata.json",
            [
                "formalOutputWritten",
                "riversFlowThroughDraftReady",
                "riversReady",
                "fullBakeReady",
                "mustNotSatisfyFullBake",
            ],
        ),
        "mainstemInjectionPlanDraft": metadata_status(
            INTERMEDIATE_DIR / "mainstem_injection_plan_draft_metadata.json",
            [
                "formalOutputWritten",
                "mainstemInjectionPlanDraftReady",
                "spatialInjectionAssigned",
                "mainstemInjectionReady",
                "supplyReady",
                "fullBakeReady",
                "mustNotSatisfyFullBake",
            ],
        ),
        "health": metadata_status(INTERMEDIATE_DIR / "health_metadata.json", ["formalOutputWritten", "healthReady", "fullBakeReady"]),
        "healthReachDraft": metadata_status(
            INTERMEDIATE_DIR / "health_reach_draft_metadata.json",
            ["formalOutputWritten", "healthReady", "mustNotSatisfyFullBake"],
        ),
        "bake": metadata_status(INTERMEDIATE_DIR / "bake_metadata.json", ["dataContractReady", "fullBakeReady"]),
        "provenance": metadata_status(INTERMEDIATE_DIR / "provenance_metadata.json", ["provenanceReady", "fullBakeReady"]),
        "provenanceDraft": metadata_status(
            INTERMEDIATE_DIR / "provenance_draft_metadata.json",
            ["provenanceDraftReady", "finalProvenanceReady", "mustNotSatisfyFullBake"],
        ),
    }

    artifact_risks = []
    for name, path in [
        ("zonal", INTERMEDIATE_DIR / "zonal.csv"),
        ("demand", INTERMEDIATE_DIR / "demand.csv"),
        ("supply", INTERMEDIATE_DIR / "supply.csv"),
        ("health", INTERMEDIATE_DIR / "health.json"),
    ]:
        if not path.exists():
            continue
        risk: dict[str, object] = {"artifact": name, "path": rel(path), "exists": True, "sizeBytes": file_size(path)}
        if path.suffix == ".csv":
            rows = load_csv_rows(path)
            ids = {row.get("id", "") for row in rows}
            risk.update(
                {
                    "rowCount": len(rows),
                    "idCount": len(ids),
                    "matchesTopology": ids == canonical,
                    "stubLike": any(str(item).startswith("SB_STUB_") for item in ids),
                }
            )
        else:
            payload = json.loads(path.read_text(encoding="utf-8"))
            ids = set(payload) if isinstance(payload, dict) else set()
            risk.update(
                {
                    "recordCount": len(ids),
                    "matchesTopology": ids == canonical,
                    "stubLike": any(str(item).startswith("SB_STUB_") for item in ids),
                }
            )
        if risk.get("stubLike") or not risk.get("matchesTopology"):
            risk["mustNotConsume"] = True
            artifact_risks.append(risk)
        elif not final_data_contract_ready:
            artifact_risks.append(risk)

    if not final_data_contract_ready:
        for path in sorted(OUT_DIR.glob("*.stub.*")):
            artifact_risks.append(
                {
                    "artifact": "stub-output",
                    "path": rel(path),
                    "exists": True,
                    "sizeBytes": file_size(path),
                    "mustNotConsume": True,
                    "reason": "Synthetic stub output under research/tools/bake/out must not be copied into research/data.",
                }
            )

    current_research_data = {
        "attrsPath": rel(DATA_DIR / "wuhan-attrs.json"),
        "attrsExists": (DATA_DIR / "wuhan-attrs.json").exists(),
        "attrsMeta": {
            "demoSample": current_attrs_meta.get("demoSample"),
            "synthetic": current_attrs_meta.get("synthetic"),
            "realDataReady": current_attrs_meta.get("realDataReady"),
            "source": current_attrs_meta.get("source"),
            "sourceInterpretation": (
                "Formal full-bake metadata is present in research/data."
                if final_data_contract_ready
                else "Legacy sample metadata retained in research/data; this text does not describe the current downloaded raw state."
            ),
        },
        "attrsSubbasinCount": len(current_attrs_subbasins) if isinstance(current_attrs_subbasins, list) else None,
        "subbasinsGeojsonBytes": file_size(DATA_DIR / "wuhan-subbasins.geojson"),
        "riversGeojsonBytes": file_size(DATA_DIR / "wuhan-rivers.geojson"),
        "provenanceExists": (DATA_DIR / "provenance.json").exists(),
        "mustNotTreatAsFullBake": not final_data_contract_ready,
    }
    if current_research_data["attrsExists"] and not final_data_contract_ready:
        artifact_risks.append(
            {
                "artifact": "current-research-data",
                "path": rel(DATA_DIR / "wuhan-attrs.json"),
                "exists": True,
                "sizeBytes": file_size(DATA_DIR / "wuhan-attrs.json"),
                "subbasinCount": current_research_data["attrsSubbasinCount"],
                "demoSample": current_attrs_meta.get("demoSample"),
                "synthetic": current_attrs_meta.get("synthetic"),
                "realDataReady": current_attrs_meta.get("realDataReady"),
                "sourceContainsSampleLanguage": isinstance(current_attrs_meta.get("source"), str)
                and any(token in current_attrs_meta.get("source", "").lower() for token in ["sample", "hand-authored", "no clcd"]),
                "mustNotConsume": True,
                "reason": "Current research/data is the honest 10-subbasin sample and is not the real bake output.",
            }
        )
    sample_records = []
    for basin_id in sorted(canonical)[:10]:
        landpop = landpop_by_id.get(basin_id, {})
        demand = demand_by_id.get(basin_id, {})
        supply = supply_by_id.get(basin_id, {})
        health = health_records.get(basin_id, {})
        sample_records.append(
            {
                "id": basin_id,
                "name": None,
                "areaKm2": float(landpop.get("sub_area_km2", 0) or 0),
                "population": float(landpop.get("worldpop_population", 0) or 0),
                "centroid": None,
                "adminCities": [],
                "demand": {
                    "agri": float(demand.get("agri_calibrated_m3", 0) or 0),
                    "industry": float(demand.get("industry_calibrated_m3", 0) or 0),
                    "urban": float(demand.get("urban_calibrated_m3", 0) or 0),
                    "eco": float(demand.get("eco_new_caliber_draft_m3", 0) or 0),
                },
                "supply": {
                    "qLocal": float(supply.get("q_local_m3", 0) or 0),
                    "qAvail": float(supply.get("q_avail_with_documented_mainstem_m3", 0) or 0),
                    "externalInflow": None,
                    "mainstemInflow": None,
                },
                "healthWeight": health.get("healthWeight"),
                "downstream": topology[basin_id],
                "downstreamReach": health.get("downstreamReach"),
            }
        )
    attrs_preview = {
        "meta": {
            "preflightOnly": True,
            "demoSample": False,
            "synthetic": False,
            "realDataReady": False,
            "estimated": True,
            "calibrationYear": 2022,
            "source": "PREFLIGHT ONLY: audit partials; not a research/data source statement.",
            "note": "Preview uses audit-only partials and intentionally omits formal demand/supply/health readiness.",
        },
        "topology": topology,
        "sectorTotals": {sector: None for sector in SECTORS},
        "citySectorDemand": {city: {sector: None for sector in SECTORS} for city in CITIES},
        "subbasins": sample_records,
    }

    attrs_empty = {**attrs_preview, "subbasins": []}
    attrs_empty_bytes = len(json.dumps(attrs_empty, ensure_ascii=False).encode("utf-8"))
    sample_records_bytes = len(json.dumps(sample_records, ensure_ascii=False).encode("utf-8"))
    per_record_estimate = sample_records_bytes / len(sample_records) if sample_records else 0
    attrs_all_record_estimate_bytes = round(attrs_empty_bytes + per_record_estimate * len(canonical))
    rivers_current = read_json_if_exists(DATA_DIR / "wuhan-rivers.geojson")
    rivers_features = rivers_current.get("features", []) if isinstance(rivers_current, dict) else []
    rivers_existing_bytes = file_size(DATA_DIR / "wuhan-rivers.geojson") or 0
    subbasins_raw_bytes = file_size(INTERMEDIATE_DIR / "subbasins_raw.geojson") or 0
    output_size = {
        "roughEstimateOnly": not final_data_contract_ready,
        "subbasinsRawGeojsonBytes": subbasins_raw_bytes,
        "subbasinsFeatureCount": len(features),
        "subbasinsCoordinateCount": count_coordinate_positions(subbasins),
        "attrsTenRecordPreviewBytes": len(json.dumps(attrs_preview, ensure_ascii=False).encode("utf-8")),
        "attrsAllRecordEstimateBytes": attrs_all_record_estimate_bytes,
        "riversExistingSampleBytes": rivers_existing_bytes,
        "riversExistingSampleFeatureCount": len(rivers_features) if isinstance(rivers_features, list) else None,
        "riversExistingSampleCoordinateCount": count_coordinate_positions(rivers_current) if rivers_current is not None else None,
        "workOrderTwoFileTotalEstimateBytes": subbasins_raw_bytes + attrs_all_record_estimate_bytes,
        "validatorThreeFileTotalEstimateBytes": subbasins_raw_bytes + attrs_all_record_estimate_bytes + rivers_existing_bytes,
        "actualValidatorFourFileBytes": (
            file_size(DATA_DIR / "wuhan-subbasins.geojson")
            + file_size(DATA_DIR / "wuhan-rivers.geojson")
            + file_size(DATA_DIR / "wuhan-attrs.json")
            + file_size(DATA_DIR / "provenance.json")
        ),
        "workOrderTwoFileTargetBytes": 3_000_000,
        "validatorThreeFileTargetBytes": 3_000_000,
        "needsSimplificationBeforeFinal": not final_data_contract_ready,
        "note": (
            "Formal full-bake outputs are already written; actual file sizes are reported for validation."
            if final_data_contract_ready
            else "Rough estimate only: raw fallback polygons are unsimplified, attrs are extrapolated, and rivers use the existing sample as a placeholder."
        ),
    }

    provenance_draft = read_json_if_exists(INTERMEDIATE_DIR / "provenance_draft.json")
    provenance_gap = {
        "finalProvenancePath": rel(DATA_DIR / "provenance.json"),
        "finalProvenanceExists": (DATA_DIR / "provenance.json").exists(),
        "provenanceMetadataExists": (INTERMEDIATE_DIR / "provenance_metadata.json").exists(),
        "draftPath": rel(INTERMEDIATE_DIR / "provenance_draft.json"),
        "draftExists": provenance_draft is not None,
        "draftSchemaVersion": provenance_draft.get("schemaVersion") if isinstance(provenance_draft, dict) else None,
        "draftMustNotSatisfyFullBake": provenance_draft.get("mustNotSatisfyFullBake") if isinstance(provenance_draft, dict) else None,
        "blockedFinalProvenanceReasons": provenance_draft.get("blockedFinalProvenanceReasons", []) if isinstance(provenance_draft, dict) else [],
    }
    viirs_has_files = has_files(RAW_DIR / "viirs")
    viirs_status = "credential_gated_missing"
    if viirs_has_files:
        viirs_status = (
            "downloaded_approved"
            if formal_metadata["zonal"].get("flags", {}).get("industrialProxyApprovedForFullBake") is True
            else "downloaded_audit_candidate_unapproved"
        )
    raw_gate_status = {
        "viirs": {
            "path": rel(RAW_DIR / "viirs"),
            "hasFiles": viirs_has_files,
            "status": viirs_status,
        },
        "merit": {
            "path": rel(RAW_DIR / "merit"),
            "hasFiles": has_files(RAW_DIR / "merit"),
            "status": (
                "project_provided_basin_asia_gdb_ready_upstream_unverified"
                if (RAW_DIR / "merit" / "Basin_Asia.gdb.zip").exists()
                else "missing_project_provided_basin_asia_gdb"
            ),
        },
    }
    validator_risk_map = {
        "meta.demoSample must be false": {
            "currentResearchDataValue": current_attrs_meta.get("demoSample"),
            "formalBakeStatus": "passed" if final_data_contract_ready else "blocked",
        },
        "meta.synthetic must be false": {
            "currentResearchDataValue": current_attrs_meta.get("synthetic"),
            "formalBakeStatus": "passed" if final_data_contract_ready else "blocked",
        },
        "meta.realDataReady must be true": {
            "currentResearchDataValue": current_attrs_meta.get("realDataReady"),
            "formalBakeStatus": "passed" if final_data_contract_ready else "blocked",
        },
        "meta.source must not contain sample language": {
            "currentResearchDataValue": current_attrs_meta.get("source"),
            "currentResearchDataValueNote": (
                "This is the legacy 10-subbasin sample source string. Current raw-download status is reported separately "
                "in rawGateStatus and provenanceGap."
            ),
            "formalBakeStatus": "passed" if final_data_contract_ready else "blocked",
        },
        "provenance.json must exist and be final": {
            "currentResearchDataValue": current_research_data["provenanceExists"],
            "formalBakeStatus": "passed" if final_data_contract_ready else "blocked",
        },
        "subbasin count must be 30-80": {
            "currentResearchDataValue": current_research_data["attrsSubbasinCount"],
            "auditIntermediateValue": len(canonical),
            "formalBakeStatus": "passed" if final_data_contract_ready else "audit basis meets count, but not baked into research/data",
        },
        "supply.externalInflow and supply.mainstemInflow must be finite": {
            "currentResearchDataValue": {
                "missingExternalInflowCount": sum(
                    1
                    for record in current_attrs_subbasins
                    if not isinstance(record, dict)
                    or not isinstance(record.get("supply"), dict)
                    or not isinstance(record.get("supply", {}).get("externalInflow"), (int, float))
                )
                if isinstance(current_attrs_subbasins, list)
                else None,
                "missingMainstemInflowCount": sum(
                    1
                    for record in current_attrs_subbasins
                    if not isinstance(record, dict)
                    or not isinstance(record.get("supply"), dict)
                    or not isinstance(record.get("supply", {}).get("mainstemInflow"), (int, float))
                )
                if isinstance(current_attrs_subbasins, list)
                else None,
            },
            "formalBakeStatus": "passed" if final_data_contract_ready else "blocked until formal supply writes explicit externalInflow and mainstemInflow fields",
        },
        "citySectorDemand must cover the Wuhan 1+8 city set": {
            "currentResearchDataValue": sorted((current_attrs.get("citySectorDemand", {}) or {}).keys())
            if isinstance(current_attrs, dict) and isinstance(current_attrs.get("citySectorDemand"), dict)
            else None,
            "requiredCities": CITIES,
            "formalBakeStatus": "passed" if final_data_contract_ready else "sample currently covers the city set; final values still depend on formal city allocation",
        },
        "river flowThrough must be present": {
            "currentResearchDataValue": {
                "featureCount": len(rivers_features) if isinstance(rivers_features, list) else None,
                "missingFlowThroughCount": sum(
                    1
                    for feature in rivers_features
                    if not isinstance(feature, dict)
                    or not isinstance(feature.get("properties"), dict)
                    or not feature.get("properties", {}).get("flowThrough")
                )
                if isinstance(rivers_features, list)
                else None,
            },
            "formalBakeStatus": "passed" if final_data_contract_ready else "blocked until real HydroRIVERS/subbasin routing is baked",
        },
    }

    blockers = []
    if formal_metadata["subbasins"].get("flags", {}).get("fullBakeReady") is not True:
        blockers.append("subbasins_metadata.fullBakeReady is not true; approved Pfafstetter level_6 subbasins are not ready.")
    for zonal_flag in [
        "formalOutputWritten",
        "rasterStatsReady",
        "nightlightProxyReady",
        "industrialProxyApprovedForFullBake",
        "worldBankLenProxyApprovedForFullBake",
        "fullBakeReady",
    ]:
        if formal_metadata["zonal"].get("flags", {}).get(zonal_flag) is not True:
            blockers.append(
                f"zonal_metadata.{zonal_flag} is not true; formal WB LEN nightlight/industrial zonal output is incomplete."
            )
    for step_name, metadata_key, flag in [
        ("demand", "demand", "formalOutputWritten"),
        ("demand", "demand", "demandReady"),
        ("supply", "supply", "formalOutputWritten"),
        ("supply", "supply", "supplyReady"),
        ("health", "health", "formalOutputWritten"),
        ("health", "health", "healthReady"),
        ("bake", "bake", "dataContractReady"),
        ("provenance", "provenance", "provenanceReady"),
    ]:
        status = formal_metadata[metadata_key]
        if not status.get("exists") or status.get("flags", {}).get(flag) is not True:
            blockers.append(f"{step_name} formal metadata is missing or {flag} is not true.")
    if not raw_gate_status["viirs"]["hasFiles"]:
        blockers.append("raw/viirs has no downloaded files; industrial-weight zonal output remains credential-gated.")
    if not raw_gate_status["merit"]["hasFiles"]:
        blockers.append("raw/merit has no Basin_Asia.gdb.zip file for approved Pfafstetter level_6 clipping.")
    if provenance_gap["blockedFinalProvenanceReasons"]:
        blockers.extend(str(item) for item in provenance_gap["blockedFinalProvenanceReasons"])
    blockers.extend(contract_gaps)

    report_path = INTERMEDIATE_DIR / "bake_preflight_report.json"
    metadata_path = INTERMEDIATE_DIR / "bake_preflight_metadata.json"
    report = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "step": "bake-preflight",
        "draft": True,
        "preflightOnly": True,
        "mustNotSatisfyFullBake": True,
        "dataContractReady": final_data_contract_ready,
        "fullBakeReady": final_data_contract_ready,
        "fullBakeUnlocked": final_data_contract_ready,
        "preflightReady": True,
        "canWriteResearchData": final_data_contract_ready,
        "idAlignment": id_alignment,
        "fieldCoverage": field_coverage,
        "formalMetadata": formal_metadata,
        "rawGateStatus": raw_gate_status,
        "currentResearchData": current_research_data,
        "provenanceGap": provenance_gap,
        "validatorRiskMap": validator_risk_map,
        "artifactRisks": artifact_risks,
        "outputSize": output_size,
        "blockers": blockers,
        "sampleAttrsPreview": attrs_preview,
    }
    metadata = {
        "createdAt": report["createdAt"],
        "step": "bake-preflight",
        "draft": True,
        "preflightOnly": True,
        "preflightOnlyNotFinalArtifact": True,
        "needsHumanReview": not final_data_contract_ready,
        "formalOutputWritten": False,
        "observedFormalOutputsReady": final_data_contract_ready,
        "dataContractReady": final_data_contract_ready,
        "observedFullBakeReady": final_data_contract_ready,
        "fullBakeReady": False,
        "fullBakeUnlocked": final_data_contract_ready,
        "canWriteResearchData": final_data_contract_ready,
        "mustNotSatisfyFullBake": True,
        "report": rel(report_path),
        "blockerCount": len(blockers),
        "artifactRiskCount": len(artifact_risks),
        "subbasinCount": len(canonical),
        "idAlignmentAllMatch": all(item["matchesTopology"] for item in id_alignment.values()),
    }
    write_json(report_path, report)
    write_json(metadata_path, metadata)
    print(f"PREFLIGHT wrote {rel(report_path)}")
    print(f"PREFLIGHT wrote {rel(metadata_path)}")
    print(
        "Bake preflight: "
        f"{len(canonical)} topology nodes, idAlignmentAllMatch={metadata['idAlignmentAllMatch']}, "
        f"blockers={len(blockers)}, artifactRisks={len(artifact_risks)}"
    )
    if final_data_contract_ready:
        print("PREFLIGHT OK: current research/data matches the formal bake contract.")
    else:
        print("PREFLIGHT ONLY: research/data and bake_metadata remain locked.")
    return [report_path, metadata_path]


def step_validate_real(_: argparse.Namespace) -> list[Path]:
    command = ["node", "research/tools/validate_research_data.js", "--full-bake"]
    result = subprocess.run(command, cwd=RESEARCH_DIR.parent, check=False)
    if result.returncode != 0:
        raise BakeBlocked(
            "validate",
            [DATA_DIR / "wuhan-attrs.json", DATA_DIR / "wuhan-subbasins.geojson", DATA_DIR / "wuhan-rivers.geojson"],
            f"Full-bake validator exited {result.returncode}; inspect validator output above.",
        )
    return []


def step_bake_real(_: argparse.Namespace) -> list[Path]:
    ensure_dirs()
    required_paths = [
        INTERMEDIATE_DIR / "subbasins_raw.geojson",
        INTERMEDIATE_DIR / "subbasins_metadata.json",
        INTERMEDIATE_DIR / "topology.json",
        INTERMEDIATE_DIR / "zonal.csv",
        INTERMEDIATE_DIR / "zonal_metadata.json",
        INTERMEDIATE_DIR / "demand.csv",
        INTERMEDIATE_DIR / "demand_metadata.json",
        INTERMEDIATE_DIR / "supply.csv",
        INTERMEDIATE_DIR / "supply_metadata.json",
        INTERMEDIATE_DIR / "health.json",
        INTERMEDIATE_DIR / "health_metadata.json",
        INTERMEDIATE_DIR / "rivers_flowthrough_draft.geojson",
        INTERMEDIATE_DIR / "city_demand_allocation_draft.csv",
    ]
    for path in required_paths:
        if not path.exists():
            raise BakeBlocked("bake", [path], "Need formal intermediate files before writing research/data.")
    for metadata_path, flag in [
        (INTERMEDIATE_DIR / "subbasins_metadata.json", "fullBakeReady"),
        (INTERMEDIATE_DIR / "zonal_metadata.json", "fullBakeReady"),
        (INTERMEDIATE_DIR / "demand_metadata.json", "demandReady"),
        (INTERMEDIATE_DIR / "supply_metadata.json", "supplyReady"),
        (INTERMEDIATE_DIR / "health_metadata.json", "healthReady"),
    ]:
        if read_metadata(metadata_path).get(flag) is not True:
            raise BakeBlocked("bake", [f"{rel(metadata_path)}:{flag}=true"], "Need formal metadata readiness before bake.")

    try:
        from shapely.geometry import LineString, Point, mapping, shape, box
    except ModuleNotFoundError as exc:
        raise BakeBlocked("bake", ["shapely in .venv-bake"], "Need shapely to simplify geometry and compute centroids.") from exc

    topology = read_topology(required=True, step="bake")
    order = topology_order(topology, "bake")
    bbox_geom = box(BBOX[0], BBOX[1], BBOX[2], BBOX[3])
    subbasins_raw = json.loads((INTERMEDIATE_DIR / "subbasins_raw.geojson").read_text(encoding="utf-8"))
    features = subbasins_raw.get("features", [])
    feature_by_id = {feature["properties"]["id"]: feature for feature in features}
    zonal_by_id = {row["id"]: row for row in load_csv_rows(INTERMEDIATE_DIR / "zonal.csv")}
    demand_by_id = {row["id"]: row for row in load_csv_rows(INTERMEDIATE_DIR / "demand.csv")}
    supply_by_id = {row["id"]: row for row in load_csv_rows(INTERMEDIATE_DIR / "supply.csv")}
    health = json.loads((INTERMEDIATE_DIR / "health.json").read_text(encoding="utf-8"))
    city_rows = load_csv_rows(INTERMEDIATE_DIR / "city_demand_allocation_draft.csv")
    overlaps = city_overlap_by_basin(city_rows)
    cities_by_basin: dict[str, set[str]] = {basin_id: set() for basin_id in order}
    for row in city_rows:
        basin_id = row.get("basin_id", "")
        city = row.get("city", "")
        if basin_id in cities_by_basin and city:
            cities_by_basin[basin_id].add(city)

    missing = [
        basin_id
        for basin_id in order
        if basin_id not in feature_by_id
        or basin_id not in zonal_by_id
        or basin_id not in demand_by_id
        or basin_id not in supply_by_id
        or basin_id not in health
    ]
    if missing:
        raise BakeBlocked("bake", [f"missing formal input {basin_id}" for basin_id in missing[:10]], "All formal inputs must align.")

    point_by_id: dict[str, tuple[float, float]] = {}
    subbasin_features = []
    for basin_id in order:
        feature = feature_by_id[basin_id]
        props = feature.get("properties", {})
        geom = shape(feature["geometry"])
        display_geom = geom.intersection(bbox_geom)
        if display_geom.is_empty:
            point_raw = geom.representative_point()
            clamped_x = min(BBOX[2] - 0.0001, max(BBOX[0] + 0.0001, float(point_raw.x)))
            clamped_y = min(BBOX[3] - 0.0001, max(BBOX[1] + 0.0001, float(point_raw.y)))
            display_geom = Point(clamped_x, clamped_y).buffer(0.0001).intersection(bbox_geom)
        point = display_geom.representative_point()
        point_by_id[basin_id] = (float(point.x), float(point.y))
        simplified = display_geom.simplify(0.006, preserve_topology=True)
        out_props = {
            "id": basin_id,
            "pfafId": props.get("pfafId"),
            "downstream": topology[basin_id],
            "areaKm2": props.get("clipAreaKm2") or props.get("subAreaKm2"),
            "source": "Pfafstetter level_6 AOI-clipped project-provided vector",
        }
        subbasin_features.append(
            {
                "type": "Feature",
                "id": basin_id,
                "properties": out_props,
                "geometry": round_geometry_coordinates(mapping(simplified), 5),
            }
        )

    subbasins_geojson = {
        "type": "FeatureCollection",
        "name": "wuhan_subbasins_pfafstetter_level6_formal_bake",
        "features": subbasin_features,
    }

    subbasin_records = []
    for basin_id in order:
        zonal = zonal_by_id[basin_id]
        demand = demand_by_id[basin_id]
        supply = supply_by_id[basin_id]
        health_record = health[basin_id]
        point = point_by_id[basin_id]
        props = feature_by_id[basin_id].get("properties", {})
        admin_cities = sorted(cities_by_basin[basin_id]) or ["Wuhan"]
        subbasin_records.append(
            {
                "id": basin_id,
                "name": f"Pfafstetter {basin_id}",
                "pfafId": props.get("pfafId") or basin_id,
                "code": basin_id,
                "adminCities": admin_cities,
                "areaKm2": csv_float(zonal, "area_km2"),
                "population": csv_float(zonal, "population"),
                "centroid": [round_coord(point[0]), round_coord(point[1])],
                "zonalProxy": {
                    "croplandHa": csv_float(zonal, "cropland_ha"),
                    "builtupHa": csv_float(zonal, "builtup_ha"),
                    "industrialWeight": csv_float(zonal, "ind_weight"),
                    "precipMm": csv_float(zonal, "precip_mm"),
                    "nightlightSource": zonal.get("industrial_proxy_source", ""),
                },
                "demand": {sector: csv_int(demand, sector) for sector in SECTORS},
                "supply": {
                    "qLocal": csv_int(supply, "qLocal"),
                    "qAvail": csv_int(supply, "qAvail"),
                    "externalInflow": csv_int(supply, "externalInflow"),
                    "mainstemInflow": csv_int(supply, "mainstemInflow"),
                    "runoffCoeff": csv_float(supply, "runoffCoeff"),
                },
                "healthWeight": health_record["healthWeight"],
                "downstream": topology[basin_id],
                "downstreamReach": downstream_reach(basin_id, topology),
            }
        )
    apply_readable_subbasin_names(subbasin_records, overlaps)
    sync_subbasin_geojson_names(subbasins_geojson, subbasin_records)

    sector_totals = {sector: sum(record["demand"][sector] for record in subbasin_records) for sector in SECTORS}
    demand_metadata = read_metadata(INTERMEDIATE_DIR / "demand_metadata.json")
    city_sector_demand = demand_metadata.get("citySectorDemandM3")
    if not isinstance(city_sector_demand, dict):
        raise BakeBlocked("bake", [INTERMEDIATE_DIR / "demand_metadata.json"], "Need citySectorDemandM3 in demand metadata.")

    rivers_draft = json.loads((INTERMEDIATE_DIR / "rivers_flowthrough_draft.geojson").read_text(encoding="utf-8"))
    river_features = []
    for feature in rivers_draft.get("features", []):
        props = feature.get("properties", {})
        flow_through = [basin_id for basin_id in props.get("flowThrough", []) if basin_id in point_by_id]
        if not flow_through:
            continue
        from_id = flow_through[0]
        to_id = flow_through[1] if len(flow_through) > 1 else from_id
        coords = [point_by_id[basin_id] for basin_id in flow_through]
        if len(coords) == 1:
            x, y = coords[0]
            coords.append((min(BBOX[2], x + 0.001), min(BBOX[3], y + 0.001)))
        line = LineString(coords)
        river_features.append(
            {
                "type": "Feature",
                "id": props.get("id"),
                "properties": {
                    "id": props.get("id"),
                    "flowDirection": "topology_ordered_flowthrough",
                    "fromSubbasin": from_id,
                    "toSubbasin": to_id,
                    "downstreamSubbasin": topology.get(flow_through[-1], "OUTLET"),
                    "flowThrough": flow_through,
                    "sourceHydroRiverId": props.get("sourceHydroRiverId"),
                    "method": "formal_centroid_line_from_hydrorivers_flowthrough_draft",
                },
                "geometry": round_geometry_coordinates(mapping(line), 5),
            }
        )
    if not river_features:
        raise BakeBlocked("bake", [INTERMEDIATE_DIR / "rivers_flowthrough_draft.geojson"], "Need at least one river feature.")

    rivers_geojson = {
        "type": "FeatureCollection",
        "name": "wuhan_rivers_flowthrough_formal_bake",
        "features": river_features,
    }

    attrs = {
        "meta": {
            "region": "Wuhan Metropolitan Area (1+8)",
            "regionZh": "武汉都市圈（武汉城市圈 1+8）",
            "calibrationYear": 2022,
            "datasetType": "offline-bake-real-data-estimated",
            "demoSample": False,
            "estimated": True,
            "synthetic": False,
            "realDataReady": True,
            "source": "Real-data offline bake from GADM AOI, project-provided Pfafstetter level_6 Basin_Asia.gdb vector, CLCD/WorldCover/WorldPop/NASA POWER/WB-LEN rasters, Hubei Water Resources Bulletin, and HydroRIVERS routing draft.",
            "note": "Industrial downscaling uses World Bank Light Every Night with adjacent-month interpolation for 202206 and 202208; EOG Annual VNL was not used. PRE-1 injects Hubei Bulletin 2022 table 5 provincial-boundary transit proxies into externalInflow/mainstemInflow: 355275000000 m3/yr at PF_465500 for the Yangtze mainstem and 17553000000 m3/yr at PF_465610 for the Han mainstem. Province-total and Han-system aggregate inflows are excluded to avoid double counting; injection node assignment remains low-confidence because HydroRIVERS route matching lacks independent river-name confirmation.",
            "bbox": BBOX,
            "sectors": SECTORS,
            "citySet": CITIES,
        },
        "topology": topology,
        "sectorTotals": sector_totals,
        "citySectorDemand": city_sector_demand,
        "subbasins": subbasin_records,
    }

    attrs_path = DATA_DIR / "wuhan-attrs.json"
    subbasins_path = DATA_DIR / "wuhan-subbasins.geojson"
    rivers_path = DATA_DIR / "wuhan-rivers.geojson"
    write_json(attrs_path, attrs)
    write_json(subbasins_path, subbasins_geojson)
    write_json(rivers_path, rivers_geojson)

    metadata_path = INTERMEDIATE_DIR / "bake_metadata.json"
    output_bytes = sum(path.stat().st_size for path in [attrs_path, subbasins_path, rivers_path])
    metadata = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "step": "bake",
        "formalOutputWritten": True,
        "dataContractReady": True,
        "fullBakeReady": True,
        "researchDataReady": True,
        "outputs": {
            "attrs": rel(attrs_path),
            "subbasins": rel(subbasins_path),
            "rivers": rel(rivers_path),
        },
        "checks": {
            "subbasinCount": len(subbasin_records),
            "riverFeatureCount": len(river_features),
            "idsMatchTopology": set(record["id"] for record in subbasin_records) == set(topology),
            "combinedBytes": output_bytes,
            "underThreeMbTarget": output_bytes <= 3_000_000,
        },
        "limitations": [
            "Formal data contract is validator-ready but remains estimated; PRE-1 mainstem transit inflows use Hubei provincial-boundary bulletin values as Wuhan 1+8 AOI proxies.",
            "Mainstem injection node assignment is low-confidence because HydroRIVERS route matching lacks independent river-name confirmation.",
            "River geometries are lightweight centroid lines derived from HydroRIVERS flowThrough evidence for front-end visualization.",
        ],
    }
    write_json(metadata_path, metadata)
    print(f"REAL wrote {rel(attrs_path)}")
    print(f"REAL wrote {rel(subbasins_path)}")
    print(f"REAL wrote {rel(rivers_path)}")
    print(f"REAL wrote {rel(metadata_path)}")
    return [attrs_path, subbasins_path, rivers_path, metadata_path]


def parse_raw_sha256_manifest(path: Path) -> list[dict[str, str]]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        digest, raw_path_text = line.split(maxsplit=1)
        raw_path_text = raw_path_text.strip()
        source_path = Path(raw_path_text)
        if not source_path.is_absolute():
            source_path = (RESEARCH_DIR.parent / source_path).resolve()
        try:
            raw_relative = source_path.relative_to(RAW_DIR)
            category = raw_relative.parts[0]
        except ValueError:
            category = "unknown"
        rows.append(
            {
                "sha256": digest,
                "path": rel(source_path),
                "inputFileName": source_path.name,
                "category": category,
            }
        )
    return rows


def step_provenance_draft(_: argparse.Namespace) -> list[Path]:
    ensure_dirs()
    manifest_path = INTERMEDIATE_DIR / "raw_sha256.txt"
    attempts_path = BAKE_DIR / "download_attempts.md"
    zonal_metadata = read_json_if_exists(INTERMEDIATE_DIR / "zonal_metadata.json") or {}
    if not manifest_path.exists():
        raise BakeBlocked(
            "provenance-draft",
            [manifest_path],
            "Need raw checksum manifest before writing an intermediate provenance draft.",
        )
    if not attempts_path.exists():
        raise BakeBlocked(
            "provenance-draft",
            [attempts_path],
            "Need download_attempts.md before writing an intermediate provenance draft.",
        )

    items = []
    for raw_item in parse_raw_sha256_manifest(manifest_path):
        info = SOURCE_INFO_BY_CATEGORY.get(raw_item["category"], {})
        items.append(
            {
                "category": raw_item["category"],
                "inputFileName": raw_item["inputFileName"],
                "path": raw_item["path"],
                "sourceUrl": info.get("sourceUrl"),
                "downloadDate": "2026-06-14",
                "sha256": raw_item["sha256"],
                "license": info.get("license"),
                "status": "downloaded_verified_sha256",
                "processingStep": info.get("processingStep"),
                "processingScript": rel(BAKE_DIR / "bake.py"),
                "processingScriptSha256": sha256_file(BAKE_DIR / "bake.py"),
                "notes": "Draft provenance item generated from intermediate/raw_sha256.txt; final provenance still requires completed real bake outputs.",
            }
        )

    missing_required_sources = []
    if not has_files(RAW_DIR / "viirs"):
        missing_required_sources.append(
            (
                "viirs",
                "https://eogdata.mines.edu/products/vnl/ and NASA Black Marble VNP46A4 LAADS probes",
                "EOG Annual VNL redirects to OpenID Connect login; NASA Black Marble actual GET returns Earthdata 401 without credentials.",
                "required before final full-bake",
            )
        )
    if not has_files(RAW_DIR / "merit"):
        missing_required_sources.append(
            (
                "merit",
                "local project-provided Basin_Asia.gdb.zip",
                "The approved Pfafstetter level_6 vector source is missing from raw/merit.",
                "required for approved Pfafstetter level_6 subbasin clipping",
            )
        )
    for category, source_url, note, processing_step in missing_required_sources:
        items.append(
            {
                "category": category,
                "inputFileName": None,
                "path": f"raw/{category}/",
                "sourceUrl": source_url,
                "downloadDate": None,
                "sha256": None,
                "license": "credential or registration gated",
                "status": "credential_gated_missing",
                "processingStep": processing_step,
                "processingScript": rel(BAKE_DIR / "bake.py"),
                "processingScriptSha256": sha256_file(BAKE_DIR / "bake.py"),
                "attemptEvidence": rel(attempts_path),
                "notes": note,
            }
        )

    blocked_reasons = []
    if not has_files(RAW_DIR / "viirs"):
        blocked_reasons.append("raw/viirs is credential-gated and missing")
    elif zonal_metadata.get("industrialProxyApprovedForFullBake") is not True:
        blocked_reasons.append("raw/viirs contains World Bank Light Every Night monthly BBox clips, but zonal metadata has not approved the WB LEN fallback")
    if not has_files(RAW_DIR / "merit"):
        blocked_reasons.append("raw/merit is missing the project-provided Basin_Asia.gdb.zip needed for approved Pfafstetter level_6 clipping")
    bake_metadata = read_json_if_exists(INTERMEDIATE_DIR / "bake_metadata.json")
    if not isinstance(bake_metadata, dict) or bake_metadata.get("dataContractReady") is not True:
        blocked_reasons.append("intermediate/bake_metadata.json:dataContractReady=true does not exist yet")
    current_attrs = read_json_if_exists(DATA_DIR / "wuhan-attrs.json")
    current_meta = current_attrs.get("meta", {}) if isinstance(current_attrs, dict) else {}
    if current_meta.get("realDataReady") is not True or current_meta.get("synthetic") is not False:
        blocked_reasons.append("research/data still contains the synthetic 10-subbasin sample, not the real bake output")

    payload = {
        "schemaVersion": "provenance-draft/v1",
        "draft": True,
        "mustNotSatisfyFullBake": True,
        "targetFinalPath": rel(DATA_DIR / "provenance.json"),
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "studyArea": {
            "name": "Wuhan Metropolitan Area (1+8)",
            "bbox": BBOX,
            "calibrationYear": 2022,
        },
        "rawManifestSource": rel(manifest_path),
        "downloadAttemptAudit": rel(attempts_path),
        "items": items,
        "blockedFinalProvenanceReasons": blocked_reasons,
    }
    metadata = {
        "createdAt": payload["createdAt"],
        "provenanceDraftReady": True,
        "finalProvenanceReady": len(blocked_reasons) == 0,
        "draftPath": rel(INTERMEDIATE_DIR / "provenance_draft.json"),
        "itemCount": len(items),
        "mustNotSatisfyFullBake": len(blocked_reasons) > 0,
        "blockedFinalProvenanceReasons": blocked_reasons,
    }
    draft_path = INTERMEDIATE_DIR / "provenance_draft.json"
    metadata_path = INTERMEDIATE_DIR / "provenance_draft_metadata.json"
    write_json(draft_path, payload)
    write_json(metadata_path, metadata)
    print(f"REAL-PARTIAL wrote {rel(draft_path)}")
    print(f"REAL-PARTIAL wrote {rel(metadata_path)}")
    print("Provenance draft is audit-only and does not satisfy research/data/provenance.json.")
    return [draft_path, metadata_path]


def step_provenance_real(_: argparse.Namespace) -> list[Path]:
    ensure_dirs()
    draft_path = INTERMEDIATE_DIR / "provenance_draft.json"
    bake_metadata_path = INTERMEDIATE_DIR / "bake_metadata.json"
    if not draft_path.exists():
        raise BakeBlocked("provenance", [draft_path], "Need provenance draft before final provenance.")
    if not bake_metadata_path.exists():
        raise BakeBlocked("provenance", [bake_metadata_path], "Need bake metadata before final provenance.")
    bake_metadata = read_metadata(bake_metadata_path)
    if bake_metadata.get("dataContractReady") is not True or bake_metadata.get("fullBakeReady") is not True:
        raise BakeBlocked("provenance", [bake_metadata_path], "Need full bake metadata before final provenance.")
    for path in [DATA_DIR / "wuhan-attrs.json", DATA_DIR / "wuhan-subbasins.geojson", DATA_DIR / "wuhan-rivers.geojson"]:
        if not path.exists():
            raise BakeBlocked("provenance", [path], "Need baked research/data files before final provenance.")

    draft = json.loads(draft_path.read_text(encoding="utf-8"))
    draft_items = draft.get("items")
    if not isinstance(draft_items, list):
        raise BakeBlocked("provenance", [draft_path], "Provenance draft items must be a list.")
    required = {"clcd", "worldcover", "worldpop", "viirs", "merit", "hydrosheds", "climate", "gadm", "bulletin"}
    final_notes_by_category = {
        "merit": "Final full-bake input. Basin_Asia.gdb.zip is project-provided; upstream original source is not independently verified.",
        "viirs": "Final full-bake input. World Bank Light Every Night BBox clip used as the approved nightlight fallback; missing 202206/202208 monthly rasters are interpolated under intermediate/.",
    }
    downloaded_items = []
    for item in draft_items:
        if item.get("status") != "downloaded_verified_sha256":
            continue
        category = str(item["category"])
        downloaded_items.append(
            {
                "category": category,
                "inputFileName": str(item["inputFileName"]),
                "path": str(item["path"]),
                "sourceUrl": str(item["sourceUrl"]),
                "downloadDate": str(item["downloadDate"]),
                "sha256": str(item["sha256"]),
                "license": str(item["license"]),
                "processingScript": str(item["processingScript"]),
                "processingStep": item.get("processingStep"),
                "processingScriptSha256": item.get("processingScriptSha256"),
                "notes": final_notes_by_category.get(
                    category,
                    "Final full-bake input item recorded from the raw checksum manifest and consumed by the formal offline bake.",
                ),
            }
        )
    categories = {item["category"] for item in downloaded_items}
    missing = sorted(required - categories)
    if missing:
        raise BakeBlocked("provenance", [f"missing provenance category {category}" for category in missing], "Final provenance must cover all required categories.")

    payload = {
        "schemaVersion": "provenance/v1",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "studyArea": {
            "name": "Wuhan Metropolitan Area (1+8)",
            "bbox": BBOX,
            "calibrationYear": 2022,
        },
        "bakeMetadata": rel(bake_metadata_path),
        "items": downloaded_items,
        "manualReviewRequiredBeforePublication": True,
        "notes": [
            "Basin_Asia.gdb.zip is a project-provided Pfafstetter level_6 vector; upstream original source is not independently verified.",
            "WB-LEN is the formal fallback nightlight proxy; EOG Annual VNL was not used.",
        ],
    }
    output_path = DATA_DIR / "provenance.json"
    metadata_path = INTERMEDIATE_DIR / "provenance_metadata.json"
    write_json(output_path, payload)
    metadata = {
        "createdAt": payload["createdAt"],
        "step": "provenance",
        "formalOutputWritten": True,
        "provenanceReady": True,
        "fullBakeReady": True,
        "output": rel(output_path),
        "itemCount": len(downloaded_items),
        "categories": sorted(categories),
        "sourceDraft": rel(draft_path),
    }
    write_json(metadata_path, metadata)
    print(f"REAL wrote {rel(output_path)}")
    print(f"REAL wrote {rel(metadata_path)}")
    return [output_path, metadata_path]


def find_gadm_level2_zip() -> Path:
    candidates = [RAW_DIR / "gadm" / "gadm41_CHN_2.json.zip"]
    if (RAW_DIR / "gadm").exists():
        candidates.extend(sorted((RAW_DIR / "gadm").glob("*_2.json.zip")))
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise BakeBlocked(
        "aoi",
        [RAW_DIR / "gadm" / "gadm41_CHN_2.json.zip"],
        "Need GADM China level-2 GeoJSON zip for Wuhan 1+8 AOI generation.",
    )


def load_gadm_level2(path: Path) -> dict[str, object]:
    with zipfile.ZipFile(path) as archive:
        json_names = [name for name in archive.namelist() if name.lower().endswith(".json")]
        if not json_names:
            raise BakeBlocked("aoi", [path], "GADM level-2 zip did not contain a JSON file.")
        return json.loads(archive.read(json_names[0]))


def iter_positions(geometry: dict[str, object]) -> Iterable[tuple[float, float]]:
    geometry_type = geometry.get("type")
    coordinates = geometry.get("coordinates")
    if geometry_type == "Polygon":
        for ring in coordinates:  # type: ignore[union-attr]
            for lon, lat in ring:
                yield float(lon), float(lat)
    elif geometry_type == "MultiPolygon":
        for polygon in coordinates:  # type: ignore[union-attr]
            for ring in polygon:
                for lon, lat in ring:
                    yield float(lon), float(lat)
    else:
        raise ValueError(f"unsupported geometry type for AOI: {geometry_type}")


def bbox_for_geometries(geometries: Iterable[dict[str, object]]) -> list[float]:
    min_lon = min_lat = float("inf")
    max_lon = max_lat = float("-inf")
    for geometry in geometries:
        for lon, lat in iter_positions(geometry):
            min_lon = min(min_lon, lon)
            max_lon = max(max_lon, lon)
            min_lat = min(min_lat, lat)
            max_lat = max(max_lat, lat)
    return [round(min_lon, 6), round(min_lat, 6), round(max_lon, 6), round(max_lat, 6)]


def ring_area_km2(ring: list[list[float]]) -> float:
    if len(ring) < 4:
        return 0.0
    total = 0.0
    for first, second in zip(ring, ring[1:]):
        lon1, lat1 = map(math.radians, first[:2])
        lon2, lat2 = map(math.radians, second[:2])
        total += (lon2 - lon1) * (2 + math.sin(lat1) + math.sin(lat2))
    return abs(total * EARTH_RADIUS_M * EARTH_RADIUS_M / 2) / 1_000_000


def polygon_area_km2(polygon: list[list[list[float]]]) -> float:
    if not polygon:
        return 0.0
    exterior = ring_area_km2(polygon[0])
    holes = sum(ring_area_km2(ring) for ring in polygon[1:])
    return max(0.0, exterior - holes)


def geometry_area_km2(geometry: dict[str, object]) -> float:
    geometry_type = geometry.get("type")
    coordinates = geometry.get("coordinates")
    if geometry_type == "Polygon":
        return polygon_area_km2(coordinates)  # type: ignore[arg-type]
    if geometry_type == "MultiPolygon":
        return sum(polygon_area_km2(polygon) for polygon in coordinates)  # type: ignore[arg-type]
    raise ValueError(f"unsupported geometry type for area: {geometry_type}")


def as_multipolygon_coordinates(geometry: dict[str, object]) -> list[object]:
    geometry_type = geometry.get("type")
    coordinates = geometry.get("coordinates")
    if geometry_type == "Polygon":
        return [coordinates]
    if geometry_type == "MultiPolygon":
        return list(coordinates)  # type: ignore[arg-type]
    raise ValueError(f"unsupported geometry type for AOI: {geometry_type}")


def step_aoi_real(_: argparse.Namespace) -> list[Path]:
    ensure_dirs()
    source_path = find_gadm_level2_zip()
    data = load_gadm_level2(source_path)
    features = data.get("features")
    if not isinstance(features, list):
        raise BakeBlocked("aoi", [source_path], "GADM level-2 JSON is not a FeatureCollection.")

    selected = []
    for feature in features:
        properties = feature.get("properties", {})
        if properties.get("NAME_1") == "Hubei" and properties.get("GID_2") in TARGET_GID_SET:
            selected.append(feature)

    selected_gids = {feature["properties"]["GID_2"] for feature in selected}
    missing_gids = sorted(TARGET_GID_SET - selected_gids)
    gid_to_city = {gid: city for city, gid in TARGET_GID_BY_CITY.items()}
    missing_cities = [gid_to_city[gid] for gid in missing_gids]
    if missing_cities:
        raise BakeBlocked(
            "aoi",
            [source_path],
            f"GADM level-2 data missing Wuhan 1+8 cities: {', '.join(missing_cities)}.",
        )

    selected.sort(key=lambda feature: CITIES.index(feature["properties"]["NAME_2"]))
    city_records = []
    multipolygon_coordinates: list[object] = []
    for feature in selected:
        geometry = feature["geometry"]
        properties = feature["properties"]
        area_km2 = round(geometry_area_km2(geometry), 1)
        city_records.append(
            {
                "name": properties["NAME_2"],
                "nameZh": properties.get("NL_NAME_2"),
                "gadmGid": properties.get("GID_2"),
                "engType": properties.get("ENGTYPE_2"),
                "areaKm2": area_km2,
            }
        )
        multipolygon_coordinates.extend(as_multipolygon_coordinates(geometry))

    total_area = round(sum(record["areaKm2"] for record in city_records), 1)
    area_target = 58_000
    area_error_pct = round((total_area - area_target) / area_target * 100, 2)
    if abs(area_error_pct) > 5:
        raise BakeBlocked(
            "aoi",
            [source_path],
            f"AOI area {total_area} km2 is outside the 58,000 km2 +/-5% acceptance band.",
        )

    bbox = bbox_for_geometries([feature["geometry"] for feature in selected])
    aoi_feature = {
        "type": "Feature",
        "properties": {
            "id": "AOI_WUHAN_1PLUS8",
            "name": "Wuhan Metropolitan Area (1+8)",
            "nameZh": "武汉都市圈（武汉城市圈 1+8）",
            "source": "GADM 4.1 China level-2 administrative boundaries",
            "sourceFile": rel(source_path),
            "gadmLevel": 2,
            "cityCount": len(city_records),
            "cities": [record["name"] for record in city_records],
            "cityGids": [record["gadmGid"] for record in city_records],
            "areaKm2": total_area,
            "areaTargetKm2": area_target,
            "areaErrorPct": area_error_pct,
            "bbox": bbox,
            "synthetic": False,
            "realDataReady": True,
            "geometryMethod": "Aggregated selected non-overlapping GADM level-2 MultiPolygon geometries; no synthetic coordinates.",
        },
        "geometry": {
            "type": "MultiPolygon",
            "coordinates": multipolygon_coordinates,
        },
    }
    payload = {
        "type": "FeatureCollection",
        "name": "wuhan_1plus8_aoi_gadm41",
        "features": [aoi_feature],
    }
    metadata = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "sourceFile": rel(source_path),
        "sourceSha256": sha256_file(source_path),
        "aoiReady": True,
        "fullBakeReady": True,
        "selectedCities": city_records,
        "totalAreaKm2": total_area,
        "areaTargetKm2": area_target,
        "areaErrorPct": area_error_pct,
        "bbox": bbox,
        "acceptance": "OK: area is within 58,000 km2 +/-5%",
        "note": "This is a real GADM-derived AOI. Downstream steps still require real subbasin delineation before full-bake.",
    }

    aoi_path = INTERMEDIATE_DIR / "aoi.geojson"
    metadata_path = INTERMEDIATE_DIR / "aoi_metadata.json"
    write_json(aoi_path, payload)
    write_json(metadata_path, metadata)
    print(f"REAL wrote {rel(aoi_path)}")
    print(f"REAL wrote {rel(metadata_path)}")
    print(f"AOI cities: {', '.join(record['name'] for record in city_records)}")
    print(f"AOI area: {total_area} km2 ({area_error_pct:+.2f}% vs 58,000 km2 target)")
    return [aoi_path, metadata_path]


def read_dbf_records(raw: bytes) -> tuple[list[str], list[dict[str, object]]]:
    record_count = int.from_bytes(raw[4:8], "little")
    header_length = int.from_bytes(raw[8:10], "little")
    record_length = int.from_bytes(raw[10:12], "little")
    fields = []
    offset = 32
    while raw[offset] != 0x0D:
        name = raw[offset : offset + 11].split(b"\x00", 1)[0].decode("ascii")
        field_type = chr(raw[offset + 11])
        length = raw[offset + 16]
        decimals = raw[offset + 17]
        fields.append((name, field_type, length, decimals))
        offset += 32

    records: list[dict[str, object]] = []
    for index in range(record_count):
        start = header_length + index * record_length
        row = raw[start : start + record_length]
        if not row or row[0:1] == b"*":
            records.append({})
            continue
        position = 1
        record: dict[str, object] = {}
        for name, field_type, length, decimals in fields:
            value_text = row[position : position + length].decode("ascii", errors="ignore").strip()
            position += length
            if value_text == "":
                record[name] = None
            elif field_type in {"N", "F"}:
                record[name] = float(value_text) if decimals else int(float(value_text))
            else:
                record[name] = value_text
        records.append(record)
    return [field[0] for field in fields], records


def read_shp_polygon_records(raw: bytes) -> Iterable[dict[str, object]]:
    offset = 100
    while offset + 8 <= len(raw):
        record_number, content_length_words = struct_unpack_be_2i(raw[offset : offset + 8])
        offset += 8
        content_length = content_length_words * 2
        content = raw[offset : offset + content_length]
        offset += content_length
        if len(content) < 44:
            continue
        shape_type = int.from_bytes(content[0:4], "little", signed=True)
        if shape_type == 0:
            continue
        if shape_type != 5:
            raise ValueError(f"expected Polygon shape type 5, got {shape_type}")
        bbox = list(struct_unpack_le_4d(content[4:36]))
        part_count = int.from_bytes(content[36:40], "little", signed=True)
        point_count = int.from_bytes(content[40:44], "little", signed=True)
        parts_start = 44
        points_start = parts_start + 4 * part_count
        parts = [
            int.from_bytes(content[parts_start + i * 4 : parts_start + i * 4 + 4], "little", signed=True)
            for i in range(part_count)
        ]
        points = [
            list(struct_unpack_le_2d(content[points_start + i * 16 : points_start + i * 16 + 16]))
            for i in range(point_count)
        ]
        rings = []
        for part_index, start in enumerate(parts):
            end = parts[part_index + 1] if part_index + 1 < len(parts) else point_count
            ring = points[start:end]
            if ring and ring[0] != ring[-1]:
                ring.append(ring[0])
            rings.append(ring)
        yield {
            "recordNumber": record_number,
            "bbox": bbox,
            "rings": rings,
        }


def struct_unpack_be_2i(payload: bytes) -> tuple[int, int]:
    import struct

    return struct.unpack(">2i", payload)


def struct_unpack_le_4d(payload: bytes) -> tuple[float, float, float, float]:
    import struct

    return struct.unpack("<4d", payload)


def struct_unpack_le_2d(payload: bytes) -> tuple[float, float]:
    import struct

    return struct.unpack("<2d", payload)


def bbox_intersects(first: list[float], second: list[float]) -> bool:
    return not (first[2] < second[0] or first[0] > second[2] or first[3] < second[1] or first[1] > second[3])


def hybas_feature_id(hybas_id: int) -> str:
    return f"HB_{hybas_id}"


def check_topology_reaches_outlet(topology: dict[str, str]) -> None:
    for basin_id in topology:
        seen = {basin_id}
        current = topology[basin_id]
        while current != "OUTLET":
            if current in seen:
                raise BakeBlocked("subbasins", [], f"Subbasin topology cycle detected at {current}.")
            if current not in topology:
                break
            seen.add(current)
            current = topology[current]


def pfaf_feature_id(value: object) -> str:
    return f"PF_{int(float(value))}"


def step_subbasins_real(_: argparse.Namespace) -> list[Path]:
    ensure_dirs()
    try:
        import geopandas as gpd
        from shapely.geometry import mapping
    except ModuleNotFoundError as exc:
        raise BakeBlocked(
            "subbasins",
            ["geopandas + shapely in .venv-bake"],
            "Need geopandas and shapely to clip the approved Pfafstetter level_6 vector basins.",
        ) from exc

    aoi_path = INTERMEDIATE_DIR / "aoi.geojson"
    aoi_metadata_path = INTERMEDIATE_DIR / "aoi_metadata.json"
    if not aoi_path.exists() or not aoi_metadata_path.exists():
        raise BakeBlocked("subbasins", [aoi_path, aoi_metadata_path], "Run the real AOI step before Pfafstetter level_6 clipping.")
    aoi_metadata = json.loads(aoi_metadata_path.read_text(encoding="utf-8"))
    source_zip = RAW_DIR / "merit" / "Basin_Asia.gdb.zip"
    if not source_zip.exists():
        raise BakeBlocked("subbasins", [source_zip], "Need project-provided Basin_Asia.gdb.zip with a level_6 layer.")

    source_uri = f"zip://{source_zip.resolve()}"
    selected_level = 6
    source_layer = "level_6"
    basins = gpd.read_file(source_uri, layer=source_layer)
    if basins.crs is None:
        basins = basins.set_crs("EPSG:4326")
    required_columns = {"Pfaf_ID", "Down_ID", "Area", "Total_Area"}
    missing_columns = sorted(required_columns - set(basins.columns))
    if missing_columns:
        raise BakeBlocked(
            "subbasins",
            [f"{source_layer}.{column}" for column in missing_columns],
            "Basin_Asia.gdb level_6 is missing required Pfafstetter topology fields.",
        )

    aoi = gpd.read_file(aoi_path)
    if aoi.crs is None:
        aoi = aoi.set_crs("EPSG:4326")
    aoi = aoi.to_crs(basins.crs)
    aoi_union = aoi.geometry.union_all()
    candidates = basins[basins.intersects(aoi_union)].copy()
    clipped = gpd.overlay(candidates, gpd.GeoDataFrame(geometry=[aoi_union], crs=basins.crs), how="intersection", keep_geom_type=True)
    clipped = clipped[clipped.geometry.notna() & ~clipped.geometry.is_empty].copy()
    clipped["pfaf_int"] = clipped["Pfaf_ID"].map(lambda value: int(float(value)))
    clipped["down_int"] = clipped["Down_ID"].map(
        lambda value: int(float(value)) if value is not None and math.isfinite(float(value)) else None
    )
    clipped = clipped.sort_values("pfaf_int").reset_index(drop=True)

    if not 30 <= len(clipped) <= 80:
        raise BakeBlocked(
            "subbasins",
            [source_zip],
            f"Pfafstetter level_6 AOI clip selected {len(clipped)} basins, outside the 30-80 target.",
        )

    projected = clipped.to_crs("EPSG:6933")
    clipped["clip_area_km2"] = projected.geometry.area / 1_000_000.0
    selected_ids = set(int(value) for value in clipped["pfaf_int"])
    topology: dict[str, str] = {}
    features = []
    for _, record in clipped.iterrows():
        pfaf_id = int(record["pfaf_int"])
        down_id = int(record["down_int"]) if record["down_int"] is not None else None
        basin_id = pfaf_feature_id(pfaf_id)
        downstream = pfaf_feature_id(down_id) if down_id in selected_ids else "OUTLET"
        clip_area_km2 = float(record["clip_area_km2"])
        original_area_km2 = float(record["Area"])
        clip_ratio = clip_area_km2 / original_area_km2 if original_area_km2 > 0 else 0.0
        edge_fragment = clip_ratio < 0.95
        small_clip_fragment = clip_area_km2 < 10.0
        topology[basin_id] = downstream
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "id": basin_id,
                    "pfafId": pfaf_id,
                    "downId": down_id,
                    "sourceBasinId": pfaf_id,
                    "downstream": downstream,
                    "level": selected_level,
                    "subAreaKm2": round(clip_area_km2, 6),
                    "clipAreaKm2": round(clip_area_km2, 6),
                    "originalAreaKm2": round(original_area_km2, 6),
                    "clipAreaRatio": round(clip_ratio, 9),
                    "edgeFragment": edge_fragment,
                    "smallClipFragment": small_clip_fragment,
                    "totalAreaKm2": round(float(record["Total_Area"]), 6),
                    "type": int(record["Type"]),
                    "outletLon": round(float(record["Outlet_lon"]), 8),
                    "outletLat": round(float(record["Outlet_lat"]), 8),
                    "source": "Pfafstetter multi-level basin vector (Basin_Asia.gdb level_6); project-provided, upstream source unverified",
                    "sourceFile": rel(source_zip),
                    "sourceLayer": source_layer,
                    "sourceFieldId": "Pfaf_ID",
                    "sourceDownField": "Down_ID",
                    "selectionMethod": "aoi_intersection_clip_from_level_6",
                    "geometryClippedToAoi": True,
                    "synthetic": False,
                    "fallback": False,
                    "sourceVerified": False,
                    "sourceDisclosureRequired": True,
                },
                "geometry": mapping(record.geometry),
            }
        )

    features.sort(key=lambda feature: feature["properties"]["pfafId"])
    topology = {feature["properties"]["id"]: topology[feature["properties"]["id"]] for feature in features}
    check_topology_reaches_outlet(topology)

    payload = {
        "type": "FeatureCollection",
        "name": "wuhan_pfafstetter_level6_aoi_clip",
        "features": features,
    }
    clipped_areas = sorted(float(feature["properties"]["clipAreaKm2"]) for feature in features)
    original_areas = sorted(float(feature["properties"]["originalAreaKm2"]) for feature in features)

    def median(values: list[float]) -> float:
        midpoint = len(values) // 2
        if len(values) % 2:
            return values[midpoint]
        return (values[midpoint - 1] + values[midpoint]) / 2.0

    metadata = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "sourceFile": rel(source_zip),
        "sourceSha256": sha256_file(source_zip),
        "sourceLayer": source_layer,
        "sourceDescription": "Pfafstetter multi-level basin vector (Basin_Asia.gdb level_6)",
        "sourceCustody": "project-provided local file; upstream original source has not been independently verified",
        "sourceClaimRestriction": "Do not name or imply an upstream source product beyond the project-provided Basin_Asia.gdb level_6 file unless provenance is later verified.",
        "selectionMethod": "Intersected level_6 polygons with the GADM-derived Wuhan 1+8 AOI and clipped geometries to the AOI boundary.",
        "subbasinsReady": True,
        "formalPfafstetterVectorReady": True,
        "fullBakeReady": True,
        "geometryClippedToAoi": True,
        "sourceVerified": False,
        "sourceDisclosureRequired": True,
        "limitations": [
            "The project owner approved this vector Pfafstetter level_6 source for the formal T1.2 subbasin step.",
            "The file is project-provided and its upstream original source has not been independently verified.",
            "Final meta.source and methodology must disclose: Pfafstetter multi-level basin vector (Basin_Asia.gdb level_6), project-provided, upstream source unverified.",
            "Do not describe this source using any named upstream product label unless upstream provenance is later verified.",
        ],
        "aoiBBox": aoi_metadata["bbox"],
        "subbasinCount": len(features),
        "targetCountRange": [30, 80],
        "areaKm2": {
            "clippedTotal": round(sum(float(feature["properties"]["clipAreaKm2"]) for feature in features), 6),
            "medianClipped": round(median(clipped_areas), 6),
            "medianOriginal": round(median(original_areas), 6),
            "edgeFragmentCount": sum(1 for feature in features if feature["properties"]["edgeFragment"]),
            "smallClipFragmentCount": sum(1 for feature in features if feature["properties"]["smallClipFragment"]),
        },
        "topologyCheck": "OK: Down_ID-derived downstream graph reaches OUTLET with no detected cycles",
    }

    subbasins_path = INTERMEDIATE_DIR / "subbasins_raw.geojson"
    topology_path = INTERMEDIATE_DIR / "topology.json"
    metadata_path = INTERMEDIATE_DIR / "subbasins_metadata.json"
    write_json(subbasins_path, payload)
    write_json(topology_path, topology)
    write_json(metadata_path, metadata)
    print(f"REAL wrote {rel(subbasins_path)}")
    print(f"REAL wrote {rel(topology_path)}")
    print(f"REAL wrote {rel(metadata_path)}")
    print(f"Pfafstetter level_6 AOI-clipped subbasins: {len(features)}")
    print("Topology check: OK, every selected basin reaches OUTLET through Down_ID topology")
    return [subbasins_path, topology_path, metadata_path]


def step_zonal_real(_: argparse.Namespace) -> list[Path]:
    ensure_dirs()
    subbasin_features = load_subbasin_features()
    precip_grid = load_power_annual_grid("PRECTOTCORR")
    evptrns_grid = load_power_annual_grid("EVPTRNS")
    t2m_grid = load_power_annual_grid("T2M")

    rows = []
    methods = set()
    for feature in subbasin_features:
        properties = feature.get("properties", {})
        bbox = feature.get("bbox")
        if not isinstance(bbox, list):
            geometry = feature.get("geometry")
            if not isinstance(geometry, dict):
                raise BakeBlocked("zonal", [], "Subbasin feature has no bbox or geometry for climate aggregation.")
            bbox = bbox_for_geometries([geometry])

        precip_mm, precip_points, precip_method = annual_grid_value(precip_grid, bbox, "sum")
        evptrns_mj_m2, evptrns_points, evptrns_method = annual_grid_value(evptrns_grid, bbox, "sum")
        t2m_c, t2m_points, t2m_method = annual_grid_value(t2m_grid, bbox, "mean")
        row_methods = {precip_method, evptrns_method, t2m_method}
        methods.update(row_methods)
        rows.append(
            {
                "id": properties.get("id"),
                "hybas_id": properties.get("hybasId"),
                "area_km2": properties.get("subAreaKm2"),
                "bbox_min_lon": round(float(bbox[0]), 6),
                "bbox_min_lat": round(float(bbox[1]), 6),
                "bbox_max_lon": round(float(bbox[2]), 6),
                "bbox_max_lat": round(float(bbox[3]), 6),
                "precip_mm": precip_mm,
                "evptrns_mj_m2_proxy": evptrns_mj_m2,
                "t2m_c_mean": t2m_c,
                "power_grid_points_precip": precip_points,
                "power_grid_points_evptrns": evptrns_points,
                "power_grid_points_t2m": t2m_points,
                "method": "+".join(sorted(row_methods)),
            }
        )

    climate_path = INTERMEDIATE_DIR / "zonal_climate.csv"
    metadata_path = INTERMEDIATE_DIR / "zonal_metadata.json"
    write_csv(climate_path, rows)

    python_modules = {
        name: python_module_available(name)
        for name in ["rasterio", "geopandas", "shapely", "fiona", "pyproj", "rasterstats"]
    }
    cli_tools = {name: command_available(name) for name in ["gdalinfo", "gdalwarp", "ogr2ogr", "mapshaper"]}
    cli_tools["mapshaperLocal"] = local_node_bin_available("mapshaper")
    viirs_ready = has_files(RAW_DIR / "viirs")
    raster_engine_ready = python_modules["rasterio"] and python_modules["geopandas"] and python_modules["rasterstats"]
    partial_outputs = [rel(climate_path)]
    landpop_stats_ready = False
    landpop_metadata: dict[str, object] | None = None
    nightlight_proxy_ready = False
    nightlight_metadata: dict[str, object] | None = None
    if raster_engine_ready:
        landpop_path, landpop_metadata = compute_landpop_partial(rows)
        landpop_stats_ready = True
        partial_outputs.append(rel(landpop_path))
        if viirs_ready:
            nightlight_path, nightlight_metadata = compute_wb_len_nightlight_partial()
            nightlight_proxy_ready = True
            partial_outputs.append(rel(nightlight_path))

    approved_nightlight_proxy = bool(
        nightlight_metadata
        and nightlight_metadata.get("industrialProxyApprovedForFullBake") is True
        and nightlight_metadata.get("worldBankLenProxyApprovedForFullBake") is True
        and not nightlight_metadata.get("missingMonthsAfterInterpolation")
    )
    formal_raster_implementation_ready = bool(raster_engine_ready and landpop_stats_ready and approved_nightlight_proxy)
    formal_output_path = INTERMEDIATE_DIR / "zonal.csv"
    formal_output_written = False
    formal_rows: list[dict[str, object]] = []
    if formal_raster_implementation_ready:
        landpop_rows = load_csv_rows(INTERMEDIATE_DIR / "zonal_landpop.csv")
        nightlight_rows = load_csv_rows(INTERMEDIATE_DIR / "zonal_nightlight_draft.csv")
        landpop_by_id = {row["id"]: row for row in landpop_rows}
        nightlight_by_id = {row["id"]: row for row in nightlight_rows}
        climate_by_id = {str(row["id"]): row for row in rows}
        missing_ids = sorted(
            (set(climate_by_id) ^ set(landpop_by_id))
            | (set(climate_by_id) ^ set(nightlight_by_id))
        )
        if missing_ids:
            raise BakeBlocked(
                "zonal",
                [f"formal zonal id mismatch: {basin_id}" for basin_id in missing_ids[:10]],
                "Climate, land/pop, and WB LEN rows must cover the same topology IDs before writing zonal.csv.",
            )
        for basin_id in sorted(climate_by_id):
            climate = climate_by_id[basin_id]
            landpop = landpop_by_id[basin_id]
            nightlight = nightlight_by_id[basin_id]
            formal_rows.append(
                {
                    "id": basin_id,
                    "source_basin_id": landpop.get("source_basin_id"),
                    "pfaf_id": landpop.get("pfaf_id"),
                    "hybas_id": landpop.get("hybas_id"),
                    "level": landpop.get("level"),
                    "area_km2": landpop.get("sub_area_km2") or climate.get("area_km2"),
                    "sub_area_km2": landpop.get("sub_area_km2") or climate.get("area_km2"),
                    "fallback": landpop.get("fallback"),
                    "cropland_ha": landpop.get("clcd_cropland_ha"),
                    "builtup_ha": landpop.get("clcd_builtup_ha"),
                    "population": landpop.get("worldpop_population"),
                    "clcd_cropland_ha": landpop.get("clcd_cropland_ha"),
                    "clcd_builtup_ha": landpop.get("clcd_builtup_ha"),
                    "worldcover_cropland_ha_nominal": landpop.get("worldcover_cropland_ha_nominal"),
                    "worldcover_builtup_ha_nominal": landpop.get("worldcover_builtup_ha_nominal"),
                    "worldpop_population": landpop.get("worldpop_population"),
                    "ind_weight": nightlight.get("ind_weight_wb_len"),
                    "ind_weight_wb_len": nightlight.get("ind_weight_wb_len"),
                    "wb_len_mean_radiance": nightlight.get("wb_len_mean_radiance"),
                    "wb_len_max_radiance": nightlight.get("wb_len_max_radiance"),
                    "wb_len_pixel_count": nightlight.get("wb_len_pixel_count"),
                    "precip_mm": climate.get("precip_mm"),
                    "evptrns_mj_m2_proxy": climate.get("evptrns_mj_m2_proxy"),
                    "t2m_c_mean": climate.get("t2m_c_mean"),
                    "et0_mm": "",
                    "industrial_proxy_source": "world_bank_light_every_night_12month_ncf_weighted_with_adjacent_month_interpolation",
                    "nightlight_months_used": nightlight.get("months_used"),
                    "nightlight_observed_months": nightlight.get("observed_months"),
                    "nightlight_interpolated_months": nightlight.get("interpolated_months"),
                    "formal_zonal_ready": True,
                    "method": "formal_rasterstats_pfafstetter_level6_wb_len_12month_interpolated",
                }
            )
        write_csv(formal_output_path, formal_rows)
        formal_output_written = True
        partial_outputs.append(rel(formal_output_path))

    blocked_missing: list[str | Path] = []
    if formal_output_written:
        blocked_missing = []
    elif not viirs_ready:
        blocked_missing.append(RAW_DIR / "viirs")
    elif not nightlight_proxy_ready:
        blocked_missing.append("World Bank Light Every Night monthly avg_rade9/n_cf BBox clips")
    if not raster_engine_ready:
        blocked_missing.append("rasterio + geopandas + rasterstats polygon zonal runtime")
    if not (cli_tools["gdalinfo"] or python_modules["rasterio"]):
        blocked_missing.append("GDAL/rasterio GeoTIFF metadata and window processing")
    if nightlight_proxy_ready and not approved_nightlight_proxy:
        blocked_missing.append("approved 12-month World Bank Light Every Night proxy metadata before formal zonal.csv")
    elif not formal_raster_implementation_ready and not formal_output_written:
        blocked_missing.append("VIIRS nightlight industrial-weight zonal implementation")

    metadata = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "step": "zonal",
        "partialOutputs": partial_outputs,
        "formalOutput": rel(formal_output_path),
        "formalOutputWritten": formal_output_written,
        "climateStatsReady": True,
        "landPopStatsReady": landpop_stats_ready,
        "rasterStatsReady": formal_output_written,
        "rasterEngineReady": raster_engine_ready,
        "formalRasterImplementationReady": formal_raster_implementation_ready,
        "viirsRawNightlightFilesPresent": viirs_ready,
        "viirsReady": False,
        "preferredViirsReady": False,
        "eogAnnualVnlReady": False,
        "nightlightProxyReady": nightlight_proxy_ready,
        "industrialWeightDraftReady": nightlight_proxy_ready,
        "industrialProxyApprovedForFullBake": approved_nightlight_proxy,
        "worldBankLenProxyApprovedForFullBake": approved_nightlight_proxy,
        "fullBakeReady": formal_output_written,
        "notFullBake": not formal_output_written,
        "mustNotSatisfyFullBake": not formal_output_written,
        "subbasinCount": len(rows),
        "subbasinsSource": rel(INTERMEDIATE_DIR / "subbasins_raw.geojson"),
        "climateSource": {
            "provider": "NASA POWER daily regional CSV fallback",
            "variables": ["PRECTOTCORR", "EVPTRNS", "T2M"],
            "method": sorted(methods),
            "note": "EVPTRNS is retained as an evapotranspiration energy-flux proxy, not FAO-56 ET0.",
        },
        "rasterInputsPresent": {
            "clcd": has_files(RAW_DIR / "clcd"),
            "worldcover": has_files(RAW_DIR / "worldcover"),
            "worldpop": has_files(RAW_DIR / "worldpop"),
            "viirs": viirs_ready,
        },
        "landPopPartial": landpop_metadata,
        "nightlightPartial": nightlight_metadata,
        "formalChecks": {
            "formalRowCount": len(formal_rows),
            "formalIdsMatchTopology": len(formal_rows) == len(rows),
            "nightlightMissingMonthsAfterInterpolation": (
                nightlight_metadata.get("missingMonthsAfterInterpolation", []) if nightlight_metadata else []
            ),
            "sourceDisclosure": "Industrial downscaling uses World Bank Light Every Night, not EOG Annual VNL.",
        },
        "runtimeSupport": {
            "pythonModules": python_modules,
            "cliTools": cli_tools,
            "sharp": "sharp@0.35.1 is installed; require() and a tiny PNG transform have passed locally. GIS zonal processing still uses rasterio/geopandas/rasterstats.",
        },
        "blockedMissing": [str(item) for item in blocked_missing],
        "limitations": [
            "This step computes NASA POWER climate summaries, CLCD/WorldCover/WorldPop zonal statistics, and WB LEN nightlight proxy weights for the AOI-clipped Pfafstetter level_6 units.",
            "Industrial downscaling uses World Bank Light Every Night monthly clips with adjacent-month interpolation for missing 202206 and 202208; EOG Annual VNL was not used.",
            "Existing older intermediate/zonal.csv files should be trusted only when this metadata has formalOutputWritten=true and rasterStatsReady=true.",
        ],
    }
    write_json(metadata_path, metadata)

    print(f"REAL-PARTIAL wrote {rel(climate_path)}")
    if landpop_metadata:
        print(f"REAL-PARTIAL wrote {landpop_metadata['output']}")
    print(f"REAL-PARTIAL wrote {rel(metadata_path)}")
    print(f"Climate rows: {len(rows)} subbasins from NASA POWER daily CSVs")
    if landpop_stats_ready:
        print("Land/pop raster partial: CLCD, WorldCover, and WorldPop zonal summaries written")
    if nightlight_proxy_ready and nightlight_metadata:
        print(
            "Nightlight proxy: "
            f"{nightlight_metadata['rowCount']} subbasins from {len(nightlight_metadata['monthsUsed'])} WB LEN monthly composites; "
            f"missing after interpolation={','.join(nightlight_metadata['missingMonthsAfterInterpolation'])}"
        )
    if formal_output_written:
        print(f"REAL wrote {rel(formal_output_path)}")
        print("Formal zonal.csv is approved for downstream demand drafts with WB LEN 12-month interpolated industrial proxy.")
        return [climate_path, INTERMEDIATE_DIR / "zonal_landpop.csv", INTERMEDIATE_DIR / "zonal_nightlight_draft.csv", formal_output_path, metadata_path]
    if not raster_engine_ready:
        note = (
            "Partial climate zonal evidence is written, but formal T1.3 raster zonal statistics remain "
            "blocked by a usable GIS raster engine, approved nightlight/industrial weights, and the formal raster zonal implementation."
        )
    elif not viirs_ready:
        note = (
            "Partial climate and land/pop zonal evidence is written, and the .venv-bake GIS runtime can import rasterio/geopandas, "
            "but formal T1.3 remains blocked by VIIRS credentials and industrial-weight zonal implementation."
        )
    elif nightlight_proxy_ready:
        note = (
            "Partial climate, land/pop, and World Bank Light Every Night nightlight evidence is written, "
            "but formal T1.3 remains blocked until the WB LEN fallback metadata is approved and zonal.csv is finalized."
        )
    else:
        note = (
            "Partial climate zonal evidence is written, but formal T1.3 raster zonal statistics are not implemented yet."
        )
    raise BakeBlocked(
        "zonal",
        blocked_missing,
        note,
    )


def step_aoi_stub(_: argparse.Namespace) -> list[Path]:
    ensure_dirs()
    path = INTERMEDIATE_DIR / "aoi.geojson"
    write_json(path, stub_aoi())
    print(f"STUB wrote {rel(path)}")
    print("PLACEHOLDER: AOI is a bbox polygon, not dissolved GADM boundaries.")
    return [path]


def step_subbasins_stub(_: argparse.Namespace) -> list[Path]:
    ensure_dirs()
    geojson, topology = stub_subbasins()
    subbasins_path = INTERMEDIATE_DIR / "subbasins_raw.geojson"
    topology_path = INTERMEDIATE_DIR / "topology.json"
    write_json(subbasins_path, geojson)
    write_json(topology_path, topology)
    print(f"STUB wrote {rel(subbasins_path)}")
    print(f"STUB wrote {rel(topology_path)}")
    print("PLACEHOLDER: 4 synthetic cells are below the 30-80 full-bake target.")
    return [subbasins_path, topology_path]


def step_zonal_stub(_: argparse.Namespace) -> list[Path]:
    ensure_dirs()
    rows = [
        {
            "id": "SB_STUB_01",
            "city": "Tianmen",
            "area_km2": 520,
            "cropland_ha": 26000,
            "builtup_ha": 3600,
            "population": 190000,
            "ind_weight": 0.11,
            "precip_mm": 1120,
            "et0_mm": 880,
        },
        {
            "id": "SB_STUB_02",
            "city": "Wuhan",
            "area_km2": 610,
            "cropland_ha": 18000,
            "builtup_ha": 14500,
            "population": 960000,
            "ind_weight": 0.42,
            "precip_mm": 1180,
            "et0_mm": 900,
        },
        {
            "id": "SB_STUB_03",
            "city": "Ezhou",
            "area_km2": 480,
            "cropland_ha": 12000,
            "builtup_ha": 8700,
            "population": 420000,
            "ind_weight": 0.28,
            "precip_mm": 1210,
            "et0_mm": 910,
        },
        {
            "id": "SB_STUB_04",
            "city": "Huanggang",
            "area_km2": 700,
            "cropland_ha": 31000,
            "builtup_ha": 5200,
            "population": 350000,
            "ind_weight": 0.19,
            "precip_mm": 1160,
            "et0_mm": 890,
        },
    ]
    path = INTERMEDIATE_DIR / "zonal.csv"
    write_csv(path, rows)
    print(f"STUB wrote {rel(path)}")
    print("PLACEHOLDER: zonal values are synthetic and not raster-derived.")
    return [path]


def step_demand_stub(_: argparse.Namespace) -> list[Path]:
    ensure_dirs()
    zonal_path = INTERMEDIATE_DIR / "zonal.csv"
    if not zonal_path.exists():
        step_zonal_stub(_)
    rows = []
    for row in load_csv_rows(zonal_path):
        cropland = float(row["cropland_ha"])
        population = float(row["population"])
        ind_weight = float(row["ind_weight"])
        rows.append(
            {
                "id": row["id"],
                "city": row["city"],
                "agri": round(cropland * 5500),
                "industry": round(ind_weight * 240_000_000),
                "urban": round(population * 73),
                "eco": round(float(row["area_km2"]) * 90000),
            }
        )
    path = INTERMEDIATE_DIR / "demand.csv"
    write_csv(path, rows)
    print(f"STUB wrote {rel(path)}")
    print("PLACEHOLDER: demand uses default coefficients and synthetic proxy weights.")
    return [path]


def step_supply_stub(_: argparse.Namespace) -> list[Path]:
    ensure_dirs()
    zonal_path = INTERMEDIATE_DIR / "zonal.csv"
    if not zonal_path.exists():
        step_zonal_stub(_)
    topology = read_topology()
    local = {}
    for row in load_csv_rows(zonal_path):
        area = float(row["area_km2"])
        precip = float(row["precip_mm"])
        local[row["id"]] = area * precip * 1000 * 0.40
    upstreams: dict[str, list[str]] = {basin_id: [] for basin_id in topology}
    for basin_id, downstream in topology.items():
        if downstream != "OUTLET":
            upstreams.setdefault(downstream, []).append(basin_id)
    memo: dict[str, float] = {}

    def avail(basin_id: str) -> float:
        if basin_id not in memo:
            mainstem = 60_000_000 if basin_id in {"SB_STUB_01", "SB_STUB_04"} else 0
            memo[basin_id] = local[basin_id] + mainstem + sum(avail(up_id) * 0.65 for up_id in upstreams.get(basin_id, []))
        return memo[basin_id]

    rows = [
        {
            "id": basin_id,
            "qLocal": round(local[basin_id]),
            "qAvail": round(avail(basin_id)),
            "mainstemInflow": 60_000_000 if basin_id in {"SB_STUB_01", "SB_STUB_04"} else 0,
            "runoffCoeff": 0.40,
        }
        for basin_id in topology
    ]
    path = INTERMEDIATE_DIR / "supply.csv"
    write_csv(path, rows)
    print(f"STUB wrote {rel(path)}")
    print("PLACEHOLDER: routed supply is synthetic; mainstem inflow is illustrative only.")
    return [path]


def step_health_stub(_: argparse.Namespace) -> list[Path]:
    ensure_dirs()
    topology = read_topology()
    payload = {
        basin_id: {
            "healthWeight": {"agri": 0.1, "industry": -0.22, "urban": 1.0, "eco": 0.6},
            "downstreamReach": downstream_reach(basin_id, topology),
        }
        for basin_id in topology
    }
    path = INTERMEDIATE_DIR / "health.json"
    write_json(path, payload)
    print(f"STUB wrote {rel(path)}")
    print("PLACEHOLDER: health weights are demo constants, not calibrated estimates.")
    return [path]


def step_bake_stub(_: argparse.Namespace) -> list[Path]:
    ensure_dirs()
    if not (INTERMEDIATE_DIR / "subbasins_raw.geojson").exists():
        step_subbasins_stub(_)
    if not (INTERMEDIATE_DIR / "demand.csv").exists():
        step_demand_stub(_)
    if not (INTERMEDIATE_DIR / "supply.csv").exists():
        step_supply_stub(_)
    if not (INTERMEDIATE_DIR / "health.json").exists():
        step_health_stub(_)

    topology = read_topology()
    demand = {row["id"]: row for row in load_csv_rows(INTERMEDIATE_DIR / "demand.csv")}
    supply = {row["id"]: row for row in load_csv_rows(INTERMEDIATE_DIR / "supply.csv")}
    zonal = {row["id"]: row for row in load_csv_rows(INTERMEDIATE_DIR / "zonal.csv")}
    health = json.loads((INTERMEDIATE_DIR / "health.json").read_text(encoding="utf-8"))
    subbasins = []
    for basin_id, downstream in topology.items():
        z = zonal[basin_id]
        d = demand[basin_id]
        s = supply[basin_id]
        subbasins.append(
            {
                "id": basin_id,
                "name": basin_id.replace("_", " "),
                "adminCities": [z["city"]],
                "areaKm2": float(z["area_km2"]),
                "population": float(z["population"]),
                "centroid": [113.0 + len(subbasins) * 0.65, 29.6 + len(subbasins) * 0.35],
                "zonalProxy": {
                    "croplandHa": float(z["cropland_ha"]),
                    "builtupHa": float(z["builtup_ha"]),
                    "industrialWeight": float(z["ind_weight"]),
                    "precipMm": float(z["precip_mm"]),
                },
                "demand": {sector: float(d[sector]) for sector in SECTORS},
                "supply": {
                    "qLocal": float(s["qLocal"]),
                    "qAvail": float(s["qAvail"]),
                    "mainstemInflow": float(s["mainstemInflow"]),
                    "runoffCoeff": float(s["runoffCoeff"]),
                },
                "healthWeight": health[basin_id]["healthWeight"],
                "downstream": downstream,
                "downstreamReach": health[basin_id]["downstreamReach"],
            }
        )

    attrs = {
        "meta": {
            "region": "Wuhan Metropolitan Area (1+8)",
            "regionZh": "武汉都市圈（武汉城市圈 1+8）",
            "calibrationYear": 2022,
            "datasetType": "offline-bake-stub",
            "demoSample": True,
            "estimated": True,
            "synthetic": True,
            "realDataReady": False,
            "source": "Synthetic bake.py --stub output for pipeline wiring only.",
            "note": "This output is intentionally written under research/tools/bake/out and must not be copied to research/data as a full bake.",
            "bbox": BBOX,
            "sectors": SECTORS,
            "citySet": CITIES,
        },
        "topology": topology,
        "subbasins": subbasins,
    }
    rivers = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "id": f"R_{basin_id}",
                    "from": basin_id,
                    "to": downstream,
                    "synthetic": True,
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[113.0 + i * 0.4, 29.4 + i * 0.25], [113.3 + i * 0.4, 29.65 + i * 0.25]],
                },
            }
            for i, (basin_id, downstream) in enumerate(topology.items())
        ],
    }

    attrs_path = OUT_DIR / "wuhan-attrs.stub.json"
    subbasins_path = OUT_DIR / "wuhan-subbasins.stub.geojson"
    rivers_path = OUT_DIR / "wuhan-rivers.stub.geojson"
    write_json(attrs_path, attrs)
    write_json(subbasins_path, json.loads((INTERMEDIATE_DIR / "subbasins_raw.geojson").read_text(encoding="utf-8")))
    write_json(rivers_path, rivers)
    print(f"STUB wrote {rel(attrs_path)}")
    print(f"STUB wrote {rel(subbasins_path)}")
    print(f"STUB wrote {rel(rivers_path)}")
    print("PLACEHOLDER: out/*stub* files are synthetic and do not satisfy --full-bake.")
    return [attrs_path, subbasins_path, rivers_path]


def step_provenance_stub(_: argparse.Namespace) -> list[Path]:
    ensure_dirs()
    files = sorted(INTERMEDIATE_DIR.glob("*")) + sorted(OUT_DIR.glob("*"))
    payload = {
        "synthetic": True,
        "realDataReady": False,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "note": "Stub provenance for bake.py wiring only. It is not research/data/provenance.json.",
        "files": [
            {
                "path": rel(path),
                "sha256": sha256_file(path) if path.is_file() else None,
            }
            for path in files
            if path.is_file()
        ],
    }
    path = OUT_DIR / "provenance.stub.json"
    write_json(path, payload)
    print(f"STUB wrote {rel(path)}")
    return [path]


def step_provenance_draft_stub(_: argparse.Namespace) -> list[Path]:
    print("STUB provenance-draft: no synthetic draft is produced; rerun without --stub for audit-only raw provenance draft.")
    return []


def step_bulletin_draft_stub(_: argparse.Namespace) -> list[Path]:
    print("STUB bulletin-draft: no synthetic bulletin extraction is produced; rerun without --stub for audit-only PDF extraction.")
    return []


def step_mainstem_inflow_draft_stub(_: argparse.Namespace) -> list[Path]:
    print("STUB mainstem-inflow-draft: no synthetic mainstem inflow extraction is produced; rerun without --stub for audit-only PDF extraction.")
    return []


def step_mainstem_node_mapping_draft_stub(_: argparse.Namespace) -> list[Path]:
    print("STUB mainstem-node-mapping-draft: no synthetic node mapping is produced; rerun without --stub for audit-only HydroRIVERS/subbasin mapping.")
    return []


def step_rivers_flowthrough_draft_stub(_: argparse.Namespace) -> list[Path]:
    print("STUB rivers-flowthrough-draft: no synthetic river flowThrough draft is produced; rerun without --stub for audit-only HydroRIVERS flowThrough mapping.")
    return []


def step_mainstem_injection_plan_draft_stub(_: argparse.Namespace) -> list[Path]:
    print("STUB mainstem-injection-plan-draft: no synthetic mainstem injection plan is produced; rerun without --stub for audit-only injection planning.")
    return []


def step_demand_draft_stub(_: argparse.Namespace) -> list[Path]:
    print("STUB demand-draft: no synthetic demand draft is produced; rerun without --stub for audit-only bulletin/zonal downscaling.")
    return []


def step_city_demand_allocation_draft_stub(_: argparse.Namespace) -> list[Path]:
    print("STUB city-demand-allocation-draft: no synthetic city allocation is produced; rerun without --stub for audit-only GADM/subbasin overlay.")
    return []


def step_supply_draft_stub(_: argparse.Namespace) -> list[Path]:
    print("STUB supply-draft: no synthetic supply draft is produced; rerun without --stub for audit-only climate/topology routing.")
    return []


def step_health_reach_draft_stub(_: argparse.Namespace) -> list[Path]:
    print("STUB health-reach-draft: no synthetic health reach draft is produced; rerun without --stub for audit-only topology/population exposure.")
    return []


def step_bake_preflight_stub(_: argparse.Namespace) -> list[Path]:
    print("STUB bake-preflight: no synthetic preflight report is produced; rerun without --stub for audit-only contract readiness checks.")
    return []


def step_validate_stub(_: argparse.Namespace) -> list[Path]:
    print("STUB validate: synthetic outputs exist only under research/tools/bake/out.")
    print("PLACEHOLDER: not running node research/tools/validate_research_data.js --full-bake for stub data.")
    return []


def step_name_stub(_: argparse.Namespace) -> list[Path]:
    print("STUB name: readable labels apply only to research/data/wuhan-attrs.json.")
    return []


def block_aoi(_: argparse.Namespace) -> None:
    require_paths(
        "aoi",
        [RAW_DIR / "gadm"],
        "Need GADM or equivalent level-2 boundaries for the Wuhan 1+8 cities.",
    )


def block_subbasins(_: argparse.Namespace) -> None:
    require_paths(
        "subbasins",
        [RAW_DIR / "merit" / "Basin_Asia.gdb.zip", INTERMEDIATE_DIR / "aoi.geojson"],
        "Need project-provided Basin_Asia.gdb level_6 vector basins plus a real AOI before formal subbasin clipping.",
    )


def block_zonal(_: argparse.Namespace) -> None:
    require_paths(
        "zonal",
        [
            RAW_DIR / "clcd",
            RAW_DIR / "worldcover",
            RAW_DIR / "worldpop",
            RAW_DIR / "climate",
            INTERMEDIATE_DIR / "subbasins_raw.geojson",
        ],
        "Need real public raster inputs, climate CSVs, and subbasins before partial zonal processing.",
    )


def block_demand(_: argparse.Namespace) -> None:
    require_paths(
        "demand",
        [INTERMEDIATE_DIR / "zonal.csv", INTERMEDIATE_DIR / "zonal_metadata.json", INTERMEDIATE_DIR / "topology.json", RAW_DIR / "bulletin"],
        "Need zonal statistics and Hubei Water Resources Bulletin tables before demand estimation.",
    )
    require_metadata_flag(
        "demand",
        INTERMEDIATE_DIR / "zonal_metadata.json",
        "rasterStatsReady",
        "Need completed polygon raster zonal statistics with approved nightlight/industrial weights; partial zonal outputs are not enough for demand estimation.",
    )
    require_metadata_flag(
        "demand",
        INTERMEDIATE_DIR / "zonal_metadata.json",
        "formalOutputWritten",
        "Need formal intermediate/zonal.csv written by the real raster zonal step, not a stale stub file.",
    )
    require_metadata_flag(
        "demand",
        INTERMEDIATE_DIR / "zonal_metadata.json",
        "industrialProxyApprovedForFullBake",
        "Need explicit approval of the industrial nightlight/proxy before formal demand estimation.",
    )
    require_metadata_flag(
        "demand",
        INTERMEDIATE_DIR / "zonal_metadata.json",
        "fullBakeReady",
        "Need zonal metadata fullBakeReady=true before formal demand estimation.",
    )
    require_metadata_flag_not_true(
        "demand",
        INTERMEDIATE_DIR / "zonal_metadata.json",
        "mustNotSatisfyFullBake",
        "Zonal metadata is still marked mustNotSatisfyFullBake; do not run formal demand.",
    )
    require_csv_ids_match_topology("demand", INTERMEDIATE_DIR / "zonal.csv")


def block_supply(_: argparse.Namespace) -> None:
    require_paths(
        "supply",
        [INTERMEDIATE_DIR / "demand.csv", INTERMEDIATE_DIR / "demand_metadata.json", INTERMEDIATE_DIR / "topology.json", RAW_DIR / "climate"],
        "Need demand, topology, and climate/runoff inputs before supply routing.",
    )
    require_metadata_flag(
        "supply",
        INTERMEDIATE_DIR / "demand_metadata.json",
        "demandReady",
        "Need demand metadata confirming real bulletin-calibrated demand; stale demand.csv is not enough.",
    )
    require_metadata_flag(
        "supply",
        INTERMEDIATE_DIR / "demand_metadata.json",
        "formalOutputWritten",
        "Need formal intermediate/demand.csv written by the real demand step, not a stale stub file.",
    )
    require_metadata_flag(
        "supply",
        INTERMEDIATE_DIR / "demand_metadata.json",
        "fullBakeReady",
        "Need demand metadata fullBakeReady=true before formal supply routing.",
    )
    require_metadata_flag_not_true(
        "supply",
        INTERMEDIATE_DIR / "demand_metadata.json",
        "mustNotSatisfyFullBake",
        "Demand metadata is still marked mustNotSatisfyFullBake; do not run formal supply.",
    )
    require_csv_ids_match_topology("supply", INTERMEDIATE_DIR / "demand.csv")


def block_health(_: argparse.Namespace) -> None:
    require_paths(
        "health",
        [
            INTERMEDIATE_DIR / "demand.csv",
            INTERMEDIATE_DIR / "demand_metadata.json",
            INTERMEDIATE_DIR / "supply.csv",
            INTERMEDIATE_DIR / "supply_metadata.json",
            INTERMEDIATE_DIR / "topology.json",
        ],
        "Need demand, supply, and topology before downstream health weighting.",
    )
    require_metadata_flag(
        "health",
        INTERMEDIATE_DIR / "demand_metadata.json",
        "demandReady",
        "Need real demand metadata before health weighting.",
    )
    require_metadata_flag(
        "health",
        INTERMEDIATE_DIR / "demand_metadata.json",
        "formalOutputWritten",
        "Need formal demand output before health weighting.",
    )
    require_metadata_flag(
        "health",
        INTERMEDIATE_DIR / "demand_metadata.json",
        "fullBakeReady",
        "Need demand metadata fullBakeReady=true before health weighting.",
    )
    require_metadata_flag(
        "health",
        INTERMEDIATE_DIR / "supply_metadata.json",
        "supplyReady",
        "Need real routed supply metadata before health weighting.",
    )
    require_metadata_flag(
        "health",
        INTERMEDIATE_DIR / "supply_metadata.json",
        "formalOutputWritten",
        "Need formal supply output before health weighting.",
    )
    require_metadata_flag(
        "health",
        INTERMEDIATE_DIR / "supply_metadata.json",
        "fullBakeReady",
        "Need supply metadata fullBakeReady=true before health weighting.",
    )
    require_metadata_flag_not_true(
        "health",
        INTERMEDIATE_DIR / "demand_metadata.json",
        "mustNotSatisfyFullBake",
        "Demand metadata is marked mustNotSatisfyFullBake; do not run formal health.",
    )
    require_metadata_flag_not_true(
        "health",
        INTERMEDIATE_DIR / "supply_metadata.json",
        "mustNotSatisfyFullBake",
        "Supply metadata is marked mustNotSatisfyFullBake; do not run formal health.",
    )


def block_bake(_: argparse.Namespace) -> None:
    require_paths(
        "bake",
        [
            INTERMEDIATE_DIR / "subbasins_raw.geojson",
            INTERMEDIATE_DIR / "subbasins_metadata.json",
            INTERMEDIATE_DIR / "topology.json",
            INTERMEDIATE_DIR / "zonal.csv",
            INTERMEDIATE_DIR / "zonal_metadata.json",
            INTERMEDIATE_DIR / "demand.csv",
            INTERMEDIATE_DIR / "demand_metadata.json",
            INTERMEDIATE_DIR / "supply.csv",
            INTERMEDIATE_DIR / "supply_metadata.json",
            INTERMEDIATE_DIR / "health.json",
            INTERMEDIATE_DIR / "health_metadata.json",
        ],
        "Need all real intermediate products before writing the research/data contract.",
    )
    for metadata_path, flag, note in [
        (
            INTERMEDIATE_DIR / "subbasins_metadata.json",
            "fullBakeReady",
            "Need final-approved Pfafstetter level_6 subbasins metadata before full bake.",
        ),
        (
            INTERMEDIATE_DIR / "zonal_metadata.json",
            "formalOutputWritten",
            "Need formal intermediate/zonal.csv written by the real zonal step before writing the research/data contract.",
        ),
        (
            INTERMEDIATE_DIR / "zonal_metadata.json",
            "rasterStatsReady",
            "Need completed raster zonal statistics before writing the research/data contract.",
        ),
        (
            INTERMEDIATE_DIR / "zonal_metadata.json",
            "nightlightProxyReady",
            "Need documented nightlight proxy readiness before writing the research/data contract.",
        ),
        (
            INTERMEDIATE_DIR / "zonal_metadata.json",
            "industrialProxyApprovedForFullBake",
            "Need explicit industrial-proxy approval before writing the research/data contract.",
        ),
        (
            INTERMEDIATE_DIR / "zonal_metadata.json",
            "worldBankLenProxyApprovedForFullBake",
            "Need WB LEN fallback approval before writing the research/data contract.",
        ),
        (
            INTERMEDIATE_DIR / "zonal_metadata.json",
            "fullBakeReady",
            "Need zonal metadata confirming the formal output is approved for full bake.",
        ),
        (
            INTERMEDIATE_DIR / "demand_metadata.json",
            "formalOutputWritten",
            "Need formal intermediate/demand.csv written by the real demand step before writing the research/data contract.",
        ),
        (
            INTERMEDIATE_DIR / "demand_metadata.json",
            "demandReady",
            "Need real demand metadata before writing the research/data contract.",
        ),
        (
            INTERMEDIATE_DIR / "demand_metadata.json",
            "fullBakeReady",
            "Need demand metadata confirming the formal output is approved for full bake.",
        ),
        (
            INTERMEDIATE_DIR / "supply_metadata.json",
            "formalOutputWritten",
            "Need formal intermediate/supply.csv written by the real supply step before writing the research/data contract.",
        ),
        (
            INTERMEDIATE_DIR / "supply_metadata.json",
            "supplyReady",
            "Need real supply metadata before writing the research/data contract.",
        ),
        (
            INTERMEDIATE_DIR / "supply_metadata.json",
            "fullBakeReady",
            "Need supply metadata confirming the formal output is approved for full bake.",
        ),
        (
            INTERMEDIATE_DIR / "health_metadata.json",
            "formalOutputWritten",
            "Need formal intermediate/health.json written by the real health step before writing the research/data contract.",
        ),
        (
            INTERMEDIATE_DIR / "health_metadata.json",
            "healthReady",
            "Need real health-weight metadata before writing the research/data contract.",
        ),
        (
            INTERMEDIATE_DIR / "health_metadata.json",
            "fullBakeReady",
            "Need health metadata confirming the formal output is approved for full bake.",
        ),
    ]:
        require_metadata_flag("bake", metadata_path, flag, note)


def block_provenance(_: argparse.Namespace) -> None:
    require_paths(
        "provenance",
        [
            RAW_DIR / "clcd",
            RAW_DIR / "worldcover",
            RAW_DIR / "worldpop",
            RAW_DIR / "viirs",
            RAW_DIR / "merit",
            INTERMEDIATE_DIR / "bake_metadata.json",
            DATA_DIR / "wuhan-attrs.json",
            DATA_DIR / "wuhan-subbasins.geojson",
            DATA_DIR / "wuhan-rivers.geojson",
        ],
        "Need real raw files and baked research/data outputs before creating research/data/provenance.json.",
    )
    require_metadata_flag(
        "provenance",
        INTERMEDIATE_DIR / "bake_metadata.json",
        "dataContractReady",
        "Need bake metadata confirming research/data was written by the real bake step before provenance finalization.",
    )


def block_provenance_draft(_: argparse.Namespace) -> None:
    require_paths(
        "provenance-draft",
        [INTERMEDIATE_DIR / "raw_sha256.txt", BAKE_DIR / "download_attempts.md"],
        "Need raw checksum manifest and download-attempt audit before writing provenance draft.",
    )


def block_bulletin_draft(_: argparse.Namespace) -> None:
    require_paths(
        "bulletin-draft",
        [RAW_DIR / "bulletin" / "hubei_water_resources_bulletin_2022.pdf"],
        "Need the downloaded Hubei Water Resources Bulletin 2022 PDF before writing the table 12 extraction draft.",
    )


def block_mainstem_inflow_draft(_: argparse.Namespace) -> None:
    require_paths(
        "mainstem-inflow-draft",
        [RAW_DIR / "bulletin" / "hubei_water_resources_bulletin_2022.pdf"],
        "Need the downloaded Hubei Water Resources Bulletin 2022 PDF before writing the table 5 mainstem inflow draft.",
    )


def block_mainstem_node_mapping_draft(_: argparse.Namespace) -> None:
    require_paths(
        "mainstem-node-mapping-draft",
        [
            INTERMEDIATE_DIR / "subbasins_raw.geojson",
            INTERMEDIATE_DIR / "topology.json",
            INTERMEDIATE_DIR / "mainstem_inflow_draft.csv",
            INTERMEDIATE_DIR / "mainstem_inflow_draft_metadata.json",
            RAW_DIR / "hydrosheds" / "HydroRIVERS_v10_as_shp.zip",
        ],
        "Need current subbasins, topology, mainstem inflow draft, and HydroRIVERS before node mapping draft.",
    )


def block_rivers_flowthrough_draft(_: argparse.Namespace) -> None:
    require_paths(
        "rivers-flowthrough-draft",
        [
            INTERMEDIATE_DIR / "subbasins_raw.geojson",
            INTERMEDIATE_DIR / "topology.json",
            RAW_DIR / "hydrosheds" / "HydroRIVERS_v10_as_shp.zip",
        ],
        "Need current subbasins, topology, and HydroRIVERS before river flowThrough draft.",
    )


def block_mainstem_injection_plan_draft(_: argparse.Namespace) -> None:
    require_paths(
        "mainstem-injection-plan-draft",
        [
            INTERMEDIATE_DIR / "mainstem_inflow_draft.csv",
            INTERMEDIATE_DIR / "mainstem_inflow_draft_metadata.json",
            INTERMEDIATE_DIR / "mainstem_node_mapping_draft.csv",
            INTERMEDIATE_DIR / "mainstem_node_mapping_draft_metadata.json",
            INTERMEDIATE_DIR / "topology.json",
        ],
        "Need mainstem inflow evidence, node mapping candidates, and topology before injection plan draft.",
    )


def block_demand_draft(_: argparse.Namespace) -> None:
    require_paths(
        "demand-draft",
        [
            INTERMEDIATE_DIR / "zonal_landpop.csv",
            INTERMEDIATE_DIR / "zonal_metadata.json",
            INTERMEDIATE_DIR / "bulletin_table12_draft.csv",
            INTERMEDIATE_DIR / "bulletin_table12_draft_metadata.json",
            INTERMEDIATE_DIR / "topology.json",
        ],
        "Need partial land/pop zonal evidence, bulletin draft, and topology before demand audit draft.",
    )


def block_city_demand_allocation_draft(_: argparse.Namespace) -> None:
    require_paths(
        "city-demand-allocation-draft",
        [
            RAW_DIR / "gadm" / "gadm41_CHN.gpkg",
            INTERMEDIATE_DIR / "subbasins_raw.geojson",
            INTERMEDIATE_DIR / "topology.json",
            INTERMEDIATE_DIR / "zonal_landpop.csv",
            INTERMEDIATE_DIR / "bulletin_table12_draft.csv",
            INTERMEDIATE_DIR / "demand_draft_metadata.json",
        ],
        "Need GADM cities, fallback subbasins, zonal land/pop, bulletin draft, and demand metadata before city allocation draft.",
    )


def block_supply_draft(_: argparse.Namespace) -> None:
    require_paths(
        "supply-draft",
        [
            INTERMEDIATE_DIR / "zonal_climate.csv",
            INTERMEDIATE_DIR / "zonal_metadata.json",
            INTERMEDIATE_DIR / "subbasins_metadata.json",
            INTERMEDIATE_DIR / "topology.json",
        ],
        "Need partial climate zonal output, subbasins metadata, and topology before supply audit draft.",
    )


def block_health_reach_draft(_: argparse.Namespace) -> None:
    require_paths(
        "health-reach-draft",
        [
            INTERMEDIATE_DIR / "zonal_landpop.csv",
            INTERMEDIATE_DIR / "zonal_metadata.json",
            INTERMEDIATE_DIR / "topology.json",
        ],
        "Need partial WorldPop zonal output, zonal metadata, and topology before health reach audit draft.",
    )


def block_bake_preflight(_: argparse.Namespace) -> None:
    require_paths(
        "bake-preflight",
        [
            INTERMEDIATE_DIR / "subbasins_raw.geojson",
            INTERMEDIATE_DIR / "subbasins_metadata.json",
            INTERMEDIATE_DIR / "topology.json",
            INTERMEDIATE_DIR / "zonal_climate.csv",
            INTERMEDIATE_DIR / "zonal_landpop.csv",
            INTERMEDIATE_DIR / "zonal_metadata.json",
            INTERMEDIATE_DIR / "demand_draft.csv",
            INTERMEDIATE_DIR / "demand_draft_metadata.json",
            INTERMEDIATE_DIR / "city_demand_allocation_draft.csv",
            INTERMEDIATE_DIR / "city_demand_allocation_draft_metadata.json",
            INTERMEDIATE_DIR / "supply_draft.csv",
            INTERMEDIATE_DIR / "supply_draft_metadata.json",
            INTERMEDIATE_DIR / "mainstem_inflow_draft.csv",
            INTERMEDIATE_DIR / "mainstem_inflow_draft_metadata.json",
        INTERMEDIATE_DIR / "mainstem_node_mapping_draft.csv",
        INTERMEDIATE_DIR / "mainstem_node_mapping_draft_metadata.json",
        INTERMEDIATE_DIR / "rivers_flowthrough_draft.geojson",
        INTERMEDIATE_DIR / "rivers_flowthrough_draft_metadata.json",
        INTERMEDIATE_DIR / "mainstem_injection_plan_draft.csv",
        INTERMEDIATE_DIR / "mainstem_injection_plan_draft.json",
        INTERMEDIATE_DIR / "mainstem_injection_plan_draft_metadata.json",
        INTERMEDIATE_DIR / "health_reach_draft.json",
        INTERMEDIATE_DIR / "health_reach_draft_metadata.json",
        ],
        "Need audit-only subbasin, zonal, supply, mainstem inflow/mapping, and health reach products before checking the bake data contract.",
    )


def block_validate(_: argparse.Namespace) -> None:
    require_paths(
        "validate",
        [
            DATA_DIR / "wuhan-attrs.json",
            DATA_DIR / "wuhan-subbasins.geojson",
            DATA_DIR / "wuhan-rivers.geojson",
            DATA_DIR / "provenance.json",
            INTERMEDIATE_DIR / "bake_metadata.json",
            INTERMEDIATE_DIR / "provenance_metadata.json",
        ],
        "Need real baked data, bake metadata, and provenance before running the final full-bake validator.",
    )
    require_metadata_flag(
        "validate",
        INTERMEDIATE_DIR / "bake_metadata.json",
        "dataContractReady",
        "Need bake metadata confirming research/data was written by the real bake step before final validation.",
    )
    require_metadata_flag(
        "validate",
        INTERMEDIATE_DIR / "bake_metadata.json",
        "fullBakeReady",
        "Need bake metadata confirming the data contract is approved for full-bake validation.",
    )
    require_metadata_flag(
        "validate",
        INTERMEDIATE_DIR / "provenance_metadata.json",
        "provenanceReady",
        "Need provenance metadata confirming a real provenance.json before final validation.",
    )


def block_name(_: argparse.Namespace) -> None:
    require_paths(
        "name",
        [DATA_DIR / "wuhan-attrs.json"],
        "Need existing wuhan-attrs.json before deriving readable subbasin labels.",
    )


STUB_STEPS: dict[str, Callable[[argparse.Namespace], list[Path]]] = {
    "aoi": step_aoi_stub,
    "subbasins": step_subbasins_stub,
    "zonal": step_zonal_stub,
    "demand": step_demand_stub,
    "supply": step_supply_stub,
    "health": step_health_stub,
    "bake": step_bake_stub,
    "provenance": step_provenance_stub,
    "provenance-draft": step_provenance_draft_stub,
    "bulletin-draft": step_bulletin_draft_stub,
    "mainstem-inflow-draft": step_mainstem_inflow_draft_stub,
    "mainstem-node-mapping-draft": step_mainstem_node_mapping_draft_stub,
    "rivers-flowthrough-draft": step_rivers_flowthrough_draft_stub,
    "mainstem-injection-plan-draft": step_mainstem_injection_plan_draft_stub,
    "demand-draft": step_demand_draft_stub,
    "city-demand-allocation-draft": step_city_demand_allocation_draft_stub,
    "supply-draft": step_supply_draft_stub,
    "health-reach-draft": step_health_reach_draft_stub,
    "bake-preflight": step_bake_preflight_stub,
    "validate": step_validate_stub,
    "name": step_name_stub,
}

REAL_GATES: dict[str, Callable[[argparse.Namespace], None]] = {
    "aoi": block_aoi,
    "subbasins": block_subbasins,
    "zonal": block_zonal,
    "demand": block_demand,
    "supply": block_supply,
    "health": block_health,
    "bake": block_bake,
    "provenance": block_provenance,
    "provenance-draft": block_provenance_draft,
    "bulletin-draft": block_bulletin_draft,
    "mainstem-inflow-draft": block_mainstem_inflow_draft,
    "mainstem-node-mapping-draft": block_mainstem_node_mapping_draft,
    "rivers-flowthrough-draft": block_rivers_flowthrough_draft,
    "mainstem-injection-plan-draft": block_mainstem_injection_plan_draft,
    "demand-draft": block_demand_draft,
    "city-demand-allocation-draft": block_city_demand_allocation_draft,
    "supply-draft": block_supply_draft,
    "health-reach-draft": block_health_reach_draft,
    "bake-preflight": block_bake_preflight,
    "validate": block_validate,
    "name": block_name,
}

REAL_STEPS: dict[str, Callable[[argparse.Namespace], list[Path]]] = {
    "aoi": step_aoi_real,
    "subbasins": step_subbasins_real,
    "zonal": step_zonal_real,
    "provenance-draft": step_provenance_draft,
    "bulletin-draft": step_bulletin_draft,
    "mainstem-inflow-draft": step_mainstem_inflow_draft,
    "mainstem-node-mapping-draft": step_mainstem_node_mapping_draft,
    "rivers-flowthrough-draft": step_rivers_flowthrough_draft,
    "mainstem-injection-plan-draft": step_mainstem_injection_plan_draft,
    "demand-draft": step_demand_draft,
    "city-demand-allocation-draft": step_city_demand_allocation_draft,
    "supply-draft": step_supply_draft,
    "health-reach-draft": step_health_reach_draft,
    "demand": step_demand_real,
    "supply": step_supply_real,
    "health": step_health_real,
    "bake": step_bake_real,
    "provenance": step_provenance_real,
    "bake-preflight": step_bake_preflight,
    "validate": step_validate_real,
    "name": step_name_real,
}

STEP_HELP = {
    "hardware": "Check disk and memory gates for the full local bake.",
    "aoi": "Build the dissolved Wuhan 1+8 AOI from GADM/admin boundaries.",
    "subbasins": "Delineate 30-80 subbasins and downstream topology.",
    "zonal": "Compute raster zonal statistics for each subbasin.",
    "demand": "Estimate sectoral water demand from zonal proxies and bulletin totals.",
    "supply": "Estimate local runoff, mainstem inflow, and routed available supply.",
    "health": "Assign health weights and downstream impact reach sets.",
    "bake": "Merge real intermediate products into the research/data contract.",
    "name": "Derive readable Chinese subbasin labels while preserving Pfaf technical ids.",
    "validate": "Run final full-bake validation when real data and provenance exist.",
    "provenance": "Write provenance for real input files and processing scripts.",
    "provenance-draft": "Write an audit-only intermediate provenance draft from downloaded raw checksums.",
    "bulletin-draft": "Extract Hubei bulletin table 12 into an audit-only intermediate draft.",
    "mainstem-inflow-draft": "Extract Hubei bulletin table 5 mainstem/provincial-boundary inflows into an audit-only draft.",
    "mainstem-node-mapping-draft": "Map mainstem inflow source rows to audit-only subbasin node candidates without injecting supply.",
    "rivers-flowthrough-draft": "Build an audit-only HydroRIVERS flowThrough draft without writing research/data.",
    "mainstem-injection-plan-draft": "Write an audit-only non-additive mainstem injection plan without injecting supply.",
    "demand-draft": "Write an audit-only bulletin/zonal demand downscaling draft without unlocking formal demand.",
    "city-demand-allocation-draft": "Write an audit-only city-to-subbasin demand allocation draft without unlocking formal demand.",
    "supply-draft": "Write an audit-only local-runoff/routed-availability draft without unlocking formal supply.",
    "health-reach-draft": "Write an audit-only downstream reach/population exposure draft without unlocking formal health.",
    "bake-preflight": "Write an audit-only data-contract readiness report without unlocking full bake.",
    "run-all": "Run all steps in order.",
}

ORDERED_STEPS = ["aoi", "subbasins", "zonal", "demand", "supply", "health", "bake", "name", "provenance", "validate"]


def run_real_gate(step: str, args: argparse.Namespace) -> int:
    try:
        REAL_GATES[step](args)
    except BakeBlocked as error:
        print(f"BLOCKED [{error.step}]: {error.note}")
        print("Missing inputs:")
        for item in error.missing:
            print(f"  - {item}")
        print("Next: complete research/tools/bake/fetch_data.md, then rerun without --stub.")
        return 2
    if step in REAL_STEPS:
        try:
            REAL_STEPS[step](args)
        except BakeBlocked as error:
            print(f"BLOCKED [{error.step}]: {error.note}")
            if error.missing:
                print("Missing inputs:")
                for item in error.missing:
                    print(f"  - {item}")
            print("Next: complete research/tools/bake/fetch_data.md, then rerun without --stub.")
            return 2
        return 0
    print(f"BLOCKED [{step}]: real geospatial implementation is scaffolded but not coded in this T1.0 skeleton.")
    print("Next worker should replace this gate with the actual raster/vector processing step.")
    return 2


def run_step(step: str, args: argparse.Namespace) -> int:
    if step == "run-all":
        for ordered_step in ORDERED_STEPS:
            print(f"== {ordered_step} ==")
            code = run_step(ordered_step, args)
            if code != 0:
                return code
        return 0

    if step == "hardware":
        try:
            step_hardware(args)
        except BakeBlocked as error:
            print(f"BLOCKED [{error.step}]: {error.note}")
            return 2
        return 0

    if (args.global_stub or args.step_stub) and not getattr(args, "step_real", False):
        STUB_STEPS[step](args)
        return 0

    return run_real_gate(step, args)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Offline bake scaffold for Wuhan Metropolitan Area real-data research inputs.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--stub",
        dest="global_stub",
        action="store_true",
        help="Run synthetic wiring logic only; write to research/tools/bake/intermediate and out, never research/data.",
    )
    subparsers = parser.add_subparsers(dest="step", metavar="step")
    for step_name in [
        "hardware",
        *ORDERED_STEPS,
        "provenance-draft",
        "bulletin-draft",
        "mainstem-inflow-draft",
        "mainstem-node-mapping-draft",
        "rivers-flowthrough-draft",
        "mainstem-injection-plan-draft",
        "demand-draft",
        "city-demand-allocation-draft",
        "supply-draft",
        "health-reach-draft",
        "bake-preflight",
        "run-all",
    ]:
        step_parser = subparsers.add_parser(
            step_name,
            help=STEP_HELP[step_name],
            description=STEP_HELP[step_name],
            formatter_class=argparse.ArgumentDefaultsHelpFormatter,
        )
        mode_group = step_parser.add_mutually_exclusive_group()
        mode_group.add_argument(
            "--stub",
            dest="step_stub",
            action="store_true",
            help="Run this step in synthetic wiring mode; outputs stay under bake/intermediate or bake/out.",
        )
        mode_group.add_argument(
            "--real",
            dest="step_real",
            action="store_true",
            help="Run this step against real inputs; overrides global --stub.",
        )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.step:
        parser.print_help()
        return 0
    return run_step(args.step, args)


if __name__ == "__main__":
    sys.exit(main())
