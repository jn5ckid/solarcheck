"""사전 계산: prep/sites/<id>.json (+ EPW) → docs/data/sites/<id>/{site,irradiance}.json

일사 모델은 해석식이다: 직달 × 입사각 × 태양 가시도(지평선 시그모이드)
+ 등방 확산 × 천공 계수 + 지면 반사. 가상 예제용 해석식이며 E2c 추론이 아니다.
E2c 연결에는 함수 교체 외에 연구 XYZ 지리 정합, 고정 정규화, 원래 HH:30
기상 시간축과 8방위/2도 soft-SF 계약이 필요하다. SURROGATE_INTEGRATION.md 참고.

사용: python prep/build_site.py prep/sites/demo_seoul.json [--epw 파일.epw]
"""
import argparse
import json
import math
from pathlib import Path

import numpy as np
from shapely.geometry import Point, Polygon
from shapely.geometry.polygon import orient

ROOT = Path(__file__).resolve().parents[1]
N_DIR = 72            # 지평선 방위 수 (5° 간격). 대리모델 입력은 8방위로 별도 추출
CELL = 1.5            # 센서 격자 목표 간격 (m)
MIN_EDGE = 2.0        # 이보다 짧은 외곽 변은 입면에서 제외 (m)
OFFSET = 0.1          # 센서를 면에서 띄우는 거리 (m)
ALBEDO = 0.2          # 지면 반사율 가정
SIG_K = math.radians(0.5)   # 태양 가시도 시그모이드 폭
DIR_AZ = np.arange(N_DIR) * 2 * math.pi / N_DIR   # 북 = 0, 시계방향
DIRS = np.c_[np.sin(DIR_AZ), np.cos(DIR_AZ)]


