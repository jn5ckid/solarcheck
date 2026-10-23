"""Verified research-coordinate inference. Address inference deliberately fails closed.

The learned absolute XYZ features cannot be translated to a new building-centred
frame. A geographic registration and an independently validated application domain
are prerequisites for a future address adapter, not operator override switches.
"""
import csv
import hashlib
import importlib.util
import json
import os
from functools import lru_cache
from pathlib import Path

import numpy as np
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[1]
CHECKPOINT_SHA256 = '3858A559C3E6DA3DB38DB009FDE3E33218264A03235F424EE76AC87AD32D8604'
NORMALIZATION_SHA256 = 'E6AAEF63A1267D7E57FE6265C4A23726A4702AAB53557842979F1F683088B135'
SOLAR_SHA256 = '87EC3C0DAE5F2992C3934D993B04DCB5745B8F9B53467CB10AE78F1D3B56CECE'
INDEPENDENT = ['x', 'y', 'z', 't', 'sin_altitude', 'cos_altitude', 'sin_azimuth', 'cos_azimuth']
HORIZON = [f'horizon_elev_deg_{d}' for d in ('N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW')]
CONDITIONING = ['nx', 'ny', 'nz', 'dni', 'dhi', *HORIZON, 'sf_soft']
LIMITATIONS = [
    '단일 연구 대상지와 서울 TMYx 기상 자료로 개발한 모델이에요.',
    '검증 결과는 개발 중 반복 사용한 검증 센서의 성능이며 독립 시험 성능이 아니에요.',
    '반사광·비등방 확산·수목·발코니와 블록 모델 밖의 장애물은 정확히 반영하지 못해요.',
]
ADDRESS_BLOCKERS = [
    {'code': 'OUTSIDE_FROZEN_RESEARCH_SITE_BLOCKED',
     'message': '주소 분석은 공공 건물 외곽이 고정 연구 건물과 검증 매칭되는 경우만 허용해요.'},
    {'code': 'APPLICATION_DOMAIN_UNVERIFIED',
     'message': '새 주소의 형상·기상 조건에서 적용 가능 범위를 검증해야 해요. 서울 기상 자료를 다른 지역에 자동 적용하지 않아요.'},
]


class SurrogateUnavailable(Exception):
    pass


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest().upper()


def artifact_paths():
    values = dotenv_values(ROOT / '.env')
    def value(name): return (os.environ.get(name) or values.get(name) or '').strip()
    research = Path(value('SOLARCHECK_RESEARCH_ROOT') or ROOT.parent)
    pipeline = value('SOLARCHECK_PIPELINE_ROOT')
    if not pipeline:
        # Historical provenance provides a location hint only; hashes below are mandatory.
        try:
            manifest = json.loads((research / 'inputs/_staging/training_manifest.json').read_text(encoding='utf-8'))
            pipeline = str(Path(manifest['inputs']['model.py']['path']).parent)
        except (OSError, ValueError, KeyError, TypeError):
            pipeline = ''
    pipeline = Path(pipeline) if pipeline else None
    return {
        'research': research,
        'checkpoint': research / 'analysis_outputs/e2c_e2f_20260810/e2c_train_run/22d_seed42_tilt_diffuse/best_model.pt',
        'normalization': pipeline / 'artifacts/tmyx_hh30_scale/c7_a5_bundles_run01/22d/metadata.json' if pipeline else None,
        'solar': pipeline / 'artifacts/tmyx_hh30_13d/p2/solar_features.csv' if pipeline else None,
    }


def status():
    paths = artifact_paths()
    checks = {}
    for key, expected in [('checkpoint', CHECKPOINT_SHA256), ('normalization', NORMALIZATION_SHA256), ('solar', SOLAR_SHA256)]:
        path = paths[key]
        try:
            checks[key] = 'verified' if path and path.is_file() and sha256(path) == expected else 'missing_or_mismatched'
        except OSError:
            checks[key] = 'unreadable'
    ready = all(v == 'verified' for v in checks.values()) and importlib.util.find_spec('torch') is not None
    return {'model': 'E2c', 'research_inference_ready': ready, 'address_inference_ready': False,
            'same_site_address_matching': True,
            'artifacts': checks, 'runtime_ready': importlib.util.find_spec('torch') is not None,
            'output_unit': 'W/m2', 'annual_unit': 'kWh/m2/year', 'hours': 8760,
            'time_axis': '2021-01-01 00:30 KST + h hours (TMYx reference year)',
            'blockers': ADDRESS_BLOCKERS, 'limitations': LIMITATIONS}


