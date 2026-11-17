/**
 * Floor Trials challenge visuals (levels 7–18): pure HUD copy helpers plus one world-overlay pass
 * that draws only what the level opts into: putaway target slots, glass / heavy pallet tags, the
 * working chargers, dock-door state with countdowns, scripted traffic, and the Lights Out fog.
 *
 * Everything reads the sim state; nothing here feeds back into the trial.
 */
import {
  TRAFFIC_HIT,
  trafficPose,
  trafficTiles,
  windowState,
  type Order,
  type Trial,
  type TrialLevel,
} from '@warehouse/sim';
import type { Painter } from '../render/painter.js';
import type { Pose } from '../render/motion.js';

/** Short mechanic tags for a level card (empty for plain levels). */
export function mechanicTags(level: TrialLevel): string[] {
  const tags: string[] = [];
  if (level.pallets.some((p) => p.to)) tags.push('Putaway');
  if (level.pallets.some((p) => p.from && p.bay)) tags.push('Cross-dock');
  if (level.pallets.some((p) => p.fragile)) tags.push('Glass');
  if (level.pallets.some((p) => p.heavy)) tags.push('Heavy');
  if (level.cones?.length) tags.push('Cones');
  if (level.spills?.length) tags.push('Spills');
  if (level.rackHp === 1) tags.push('Wobbly racks');
  if (level.battery) tags.push('Battery');
  if (level.windows) tags.push('Dock windows');
  if (level.traffic?.length) tags.push('Traffic');
  if (level.visibility) tags.push('Dark');
  return tags;
}

/** Battery pill copy and tone, or null on levels without a battery. */
export function batteryHud(tr: Trial): { text: string; tone: 'ok' | 'low' | 'charging' } | null {
  const b = tr.state.battery;
  if (b === null || !tr.level.battery) return null;
  const pct = Math.max(0, Math.floor(b));
  if (tr.state.charging) return { text: `⚡ ${pct}% charging`, tone: 'charging' };
  return { text: `Battery ${pct}%`, tone: b <= 20 ? 'low' : 'ok' };
}

/** Stack pill: count, shipped, and the carried glass / heavy pallets bottom → top. */
export function stackSummary(tr: Trial): string {
  const v = tr.vehicle;
  const st = tr.state;
  const marks = v.cargo.map((o) => {
    const s = tr.specs.get(o.id);
    return s?.fragile ? 'glass' : s?.heavy ? 'heavy' : 'light';
  });
  const special = marks.some((m) => m !== 'light') ? ` (${marks.join(' · ')})` : '';
  return `Stack ${v.cargo.length}/${tr.level.stackMax}${special} · ${st.delivered}/${st.total} shipped`;
}

/**
 * Bottom intent line for challenge situations, or null to fall back to the basic copy.
 * `guide` is the sim's `trialGuide` result for this frame.
 */
export function challengeIntent(
  tr: Trial,
  guide: { kind: string; inRange: boolean; stow?: boolean; order: { bay: string; putaway?: { rackId: string } } } | null,
): string | null {
  const st = tr.state;
  const v = tr.vehicle;
  if (st.status !== 'running') return null;
  const slow = Math.abs(v.speedNow) < 1;
  if (st.charging) return `Charging ${Math.floor(st.battery ?? 0)}% · stay parked`;
  if (guide?.kind === 'charge') return 'Battery low · park on a green charger';
  if (guide?.kind === 'drop' && guide.stow && guide.inRange && slow) {
    return `E · Stow in ${guide.order.putaway?.rackId ?? 'rack'}`;
  }
  if (guide?.kind === 'drop' && !guide.stow && guide.inRange) {
    const win = windowState(tr.level.windows, guide.order.bay, st.t);
    if (win && !win.open) return `Bay ${guide.order.bay} door shut · opens in ${win.left.toFixed(1)}s`;
  }
  if (v.cargo.some((o) => tr.specs.get(o.id)?.fragile) && Math.abs(st.sway) > 0.3) return 'Glass aboard! Ease off';
  return null;
}

/** Fog layers (radius in tiles, alpha) for a visibility radius: a soft edge, dark beyond it. */
export function fogRings(visibility: number): Array<{ r: number; alpha: number }> {
  return [0, 0.6, 1.2, 1.8].map((d) => ({ r: visibility + d, alpha: 0.36 }));
}

const TRUCK_BODY = '#F97316';
const TRUCK_MAST = '#334155';
const GLASS = '#0284C7';
const HEAVY = '#334155';
const OPEN = '#16A34A';
const SHUT = '#DC2626';

function tag(pt: Painter, x: number, y: number, text: string, bg: string): void {
  const [sx, sy] = pt.P(x + 0.5, y + 0.5, 30);
  const ctx = pt.ctx;
  ctx.save();
  ctx.font = '800 9px Inter, -apple-system, sans-serif';
  const w = ctx.measureText(text).width + 8;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(sx - w / 2, sy - 7, w, 14, 4);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, sx, sy + 0.5);
  ctx.restore();
}

