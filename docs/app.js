import { evaluate, faceName } from './calc.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const fmt = (x, d = 0) => Number.isFinite(x) ? x.toLocaleString('ko-KR', { maximumFractionDigits: d, minimumFractionDigits: d }) : '–';
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const PPM = 20;          // 보정 영상 해상도 (px/m), 화면 폭에 맞춰 줄인다
const MAX_SRC = 1600;    // 사진 긴 변 최대 px

const S = { params: null, site: null, irr: null, face: null, cellsFrac: {}, img: null, corners: [], cells: null };

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
}
// 일사량 색: 음영(회청) → 햇빛(노랑) → 강한 일사(주황)
const RAMP = [[96, 112, 120], [150, 160, 150], [242, 179, 0], [232, 110, 30]];
function color(v, lo, hi) {
  const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo))) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(t)), w = t - i;
  return `rgb(${RAMP[i].map((c, k) => Math.round(c + (RAMP[i + 1][k] - c) * w))})`;
}
const range = () => {
  const all = Object.values(S.irr.faces).flatMap(f => f.annual);
  return [Math.min(...all), Math.max(...all)];
};

// ---------- 1. 건물 ----------
async function loadSite(id) {
  [S.site, S.irr] = await Promise.all([
    getJSON(`data/sites/${id}/site.json`), getJSON(`data/sites/${id}/irradiance.json`)]);
  S.face = null; S.cellsFrac = {};
  const b = S.site.building, age = new Date().getFullYear() - b.approval_year;
  $('#site-info').innerHTML = `
    <dt>사용승인</dt><dd>${b.approval_year ? `${b.approval_year}년 · ${age}년 경과${age >= 15 ? '<span class="tag">노후</span>' : ''}` : '확인 필요'}</dd>
    <dt>용도</dt><dd>${esc(b.use)}</dd>
    <dt>규모</dt><dd>지상 ${b.floors}층${b.gfa_m2 ? ` · ${fmt(b.gfa_m2)}㎡` : ''}</dd>
    <dt>주변 건물</dt><dd>${S.site.context.length}동 반영</dd>`;
  drawPlan();
  drawFaceList();
  $('#go-photo').disabled = true;
}

function drawPlan() {
  const all = [S.site.target, ...S.site.context.map(c => c.footprint)].flat();
  const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const k = Math.min(320 / (x1 - x0), 260 / (y1 - y0));
  const ox = 180 - (x0 + x1) / 2 * k, oy = 150 + (y0 + y1) / 2 * k;
  const P = ([x, y]) => `${(ox + x * k).toFixed(1)},${(oy - y * k).toFixed(1)}`;
  const [lo, hi] = range();
  const ctx = S.site.context.map(c => {
    const cx = mean(c.footprint.slice(0, -1).map(p => p[0])), cy = mean(c.footprint.slice(0, -1).map(p => p[1]));
    return `<polygon points="${c.footprint.map(P).join(' ')}" fill="#c3cfcb" stroke="#9fb0aa"/>
      <text x="${P([cx, cy]).split(',')[0]}" y="${+P([cx, cy]).split(',')[1] + 4}" text-anchor="middle" font-size="10" fill="#4b5d57">${Math.round(c.height_m)}m</text>`;
  }).join('');
  const edges = S.site.faces.filter(f => f.type === 'facade').map(f => {
    const v = mean(S.irr.faces[f.face_id].annual);
    return `<line class="edge${S.face === f.face_id ? ' sel' : ''}" data-face="${f.face_id}" x1="${P(f.p0).split(',')[0]}" y1="${P(f.p0).split(',')[1]}"
      x2="${P(f.p1).split(',')[0]}" y2="${P(f.p1).split(',')[1]}" stroke="${color(v, lo, hi)}" stroke-width="7" stroke-linecap="round"><title>${faceName(f)} · 연간 ${fmt(v)} kWh/㎡</title></line>`;
  }).join('');
  $('#plan').innerHTML = `${ctx}
    <polygon points="${S.site.target.map(P).join(' ')}" fill="#fff" stroke="#18302a" stroke-width="1"/>
    <text x="${P([0, 0]).split(',')[0]}" y="${+P([0, 0]).split(',')[1] + 4}" text-anchor="middle" font-size="11" font-weight="700" fill="#18302a">대상</text>
    ${edges}
    <g transform="translate(336 28)"><path d="M0 -14 L6 4 L0 0 L-6 4Z" fill="#18302a"/><text y="18" text-anchor="middle" font-size="10" fill="#18302a">N</text></g>`;
  $('#plan').querySelectorAll('.edge').forEach(e => e.addEventListener('click', () => pickFace(e.dataset.face)));
}

