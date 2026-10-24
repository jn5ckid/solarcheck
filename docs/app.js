import { evaluate, faceName, openingRatio } from './calc.js?v=20261024-research-cleanup';
import { FacadeViewer } from './facade-viewer.js?v=20261024-research-cleanup';
import { clampImagePoint, nearestCornerIndex, rectifiedSize, validateCorners } from './facade-geometry.js?v=20261024-perspective-mask';
import { loadFacades, saveFacade, removeFacade } from './facade-store.js';
import { analyzeFacadeOpenings, closestFacadeByAzimuth } from './facade-openings.js?v=20261024-auto-openings';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const fmt = (x, d = 0) => Number.isFinite(x) ? x.toLocaleString('ko-KR', { maximumFractionDigits: d, minimumFractionDigits: d }) : '–';
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const PPM = 20;          // 보정 영상 해상도 (px/m), 화면 폭에 맞춰 줄인다
const MAX_SRC = 1600;    // 사진 긴 변 최대 px

const S = { params: null, site: null, irr: null, face: null, cellsFrac: {}, img: null, corners: [], cells: null,
  textures: {}, mode: 'site', publicSite: null, researchOverview: null, researchBuilding: null, researchSensors: [], researchGroup: null,
  researchMonthly: null, researchAddress: null, analysisGrid: null, candidatePrediction: null, dragCorner: null };
const viewer = new FacadeViewer($('#building-canvas'), id => pickFace(id), sensor => showResearchSensor(sensor));
let siteLoadVersion = 0;

const labelFace = f => `${faceName(f)}${S.site?.source === 'public_api' ? ` · ${f.face_id}` : ''}`;
const photoSite = () => S.mode === 'research' ? S.publicSite : S.site;
const face = () => photoSite()?.faces.find(f => f.face_id === S.face);
const selectedResearchGroup = () => S.researchBuilding?.surface_groups
  .find(group => group.surface_group_id === S.researchGroup) || null;
const photoFaceLabel = () => S.mode === 'research' && selectedResearchGroup()
  ? researchSurfaceLabel(selectedResearchGroup()) : labelFace(face());
const researchPhotoFace = group => group?.surface_type === 'Roof' ? null
  : closestFacadeByAzimuth(S.publicSite?.faces, group?.normal_azimuth_bin_deg);

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
const CARDINAL_LABELS = ['북측', '북동측', '동측', '남동측', '남측', '남서측', '서측', '북서측'];
function researchSurfaceLabel(group) {
  if (group.surface_type === 'Roof') return '지붕';
  const azimuth = ((Number(group.normal_azimuth_bin_deg) || 0) % 360 + 360) % 360;
  return `${CARDINAL_LABELS[Math.round(azimuth / 45) % CARDINAL_LABELS.length]} 입면`;
}
const range = () => {
  if (!S.irr) return [0, 1];
  const all = Object.values(S.irr.faces).flatMap(f => f.annual);
  return [Math.min(...all), Math.max(...all)];
};

function buildingInfo(site) {
  const b = site.building;
  const heightNote = b.height_source === 'floor_estimate' ? ' (층수로 추정)' : '';
  const text = value => esc(value ?? '확인 필요');
  return `<dt>사용승인일</dt><dd>${text(b.approval_date || (b.approval_year ? `${b.approval_year}년` : null))}</dd>
    <dt>주용도</dt><dd>${text(b.use)}</dd>
    <dt>세부 용도</dt><dd>${text(b.other_use)}</dd>
    <dt>층수</dt><dd>지상 ${fmt(b.floors)} / 지하 ${fmt(b.basement_floors)}층</dd>
    <dt>연면적</dt><dd>${fmt(b.gfa_m2, 1)}㎡</dd>
    <dt>건축 / 대지면적</dt><dd>${fmt(b.building_area_m2, 1)} / ${fmt(b.land_area_m2, 1)}㎡</dd>
    <dt>높이</dt><dd>${b.height_m ? `${fmt(b.height_m, 1)}m${heightNote}` : '확인 필요'}</dd>
    <dt>구조</dt><dd>${text(b.structure)}</dd>
    <dt>주변 건물</dt><dd>${site.context.length}동 반영</dd>`;
}

