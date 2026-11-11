/**
 * Canvas2D isometric drawing primitives (mock: poly, shade, oBox, aaBox, cyl, wheel, circleGrid, pill, star).
 * A Painter binds a 2D context to a live camera; all coordinates are grid tiles unless noted.
 */
import { type Camera, rotateGrid, TH, TW } from './iso.js';

export type Pt = [number, number];

const shadeCache = new Map<string, string>();

/** Multiply an #RRGGBB colour's channels by f (cached). */
export function shade(hex: string, f: number): string {
  const key = hex + f;
  let c = shadeCache.get(key);
  if (c) return c;
  const n = parseInt(hex.slice(1), 16);
  const ch = (s: number) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * f)));
  c = `rgb(${ch(16)},${ch(8)},${ch(0)})`;
  shadeCache.set(key, c);
  return c;
}

/** Convex hull (Andrew's monotone chain) of screen points, counter-clockwise. */
export function convexHull(points: readonly Pt[]): Pt[] {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

export class Painter {
  constructor(
    public readonly ctx: CanvasRenderingContext2D,
    public readonly cam: Camera,
  ) {}

  /** Project grid (gx, gy, z) to screen. */
  P(gx: number, gy: number, z = 0): Pt {
    const c = this.cam;
    const [rx, ry] = rotateGrid(gx, gy, c.rot ?? 0);
    return [c.x + (((rx - ry) * TW) / 2) * c.zoom, c.y + (((rx + ry) * TH) / 2 - z) * c.zoom];
  }

  poly(pts: Pt[], fill: string | null, stroke?: string | null, lw = 1): void {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      if (i) ctx.lineTo(pts[i][0], pts[i][1]);
      else ctx.moveTo(pts[i][0], pts[i][1]);
    }
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lw;
      ctx.stroke();
    }
  }

  /** Fast zero-allocation 4-point polygon draw. */
  quad(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number,
    fill: string | null,
    stroke?: string | null,
    lw = 1,
  ): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x3, y3);
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lw;
      ctx.stroke();
    }
  }

  /** Floor-plane quad for a whole tile (or w x h tiles). */
  tile(x: number, y: number, fill: string | null, stroke?: string | null, lw = 1, w = 1, h = 1): void {
    const c = this.cam;
    const xw = x + w;
    const yh = y + h;
    if (c.rot) {
      const [x0, y0] = this.P(x, y);
      const [x1, y1] = this.P(xw, y);
      const [x2, y2] = this.P(xw, yh);
      const [x3, y3] = this.P(x, yh);
      this.quad(x0, y0, x1, y1, x2, y2, x3, y3, fill, stroke, lw);
      return;
    }
    const z = c.zoom;
    const hw = (TW / 2) * z;
    const hh = (TH / 2) * z;
    this.quad(
      c.x + (x - y) * hw,
      c.y + (x + y) * hh,
      c.x + (xw - y) * hw,
      c.y + (xw + y) * hh,
      c.x + (xw - yh) * hw,
      c.y + (xw + yh) * hh,
      c.x + (x - yh) * hw,
      c.y + (x + yh) * hh,
      fill,
      stroke,
      lw,
    );
  }

  /**
   * Oriented extruded box centred at (cx, cy) with heading a. A side face is visible when
   * its outward normal satisfies nx + ny > 0 (camera looks from +x,+y); visible sides draw
   * back to front, then the top with a crisp specular bevel highlight.
   */
  oBox(
    cx: number,
    cy: number,
    len: number,
    wid: number,
    a: number,
    z0: number,
    h: number,
    hex: string,
    stroke?: string,
  ): void {
    const c = this.cam;
    const rot = c.rot ?? 0;
    if (a === 0 && !rot) {
      this.aaBox(cx - len / 2, cy - wid / 2, len, wid, z0, h, hex, stroke);
      return;
    }
    const [rcx, rcy] = rotateGrid(cx, cy, rot);
    const ra = a + rot;
    const z = c.zoom;
    const hw = (TW / 2) * z;
    const hh = (TH / 2) * z;
    const zOff0 = z0 * z;
    const dz = h * z;

    const ca = Math.cos(ra);
    const sa = Math.sin(ra);
    const hl = len / 2;
    const hwid = wid / 2;

    const gx0 = rcx + ca * hl - sa * hwid;
    const gy0 = rcy + sa * hl + ca * hwid;
    const gx1 = rcx + ca * hl + sa * hwid;
    const gy1 = rcy + sa * hl - ca * hwid;
    const gx2 = rcx - ca * hl + sa * hwid;
    const gy2 = rcy - sa * hl - ca * hwid;
    const gx3 = rcx - ca * hl - sa * hwid;
    const gy3 = rcy - sa * hl + ca * hwid;

    const sx0 = c.x + (gx0 - gy0) * hw;
    const sy0 = c.y + (gx0 + gy0) * hh - zOff0;
    const sx1 = c.x + (gx1 - gy1) * hw;
    const sy1 = c.y + (gx1 + gy1) * hh - zOff0;
    const sx2 = c.x + (gx2 - gy2) * hw;
    const sy2 = c.y + (gx2 + gy2) * hh - zOff0;
    const sx3 = c.x + (gx3 - gy3) * hw;
    const sy3 = c.y + (gx3 + gy3) * hh - zOff0;

    const gxs = [gx0, gx1, gx2, gx3];
    const gys = [gy0, gy1, gy2, gy3];
    const sxs = [sx0, sx1, sx2, sx3];
    const sys = [sy0, sy1, sy2, sy3];

    let f0Idx = -1;
    let f0D = Infinity;
    let f0Left = false;
    let f1Idx = -1;
    let f1D = Infinity;
    let f1Left = false;

    for (let i = 0; i < 4; i++) {
      const j = (i + 1) & 3;
      const mx = (gxs[i] + gxs[j]) * 0.5;
      const my = (gys[i] + gys[j]) * 0.5;
      const nx = mx - rcx;
      const ny = my - rcy;
      if (nx + ny > 0.001) {
        const d = mx + my;
        const left = ny > nx;
        if (f0Idx === -1) {
          f0Idx = i;
          f0D = d;
          f0Left = left;
        } else if (d < f0D) {
          f1Idx = f0Idx;
          f1D = f0D;
          f1Left = f0Left;
          f0Idx = i;
          f0D = d;
          f0Left = left;
        } else {
          f1Idx = i;
          f1D = d;
          f1Left = left;
        }
      }
    }

    if (f0Idx !== -1) {
      const j = (f0Idx + 1) & 3;
      this.quad(
        sxs[f0Idx],
        sys[f0Idx],
        sxs[j],
        sys[j],
        sxs[j],
        sys[j] - dz,
        sxs[f0Idx],
        sys[f0Idx] - dz,
        shade(hex, f0Left ? 0.84 : 0.66),
        stroke,
      );
    }
    if (f1Idx !== -1) {
      const j = (f1Idx + 1) & 3;
      this.quad(
        sxs[f1Idx],
        sys[f1Idx],
        sxs[j],
        sys[j],
        sxs[j],
        sys[j] - dz,
        sxs[f1Idx],
        sys[f1Idx] - dz,
        shade(hex, f1Left ? 0.84 : 0.66),
        stroke,
      );
    }
    this.quad(
      sx0,
      sy0 - dz,
      sx1,
      sy1 - dz,
      sx2,
      sy2 - dz,
      sx3,
      sy3 - dz,
      shade(hex, 1.08),
      stroke,
    );

    const frontIdx = f1Idx !== -1 ? f1Idx : f0Idx;
    if (frontIdx !== -1 && dz >= 1.5) {
      const j = (frontIdx + 1) & 3;
      const ctx = this.ctx;
      ctx.beginPath();
      ctx.moveTo(sxs[frontIdx], sys[frontIdx] - dz);
      ctx.lineTo(sxs[j], sys[j] - dz);
      ctx.strokeStyle = shade(hex, 1.3);
      ctx.lineWidth = Math.max(0.75, 0.9 * z);
      ctx.stroke();
    }
  }

  /** Axis-aligned box with corner (x, y), footprint w x d, and top specular bevel highlight. Zero allocations. */
  aaBox(x: number, y: number, w: number, d: number, z0: number, h: number, hex: string, stroke?: string): void {
    const c = this.cam;
    if (c.rot) {
      this.oBox(x + w / 2, y + d / 2, w, d, 0, z0, h, hex, stroke);
      return;
    }
    const z = c.zoom;
    const hw = (TW / 2) * z;
    const hh = (TH / 2) * z;
    const zOff0 = z0 * z;
    const dz = h * z;

    const x1 = x + w;
    const y1 = y + d;

    // 0: (x1, y1), 1: (x1, y), 2: (x, y), 3: (x, y1)
    const sx0 = c.x + (x1 - y1) * hw;
    const sy0 = c.y + (x1 + y1) * hh - zOff0;
    const sx1 = c.x + (x1 - y) * hw;
    const sy1 = c.y + (x1 + y) * hh - zOff0;
    const sx2 = c.x + (x - y) * hw;
    const sy2 = c.y + (x + y) * hh - zOff0;
    const sx3 = c.x + (x - y1) * hw;
    const sy3 = c.y + (x + y1) * hh - zOff0;

    const rightCol = shade(hex, 0.66);
    const leftCol = shade(hex, 0.84);

    if (w < d) {
      // +x face (0->1) is further back than +y face (3->0)
      this.quad(sx0, sy0, sx1, sy1, sx1, sy1 - dz, sx0, sy0 - dz, rightCol, stroke);
      this.quad(sx3, sy3, sx0, sy0, sx0, sy0 - dz, sx3, sy3 - dz, leftCol, stroke);
    } else {
      this.quad(sx3, sy3, sx0, sy0, sx0, sy0 - dz, sx3, sy3 - dz, leftCol, stroke);
      this.quad(sx0, sy0, sx1, sy1, sx1, sy1 - dz, sx0, sy0 - dz, rightCol, stroke);
    }
    this.quad(sx0, sy0 - dz, sx1, sy1 - dz, sx2, sy2 - dz, sx3, sy3 - dz, shade(hex, 1.08), stroke);

    if (dz >= 1.5) {
      const ctx = this.ctx;
      ctx.beginPath();
      ctx.moveTo(sx3, sy3 - dz);
      ctx.lineTo(sx0, sy0 - dz);
      ctx.lineTo(sx1, sy1 - dz);
      ctx.strokeStyle = shade(hex, 1.3);
      ctx.lineWidth = Math.max(0.75, 0.9 * z);
      ctx.stroke();
    }
  }

  /**
   * Upright cylinder centred on grid point (cx, cy): radius r (tiles), base height z0 and
   * height h (iso px). A floor circle projects to an ellipse with radii r·√2·TW/2 and r·√2·TH/2.
   * The front half of the wall is shaded left→right (lit → shadow), then the lighter top cap.
   */
  cyl(cx: number, cy: number, r: number, z0: number, h: number, hex: string, stroke?: string): void {
    const ctx = this.ctx;
    const z = this.cam.zoom;
    const rx = r * Math.SQRT2 * (TW / 2) * z;
    const ry = r * Math.SQRT2 * (TH / 2) * z;
    if (rx <= 0 || ry <= 0) return;
    const [sx, sy] = this.P(cx, cy, z0);
    const top = sy - h * z;
    const wall = ctx.createLinearGradient(sx - rx, 0, sx + rx, 0);
    wall.addColorStop(0, shade(hex, 0.92));
    wall.addColorStop(0.55, shade(hex, 0.78));
    wall.addColorStop(1, shade(hex, 0.58));
    ctx.beginPath();
    ctx.moveTo(sx - rx, top);
    ctx.lineTo(sx - rx, sy);
    ctx.ellipse(sx, sy, rx, ry, 0, Math.PI, 0, true);
    ctx.lineTo(sx + rx, top);
    ctx.closePath();
    ctx.fillStyle = wall;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.ellipse(sx, top, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = shade(hex, 1.08);
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (h * z >= 1.5) {
      ctx.beginPath();
      ctx.ellipse(sx, top, rx * 0.92, ry * 0.92, 0, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.strokeStyle = shade(hex, 1.3);
      ctx.lineWidth = Math.max(0.75, 0.9 * z);
      ctx.stroke();
    }
  }

  /**
   * Wheel: a cylinder whose axle runs across heading `a`. `diam` / `tread` in tiles; `z0` / `h`
   * in iso px (the tyre's vertical extent, so it can be drawn taller than true scale). Draws the
   * hidden sidewall joined to the visible one as the tread (convex hull of both silhouettes), then
   * the camera-facing sidewall with a soft top-lit gradient.
   */
  wheel(
    cx: number,
    cy: number,
    diam: number,
    tread: number,
    a: number,
    z0: number,
    h: number,
    hex: string,
    stroke?: string,
  ): void {
    if (!(diam > 0 && tread > 0 && h > 0)) return;
    const rot = this.cam.rot ?? 0;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    const nx = -uy;
    const ny = ux;
    // Axle direction in camera space decides which sidewall faces the viewer (+x,+y is near).
    const [rnx, rny] = rotateGrid(nx, ny, rot);
    const near = rnx + rny >= 0 ? 1 : -1;
    const r = diam / 2;
    const rz = h / 2;
    const zc = z0 + rz;
    const N = 16;
    const face = (side: number): Pt[] => {
      const ox = cx + nx * side * (tread / 2);
      const oy = cy + ny * side * (tread / 2);
      const out: Pt[] = [];
      for (let i = 0; i < N; i++) {
        const t = (i / N) * Math.PI * 2;
        const c = Math.cos(t) * r;
        out.push(this.P(ox + ux * c, oy + uy * c, zc + Math.sin(t) * rz));
      }
      return out;
    };
    const farPts = face(-near);
    const nearPts = face(near);
    this.poly(convexHull(farPts.concat(nearPts)), shade(hex, 0.72), stroke);
    let minY = Infinity;
    let maxY = -Infinity;
    for (const q of nearPts) {
      if (q[1] < minY) minY = q[1];
      if (q[1] > maxY) maxY = q[1];
    }
    const ctx = this.ctx;
    if (typeof ctx.createLinearGradient === 'function' && maxY - minY > 0.5) {
      const g = ctx.createLinearGradient(0, minY, 0, maxY);
      g.addColorStop(0, shade(hex, 1.15));
      g.addColorStop(1, shade(hex, 0.82));
      ctx.beginPath();
      ctx.moveTo(nearPts[0][0], nearPts[0][1]);
      for (let i = 1; i < nearPts.length; i++) ctx.lineTo(nearPts[i][0], nearPts[i][1]);
      ctx.closePath();
      ctx.fillStyle = g;
      ctx.fill();
    } else {
      this.poly(nearPts, shade(hex, 1));
    }
  }

  /**
   * Soft oriented footprint shadow (rounded rectangle, three feathered layers) for a body of
   * `len` × `wid` tiles centred at (cx, cy) with heading `a`. Grounds models better than a disc.
   */
  footprintShadow(cx: number, cy: number, len: number, wid: number, a: number, alpha = 0.2): void {
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const layers: Array<[number, number]> = [
      [0.12, alpha * 0.35],
      [0.06, alpha * 0.45],
      [0, alpha * 0.6],
    ];
    for (const [grow, al] of layers) {
      const hl = len / 2 + grow;
      const hw = wid / 2 + grow;
      const rr = Math.min(hl, hw) * 0.45;
      const pts: Pt[] = [];
      const corners: Array<[number, number, number]> = [
        [hl - rr, hw - rr, 0],
        [-hl + rr, hw - rr, Math.PI / 2],
        [-hl + rr, -hw + rr, Math.PI],
        [hl - rr, -hw + rr, (3 * Math.PI) / 2],
      ];
      for (const [lx, ly, a0] of corners) {
        for (let i = 0; i <= 4; i++) {
          const t = a0 + (i / 4) * (Math.PI / 2);
          const px = lx + Math.cos(t) * rr;
          const py = ly + Math.sin(t) * rr;
          pts.push(this.P(cx + ca * px - sa * py, cy + sa * px + ca * py));
        }
      }
      this.poly(pts, `rgba(15,23,42,${al.toFixed(3)})`);
    }
  }

  /** Circle on the floor plane (an ellipse on screen). */
  circleGrid(cx: number, cy: number, r: number, n = 28): Pt[] {
    const pts: Pt[] = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      pts.push(this.P(cx + Math.cos(t) * r, cy + Math.sin(t) * r));
    }
    return pts;
  }

  /** Rounded label pill centred at screen (sx, sy). */
  pill(text: string, sx: number, sy: number, bg: string, fg = '#fff'): void {
    const ctx = this.ctx;
    ctx.font = '700 12px Inter, -apple-system, sans-serif';
    const w = ctx.measureText(text).width + 12;
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(sx - w / 2, sy - 10, w, 20, 7);
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, sx, sy + 0.5);
  }

  /** Five-point star at screen (sx, sy). */
  star(sx: number, sy: number, r: number, fill: string): void {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const rr = i % 2 ? r * 0.45 : r;
      const t = -Math.PI / 2 + (i * Math.PI) / 5;
      ctx.lineTo(sx + Math.cos(t) * rr, sy + Math.sin(t) * rr);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = '#92400E';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}
