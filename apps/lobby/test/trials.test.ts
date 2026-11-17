import { describe, expect, it } from 'vitest';
import { TrialGhostsResponseSchema, TrialRunSubmitResponseSchema } from '@warehouse/protocol';
import { createTrial, decodeGhost, TRIAL_LEVELS, type GhostRun } from '@warehouse/sim';
import { drive, recordGuided, runOf } from '../../../packages/sim/test/trialDriver.js';
import { buildLobbyServer, InMemoryLobbyStore, publicIdFor, TRIAL_RUN_RATE_PER_MIN, type StoredSiteDoc } from '../src/index.js';

const TEST_SECRET = 'test-hmac-secret-key-for-warehouse-lobby-2026';
const NOW = 1_700_000_000_000;

const site: StoredSiteDoc = {
  id: 'den-1',
  state: 'live',
  phase: 'running',
  drivers: 0,
  spectators: 0,
  tier: 1,
  shipped: 0,
  wsUrl: 'wss://den-1.warehouse.example/ws',
  updatedAt: NOW - 2_000,
};

/** A genuine clear of `levelId`, driven through the real trial sim and recorded like the client does. */
function genuineRun(levelId: string, boost = false): GhostRun {
  const tr = createTrial(levelId);
  const rec = drive(tr, { boost });
  expect(tr.state.status).toBe('won');
  return runOf(tr, rec);
}

const slow = genuineRun('rush-hour');
const fast = genuineRun('rush-hour', true);

async function makeApp(store = new InMemoryLobbyStore([site])) {
  const app = await buildLobbyServer({ store, ticketSecret: TEST_SECRET, now: () => NOW });
  return { app, store };
}

function submit(app: Awaited<ReturnType<typeof makeApp>>['app'], clientId: string, run: GhostRun, ip = '10.0.0.1') {
  const { levelId, ...rest } = run;
  return app.inject({
    method: 'POST',
    url: `/api/trials/${levelId}/runs`,
    payload: { clientId, ...rest },
    remoteAddress: ip,
  });
}

