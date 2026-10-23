import { evaluate, faceName, openingRatio } from './calc.js?v=20261023-surrogate';
import { FacadeViewer } from './facade-viewer.js';
import { validateCorners } from './facade-geometry.js';
import { loadFacades, saveFacade, removeFacade } from './facade-store.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const fmt = (x, d = 0) => Number.isFinite(x) ? x.toLocaleString('ko-KR', { maximumFractionDigits: d, minimumFractionDigits: d }) : '–';
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const PPM = 20;          // 보정 영상 해상도 (px/m), 화면 폭에 맞춰 줄인다
const MAX_SRC = 1600;    // 사진 긴 변 최대 px

const S = { params: null, site: null, irr: null, face: null, cellsFrac: {}, img: null, corners: [], cells: null,
  textures: {}, index: [] };
const viewer = new FacadeViewer($('#building-canvas'), id => pickFace(id));
let siteLoadVersion = 0;

const labelFace = f => `${faceName(f)}${S.site?.source === 'public_api' ? ` · ${f.face_id}` : ''}`;

// ---------- 공통 ----------
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} 를 불러오지 못했어요 (${r.status})`);
  return r.json();
}
function show(step) {
  for (const id of ['site', 'photo', 'result']) $(`#step-${id}`).hidden = id !== step;
  document.querySelectorAll('.steps li').forEach(li => li.classList.toggle('on', li.dataset.step === step));
  scrollTo(0, 0);
  if (step === 'site') requestAnimationFrame(() => viewer.draw());
}
// 일사량 색: 음영(회청) → 햇빛(노랑) → 강한 일사(주황)
const RAMP = [[96, 112, 120], [150, 160, 150], [242, 179, 0], [232, 110, 30]];
function color(v, lo, hi) {
  const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo || 1))) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(t)), w = t - i;
  return `rgb(${RAMP[i].map((c, k) => Math.round(c + (RAMP[i + 1][k] - c) * w))})`;
}
const range = () => {
  if (!S.irr) return [0, 1];
  const all = Object.values(S.irr.faces).flatMap(f => f.annual);
  return [Math.min(...all), Math.max(...all)];
};

// ---------- 1. 건물 ----------
async function loadSite(id) {
  const version = ++siteLoadVersion;
  $('#go-photo').disabled = true;
  const [site, irr] = await Promise.all([
    getJSON(`data/sites/${id}/site.json`), getJSON(`data/sites/${id}/irradiance.json`)]);
  if (version !== siteLoadVersion) return;
  await displaySite(site, irr, version);
}

