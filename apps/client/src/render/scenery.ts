/** District palette, rack palette and static scenery (racks, structures, cargo items). */
import { getCanonicalBaseSiteId } from '@warehouse/protocol';
import {
  getSiteTheme,
  HUMAN,
  STRATEGIES,
  type DistrictKind,
  type Order,
  type Rack,
  type StructInfo,
  type Vehicle,
} from '@warehouse/sim';
import { isoDepth } from './iso.js';
import { beamTopM, isoZ, rackHeightM } from './liftGeometry.js';
import type { Painter } from './painter.js';

export const BG = '#CBD5E1';

export const KFLOOR: Record<DistrictKind, string> = {
  ambient: '#EAECEF',
  cold: '#DCEEF6',
  fast: '#E1F1E7',
  bulk: '#F0E7D6',
  haz: '#F6E1DE',
  returns: '#EDE6F5',
  staging: '#E6ECF5',
  office: '#E5E7EB',
  charging: '#E3F3E8',
};

export const KOUT: Record<DistrictKind, string> = {
  ambient: '#1E3A8A',
  cold: '#0891B2',
  fast: '#059669',
  bulk: '#B45309',
  haz: '#DC2626',
  returns: '#7C3AED',
  staging: '#2563EB',
  office: '#64748B',
  charging: '#16A34A',
};

/** Transfer-bay (→ NET) accent; a live-build extra not present in the mock. */
export const NET_COLOR = '#4F46E5';

export interface SiteVisualPalette {
  bg: string;
  floorBorder: string;
  floorShadow: string;
  hwyFill: string;
  hwyLaneDash: string;
  gridStroke: string;
  kfloor: Record<DistrictKind, string>;
  kout: Record<DistrictKind, string>;
  conveyorBed: string;
  conveyorRail: string;
}

const SITE_VISUALS: Record<'den-1' | 'slc-2' | 'phx-3' | 'abq-4', SiteVisualPalette> = {
  'den-1': {
    bg: BG,
    floorBorder: '#475569',
    floorShadow: '#64748B',
    hwyFill: '#D4DBE5',
    hwyLaneDash: 'rgba(180,130,20,0.55)',
    gridStroke: 'rgba(15,23,42,0.055)',
    kfloor: KFLOOR,
    kout: KOUT,
    conveyorBed: '#475569',
    conveyorRail: '#F59E0B',
  },
  'slc-2': {
    bg: '#C2D6C8',
    floorBorder: '#2F523E',
    floorShadow: '#4A6E58',
    hwyFill: '#CBDCD0',
    hwyLaneDash: 'rgba(22,101,52,0.45)',
    gridStroke: 'rgba(20,83,45,0.065)',
    kfloor: {
      ambient: '#E6EFE7',
      cold: '#D5EFEA',
      fast: '#D9F2DF',
      bulk: '#EDE4D3',
      haz: '#F5E1DC',
      returns: '#E8E3F2',
      staging: '#E0ECE4',
      office: '#E2EAE4',
      charging: '#D8F3E0',
    },
    kout: {
      ambient: '#166534',
      cold: '#0D9488',
      fast: '#15803D',
      bulk: '#A16207',
      haz: '#DC2626',
      returns: '#7C3AED',
      staging: '#0F766E',
      office: '#475569',
      charging: '#16A34A',
    },
    conveyorBed: '#3B5E49',
    conveyorRail: '#22C55E',
  },
  'phx-3': {
    bg: '#BFCEE0',
    floorBorder: '#1E3A5F',
    floorShadow: '#476282',
    hwyFill: '#CEDBE9',
    hwyLaneDash: 'rgba(2,132,199,0.5)',
    gridStroke: 'rgba(14,116,144,0.075)',
    kfloor: {
      ambient: '#E6EEF6',
      cold: '#D4ECF7',
      fast: '#DCEAF7',
      bulk: '#E5E9F0',
      haz: '#F5DFDF',
      returns: '#E7E4F6',
      staging: '#DFECF7',
      office: '#E2E8F0',
      charging: '#D9F0EC',
    },
    kout: {
      ambient: '#0369A1',
      cold: '#0891B2',
      fast: '#0284C7',
      bulk: '#475569',
      haz: '#E11D48',
      returns: '#6366F1',
      staging: '#2563EB',
      office: '#334155',
      charging: '#0D9488',
    },
    conveyorBed: '#1E293B',
    conveyorRail: '#38BDF8',
  },
  'abq-4': {
    bg: '#D8C7B8',
    floorBorder: '#6B3E26',
    floorShadow: '#85583F',
    hwyFill: '#DFD2C5',
    hwyLaneDash: 'rgba(180,83,9,0.52)',
    gridStroke: 'rgba(120,53,15,0.065)',
    kfloor: {
      ambient: '#F1E9DF',
      cold: '#DEECEE',
      fast: '#E8EFE2',
      bulk: '#EFE1CE',
      haz: '#F6DED8',
      returns: '#EDE3EE',
      staging: '#EAE6DF',
      office: '#EAE3DC',
      charging: '#E2EFE4',
    },
    kout: {
      ambient: '#9A3412',
      cold: '#0E7490',
      fast: '#B45309',
      bulk: '#78350F',
      haz: '#DC2626',
      returns: '#7E22CE',
      staging: '#C2410C',
      office: '#57534E',
      charging: '#15803D',
    },
    conveyorBed: '#573B26',
    conveyorRail: '#F97316',
  },
};

