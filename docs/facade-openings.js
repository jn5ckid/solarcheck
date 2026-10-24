const median = values => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const robustScale = (values, center, floor) =>
  Math.max(floor, median(values.map(value => Math.abs(value - center))) * 1.4826);

const lumaAt = (data, width, x, y) => {
  const offset = (y * width + x) * 4;
  return data[offset] * .2126 + data[offset + 1] * .7152 + data[offset + 2] * .0722;
};

export function openingRatioFromMask(mask) {
  if (!mask?.length) return 0;
  return mask.reduce((sum, value) => sum + value / 255, 0) / mask.length;
}

export function maskToCellFractions(mask, width, height, ns, nt) {
  if (!mask || mask.length !== width * height || !Number.isInteger(ns) || ns < 1 || !Number.isInteger(nt) || nt < 1) {
    throw new Error('개구부 마스크와 입면 격자를 확인해 주세요.');
  }
  const cells = [];
  for (let t = 0; t < nt; t++) {
    const y0 = Math.floor((nt - 1 - t) * height / nt), y1 = Math.max(y0 + 1, Math.floor((nt - t) * height / nt));
    for (let s = 0; s < ns; s++) {
      const x0 = Math.floor(s * width / ns), x1 = Math.max(x0 + 1, Math.floor((s + 1) * width / ns));
      let masked = 0, count = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        masked += mask[y * width + x] / 255; count++;
      }
      cells.push(Math.max(0, Math.min(1, 1 - masked / count)));
    }
  }
  return cells;
}

export function paintMask(mask, width, height, cx, cy, radius, value) {
  if (!mask || mask.length !== width * height || !(radius > 0)) return;
  const x0 = Math.max(0, Math.floor(cx - radius)), x1 = Math.min(width - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius)), y1 = Math.min(height - 1, Math.ceil(cy + radius));
  const squared = radius * radius, next = Math.max(0, Math.min(255, value));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if ((x - cx) ** 2 + (y - cy) ** 2 <= squared) mask[y * width + x] = next;
  }
}

const uniqueSorted = values => [...values].sort((a, b) => a - b)
  .filter((value, index, array) => !index || Math.abs(value - array[index - 1]) > 1e-4);

const typicalStep = values => {
  const unique = uniqueSorted(values);
  if (unique.length < 2) return 1;
  const gaps = unique.slice(1).map((value, index) => value - unique[index]).sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] || 1;
};

/** Map a photo-space opening mask to the actual facade sensor patches. */
export function sensorAvailabilitiesFromMask(mask, width, height, sensors) {
  if (!mask || mask.length !== width * height || !(width > 0) || !(height > 0)) {
    throw new Error('센서에 대응할 개구부 마스크를 확인해 주세요.');
  }
  if (!Array.isArray(sensors) || !sensors.length) return [];
  const normalLength = Math.hypot(
    sensors.reduce((sum, sensor) => sum + Number(sensor.nx || 0), 0),
    sensors.reduce((sum, sensor) => sum + Number(sensor.ny || 0), 0),
  );
  if (!(normalLength > 0)) throw new Error('입면 센서의 표면 방향을 확인해 주세요.');
  const nx = sensors.reduce((sum, sensor) => sum + Number(sensor.nx || 0), 0) / normalLength;
  const ny = sensors.reduce((sum, sensor) => sum + Number(sensor.ny || 0), 0) / normalLength;
  // Looking at the facade from outside, screen-right is (-ny, nx).
  const samples = sensors.map(sensor => ({
    along: Number(sensor.x) * -ny + Number(sensor.y) * nx,
    z: Number(sensor.z),
  }));
  if (samples.some(sample => !Number.isFinite(sample.along) || !Number.isFinite(sample.z))) {
    throw new Error('입면 센서 좌표를 확인해 주세요.');
  }
  const alongStep = typicalStep(samples.map(sample => sample.along));
  const zStep = typicalStep(samples.map(sample => sample.z));
  const alongMin = Math.min(...samples.map(sample => sample.along)) - alongStep / 2;
  const alongMax = Math.max(...samples.map(sample => sample.along)) + alongStep / 2;
  const zMin = Math.min(...samples.map(sample => sample.z)) - zStep / 2;
  const zMax = Math.max(...samples.map(sample => sample.z)) + zStep / 2;
  const px = value => Math.max(0, Math.min(width, Math.round((value - alongMin) / (alongMax - alongMin) * width)));
  const py = value => Math.max(0, Math.min(height, Math.round((zMax - value) / (zMax - zMin) * height)));
  return samples.map(sample => {
    const x0 = px(sample.along - alongStep / 2), x1 = px(sample.along + alongStep / 2);
    const y0 = py(sample.z + zStep / 2), y1 = py(sample.z - zStep / 2);
    let openings = 0, count = 0;
    for (let y = y0; y < Math.max(y0 + 1, y1); y++) for (let x = x0; x < Math.max(x0 + 1, x1); x++) {
      openings += mask[Math.min(height - 1, y) * width + Math.min(width - 1, x)] / 255; count++;
    }
    return Math.max(0, Math.min(1, 1 - openings / Math.max(1, count)));
  });
}

