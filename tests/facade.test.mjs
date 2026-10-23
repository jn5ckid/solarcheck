import test from 'node:test';
import assert from 'node:assert/strict';
import { projectPoint, facadeCorners, imageTransform, validateCorners, pointInPolygon } from '../docs/facade-geometry.js';

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
