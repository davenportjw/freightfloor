/**
 * Dock semi trucks (tractor + 53' trailer) for the east shipping bays and west receiving docks.
 *
 * East bays: the sim only tells us when a full trailer left (`bay.departUntil = t + 3`, "next
 * one docks in 3 min"). We turn that window into a readable two-act animation driven purely by
 * world time: the full rig pulls away from the dock, the apron sits empty for a beat, then the
 * next rig backs in (reverse lamps + hazard beacon) and settles just as the bay reopens.
 * West docks: the same model mirrored (rear doors face the camera). The sim has no inbound
 * trailer cycle, so these stay parked; their roll-up door opens while real inbound transfer
 * pallets are waiting at that dock.
 * Geometry follows the style guide: ribbed aluminium roof, side marker lamps, tandem axles,
 * rear roll-up doors, rubber dock bumpers and yellow wheel chocks while docked.
 */
import type { Painter, Pt } from './painter.js';
import { interpAlpha } from './motion.js';

/** Game-minutes between a trailer leaving and the next one being docked (sim contract). */
export const DOCK_SWAP_MIN = 3;
/** How far (tiles) a rig travels between the dock face and off-apron. */
export const DOCK_TRAVEL_TILES = 7;

export type DockPhase = 'docked' | 'departing' | 'empty' | 'arriving';

export interface DockTruckFrame {
  phase: DockPhase;
  /** False while the apron is empty between rigs. */
  visible: boolean;
  /** Offset (tiles, +x = away from the building) of the trailer's rear from the dock face. */
  dx: number;
  /** 0..1 opacity (rigs fade as they leave / enter the far yard). */
  alpha: number;
  /** -1 reversing, 0 stopped, +1 pulling forward. */
  gear: -1 | 0 | 1;
  /** Brake lamps lit (rig decelerating into the dock or about to pull away). */
  braking: boolean;
}

const DEPART_END = 0.42;
const ARRIVE_START = 0.55;
const easeIn = (k: number) => k * k;
const easeOut = (k: number) => 1 - (1 - k) * (1 - k);
const clamp01 = (k: number) => Math.max(0, Math.min(1, k));

/**
 * Pure dock-cycle state for a bay at world time `t` given its `departUntil`.
 * Outside the swap window the rig is docked; inside it the old rig pulls out, then the
 * replacement reverses in and settles exactly as the bay becomes available again.
 */
export function dockTruckFrame(t: number, departUntil: number, swapMin = DOCK_SWAP_MIN): DockTruckFrame {
  const docked: DockTruckFrame = { phase: 'docked', visible: true, dx: 0, alpha: 1, gear: 0, braking: false };
  if (!Number.isFinite(t) || !Number.isFinite(departUntil) || t >= departUntil || swapMin <= 0) return docked;
  const u = clamp01(1 - (departUntil - t) / swapMin); // 0 = just left full, 1 = next rig docked
  const D = DOCK_TRAVEL_TILES;
  const fade = (dx: number) => clamp01(1 - (dx - D * 0.6) / (D * 0.4));
  if (u < DEPART_END) {
    const k = u / DEPART_END;
    const dx = easeIn(k) * D;
    return { phase: 'departing', visible: true, dx, alpha: fade(dx), gear: k < 0.08 ? 0 : 1, braking: k < 0.08 };
  }
  if (u < ARRIVE_START) return { phase: 'empty', visible: false, dx: D, alpha: 0, gear: 0, braking: false };
  const k = (u - ARRIVE_START) / (1 - ARRIVE_START);
  const dx = (1 - easeOut(k)) * D;
  return { phase: 'arriving', visible: true, dx, alpha: fade(dx), gear: k > 0.97 ? 0 : -1, braking: k > 0.8 };
}

/**
 * Smooths 10 Hz world time into a per-frame clock using the same "one snapshot behind"
 * interpolation the vehicles use, so docking rigs glide instead of stepping.
 */
export class SimClock {
  private prevT = Number.NaN;
  private currT = Number.NaN;
  private changedAt = 0;
  private interval = 100;

  update(worldT: number, nowMs: number): number {
    if (worldT !== this.currT) {
      if (Number.isNaN(this.currT) || worldT < this.currT || worldT - this.currT > 1) {
        this.prevT = worldT; // first sample, rewind or big jump: snap
      } else {
        this.prevT = this.value(nowMs);
        const dt = nowMs - this.changedAt;
        if (dt > 0) this.interval = this.interval * 0.7 + Math.max(30, Math.min(1000, dt)) * 0.3;
      }
      this.currT = worldT;
      this.changedAt = nowMs;
    }
    return this.value(nowMs);
  }

