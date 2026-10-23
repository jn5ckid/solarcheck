import test from 'node:test';
import assert from 'node:assert/strict';
import { projectPoint, facadeCorners, imageTransform, validateCorners, pointInPolygon } from '../docs/facade-geometry.js';
import { FacadeViewer, researchDisplayPoint, researchPointRadii, facadeHeatmapCells } from '../docs/facade-viewer.js';

test('research sensor display offset follows its normal without changing source XYZ', () => {
  const sensor = {x: 10, y: 20, z: 30, nx: 0, ny: -1, nz: 0};
  assert.deepEqual(researchDisplayPoint(sensor, [5, 8], 10), [5, 11.95, 20]);
  assert.deepEqual([sensor.x, sensor.y, sensor.z], [10, 20, 30]);
  assert.deepEqual(researchDisplayPoint({...sensor, nx: 0, ny: 0, nz: 1}, [5, 8], 10), [5, 12, 20.05]);
});

test('research points become exactly one fifth size with context buildings visible', () => {
  const normal = researchPointRadii(1, false);
  const context = researchPointRadii(1, true);
  assert.ok(Math.abs(context.sensor - normal.sensor / 5) < 1e-12);
  assert.ok(Math.abs(context.draft - normal.draft / 5) < 1e-12);
  assert.ok(Math.abs(context.halo - normal.halo / 5) < 1e-12);
});

test('facade sensor grid becomes gap-free colored surface cells', () => {
  const candidates = [
    {x: 1, y: -.1, z: 1, color: 'rgb(1,2,3)'}, {x: 3, y: -.1, z: 1, color: 'rgb(4,5,6)'},
    {x: 1, y: -.1, z: 3, color: 'rgb(7,8,9)'}, {x: 3, y: -.1, z: 3, color: 'rgb(10,11,12)'},
  ];
  const cells = facadeHeatmapCells(candidates, [0, 0], [4, 0], 4);
  assert.equal(cells.length, 4);
  assert.deepEqual(cells[0].points, [[0, 0, 0], [2, 0, 0], [2, 0, 2], [0, 0, 2]]);
  assert.deepEqual(cells[3].points, [[2, 0, 2], [4, 0, 2], [4, 0, 4], [2, 0, 4]]);
});

test('south facade maps photo left/right and top/bottom without mirroring', () => {
  const face = {p0: [-7, -6], p1: [7, -6], height_m: 16.5};
  const view = {yaw: 0, pitch: .2, scale: 5, cx: 200, cy: 200};
  const projected = facadeCorners(face).map(p => projectPoint(p, view));
  assert.ok(projected[0][0] < projected[1][0]);
  assert.ok(projected[0][1] < projected[3][1]);
});

test('photo corners coincide with selected facade at multiple view rotations', () => {
  const face = {p0: [-7, -6], p1: [7, -6], height_m: 16.5};
  for (const yaw of [-.7, 0, .7, 1.2]) {
    const points = facadeCorners(face).map(p => projectPoint(p, {yaw, pitch: .5, scale: 7, cx: 200, cy: 200}));
    const [a, b, c, d, e, f] = imageTransform(points, 400, 500);
    for (const [i, [u, v]] of [[0, [0, 0]], [1, [400, 0]], [2, [400, 500]], [3, [0, 500]]]) {
      assert.ok(Math.abs(a * u + c * v + e - points[i][0]) < 1e-8);
      assert.ok(Math.abs(b * u + d * v + f - points[i][1]) < 1e-8);
    }
  }
});

test('corner selection rejects crossed, repeated, reversed, and nearly collinear points', () => {
  assert.equal(validateCorners([[10, 10], [200, 20], [180, 300], [20, 290]]), true);
  assert.equal(validateCorners([[0, 0], [100, 100], [100, 0], [0, 100]]), false);
  assert.equal(validateCorners([[0, 0], [0, 0], [100, 100], [0, 100]]), false);
  assert.equal(validateCorners([[0, 0], [0, 100], [100, 100], [100, 0]]), false);
  assert.equal(validateCorners([[0, 0], [1, 0], [2, 0], [3, 0]]), false);
});

test('face selection respects the projected polygon, not its bounding rectangle', () => {
  const polygon = [[0, 0], [10, 5], [10, 15], [0, 10]];
  assert.equal(pointInPolygon([5, 7], polygon), true);
  assert.equal(pointInPolygon([9, 1], polygon), false);
});