async function displaySite(site, irr, version = ++siteLoadVersion) {
  const id = site.site_id;
  S.site = site; S.irr = irr;
  S.face = null; S.cellsFrac = {}; S.textures = {};
  viewer.setSite(site); viewer.setContext($('#model-context').checked);
  const b = S.site.building;
  $('#loaded-building-name').textContent = `${site.source === 'public_api' ? '' : '[가상 데모] '}${site.name} · ${site.address}`;
  const heightNote = b.height_source === 'floor_estimate' ? ' (층수로 추정)' : '';
  const text = v => esc(v ?? '확인 필요');
  $('#site-info').innerHTML = `
    <dt>사용승인일</dt><dd>${text(b.approval_date || (b.approval_year ? `${b.approval_year}년` : null))}</dd>
    <dt>주용도</dt><dd>${text(b.use)}</dd>
    <dt>세부 용도</dt><dd>${text(b.other_use)}</dd>
    <dt>층수</dt><dd>지상 ${fmt(b.floors)} / 지하 ${fmt(b.basement_floors)}층</dd>
    <dt>연면적</dt><dd>${fmt(b.gfa_m2, 1)}㎡</dd>
    <dt>건축 / 대지면적</dt><dd>${fmt(b.building_area_m2, 1)} / ${fmt(b.land_area_m2, 1)}㎡</dd>
    <dt>높이</dt><dd>${b.height_m ? `${fmt(b.height_m, 1)}m${heightNote}` : '확인 필요'}</dd>
    <dt>구조</dt><dd>${text(b.structure)}</dd>
    <dt>주변 건물</dt><dd>${S.site.context.length}동 반영</dd>`;
  $('#public-data-details').hidden = !!irr;
  $('#go-result').disabled = !irr;
  $('#go-result').textContent = irr ? '사진 없이 데모 결과 보기' : '일사량 분석 연결 전';
  drawFaceList();
  $('#go-photo').disabled = true;
  $('#model-front').disabled = true;
  $('#remove-photo').hidden = true;
  $('#facade-status').textContent = '저장된 입면 사진을 확인하고 있어요.';
  let stored = [];
  let storageAvailable = true;
  try { stored = await loadFacades(id); }
  catch { storageAvailable = false; }
  const restored = await Promise.all(stored.map(async record => {
    const f = site.faces.find(f => f.face_id === record.faceId && f.type === 'facade');
    if (!f || !Array.isArray(record.cells) || record.cells.length !== f.ns * f.nt
      || record.cells.some(x => !Number.isFinite(x) || x < 0 || x > 1)
      || !/^data:image\/(jpeg|png);base64,/.test(record.dataUrl)) return null;
    try {
      const image = new Image(); image.src = record.dataUrl; await image.decode();
      return {record, image};
    } catch { return null; }
  }));
  if (version !== siteLoadVersion) return;
  for (const entry of restored.filter(Boolean)) {
    S.textures[entry.record.faceId] = {image: entry.image, dataUrl: entry.record.dataUrl};
    S.cellsFrac[entry.record.faceId] = entry.record.cells;
  }
  viewer.setPhotos(S.textures); drawFaceList();
  const count = Object.keys(S.textures).length;
  $('#facade-status').textContent = !storageAvailable ? '사진 저장소를 사용할 수 없어 현재 화면에만 사진을 입힐 수 있어요.'
    : count ? `이 건물의 입면 ${count}곳에 저장된 사진을 불러왔어요.`
      : '입면을 고르고 사진의 네 모서리를 지정하면 해당 벽면에 입혀요. 사진은 이 기기에 저장돼요.';
  if (irr) $('#go-result').textContent = count ? '데모 진단 결과 보기' : '사진 없이 데모 결과 보기';
  if (!site.faces.length) $('#facade-status').textContent = '높이가 없어 사진을 붙일 입면을 만들지 못했어요. 건물의 높이 또는 지상층수 확인이 필요해요.';
  drawIrradianceGrid();
}

function drawFaceList() {
  const [lo, hi] = range();
  $('#face-list').innerHTML = S.site.faces.map(f => {
    const v = S.irr ? mean(S.irr.faces[f.face_id].annual) : null;
    const roof = f.type === 'roof';
    const sub = roof ? `${fmt(f.area_m2)}㎡ · 정사영상 분석 예정`
      : `폭 ${fmt(f.width_m, 1)}m · ${S.cellsFrac[f.face_id] ? '사진 반영됨' : '사진 없음'}`;
    const texture = S.textures[f.face_id];
    return `<li><button class="${texture ? 'has-photo' : ''}" data-face="${f.face_id}" aria-pressed="${S.face === f.face_id}" ${roof ? 'disabled' : ''}>
      ${texture ? `<img class="face-thumbnail" src="${esc(texture.dataUrl)}" alt="">` : `<span class="swatch" style="background:${v === null ? '#7d9587' : color(v, lo, hi)}"></span>`}
      <span>${labelFace(f)}<span class="sub">${sub}</span></span>
      <span class="val">${v === null ? '<span class="sub">일사 분석 전</span>' : `${fmt(v)}<span class="sub">kWh/㎡·년</span>`}</span></button></li>`;
  }).join('');
  $('#face-list').querySelectorAll('button:not(:disabled)').forEach(b => b.addEventListener('click', () => pickFace(b.dataset.face)));
  drawIrradianceGrid();
}

