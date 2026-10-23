import importlib.util
import unittest
from unittest.mock import patch

import numpy as np
from fastapi import HTTPException

from backend.surrogate import (facade_sensors, aggregate_cells, soft_visibility,
                               predict_research_sensors, status)
from backend.main import BuildingLookup, analyze_irradiance


class SurrogateTests(unittest.TestCase):
    def test_geographic_registration_is_required_even_with_model_files(self):
        state = status()
        self.assertFalse(state['address_inference_ready'])
        self.assertIn('MODEL_GEOREFERENCE_REQUIRED', [b['code'] for b in state['blockers']])
        with self.assertRaises(HTTPException) as raised:
            analyze_irradiance(BuildingLookup(address='테스트 주소'))
        self.assertEqual(raised.exception.status_code, 409)
        self.assertNotIn('faces', raised.exception.detail)
        self.assertNotIn('C:', str(state))

    def test_local_grid_preserves_photo_cell_order_and_outward_normal(self):
        xyz, normal = facade_sensors({'p0': [0, 0], 'p1': [4, 0], 'ns': 2, 'nt': 2, 'height_m': 6})
        np.testing.assert_allclose(normal, [0, -1, 0])
        np.testing.assert_allclose(xyz, [[1, -.1, 1.5], [3, -.1, 1.5], [1, -.1, 4.5], [3, -.1, 4.5]])

    def test_horizon_wrap_and_original_two_degree_soft_visibility(self):
        horizon = np.array([[0, 10, 20, 30, 40, 50, 60, 70]])
        value = soft_visibility(horizon, np.array([35, 5, -1]), np.array([337.5, 22.5, 0]))
        np.testing.assert_allclose(value, [[.5, .5, 0]])

    def test_energy_units_and_no_time_shape_from_annual_total(self):
        cells = np.zeros((2, 8760)); cells[0, 12] = 1000; cells[1, 13] = 500
        data = aggregate_cells(cells)
        self.assertEqual(data['annual'], [1, .5])
        self.assertEqual(data['hourly'][12:14], [500, 250])
        for bad in (np.ones((2, 12)), np.array([1000, 500]), np.full((1, 8760), np.nan)):
            with self.assertRaises(ValueError): aggregate_cells(bad)

    def test_recentered_or_nonphysical_inputs_cannot_reach_model(self):
        with patch('backend.surrogate.load') as loader:
            for frame in ('building-centred', 'wgs84'):
                with self.assertRaises(ValueError):
                    predict_research_sensors([[0, 0, 0]], [[0, -1, 0]], [[0] * 8], coordinate_frame=frame)
            with self.assertRaises(ValueError):
                predict_research_sensors([[0, 0, 0]], [[0, 0, 0]], [[0] * 8], coordinate_frame='original-research-local')
            loader.assert_not_called()

    @unittest.skipUnless(importlib.util.find_spec('torch'), 'Optional PyTorch not installed')
    def test_e2c_physics_day_night_and_vertical_diffuse(self):
        import torch
        from backend.e2c_model import E2cModel
        model = E2cModel().eval()
        with torch.no_grad():
            model.correction_head.weight.zero_()
            model.correction_head.bias.fill_(np.log(np.expm1(1)))  # correction = 1
            independent = torch.zeros((3, 8))
            independent[0, 4:8] = torch.tensor([.5, np.sqrt(.75), 0, -1])
            independent[1, 4:8] = independent[0, 4:8]
            independent[2, 4] = -.5
            cond = torch.zeros((3, 14))
            cond[0, 1] = -1  # south wall, clear sky
            cond[1, 2] = 1  # horizontal roof
            cond[:, 3:5] = torch.tensor([.8, .1])
            cond[:, 13] = 1
            out = model(independent, cond).numpy().ravel()
        np.testing.assert_allclose(out, [800 * np.sqrt(.75) + 50, 400 + 100, 0], atol=1e-3)


if __name__ == '__main__':
    unittest.main()
