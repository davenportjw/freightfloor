/** District palette, rack palette and static scenery (racks, structures) from the mock. */
import { HUMAN, STRATEGIES, type DistrictKind, type Rack, type StructInfo, type Vehicle } from '@warehouse/sim';
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

type RackPal = [string, string, string[]];
const RACK_PAL: Partial<Record<DistrictKind, RackPal>> = {
  ambient: ['#1D4ED8', '#2563EB', ['#D9B98A', '#C4A06B', '#CDAE82']],
  cold: ['#0E7490', '#0891B2', ['#E0F2FE', '#BAE6FD', '#CFE8F3']],
  haz: ['#B91C1C', '#DC2626', ['#FACC15', '#EF4444', '#F59E0B']],
  fast: ['#047857', '#059669', ['#FB923C', '#FACC15', '#38BDF8']],
};

export function teamColor(v: Vehicle): string {
  return v.human ? HUMAN.color : (STRATEGIES[v.strategy]?.color ?? '#64748B');
}

/**
 * 3D rack. Shelf stock is decorative (deterministic hash of the rack position, as in
 * the mock); real order data is drawn separately as pallets + rings at the aisle slot.
 */
export function drawRack(p: Painter, r: Rack): void {
  const x = r.x;
  const y = r.y;
  const hsh = (x * 7 + y * 13 + x * y) % 7;
  const k = r.kind;
  const pal = RACK_PAL[k] ?? RACK_PAL.ambient!;
  if (p.cam.zoom < 0.7) {
    const h = k === 'bulk' ? 30 : k === 'fast' ? 26 : 38;
    p.aaBox(x + 0.04, y + 0.04, 0.92, 0.92, 0, h, k === 'bulk' ? '#C8963F' : pal[r.tone ? 1 : 0]);
    return;
  }
  if (k === 'bulk') {
    p.aaBox(x + 0.06, y + 0.06, 0.88, 0.88, 0, 3, '#C4A06B');
    const n = 1 + (hsh % 3);
    for (let i = 0; i < n; i++) {
      p.aaBox(x + 0.1, y + 0.1, 0.8, 0.8, 3 + i * 15, 14, ['#D6A75C', '#C8963F', '#DDB46B'][(hsh + i) % 3]);
      p.aaBox(x + 0.08, y + 0.08, 0.84, 0.84, 8 + i * 15, 2, '#E5E7EB');
    }
    return;
  }
  const lv = k === 'fast' ? 2 : 3;
  const H = lv === 2 ? 25 : 36;
  const base = pal[r.tone ? 1 : 0];
  const post = (px: number, py: number) => p.aaBox(x + px, y + py, 0.07, 0.07, 0, H, base);
  post(0.04, 0.04);
  post(0.89, 0.04);
  post(0.04, 0.89);
  for (let l = 0; l < lv; l++) {
    const z = 3 + l * 11;
    p.aaBox(x + 0.03, y + 0.03, 0.94, 0.94, z, 1.6, '#64748B');
    const q = (hsh + l * 3) % 7;
    if (q === 0 || q === 3) continue;
    if (k === 'fast') {
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
  post(0.89, 0.89);
  p.aaBox(x + 0.02, y + 0.02, 0.96, 0.96, H - 1, 2.5, k === 'cold' ? '#7DD3FC' : '#334155');
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