@lru_cache(maxsize=2)
def _load(checkpoint_path, normalization_path, solar_path):
    paths = [Path(p) for p in (checkpoint_path, normalization_path, solar_path)]
    for path, expected in zip(paths, (CHECKPOINT_SHA256, NORMALIZATION_SHA256, SOLAR_SHA256)):
        if sha256(path) != expected:
            raise SurrogateUnavailable('연구 모델 또는 전처리 자료의 해시가 일치하지 않아요.')
    import torch
    from .e2c_model import E2cModel
    checkpoint = torch.load(paths[0], map_location='cpu', weights_only=True)
    if (checkpoint['model_kind'] != 'E2cTiltAwareDiffuseMultiplicative'
        or checkpoint['columns']['independent'] != INDEPENDENT
        or checkpoint['columns']['conditioning'] != CONDITIONING
        or checkpoint['input_scaling']['dni'] != 1000.0 or checkpoint['input_scaling']['dhi'] != 1000.0
        or checkpoint['model_config']['hidden_dims'] != [256, 256, 128, 64]
        or checkpoint['global_step'] != 2275):
        raise SurrogateUnavailable('E2c 입력·체크포인트 계약이 달라요.')
    model = E2cModel().eval()
    model.load_state_dict(checkpoint['model_state_dict'], strict=True)
    normalization = json.loads(paths[1].read_text(encoding='utf-8'))['normalization']['axes']
    with paths[2].open(encoding='utf-8-sig', newline='') as handle:
        solar = list(csv.DictReader(handle))
    if len(solar) != 8760 or [int(r['hour_index']) for r in solar] != list(range(8760)):
        raise SurrogateUnavailable('기상 자료의 시간축이 달라요.')
    return model, normalization, solar


def load():
    paths = artifact_paths()
    if not status()['research_inference_ready']:
        raise SurrogateUnavailable('검증된 E2c 자료 또는 PyTorch가 준비되지 않았어요.')
    return _load(*(str(paths[key]) for key in ('checkpoint', 'normalization', 'solar')))


def soft_visibility(horizons_deg, altitude_deg, azimuth_deg):
    sector = np.mod(azimuth_deg, 360.0) / 45.0
    left = np.floor(sector).astype(np.int64) % 8
    fraction = sector - np.floor(sector)
    interpolated = horizons_deg[:, left] * (1 - fraction) + horizons_deg[:, (left + 1) % 8] * fraction
    logits = (altitude_deg[None, :] - interpolated) / 2.0
    soft = np.exp(-np.logaddexp(0, -logits))
    soft[:, altitude_deg <= 0] = 0
    return soft.astype(np.float32)


def predict_research_sensors(xyz, normals, horizons_deg, *, coordinate_frame):
    """Return (sensor, 8760) W/m² in the ORIGINAL research frame only.

    This internal/offline interface is deliberately not a public raw-input API.
    Never pass building-centred GIS coordinates or invent a z datum here.
    """
    return predict_research_sensors_at_hours(
        xyz, normals, horizons_deg, range(8760), coordinate_frame=coordinate_frame
    )