function palletTags(pt: Painter, tr: Trial, hidden: ReadonlySet<number>): void {
  for (const o of tr.world.orders) {
    if (o.state !== 'open' || hidden.has(o.id)) continue;
    const s = tr.specs.get(o.id);
    if (s?.fragile) tag(pt, o.slot.ax, o.slot.ay, 'GLASS', GLASS);
    else if (s?.heavy) tag(pt, o.slot.ax, o.slot.ay, 'HEAVY', HEAVY);
  }
}

function putawaySlots(pt: Painter, tr: Trial, pulse: number): void {
  const carried = new Set(tr.vehicle.cargo.map((o: Order) => o.id));
  for (const o of tr.world.orders) {
    if (!o.putaway || o.state === 'done') continue;
    const live = carried.has(o.id);
    const s = o.putaway;
    pt.tile(s.ax, s.ay, live ? `rgba(13,148,136,${(0.18 + 0.14 * pulse).toFixed(3)})` : 'rgba(13,148,136,0.08)', '#0D9488', live ? 2.5 : 1.5);
    if (live) {
      const [sx, sy] = pt.P(s.ax + 0.5, s.ay + 0.5, 18);
      pt.pill(s.rackId, sx, sy, '#0F766E');
    }
  }
}

function chargers(pt: Painter, tr: Trial, pulse: number): void {
  for (const c of tr.level.battery?.chargers ?? []) {
    pt.poly(pt.circleGrid(c.x + 0.5, c.y + 0.5, 0.42 + 0.05 * pulse, 18), 'rgba(34,197,94,0.22)', OPEN, 2);
  }
}

function dockDoors(pt: Painter, tr: Trial): void {
  const t = tr.state.t;
  for (const id of Object.keys(tr.level.windows ?? {})) {
    const bay = tr.world.map.bays.find((b) => b.id === id);
    const win = windowState(tr.level.windows, id, t);
    if (!bay || !win) continue;
    const col = win.open ? OPEN : SHUT;
    for (const tile of bay.tiles) pt.tile(tile.x, tile.y, win.open ? 'rgba(22,163,74,0.28)' : 'rgba(220,38,38,0.28)', col, 2);
    const mid = bay.tiles[1] ?? bay.tiles[0];
    const [sx, sy] = pt.P(mid.x + 0.5, mid.y + 0.5, 46);
    pt.pill(`${id} ${win.open ? 'OPEN' : 'SHUT'} ${win.left.toFixed(1)}s`, sx, sy, col);
  }
}

function traffic(pt: Painter, tr: Trial, worldT: number, blink: boolean): void {
  const ctx = pt.ctx;
  for (const tk of tr.level.traffic ?? []) {
    // Lane hint: faint dashed centre line along the loop.
    const tiles = trafficTiles(tk);
    if (tiles.length > 1) {
      ctx.save();
      ctx.setLineDash([3, 6]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(249,115,22,0.35)';
      ctx.beginPath();
      [...tk.path, tk.path[0]].forEach((p, i) => {
        const [x, y] = pt.P(p.x + 0.5, p.y + 0.5);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.stroke();
      ctx.restore();
    }
    const p = trafficPose(tk, worldT);
    const ca = Math.cos(p.a);
    const sa = Math.sin(p.a);
    pt.poly(pt.circleGrid(p.x, p.y, TRAFFIC_HIT, 20), 'rgba(249,115,22,0.12)', 'rgba(234,88,12,0.7)', 1.5);
    pt.oBox(p.x - ca * 0.08, p.y - sa * 0.08, 0.78, 0.56, p.a, 0, 9, TRUCK_BODY, 'rgba(15,23,42,0.28)');
    pt.oBox(p.x + ca * 0.36, p.y + sa * 0.36, 0.1, 0.46, p.a, 9, 13, TRUCK_MAST, 'rgba(15,23,42,0.28)');
    pt.oBox(p.x - ca * 0.2, p.y - sa * 0.2, 0.18, 0.18, p.a, 9, 3, blink ? '#FDE047' : '#CA8A04');
  }
}

/** Lights Out: darken everything beyond `visibility` tiles of the truck (soft-edged, static). */
export function drawFog(pt: Painter, pose: Pose, visibility: number): void {
  const ctx = pt.ctx;
  ctx.save();
  for (const ring of fogRings(visibility)) {
    ctx.beginPath();
    ctx.rect(-1e4, -1e4, 3e4, 3e4);
    const pts = pt.circleGrid(pose.x, pose.y, ring.r, 40);
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = `rgba(2,6,23,${ring.alpha})`;
    ctx.fill('evenodd');
  }
  ctx.restore();
}

/**
 * World overlays for the level's mechanics. `hidden` lists pallets still mid-tumble and `simT` is
 * the frame-interpolated level clock (smooth traffic between 10 Hz ticks). Under reduced motion
 * nothing pulses or blinks.
 */
export function drawChallengeWorld(
  pt: Painter,
  tr: Trial,
  nowMs: number,
  hidden: ReadonlySet<number>,
  reducedMotion: boolean,
  simT = tr.state.t,
): void {
  const pulse = reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(nowMs / 220);
  const blink = reducedMotion ? true : Math.floor(nowMs / 400) % 2 === 0;
  putawaySlots(pt, tr, pulse);
  chargers(pt, tr, pulse);
  dockDoors(pt, tr);
  palletTags(pt, tr, hidden);
  traffic(pt, tr, simT, blink);
}
