import { afterEach, describe, expect, it } from 'vitest';
import { LEAGUE_BOARD_SIZE, LeagueResponseSchema, weekEndMs, weekKey } from '@warehouse/protocol';
import {
  buildLobbyServer,
  FirestoreLobbyStore,
  InMemoryLobbyStore,
  LEAGUE_BOARD_CACHE_TTL_MS,
  type StoredLeagueEntry,
} from '../src/index.js';

const TEST_SECRET = 'test-hmac-secret-key-for-warehouse-lobby-2026';
// Thursday of ISO week 2026-W46; the previous week is 2026-W45.
const NOW = Date.UTC(2026, 10, 12, 15, 0, 0);
const WEEK = weekKey(NOW);
const PREV = '2026-W45';

const pid = (n: number) => `p1_${String(n).padStart(22, 'a')}`;
const entry = (n: number, weekPts: number, extra: Partial<StoredLeagueEntry> = {}): StoredLeagueEntry => ({
  publicId: pid(n),
  name: `Driver ${n}`,
  weekPts,
  runs: 3,
  runsCounted: 3,
  siteId: 'site-den-1',
  ...extra,
});

let apps: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

async function build(store: InMemoryLobbyStore | FirestoreLobbyStore, clock: { t: number } = { t: NOW }) {
  const app = await buildLobbyServer({ store, ticketSecret: TEST_SECRET, gaMeasurementId: null, now: () => clock.t });
  apps.push(app);
  return app;
}

const getLeague = async (app: Awaited<ReturnType<typeof build>>, qs = '') => {
  const res = await app.inject({ method: 'GET', url: `/api/league${qs}` });
  return { res, body: res.statusCode === 200 ? LeagueResponseSchema.parse(res.json()) : undefined };
};

