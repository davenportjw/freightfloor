import { describe, expect, it } from 'vitest';
import type { Firestore } from '@google-cloud/firestore';
import { addDays, dayKeyToMs, DAILY_ENTRY_TTL_DAYS, dailyInfoFor } from '@warehouse/protocol';
import {
  CloudPersistenceStore,
  InMemoryPersistenceStore,
  applyDailyResult,
  dailyEntryExpireAt,
  type DailyResultInput,
  type PersistenceStore,
} from '../src/persistence.js';

/**
 * Minimal in-process Firestore test double: documents, subcollections, merge sets, `>` count
 * queries, and transactions with optimistic concurrency (a transaction whose read set changed
 * before commit is retried), which is what makes the concurrent-write test meaningful.
 */
class TxFirestore {
  readonly docs = new Map<string, { data: Record<string, unknown>; version: number }>();
  commits = 0;
  retries = 0;

  collection(path: string) {
    return new FakeCollection(this, path);
  }

  write(path: string, data: Record<string, unknown>, merge: boolean): void {
    const prev = this.docs.get(path);
    const next = merge && prev ? { ...prev.data, ...data } : { ...data };
    this.docs.set(path, { data: next, version: (prev?.version ?? 0) + 1 });
  }

  async runTransaction<T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const tx = new FakeTx(this);
      const out = await fn(tx);
      const stale = [...tx.reads].some(([path, v]) => (this.docs.get(path)?.version ?? 0) !== v);
      if (stale) {
        this.retries++;
        continue;
      }
      for (const w of tx.writes) this.write(w.path, w.data, w.merge);
      this.commits++;
      return out;
    }
    throw new Error('transaction contention');
  }
}

class FakeDocSnap {
  constructor(readonly exists: boolean, private readonly d: Record<string, unknown> | undefined) {}
  data() {
    return this.d ? { ...this.d } : undefined;
  }
}

class FakeDoc {
  constructor(readonly db: TxFirestore, readonly path: string) {}
  collection(name: string) {
    return new FakeCollection(this.db, `${this.path}/${name}`);
  }
  async get() {
    const d = this.db.docs.get(this.path);
    return new FakeDocSnap(Boolean(d), d?.data);
  }
  async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
    this.db.write(this.path, data, Boolean(opts?.merge));
  }
}

class FakeCollection {
  constructor(readonly db: TxFirestore, readonly path: string, private readonly filter?: (d: Record<string, unknown>) => boolean) {}
  doc(id: string) {
    return new FakeDoc(this.db, `${this.path}/${id}`);
  }
  where(field: string, op: '>', value: number) {
    if (op !== '>') throw new Error(`unsupported op ${op}`);
    return new FakeCollection(this.db, this.path, (d) => (d[field] as number) > value);
  }
  private rows() {
    const prefix = `${this.path}/`;
    return [...this.db.docs.entries()]
      .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .map(([, d]) => d.data)
      .filter((d) => !this.filter || this.filter(d));
  }
  count() {
    return { get: async () => ({ data: () => ({ count: this.rows().length }) }) };
  }
}

class FakeTx {
  readonly reads = new Map<string, number>();
  readonly writes: Array<{ path: string; data: Record<string, unknown>; merge: boolean }> = [];
  constructor(private readonly db: TxFirestore) {}
  async get(ref: FakeDoc) {
    await Promise.resolve();
    const d = this.db.docs.get(ref.path);
    this.reads.set(ref.path, d?.version ?? 0);
    return new FakeDocSnap(Boolean(d), d?.data);
  }
  set(ref: FakeDoc, data: Record<string, unknown>, opts?: { merge?: boolean }) {
    this.writes.push({ path: ref.path, data, merge: Boolean(opts?.merge) });
  }
}

const D1 = '2026-12-01';
const input = (over: Partial<DailyResultInput> = {}): DailyResultInput => ({
  clientId: 'cid-ada',
  publicId: 'p1_AAAAAAAAAAAAAAAAAAAAAA',
  name: 'Ada',
  siteId: 'den-1',
  dayKey: D1,
  pts: 300,
  tape: 'OOL',
  nowMs: dayKeyToMs(D1) + 3_600_000,
  ...over,
});

function cloudStore(db = new TxFirestore()) {
  return {
    db,
    store: new CloudPersistenceStore({
      firestore: db as unknown as Firestore,
      pubsub: {} as never,
      budgetFlushIntervalMs: 0,
    }),
  };
}

const stores: Array<[string, () => PersistenceStore]> = [
  ['InMemoryPersistenceStore', () => new InMemoryPersistenceStore()],
  ['CloudPersistenceStore', () => cloudStore().store],
];

