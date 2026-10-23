"""Georeference public building geometry into the frozen research-local frame."""

from __future__ import annotations

import json
import math
from pathlib import Path

from pyproj import CRS, Transformer
from shapely.geometry import Polygon


PROJECT = Path(__file__).resolve().parents[1]
MANIFEST = PROJECT / "RESEARCH_SITE_MANIFEST.json"


class ResearchGeoreferenceUnavailable(RuntimeError):
    pass


def georeference() -> dict:
    try:
        record = json.loads(MANIFEST.read_text(encoding="utf-8"))["georeference"]
        lon, lat = float(record["origin_lon"]), float(record["origin_lat"])
        if record["local_xy_origin_m"] != [0.0, 0.0] or record["axes"] != "east,north,up":
            raise ValueError("unsupported frame")
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise ResearchGeoreferenceUnavailable("연구 대상지 지리 기준점을 확인해 주세요.") from error
    return record | {"origin_lon": lon, "origin_lat": lat}


def public_ring_in_research_frame(site: dict, relative_ring: list) -> Polygon:
    """Transform one public-site relative ring into the frozen research frame."""
    record = georeference()
    try:
        frame = site["geometry_frame"]
        source_crs = CRS.from_user_input(frame["crs"])
        center_x, center_y = map(float, frame["origin_in_crs_m"])
        inverse = Transformer.from_crs(source_crs, 4326, always_xy=True)
        target_crs = CRS.from_proj4(
            f'+proj=aeqd +lat_0={record["origin_lat"]} +lon_0={record["origin_lon"]} '
            '+datum=WGS84 +units=m'
        )
        forward = Transformer.from_crs(4326, target_crs, always_xy=True)
        ring = []
        for relative_x, relative_y in relative_ring:
            lon, lat = inverse.transform(center_x + float(relative_x), center_y + float(relative_y))
            ring.append(forward.transform(lon, lat))
        polygon = Polygon(ring)
    except (KeyError, TypeError, ValueError) as error:
        raise ResearchGeoreferenceUnavailable("공공 건물 좌표를 연구 좌표로 변환하지 못했어요.") from error
    if (not polygon.is_valid or polygon.is_empty or polygon.area < 1
            or not all(math.isfinite(value) for value in polygon.bounds)):
        raise ResearchGeoreferenceUnavailable("변환된 건물 형상이 유효하지 않아요.")
    return polygon


def public_site_polygon_in_research_frame(site: dict) -> Polygon:
    """Transform the selected public footprint, which is stored relative to its centroid."""
    return public_ring_in_research_frame(site, site["target"])


def match_public_site(site: dict, repository) -> dict:
    polygon = public_site_polygon_in_research_frame(site)
    result = repository.match_building_polygon(polygon)
    record = georeference()
    return result | {
        "origin_address": record["origin_address"],
        "origin_lon": record["origin_lon"],
        "origin_lat": record["origin_lat"],
        "coordinate_frame": "original-research-local",
    }
