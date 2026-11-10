/**
 * Board livery swatches: the lobby passes a catalog livery id through on `/api/network`,
 * `/api/daily` and `/api/league` rows, and drops unknown / legacy values so they never hit the wire.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DailyBoardResponseSchema, dayKey, LeaderboardEntrySchema, LeagueResponseSchema, weekKey } from '@warehouse/protocol';
import {
  buildLobbyServer,
  InMemoryLobbyStore,
  liveryField,
  publicIdFor,
  type StoredDailyEntry,
  type StoredLeagueEntry,
  type StoredPlayerDoc,
} from '../src/index.js';

const TEST_SECRET = 'test-hmac-secret-key-for-warehouse-lobby-2026';
const NOW = Date.UTC(2026, 10, 12, 15, 0, 0);
const pid = (n: number) => `p1_${String(n).padStart(22, 'a')}`;

let apps: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});
async function build(store: InMemoryLobbyStore) {
  const app = await buildLobbyServer({ store, ticketSecret: TEST_SECRET, gaMeasurementId: null, now: () => NOW });
  apps.push(app);
  return app;
}

describe('liveryField', () => {
  it('keeps catalog ids and drops everything else', () => {
    expect(liveryField('gold_fork')).toEqual({ livery: 'gold_fork' });
    expect(liveryField('standard')).toEqual({ livery: 'standard' });
    expect(liveryField('rainbow')).toEqual({});
    expect(liveryField(3)).toEqual({});
    expect(liveryField(undefined)).toEqual({});
  });
});

describe('@warehouse/lobby: board livery swatches', () => {
  it('/api/network rows carry the player doc livery, omitting unknown or missing values', async () => {
    const players: StoredPlayerDoc[] = [
      { clientId: 'h-gold', name: 'Ada Lovelace', points: 900, deliveries: 40, livery: 'gold_fork' },
      { clientId: 'h-none', name: 'Grace Hopper', points: 500, deliveries: 2 },
      { clientId: 'h-bad', name: 'Alan Turing', points: 300, deliveries: 9, livery: 'rainbow' as StoredPlayerDoc['livery'] },
    ];
    const app = await build(new InMemoryLobbyStore([], players));
    const res = await app.inject({ method: 'GET', url: '/api/network' });
    expect(res.statusCode).toBe(200);
    const rows = res.json().leaderboard as Array<Record<string, unknown>>;
    const byId = new Map(rows.map((r) => [r.publicId as string, r]));
    expect(byId.get(publicIdFor('h-gold', TEST_SECRET))?.livery).toBe('gold_fork');
    expect(byId.get(publicIdFor('h-none', TEST_SECRET))).not.toHaveProperty('livery');
    expect(byId.get(publicIdFor('h-bad', TEST_SECRET))).not.toHaveProperty('livery');
    for (const r of rows) expect(LeaderboardEntrySchema.safeParse(r).success).toBe(true);
  });

  it('/api/daily rows carry the entry livery', async () => {
    const store = new InMemoryLobbyStore([]);
    const today = dayKey(NOW);
    const entry = (n: number, extra: Partial<StoredDailyEntry>): StoredDailyEntry => ({
      publicId: pid(n), name: `Driver ${n}`, bestPts: 100 * n, attempts: 1, siteId: 'site-den-1', streak: 1, ...extra,
    });
    store.setDailyEntry(today, 'c-1', entry(1, { livery: 'hi_vis' }));
    store.setDailyEntry(today, 'c-2', entry(2, {}));
    store.setDailyEntry(today, 'c-3', entry(3, { livery: 'rainbow' as StoredDailyEntry['livery'] }));
    const app = await build(store);
    const res = await app.inject({ method: 'GET', url: '/api/daily' });
    const body = DailyBoardResponseSchema.parse(res.json());
    const by = new Map(body.top.map((r) => [r.publicId, r]));
    expect(by.get(pid(1))?.livery).toBe('hi_vis');
    expect(by.get(pid(2))).not.toHaveProperty('livery');
    expect(by.get(pid(3))).not.toHaveProperty('livery');
  });

  it('/api/league rows carry the entry livery', async () => {
    const store = new InMemoryLobbyStore([]);
    const week = weekKey(NOW);
    const entry = (n: number, extra: Partial<StoredLeagueEntry>): StoredLeagueEntry => ({
      publicId: pid(n), name: `Driver ${n}`, weekPts: 100 * n, runs: 2, runsCounted: 2, siteId: 'site-den-1', ...extra,
    });
    store.setLeagueEntry(week, 'c-1', entry(1, { livery: 'champion' }));
    store.setLeagueEntry(week, 'c-2', entry(2, {}));
    const app = await build(store);
    const res = await app.inject({ method: 'GET', url: '/api/league' });
    const body = LeagueResponseSchema.parse(res.json());
    const by = new Map(body.top.map((r) => [r.publicId, r]));
    expect(by.get(pid(1))?.livery).toBe('champion');
    expect(by.get(pid(2))).not.toHaveProperty('livery');
  });
});