describe('@warehouse/lobby: GET /api/league', () => {
  it('returns the current week, a sorted top-20 board, entrants, endsAt, and no-store caching', async () => {
    const store = new InMemoryLobbyStore([]);
    for (let i = 0; i < 25; i++) store.setLeagueEntry(WEEK, `client-${i}`, entry(i, 100 + i * 10));
    const app = await build(store);
    const { res, body } = await getLeague(app);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(body!.weekKey).toBe('2026-W46');
    expect(body!.endsAt).toBe(weekEndMs('2026-W46'));
    expect(body!.entrants).toBe(25);
    expect(body!.top).toHaveLength(LEAGUE_BOARD_SIZE);
    expect(body!.top[0]).toEqual({ publicId: pid(24), name: 'Driver 24', weekPts: 340, runs: 3, siteId: 'site-den-1' });
    expect(body!.finalized).toBe(false);
    expect(body!.podium).toBeUndefined();
  });

  it('ranks `you` by publicId (ties share a rank) and reports runs counted', async () => {
    const store = new InMemoryLobbyStore([]);
    store.setLeagueEntry(WEEK, 'c-a', entry(1, 500));
    store.setLeagueEntry(WEEK, 'c-b', entry(2, 300, { runsCounted: 10, runs: 14 }));
    store.setLeagueEntry(WEEK, 'c-c', entry(3, 300));
    const app = await build(store);
    expect((await getLeague(app, `?publicId=${pid(2)}`)).body!.you).toEqual({ rank: 2, weekPts: 300, runsCounted: 10 });
    expect((await getLeague(app, `?publicId=${pid(3)}`)).body!.you?.rank).toBe(2);
    expect((await getLeague(app, `?publicId=${pid(99)}`)).body!.you).toBeUndefined();
  });

  it('rejects malformed, nonexistent and future weeks and raw client ids', async () => {
    const app = await build(new InMemoryLobbyStore([]));
    for (const qs of ['?week=2026-46', '?week=2026-W60', '?week=2025-W53', '?week=2026-W47', '?week=next', '?publicId=raw-client-id']) {
      const { res } = await getLeague(app, qs);
      expect(res.statusCode, qs).toBe(400);
      expect(res.json().error).toBe('invalid_request');
    }
  });

  it('keeps reserved bot names off the board and the podium', async () => {
    const store = new InMemoryLobbyStore([]);
    store.setLeagueEntry(PREV, 'bot', entry(1, 9_999, { name: 'loadtest-007' }));
    store.setLeagueEntry(PREV, 'c-a', entry(2, 400));
    const app = await build(store);
    const { body } = await getLeague(app, '?week=previous');
    expect(body!.top.map((r) => r.publicId)).toEqual([pid(2)]);
    expect(body!.podium?.map((p) => p.publicId)).toEqual([pid(2)]);
  });

  it('finalizes last week lazily on the first read: podium, champion leagueWins, best ranks', async () => {
    const store = new InMemoryLobbyStore([], [{ clientId: 'c-b', name: 'Driver 2', deliveries: 5, bestLeagueRank: 1, leagueWins: 2 }]);
    store.setLeagueEntry(PREV, 'c-a', entry(1, 900));
    store.setLeagueEntry(PREV, 'c-b', entry(2, 700));
    store.setLeagueEntry(PREV, 'c-c', entry(3, 500));
    store.setLeagueEntry(PREV, 'c-d', entry(4, 100));
    const app = await build(store);
    // Any read in the new week (here: the current board) closes the previous week.
    const cur = await getLeague(app);
    expect(cur.body!.finalized).toBe(false);
    expect(store.leagueFinalizations).toBe(1);
    const { body } = await getLeague(app, '?week=previous');
    expect(body!.weekKey).toBe(PREV);
    expect(body!.finalized).toBe(true);
    expect(body!.podium).toEqual([
      { rank: 1, publicId: pid(1), name: 'Driver 1', weekPts: 900 },
      { rank: 2, publicId: pid(2), name: 'Driver 2', weekPts: 700 },
      { rank: 3, publicId: pid(3), name: 'Driver 3', weekPts: 500 },
    ]);
    expect(store.getPlayer('c-a')).toMatchObject({ leagueWins: 1, bestLeagueRank: 1 });
    // A better earlier finish is kept; wins are only added for first place.
    expect(store.getPlayer('c-b')).toMatchObject({ leagueWins: 2, bestLeagueRank: 1 });
    expect(store.getPlayer('c-c')).toMatchObject({ bestLeagueRank: 3 });
    expect(store.getPlayer('c-c')?.leagueWins).toBeUndefined();
    expect(store.getPlayer('c-d')).toBeUndefined();
    expect(store.leagueFinalizations).toBe(1);
  });

  it('finalizes exactly once under concurrent reads across two lobby instances', async () => {
    const store = new InMemoryLobbyStore([]);
    store.setLeagueEntry(PREV, 'c-a', entry(1, 900));
    const [a, b] = [await build(store), await build(store)];
    await Promise.all([getLeague(a), getLeague(b), getLeague(a, '?week=previous'), getLeague(b, '?week=previous')]);
    expect(store.leagueFinalizations).toBe(1);
    expect(store.getPlayer('c-a')).toMatchObject({ leagueWins: 1, bestLeagueRank: 1 });
  });

  it('never finalizes the current week and serves explicit past weeks', async () => {
    const store = new InMemoryLobbyStore([]);
    store.setLeagueEntry(WEEK, 'c-a', entry(1, 900));
    store.setLeagueEntry('2026-W40', 'c-b', entry(2, 300));
    const app = await build(store);
    expect((await getLeague(app)).body!.finalized).toBe(false);
    const old = await getLeague(app, '?week=2026-W40');
    expect(old.body!.finalized).toBe(true);
    expect(old.body!.podium?.[0].publicId).toBe(pid(2));
    expect(store.getPlayer('c-a')).toBeUndefined();
  });

  it('never leaks raw client ids or entry doc ids', async () => {
    const store = new InMemoryLobbyStore([]);
    store.setLeagueEntry(PREV, 'secret-client-id-123', entry(7, 420));
    store.setLeagueEntry(WEEK, 'secret-client-id-456', entry(8, 120));
    const app = await build(store);
    for (const qs of ['', '?week=previous', `?publicId=${pid(8)}`]) {
      const res = await app.inject({ method: 'GET', url: `/api/league${qs}` });
      expect(res.body).not.toContain('secret-client-id');
    }
  });

  it('surfaces store failures as 503 and does not cache them', async () => {
    const store = new InMemoryLobbyStore([]);
    store.setLeagueEntry(WEEK, 'c-a', entry(1, 300));
    const real = store.getLeagueBoard.bind(store);
    let fail = true;
    store.getLeagueBoard = async (w, l) => {
      if (fail) throw new Error('UNAVAILABLE');
      return real(w, l);
    };
    const app = await build(store);
    const bad = await getLeague(app);
    expect(bad.res.statusCode).toBe(503);
    expect(bad.res.json().error).toBe('league_unavailable');
    fail = false;
    expect((await getLeague(app)).body!.top).toHaveLength(1);
  });

  it('caches the board per week for the TTL, then refreshes', async () => {
    const store = new InMemoryLobbyStore([]);
    store.setLeagueEntry(WEEK, 'c-a', entry(1, 300));
    const clock = { t: NOW };
    const app = await build(store, clock);
    expect((await getLeague(app)).body!.entrants).toBe(1);
    store.setLeagueEntry(WEEK, 'c-b', entry(2, 200));
    expect((await getLeague(app)).body!.entrants).toBe(1);
    clock.t += LEAGUE_BOARD_CACHE_TTL_MS + 1;
    expect((await getLeague(app)).body!.entrants).toBe(2);
  });

  it('a failed finalization is logged, retried on the next read, and does not fail the board', async () => {
    const store = new InMemoryLobbyStore([]);
    store.setLeagueEntry(PREV, 'c-a', entry(1, 900));
    const real = store.finalizeLeagueWeek.bind(store);
    let fail = true;
    store.finalizeLeagueWeek = async (w, n) => {
      if (fail) throw new Error('ABORTED');
      return real(w, n);
    };
    const app = await build(store);
    expect((await getLeague(app)).res.statusCode).toBe(200);
    expect(store.leagueFinalizations).toBe(0);
    fail = false;
    await getLeague(app);
    expect(store.leagueFinalizations).toBe(1);
  });

  it('answers 503 when the store has no league support', async () => {
    const store = new InMemoryLobbyStore([]);
    (store as { getLeagueBoard?: unknown }).getLeagueBoard = undefined;
    const app = await build(store);
    const { res } = await getLeague(app);
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('league_unavailable');
  });
});