export function cellFractionsToMask(cells, ns, nt) {
  if (!Array.isArray(cells) || cells.length !== ns * nt || ns < 1 || nt < 1) {
    throw new Error('저장된 입면 설치 가능 비율을 확인해 주세요.');
  }
  const mask = new Uint8ClampedArray(ns * nt);
  for (let t = 0; t < nt; t++) for (let s = 0; s < ns; s++) {
    mask[(nt - 1 - t) * ns + s] = Math.round((1 - cells[t * ns + s]) * 255);
  }
  return {mask, width: ns, height: nt};
}

/**
 * Lightweight facade-opening proposal generator.
 *
 * It returns an editable pixel mask. Dark/contrasting, edge-rich regions
 * become window/door candidates and are later aggregated only for area math.
 */
export function analyzeFacadeOpenings(image, ns, nt) {
  if (!image || !(image.width > 0) || !(image.height > 0) || !image.data) {
    throw new Error('보정된 입면 사진이 필요해요.');
  }
  if (!Number.isInteger(ns) || ns < 1 || !Number.isInteger(nt) || nt < 1) {
    throw new Error('입면 격자 크기가 올바르지 않아요.');
  }

  const {width, height, data} = image;
  const sampleStep = Math.max(1, Math.floor(Math.sqrt(width * height / 12000)));
  const samples = [];
  for (let y = 0; y < height; y += sampleStep) for (let x = 0; x < width; x += sampleStep) {
    const offset = (y * width + x) * 4;
    const r = data[offset], g = data[offset + 1], b = data[offset + 2];
    const here = lumaAt(data, width, x, y);
    const right = x + sampleStep < width ? lumaAt(data, width, x + sampleStep, y) : here;
    const below = y + sampleStep < height ? lumaAt(data, width, x, y + sampleStep) : here;
    samples.push({r, g, b, luma: here, edge: (Math.abs(here - right) + Math.abs(here - below)) / 2});
  }
  const centers = {
    r: median(samples.map(pixel => pixel.r)),
    g: median(samples.map(pixel => pixel.g)),
    b: median(samples.map(pixel => pixel.b)),
    luma: median(samples.map(pixel => pixel.luma)),
    edge: median(samples.map(pixel => pixel.edge)),
  };
  const colorDistances = samples.map(pixel => Math.hypot(
    pixel.r - centers.r, pixel.g - centers.g, pixel.b - centers.b,
  ));
  const scales = {
    color: robustScale(colorDistances, median(colorDistances), 18),
    luma: robustScale(samples.map(pixel => pixel.luma), centers.luma, 14),
    edge: robustScale(samples.map(pixel => pixel.edge), centers.edge, 5),
  };
  const raw = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    const r = data[offset], g = data[offset + 1], b = data[offset + 2], luma = lumaAt(data, width, x, y);
    const contrast = Math.hypot(r - centers.r, g - centers.g, b - centers.b) / scales.color;
    const darkness = Math.max(0, (centers.luma - luma) / scales.luma);
    const right = x + 1 < width ? lumaAt(data, width, x + 1, y) : luma;
    const below = y + 1 < height ? lumaAt(data, width, x, y + 1) : luma;
    const edge = Math.max(0, ((Math.abs(luma - right) + Math.abs(luma - below)) / 2 - centers.edge) / scales.edge);
    const score = contrast * .68 + darkness * .72 + edge * .22;
    raw[y * width + x] = score >= 1.55 ? 255 : score >= 1.02 ? 150 : 0;
  }
  const mask = new Uint8ClampedArray(raw.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let active = 0, strong = 0, count = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
      const value = raw[yy * width + xx];
      if (value > 0) active++;
      if (value === 255) strong++;
      count++;
    }
    mask[y * width + x] = strong >= 3 || active >= Math.ceil(count * .7) ? 255
      : active >= Math.ceil(count * .45) ? 150 : 0;
  }
  const cells = maskToCellFractions(mask, width, height, ns, nt);
  const openingRatio = openingRatioFromMask(mask);
  return {
    cells, mask, width, height, openingRatio,
    maskedPixelCount: mask.filter(value => value >= 200).length,
    uncertainPixelCount: mask.filter(value => value > 0 && value < 200).length,
  };
}

export function closestFacadeByAzimuth(faces, azimuthDeg) {
  if (!Array.isArray(faces) || !Number.isFinite(Number(azimuthDeg))) return null;
  const facades = faces.filter(face => face?.type === 'facade' && Number.isFinite(Number(face.azimuth_deg)));
  if (!facades.length) return null;
  const distance = value => {
    const delta = Math.abs((((Number(value) - Number(azimuthDeg)) % 360) + 360) % 360);
    return Math.min(delta, 360 - delta);
  };
  return facades.reduce((best, face) => distance(face.azimuth_deg) < distance(best.azimuth_deg) ? face : best);
}
