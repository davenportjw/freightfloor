import { describe, expect, it } from 'vitest';
import { ArmorGuard, MUTE_DURATION_MS, RATE_WINDOW_MS, STRIKE_WINDOW_MS } from '../src/index.js';

describe('ArmorGuard TTL eviction (bounded per-client / per-IP maps)', () => {
  it('evicts request histories once their sliding window has passed', () => {
    const guard = new ArmorGuard();
    const t0 = 1_000_000;
    for (let i = 0; i < 500; i++) {
      expect(guard.consumeRequest(`client-${i}`, `10.0.${i >> 8}.${i & 255}`, t0).ok).toBe(true);
    }
    expect(guard.trackedKeyCount()).toBe(1000);

    // One request after the window elapses triggers an opportunistic sweep.
    guard.consumeRequest('late-client', '10.9.9.9', t0 + RATE_WINDOW_MS + 1);
    expect(guard.trackedKeyCount()).toBe(2);
  });

  it('keeps live strikes and mutes, then evicts them after the strike window and mute expire', () => {
    const guard = new ArmorGuard();
    const t0 = 5_000_000;
    guard.recordStrike('griefer', '1.2.3.4', t0);
    guard.recordStrike('griefer', '1.2.3.4', t0 + 1);
    const third = guard.recordStrike('griefer', '1.2.3.4', t0 + 2);
    expect(third.muted).toBe(true);

    // Sweeping inside the windows must not lose the mute.
    guard.sweep(t0 + RATE_WINDOW_MS + 10);
    expect(guard.isMuted('griefer', '1.2.3.4', t0 + RATE_WINDOW_MS + 10).muted).toBe(true);

    const after = t0 + Math.max(STRIKE_WINDOW_MS, MUTE_DURATION_MS) + 10;
    guard.sweep(after);
    expect(guard.trackedKeyCount()).toBe(0);
    expect(guard.isMuted('griefer', '1.2.3.4', after).muted).toBe(false);
  });
});
