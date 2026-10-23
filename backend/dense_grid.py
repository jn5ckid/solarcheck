"""Generate candidate analysis sensors for a verified same-site public block model.

The grid is deliberately geometry-only.  It produces the frozen E2c geometric
inputs (research-frame XYZ, unit normals and eight-direction horizons), but it
does not claim that those new points have been validated for model inference.
"""

from __future__ import annotations

import math

import numpy as np
from shapely.geometry import Point, Polygon
from shapely.geometry.polygon import orient

from .research_georef import public_ring_in_research_frame


CELL_M = 1.5
OFFSET_M = 0.1
ROOF_SETBACK_M = 1.0
MIN_EDGE_M = 0.8
HORIZON_NAMES = ("n", "ne", "e", "se", "s", "sw", "w", "nw")
HORIZON_AZIMUTH_DEG = np.arange(8, dtype=float) * 45.0
HORIZON_DIRECTIONS = np.column_stack((
    np.sin(np.radians(HORIZON_AZIMUTH_DEG)),
    np.cos(np.radians(HORIZON_AZIMUTH_DEG)),
))


class DenseGridUnavailable(RuntimeError):
    pass


def _block_edges(blocks: list[tuple[Polygon, float]]) -> np.ndarray:
    rows = []
    for polygon, top_z in blocks:
        coordinates = np.asarray(polygon.exterior.coords, dtype=float)
        rows.extend([*a, *b, float(top_z)] for a, b in zip(coordinates[:-1], coordinates[1:]))
    return np.asarray(rows, dtype=float)


def horizon_degrees(points: np.ndarray, segments: np.ndarray) -> np.ndarray:
    """Return N/NE/E/SE/S/SW/W/NW obstacle elevations in degrees."""
    if not len(points):
        return np.empty((0, 8), dtype=float)
    if not len(segments):
        return np.zeros((len(points), 8), dtype=float)
    ax, ay, bx, by, height = segments.T
    edge_x, edge_y = bx - ax, by - ay
    output = np.zeros((len(points), 8), dtype=float)
    for start in range(0, len(points), 64):
        chunk = points[start:start + 64]
        px, py, pz = (chunk[:, index, None, None] for index in range(3))
        ray_x = HORIZON_DIRECTIONS[None, :, 0, None]
        ray_y = HORIZON_DIRECTIONS[None, :, 1, None]
        denominator = ray_x * edge_y - ray_y * edge_x
        offset_x, offset_y = ax - px, ay - py
        with np.errstate(divide="ignore", invalid="ignore"):
            distance = (offset_x * edge_y - offset_y * edge_x) / denominator
            fraction = (offset_x * ray_y - offset_y * ray_x) / denominator
        hit = ((np.abs(denominator) > 1e-12) & (distance > 1e-6)
               & (fraction >= 0) & (fraction <= 1))
        elevation = np.where(
            hit,
            np.arctan2(height - pz, np.where(hit, distance, 1.0)),
            0.0,
        )
        output[start:start + len(chunk)] = np.degrees(np.maximum(elevation.max(axis=2), 0.0))
    return np.clip(output, 0.0, 90.0)


def _facade_candidates(polygon: Polygon, base_z: float, top_z: float) -> tuple[list[dict], list[dict]]:
    sensors, surfaces = [], []
    ring = np.asarray(polygon.exterior.coords, dtype=float)
    height = top_z - base_z
    for edge_index, (a, b) in enumerate(zip(ring[:-1], ring[1:]), start=1):
        delta = b - a
        width = float(np.linalg.norm(delta))
        if width < MIN_EDGE_M:
            continue
        tangent = delta / width
        normal = np.array([tangent[1], -tangent[0], 0.0])
        columns, rows = max(1, round(width / CELL_M)), max(1, round(height / CELL_M))
        along = (np.arange(columns) + 0.5) * width / columns
        vertical = base_z + (np.arange(rows) + 0.5) * height / rows
        zz, ss = np.meshgrid(vertical, along, indexing="ij")
        xy = a + ss.ravel()[:, None] * tangent + OFFSET_M * normal[:2]
        surface_id = f"candidate:F{edge_index:02d}"
        start = len(sensors)
        for local_index, (point_xy, z) in enumerate(zip(xy, zz.ravel()), start=1):
            sensors.append({
                "candidate_id": f"{surface_id}:{local_index:04d}",
                "surface_id": surface_id,
                "surface_type": "Facade",
                "x": float(point_xy[0]), "y": float(point_xy[1]), "z": float(z),
                "nx": float(normal[0]), "ny": float(normal[1]), "nz": 0.0,
            })
        surfaces.append({
            "surface_id": surface_id, "surface_type": "Facade",
            "sensor_count": len(sensors) - start,
            "width_m": width, "height_m": height,
            "normal": normal.tolist(),
        })
    return sensors, surfaces