// ---------------------------------------------------------------------------
// Path-based Firestore double: nested collections, orderBy/limit/where queries, count(), and
// optimistic transactions (a transaction whose read set changed before commit is retried).
// Every read yields to the event loop so concurrent finalizers genuinely interleave.
// ---------------------------------------------------------------------------

type Data = Record<string, unknown>;
const tick = () => new Promise<void>((r) => setImmediate(r));

class PathFirestore {
  readonly docs = new Map<string, { version: number; data: Data }>();
  private clock = 0;
  commits = 0;
  retries = 0;
  collection(path: string) {
    return new PathQuery(this, path);
  }
  write(path: string, data: Data, merge: boolean) {
    const prev = this.docs.get(path);
    this.docs.set(path, { version: ++this.clock, data: merge && prev ? { ...prev.data, ...data } : { ...data } });
  }
  snap(path: string) {
    const rec = this.docs.get(path);
    return { exists: Boolean(rec), id: path.split('/').pop()!, data: () => (rec ? { ...rec.data } : undefined) };
  }
  async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const reads = new Map<string, number>();
      const colSigs = new Map<string, string>();
      const writes: Array<() => void> = [];
      const tx = {
        get: async (ref: PathDoc | PathQuery) => {
          await tick();
          if (ref instanceof PathDoc) {
            reads.set(ref.path, this.docs.get(ref.path)?.version ?? 0);
            return this.snap(ref.path);
          }
          colSigs.set(ref.path, ref.memberSig());
          const out = ref.run();
          for (const d of out.docs) reads.set(`${ref.path}/${d.id}`, this.docs.get(`${ref.path}/${d.id}`)?.version ?? 0);
          return out;
        },
        set: (ref: PathDoc, data: Data, opts?: { merge?: boolean }) => {
          writes.push(() => this.write(ref.path, data, Boolean(opts?.merge)));
        },
      };
      const result = await fn(tx);
      const stale =
        [...reads].some(([p, v]) => (this.docs.get(p)?.version ?? 0) !== v) ||
        [...colSigs].some(([p, sig]) => new PathQuery(this, p).memberSig() !== sig);
      if (stale) {
        this.retries += 1;
        continue;
      }
      for (const w of writes) w();
      this.commits += 1;
      return result;
    }
    throw new Error('10 ABORTED: too much contention');
  }
}

class PathDoc {
  constructor(readonly db: PathFirestore, readonly path: string) {}
  collection(name: string) {
    return new PathQuery(this.db, `${this.path}/${name}`);
  }
  async get() {
    await tick();
    return this.db.snap(this.path);
  }
  async set(data: Data, opts?: { merge?: boolean }) {
    this.db.write(this.path, data, Boolean(opts?.merge));
  }
}

