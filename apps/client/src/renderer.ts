/**
 * Canvas2D isometric warehouse renderer, ported from the mock's `<script id="render">`
 * block (2:1 iso, TW=64/TH=32, extruded shaded boxes). It only draws real world state;
 * camera, picking and remote-vehicle interpolation live here, pure math lives in ./render/.
 */
import {
  guide as simGuide,
  laneDir,
  REACH,
  stratOf,
  type Order,
  type Vehicle,
  type World,
  type WorldMap,
} from '@warehouse/sim';
import { centreOn, fitCamera, unproject, zoomAt, TH, TW, type Camera } from './render/iso.js';
import { pickNearest, PoseTracker, type Pose } from './render/motion.js';
import { Painter } from './render/painter.js';
import { arrowColor, CALLOUT_MS, calloutColor, guideUrgency, type Callout } from './render/fx.js';
import {
  BG,
  drawCargoItem,
  drawConveyorItem,
  drawRack,
  drawStruct,
  getSiteVisuals,
  KFLOOR,
  KOUT,
  NET_COLOR,
  teamColor,
} from './render/scenery.js';
import {
  CHARGE_CUE_PERIOD_MS,
  CHARGE_RATE_PER_MIN,
  computeChargeVisualCue,
  drawVehicle,
  isVehicleCharging,
  type ChargeCueFrame,
} from './render/vehicles.js';

export {
  CHARGE_CUE_PERIOD_MS,
  CHARGE_RATE_PER_MIN,
  computeChargeVisualCue,
  isVehicleCharging,
  type ChargeCueFrame,
};

// ---------------------------------------------------------------------------
// Legacy sprite-atlas helpers (no longer used for drawing; kept for existing tests/tools)
// ---------------------------------------------------------------------------

export interface AtlasFrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AtlasManifest {
  version: number;
  tileSize: number;
  vehicleCellSize: number;
  strategyTintMap: Record<string, string>;
  vehicleTypeAliases: Record<string, string>;
  sprites: Record<string, AtlasFrameRect>;
  frames: Record<string, { frame: AtlasFrameRect }>;
}

export function headingToIndex16(angleRad: number): number {
  const twoPi = Math.PI * 2;
  const norm = ((angleRad % twoPi) + twoPi) % twoPi;
  return Math.round((norm / twoPi) * 16) % 16;
}

export function resolveVehicleSpriteKey(
  vType: string | undefined,
  strategy: string | undefined,
  human: boolean | undefined,
  loaded: boolean,
  angleRad: number,
  manifest?: AtlasManifest | null,
): string {
  const canonicalType =
    (vType && manifest?.vehicleTypeAliases?.[vType]) ||
    (vType === 'reach' || vType === 'counterbalance' || vType === 'turret'
      ? vType
      : 'counterbalance');
  const stratKey = human ? 'Human' : strategy || 'Steady';
  const tint =
    manifest?.strategyTintMap?.[stratKey] ||
    (stratKey === 'Sprinter'
      ? 'rose'
      : stratKey === 'Steady'
        ? 'indigo'
        : stratKey === 'Batcher'
          ? 'emerald'
          : stratKey === 'Opportunist'
            ? 'amber'
            : stratKey === 'Strategist'
              ? 'slate'
              : 'teal');
  const loadState = loaded ? 'loaded' : 'empty';
  const h = headingToIndex16(angleRad);
  return `vehicle_${canonicalType}_${tint}_${loadState}_h${h}`;
}

// ---------------------------------------------------------------------------
// Public renderer API (see contracts.md)
// ---------------------------------------------------------------------------

export interface RenderVehicleOverlay {
  brainThinking?: boolean;
  brainError?: string | null;
  isBot?: boolean;
}

export interface RenderLayers {
  routes: boolean;
  traffic: boolean;
  labels: boolean;
}

/** Driven-vehicle guidance target (same shape the sim's guide() returns / the delta carries). */
export interface GuideInfo {
  kind: string;
  x?: number | null;
  y?: number | null;
  text?: string;
  inRange?: boolean;
  order?: { id: number; bay: string } | null;
}

export interface RenderOptions {
  layers: RenderLayers;
  highlightStrategy: string | null;
  selectedVid: string | null;
  myVid: string | null;
  coneMode: boolean;
  overlays: Map<string, RenderVehicleOverlay>;
  /**
   * Optional (additive to the contract): guidance for myVid from the server delta. When
   * undefined the renderer computes it locally with the sim's guide(), as the mock does.
   */
  guide?: GuideInfo | null;
  /**
   * Optional smoothed predicted pose for `myVid` while client-side prediction is active.
   */
  myPose?: Pose | null;
}

export interface WarehouseRendererInit {
  canvas: HTMLCanvasElement;
  onSelectVehicle: (vid: string | null) => void;
  onClickTile: (x: number, y: number) => void;
}

interface SceneItem {
  d: number;
  fn: () => void;
}

const DRAG_THRESHOLD = 4;
const PICK_RADIUS = 1.1;

