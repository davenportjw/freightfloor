/**
 * Moment juice (retention spec §4b): small canvas effects at state changes the client already
 * receives. No new server data, nothing invented:
 *   - on-time delivery (my `fare` event, rating not `slow`) → confetti in my livery colours;
 *   - delivery streak milestone (my `streak` crossing a multiple of 5) and a Daily streak
 *     milestone (`dailyResult.streakDelta > 0` at 3 / 7 / 14 / 30 / 50 / 100 days) → ring pulse;
 *   - new personal best (`dailyResult.improved` on a repeat attempt) → gold edge flash.
 *
 * Every effect respects `prefers-reduced-motion`: no confetti, a static ring that only fades,
 * and a dim, non-flickering edge glow instead of the flash.
 *
 * Pure and deterministic (particles come from a seeded PRNG), so frames are unit-testable.
 */
import { HUMAN, type SimEvent } from '@warehouse/sim';
import { mulberry32, type DailyResultMessage, type LiveryDef } from '@warehouse/protocol';

export type JuiceKind = 'confetti' | 'ring' | 'flash';

export interface Juice {
  kind: JuiceKind;
  born: number;
  /** Confetti palette, or the single ring / flash colour at [0]. */
  colors: string[];
  /** PRNG seed for confetti layout. */
  seed: number;
}

export const JUICE_MS: Record<JuiceKind, number> = { confetti: 900, ring: 1100, flash: 700 };
export const JUICE_MAX = 6;
export const STREAK_MILESTONE_EVERY = 5;
export const DAILY_STREAK_MILESTONES: readonly number[] = [3, 7, 14, 30, 50, 100];
export const GOLD = '#F59E0B';
const CONFETTI_COUNT = 18;

/** Confetti colours: livery primary + accent/highlight, else the human teal, plus amber and white. */
export function confettiPalette(livery: LiveryDef | null): string[] {
  if (!livery) return [HUMAN.color, '#5EEAD4', GOLD, '#FFFFFF'];
  return [livery.primary, livery.accent ?? livery.light, GOLD, '#FFFFFF'];
}

/** Confetti for my on-time delivery, else null. `slow` is the only rating a late delivery gets. */
export function juiceForEvent(ev: SimEvent, myVid: string | null, livery: LiveryDef | null, now: number): Juice | null {
  if (!myVid || ev.type !== 'fare' || ev.vid !== myVid) return null;
  if (ev.rating === 'slow') return null;
  const seed = (typeof ev.orderId === 'number' ? ev.orderId : 0) * 2654435761 + Math.floor(now);
  return { kind: 'confetti', born: now, colors: confettiPalette(livery), seed: seed >>> 0 };
}

/** The milestone reached when my delivery streak goes prev → next, else null. */
export function streakMilestone(prev: number, next: number): number | null {
  if (!(next > prev) || next < STREAK_MILESTONE_EVERY) return null;
  const m = Math.floor(next / STREAK_MILESTONE_EVERY) * STREAK_MILESTONE_EVERY;
  return m > prev ? m : null;
}

export function ringJuice(now: number, color = GOLD): Juice {
  return { kind: 'ring', born: now, colors: [color], seed: 0 };
}

/** Juice for my private Daily result: PB flash on a repeat attempt, ring on a streak milestone. */
export function dailyJuice(msg: DailyResultMessage, now: number): Juice[] {
  const out: Juice[] = [];
  if (msg.improved && msg.attempts > 1) out.push({ kind: 'flash', born: now, colors: [GOLD], seed: 0 });
  if (msg.streakDelta > 0 && DAILY_STREAK_MILESTONES.includes(msg.streak)) out.push(ringJuice(now));
  return out;
}

/** Drop expired effects and cap the list (newest kept). */
export function pruneJuice(list: readonly Juice[], now: number): Juice[] {
  return list.filter((j) => now - j.born < JUICE_MS[j.kind] && now >= j.born).slice(-JUICE_MAX);
}

export interface ConfettiBit {
  /** Screen offset from the burst origin (CSS px, before zoom). */
  dx: number;
  dy: number;
  size: number;
  rot: number;
  color: string;
  alpha: number;
}