def _roof_candidates(polygon: Polygon, top_z: float) -> tuple[list[dict], dict | None]:
    inner = polygon.buffer(-ROOF_SETBACK_M)
    if inner.is_empty:
        inner = polygon
    if inner.geom_type == "MultiPolygon":
        inner = max(inner.geoms, key=lambda item: item.area)
    x_min, y_min, x_max, y_max = inner.bounds
    xs = np.arange(x_min + CELL_M / 2, x_max, CELL_M)
    ys = np.arange(y_min + CELL_M / 2, y_max, CELL_M)
    points = [(x, y) for y in ys for x in xs if inner.covers(Point(x, y))]
    if not points:
        point = inner.representative_point()
        points = [(point.x, point.y)]
    sensors = [{
        "candidate_id": f"candidate:R00:{index:04d}",
        "surface_id": "candidate:R00", "surface_type": "Roof",
        "x": float(x), "y": float(y), "z": float(top_z + OFFSET_M),
        "nx": 0.0, "ny": 0.0, "nz": 1.0,
    } for index, (x, y) in enumerate(points, start=1)]
    surface = {
        "surface_id": "candidate:R00", "surface_type": "Roof",
        "sensor_count": len(sensors), "area_m2": float(inner.area),
        "normal": [0.0, 0.0, 1.0],
    }
    return sensors, surface


def build_dense_grid(site: dict, match: dict, repository) -> dict:
    """Build a geometry preview only after strict public/research building matching."""
    if match.get("status") != "matched" or match.get("coordinate_frame") != "original-research-local":
        raise DenseGridUnavailable("검증된 연구 대상지 건물 매칭이 필요해요.")
    try:
        profile = repository.building_vertical_profile(match["building_id"])
        target = orient(public_ring_in_research_frame(site, site["target"]), 1.0)
        context = [
            (orient(public_ring_in_research_frame(site, block["footprint"]), 1.0),
             float(profile["base_z_m"]) + float(block["height_m"]))
            for block in site.get("context", []) if float(block.get("height_m") or 0) > 0
        ]
        base_z, top_z = float(profile["base_z_m"]), float(profile["top_z_m"])
    except (KeyError, TypeError, ValueError) as error:
        raise DenseGridUnavailable("후보 센서의 연구 좌표를 만들지 못했어요.") from error
    if not (target.is_valid and target.area >= 1 and math.isfinite(base_z)
            and math.isfinite(top_z) and top_z > base_z):
        raise DenseGridUnavailable("후보 센서를 만들 건물 형상 또는 높이가 유효하지 않아요.")

    facade_sensors, surfaces = _facade_candidates(target, base_z, top_z)
    roof_sensors, roof_surface = _roof_candidates(target, top_z)
    sensors = facade_sensors + roof_sensors
    if roof_surface:
        surfaces.append(roof_surface)
    points = np.array([[sensor[key] for key in ("x", "y", "z")] for sensor in sensors])
    segments = _block_edges([(target, top_z), *context])
    horizons = horizon_degrees(points, segments)
    for sensor, values in zip(sensors, horizons):
        sensor["horizon_deg"] = {name: round(float(value), 3) for name, value in zip(HORIZON_NAMES, values)}
        sensor["horizon_max_deg"] = round(float(values.max()), 3)

    return {
        "status": "geometry_ready_prediction_not_run",
        "coordinate_frame": "original-research-local",
        "cell_target_m": CELL_M,
        "roof_setback_m": ROOF_SETBACK_M,
        "terrain_assumption": "flat_ground_from_matched_building_vertical_profile",
        "z_alignment": profile,
        "sensor_count": len(sensors),
        "facade_sensor_count": len(facade_sensors),
        "roof_sensor_count": len(roof_sensors),
        "surface_count": len(surfaces),
        "context_block_count": len(context),
        "horizon_directions_deg": HORIZON_AZIMUTH_DEG.tolist(),
        "surfaces": surfaces,
        "sensors": sensors,
    }
