/**
 * Floor Trials shared ghost runs: `POST /api/trials/:levelId/runs` and
 * `GET /api/trials/:levelId/ghosts`.
 *
 * Storage: `trials{SUFFIX}/{levelId}_r{rev}/runs/{clientId}`, one doc per player per level
 * revision holding only that player's fastest plausible run. Reads use single-field ordering on
 * `time` (Firestore's automatic indexes), so no composite index is required.
 */
import type { Firestore } from '@google-cloud/firestore';
import type { FastifyInstance } from 'fastify';
import {
  TrialLevelIdSchema,
  TrialRunSubmitSchema,
  type TrialGhost,
  type TrialGhostsResponse,
  type TrialRunSubmitResponse,
} from '@warehouse/protocol';
import { trialLevel, trialRev, validateGhostRun } from '@warehouse/sim';

/** A stored best run (Firestore doc fields; `clientId` is the doc id and never served). */
export interface StoredTrialRun {
  publicId: string;
  name: string;
  time: number;
  stars: number;
  strikes: number;
  track: string;
  updatedAt: number;
}

/** Faster first; ties go to fewer strikes, then the earlier run. */
export function compareTrialRuns(a: StoredTrialRun, b: StoredTrialRun): number {
  return a.time - b.time || a.strikes - b.strikes || a.updatedAt - b.updatedAt;
}

/** Board key for a level revision: the `{levelId}_r{rev}` doc under `trials`. */
export function trialBoardKey(levelId: string, rev: number): string {
  return `${levelId}_r${rev}`;
}

export interface TrialGhostStore {
  /**
   * Stores `run` as the player's best on `board` unless their stored best is at least as fast.
   * Must be atomic per player across lobby instances.
   */
  submitTrialRun(board: string, clientId: string, run: StoredTrialRun): Promise<{ improved: boolean; best: StoredTrialRun }>;
  /** Fastest `limit` runs (time asc) and the number of players on the board. */
  getTrialTop(board: string, limit: number): Promise<{ total: number; top: StoredTrialRun[] }>;
  /** The slowest run strictly faster than `time` (the one to beat next), or null. */
  getTrialNext(board: string, time: number): Promise<StoredTrialRun | null>;
  /** Number of runs strictly faster than `time`. */
  countTrialFaster(board: string, time: number): Promise<number>;
}

function toStoredTrialRun(data: Record<string, unknown>): StoredTrialRun {
  return {
    publicId: typeof data.publicId === 'string' ? data.publicId : '',
    name: typeof data.name === 'string' && data.name ? data.name : 'Driver',
    time: typeof data.time === 'number' ? data.time : Number.POSITIVE_INFINITY,
    stars: typeof data.stars === 'number' ? data.stars : 0,
    strikes: typeof data.strikes === 'number' ? data.strikes : 0,
    track: typeof data.track === 'string' ? data.track : '',
    updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : 0,
  };
}

export class FirestoreTrialGhostStore implements TrialGhostStore {
  constructor(
    private readonly db: Firestore,
    private readonly colName: (base: string) => string,
  ) {}

  private runs(board: string) {
    return this.db.collection(this.colName('trials')).doc(board).collection('runs');
  }

  async submitTrialRun(board: string, clientId: string, run: StoredTrialRun): Promise<{ improved: boolean; best: StoredTrialRun }> {
    const ref = this.runs(board).doc(clientId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const prev = snap.exists ? toStoredTrialRun(snap.data() ?? {}) : null;
      if (prev && compareTrialRuns(prev, run) <= 0) {
        // Keep the faster run, but follow callsign changes.
        if (prev.name !== run.name) tx.set(ref, { name: run.name }, { merge: true });
        return { improved: false, best: { ...prev, name: run.name } };
      }
      tx.set(ref, { ...run });
      return { improved: true, best: run };
    });
  }

  async getTrialTop(board: string, limit: number): Promise<{ total: number; top: StoredTrialRun[] }> {
    const col = this.runs(board);
    const [snap, count] = await Promise.all([
      col.orderBy('time', 'asc').limit(Math.max(1, limit)).get(),
      col.count().get(),
    ]);
    return { total: count.data().count, top: snap.docs.map((d) => toStoredTrialRun(d.data())).sort(compareTrialRuns) };
  }

  async getTrialNext(board: string, time: number): Promise<StoredTrialRun | null> {
    const snap = await this.runs(board).where('time', '<', time).orderBy('time', 'desc').limit(1).get();
    const doc = snap.docs[0];
    return doc ? toStoredTrialRun(doc.data()) : null;
  }

  async countTrialFaster(board: string, time: number): Promise<number> {
    const agg = await this.runs(board).where('time', '<', time).count().get();
    return agg.data().count;
  }
}

