"""Read-only access to the frozen original-research-site mapping package."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from functools import lru_cache
from pathlib import Path

from shapely.geometry import MultiPoint, Polygon


PROJECT = Path(__file__).resolve().parents[1]
DEFAULT_DATABASE = PROJECT / "outputs" / "research_site_mapping" / "research_site.sqlite"
REQUIRED_TABLES = {"metadata", "sensors", "buildings", "surface_groups"}


class ResearchSiteUnavailable(RuntimeError):
    pass


class ResearchSiteNotFound(LookupError):
    pass


class ResearchSiteInferenceBlocked(RuntimeError):
    pass


class ResearchSiteMatchUnavailable(LookupError):
    pass


def configured_database_path() -> Path:
    configured = os.getenv("SOLARCHECK_RESEARCH_SITE_DB", "").strip()
    return Path(configured).expanduser() if configured else DEFAULT_DATABASE


@lru_cache(maxsize=8)
def _verify_sha256(path_text: str, size: int, modified_ns: int, expected: str) -> bool:
    del size, modified_ns  # Values intentionally participate in the cache key.
    digest = hashlib.sha256()
    with Path(path_text).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest().upper() == expected.upper()


class ResearchSiteRepository:
    def __init__(self, database: Path | None = None):
        self.database = Path(database) if database is not None else configured_database_path()

    @property
    def package_manifest(self) -> Path:
        return self.database.with_name("mapping_manifest.json")

    def _verify_package(self) -> dict:
        if not self.database.is_file() or not self.package_manifest.is_file():
            raise ResearchSiteUnavailable("연구 대상지 매핑 패키지가 준비되지 않았어요.")
        try:
            document = json.loads(self.package_manifest.read_text(encoding="utf-8"))
            stat = self.database.stat()
            if document["database"] != self.database.name or int(document["database_bytes"]) != stat.st_size:
                raise ValueError("database identity mismatch")
            if not _verify_sha256(str(self.database.resolve()), stat.st_size, stat.st_mtime_ns, document["database_sha256"]):
                raise ValueError("database hash mismatch")
        except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise ResearchSiteUnavailable("연구 대상지 매핑 패키지 검증에 실패했어요.") from error
        return document

    def _connect(self) -> tuple[sqlite3.Connection, dict]:
        package = self._verify_package()
        try:
            uri = self.database.resolve().as_uri() + "?mode=ro"
            connection = sqlite3.connect(uri, uri=True)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA query_only = ON")
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not REQUIRED_TABLES.issubset(tables):
                raise ValueError("required tables missing")
            if connection.execute("PRAGMA quick_check(1)").fetchone()[0] != "ok":
                raise ValueError("database quick check failed")
        except (OSError, sqlite3.Error, ValueError) as error:
            if "connection" in locals():
                connection.close()
            raise ResearchSiteUnavailable("연구 대상지 데이터베이스를 읽을 수 없어요.") from error
        return connection, package

    @staticmethod
    def _metadata(connection: sqlite3.Connection) -> dict:
        return {
            row["key"]: json.loads(row["value_json"])
            for row in connection.execute("SELECT key, value_json FROM metadata")
        }

    def status(self) -> dict:
        try:
            connection, package = self._connect()
            with connection:
                metadata = self._metadata(connection)
                counts = connection.execute(
                    "SELECT (SELECT COUNT(*) FROM sensors), (SELECT COUNT(*) FROM buildings), "
                    "(SELECT COUNT(*) FROM surface_groups), (SELECT SUM(hourly_inference_eligible) FROM sensors)"
                ).fetchone()
            connection.close()
            return {
                "ready": True,
                "site_id": metadata["site_id"],
                "spec_version": metadata["spec_version"],
                "sensor_count": counts[0],
                "building_count": counts[1],
                "surface_group_count": counts[2],
                "hourly_inference_eligible": counts[3],
                "package_sha256": package["database_sha256"],
            }
        except (ResearchSiteUnavailable, KeyError, json.JSONDecodeError):
            return {
                "ready": False,
                "code": "RESEARCH_SITE_PACKAGE_UNAVAILABLE",
                "message": "연구 대상지 매핑 패키지를 확인해 주세요.",
            }

    def overview(self) -> dict:
        connection, package = self._connect()
        try:
            metadata = self._metadata(connection)
            summary = connection.execute(
                "SELECT COUNT(*) AS sensor_count, COUNT(DISTINCT building_id) AS building_count, "
                "COUNT(DISTINCT surface_group_id) AS surface_group_count, "
                "SUM(surface_type='Roof') AS roof_sensor_count, "
                "SUM(surface_type='Facade') AS facade_sensor_count, "
                "SUM(hourly_inference_eligible) AS hourly_inference_eligible, "
                "MIN(x) AS x_min, MAX(x) AS x_max, MIN(y) AS y_min, MAX(y) AS y_max, "
                "MIN(z) AS z_min, MAX(z) AS z_max, "
                "MIN(annual_prediction_kwh_m2_year) AS annual_min, "
                "MAX(annual_prediction_kwh_m2_year) AS annual_max FROM sensors"
            ).fetchone()
            return {
                "site_id": metadata["site_id"],
                "coordinate_frame": metadata["coordinate_frame"],
                "primary_sensor_key": metadata["primary_sensor_key"],
                "sensor_count": summary["sensor_count"],
                "building_count": summary["building_count"],
                "surface_group_count": summary["surface_group_count"],
                "roof_sensor_count": summary["roof_sensor_count"],
                "facade_sensor_count": summary["facade_sensor_count"],
                "hourly_inference_eligible": summary["hourly_inference_eligible"],
                "hourly_inference_blocked": summary["sensor_count"] - summary["hourly_inference_eligible"],
                "coordinate_bounds_m": {
                    "x": [summary["x_min"], summary["x_max"]],
                    "y": [summary["y_min"], summary["y_max"]],
                    "z": [summary["z_min"], summary["z_max"]],
                },
                "annual_prediction_range_kwh_m2_year": [summary["annual_min"], summary["annual_max"]],
                "surface_group_rule": metadata["surface_group_rule"],
                "surface_group_limitation": metadata["surface_group_limitation"],
                "package_sha256": package["database_sha256"],
            }
        finally:
            connection.close()

    def list_buildings(self, *, offset: int, limit: int) -> dict:
        connection, _ = self._connect()
        try:
            total = connection.execute("SELECT COUNT(*) FROM buildings").fetchone()[0]
            rows = connection.execute(
                "SELECT * FROM buildings "
                "ORDER BY CASE WHEN building_id GLOB 'B[0-9]*' THEN CAST(substr(building_id,2) AS INTEGER) END, building_id "
                "LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
            return {"total": total, "offset": offset, "limit": limit, "items": [dict(row) for row in rows]}
        finally:
            connection.close()

    def building(self, building_id: str) -> dict:
        connection, _ = self._connect()
        try:
            building = connection.execute("SELECT * FROM buildings WHERE building_id=?", (building_id,)).fetchone()
            if building is None:
                raise ResearchSiteNotFound("연구 대상지에서 해당 건물을 찾을 수 없어요.")
            groups = connection.execute(
                "SELECT * FROM surface_groups WHERE building_id=? "
                "ORDER BY surface_type, normal_azimuth_bin_deg, normal_tilt_bin_deg, surface_group_id",
                (building_id,),
            ).fetchall()
            result = dict(building)
            result["surface_groups"] = [dict(row) for row in groups]
            return result
        finally:
            connection.close()

    def surface_sensors(
        self, surface_group_id: str, *, offset: int, limit: int, hourly_eligible_only: bool
    ) -> dict:
        connection, _ = self._connect()
        try:
            group = connection.execute(
                "SELECT * FROM surface_groups WHERE surface_group_id=?", (surface_group_id,)
            ).fetchone()
            if group is None:
                raise ResearchSiteNotFound("연구 대상지에서 해당 표면 그룹을 찾을 수 없어요.")
            condition = "surface_group_id=?" + (" AND hourly_inference_eligible=1" if hourly_eligible_only else "")
            total = connection.execute(f"SELECT COUNT(*) FROM sensors WHERE {condition}", (surface_group_id,)).fetchone()[0]
            rows = connection.execute(
                "SELECT sensor_row_index, sample_order, x, y, z, nx, ny, nz, "
                "annual_prediction_kwh_m2_year, hourly_inference_eligible "
                f"FROM sensors WHERE {condition} ORDER BY sample_order LIMIT ? OFFSET ?",
                (surface_group_id, limit, offset),
            ).fetchall()
            return {
                "surface_group": dict(group),
                "total": total,
                "offset": offset,
                "limit": limit,
                "hourly_eligible_only": hourly_eligible_only,
                "items": [dict(row) for row in rows],
            }
        finally:
            connection.close()

    def inference_sensor(self, sensor_row_index: int) -> dict:
        """Return the frozen model inputs for one server-selected sensor."""
        connection, _ = self._connect()
        try:
            row = connection.execute(
                "SELECT sensor_row_index, building_id, surface_type, surface_group_id, "
                "x, y, z, nx, ny, nz, horizon_n, horizon_ne, horizon_e, horizon_se, "
                "horizon_s, horizon_sw, horizon_w, horizon_nw, "
                "annual_prediction_kwh_m2_year, hourly_inference_eligible "
                "FROM sensors WHERE sensor_row_index=?",
                (sensor_row_index,),
            ).fetchone()
            if row is None:
                raise ResearchSiteNotFound("연구 대상지에서 해당 센서를 찾을 수 없어요.")
            result = dict(row)
            if not result["hourly_inference_eligible"]:
                raise ResearchSiteInferenceBlocked(
                    "해당 센서는 고정 학습 XYZ 범위 밖이므로 시간별 재추론을 실행하지 않아요."
                )
            return result
        finally:
            connection.close()

    def monthly_inference_sensors(self, building_id: str, surface_group_id: str | None = None) -> list[dict]:
        """Return frozen E2c inputs for a complete building or one of its surface groups."""
        connection, _ = self._connect()
        try:
            condition = "building_id=?"
            parameters: list[object] = [building_id]
            if surface_group_id is not None:
                condition += " AND surface_group_id=?"
                parameters.append(surface_group_id)
            rows = connection.execute(
                "SELECT sensor_row_index, building_id, surface_type, surface_group_id, "
                "x, y, z, nx, ny, nz, horizon_n, horizon_ne, horizon_e, horizon_se, "
                "horizon_s, horizon_sw, horizon_w, horizon_nw, "
                "annual_prediction_kwh_m2_year, hourly_inference_eligible "
                f"FROM sensors WHERE {condition} ORDER BY sample_order",
                parameters,
            ).fetchall()
            if not rows:
                raise ResearchSiteNotFound("연구 대상지에서 월별 분석 대상을 찾을 수 없어요.")
            result = [dict(row) for row in rows]
            if any(not sensor["hourly_inference_eligible"] for sensor in result):
                raise ResearchSiteInferenceBlocked(
                    "선택한 표면의 일부 분석 위치가 고정 학습 XYZ 범위를 벗어나 월별 추론을 실행하지 않아요."
                )
            return result
        finally:
            connection.close()

    def building_vertical_profile(self, building_id: str) -> dict:
        """Return a conservative vertical envelope from the frozen building sensors."""
        connection, _ = self._connect()
        try:
            row = connection.execute(
                "SELECT MIN(z) AS z_min, MAX(z) AS z_max, "
                "AVG(CASE WHEN surface_type='Roof' THEN z END) AS roof_z "
                "FROM sensors WHERE building_id=?", (building_id,),
            ).fetchone()
            if row is None or row["z_min"] is None or row["z_max"] is None:
                raise ResearchSiteNotFound("연구 대상지에서 건물의 높이 범위를 찾을 수 없어요.")
            top_z = float(row["roof_z"] if row["roof_z"] is not None else row["z_max"])
            base_z = min(float(row["z_min"]), top_z - 0.5) - 0.5 * 1.5
            return {
                "basis": "matched_research_sensor_envelope",
                "base_z_m": base_z,
                "top_z_m": top_z,
                "height_m": top_z - base_z,
            }
        finally:
            connection.close()

    def match_building_polygon(self, polygon: Polygon, *, search_radius_m: float = 45.0) -> dict:
        """Match a georeferenced public footprint to frozen sensor geometry; fail closed."""
        if not isinstance(polygon, Polygon) or polygon.is_empty or not polygon.is_valid or polygon.area < 1:
            raise ValueError("Expected a valid public building polygon")
        center = polygon.centroid
        connection, _ = self._connect()
        try:
            candidates = connection.execute(
                "SELECT * FROM buildings WHERE (x_min+x_max)/2 BETWEEN ? AND ? "
                "AND (y_min+y_max)/2 BETWEEN ? AND ?",
                (center.x - search_radius_m, center.x + search_radius_m,
                 center.y - search_radius_m, center.y + search_radius_m),
            ).fetchall()
            scored = []
            for candidate in candidates:
                points = connection.execute(
                    "SELECT x,y FROM sensors WHERE building_id=?", (candidate["building_id"],)
                ).fetchall()
                hull = MultiPoint([(row["x"], row["y"]) for row in points]).convex_hull
                distance = float(center.distance(hull.centroid))
                overlap = 0.0
                if hull.geom_type == "Polygon" and hull.area > 0:
                    union = polygon.union(hull).area
                    overlap = float(polygon.intersection(hull).area / union) if union else 0.0
                scored.append((overlap, distance, dict(candidate)))
        finally:
            connection.close()
        scored.sort(key=lambda item: (-item[0], item[1], item[2]["building_id"]))
        if not scored:
            raise ResearchSiteMatchUnavailable("입력 건물을 연구 대상지 건물과 매칭하지 못했어요.")
        overlap, distance, building = scored[0]
        second_overlap = scored[1][0] if len(scored) > 1 else 0.0
        # Sparse sampled buildings cannot establish a footprint identity. Require both proximity
        # and meaningful shape overlap, with a clear margin over the next candidate.
        if distance > 10.0 or overlap < 0.25 or overlap - second_overlap < 0.10:
            raise ResearchSiteMatchUnavailable(
                "가장 가까운 연구 건물의 위치·외곽 일치도가 부족해 자동 분석을 실행하지 않아요."
            )
        return {
            "status": "matched",
            "building_id": building["building_id"],
            "centroid_distance_m": distance,
            "footprint_iou": overlap,
            "public_centroid_xy_m": [center.x, center.y],
            "sensor_count": building["sensor_count"],
            "hourly_eligible_sensor_count": building["hourly_eligible_sensor_count"],
        }

