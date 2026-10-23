"""GIS 건물 윤곽 파일 → build_site.py 입력 JSON

사용 예:
  python prep/gis_to_site.py raw/buildings.gpkg --lon 128.53 --lat 35.84 --site-id A_daegu \
      --height-col HEIGHT --floors-col GRND_FLR --use 제1종근린생활시설 --tariff 일반용 \
      --approval-year 1998 --gfa 6801.9 --name "A동 (대구 달서구)" --address "도로명 주소"

높이 열 값이 없거나 0이면 층수 × --floor-height 로 보정한다.
열 이름은 받은 파일에서 확인해 지정한다 (예: print(gpd.read_file(f).columns)).
"""
import argparse
import json
from pathlib import Path

import geopandas as gpd
from shapely.geometry import MultiPolygon, Point


def largest(geom):
    return max(geom.geoms, key=lambda g: g.area) if isinstance(geom, MultiPolygon) else geom


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('--lon', type=float, required=True)
    ap.add_argument('--lat', type=float, required=True)
    ap.add_argument('--site-id', required=True)
    ap.add_argument('--name', default='')
    ap.add_argument('--address', default='')
    ap.add_argument('--radius', type=float, default=200)
    ap.add_argument('--crs', default='EPSG:5186', help='미터 단위 투영 좌표계')
    ap.add_argument('--height-col')
    ap.add_argument('--floors-col')
    ap.add_argument('--floor-height', type=float, default=3.3)
    ap.add_argument('--use', default='근린생활시설')
    ap.add_argument('--tariff', default='일반용')
    ap.add_argument('--approval-year', type=int)
    ap.add_argument('--gfa', type=float)
    ap.add_argument('--floors', type=int)
    ap.add_argument('--out', default=None)
    a = ap.parse_args()

    gdf = gpd.read_file(a.src).to_crs(a.crs)
    origin_pt = gpd.GeoSeries([Point(a.lon, a.lat)], crs='EPSG:4326').to_crs(a.crs).iloc[0]
    hit = gdf[gdf.contains(origin_pt)]
    if hit.empty:
        raise SystemExit('좌표를 포함하는 건물 윤곽이 없습니다. 좌표나 좌표계를 확인하세요.')
    tgt_idx = hit.index[0]
    near = gdf[gdf.distance(gdf.loc[tgt_idx].geometry.centroid) <= a.radius]

    def height(row):
        h = float(row[a.height_col]) if a.height_col and row.get(a.height_col) not in (None, '') else 0.0
        if h > 0:
            return h
        fl = float(row[a.floors_col]) if a.floors_col and row.get(a.floors_col) not in (None, '') else 0.0
        return fl * a.floor_height

    ox, oy = gdf.loc[tgt_idx].geometry.centroid.coords[0]

    def local(geom):
        return [[round(x - ox, 2), round(y - oy, 2)] for x, y in largest(geom).simplify(0.3).exterior.coords]

    context, skipped = [], 0
    for i, row in near.iterrows():
        if i == tgt_idx:
            continue
        h = height(row)
        if h <= 0:
            skipped += 1
            continue
        context.append({'footprint': local(row.geometry), 'height_m': round(h, 2)})

    tgt_row = gdf.loc[tgt_idx]
    tgt_h = height(tgt_row)
    if tgt_h <= 0:
        raise SystemExit('대상 건물 높이·층수가 없습니다. --height-col / --floors-col 을 확인하세요.')
    floors = a.floors or (int(float(tgt_row[a.floors_col])) if a.floors_col else round(tgt_h / a.floor_height))
    cfg = {
        'site_id': a.site_id, 'name': a.name or a.site_id, 'address': a.address,
        'lat': a.lat, 'lon': a.lon, 'tz': 9,
        'building': {'use': a.use, 'tariff': a.tariff, 'approval_year': a.approval_year,
                     'floors': floors, 'gfa_m2': a.gfa},
        'roof_setback_m': 1.0,
        'target': {'footprint': local(tgt_row.geometry), 'height_m': round(tgt_h, 2)},
        'context': context,
    }
    out = Path(a.out or Path(__file__).parent / 'sites' / f'{a.site_id}.json')
    out.write_text(json.dumps(cfg, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'대상 높이 {tgt_h:.1f} m, 주변 {len(context)}동 (높이 정보 없어 제외 {skipped}동) → {out}')


if __name__ == '__main__':
    main()
