"""Build a queryable web mapping package for the frozen research-site sensors."""

from __future__ import annotations

import argparse
import csv
import itertools
import json
import math
import os
import sqlite3
from pathlib import Path

from prep.audit_research_site import (
    MANIFEST,
    TRAIN_BOUNDS,
    audit_hashes,
    audit_sensor_tables,
    compare_frozen_counts,
    resolve_artifacts,
    sha256,
)


PROJECT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = PROJECT / "outputs" / "research_site_mapping" / "research_site.sqlite"
HORIZON_NAMES = ("N", "NE", "E", "SE", "S", "SW", "W", "NW")


def normal_angles(nx: float, ny: float, nz: float) -> tuple[float, float]:
    """Return north-clockwise azimuth and tilt from +Z in degrees."""
    azimuth = math.degrees(math.atan2(nx, ny)) % 360.0
    tilt = math.degrees(math.acos(max(-1.0, min(1.0, nz))))
    return azimuth, tilt


def bin_five_degrees(value: float, *, wrap: bool = False) -> int:
    result = int(math.floor(value / 5.0 + 0.5)) * 5
    return result % 360 if wrap else min(180, result)


def surface_group_id(building_id: str, surface_type: str, azimuth: float, tilt: float) -> str:
    kind = "R" if surface_type == "Roof" else "F"
    return f"{building_id}:{kind}:A{bin_five_degrees(azimuth, wrap=True):03d}:T{bin_five_degrees(tilt):03d}"