function drawFaceList() {
  const [lo, hi] = range();
  $('#face-list').innerHTML = S.site.faces.map(f => {
    const v = mean(S.irr.faces[f.face_id].annual);
    const roof = f.type === 'roof';
    const sub = roof ? `${fmt(f.area_m2)}㎡ · 정사영상 분석 예정`
      : `폭 ${fmt(f.width_m, 1)}m · ${S.cellsFrac[f.face_id] ? '사진 반영됨' : '사진 없음'}`;
    return `<li><button data-face="${f.face_id}" aria-pressed="${S.face === f.face_id}" ${roof ? 'disabled' : ''}>
      <span class="swatch" style="background:${color(v, lo, hi)}"></span>
      <span>${faceName(f)}<span class="sub">${sub}</span></span>
      <span class="val">${fmt(v)}<span class="sub">kWh/㎡·년</span></span></button></li>`;
  }).join('');
  $('#face-list').querySelectorAll('button:not(:disabled)').forEach(b => b.addEventListener('click', () => pickFace(b.dataset.face)));
}

function pickFace(id) {
  S.face = id;
  drawPlan(); drawFaceList();
  $('#go-photo').disabled = false;
}

// ---------- 2. 입면 사진 ----------
const face = () => S.site.faces.find(f => f.face_id === S.face);
const CORNERS = ['왼쪽 위', '오른쪽 위', '오른쪽 아래', '왼쪽 아래'];

function openPhoto() {
  const f = face();
  $('#photo-title').textContent = `${faceName(f)} 촬영`;
  $('#photo-hint').textContent = `건물 밖에서 ${faceName(f)}을 정면으로 보고, 벽 전체가 들어오게 찍어 주세요.`;
  S.img = null; S.corners = [];
  S.cells = S.cellsFrac[S.face] ? [...S.cellsFrac[S.face]] : null;
  $('#corner-box').hidden = true;
  $('#grid-box').hidden = true;
  $('#photo-reset').hidden = true;
  $('#photo-done').disabled = true;
  $('#photo-input').value = '';
  show('photo');
}

$('#photo-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, MAX_SRC / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  S.img = c; S.corners = [];
  S.cells = null;
  $('#grid-box').hidden = true;
  $('#corner-box').hidden = false;
  $('#photo-done').disabled = true;
  drawCorners();
});

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
  const minH = S.params.min_annual_kwh_m2.value, annual = S.irr.faces[f.face_id].annual;
  g.putImageData(S.rectImg, 0, 0);
  for (let t = 0; t < f.nt; t++) for (let s = 0; s < f.ns; s++) {
    const i = t * f.ns + s, x = s * cw, y = (f.nt - 1 - t) * ch, v = S.cells[i];
    if (annual[i] < minH) {
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

$('#photo-done').addEventListener('click', () => { S.cellsFrac[S.face] = S.cells; showResult(); });
$('#photo-back').addEventListener('click', () => { drawFaceList(); show('site'); });

// ---------- 3. 결과 ----------
function showResult() {
  const usage = Number($('#usage').value);
  const r = evaluate({ site: S.site, irr: S.irr, params: S.params, cellsFrac: S.cellsFrac, annualKwh: usage > 0 ? usage * 12 : null });
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
$('#again').addEventListener('click', () => { drawPlan(); drawFaceList(); show('site'); });
$('#print').addEventListener('click', () => print());
addEventListener('beforeprint', () => document.querySelectorAll('details').forEach(d => { d.open = true; }));

// ---------- 시작 ----------
(async () => {
  try {
    const [params, index] = await Promise.all([getJSON('params.json'), getJSON('data/sites/index.json')]);
    S.params = params;
    $('#site-select').innerHTML = index.map(s => `<option value="${esc(s.site_id)}">${esc(s.name)} — ${esc(s.address)}</option>`).join('');
    $('#site-select').addEventListener('change', e => loadSite(e.target.value));
    await loadSite(index[0].site_id);
    show('site');
  } catch (err) {
    $('main').innerHTML = `<h1>데이터를 불러오지 못했어요</h1><p class="hint">${esc(err.message)}. 로컬에서는 docs 폴더에서 python -m http.server 로 띄워 주세요.</p>`;
  }
})();