describe.each(stores)('%s daily results', (_name, make) => {
  it('keeps the best score of unlimited attempts and leaves the streak alone on repeat days', async () => {
    const store = make();
    const a = await store.recordDailyResult(input({ pts: 300 }));
    expect(a).toEqual({ bestPts: 300, improved: true, attempts: 1, streak: 1, streakDelta: 1 });
    const b = await store.recordDailyResult(input({ pts: 120 }));
    expect(b).toEqual({ bestPts: 300, improved: false, attempts: 2, streak: 1, streakDelta: 0 });
    const c = await store.recordDailyResult(input({ pts: 410 }));
    expect(c).toEqual({ bestPts: 410, improved: true, attempts: 3, streak: 1, streakDelta: 0 });
    expect(await store.getPlayerStats('cid-ada')).toMatchObject({ dailyStreak: 1, dailiesCompleted: 1, lastDailyKey: D1 });
  });

  it('extends on consecutive days and restarts after a gap', async () => {
    const store = make();
    await store.recordDailyResult(input());
    expect((await store.recordDailyResult(input({ dayKey: addDays(D1, 1) }))).streak).toBe(2);
    expect((await store.recordDailyResult(input({ dayKey: addDays(D1, 2) }))).streak).toBe(3);
    const gap = await store.recordDailyResult(input({ dayKey: addDays(D1, 4) }));
    expect(gap).toMatchObject({ streak: 1, streakDelta: 1 });
    expect(await store.getPlayerStats('cid-ada')).toMatchObject({
      dailyStreak: 1,
      bestDailyStreak: 3,
      dailiesCompleted: 4,
      lastDailyKey: addDays(D1, 4),
    });
  });

  it('ranks by best score (ties share a rank) and keeps existing lifetime totals', async () => {
    const store = make();
    await store.recordRunStats({ clientId: 'cid-ada', name: 'Ada', isBot: false, siteId: 'den-1', deliveries: 4, score: 90, nowMs: 1 });
    await store.recordDailyResult(input({ pts: 300 }));
    await store.recordDailyResult(input({ clientId: 'cid-bo', publicId: 'p1_BBBBBBBBBBBBBBBBBBBBBB', name: 'Bo', pts: 500 }));
    await store.recordDailyResult(input({ clientId: 'cid-cy', publicId: 'p1_CCCCCCCCCCCCCCCCCCCCCC', name: 'Cy', pts: 300 }));
    expect(await store.getDailyRank(D1, 500)).toEqual({ rank: 1, of: 3 });
    expect(await store.getDailyRank(D1, 300)).toEqual({ rank: 2, of: 3 });
    expect(await store.getDailyRank(addDays(D1, 1), 300)).toEqual({ rank: 1, of: 0 });
    expect(await store.getPlayerStats('cid-ada')).toMatchObject({ totalDeliveries: 4, totalScore: 90, shiftsPlayed: 1 });
  });

  it('folds run totals atomically: concurrent runs never lose an update', async () => {
    const store = make();
    const run = (n: number) =>
      store.recordRunStats({
        clientId: 'cid-ada',
        name: 'Ada',
        isBot: false,
        siteId: 'den-1',
        deliveries: 1,
        score: 10,
        blitzPts: n * 10,
        ppm: n,
        nowMs: n,
      });
    await Promise.all([1, 2, 3, 4, 5].map(run));
    expect(await store.getPlayerStats('cid-ada')).toMatchObject({
      totalDeliveries: 5,
      totalScore: 50,
      shiftsPlayed: 5,
      bestBlitzPts: 50,
      ppm: 5,
    });
  });

  it('concurrent completions of the same day count the streak once and every attempt', async () => {
    const store = make();
    const results = await Promise.all([300, 450, 200].map((pts) => store.recordDailyResult(input({ pts }))));
    expect(results.map((r) => r.streakDelta).sort()).toEqual([0, 0, 1]);
    expect(Math.max(...results.map((r) => r.attempts))).toBe(3);
    expect(await store.getPlayerStats('cid-ada')).toMatchObject({ dailyStreak: 1, dailiesCompleted: 1 });
    expect(await store.getDailyRank(D1, 450)).toEqual({ rank: 1, of: 1 });
  });
});

describe('CloudPersistenceStore daily documents', () => {
  it('writes daily/{dayKey} once and the entry with a TTL Timestamp and publicId only', async () => {
    const { db, store } = cloudStore();
    await store.recordDailyResult(input({ pts: 300 }));
    await store.recordDailyResult(input({ pts: 500, tape: 'OOOX' }));
    const day = db.docs.get(`daily/${D1}`)!;
    expect(day.version).toBe(1);
    const info = dailyInfoFor(D1);
    expect(day.data).toMatchObject({ dayKey: D1, number: info.number, modifier: info.modifier.id, cards: info.cards });
    const entry = db.docs.get(`daily/${D1}/entries/cid-ada`)!.data;
    expect(entry).toMatchObject({ publicId: 'p1_AAAAAAAAAAAAAAAAAAAAAA', bestPts: 500, attempts: 2, tape: 'OOOX' });
    expect(JSON.stringify(entry)).not.toContain('cid-ada');
    const expireAt = entry.expireAt as { toMillis(): number };
    expect(expireAt.toMillis()).toBe(dayKeyToMs(addDays(D1, DAILY_ENTRY_TTL_DAYS)));
  });

  it('retries on contention instead of overwriting (concurrent shards)', async () => {
    const { db, store } = cloudStore();
    await Promise.all([1, 2, 3].map((n) => store.recordDailyResult(input({ pts: n * 100 }))));
    expect(db.retries).toBeGreaterThan(0);
    expect(db.docs.get(`daily/${D1}/entries/cid-ada`)!.data).toMatchObject({ bestPts: 300, attempts: 3 });
  });

  it('surfaces Firestore failures instead of inventing a result', async () => {
    const db = new TxFirestore();
    db.runTransaction = async () => {
      throw new Error('firestore unavailable');
    };
    const { store } = cloudStore(db);
    await expect(store.recordDailyResult(input())).rejects.toThrow('firestore unavailable');
  });
});

describe('applyDailyResult / dailyEntryExpireAt', () => {
  it('stamps expireAt DAILY_ENTRY_TTL_DAYS after the day and keeps the best run tape and site', () => {
    expect(dailyEntryExpireAt(D1)).toBe(dayKeyToMs(addDays(D1, 120)));
    const first = applyDailyResult(null, null, input({ pts: 400, tape: 'OO', siteId: 'den-1' }));
    const worse = applyDailyResult(null, first.entry, input({ pts: 100, tape: 'X', siteId: 'slc-2' }));
    expect(worse.entry).toMatchObject({ bestPts: 400, tape: 'OO', siteId: 'den-1', attempts: 2 });
  });
});
