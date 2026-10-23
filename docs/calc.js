// 발전량·경제성 산정과 판정. 브라우저와 node 테스트가 같은 파일을 쓴다.

const DOW_JAN1 = 3; // 2026-01-01 = 목요일 (월 = 0). 공휴일은 반영하지 않음

export const DIR8 = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
export const faceName = f => f.type === 'roof' ? '지붕' : `${DIR8[Math.round(f.azimuth_deg / 45) % 8]}측 입면`;

const sum = a => a.reduce((s, x) => s + x, 0);

export function loadShape(params, use) {
  const prof = params.load_profile_24h.value[use] ?? params.load_profile_24h.value['근린생활시설'];
  const raw = Array.isArray(prof) ? prof : Array.from({ length: 8760 }, (_, h) => {
    const dow = (Math.floor(h / 24) + DOW_JAN1) % 7;
    return (dow >= 5 ? prof.weekend : prof.weekday)[h % 24];
  });
  const total = sum(raw);
  return raw.map(x => x / total);
}

export function verdictOf(standalone, linked, threshold) {
  if (standalone <= threshold) return '적합';
  if (linked <= threshold) return '조건부';
  return '부적합';
}

// 촬영한 면들의 평균 개구율. 촬영한 면이 없으면 기본 가정값
export function openingRatio(cellsFrac, params) {
  const all = Object.values(cellsFrac).flat();
  return all.length ? 1 - sum(all) / all.length : params.default_opening_ratio.value;
}

/**
 * @param site       site.json
 * @param irr        irradiance.json
 * @param params     params.json
 * @param cellsFrac  {face_id: [셀별 설치 가능 비율 0~1]} 사진으로 확인한 입면만
 * @param annualKwh  건물 연간 전력 사용량 (없으면 용도별 원단위 × 연면적)
 */
export function evaluate({ site, irr, params, cellsFrac = {}, annualKwh = null }) {
  const V = k => params[k].value;
  const b = site.building;
  const T = V('payback_threshold_y');
  const openR = openingRatio(cellsFrac, params);
  const rate = V('tariff_won_per_kwh')[b.tariff] ?? V('tariff_won_per_kwh')['일반용'];
  const usage = annualKwh ?? b.gfa_m2 * (V('annual_kwh_per_m2_gfa')[b.use] ?? V('annual_kwh_per_m2_gfa')['근린생활시설']);
  const load = loadShape(params, b.use).map(x => x * usage);

  const faces = site.faces.map(face => {
    const { annual, hourly } = irr.faces[face.face_id];
    const roof = face.type === 'roof';
    const fr = roof ? null : cellsFrac[face.face_id];
    let area = 0, hSum = 0, shaded = 0;
    annual.forEach((H, i) => {
      const f = roof ? 1 : fr ? fr[i] : 1 - openR;
      if (H < V('min_annual_kwh_m2')) { shaded += face.cell_area_m2 * f; return; }
      area += face.cell_area_m2 * f;
      hSum += H * face.cell_area_m2 * f;
    });
    const type = roof ? 'roof' : 'facade';
    const kw = area * V('module_kw_per_m2');
    const kwh = hSum * V('module_kw_per_m2') * V('performance_ratio');
    const cost = kw * V('unit_cost_won_per_kw')[type];
    const subsidy = cost * V('subsidy_rate')[type];
    const cladding = roof ? 0 : area * V('cladding_cost_won_per_m2');
    const hTot = sum(hourly);
    return {
      face_id: face.face_id, name: faceName(face), type, photo: Boolean(fr),
      area_m2: area, shaded_m2: shaded, kw, kwh, kwh_per_kw: kw ? kwh / kw : 0,
      cost, subsidy, cladding, gen: hourly.map(x => hTot ? kwh * x / hTot : 0),
    };
  });

  const scrOf = sel => {
    const g = load.map((_, h) => sum(sel.map(f => f.gen[h])));
    const gT = sum(g);
    return gT ? sum(g.map((x, h) => Math.min(x, load[h]))) / gT : 0;
  };
  const paybacks = (x, scr) => {
    const saving = x.kwh * scr * rate;
    return {
      saving,
      standalone: saving > 0 ? (x.cost - x.subsidy) / saving : Infinity,
      linked: saving > 0 ? (x.cost - x.cladding - x.subsidy) / saving : Infinity,
    };
  };

  // 면별 판정은 모든 후보 면을 설치한다고 본 자가소비율로, 건물 합계는 추천 면만으로 다시 계산한다
  const scrAll = scrOf(faces);
  for (const f of faces) {
    Object.assign(f, paybacks(f, scrAll));
    f.verdict = f.kw > 0 ? verdictOf(f.standalone, f.linked, T) : '부적합';
  }
  const picked = faces.filter(f => f.verdict !== '부적합');
  const scr = scrOf(picked);
  const tot = { kw: 0, kwh: 0, cost: 0, subsidy: 0, cladding: 0, area_m2: 0 };
  for (const f of picked) for (const k in tot) tot[k] += f[k];
  Object.assign(tot, paybacks(tot, scr), { self_consumption: scr, usage_kwh: usage });
  const verdict = picked.length ? verdictOf(tot.standalone, tot.linked, T) : '부적합';

  const assumptions = [
    `일사: ${irr.weather}, ${irr.model === 'analytic' ? '해석식 모델' : irr.model}`,
    Object.keys(cellsFrac).length
      ? `촬영하지 않은 입면은 촬영한 면의 개구율 ${Math.round(openR * 100)}%를 적용`
      : `입면 사진이 없어 개구율 ${Math.round(openR * 100)}%를 가정`,
    annualKwh ? '전력 사용량: 입력값' : `전력 사용량: 용도별 원단위 가정 (연 ${Math.round(usage).toLocaleString()} kWh)`,
    '남는 전력의 판매 수익은 0으로 계산 (보수적)',
    ...Object.entries(params).filter(([, p]) => p.source?.startsWith('가정')).map(([k, p]) => `${k}: ${p.source}`),
  ];

  return { verdict, threshold: T, total: tot, faces, reasons: reasons(verdict, tot, faces, b), assumptions };
}

function reasons(verdict, tot, faces, b) {
  const out = [{
    적합: '단독으로 설치해도 회수기간이 기준 안에 들어와요.',
    조건부: '단독 설치는 회수기간이 길지만, 외장재를 교체할 때 함께하면 기준 안에 들어와요.',
    부적합: '지금 조건에서는 외피 공사와 함께해도 회수기간이 기준을 넘어요.',
  }[verdict]];
  if (tot.kw > 0 && tot.self_consumption >= 0.7) out.push(`${b.use}의 낮 시간 사용이 발전 시간대와 겹쳐 자가소비율이 높아요.`);
  if (tot.kw > 0 && tot.self_consumption < 0.4) out.push('발전하는 시간에 쓰는 전력이 적어 남는 전력이 많아요.');
  const dropped = faces.filter(f => f.verdict === '부적합' && f.type === 'facade');
  if (dropped.length) out.push(`${dropped.map(f => f.name).join(', ')}은 일사가 부족해 추천에서 뺐어요.`);
  return out;
}