function drawIrradianceGrid() {
  const f = S.site?.faces.find(f => f.face_id === S.face), data = S.irr?.faces[f?.face_id];
  const box = $('#irradiance-grid');
  box.hidden = !data || !f?.ns || !f?.nt;
  if (box.hidden) return;
  const cv = $('#irradiance-canvas'), g = cv.getContext('2d'), [lo, hi] = range();
  cv.width = 720; cv.height = Math.max(160, Math.min(620, 720 * f.height_m / f.width_m));
  const cw = cv.width / f.ns, ch = cv.height / f.nt;
  const fractions = S.cellsFrac[f.face_id];
  $('#irradiance-grid-title').textContent = `${S.site.source === 'public_api' ? '' : '[가상 데모] '}${labelFace(f)} · 격자별 연간 일사량`;
  $('#irradiance-grid-note').textContent = `${fmt(lo)} ~ ${fmt(hi)} kWh/㎡·년 · 칸을 누르면 수치가 나와요. 사선은 사진에서 제외한 칸이에요. ${S.irr.weather}`;
  for (let t = 0; t < f.nt; t++) for (let s = 0; s < f.ns; s++) {
    const i = t * f.ns + s, x = s * cw, y = (f.nt - 1 - t) * ch;
    g.fillStyle = color(data.annual[i], lo, hi); g.fillRect(x, y, cw, ch);
    g.strokeStyle = '#ffffffaa'; g.lineWidth = .8; g.strokeRect(x, y, cw, ch);
    if (fractions?.[i] < 1) {
      g.strokeStyle = '#18302a'; g.beginPath(); g.moveTo(x, y + ch); g.lineTo(x + cw, y); g.stroke();
    }
  }
  $('#irradiance-cell-value').textContent = '왼쪽부터 열 번호, 아래쪽부터 행 번호로 표시해요.';
}
$('#irradiance-canvas').addEventListener('click', e => {
  const f = face(), cv = e.currentTarget, rect = cv.getBoundingClientRect();
  const s = Math.min(f.ns - 1, Math.max(0, Math.floor((e.clientX - rect.left) / rect.width * f.ns)));
  const t = f.nt - 1 - Math.min(f.nt - 1, Math.max(0, Math.floor((e.clientY - rect.top) / rect.height * f.nt)));
  const i = t * f.ns + s, fraction = S.cellsFrac[f.face_id]?.[i] ?? 1 - openingRatio(S.cellsFrac, S.params);
  $('#irradiance-cell-value').textContent = `${s + 1}열 ${t + 1}행 · ${fmt(S.irr.faces[f.face_id].annual[i], 1)} kWh/㎡·년 · 설치 가능 비율 ${fmt(fraction * 100)}%${S.cellsFrac[f.face_id] ? ' (사진 편집)' : ' (개구율 가정)'}`;
});

function pickFace(id) {
  S.face = id;
  drawFaceList();
  $('#go-photo').disabled = false;
  $('#model-front').disabled = false;
  $('#remove-photo').hidden = !S.textures[id];
  viewer.select(id);
  $('#go-photo').textContent = `${labelFace(face())} 사진 ${S.textures[id] ? '촬영·교체' : '촬영·선택'}`;
}

$('#model-reset').addEventListener('click', () => viewer.reset());
$('#model-front').addEventListener('click', () => viewer.faceFront());
$('#model-zoom-in').addEventListener('click', () => viewer.zoomBy(1.2));
$('#model-zoom-out').addEventListener('click', () => viewer.zoomBy(1 / 1.2));
$('#model-context').addEventListener('change', e => viewer.setContext(e.target.checked));
$('#remove-photo').addEventListener('click', async () => {
  const siteId = S.site.site_id, id = S.face;
  try { await removeFacade(siteId, id); }
  catch { $('#facade-status').textContent = '저장된 사진을 지우지 못했어요. 다시 시도해 주세요.'; return; }
  if (S.site.site_id !== siteId) return;
  delete S.textures[id]; delete S.cellsFrac[id];
  viewer.setPhotos(S.textures); drawFaceList(); pickFace(id);
  if (S.irr) $('#go-result').textContent = Object.keys(S.textures).length ? '데모 진단 결과 보기' : '사진 없이 데모 결과 보기';
  $('#facade-status').textContent = `${labelFace(face())} 사진을 지웠어요.`;
});