/** Confetti particles at `now`. Empty under reduced motion or outside the effect's lifetime. */
export function confettiFrame(j: Juice, now: number, reduced: boolean): ConfettiBit[] {
  if (reduced || j.kind !== 'confetti') return [];
  const k = (now - j.born) / JUICE_MS.confetti;
  if (k < 0 || k >= 1) return [];
  const rnd = mulberry32(j.seed);
  const t = k * 0.9; // seconds-ish
  const out: ConfettiBit[] = [];
  for (let i = 0; i < CONFETTI_COUNT; i++) {
    const ang = -Math.PI / 2 + (rnd() - 0.5) * Math.PI * 1.1;
    const speed = 90 + rnd() * 110;
    const spin = (rnd() - 0.5) * 14;
    out.push({
      dx: Math.cos(ang) * speed * t,
      dy: Math.sin(ang) * speed * t + 160 * t * t,
      size: 3 + rnd() * 3,
      rot: spin * t,
      color: j.colors[i % j.colors.length],
      alpha: k < 0.6 ? 1 : Math.max(0, 1 - (k - 0.6) / 0.4),
    });
  }
  return out;
}

/** Ring pulse at `now`: expands and fades, or (reduced motion) holds its radius and only fades. */
export function ringFrame(j: Juice, now: number, reduced: boolean): { radius: number; alpha: number; width: number } | null {
  if (j.kind !== 'ring') return null;
  const k = (now - j.born) / JUICE_MS.ring;
  if (k < 0 || k >= 1) return null;
  const ease = 1 - (1 - k) ** 3;
  return {
    radius: reduced ? 1.1 : 0.7 + 1.6 * ease,
    alpha: reduced ? 0.6 * (1 - k) : 0.9 * (1 - k),
    width: reduced ? 2.5 : 4 - 2 * k,
  };
}

/** Edge-flash opacity at `now`: one quick rise then decay (never flickers); dim under reduced motion. */
export function flashAlpha(j: Juice, now: number, reduced: boolean): number {
  if (j.kind !== 'flash') return 0;
  const k = (now - j.born) / JUICE_MS.flash;
  if (k < 0 || k >= 1) return 0;
  const peak = reduced ? 0.12 : 0.4;
  if (reduced) return peak * (1 - k);
  return k < 0.15 ? peak * (k / 0.15) : peak * (1 - (k - 0.15) / 0.85);
}

// ---------------------------------------------------------------------------------------------
// Shared screen-space painters (iso renderer and Cab View overlay draw the same effects).

/** The slice of `CanvasRenderingContext2D` the painters use (kept narrow so tests can record). */
export type JuiceCtx = Pick<
  CanvasRenderingContext2D,
  | 'save' | 'restore' | 'translate' | 'rotate' | 'fillRect' | 'createRadialGradient'
  | 'beginPath' | 'ellipse' | 'stroke'
> & { globalAlpha: number; fillStyle: string | CanvasGradient | CanvasPattern; strokeStyle: string | CanvasGradient | CanvasPattern; lineWidth: number };

/** Gold edge flash over a `w`×`h` CSS-px viewport. */
export function paintEdgeFlash(ctx: JuiceCtx, w: number, h: number, alpha: number): void {
  if (alpha <= 0) return;
  const r = Math.max(w, h) * 0.75;
  const g = ctx.createRadialGradient(w / 2, h / 2, r * 0.55, w / 2, h / 2, r);
  g.addColorStop(0, 'rgba(245,158,11,0)');
  g.addColorStop(1, `rgba(245,158,11,${alpha.toFixed(3)})`);
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/** Confetti bits around screen origin (`ox`, `oy`), offsets scaled by `scale`. */
export function paintConfetti(ctx: JuiceCtx, bits: readonly ConfettiBit[], ox: number, oy: number, scale: number): void {
  for (const b of bits) {
    const s = b.size * scale;
    ctx.save();
    ctx.globalAlpha = b.alpha;
    ctx.fillStyle = b.color;
    ctx.translate(ox + b.dx * scale, oy + b.dy * scale);
    ctx.rotate(b.rot);
    ctx.fillRect(-s / 2, -s / 4, s, s / 2);
    ctx.restore();
  }
}

/**
 * Cab View anchor: effects burst from the lower centre (where your forks are), and the ring is a
 * floor-perspective ellipse whose radius tracks the viewport. `ringPx` is pixels per ring tile.
 */
export function cabJuiceAnchor(w: number, h: number): { x: number; y: number; ringPx: number; squash: number; scale: number } {
  const m = Math.min(w, h);
  return { x: w / 2, y: h * 0.62, ringPx: m * 0.16, squash: 0.35, scale: Math.max(1, Math.min(2.2, m / 420)) };
}

/** Cab View ring pulse: a floor ellipse around the anchor. */
export function paintCabRing(ctx: JuiceCtx, w: number, h: number, f: { radius: number; alpha: number; width: number }, color: string): void {
  const a = cabJuiceAnchor(w, h);
  const rx = f.radius * a.ringPx;
  ctx.save();
  ctx.globalAlpha = f.alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = f.width * a.scale;
  ctx.beginPath();
  ctx.ellipse(a.x, a.y, rx, rx * a.squash, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}