export function getSiteVisuals(siteId = 'den-1'): SiteVisualPalette {
  const theme = getSiteTheme(siteId);
  return SITE_VISUALS[getCanonicalBaseSiteId(theme.id)];
}

type RackPal = [string, string, string[]];
const RACK_PAL: Partial<Record<DistrictKind, RackPal>> = {
  ambient: ['#1D4ED8', '#2563EB', ['#D9B98A', '#C4A06B', '#CDAE82']],
  cold: ['#0E7490', '#0891B2', ['#E0F2FE', '#BAE6FD', '#CFE8F3']],
  haz: ['#B91C1C', '#DC2626', ['#FACC15', '#EF4444', '#F59E0B']],
  fast: ['#047857', '#059669', ['#FB923C', '#FACC15', '#38BDF8']],
};

const SITE_RACK_PAL: Record<'den-1' | 'slc-2' | 'phx-3' | 'abq-4', Partial<Record<DistrictKind, RackPal>>> = {
  'den-1': RACK_PAL,
  'slc-2': {
    ambient: ['#15803D', '#16A34A', ['#22C55E', '#4ADE80', '#16A34A']],
    cold: ['#0D9488', '#14B8A6', ['#A7F3D0', '#6EE7B7', '#5EEAD4']],
    haz: ['#B91C1C', '#DC2626', ['#F43F5E', '#FB923C', '#FACC15']],
    fast: ['#65A30D', '#84CC16', ['#86EFAC', '#FDE047', '#4ADE80']],
  },
  'phx-3': {
    ambient: ['#0369A1', '#0284C7', ['#38BDF8', '#E2E8F0', '#7DD3FC']],
    cold: ['#0E7490', '#06B6D4', ['#67E8F9', '#CFFAFE', '#22D3EE']],
    haz: ['#BE123C', '#E11D48', ['#FB7185', '#FBBF24', '#F43F5E']],
    fast: ['#1D4ED8', '#3B82F6', ['#60A5FA', '#A5F3FC', '#818CF8']],
  },
  'abq-4': {
    ambient: ['#9A3412', '#C2410C', ['#D97706', '#B45309', '#E0B589']],
    cold: ['#0E7490', '#0891B2', ['#BAE6FD', '#7DD3FC', '#D6D3D1']],
    haz: ['#991B1B', '#DC2626', ['#F59E0B', '#EF4444', '#FBBF24']],
    fast: ['#B45309', '#D97706', ['#FBBF24', '#F59E0B', '#D6A75C']],
  },
};

export function teamColor(v: Vehicle): string {
  return v.human ? HUMAN.color : (STRATEGIES[v.strategy]?.color ?? '#64748B');
}

/**
 * 3D rack. Shelf stock is decorative (deterministic hash of the rack position) and styled
 * according to the active site's cargo theme (`boxes`, `plants`, `tech`, `artisan`);
 * real order data is drawn separately as cargo items + rings at the aisle slot.
 */
