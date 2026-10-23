# 일사량 대리모델 연결 점검 (2026-10-23)

E2c의 **원래 연구 좌표 추론은 연결·검증 완료**했다. 주소 건물이 **고정 연구 대상지의 기존 건물과 위치·외곽으로 검증 매칭될 때만** 입면별 연평균과 8,760시간 기반 월별 일사량을 연결한다. 대상지 밖 주소와 모호한 매칭은 계속 차단한다.

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
| 공간 원본 | `../3DM.3dm`: 단위 m, 문서 사용자 텍스트 없음, `EarthLocationIsSet() == False`. 외부 기준점으로 지리 정합 |
| 외부 기준점 | `서울특별시 동작구 상도로47길 102` → 경도 126.95190436549447, 위도 37.5037278415151 → 연구 로컬 (0,0). X=동, Y=북 |

체크포인트·기상·사진·원시 센서 자료는 GitHub에 복사하지 않았다. 재현용 코드와 경로 없는 검증 요약만 저장소에 포함한다.

## 고정 연구 대상지 패키지

웹 연결의 기준 모집단은 `g2_100k_sensor_disjoint_20260814`의 **동일 대상지 sensor-disjoint 100,000점**으로 고정한다. 학습 센서 및 개발 센서와 ID 중복은 0이며, 1,701개 건물의 지붕 28,387점과 입면 71,613점을 포함한다. 독립 건물 holdout이나 봉인 시험 세트는 아니다.

고정 파일의 경로·크기·SHA-256·모델 계약·검증 성능은 `RESEARCH_SITE_MANIFEST.json`에 기록했다. `sensor_row_index`만 교차 파일 고유 키로 사용한다. `Space_ID + Index`와 `building_id + Space_ID + Index`는 각각 5,362개 중복이 있어 조인 키로 사용하지 않는다.

100,000점 중 687점은 하나 이상의 고정 학습 XYZ 범위를 벗어난다(Px 634, Py 2, Pz 51; 축별 수는 중복 가능). 기존 연간 적용 결과에는 포함되지만 현재 `predict_research_sensors()`의 외삽 차단 정책에 따라 시간별 재추론에서는 제외한다. 따라서 1차 웹 연결의 시간별 추론 가능 모집단은 **99,313점**이다. 이 정책을 완화하려면 별도의 외삽 검증과 명시적 버전 변경이 필요하다.

다음 명령은 원본을 수정하거나 GT 값을 읽지 않고 해시, 센서 순서, 좌표 일치, 법선, 지평선 범위와 적용 가능 개수를 다시 점검한다.

```powershell
.\.venv\Scripts\python.exe -m prep.audit_research_site
```

웹 조회용 센서 매핑은 다음 명령으로 `outputs/research_site_mapping/research_site.sqlite`에 생성한다. 이 데이터베이스는 `sensor_row_index`를 기본 키로 센서 XYZ, 단위 법선, 8방위 지평선, 연간 예측과 시간별 재추론 가능 여부를 결합하며 GT 값은 저장하지 않는다.

```powershell
.\.venv\Scripts\python.exe -m prep.build_research_site_mapping
```

`surface_group_id`는 건물·표면 종류와 법선 방위/경사를 5°로 묶은 웹 조회·색상 표시용 그룹이다. 3DM의 실제 벽면 폴리곤 ID가 아니며 사진 마스크나 면적 기반 경제성 계산에 직접 사용하지 않는다. 해당 연결은 3DM 면 또는 원본 센서 격자의 명시적 face 매핑이 확보된 뒤 별도로 검증한다.

웹의 월별 차트는 `GET /api/research-site/buildings/{building_id}/monthly-irradiance`를 사용한다. 선택한 표면의 고정 XYZ·단위 법선·8방위 지평선으로 8,760시간을 추론한 뒤 달력 월별로 적산하고 표면 전체 평균을 반환한다. 단위는 kWh/㎡·월이고 12개월 합계는 kWh/㎡·년이다. 개별 센서 날짜 API는 개발 진단용으로만 유지하며 기본 UI에는 노출하지 않는다. 학습 XYZ 범위 밖 입력은 HTTP 409로 차단한다.

## 모델 계약

