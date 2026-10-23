"""solarcheck connection demo. Run from the project root with Uvicorn."""

from collections import OrderedDict
from datetime import date

import numpy as np

from fastapi import FastAPI, File, Form, UploadFile, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from .public_data import PublicBuildings, LookupFailure, settings
from .surrogate import (SurrogateUnavailable, load as load_surrogate,
                        predict_research_sensors, predict_research_sensors_at_hours,
                        status as surrogate_status)
from .research_site import (ResearchSiteInferenceBlocked, ResearchSiteNotFound,
                            ResearchSiteMatchUnavailable, ResearchSiteRepository,
                            ResearchSiteUnavailable)
from .research_georef import (ResearchGeoreferenceUnavailable, match_public_site)
from .dense_grid import DenseGridUnavailable, build_dense_grid

app = FastAPI(title="SolarCheck 연결 시험")
research_site = ResearchSiteRepository()
candidate_grids: OrderedDict[str, dict] = OrderedDict()
candidate_predictions: OrderedDict[str, dict] = OrderedDict()
research_monthly_predictions: OrderedDict[str, dict] = OrderedDict()


def _bounded_remember(cache: OrderedDict, key: str, value: dict, limit: int = 16) -> None:
    cache[key] = value
    cache.move_to_end(key)
    while len(cache) > limit:
        cache.popitem(last=False)

# GitHub Pages 연결 시 환경변수에 https://계정명.github.io 를 추가하세요.
# 여러 주소는 쉼표로 구분합니다. 저장소 경로는 포함하지 않습니다.
origins = settings()['origins']
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in origins.split(",") if origin.strip()],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


@app.get("/health")
def health():
    return {"status": "ok", "version": "dense-grid-preview-1"}


class BuildingLookup(BaseModel):
    address: str = Field(min_length=3, max_length=300)
    radius_m: int = Field(default=200, ge=50, le=300)
    building_id: str | None = Field(default=None, max_length=100)
    record_id: str | None = Field(default=None, max_length=100)


@app.get('/api/config')
def public_config():
    config = settings()
    return {'vworld_ready': bool(config['vworld_key']), 'registry_ready': bool(config['registry_key']),
            'floor_height_assumption_m': config['floor_height'], 'radius_max_m': 300}


@app.get('/api/irradiance/status')
def irradiance_status():
    # Only readiness and public limitations: never local paths or credentials.
    return surrogate_status()


def _research_site_call(method, *args, **kwargs):
    try:
        return method(*args, **kwargs)
    except ResearchSiteNotFound as error:
        raise HTTPException(status_code=404, detail={'code': 'RESEARCH_SITE_ITEM_NOT_FOUND', 'message': str(error)}) from None
    except ResearchSiteUnavailable as error:
        raise HTTPException(status_code=503, detail={'code': 'RESEARCH_SITE_PACKAGE_UNAVAILABLE', 'message': str(error)}) from None
    except ResearchSiteInferenceBlocked as error:
        raise HTTPException(status_code=409, detail={'code': 'RESEARCH_SENSOR_EXTRAPOLATION_BLOCKED', 'message': str(error)}) from None


@app.get('/api/research-site/status')
def research_site_status():
    return research_site.status()


@app.get('/api/research-site')
def research_site_overview():
    return _research_site_call(research_site.overview)


@app.get('/api/research-site/buildings')
def research_site_buildings(
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
):
    return _research_site_call(research_site.list_buildings, offset=offset, limit=limit)


@app.get('/api/research-site/buildings/{building_id}')
def research_site_building(building_id: str):
    if not 1 <= len(building_id) <= 100:
        raise HTTPException(status_code=422, detail={'code': 'INVALID_BUILDING_ID', 'message': '건물 ID 형식을 확인해 주세요.'})
    return _research_site_call(research_site.building, building_id)


