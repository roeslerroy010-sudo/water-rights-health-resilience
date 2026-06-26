#!/usr/bin/env python3
"""Audit-only calibration harness for the Wuhan real-data bake.

This script reads current draft intermediates and writes a calibration audit
report. It does not approve proxies, write formal demand/supply files, or unlock
the full bake.
"""

from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


BASE_IRRIG_NORM_M3_PER_HA = 5500.0
BASE_PERCAP_M3_PER_CAP_YR = 73.0
BASE_RUNOFF_COEFF = 0.40
DEFAULT_INTERMEDIATE_DIR = Path(__file__).resolve().parent / "intermediate"


def read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f"missing required calibration input: {path}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"expected JSON object in {path}")
    return payload


def finite(value: Any, label: str) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{label} is not finite: {value!r}")
    return number


def pct_error(actual: float, target: float) -> float | None:
    if target == 0:
        return None
    return abs(actual - target) / abs(target) * 100.0


def rel(path: Path, base: Path) -> str:
    try:
        return str(path.relative_to(base.parent))
    except ValueError:
        return str(path)


def build_report(intermediate_dir: Path) -> dict[str, Any]:
    demand_path = intermediate_dir / "demand_draft_metadata.json"
    supply_path = intermediate_dir / "supply_draft_metadata.json"
    zonal_path = intermediate_dir / "zonal_metadata.json"
    subbasins_path = intermediate_dir / "subbasins_metadata.json"

    demand = read_json(demand_path)
    supply = read_json(supply_path)
    zonal = read_json(zonal_path)
    subbasins = read_json(subbasins_path)

    target_totals = demand.get("targetTotalsM3", {})
    default_totals = demand.get("checks", {}).get("defaultFormulaTotalsM3", {})
    scale_to_bulletin = demand.get("checks", {}).get("scaleToBulletin", {})
    sector_sums = demand.get("checks", {}).get("sectorSumsM3", {})

    agri_target = finite(target_totals.get("agri", 0), "targetTotalsM3.agri")
    urban_target = finite(target_totals.get("urban", 0), "targetTotalsM3.urban")
    agri_default = finite(default_totals.get("agriDefault", 0), "defaultFormulaTotalsM3.agriDefault")
    urban_default = finite(default_totals.get("urbanDefault", 0), "defaultFormulaTotalsM3.urbanDefault")
    agri_actual = finite(sector_sums.get("agri", 0), "sectorSumsM3.agri")
    urban_actual = finite(sector_sums.get("urban", 0), "sectorSumsM3.urban")
    industry_actual = finite(sector_sums.get("industry", 0), "sectorSumsM3.industry")
    old_caliber_actual = finite(demand.get("checks", {}).get("oldCaliberSumM3", 0), "checks.oldCaliberSumM3")
    old_caliber_target = finite(
        demand.get("checks", {}).get("bulletinOldCaliberTotalM3", 0),
        "checks.bulletinOldCaliberTotalM3",
    )

    agri_scale = finite(scale_to_bulletin.get("agri", agri_target / agri_default), "scaleToBulletin.agri")
    urban_scale = finite(scale_to_bulletin.get("urban", urban_target / urban_default), "scaleToBulletin.urban")
    calibrated_irrig_norm = BASE_IRRIG_NORM_M3_PER_HA * agri_scale
    calibrated_percap = BASE_PERCAP_M3_PER_CAP_YR * urban_scale

    q_local_total = finite(supply.get("checks", {}).get("qLocalTotalM3", 0), "supply.checks.qLocalTotalM3")
    outlet_no_mainstem = finite(
        supply.get("checks", {}).get("outletNoMainstemM3", 0),
        "supply.checks.outletNoMainstemM3",
    )
    runoff_target = supply.get("checks", {}).get("bulletinLocalRunoffTargetM3")

    demand_error = pct_error(old_caliber_actual, old_caliber_target)
    demand_meets_10pct = demand_error is not None and demand_error < 10.0
    industrial_proxy_approved = demand.get("industrialProxyApprovedForFullBake") is True
    formal_subbasins_ready = subbasins.get("fullBakeReady") is True
    formal_zonal_ready = zonal.get("fullBakeReady") is True and zonal.get("formalOutputWritten") is True

    blockers = []
    if not industrial_proxy_approved:
        blockers.append("Industrial proxy is not approved for full-bake demand calibration.")
    if not formal_subbasins_ready:
        blockers.append("Subbasins are still HydroBASINS fallback or otherwise not fullBakeReady.")
    if not formal_zonal_ready:
        blockers.append("Formal zonal output is not fullBakeReady/formalOutputWritten.")
    if runoff_target is None:
        blockers.append("No AOI-local runoff target exists, so RUNOFF_COEFF cannot be formally calibrated.")
    if supply.get("mainstemInjectionReady") is not True:
        blockers.append("Mainstem inflow injection is not spatially approved, so supply calibration remains draft-only.")

    report = {
        "schemaVersion": "calibration-audit/v1",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "auditOnly": True,
        "formalOutputWritten": False,
        "calibrationReady": False,
        "demandCalibrationAuditReady": True,
        "supplyCalibrationAuditReady": True,
        "fullBakeReady": False,
        "mustNotSatisfyFullBake": True,
        "sourceInputs": {
            "demandDraftMetadata": rel(demand_path, intermediate_dir),
            "supplyDraftMetadata": rel(supply_path, intermediate_dir),
            "zonalMetadata": rel(zonal_path, intermediate_dir),
            "subbasinsMetadata": rel(subbasins_path, intermediate_dir),
        },
        "baseParameters": {
            "IRRIG_NORM_m3_per_ha_yr": BASE_IRRIG_NORM_M3_PER_HA,
            "PERCAP_m3_per_cap_yr": BASE_PERCAP_M3_PER_CAP_YR,
            "RUNOFF_COEFF": BASE_RUNOFF_COEFF,
        },
        "demandCalibration": {
            "scope": demand.get("calibrationScope", "draft demand metadata"),
            "oldCaliberActualM3": round(old_caliber_actual, 3),
            "oldCaliberTargetM3": round(old_caliber_target, 3),
            "oldCaliberErrorPct": round(demand_error, 9) if demand_error is not None else None,
            "meetsTenPctTarget": demand_meets_10pct,
            "agri": {
                "targetM3": round(agri_target, 3),
                "draftActualM3": round(agri_actual, 3),
                "defaultFormulaM3": round(agri_default, 3),
                "scaleToBulletin": round(agri_scale, 12),
                "calibratedIRRIGNORM_m3_per_ha_yr": round(calibrated_irrig_norm, 6),
                "errorPct": round(pct_error(agri_actual, agri_target) or 0.0, 9),
            },
            "urban": {
                "targetM3": round(urban_target, 3),
                "draftActualM3": round(urban_actual, 3),
                "defaultFormulaM3": round(urban_default, 3),
                "scaleToBulletin": round(urban_scale, 12),
                "calibratedPERCAP_m3_per_cap_yr": round(calibrated_percap, 6),
                "errorPct": round(pct_error(urban_actual, urban_target) or 0.0, 9),
            },
            "industry": {
                "draftActualM3": round(industry_actual, 3),
                "proxySource": demand.get("checks", {}).get("industryProxySource"),
                "industrialProxyApprovedForFullBake": industrial_proxy_approved,
            },
        },
        "supplyCalibration": {
            "draftRunoffCoeff": BASE_RUNOFF_COEFF,
            "qLocalTotalM3": round(q_local_total, 3),
            "outletNoMainstemM3": round(outlet_no_mainstem, 3),
            "runoffCoeffCalibrationReady": False,
            "runoffCoeffFormalTargetM3": runoff_target,
            "mainstemInjectionReady": supply.get("mainstemInjectionReady") is True,
            "note": "RUNOFF_COEFF remains an audit default until an AOI-local runoff target and approved mainstem injection treatment exist.",
        },
        "blockers": blockers,
        "limitations": [
            "Demand totals are matched by downscaling the 1+8 bulletin total and are audit-only until industrial proxy approval.",
            "The calibrated IRRIG_NORM/PERCAP values are implied by current draft scaling factors; they are not final project parameters.",
            "RUNOFF_COEFF is not formally calibrated because the available supply draft has no approved AOI-local runoff target.",
            "This report deliberately does not write demand.csv, supply.csv, health.json, research/data, or provenance.json.",
        ],
    }
    return report


