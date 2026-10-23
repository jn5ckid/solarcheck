import hashlib
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from backend.research_site import (ResearchSiteInferenceBlocked, ResearchSiteNotFound,
                                   ResearchSiteRepository)
from prep.build_research_site_mapping import create_schema, populate_summaries


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest().upper()


class ResearchSiteRepositoryTests(unittest.TestCase):
    def setUp(self):
        test_temp_root = Path(__file__).resolve().parents[1] / 'outputs' / 'test-temp'
        test_temp_root.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=test_temp_root)
        self.database = Path(self.temp.name) / 'research_site.sqlite'
        connection = sqlite3.connect(self.database)
        create_schema(connection)
        rows = [
            (1, 0, 'B0', 'B0_Roof', 0, 'Roof', 'B0:R:A000:T000',
             0, 0, 10, 0, 0, 1, 0, 0, *([0] * 8), 1500, 1),
            (2, 1, 'B0', 'B0_Facade', 0, 'Facade', 'B0:F:A180:T090',
             0, -1, 5, 0, -1, 0, 180, 90, *([15] * 8), 600, 1),
            (3, 2, 'B1', 'B1_Facade', 0, 'Facade', 'B1:F:A090:T090',
             10, 0, 5, 1, 0, 0, 90, 90, *([20] * 8), 400, 0),
        ]
        connection.executemany(f"INSERT INTO sensors VALUES ({','.join('?' for _ in range(25))})", rows)
        populate_summaries(connection)
        metadata = {
            'spec_version': 'solarcheck-research-site-mapping/v1',
            'site_id': 'test_site',
            'coordinate_frame': 'original-research-local',
            'primary_sensor_key': 'sensor_row_index',
            'surface_group_rule': 'test rule',
            'surface_group_limitation': 'test limitation',
        }
        connection.executemany(
            'INSERT INTO metadata(key,value_json) VALUES (?,?)',
            [(key, json.dumps(value)) for key, value in metadata.items()],
        )
        connection.commit()
        connection.close()
        package = {
            'database': self.database.name,
            'database_bytes': self.database.stat().st_size,
            'database_sha256': file_sha256(self.database),
        }
        self.database.with_name('mapping_manifest.json').write_text(json.dumps(package), encoding='utf-8')
        self.repository = ResearchSiteRepository(self.database)

    def tearDown(self):
        self.temp.cleanup()

    def test_status_and_overview(self):
        status = self.repository.status()
        self.assertTrue(status['ready'])
        self.assertEqual(status['sensor_count'], 3)
        overview = self.repository.overview()
        self.assertEqual(overview['building_count'], 2)
        self.assertEqual(overview['hourly_inference_eligible'], 2)
        self.assertEqual(overview['hourly_inference_blocked'], 1)

    def test_building_and_surface_sensor_queries(self):
        buildings = self.repository.list_buildings(offset=0, limit=1)
        self.assertEqual(buildings['total'], 2)
        self.assertEqual(buildings['items'][0]['building_id'], 'B0')
        building = self.repository.building('B0')
        self.assertEqual(building['sensor_count'], 2)
        self.assertEqual(len(building['surface_groups']), 2)
        sensors = self.repository.surface_sensors(
            'B0:F:A180:T090', offset=0, limit=10, hourly_eligible_only=True
        )
        self.assertEqual(sensors['total'], 1)
        self.assertEqual(sensors['items'][0]['sensor_row_index'], 2)

    def test_unknown_items_and_tampered_package_fail_closed(self):
        with self.assertRaises(ResearchSiteNotFound):
            self.repository.building('missing')
        with self.database.open('ab') as handle:
            handle.write(b'tampered')
        status = self.repository.status()
        self.assertFalse(status['ready'])
        self.assertNotIn(str(self.database), str(status))

    def test_inference_sensor_uses_frozen_inputs_and_blocks_extrapolation(self):
        sensor = self.repository.inference_sensor(2)
        self.assertEqual(sensor['building_id'], 'B0')
        self.assertEqual(sensor['horizon_n'], 15)
        self.assertEqual(sensor['horizon_nw'], 15)
        with self.assertRaises(ResearchSiteInferenceBlocked):
            self.repository.inference_sensor(3)
        with self.assertRaises(ResearchSiteNotFound):
            self.repository.inference_sensor(999)

    def test_monthly_inference_requires_a_complete_eligible_surface(self):
        sensors = self.repository.monthly_inference_sensors('B0', 'B0:F:A180:T090')
        self.assertEqual([sensor['sensor_row_index'] for sensor in sensors], [2])
        with self.assertRaises(ResearchSiteInferenceBlocked):
            self.repository.monthly_inference_sensors('B1', 'B1:F:A090:T090')
        with self.assertRaises(ResearchSiteNotFound):
            self.repository.monthly_inference_sensors('B0', 'missing')

    def test_building_vertical_profile_uses_roof_level_and_sensor_envelope(self):
        profile = self.repository.building_vertical_profile('B0')
        self.assertEqual(profile['basis'], 'matched_research_sensor_envelope')
        self.assertLess(profile['base_z_m'], profile['top_z_m'])
        self.assertAlmostEqual(profile['height_m'], profile['top_z_m'] - profile['base_z_m'])


if __name__ == '__main__':
    unittest.main()