@app.get('/api/research-site/surface-groups/{surface_group_id}/sensors')
def research_site_surface_sensors(
    surface_group_id: str,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=500, ge=1, le=2000),
    hourly_eligible_only: bool = Query(default=False),
):
    if not 1 <= len(surface_group_id) <= 200:
        raise HTTPException(status_code=422, detail={'code': 'INVALID_SURFACE_GROUP_ID', 'message': '표면 그룹 ID 형식을 확인해 주세요.'})
    return _research_site_call(
        research_site.surface_sensors,
        surface_group_id,
        offset=offset,
        limit=limit,
        hourly_eligible_only=hourly_eligible_only,
    )


@app.get('/api/research-site/sensors/{sensor_row_index}/irradiance')
def research_site_sensor_irradiance(
    sensor_row_index: int,
    day: date = Query(alias='date'),
):
    if sensor_row_index < 0:
        raise HTTPException(status_code=422, detail={'code': 'INVALID_SENSOR_ID', 'message': '센서 ID를 확인해 주세요.'})
    if day.year != 2021:
        raise HTTPException(status_code=422, detail={
            'code': 'INVALID_TMY_DATE',
            'message': '고정 TMYx 기준일은 2021년 날짜로 선택해 주세요.',
        })
    sensor = _research_site_call(research_site.inference_sensor, sensor_row_index)
    start = (day - date(2021, 1, 1)).days * 24
    hour_indices = list(range(start, start + 24))
    xyz = [[sensor[key] for key in ('x', 'y', 'z')]]
    normals = [[sensor[key] for key in ('nx', 'ny', 'nz')]]
    horizons = [[sensor[key] for key in (
        'horizon_n', 'horizon_ne', 'horizon_e', 'horizon_se',
        'horizon_s', 'horizon_sw', 'horizon_w', 'horizon_nw',
    )]]
    try:
        prediction = predict_research_sensors_at_hours(
            xyz, normals, horizons, hour_indices, coordinate_frame='original-research-local'
        )[0]
        _, _, solar = load_surrogate()
    except SurrogateUnavailable as error:
        raise HTTPException(status_code=503, detail={
            'code': 'RESEARCH_MODEL_UNAVAILABLE', 'message': str(error),
        }) from None
    except ValueError as error:
        raise HTTPException(status_code=409, detail={
            'code': 'RESEARCH_SENSOR_INPUT_REJECTED', 'message': str(error),
        }) from None
    series = [{
        'hour_index': hour_index,
        'timestamp': solar[hour_index]['timestamp'],
        'irradiance_w_m2': float(value),
        'solar_altitude_deg': float(solar[hour_index]['solar_altitude_deg']),
        'solar_azimuth_deg': float(solar[hour_index]['solar_azimuth_deg']),
        'dni_w_m2': float(solar[hour_index]['dni']),
        'dhi_w_m2': float(solar[hour_index]['dhi']),
    } for hour_index, value in zip(hour_indices, prediction)]
    peak_position = int(np.argmax(prediction))
    return {
        'model': 'E2c',
        'coordinate_frame': 'original-research-local',
        'weather': 'Seoul TMYx 2004-2018',
        'timezone': 'Asia/Seoul',
        'date': day.isoformat(),
        'sample_offset_minutes': 30,
        'unit': 'W/m2',
        'sensor': {
            'sensor_row_index': sensor['sensor_row_index'],
            'building_id': sensor['building_id'],
            'surface_type': sensor['surface_type'],
            'surface_group_id': sensor['surface_group_id'],
            'annual_prediction_kwh_m2_year': sensor['annual_prediction_kwh_m2_year'],
        },
        'daily_energy_kwh_m2': float(prediction.sum() / 1000),
        'peak_irradiance_w_m2': float(prediction[peak_position]),
        'peak_timestamp': series[peak_position]['timestamp'],
        'series': series,
    }


