"""Official-shaped fixtures only. No live keys or real address records in tests."""
import json
import unittest
from unittest.mock import patch
from urllib.error import URLError

from backend.public_data import (PublicBuildings, LookupFailure, JsonTransport,
                                 approval_date, pnu_parameters, title_record, settings)

CONFIG = {'vworld_key': 'fixture-secret', 'registry_key': '', 'domain': '', 'floor_height': 3.3}


def feature(identifier, x=127, floors=5):
    ring = [[x-.00005, 37-.00005], [x+.00005, 37-.00005],
            [x+.00005, 37+.00005], [x-.00005, 37+.00005], [x-.00005, 37-.00005]]
    return {'id': identifier, 'properties': {'bd_mgt_sn': identifier, 'gro_flo_co': floors},
            'geometry': {'type': 'Polygon', 'coordinates': [ring]}}


class FixtureBuildings(PublicBuildings):
    def __init__(self, features=None, titles=None):
        super().__init__(CONFIG.copy())
        self.rows = features if features is not None else [feature('target'), feature('neighbor', 127.0004)]
        self.records = titles

    def geocode(self, address): return 127, 37, '테스트 주소'
    def features(self, layer, lon, lat, radius=0): return self.rows, True
    def registry(self, polygon):
        return (self.records, '테스트 필지', None) if self.records is not None else ([], None, 'registry_key_missing')


class PublicDataTests(unittest.TestCase):
    def test_dates_and_unavailable_fields_are_not_fabricated(self):
        self.assertEqual(approval_date('20240229'), '2024-02-29')
        for invalid in ('20230229', '2024111', '00000000', None): self.assertIsNone(approval_date(invalid))
        row = title_record({'useAprDay':'20201231', 'totArea':'1,204.5', 'grndFlrCnt':'5'})
        self.assertEqual(row['gfa_m2'], 1204.5)
        self.assertIsNone(row['use'])
        with patch('backend.public_data.dotenv_values', return_value={'DATA_GO_KR_SERVICE_KEY':'a%2Bb%2Fc%3D'}), patch.dict('os.environ', {}, clear=True):
            self.assertEqual(settings()['registry_key'], 'a+b/c=')

    def test_pnu_uses_current_cadastral_parcel(self):
        p = PublicBuildings(CONFIG, request=lambda endpoint, params: {'response': {'status':'OK',
            'result': {'featureCollection': {'features': [{'geometry':feature('old')['geometry'],
                'properties': {'pnu':'1111010100101230004'}}]}}}})
        from shapely.geometry import shape
        current, _ = p.parcel(shape(feature('old')['geometry']))
        self.assertEqual(pnu_parameters(current), {'sigunguCd':'11110', 'bjdongCd':'10100', 'platGbCd':'0', 'bun':'0123', 'ji':'0004'})

    def test_partial_geometry_has_no_solar_data_and_estimates_are_explicit(self):
        r = FixtureBuildings().lookup('테스트', 100)
        self.assertEqual(r['status'], 'ok')
        b = r['site']['building']
        self.assertIsNone(b['approval_date']); self.assertIsNone(b['use'])
        self.assertEqual(b['height_m'], 16.5)
        self.assertEqual(b['height_source'], 'floor_estimate')
        self.assertNotIn('irradiance', r)
        self.assertEqual(r['neighbor_count'], 1)
        self.assertEqual(len(r['site']['faces']), 4)

    def test_zero_floor_never_creates_a_fake_height(self):
        r = FixtureBuildings([feature('target', floors=0)]).lookup('테스트')
        self.assertIsNone(r['site']['building']['height_m'])
        self.assertEqual(r['site']['faces'], [])

    def test_face_ids_stay_on_same_wall_if_upstream_ring_order_changes(self):
        first = feature('target')
        other = json.loads(json.dumps(first))
        ring = other['geometry']['coordinates'][0][:-1]
        ring = list(reversed(ring[2:] + ring[:2]))
        other['geometry']['coordinates'][0] = ring + [ring[0]]
        a = FixtureBuildings([first]).lookup('테스트')['site']
        b = FixtureBuildings([other]).lookup('테스트')['site']
        self.assertEqual(a['site_id'], b['site_id'])
        self.assertEqual(a['faces'], b['faces'])

    def test_radius_and_building_selection(self):
        p = FixtureBuildings([feature('a', 127.0002), feature('b', 127.0003), feature('far',127.01)])
        r = p.lookup('테스트',100)
        self.assertEqual(r['status'], 'select_building')
        self.assertEqual({c['id'] for c in r['candidates']}, {'a','b'})
        r = p.lookup('테스트',100, 'a')
        self.assertEqual(r['neighbor_count'],1)
        with self.assertRaises(LookupFailure): p.lookup('테스트',100,'far')

    def test_multiple_registry_titles_require_explicit_selection(self):
        p = FixtureBuildings(titles=[title_record({'mgmBldrgstPk':'a','bldNm':'A동','heit':'18'}), title_record({'mgmBldrgstPk':'b','bldNm':'B동','heit':'30'})])
        r = p.lookup('테스트')
        self.assertEqual(r['status'], 'select_record')
        r = p.lookup('테스트',200,'target','b')
        self.assertEqual(r['site']['building']['height_m'],30)
        self.assertEqual(r['site']['building']['height_source'],'registry')

    def test_single_item_and_multi_page_registry(self):
        calls=[]
        def request(endpoint, params):
            calls.append(params)
            row={'mgmBldrgstPk':str(params['pageNo']), 'useAprDay':'20200102'}
            return {'response':{'header':{'resultCode':'00'},'body':{'totalCount':2,'items':{'item':row}}}}
        p=PublicBuildings(CONFIG | {'registry_key':'fixture'}, request)
        rows=p.titles('1111010100101230004')
        self.assertEqual([x['id'] for x in rows],['1','2'])
        self.assertEqual(calls[0]['bun'],'0123')

    def test_errors_never_echo_upstream_secret(self):
        with patch('backend.public_data.urlopen',side_effect=URLError('https://bad/?key=fixture-secret')):
            with self.assertRaises(LookupFailure) as e: JsonTransport()('https://api.vworld.kr/req/data',{'key':'fixture-secret'})
        self.assertNotIn('fixture-secret',str(e.exception))
        p=PublicBuildings(CONFIG, request=lambda *a: {'response':{'status':'ERROR','error':{'code':'INVALID_KEY','text':'fixture-secret'}}})
        with self.assertRaises(LookupFailure) as e: p.geocode('테스트')
        self.assertNotIn('fixture-secret',str(e.exception))


if __name__ == '__main__': unittest.main()