async function restoreFacadePhotos(site) {
  let stored = [], storageAvailable = true;
  try { stored = await loadFacades(site.site_id); }
  catch { storageAvailable = false; }
  const restored = await Promise.all(stored.map(async record => {
    const facade = site.faces.find(item => item.face_id === record.faceId && item.type === 'facade');
    if (!facade || !Array.isArray(record.cells) || record.cells.length !== facade.ns * facade.nt
      || record.cells.some(x => !Number.isFinite(x) || x < 0 || x > 1)
      || !/^data:image\/(jpeg|png);base64,/.test(record.dataUrl)) return null;
    try {
      const image = new Image(); image.src = record.dataUrl; await image.decode();
      return {record, image};
    } catch { return null; }
  }));
  for (const entry of restored.filter(Boolean)) {
    S.textures[entry.record.faceId] = {image: entry.image, dataUrl: entry.record.dataUrl};
    S.cellsFrac[entry.record.faceId] = entry.record.cells;
  }
  viewer.setPhotos(S.textures);
  return {storageAvailable, count: Object.keys(S.textures).length};
}

// ---------- 1. 건물 ----------
async function displaySite(site, irr, version = ++siteLoadVersion) {
  ++researchVersion; ++researchMonthlyVersion;
  const id = site.site_id;
  S.mode = 'site'; S.site = site; S.publicSite = site; S.irr = irr; S.researchBuilding = null; S.researchSensors = []; S.researchGroup = null;
  S.researchAddress = null;
  S.researchMonthly = null; $('#research-monthly-panel').hidden = true;
  S.face = null; S.cellsFrac = {}; S.textures = {};
  viewer.setSite(site); viewer.setContext($('#model-context').checked);
  $('#model-draft').checked = false; $('#model-draft').disabled = true;
  $('#model-heatmap').checked = false; $('#model-heatmap').disabled = true;
  $('#building-canvas').setAttribute('aria-label', '건물 3D 입면 보기. 드래그 또는 방향키로 회전하고 휠이나 더하기·빼기 키로 확대하세요.');
  $('#research-legend').hidden = true;
  $('#building-caption').textContent = '건물을 돌려 보고 사진을 붙일 벽면을 선택하세요.';
  $('#face-list-title').textContent = '사진을 촬영·적용할 입면을 고르세요';
  $('#model-context').disabled = false;
  $('#go-photo').textContent = '선택한 입면 사진 촬영·선택';
  $('#go-photo').hidden = false; $('#go-result').hidden = false; $('#check-surrogate').hidden = false;
  $('#building-actions').hidden = false;
  $('#building-result').hidden = false;
  $('#loaded-building-name').textContent = `${site.name} · ${site.address}`;
  $('#registry-info-title').hidden = false;
  $('#site-info').hidden = false;
  $('#site-info').innerHTML = buildingInfo(site);
  $('#public-data-details').hidden = !!irr;
  $('#go-result').disabled = !irr;
  $('#go-result').textContent = irr ? '사진 없이 데모 결과 보기' : '일사량 분석 연결 전';
  drawFaceList();
  $('#go-photo').disabled = true;
  $('#model-front').disabled = true;
  $('#remove-photo').hidden = true;
  $('#facade-status').textContent = '저장된 입면 사진을 확인하고 있어요.';
  const {storageAvailable, count} = await restoreFacadePhotos(site);
  if (version !== siteLoadVersion) return;
  drawFaceList();
  $('#facade-status').textContent = !storageAvailable ? '사진 저장소를 사용할 수 없어 현재 화면에만 사진을 입힐 수 있어요.'
    : count ? `이 건물의 입면 ${count}곳에 저장된 사진을 불러왔어요.`
      : '입면을 고르고 사진의 네 모서리를 지정하면 해당 벽면에 입혀요. 사진은 이 기기에 저장돼요.';
  if (irr) $('#go-result').textContent = count ? '데모 진단 결과 보기' : '사진 없이 데모 결과 보기';
  if (!site.faces.length) $('#facade-status').textContent = '높이가 없어 사진을 붙일 입면을 만들지 못했어요. 건물의 높이 또는 지상층수 확인이 필요해요.';
  drawIrradianceGrid();
}