describe('Floor Trials shared ghosts API', () => {
  it('stores a genuine run and serves it back as the world #1 ghost (no raw clientId)', async () => {
    expect(fast.time).toBeLessThan(slow.time);
    const store = new InMemoryLobbyStore([site], [{ clientId: 'client-ace', name: 'ace', deliveries: 0 }]);
    const { app } = await makeApp(store);
    const res = await submit(app, 'client-ace', slow);
    expect(res.statusCode).toBe(200);
    const body = TrialRunSubmitResponseSchema.parse(res.json());
    expect(body).toMatchObject({ ok: true, improved: true, rank: 1, total: 1, best: { time: slow.time, stars: slow.stars } });

    const ghosts = await app.inject({ method: 'GET', url: '/api/trials/rush-hour/ghosts' });
    expect(ghosts.statusCode).toBe(200);
    const g = TrialGhostsResponseSchema.parse(ghosts.json());
    expect(g).toMatchObject({ levelId: 'rush-hour', rev: slow.rev, total: 1, next: null });
    expect(g.top).toHaveLength(1);
    expect(g.top[0]).toMatchObject({ rank: 1, name: 'ace', time: slow.time, publicId: publicIdFor('client-ace', TEST_SECRET) });
    expect(decodeGhost(g.top[0].track).x.length).toBe(Math.round(slow.time * 10) + 1);
    expect(ghosts.body).not.toContain('client-ace');
    await app.close();
  });

  it('keeps only each player best and returns the run just faster than ?time', async () => {
    const { app } = await makeApp();
    // Player A posts the slow run, player B the fast one.
    expect((await submit(app, 'client-a', slow)).statusCode).toBe(200);
    expect((await submit(app, 'client-b', fast)).statusCode).toBe(200);
    // A re-posts the slow run: not an improvement.
    const again = TrialRunSubmitResponseSchema.parse((await submit(app, 'client-a', slow)).json());
    expect(again).toMatchObject({ improved: false, rank: 2 });
    // A improves with the fast run.
    const better = TrialRunSubmitResponseSchema.parse((await submit(app, 'client-a', fast)).json());
    expect(better.improved).toBe(true);
    expect(better.best.time).toBe(fast.time);

    const store2 = await makeApp();
    await submit(store2.app, 'client-a', slow);
    await submit(store2.app, 'client-b', fast);
    const res = TrialGhostsResponseSchema.parse(
      (await store2.app.inject({ method: 'GET', url: `/api/trials/rush-hour/ghosts?time=${slow.time}` })).json(),
    );
    expect(res.total).toBe(2);
    expect(res.top.map((r) => r.time)).toEqual([fast.time, slow.time]);
    expect(res.next).toMatchObject({ rank: 1, time: fast.time, publicId: publicIdFor('client-b', TEST_SECRET) });
    // Generated callsign for players without a stored name.
    expect(res.next?.name).toMatch(/\S/);
    // The leader has nobody to chase.
    const lead = TrialGhostsResponseSchema.parse(
      (await store2.app.inject({ method: 'GET', url: `/api/trials/rush-hour/ghosts?time=${fast.time}` })).json(),
    );
    expect(lead.next).toBeNull();
    await app.close();
    await store2.app.close();
  });

  it('rejects implausible, malformed, oversized and unknown-level runs', async () => {
    const { app } = await makeApp();
    const doctored = await submit(app, 'client-x', { ...slow, time: Math.round(slow.time * 4) / 10 });
    expect(doctored.statusCode).toBe(422);
    expect(doctored.json()).toMatchObject({ error: 'implausible_run' });

    const stale = await submit(app, 'client-x', { ...slow, rev: slow.rev + 1 });
    expect(stale.statusCode).toBe(422);
    expect(stale.json()).toMatchObject({ reason: 'stale_rev' });

    const bad = await app.inject({ method: 'POST', url: '/api/trials/rush-hour/runs', payload: { clientId: 'c', track: 1 } });
    expect(bad.statusCode).toBe(400);

    const extra = await app.inject({
      method: 'POST',
      url: '/api/trials/rush-hour/runs',
      payload: { clientId: 'c', rev: slow.rev, time: slow.time, stars: slow.stars, strikes: slow.strikes, track: slow.track, name: 'spoof' },
    });
    expect(extra.statusCode).toBe(400);

    const huge = await app.inject({
      method: 'POST',
      url: '/api/trials/rush-hour/runs',
      payload: { clientId: 'c', rev: 1, time: 10, stars: 1, strikes: 0, track: 'A'.repeat(70_000) },
    });
    expect(huge.statusCode).toBe(413);

    expect((await submit(app, 'client-x', { ...slow, levelId: 'no-such-level' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/trials/no-such-level/ghosts' })).statusCode).toBe(404);

    const empty = TrialGhostsResponseSchema.parse((await app.inject({ method: 'GET', url: '/api/trials/first-lift/ghosts' })).json());
    expect(empty).toMatchObject({ total: 0, top: [], next: null });
    await app.close();
  });

  it('rate-limits submits per IP and refuses crawlers', async () => {
    const { app } = await makeApp();
    const crawler = await app.inject({
      method: 'POST',
      url: '/api/trials/rush-hour/runs',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
      payload: { clientId: 'c' },
    });
    expect(crawler.statusCode).toBe(403);
    const codes: number[] = [];
    for (let i = 0; i < TRIAL_RUN_RATE_PER_MIN + 1; i++) codes.push((await submit(app, `client-${i}`, slow, '10.9.9.9')).statusCode);
    expect(codes.slice(0, TRIAL_RUN_RATE_PER_MIN).every((c) => c === 200)).toBe(true);
    expect(codes.at(-1)).toBe(429);
    await app.close();
  });

  it('accepts genuine Challenge clears (putaway stows, dock windows, chargers, traffic)', async () => {
    const { app } = await makeApp();
    for (const id of ['putaway', 'cross-dock', 'dock-windows', 'low-battery', 'traffic', 'night-shift'].filter((x) => TRIAL_LEVELS.some((l) => l.id === x))) {
      const tr = createTrial(id);
      const { rec } = recordGuided(tr);
      expect(tr.state.status).toBe('won');
      const res = await submit(app, `client-${id}`, runOf(tr, rec), `10.1.0.${id.length}`);
      expect(res.statusCode, `${id}: ${res.body}`).toBe(200);
      const g = TrialGhostsResponseSchema.parse((await app.inject({ method: 'GET', url: `/api/trials/${id}/ghosts` })).json());
      expect(g.top[0].time).toBe(tr.state.t);
    }
    await app.close();
  });

  it('reports an honest 503 when the board store fails', async () => {
    const store = new InMemoryLobbyStore([site]);
    store.trialGhosts.getTrialTop = async () => {
      throw new Error('firestore down');
    };
    const { app } = await makeApp(store);
    const res = await app.inject({ method: 'GET', url: '/api/trials/rush-hour/ghosts' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'ghosts_unavailable' });
    await app.close();
  });
});