def sun_position(lat, lon, tz):
    """8,760시간(평년, 지방표준시 각 시각의 중앙) 태양 고도·방위 (rad, 방위는 북 = 0 시계방향)."""
    h = np.arange(8760)
    b = 2 * np.pi * (h // 24) / 365
    decl = (0.006918 - 0.399912 * np.cos(b) + 0.070257 * np.sin(b) - 0.006758 * np.cos(2 * b)
            + 0.000907 * np.sin(2 * b) - 0.002697 * np.cos(3 * b) + 0.00148 * np.sin(3 * b))
    eot = 229.18 * (0.000075 + 0.001868 * np.cos(b) - 0.032077 * np.sin(b)
                    - 0.014615 * np.cos(2 * b) - 0.04089 * np.sin(2 * b))
    solar_t = (h % 24) + 0.5 + (4 * (lon - 15 * tz) + eot) / 60
    w = np.radians(15 * (solar_t - 12))
    phi = math.radians(lat)
    alt = np.arcsin(np.sin(phi) * np.sin(decl) + np.cos(phi) * np.cos(decl) * np.cos(w))
    az = np.arctan2(np.sin(w), np.cos(w) * np.sin(phi) - np.tan(decl) * np.cos(phi)) + np.pi
    return alt, az


def load_weather(epw, alt):
    """(dni, dhi, ghi) W/m², 출처 문자열."""
    if epw:
        rows = [r.split(',') for r in Path(epw).read_text(encoding='latin-1').splitlines()[8:8768]]
        ghi, dni, dhi = (np.array([float(r[i]) for r in rows]) for i in (13, 14, 15))
        return dni, dhi, ghi, f'EPW: {Path(epw).name}'
    # shortcut: EPW가 없을 때만 쓰는 청천(Meinel) 근사. 연간 일사를 과대평가하므로 EPW 확보 즉시 교체
    up = alt > 0
    am = np.where(up, 1 / np.maximum(np.sin(alt), 0.05), 0)
    dni = np.where(up, 1353 * 0.7 ** (am ** 0.678), 0)
    dhi = 0.1 * dni
    ghi = dni * np.maximum(np.sin(alt), 0) + dhi
    return dni, dhi, ghi, '청천 근사 (EPW 미적용, 과대평가)'


def edges(blocks):
    """[(Polygon, 높이)] → (E, 5) 배열: ax, ay, bx, by, H."""
    segs = []
    for poly, height in blocks:
        c = np.asarray(poly.exterior.coords)
        segs += [(*a, *b, height) for a, b in zip(c[:-1], c[1:])]
    return np.array(segs)


def horizon(pts, segs):
    """센서별·방위별 지평선 고도 (S, N_DIR) rad. 블록 윤곽 변과 2D 광선 교차로 정확히 계산."""
    ax, ay, bx, by, hb = segs.T
    ex, ey = bx - ax, by - ay
    dx, dy = DIRS[None, :, 0, None], DIRS[None, :, 1, None]
    den = dx * ey - dy * ex
    out = np.zeros((len(pts), N_DIR))
    for i in range(0, len(pts), 64):
        p = pts[i:i + 64]
        px, py, pz = (p[:, k, None, None] for k in range(3))
        wx, wy = ax - px, ay - py
        with np.errstate(divide='ignore', invalid='ignore'):
            t = (wx * ey - wy * ex) / den
            u = (wx * dy - wy * dx) / den
        hit = (np.abs(den) > 1e-12) & (t > 1e-6) & (u >= 0) & (u <= 1)
        el = np.where(hit, np.arctan2(hb - pz, np.where(hit, t, 1.0)), 0.0)
        out[i:i + 64] = np.maximum(el.max(axis=2), 0)
    return out


def sky_factor(hor, normal):
    """가려지지 않은 하늘에서 받는 등방 확산의 비율. 수평 무차폐 = 1, 연직 무차폐 = 0.5."""
    d_el = math.radians(2)
    el = np.arange(1, 90, 2) * math.pi / 180
    v = np.stack([np.cos(el)[None] * np.sin(DIR_AZ)[:, None],
                  np.cos(el)[None] * np.cos(DIR_AZ)[:, None],
                  np.broadcast_to(np.sin(el)[None], (N_DIR, len(el)))], -1)   # (D, E, 3)
    cosinc = np.clip(v @ normal, 0, None)                                      # (D, E)
    vis = el[None, None] > hor[:, :, None]                                     # (S, D, E)
    return (vis * (cosinc * np.cos(el)[None])[None]).sum((1, 2)) * d_el * (2 * math.pi / N_DIR) / math.pi


def face_irradiance(pts, normal, segs, sun, wx):
    """센서별 연간 일사 (kWh/m²)와 면 평균 시간 일사 (W/m², 8,760)."""
    alt, az = sun
    dni, dhi, ghi = wx
    hor = horizon(pts, segs)
    f_sky = sky_factor(hor, normal)
    day = np.flatnonzero(alt > 0)
    a, z = alt[day], az[day]
    s = np.stack([np.cos(a) * np.sin(z), np.cos(a) * np.cos(z), np.sin(a)], -1)
    cosinc = np.clip(s @ normal, 0, None)
    j = z / (2 * np.pi) * N_DIR
    i0 = np.floor(j).astype(int) % N_DIR
    w = j - np.floor(j)
    h_sun = hor[:, i0] * (1 - w) + hor[:, (i0 + 1) % N_DIR] * w                # (S, day)
    vis = 1 / (1 + np.exp(-(a[None] - h_sun) / SIG_K))
    g = (dni[day] * cosinc)[None] * vis + f_sky[:, None] * dhi[day][None]
    g += ALBEDO * ghi[day][None] * (1 - normal[2]) / 2
    hourly = np.zeros(8760)
    hourly[day] = g.mean(0)
    return g.sum(1) / 1000, hourly


def facades(poly, height):
    out = []
    c = np.asarray(poly.exterior.coords)
    for a, b in zip(c[:-1], c[1:]):
        d = b - a
        width = float(np.hypot(*d))
        if width < MIN_EDGE:
            continue
        u = d / width
        n = np.array([u[1], -u[0]])                       # 반시계 윤곽의 바깥 법선
        ns, nt = max(1, round(width / CELL)), max(1, round(height / CELL))
        s = (np.arange(ns) + 0.5) * width / ns
        t = (np.arange(nt) + 0.5) * height / nt
        tt, ss = np.meshgrid(t, s, indexing='ij')          # t 행 우선 (아래층부터)
        xy = a + ss.ravel()[:, None] * u + OFFSET * n
        pts = np.c_[xy, tt.ravel()]
        out.append(dict(face_id=f'F{len(out) + 1:02d}', type='facade',
                        azimuth_deg=round(math.degrees(math.atan2(n[0], n[1])) % 360, 1),
                        p0=a.round(2).tolist(), p1=b.round(2).tolist(),
                        width_m=round(width, 2), height_m=height, ns=ns, nt=nt,
                        cell_area_m2=round(width * height / (ns * nt), 3),
                        _pts=pts, _normal=np.array([n[0], n[1], 0.0])))
    return out


def roof(poly, height, setback):
    inner = poly.buffer(-setback)
    if inner.is_empty:
        return None
    x0, y0, x1, y1 = inner.bounds
    gx, gy = np.meshgrid(np.arange(x0 + CELL / 2, x1, CELL), np.arange(y0 + CELL / 2, y1, CELL))
    xy = [(x, y) for x, y in zip(gx.ravel(), gy.ravel()) if inner.contains(Point(x, y))]
    if not xy:
        return None
    xy = np.array(xy)
    return dict(face_id='R0', type='roof', area_m2=round(inner.area, 2),
                cell_area_m2=round(inner.area / len(xy), 3), points=xy.round(2).tolist(),
                outline=np.asarray(inner.exterior.coords).round(2).tolist(),
                _pts=np.c_[xy, np.full(len(xy), height + OFFSET)], _normal=np.array([0.0, 0.0, 1.0]))


def build(cfg, epw=None):
    tgt = orient(Polygon(cfg['target']['footprint']), 1.0)
    h = float(cfg['target']['height_m'])
    ctx = [(orient(Polygon(b['footprint']), 1.0), float(b['height_m'])) for b in cfg['context']]
    segs = edges([(tgt, h)] + ctx)
    sun = sun_position(cfg['lat'], cfg['lon'], cfg.get('tz', 9))
    dni, dhi, ghi, wx_src = load_weather(epw, sun[0])

    faces = facades(tgt, h)
    r = roof(tgt, h, cfg.get('roof_setback_m', 1.0))
    if r:
        faces.append(r)
    irr = {}
    for f in faces:
        annual, hourly = face_irradiance(f.pop('_pts'), f.pop('_normal'), segs, sun, (dni, dhi, ghi))
        irr[f['face_id']] = dict(annual=annual.round(1).tolist(), hourly=hourly.round().astype(int).tolist())

    site = {k: cfg[k] for k in ('site_id', 'name', 'address', 'lat', 'lon')}
    site.update(building={**cfg['building'], 'height_m': h},
                weather=wx_src, model='analytic',
                target=np.asarray(tgt.exterior.coords).round(2).tolist(),
                context=[dict(footprint=np.asarray(p.exterior.coords).round(2).tolist(), height_m=hh)
                         for p, hh in ctx],
                faces=faces)
    return site, {'model': 'analytic', 'weather': wx_src, 'faces': irr}


def self_check():
    """무차폐 수평·연직 천공 계수와 남중 고도로 기하·태양 계산을 확인한다."""
    flat = np.zeros((1, N_DIR))
    assert abs(sky_factor(flat, np.array([0, 0, 1.0]))[0] - 1) < 0.01
    assert abs(sky_factor(flat, np.array([0, -1.0, 0]))[0] - 0.5) < 0.01
    alt, az = sun_position(37.5, 127.5, 9)        # 경도 127.5°에서는 정오 근처가 남중
    noon = alt[172 * 24 + 12]                     # 6월 하지 무렵 12:30
    assert 70 < math.degrees(noon) < 77 and 170 < math.degrees(az[172 * 24 + 12]) < 200
    block = Polygon([(-6, -6), (6, -6), (6, 6), (-6, 6)])
    hz = horizon(np.array([[0, -16, 0.0]]), edges([(block, 10.0)]))
    assert abs(math.degrees(hz[0, 0]) - 45) < 0.5   # 북쪽 10 m 거리, 높이 10 m 벽 → 45°


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('site_input')
    ap.add_argument('--epw')
    args = ap.parse_args()
    self_check()
    cfg = json.loads(Path(args.site_input).read_text(encoding='utf-8'))
    site, irr = build(cfg, args.epw)
    out = ROOT / 'docs/data/sites' / cfg['site_id']
    out.mkdir(parents=True, exist_ok=True)
    (out / 'site.json').write_text(json.dumps(site, ensure_ascii=False), encoding='utf-8')
    (out / 'irradiance.json').write_text(json.dumps(irr), encoding='utf-8')

    index_path = ROOT / 'docs/data/sites/index.json'
    index = json.loads(index_path.read_text(encoding='utf-8')) if index_path.exists() else []
    index = [s for s in index if s['site_id'] != cfg['site_id']]
    index.append({k: cfg[k] for k in ('site_id', 'name', 'address')})
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding='utf-8')

    for f in site['faces']:
        a = np.array(irr['faces'][f['face_id']]['annual'])
        print(f"{f['face_id']} {f['type']:7s} 방위 {f.get('azimuth_deg', '-'):>6}  "
              f"센서 {len(a):4d}  연간 일사 평균 {a.mean():7.1f}  최소 {a.min():7.1f}  최대 {a.max():7.1f} kWh/m²")
    print('weather:', irr['weather'], '→', out)