def _predict_monthly_irradiance(sensors: list[dict]) -> dict:
    xyz = [[sensor[key] for key in ('x', 'y', 'z')] for sensor in sensors]
    normals = [[sensor[key] for key in ('nx', 'ny', 'nz')] for sensor in sensors]
    horizons = [[sensor[key] for key in (
        'horizon_n', 'horizon_ne', 'horizon_e', 'horizon_se',
        'horizon_s', 'horizon_sw', 'horizon_w', 'horizon_nw',
    )] for sensor in sensors]
    hourly = predict_research_sensors(
        xyz, normals, horizons, coordinate_frame='original-research-local'
    )
    month_start_days = (0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365)
    monthly = [float(hourly[:, month_start_days[month - 1] * 24:month_start_days[month] * 24]
                     .sum(axis=1, dtype=np.float64).mean() / 1000.0)
               for month in range(1, 13)]
    return {
        'status': 'predicted',
        'model': 'E2c',
        'coordinate_frame': 'original-research-local',
        'weather': 'Seoul TMYx 2004-2018',
        'unit': 'kWh/m2/month',
        'building_id': sensors[0]['building_id'],
        'surface_group_id': sensors[0]['surface_group_id'] if all(
            sensor['surface_group_id'] == sensors[0]['surface_group_id'] for sensor in sensors
        ) else None,
        'annual_mean_kwh_m2_year': float(sum(monthly)),
        'series': [
            {'month': month, 'irradiance_kwh_m2_month': value}
            for month, value in enumerate(monthly, start=1)
        ],
    }


@app.get('/api/research-site/buildings/{building_id}/monthly-irradiance')
def research_site_monthly_irradiance(
    building_id: str,
    surface_group_id: str | None = Query(default=None),
):
    if not 1 <= len(building_id) <= 100:
        raise HTTPException(status_code=422, detail={'code': 'INVALID_BUILDING_ID', 'message': '건물 ID 형식을 확인해 주세요.'})
    if surface_group_id is not None and not 1 <= len(surface_group_id) <= 200:
        raise HTTPException(status_code=422, detail={'code': 'INVALID_SURFACE_GROUP_ID', 'message': '표면 그룹 ID 형식을 확인해 주세요.'})
    cache_key = f'{building_id}:{surface_group_id or "all"}'
    cached = research_monthly_predictions.get(cache_key)
    if cached is not None:
        research_monthly_predictions.move_to_end(cache_key)
        return cached
    sensors = _research_site_call(
        research_site.monthly_inference_sensors, building_id, surface_group_id
    )
    try:
        result = _predict_monthly_irradiance(sensors)
    except SurrogateUnavailable as error:
        raise HTTPException(status_code=503, detail={
            'code': 'RESEARCH_MODEL_UNAVAILABLE', 'message': str(error),
        }) from None
    except ValueError as error:
        raise HTTPException(status_code=409, detail={
            'code': 'RESEARCH_SENSOR_INPUT_REJECTED', 'message': str(error),
        }) from None
    _bounded_remember(research_monthly_predictions, cache_key, result)
    return result


def _predict_candidate_grid(grid: dict) -> dict:
    sensors = grid.get('sensors') or []
    if not 1 <= len(sensors) <= 1024:
        raise ValueError('후보 센서 개수는 1~1,024개여야 해요.')
    xyz = [[sensor[key] for key in ('x', 'y', 'z')] for sensor in sensors]
    normals = [[sensor[key] for key in ('nx', 'ny', 'nz')] for sensor in sensors]
    directions = ('n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw')
    horizons = [[sensor['horizon_deg'][key] for key in directions] for sensor in sensors]
    hourly = predict_research_sensors(
        xyz, normals, horizons, coordinate_frame='original-research-local'
    )
    annual = hourly.sum(axis=1, dtype=np.float64) / 1000.0
    return {
        'status': 'predicted',
        'model': 'E2c',
        'coordinate_frame': 'original-research-local',
        'weather': 'Seoul TMYx 2004-2018',
        'hours': 8760,
        'unit': 'kWh/m2/year',
        'sensor_count': len(sensors),
        'annual_min': float(annual.min()),
        'annual_mean': float(annual.mean()),
        'annual_max': float(annual.max()),
        'items': [{
            'candidate_id': sensor['candidate_id'],
            'annual_prediction_kwh_m2_year': float(value),
        } for sensor, value in zip(sensors, annual)],
    }