// Address lookup, credentials stay on the research PC.
let lookupVersion = 0, lookupAbort;
const serverUrl = () => {
  let url;
  try { url = new URL($('#api-url').value.trim()); } catch { throw new Error('연구실 PC 연결 설정에 서버 주소를 입력해 주세요.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || (url.pathname !== '/' && url.pathname !== '')) throw new Error('서버의 기본 주소만 입력해 주세요.');
  if (location.protocol === 'https:' && url.protocol !== 'https:') throw new Error('공개 화면에서는 HTTPS 터널 주소가 필요해요.');
  return url.origin;
};
function rememberServer() {
  const url = serverUrl();
  try { localStorage.setItem('solarcheck-api-url', url); } catch { /* browser storage optional */ }
  $('#connection-link').href = `connection-test/?api=${encodeURIComponent(url)}`;
  return url;
}
async function checkServer() {
  $('#api-status').textContent = '연구실 PC 연결을 확인하고 있어요…';
  try {
    const r = await fetch(`${rememberServer()}/api/config`, {signal: AbortSignal.timeout(12000)});
    if (!r.ok) throw new Error('서버의 주소 조회 기능을 확인하지 못했어요. Python 서버를 다시 시작해 주세요.');
    const c = await r.json();
    $('#api-status').textContent = `연구실 PC 연결됨 · 브이월드 ${c.vworld_ready ? '키 설정됨' : '키 필요'} · 건축HUB ${c.registry_ready ? '키 설정됨' : '키 필요 (사용승인일·용도·면적)'}`;
    await checkSurrogate();
  } catch (e) { $('#api-status').textContent = e instanceof TypeError ? '서버에 연결하지 못했어요. PC 서버와 터널이 실행 중인지 확인해 주세요.' : e.message; }
}
$('#api-check').addEventListener('click', checkServer);
$('#api-url').addEventListener('change', () => { lookupAbort?.abort(); ++lookupVersion; checkServer(); });

let modelStatusVersion = 0;
async function checkSurrogate() {
  const version = ++modelStatusVersion;
  $('#surrogate-status').textContent = '일사량 모델 준비 상태를 확인하고 있어요…';
  try {
    const origin = serverUrl();
    const r = await fetch(`${origin}/api/irradiance/status`, {signal: AbortSignal.timeout(12000)});
    if (!r.ok) throw new Error('모델 상태를 확인하지 못했어요. 서버 업데이트·실행 상태를 확인해 주세요.');
    const data = await r.json();
    if (version !== modelStatusVersion || origin !== serverUrl()) return;
    $('#surrogate-status').textContent = `${data.research_inference_ready ? '연구용 시간별 모델 준비됨' : '연구 모델 자료·실행 환경 확인 필요'} · 실제 주소 분석 보류. ${(data.blockers ?? []).map(b => b.message).join(' ')}`;
  } catch (e) {
    if (version === modelStatusVersion) $('#surrogate-status').textContent = `실제 주소 분석은 실행하지 않았어요. ${e instanceof TypeError ? '연구실 PC 서버에 연결하지 못했어요.' : e.message}`;
  }
}
$('#check-surrogate').addEventListener('click', checkSurrogate);

function renderPublicData(data) {
  $('#data-source').textContent = `조회: ${new Date(data.retrieved_at).toLocaleString('ko-KR')} · ${Object.values(data.sources).join(' / ')}. 미확인 항목은 — 또는 확인 필요로 표시해요.`;
  $('#lookup-warnings').innerHTML = data.warnings.map(w => `<li>${esc(w)}</li>`).join('');
  $('#neighbor-summary').textContent = `주변 ${data.neighbor_count}동 · 3D 반영 ${data.modeled_neighbor_count}동 · 반경 ${data.radius_m}m${data.neighbors_complete ? '' : ' (일부 누락 가능)'}`;
  $('#neighbor-table').innerHTML = '<thead><tr><th>건물 / 동</th><th>거리 / 방향</th><th>지상층</th><th>높이</th><th>용도</th><th>사용승인일</th><th>상세 조회</th></tr></thead><tbody>'
    + data.neighbors.map(n => `<tr><td>${esc(n.name)} ${esc(n.dong_name)}</td><td>${fmt(n.distance_m, 1)}m / ${fmt(n.bearing_deg)}°</td><td>${fmt(n.floors)}</td><td>${fmt(n.height_m, 1)}m${n.height_source === 'floor_estimate' ? ' (추정)' : ''}</td><td>${esc(n.use || '—')}</td><td>${esc(n.approval_date || '—')}</td><td>${esc(({found:'확인',not_found:'자료 없음',not_requested:'미조회',multiple_records:'동 선택 필요',registry_key_missing:'키 필요'})[n.registry_status] || '조회 실패')}</td></tr>`).join('') + '</tbody>';
}
async function lookupBuilding(query) {
  const version = ++lookupVersion;
  lookupAbort?.abort(); lookupAbort = new AbortController();
  const timeout = setTimeout(() => lookupAbort.abort(), 180000);
  const button = $('#lookup-submit'); button.disabled = true;
  $('#site-select').disabled = true; $('#api-url').disabled = true;
  $('#lookup-choices').hidden = true;
  $('#building-search-note').textContent = '주소·건물 형상·주변 건물을 조회하고 있어요. 건축물대장까지 조회하면 잠시 걸릴 수 있어요.';
  try {
    const r = await fetch(`${rememberServer()}/api/buildings/lookup`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(query), signal:lookupAbort.signal});
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail?.message || `조회 요청에 실패했어요 (${r.status}). 서버를 다시 시작했는지 확인해 주세요.`);
    if (version !== lookupVersion) return;
    $('#building-search-note').textContent = data.message || '공공 데이터에서 건물을 불러왔어요. 실제 건물의 일사량·경제성 분석은 연결 전이에요.';
    if (data.status === 'select_building' || data.status === 'select_record') {
      const records = data.status === 'select_record';
      const box = $('#lookup-choices'); box.replaceChildren(); box.hidden = false;
      for (const c of data.candidates) {
        const b = document.createElement('button'); b.type = 'button';
        b.textContent = `${c.name || '이름 미제공'} ${c.dong_name || ''} · ${c.address || ''} · 지상 ${fmt(c.floors)}층${records ? ` · ${c.use || '용도 미제공'} · ${fmt(c.gfa_m2)}㎡` : ` · 주소 좌표에서 ${fmt(c.distance_m, 1)}m`}`;
        b.addEventListener('click', () => lookupBuilding({...query, building_id: records ? data.building_id : c.id, record_id: records ? c.id : undefined}));
        box.append(b);
      }
      return;
    }
    if (data.status !== 'ok') throw new Error('조회 결과의 형식을 확인하지 못했어요.');
    await displaySite(data.site, null); renderPublicData(data);
    $('#site-select').value = '';
  } catch (e) {
    if (version !== lookupVersion) return;
    const message = e.name === 'AbortError' ? '조회 시간이 초과됐어요. 다시 시도해 주세요.' : e instanceof TypeError ? '연구실 PC에 연결하지 못했어요. 서버와 터널 주소를 확인해 주세요.' : e.message;
    $('#building-search-note').textContent = `${message} 아래에는 이전에 불러온 건물이 표시돼요.`;
  } finally {
    clearTimeout(timeout);
    if (version === lookupVersion) { button.disabled = false; $('#site-select').disabled = false; $('#api-url').disabled = false; }
  }
}
$('#building-search').addEventListener('submit', e => {
  e.preventDefault(); lookupBuilding({address:$('#building-query').value.trim(), radius_m:Number($('#lookup-radius').value)});
});