export function drawRack(p: Painter, r: Rack, siteId = 'den-1'): void {
  const x = r.x;
  const y = r.y;
  const hsh = (x * 7 + y * 13 + x * y) % 7;
  const k = r.kind;
  const theme = getSiteTheme(siteId);
  const sitePal = SITE_RACK_PAL[getCanonicalBaseSiteId(theme.id)] ?? RACK_PAL;
  const pal = sitePal[k] ?? sitePal.ambient ?? RACK_PAL.ambient!;

  if (p.cam.zoom < 0.7) {
    const h = k === 'bulk' ? 30 : k === 'fast' ? 26 : 38;
    const bulkLowColor =
      theme.cargoStyle === 'plants'
        ? '#15803D'
        : theme.cargoStyle === 'tech'
          ? '#0284C7'
          : theme.cargoStyle === 'artisan'
            ? '#92400E'
            : '#C8963F';
    p.aaBox(x + 0.04, y + 0.04, 0.92, 0.92, 0, h, k === 'bulk' ? bulkLowColor : pal[r.tone ? 1 : 0]);
    return;
  }

  if (k === 'bulk') {
    if (theme.cargoStyle === 'plants') {
      // Raised cedar planter bed with lush greenhouse trees / bushes
      p.aaBox(x + 0.06, y + 0.06, 0.88, 0.88, 0, 7, '#854D0E');
      p.aaBox(x + 0.1, y + 0.1, 0.8, 0.8, 7, 2, '#3F2E1E');
      p.cyl(x + 0.5, y + 0.5, 0.1, 9, 10, '#713F12');
      p.cyl(x + 0.5, y + 0.5, 0.36, 17, 12, ['#15803D', '#16A34A', '#059669'][hsh % 3]);
      p.cyl(x + 0.5, y + 0.5, 0.24, 27, 8, '#4ADE80');
      return;
    }
    if (theme.cargoStyle === 'tech') {
      // Cleanroom wafer server / cryo stack
      p.aaBox(x + 0.06, y + 0.06, 0.88, 0.88, 0, 3, '#334155');
      const n = 1 + (hsh % 2);
      for (let i = 0; i < n; i++) {
        p.aaBox(x + 0.12, y + 0.12, 0.76, 0.76, 3 + i * 16, 14, '#1E293B');
        p.aaBox(x + 0.1, y + 0.1, 0.8, 0.8, 9 + i * 16, 2.2, ['#38BDF8', '#22D3EE', '#818CF8'][(hsh + i) % 3]);
      }
      return;
    }
    if (theme.cargoStyle === 'artisan') {
      // Wooden pallet with aged oak casks / barrels
      p.aaBox(x + 0.06, y + 0.06, 0.88, 0.88, 0, 3, '#A16207');
      p.cyl(x + 0.32, y + 0.34, 0.2, 3, 16, '#78350F');
      p.cyl(x + 0.68, y + 0.34, 0.2, 3, 16, '#92400E');
      p.cyl(x + 0.5, y + 0.66, 0.2, 3, 16, '#78350F');
      p.cyl(x + 0.5, y + 0.5, 0.22, 19, 14, '#B45309');
      return;
    }
    p.aaBox(x + 0.06, y + 0.06, 0.88, 0.88, 0, 3, '#C4A06B');
    const n = 1 + (hsh % 3);
    for (let i = 0; i < n; i++) {
      p.aaBox(x + 0.1, y + 0.1, 0.8, 0.8, 3 + i * 15, 14, ['#D6A75C', '#C8963F', '#DDB46B'][(hsh + i) % 3]);
      p.aaBox(x + 0.08, y + 0.08, 0.84, 0.84, 8 + i * 15, 2, '#E5E7EB');
    }
    return;
  }

  const lv = k === 'fast' ? 2 : 3;
  // Heights from the shared lift geometry, so shelf beams sit exactly where a Perfect lift lands.
  const H = isoZ(rackHeightM(lv));
  const base = pal[r.tone ? 1 : 0];
  const post = (px: number, py: number) => p.aaBox(x + px, y + py, 0.07, 0.07, 0, H, base);
  const camRot = p.cam?.rot ?? 0;
  const postOffsets: Array<[number, number]> = [
    [0.04, 0.04],
    [0.89, 0.04],
    [0.04, 0.89],
    [0.89, 0.89],
  ];
  if (camRot) {
    postOffsets.sort(
      (a, b) => isoDepth(x + a[0], y + a[1], camRot) - isoDepth(x + b[0], y + b[1], camRot),
    );
  }
  post(postOffsets[0][0], postOffsets[0][1]);
  post(postOffsets[1][0], postOffsets[1][1]);
  post(postOffsets[2][0], postOffsets[2][1]);

  const shelfColor =
    theme.cargoStyle === 'plants'
      ? '#57534E'
      : theme.cargoStyle === 'tech'
        ? '#475569'
        : theme.cargoStyle === 'artisan'
          ? '#78350F'
          : '#64748B';

  for (let l = 0; l < lv; l++) {
    const z = isoZ(beamTopM(l as 0 | 1 | 2)) - 1.6; // beam top = liftGeometry beamTopM(l)
    p.aaBox(x + 0.03, y + 0.03, 0.94, 0.94, z, 1.6, shelfColor);
    const q = (hsh + l * 3) % 7;
    if (q === 0 || q === 3) continue;

    if (theme.cargoStyle === 'plants') {
      // Terracotta pots + botanical foliage canopies on shelves
      p.cyl(x + 0.32, y + 0.48, 0.14, z + 1.6, 3.6, '#C2410C');
      p.cyl(x + 0.32, y + 0.48, 0.2, z + 5.0, 4.5, pal[2][q % 3]);
      p.cyl(x + 0.68, y + 0.52, 0.14, z + 1.6, 3.6, '#B45309');
      p.cyl(x + 0.68, y + 0.52, 0.2, z + 5.0, 4.8, pal[2][(q + 1) % 3]);
      if (k === 'haz' || q % 2 === 1) {
        p.aaBox(x + 0.26, y + 0.42, 0.12, 0.12, z + 9.5, 2.2, '#F472B6');
      }
    } else if (theme.cargoStyle === 'tech') {
      // Silicon wafer FOUP pods + cyan LED status strips
      p.aaBox(x + 0.14, y + 0.16, 0.32, 0.68, z + 1.6, 7.2, '#1E293B');
      p.aaBox(x + 0.12, y + 0.2, 0.36, 0.6, z + 5.2, 1.6, pal[2][q % 3]);
      p.aaBox(x + 0.54, y + 0.16, 0.32, 0.68, z + 1.6, 7.2, '#0F172A');
      p.aaBox(x + 0.52, y + 0.2, 0.36, 0.6, z + 5.2, 1.6, pal[2][(q + 1) % 3]);
    } else if (theme.cargoStyle === 'artisan') {
      // Mini oak casks and burlap sacks on timber shelves
      p.cyl(x + 0.32, y + 0.48, 0.17, z + 1.6, 7.5, '#78350F');
      p.aaBox(x + 0.52, y + 0.18, 0.34, 0.64, z + 1.6, 6.8, pal[2][q % 3]);
      p.aaBox(x + 0.5, y + 0.22, 0.38, 0.56, z + 4.8, 1.4, '#FDE68A');
    } else if (k === 'fast') {
      p.aaBox(x + 0.12, y + 0.14, 0.34, 0.7, z + 1.6, 6, pal[2][q % 3]);
      p.aaBox(x + 0.54, y + 0.14, 0.34, 0.7, z + 1.6, 6, pal[2][(q + 1) % 3]);
    } else if (k === 'haz') {
      p.aaBox(x + 0.14, y + 0.16, 0.3, 0.3, z + 1.6, 8, pal[2][q % 3]);
      p.aaBox(x + 0.54, y + 0.16, 0.3, 0.3, z + 1.6, 8, pal[2][(q + 1) % 3]);
      p.aaBox(x + 0.34, y + 0.58, 0.3, 0.3, z + 1.6, 8, pal[2][(q + 2) % 3]);
    } else {
      p.aaBox(x + 0.16, y + 0.14, 0.68, 0.72, z + 1.6, 7 + (q % 3) * 1.5, pal[2][q % 3]);
    }
  }
  post(postOffsets[3][0], postOffsets[3][1]);
  const capColor =
    k === 'cold'
      ? '#7DD3FC'
      : theme.cargoStyle === 'plants'
        ? '#86EFAC'
        : theme.cargoStyle === 'tech'
          ? '#38BDF8'
          : theme.cargoStyle === 'artisan'
            ? '#B45309'
            : '#334155';
  p.aaBox(x + 0.02, y + 0.02, 0.96, 0.96, H - 1, 2.5, capColor);
}

