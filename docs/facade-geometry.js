// Orthographic projection of GIS coordinates: x east, y north, z up.
export function projectPoint([x, y, z], view) {
  const { yaw, pitch, scale, cx, cy, center = [0, 0, 0] } = view;
  x -= center[0]; y -= center[1]; z -= center[2];
  const side = x * Math.cos(yaw) + y * Math.sin(yaw);
  const toward = x * Math.sin(yaw) - y * Math.cos(yaw);
  return [cx + side * scale, cy - (z * Math.cos(pitch) - toward * Math.sin(pitch)) * scale,
    toward * Math.cos(pitch) + z * Math.sin(pitch)];
}

// Image corners are TL, TR, BR, BL as seen from outside the building.
export function facadeCorners(face) {
  const [a, b] = [face.p0, face.p1], h = face.height_m;
  return [[...a, h], [...b, h], [...b, 0], [...a, 0]];
}

export function imageTransform(corners, width, height) {
  if (!(width > 0 && height > 0)) throw new Error('사진 크기가 올바르지 않아요.');
  const [tl, tr, , bl] = corners;
  return [(tr[0] - tl[0]) / width, (tr[1] - tl[1]) / width,
    (bl[0] - tl[0]) / height, (bl[1] - tl[1]) / height, tl[0], tl[1]];
}

export function pointInPolygon([x, y], polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function validateCorners(points) {
  if (points.length !== 4) return false;
  const cross = points.map((p, i) => {
    const q = points[(i + 1) % 4], r = points[(i + 2) % 4];
    return (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]);
  });
  return cross.every(x => x > 1) && Math.abs(points.reduce((a, p, i) => {
    const q = points[(i + 1) % 4];
    return a + p[0] * q[1] - q[0] * p[1];
  }, 0)) > 50;
}
