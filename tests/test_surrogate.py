import importlib.util
import unittest
from datetime import date
from unittest.mock import patch

import numpy as np
from fastapi import HTTPException

from backend.surrogate import (facade_sensors, aggregate_cells, soft_visibility,
                               predict_research_sensors, predict_research_sensors_at_hours, status)
from backend.main import (BuildingLookup, analyze_irradiance,
                          research_site_sensor_irradiance, _predict_candidate_grid,
                          _predict_monthly_irradiance)


class SurrogateTests(unittest.TestCase):
    def test_arbitrary_address_inference_stays_blocked_with_same_site_matching(self):
        state = status()
        self.assertFalse(state['address_inference_ready'])
        self.assertTrue(state['same_site_address_matching'])
        self.assertIn('OUTSIDE_FROZEN_RESEARCH_SITE_BLOCKED', [b['code'] for b in state['blockers']])
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

    def test_requested_hour_indices_are_validated_before_model_load(self):
        with patch('backend.surrogate.load') as loader:
            valid_geometry = ([[0, 0, 0]], [[0, -1, 0]], [[0] * 8])
            for hours in ([], [-1], [8760], [12, 12], [1.5]):
                with self.assertRaises(ValueError):
                    predict_research_sensors_at_hours(
                        *valid_geometry, hours, coordinate_frame='original-research-local'
                    )
            loader.assert_not_called()

    def test_research_sensor_day_response_has_real_time_axis_and_units(self):
        sensor = {
            'sensor_row_index': 7, 'building_id': 'B0', 'surface_type': 'Facade',
            'surface_group_id': 'B0:F:A180:T090', 'annual_prediction_kwh_m2_year': 600,
            'x': 0, 'y': 0, 'z': 5, 'nx': 0, 'ny': -1, 'nz': 0,
            **{f'horizon_{key}': 0 for key in ('n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw')},
        }
        solar = [{
            'timestamp': f'2021-01-01T{hour:02d}:30:00+09:00',
            'solar_altitude_deg': str(hour - 6), 'solar_azimuth_deg': '180',
            'dni': '500', 'dhi': '100',
        } for hour in range(24)]
        prediction = np.arange(24, dtype=np.float32)[None, :]
        with patch('backend.main.research_site.inference_sensor', return_value=sensor), \
             patch('backend.main.predict_research_sensors_at_hours', return_value=prediction) as predictor, \
             patch('backend.main.load_surrogate', return_value=(None, None, solar)):
            result = research_site_sensor_irradiance(7, date(2021, 1, 1))
        self.assertEqual(len(result['series']), 24)
        self.assertEqual(result['series'][12]['timestamp'], '2021-01-01T12:30:00+09:00')
        self.assertEqual(result['series'][12]['irradiance_w_m2'], 12)
        self.assertAlmostEqual(result['daily_energy_kwh_m2'], sum(range(24)) / 1000)
        self.assertEqual(result['peak_irradiance_w_m2'], 23)
        self.assertEqual(predictor.call_args.args[3], list(range(24)))

    def test_candidate_grid_annual_prediction_uses_original_coordinates(self):
        sensors = [{
            'candidate_id': f'candidate:{index}', 'x': index, 'y': 2, 'z': 3,
            'nx': 0, 'ny': -1, 'nz': 0,
            'horizon_deg': {key: 0 for key in ('n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw')},
        } for index in range(2)]
        prediction = np.vstack([np.full(8760, 100.0), np.full(8760, 250.0)])
        with patch('backend.main.predict_research_sensors', return_value=prediction) as predictor:
            result = _predict_candidate_grid({'sensors': sensors})
        self.assertEqual(result['sensor_count'], 2)
        self.assertEqual(result['coordinate_frame'], 'original-research-local')
        self.assertAlmostEqual(result['items'][0]['annual_prediction_kwh_m2_year'], 876)
        self.assertAlmostEqual(result['items'][1]['annual_prediction_kwh_m2_year'], 2190)
        self.assertEqual(predictor.call_args.kwargs['coordinate_frame'], 'original-research-local')

    def test_monthly_prediction_aggregates_hourly_energy_by_calendar_month(self):
        sensor = {
            'building_id': 'B0', 'surface_group_id': 'B0:F:A180:T090',
            'x': 0, 'y': 0, 'z': 5, 'nx': 0, 'ny': -1, 'nz': 0,
            **{f'horizon_{key}': 0 for key in ('n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw')},
        }
        prediction = np.ones((2, 8760), dtype=np.float32) * np.array([[100], [300]], dtype=np.float32)
        with patch('backend.main.predict_research_sensors', return_value=prediction) as predictor:
            result = _predict_monthly_irradiance([sensor, sensor])
        self.assertEqual(len(result['series']), 12)
        self.assertAlmostEqual(result['series'][0]['irradiance_kwh_m2_month'], 148.8)
        self.assertAlmostEqual(result['series'][1]['irradiance_kwh_m2_month'], 134.4)
        self.assertAlmostEqual(result['annual_mean_kwh_m2_year'], 1752.0)
        self.assertEqual(predictor.call_args.kwargs['coordinate_frame'], 'original-research-local')

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
