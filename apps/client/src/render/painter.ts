/**
 * Canvas2D isometric drawing primitives (mock: poly, shade, oBox, aaBox, cyl, wheel, circleGrid, pill, star).
 * A Painter binds a 2D context to a live camera; all coordinates are grid tiles unless noted.
 */
import { type Camera, rotateGrid, TH, TW } from './iso.js';

export type Pt = [number, number];

const shadeCache = new Map<string, Map<number, string>>();

/** Multiply an #RRGGBB colour's channels by f (cached). */
export function shade(hex: string, f: number): string {
  // Two-level cache: no per-call key string (this runs thousands of times per frame).
  let byF = shadeCache.get(hex);
  if (!byF) shadeCache.set(hex, (byF = new Map()));
  let c = byF.get(f);
  if (c) return c;
  const n = parseInt(hex.slice(1), 16);
  const ch = (s: number) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * f)));
  c = `rgb(${ch(16)},${ch(8)},${ch(0)})`;
  byF.set(f, c);
  return c;
}

/** Unit circle table for wheel sidewalls (shared; wheels are drawn many times per frame). */
const WHEEL_SEGS = 14;
const WHEEL_COS = Array.from({ length: WHEEL_SEGS }, (_, i) => Math.cos((i / WHEEL_SEGS) * Math.PI * 2));
const WHEEL_SIN = Array.from({ length: WHEEL_SEGS }, (_, i) => Math.sin((i / WHEEL_SEGS) * Math.PI * 2));

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
   * hidden sidewall joined to the visible one as the tread silhouette, then the camera-facing
   * sidewall.
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
    // The projection is affine, so project the centre once and build both sidewalls from screen
    // vectors (no per-point P()/rotateGrid). The tread silhouette is the union of the far ellipse
    // and its translate by `d`: walk the ellipse once, taking the far point where the outline faces
    // away from `d` and the near point where it faces toward it (O(N), no hull sort).
    const z = this.cam.zoom;
    const [pcx, pcy] = this.P(cx, cy, z0 + h / 2);
    const [px1, py1] = this.P(cx + ux, cy + uy, z0 + h / 2);
    const [pnx, pny] = this.P(cx + nx, cy + ny, z0 + h / 2);
    const r = diam / 2;
    const ax = (px1 - pcx) * r; // screen vector of the wheel radius along the heading
    const ay = (py1 - pcy) * r;
    const bz = (h / 2) * z; // screen radius straight up
    const hx = (pnx - pcx) * (tread / 2) * near; // centre → near sidewall
    const hy = (pny - pcy) * (tread / 2) * near;
    const N = WHEEL_SEGS;
    const ctx = this.ctx;
    // Far sidewall points F_i = c - h + a·cos t - (0, bz)·sin t; near N_i = F_i + 2h.
    const fx = pcx - hx;
    const fy = pcy - hy;
    const dx = 2 * hx;
    const dy = 2 * hy;
    // Outward normal = orient · (ty, -tx), where orient is the winding of the projected ellipse.
    const orient = -ax * bz >= 0 ? 1 : -1;
    ctx.beginPath();
    let prevSide = 0;
    for (let i = 0; i <= N; i++) {
      const k = i % N;
      const ct = WHEEL_COS[k];
      const st = WHEEL_SIN[k];
      const ox = ax * ct;
      const oy = ay * ct - bz * st;
      // Outline tangent at t is a·(-sin t) - (0,bz)·cos t; the outward normal facing `d` picks the face.
      const tx = -ax * st;
      const ty = -ay * st - bz * ct;
      const side = orient * (ty * dx - tx * dy) >= 0 ? 1 : -1;
      const px = fx + ox;
      const py = fy + oy;
      if (i === 0) {
        if (side > 0) ctx.moveTo(px + dx, py + dy);
        else ctx.moveTo(px, py);
      } else {
        if (side !== prevSide) {
          // Bridge across the silhouette edge (both copies of this point).
          if (side > 0) {
            ctx.lineTo(px, py);
            ctx.lineTo(px + dx, py + dy);
          } else {
            ctx.lineTo(px + dx, py + dy);
            ctx.lineTo(px, py);
          }
        } else if (side > 0) ctx.lineTo(px + dx, py + dy);
        else ctx.lineTo(px, py);
      }
      prevSide = side;
    }
    ctx.closePath();
    ctx.fillStyle = shade(hex, 0.72);
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    // Camera-facing sidewall (flat-lit: a per-wheel gradient cost more than the rest of the wheel).
    const nxs = pcx + hx;
    const nys = pcy + hy;
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
      const px = nxs + ax * WHEEL_COS[i];
      const py = nys + ay * WHEEL_COS[i] - bz * WHEEL_SIN[i];
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = shade(hex, 1.02);
    ctx.fill();
  }

  /**
   * Soft oriented footprint shadow (rounded rectangle, three feathered layers) for a body of
   * `len` × `wid` tiles centred at (cx, cy) with heading `a`. Grounds models better than a disc.
   */
  footprintShadow(cx: number, cy: number, len: number, wid: number, a: number, alpha = 0.2): void {
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    // Three feathered layers up close; one layer (same overall darkness) when zoomed out.
    const layers: Array<[number, number]> =
      this.cam.zoom >= 1.2
        ? [
            [0.12, alpha * 0.35],
            [0.06, alpha * 0.45],
            [0, alpha * 0.6],
          ]
        : [[0.05, alpha * 0.85]];
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
        const segs = this.cam.zoom >= 1.2 ? 4 : 2;
        for (let i = 0; i <= segs; i++) {
          const t = a0 + (i / segs) * (Math.PI / 2);
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