export class WarehouseRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly onSelectVehicle: (vid: string | null) => void;
  private readonly onClickTile: (x: number, y: number) => void;
  private readonly cam: Camera = { x: 0, y: 0, zoom: 1 };
  private readonly painter: Painter;
  private readonly tracker = new PoseTracker();
  private poses = new Map<string, Pose>();

  private VW = 0;
  private VH = 0;
  private dpr = 1;
  private mapKey = '';
  private needsFit = true;
  private lastMap: WorldMap | null = null;
  private followId: string | null = null;
  private coneMode = false;
  private cursor = '';
  private drag: { id: number; x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
  private reducedMotion = false;
  private nowMs = 0;
  private lastRenderMs = 0;
  private readonly cleanup: Array<() => void> = [];
  /** Floating driver callouts (fare ratings, combo resets, ...) with their spawn time. */
  private callouts: Array<Callout & { born: number }> = [];

  constructor(o: WarehouseRendererInit) {
    this.canvas = o.canvas;
    const ctx = o.canvas.getContext('2d');
    if (!ctx) throw new Error('WarehouseRenderer: Canvas2D context unavailable');
    this.ctx = ctx;
    this.painter = new Painter(ctx, this.cam);
    this.onSelectVehicle = o.onSelectVehicle;
    this.onClickTile = o.onClickTile;
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.reducedMotion = mq.matches;
      const onMq = (e: MediaQueryListEvent) => {
        this.reducedMotion = e.matches;
      };
      mq.addEventListener('change', onMq);
      this.cleanup.push(() => mq.removeEventListener('change', onMq));
    }
    this.attachPointer();
    this.resize();
  }

  get zoom(): number {
    return this.cam.zoom;
  }

  /** Float a callout above the driven forklift for CALLOUT_MS (newest stacks on top). */
  pushCallout(c: Callout, nowMs: number): void {
    this.callouts = this.callouts.filter((x) => nowMs - x.born < CALLOUT_MS).slice(-3);
    this.callouts.push({ ...c, born: nowMs });
  }

  /** Fit the iso bounds of the current map into the viewport. */
  fit(): void {
    if (!this.lastMap) {
      this.needsFit = true;
      return;
    }
    Object.assign(this.cam, fitCamera(this.lastMap.w, this.lastMap.h, this.VW, this.VH));
    this.needsFit = false;
  }

  /** Zoom about the screen centre. */
  zoomBy(factor: number): void {
    Object.assign(this.cam, zoomAt(this.cam, this.VW / 2, this.VH / 2, factor));
  }

  /** Call after a tier expansion/compaction; re-fits on the next frame with the new map. */
  onMapRebuilt(): void {
    this.needsFit = true;
  }

  /** Re-measure the canvas (call on window resize only). Keeps the view centre fixed. */
  resize(): void {
    const parent = this.canvas.parentElement;
    const winW = typeof window !== 'undefined' ? window.innerWidth : 1024;
    const winH = typeof window !== 'undefined' ? window.innerHeight : 768;
    const w = Math.max(1, Math.round(parent?.clientWidth || winW));
    const h = Math.max(1, Math.round(parent?.clientHeight || winH));
    const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    if (this.VW && this.VH) {
      this.cam.x += (w - this.VW) / 2;
      this.cam.y += (h - this.VH) / 2;
    }
    this.VW = w;
    this.VH = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
  }

  destroy(): void {
    for (const fn of this.cleanup.splice(0)) fn();
    this.tracker.clear();
    this.poses.clear();
    this.canvas.style.cursor = '';
  }

  // -------------------------------------------------------------------------
  // Input: pan (pointer capture, 4px threshold), wheel zoom about cursor, pick
  // -------------------------------------------------------------------------

  private on<K extends keyof HTMLElementEventMap>(
    type: K,
    fn: (ev: HTMLElementEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void {
    this.canvas.addEventListener(type, fn, opts);
    this.cleanup.push(() => this.canvas.removeEventListener(type, fn, opts));
  }

  private local(ev: MouseEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  }

  private attachPointer(): void {
    this.on('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, cx: this.cam.x, cy: this.cam.y, moved: false };
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        // pointer already released; nothing to capture
      }
    });
    this.on('pointermove', (e) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
        d.moved = true;
        this.updateCursor();
      }
      if (d.moved) {
        this.cam.x = d.cx + dx;
        this.cam.y = d.cy + dy;
      }
    });
    const end = (e: PointerEvent, click: boolean) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      this.drag = null;
      if (this.canvas.hasPointerCapture?.(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
      this.updateCursor();
      if (!click || d.moved) return;
      const [sx, sy] = this.local(e);
      const g = unproject(this.cam, sx, sy);
      if (this.coneMode) {
        this.onClickTile(Math.floor(g.x), Math.floor(g.y));
        return;
      }
      this.onSelectVehicle(pickNearest(this.poses, g.x, g.y, PICK_RADIUS));
    };
    this.on('pointerup', (e) => end(e, true));
    this.on('pointercancel', (e) => end(e, false));
    this.on(
      'wheel',
      (e) => {
        e.preventDefault();
        const [mx, my] = this.local(e);
        Object.assign(this.cam, zoomAt(this.cam, mx, my, Math.exp(-e.deltaY * 0.0015)));
      },
      { passive: false },
    );
  }

  private updateCursor(): void {
    const c = this.coneMode ? 'crosshair' : this.drag?.moved ? 'grabbing' : 'grab';
    if (c !== this.cursor) {
      this.cursor = c;
      this.canvas.style.cursor = c;
    }
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  /** 0..1 sine pulse; constant 0.5 under prefers-reduced-motion. */
  private pulse = (periodMs: number, phase = 0): number =>
    this.reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin((this.nowMs / periodMs) * Math.PI * 2 + phase);

  render(world: World, opts: RenderOptions, nowMs: number): void {
    const dtMs = this.lastRenderMs > 0 ? Math.max(1, Math.min(100, nowMs - this.lastRenderMs)) : 16.67;
    this.lastRenderMs = nowMs;
    this.nowMs = nowMs;
    const map = world.map;
    this.lastMap = map;
    const key = `${world.siteId}:${map.w}x${map.h}`;
    if (key !== this.mapKey) {
      this.mapKey = key;
      this.needsFit = true;
    }
    if (this.needsFit) this.fit();
    this.coneMode = opts.coneMode;
    this.updateCursor();

    // Remote vehicles slide between the last two world.t values; the driven (locally
    // predicted) vehicle uses its smoothed predicted pose when active, or interpolates
    // via PoseTracker during server-driven phases (e.g. auto-docking on E).
    this.tracker.update(world.t, nowMs, world.vehicles);
    const poses = new Map<string, Pose>();
    for (const v of world.vehicles) {
      let p: Pose | null = null;
      if (v.id === opts.myVid) {
        p = opts.myPose ?? (v.state === 'driven' ? { x: v.px, y: v.py, a: v.angle } : this.tracker.pose(v.id, nowMs));
      } else {
        p = this.tracker.pose(v.id, nowMs);
      }
      poses.set(v.id, p ?? { x: v.px, y: v.py, a: v.angle });
    }
    this.poses = poses;

    // Camera follow: only the vehicle this client drives, using frame-rate-independent smoothing.
    const me = opts.myVid ? world.vehicles.find((v) => v.id === opts.myVid) : undefined;
    if (!me) this.followId = null;
    else {
      const p = poses.get(me.id)!;
      if (this.followId !== me.id) {
        this.followId = me.id;
        if (this.cam.zoom < 0.9) this.cam.zoom = 1;
        const t = centreOn(this.cam, p.x, p.y, this.VW, this.VH);
        this.cam.x = t.x;
        this.cam.y = t.y;
      } else {
        const t = centreOn(this.cam, p.x, p.y, this.VW, this.VH);
        const alpha = this.reducedMotion ? 1 : 1 - Math.exp(-dtMs / 65);
        this.cam.x += (t.x - this.cam.x) * alpha;
        this.cam.y += (t.y - this.cam.y) * alpha;
      }
    }

    const vis = getSiteVisuals(world.siteId);
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = vis.bg;
    ctx.fillRect(0, 0, this.VW, this.VH);
    this.drawFloor(world, opts);
    if (opts.layers.routes) this.drawRoutes(world, opts);
    const items = this.sceneItems(world, opts);
    items.sort((a, b) => a.d - b.d);
    for (const it of items) it.fn();
    this.drawLabels(world, opts);
    if (me) this.drawGuide(world, me, opts);
    if (me) this.drawCallouts(me);
  }

  /** Is grid point (gx, gy) on screen (with an iso-pixel margin for tall objects)? */
  private visible(gx: number, gy: number, margin = 80): boolean {
    const z = this.cam.zoom;
    const sx = (gx - gy) * (TW / 2) * z + this.cam.x;
    const sy = (gx + gy) * (TH / 2) * z + this.cam.y;
    const m = margin * z + 8;
    return sx > -m && sx < this.VW + m && sy > -m && sy < this.VH + m * 1.5;
  }

  /** Fill an axis-aligned grid rectangle [x0, x1] x [y0, y1] on the floor plane (z=0). */
  private fillGridRect(x0: number, y0: number, x1: number, y1: number, fill: string): void {
    const z = this.cam.zoom;
    const hw = (TW / 2) * z;
    const hh = (TH / 2) * z;
    const cx = this.cam.x;
    const cy = this.cam.y;
    this.painter.quad(
      (x0 - y0) * hw + cx,
      (x0 + y0) * hh + cy,
      (x1 - y0) * hw + cx,
      (x1 + y0) * hh + cy,
      (x1 - y1) * hw + cx,
      (x1 + y1) * hh + cy,
      (x0 - y1) * hw + cx,
      (x0 + y1) * hh + cy,
      fill,
    );
  }

  private drawFloor(world: World, opts: RenderOptions): void {
    const pt = this.painter;
    const ctx = this.ctx;
    const map = world.map;
    const vis = getSiteVisuals(world.siteId);
    const W = map.w;
    const H = map.h;
    const z = this.cam.zoom;
    const hw = (TW / 2) * z;
    const hh = (TH / 2) * z;
    const camX = this.cam.x;
    const camY = this.cam.y;

    // 1. Batch-fill warehouse regions instead of issuing W*H individual tile fill+stroke calls.
    this.fillGridRect(0, 0, W, H, vis.floorBorder);
    if (W > 2 && H > 2) {
      this.fillGridRect(1, 1, W - 1, H - 1, vis.kfloor.ambient);
      for (const a of map.areas) {
        const col = vis.kfloor[a.kind];
        if (col && col !== vis.kfloor.ambient) {
          this.fillGridRect(
            Math.max(1, a.x),
            Math.max(1, a.y),
            Math.min(W - 1, a.x + a.w),
            Math.min(H - 1, a.y + a.h),
            col,
          );
        }
      }
      for (const h of map.hwyY) {
        if (h >= 1 && h + 2 <= H - 1) {
          this.fillGridRect(1, h, W - 1, h + 2, vis.hwyFill);
        }
      }
      this.fillGridRect(4, 1, 6, H - 1, vis.hwyFill);
      for (const hx of map.hwyX) {
        if (hx >= 1 && hx + 1 <= W - 1) {
          this.fillGridRect(hx, 1, hx + 1, H - 1, vis.hwyFill);
        }
      }
    }

    // 2. Batch all floor grid lines into a single stroke call.
    ctx.beginPath();
    for (let x = 0; x <= W; x++) {
      ctx.moveTo(x * hw + camX, x * hh + camY);
      ctx.lineTo((x - H) * hw + camX, (x + H) * hh + camY);
    }
    for (let y = 0; y <= H; y++) {
      ctx.moveTo(-y * hw + camX, y * hh + camY);
      ctx.lineTo((W - y) * hw + camX, (W + y) * hh + camY);
    }
    ctx.strokeStyle = vis.gridStroke;
    ctx.lineWidth = 0.7;
    ctx.stroke();

    // 3. Batch one-way lane arrows into a single stroke call.
    ctx.strokeStyle = 'rgba(71,85,105,0.55)';
    ctx.lineWidth = Math.max(1, 1.6 * z);
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        if ((x + y) % 3) continue;
        const d = laneDir(map, x, y);
        if (!d || !this.visible(x + 0.5, y + 0.5, TW)) continue;
        const cx = x + 0.5;
        const cy = y + 0.5;
        const ppx = -d[1];
        const ppy = d[0];
        const tx = cx + d[0] * 0.2;
        const ty = cy + d[1] * 0.2;
        const ax = cx - d[0] * 0.1 + ppx * 0.15;
        const ay = cy - d[1] * 0.1 + ppy * 0.15;
        const bx = cx - d[0] * 0.1 - ppx * 0.15;
        const by = cy - d[1] * 0.1 - ppy * 0.15;
        ctx.moveTo((ax - ay) * hw + camX, (ax + ay) * hh + camY);
        ctx.lineTo((tx - ty) * hw + camX, (tx + ty) * hh + camY);
        ctx.lineTo((bx - by) * hw + camX, (bx + by) * hh + camY);
      }
    }
    ctx.stroke();

    // 4. Batch dashed lane centre lines.
    ctx.save();
    ctx.setLineDash([8 * z, 8 * z]);
    ctx.strokeStyle = vis.hwyLaneDash;
    ctx.lineWidth = Math.max(1, 1.5 * z);
    ctx.beginPath();
    for (const h of map.hwyY) {
      const y = h + 1;
      ctx.moveTo((1 - y) * hw + camX, (1 + y) * hh + camY);
      ctx.lineTo((W - 1 - y) * hw + camX, (W - 1 + y) * hh + camY);
    }
    ctx.moveTo((5 - 1) * hw + camX, (5 + 1) * hh + camY);
    ctx.lineTo((5 - (H - 1)) * hw + camX, (5 + (H - 1)) * hh + camY);
    ctx.stroke();
    ctx.restore();

    // 5. Batch rack shadows into a single path fill.
    ctx.beginPath();
    for (const r of map.racks) {
      if (!this.visible(r.x + 0.5, r.y + 0.5)) continue;
      const x0 = r.x + 1;
      const y0 = r.y;
      const x1 = r.x + 1.6;
      const y1 = r.y + 0.2;
      const y2 = r.y + 1.2;
      const y3 = r.y + 1;
      ctx.moveTo((x0 - y0) * hw + camX, (x0 + y0) * hh + camY);
      ctx.lineTo((x1 - y1) * hw + camX, (x1 + y1) * hh + camY);
      ctx.lineTo((x1 - y2) * hw + camX, (x1 + y2) * hh + camY);
      ctx.lineTo((x0 - y3) * hw + camX, (x0 + y3) * hh + camY);
      ctx.closePath();
    }
    ctx.fillStyle = 'rgba(15,23,42,0.09)';
    ctx.fill();

    // district outlines
    for (const a of map.areas) {
      if (a.kind === 'office') continue;
      ctx.save();
      ctx.setLineDash([6 * z + 2, 5 * z + 2]);
      pt.poly(
        [pt.P(a.x, a.y), pt.P(a.x + a.w, a.y), pt.P(a.x + a.w, a.y + a.h), pt.P(a.x, a.y + a.h)],
        null,
        vis.kout[a.kind],
        Math.max(1.2, 2 * z),
      );
      ctx.restore();
    }
    // bay drop pads (transfer bays in the → NET accent, RET in warm amber) and charger pads
    for (const b of map.bays) {
      const isRet = b.id === 'RET';
      const net = b.isTransferBay;
      const fill = isRet ? '#FEF3C7' : net ? '#C7D2FE' : '#BFD3F2';
      const stroke = isRet ? '#D97706' : net ? '#6366F1' : '#3B82F6';
      for (const t of b.tiles) pt.tile(t.x, t.y, fill, stroke, 1.5);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.max(9, 13 * z)}px sans-serif`;
    for (const c of map.chargers) {
      pt.tile(c.x, c.y, '#BBF7D0', '#16A34A', 1.5);
      const [bx, by] = pt.P(c.x + 0.5, c.y + 0.5);
      ctx.fillStyle = '#15803D';
      ctx.fillText('⚡', bx, by);
    }
    // traffic heat
    const heat = world.heat;
    if (opts.layers.traffic && heat && heat.length >= W * H) {
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          const h = (heat[y * W + x] || 0) / 14;
          if (h < 0.05 || !this.visible(x + 0.5, y + 0.5, TW)) continue;
          const hot = h > 0.5;
          pt.tile(x, y, `rgba(${hot ? 220 : 245},${hot ? 38 : 158},${hot ? 38 : 11},${Math.min(0.6, h * 0.7)})`);
        }
      }
    }
    // order pickup rings
    for (const o of world.orders) {
      if (o.state === 'picked' || o.state === 'done') continue;
      const s = o.slot;
      if (!this.visible(s.ax + 0.5, s.ay + 0.5, TW)) continue;
      const claimer = o.claimant ? world.vehicles.find((v) => v.id === o.claimant) : undefined;
      const col = claimer
        ? teamColor(claimer)
        : o.p0
          ? '#F59E0B'
          : o.card
            ? '#7C3AED'
            : o.isTransfer || o.destSite
              ? '#6366F1'
              : '#64748B';
      const pulse = this.pulse(280 * Math.PI * 2, o.id);
      pt.poly(
        pt.circleGrid(s.ax + 0.5, s.ay + 0.5, 0.36 + (claimer ? 0 : 0.06 * pulse)),
        claimer && col.startsWith('#') ? `${col}33` : null,
        col,
        o.p0 ? 3 : 2,
      );
    }
    // spills shrink as their TTL runs out
    for (const h of world.hazards ?? world.spills ?? []) {
      if (!this.visible(h.x + 0.5, h.y + 0.5, TW)) continue;
      const left = Math.max(0, Math.min(1, (h.until - world.t) / 30));
      pt.poly(pt.circleGrid(h.x + 0.5, h.y + 0.5, 0.42 + 0.08 * left), 'rgba(250,204,21,0.55)', '#CA8A04', 2);
      pt.poly(pt.circleGrid(h.x + 0.5, h.y + 0.5, 0.22), 'rgba(250,204,21,0.85)', 'rgba(202,138,4,0.5)', 1);
    }
    // pulsing incident / near-miss markers
    const mp = this.pulse(150 * Math.PI * 2);
    for (const m of world.markers) {
      if (m.until <= world.t || !this.visible(m.x + 0.5, m.y + 0.5, TW)) continue;
      const inc = m.kind === 'incident';
      pt.poly(
        pt.circleGrid(m.x + 0.5, m.y + 0.5, 0.5 + 0.35 * mp * (inc ? 1 : 0.6)),
        inc ? 'rgba(220,38,38,0.28)' : 'rgba(245,158,11,0.3)',
        inc ? '#DC2626' : '#D97706',
        2,
      );
    }
  }

  private sceneItems(world: World, opts: RenderOptions): SceneItem[] {
    const pt = this.painter;
    const ctx = this.ctx;
    const map = world.map;
    const vis = getSiteVisuals(world.siteId);
    const items: SceneItem[] = [];
    for (const r of map.racks) {
      if (this.visible(r.x + 0.5, r.y + 0.5)) items.push({ d: r.x + r.y + 1, fn: () => drawRack(pt, r, world.siteId) });
    }
    for (const st of map.structs) {
      if (this.visible(st.x + st.w * 0.5, st.y + st.h * 0.5, 140)) {
        items.push({ d: st.x + st.w + st.y + st.h - 1, fn: () => drawStruct(pt, st) });
      }
    }
    for (const c of map.conveyors) {
      if (!this.visible(c.x + 0.5, c.y + 0.5)) continue;
      items.push({
        d: c.x + c.y + 1,
        fn: () => {
          pt.aaBox(c.x + 0.1, c.y, 0.8, 1, 0, 7, vis.conveyorBed, 'rgba(15,23,42,0.2)');
          pt.aaBox(c.x + 0.2, c.y, 0.6, 1, 7, 1.5, vis.conveyorRail);
        },
      });
    }
    // totes riding the conveyor line (positions are a pure function of sim time)
    const NCV = map.conveyors.length;
    if (NCV) {
      for (let i = 0; i < 16; i++) {
        const p = (world.t * 0.6 + (i * NCV) / 16) % NCV;
        const c = map.conveyors[Math.floor(p)];
        if (!c || !this.visible(c.x + 0.5, c.y + 0.5)) continue;
        const fy = p - Math.floor(p);
        items.push({
          d: c.x + c.y + fy + 1,
          fn: () => drawConveyorItem(pt, c.x, c.y + fy * 0.6, 8.5, i, world.siteId),
        });
      }
    }
    // west dock trucks
    for (const dk of map.westDocks) {
      items.push({
        d: 1 + dk.y + 1,
        fn: () => {
          pt.aaBox(0.1, dk.y - 1, 0.8, 3, 0, 18, '#94A3B8', 'rgba(15,23,42,0.2)');
          pt.aaBox(0.1, dk.y - 0.5, 0.25, 2, 4, 8, '#334155');
        },
      });
    }
    // east trailers: slide out + fade while departing; fill bar while docked
    for (const bay of map.bays) {
      if (bay.id === 'RET') continue;
      const b = world.bays.find((s) => s.id === bay.id);
      const away = !!b && world.t < b.departUntil;
      const slide = away ? Math.min(1, (b.departUntil - world.t) / 3) : 0;
      const dx = away ? (1 - slide) * 5 : 0;
      const net = bay.isTransferBay || !!b?.isTransferBay;
      items.push({
        d: map.w + bay.y + 2,
        fn: () => {
          if (away && dx > 4.5) return;
          ctx.save();
          if (away) ctx.globalAlpha = Math.max(0, 1 - dx / 5);
          pt.aaBox(map.w - 0.95 + dx, bay.y - 1, 3.2, 3, 0, 26, net ? '#E0E7FF' : '#E2E8F0', 'rgba(15,23,42,0.25)');
          pt.aaBox(map.w - 0.95 + dx, bay.y - 1, 3.2, 3, 26, 2, net ? '#A5B4FC' : '#CBD5E1');
          pt.aaBox(map.w - 0.8 + dx, bay.y + 1.9, 0.14, 0.14, 28, 6, '#475569');
          ctx.restore();
          if (!away && b && b.cap > 0) {
            const fill = Math.max(0, Math.min(1, b.load / b.cap));
            const [lx, ly] = pt.P(map.w + 0.4 + dx, bay.y + 0.5, 40);
            ctx.fillStyle = '#CBD5E1';
            ctx.fillRect(lx - 24, ly - 5, 48, 7);
            ctx.fillStyle = fill > 0.75 ? '#EA580C' : net ? NET_COLOR : '#2563EB';
            ctx.fillRect(lx - 24, ly - 5, 48 * fill, 7);
          }
        },
      });
    }
    for (const c of map.chargers) {
      items.push({ d: c.x + c.y + 0.6, fn: () => pt.aaBox(c.x + 0.3, c.y + 0.82, 0.4, 0.14, 0, 16, '#16A34A') });
    }
    // order pallets (P0 star)
    for (const o of world.orders) {
      if (o.state === 'picked' || o.state === 'done') continue;
      const s = o.slot;
      items.push({
        d: s.ax + s.ay + 1,
        fn: () => {
          drawCargoItem(pt, s.ax, s.ay, 0, o, world.siteId);
          if (o.p0) {
            const [sx, sy] = pt.P(s.ax + 0.5, s.ay + 0.5, 26);
            pt.star(sx, sy, 8 * Math.max(0.8, this.cam.zoom), '#FBBF24');
          }
        },
      });
    }
    // cones
    for (const k of world.cones) {
      const [x, y] = k.split(',').map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      items.push({
        d: x + y + 1,
        fn: () => {
          pt.aaBox(x + 0.25, y + 0.25, 0.5, 0.5, 0, 2, '#334155');
          pt.aaBox(x + 0.36, y + 0.36, 0.28, 0.28, 2, 9, '#F97316');
          pt.aaBox(x + 0.4, y + 0.4, 0.2, 0.2, 7, 2, '#FFFFFF');
        },
      });
    }
    // vehicles
    const hl = opts.highlightStrategy;
    for (const v of world.vehicles) {
      const p = this.poses.get(v.id)!;
      const strat = stratOf(v);
      const ov = opts.overlays.get(v.id);
      items.push({
        d: p.x + p.y + 0.5,
        fn: () =>
          drawVehicle(pt, v, p, {
            worldT: world.t,
            dim: !!hl && hl !== strat,
            emphasised: v.human || opts.selectedVid === v.id || (!!hl && hl === strat),
            brainError: !!(ov?.brainError || v.brainError),
            pulse: this.pulse,
            nowMs: this.nowMs,
            reducedMotion: this.reducedMotion,
            siteId: world.siteId,
          }),
      });
    }
    return items;
  }

  private drawRoutes(world: World, opts: RenderOptions): void {
    const pt = this.painter;
    const ctx = this.ctx;
    const hl = opts.highlightStrategy;
    ctx.save();
    ctx.setLineDash([3, 6]);
    ctx.lineWidth = Math.max(1.5, 2.2 * this.cam.zoom);
    ctx.lineCap = 'round';
    for (const v of world.vehicles) {
      if (v.human || !v.path?.length) continue;
      if (hl && hl !== stratOf(v)) continue;
      const p = this.poses.get(v.id)!;
      const gold = (v.orders ?? []).some((o) => o.p0) || (v.cargo ?? []).some((o) => o.p0);
      ctx.strokeStyle = gold ? '#D97706' : teamColor(v);
      ctx.globalAlpha = opts.selectedVid === v.id ? 1 : 0.55;
      ctx.beginPath();
      const a = pt.P(p.x, p.y);
      ctx.moveTo(a[0], a[1]);
      for (const n of v.path) {
        const q = pt.P(n.x + 0.5, n.y + 0.5);
        ctx.lineTo(q[0], q[1]);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawLabels(world: World, opts: RenderOptions): void {
    const pt = this.painter;
    const ctx = this.ctx;
    const map = world.map;
    const vis = getSiteVisuals(world.siteId);
    const z = this.cam.zoom;
    const labels = opts.layers.labels;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (labels) {
      if (z > 0.45) {
        ctx.font = '800 13px Inter, sans-serif';
        for (const zn of map.zones) {
          const [sx, sy] = pt.P(zn.x + 1, zn.y + 3, 38);
          ctx.fillStyle = vis.kout[zn.kind];
          ctx.fillText(zn.id, sx, sy - 8);
        }
      }
      for (const a of map.areas) {
        const [sx, sy] = pt.P(a.x + a.w / 2, a.y + 0.2, a.kind === 'office' ? 56 : 0);
        pt.pill(a.name, sx, sy, vis.kout[a.kind]);
      }
      for (const b of map.bays) {
        const [sx, sy] = pt.P(b.dropX + 0.5, b.y + 0.5, 0);
        if (b.id === 'RET') {
          pt.pill('RET · QA', sx, sy + 1, '#D97706');
          continue;
        }
        const net = b.isTransferBay;
        pt.pill(net ? `${b.id} → NET` : b.id, sx - 26 * Math.min(1, z + 0.3), sy + 1, net ? NET_COLOR : '#1D4ED8');
      }
    }
    for (const m of world.markers) {
      if (m.kind !== 'incident' || m.until <= world.t) continue;
      const [sx, sy] = pt.P(m.x + 0.5, m.y + 0.5, 46);
      pt.pill('Incident', sx, sy, '#DC2626');
    }
    if (labels && z > 1.1) {
      for (const v of world.vehicles) {
        const p = this.poses.get(v.id)!;
        const [sx, sy] = pt.P(p.x, p.y, 44);
        ctx.font = '700 11px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.fillStyle = '#334155';
        ctx.strokeText(v.id, sx, sy);
        ctx.fillText(v.id, sx, sy);
        const bw = 26;
        const bx = sx - bw / 2;
        const by = sy + 7;
        const bat = Math.max(0, Math.min(100, v.battery));
        ctx.fillStyle = 'rgba(15,23,42,0.18)';
        ctx.fillRect(bx, by, bw, 4);
        ctx.fillStyle = bat < 20 ? '#DC2626' : bat < 40 ? '#D97706' : '#16A34A';
        ctx.fillRect(bx, by, (bw * bat) / 100, 4);
        if (isVehicleCharging(v)) {
          ctx.strokeStyle = '#22C55E';
          ctx.lineWidth = 1.2;
          ctx.strokeRect(bx - 0.5, by - 0.5, bw + 1, 5);
        }
      }
    }
    for (const v of world.vehicles) {
      const p = this.poses.get(v.id)!;
      const carryP0 = (v.cargo ?? []).some((o: Order) => o.p0);
      const named = v.human || opts.selectedVid === v.id || carryP0;
      const [sx, sy] = pt.P(p.x, p.y, 60);
      if (named) pt.pill(carryP0 ? `★ ${v.id}` : v.id, sx, sy, carryP0 ? '#D97706' : teamColor(v));
      // live extra: brain badges from server overlays
      const ov = opts.overlays.get(v.id);
      const err = ov?.brainError || v.brainError;
      const by = named ? sy - 24 : sy;
      if (err) pt.pill('! BRAIN ERR', sx, by, '#BE123C');
      else if (ov?.brainThinking && labels) pt.pill('⋯ AI', sx, by, '#4F46E5');
      const cue = computeChargeVisualCue(v, this.nowMs, this.reducedMotion);
      if (cue.active) {
        const [cx, cy] = pt.P(p.x, p.y, (named ? 78 : 54) + cue.zOffset);
        ctx.save();
        ctx.globalAlpha = cue.alpha;
        ctx.font = '800 11.5px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.fillStyle = '#15803D';
        ctx.strokeText(cue.label, cx, cy);
        ctx.fillText(cue.label, cx, cy);
        ctx.restore();
      }
    }
  }

  private drawGuide(world: World, me: Vehicle, opts: RenderOptions): void {
    const g: GuideInfo | null = opts.guide !== undefined ? opts.guide : (simGuide(world, me) as GuideInfo | null);
    if (!g || g.x == null || g.y == null) return;
    const pt = this.painter;
    const ctx = this.ctx;
    const z = this.cam.zoom;
    const bayAt =
      g.kind === 'drop' ? (world.map.bays.find((bb) => bb.tiles.some((t) => t.x === g.x && t.y === g.y))?.id ?? null) : null;
    const urgency = guideUrgency(g, world.t, world.orders, me.cargo ?? [], bayAt);
    const kindCol = arrowColor(g.kind, urgency);
    const col = g.inRange ? '#16A34A' : kindCol;
    const pulse = this.pulse(260 * Math.PI * 2);
    const cx = g.x + 0.5;
    const cy = g.y + 0.5;
    const p = this.poses.get(me.id) ?? { x: me.px, y: me.py, a: me.angle };
    if (!g.inRange) this.drawOverheadArrow(p, cx, cy, kindCol);
    ctx.save();
    pt.poly(
      pt.circleGrid(cx, cy, g.inRange ? REACH : 0.55 + 0.15 * pulse),
      col + (g.inRange ? '30' : '40'),
      col,
      g.inRange ? 4 : 3,
    );
    const [bx, by] = pt.P(cx, cy, 0);
    const [, ty] = pt.P(cx, cy, 90);
    const grd = ctx.createLinearGradient(0, by, 0, ty);
    grd.addColorStop(0, `${col}AA`);
    grd.addColorStop(1, `${col}00`);
    ctx.fillStyle = grd;
    ctx.fillRect(bx - 5 * z, ty, 10 * z, by - ty);
    ctx.setLineDash([2, 7]);
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.strokeStyle = col;
    ctx.globalAlpha = 0.7;
    const a = pt.P(p.x, p.y);
    const b = pt.P(cx, cy);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
    ctx.restore();
    let label = '';
    if (g.inRange) label = 'Press E';
    else if (g.kind === 'pick') {
      const id = g.order?.id ?? world.orders.find((o) => o.slot.ax === g.x && o.slot.ay === g.y)?.id;
      label = id != null ? `Pick #${id}` : 'Pick';
    } else if (g.kind === 'drop') {
      const bay = g.order?.bay ?? world.map.bays.find((bb) => bb.tiles.some((t) => t.x === g.x && t.y === g.y))?.id;
      label = bay ? `Bay ${bay}` : 'Bay';
    } else if (g.kind === 'charge') label = 'Charger';
    if (label) {
      const VW = this.VW;
      const VH = this.VH;
      const off = bx < 40 || bx > VW - 40 || ty < 70 || by > VH - 40;
      pt.pill(
        label,
        off ? Math.max(70, Math.min(VW - 70, bx)) : bx,
        off ? Math.max(100, Math.min(VH - 120, ty)) : ty - 12,
        col,
      );
    }
  }

  /** Arrow hovering above the forklift, pointing (in screen space) at the guide target. */
  private drawOverheadArrow(p: Pose, tx: number, ty: number, col: string): void {
    const pt = this.painter;
    const ctx = this.ctx;
    const z = Math.max(0.8, Math.min(1.6, this.cam.zoom));
    const [ax, ay] = pt.P(p.x, p.y, 0);
    const [bx, by] = pt.P(tx, ty, 0);
    const dx = bx - ax;
    const dy = by - ay;
    if (Math.hypot(dx, dy) < 4) return;
    const ang = Math.atan2(dy, dx);
    const [hx, hy] = pt.P(p.x, p.y, 92);
    const bob = this.reducedMotion ? 0 : 3 * Math.sin(this.nowMs / 220);
    const s = 13 * z;
    ctx.save();
    ctx.translate(hx, hy + bob);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(s * 1.2, 0);
    ctx.lineTo(-s * 0.7, -s * 0.85);
    ctx.lineTo(-s * 0.25, 0);
    ctx.lineTo(-s * 0.7, s * 0.85);
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.stroke();
    ctx.fillStyle = col;
    ctx.fill();
    ctx.restore();
  }

  /** Floating callouts above the forklift; each rises and fades over CALLOUT_MS. */
  private drawCallouts(me: Vehicle): void {
    const now = this.nowMs;
    this.callouts = this.callouts.filter((c) => now - c.born < CALLOUT_MS);
    if (!this.callouts.length) return;
    const pt = this.painter;
    const ctx = this.ctx;
    const p = this.poses.get(me.id) ?? { x: me.px, y: me.py, a: me.angle };
    const [sx, sy] = pt.P(p.x, p.y, 120);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '900 18px Inter, system-ui, sans-serif';
    ctx.lineJoin = 'round';
    const n = this.callouts.length;
    this.callouts.forEach((c, i) => {
      const k = (now - c.born) / CALLOUT_MS;
      const rise = this.reducedMotion ? 0 : 28 * k;
      ctx.globalAlpha = k < 0.7 ? 1 : Math.max(0, 1 - (k - 0.7) / 0.3);
      const y = sy - rise - (n - 1 - i) * 22;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(255,251,240,0.95)';
      ctx.strokeText(c.text, sx, y);
      ctx.fillStyle = calloutColor(c.tone);
      ctx.fillText(c.text, sx, y);
    });
    ctx.restore();
  }
}

// Re-export the iso tile constants for callers that need screen<->tile math.
export { TW, TH };