test('research sensors render, filter by surface group, and can be selected', () => {
  globalThis.devicePixelRatio = 1;
  globalThis.ResizeObserver = class { observe() {} };
  const listeners = new Map();
  const context = new Proxy({}, {
    get(target, property) {
      if (!(property in target)) target[property] = () => {};
      return target[property];
    },
    set(target, property, value) { target[property] = value; return true; },
  });
  const canvas = {
    clientWidth: 400, clientHeight: 300, width: 0, height: 0, parentElement: {},
    getContext: () => context,
    addEventListener: (name, handler) => listeners.set(name, handler),
    setPointerCapture: () => {},
    getBoundingClientRect: () => ({left: 0, top: 0}),
  };
  let selected = null;
  const viewer = new FacadeViewer(canvas, () => {}, sensor => { selected = sensor.sensor_row_index; });
  const sensors = [
    {sensor_row_index: 10, x: 0, y: 0, z: 0, color: '#111', hourly_inference_eligible: 1, surface_group_id: 'a'},
    {sensor_row_index: 11, x: 10, y: 5, z: 8, color: '#222', hourly_inference_eligible: 0, surface_group_id: 'b'},
  ];
  viewer.setResearch({sensors});
  assert.equal(viewer.hits.length, 2);
  viewer.setResearchGroup('a');
  assert.equal(viewer.hits.length, 1);
  const hit = viewer.hits[0];
  listeners.get('pointerdown')({button: 0, pointerId: 1, clientX: hit.x, clientY: hit.y});
  listeners.get('pointerup')({pointerId: 1, clientX: hit.x, clientY: hit.y});
  assert.equal(selected, 10);
  assert.equal(viewer.researchSelected, 10);
});

test('research view overlays the target mass and toggles nearby context masses', () => {
  globalThis.devicePixelRatio = 1;
  globalThis.ResizeObserver = class { observe() {} };
  let fills = 0;
  const context = new Proxy({fill: () => { fills++; }}, {
    get(target, property) {
      if (!(property in target)) target[property] = () => {};
      return target[property];
    },
    set(target, property, value) { target[property] = value; return true; },
  });
  const canvas = {
    clientWidth: 400, clientHeight: 300, width: 0, height: 0, parentElement: {},
    getContext: () => context, addEventListener: () => {}, setPointerCapture: () => {},
    getBoundingClientRect: () => ({left: 0, top: 0}),
  };
  const viewer = new FacadeViewer(canvas, () => {});
  const sensors = [{sensor_row_index: 1, x: 100, y: 200, z: 30, color: '#f00',
    hourly_inference_eligible: 1, surface_group_id: 'roof'}];
  const site = {
    building: {height_m: 12}, faces: [],
    target: [[-5, -5], [5, -5], [5, 5], [-5, 5], [-5, -5]],
    context: [{height_m: 9, footprint: [[12, -4], [18, -4], [18, 4], [12, 4], [12, -4]]}],
  };
  viewer.setResearch({sensors, site, anchor_xy: [100, 200], context_radius_m: 60});
  const targetOnlyFills = fills;
  assert.equal(viewer.site, site);
  assert.equal(viewer.hits.length, 1);
  viewer.setContext(true);
  assert.ok(fills - targetOnlyFills > targetOnlyFills, 'nearby context adds mass polygons to the redraw');
  assert.equal(viewer.hits.length, 1, 'only sensors remain selectable');
});

test('candidate sensors render separately and never become selectable research hits', () => {
  globalThis.devicePixelRatio = 1;
  globalThis.ResizeObserver = class { observe() {} };
  let strokes = 0;
  const context = new Proxy({stroke: () => { strokes++; }}, {
    get(target, property) {
      if (!(property in target)) target[property] = () => {};
      return target[property];
    },
    set(target, property, value) { target[property] = value; return true; },
  });
  const canvas = {
    clientWidth: 400, clientHeight: 300, width: 0, height: 0, parentElement: {},
    getContext: () => context, addEventListener: () => {}, setPointerCapture: () => {},
    getBoundingClientRect: () => ({left: 0, top: 0}),
  };
  const viewer = new FacadeViewer(canvas, () => {});
  const sensors = [{sensor_row_index: 1, x: 0, y: 0, z: 1, color: '#f00',
    hourly_inference_eligible: 1, surface_group_id: 'roof'}];
  const draftSensors = [{candidate_id: 'candidate:R00:0001', x: 1, y: 1, z: 1, nx: 0, ny: 0, nz: 1}];
  viewer.setResearch({sensors, draftSensors});
  const withDraftStrokes = strokes;
  assert.equal(viewer.hits.length, 1);
  assert.equal(viewer.draft, true);
  viewer.setDraft(false);
  assert.equal(viewer.hits.length, 1);
  assert.ok(strokes - withDraftStrokes < withDraftStrokes, 'turning candidates off removes their outline draw');
});
