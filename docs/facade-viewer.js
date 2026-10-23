import { projectPoint, facadeCorners, imageTransform, pointInPolygon } from './facade-geometry.js';

// A small orthographic software renderer. No external CDN or GPU is required.
export class FacadeViewer {
  constructor(canvas, onSelect) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.onSelect = onSelect;
    this.photos = {}; this.selected = null; this.context = false; this.hits = [];
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

  setSite(site) { this.site = site; this.photos = {}; this.selected = null; this.reset(); }
  setPhotos(photos) { this.photos = photos; this.draw(); }
  select(id) { this.selected = id; this.draw(); }
  setContext(show) { this.context = show; this.draw(); }
  zoomBy(factor) { this.zoom = Math.max(.5, Math.min(3, this.zoom * factor)); this.draw(); }
  reset() { this.yaw = -.45; this.pitch = .48; this.zoom = 1; this.draw(); }
  faceFront() {
    const f = this.site?.faces.find(f => f.face_id === this.selected);
    if (!f?.p0) return;
    const dx = f.p1[0] - f.p0[0], dy = f.p1[1] - f.p0[1];
    this.yaw = Math.atan2(dy, dx); this.pitch = .12; this.zoom = 1; this.draw();
  }

  draw() {
    if (!this.site) return;
    const width = this.canvas.clientWidth, height = this.canvas.clientHeight;
    if (!width || !height) return;
    const dpr = Math.min(devicePixelRatio || 1, 2), g = this.ctx;
    if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) {
      this.canvas.width = Math.round(width * dpr); this.canvas.height = Math.round(height * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, width, height);
    g.fillStyle = '#e8efeb'; g.fillRect(0, 0, width, height);
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
}
