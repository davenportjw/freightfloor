import {
  AreaInfo,
  BASE_FLEET,
  BASE_H,
  BayConfig,
  DistrictKind,
  MAP_W,
  MAX_TIER,
  Point,
  Rack,
  Slot,
  StructInfo,
  TIER_ROWS,
  TIER_STEP,
  World,
  WorldMap,
  ZoneInfo,
} from './types.js';

export const BASE_HWY_Y = [2, 11, 20, 29, 38] as const;
export const HWY_X = [10, 15, 20, 25, 30, 35, 40, 45, 50, MAP_W - 5] as const;
export const HWY_E = MAP_W - 5;
export const PARK_Y = 39;

export const KINDS: Record<
  DistrictKind,
  { label: string; short: string; pick: number; drain: number; speed: number; bonus: number }
> = {
  ambient: { label: 'Ambient racking', short: 'Ambient', pick: 1.2, drain: 1.0, speed: 1.0, bonus: 0 },
  cold: { label: 'Cold storage', short: 'Cold', pick: 1.5, drain: 1.6, speed: 1.0, bonus: 3 },
  fast: { label: 'Fast pick', short: 'Fast pick', pick: 0.7, drain: 1.0, speed: 1.0, bonus: 0 },
  bulk: { label: 'Bulk floor stack', short: 'Bulk', pick: 1.8, drain: 1.15, speed: 1.0, bonus: 2 },
  haz: { label: 'Hazmat cage', short: 'Hazmat', pick: 1.6, drain: 1.0, speed: 0.6, bonus: 5 },
  returns: { label: 'Returns & QA', short: 'Returns', pick: 1.2, drain: 1.0, speed: 1.0, bonus: 0 },
  staging: { label: 'Outbound staging', short: 'Staging', pick: 1.2, drain: 1.0, speed: 1.0, bonus: 0 },
  office: { label: 'Offices', short: 'Offices', pick: 1.2, drain: 1.0, speed: 1.0, bonus: 0 },
  charging: { label: 'Charging bank', short: 'Charging', pick: 1.2, drain: 1.0, speed: 1.0, bonus: 0 },
};

export const KIND_IDS = Object.keys(KINDS) as DistrictKind[];
export const K_SPEED = KIND_IDS.map((k) => KINDS[k].speed);
export const K_DRAIN = KIND_IDS.map((k) => KINDS[k].drain);
export const K_PICK = KIND_IDS.map((k) => KINDS[k].pick);

const BAND_Y = [5, 14, 23, 32];
const BLOCK_X = [7, 12, 17, 22, 27, 32, 37, 42, 47];
const LAYOUT: Array<Array<string | null>> = [
  ['A:ambient', 'B:ambient', 'C:ambient', 'D:ambient', 'E:cold', 'F:cold', 'G:bulk', 'H:bulk', null],
  ['I:ambient', 'J:ambient', 'K:fast', 'L:fast', 'M:cold', 'N:cold', null, null, 'O:haz'],
  ['P:fast', 'Q:fast', 'R:ambient', 'S:ambient', 'T:ambient', 'U:ambient', 'V:bulk', 'W:bulk', null],
  [null, null, null, 'X:ambient', 'Y:ambient', 'Z:haz', null, null, null],
];
const WING_KINDS: DistrictKind[] = [
  'ambient',
  'ambient',
  'fast',
  'fast',
  'ambient',
  'cold',
  'cold',
  'bulk',
  'bulk',
];

export function tierFor(vehicleCount: number): number {
  return Math.max(0, Math.min(MAX_TIER, Math.ceil((vehicleCount - BASE_FLEET) / TIER_STEP)));
}

export function tierCap(tier: number): number {
  const clamped = Math.max(0, Math.min(MAX_TIER, tier));
  return BASE_FLEET + TIER_STEP * clamped;
}

function kindIdx(k: DistrictKind): number {
  return KIND_IDS.indexOf(k);
}

function checkIsHighway(hwyY: number[], x: number, y: number): boolean {
  return (
    hwyY.some((h) => y === h || y === h + 1) ||
    x === 4 ||
    x === 5 ||
    (HWY_X as readonly number[]).includes(x)
  );
}

