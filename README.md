# 솔라체크 (SolarCheck)

주소와 입면 사진 1장으로 노후 건축물 외피(지붕·입면) 태양광 적용 가능성을 판정하는 웹 서비스의 해커톤 구현본.

- `prep/` 사전 계산 (Python): GIS 윤곽 → 블록·분석면 → 센서 격자 → 지평선 → 일사
- `docs/` 웹 (GitHub Pages 배포 폴더): 건물 선택 → 입면 촬영·원근 보정·칸 편집 → 산정·판정
- `tests/` 산정 로직 테스트

## 실행

```bash
pip install -r requirements.txt

# 1) GIS 파일 → 사이트 입력 (데모는 prep/sites/demo_seoul.json 이 이미 있음)
python prep/gis_to_site.py raw/buildings.gpkg --lon 128.53 --lat 35.84 --site-id A_daegu \
    --height-col <높이 열> --floors-col <층수 열> --use 근린생활시설 --approval-year 1998 --gfa 6801.9

# 2) 사전 계산 → docs/data/sites/<id>/
python prep/build_site.py prep/sites/demo_seoul.json --epw <서울 EPW 경로>

# 3) 로컬 확인 (file:// 로 열면 JSON을 못 읽음)
cd docs && python -m http.server 8000      # 휴대폰은 같은 와이파이에서 http://<노트북 IP>:8000

# 4) 산정 테스트
node --test tests/calc.test.mjs
```

GitHub Pages: 저장소 Settings → Pages → Branch `main`, 폴더 `/docs`.
휴대폰 카메라 촬영은 HTTPS(Pages) 또는 localhost에서만 확실히 동작한다.

## 지금 상태와 남은 일

| 항목 | 상태 | 다음 |
| --- | --- | --- |
| 일사 | 해석식 (직달 × 태양 가시도 + 등방 확산 × 천공 계수 + 지면 반사) | 대리모델로 교체: `build_site.py`의 `face_irradiance()` |
| 기상 | EPW 없으면 청천 근사 (과대평가) | 시연 지역 EPW로 다시 실행 |
| 입면 분할 | 칸을 눌러 벽/창 지정 (수동) | CNN 결과로 `app.js` `rectify()`의 초기 칸 값 채우기 |
| 지붕 | 이격 거리만 빼고 전체 설치 | 정사영상 분할 |
| 파라미터 | `docs/params.json`, `source`가 "가정"인 값은 미확인 | 출처 확인 후 교체 |
| 부하 | 용도별 24시간 가정 형상 | 보정 에너지 모델 시간 부하(8,760개 배열)로 교체 |
| 3D 뷰어 | 2D 배치도 | 필요하면 Three.js |

데모 건물(`demo_seoul`)은 페르소나 유형을 본뜬 가상 건물이다. 실제 주소가 아니다.

## 좌표 규약

대상 건물 윤곽 중심 원점, x = 동, y = 북, z = 위 (m). 방위각은 북 = 0°, 시계방향.
입면은 반시계 윤곽의 변 `p0 → p1`, 밖에서 보면 `p0`이 왼쪽. 격자 인덱스는 `t * ns + s` (t = 0이 1층 쪽).