/** Scale an `#rrggbb` colour's channels by `f`, returning `#rrggbb` (cab + iso painters both parse it). */
function shadeHex(hex: string, f: number): string {
  const n = parseInt(hex.slice(1, 7), 16);
  const ch = (sh: number) => Math.max(0, Math.min(255, Math.round(((n >> sh) & 255) * f)));
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}

/**
 * Soft ground shadow under a floor-standing prop (iso only: duck-typed so the Cab View's
 * `PrimRecorder` and test painters skip it; the Cab View has its own instanced blob shadows).
 */
function propShadow(p: Painter, cx: number, cy: number, w: number, d: number, z0: number, alpha = 0.22): void {
  if (z0 > 0.01 || typeof (p as Partial<Painter>).footprintShadow !== 'function') return;
  p.footprintShadow(cx, cy, w, d, 0, alpha);
}

/** Floor aura ring for P0 rush / cross-site NET pallets (iso only). */
function auraRing(p: Painter, cx: number, cy: number, z0: number, col: string): void {
  if (z0 > 0.01 || typeof (p as Partial<Painter>).poly !== 'function' || typeof p.circleGrid !== 'function') return;
  p.poly(p.circleGrid(cx, cy, 0.46), null, col, 2);
}

/** Minimal primitive sink shared by props: boxes centred at (cx, cy), upright cylinders. */
interface PropSink {
  box(cx: number, cy: number, w: number, d: number, z0: number, h: number, hex: string): void;
  cyl(cx: number, cy: number, r: number, z0: number, h: number, hex: string): void;
}

