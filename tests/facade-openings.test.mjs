import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeFacadeOpenings, closestFacadeByAzimuth, maskToCellFractions,
  openingRatioFromMask, paintMask} from '../docs/facade-openings.js';

function image(width, height, color = [210, 196, 170]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = color[0]; data[i * 4 + 1] = color[1]; data[i * 4 + 2] = color[2]; data[i * 4 + 3] = 255;
  }
  return {width, height, data};
}

function fillRect(target, x0, y0, width, height, color) {
  for (let y = y0; y < y0 + height; y++) for (let x = x0; x < x0 + width; x++) {
    const i = (y * target.width + x) * 4;
    target.data[i] = color[0]; target.data[i + 1] = color[1]; target.data[i + 2] = color[2];
  }
}

test('uniform facade remains fully usable', () => {
  const result = analyzeFacadeOpenings(image(80, 80), 4, 4);
  assert.deepEqual(result.cells, Array(16).fill(1));
  assert.equal(result.openingRatio, 0);
  assert.equal(result.mask.some(value => value > 0), false);
});

test('dark contrasting rectangles become editable opening candidates', () => {
  const facade = image(120, 120);
  fillRect(facade, 30, 30, 30, 30, [35, 60, 75]);
  fillRect(facade, 60, 60, 30, 60, [45, 50, 55]);
  const result = analyzeFacadeOpenings(facade, 4, 4);
  assert.ok(result.cells.some(value => value < 1));
  assert.ok(result.maskedPixelCount + result.uncertainPixelCount > 0);
  assert.ok(result.openingRatio > 0);
});

test('pixel mask brush paints and erases before internal cell aggregation', () => {
  const mask = new Uint8ClampedArray(100);
  paintMask(mask, 10, 10, 2, 2, 2, 255);
  assert.ok(openingRatioFromMask(mask) > 0);
  const cells = maskToCellFractions(mask, 10, 10, 2, 2);
  assert.ok(cells.some(value => value < 1));
  paintMask(mask, 10, 10, 2, 2, 3, 0);
  assert.equal(openingRatioFromMask(mask), 0);
});

test('invalid input fails clearly', () => {
  assert.throws(() => analyzeFacadeOpenings(null, 2, 2), /보정된 입면 사진/);
  assert.throws(() => analyzeFacadeOpenings(image(20, 20), 0, 2), /격자 크기/);
});

test('research direction maps to the closest public facade across north', () => {
  const faces = [
    {face_id: 'west', type: 'facade', azimuth_deg: 265},
    {face_id: 'north', type: 'facade', azimuth_deg: 359},
    {face_id: 'roof', type: 'roof', azimuth_deg: 0},
  ];
  assert.equal(closestFacadeByAzimuth(faces, 2).face_id, 'north');
  assert.equal(closestFacadeByAzimuth(faces, 270).face_id, 'west');
});
