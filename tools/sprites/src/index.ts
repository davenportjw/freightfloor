import { createCanvas, SKRSContext2D } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SPRITES_VERSION = 2;

export type SpriteVehicleType = 'reach' | 'counterbalance' | 'turret';
export type SpriteLoadState = 'empty' | 'loaded';
export type SpriteTeamTint = 'amber' | 'teal' | 'indigo' | 'emerald' | 'rose' | 'slate';

export interface AtlasFrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AtlasFrameEntry extends AtlasFrameRect {
  frame: AtlasFrameRect;
  rotated: boolean;
  trimmed: boolean;
  spriteSourceSize: AtlasFrameRect;
  sourceSize: { w: number; h: number };
  anchor: { x: number; y: number };
}

export interface SpriteAtlasManifest {
  version: number;
  tileSize: number;
  vehicleCellSize: number;
  meta: {
    app: string;
    version: string;
    image: string;
    format: string;
    size: { w: number; h: number };
    scale: string;
  };
  tints: Record<SpriteTeamTint, { primary: string; dark: string; light: string }>;
  strategyTintMap: Record<string, SpriteTeamTint>;
  vehicleTypeAliases: Record<string, SpriteVehicleType>;
  frames: Record<string, AtlasFrameEntry>;
  sprites: Record<string, AtlasFrameRect>;
  vehicles: Record<
    string,
    Record<string, Record<SpriteLoadState, Record<number, AtlasFrameRect>>>
  >;
}

const VEHICLE_TYPES: SpriteVehicleType[] = ['reach', 'counterbalance', 'turret'];
const HEADINGS = 16;
const LOAD_STATES: SpriteLoadState[] = ['empty', 'loaded'];

export const TEAM_TINTS: Record<
  SpriteTeamTint,
  { primary: string; dark: string; light: string }
> = {
  amber: { primary: '#D97706', dark: '#92400E', light: '#FBBF24' },
  teal: { primary: '#0D9488', dark: '#115E59', light: '#2DD4BF' },
  indigo: { primary: '#4F46E5', dark: '#3730A3', light: '#818CF8' },
  emerald: { primary: '#16A34A', dark: '#166534', light: '#4ADE80' },
  rose: { primary: '#E11D48', dark: '#9F1239', light: '#FB7185' },
  slate: { primary: '#475569', dark: '#1E293B', light: '#94A3B8' },
};

export const STRATEGY_TINT_MAP: Record<string, SpriteTeamTint> = {
  Sprinter: 'rose',
  Steady: 'indigo',
  Batcher: 'emerald',
  Opportunist: 'amber',
  Strategist: 'slate',
  Human: 'teal',
};

export const VEHICLE_TYPE_ALIASES: Record<string, SpriteVehicleType> = {
  reach: 'reach',
  counterbalance: 'counterbalance',
  forklift: 'counterbalance',
  turret: 'turret',
  pallet_jack: 'turret',
  agv: 'turret',
};

export const CELL = 96; // 96x96 high-DPI isometric cell (1.5 world tiles wide at TW=64)
export const COLS = 24; // 24 columns * 96px = 2304px wide
const ISO_TW = 64;
const ISO_TH = 32;
const DEFAULT_ANCHOR_X = 0.5;
const DEFAULT_ANCHOR_Y = 0.62;

type Pt = [number, number];

function shade(hex: string, f: number): string {
  const clean = hex.startsWith('#') ? hex.slice(1) : hex;
  const n = parseInt(clean, 16);
  const ch = (s: number) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * f)));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

/**
 * Project local grid coordinates (gx, gy, z) relative to cell anchor (ox, oy)
 * using the exact 2:1 isometric projection (TW=64, TH=32) as the client renderer.
 */
function isoP(ox: number, oy: number, gx: number, gy: number, z = 0): Pt {
  return [ox + ((gx - gy) * ISO_TW) / 2, oy + ((gx + gy) * ISO_TH) / 2 - z];
}

