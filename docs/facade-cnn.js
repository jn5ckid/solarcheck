// Browser-side facade segmentation. The model and WASM runtime are loaded
// lazily only after a user rectifies a facade photo.
const TFJS_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.9.0/dist/tf.min.js';
const TFLITE_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-tflite@0.0.1-alpha.10/dist/tf-tflite.min.js';
const TFLITE_WASM_PATH = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-tflite@0.0.1-alpha.10/wasm/';
const MODEL_URL = 'https://raw.githubusercontent.com/mlcommons/mobile_models/9c7b31ce63ff0331bd659ac2609c4e68b6b4ec0f/v0_7/tflite/deeplabv3_mnv2_ade20k_float.tflite';
const MODEL_SIZE = 512;

// ADE20K IDs include a background class at index 0. Only permanent facade
// elements are excluded; people, cars, trees and shadows remain transient.
const ADE20K_LABELS = new Map([
  [9, 'windowpane'], [15, 'door'], [19, 'curtain'], [37, 'lamp'],
  [39, 'railing'], [43, 'column'], [44, 'signboard'], [54, 'stairs'],
  [59, 'screen'], [60, 'stairway'], [65, 'blind'], [84, 'light'],
  [86, 'awning'], [94, 'pole'], [96, 'bannister'], [103, 'poster'],
  [108, 'canopy'], [125, 'tank'], [132, 'screen'], [138, 'fan'],
  [141, 'screen'], [143, 'radiator'], [144, 'glass'],
]);

export const FACADE_BLOCKING_LABELS = new Set(ADE20K_LABELS.values());
const FACADE_BLOCKING_IDS = new Set(ADE20K_LABELS.keys());
const normalizeLabel = value => String(value || '').trim().toLowerCase();
const colorKey = color => color.slice(0, 3).map(value => Number(value) || 0).join(',');

export function mergeOpeningMasks(...masks) {
  const usable = masks.filter(Boolean);
  if (!usable.length) throw new Error('합칠 개구부 마스크가 필요해요.');
  const length = usable[0].length;
  if (!length || usable.some(mask => mask.length !== length)) {
    throw new Error('개구부 마스크의 크기가 서로 달라요.');
  }
  const merged = new Uint8ClampedArray(length);
  for (const mask of usable) for (let i = 0; i < length; i++) {
    merged[i] = Math.max(merged[i], mask[i]);
  }
  return merged;
}

function resizeMask(source, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const mask = new Uint8ClampedArray(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y++) for (let x = 0; x < targetWidth; x++) {
    const sourceX = Math.min(sourceWidth - 1, Math.floor((x + .5) * sourceWidth / targetWidth));
    const sourceY = Math.min(sourceHeight - 1, Math.floor((y + .5) * sourceHeight / targetHeight));
    mask[y * targetWidth + x] = source[sourceY * sourceWidth + sourceX];
  }
  return mask;
}

function summarizeMask(mask, counts, targetWidth, targetHeight) {
  const labels = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([label]) => label);
  const blockedPixels = mask.reduce((sum, value) => sum + (value > 0 ? 1 : 0), 0);
  return {mask, width: targetWidth, height: targetHeight, labels,
    openingRatio: blockedPixels / mask.length, model: 'DeepLab v3 · MobileNet v2 · ADE20K'};
}

