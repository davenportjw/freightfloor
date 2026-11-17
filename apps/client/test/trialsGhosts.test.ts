import { describe, expect, it } from 'vitest';
import { createTrial, trialLevel, trialRev, type GhostRun } from '@warehouse/sim';
import type { TrialGhostsResponse } from '@warehouse/protocol';
import { drive, runOf } from '../../../packages/sim/test/trialDriver.js';
import {
  CLIENT_ID_KEY,
  GHOST_MODE_KEY,
  GHOST_STORE_KEY,
  fetchTrialGhosts,
  loadGhostMode,
  localBest,
  pickGhosts,
  saveLocalBest,
  submitTrialRun,
  trialClientId,
} from '../src/trials/ghosts.js';

function memStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

function genuine(levelId: string, boost = false): GhostRun {
  const tr = createTrial(levelId);
  const rec = drive(tr, { boost });
  expect(tr.state.status).toBe('won');
  return runOf(tr, rec);
}

const slow = genuine('rush-hour');
const fast = genuine('rush-hour', true);
const level = trialLevel('rush-hour')!;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('Floor Trials ghosts: local best', () => {
  it('keeps only the fastest run for the current rules revision', () => {
    const s = memStorage({ 'ff.trials.v1': '{"rush-hour":{"stars":2,"time":80}}' });
    expect(localBest(s, level)).toBeNull();
    expect(saveLocalBest(s, level, slow)).toBe(true);
    expect(localBest(s, level)).toMatchObject({ time: slow.time, submitted: false, rev: trialRev(level) });
    expect(saveLocalBest(s, level, slow)).toBe(false);
    expect(saveLocalBest(s, level, fast)).toBe(true);
    expect(saveLocalBest(s, level, slow)).toBe(false);
    expect(localBest(s, level)?.time).toBe(fast.time);
    // The progress key is untouched (ff.trials.v1 stays compatible).
    expect(s.m.get('ff.trials.v1')).toBe('{"rush-hour":{"stars":2,"time":80}}');
    // A stale revision is ignored and replaced.
    expect(localBest(s, { ...level, rev: trialRev(level) + 1 })).toBeNull();
    expect(saveLocalBest(s, { ...level, rev: trialRev(level) + 1 }, { ...slow, rev: trialRev(level) + 1 })).toBe(true);
  });

  it('survives corrupt storage and defaults the selector to World #1', () => {
    const s = memStorage({ [GHOST_STORE_KEY]: '{not json', [GHOST_MODE_KEY]: 'bogus' });
    expect(localBest(s, level)).toBeNull();
    expect(loadGhostMode(s)).toBe('world');
    expect(loadGhostMode(memStorage({ [GHOST_MODE_KEY]: 'off' }))).toBe('off');
    expect(loadGhostMode(null)).toBe('world');
  });

  it('reuses (or mints) the live game clientId', () => {
    expect(trialClientId(memStorage({ [CLIENT_ID_KEY]: 'abc-123' }))).toBe('abc-123');
    const s = memStorage();
    const id = trialClientId(s);
    expect(id).toMatch(/[0-9a-f-]{36}/);
    expect(s.m.get(CLIENT_ID_KEY)).toBe(id);
  });
});

describe('Floor Trials ghosts: slot selection', () => {
  const board = (top: GhostRun[], next: GhostRun | null): TrialGhostsResponse => ({
    levelId: 'rush-hour',
    rev: 1,
    total: top.length,
    top: top.map((r, i) => ({ rank: i + 1, publicId: `p1_${'a'.repeat(22)}`, name: `p${i}`, time: r.time, stars: r.stars, strikes: r.strikes, track: r.track })),
    next: next ? { rank: 1, publicId: `p1_${'b'.repeat(22)}`, name: 'nx', time: next.time, stars: next.stars, strikes: next.strikes, track: next.track } : null,
  });
  const mine = (r: GhostRun) => ({ rev: r.rev, time: r.time, stars: r.stars, strikes: r.strikes, track: r.track, submitted: true });

  it('orders World #1, Next to beat, My best and drops duplicates', () => {
    const shown = pickGhosts(board([fast, slow], fast), mine(slow));
    expect(shown.map((g) => [g.slot, g.name])).toEqual([
      ['world', 'p0'],
      ['mine', 'You'],
    ]);
    expect(shown[0].track.x.length).toBe(Math.round(fast.time * 10) + 1);
  });

  it('labels your own shared run "You" instead of drawing it twice', () => {
    expect(pickGhosts(board([slow], null), mine(slow)).map((g) => [g.slot, g.name])).toEqual([['world', 'You']]);
  });

  it('still shows My best when the lobby is unreachable (board null)', () => {
    expect(pickGhosts(null, mine(slow)).map((g) => g.slot)).toEqual(['mine']);
    expect(pickGhosts(null, null)).toEqual([]);
  });

  it('skips undecodable tracks instead of inventing a ghost', () => {
    const b = board([fast], null);
    b.top[0].track = 'AAAA';
    expect(pickGhosts(b, null)).toEqual([]);
  });
});