// ---------- 2. 입면 사진 ----------
const face = () => S.site.faces.find(f => f.face_id === S.face);
const CORNERS = ['왼쪽 위', '오른쪽 위', '오른쪽 아래', '왼쪽 아래'];

function openPhoto() {
  const f = face();
  $('#photo-title').textContent = `${labelFace(f)} 사진`;
  $('#photo-hint').textContent = `건물 밖에서 ${labelFace(f)}을 정면으로 보고, 벽 전체가 들어오게 찍어 주세요.`;
  S.img = null; S.rectImg = null; S.corners = [];
  S.cells = S.cellsFrac[S.face] ? [...S.cellsFrac[S.face]] : null;
  $('#corner-box').hidden = true;
  $('#grid-box').hidden = true;
  $('#photo-reset').hidden = true;
  $('#photo-done').disabled = true;
  $('#photo-input').value = '';
  $('#photo-camera').value = '';
  show('photo');
}

async function loadPhoto(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';
  S.rectImg = null;
  $('#photo-done').disabled = true;
  $('#photo-reset').hidden = true;
  $('#corner-box').hidden = true;
  $('#grid-box').hidden = true;
  if (file.size > 20 * 1024 * 1024) { $('#photo-hint').textContent = '20MB 이하의 사진을 선택해 주세요.'; return; }
  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch { $('#photo-hint').textContent = '사진을 읽지 못했어요. JPG 또는 PNG 사진을 선택해 주세요.'; return; }
  const k = Math.min(1, MAX_SRC / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  S.img = c; S.corners = [];
  S.cells = null;
  $('#grid-box').hidden = true;
  $('#corner-box').hidden = false;
  $('#photo-done').disabled = true;
  drawCorners();
}
$('#photo-input').addEventListener('change', loadPhoto);
$('#photo-camera').addEventListener('change', loadPhoto);

function drawCorners() {
  const cv = $('#photo-canvas'), g = cv.getContext('2d');
  cv.width = S.img.width; cv.height = S.img.height;
  g.drawImage(S.img, 0, 0);
  const r = Math.max(6, S.img.width / 120);
  g.lineWidth = r / 2; g.strokeStyle = '#f2b300'; g.fillStyle = '#f2b300';
  g.beginPath();
  S.corners.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  if (S.corners.length === 4) g.closePath();
  g.stroke();
  S.corners.forEach(([x, y]) => { g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); });
  $('#corner-hint').textContent = S.corners.length < 4
    ? `벽의 ${CORNERS[S.corners.length]} 모서리를 누르세요 (${S.corners.length + 1}/4)`
    : '모서리 지정 완료';
}

