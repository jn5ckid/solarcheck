import unittest
from unittest.mock import patch

from backend.main import BuildingLookup, lookup_building
from backend.research_georef import (georeference, match_public_site, public_ring_in_research_frame,
                                     public_site_polygon_in_research_frame)


def reference_site(target=None):
    record = georeference()
    return {
        'target': target or [[-5, -5], [5, -5], [5, 5], [-5, 5], [-5, -5]],
        'geometry_frame': {
            'crs': (f'+proj=aeqd +lat_0={record["origin_lat"]} +lon_0={record["origin_lon"]} '
                    '+datum=WGS84 +units=m +type=crs'),
            'origin_in_crs_m': [0, 0],
            'axes': 'east,north,up',
        },
    }


class ResearchGeoreferenceTests(unittest.TestCase):
    def test_reference_frame_round_trip_preserves_local_xy(self):
        polygon = public_site_polygon_in_research_frame(reference_site())
        self.assertAlmostEqual(polygon.centroid.x, 0, places=5)
        self.assertAlmostEqual(polygon.centroid.y, 0, places=5)
        self.assertAlmostEqual(polygon.area, 100, places=3)

    def test_any_relative_ring_uses_the_same_public_frame(self):
        polygon = public_ring_in_research_frame(reference_site(), [[15, -5], [25, -5], [25, 5], [15, 5], [15, -5]])
        self.assertAlmostEqual(polygon.centroid.x, 20, places=3)
        self.assertAlmostEqual(polygon.centroid.y, 0, places=3)

    def test_match_adds_frozen_origin_without_exposing_paths(self):
        class Repository:
            def match_building_polygon(self, polygon):
                return {'status': 'matched', 'building_id': 'B1257', 'footprint_iou': .75,
                        'centroid_distance_m': 1.2}
        result = match_public_site(reference_site(), Repository())
        self.assertEqual(result['building_id'], 'B1257')
        self.assertEqual(result['coordinate_frame'], 'original-research-local')
        self.assertNotIn('C:', str(result))

    def test_public_lookup_is_enriched_only_after_a_complete_selection(self):
        response = {'status': 'ok', 'site': reference_site(), 'warnings': []}
        matched = {'status': 'matched', 'building_id': 'B1257'}
        with patch('backend.main.PublicBuildings') as public, patch(
                'backend.main.match_public_site', return_value=matched) as matcher:
            public.return_value.lookup.return_value = response
            result = lookup_building(BuildingLookup(address='서울시 동작구 테스트로 1'))
        self.assertEqual(result['research_match'], matched)
        self.assertIn('건물 B1257에 일치', result['message'])
        matcher.assert_called_once()


if __name__ == '__main__':
    unittest.main()
