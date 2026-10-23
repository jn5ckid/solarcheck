// node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluate, loadShape, verdictOf } from '../docs/calc.js';

const params = JSON.parse(readFileSync(new URL('../docs/params.json', import.meta.url)));
const flat = Array.from({ length: 8760 }, (_, h) => (h % 24 >= 9 && h % 24 < 17 ? 100 : 0));
const site = {
  building: { use: '근린생활시설', tariff: '일반용', gfa_m2: 1000 },
  faces: [
    { face_id: 'F01', type: 'facade', azimuth_deg: 180, cell_area_m2: 10 },
    { face_id: 'R0', type: 'roof', cell_area_m2: 5 },
  ],
};
const irr = {
  model: 'analytic', weather: 'test',
  faces: { F01: { annual: [1000, 500], hourly: flat }, R0: { annual: [1500], hourly: flat } },
};

test('부하 형상은 합이 1', () => {
  assert.ok(Math.abs(loadShape(params, '공동주택').reduce((a, b) => a + b) - 1) < 1e-9);
});

test('판정 규칙', () => {
  assert.equal(verdictOf(10, 5, 12), '적합');
  assert.equal(verdictOf(15, 9, 12), '조건부');
  assert.equal(verdictOf(20, 15, 12), '부적합');
  assert.equal(verdictOf(Infinity, Infinity, 12), '부적합');
});

test('면적·발전량·회수기간을 손계산과 비교', () => {
  // 입면: 1,000 kWh/m² 셀만 기준(600) 이상, 사진 비율 0.5 → 면적 5 m²
  const r = evaluate({ site, irr, params, cellsFrac: { F01: [0.5, 1] }, annualKwh: 1e9 });
  const fa = r.faces[0];
  assert.equal(fa.area_m2, 5);
  assert.equal(fa.shaded_m2, 10);
  assert.ok(Math.abs(fa.kw - 0.75) < 1e-9);
  assert.ok(Math.abs(fa.kwh - 1000 * 5 * 0.15 * 0.75) < 1e-6);
  // 부하가 매우 크면 자가소비율 1 → 절감액 = 발전량 × 180원
  assert.ok(Math.abs(r.total.self_consumption - 1) < 1e-9);
  const saving = fa.kwh * 180;
  const cost = 0.75 * 6750000;
  assert.ok(Math.abs(fa.standalone - (cost * 0.3) / saving) < 1e-9);
  assert.ok(Math.abs(fa.linked - (cost * 0.3 - 5 * 200000) / saving) < 1e-9);
});

test('사진이 없으면 기본 개구율, 촬영 면이 있으면 그 개구율을 다른 면에 적용', () => {
  const r0 = evaluate({ site, irr, params });
  assert.ok(Math.abs(r0.faces[0].area_m2 - 10 * 0.6) < 1e-9);
  const two = { ...site, faces: [...site.faces, { face_id: 'F02', type: 'facade', azimuth_deg: 270, cell_area_m2: 10 }] };
  const irr2 = { ...irr, faces: { ...irr.faces, F02: { annual: [1000, 1000], hourly: flat } } };
  const r1 = evaluate({ site: two, irr: irr2, params, cellsFrac: { F01: [1, 0] } });
  assert.ok(Math.abs(r1.faces[2].area_m2 - 20 * 0.5) < 1e-9);
});

test('발전이 없는 면은 부적합, 추천 면이 없으면 건물도 부적합', () => {
  const dark = { ...irr, faces: { F01: { annual: [0, 0], hourly: flat }, R0: { annual: [0], hourly: flat } } };
  const r = evaluate({ site, irr: dark, params });
  assert.equal(r.verdict, '부적합');
  assert.ok(r.faces.every(f => f.verdict === '부적합'));
});