$('#photo-canvas').addEventListener('click', e => {
  if (!S.img || S.corners.length >= 4) return;
  const cv = e.currentTarget, rc = cv.getBoundingClientRect();
  S.corners.push([(e.clientX - rc.left) * cv.width / rc.width, (e.clientY - rc.top) * cv.height / rc.height]);
  drawCorners();
  if (S.corners.length === 4) {
    $('#photo-reset').hidden = false;
    rectify();
  }
});

$('#photo-reset').addEventListener('click', () => {
  S.corners = []; S.cells = null;
  $('#grid-box').hidden = true; $('#photo-reset').hidden = true; $('#photo-done').disabled = true;
  drawCorners();
});

// 4점 대응으로 사영변환 행렬을 구한다 (from → to, h33 = 1)
function homography(from, to) {
  const A = [];
  from.forEach(([x, y], i) => {
    const [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u], [0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  });
  for (let c = 0; c < 8; c++) {           // 부분 피벗 가우스 소거
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    if (Math.abs(A[c][c]) < 1e-12) throw new Error('모서리 네 점이 한 줄에 있어요. 다시 지정해 주세요.');
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const m = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= m * A[c][k];
    }
  }
  return [...A.map((row, i) => row[8] / row[i]), 1];
}

function rectify() {
  const f = face();
  if (!validateCorners(S.corners)) {
    $('#corner-hint').textContent = '왼쪽 위 → 오른쪽 위 → 오른쪽 아래 → 왼쪽 아래 순서로 모서리를 다시 지정해 주세요.';
    return;
  }
  let W = Math.round(f.width_m * PPM), H = Math.round(f.height_m * PPM);
  const k = Math.min(1, 720 / W, 960 / H);
  W = Math.round(W * k); H = Math.round(H * k);
  let h;
  try { h = homography([[0, 0], [W, 0], [W, H], [0, H]], S.corners); }
  catch (err) { $('#corner-hint').textContent = err.message; return; }
  const src = S.img.getContext('2d').getImageData(0, 0, S.img.width, S.img.height);
  const cv = $('#rect-canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d'), out = g.createImageData(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = h[6] * x + h[7] * y + 1;
    const sx = Math.round((h[0] * x + h[1] * y + h[2]) / d), sy = Math.round((h[3] * x + h[4] * y + h[5]) / d);
    if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) continue;
    const i = (sy * src.width + sx) * 4, o = (y * W + x) * 4;
    out.data[o] = src.data[i]; out.data[o + 1] = src.data[i + 1]; out.data[o + 2] = src.data[i + 2]; out.data[o + 3] = 255;
  }
  S.rectImg = out;
  // shortcut: 분할 모델이 없어 모든 칸을 벽으로 시작한다. CNN이 붙으면 여기서 칸별 벽 비율을 채운다
  S.cells ??= Array(f.ns * f.nt).fill(1);
  $('#grid-box').hidden = false;
  $('#photo-done').disabled = false;
  drawGrid();
}