  value(nowMs: number): number {
    if (Number.isNaN(this.currT)) return 0;
    const a = interpAlpha(nowMs, this.changedAt, this.interval);
    return this.prevT + (this.currT - this.prevT) * a;
  }
}

/** One axis-aligned box of the rig: corner (x, y), footprint w x d (tiles), z0/h in iso px. */
export interface RigBox {
  x: number;
  y: number;
  w: number;
  d: number;
  z0: number;
  h: number;
  hex: string;
  stroke?: string;
}

export type RigKind = 'ship' | 'net' | 'receive';

export interface RigOpts {
  /** Grid x of the dock face (trailer rear when docked). */
  dockX: number;
  /** Grid y of the bay centreline. */
  cy: number;
  /** Offset from the dock face (tiles, always >= 0, measured away from the building). */
  dx: number;
  /**
   * Which way the rig points away from the building: +1 = tractor towards +x (east shipping
   * bays, cab faces the camera), -1 = tractor towards -x (west receiving docks, rear doors
   * face the camera).
   */
  dir?: 1 | -1;
  /** Livery: outbound shipping, inter-site NET transfer, or inbound receiving. */
  kind: RigKind;
  /** 0..1 trailer fill (suspension squats slightly as it loads). */
  fill: number;
  /** Hazard / beacon blink state. */
  blink: boolean;
  gear: -1 | 0 | 1;
  braking: boolean;
  /** Parked at the dock: yellow wheel chocks are set against the trailer tandem. */
  chocked?: boolean;
  /**
   * Rear roll-up door state (only visible when dir = -1): `null` = closed, otherwise the door
   * is raised and this many pallets (0..3) are drawn waiting in the trailer mouth.
   */
  doorPallets?: number | null;
}

export const TRAILER_LEN = 3.1;
export const TRAILER_WID = 1.5;
const CAB_GAP = 0.12;
const CAB_LEN = 0.78;
const HOOD_LEN = 0.55;
const CAB_WID = 1.34;
/** Total rig length (trailer + gap + tractor) in tiles. */
export const RIG_LEN = TRAILER_LEN + CAB_GAP + CAB_LEN + HOOD_LEN + 0.12;
/** Iso-px height of the trailer roof. */
export const TRAILER_TOP = 30;
const OUTLINE = 'rgba(15,23,42,0.28)';

/** Livery per dock kind (shipping = blue stripe / red tractor, NET = indigo, receiving = teal / blue). */
export function rigLivery(kind: RigKind): { body: string; roof: string; stripe: string; cab: string } {
  if (kind === 'net') return { body: '#E0E7FF', roof: '#C7D2FE', stripe: '#6366F1', cab: '#4338CA' };
  if (kind === 'receive') return { body: '#E2E8F0', roof: '#CBD5E1', stripe: '#0F766E', cab: '#1D4ED8' };
  return { body: '#E2E8F0', roof: '#CBD5E1', stripe: '#2563EB', cab: '#B91C1C' };
}

/** World-x of the low edge of a span starting `u` tiles from the dock face, `len` long. */
const spanX = (dockX: number, dir: 1 | -1, u: number, len: number) => (dir > 0 ? dockX + u : dockX - u - len);

/**
 * Painter-ordered boxes for a tractor-trailer parked `dx` tiles off a dock face. The model is
 * built in dock-local units (u = distance from the dock face) and mirrored for west docks.
 * Emission order respects the camera (looking from +x,+y): running gear before the bodies it
 * hides under, the part nearer the camera in x last, and only details on faces the camera
 * can see (cab front for east bays, trailer rear doors for west docks).
 */