def create_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        PRAGMA foreign_keys = ON;
        CREATE TABLE metadata (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL
        );
        CREATE TABLE sensors (
            sensor_row_index INTEGER PRIMARY KEY,
            sample_order INTEGER NOT NULL UNIQUE,
            building_id TEXT NOT NULL,
            space_id TEXT NOT NULL,
            source_index INTEGER NOT NULL,
            surface_type TEXT NOT NULL CHECK(surface_type IN ('Roof', 'Facade')),
            surface_group_id TEXT NOT NULL,
            x REAL NOT NULL,
            y REAL NOT NULL,
            z REAL NOT NULL,
            nx REAL NOT NULL,
            ny REAL NOT NULL,
            nz REAL NOT NULL,
            normal_azimuth_deg REAL NOT NULL,
            normal_tilt_deg REAL NOT NULL,
            horizon_n REAL NOT NULL,
            horizon_ne REAL NOT NULL,
            horizon_e REAL NOT NULL,
            horizon_se REAL NOT NULL,
            horizon_s REAL NOT NULL,
            horizon_sw REAL NOT NULL,
            horizon_w REAL NOT NULL,
            horizon_nw REAL NOT NULL,
            annual_prediction_kwh_m2_year REAL NOT NULL CHECK(annual_prediction_kwh_m2_year >= 0),
            hourly_inference_eligible INTEGER NOT NULL CHECK(hourly_inference_eligible IN (0, 1))
        );
        CREATE TABLE buildings (
            building_id TEXT PRIMARY KEY,
            sensor_count INTEGER NOT NULL,
            roof_sensor_count INTEGER NOT NULL,
            facade_sensor_count INTEGER NOT NULL,
            surface_group_count INTEGER NOT NULL,
            hourly_eligible_sensor_count INTEGER NOT NULL,
            x_min REAL NOT NULL, x_max REAL NOT NULL,
            y_min REAL NOT NULL, y_max REAL NOT NULL,
            z_min REAL NOT NULL, z_max REAL NOT NULL,
            annual_prediction_mean REAL NOT NULL,
            annual_prediction_min REAL NOT NULL,
            annual_prediction_max REAL NOT NULL
        );
        CREATE TABLE surface_groups (
            surface_group_id TEXT PRIMARY KEY,
            building_id TEXT NOT NULL,
            surface_type TEXT NOT NULL,
            normal_azimuth_bin_deg INTEGER NOT NULL,
            normal_tilt_bin_deg INTEGER NOT NULL,
            sensor_count INTEGER NOT NULL,
            hourly_eligible_sensor_count INTEGER NOT NULL,
            x_min REAL NOT NULL, x_max REAL NOT NULL,
            y_min REAL NOT NULL, y_max REAL NOT NULL,
            z_min REAL NOT NULL, z_max REAL NOT NULL,
            annual_prediction_mean REAL NOT NULL,
            annual_prediction_min REAL NOT NULL,
            annual_prediction_max REAL NOT NULL,
            FOREIGN KEY(building_id) REFERENCES buildings(building_id)
        );
        """
    )


def sensor_rows(sample_path: Path, horizon_path: Path, figure_path: Path):
    with sample_path.open(encoding="utf-8-sig", newline="") as sample_handle, horizon_path.open(
        encoding="utf-8-sig", newline=""
    ) as horizon_handle, figure_path.open(encoding="utf-8-sig", newline="") as figure_handle:
        samples = csv.DictReader(sample_handle)
        horizon_rows = csv.DictReader(horizon_handle)
        figures = csv.DictReader(figure_handle)
        for row_number, triple in enumerate(itertools.zip_longest(samples, horizon_rows, figures), start=1):
            sample, horizon, figure = triple
            if sample is None or horizon is None or figure is None:
                raise ValueError("Sample, horizon and prediction row counts differ")
            sensor_id = int(sample["sensor_row_index"])
            if sensor_id != int(horizon["sensor_row_index"]) or sensor_id != int(figure["sensor_row_index"]):
                raise ValueError(f"Cross-artifact sensor order mismatch at row {row_number}")
            if any(sample[name] != figure[name] for name in ("Space_ID", "building_id", "surface_type")):
                raise ValueError(f"Cross-artifact sensor metadata mismatch at row {row_number}")

            x, y, z = (float(sample[name]) for name in ("Px", "Py", "Pz"))
            nx, ny, nz = (float(sample[name]) for name in ("Nx", "Ny", "Nz"))
            azimuth, tilt = normal_angles(nx, ny, nz)
            horizon_values = tuple(float(horizon[f"horizon_elev_deg_{name}"]) for name in HORIZON_NAMES)
            annual = float(figure["annual_prediction_kwh_m2_yr"])
            if not math.isfinite(annual) or annual < 0:
                raise ValueError(f"Invalid annual prediction at sensor {sensor_id}")
            eligible = all(lower <= value <= upper for value, (lower, upper) in zip((x, y, z), TRAIN_BOUNDS.values()))
            group_id = surface_group_id(sample["building_id"], sample["surface_type"], azimuth, tilt)
            yield (
                sensor_id, int(sample["sample_order"]), sample["building_id"], sample["Space_ID"],
                int(sample["Index"]), sample["surface_type"], group_id,
                x, y, z, nx, ny, nz, azimuth, tilt, *horizon_values, annual, int(eligible),
            )


def insert_sensors(connection: sqlite3.Connection, paths: dict[str, Path]) -> int:
    sql = f"INSERT INTO sensors VALUES ({','.join('?' for _ in range(25))})"
    count = 0
    batch = []
    for row in sensor_rows(paths["sample"], paths["horizon"], paths["figure_sensor_data"]):
        batch.append(row)
        if len(batch) == 2000:
            connection.executemany(sql, batch)
            count += len(batch)
            batch.clear()
    if batch:
        connection.executemany(sql, batch)
        count += len(batch)
    return count


def populate_summaries(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        INSERT INTO buildings
        SELECT building_id,
               COUNT(*),
               SUM(surface_type = 'Roof'),
               SUM(surface_type = 'Facade'),
               COUNT(DISTINCT surface_group_id),
               SUM(hourly_inference_eligible),
               MIN(x), MAX(x), MIN(y), MAX(y), MIN(z), MAX(z),
               AVG(annual_prediction_kwh_m2_year),
               MIN(annual_prediction_kwh_m2_year),
               MAX(annual_prediction_kwh_m2_year)
        FROM sensors GROUP BY building_id;

        INSERT INTO surface_groups
        SELECT surface_group_id,
               building_id,
               surface_type,
               CAST(substr(surface_group_id, instr(surface_group_id, ':A') + 2, 3) AS INTEGER),
               CAST(substr(surface_group_id, instr(surface_group_id, ':T') + 2, 3) AS INTEGER),
               COUNT(*),
               SUM(hourly_inference_eligible),
               MIN(x), MAX(x), MIN(y), MAX(y), MIN(z), MAX(z),
               AVG(annual_prediction_kwh_m2_year),
               MIN(annual_prediction_kwh_m2_year),
               MAX(annual_prediction_kwh_m2_year)
        FROM sensors GROUP BY surface_group_id, building_id, surface_type;

        CREATE INDEX sensors_building ON sensors(building_id);
        CREATE INDEX sensors_surface_group ON sensors(surface_group_id);
        CREATE INDEX sensors_space ON sensors(space_id);
        CREATE INDEX sensors_surface_type ON sensors(surface_type);
        """
    )