@app.get('/api/research-site/candidate-grids/{site_id}/irradiance')
def candidate_grid_irradiance(site_id: str):
    if not (site_id.startswith('vw_') and len(site_id) == 23
            and all(character in '0123456789abcdef' for character in site_id[3:])):
        raise HTTPException(status_code=422, detail={
            'code': 'INVALID_SITE_ID', 'message': '후보 센서 사이트 ID를 확인해 주세요.',
        })
    cached = candidate_predictions.get(site_id)
    if cached is not None:
        candidate_predictions.move_to_end(site_id)
        return cached
    grid = candidate_grids.get(site_id)
    if grid is None:
        raise HTTPException(status_code=404, detail={
            'code': 'CANDIDATE_GRID_NOT_FOUND',
            'message': '후보 센서가 만료됐어요. 주소를 다시 조회해 주세요.',
        })
    try:
        result = _predict_candidate_grid(grid)
    except SurrogateUnavailable as error:
        raise HTTPException(status_code=503, detail={
            'code': 'RESEARCH_MODEL_UNAVAILABLE', 'message': str(error),
        }) from None
    except ValueError as error:
        raise HTTPException(status_code=409, detail={
            'code': 'CANDIDATE_SENSOR_INPUT_REJECTED', 'message': str(error),
        }) from None
    _bounded_remember(candidate_predictions, site_id, result)
    return result


@app.post('/api/irradiance/analyze')
def analyze_irradiance(query: BuildingLookup):
    # The research-coordinate predictor is callable from Python, but this route
    # cannot convert addresses before geographic registration is established.
    model = surrogate_status()
    raise HTTPException(status_code=409, detail={
        'code': 'ADDRESS_MODEL_NOT_READY',
        'message': '임의 주소 추론은 실행하지 않아요. 고정 연구 대상지 건물은 건물 조회의 외곽 검증 매칭을 사용해 주세요.',
        'blockers': model['blockers'], 'research_inference_ready': model['research_inference_ready'],
    })


@app.post('/api/buildings/lookup')
def lookup_building(query: BuildingLookup):
    try:
        result = PublicBuildings().lookup(query.address.strip(), query.radius_m, query.building_id, query.record_id)
        if result.get('status') == 'ok':
            try:
                result['research_match'] = match_public_site(result['site'], research_site)
                try:
                    result['analysis_grid'] = build_dense_grid(
                        result['site'], result['research_match'], research_site
                    )
                    _bounded_remember(candidate_grids, result['site']['site_id'], result['analysis_grid'])
                    candidate_predictions.pop(result['site']['site_id'], None)
                except DenseGridUnavailable as error:
                    result['analysis_grid'] = {'status': 'unavailable', 'message': str(error)}
                result['message'] = (
                    f"연구 대상지 건물 {result['research_match']['building_id']}에 일치해 일사량 분석을 연결했어요."
                )
            except ResearchSiteMatchUnavailable as error:
                result['research_match'] = {'status': 'unmatched', 'message': str(error)}
            except (ResearchSiteUnavailable, ResearchGeoreferenceUnavailable) as error:
                result['research_match'] = {'status': 'unavailable', 'message': str(error)}
        return result
    except LookupFailure as error:
        raise HTTPException(status_code=error.status, detail={'code': error.code, 'message': error.message}) from None


@app.post("/analyze")
def analyze(
    address: str = Form(..., min_length=1, max_length=300),
    photo: UploadFile = File(...),
):
    # TODO: 기존 GIS·AI 분석 함수를 이곳에 연결하세요.
    # 현재는 업로드 접수만 확인하며, 분석하거나 파일을 보관하지 않습니다.
    return {
        "status": "received",
        "address": address,
        "photo": photo.filename,
        "message": "연구실 PC가 요청을 받았습니다. 실제 분석은 연결 전입니다.",
    }
