import { afterEach, describe, expect, it } from 'vitest';
import { DAILY_BOARD_SIZE, DailyBoardResponseSchema, dailyInfoFor, dayKey } from '@warehouse/protocol';
import {
  buildLobbyServer,
  DAILY_BOARD_CACHE_TTL_MS,
  InMemoryLobbyStore,
  type StoredDailyEntry,
} from '../src/index.js';

const TEST_SECRET = 'test-hmac-secret-key-for-warehouse-lobby-2026';
const NOW = Date.UTC(2026, 10, 12, 15, 0, 0);
const TODAY = dayKey(NOW);

const pid = (n: number) => `p1_${String(n).padStart(22, 'a')}`;
const entry = (n: number, bestPts: number, extra: Partial<StoredDailyEntry> = {}): StoredDailyEntry => ({
  publicId: pid(n),
  name: `Driver ${n}`,
  bestPts,
  attempts: 1,
  siteId: 'site-den-1',
  streak: 1,
  ...extra,
});

let apps: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

async function build(store: InMemoryLobbyStore, clock: { t: number } = { t: NOW }) {
  const app = await buildLobbyServer({ store, ticketSecret: TEST_SECRET, gaMeasurementId: null, now: () => clock.t });
  apps.push(app);
  return app;
}

describe('@warehouse/lobby: GET /api/daily', () => {
  it('returns today\'s info, a sorted top-20 board, entrant count, and no-store caching', async () => {
    const store = new InMemoryLobbyStore([]);
    for (let i = 0; i < 25; i++) store.setDailyEntry(TODAY, `client-${i}`, entry(i, 100 + i * 10));
    const app = await build(store);

    const res = await app.inject({ method: 'GET', url: '/api/daily' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = DailyBoardResponseSchema.parse(res.json());
    expect(body.info).toEqual(dailyInfoFor(TODAY));
    expect(body.entrants).toBe(25);
    expect(body.top).toHaveLength(DAILY_BOARD_SIZE);
    expect(body.top[0]).toEqual({ publicId: pid(24), name: 'Driver 24', pts: 340, streak: 1, siteId: 'site-den-1' });
    const pts = body.top.map((r) => r.pts);
    expect([...pts].sort((a, b) => b - a)).toEqual(pts);
    expect(body.you).toBeUndefined();
  });

  it('ranks `you` by publicId with ties sharing a rank', async () => {
    const store = new InMemoryLobbyStore([]);
    store.setDailyEntry(TODAY, 'c-a', entry(1, 500));
    store.setDailyEntry(TODAY, 'c-b', entry(2, 300, { attempts: 4 }));
    store.setDailyEntry(TODAY, 'c-c', entry(3, 300));
    store.setDailyEntry(TODAY, 'c-d', entry(4, 100));
    const app = await build(store);

    const b = DailyBoardResponseSchema.parse(
      (await app.inject({ method: 'GET', url: `/api/daily?publicId=${pid(2)}` })).json(),
    );
    expect(b.you).toEqual({ rank: 2, bestPts: 300, attempts: 4 });
    const c = DailyBoardResponseSchema.parse(
      (await app.inject({ method: 'GET', url: `/api/daily?publicId=${pid(3)}` })).json(),
    );
    expect(c.you?.rank).toBe(2);
    const missing = DailyBoardResponseSchema.parse(
      (await app.inject({ method: 'GET', url: `/api/daily?publicId=${pid(99)}` })).json(),
    );
    expect(missing.you).toBeUndefined();
  });

  it('serves a past day by ?date= and never leaks raw client ids', async () => {
    const store = new InMemoryLobbyStore([]);
    store.setDailyEntry('2026-11-10', 'secret-client-id-123', entry(7, 420));
    const app = await build(store);

    const res = await app.inject({ method: 'GET', url: '/api/daily?date=2026-11-10' });
    expect(res.statusCode).toBe(200);
    const body = DailyBoardResponseSchema.parse(res.json());
    expect(body.info.dayKey).toBe('2026-11-10');
    expect(body.top.map((r) => r.publicId)).toEqual([pid(7)]);
    expect(res.body).not.toContain('secret-client-id-123');
    expect(res.body).not.toContain('clientId');
  });

  it('keeps reserved bot names off the board', async () => {
    const store = new InMemoryLobbyStore([]);
    store.setDailyEntry(TODAY, 'c-1', entry(1, 900, { name: 'loadtest-007' }));
    store.setDailyEntry(TODAY, 'c-2', entry(2, 200));
    const app = await build(store);
    const body = DailyBoardResponseSchema.parse((await app.inject({ method: 'GET', url: '/api/daily' })).json());
    expect(body.top.map((r) => r.name)).toEqual(['Driver 2']);
  });

  it.each([
    ['malformed date', '/api/daily?date=2026-1-1'],
    ['impossible date', '/api/daily?date=2026-02-30'],
    ['future date', '/api/daily?date=2026-11-13'],
    ['raw client id as publicId', '/api/daily?publicId=client-123'],
  ])('rejects a %s with 400', async (_label, url) => {
    const app = await build(new InMemoryLobbyStore([]));
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');
  });

  it('surfaces store failures as 503 and does not cache them', async () => {
    const store = new InMemoryLobbyStore([]);
    store.setDailyEntry(TODAY, 'c-1', entry(1, 250));
    const real = store.getDailyBoard.bind(store);
    let fail = true;
    let calls = 0;
    store.getDailyBoard = async (day, limit) => {
      calls++;
      if (fail) throw new Error('firestore down');
      return real(day, limit);
    };
    const app = await build(store);

    const bad = await app.inject({ method: 'GET', url: '/api/daily' });
    expect(bad.statusCode).toBe(503);
    expect(bad.json().error).toBe('daily_unavailable');

    fail = false;
    const ok = await app.inject({ method: 'GET', url: '/api/daily' });
    expect(ok.statusCode).toBe(200);
    expect(calls).toBe(2);
  });

  it('caches the board per day for the TTL, then refreshes', async () => {
    const store = new InMemoryLobbyStore([]);
    store.setDailyEntry(TODAY, 'c-1', entry(1, 250));
    const real = store.getDailyBoard.bind(store);
    let calls = 0;
    store.getDailyBoard = async (day, limit) => {
      calls++;
      return real(day, limit);
    };
    const clock = { t: NOW };
    const app = await build(store, clock);

    await app.inject({ method: 'GET', url: '/api/daily' });
    store.setDailyEntry(TODAY, 'c-2', entry(2, 999));
    clock.t += DAILY_BOARD_CACHE_TTL_MS - 1;
    const cached = DailyBoardResponseSchema.parse((await app.inject({ method: 'GET', url: '/api/daily' })).json());
    expect(calls).toBe(1);
    expect(cached.entrants).toBe(1);

    clock.t += 2;
    const fresh = DailyBoardResponseSchema.parse((await app.inject({ method: 'GET', url: '/api/daily' })).json());
    expect(calls).toBe(2);
    expect(fresh.top[0].pts).toBe(999);
  });

  it('answers 503 when the store has no Daily support', async () => {
    const store = new InMemoryLobbyStore([]);
    (store as { getDailyBoard?: unknown }).getDailyBoard = undefined;
    const app = await build(store);
    const res = await app.inject({ method: 'GET', url: '/api/daily' });
    expect(res.statusCode).toBe(503);
  });
});

describe('@warehouse/lobby: /api/config daily field', () => {
  it('never caches past the UTC midnight that rolls the Daily', async () => {
    const app = await build(new InMemoryLobbyStore([]), { t: Date.UTC(2026, 10, 12, 23, 59, 0) });
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect(res.json().daily).toEqual(dailyInfoFor('2026-11-12'));
  });
});
