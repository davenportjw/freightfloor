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

  /** Floor-plane quad for a whole tile (or w x h tiles). */
  tile(x: number, y: number, fill: string | null, stroke?: string | null, lw = 1, w = 1, h = 1): void {
    this.poly([this.P(x, y), this.P(x + w, y), this.P(x + w, y + h), this.P(x, y + h)], fill, stroke, lw);
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
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const hl = len / 2;
    const hw = wid / 2;
    const L: Pt[] = [
      [hl, hw],
      [hl, -hw],
      [-hl, -hw],
      [-hl, hw],
    ].map(([u, v]) => [cx + ca * u - sa * v, cy + sa * u + ca * v]);
    const faces: Array<{ A: Pt; B: Pt; d: number; left: boolean }> = [];
    for (let i = 0; i < 4; i++) {
      const A = L[i];
      const B = L[(i + 1) % 4];
      const mx = (A[0] + B[0]) / 2;
      const my = (A[1] + B[1]) / 2;
      const nx = mx - cx;
      const ny = my - cy;
      if (nx + ny > 0.001) faces.push({ A, B, d: mx + my, left: ny > nx });
    }
    faces.sort((p, q) => p.d - q.d);
    for (const f of faces) {
      this.poly(
        [
          this.P(f.A[0], f.A[1], z0),
          this.P(f.B[0], f.B[1], z0),
          this.P(f.B[0], f.B[1], z0 + h),
          this.P(f.A[0], f.A[1], z0 + h),
        ],
        shade(hex, f.left ? 0.84 : 0.66),
        stroke,
      );
    }
    this.poly(
      L.map((p) => this.P(p[0], p[1], z0 + h)),
      shade(hex, 1.06),
      stroke,
    );
  }

  /** Axis-aligned box with corner (x, y), footprint w x d. */
  aaBox(x: number, y: number, w: number, d: number, z0: number, h: number, hex: string, stroke?: string): void {
    this.oBox(x + w / 2, y + d / 2, w, d, 0, z0, h, hex, stroke);
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