const painterSink = (p: Painter): PropSink => ({
  box: (cx, cy, w, d, z0, h, hex) => p.aaBox(cx - w / 2, cy - d / 2, w, d, z0, h, hex),
  cyl: (cx, cy, r, z0, h, hex) => p.cyl(cx, cy, r, z0, h, hex),
});

/** Pallet base centred at (cx, cy): three stringer runners under a deck board (3.4 iso-px tall). */
function palletBase(e: PropSink, cx: number, cy: number, z0: number, deckHex: string, stringerHex: string): void {
  const s = 0.64;
  const h = s / 2;
  for (const oy of [-h + 0.06, 0, h - 0.06]) e.box(cx, cy + oy, s, 0.12, z0, 1.8, stringerHex);
  e.box(cx, cy, s, s, z0 + 1.8, 1.6, deckHex);
}

/**
 * Upright box split around wider horizontal bands, emitted bottom-to-top. The iso painter has no
 * depth buffer, so a wider band drawn after a taller box would paint its top face over the box
 * (this is what squashed the old Denver carton flat in Forklift Up).
 */
function bandedBox(
  e: PropSink,
  cx: number,
  cy: number,
  w: number,
  d: number,
  z0: number,
  h: number,
  hex: string,
  bands: ReadonlyArray<{ z: number; h: number; hex: string; grow: number }>,
): void {
  let z = z0;
  for (const b of [...bands].sort((a, c) => a.z - c.z)) {
    if (b.z > z) e.box(cx, cy, w, d, z, b.z - z, hex);
    e.box(cx, cy, w + b.grow * 2, d + b.grow * 2, b.z, b.h, b.hex);
    z = b.z + b.h;
  }
  if (z0 + h > z) e.box(cx, cy, w, d, z, z0 + h - z, hex);
}

/** Upright cylinder split around wider hoops, emitted bottom-to-top (same reason as `bandedBox`). */
function hoopedCyl(
  e: PropSink,
  cx: number,
  cy: number,
  r: number,
  z0: number,
  h: number,
  hex: string,
  hoops: ReadonlyArray<{ z: number; h: number; hex: string; r: number }>,
): void {
  let z = z0;
  for (const b of [...hoops].sort((a, c) => a.z - c.z)) {
    if (b.z > z) e.cyl(cx, cy, r, z, b.z - z, hex);
    e.cyl(cx, cy, b.r, b.z, b.h, b.hex);
    z = b.z + b.h;
  }
  if (z0 + h > z) e.cyl(cx, cy, r, z, z0 + h - z, hex);
}

