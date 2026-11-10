import { describe, expect, it } from 'vitest';
import { buildLobbyServer, InMemoryLobbyStore, type StoredSiteDoc } from '../src/index.js';

const TEST_SECRET = 'test-hmac-secret-key-for-warehouse-lobby-2026';
const DAY1 = Date.parse('2026-11-09T18:00:00Z');
const DAY1_LATER = Date.parse('2026-11-09T23:30:00Z');
const DAY4 = Date.parse('2026-11-12T02:00:00Z');

function liveSites(nowMs: number): StoredSiteDoc[] {
  return (['den-1', 'slc-2', 'phx-3', 'abq-4'] as const).map((id) => ({
    id,
    state: 'live',
    phase: 'running',
    drivers: 0,
    spectators: 0,
    tier: 1,
    shipped: 0,
    wsUrl: `wss://${id}.warehouse.example/ws`,
    updatedAt: nowMs - 1_000,
  }));
}

/** Lets the fire-and-forget ledger write settle before asserting. */
const settle = () => new Promise((r) => setImmediate(r));

describe('@warehouse/lobby: return-visit ledger (recordVisit)', () => {
  it('store: advances once per UTC day and counts returning days', async () => {
    const store = new InMemoryLobbyStore();
    const first = await store.recordVisit('c1', DAY1);
    expect(first).toMatchObject({ isNewDay: true, isReturn: false });
    expect((await store.recordVisit('c1', DAY1_LATER)).isNewDay).toBe(false);
    const back = await store.recordVisit('c1', DAY4);
    expect(back).toMatchObject({ isReturn: true, daysSinceLast: 3 });
    expect(store.getPlayer('c1')).toMatchObject({
      firstSeenDay: '2026-11-09',
      lastSeenDay: '2026-11-12',
      activeDays: 2,
    });
  });

  it('POST /api/join records human visits across days', async () => {
    let now = DAY1;
    const store = new InMemoryLobbyStore(liveSites(DAY4));
    const app = await buildLobbyServer({ store, ticketSecret: TEST_SECRET, now: () => now });
    const join = () =>
      app.inject({ method: 'POST', url: '/api/join', payload: { clientId: 'client-visit-1' } });

    expect((await join()).statusCode).toBe(200);
    await settle();
    expect(store.getPlayer('client-visit-1')).toMatchObject({ activeDays: 1, lastSeenDay: '2026-11-09' });

    now = DAY1_LATER;
    await join();
    await settle();
    expect(store.getPlayer('client-visit-1')?.activeDays).toBe(1);

    now = DAY4;
    await join();
    await settle();
    expect(store.getPlayer('client-visit-1')).toMatchObject({
      firstSeenDay: '2026-11-09',
      lastSeenDay: '2026-11-12',
      activeDays: 2,
    });
    await app.close();
  });

  it('POST /api/join never records a ledger for bots', async () => {
    const store = new InMemoryLobbyStore(liveSites(DAY1));
    const app = await buildLobbyServer({ store, ticketSecret: TEST_SECRET, now: () => DAY1 });
    const res = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { clientId: 'bot-visit-1', name: 'loadtest-007' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isBot).toBe(true);
    await settle();
    expect(store.getPlayer('bot-visit-1')?.activeDays).toBeUndefined();
    await app.close();
  });

  it('a failing ledger write is logged and never blocks the join', async () => {
    const store = new InMemoryLobbyStore(liveSites(DAY1));
    store.recordVisit = async () => {
      throw new Error('firestore unavailable');
    };
    const app = await buildLobbyServer({ store, ticketSecret: TEST_SECRET, now: () => DAY1 });
    const res = await app.inject({ method: 'POST', url: '/api/join', payload: { clientId: 'c-err' } });
    expect(res.statusCode).toBe(200);
    await settle();
    await app.close();
  });
});