export function buildMap(tierInput = 0): WorldMap {
  const tier = Math.max(0, Math.min(MAX_TIER, tierInput | 0));
  const w = MAP_W;
  const h = tier ? BASE_H + 3 + TIER_ROWS * tier : BASE_H;
  const hwyY: number[] = [...BASE_HWY_Y];
  const hwyX = [...HWY_X];
  const racks: Rack[] = [];
  const slots: Slot[] = [];
  const zones: ZoneInfo[] = [];
  const areas: AreaInfo[] = [];
  const structs: StructInfo[] = [];
  const zoneFar: Record<string, number> = {};
  const zoneKind: Record<string, DistrictKind> = {};
  const conveyors: Point[] = [];
  const bays: BayConfig[] = [];
  const westDocks: Array<{ id: string; y: number; x: number }> = [];
  const chargers: Point[] = [];
  const floorK = new Uint8Array(w * h);
  const staticBlock = new Uint8Array(w * h);

  const bandY = BAND_Y.slice();
  const layout = LAYOUT.map((row) => row.slice());

  for (let j = 1; j <= tier; j++) {
    hwyY.push(43 + TIER_ROWS * (j - 1));
    bandY.push(46 + TIER_ROWS * (j - 1));
    layout.push(
      Array.from({ length: 9 }, (_, ci) =>
        ci === 8 ? null : `${'ABCDEFGHI'[ci]}${j}:${WING_KINDS[(ci + j * 3) % 9]}`,
      ),
    );
  }
  if (tier) {
    hwyY.push(43 + TIER_ROWS * tier);
  }

  const paint = (x0: number, y0: number, x1: number, y1: number, kind: DistrictKind) => {
    const idx = kindIdx(kind);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (x < 1 || y < 1 || x > w - 2 || y > h - 2 || checkIsHighway(hwyY, x, y)) continue;
        floorK[y * w + x] = idx;
      }
    }
  };

  const addArea = (
    kind: DistrictKind,
    x: number,
    y: number,
    aw: number,
    ah: number,
    name?: string,
  ) => {
    areas.push({ kind, x, y, w: aw, h: ah, name: name || KINDS[kind].label });
    paint(x, y, x + aw - 1, y + ah - 1, kind);
  };

  layout.forEach((row, bi) => {
    const y0 = bandY[bi];
    row.forEach((cell, ci) => {
      if (!cell) return;
      const [zone, rawKind] = cell.split(':');
      const kind = rawKind as DistrictKind;
      const x0 = BLOCK_X[ci];
      zones.push({ id: zone, kind, x: x0, y: y0 });
      zoneFar[zone] = x0 + 1;
      zoneKind[zone] = kind;
      [x0, x0 + 1].forEach((x, k) => {
        [0, 1, 2, 3, 4].forEach((ri) => {
          const y = y0 + ri;
          const id = `${zone}${zone.length > 1 ? '.' : ''}${k + 1}-${ri + 1}`;
          const ax = k === 0 ? x - 1 : x + 1;
          racks.push({ id, zone, kind, x, y, tone: (x + y) % 2 });
          slots.push({ key: `${ax},${y}`, rackId: id, zone, rx: x, ry: y, ax, ay: y });
        });
      });
    });

    for (let ci = 0; ci < row.length; ci++) {
      const cell = row[ci];
      const kind = cell ? (cell.split(':')[1] as DistrictKind) : null;
      if (!kind || kind === 'ambient') continue;
      let cj = ci;
      while (cj + 1 < row.length && row[cj + 1] && row[cj + 1]!.split(':')[1] === kind) {
        cj++;
      }
      addArea(kind, BLOCK_X[ci] - 1, y0 - 1, BLOCK_X[cj] - BLOCK_X[ci] + 4, 7);
      ci = cj;
    }
  });

  addArea('returns', 6, 31, 15, 7);
  [6, 11, 16].forEach((x) => structs.push({ type: 'bench', x, y: 33, w: 3, h: 2 }));
  addArea('staging', 36, 31, 15, 7);
  addArea('staging', 46, 4, 5, 7);
  addArea('staging', 46, 22, 5, 7);
  addArea('office', 36, 14, 4, 5, 'Admin');
  structs.push({ type: 'office', x: 36, y: 14, w: 4, h: 5, name: 'Admin' });
  addArea('office', 41, 14, 4, 5, 'Break room');
  structs.push({ type: 'break', x: 41, y: 14, w: 4, h: 5, name: 'Break room' });
  addArea('charging', 7, 40, 26, 2);

  bandY.forEach((y0) => {
    for (let y = y0; y < y0 + 5; y++) {
      conveyors.push({ x: w - 8, y });
    }
  });

  // East bays: E7 and E8 (indices 6 and 7 on the base floor) are dedicated network transfer bays ('→ NET')
  bandY
    .flatMap((y0) => [y0 + 1, y0 + 4])
    .forEach((y, i) => {
      const id = `E${i + 1}`;
      const isTransferBay = i === 6 || i === 7;
      bays.push({
        id,
        y,
        dropX: w - 2,
        tiles: [y - 1, y, y + 1].map((ty) => ({ x: w - 2, y: ty })),
        isTransferBay,
        label: isTransferBay ? '→ NET' : id,
      });
    });

  bandY.forEach((y0, i) => westDocks.push({ id: `W${i + 1}`, x: 1, y: y0 + 2 }));

  for (let i = 0; i < 10; i++) chargers.push({ x: 8 + i, y: 40 });
  for (let i = 0; i < 10; i++) chargers.push({ x: 22 + i, y: 40 });

  for (let j = 1; j <= tier; j++) {
    const y0 = bandY[3 + j];
    addArea('charging', 7, y0 - 1, 10, 1);
    for (let i = 0; i < 8; i++) chargers.push({ x: 8 + i, y: y0 - 1 });
    addArea('staging', 46, y0 - 1, 5, 7);
  }

  racks.forEach((r) => {
    staticBlock[r.y * w + r.x] = 1;
  });
  conveyors.forEach((c) => {
    staticBlock[c.y * w + c.x] = 1;
  });
  structs.forEach((s) => {
    for (let y = s.y; y < s.y + s.h; y++) {
      for (let x = s.x; x < s.x + s.w; x++) {
        staticBlock[y * w + x] = 1;
      }
    }
  });

  return {
    tier,
    w,
    h,
    hwyY,
    hwyX,
    racks,
    slots,
    zones,
    areas,
    structs,
    zoneFar,
    zoneKind,
    conveyors,
    bays,
    westDocks,
    chargers,
    floorK,
    staticBlock,
  };
}

