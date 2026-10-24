import test from 'node:test';
import assert from 'node:assert/strict';
import {classIdsToOpeningMask, mergeOpeningMasks, segmentationToOpeningMask} from '../docs/facade-cnn.js';

test('CNN misses are filled by the pixel-analysis mask without a display grid', () => {
  const merged = mergeOpeningMasks(
    new Uint8ClampedArray([0, 255, 0, 0]),
    new Uint8ClampedArray([150, 0, 255, 0]),
  );
  assert.deepEqual([...merged], [150, 255, 255, 0]);
  assert.throws(() => mergeOpeningMasks(new Uint8ClampedArray(2), new Uint8ClampedArray(3)), /크기/);
});

test('ADE20K class IDs become a pixel mask and preserve transient objects', () => {
  const result = classIdsToOpeningMask(new Int32Array([
    1, 9, 13,
    15, 21, 44,
  ]), 3, 2);
  assert.deepEqual([...result.mask], [0, 255, 0, 255, 0, 255]);
  assert.deepEqual(result.labels, ['windowpane', 'door', 'signboard']);
  assert.equal(result.openingRatio, .5);
});

test('DeepLab facade classes become a pixel opening mask and resize by nearest label', () => {
  const result = segmentationToOpeningMask({
    width: 2,
    height: 1,
    segmentationMap: new Uint8ClampedArray([
      10, 20, 30, 255,
      40, 50, 60, 255,
    ]),
    legend: {wall: [10, 20, 30], windowpane: [40, 50, 60]},
  }, 4, 2);
  assert.deepEqual([...result.mask], [0, 0, 255, 255, 0, 0, 255, 255]);
  assert.deepEqual(result.labels, ['windowpane']);
  assert.equal(result.openingRatio, .5);
  assert.match(result.model, /DeepLab/);
});

test('transient ADE20K objects are not treated as permanent facade openings', () => {
  const result = segmentationToOpeningMask({
    width: 3,
    height: 1,
    segmentationMap: new Uint8ClampedArray([
      1, 1, 1, 255,
      2, 2, 2, 255,
      3, 3, 3, 255,
    ]),
    legend: {person: [1, 1, 1], car: [2, 2, 2], door: [3, 3, 3]},
  });
  assert.deepEqual([...result.mask], [0, 0, 255]);
  assert.deepEqual(result.labels, ['door']);
});

test('malformed segmentation output is rejected', () => {
  assert.throws(() => segmentationToOpeningMask({width: 2, height: 2,
    segmentationMap: new Uint8ClampedArray(4), legend: {}}), /크기/);
});
