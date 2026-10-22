/**
 * Multi-pointer canvas gestures (pure, unit-tested): pinch zoom + two-finger pan, and a small
 * pointer registry so a second finger never clobbers the first finger's drag.
 */
import { zoomAt, type Camera } from './iso.js';

export interface Pt {
  x: number;
  y: number;
}

const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * One pinch step: zoom by the change in finger distance about the previous midpoint, then pan
 * by how far the midpoint moved. Points are canvas-local CSS pixels.
 */
export function pinchStep(cam: Camera, prev: readonly [Pt, Pt], next: readonly [Pt, Pt]): Camera {
  const d0 = dist(prev[0], prev[1]);
  const d1 = dist(next[0], next[1]);
  const m0 = mid(prev[0], prev[1]);
  const m1 = mid(next[0], next[1]);
  const k = d0 > 1 && d1 > 1 ? d1 / d0 : 1;
  const z = zoomAt(cam, m0.x, m0.y, k);
  return { x: z.x + (m1.x - m0.x), y: z.y + (m1.y - m0.y), zoom: z.zoom };
}

/** Active pointers on the canvas (insertion-ordered), in canvas-local coordinates. */
export class PointerSet {
  private readonly pts = new Map<number, Pt>();

  get size(): number {
    return this.pts.size;
  }

  has(id: number): boolean {
    return this.pts.has(id);
  }

  set(id: number, p: Pt): void {
    this.pts.set(id, { x: p.x, y: p.y });
  }

  delete(id: number): void {
    this.pts.delete(id);
  }

  clear(): void {
    this.pts.clear();
  }

  /** The first two pointers (the pinch pair), or null with fewer than two. */
  pair(): [Pt, Pt] | null {
    if (this.pts.size < 2) return null;
    const it = this.pts.values();
    const a = it.next().value as Pt;
    const b = it.next().value as Pt;
    return [{ ...a }, { ...b }];
  }

  /** Any remaining pointer (id + position), e.g. to resume a one-finger drag after a pinch. */
  first(): { id: number; p: Pt } | null {
    for (const [id, p] of this.pts) return { id, p: { ...p } };
    return null;
  }
}