describe('Floor Trials ghosts: lobby calls', () => {
  it('passes the caller best time and validates the reply', async () => {
    const urls: string[] = [];
    const ok = await fetchTrialGhosts(async (url) => {
      urls.push(url);
      return jsonResponse(200, { levelId: 'rush-hour', rev: 1, total: 0, top: [], next: null });
    }, 'rush-hour', 41.25);
    expect(ok).toMatchObject({ ok: true, data: { total: 0 } });
    expect(urls[0]).toBe('/api/trials/rush-hour/ghosts?time=41.3');
    const err = await fetchTrialGhosts(async () => jsonResponse(503, { error: 'ghosts_unavailable', message: 'Shared ghosts are unavailable right now.' }), 'rush-hour', null);
    expect(err).toEqual({ ok: false, error: 'Shared ghosts are unavailable right now.' });
    const offline = await fetchTrialGhosts(async () => {
      throw new TypeError('Failed to fetch');
    }, 'rush-hour', null);
    expect(offline).toEqual({ ok: false, error: 'Failed to fetch' });
  });

  it('submits the run without the levelId in the body', async () => {
    let sent: { url: string; body: Record<string, unknown> } | null = null;
    const res = await submitTrialRun(async (url, init) => {
      sent = { url, body: JSON.parse(String(init?.body)) };
      return jsonResponse(200, { ok: true, improved: true, best: { time: slow.time, stars: slow.stars }, rank: 1, total: 1 });
    }, 'client-1', slow);
    expect(res).toMatchObject({ ok: true, data: { rank: 1 } });
    expect(sent!.url).toBe('/api/trials/rush-hour/runs');
    expect(Object.keys(sent!.body).sort()).toEqual(['clientId', 'rev', 'stars', 'strikes', 'time', 'track']);
  });
});

describe('trials ghost trail drawing', () => {
  it('starts the bright segment at the interpolated ghost position and keeps a fixed sample parity', async () => {
    const { drawGhostTrail } = await import('../src/trials/ghosts.js');
    const { sampleGhost } = await import('@warehouse/sim');
    const n = 80;
    const xs = Array.from({ length: n }, (_, i) => i * 0.2);
    const ys = Array.from({ length: n }, (_, i) => Math.sin(i / 5));
    const track = { x: xs, y: ys, a: xs.map(() => 0), fork: xs.map(() => 0), sway: xs.map(() => 0), stack: xs.map(() => 0), events: [] };
    const ghost = { slot: 'world', name: 'W', time: 8, track, key: 'k' } as unknown as Parameters<typeof drawGhostTrail>[1];
    const paths = (t: number) => {
      const out: Array<Array<[number, number]>> = [];
      const ctx = {
        save() {}, restore() {}, setLineDash() {}, stroke() {},
        beginPath() { out.push([]); },
        moveTo(x: number, y: number) { out[out.length - 1]!.push([x, y]); },
        lineTo(x: number, y: number) { out[out.length - 1]!.push([x, y]); },
        globalAlpha: 1, lineCap: '', lineJoin: '', strokeStyle: '', lineWidth: 1,
      };
      const pt = { ctx, cam: { zoom: 1 }, P: (x: number, y: number) => [x, y], circleGrid: () => [], poly() {} };
      drawGhostTrail(pt as unknown as Parameters<typeof drawGhostTrail>[0], ghost, t);
      return out;
    };
    for (const t of [1.0, 1.03, 1.05, 1.08, 1.1]) {
      const bright = paths(t)[1]!;
      const g = sampleGhost(track as never, t);
      expect(bright[0]![0]).toBeCloseTo(g.x, 9);
      expect(bright[0]![1]).toBeCloseTo(g.y, 9);
      // interior vertices are the even-indexed samples only
      for (const [x] of bright.slice(1, -1)) expect(Math.round(x / 0.2) % 2).toBe(0);
    }
  });
});