/** One cargo primitive in item-local space: centred on (x, y) tiles from the item centre, z0 from its base. */
export interface CargoPrim {
  kind: 'box' | 'cyl';
  x: number;
  y: number;
  /** Box: size along x / y (tiles). Cylinder: diameter for both. */
  w: number;
  d: number;
  z0: number;
  h: number;
  hex: string;
}

/**
 * The single cargo model per regional style, in painter order (bottom-to-top). Floor and shelf
 * pallets (`drawCargoItem`), pallets carried on the forks (`vehicleParts`) and the 3D Cab View all
 * build from this, so a pallet looks the same wherever it is and from every camera.
 */
export function cargoPrims(o: Pick<Order, 'id' | 'p0' | 'isTransfer'>, siteId = 'den-1'): { prims: CargoPrim[]; height: number } {
  const theme = getSiteTheme(siteId);
  const variant = Math.abs(o.id || 0) % 3;
  const prims: CargoPrim[] = [];
  let top = 0;
  const e: PropSink = {
    box: (x, y, w, d, z0, h, hex) => {
      prims.push({ kind: 'box', x, y, w, d, z0, h, hex });
      top = Math.max(top, z0 + h);
    },
    cyl: (x, y, r, z0, h, hex) => {
      prims.push({ kind: 'cyl', x, y, w: r * 2, d: r * 2, z0, h, hex });
      top = Math.max(top, z0 + h);
    },
  };
  const zb = 3.4; // top of the pallet deck

  if (theme.cargoStyle === 'plants') {
    // Cedar nursery tray + soil bed, terracotta pot with a lip, tiered foliage and a blossom.
    palletBase(e, 0, 0, 0, '#854D0E', '#5C3409');
    e.box(0, 0, 0.56, 0.56, zb, 2.2, '#3F2E1E');
    const potCol = o.p0 ? '#DC2626' : o.isTransfer ? NET_COLOR : '#C2410C';
    hoopedCyl(e, 0, 0, 0.22, zb + 2.2, 6.6, potCol, [{ z: zb + 7.0, h: 1.8, hex: shadeHex(potCol, 1.12), r: 0.24 }]);
    const leafCol = variant === 0 ? '#16A34A' : variant === 1 ? '#15803D' : '#059669';
    e.cyl(0, 0, 0.29, zb + 8.8, 6.0, leafCol);
    e.cyl(0, 0, 0.22, zb + 14.8, 3.8, '#22C55E');
    const bloomCol = o.p0
      ? '#FEF08A'
      : o.isTransfer
        ? '#C7D2FE'
        : variant === 0
          ? '#F472B6'
          : variant === 1
            ? '#4ADE80'
            : '#FACC15';
    e.cyl(0, 0, 0.13, zb + 18.6, 2.4, bloomCol);
  } else if (theme.cargoStyle === 'tech') {
    // Brushed aluminium base, cleanroom FOUP pod with a glowing status ring, purge-port cap.
    palletBase(e, 0, 0, 0, '#94A3B8', '#475569');
    const podCol = o.p0 ? '#991B1B' : o.isTransfer ? '#312E81' : '#1E293B';
    const glowCol = o.p0
      ? '#F87171'
      : o.isTransfer
        ? '#818CF8'
        : variant === 0
          ? '#38BDF8'
          : variant === 1
            ? '#22D3EE'
            : '#34D399';
    bandedBox(e, 0, 0, 0.52, 0.52, zb, 11.5, podCol, [{ z: zb + 4.8, h: 2.2, hex: glowCol, grow: 0.02 }]);
    e.cyl(0, 0, 0.16, zb + 11.5, 2.4, '#CBD5E1');
    e.cyl(0, 0, 0.1, zb + 13.9, 1.5, glowCol);
  } else if (theme.cargoStyle === 'artisan') {
    // Hand-hewn timber pallet + oak cask with two tension hoops and a sealed bung lid.
    palletBase(e, 0, 0, 0, '#A16207', '#78350F');
    const caskCol = o.p0
      ? '#DC2626'
      : o.isTransfer
        ? NET_COLOR
        : variant === 0
          ? '#78350F'
          : variant === 1
            ? '#92400E'
            : '#B45309';
    const hoopCol = o.p0 ? '#FEF08A' : o.isTransfer ? '#C7D2FE' : variant === 2 ? '#2DD4BF' : '#FBBF24';
    hoopedCyl(e, 0, 0, 0.25, zb, 12.5, caskCol, [
      { z: zb + 2.8, h: 1.6, hex: hoopCol, r: 0.265 },
      { z: zb + 8.0, h: 1.6, hex: hoopCol, r: 0.265 },
    ]);
    e.cyl(0, 0, 0.21, zb + 12.5, 1.5, '#D97706');
  } else {
    // Default ('den-1' boxes): timber pallet + corrugated cartons + high-vis strapping.
    palletBase(e, 0, 0, 0, '#C4A06B', '#78350F');
    const boxCol = o.p0 ? '#EF4444' : o.isTransfer ? NET_COLOR : variant === 0 ? '#D97706' : variant === 1 ? '#C8963F' : '#B45309';
    const strapCol = o.p0 ? '#FEF3C7' : o.isTransfer ? '#C7D2FE' : '#FDE68A';
    if (variant === 1 && !o.p0 && !o.isTransfer) {
      // Two-layer stack: one base carton, two half cartons on top, a strap over both lids.
      e.box(0, 0, 0.52, 0.52, zb, 6.2, boxCol);
      e.box(-0.12, 0, 0.24, 0.48, zb + 6.2, 5.4, '#D97706');
      e.box(0.13, 0, 0.22, 0.48, zb + 6.2, 5.4, '#B45309');
      e.box(0, 0, 0.54, 0.12, zb + 11.6, 0.6, strapCol);
    } else {
      bandedBox(e, 0, 0, 0.52, 0.52, zb, 11.2, boxCol, [{ z: zb + 4.8, h: 1.8, hex: strapCol, grow: 0.02 }]);
      e.box(0, 0, 0.12, 0.54, zb + 11.2, 0.6, strapCol); // strap over the lid
      e.box(-0.06, 0.27, 0.2, 0.02, zb + 7.2, 3.2, '#F8FAFC'); // shipping label (front face)
    }
  }
  return { prims, height: top };
}

