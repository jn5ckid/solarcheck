import { projectPoint, facadeCorners, imageTransform, pointInPolygon } from './facade-geometry.js';

export const RESEARCH_SENSOR_DISPLAY_OFFSET_M = .05;

// Rendering-only separation: inference keeps the frozen research XYZ unchanged.
export function researchDisplayPoint(sensor, anchor = [0, 0], zBase = 0, offset = RESEARCH_SENSOR_DISPLAY_OFFSET_M) {
  return [
    sensor.x - anchor[0] + (sensor.nx || 0) * offset,
    sensor.y - anchor[1] + (sensor.ny || 0) * offset,
    sensor.z - zBase + (sensor.nz || 0) * offset,
  ];
}

export function researchPointRadii(zoom = 1, contextVisible = false) {
  const scale = contextVisible ? .2 : 1;
  const sensor = Math.max(2.4, Math.min(5.2, 3.2 * zoom));
  return {sensor: sensor * scale, draft: Math.max(1.8, sensor - .8) * scale, halo: 3 * scale};
}

const uniqueSorted = values => [...values].sort((a, b) => a - b)
  .filter((value, index, array) => !index || Math.abs(value - array[index - 1]) > 1e-6);

const cellBounds = (centers, low, high) => centers.map((center, index) => [
  index ? (centers[index - 1] + center) / 2 : low,
  index + 1 < centers.length ? (center + centers[index + 1]) / 2 : high,
]);

export function facadeHeatmapCells(candidates, edgeStart, edgeEnd, height, anchor = [0, 0], zBase = 0) {
  if (!candidates.length || !(height > 0)) return [];
  const dx = edgeEnd[0] - edgeStart[0], dy = edgeEnd[1] - edgeStart[1];
  const width = Math.hypot(dx, dy);
  if (!(width > 0)) return [];
  const tangent = [dx / width, dy / width];
  const samples = candidates.map(sensor => {
    const x = sensor.x - anchor[0], y = sensor.y - anchor[1];
    return {...sensor, along: (x - edgeStart[0]) * tangent[0] + (y - edgeStart[1]) * tangent[1], localZ: sensor.z - zBase};
  });
  const columns = uniqueSorted(samples.map(sensor => sensor.along));
  const rows = uniqueSorted(samples.map(sensor => sensor.localZ));
  const columnBounds = cellBounds(columns, 0, width), rowBounds = cellBounds(rows, 0, height);
  const nearest = (values, value) => values.reduce((best, item, index) =>
    Math.abs(item - value) < Math.abs(values[best] - value) ? index : best, 0);
  return samples.map(sensor => {
    const [s0, s1] = columnBounds[nearest(columns, sensor.along)];
    const [z0, z1] = rowBounds[nearest(rows, sensor.localZ)];
    const at = (distance, z) => [edgeStart[0] + tangent[0] * distance, edgeStart[1] + tangent[1] * distance, z];
    return {color: sensor.color, points: [at(s0, z0), at(s1, z0), at(s1, z1), at(s0, z1)]};
  });
}

function meanColor(sensors, fallback) {
  const colors = sensors.map(sensor => String(sensor.color || '').match(/\d+/g)?.slice(0, 3).map(Number)).filter(Boolean);
  if (!colors.length) return fallback;
  const mean = index => Math.round(colors.reduce((sum, value) => sum + value[index], 0) / colors.length);
  return `rgb(${mean(0)},${mean(1)},${mean(2)})`;
}