function drawFaceList() {
  if (S.mode === 'research') { drawResearchGroups(); return; }
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
$('#model-draft').addEventListener('change', e => { viewer.setPoints(e.target.checked); viewer.setDraft(e.target.checked); });
$('#model-heatmap').addEventListener('change', e => viewer.setHeatmap(e.target.checked));
$('#remove-photo').addEventListener('click', async () => {
  const siteId = photoSite().site_id, id = S.face;
  try { await removeFacade(siteId, id); }
  catch { $('#facade-status').textContent = '저장된 사진을 지우지 못했어요. 다시 시도해 주세요.'; return; }
  if (photoSite()?.site_id !== siteId) return;
  delete S.textures[id]; delete S.cellsFrac[id];
  viewer.setPhotos(S.textures); drawFaceList();
  if (S.mode === 'research') {
    $('#remove-photo').hidden = true;
    $('#facade-status').textContent = `${photoFaceLabel()} 사진과 자동 판별 결과를 지웠어요.`;
  } else {
    pickFace(id);
    if (S.irr) $('#go-result').textContent = Object.keys(S.textures).length ? '데모 진단 결과 보기' : '사진 없이 데모 결과 보기';
    $('#facade-status').textContent = `${labelFace(face())} 사진을 지웠어요.`;
  }
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
    $('#surrogate-status').textContent = `${data.research_inference_ready ? '연구용 시간별 모델 준비됨' : '연구 모델 자료·실행 환경 확인 필요'} · 연구 대상지 내 주소는 건물 외곽 매칭 후 분석. ${(data.blockers ?? []).map(b => b.message).join(' ')}`;
  } catch (e) {
    if (version === modelStatusVersion) $('#surrogate-status').textContent = `모델 상태를 확인하지 못했어요. ${e instanceof TypeError ? '연구실 PC 서버에 연결하지 못했어요.' : e.message}`;
  }
}
$('#check-surrogate').addEventListener('click', checkSurrogate);

// Frozen original-research-site data is loaded only after a public address match.
let researchVersion = 0;
async function researchJSON(path, signal) {
  const r = await fetch(`${rememberServer()}${path}`, {signal});
  const data = await r.json();
  if (!r.ok) throw new Error(data.detail?.message || `연구 대상지 자료를 불러오지 못했어요 (${r.status}).`);
  return data;
}
async function predictCandidateGrid(siteId, version) {
  const candidates = S.analysisGrid?.sensors || [];
  if (!candidates.length) return;
  $('#surrogate-status').textContent = 'E2c 연간 일사량을 예측하고 있어요…';
  $('#facade-status').textContent = '분석 위치는 화면에서만 표면 바깥으로 0.05m 띄워 표시하며, 현재 일사량을 예측 중이에요…';
  try {
    const result = await researchJSON(
      `/api/research-site/candidate-grids/${encodeURIComponent(siteId)}/irradiance`,
      AbortSignal.timeout(180000),
    );
    if (version !== researchVersion) return;
    const byId = new Map(result.items.map(item => [item.candidate_id, item.annual_prediction_kwh_m2_year]));
    const [lo, hi] = S.researchOverview.annual_prediction_range_kwh_m2_year;
    for (const sensor of candidates) {
      const annual = byId.get(sensor.candidate_id);
      if (!Number.isFinite(annual)) continue;
      sensor.annual_prediction_kwh_m2_year = annual;
      sensor.color = color(annual, lo, hi);
    }
    S.candidatePrediction = result;
    $('#model-heatmap').checked = true; $('#model-heatmap').disabled = false; viewer.setHeatmap(true);
    $('#model-draft').checked = false; viewer.setPoints(false); viewer.setDraft(false);
    $('#surrogate-status').textContent = `E2c 연간 예측 완료 · 평균 ${fmt(result.annual_mean, 1)} kWh/㎡·년 · 범위 ${fmt(result.annual_min, 1)}–${fmt(result.annual_max, 1)}`;
    $('#facade-status').textContent = '예측값을 대상 건물 면 컬러맵으로 표시했어요.';
    $('#building-caption').textContent = `대상 건물은 1.5m 후보 센서의 E2c 연간 예측값을 면별 패치로 표시해요. 주변 건물은 단색이며, 센서 포인트를 켜면 원래 연구 XYZ 위치도 확인할 수 있어요.`;
  } catch (error) {
    if (version !== researchVersion) return;
    $('#surrogate-status').textContent = `E2c 예측을 완료하지 못했어요. ${error.message}`;
    $('#facade-status').textContent = '분석 위치는 청록 테두리로 표시했어요. 계산 좌표는 유지하고 화면에서만 0.05m 이격했어요.';
  }
}
async function loadResearchBuilding(buildingId, context = {}) {
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(buildingId)) throw new Error('연구 건물 ID 형식을 확인해 주세요.');
  ++siteLoadVersion;
  const version = ++researchVersion;
  $('#building-search-note').textContent = `${buildingId} 센서와 연간 예측을 불러오고 있어요…`;
  {
    const [overview, building] = await Promise.all([
      S.researchOverview ? Promise.resolve(S.researchOverview) : researchJSON('/api/research-site', AbortSignal.timeout(20000)),
      researchJSON(`/api/research-site/buildings/${encodeURIComponent(buildingId)}`, AbortSignal.timeout(20000)),
    ]);
    S.researchOverview = overview;
    const pages = await Promise.all(building.surface_groups.map(group => researchJSON(
      `/api/research-site/surface-groups/${encodeURIComponent(group.surface_group_id)}/sensors?offset=0&limit=2000`,
      AbortSignal.timeout(20000))));
    if (version !== researchVersion) return;
    const [lo, hi] = S.researchOverview.annual_prediction_range_kwh_m2_year;
    const sensors = pages.flatMap(page => page.items.map(sensor => ({...sensor,
      surface_group_id: page.surface_group.surface_group_id, surface_type: page.surface_group.surface_type,
      color: color(sensor.annual_prediction_kwh_m2_year, lo, hi)})));
    if (sensors.length !== building.sensor_count) throw new Error('건물 센서 개수가 매핑 패키지와 일치하지 않아요.');
    S.mode = 'research'; S.site = null; S.publicSite = context.publicSite || null; S.irr = null; S.face = null; S.researchBuilding = building;
    S.researchSensors = sensors; S.researchGroup = null; S.researchMonthly = null;
    S.researchAddress = context.address || null; S.analysisGrid = context.analysisGrid || null; S.candidatePrediction = null; ++researchMonthlyVersion;
    S.cellsFrac = {}; S.textures = {};
    if (S.publicSite) await restoreFacadePhotos(S.publicSite);
    if (version !== researchVersion) return;
    const requestedRadius = Number(context.radiusM);
    const contextRadiusM = [100, 200, 300].includes(requestedRadius) ? requestedRadius : 200;
    viewer.setResearch({sensors, site: S.publicSite,
      anchor_xy: context.match?.public_centroid_xy_m || [0, 0], context_radius_m: contextRadiusM,
      cell_target_m: S.analysisGrid?.cell_target_m || 1.5,
      draftSensors: S.analysisGrid?.sensors || []});
    $('#building-result').hidden = false;
    $('#building-canvas').setAttribute('aria-label', `${building.building_id} 대상 건물의 연간 일사량 면 컬러맵 3D 보기. 센서 포인트 표시는 선택해서 켤 수 있습니다.`);
    $('#loaded-building-name').textContent = context.address || '연구 대상지 건물';
    $('#registry-info-title').hidden = !S.publicSite;
    $('#site-info').hidden = !S.publicSite;
    $('#site-info').innerHTML = S.publicSite ? buildingInfo(S.publicSite) : '';
    $('#public-data-details').hidden = !S.publicSite;
    $('#building-caption').textContent = S.publicSite
      ? `대상·반경 ${contextRadiusM}m 주변 건물은 평면 지면 기준이에요. 센서 점은 화면에서만 법선 방향 0.05m 이격하며, 주변 건물을 켜면 크기가 1/5로 줄어요.`
      : '센서 점을 누르면 연간 예측값을 확인할 수 있어요. 드래그로 회전하고 휠로 확대하세요.';
    $('#research-legend').hidden = false;
    $('#research-legend-low').textContent = `${fmt(lo)} kWh/㎡·년`;
    $('#research-legend-high').textContent = `${fmt(hi)} kWh/㎡·년`;
    $('#face-list-title').textContent = '입면별 연평균 일사량';
    $('#model-context').checked = !!S.publicSite; $('#model-context').disabled = !S.publicSite;
    viewer.setContext(!!S.publicSite);
    const candidateCount = S.analysisGrid?.sensor_count || 0;
    $('#model-draft').checked = candidateCount > 0; $('#model-draft').disabled = candidateCount === 0;
    viewer.setPoints(true); viewer.setDraft(candidateCount > 0);
    $('#model-heatmap').checked = false; $('#model-heatmap').disabled = true; viewer.setHeatmap(false);
    $('#model-front').disabled = true; $('#go-photo').disabled = true; $('#remove-photo').hidden = true;
    $('#building-actions').hidden = !S.publicSite;
    $('#go-photo').hidden = false; $('#go-photo').textContent = '입면을 선택하면 사진을 분석할 수 있어요';
    $('#go-result').hidden = true; $('#check-surrogate').hidden = true;
    $('#irradiance-grid').hidden = true;
    $('#research-monthly-panel').hidden = true;
    $('#surrogate-status').textContent = candidateCount
      ? '분석 좌표·표면 방향·차폐각 생성 완료, E2c 예측을 시작해요.'
      : '검증된 동일 대상지의 E2c 연간 예측을 표시해요.';
    drawResearchGroups();
    $('#facade-status').textContent = S.publicSite
      ? '기존 연구 일사량과 신규 면 분석 위치를 함께 표시했어요.'
      : '기존 연구 일사량을 표시했어요.';
    $('#building-search-note').textContent = '';
    $('#building-search-note').hidden = true;
    if (candidateCount && S.publicSite?.site_id) await predictCandidateGrid(S.publicSite.site_id, version);
  }
}
function drawResearchGroups() {
  if (!S.researchBuilding) return;
  const [lo, hi] = S.researchOverview.annual_prediction_range_kwh_m2_year;
  const groups = S.researchBuilding.surface_groups;
  const buildingMean = mean(S.researchSensors.map(sensor => sensor.annual_prediction_kwh_m2_year));
  $('#face-list').innerHTML = `<li><button data-research-group="" aria-controls="research-monthly-panel" aria-pressed="${S.researchGroup === null}">
    <span class="swatch research-all"></span><span>건물 전체 평균<span class="sub">지붕·입면 종합</span></span>
    <span class="val">${fmt(buildingMean)}<span class="sub">kWh/㎡·년</span></span></button></li>`
    + groups.map(group => {
      const mappedFace = researchPhotoFace(group), mask = mappedFace && S.cellsFrac[mappedFace.face_id];
      const photoNote = mask ? ` · 창문·문 ${Math.round((1 - mean(mask)) * 100)}% 반영` : '';
      return `<li><button data-research-group="${esc(group.surface_group_id)}" aria-controls="research-monthly-panel" aria-pressed="${S.researchGroup === group.surface_group_id}">
      <span class="swatch" style="background:${color(group.annual_prediction_mean, lo, hi)}"></span>
      <span>${researchSurfaceLabel(group)}<span class="sub">방위 ${fmt(group.normal_azimuth_bin_deg)}° · 경사 ${fmt(group.normal_tilt_bin_deg)}°${photoNote}</span></span>
      <span class="val">${fmt(group.annual_prediction_mean)}<span class="sub">kWh/㎡·년</span></span></button></li>`;
    }).join('');
  $('#face-list').querySelectorAll('[data-research-group]').forEach(button => button.addEventListener('click', () => {
    S.researchGroup = button.dataset.researchGroup || null;
    viewer.setResearchGroup(S.researchGroup); viewer.selectResearchSensor(null); drawResearchGroups();
    const selectedGroup = groups.find(group => group.surface_group_id === S.researchGroup);
    const mappedFace = researchPhotoFace(selectedGroup);
    S.face = mappedFace?.face_id || null;
    $('#go-photo').disabled = !mappedFace;
    $('#go-photo').textContent = mappedFace
      ? `${researchSurfaceLabel(selectedGroup)} 사진 ${S.textures[mappedFace.face_id] ? '촬영·교체' : '촬영·선택'}`
      : selectedGroup?.surface_type === 'Roof' ? '지붕 사진 분석은 지원하지 않아요' : '입면을 선택하면 사진을 분석할 수 있어요';
    $('#remove-photo').hidden = !mappedFace || !S.textures[mappedFace.face_id];
    $('#facade-status').textContent = selectedGroup
      ? `${researchSurfaceLabel(selectedGroup)} · 연평균 ${fmt(selectedGroup.annual_prediction_mean)} kWh/㎡·년`
      : `건물 전체 평균 · ${fmt(buildingMean)} kWh/㎡·년`;
    void loadResearchMonthly(selectedGroup || null);
  }));
}
function showResearchSensor(sensor) {
  $('#facade-status').textContent = `${sensor.surface_type === 'Roof' ? '지붕' : '입면'} 분석 위치 · 연평균 ${fmt(sensor.annual_prediction_kwh_m2_year, 1)} kWh/㎡·년`;
}
let researchMonthlyVersion = 0;
async function loadResearchMonthly(group) {
  if (!S.researchBuilding) return;
  const version = ++researchMonthlyVersion;
  const buildingId = S.researchBuilding.building_id;
  const groupId = group?.surface_group_id || null;
  const label = group ? researchSurfaceLabel(group) : '건물 전체';
  const panel = $('#research-monthly-panel'); panel.hidden = false;
  $('#research-monthly-title').textContent = `${label} 월평균 일사량`;
  $('#research-monthly-summary').textContent = 'E2c의 연중 시간별 결과를 월별로 적산하고 선택 표면 전체의 평균을 계산해요.';
  $('#research-monthly-chart').innerHTML = '';
  $('#research-monthly-status').textContent = '월별 일사량을 계산하고 있어요…';
  try {
    const query = groupId ? `?surface_group_id=${encodeURIComponent(groupId)}` : '';
    const data = await researchJSON(
      `/api/research-site/buildings/${encodeURIComponent(buildingId)}/monthly-irradiance${query}`,
      AbortSignal.timeout(180000),
    );
    if (version !== researchMonthlyVersion || S.researchGroup !== groupId) return;
    S.researchMonthly = data;
    renderResearchMonthly(data, label);
  } catch (error) {
    if (version === researchMonthlyVersion) $('#research-monthly-status').textContent = error instanceof TypeError
      ? '연구실 PC 서버에 연결하지 못했어요.' : error.message;
  }
}
function renderResearchMonthly(data, label) {
  const peak = Math.max(...data.series.map(row => row.irradiance_kwh_m2_month), 1);
  const chart = $('#research-monthly-chart');
  chart.setAttribute('aria-label', `${label} 1월부터 12월까지 월평균 일사량 막대 차트`);
  chart.innerHTML = data.series.map(row => {
    const value = row.irradiance_kwh_m2_month;
    return `<div class="research-monthly-bar" data-month="${row.month}월" data-value="${fmt(value, 1)}" title="${row.month}월 ${fmt(value, 1)} kWh/㎡·월" style="--bar-height:${Math.max(2, value / peak * 100)}%;--bar-color:${color(value, 0, peak)}"></div>`;
  }).join('');
  $('#research-monthly-summary').textContent = `${label} · 연간 합계 ${fmt(data.annual_mean_kwh_m2_year, 1)} kWh/㎡·년`;
  $('#research-monthly-status').textContent = `${data.weather} · 단위 kWh/㎡·월`;
}

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
  $('#api-url').disabled = true;
  $('#lookup-choices').hidden = true;
  $('#building-search-note').hidden = false;
  $('#building-search-note').textContent = '주소·건물 형상·주변 건물을 조회하고 있어요. 건축물대장까지 조회하면 잠시 걸릴 수 있어요.';
  try {
    const r = await fetch(`${rememberServer()}/api/buildings/lookup`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(query), signal:lookupAbort.signal});
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail?.message || `조회 요청에 실패했어요 (${r.status}). 서버를 다시 시작했는지 확인해 주세요.`);
    if (version !== lookupVersion) return;
    $('#building-search-note').textContent = data.message || '공공 데이터에서 건물을 불러왔어요. 연구 대상지 기존 건물과 검증 매칭되면 일사량을 연결해요.';
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
    if (data.research_match?.status === 'matched') {
      renderPublicData(data);
      await loadResearchBuilding(data.research_match.building_id, {
        address: data.site.address, match: data.research_match, publicSite: data.site,
        analysisGrid: data.analysis_grid, radiusM: data.radius_m,
      });
      $('#building-search-note').textContent = '';
      $('#building-search-note').hidden = true;
    } else {
      await displaySite(data.site, null); renderPublicData(data);
      if (data.research_match?.message) $('#building-search-note').textContent = `${data.research_match.message} 공공 건물 정보만 표시합니다.`;
    }
  } catch (e) {
    if (version !== lookupVersion) return;
    const message = e.name === 'AbortError' ? '조회 시간이 초과됐어요. 다시 시도해 주세요.' : e instanceof TypeError ? '연구실 PC에 연결하지 못했어요. 서버와 터널 주소를 확인해 주세요.' : e.message;
    $('#building-search-note').textContent = `${message} 아래에는 이전에 불러온 건물이 표시돼요.`;
  } finally {
    clearTimeout(timeout);
    if (version === lookupVersion) { button.disabled = false; $('#api-url').disabled = false; }
  }
}
$('#building-search').addEventListener('submit', e => {
  e.preventDefault(); lookupBuilding({address:$('#building-query').value.trim(), radius_m:Number($('#lookup-radius').value)});
});