def predict_research_sensors_at_hours(xyz, normals, horizons_deg, hour_indices, *, coordinate_frame):
    """Return W/m² for requested frozen TMYx hour indices in request order."""
    if coordinate_frame != 'original-research-local':
        raise ValueError('A verified original research coordinate frame is required')
    xyz, normals, horizons_deg = [np.asarray(a, dtype=np.float64) for a in (xyz, normals, horizons_deg)]
    n = len(xyz)
    if not 1 <= n <= 1024 or xyz.shape != (n, 3) or normals.shape != (n, 3) or horizons_deg.shape != (n, 8):
        raise ValueError('Expected 1..1024 XYZ, normal and eight-direction horizon rows')
    if not all(np.isfinite(a).all() for a in (xyz, normals, horizons_deg)):
        raise ValueError('Non-finite sensor input')
    if not np.allclose(np.linalg.norm(normals, axis=1), 1, rtol=0, atol=1e-4):
        raise ValueError('Normals must be unit vectors')
    if (horizons_deg < 0).any() or (horizons_deg > 90).any():
        raise ValueError('Horizon elevations must be in [0, 90] degrees')
    requested = np.asarray(list(hour_indices))
    if requested.ndim != 1 or not 1 <= len(requested) <= 8760:
        raise ValueError('Expected 1..8760 hour indices')
    if not np.issubdtype(requested.dtype, np.integer):
        try:
            integer_requested = requested.astype(np.int64)
        except (TypeError, ValueError, OverflowError) as error:
            raise ValueError('Hour indices must be integers') from error
        if not np.equal(requested, integer_requested).all():
            raise ValueError('Hour indices must be integers')
        requested = integer_requested
    else:
        requested = requested.astype(np.int64, copy=False)
    if (requested < 0).any() or (requested >= 8760).any() or len(np.unique(requested)) != len(requested):
        raise ValueError('Hour indices must be unique values in [0, 8759]')
    model, axes, solar = load()
    normalized = np.column_stack([(xyz[:, i] - axes[k]['min']) / axes[k]['scale']
                                  for i, k in enumerate(('Px', 'Py', 'Pz'))]).astype(np.float32)
    if (normalized < 0).any() or (normalized > 1).any():
        raise ValueError('Sensor is outside the frozen train XYZ range; extrapolation is blocked')
    import torch
    full_day = np.array([r['is_daytime'].lower() == 'true' for r in solar])
    if int(full_day.sum()) != 4434:
        raise SurrogateUnavailable('기상 자료의 주간 시간수가 달라요.')
    daytime_positions = np.flatnonzero(full_day[requested])
    hours = requested[daytime_positions]
    result = np.zeros((n, len(requested)), dtype=np.float32)
    if not len(hours):
        return result
    angles = np.array([[float(solar[h][k]) for k in INDEPENDENT[4:]] for h in hours], dtype=np.float32)
    weather = np.array([[float(solar[h][k]) for k in ('dni', 'dhi')] for h in hours], dtype=np.float32)
    altitude = np.array([float(solar[h]['solar_altitude_deg']) for h in hours])
    azimuth = np.array([float(solar[h]['solar_azimuth_deg']) for h in hours])
    # Batch sensor-hour pairs so dense same-site grids do not require one model call per sensor.
    # 32,768 rows keeps intermediate activations bounded while preserving the original float32 contract.
    with torch.inference_mode():
        visible = soft_visibility(horizons_deg, altitude, azimuth)
        hour_fraction = (hours / 8759).astype(np.float32)
        flat = np.empty(n * len(hours), dtype=np.float32)
        for start in range(0, len(flat), 32768):
            stop = min(start + 32768, len(flat))
            pair = np.arange(start, stop, dtype=np.int64)
            sensor_index, hour_position = np.divmod(pair, len(hours))
            independent = np.column_stack([
                normalized[sensor_index], hour_fraction[hour_position], angles[hour_position],
            ]).astype(np.float32)
            raw = np.column_stack([
                normals[sensor_index].astype(np.float32), weather[hour_position],
                (horizons_deg[sensor_index] / 90).astype(np.float32),
                visible[sensor_index, hour_position],
            ]).astype(np.float32)
            raw[:, 3:5] /= 1000.0
            flat[start:stop] = model(
                torch.from_numpy(independent), torch.from_numpy(raw)
            ).numpy().ravel()
        result[:, daytime_positions] = flat.reshape(n, len(hours))
    if not np.isfinite(result).all() or (result < 0).any():
        raise SurrogateUnavailable('모델이 유효하지 않은 일사량을 반환했어요.')
    return result


def facade_sensors(face):
    """Building-centred cell centres, bottom row first; NOT yet model coordinates."""
    a, b = np.asarray(face['p0'], float), np.asarray(face['p1'], float)
    delta = b - a
    width = np.linalg.norm(delta)
    ns, nt, height = face['ns'], face['nt'], face['height_m']
    if width <= 0 or height <= 0 or ns < 1 or nt < 1:
        raise ValueError('Invalid facade geometry')
    tangent = delta / width
    normal = np.array([tangent[1], -tangent[0], 0.0])
    ss, zz = np.meshgrid((np.arange(ns) + .5) * width / ns, (np.arange(nt) + .5) * height / nt)
    xy = a + ss.ravel()[:, None] * tangent + .1 * normal[:2]
    return np.column_stack([xy, zz.ravel()]), normal


def aggregate_cells(hourly_cells):
    """Unrounded measured-time output; never synthesize a shape from annual totals."""
    hourly = np.asarray(hourly_cells, dtype=np.float64)
    if hourly.ndim != 2 or hourly.shape[1] != 8760 or not len(hourly) or not np.isfinite(hourly).all() or (hourly < 0).any():
        raise ValueError('Expected nonnegative finite (cells, 8760) W/m2')
    return {'annual': (hourly.sum(axis=1) / 1000).tolist(),
            'hourly': hourly.mean(axis=0).tolist(), 'hourly_cells': hourly.tolist()}
