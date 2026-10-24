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

function cellFeatures(image, ns, nt) {
  const {width, height, data} = image;
  const features = [];
  for (let t = 0; t < nt; t++) {
    const y0 = Math.floor((nt - 1 - t) * height / nt);
    const y1 = Math.max(y0 + 1, Math.floor((nt - t) * height / nt));
    for (let s = 0; s < ns; s++) {
      const x0 = Math.floor(s * width / ns);
      const x1 = Math.max(x0 + 1, Math.floor((s + 1) * width / ns));
      const step = Math.max(1, Math.floor(Math.min(x1 - x0, y1 - y0) / 14));
      let red = 0, green = 0, blue = 0, edge = 0, count = 0;
      for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
        const offset = (y * width + x) * 4;
        red += data[offset]; green += data[offset + 1]; blue += data[offset + 2];
        const here = lumaAt(data, width, x, y);
        if (x + step < x1) edge += Math.abs(here - lumaAt(data, width, x + step, y));
        if (y + step < y1) edge += Math.abs(here - lumaAt(data, width, x, y + step));
        count++;
      }
      const r = red / count, g = green / count, b = blue / count;
      features.push({
        s, t, r, g, b,
        luma: r * .2126 + g * .7152 + b * .0722,
        edge: edge / Math.max(1, count),
      });
    }
  }
  return features;
}

/**
 * Lightweight facade-opening proposal generator.
 *
 * It deliberately returns editable grid fractions rather than asserting a
 * pixel-perfect semantic segmentation. Dark/contrasting, edge-rich regions
 * become window/door candidates; uncertain cells remain at 50% so the user
 * can confirm them in the existing grid editor.
 */
export function analyzeFacadeOpenings(image, ns, nt) {
  if (!image || !(image.width > 0) || !(image.height > 0) || !image.data) {
    throw new Error('보정된 입면 사진이 필요해요.');
  }
  if (!Number.isInteger(ns) || ns < 1 || !Number.isInteger(nt) || nt < 1) {
    throw new Error('입면 격자 크기가 올바르지 않아요.');
  }

  const features = cellFeatures(image, ns, nt);
  const centers = {
    r: median(features.map(cell => cell.r)),
    g: median(features.map(cell => cell.g)),
    b: median(features.map(cell => cell.b)),
    luma: median(features.map(cell => cell.luma)),
    edge: median(features.map(cell => cell.edge)),
  };
  const colorDistances = features.map(cell => Math.hypot(
    cell.r - centers.r, cell.g - centers.g, cell.b - centers.b,
  ));
  const scales = {
    color: robustScale(colorDistances, median(colorDistances), 18),
    luma: robustScale(features.map(cell => cell.luma), centers.luma, 14),
    edge: robustScale(features.map(cell => cell.edge), centers.edge, 5),
  };

  const scored = features.map((cell, index) => {
    const contrast = colorDistances[index] / scales.color;
    const darkness = Math.max(0, (centers.luma - cell.luma) / scales.luma);
    const edge = Math.max(0, (cell.edge - centers.edge) / scales.edge);
    return {...cell, score: contrast * .7 + darkness * .75 + edge * .45};
  });
  const at = (s, t) => scored[t * ns + s];
  const neighborSupport = cell => {
    let support = 0;
    for (let dt = -1; dt <= 1; dt++) for (let ds = -1; ds <= 1; ds++) {
      if (!ds && !dt) continue;
      const other = at(cell.s + ds, cell.t + dt);
      if (other?.score >= 1.05) support++;
    }
    return support;
  };

  const labels = scored.map(cell => {
    const supported = neighborSupport(cell) > 0;
    if (cell.score >= 1.75 || (cell.score >= 1.2 && supported)) {
      return cell.t < Math.max(1, Math.ceil(nt * .3)) ? 'door' : 'window';
    }
    if (cell.score >= .82) return 'uncertain';
    return 'wall';
  });
  const cells = labels.map(label => label === 'wall' ? 1 : label === 'uncertain' ? .5 : 0);
  const openingEquivalent = cells.reduce((sum, value) => sum + 1 - value, 0);
  return {
    cells,
    labels,
    openingRatio: openingEquivalent / cells.length,
    windowCount: labels.filter(label => label === 'window').length,
    doorCount: labels.filter(label => label === 'door').length,
    uncertainCount: labels.filter(label => label === 'uncertain').length,
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
