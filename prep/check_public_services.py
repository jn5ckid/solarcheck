"""Live credential check, with no keys, request URLs or upstream bodies printed."""
import json
from shapely.geometry import Point
from backend.public_data import PublicBuildings, LookupFailure


def main():
    client = PublicBuildings()
    result = {'vworld_configured': bool(client.config['vworld_key']),
              'registry_configured': bool(client.config['registry_key'])}
    try:
        lon, lat, _ = client.geocode('서울특별시 중구 세종대로 110')
        result['vworld_auth'] = 'ok'
        pnu, _ = client.parcel(Point(lon, lat))
        result['current_parcel'] = 'resolved'
    except LookupFailure as error:
        result['lookup_error_code'] = error.code
        pnu = None
    if client.config['registry_key']:
        # A successful header authenticates the service even if this probe parcel has no titles.
        try:
            records = client.titles(pnu or '1114010300100310000')
            result['registry_auth'] = 'ok'
            result['title_count'] = len(records)
        except LookupFailure as error:
            result['registry_error_code'] = error.code
    print(json.dumps(result, ensure_ascii=True))


if __name__ == '__main__':
    main()