// A small orthographic software renderer. No external CDN or GPU is required.
export class FacadeViewer {
  constructor(canvas, onSelect, onResearchSelect = () => {}) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.onSelect = onSelect; this.onResearchSelect = onResearchSelect;
    this.photos = {}; this.selected = null; this.context = false; this.draft = false; this.points = true; this.heatmap = false; this.hits = [];
    this.yaw = -.45; this.pitch = .48; this.zoom = 1;
    this.observer = new ResizeObserver(() => this.draw());
    this.observer.observe(canvas.parentElement);
    canvas.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      this.pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', e => {
      const p = this.pointer;
      if (!p || p.id !== e.pointerId) return;
      this.yaw -= (e.clientX - p.x) * .01;
      this.pitch = Math.max(.05, Math.min(1.3, this.pitch + (e.clientY - p.y) * .008));
      p.x = e.clientX; p.y = e.clientY; this.draw();
    });
    canvas.addEventListener('pointerup', e => {
      const p = this.pointer; this.pointer = null;
      if (!p || p.id !== e.pointerId) return;
      if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) < 6) {
        const rect = canvas.getBoundingClientRect(), point = [e.clientX - rect.left, e.clientY - rect.top];
        if (this.mode === 'research') {
          const hit = [...this.hits].reverse().find(h => Math.hypot(point[0] - h.x, point[1] - h.y) <= 9);
          if (hit?.sensor) { this.researchSelected = hit.sensor.sensor_row_index; this.onResearchSelect(hit.sensor); this.draw(); }
          return;
        }
        const hit = [...this.hits].reverse().find(f => pointInPolygon(point, f.points));
        if (hit?.faceId) this.onSelect(hit.faceId);
      }
    });
    canvas.addEventListener('pointercancel', () => { this.pointer = null; });
    canvas.addEventListener('wheel', e => {
      e.preventDefault(); this.zoom = Math.max(.5, Math.min(3, this.zoom * Math.exp(-e.deltaY * .001))); this.draw();
    }, { passive: false });
    canvas.addEventListener('keydown', e => {
      const move = { ArrowLeft: -.15, ArrowRight: .15 }[e.key];
      if (move !== undefined) this.yaw += move;
      else if (e.key === 'ArrowUp') this.pitch = Math.min(1.3, this.pitch + .1);
      else if (e.key === 'ArrowDown') this.pitch = Math.max(.05, this.pitch - .1);
      else if (e.key === '+' || e.key === '=') this.zoom = Math.min(3, this.zoom * 1.1);
      else if (e.key === '-') this.zoom = Math.max(.5, this.zoom / 1.1);
      else if (e.key === 'Home') { this.reset(); return; }
      else return;
      e.preventDefault(); this.draw();
    });
  }

  setSite(site) { this.mode = 'facade'; this.site = site; this.research = null; this.draft = false; this.points = true; this.heatmap = false; this.photos = {}; this.selected = null; this.reset(); }
  setResearch(research) {
    this.mode = 'research'; this.research = research; this.site = research.site || null;
    this.draft = !!research.draftSensors?.length; this.points = true; this.researchGroup = null; this.researchSelected = null; this.reset();
  }
  setResearchGroup(group) { this.researchGroup = group; this.researchSelected = null; this.draw(); }
  selectResearchSensor(sensorRowIndex) { this.researchSelected = sensorRowIndex; this.draw(); }
  setPhotos(photos) { this.photos = photos; this.draw(); }
  select(id) { this.selected = id; this.draw(); }
  setContext(show) { this.context = show; this.draw(); }
  setDraft(show) { this.draft = show; this.draw(); }
  setPoints(show) { this.points = show; this.draw(); }
  setHeatmap(show) { this.heatmap = show; this.draw(); }
  zoomBy(factor) { this.zoom = Math.max(.5, Math.min(3, this.zoom * factor)); this.draw(); }
  reset() { this.yaw = -.45; this.pitch = .48; this.zoom = 1; this.draw(); }
  faceFront() {
    if (this.mode === 'research') return;
    const f = this.site?.faces.find(f => f.face_id === this.selected);
    if (!f?.p0) return;
    const dx = f.p1[0] - f.p0[0], dy = f.p1[1] - f.p0[1];
    this.yaw = Math.atan2(dy, dx); this.pitch = .12; this.zoom = 1; this.draw();
  }

  draw() {
    const width = this.canvas.clientWidth, height = this.canvas.clientHeight;
    if (!width || !height) return;
    const dpr = Math.min(devicePixelRatio || 1, 2), g = this.ctx;
    if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) {
      this.canvas.width = Math.round(width * dpr); this.canvas.height = Math.round(height * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, width, height);
    g.fillStyle = '#e8efeb'; g.fillRect(0, 0, width, height);
    this.hits = [];
    if (this.mode === 'research') { this.drawResearch(g, width, height); return; }
    if (!this.site?.building.height_m) {
      g.fillStyle = '#315442'; g.font = '14px system-ui'; g.textAlign = 'center';
      g.fillText('높이 확인 후 3D 입면을 만들 수 있어요.', width / 2, height / 2);
      g.textAlign = 'start'; return;
    }
    const site = this.site, targetHeight = site.building.height_m;
    const bounds = (this.context ? [site.target, ...site.context.map(b => b.footprint)] : [site.target]).flat();
    const xs = bounds.map(p => p[0]), ys = bounds.map(p => p[1]);
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), targetHeight);
    const tx = site.target.map(p => p[0]), ty = site.target.map(p => p[1]);
    const center = [(Math.min(...tx) + Math.max(...tx)) / 2, (Math.min(...ty) + Math.max(...ty)) / 2, targetHeight / 2];
    const view = { yaw: this.yaw, pitch: this.pitch, scale: Math.min(width * .72, height * .7) / span * this.zoom,
      cx: width / 2, cy: height / 2 + 12, center };
    const project = p => projectPoint(p, view);
    const normal = [Math.sin(this.yaw) * Math.cos(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch)];
    // Ground grid helps keep the building's orientation clear while rotating.
    const grid = Math.ceil(span / 5) * 5;
    g.strokeStyle = '#ccd9d1'; g.lineWidth = .6;
    for (let q = -grid; q <= grid; q += 5) {
      for (const line of [[[q, -grid, 0], [q, grid, 0]], [[-grid, q, 0], [grid, q, 0]]]) {
        const [a, b] = line.map(project); g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
      }
    }
    const polygons = [];
    const addBlock = (footprint, h, target) => {
      const ring = footprint.slice(0, -1);
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length], dx = b[0] - a[0], dy = b[1] - a[1];
        if (dy * normal[0] - dx * normal[1] <= 1e-7) continue;
        const face = target ? site.faces.find(f => f.type === 'facade' && Math.hypot(f.p0[0] - a[0], f.p0[1] - a[1]) < .01) : null;
        const faceId = face?.face_id;
        const points = facadeCorners({p0: a, p1: b, height_m: h}).map(project);
        polygons.push({ points, faceId, target, roof: false, depth: points.reduce((s, p) => s + p[2], 0) / 4,
          image: faceId ? this.photos[faceId]?.image : null });
      }
      const points = ring.map(([x, y]) => project([x, y, h]));
      polygons.push({ points, target, roof: true, depth: points.reduce((s, p) => s + p[2], 0) / points.length });
    };
    if (this.context) site.context.forEach(b => addBlock(b.footprint, b.height_m, false));
    addBlock(site.target, targetHeight, true);
    polygons.sort((a, b) => a.depth - b.depth);
    this.hits = [];
    const path = points => {
      g.beginPath(); points.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.closePath();
    };
    for (const p of polygons) {
      path(p.points);
      g.fillStyle = p.target ? (p.roof ? '#b6c6bd' : '#f5f7f2') : (p.roof ? '#b3c1b9' : '#cbd5cf');
      g.fill();
      if (p.image) {
        g.save(); path(p.points); g.clip();
        g.transform(...imageTransform(p.points, p.image.width, p.image.height));
        g.drawImage(p.image, 0, 0); g.restore();
      } else if (p.target && !p.roof) {
        g.strokeStyle = '#c3cec7'; g.lineWidth = .6;
        for (let floor = 1; floor < site.building.floors; floor++) {
          const t = floor / site.building.floors, [tl, tr, br, bl] = p.points;
          g.beginPath(); g.moveTo(bl[0] + (tl[0] - bl[0]) * t, bl[1] + (tl[1] - bl[1]) * t);
          g.lineTo(br[0] + (tr[0] - br[0]) * t, br[1] + (tr[1] - br[1]) * t); g.stroke();
        }
      }
      path(p.points); g.strokeStyle = p.faceId && p.faceId === this.selected ? '#d59200' : '#7d9587';
      g.lineWidth = p.faceId && p.faceId === this.selected ? 3 : .9; g.stroke();
      this.hits.push(p);
    }
    // Compass is projected consistently with the building, not fixed to the screen.
    const n = projectPoint([0, 10, 0], {...view, center: [0, 0, 0], cx: 0, cy: 0, scale: 2});
    g.strokeStyle = '#315442'; g.lineWidth = 2; g.beginPath(); g.moveTo(width - 38, height - 36);
    g.lineTo(width - 38 + n[0], height - 36 + n[1]); g.stroke();
    g.font = 'bold 12px system-ui'; g.fillStyle = '#315442'; g.fillText('N', width - 42 + n[0], height - 42 + n[1]);
  }

  drawResearch(g, width, height) {
    const all = this.research?.sensors ?? [];
    const sensors = this.researchGroup ? all.filter(s => s.surface_group_id === this.researchGroup) : all;
    if (!sensors.length) {
      g.fillStyle = '#315442'; g.font = '14px system-ui'; g.textAlign = 'center';
      g.fillText('표시할 연구 센서가 없어요.', width / 2, height / 2); g.textAlign = 'start'; return;
    }
    const site = this.site, anchor = this.research.anchor_xy || [0, 0];
    const candidates = this.research?.draftSensors ?? [];
    const drafts = this.draft ? candidates : [];
    const pointSensors = this.points
      ? sensors.filter(sensor => (sensor.installable_fraction ?? 1) > .01) : [];
    const rawZ = [...all, ...candidates].map(sensor => sensor.z), zBase = Math.min(...rawZ);
    const displayLocal = sensor => researchDisplayPoint(sensor, anchor, zBase);
    const sensorPoints = [...all, ...drafts].map(displayLocal), sensorSpanZ = Math.max(...rawZ) - zBase;
    const contextRadius = this.research.context_radius_m || 60;
    const ring = footprint => footprint.length > 1
      && footprint[0][0] === footprint.at(-1)[0] && footprint[0][1] === footprint.at(-1)[1]
      ? footprint.slice(0, -1) : footprint;
    const distanceToOrigin = footprint => Math.min(...ring(footprint).map(([x, y]) => Math.hypot(x, y)));
    const context = site && this.context
      ? site.context.filter(block => distanceToOrigin(block.footprint) <= contextRadius) : [];
    const targetHeight = site ? Math.max(site.building.height_m || 0, sensorSpanZ, 3) : sensorSpanZ;
    const masses = site ? [{footprint: site.target, height: targetHeight},
      ...context.map(block => ({footprint: block.footprint, height: block.height_m || 3}))] : [];
    const massPoints = masses.flatMap(mass => ring(mass.footprint)
      .flatMap(([x, y]) => [[x, y, 0], [x, y, mass.height]]));
    const bounds = [...sensorPoints, ...massPoints];
    const xs = bounds.map(p => p[0]), ys = bounds.map(p => p[1]), zs = bounds.map(p => p[2]);
    const center = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2,
      (Math.min(...zs) + Math.max(...zs)) / 2];
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys),
      Math.max(...zs) - Math.min(...zs), 5);
    const view = {yaw: this.yaw, pitch: this.pitch, scale: Math.min(width * .72, height * .68) / span * this.zoom,
      cx: width / 2, cy: height / 2 + 8, center};
    const project = point => projectPoint(point, view);
    const grid = Math.ceil(Math.max(...xs.map(Math.abs), ...ys.map(Math.abs), 10) / 5) * 5;
    g.strokeStyle = '#ccd9d1'; g.lineWidth = .6;
    for (let q = -grid; q <= grid; q += 5) {
      for (const line of [[[q, -grid, 0], [q, grid, 0]], [[-grid, q, 0], [grid, q, 0]]]) {
        const [a, b] = line.map(project); g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
      }
    }
    const normal = [Math.sin(this.yaw) * Math.cos(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch)];
    const primitives = [];
    const addBlock = (footprint, height, target) => {
      const points = ring(footprint);
      for (let i = 0; i < points.length; i++) {
        const a = points[i], b = points[(i + 1) % points.length], dx = b[0] - a[0], dy = b[1] - a[1];
        if (dy * normal[0] - dx * normal[1] <= 1e-7) continue;
        const polygon = facadeCorners({p0: a, p1: b, height_m: height}).map(project);
        const surfaceId = `candidate:F${String(i + 1).padStart(2, '0')}`;
        const surfaceCandidates = target && this.heatmap
          ? candidates.filter(sensor => sensor.surface_id === surfaceId && sensor.color
            && (sensor.installable_fraction ?? 1) > .01) : [];
        const heatCells = facadeHeatmapCells(surfaceCandidates, a, b, height, anchor, zBase)
          .map(cell => ({...cell, points: cell.points.map(project)}));
        primitives.push({type: 'mass', points: polygon, target, roof: false, heatCells,
          depth: polygon.reduce((sum, point) => sum + point[2], 0) / polygon.length});
      }
      const roof = points.map(([x, y]) => project([x, y, height]));
      const roofCandidates = target && this.heatmap
        ? candidates.filter(sensor => sensor.surface_type === 'Roof' && sensor.color) : [];
      const cellSize = this.research?.cell_target_m || 1.5;
      const roofHeatCells = roofCandidates.map(sensor => {
        const x = sensor.x - anchor[0], y = sensor.y - anchor[1], half = cellSize / 2;
        return {color: sensor.color, points: [[x - half, y - half, height], [x + half, y - half, height],
          [x + half, y + half, height], [x - half, y + half, height]].map(project)};
      });
      primitives.push({type: 'mass', points: roof, target, roof: true, heatCells: roofHeatCells,
        heatBase: meanColor(roofCandidates, 'rgba(172,190,179,.86)'),
        depth: roof.reduce((sum, point) => sum + point[2], 0) / roof.length});
    };
    context.forEach(block => addBlock(block.footprint, block.height_m || 3, false));
    if (site) addBlock(site.target, targetHeight, true);
    pointSensors.forEach(sensor => {
      const point = project(displayLocal(sensor));
      primitives.push({type: 'sensor', sensor, point, depth: point[2]});
    });
    drafts.forEach(sensor => {
      const point = project(displayLocal(sensor));
      primitives.push({type: 'draft', sensor, point, depth: point[2]});
    });
    primitives.sort((a, b) => a.depth - b.depth);
    const radii = researchPointRadii(this.zoom, this.context);
    const path = points => {
      g.beginPath(); points.forEach((point, index) => index ? g.lineTo(point[0], point[1]) : g.moveTo(point[0], point[1])); g.closePath();
    };
    for (const primitive of primitives) {
      if (primitive.type === 'mass') {
        path(primitive.points);
        g.fillStyle = primitive.target && primitive.heatCells?.length
          ? (primitive.roof ? primitive.heatBase : primitive.heatCells[0].color)
          : primitive.target
          ? (primitive.roof ? 'rgba(172,190,179,.86)' : 'rgba(238,244,239,.82)')
          : (primitive.roof ? '#aebdb4' : '#c7d2cc');
        g.fill();
        if (primitive.heatCells?.length) {
          g.save(); path(primitive.points); g.clip();
          for (const cell of primitive.heatCells) { path(cell.points); g.fillStyle = cell.color; g.fill(); }
          g.restore();
        }
        path(primitive.points);
        g.strokeStyle = primitive.target ? '#496b5a' : '#82978b'; g.lineWidth = primitive.target ? 1.5 : .8; g.stroke();
        continue;
      }
      const {sensor, point} = primitive;
      if (primitive.type === 'draft') {
        g.beginPath(); g.arc(point[0], point[1], radii.draft, 0, Math.PI * 2);
        g.fillStyle = sensor.color || 'rgba(232,239,235,.72)'; g.fill();
        g.strokeStyle = '#06758b'; g.lineWidth = 1.1; g.stroke();
        continue;
      }
      g.beginPath(); g.arc(point[0], point[1], radii.sensor, 0, Math.PI * 2); g.fillStyle = sensor.color; g.fill();
      if (!sensor.hourly_inference_eligible) { g.strokeStyle = '#782f2f'; g.lineWidth = 1.2; g.stroke(); }
      if (sensor.sensor_row_index === this.researchSelected) {
        g.beginPath(); g.arc(point[0], point[1], radii.sensor + radii.halo, 0, Math.PI * 2);
        g.strokeStyle = '#18302a'; g.lineWidth = 2; g.stroke();
      }
      this.hits.push({x: point[0], y: point[1], sensor});
    }
    const n = projectPoint([0, 10, 0], {...view, center: [0, 0, 0], cx: 0, cy: 0, scale: 2});
    g.strokeStyle = '#315442'; g.lineWidth = 2; g.beginPath(); g.moveTo(width - 38, height - 36);
    g.lineTo(width - 38 + n[0], height - 36 + n[1]); g.stroke();
    g.font = 'bold 12px system-ui'; g.fillStyle = '#315442'; g.fillText('N', width - 42 + n[0], height - 42 + n[1]);
  }
}