def scalar(connection: sqlite3.Connection, sql: str):
    return connection.execute(sql).fetchone()[0]


def build(output: Path) -> dict:
    frozen = json.loads(MANIFEST.read_text(encoding="utf-8"))
    paths = resolve_artifacts(frozen)
    hashes, failures = audit_hashes(frozen, paths)
    table_audit = audit_sensor_tables(paths["sample"], paths["horizon"])
    failures.extend(compare_frozen_counts(frozen, table_audit))
    if failures:
        raise RuntimeError(f"Frozen source audit failed: {failures}")

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    if temporary.exists():
        temporary.unlink()
    connection = sqlite3.connect(temporary)
    try:
        create_schema(connection)
        count = insert_sensors(connection, paths)
        if count != frozen["population"]["sensors"]:
            raise ValueError(f"Expected {frozen['population']['sensors']} sensors, got {count}")
        populate_summaries(connection)
        metadata = {
            "spec_version": "solarcheck-research-site-mapping/v1",
            "site_id": frozen["site_id"],
            "coordinate_frame": frozen["coordinate_frame"],
            "primary_sensor_key": frozen["primary_sensor_key"],
            "surface_group_rule": "building_id + surface_type + north-clockwise normal azimuth/tilt rounded to 5 degrees",
            "surface_group_limitation": "Visualization/query grouping only; not a verified 3DM face or photo-mask identity.",
            "source_manifest_sha256": sha256(MANIFEST),
        }
        connection.executemany(
            "INSERT INTO metadata(key, value_json) VALUES (?, ?)",
            [(key, json.dumps(value, ensure_ascii=False)) for key, value in metadata.items()],
        )
        connection.commit()
        connection.execute("ANALYZE")
        connection.commit()
        summary = {
            "spec_version": metadata["spec_version"],
            "site_id": frozen["site_id"],
            "database": output.name,
            "sensor_count": scalar(connection, "SELECT COUNT(*) FROM sensors"),
            "building_count": scalar(connection, "SELECT COUNT(*) FROM buildings"),
            "surface_group_count": scalar(connection, "SELECT COUNT(*) FROM surface_groups"),
            "roof_sensor_count": scalar(connection, "SELECT COUNT(*) FROM sensors WHERE surface_type='Roof'"),
            "facade_sensor_count": scalar(connection, "SELECT COUNT(*) FROM sensors WHERE surface_type='Facade'"),
            "hourly_inference_eligible": scalar(connection, "SELECT SUM(hourly_inference_eligible) FROM sensors"),
            "hourly_inference_blocked": scalar(connection, "SELECT SUM(1-hourly_inference_eligible) FROM sensors"),
            "annual_prediction_range_kwh_m2_year": [
                scalar(connection, "SELECT MIN(annual_prediction_kwh_m2_year) FROM sensors"),
                scalar(connection, "SELECT MAX(annual_prediction_kwh_m2_year) FROM sensors"),
            ],
            "coordinate_bounds_m": {
                axis: [
                    scalar(connection, f"SELECT MIN({axis}) FROM sensors"),
                    scalar(connection, f"SELECT MAX({axis}) FROM sensors"),
                ]
                for axis in ("x", "y", "z")
            },
            "surface_group_rule": metadata["surface_group_rule"],
            "limitations": [
                metadata["surface_group_limitation"],
                "Ground-truth irradiance values are not stored in this mapping database.",
                "The database stores annual predictions; 8,760-hour series are generated later for eligible sensors.",
            ],
        }
    finally:
        connection.close()

    os.replace(temporary, output)
    summary["database_bytes"] = output.stat().st_size
    summary["database_sha256"] = sha256(output)
    manifest_path = output.with_name("mapping_manifest.json")
    manifest_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    summary = build(args.output.resolve())
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