export function classIdsToOpeningMask(classIds, width, height,
    targetWidth = width, targetHeight = height) {
  if (!(width > 0) || !(height > 0) || !classIds || classIds.length !== width * height
      || !(targetWidth > 0) || !(targetHeight > 0)) {
    throw new Error('CNN 분할 결과의 크기를 확인해 주세요.');
  }
  const sourceMask = new Uint8ClampedArray(width * height);
  const counts = new Map();
  for (let i = 0; i < classIds.length; i++) {
    const id = Math.round(Number(classIds[i]));
    if (!FACADE_BLOCKING_IDS.has(id)) continue;
    sourceMask[i] = 255;
    const label = ADE20K_LABELS.get(id);
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return summarizeMask(resizeMask(sourceMask, width, height, targetWidth, targetHeight),
    counts, targetWidth, targetHeight);
}

// Retained as a pure conversion helper for compatibility with the former
// TensorFlow.js DeepLab output and for deterministic unit testing.
export function segmentationToOpeningMask(result, targetWidth = result?.width, targetHeight = result?.height) {
  const {width, height, segmentationMap, legend = {}} = result || {};
  if (!(width > 0) || !(height > 0) || !segmentationMap || segmentationMap.length !== width * height * 4
      || !(targetWidth > 0) || !(targetHeight > 0)) {
    throw new Error('CNN 분할 결과의 크기를 확인해 주세요.');
  }
  const blockedColors = new Map();
  for (const [label, color] of Object.entries(legend)) {
    const normalized = normalizeLabel(label);
    if (FACADE_BLOCKING_LABELS.has(normalized)) blockedColors.set(colorKey(color), normalized);
  }
  const sourceMask = new Uint8ClampedArray(width * height);
  const counts = new Map();
  for (let i = 0; i < width * height; i++) {
    const offset = i * 4;
    const label = blockedColors.get(`${segmentationMap[offset]},${segmentationMap[offset + 1]},${segmentationMap[offset + 2]}`);
    if (!label) continue;
    sourceMask[i] = 255;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return summarizeMask(resizeMask(sourceMask, width, height, targetWidth, targetHeight),
    counts, targetWidth, targetHeight);
}

let modelPromise = null;

function loadScript(url, ready) {
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let script = document.querySelector(`script[src="${url}"]`);
    if (script?.dataset.failed === 'true') script.remove(), script = null;
    script ||= Object.assign(document.createElement('script'), {src: url, crossOrigin: 'anonymous'});
    const finish = () => ready() ? resolve() : reject(new Error('CNN 라이브러리를 초기화하지 못했어요.'));
    const fail = () => {
      script.dataset.failed = 'true';
      reject(new Error('CNN 라이브러리를 내려받지 못했어요.'));
    };
    script.addEventListener('load', finish, {once: true});
    script.addEventListener('error', fail, {once: true});
    if (!script.isConnected) document.head.append(script);
  });
}

async function loadModel() {
  if (!modelPromise) modelPromise = (async () => {
    await loadScript(TFJS_URL, () => Boolean(window.tf));
    await loadScript(TFLITE_URL, () => Boolean(window.tflite));
    await window.tf.ready();
    window.tflite.setWasmPath(TFLITE_WASM_PATH);
    return window.tflite.loadTFLiteModel(MODEL_URL);
  })().catch(error => { modelPromise = null; throw error; });
  return modelPromise;
}

function outputDimensions(output) {
  const shape = output?.shape || [];
  if (shape.length === 4 && shape[0] === 1 && shape[3] === 1) return [shape[2], shape[1]];
  if (shape.length === 3 && shape[0] === 1) return [shape[2], shape[1]];
  if (shape.length === 2) return [shape[1], shape[0]];
  throw new Error(`지원하지 않는 CNN 출력 크기예요: ${shape.join('×') || '없음'}`);
}

export async function analyzeFacadeWithCNN(imageData) {
  if (!imageData?.data || !(imageData.width > 0) || !(imageData.height > 0)) {
    throw new Error('CNN으로 분석할 보정 입면 이미지가 필요해요.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width; canvas.height = imageData.height;
  canvas.getContext('2d').putImageData(imageData, 0, 0);
  const model = await loadModel();
  const input = window.tf.tidy(() => window.tf.image
    .resizeBilinear(window.tf.browser.fromPixels(canvas), [MODEL_SIZE, MODEL_SIZE])
    .toFloat().div(255).expandDims(0));
  let output;
  try {
    output = model.predict(input);
    const [width, height] = outputDimensions(output);
    const classIds = await output.data();
    return classIdsToOpeningMask(classIds, width, height, imageData.width, imageData.height);
  } finally {
    input.dispose();
    output?.dispose?.();
  }
}
