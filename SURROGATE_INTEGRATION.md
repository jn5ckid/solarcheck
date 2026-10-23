# 일사량 대리모델 연결 점검 (2026-10-23)

E2c의 **원래 연구 좌표 추론은 연결·검증 완료**했다. **실제 주소 분석은 지리 정합 자료가 없어 보류**한다. 실제 건물에 데모 일사량을 적용하거나 시간 분포를 만들어 넣지 않는다.

## 발견한 자료와 선택 근거

연구 폴더는 기본적으로 `solarcheck`의 상위 폴더다. 경로 변경 시 `.env`의 `SOLARCHECK_RESEARCH_ROOT`, `SOLARCHECK_PIPELINE_ROOT`를 지정한다. 기존 staging 학습 manifest는 원본 pipeline 위치를 찾는 힌트로만 사용하고, 아래 자료의 SHA-256을 별도로 검증한다.

| 자료 | 위치 / 설명 |
| --- | --- |
| 기존 C7 후보 | `../inputs/_staging/best_model.pt`, `training_manifest.json`. E2c와 다른 체크포인트이며 혼용하지 않음 |
| 선택한 E2c | `../analysis_outputs/e2c_e2f_20260810/e2c_train_run/22d_seed42_tilt_diffuse/best_model.pt` 및 `training_manifest.json` |
| E2c 체크포인트 해시 | `3858A559C3E6DA3DB38DB009FDE3E33218264A03235F424EE76AC87AD32D8604`, best step 2275 |
| 원래 추론·구조 | `../experiments/g2_inference_e2c_100000.py`, `e2c_train_tilt_diffuse.py`, `e1b_train_structured.py` |
| 고정 정규화 | 원본 pipeline의 `artifacts/tmyx_hh30_scale/c7_a5_bundles_run01/22d/metadata.json` |
| 정규화 해시 | `E6AAEF63A1267D7E57FE6265C4A23726A4702AAB53557842979F1F683088B135` |
| 기상·태양위치 | 원본 pipeline의 `artifacts/tmyx_hh30_13d/p2/solar_features.csv`, `solar_manifest.json` |
| 기상 특징 해시 | `87EC3C0DAE5F2992C3934D993B04DCB5745B8F9B53467CB10AE78F1D3B56CECE` |
| 개발 검증 | `../analysis_outputs/e2c_e2f_20260810/e2c_evaluation_clean523/` 및 기존 clean523 GT 캐시 |
| 공간 원본 | `../3DM.3dm`: 단위 m, 문서 사용자 텍스트 없음, `EarthLocationIsSet() == False`. 실제 위경도 기준점이 내장돼 있지 않음 |

체크포인트·기상·사진·원시 센서 자료는 GitHub에 복사하지 않았다. 재현용 코드와 경로 없는 검증 요약만 저장소에 포함한다.

## 모델 계약

모델은 22 → 256 → 256 → 128 → 64 → 1, GELU, softplus 보정 계수 구조다. 다음 순서를 바꾸지 않는다.

| 입력 | 전처리 |
| --- | --- |
| `x,y,z` | **원래 연구 XYZ**에 `(P-min)/scale` 적용. 건물마다 새로 정규화하지 않음 |
| `t` | `hour_index / 8759` |
| `sin_altitude,cos_altitude,sin_azimuth,cos_azimuth` | 원본 태양위치 특징 그대로 |
| `nx,ny,nz` | 단위 법선, 연구 좌표축 기준 |
| `dni,dhi` | 원자료 W/㎡를 모델 입력에서만 1000으로 나눔 |
| N,NE,E,SE,S,SW,W,NW 지평선 8개 | 원래 고도각(도)을 90으로 나눔 |
| `sf_soft` | 태양 방위에서 8방위 지평선을 선형 보간하고 `sigmoid((고도-지평선)/2°)`. 야간은 0 |