export function rigParts(o: RigOpts): RigBox[] {
  const dir = o.dir ?? 1;
  const L = TRAILER_LEN;
  const W = TRAILER_WID;
  const y0 = o.cy - W / 2;
  const y1 = o.cy + W / 2;
  const cy0 = o.cy - CAB_WID / 2;
  const cy1 = o.cy + CAB_WID / 2;
  const u0 = o.dx; // trailer rear
  const uf = u0 + L; // trailer nose (kingpin sits ~0.35 behind it)
  const c0 = uf + CAB_GAP; // tractor sleeper rear
  const hoodU = c0 + CAB_LEN;
  const noseU = hoodU + HOOD_LEN;
  const liv = rigLivery(o.kind);
  const deck = 7 - clamp01(o.fill) * 1.2; // loaded trailers squat on their suspension
  const box =
    (out: RigBox[]) =>
    (u: number, len: number, y: number, d: number, z0: number, h: number, hex: string, stroke?: string) =>
      out.push({ x: spanX(o.dockX, dir, u, len), y, w: len, d, z0, h, hex, stroke });

  const wheelInto = (add: ReturnType<typeof box>, u: number, side: number, wid: number) => {
    const y = side < 0 ? y0 + 0.04 : y1 - 0.04 - wid;
    add(u - 0.16, 0.32, y, wid, 0, 6, '#111827', OUTLINE);
    if (side > 0) add(u - 0.07, 0.14, y + wid, 0.015, 1.8, 2.4, '#9CA3AF'); // hub
  };

  // --- trailer running gear ---
  const trailerGear: RigBox[] = [];
  {
    const add = box(trailerGear);
    add(u0 + 0.1, L - 0.2, o.cy - 0.32, 0.64, 3, deck - 3, '#334155'); // frame rails
    for (const side of [-1, 1]) {
      for (const u of [u0 + 0.45, u0 + 0.82]) wheelInto(add, u, side, 0.22); // tandem
      add(uf - 1.05, 0.06, side < 0 ? y0 + 0.2 : y1 - 0.26, 0.06, 0, deck, '#475569'); // landing gear legs
    }
    add(u0 + 0.18, 0.04, y1 - 0.26, 0.22, 0.8, 5, '#0F172A'); // mud flap behind the tandem
    if (o.chocked) {
      for (const u of [u0 + 0.24, u0 + 1.03]) add(u - 0.05, 0.1, y1 - 0.24, 0.2, 0, 2.6, '#FACC15', OUTLINE);
    }
  }

  // --- tractor running gear ---
  const tractorGear: RigBox[] = [];
  {
    const add = box(tractorGear);
    add(uf - 0.75, noseU - (uf - 0.75), o.cy - 0.3, 0.6, 2.5, 4.5, '#1F2937'); // frame + fifth wheel
    for (const side of [-1, 1]) {
      for (const u of [uf - 0.55, uf - 0.18]) wheelInto(add, u, side, 0.2); // drive tandem under the kingpin
      wheelInto(add, hoodU + 0.24, side, 0.18); // steer axle under the hood
    }
  }

  // --- trailer box + side details ---
  const trailerBody: RigBox[] = [];
  {
    const add = box(trailerBody);
    add(u0, L, y0, W, deck, TRAILER_TOP - deck, liv.body, OUTLINE);
    for (let i = 0; i < 9; i++) add(u0 + 0.12 + i * ((L - 0.3) / 8), 0.05, y0, W, TRAILER_TOP, 0.6, liv.roof); // ribs
    add(u0, L, y1, 0.012, deck, 1.4, '#94A3B8'); // bottom side rail
    add(u0 + 0.25, L - 0.5, y1, 0.012, 15, 3.2, liv.stripe); // livery stripe
    for (let i = 0; i < 4; i++) add(u0 + 0.2 + i * ((L - 0.4) / 3), 0.05, y1, 0.014, 28, 1.2, '#F59E0B'); // markers
    add(u0 + 0.02, 0.06, y1, 0.014, deck + 1.5, 2.2, o.braking ? '#F87171' : '#991B1B'); // rear corner lamp
  }

  // Trailer nose (faces the camera only on east bays, where the cab sits in front of it).
  const trailerNose: RigBox[] = [];
  if (dir > 0) box(trailerNose)(uf, 0.03, o.cy - 0.5, 0.22, 20, 4, '#64748B'); // nose vent

  // Trailer rear: frame, roll-up door (or open mouth with waiting pallets), tail lamps, ICC bar.
  const trailerRear: RigBox[] = [];
  if (dir < 0) {
    const add = box(trailerRear);
    add(u0 - 0.015, 0.015, y0 + 0.04, W - 0.08, deck + 0.4, TRAILER_TOP - deck - 1.6, '#94A3B8'); // door frame
    const dz0 = deck + 1.2;
    const dh = TRAILER_TOP - deck - 3.6;
    if (o.doorPallets == null) {
      add(u0 - 0.025, 0.01, y0 + 0.12, W - 0.24, dz0, dh, '#E5E7EB'); // closed roll-up door
      for (let z = dz0 + 3; z < dz0 + dh - 1; z += 3.2) add(u0 - 0.03, 0.005, y0 + 0.12, W - 0.24, z, 0.45, '#CBD5E1');
      add(u0 - 0.035, 0.01, o.cy - 0.08, 0.16, dz0 + 1, 1.2, '#475569'); // door handle
    } else {
      add(u0 - 0.025, 0.01, y0 + 0.12, W - 0.24, dz0, dh, '#1E293B'); // open mouth (dark interior)
      add(u0 - 0.03, 0.01, y0 + 0.12, W - 0.24, dz0 + dh - 2.4, 2.4, '#CBD5E1'); // rolled-up door
      const n = Math.max(0, Math.min(3, Math.round(o.doorPallets)));
      const pw = (W - 0.36) / 3;
      for (let i = 0; i < n; i++) {
        const py = y0 + 0.18 + i * pw;
        add(u0 - 0.04, 0.02, py, pw - 0.05, dz0, 1.6, '#A16207'); // pallet deck
        add(u0 - 0.04, 0.02, py + 0.02, pw - 0.09, dz0 + 1.6, 7, '#D9B98A'); // cartons
      }
    }
    for (const y of [y0 + 0.04, y1 - 0.16]) {
      add(u0 - 0.03, 0.03, y, 0.12, deck + 1.2, 2.4, o.braking ? '#F87171' : '#DC2626'); // tail lamps
    }
    add(u0 - 0.06, 0.06, y0 + 0.16, W - 0.32, 1.5, 1.6, '#B91C1C', OUTLINE); // ICC underride bar
  }

  // Exhaust stacks stand in the gap between sleeper and trailer nose.
  const stacks: RigBox[] = [];
  for (const y of [cy0 + 0.05, cy1 - 0.13]) box(stacks)(c0 - 0.1, 0.08, y, 0.08, 7, 31, '#D1D5DB');

  // --- tractor body + side details ---
  const tractorBody: RigBox[] = [];
  {
    const add = box(tractorBody);
    add(c0, CAB_LEN, cy0, CAB_WID, 7, 20, liv.cab, OUTLINE); // sleeper + cab
    add(c0 + 0.02, 0.5, cy0 + 0.04, CAB_WID - 0.08, 27, 3, liv.cab, OUTLINE); // roof fairing
    add(hoodU, HOOD_LEN, cy0 + 0.1, CAB_WID - 0.2, 7, 10, liv.cab, OUTLINE); // hood
    add(c0 + 0.08, 0.3, cy1, 0.012, 9, 2.2, '#F8FAFC'); // fleet number plate
    add(c0 + 0.42, 0.32, cy1, 0.012, 18, 6, '#1E3A5F'); // door window
    add(hoodU - 0.04, 0.03, cy1, 0.08, 19, 6, '#111827'); // mirror
    if (dir > 0) {
      add(hoodU, 0.02, cy0 + 0.12, CAB_WID - 0.24, 18, 7.5, '#1E3A5F'); // windshield
      add(noseU, 0.04, o.cy - 0.24, 0.48, 8, 8, '#CBD5E1'); // grille
      for (const y of [cy0 + 0.14, cy1 - 0.3]) add(noseU, 0.03, y, 0.16, 11, 2.2, o.gear > 0 ? '#FEF9C3' : '#FDE68A');
      add(noseU, 0.07, cy0 + 0.06, CAB_WID - 0.12, 4, 3, '#CBD5E1'); // chrome bumper
    }
    add(c0 + 0.32, 0.12, o.cy - 0.06, 0.12, 30, 2.5, o.blink && o.gear !== 0 ? '#FBBF24' : '#92400E'); // beacon
  }

  return dir > 0
    ? [...trailerGear, ...tractorGear, ...trailerBody, ...trailerNose, ...stacks, ...tractorBody]
    : [...tractorGear, ...tractorBody, ...stacks, ...trailerGear, ...trailerBody, ...trailerRear];
}