// ---------- 2. 입면 사진 ----------
const CORNERS = ['왼쪽 위', '오른쪽 위', '오른쪽 아래', '왼쪽 아래'];

function openPhoto() {
  const f = face();
  $('#photo-title').textContent = `${photoFaceLabel()} 사진`;
  $('#photo-hint').textContent = `건물 밖에서 ${photoFaceLabel()}을 정면으로 보고, 벽 전체가 들어오게 찍어 주세요.`;
  S.img = null; S.rectImg = null; S.corners = []; S.dragCorner = null;
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
  S.img = c; S.corners = []; S.dragCorner = null;
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
  if (S.corners.length === 4) {
    g.save();
    g.fillStyle = 'rgba(8,24,20,.52)';
    g.beginPath(); g.rect(0, 0, cv.width, cv.height);
    S.corners.forEach(([x, y], index) => index ? g.lineTo(x, y) : g.moveTo(x, y));
    g.closePath(); g.fill('evenodd'); g.restore();
  }
  g.lineWidth = r / 2; g.strokeStyle = '#f2b300'; g.fillStyle = '#f2b300';
  g.beginPath();
  S.corners.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  if (S.corners.length === 4) g.closePath();
  g.stroke();
  S.corners.forEach(([x, y], index) => {
    g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    g.fillStyle = '#18302a'; g.font = `bold ${Math.max(11, r * 1.35)}px system-ui`;
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(index + 1), x, y);
    g.fillStyle = '#f2b300';
  });
  cv.classList.toggle('corners-ready', S.corners.length === 4);
  $('#corner-hint').textContent = S.corners.length < 4
    ? `벽의 ${CORNERS[S.corners.length]} 모서리를 누르세요 (${S.corners.length + 1}/4)`
    : '선택 영역 밖은 분석에서 제외돼요. 네 점을 드래그해 벽 경계를 맞춘 뒤 아래 직사각형 보정 결과를 확인하세요.';
}