XYZ의 고정 train 범위와 scale은 다음과 같다. 이 범위에 있다는 사실만으로 지리·형상·기상 일반화가 검증되는 것은 아니다. 새 어댑터는 범위를 벗어나는 센서의 추론을 차단한다.

| 축 | min (m) | max (m) | scale (m) |
| --- | ---: | ---: | ---: |
| Px | -502.982208265 | 506.664648697 | 1009.646856962 |
| Py | -518.989267452 | 519.698746169 | 1038.688013620 |
| Pz | 27.048600197 | 149.313980103 | 122.265379906 |

출력은 격자·시간별 **W/㎡**다. 시간축은 서울 TMYx(2004–2018), 태양위치 위도 37.56 / 경도 126.97, `2021-01-01 00:30 KST + h시간`, 8,760시간이다. 2021년은 태양위치 계산용 평년이며 실제 관측연도가 아니다. 주간 4,434시간만 추론하며 나머지는 원모델의 야간 0 게이트를 적용한다. 연간 일사는 1시간 간격의 출력을 합산해 `/1000`한 **kWh/㎡·년**이다.

물리 기저는 직달 `DNI × max(cos(AOI),0) × sf_soft`와 경사·전방 지평선을 반영한 등방 확산이다. MLP가 양의 곱셈 보정 계수를 예측한다. 반사광·비등방 확산은 명시적으로 계산하지 않는다. 보정 계수는 학습 자료의 영향도 포함하므로 실제 다른 지역에 적용할 수 있다는 근거로 해석하지 않는다.

## 현재 형상과의 연결 가능성 및 부족한 자료

`facade_sensors()`는 현재 입면의 `p0,p1,ns,nt,height_m`를 사진 편집과 동일한 `t*ns+s` 순서(아래 행부터)의 센서 중심과 바깥 법선으로 변환한다. 0.1m 면 오프셋도 유지한다. 공공 조회 결과에 `geometry_frame`을 추가해 주소 중심 AEQD 투영과 대상 건물 중심 이동량을 보존했다. z는 지리 기준이 없는 평탄 지면 가정임을 명시했다.

하지만 다음 자료가 없으므로 실제 주소를 모델에 넣을 수 없다.

1. **지리 정합**: 연구 로컬 XYZ에 대응하는 위경도 또는 CRS의 기준점, 진북 회전각, 높이 기준(지면/표고/모델 원점). 한 점만 줄 경우 회전·단위·높이 기준도 명시해야 한다. 가능하면 2개 이상 대응점을 제공해 정합 오차를 확인한다.
2. **지형·장애물 기준의 일치**: 연구 지평선 계산은 원래 3D 형상에서 구했다. 건물 높이만 있는 평탄 블록의 8방위 지평선을 그대로 동등하다고 볼 수 없다. 대지 표고와 주변 형상 누락·절단 반경에 대한 비교가 필요하다.
3. **적용 대상지 검증**: 단일 대상지·서울 기상 자료·개발 검증 결과뿐이다. 새 주소나 다른 기상 지역에 대한 독립 기준 시뮬레이션을 마련해야 한다. 좌표 정합 완료만으로 모든 주소를 허용하지 않는다.

추론은 원래 연구 프레임의 Python 함수 `predict_research_sensors(..., coordinate_frame='original-research-local')`로 제공한다. 임의 좌표를 넣는 공개 추론 API는 만들지 않았다. `POST /api/irradiance/analyze`는 현재 항상 HTTP 409와 부족한 자료를 반환하며 일사량을 반환하지 않는다. 지리 자료가 생겨도 이 차단을 플래그 하나로 해제할 수 없고, 실제 변환·적용 범위 검증을 구현해야 한다.

`prep/build_site.py`의 기존 72방위/청천 해석식은 데모용으로 유지했다. **`face_irradiance()`만 바꾸는 것으로는 E2c 연결이 되지 않는다.** 고정 XYZ, 정확한 HH:30 시간축, 8방위 지평선, 2° soft-SF, 검증된 대상지 기상이 모두 맞아야 한다. 청천 자료로 대체하는 경로는 E2c 어댑터에 없다.