검증 매칭된 공공 건물에는 1.5m 간격의 지붕·입면 후보 센서를 생성한다. 후보 XYZ는 공공 외곽을 원래 연구 로컬 XY로 변환하고, 매칭된 기존 연구 건물 센서의 수직 범위에 정렬한다. 법선은 공공 블록 외곽의 바깥 방향과 지붕 상향 방향으로 만들며, 대상 및 주변 블록을 이용해 북=0°·시계방향의 8방위 지평선 고도를 계산한다. 주변 건물의 지반 높이는 현재 대상 건물과 같은 평면으로 가정한다. 주소 조회 직후 후보 전체를 8,760시간 배치 추론하고 연간 적산값을 색상으로 표시한다. 입면은 외곽변별 센서 중심 사이의 경계를 사용한 무경계 사각 패치, 지붕은 외곽으로 클리핑한 1.5m 격자로 면 컬러맵을 만든다. 센서 점은 선택적으로 켤 수 있으며 화면에서만 법선 방향으로 0.05m 추가 이격하고 주변 건물 표시 중에는 크기를 1/5로 줄인다. E2c 입력에는 0.1m 물리 이격을 포함한 원래 후보 XYZ를 그대로 사용한다.

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

## 주소 건물과 연구 건물 정합

`backend/research_georef.py`는 VWorld의 도로명주소 위·경도와 공공 건물 외곽을 WGS84로 복원한 뒤, 기준점 중심 AEQD(X=동, Y=북)로 투영한다. 이 외곽을 연구 센서 XY 컨벡스홀과 비교해 중심 거리 10m 이하, IoU 0.25 이상, 차순위와 IoU 0.10 이상 차이를 모두 만족할 때만 B번호를 자동 확정한다.

기준 주소는 공공 건물과 `B1257`이 중심 거리 1.259m, IoU 0.766으로 일치했다. 인접 건물의 위치도 `B1261`, `B510`과 약 1m 내로 일치해 축 방향과 미터 단위를 확인했다. 입력 주소가 대상지 밖이거나 외곽 일치가 모호하면 공공 건물 정보만 표시하고 E2c 연결을 차단한다.

이 연결은 **이미 고정된 1,701개 연구 건물을 주소로 식별**하는 것이다. 새 건물 형상에서 센서·지평선을 생성해 일반화하는 기능은 아니다. `POST /api/irradiance/analyze`의 임의 주소 추론은 계속 HTTP 409로 차단하고, 검증 매칭은 `POST /api/buildings/lookup` 응답의 `research_match`를 통해만 연결한다.

`prep/build_site.py`의 기존 72방위/청천 해석식은 데모용으로 유지했다. **`face_irradiance()`만 바꾸는 것으로는 E2c 연결이 되지 않는다.** 고정 XYZ, 정확한 HH:30 시간축, 8방위 지평선, 2° soft-SF, 검증된 대상지 기상이 모두 맞아야 한다. 청천 자료로 대체하는 경로는 E2c 어댑터에 없다.

## 웹과 경제성 계산

- 모델 상태 확인은 `GET /api/irradiance/status`에서 실제 파일 해시·PyTorch 설치와 제한 사유를 읽는다. 공개 응답에 로컬 경로나 키는 없다.
- 데모 입면 자료는 개발 검증용으로 유지한다. 고정 연구 대상지 주소는 검증 매칭된 건물의 면 컬러맵과 입면별 연평균 카드를 표시하며, 카드를 누르면 12개월 평균 일사량 차트를 표시한다. 내부 건물 ID·센서 개수·개별 센서 날짜 선택은 기본 화면에 노출하지 않는다.
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
- Python 35개, Node 17개 테스트 통과. 웹에서 기준 주소의 외곽 매칭, 주변 건물 3D, 연간 면 컬러맵, 입면별 연평균과 12개월 E2c 일사량 차트를 점검했다.
- 브이월드와 건축HUB의 실제 인증 응답이 모두 성공했다. 설정 여부 확인과 실제 인증 확인을 구분하며 키는 출력하지 않았다.

2026-10-23 점검 시 기존 8000 서버와 옛 터널은 `address-lookup-1`로 응답했다. 다른 프로세스를 종료하지 않고 새 코드를 8001에서 별도 검증했다. 8000을 계속 사용할 경우 해당 서버를 사용자가 다시 시작해야 새 코드가 적용된다. 터널 주소는 실행할 때마다 실제 `/health` 버전을 확인한다.
