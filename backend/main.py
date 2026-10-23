"""solarcheck connection demo. Run from the project root with Uvicorn."""

import os

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="SolarCheck 연결 시험")

# GitHub Pages 연결 시 환경변수에 https://계정명.github.io 를 추가하세요.
# 여러 주소는 쉼표로 구분합니다. 저장소 경로는 포함하지 않습니다.
origins = os.getenv(
    "SOLARCHECK_ALLOWED_ORIGINS",
    "http://127.0.0.1:5500,http://localhost:5500,https://jn5ckid.github.io",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in origins.split(",") if origin.strip()],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


@app.get("/health")
def health():
    return {"status": "ok"}


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
