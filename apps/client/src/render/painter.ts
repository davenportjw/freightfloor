/**
 * Canvas2D isometric drawing primitives (mock: poly, shade, oBox, aaBox, circleGrid, pill, star).
 * A Painter binds a 2D context to a live camera; all coordinates are grid tiles unless noted.
 */
import { type Camera, TH, TW } from './iso.js';

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

export class Painter {
  constructor(
    public readonly ctx: CanvasRenderingContext2D,
    public readonly cam: Camera,
  ) {}

  /** Project grid (gx, gy, z) to screen. */
  P(gx: number, gy: number, z = 0): Pt {
    const c = this.cam;
    return [c.x + (((gx - gy) * TW) / 2) * c.zoom, c.y + (((gx + gy) * TH) / 2 - z) * c.zoom];
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
    const z = c.zoom;
    const hw = (TW / 2) * z;
    const hh = (TH / 2) * z;
    const xw = x + w;
    const yh = y + h;
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
   * back to front, then the top.
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
    if (a === 0) {
      this.aaBox(cx - len / 2, cy - wid / 2, len, wid, z0, h, hex, stroke);
      return;
    }
    const c = this.cam;
    const z = c.zoom;
    const hw = (TW / 2) * z;
    const hh = (TH / 2) * z;
    const zOff0 = z0 * z;
    const dz = h * z;

    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const hl = len / 2;
    const hwid = wid / 2;

    const gx0 = cx + ca * hl - sa * hwid;
    const gy0 = cy + sa * hl + ca * hwid;
    const gx1 = cx + ca * hl + sa * hwid;
    const gy1 = cy + sa * hl - ca * hwid;
    const gx2 = cx - ca * hl + sa * hwid;
    const gy2 = cy - sa * hl - ca * hwid;
    const gx3 = cx - ca * hl - sa * hwid;
    const gy3 = cy - sa * hl + ca * hwid;

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
      const nx = mx - cx;
      const ny = my - cy;
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
      shade(hex, 1.06),
      stroke,
    );
  }

  /** Axis-aligned box with corner (x, y), footprint w x d. Zero allocations. */
  aaBox(x: number, y: number, w: number, d: number, z0: number, h: number, hex: string, stroke?: string): void {
    const c = this.cam;
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
    this.quad(sx0, sy0 - dz, sx1, sy1 - dz, sx2, sy2 - dz, sx3, sy3 - dz, shade(hex, 1.06), stroke);
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