/**
 * Draws an order's physical cargo item at aisle slot `(x, y)` starting at height `z0`
 * (see `cargoPrims`), with a ground shadow and a P0 / NET aura ring when on the floor.
 */
export function drawCargoItem(
  p: Painter,
  x: number,
  y: number,
  z0: number,
  o: Pick<Order, 'id' | 'p0' | 'isTransfer'>,
  siteId = 'den-1',
): void {
  const cx = x + 0.5;
  const cy = y + 0.5;
  propShadow(p, cx, cy, 0.66, 0.66, z0);
  if (o.p0) auraRing(p, cx, cy, z0, '#EF4444');
  else if (o.isTransfer) auraRing(p, cx, cy, z0, NET_COLOR);
  for (const q of cargoPrims(o, siteId).prims) {
    if (q.kind === 'cyl') p.cyl(cx + q.x, cy + q.y, q.w / 2, z0 + q.z0, q.h, q.hex);
    else p.aaBox(cx + q.x - q.w / 2, cy + q.y - q.d / 2, q.w, q.d, z0 + q.z0, q.h, q.hex);
  }
}

/**
 * Draws a moving item on the outbound conveyor belt at `(x, y)` starting at `z0`.
 */
export function drawConveyorItem(
  p: Painter,
  x: number,
  y: number,
  z0: number,
  index: number,
  siteId = 'den-1',
): void {
  const theme = getSiteTheme(siteId);
  const cx = x + 0.5;
  const v = Math.abs(Math.floor(index)) % 2;
  if (theme.cargoStyle === 'plants') {
    p.cyl(cx, y, 0.19, z0, 4.0, '#C2410C');
    p.cyl(cx, y, 0.24, z0 + 4.0, 4.8, v ? '#16A34A' : '#22C55E');
    p.cyl(cx, y, 0.12, z0 + 8.8, 2.0, v ? '#F472B6' : '#FACC15');
    return;
  }
  if (theme.cargoStyle === 'tech') {
    bandedBox(painterSink(p), cx, y, 0.56, 0.36, z0, 7.2, '#0F172A', [{ z: z0 + 3.5, h: 1.8, hex: v ? '#38BDF8' : '#22D3EE', grow: 0.02 }]);
    return;
  }
  if (theme.cargoStyle === 'artisan') {
    hoopedCyl(painterSink(p), cx, y, 0.21, z0, 8.0, v ? '#78350F' : '#92400E', [{ z: z0 + 3.6, h: 1.5, hex: '#FBBF24', r: 0.22 }]);
    return;
  }
  // Default ('boxes'): tote with a cross strap over the lid and down the visible side.
  p.aaBox(cx - 0.28, y - 0.18, 0.56, 0.36, z0, 7.5, v ? '#D97706' : '#3B82F6');
  p.aaBox(cx - 0.29, y - 0.05, 0.58, 0.1, z0 + 7.5, 0.4, '#FEF3C7');
  p.aaBox(cx + 0.28, y - 0.05, 0.01, 0.1, z0, 7.5, '#FEF3C7');
}