/** In-memory board for tests and local dev without Firestore. */
export class InMemoryTrialGhostStore implements TrialGhostStore {
  private readonly boards = new Map<string, Map<string, StoredTrialRun>>();

  private board(key: string): Map<string, StoredTrialRun> {
    let b = this.boards.get(key);
    if (!b) {
      b = new Map();
      this.boards.set(key, b);
    }
    return b;
  }

  async submitTrialRun(board: string, clientId: string, run: StoredTrialRun): Promise<{ improved: boolean; best: StoredTrialRun }> {
    const b = this.board(board);
    const prev = b.get(clientId);
    if (prev && compareTrialRuns(prev, run) <= 0) {
      prev.name = run.name;
      return { improved: false, best: { ...prev } };
    }
    b.set(clientId, { ...run });
    return { improved: true, best: { ...run } };
  }

  async getTrialTop(board: string, limit: number): Promise<{ total: number; top: StoredTrialRun[] }> {
    const rows = [...this.board(board).values()].sort(compareTrialRuns);
    return { total: rows.length, top: rows.slice(0, Math.max(1, limit)).map((r) => ({ ...r })) };
  }

  async getTrialNext(board: string, time: number): Promise<StoredTrialRun | null> {
    const faster = [...this.board(board).values()].filter((r) => r.time < time).sort(compareTrialRuns);
    const r = faster.at(-1);
    return r ? { ...r } : null;
  }

  async countTrialFaster(board: string, time: number): Promise<number> {
    return [...this.board(board).values()].filter((r) => r.time < time).length;
  }
}

/** Fastest runs served per level. */
export const TRIAL_GHOSTS_TOP = 3;
/** Per-instance cache TTL for a level's top runs (they only change when someone improves). */
export const TRIAL_GHOSTS_CACHE_TTL_MS = 15_000;
/** Max request body for a run submit (the track is capped at 48 K chars). */
export const TRIAL_RUN_BODY_LIMIT = 64 * 1024;
/** Run submits allowed per IP per minute (a player finishes a level at most every ~10 s). */
export const TRIAL_RUN_RATE_PER_MIN = 12;

export interface TrialRouteDeps {
  store: TrialGhostStore | null;
  now: () => number;
  /** Opaque public id for a raw clientId. */
  publicIdFor: (clientId: string) => string;
  /** Display callsign for a raw clientId (stored player name or the generated callsign). */
  nameFor: (clientId: string) => Promise<string>;
  isCrawler: (userAgent: string | undefined) => boolean;
  /** Per-IP token bucket for submits. */
  allowSubmit: (ip: string, nowMs: number) => boolean;
}

function toGhost(r: StoredTrialRun, rank: number): TrialGhost {
  return { rank, publicId: r.publicId, name: r.name, time: r.time, stars: r.stars, strikes: r.strikes, track: r.track };
}

