"""Audit the frozen original-research-site artifacts without loading GT values."""

from __future__ import annotations

import argparse
import csv
import hashlib
import itertools
import json
import math
from pathlib import Path

from backend.surrogate import artifact_paths


PROJECT = Path(__file__).resolve().parents[1]
MANIFEST = PROJECT / "RESEARCH_SITE_MANIFEST.json"
SAMPLE_COLUMNS = [
    "sample_order", "source_group", "sensor_row_index", "Space_ID", "Index",
    "Px", "Py", "Pz", "Nx", "Ny", "Nz", "building_id", "surface_type",
]
HORIZON_COLUMNS = [f"horizon_elev_deg_{d}" for d in ("N", "NE", "E", "SE", "S", "SW", "W", "NW")]
TRAIN_BOUNDS = {
    "Px": (-502.982208265, 506.664648697),
    "Py": (-518.989267452, 519.698746169),
    "Pz": (27.048600197, 149.313980103),
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest().upper()


def resolve_artifacts(document: dict) -> dict[str, Path]:
    research = PROJECT.parent
    surrogate = artifact_paths()
    resolved = {}
    for name, record in document["artifacts"].items():
        if "path" in record:
            resolved[name] = research / Path(record["path"])
        else:
            prefix, key = record["resolver"].split(":", 1)
            if prefix != "surrogate" or key not in surrogate:
                raise ValueError(f"Unsupported artifact resolver: {record['resolver']}")
            resolved[name] = Path(surrogate[key])
    return resolved


def audit_hashes(document: dict, resolved: dict[str, Path]) -> tuple[dict, list[str]]:
    report = {}
    failures = []
    for name, path in resolved.items():
        expected = document["artifacts"][name]
        exists = path.is_file()
        size = path.stat().st_size if exists else None
        actual_hash = sha256(path) if exists else None
        matches = exists and size == expected["bytes"] and actual_hash == expected["sha256"]
        report[name] = {
            "exists": exists,
            "bytes": size,
            "sha256": actual_hash,
            "matches_frozen_manifest": matches,
        }
        if not matches:
            failures.append(f"artifact:{name}")
    return report, failures


def audit_sensor_tables(sample_path: Path, horizon_path: Path) -> dict:
    sensor_ids = set()
    spaces = set()
    buildings = set()
    space_index = set()
    surface_counts = {"Roof": 0, "Facade": 0}
    duplicate_space_index = 0
    outside_by_axis = {axis: 0 for axis in TRAIN_BOUNDS}
    outside_any = 0
    normal_outside_tolerance = 0
    horizon_outside_range = 0
    horizon_min = math.inf
    horizon_max = -math.inf
    max_xyz_difference = 0.0
    order_matches = True
    rows = 0

    with sample_path.open(encoding="utf-8-sig", newline="") as sample_handle, horizon_path.open(
        encoding="utf-8-sig", newline=""
    ) as horizon_handle:
        samples = csv.DictReader(sample_handle)
        horizons = csv.DictReader(horizon_handle)
        if samples.fieldnames != SAMPLE_COLUMNS:
            raise ValueError(f"Unexpected sample columns: {samples.fieldnames}")
        missing_horizon = [name for name in ["sensor_row_index", "Px", "Py", "Pz", *HORIZON_COLUMNS] if name not in horizons.fieldnames]
        if missing_horizon:
            raise ValueError(f"Missing horizon columns: {missing_horizon}")

        for sample, horizon in itertools.zip_longest(samples, horizons):
            if sample is None or horizon is None:
                order_matches = False
                continue
            rows += 1
            sensor_id = int(sample["sensor_row_index"])
            order_matches &= sensor_id == int(horizon["sensor_row_index"])
            sensor_ids.add(sensor_id)
            spaces.add(sample["Space_ID"])
            buildings.add(sample["building_id"])
            key = (sample["Space_ID"], sample["Index"])
            if key in space_index:
                duplicate_space_index += 1
            space_index.add(key)

            surface = sample["surface_type"]
            surface_counts[surface] = surface_counts.get(surface, 0) + 1
            xyz = {axis: float(sample[axis]) for axis in TRAIN_BOUNDS}
            row_outside = False
            for axis, (lower, upper) in TRAIN_BOUNDS.items():
                is_outside = not lower <= xyz[axis] <= upper
                outside_by_axis[axis] += int(is_outside)
                row_outside |= is_outside
                max_xyz_difference = max(max_xyz_difference, abs(xyz[axis] - float(horizon[axis])))
            outside_any += int(row_outside)

            normal_norm = math.sqrt(sum(float(sample[axis]) ** 2 for axis in ("Nx", "Ny", "Nz")))
            normal_outside_tolerance += int(abs(normal_norm - 1.0) > 1e-5)
            for column in HORIZON_COLUMNS:
                value = float(horizon[column])
                horizon_min = min(horizon_min, value)
                horizon_max = max(horizon_max, value)
                horizon_outside_range += int(not 0.0 <= value <= 90.0)

    return {
        "rows": rows,
        "unique_sensor_ids": len(sensor_ids),
        "unique_spaces": len(spaces),
        "unique_buildings": len(buildings),
        "surface_counts": surface_counts,
        "duplicate_sensor_row_index": rows - len(sensor_ids),
        "duplicate_space_id_index": duplicate_space_index,
        "sample_horizon_sensor_order_match": order_matches,
        "sample_horizon_max_abs_xyz_difference_m": max_xyz_difference,
        "unit_normal_rows_outside_tolerance_1e-5": normal_outside_tolerance,
        "horizon_values_outside_0_90": horizon_outside_range,
        "horizon_min_deg": horizon_min,
        "horizon_max_deg": horizon_max,
        "inside_all_frozen_train_xyz_axes": rows - outside_any,
        "blocked_outside_any_frozen_train_xyz_axis": outside_any,
        "blocked_by_axis": outside_by_axis,
    }


def compare_frozen_counts(document: dict, tables: dict) -> list[str]:
    expected = document["population"]
    policy = document["live_inference_policy"]
    identity = document["identity_checks"]
    checks = {
        "rows": expected["sensors"],
        "unique_sensor_ids": expected["unique_sensor_ids"],
        "unique_spaces": expected["unique_spaces"],
        "unique_buildings": expected["unique_buildings"],
        "inside_all_frozen_train_xyz_axes": policy["inside_all_frozen_train_xyz_axes"],
        "blocked_outside_any_frozen_train_xyz_axis": policy["blocked_outside_any_frozen_train_xyz_axis"],
        "duplicate_sensor_row_index": identity["duplicate_sensor_row_index"],
        "duplicate_space_id_index": identity["duplicate_space_id_index"],
        "unit_normal_rows_outside_tolerance_1e-5": identity["unit_normal_rows_outside_tolerance_1e-5"],
    }
    failures = [f"table:{name}" for name, value in checks.items() if tables[name] != value]
    if tables["surface_counts"].get("Roof") != expected["roof_sensors"]:
        failures.append("table:roof_sensors")
    if tables["surface_counts"].get("Facade") != expected["facade_sensors"]:
        failures.append("table:facade_sensors")
    if tables["blocked_by_axis"] != policy["blocked_by_axis"]:
        failures.append("table:blocked_by_axis")
    if not tables["sample_horizon_sensor_order_match"]:
        failures.append("table:sample_horizon_sensor_order_match")
    if tables["sample_horizon_max_abs_xyz_difference_m"] > 1e-9:
        failures.append("table:sample_horizon_xyz")
    if tables["horizon_values_outside_0_90"]:
        failures.append("table:horizon_range")
    return failures


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, help="Optional JSON report path")
    args = parser.parse_args()

    document = json.loads(MANIFEST.read_text(encoding="utf-8"))
    resolved = resolve_artifacts(document)
    hashes, failures = audit_hashes(document, resolved)
    if resolved["sample"].is_file() and resolved["horizon"].is_file():
        tables = audit_sensor_tables(resolved["sample"], resolved["horizon"])
        failures.extend(compare_frozen_counts(document, tables))
    else:
        tables = None
        failures.append("table:unavailable")

    report = {
        "spec_version": "solarcheck-research-site-audit/v1",
        "site_id": document["site_id"],
        "passed": not failures,
        "failures": failures,
        "artifacts": hashes,
        "sensor_tables": tables,
        "policy_decision": {
            "primary_sensor_key": document["primary_sensor_key"],
            "hourly_reinference_sensor_count": document["live_inference_policy"]["inside_all_frozen_train_xyz_axes"],
            "blocked_sensor_count": document["live_inference_policy"]["blocked_outside_any_frozen_train_xyz_axis"],
        },
    }
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered, end="")
    raise SystemExit(0 if report["passed"] else 1)


if __name__ == "__main__":
    main()
