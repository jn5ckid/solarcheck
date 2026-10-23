"""VWorld address/building/cadastral data + Building HUB title records.

Only official HTTPS endpoints are used. Credentials and upstream URLs containing
credentials must never be included in errors, logs, or API responses.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import re
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, unquote
from urllib.request import Request, urlopen

from dotenv import dotenv_values
from pyproj import CRS, Transformer
from shapely.geometry import Point, Polygon, shape
from shapely.geometry.polygon import orient
from shapely.ops import transform

ROOT = Path(__file__).resolve().parents[1]
VWORLD = 'https://api.vworld.kr'
HUB = 'https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo'
SOURCES = {
    'address': '브이월드 주소 좌표 변환',
    'geometry': '브이월드 도로명주소 건물(LT_C_SPBD)',
    'parcel': '브이월드 연속지적도(LP_PA_CBND_BUBUN)',
    'registry': '국토교통부 건축HUB 건축물대장 표제부',
}


class LookupFailure(Exception):
    def __init__(self, code, message, status=502):
        self.code, self.message, self.status = code, message, status
        super().__init__(message)


def settings():
    values = dotenv_values(ROOT / '.env')
    def value(name, default=''):
        return (os.environ.get(name) or values.get(name) or default).strip()
    try:
        floor_height = float(value('SOLARCHECK_FLOOR_HEIGHT_M', '3.3'))
        if not 2 <= floor_height <= 6: raise ValueError()
    except ValueError:
        floor_height = 3.3
    return {
        'vworld_key': value('VWORLD_API_KEY'), 'domain': value('VWORLD_DOMAIN'),
        'registry_key': unquote(value('DATA_GO_KR_SERVICE_KEY')),
        'floor_height': floor_height,
        'origins': value('SOLARCHECK_ALLOWED_ORIGINS', 'http://127.0.0.1:5500,http://localhost:5500,https://jn5ckid.github.io'),
    }


def number(value, integer=False):
    try:
        n = float(str(value).replace(',', ''))
        if not math.isfinite(n) or n < 0: return None
        return int(n) if integer and n.is_integer() else (None if integer else n)
    except (TypeError, ValueError):
        return None


def approval_date(value):
    if not re.fullmatch(r'\d{8}', str(value)): return None
    try:
        return datetime.strptime(str(value), '%Y%m%d').date().isoformat()
    except (ValueError, TypeError):
        return None


def title_record(row):
    approved = approval_date(row.get('useAprDay'))
    return {
        'id': str(row.get('mgmBldrgstPk', '')), 'name': row.get('bldNm') or None,
        'dong_name': row.get('dongNm') or None, 'address': row.get('newPlatPlc') or row.get('platPlc'),
        'approval_date': approved, 'approval_year': int(approved[:4]) if approved else None,
        'use': row.get('mainPurpsCdNm') or None, 'other_use': row.get('etcPurps') or None,
        'floors': number(row.get('grndFlrCnt'), True), 'basement_floors': number(row.get('ugrndFlrCnt'), True),
        'gfa_m2': number(row.get('totArea')), 'building_area_m2': number(row.get('archArea')),
        'land_area_m2': number(row.get('platArea')), 'height_m': number(row.get('heit')),
        'structure': row.get('strctCdNm') or row.get('etcStrct') or None,
        'registry_date': approval_date(row.get('crtnDay')), 'source': SOURCES['registry'],
    }


def pnu_parameters(pnu):
    if not re.fullmatch(r'\d{19}', str(pnu)) or pnu[10] not in '12':
        raise LookupFailure('INVALID_PNU', '현재 필지의 지번코드를 확인하지 못했어요.')
    return {'sigunguCd': pnu[:5], 'bjdongCd': pnu[5:10],
            'platGbCd': '0' if pnu[10] == '1' else '1', 'bun': pnu[11:15], 'ji': pnu[15:19]}


class JsonTransport:
    """Short, bounded in-memory cache; no API key or address query is written to disk."""
    def __init__(self):
        self.cache = {}; self.lock = threading.Lock()

    def __call__(self, endpoint, params):
        cache_key = hashlib.sha256((endpoint + urlencode(params)).encode()).hexdigest()
        with self.lock:
            cached = self.cache.get(cache_key)
            if cached and cached[0] > time.monotonic(): return cached[1]
        try:
            request = Request(endpoint + '?' + urlencode(params), headers={'User-Agent': 'SolarCheck/0.1'})
            with urlopen(request, timeout=15) as response:
                raw = response.read(12 * 1024 * 1024 + 1)
            if len(raw) > 12 * 1024 * 1024:
                raise LookupFailure('UPSTREAM_SIZE', '공공 API 응답이 너무 커서 처리하지 못했어요.')
            data = json.loads(raw)
        except LookupFailure:
            raise
        except HTTPError as error:
            raise LookupFailure('UPSTREAM_HTTP', f'공공 API가 요청을 처리하지 못했어요(HTTP {error.code}). 키의 활용 승인 상태를 확인해 주세요.') from None
        except (URLError, TimeoutError, OSError):
            raise LookupFailure('UPSTREAM_NETWORK', '공공 API 연결 시간이 초과됐거나 연결할 수 없어요. 잠시 후 다시 시도해 주세요.') from None
        except (ValueError, UnicodeError):
            # data.go.kr may return XML for authentication failures even with _type=json.
            raise LookupFailure('UPSTREAM_FORMAT', '공공 API 응답을 읽지 못했어요. 인증키와 해당 서비스 활용 승인을 확인해 주세요.') from None
        with self.lock:
            if len(self.cache) >= 128: self.cache.pop(next(iter(self.cache)))
            self.cache[cache_key] = (time.monotonic() + 300, data)
        return data


transport = JsonTransport()


class PublicBuildings:
    def __init__(self, config=None, request=None):
        self.config = config or settings(); self.request = request or transport

    def vworld(self, path, **params):
        if not self.config['vworld_key']:
            raise LookupFailure('VWORLD_KEY_REQUIRED', '연구실 PC의 .env 파일에 VWORLD_API_KEY를 설정해 주세요.', 503)
        params.update(key=self.config['vworld_key'], version='2.0', format='json', errorFormat='json')
        if self.config['domain']: params['domain'] = self.config['domain']
        data = self.request(VWORLD + path, params).get('response', {})
        status = data.get('status')
        if status == 'NOT_FOUND': return None
        if status != 'OK':
            code = data.get('error', {}).get('code', 'UNKNOWN_ERROR')
            messages = {
                'INCORRECT_KEY': '브이월드 키에 등록된 URL과 VWORLD_DOMAIN 설정을 확인해 주세요.',
                'INVALID_KEY': '브이월드 인증키가 유효하지 않아요.',
                'OVER_REQUEST_LIMIT': '브이월드 일일 요청 한도를 초과했어요.',
            }
            raise LookupFailure('VWORLD_' + re.sub(r'[^A-Z_]', '', str(code))[:50], messages.get(code, '브이월드 요청에 실패했어요. 키의 허용 API와 활용 상태를 확인해 주세요.'))
        return data

    def geocode(self, address):
        for kind in ('ROAD', 'PARCEL'):
            data = self.vworld('/req/address', service='address', request='GetCoord', address=address,
                               type=kind, crs='EPSG:4326', refine='true', simple='false')
            if data:
                try:
                    point = data['result']['point']; lon, lat = float(point['x']), float(point['y'])
                    if not 124 <= lon <= 132 or not 32 <= lat <= 40: raise ValueError()
                except (KeyError, ValueError, TypeError):
                    raise LookupFailure('ADDRESS_COORDINATES', '주소의 국내 좌표를 확인하지 못했어요.') from None
                return lon, lat, data.get('refined', {}).get('text') or address
        raise LookupFailure('ADDRESS_NOT_FOUND', '주소를 찾지 못했어요. 시·군·구와 건물번호까지 입력해 주세요.', 404)

    def features(self, layer, lon, lat, radius=0):
        output = []; total = 0
        for page in range(1, 6):
            data = self.vworld('/req/data', service='data', request='GetFeature', data=layer,
                               geomFilter=f'POINT({lon:.9f} {lat:.9f})', buffer=radius, crs='EPSG:4326',
                               size=1000, page=page, geometry='true', attribute='true')
            if not data: break
            try:
                chunk = data['result']['featureCollection']['features']
                total = int(data.get('record', {}).get('total', len(chunk)))
                pages = int(data.get('page', {}).get('total', 1))
                if not isinstance(chunk, list): raise ValueError()
            except (ValueError, KeyError, TypeError):
                raise LookupFailure('GEOMETRY_FORMAT', '공공 건물 형상 응답을 읽지 못했어요.') from None
            output.extend(chunk)
            if page >= pages: break
        return output, len(output) >= total

    def parcel(self, polygon):
        # bd_mgt_sn's first 19 digits reflect the PNU when created, NOT necessarily today's parcel.
        point = polygon.representative_point()
        # A zero-width point query can return NOT_FOUND; use 1m then test exact containment.
        features, _ = self.features('LP_PA_CBND_BUBUN', point.x, point.y, 1)
        matches = []
        for feature in features:
            try:
                if shape(feature['geometry']).covers(point): matches.append(feature['properties'])
            except (ValueError, KeyError, TypeError): pass
        if len(matches) != 1:
            raise LookupFailure('PARCEL_UNRESOLVED', '건물이 놓인 현재 필지를 한 곳으로 확정하지 못했어요.')
        pnu = str(matches[0].get('pnu', '')); pnu_parameters(pnu)
        return pnu, matches[0].get('addr')

    def titles(self, pnu):
        if not self.config['registry_key']: return []
        output = []
        for page in range(1, 6):
            data = self.request(HUB, dict(pnu_parameters(pnu), serviceKey=self.config['registry_key'],
                                         _type='json', numOfRows=100, pageNo=page)).get('response', {})
            if str(data.get('header', {}).get('resultCode', '')) not in ('00', '0', '000'):
                raise LookupFailure('REGISTRY_AUTH_OR_SERVICE', '건축HUB 조회에 실패했어요. 서비스별 활용 승인과 인증키를 확인해 주세요.')
            body = data.get('body', {}); items = body.get('items') or {}
            rows = items.get('item', []) if isinstance(items, dict) else []
            if isinstance(rows, dict): rows = [rows]
            output.extend(title_record(row) for row in rows)
            if len(output) >= int(body.get('totalCount', 0)): return output
        raise LookupFailure('REGISTRY_TRUNCATED', '해당 필지의 건축물대장이 너무 많아 대상 동을 확정하지 못했어요.')

    def registry(self, polygon):
        if not self.config['registry_key']: return [], None, 'registry_key_missing'
        try:
            pnu, parcel_address = self.parcel(polygon)
            return self.titles(pnu), parcel_address, None
        except LookupFailure as error:
            return [], None, error.code

    def lookup(self, address, radius=200, building_id=None, record_id=None):
        lon, lat, refined = self.geocode(address)
        local_crs = CRS.from_proj4(f'+proj=aeqd +lat_0={lat} +lon_0={lon} +datum=WGS84 +units=m')
        forward = Transformer.from_crs(4326, local_crs, always_xy=True).transform
        features, complete = self.features('LT_C_SPBD', lon, lat, radius)
        origin = Point(0, 0); buildings = []
        for feature in features:
            try:
                geo = shape(feature['geometry'])
                if geo.geom_type == 'MultiPolygon':
                    geo = max(geo.geoms, key=lambda p: p.area)
                if geo.geom_type != 'Polygon' or geo.is_empty or not geo.is_valid: continue
                # Stable corner order keeps face IDs attached to the same walls on reload.
                geo = orient(geo.normalize(), 1)
                local = orient(transform(forward, geo), 1)
                if local.distance(origin) > radius: continue
                props = feature.get('properties', {})
                identifier = str(props.get('bd_mgt_sn') or feature.get('id') or '')
                if not identifier or any(b['id'] == identifier for b in buildings): continue
                buildings.append({'id': identifier, 'geo': geo, 'local': local, 'props': props,
                    'distance_m': round(local.distance(origin), 1),
                    'name': props.get('buld_nm') or props.get('buld_nm_dc') or '이름 미제공 건물',
                    'floors': number(props.get('gro_flo_co'), True) or None})
            except (TypeError, ValueError, KeyError): continue
        buildings.sort(key=lambda b: (b['distance_m'], b['id']))
        if not buildings:
            raise LookupFailure('BUILDING_NOT_FOUND', '주소 주변에서 건물 형상을 찾지 못했어요. 주소나 조회 반경을 확인해 주세요.', 404)
        def candidate(b):
            p = b['props']
            return {k: b[k] for k in ('id', 'name', 'floors', 'distance_m')} | {'dong_name': p.get('buld_nm_dc'),
                'address': ' '.join(str(p.get(k) or '') for k in ('sido', 'sigungu', 'gu', 'rd_nm', 'buld_no')).strip()}
        if building_id:
            chosen = next((b for b in buildings if b['id'] == building_id), None)
            if not chosen: raise LookupFailure('BUILDING_SELECTION', '선택한 건물이 이번 조회 범위에 없어요.', 409)
        else:
            inside = [b for b in buildings if b['local'].covers(origin)]
            if len(inside) == 1: chosen = inside[0]
            else:
                candidates = inside or [b for b in buildings if b['distance_m'] <= 30][:20]
                if not candidates:
                    raise LookupFailure('BUILDING_SELECTION', '주소 좌표가 건물 안에 있지 않아요. 더 정확한 주소를 입력해 주세요.', 404)
                return {'status': 'select_building', 'address': refined, 'candidates': [candidate(b) for b in candidates],
                        'message': '주소 좌표가 여러 동 또는 건물 바깥에 있어요. 대상 건물을 선택해 주세요.'}
        titles, parcel_address, registry_issue = self.registry(chosen['geo'])
        if record_id:
            selected_record = next((t for t in titles if t['id'] == record_id), None)
            if not selected_record: raise LookupFailure('RECORD_SELECTION', '선택한 표제부를 확인하지 못했어요. 다시 조회해 주세요.', 409)
        elif len(titles) > 1:
            return {'status': 'select_record', 'address': refined, 'building_id': chosen['id'], 'candidates': titles,
                    'message': '같은 필지에 여러 건축물대장이 있어요. 선택한 건물의 동명칭과 규모를 확인해 주세요.'}
        else:
            selected_record = titles[0] if titles else {}
        properties = chosen['props']
        info = dict(selected_record)
        info.setdefault('name', chosen['name']); info.setdefault('dong_name', properties.get('buld_nm_dc'))
        info['floors'] = info.get('floors') or chosen['floors']
        height, height_source = info.get('height_m'), 'registry'
        if not height:
            height = info['floors'] * self.config['floor_height'] if info['floors'] else None
            height_source = 'floor_estimate' if height else 'unavailable'
        info.update(height_m=height, height_source=height_source, floor_height_assumption_m=self.config['floor_height'])
        for field in ('approval_date', 'approval_year', 'use', 'other_use', 'basement_floors', 'gfa_m2',
                      'building_area_m2', 'land_area_m2', 'structure'):
            info.setdefault(field, None)
        info['field_sources'] = {field: SOURCES['registry'] if selected_record.get(field) is not None else None
            for field in ('approval_date', 'use', 'gfa_m2', 'building_area_m2', 'basement_floors', 'land_area_m2')}
        info['field_sources']['floors'] = SOURCES['registry'] if selected_record.get('floors') else SOURCES['geometry']
        centroid = chosen['local'].centroid
        center = (centroid.x, centroid.y)
        def ring(poly):
            return [[round(x - center[0], 3), round(y - center[1], 3)] for x, y in poly.exterior.coords]
        context = []; neighbors = []
        # The query radius is centered on the geocoded address, consistently with GetFeature.
        nearby = [b for b in buildings if b['id'] != chosen['id']]
        nearby.sort(key=lambda b: b['local'].distance(chosen['local']))
        # Metadata enrichment is bounded to ten nearest neighbors to avoid an API request explosion.
        def enrich(b):
            records, addr, issue = self.registry(b['geo'])
            record = records[0] if len(records) == 1 else {}
            return record, addr, issue or ('multiple_records' if len(records) > 1 else None)
        enriched = {}
        if self.config['registry_key']:
            with ThreadPoolExecutor(max_workers=3) as pool:
                values = list(pool.map(enrich, nearby[:10]))
            enriched = dict(zip([b['id'] for b in nearby[:10]], values))
        for b in nearby:
            record, addr, issue = enriched.get(b['id'], ({}, None, 'not_requested'))
            floors = record.get('floors') or b['floors']
            nh = record.get('height_m') or (floors * self.config['floor_height'] if floors else None)
            delta = b['local'].centroid
            bearing = math.degrees(math.atan2(delta.x - center[0], delta.y - center[1])) % 360
            n = candidate(b) | {'distance_m': round(b['local'].distance(chosen['local']), 1),
                'bearing_deg': round(bearing, 1), 'floors': floors, 'height_m': nh,
                'height_source': 'registry' if record.get('height_m') else ('floor_estimate' if nh else 'unavailable'),
                'use': record.get('use'), 'approval_date': record.get('approval_date'), 'gfa_m2': record.get('gfa_m2'),
                'registry_status': issue or ('found' if record else 'not_found')}
            neighbors.append(n)
            if nh: context.append({'id': b['id'], 'footprint': ring(b['local']), 'height_m': nh, 'height_source': n['height_source']})
        target = ring(chosen['local'])
        site_id = 'vw_' + hashlib.sha256((chosen['id'] + chosen['geo'].normalize().wkb_hex).encode()).hexdigest()[:20]
        faces = []
        if height:
            for i, (a, b) in enumerate(zip(target[:-1], target[1:])):
                dx, dy = b[0] - a[0], b[1] - a[1]; width = math.hypot(dx, dy)
                if width < .8: continue
                ns, nt = max(1, round(width / 1.5)), max(1, round(height / 1.5))
                faces.append({'face_id': f'F{i + 1:02d}', 'type': 'facade', 'azimuth_deg': round(math.degrees(math.atan2(dy, -dx)) % 360, 1),
                    'p0': a, 'p1': b, 'width_m': round(width, 3), 'height_m': height,
                    'ns': ns, 'nt': nt, 'cell_area_m2': width * height / (ns * nt)})
        warnings = ['건물 형상은 지붕 모양·발코니·수목을 반영하지 않은 블록 모델이에요.',
                    '실제 건물의 일사량·발전량 분석은 아직 실행하지 않았어요.']
        if registry_issue == 'registry_key_missing': warnings.append('건축HUB 인증키가 없어 사용승인일·용도·면적 조회가 아직 연결되지 않았어요.')
        elif registry_issue: warnings.append(f'건축물대장 조회를 완료하지 못했어요({registry_issue}). 확인되지 않은 값은 비워뒀어요.')
        elif not titles: warnings.append('해당 필지에서 건축물대장 표제부를 찾지 못했어요.')
        if height_source == 'floor_estimate': warnings.append(f'대상 높이는 지상층수 × {self.config["floor_height"]}m로 추정했어요.')
        if not height: warnings.append('대상 건물의 높이와 지상층수가 없어 3D 입면 생성과 사진 정합을 보류했어요. 건축물대장 확인이 필요해요.')
        if not complete: warnings.append('건물 조회가 최대 페이지 수에 도달해 주변 건물이 일부 누락될 수 있어요.')
        if len(context) < len(neighbors): warnings.append('높이·층수가 모두 없는 주변 건물은 목록에 표시하고 3D 모델에서 제외했어요.')
        if self.config['registry_key'] and len(nearby) > 10: warnings.append('주변 건축물대장 상세 정보는 가까운 10동까지 조회했어요. 나머지는 건물 형상·층수 정보만 표시해요.')
        if chosen['geo'].interiors: warnings.append('중정이 있는 건물의 내부 벽면은 사진 정합 대상에서 제외했어요.')
        return {'status': 'ok', 'site': {'site_id': site_id, 'name': info.get('name') or chosen['name'],
                    'address': info.get('address') or parcel_address or refined, 'lat': lat, 'lon': lon,
                    'building': info, 'target': target, 'faces': faces, 'context': context, 'source': 'public_api',
                    'geometry_frame': {'crs': local_crs.to_string(), 'origin_in_crs_m': list(center),
                                       'units': 'm', 'axes': 'east,north,up',
                                       'z_reference': 'flat_ground_assumption_not_georeferenced'}},
                'neighbors': neighbors, 'radius_m': radius, 'neighbor_count': len(neighbors),
                'radius_center': 'address_coordinate',
                'modeled_neighbor_count': len(context), 'neighbors_complete': complete,
                'sources': SOURCES, 'warnings': warnings,
                'retrieved_at': datetime.now().astimezone().isoformat(timespec='seconds')}