export function registerTrialRoutes(app: FastifyInstance, deps: TrialRouteDeps): void {
  const topCache = new Map<string, { atMs: number; value: Promise<{ total: number; top: StoredTrialRun[] }> }>();
  const cachedTop = (board: string, nowMs: number) => {
    const store = deps.store;
    if (!store) return Promise.resolve({ total: 0, top: [] as StoredTrialRun[] });
    const hit = topCache.get(board);
    if (hit && nowMs - hit.atMs < TRIAL_GHOSTS_CACHE_TTL_MS) return hit.value;
    const value = store.getTrialTop(board, TRIAL_GHOSTS_TOP);
    const entry = { atMs: nowMs, value };
    topCache.set(board, entry);
    value.catch(() => {
      if (topCache.get(board) === entry) topCache.delete(board); // never cache a failure
    });
    return value;
  };

  const levelOf = (raw: unknown) => {
    const id = TrialLevelIdSchema.safeParse(raw);
    return id.success ? trialLevel(id.data) : null;
  };

  app.get<{ Params: { levelId: string }; Querystring: { time?: string } }>(
    '/api/trials/:levelId/ghosts',
    async (req, reply) => {
      const level = levelOf(req.params.levelId);
      if (!level) return reply.code(404).send({ error: 'unknown_level', message: 'No such Floor Trials level.' });
      if (!deps.store) {
        return reply.code(503).send({ error: 'ghosts_unavailable', message: 'Shared ghosts are unavailable right now.' });
      }
      const rev = trialRev(level);
      const board = trialBoardKey(level.id, rev);
      const rawTime = Number(req.query?.time);
      const myTime = Number.isFinite(rawTime) && rawTime > 0 ? rawTime : null;
      try {
        const nowMs = deps.now();
        const [{ total, top }, next] = await Promise.all([
          cachedTop(board, nowMs),
          myTime != null ? deps.store.getTrialNext(board, myTime) : Promise.resolve(null),
        ]);
        let nextGhost: TrialGhost | null = null;
        if (next) {
          const above = top.findIndex((r) => r.time >= next.time);
          const rank = above >= 0 ? above + 1 : (await deps.store.countTrialFaster(board, next.time)) + 1;
          nextGhost = toGhost(next, rank);
        }
        const body: TrialGhostsResponse = {
          levelId: level.id,
          rev,
          total,
          top: top.map((r) => toGhost(r, top.findIndex((x) => x.time === r.time) + 1)),
          next: nextGhost,
        };
        reply.header('Cache-Control', 'no-store');
        return body;
      } catch (err) {
        req.log.error({ err }, 'trial ghosts read failed');
        return reply.code(503).send({ error: 'ghosts_unavailable', message: 'Shared ghosts are unavailable right now.' });
      }
    },
  );

  app.post<{ Params: { levelId: string } }>(
    '/api/trials/:levelId/runs',
    { bodyLimit: TRIAL_RUN_BODY_LIMIT },
    async (req, reply) => {
      const nowMs = deps.now();
      if (deps.isCrawler(req.headers['user-agent'])) {
        return reply.code(403).send({ error: 'crawler_not_allowed', message: 'Automated crawlers cannot post runs.' });
      }
      if (!deps.allowSubmit(req.ip || '127.0.0.1', nowMs)) {
        return reply.code(429).send({ error: 'rate_limited', message: 'Too many runs from this IP. Please wait a moment.' });
      }
      const level = levelOf(req.params.levelId);
      if (!level) return reply.code(404).send({ error: 'unknown_level', message: 'No such Floor Trials level.' });
      const parsed = TrialRunSubmitSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'invalid_request',
          message: parsed.error.issues[0]?.message ?? 'Invalid run payload.',
        });
      }
      const { clientId, rev, time, stars, strikes, track } = parsed.data;
      const verdict = validateGhostRun({ levelId: level.id, rev, time, stars, strikes, track });
      if (!verdict.ok) {
        return reply.code(422).send({ error: 'implausible_run', reason: verdict.reason, message: 'Run rejected by the trial rules check.' });
      }
      if (!deps.store) {
        return reply.code(503).send({ error: 'ghosts_unavailable', message: 'Shared ghosts are unavailable right now.' });
      }
      const board = trialBoardKey(level.id, rev);
      try {
        const run: StoredTrialRun = {
          publicId: deps.publicIdFor(clientId),
          name: await deps.nameFor(clientId),
          time,
          stars,
          strikes,
          track,
          updatedAt: nowMs,
        };
        const { improved, best } = await deps.store.submitTrialRun(board, clientId, run);
        if (improved) topCache.delete(board);
        const [faster, top] = await Promise.all([deps.store.countTrialFaster(board, best.time), cachedTop(board, nowMs)]);
        const body: TrialRunSubmitResponse = {
          ok: true,
          improved,
          best: { time: best.time, stars: best.stars },
          rank: faster + 1,
          total: top.total,
        };
        return body;
      } catch (err) {
        req.log.error({ err }, 'trial run write failed');
        return reply.code(503).send({ error: 'ghosts_unavailable', message: 'Could not save the run right now.' });
      }
    },
  );
}