/**
 * Battery charger on tile `(x, y)`: a cabinet on a plinth along the tile's south edge (clear of
 * the parking spot at the tile centre), status screens on both faces, a floor cable to the pad
 * and a beacon strip that turns amber while a vehicle is charging.
 */
export function drawCharger(p: Painter, x: number, y: number, busy: boolean): void {
  propShadow(p, x + 0.5, y + 0.88, 0.5, 0.24, 0);
  p.aaBox(x + 0.47, y + 0.55, 0.06, 0.26, 0, 0.6, '#0F172A'); // floor cable to the pad
  p.aaBox(x + 0.26, y + 0.78, 0.48, 0.2, 0, 2, '#1E293B'); // plinth
  p.aaBox(x + 0.34, y + 0.785, 0.32, 0.02, 9, 5.5, busy ? '#FEF08A' : '#34D399'); // screen (pad side)
  p.aaBox(x + 0.28, y + 0.8, 0.44, 0.16, 2, 16, busy ? '#059669' : '#16A34A'); // cabinet
  p.aaBox(x + 0.34, y + 0.96, 0.32, 0.02, 9, 5.5, busy ? '#FEF08A' : '#34D399'); // screen (aisle side)
  p.aaBox(x + 0.27, y + 0.79, 0.46, 0.18, 18, 1.8, busy ? '#FACC15' : '#4ADE80'); // beacon strip
}

/** Traffic cone on tile `(x, y)`: rubber base, tapered orange body with a reflective collar. */
export function drawCone(p: Painter, x: number, y: number): void {
  const cx = x + 0.5;
  const cy = y + 0.5;
  propShadow(p, cx, cy, 0.5, 0.5, 0);
  p.aaBox(cx - 0.26, cy - 0.26, 0.52, 0.52, 0, 2.4, '#1E293B');
  p.cyl(cx, cy, 0.19, 2.4, 5.2, '#EA580C');
  p.cyl(cx, cy, 0.15, 7.6, 3.2, '#F8FAFC');
  p.cyl(cx, cy, 0.11, 10.8, 4.2, '#F97316');
}

/** Benches (returns QA), offices and break room. */
export function drawStruct(p: Painter, s: StructInfo): void {
  const o = 'rgba(15,23,42,0.22)';
  if (s.type === 'bench') {
    p.aaBox(s.x + 0.05, s.y + 0.1, s.w - 0.1, s.h - 0.2, 0, 11, '#8B5CF6', o);
    p.aaBox(s.x + 0.15, s.y + 0.2, s.w - 0.3, s.h - 0.4, 11, 1.5, '#EDE9FE');
    for (let i = 0; i < s.w; i++) p.aaBox(s.x + 0.35 + i * 0.95, s.y + 0.25, 0.3, 0.1, 12.5, 9, '#334155');
    return;
  }
  const office = s.type === 'office';
  const h = office ? 46 : 34;
  p.aaBox(s.x, s.y, s.w, s.h, 0, h, office ? '#CBD5E1' : '#D3E6CC', o);
  p.aaBox(s.x + 0.1, s.y + 0.1, s.w - 0.2, s.h - 0.2, h, 2.5, office ? '#E2E8F0' : '#BBF7D0');
  p.aaBox(s.x + 0.3, s.y + s.h, s.w - 0.6, 0.04, 14, 16, '#60A5FA');
  p.aaBox(s.x + s.w, s.y + 0.3, 0.04, s.h - 0.6, 14, 16, '#60A5FA');
}