const canvasPoint = (canvas, event) => {
  const rect = canvas.getBoundingClientRect();
  return clampImagePoint([
    (event.clientX - rect.left) * canvas.width / rect.width,
    (event.clientY - rect.top) * canvas.height / rect.height,
  ], canvas.width, canvas.height);
};

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

$('#photo-canvas').addEventListener('pointerdown', e => {
  if (!S.img || S.corners.length !== 4) return;
  const cv = e.currentTarget;
  const index = nearestCornerIndex(S.corners, canvasPoint(cv, e), Math.max(20, cv.width / 32));
  if (index < 0) return;
  e.preventDefault();
  S.dragCorner = {index, pointerId: e.pointerId, start: S.corners.map(point => [...point])};
  cv.setPointerCapture?.(e.pointerId); cv.classList.add('dragging');
});

$('#photo-canvas').addEventListener('pointermove', e => {
  if (!S.dragCorner || S.dragCorner.pointerId !== e.pointerId) return;
  e.preventDefault();
  S.corners[S.dragCorner.index] = canvasPoint(e.currentTarget, e);
  drawCorners();
});

function finishCornerDrag(canvas, cancelled = false) {
  if (!S.dragCorner) return;
  const previous = S.dragCorner.start;
  canvas.releasePointerCapture?.(S.dragCorner.pointerId);
  canvas.classList.remove('dragging'); S.dragCorner = null;
  if (cancelled || !validateCorners(S.corners)) {
    S.corners = previous; drawCorners();
    $('#corner-hint').textContent = '네 점이 교차하지 않도록 벽 모서리 안에서 조정해 주세요.';
    return;
  }
  S.cells = null;
  drawCorners(); rectify();
}

