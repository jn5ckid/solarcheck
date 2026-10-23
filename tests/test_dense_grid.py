import unittest
from unittest.mock import patch

import numpy as np
from shapely.geometry import Polygon

from backend.dense_grid import (DenseGridUnavailable, build_dense_grid,
                                horizon_degrees)


class Repository:
    def building_vertical_profile(self, building_id):
        if building_id != "B1":
            raise AssertionError("unexpected building")
        return {
            "basis": "matched_research_sensor_envelope",
            "base_z_m": 10.0,
            "top_z_m": 20.0,
            "height_m": 10.0,
        }


class DenseGridTests(unittest.TestCase):
    def test_horizon_uses_north_clockwise_directions(self):
        points = np.array([[0.0, 0.0, 0.0]])
        # A 10 m high east-west wall 10 m north gives a 45 degree north horizon.
        segments = np.array([[-5.0, 10.0, 5.0, 10.0, 10.0]])
        horizon = horizon_degrees(points, segments)
        self.assertAlmostEqual(horizon[0, 0], 45.0, places=6)
        self.assertEqual(horizon[0, 4], 0.0)

    def test_verified_match_builds_unit_normals_and_eight_direction_horizons(self):
        site = {
            "target": [[-5, -5], [5, -5], [5, 5], [-5, 5], [-5, -5]],
            "context": [{
                "footprint": [[-5, 15], [5, 15], [5, 20], [-5, 20], [-5, 15]],
                "height_m": 20,
            }],
            "geometry_frame": {"crs": "EPSG:5179", "origin_in_crs_m": [0, 0]},
        }
        match = {"status": "matched", "coordinate_frame": "original-research-local", "building_id": "B1"}
        def polygon(_site, ring):
            return Polygon(ring)
        with patch("backend.dense_grid.public_ring_in_research_frame", side_effect=polygon):
            grid = build_dense_grid(site, match, Repository())
        self.assertGreater(grid["facade_sensor_count"], 0)
        self.assertGreater(grid["roof_sensor_count"], 0)
        self.assertEqual(grid["sensor_count"], len(grid["sensors"]))
        self.assertEqual(grid["context_block_count"], 1)
        for sensor in grid["sensors"]:
            self.assertAlmostEqual(np.linalg.norm([sensor["nx"], sensor["ny"], sensor["nz"]]), 1.0)
            self.assertEqual(set(sensor["horizon_deg"]), {"n", "ne", "e", "se", "s", "sw", "w", "nw"})
            self.assertTrue(all(0 <= value <= 90 for value in sensor["horizon_deg"].values()))

    def test_unverified_match_is_rejected(self):
        with self.assertRaises(DenseGridUnavailable):
            build_dense_grid({}, {"status": "unmatched"}, Repository())


if __name__ == "__main__":
    unittest.main()
