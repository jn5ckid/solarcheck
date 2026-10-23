"""solarcheck connection demo. Run from the project root with Uvicorn."""

from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from .public_data import PublicBuildings, LookupFailure, settings

app = FastAPI(title="SolarCheck 연결 시험")

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
    return {"status": "ok", "version": "address-lookup-1"}


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


@app.post('/api/buildings/lookup')
def lookup_building(query: BuildingLookup):
    try:
        return PublicBuildings().lookup(query.address.strip(), query.radius_m, query.building_id, query.record_id)
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