const DEFAULT_MAP_T0 = buildMap(0);

function resolveMap(m?: World | WorldMap): WorldMap {
  if (!m) return DEFAULT_MAP_T0;
  return 'map' in m ? m.map : m;
}

export function parkY(mapOrY: World | WorldMap | number, maybeY?: number): number {
  const m = typeof mapOrY === 'number' ? DEFAULT_MAP_T0 : resolveMap(mapOrY);
  const y = typeof mapOrY === 'number' ? mapOrY : maybeY!;
  if (y < 42) return PARK_Y;
  const below = m.hwyY.filter((h) => h <= y);
  return (below.length ? below[below.length - 1] : PARK_Y - 1) + 1;
}

export function isHighway(
  mapOrX: World | WorldMap | number,
  xOrY: number,
  maybeY?: number,
): boolean {
  const m = typeof mapOrX === 'number' ? DEFAULT_MAP_T0 : resolveMap(mapOrX);
  const x = typeof mapOrX === 'number' ? mapOrX : xOrY;
  const y = typeof mapOrX === 'number' ? xOrY : maybeY!;
  return checkIsHighway(m.hwyY, x, y);
}

export function laneDir(
  mapOrX: World | WorldMap | number,
  xOrY: number,
  maybeY?: number,
): [number, number] | null {
  const m = typeof mapOrX === 'number' ? DEFAULT_MAP_T0 : resolveMap(mapOrX);
  const x = typeof mapOrX === 'number' ? mapOrX : xOrY;
  const y = typeof mapOrX === 'number' ? xOrY : maybeY!;
  if (m.hwyY.includes(y)) return [-1, 0];
  if (m.hwyY.includes(y - 1)) return [1, 0];
  if (x === 4) return [0, -1];
  if (x === 5) return [0, 1];
  return null;
}

export function laneAgainst(
  map: World | WorldMap,
  x: number,
  y: number,
  dx: number,
  dy: number,
): boolean {
  const d = laneDir(map, x, y);
  return !!d && ((d[0] !== 0 && dx === -d[0]) || (d[1] !== 0 && dy === -d[1]));
}

export function floorKind(
  mapOrX: World | WorldMap | number,
  xOrY: number,
  maybeY?: number,
): DistrictKind {
  const m = typeof mapOrX === 'number' ? DEFAULT_MAP_T0 : resolveMap(mapOrX);
  const x = typeof mapOrX === 'number' ? mapOrX : xOrY;
  const y = typeof mapOrX === 'number' ? xOrY : maybeY!;
  return KIND_IDS[m.floorK[y * m.w + x]] || 'ambient';
}

export function kindAtTile(
  mapOrX: World | WorldMap | number,
  xOrY: number,
  maybeY?: number,
): number {
  const m = typeof mapOrX === 'number' ? DEFAULT_MAP_T0 : resolveMap(mapOrX);
  const x = typeof mapOrX === 'number' ? mapOrX : xOrY;
  const y = typeof mapOrX === 'number' ? xOrY : maybeY!;
  return m.floorK[y * m.w + x] ?? 0;
}