class PathQuery {
  constructor(
    readonly db: PathFirestore,
    readonly path: string,
    private readonly filters: Array<(d: Data) => boolean> = [],
    private readonly order?: string,
    private readonly max?: number,
  ) {}
  doc(id: string) {
    return new PathDoc(this.db, `${this.path}/${id}`);
  }
  where(field: string, op: '==' | '>', value: unknown) {
    const f = op === '==' ? (d: Data) => d[field] === value : (d: Data) => (d[field] as number) > (value as number);
    return new PathQuery(this.db, this.path, [...this.filters, f], this.order, this.max);
  }
  orderBy(field: string, _dir: 'desc') {
    return new PathQuery(this.db, this.path, this.filters, field, this.max);
  }
  limit(n: number) {
    return new PathQuery(this.db, this.path, this.filters, this.order, n);
  }
  private rows() {
    const prefix = `${this.path}/`;
    return [...this.db.docs.entries()]
      .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .map(([p, r]) => ({ id: p.slice(prefix.length), data: r.data }))
      .filter((r) => this.filters.every((f) => f(r.data)));
  }
  memberSig() {
    return this.rows().map((r) => r.id).sort().join('|');
  }
  run() {
    let rows = this.rows();
    if (this.order) rows = rows.sort((a, b) => (b.data[this.order!] as number) - (a.data[this.order!] as number));
    if (this.max !== undefined) rows = rows.slice(0, this.max);
    const docs = rows.map((r) => ({ id: r.id, data: () => ({ ...r.data }) }));
    return { empty: docs.length === 0, size: docs.length, docs, forEach: (cb: (d: (typeof docs)[number]) => void) => docs.forEach(cb) };
  }
  async get() {
    await tick();
    return this.run();
  }
  count() {
    return { get: async () => ({ data: () => ({ count: this.rows().length }) }) };
  }
}

describe('FirestoreLobbyStore weekly league', () => {
  const seed = (db: PathFirestore, week: string, clientId: string, n: number, weekPts: number) =>
    db.write(`league/${week}/entries/${clientId}`, { weekKey: week, publicId: pid(n), name: `Driver ${n}`, weekPts, topRuns: [weekPts], runs: 2, siteId: 'den-1' }, false);

  it('finalizes a week exactly once under concurrent finalizers on two instances', async () => {
    const db = new PathFirestore();
    db.write('players/c-a', { clientId: 'c-a', name: 'Driver 1', deliveries: 4, leagueWins: 1 }, false);
    seed(db, PREV, 'c-a', 1, 900);
    seed(db, PREV, 'c-b', 2, 600);
    seed(db, PREV, 'c-c', 3, 300);
    seed(db, PREV, 'c-d', 4, 100);
    const a = new FirestoreLobbyStore(db as never, {});
    const b = new FirestoreLobbyStore(db as never, {});
    const results = await Promise.all([a.finalizeLeagueWeek(PREV, NOW), b.finalizeLeagueWeek(PREV, NOW), a.finalizeLeagueWeek(PREV, NOW)]);
    for (const podium of results) expect(podium.map((p) => p.publicId)).toEqual([pid(1), pid(2), pid(3)]);
    expect(db.snap('players/c-a').data()).toMatchObject({ leagueWins: 2, bestLeagueRank: 1, deliveries: 4 });
    expect(db.snap('players/c-b').data()).toMatchObject({ bestLeagueRank: 2 });
    expect(db.snap('players/c-c').data()).toMatchObject({ bestLeagueRank: 3 });
    expect(db.snap('players/c-d').exists).toBe(false);
    expect(db.snap(`league/${PREV}`).data()).toMatchObject({ weekKey: PREV, finalized: true, finalizedAt: NOW });
    // Re-running after commit is a no-op.
    await a.finalizeLeagueWeek(PREV, NOW + 1);
    expect(db.snap('players/c-a').data()?.leagueWins).toBe(2);
  });

  it('serves the board, standing and podium through /api/league without leaking doc ids', async () => {
    const db = new PathFirestore();
    seed(db, PREV, 'secret-cid-1', 1, 900);
    seed(db, WEEK, 'secret-cid-2', 2, 400);
    seed(db, WEEK, 'secret-cid-3', 3, 250);
    const app = await build(new FirestoreLobbyStore(db as never, {}));
    const cur = await app.inject({ method: 'GET', url: `/api/league?publicId=${pid(3)}` });
    expect(cur.statusCode).toBe(200);
    const body = LeagueResponseSchema.parse(cur.json());
    expect(body.top.map((r) => r.weekPts)).toEqual([400, 250]);
    expect(body.you).toEqual({ rank: 2, weekPts: 250, runsCounted: 1 });
    expect(cur.body).not.toContain('secret-cid');
    const prev = await app.inject({ method: 'GET', url: '/api/league?week=previous' });
    expect(LeagueResponseSchema.parse(prev.json()).podium).toEqual([{ rank: 1, publicId: pid(1), name: 'Driver 1', weekPts: 900 }]);
    expect(prev.body).not.toContain('secret-cid');
  });
});