## 웹과 경제성 계산

- 모델 상태 확인은 `GET /api/irradiance/status`에서 실제 파일 해시·PyTorch 설치와 제한 사유를 읽는다. 공개 응답에 로컬 경로나 키는 없다.
- 데모 입면을 선택하면 격자별 일사 색상과 클릭한 칸의 연간 수치·사진 설치 비율을 볼 수 있다. 화면에 **가상 데모**와 기상 근사 출처를 표시한다. 실제 주소는 일사 자료가 없으므로 이 격자를 표시하지 않고 결과 버튼을 비활성화한다.
- 계산 입력은 면별 `annual[cells]`, `hourly[8760]`이며, E2c 출력에는 `hourly_cells[cells][8760]`와 `reference_year:2021`도 필요하다. 격자별 합계와 연간 값의 단위·개수·일치성을 검증한다.
- 격자별 시간 자료가 있으면 사진 비율·일사 기준 제외를 각 시간에 적용한다. 연간 총량만 있거나 자료가 불일치하면 계산을 거부한다. 면 평균 시간 자료만 있는 기존 데모는 그 근사 한계를 분석 가정에 표시한다.
- 사진은 계속 IndexedDB에만 저장한다. 삭제했던 배치도와 월평균 전기 사용량 UI는 추가하지 않았다.

## 설치·실행·검증

프로젝트 폴더에서 실행한다. 기존 주소 조회만 쓸 때는 PyTorch가 없어도 된다.

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-inference.txt
.\.venv\Scripts\python.exe -m prep.validate_surrogate
.\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'
node --test tests/calc.test.mjs tests/facade.test.mjs
.\.venv\Scripts\python.exe -m prep.check_public_services
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

검증 보고서는 `outputs/surrogate-validation.json`에 기록된다. 저장소의 [SURROGATE_VALIDATION.json](SURROGATE_VALIDATION.json)은 이번 검증의 요약 사본이다. 새 검증을 실행해도 이 사본을 자동 덮어쓰지 않는다.

- 프로젝트 Python 3.14.4 / torch 2.14.1 CPU에서 원래 연구 센서 **8개(지붕 4, 입면 4) × 8,760시간**을 새로 추론했다.
- 기존 E2c GPU 결과와 최대 절대 차이: 시간별 **0.000244141 W/㎡**, 연간 **0.000144377 kWh/㎡**. 야간은 모두 정확히 0.
- 기존 clean523 캐시를 다시 비교한 입면 250개 개발 검증: 시간별 R² **0.860298**, RMSE **74.7903 W/㎡**; 연간 R² **0.897575**, RMSE **124.1483 kWh/㎡**.
- 전체 523개를 이번에 재추론했다는 뜻이 아니다. 새 추론 8개의 수치 일치 점검과 기존 523개 캐시 성능 재계산을 구분한다. 새 주소나 독립 시험 성능이 아니다. test/holdout 자료는 열지 않았다.
- Python 15개, Node 11개 테스트 통과. 웹에서 데모 격자와 수치·사진 비율 표시, 기존 데모 결과, 실제 주소 분석 차단을 점검했다.
- 브이월드와 건축HUB의 실제 인증 응답이 모두 성공했다. 설정 여부 확인과 실제 인증 확인을 구분하며 키는 출력하지 않았다.

2026-10-23 점검 시 기존 8000 서버와 옛 터널은 `address-lookup-1`로 응답했다. 다른 프로세스를 종료하지 않고 새 코드를 8001에서 별도 검증했다. 8000을 계속 사용할 경우 해당 서버를 사용자가 다시 시작해야 새 코드가 적용된다. 터널 주소는 실행할 때마다 실제 `/health` 버전을 확인한다.