def markdown_summary(report: dict[str, Any]) -> str:
    demand = report["demandCalibration"]
    supply = report["supplyCalibration"]
    agri = demand["agri"]
    urban = demand["urban"]
    industry = demand["industry"]
    lines = [
        "# Calibration Audit Report",
        "",
        f"Created: `{report['createdAt']}`",
        "",
        "This is an audit-only calibration report. It does not unlock full-bake outputs.",
        "",
        "## Demand",
        "",
        f"- Old-caliber draft total: `{demand['oldCaliberActualM3']}` m3",
        f"- Old-caliber bulletin target: `{demand['oldCaliberTargetM3']}` m3",
        f"- Error: `{demand['oldCaliberErrorPct']}`%",
        f"- Meets <10% target: `{demand['meetsTenPctTarget']}`",
        f"- Implied IRRIG_NORM: `{agri['calibratedIRRIGNORM_m3_per_ha_yr']}` m3/ha/yr",
        f"- Implied PERCAP: `{urban['calibratedPERCAP_m3_per_cap_yr']}` m3/cap/yr",
        f"- Industry proxy source: `{industry['proxySource']}`",
        f"- Industrial proxy approved for full-bake: `{industry['industrialProxyApprovedForFullBake']}`",
        "",
        "## Supply",
        "",
        f"- Draft RUNOFF_COEFF: `{supply['draftRunoffCoeff']}`",
        f"- Draft qLocal total: `{supply['qLocalTotalM3']}` m3",
        f"- Draft outlet no-mainstem total: `{supply['outletNoMainstemM3']}` m3",
        f"- RUNOFF_COEFF calibration ready: `{supply['runoffCoeffCalibrationReady']}`",
        f"- Mainstem injection ready: `{supply['mainstemInjectionReady']}`",
        "",
        "## Blockers",
        "",
    ]
    lines.extend(f"- {item}" for item in report["blockers"])
    lines.extend(["", "## Limitations", ""])
    lines.extend(f"- {item}" for item in report["limitations"])
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Write an audit-only calibration report.")
    parser.add_argument("--intermediate-dir", type=Path, default=DEFAULT_INTERMEDIATE_DIR)
    parser.add_argument("--json-out", type=Path)
    parser.add_argument("--md-out", type=Path)
    args = parser.parse_args()

    intermediate_dir = args.intermediate_dir.resolve()
    json_out = args.json_out or intermediate_dir / "calibration_audit_report.json"
    md_out = args.md_out or intermediate_dir / "calibration_audit_report.md"

    report = build_report(intermediate_dir)
    json_out.parent.mkdir(parents=True, exist_ok=True)
    md_out.parent.mkdir(parents=True, exist_ok=True)
    json_out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    md_out.write_text(markdown_summary(report), encoding="utf-8")

    print(f"CALIBRATION AUDIT wrote {json_out.relative_to(Path.cwd()) if json_out.is_relative_to(Path.cwd()) else json_out}")
    print(f"CALIBRATION AUDIT wrote {md_out.relative_to(Path.cwd()) if md_out.is_relative_to(Path.cwd()) else md_out}")
    print(
        "Demand audit: "
        f"old-caliber error={report['demandCalibration']['oldCaliberErrorPct']}%, "
        f"IRRIG_NORM={report['demandCalibration']['agri']['calibratedIRRIGNORM_m3_per_ha_yr']} m3/ha/yr, "
        f"PERCAP={report['demandCalibration']['urban']['calibratedPERCAP_m3_per_cap_yr']} m3/cap/yr"
    )
    print("AUDIT ONLY: calibrationReady remains false and fullBakeReady remains false.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