/** Static dock furniture: rubber bumpers either side of the door and the leveller lip. */
export function dockParts(dockX: number, cy: number, dir: 1 | -1 = 1): RigBox[] {
  const W = TRAILER_WID;
  const x = (u: number, len: number) => spanX(dockX, dir, u, len);
  return [
    { x: x(-0.14, 0.12), y: cy - W / 2 - 0.16, w: 0.12, d: 0.14, z0: 4, h: 6, hex: '#111827' },
    { x: x(-0.14, 0.12), y: cy + W / 2 + 0.02, w: 0.12, d: 0.14, z0: 4, h: 6, hex: '#111827' },
    { x: x(-0.2, 0.18), y: cy - W / 2 + 0.06, w: 0.18, d: W - 0.12, z0: 0, h: 1.2, hex: '#64748B' },
  ];
}

export interface DrawRigState {
  dockX: number;
  cy: number;
  dir?: 1 | -1;
  kind: RigKind;
  fill: number;
  frame: DockTruckFrame;
  nowMs: number;
  reducedMotion: boolean;
  /** See {@link RigOpts.doorPallets}. */
  doorPallets?: number | null;
}

/** Draw the dock furniture plus (if present) the rig for one dock. */
export function drawDockRig(pt: Painter, s: DrawRigState): void {
  const ctx = pt.ctx;
  const { dockX, cy, frame } = s;
  const dir = s.dir ?? 1;
  const W = TRAILER_WID;
  const x = (u: number, len: number) => spanX(dockX, dir, u, len);
  const furniture = () => {
    for (const b of dockParts(dockX, cy, dir)) pt.aaBox(b.x, b.y, b.w, b.d, b.z0, b.h, b.hex, b.stroke);
  };
  // Hazard stripes on the building-side apron edge, just inside the leveller.
  for (let i = 0; i < 6; i++) {
    floorQuad(pt, x(-0.36, 0.16), cy - W / 2 + i * (W / 6), 0.16, W / 12, i % 2 ? '#1F2937' : '#FACC15');
  }
  // Furniture sits behind the rig on east bays and in front of it on west docks.
  if (dir > 0) furniture();
  if (frame.visible && frame.alpha > 0.01) {
    const blink = s.reducedMotion ? true : Math.floor(s.nowMs / 380) % 2 === 0;
    ctx.save();
    ctx.globalAlpha *= frame.alpha;
    floorQuad(pt, x(frame.dx + 0.05, RIG_LEN), cy - W / 2 + 0.08, RIG_LEN, W, 'rgba(15,23,42,0.18)'); // shadow
    if (frame.gear < 0 && frame.dx > 0.08) {
      const reach = Math.min(1.1, frame.dx);
      floorQuad(pt, x(frame.dx - reach, reach), cy - W / 2 + 0.1, reach, W - 0.2, 'rgba(254,249,195,0.38)'); // reverse lamps
    }
    if (frame.gear > 0) floorQuad(pt, x(frame.dx + RIG_LEN, 1.4), cy - 0.55, 1.4, 1.1, 'rgba(253,230,138,0.25)'); // headlights
    const parts = rigParts({
      dockX,
      cy,
      dx: frame.dx,
      dir,
      kind: s.kind,
      fill: s.fill,
      blink,
      gear: frame.gear,
      braking: frame.braking,
      chocked: frame.phase === 'docked',
      doorPallets: frame.phase === 'docked' ? s.doorPallets : null,
    });
    for (const b of parts) pt.aaBox(b.x, b.y, b.w, b.d, b.z0, b.h, b.hex, b.stroke);
    if (frame.gear !== 0 && !s.reducedMotion) {
      const sx = x(frame.dx + TRAILER_LEN + CAB_GAP - 0.06, 0);
      for (let i = 0; i < 3; i++) {
        const k = (((s.nowMs / 900 + i / 3) % 1) + 1) % 1;
        const [px, py] = pt.P(sx, cy + 0.6 - k * 0.3, 40 + k * 18);
        ctx.beginPath();
        ctx.arc(px, py, (2 + k * 5) * pt.cam.zoom, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(100,116,139,${0.35 * (1 - k)})`;
        ctx.fill();
      }
    }
    ctx.restore();
  }
  if (dir < 0) furniture();
}

function floorQuad(pt: Painter, x: number, y: number, w: number, d: number, fill: string): void {
  const pts: Pt[] = [pt.P(x, y), pt.P(x + w, y), pt.P(x + w, y + d), pt.P(x, y + d)];
  pt.poly(pts, fill);
}