function drawGrid() {
  const f = face(), cv = $('#rect-canvas'), g = cv.getContext('2d');
  const cw = cv.width / f.ns, ch = cv.height / f.nt;
  const minH = S.params.min_annual_kwh_m2.value, annual = S.irr?.faces[f.face_id]?.annual;
  g.putImageData(S.rectImg, 0, 0);
  for (let t = 0; t < f.nt; t++) for (let s = 0; s < f.ns; s++) {
    const i = t * f.ns + s, x = s * cw, y = (f.nt - 1 - t) * ch, v = S.cells[i];
    if (annual && annual[i] < minH) {
      g.fillStyle = 'rgba(141,156,151,.6)'; g.fillRect(x, y, cw, ch);
      g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, y + ch); g.lineTo(x + cw, y); g.stroke();
    }
    if (v > 0) { g.fillStyle = 'rgba(242,179,0,.45)'; g.fillRect(x, y, cw * v, ch); }
    if (v < 1) { g.fillStyle = 'rgba(24,48,42,.6)'; g.fillRect(x + cw * v, y, cw * (1 - v), ch); }
    g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 1; g.strokeRect(x + .5, y + .5, cw - 1, ch - 1);
  }
  $('#open-ratio').textContent = `이 면의 창·간판 비율 ${Math.round((1 - mean(S.cells)) * 100)}% · 칸 하나 ${fmt(f.width_m / f.ns, 1)} × ${fmt(f.height_m / f.nt, 1)}m`;
}

$('#rect-canvas').addEventListener('click', e => {
  const f = face(), cv = e.currentTarget, rc = cv.getBoundingClientRect();
  const s = Math.floor((e.clientX - rc.left) / rc.width * f.ns);
  const t = f.nt - 1 - Math.floor((e.clientY - rc.top) / rc.height * f.nt);
  const i = t * f.ns + s;
  S.cells[i] = S.cells[i] === 1 ? 0 : S.cells[i] === 0 ? 0.5 : 1;
  drawGrid();
});

$('#photo-done').addEventListener('click', async () => {
  if (!S.rectImg || !S.cells) return;
  const button = $('#photo-done'), siteId = S.site.site_id, faceId = S.face;
  button.disabled = true;
  try {
    // Use the clean rectified photo, not the yellow installation-mask overlay.
    const canvas = document.createElement('canvas'); canvas.width = S.rectImg.width; canvas.height = S.rectImg.height;
    canvas.getContext('2d').putImageData(S.rectImg, 0, 0);
    const dataUrl = canvas.toDataURL('image/jpeg', .9), cells = [...S.cells];
    const image = new Image(); image.src = dataUrl; await image.decode();
    S.cellsFrac[faceId] = cells; S.textures[faceId] = {image, dataUrl};
    let saved = true;
    try { await saveFacade(siteId, faceId, {dataUrl, cells}); } catch { saved = false; }
    viewer.setPhotos(S.textures); drawFaceList(); pickFace(faceId);
    if (S.irr) $('#go-result').textContent = '데모 진단 결과 보기';
    $('#facade-status').textContent = saved ? `${labelFace(face())}에 사진을 입혔어요. 이 기기의 브라우저에 저장했어요.`
      : '사진을 입혔지만 브라우저에 저장하지 못했어요. 새로고침하면 사진이 사라질 수 있어요.';
    show('site'); viewer.faceFront();
    $('#building-canvas').scrollIntoView({block: 'center', behavior: 'instant'});
  } catch { $('#photo-hint').textContent = '사진을 입히지 못했어요. 다른 사진으로 다시 시도해 주세요.'; }
  finally { button.disabled = false; }
});
$('#photo-back').addEventListener('click', () => { drawFaceList(); show('site'); });

