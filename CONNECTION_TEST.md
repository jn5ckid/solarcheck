# solarcheck · 솔라체크 연결 시험

주소와 사진을 웹 화면에서 Python API로 전송하고 접수 응답을 확인하는 로컬 예제입니다.
GIS·AI 분석은 아직 연결하지 않았으며, 업로드 파일을 따로 저장하지 않습니다.

## VS Code에서 시작

이 `solarcheck` 폴더 자체를 VS Code의 **파일 → 폴더 열기**로 여세요.
Microsoft Python 확장을 설치하고, `Python: Select Interpreter`에서
`.venv\Scripts\python.exe`를 선택하세요.

아래 명령은 모두 프로젝트 최상위 폴더의 PowerShell에서 실행합니다.

가상환경이 없으면 생성하고 패키지를 설치합니다.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

### 터미널 1: API 서버

```powershell
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

또는 선택한 가상환경에서 F5를 누르고 **솔라체크 API 실행**을 선택합니다.
같은 API를 터미널과 F5로 동시에 실행하지 마세요.

- 상태 확인: http://127.0.0.1:8000/health
- API 시험 화면: http://127.0.0.1:8000/docs

### 터미널 2: 웹 화면

```powershell
.\.venv\Scripts\python.exe -m http.server 5500 --bind 127.0.0.1 --directory docs
```

http://127.0.0.1:5500/connection-test/ 를 열고 주소와 사진을 전송하세요.
화면에 `status: received`와 접수 메시지가 나타나면 연결 성공입니다.
각 프로그램은 해당 터미널에서 Ctrl+C로 종료합니다.

## GitHub Pages와 외부 접속

연결 대상 계정은 `jn5ckid`, 저장소 이름은 `solarcheck`입니다.
기존 화면은 `https://jn5ckid.github.io/solarcheck/`이고,
연결 시험 화면은 `https://jn5ckid.github.io/solarcheck/connection-test/`입니다.

1. GitHub의 `jn5ckid/solarcheck` 저장소에 공개 가능한 파일만 올립니다. `.gitignore`는 이미 추적 중인 파일에는 적용되지 않습니다.
2. 저장소의 Settings → Pages에서 `main` 브랜치, `/docs` 폴더를 배포 대상으로 선택합니다.
3. API의 기본 CORS 설정에 `https://jn5ckid.github.io`가 포함되어 있으므로 터미널 1의 명령으로 실행하면 됩니다. 허용 주소를 직접 지정하려면 아래처럼 실행합니다.

```powershell
$env:SOLARCHECK_ALLOWED_ORIGINS = "http://127.0.0.1:5500,http://localhost:5500,https://jn5ckid.github.io"
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

4. Cloudflare 공식 배포판의 Windows 64비트 실행 파일을 `tools/cloudflared.exe`로 둡니다.
   이 폴더는 GitHub 업로드에서 제외됩니다. 공식 다운로드: https://developers.cloudflare.com/tunnel/downloads/
   별도 터미널에서 아래 명령을 실행하고 해당 터미널을 켜둡니다.

```powershell
.\tools\cloudflared.exe tunnel --url http://127.0.0.1:8000
```

5. 연결 시험 화면의 **분석 서버 주소**에 출력된 `https://…trycloudflare.com` 주소를 입력합니다.

링크에 서버 주소를 포함하면 입력란이 자동으로 채워집니다. 자동으로 전송되지는 않습니다.

```text
https://jn5ckid.github.io/solarcheck/connection-test/?api=https%3A%2F%2F실제발급주소.trycloudflare.com
```

터미널을 별도로 열지 않고 터널을 시작하려면 아래 도우미를 사용할 수도 있습니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-tunnel.ps1
```

위 옵션은 이 스크립트 프로세스에만 적용되며 시스템 실행 정책을 변경하지 않습니다.
도우미는 기존 API가 실행 중인지 확인한 후 터널을 백그라운드에서 실행하고 공유 링크를 출력합니다.
터널 중지:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\stop-tunnel.ps1
```

다른 사람이 쓰는 동안에는 터널을 중지하지 마세요. API 서버는 별도로 실행되어 있어야 합니다.

Quick Tunnel은 개발·시험용이며 재실행 시 주소가 바뀝니다. 화면에서 새 주소를 입력하면 됩니다.
연구실 PC와 API, 터널이 실행 중이어야 외부 요청을 받을 수 있습니다.
HTTPS 화면에서는 HTTP 로컬 서버 대신 HTTPS 터널 주소를 사용하세요.
실제 이용자에게 공개하기 전에는 인증 및 업로드 제한을 추가하세요. CORS는 인증 기능이 아닙니다.

## 실제 분석 연결 위치

`backend/main.py`의 `analyze()` 안에서 기존 분석 함수를 호출하도록 확장하세요.
모델·데이터·비밀키는 공개 저장소에 넣지 말고 연구실 PC에 보관하세요.
긴 분석 작업은 작업 번호 반환 → 진행 상태 조회 → 결과 조회 방식으로 확장할 수 있습니다.
