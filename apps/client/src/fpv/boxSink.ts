/**
 * Recording "painter" for Cab View: lets the existing iso scenery builders (`drawRack`,
 * `drawStruct`, `drawCargoItem`, `drawConveyorItem`, `rigParts`, `vehicleParts`) emit real 3D
 * primitives instead of Canvas2D faces, so the first-person world uses the exact same shapes and
 * palette as the iso view. Pure (no three.js), safe for node tests.
 */
import type { Painter } from '../render/painter.js';
import { ISO_PX_PER_M, TILE_M } from '../render/liftGeometry.js';

export interface Prim {
  /** `wheel` = cylinder with its axle along the local Z (across the heading). */
  kind: 'box' | 'cyl' | 'wheel';
  /** Centre on the floor plane (grid units). */
  cx: number;
  cy: number;
  /** Box: size along its local X (grid units). Cylinder / wheel: diameter. */
  sx: number;
  /** Box: size along its local Z (grid units). Cylinder: diameter. Wheel: tread width. */
  sz: number;
  /** Bottom / height in iso-px (converted to metres by the renderer). */
  z0: number;
  h: number;
  /** Heading in radians (sim convention); 0 for axis-aligned. */
  a: number;
  /** Optional pitch about the box's lateral axis (rad, + = nose down). */
  pitch?: number;
  r: number;
  g: number;
  b: number;
  /** 0..1 opacity. */
  alpha: number;
}

const colorCache = new Map<string, [number, number, number, number]>();

/** Parse `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` / `rgba()` into linear-agnostic 0..1 sRGB + alpha. */
export function parseColor(css: string): [number, number, number, number] {
  const hit = colorCache.get(css);
  if (hit) return hit;
  let out: [number, number, number, number] = [0.5, 0.5, 0.5, 1];
  const s = css.trim();
  if (s.startsWith('#')) {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    const n = parseInt(h.slice(0, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    if (Number.isFinite(n)) out = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
  } else {
    const m = /rgba?\(([^)]+)\)/i.exec(s);
    if (m) {
      const p = m[1].split(',').map((v) => parseFloat(v));
      out = [(p[0] ?? 128) / 255, (p[1] ?? 128) / 255, (p[2] ?? 128) / 255, Number.isFinite(p[3]) ? p[3] : 1];
    }
  }
  colorCache.set(css, out);
  return out;
}

/** Collects primitives; duck-types the subset of `Painter` the scenery builders call. */
export class PrimRecorder {
  readonly prims: Prim[] = [];
  /** Zoom ≥ 0.7 so `drawRack` emits its detailed (shelf + cargo) model. */
  readonly cam = { x: 0, y: 0, zoom: 1, rot: 0 };
  /** Multiplies every recorded primitive's opacity (e.g. see-through carried cargo). */
  alphaMul = 1;

  clear(): void {
    this.prims.length = 0;
  }

  private push(p: Omit<Prim, 'r' | 'g' | 'b' | 'alpha'>, hex: string): void {
    const [r, g, b, a] = parseColor(hex);
    this.prims.push({ ...p, r, g, b, alpha: a * this.alphaMul });
  }

  aaBox(x: number, y: number, w: number, d: number, z0: number, h: number, hex: string): void {
    if (!(w > 0 && d > 0 && h > 0)) return;
    this.push({ kind: 'box', cx: x + w / 2, cy: y + d / 2, sx: w, sz: d, z0, h, a: 0 }, hex);
  }

  oBox(cx: number, cy: number, len: number, wid: number, a: number, z0: number, h: number, hex: string, pitch = 0): void {
    if (!(len > 0 && wid > 0 && h > 0)) return;
    this.push({ kind: 'box', cx, cy, sx: len, sz: wid, z0, h, a, ...(pitch ? { pitch } : {}) }, hex);
  }

  cyl(cx: number, cy: number, r: number, z0: number, h: number, hex: string): void {
    if (!(r > 0 && h > 0)) return;
    this.push({ kind: 'cyl', cx, cy, sx: r * 2, sz: r * 2, z0, h, a: 0 }, hex);
  }

  /**
   * True-scale round wheel: `diam` / `tread` in tiles, heading `a`, axle height in metres. Iso
   * stretches wheels vertically for readability; the 3D view must not, so the height here is
   * derived from the diameter rather than the iso part height.
   */
  axleWheel(cx: number, cy: number, diam: number, tread: number, a: number, axleM: number, hex: string): void {
    if (!(diam > 0 && tread > 0)) return;
    const dM = diam * TILE_M;
    this.push({ kind: 'wheel', cx, cy, sx: diam, sz: tread, z0: (axleM - dM / 2) * ISO_PX_PER_M, h: dM * ISO_PX_PER_M, a }, hex);
  }

  /** Iso projection is meaningless here; builders only use it for 2D extras we skip. */
  P(): [number, number] {
    return [0, 0];
  }

  poly(): void {}
  tile(): void {}
  quad(): void {}
  pill(): void {}
  star(): void {}
  circleGrid(): [number, number][] {
    return [];
  }

  /** View as a `Painter` for the scenery builder signatures. */
  asPainter(): Painter {
    return this as unknown as Painter;
  }
}