// ---------- 3. 결과 ----------
function showResult() {
  if (!S.irr) return;
  let r;
  try { r = evaluate({ site: S.site, irr: S.irr, params: S.params, cellsFrac: S.cellsFrac, annualKwh: null }); }
  catch (e) { $('#facade-status').textContent = e.message; return; }
  $('#result-source').textContent = S.site.source === 'public_api' ? '추정 분석 결과 · 계산에 쓴 가정과 한계를 확인하세요.' : '[가상 데모] 실제 주소의 분석 결과가 아니에요.';
  const t = r.total;
  $('#verdict').innerHTML = `<span class="badge b-${r.verdict}">${r.verdict}</span>
    <p>${esc(r.reasons[0])}</p>${r.reasons.length > 1 ? `<ul>${r.reasons.slice(1).map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}`;
  $('#metrics').innerHTML = `
    <div><span>설치 용량</span><b>${fmt(t.kw, 1)} kW</b></div>
    <div><span>연간 발전량</span><b>${fmt(t.kwh)} kWh</b></div>
    <div><span>자가소비율</span><b>${fmt(t.self_consumption * 100)}%</b></div>`;
  const maxY = Math.max(r.threshold * 1.6, ...[t.standalone, t.linked].filter(Number.isFinite));
  const bar = (label, y) => `<div class="pb-row"><span>${label}</span>
    <div class="pb-track"><div class="pb-bar${y <= r.threshold ? ' ok' : ''}" style="width:${Number.isFinite(y) ? Math.min(100, y / maxY * 100) : 100}%"></div>
    <div class="pb-t" style="left:${r.threshold / maxY * 100}%"></div></div><b>${Number.isFinite(y) ? `${fmt(y, 1)}년` : '회수 불가'}</b></div>`;
  $('#payback').innerHTML = bar('단독 설치', t.standalone) + bar('외피 연계', t.linked)
    + `<p class="pb-note">점선은 기준 ${r.threshold}년 · 외피 연계는 BIPV가 대신하는 외장재 비용을 뺀 값</p>`;
  const [lo, hi] = range();
  $('#face-result').innerHTML = r.faces.map(f => {
    const v = mean(S.irr.faces[f.face_id].annual);
    const sub = f.kw > 0
      ? `${fmt(f.area_m2)}㎡ · ${fmt(f.kwh)} kWh/년 · 회수 ${Number.isFinite(f.standalone) ? fmt(f.standalone, 1) : '–'} / 연계 ${Number.isFinite(f.linked) ? fmt(f.linked, 1) : '–'}년${f.photo ? ' · 사진 반영' : ''}`
      : '연간 일사 기준 미달로 설치 영역 없음';
    return `<li><span class="swatch" style="background:${color(v, lo, hi)}"></span>
      <span>${f.name}<span class="sub">${sub}</span></span>
      <span><span class="val">${f.kw > 0 ? `${fmt(f.kw, 1)} kW` : ''}</span> <span class="chip c-${f.verdict}">${f.verdict}</span></span></li>`;
  }).join('');
  $('#money').innerHTML = [
    ['설치비', t.cost], ['보조금', -t.subsidy], ['대체 외장재 비용 (외피 연계 시)', -t.cladding],
    ['연간 절감액', t.saving], ['연간 전력 사용량 (kWh)', t.usage_kwh],
  ].map(([k, v]) => `<tr><td>${k}</td><td>${fmt(v)}${k.includes('kWh') ? '' : ' 원'}</td></tr>`).join('');
  $('#assumptions').innerHTML = r.assumptions.map(a => `<li>${esc(a)}</li>`).join('');
  show('result');
}

$('#go-photo').addEventListener('click', openPhoto);
$('#go-result').addEventListener('click', showResult);
$('#again').addEventListener('click', () => { drawFaceList(); show('site'); });
$('#print').addEventListener('click', () => print());
addEventListener('beforeprint', () => document.querySelectorAll('details').forEach(d => { d.open = true; }));

// ---------- 시작 ----------
(async () => {
  try {
    const [params, index] = await Promise.all([getJSON('params.json'), getJSON('data/sites/index.json')]);
    S.params = params;
    S.index = index;
    let savedUrl = '';
    try { savedUrl = localStorage.getItem('solarcheck-api-url') || ''; } catch { /* optional */ }
    $('#api-url').value = new URLSearchParams(location.search).get('api') || savedUrl || (location.protocol === 'http:' ? 'http://127.0.0.1:8000' : '');
    if ($('#api-url').value) checkServer();
    $('#site-select').innerHTML = index.map(s => `<option value="${esc(s.site_id)}">${esc(s.name)} — ${esc(s.address)}</option>`).join('');
    $('#site-select').addEventListener('change', async e => {
      try { await loadSite(e.target.value); $('#lookup-choices').hidden = true; $('#building-search-note').textContent = '아래는 가상 데모 건물이에요. 주소 자동 조회 결과와 구분해 주세요.'; }
      catch (err) { $('#building-search-note').textContent = err.message; }
    });
    await loadSite(index[0].site_id);
    $('#lookup-submit').disabled = false;
    show('site');
  } catch (err) {
    $('main').innerHTML = `<h1>데이터를 불러오지 못했어요</h1><p class="hint">${esc(err.message)}. 로컬에서는 docs 폴더에서 python -m http.server 로 띄워 주세요.</p>`;
  }
})();