function isoQuad(
  ctx: SKRSContext2D,
  p0: Pt,
  p1: Pt,
  p2: Pt,
  p3: Pt,
  fill: string | null,
  stroke?: string | null,
  lw = 0.9,
): void {
  ctx.beginPath();
  ctx.moveTo(p0[0], p0[1]);
  ctx.lineTo(p1[0], p1[1]);
  ctx.lineTo(p2[0], p2[1]);
  ctx.lineTo(p3[0], p3[1]);
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

function isoContactShadow(
  ctx: SKRSContext2D,
  ox: number,
  oy: number,
  gx: number,
  gy: number,
  rxTiles: number,
  ryTiles = rxTiles,
  alpha = 0.22,
): void {
  const [sx, sy] = isoP(ox, oy, gx, gy, 0);
  const rx = rxTiles * Math.SQRT2 * (ISO_TW / 2);
  const ry = ryTiles * Math.SQRT2 * (ISO_TH / 2);
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(sx, sy + 1, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(15, 23, 42, ${alpha})`;
  ctx.fill();
  ctx.restore();
}

/**
 * Axis-aligned 2:1 isometric 3D box with multi-face directional shading and top specular bevel highlight.
 */
function isoBox(
  ctx: SKRSContext2D,
  ox: number,
  oy: number,
  x: number,
  y: number,
  w: number,
  d: number,
  z0: number,
  h: number,
  hex: string,
  stroke = 'rgba(15, 23, 42, 0.28)',
): void {
  const x1 = x + w;
  const y1 = y + d;

  // Base points: 0:(x1,y1) front, 1:(x1,y) right, 2:(x,y) back, 3:(x,y1) left
  const b0 = isoP(ox, oy, x1, y1, z0);
  const b1 = isoP(ox, oy, x1, y, z0);
  const b3 = isoP(ox, oy, x, y1, z0);

  const t0 = isoP(ox, oy, x1, y1, z0 + h);
  const t1 = isoP(ox, oy, x1, y, z0 + h);
  const t2 = isoP(ox, oy, x, y, z0 + h);
  const t3 = isoP(ox, oy, x, y1, z0 + h);

  const rightCol = shade(hex, 0.66);
  const leftCol = shade(hex, 0.84);
  const topCol = shade(hex, 1.08);

  if (w < d) {
    isoQuad(ctx, b0, b1, t1, t0, rightCol, stroke, 0.85);
    isoQuad(ctx, b3, b0, t0, t3, leftCol, stroke, 0.85);
  } else {
    isoQuad(ctx, b3, b0, t0, t3, leftCol, stroke, 0.85);
    isoQuad(ctx, b0, b1, t1, t0, rightCol, stroke, 0.85);
  }
  isoQuad(ctx, t0, t1, t2, t3, topCol, stroke, 0.85);

  // Specular bevel highlight along the front-top edges
  if (h >= 1.5) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(t3[0], t3[1]);
    ctx.lineTo(t0[0], t0[1]);
    ctx.lineTo(t1[0], t1[1]);
    ctx.strokeStyle = shade(hex, 1.32);
    ctx.lineWidth = 1.0;
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * Oriented 2:1 isometric 3D box centered at (cx, cy) with heading angle `a` (radians).
 */
function isoOrientedBox(
  ctx: SKRSContext2D,
  ox: number,
  oy: number,
  cx: number,
  cy: number,
  len: number,
  wid: number,
  a: number,
  z0: number,
  h: number,
  hex: string,
  stroke = 'rgba(15, 23, 42, 0.28)',
): void {
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const hl = len / 2;
  const hw = wid / 2;

  const gxs = [
    cx + ca * hl - sa * hw,
    cx + ca * hl + sa * hw,
    cx - ca * hl + sa * hw,
    cx - ca * hl - sa * hw,
  ];
  const gys = [
    cy + sa * hl + ca * hw,
    cy + sa * hl - ca * hw,
    cy - sa * hl - ca * hw,
    cy - sa * hl + ca * hw,
  ];

  const basePts = [0, 1, 2, 3].map((i) => isoP(ox, oy, gxs[i], gys[i], z0));
  const topPts = [0, 1, 2, 3].map((i) => isoP(ox, oy, gxs[i], gys[i], z0 + h));

  const visibleFaces: Array<{ i: number; j: number; d: number; brightness: number }> = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) & 3;
    const mx = (gxs[i] + gxs[j]) * 0.5;
    const my = (gys[i] + gys[j]) * 0.5;
    const nx = mx - cx;
    const ny = my - cy;
    if (nx + ny > 0.0005) {
      const nLen = Math.hypot(nx, ny) || 1;
      // Smooth directional lighting: +y faces are brighter (0.86), +x faces are deeper shadow (0.64)
      const leftBias = (ny - nx) / (nLen * Math.SQRT2);
      const brightness = 0.75 + 0.11 * leftBias;
      visibleFaces.push({ i, j, d: mx + my, brightness });
    }
  }
  visibleFaces.sort((f1, f2) => f1.d - f2.d);

  for (const f of visibleFaces) {
    isoQuad(
      ctx,
      basePts[f.i],
      basePts[f.j],
      topPts[f.j],
      topPts[f.i],
      shade(hex, f.brightness),
      stroke,
      0.8,
    );
  }

  isoQuad(ctx, topPts[0], topPts[1], topPts[2], topPts[3], shade(hex, 1.08), stroke, 0.8);

  if (h >= 1.5 && visibleFaces.length > 0) {
    const front = visibleFaces[visibleFaces.length - 1];
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(topPts[front.i][0], topPts[front.i][1]);
    ctx.lineTo(topPts[front.j][0], topPts[front.j][1]);
    ctx.strokeStyle = shade(hex, 1.32);
    ctx.lineWidth = 0.95;
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * Upright 2:1 isometric 3D cylinder centered at (cx, cy) with radius `r` (tiles) and height `h` (iso px).
 */
function isoCyl(
  ctx: SKRSContext2D,
  ox: number,
  oy: number,
  cx: number,
  cy: number,
  r: number,
  z0: number,
  h: number,
  hex: string,
  stroke = 'rgba(15, 23, 42, 0.26)',
): void {
  const rx = r * Math.SQRT2 * (ISO_TW / 2);
  const ry = r * Math.SQRT2 * (ISO_TH / 2);
  if (rx <= 0 || ry <= 0) return;
  const [sx, sy] = isoP(ox, oy, cx, cy, z0);
  const topY = sy - h;

  const grad = ctx.createLinearGradient(sx - rx, 0, sx + rx, 0);
  grad.addColorStop(0, shade(hex, 0.94));
  grad.addColorStop(0.5, shade(hex, 0.78));
  grad.addColorStop(1, shade(hex, 0.58));

  ctx.beginPath();
  ctx.moveTo(sx - rx, topY);
  ctx.lineTo(sx - rx, sy);
  ctx.ellipse(sx, sy, rx, ry, 0, Math.PI, 0, true);
  ctx.lineTo(sx + rx, topY);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 0.85;
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.ellipse(sx, topY, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = shade(hex, 1.08);
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 0.85;
    ctx.stroke();
  }

  // Front rim specular highlight on top cap
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(sx, topY, rx * 0.92, ry * 0.92, 0, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.strokeStyle = shade(hex, 1.32);
  ctx.lineWidth = 0.95;
  ctx.stroke();
  ctx.restore();
}

interface OrientedPart {
  cx: number;
  cy: number;
  len: number;
  wid: number;
  z0: number;
  h: number;
  hex: string;
}

/**
 * Renders a vehicle cell in true 2:1 isometric 3D projection at one of 16 headings.
 */
function drawVehicleCell(
  ctx: SKRSContext2D,
  cellX: number,
  cellY: number,
  vtype: SpriteVehicleType,
  headingIdx: number,
  loadState: SpriteLoadState,
  tint: { primary: string; dark: string; light: string },
): void {
  const ox = cellX + CELL * DEFAULT_ANCHOR_X;
  const oy = cellY + CELL * DEFAULT_ANCHOR_Y;
  const angle = (headingIdx / HEADINGS) * Math.PI * 2;
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);

  ctx.save();
  ctx.beginPath();
  ctx.rect(cellX, cellY, CELL, CELL);
  ctx.clip();

  // Soft isometric contact shadow on floor plane
  isoContactShadow(ctx, ox, oy, 0, 0, 0.56, 0.56, 0.24);

  const parts: OrientedPart[] = [];
  const addPart = (
    lx: number,
    ly: number,
    len: number,
    wid: number,
    z0: number,
    h: number,
    hex: string,
  ) => {
    parts.push({
      cx: ca * lx - sa * ly,
      cy: sa * lx + ca * ly,
      len,
      wid,
      z0,
      h,
      hex,
    });
  };

  const addLoadedPallet = (forkX: number, forkZ: number) => {
    // Timber pallet deck + stringers
    addPart(forkX, 0, 0.42, 0.42, forkZ, 2.5, '#B47B38');
    // Strapped cargo carton + high-vis strapping band
    addPart(forkX, 0, 0.36, 0.36, forkZ + 2.5, 9.0, '#D97706');
    addPart(forkX, 0, 0.38, 0.38, forkZ + 6.5, 1.6, '#FEF3C7');
    addPart(forkX, 0, 0.22, 0.22, forkZ + 11.5, 1.0, '#FDE68A');
  };

  if (vtype === 'counterbalance') {
    const wid = 0.48;
    // 4 industrial rubber tires
    for (const sx of [-0.24, 0.24]) {
      for (const sy of [-1, 1]) {
        addPart(sx, sy * (wid / 2 + 0.02), 0.2, 0.1, 0, 5.2, '#1E293B');
      }
    }
    // Lower chassis & step plate
    addPart(-0.04, 0, 0.74, wid, 2.5, 4.5, '#64748B');
    // Main cab body in team primary tint
    addPart(-0.02, 0, 0.54, wid - 0.04, 7.0, 5.5, tint.primary);
    // Heavy rear counterweight in team dark tint + team light trim
    addPart(-0.36, 0, 0.26, wid, 3.0, 12.5, tint.dark);
    addPart(-0.38, 0, 0.24, wid + 0.02, 8.5, 2.0, tint.light);
    // Operator seat & console
    addPart(-0.1, 0, 0.2, 0.22, 12.5, 4.5, '#0F172A');
    addPart(0.12, 0, 0.08, 0.16, 12.5, 5.0, '#334155');
    // 4-post overhead guard cage + roof grill
    for (const sx of [-0.22, 0.1]) {
      for (const sy of [-1, 1]) {
        addPart(sx, sy * 0.19, 0.045, 0.045, 12.0, 12.5, '#1E293B');
      }
    }
    addPart(-0.06, 0, 0.4, 0.42, 24.5, 2.2, '#334155');
    // Dual-rail hydraulic mast + central lift cylinder + fork carriage backrest
    for (const sy of [-1, 1]) {
      addPart(0.38, sy * 0.15, 0.07, 0.06, 0, 30, '#1E293B');
    }
    addPart(0.38, 0, 0.05, 0.05, 2, 24, '#94A3B8');
    const forkZ = loadState === 'loaded' ? 6.0 : 2.5;
    addPart(0.43, 0, 0.04, 0.36, forkZ, 6.5, '#334155');
    // Steel forks + high-vis amber tips
    for (const sy of [-1, 1]) {
      addPart(0.6, sy * 0.12, 0.38, 0.065, forkZ, 2.0, '#475569');
      addPart(0.77, sy * 0.12, 0.08, 0.065, forkZ, 2.0, '#F59E0B');
    }
    if (loadState === 'loaded') {
      addLoadedPallet(0.62, forkZ + 2.0);
    }
    // Roof amber beacon
    addPart(-0.2, 0, 0.09, 0.09, 26.7, 3.2, '#FBBF24');
  } else if (vtype === 'reach') {
    const wid = 0.4;
    // Outrigger straddle legs extending forward + rear drive wheel housing
    for (const sy of [-1, 1]) {
      addPart(0.28, sy * 0.18, 0.48, 0.07, 0, 3.5, '#1E293B');
      addPart(-0.24, sy * 0.18, 0.2, 0.09, 0, 4.8, '#1E293B');
    }
    // Compact narrow-aisle side-stance chassis
    addPart(-0.14, 0, 0.56, wid, 2.5, 8.5, tint.primary);
    addPart(-0.34, 0, 0.24, wid, 3.0, 14.0, tint.dark);
    addPart(-0.35, 0, 0.22, wid + 0.02, 10.0, 2.0, tint.light);
    // Side-stance operator compartment & overhead guard
    addPart(-0.12, 0, 0.28, 0.28, 11.0, 5.5, '#0F172A');
    for (const sy of [-1, 1]) {
      addPart(-0.24, sy * 0.16, 0.045, 0.045, 14.0, 14.0, '#1E293B');
    }
    addPart(-0.16, 0, 0.3, 0.36, 28.0, 2.0, '#334155');
    // Tall high-bay dual-stage reach mast + hydraulic cylinder
    for (const sy of [-1, 1]) {
      addPart(0.18, sy * 0.14, 0.08, 0.06, 0, 35, '#1E293B');
    }
    addPart(0.18, 0, 0.05, 0.05, 2, 31, '#94A3B8');
    // Pantograph scissor reach carriage + forks
    const forkZ = loadState === 'loaded' ? 9.0 : 3.0;
    addPart(0.32, 0, 0.22, 0.26, forkZ + 1.0, 3.0, '#64748B');
    addPart(0.42, 0, 0.04, 0.34, forkZ, 6.0, '#334155');
    for (const sy of [-1, 1]) {
      addPart(0.58, sy * 0.11, 0.36, 0.06, forkZ, 2.0, '#475569');
      addPart(0.74, sy * 0.11, 0.08, 0.06, forkZ, 2.0, '#F59E0B');
    }
    if (loadState === 'loaded') {
      addLoadedPallet(0.6, forkZ + 2.0);
    }
    // Beacon on tall overhead guard
    addPart(-0.22, 0, 0.08, 0.08, 30.0, 3.0, '#FBBF24');
  } else {
    // Turret / AGV / Pallet jack: sleek low-profile autonomous deck with turret ring & LiDAR
    addPart(0, 0, 0.88, 0.52, 0.5, 2.5, '#1E293B');
    addPart(0, 0, 0.92, 0.54, 2.5, 5.5, '#E2E8F0');
    addPart(0, 0, 0.84, 0.46, 8.0, 2.2, tint.primary);
    addPart(0, 0, 0.86, 0.48, 6.2, 1.5, tint.light);
    // Turret pivot ring & deck plate
    addPart(-0.04, 0, 0.38, 0.38, 10.2, 1.8, tint.dark);
    // Front LiDAR sensor dome + status bar
    addPart(0.38, 0, 0.12, 0.3, 8.2, 4.8, '#0F172A');
    addPart(0.41, 0, 0.08, 0.22, 10.0, 1.8, '#38BDF8');
    // Beacon
    addPart(-0.32, 0, 0.09, 0.09, 10.2, 3.2, '#FBBF24');
    if (loadState === 'loaded') {
      addLoadedPallet(-0.02, 12.0);
    }
  }

  parts.sort((a, b) => a.cx + a.cy - (b.cx + b.cy) || a.z0 - b.z0);
  for (const p of parts) {
    isoOrientedBox(ctx, ox, oy, p.cx, p.cy, p.len, p.wid, angle, p.z0, p.h, p.hex);
  }

  ctx.restore();
}

/**
 * Draws an isometric wooden/aluminum pallet base centered around (0, 0, z0).
 */
function drawIsoPalletBase(
  ctx: SKRSContext2D,
  ox: number,
  oy: number,
  z0 = 0,
  deckHex = '#B47B38',
  stringerHex = '#78350F',
  scale = 1,
): void {
  const s = 0.64 * scale;
  const hs = s / 2;
  // 3 bottom stringer runners
  isoBox(ctx, ox, oy, -hs, -hs, s, 0.12 * scale, z0, 1.8, stringerHex);
  isoBox(ctx, ox, oy, -hs, -0.06 * scale, s, 0.12 * scale, z0, 1.8, stringerHex);
  isoBox(ctx, ox, oy, -hs, hs - 0.12 * scale, s, 0.12 * scale, z0, 1.8, stringerHex);
  // Top deck board
  isoBox(ctx, ox, oy, -hs, -hs, s, s, z0 + 1.8, 1.6, deckHex);
}

/**
 * Draws a regional cargo pallet sprite (`cargo_<style>_<variant>`) in crisp 2:1 isometric 3D.
 */
function drawRegionalCargoSprite(
  ctx: SKRSContext2D,
  ox: number,
  oy: number,
  style: 'boxes' | 'plants' | 'tech' | 'artisan',
  variant: '0' | '1' | '2' | 'p0' | 'net',
): void {
  const isP0 = variant === 'p0';
  const isNet = variant === 'net';
  const vNum = variant === '1' ? 1 : variant === '2' ? 2 : 0;

  isoContactShadow(ctx, ox, oy, 0, 0, 0.44, 0.44, 0.24);

  // Subtle floor aura ring for P0 urgent or cross-site network transfer pallets
  if (isP0 || isNet) {
    const [sx, sy] = isoP(ox, oy, 0, 0, 0);
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(sx, sy, 26, 13, 0, 0, Math.PI * 2);
    ctx.strokeStyle = isP0 ? '#EF4444' : '#6366F1';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  if (style === 'plants') {
    // Cedar nursery pallet tray + dark soil bed
    drawIsoPalletBase(ctx, ox, oy, 0, '#854D0E', '#5C3409');
    isoBox(ctx, ox, oy, -0.28, -0.28, 0.56, 0.56, 3.4, 2.2, '#3F2E1E');
    // Terracotta pot (crimson for P0, indigo for NET)
    const potCol = isP0 ? '#DC2626' : isNet ? '#4F46E5' : '#C2410C';
    isoCyl(ctx, ox, oy, 0, 0, 0.22, 5.6, 6.2, potCol);
    isoCyl(ctx, ox, oy, 0, 0, 0.24, 10.4, 1.8, shade(potCol, 1.12));
    // Multi-tiered botanical foliage canopy
    const leafCol = vNum === 0 ? '#16A34A' : vNum === 1 ? '#15803D' : '#059669';
    isoCyl(ctx, ox, oy, 0, 0, 0.29, 12.0, 6.8, leafCol);
    isoCyl(ctx, ox, oy, 0, 0, 0.22, 17.5, 5.0, '#22C55E');
    // Crown blossom / botanical tag
    const bloomCol = isP0
      ? '#FEF08A'
      : isNet
        ? '#C7D2FE'
        : vNum === 0
          ? '#F472B6'
          : vNum === 1
            ? '#4ADE80'
            : '#FACC15';
    isoCyl(ctx, ox, oy, 0, 0, 0.13, 21.8, 2.8, bloomCol);
    return;
  }

  if (style === 'tech') {
    // Brushed aluminum wafer base
    drawIsoPalletBase(ctx, ox, oy, 0, '#94A3B8', '#475569');
    const podCol = isP0 ? '#991B1B' : isNet ? '#312E81' : '#1E293B';
    const glowCol = isP0
      ? '#F87171'
      : isNet
        ? '#818CF8'
        : vNum === 0
          ? '#38BDF8'
          : vNum === 1
            ? '#22D3EE'
            : '#34D399';
    // Main cleanroom FOUP wafer pod enclosure
    isoBox(ctx, ox, oy, -0.26, -0.26, 0.52, 0.52, 3.4, 11.5, podCol);
    // Glowing telemetry LED status ring
    isoBox(ctx, ox, oy, -0.28, -0.28, 0.56, 0.56, 8.2, 2.2, glowCol);
    // Top cleanroom purge port & optical sensor cap
    isoCyl(ctx, ox, oy, 0, 0, 0.16, 14.9, 2.4, '#CBD5E1');
    isoCyl(ctx, ox, oy, 0, 0, 0.1, 17.3, 1.5, glowCol);
    return;
  }

  if (style === 'artisan') {
    // Hand-hewn timber pallet + standing oak barrel / glazed kiln amphora
    drawIsoPalletBase(ctx, ox, oy, 0, '#A16207', '#78350F');
    const caskCol = isP0
      ? '#DC2626'
      : isNet
        ? '#4F46E5'
        : vNum === 0
          ? '#78350F'
          : vNum === 1
            ? '#92400E'
            : '#B45309';
    const hoopCol = isP0 ? '#FEF08A' : isNet ? '#C7D2FE' : vNum === 2 ? '#2DD4BF' : '#FBBF24';
    isoCyl(ctx, ox, oy, 0, 0, 0.25, 3.4, 12.5, caskCol);
    // Lower and upper brass/turquoise tension hoops
    isoCyl(ctx, ox, oy, 0, 0, 0.265, 6.2, 1.6, hoopCol);
    isoCyl(ctx, ox, oy, 0, 0, 0.265, 11.4, 1.6, hoopCol);
    // Top sealed bung lid
    isoCyl(ctx, ox, oy, 0, 0, 0.21, 15.9, 1.5, '#D97706');
    return;
  }

  // Default ('boxes' - DEN-1): timber pallet + corrugated cartons + high-vis strapping bands
  drawIsoPalletBase(ctx, ox, oy, 0, '#C4A06B', '#78350F');
  const boxCol = isP0
    ? '#EF4444'
    : isNet
      ? '#4F46E5'
      : vNum === 0
        ? '#D97706'
        : vNum === 1
          ? '#C8963F'
          : '#B45309';
  const strapCol = isP0 ? '#FEF3C7' : isNet ? '#C7D2FE' : '#FDE68A';

  if (vNum === 1 && !isP0 && !isNet) {
    // Dual-stack interlocking cartons
    isoBox(ctx, ox, oy, -0.26, -0.26, 0.52, 0.52, 3.4, 6.2, boxCol);
    isoBox(ctx, ox, oy, -0.24, -0.24, 0.24, 0.48, 9.6, 5.4, '#D97706');
    isoBox(ctx, ox, oy, 0.02, -0.24, 0.22, 0.48, 9.6, 5.4, '#B45309');
    isoBox(ctx, ox, oy, -0.27, -0.06, 0.54, 0.12, 3.4, 11.8, strapCol);
  } else {
    isoBox(ctx, ox, oy, -0.26, -0.26, 0.52, 0.52, 3.4, 11.2, boxCol);
    // Horizontal & vertical strapping bands
    isoBox(ctx, ox, oy, -0.28, -0.28, 0.56, 0.56, 8.2, 1.8, strapCol);
    isoBox(ctx, ox, oy, -0.06, -0.27, 0.12, 0.54, 14.6, 0.8, strapCol);
    // White shipping manifest label on front-left face
    isoBox(ctx, ox, oy, -0.16, 0.25, 0.2, 0.03, 9.8, 3.2, '#F8FAFC');
  }
}

/**
 * Draws a regional outbound conveyor tote sprite (`conv_<style>_<variant>`) in 2:1 isometric 3D.
 */
function drawRegionalConveyorSprite(
  ctx: SKRSContext2D,
  ox: number,
  oy: number,
  style: 'boxes' | 'plants' | 'tech' | 'artisan',
  variant: 0 | 1,
): void {
  isoContactShadow(ctx, ox, oy, 0, 0, 0.3, 0.24, 0.18);

  if (style === 'plants') {
    isoCyl(ctx, ox, oy, 0, 0, 0.19, 0, 4.4, '#C2410C');
    isoCyl(ctx, ox, oy, 0, 0, 0.24, 4.0, 5.2, variant ? '#16A34A' : '#22C55E');
    isoCyl(ctx, ox, oy, 0, 0, 0.12, 8.8, 2.0, variant ? '#F472B6' : '#FACC15');
    return;
  }
  if (style === 'tech') {
    isoBox(ctx, ox, oy, -0.28, -0.18, 0.56, 0.36, 0, 7.2, '#0F172A');
    isoBox(
      ctx,
      ox,
      oy,
      -0.3,
      -0.16,
      0.6,
      0.32,
      3.5,
      1.8,
      variant ? '#38BDF8' : '#22D3EE',
    );
    return;
  }
  if (style === 'artisan') {
    isoCyl(ctx, ox, oy, 0, 0, 0.21, 0, 8.0, variant ? '#78350F' : '#92400E');
    isoCyl(ctx, ox, oy, 0, 0, 0.22, 3.6, 1.5, '#FBBF24');
    return;
  }
  // Default ('boxes')
  const col = variant ? '#D97706' : '#3B82F6';
  isoBox(ctx, ox, oy, -0.28, -0.18, 0.56, 0.36, 0, 7.5, col);
  isoBox(ctx, ox, oy, -0.29, -0.05, 0.58, 0.1, 0, 7.8, '#FEF3C7');
}

function drawTileSprite(ctx: SKRSContext2D, cellX: number, cellY: number, name: string): void {
  const ox = cellX + CELL * DEFAULT_ANCHOR_X;
  const oy = cellY + CELL * DEFAULT_ANCHOR_Y;

  ctx.save();
  ctx.beginPath();
  ctx.rect(cellX, cellY, CELL, CELL);
  ctx.clip();

  if (name.startsWith('cargo_')) {
    const [, style, variant] = name.split('_') as [
      string,
      'boxes' | 'plants' | 'tech' | 'artisan',
      '0' | '1' | '2' | 'p0' | 'net',
    ];
    drawRegionalCargoSprite(ctx, ox, oy, style, variant);
    ctx.restore();
    return;
  }

  if (name.startsWith('conv_')) {
    const [, style, vStr] = name.split('_') as [
      string,
      'boxes' | 'plants' | 'tech' | 'artisan',
      string,
    ];
    drawRegionalConveyorSprite(ctx, ox, oy, style, vStr === '1' ? 1 : 0);
    ctx.restore();
    return;
  }

  if (name.startsWith('floor_')) {
    const palette: Record<string, { bg: string; border: string; accent?: string }> = {
      floor_main: { bg: '#ECE7DC', border: '#DFD8C8' },
      floor_aisle: { bg: '#E5DEC9', border: '#D5CCB4', accent: '#C8BFA6' },
      floor_ambient: { bg: '#EFECE6', border: '#E2DDD3' },
      floor_cold: { bg: '#E0F2FE', border: '#BAE6FD', accent: '#38BDF8' },
      floor_hazmat: { bg: '#FEF3C7', border: '#FDE68A', accent: '#F59E0B' },
      floor_bulk: { bg: '#E7E5E4', border: '#D6D3D1', accent: '#78716C' },
      floor_staging: { bg: '#E2E8F0', border: '#CBD5E1', accent: '#64748B' },
    };
    const p = palette[name] || palette.floor_main;
    isoBox(ctx, ox, oy, -0.5, -0.5, 1.0, 1.0, 0, 2.5, p.bg, p.border);
    if (p.accent) {
      isoBox(ctx, ox, oy, -0.36, -0.36, 0.72, 0.72, 2.5, 0.6, p.accent);
    }
  } else if (name === 'wall' || name === 'pillar') {
    isoContactShadow(ctx, ox, oy, 0, 0, 0.52, 0.52, 0.25);
    isoBox(ctx, ox, oy, -0.42, -0.42, 0.84, 0.84, 0, 36, '#334155');
    if (name === 'pillar') {
      isoBox(ctx, ox, oy, -0.44, -0.44, 0.88, 0.88, 4, 4, '#F59E0B');
      isoBox(ctx, ox, oy, -0.44, -0.44, 0.88, 0.88, 14, 4, '#F59E0B');
    }
  } else if (name.startsWith('rack_')) {
    const stocked = name.includes('stocked');
    const isCold = name.includes('cold');
    const isHaz = name.includes('hazmat');
    const isBulk = name.includes('bulk');
    const isP0 = name.includes('p0');
    const isCard = name.includes('card');

    const frameCol = isCold
      ? '#0284C7'
      : isHaz
        ? '#DC2626'
        : isBulk
          ? '#57534E'
          : '#1D4ED8';
    const beamCol = isCold ? '#38BDF8' : isHaz ? '#FACC15' : '#F97316';

    isoContactShadow(ctx, ox, oy, 0, 0, 0.55, 0.55, 0.24);
    const H = 34;
    // Back & side uprights
    isoBox(ctx, ox, oy, -0.44, -0.44, 0.08, 0.08, 0, H, frameCol);
    isoBox(ctx, ox, oy, 0.36, -0.44, 0.08, 0.08, 0, H, frameCol);
    isoBox(ctx, ox, oy, -0.44, 0.36, 0.08, 0.08, 0, H, frameCol);

    for (let lv = 0; lv < 2; lv++) {
      const z = 4 + lv * 14;
      isoBox(ctx, ox, oy, -0.44, -0.44, 0.88, 0.88, z, 2.0, beamCol);
      if (stocked) {
        const cargoCol = isP0
          ? '#EF4444'
          : isCard
            ? '#A855F7'
            : isCold
              ? '#BAE6FD'
              : isHaz
                ? '#F59E0B'
                : '#D97706';
        isoBox(ctx, ox, oy, -0.3, -0.3, 0.6, 0.6, z + 2.0, 8.5, cargoCol);
        isoBox(ctx, ox, oy, -0.32, -0.32, 0.64, 0.64, z + 6.0, 1.4, '#FEF3C7');
      }
    }
    // Front upright & top cap
    isoBox(ctx, ox, oy, 0.36, 0.36, 0.08, 0.08, 0, H, frameCol);
    isoBox(ctx, ox, oy, -0.45, -0.45, 0.9, 0.9, H, 2.2, frameCol);
  } else if (name.startsWith('conveyor_')) {
    isoContactShadow(ctx, ox, oy, 0, 0, 0.5, 0.5, 0.2);
    isoBox(ctx, ox, oy, -0.4, -0.48, 0.8, 0.96, 0, 7.0, '#475569');
    isoBox(ctx, ox, oy, -0.42, -0.48, 0.08, 0.96, 7.0, 2.0, '#F59E0B');
    isoBox(ctx, ox, oy, 0.34, -0.48, 0.08, 0.96, 7.0, 2.0, '#F59E0B');
    const phase = name.endsWith('1')
      ? 0.08
      : name.endsWith('2')
        ? 0.16
        : name.endsWith('3')
          ? 0.24
          : 0;
    for (let ry = -0.36 + phase; ry <= 0.36; ry += 0.24) {
      isoBox(ctx, ox, oy, -0.32, ry, 0.64, 0.1, 7.0, 1.2, '#CBD5E1');
    }
  } else if (
    name === 'trailer' ||
    name === 'trailer_transfer' ||
    name === 'dock_west' ||
    name === 'bay_east' ||
    name === 'bay_transfer'
  ) {
    const isTransfer = name.includes('transfer');
    isoContactShadow(ctx, ox, oy, 0, 0, 0.58, 0.58, 0.26);
    isoBox(
      ctx,
      ox,
      oy,
      -0.44,
      -0.44,
      0.88,
      0.88,
      0,
      20,
      isTransfer ? '#C7D2FE' : '#E2E8F0',
    );
    isoBox(
      ctx,
      ox,
      oy,
      -0.46,
      -0.46,
      0.92,
      0.92,
      20,
      2.5,
      isTransfer ? '#6366F1' : '#3B82F6',
    );
  } else if (name === 'transfer_bay_net' || name === 'sign_net') {
    isoContactShadow(ctx, ox, oy, 0, 0, 0.5, 0.5, 0.22);
    isoBox(ctx, ox, oy, -0.45, -0.45, 0.9, 0.9, 0, 3.0, '#C7D2FE', '#4F46E5');
    isoBox(ctx, ox, oy, -0.36, -0.12, 0.72, 0.24, 3.0, 16.0, '#312E81');
    isoBox(ctx, ox, oy, -0.38, -0.14, 0.76, 0.28, 19.0, 2.2, '#818CF8');
  } else if (name === 'charger' || name === 'charger_busy') {
    const busy = name === 'charger_busy';
    isoContactShadow(ctx, ox, oy, 0, 0, 0.42, 0.42, 0.22);
    // Floor conductive charging pad
    isoBox(
      ctx,
      ox,
      oy,
      -0.38,
      -0.38,
      0.76,
      0.76,
      0,
      2.0,
      busy ? '#86EFAC' : '#BBF7D0',
      '#16A34A',
    );
    // Upright industrial supercharger cabinet
    isoBox(
      ctx,
      ox,
      oy,
      -0.22,
      -0.38,
      0.44,
      0.2,
      2.0,
      18.0,
      busy ? '#059669' : '#16A34A',
    );
    // Glowing status display screen & top beacon strip
    isoBox(
      ctx,
      ox,
      oy,
      -0.16,
      -0.17,
      0.32,
      0.04,
      10.0,
      5.5,
      busy ? '#FEF08A' : '#34D399',
    );
    isoBox(
      ctx,
      ox,
      oy,
      -0.24,
      -0.4,
      0.48,
      0.24,
      20.0,
      2.0,
      busy ? '#FACC15' : '#4ADE80',
    );
  } else if (name === 'cone') {
    isoContactShadow(ctx, ox, oy, 0, 0, 0.32, 0.32, 0.22);
    // Heavy rubber octagonal base
    isoBox(ctx, ox, oy, -0.26, -0.26, 0.52, 0.52, 0, 2.4, '#1E293B');
    // Tapered high-vis orange cone body + reflective white collar
    isoCyl(ctx, ox, oy, 0, 0, 0.19, 2.4, 5.2, '#EA580C');
    isoCyl(ctx, ox, oy, 0, 0, 0.15, 7.6, 3.2, '#F8FAFC');
    isoCyl(ctx, ox, oy, 0, 0, 0.11, 10.8, 4.2, '#F97316');
  } else if (name === 'spill') {
    const [sx, sy] = isoP(ox, oy, 0, 0, 0);
    ctx.save();
    ctx.fillStyle = 'rgba(234, 179, 8, 0.78)';
    ctx.beginPath();
    ctx.ellipse(sx - 4, sy, 20, 10, 0, 0, Math.PI * 2);
    ctx.ellipse(sx + 8, sy - 3, 14, 7, 0, 0, Math.PI * 2);
    ctx.ellipse(sx + 2, sy + 5, 16, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#CA8A04';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.restore();
  } else if (name.startsWith('pallet')) {
    const variant =
      name === 'pallet_p0'
        ? 'p0'
        : name === 'pallet_transfer'
          ? 'net'
          : name === 'pallet_card'
            ? '2'
            : '0';
    drawRegionalCargoSprite(ctx, ox, oy, 'boxes', variant);
  }

  ctx.restore();
}

export const REGIONAL_CARGO_SPRITE_NAMES = [
  'cargo_boxes_0',
  'cargo_boxes_1',
  'cargo_boxes_2',
  'cargo_boxes_p0',
  'cargo_boxes_net',
  'cargo_plants_0',
  'cargo_plants_1',
  'cargo_plants_2',
  'cargo_plants_p0',
  'cargo_plants_net',
  'cargo_tech_0',
  'cargo_tech_1',
  'cargo_tech_2',
  'cargo_tech_p0',
  'cargo_tech_net',
  'cargo_artisan_0',
  'cargo_artisan_1',
  'cargo_artisan_2',
  'cargo_artisan_p0',
  'cargo_artisan_net',
] as const;

export const REGIONAL_CONVEYOR_SPRITE_NAMES = [
  'conv_boxes_0',
  'conv_boxes_1',
  'conv_plants_0',
  'conv_plants_1',
  'conv_tech_0',
  'conv_tech_1',
  'conv_artisan_0',
  'conv_artisan_1',
] as const;

export const STATIC_SPRITE_NAMES = [
  'floor_main',
  'floor_aisle',
  'floor_ambient',
  'floor_cold',
  'floor_hazmat',
  'floor_bulk',
  'floor_staging',
  'wall',
  'pillar',
  'rack_empty',
  'rack_stocked',
  'rack_empty_ambient',
  'rack_stocked_ambient',
  'rack_empty_cold',
  'rack_stocked_cold',
  'rack_empty_hazmat',
  'rack_stocked_hazmat',
  'rack_empty_bulk',
  'rack_stocked_bulk',
  'rack_empty_p0',
  'rack_stocked_p0',
  'rack_stocked_card',
  'conveyor_h',
  'conveyor_v',
  'conveyor_f0',
  'conveyor_f1',
  'conveyor_f2',
  'conveyor_f3',
  'trailer',
  'trailer_transfer',
  'dock_west',
  'bay_east',
  'bay_transfer',
  'transfer_bay_net',
  'sign_net',
  'charger',
  'charger_busy',
  'cone',
  'spill',
  'pallet',
  'pallet_p0',
  'pallet_card',
  'pallet_transfer',
  ...REGIONAL_CARGO_SPRITE_NAMES,
  ...REGIONAL_CONVEYOR_SPRITE_NAMES,
];

function makeFrameEntry(rect: AtlasFrameRect): AtlasFrameEntry {
  return {
    ...rect,
    frame: { ...rect },
    rotated: false,
    trimmed: false,
    spriteSourceSize: { x: 0, y: 0, w: rect.w, h: rect.h },
    sourceSize: { w: rect.w, h: rect.h },
    anchor: { x: DEFAULT_ANCHOR_X, y: DEFAULT_ANCHOR_Y },
  };
}

export function generateAtlas(outDir?: string): {
  pngPath: string;
  jsonPath: string;
  manifest: SpriteAtlasManifest;
} {
  const tintKeys = Object.keys(TEAM_TINTS) as SpriteTeamTint[];
  const totalVehicleSprites =
    VEHICLE_TYPES.length * tintKeys.length * LOAD_STATES.length * HEADINGS;
  const totalCells = totalVehicleSprites + STATIC_SPRITE_NAMES.length;
  const rows = Math.ceil(totalCells / COLS);
  const width = COLS * CELL;
  const height = rows * CELL;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);

  const frames: Record<string, AtlasFrameEntry> = {};
  const sprites: Record<string, AtlasFrameRect> = {};
  const vehicles: SpriteAtlasManifest['vehicles'] = {};

  let cellIndex = 0;
  const nextCellRect = (): AtlasFrameRect => {
    const col = cellIndex % COLS;
    const row = Math.floor(cellIndex / COLS);
    cellIndex++;
    return { x: col * CELL, y: row * CELL, w: CELL, h: CELL };
  };

  for (const vtype of VEHICLE_TYPES) {
    vehicles[vtype] = {};
    for (const tintKey of tintKeys) {
      vehicles[vtype][tintKey] = { empty: {}, loaded: {} };
      const tint = TEAM_TINTS[tintKey];
      for (const loadState of LOAD_STATES) {
        for (let h = 0; h < HEADINGS; h++) {
          const rect = nextCellRect();
          drawVehicleCell(ctx, rect.x, rect.y, vtype, h, loadState, tint);
          const key = `vehicle_${vtype}_${tintKey}_${loadState}_h${h}`;
          const entry = makeFrameEntry(rect);
          frames[key] = entry;
          sprites[key] = rect;
          vehicles[vtype][tintKey][loadState][h] = rect;
        }
      }
    }
  }

  // Register vehicle type aliases (forklift -> counterbalance, pallet_jack/agv -> turret)
  for (const [alias, canonical] of Object.entries(VEHICLE_TYPE_ALIASES)) {
    if (alias === canonical) continue;
    vehicles[alias] = vehicles[canonical];
    for (const tintKey of tintKeys) {
      for (const loadState of LOAD_STATES) {
        for (let h = 0; h < HEADINGS; h++) {
          const srcKey = `vehicle_${canonical}_${tintKey}_${loadState}_h${h}`;
          const aliasKey = `vehicle_${alias}_${tintKey}_${loadState}_h${h}`;
          frames[aliasKey] = frames[srcKey];
          sprites[aliasKey] = sprites[srcKey];
        }
      }
    }
  }

  // Register strategy tint aliases (Sprinter, Steady, Batcher, Opportunist, Strategist, Human)
  for (const [strat, tintKey] of Object.entries(STRATEGY_TINT_MAP)) {
    for (const vtype of Object.keys(VEHICLE_TYPE_ALIASES)) {
      const canonical = VEHICLE_TYPE_ALIASES[vtype];
      vehicles[vtype][strat] = vehicles[canonical][tintKey];
      for (const loadState of LOAD_STATES) {
        for (let h = 0; h < HEADINGS; h++) {
          const srcKey = `vehicle_${canonical}_${tintKey}_${loadState}_h${h}`;
          const stratKey = `vehicle_${vtype}_${strat}_${loadState}_h${h}`;
          frames[stratKey] = frames[srcKey];
          sprites[stratKey] = sprites[srcKey];
        }
      }
    }
  }

  // Draw static environment, rack, dock, transfer bay, regional cargo, and floor tiles
  for (const name of STATIC_SPRITE_NAMES) {
    const rect = nextCellRect();
    drawTileSprite(ctx, rect.x, rect.y, name);
    frames[name] = makeFrameEntry(rect);
    sprites[name] = rect;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const targetDir = outDir || resolve(here, '../../../apps/client/public/assets');
  mkdirSync(targetDir, { recursive: true });

  const pngPath = resolve(targetDir, 'atlas.png');
  const jsonPath = resolve(targetDir, 'atlas.json');

  const pngBuffer = canvas.toBuffer('image/png');
  writeFileSync(pngPath, pngBuffer);

  const manifest: SpriteAtlasManifest = {
    version: SPRITES_VERSION,
    tileSize: CELL,
    vehicleCellSize: CELL,
    meta: {
      app: '@warehouse/sprites',
      version: String(SPRITES_VERSION),
      image: 'atlas.png',
      format: 'RGBA8888',
      size: { w: width, h: height },
      scale: '1',
    },
    tints: TEAM_TINTS,
    strategyTintMap: STRATEGY_TINT_MAP,
    vehicleTypeAliases: VEHICLE_TYPE_ALIASES,
    frames,
    sprites,
    vehicles,
  };

  writeFileSync(jsonPath, JSON.stringify(manifest, null, 2));
  return { pngPath, jsonPath, manifest };
}

// Run automatically when invoked via CLI (`npm run sprites` / `node dist/index.js`)
const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const { pngPath, jsonPath, manifest } = generateAtlas();
  console.log(
    `[@warehouse/sprites] Generated ${Object.keys(manifest.frames).length} isometric 3D sprite frames (${manifest.meta.size.w}x${manifest.meta.size.h}) -> ${pngPath} & ${jsonPath}`,
  );
}
