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

/**
 * Resolves the pre-baked isometric 3D cargo sprite key (`cargo_<style>_<variant>`)
 * for an order at the given regional site.
 */
export function resolveCargoSpriteKey(
  o: Pick<Order, 'id' | 'p0' | 'isTransfer'>,
  siteId = 'den-1',
): string {
  const theme = getSiteTheme(siteId);
  const suffix = o.p0
    ? 'p0'
    : o.isTransfer
      ? 'net'
      : String(Math.abs(o.id || 0) % 3);
  return `cargo_${theme.cargoStyle}_${suffix}`;
}

/**
 * Resolves the pre-baked isometric 3D conveyor tote sprite key (`conv_<style>_<variant>`)
 * for a moving outbound tote at the given regional site.
 */
export function resolveConveyorSpriteKey(index: number, siteId = 'den-1'): string {
  const theme = getSiteTheme(siteId);
  const variant = Math.abs(Math.floor(index)) % 2;
  return `conv_${theme.cargoStyle}_${variant}`;
}

/**
 * Draws an order's physical cargo item at aisle slot `(x, y)` starting at height `z0`.
 * Uses the baked 96x96 2:1 isometric 3D sprite when `p.sprite` has a loaded atlas,
 * falling back to procedural 3D primitives otherwise.
 */
export function drawCargoItem(
  p: Painter,
  x: number,
  y: number,
  z0: number,
  o: Pick<Order, 'id' | 'p0' | 'isTransfer'>,
  siteId = 'den-1',
): void {
  const key = resolveCargoSpriteKey(o, siteId);
  if (typeof (p as Partial<Painter>).sprite === 'function' && p.sprite(key, x + 0.5, y + 0.5, z0, 1.5)) {
    return;
  }
  const theme = getSiteTheme(siteId);
  const variant = Math.abs(o.id || 0) % 3;

  if (theme.cargoStyle === 'plants') {
    // Wooden nursery tray + terracotta pot + botanical canopy / blossom
    p.aaBox(x + 0.2, y + 0.2, 0.6, 0.6, z0, 2.2, '#A16207');
    const potCol = o.p0 ? '#DC2626' : o.isTransfer ? NET_COLOR : '#C2410C';
    p.cyl(x + 0.5, y + 0.5, 0.21, z0 + 2.2, 5.2, potCol);
    const leafCol =
      variant === 0 ? '#16A34A' : variant === 1 ? '#15803D' : '#059669';
    p.cyl(x + 0.5, y + 0.5, 0.28, z0 + 7.0, 6.2, leafCol);
    const bloomCol = o.p0
      ? '#FEF08A'
      : o.isTransfer
        ? '#C7D2FE'
        : variant === 0
          ? '#F472B6'
          : variant === 1
            ? '#4ADE80'
            : '#FACC15';
    p.cyl(x + 0.5, y + 0.5, 0.14, z0 + 13.0, 2.4, bloomCol);
    return;
  }

  if (theme.cargoStyle === 'tech') {
    // Brushed aluminum wafer base + dark cleanroom FOUP pod + glowing status ring
    p.aaBox(x + 0.2, y + 0.2, 0.6, 0.6, z0, 2.2, '#94A3B8');
    const bodyCol = o.p0 ? '#991B1B' : o.isTransfer ? '#312E81' : '#1E293B';
    p.aaBox(x + 0.24, y + 0.24, 0.52, 0.52, z0 + 2.2, 9.5, bodyCol);
    const glowCol = o.p0
      ? '#F87171'
      : o.isTransfer
        ? '#818CF8'
        : variant === 0
          ? '#38BDF8'
          : variant === 1
            ? '#22D3EE'
            : '#34D399';
    p.aaBox(x + 0.22, y + 0.22, 0.56, 0.56, z0 + 6.5, 2.0, glowCol);
    p.cyl(x + 0.5, y + 0.5, 0.15, z0 + 11.7, 1.8, glowCol);
    return;
  }

  if (theme.cargoStyle === 'artisan') {
    // Timber pallet + standing oak barrel / copper cask + brass hoop
    p.aaBox(x + 0.2, y + 0.2, 0.6, 0.6, z0, 2.2, '#A16207');
    const caskCol = o.p0
      ? '#DC2626'
      : o.isTransfer
        ? NET_COLOR
        : variant === 0
          ? '#78350F'
          : variant === 1
            ? '#92400E'
            : '#B45309';
    p.cyl(x + 0.5, y + 0.5, 0.25, z0 + 2.2, 10.2, caskCol);
    const hoopCol = o.p0 ? '#FEF08A' : o.isTransfer ? '#C7D2FE' : '#FBBF24';
    p.cyl(x + 0.5, y + 0.5, 0.26, z0 + 5.8, 1.6, hoopCol);
    p.cyl(x + 0.5, y + 0.5, 0.22, z0 + 12.4, 1.2, '#D97706');
    return;
  }

  // Default ('den-1' boxes): pallet + cardboard / P0 / transfer carton + strapping band
  p.aaBox(x + 0.2, y + 0.2, 0.6, 0.6, z0, 2.5, '#C4A06B');
  const boxCol = o.p0 ? '#EF4444' : o.isTransfer ? NET_COLOR : '#D97706';
  const strapCol = o.p0 ? '#FEF3C7' : o.isTransfer ? '#C7D2FE' : '#FDE68A';
  p.aaBox(x + 0.24, y + 0.24, 0.52, 0.52, z0 + 2.5, 9, boxCol);
  p.aaBox(x + 0.22, y + 0.22, 0.56, 0.56, z0 + 6.5, 1.5, strapCol);
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
  const key = resolveConveyorSpriteKey(index, siteId);
  if (typeof (p as Partial<Painter>).sprite === 'function' && p.sprite(key, x + 0.5, y, z0, 1.5)) {
    return;
  }
  const theme = getSiteTheme(siteId);
  if (theme.cargoStyle === 'plants') {
    p.cyl(x + 0.5, y, 0.18, z0, 3.8, '#C2410C');
    p.cyl(x + 0.5, y, 0.23, z0 + 3.5, 4.5, index % 2 ? '#16A34A' : '#22C55E');
    return;
  }
  if (theme.cargoStyle === 'tech') {
    p.aaBox(x + 0.22, y - 0.18, 0.56, 0.36, z0, 6.5, '#0F172A');
    p.aaBox(x + 0.2, y - 0.16, 0.6, 0.32, z0 + 3.2, 1.5, index % 2 ? '#38BDF8' : '#22D3EE');
    return;
  }
  if (theme.cargoStyle === 'artisan') {
    p.cyl(x + 0.5, y, 0.21, z0, 7.2, index % 2 ? '#78350F' : '#92400E');
    p.cyl(x + 0.5, y, 0.22, z0 + 3.2, 1.3, '#FBBF24');
    return;
  }
  p.aaBox(x + 0.22, y - 0.18, 0.56, 0.36, z0, 7, index % 2 ? '#D97706' : '#3B82F6');
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