$('#photo-canvas').addEventListener('pointerup', e => {
  if (S.dragCorner?.pointerId === e.pointerId) finishCornerDrag(e.currentTarget);
});
$('#photo-canvas').addEventListener('pointercancel', e => {
  if (S.dragCorner?.pointerId === e.pointerId) finishCornerDrag(e.currentTarget, true);
});

$('#photo-reset').addEventListener('click', () => {
  S.corners = []; S.cells = null; S.dragCorner = null;
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
  const [W, H] = rectifiedSize(f.width_m, f.height_m, PPM);
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
  $('#rectify-hint').textContent = `실제 입면 ${fmt(f.width_m, 1)} × ${fmt(f.height_m, 1)}m 비율로 ${W} × ${H}px 직사각형에 보정했어요.`;
  if (!S.cells) {
    const proposal = analyzeFacadeOpenings(out, f.ns, f.nt);
    S.cells = proposal.cells;
    const candidates = proposal.windowCount + proposal.doorCount;
    $('#photo-hint').textContent = candidates || proposal.uncertainCount
      ? `자동 판별 완료: 창문·문 후보 ${candidates}칸, 확인 필요 ${proposal.uncertainCount}칸. 격자를 눌러 수정해 주세요.`
      : '자동 판별에서 뚜렷한 창문·문 후보를 찾지 못했어요. 격자를 눌러 직접 제외할 수 있어요.';
  }
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
  $('#open-ratio').textContent = `자동 판별·보정된 창문·문 비율 ${Math.round((1 - mean(S.cells)) * 100)}% · 칸 하나 ${fmt(f.width_m / f.ns, 1)} × ${fmt(f.height_m / f.nt, 1)}m`;
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
  const button = $('#photo-done'), siteId = photoSite().site_id, faceId = S.face;
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
    viewer.setPhotos(S.textures); drawFaceList();
    if (S.mode !== 'research') pickFace(faceId);
    else {
      $('#remove-photo').hidden = false;
      $('#facade-status').textContent = `${photoFaceLabel()}의 창문·문 후보를 자동 판별해 저장했어요.`;
    }
    if (S.irr) $('#go-result').textContent = '데모 진단 결과 보기';
    if (S.mode !== 'research') $('#facade-status').textContent = saved ? `${labelFace(face())}에 사진을 입혔어요. 이 기기의 브라우저에 저장했어요.`
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
    S.params = await getJSON('params.json');
    let savedUrl = '';
    try { savedUrl = localStorage.getItem('solarcheck-api-url') || ''; } catch { /* optional */ }
    $('#api-url').value = new URLSearchParams(location.search).get('api') || savedUrl || (location.protocol === 'http:' ? 'http://127.0.0.1:8000' : '');
    if ($('#api-url').value) checkServer();
    $('#building-result').hidden = true;
    $('#lookup-submit').disabled = false;
    show('site');
  } catch (err) {
    $('main').innerHTML = `<h1>데이터를 불러오지 못했어요</h1><p class="hint">${esc(err.message)}. 로컬에서는 docs 폴더에서 python -m http.server 로 띄워 주세요.</p>`;
  }
})();