export function isBlocked(w: World, x: number, y: number): boolean {
  const m = w.map;
  if (x < 1 || x > m.w - 2 || y < 1 || y > m.h - 2) return true;
  if (m.staticBlock[y * m.w + x]) return true;
  return w.cones.has(`${x},${y}`);
}

export function bayAt(
  mapOrX: World | WorldMap | number,
  xOrY: number,
  maybeY?: number,
): BayConfig | null {
  const m = typeof mapOrX === 'number' ? DEFAULT_MAP_T0 : resolveMap(mapOrX);
  const x = typeof mapOrX === 'number' ? mapOrX : xOrY;
  const y = typeof mapOrX === 'number' ? xOrY : maybeY!;
  return m.bays.find((b) => b.tiles.some((t) => t.x === x && t.y === y)) || null;
}

export function dropTile(w: World, bay: BayConfig, fx: number, fy: number): Point {
  const busy = new Set<string>();
  w.vehicles.forEach((q) => {
    busy.add(`${q.tile.x},${q.tile.y}`);
    if (q.moveTo) busy.add(`${q.moveTo.x},${q.moveTo.y}`);
  });
  const cost = (t: Point) =>
    Math.abs(t.x - fx) +
    Math.abs(t.y - fy) +
    (busy.has(`${t.x},${t.y}`) ? 6 : 0) +
    (w.cones.has(`${t.x},${t.y}`) ? 99 : 0);
  return bay.tiles.slice().sort((a, b) => cost(a) - cost(b))[0];
}

export function chargerAt(
  mapOrX: World | WorldMap | number,
  xOrY: number,
  maybeY?: number,
): number {
  const m = typeof mapOrX === 'number' ? DEFAULT_MAP_T0 : resolveMap(mapOrX);
  const x = typeof mapOrX === 'number' ? mapOrX : xOrY;
  const y = typeof mapOrX === 'number' ? xOrY : maybeY!;
  return m.chargers.findIndex((c) => c.x === x && c.y === y);
}

// ---------- A* Pathfinding (binary heap) ----------
type HeapNode = [number, number];

function heapPush(h: HeapNode[], n: HeapNode): void {
  h.push(n);
  let i = h.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (h[p][0] <= h[i][0]) break;
    const tmp = h[p];
    h[p] = h[i];
    h[i] = tmp;
    i = p;
  }
}

function heapPop(h: HeapNode[]): HeapNode {
  const top = h[0];
  const last = h.pop()!;
  if (h.length) {
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < h.length && h[l][0] < h[m][0]) m = l;
      if (r < h.length && h[r][0] < h[m][0]) m = r;
      if (m === i) break;
      const tmp = h[m];
      h[m] = h[i];
      h[i] = tmp;
      i = m;
    }
  }
  return top;
}

export interface FindPathOptions {
  flat?: boolean;
  avoid?: Set<string>;
}

export function findPath(
  w: World,
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  opts: FindPathOptions = {},
): Point[] | null {
  if (sx === ex && sy === ey) return [];
  if (isBlocked(w, ex, ey)) return null;
  const m = w.map;
  const W = m.w;
  const H = m.h;
  const N = W * H;
  const s = sy * W + sx;
  const e = ey * W + ex;
  const g = new Float32Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const open: HeapNode[] = [];
  g[s] = 0;
  heapPush(open, [0, s]);
  const D: Array<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  while (open.length) {
    const cur = heapPop(open)[1];
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === e) break;
    const cx = cur % W;
    const cy = (cur / W) | 0;
    for (const [dx, dy] of D) {
      const nx = cx + dx;
      const ny = cy + dy;
      const ni = ny * W + nx;
      if (isBlocked(w, nx, ny) || closed[ni]) continue;
      if (opts.avoid && ni !== e && opts.avoid.has(`${nx},${ny}`)) continue;
      const hwy = isHighway(m, nx, ny);
      const against = laneAgainst(m, nx, ny, dx, dy);
      const heatCost = w.heat ? Math.min(0.8, (w.heat[ni] || 0) * 0.04) : 0;
      const cost =
        (opts.flat ? 1 : hwy ? 0.8 : 1.25) +
        (against ? (opts.flat ? 1 : 3) : 0) +
        heatCost;
      const ng = g[cur] + cost;
      if (ng < g[ni]) {
        g[ni] = ng;
        came[ni] = cur;
        heapPush(open, [ng + 0.8 * (Math.abs(ex - nx) + Math.abs(ey - ny)), ni]);
      }
    }
  }
  if (came[e] === -1) return null;
  const path: Point[] = [];
  for (let c = e; c !== s; c = came[c]) {
    path.push({ x: c % W, y: (c / W) | 0 });
  }
  return path.reverse();
}
