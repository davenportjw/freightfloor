/**
 * Lobby security & concurrency regressions:
 *  1. Account takeover via callsign resume → secret resume codes.
 *  2. Spoofable client IP → trust exactly one proxy hop; signed client-IP header to sites;
 *     limiter TTL eviction.
 *  3. Seat/queue races across two lobby instances → Firestore transactions + shared seat holds;
 *     empty Firestore queue is authoritative; real queue errors surface as 503.
 *  4. No committed dev HMAC literal.
 *  5. Lobby WebSocketServer maxPayload.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { MAX_WS_FRAME_BYTES, verifyProxyHeader } from '@warehouse/protocol';
import {
  buildLobbyServer,
  CLIENT_IP_HEADER_NAME,
  CLIENT_IP_SIG_HEADER_NAME,
  FirestoreLobbyStore,
  hashResumeToken,
  InMemoryLobbyStore,
  isResumeTokenFormat,
  PUBLIC_ID_PATTERN,
  publicIdFor,
  resolveClientIp,
  resolveTicketSecret,
  resumeTokenFor,
  signClientIp,
  TokenBucketRateLimiter,
  verifyResumeToken,
  type StoredSiteDoc,
} from '../src/index.js';

const SECRET = 'test-hmac-secret-key-for-warehouse-lobby-security';
const NOW = 1_700_000_000_000;

function makeSite(id: StoredSiteDoc['id'], overrides: Partial<StoredSiteDoc> = {}): StoredSiteDoc {
  return {
    id,
    state: 'live',
    phase: 'running',
    drivers: 0,
    spectators: 0,
    tier: 1,
    shipped: 0,
    updatedAt: NOW - 1_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Minimal Firestore double with optimistic-concurrency transactions. Every awaited read yields to
// the event loop so concurrent requests on two lobby "instances" genuinely interleave; a
// transaction commits only if every doc (and collection membership) it read is unchanged,
// otherwise it retries — the same serializability guarantee Firestore provides.
// ---------------------------------------------------------------------------

type Data = Record<string, unknown>;
const tick = () => new Promise<void>((r) => setImmediate(r));

class FakeDocRef {
  constructor(
    readonly db: FakeFirestore,
    readonly colName: string,
    readonly id: string,
  ) {}
  async get() {
    await tick();
    return this.db.docSnap(this.colName, this.id);
  }
  async set(data: Data, opts?: { merge?: boolean }) {
    await tick();
    this.db.write(this.colName, this.id, data, Boolean(opts?.merge));
  }
  async delete() {
    await tick();
    this.db.remove(this.colName, this.id);
  }
}

class FakeCollection {
  constructor(
    readonly db: FakeFirestore,
    readonly name: string,
    private readonly filter?: { field: string; value: unknown },
    private readonly max?: number,
  ) {}
  doc(id: string) {
    return new FakeDocRef(this.db, this.name, id);
  }
  where(field: string, _op: string, value: unknown) {
    return new FakeCollection(this.db, this.name, { field, value }, this.max);
  }
  limit(n: number) {
    return new FakeCollection(this.db, this.name, this.filter, n);
  }
  async get() {
    await tick();
    return this.db.querySnap(this.name, this.filter, this.max);
  }
}

class FakeFirestore {
  private readonly cols = new Map<string, Map<string, { version: number; data: Data }>>();
  private clock = 0;
  failQueueReads = false;
  transactions = 0;
  retries = 0;

  col(name: string) {
    let c = this.cols.get(name);
    if (!c) {
      c = new Map();
      this.cols.set(name, c);
    }
    return c;
  }
  collection(name: string) {
    return new FakeCollection(this, name);
  }
  raw(name: string): Data[] {
    return [...this.col(name).values()].map((r) => ({ ...r.data }));
  }
  write(colName: string, id: string, data: Data, merge: boolean) {
    const prev = this.col(colName).get(id);
    this.col(colName).set(id, {
      version: ++this.clock,
      data: merge && prev ? { ...prev.data, ...data } : { ...data },
    });
  }
  remove(colName: string, id: string) {
    this.col(colName).delete(id);
  }
  docSnap(colName: string, id: string) {
    const rec = this.col(colName).get(id);
    return { exists: Boolean(rec), id, data: () => (rec ? { ...rec.data } : undefined) };
  }
  querySnap(name: string, filter?: { field: string; value: unknown }, max?: number) {
    if (this.failQueueReads && name.startsWith('queue')) {
      throw new Error('14 UNAVAILABLE: firestore backend unreachable');
    }
    let docs = [...this.col(name).entries()]
      .filter(([, r]) => !filter || r.data[filter.field] === filter.value)
      .map(([id, r]) => ({ id, data: () => ({ ...r.data }) }));
    if (max !== undefined) docs = docs.slice(0, max);
    return { empty: docs.length === 0, size: docs.length, docs, forEach: (cb: (d: (typeof docs)[number]) => void) => docs.forEach(cb) };
  }

  async runTransaction<T>(fn: (t: unknown) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 50; attempt++) {
      this.transactions += 1;
      const docReads = new Map<string, number>();
      const colReads = new Map<string, string>();
      const writes: Array<() => void> = [];
      const t = {
        get: async (ref: FakeDocRef | FakeCollection) => {
          await tick();
          if (ref instanceof FakeDocRef) {
            docReads.set(`${ref.colName}/${ref.id}`, this.col(ref.colName).get(ref.id)?.version ?? 0);
            return this.docSnap(ref.colName, ref.id);
          }
          const snap = this.querySnap(ref.name);
          colReads.set(ref.name, [...this.col(ref.name).keys()].sort().join('|'));
          for (const [id, r] of this.col(ref.name)) docReads.set(`${ref.name}/${id}`, r.version);
          return snap;
        },
        set: (ref: FakeDocRef, data: Data) => {
          writes.push(() => this.write(ref.colName, ref.id, data, false));
        },
        delete: (ref: FakeDocRef) => {
          writes.push(() => this.remove(ref.colName, ref.id));
        },
      };
      const result = await fn(t);
      // Validate + commit synchronously (atomic w.r.t. other JS tasks).
      let valid = true;
      for (const [key, version] of docReads) {
        const [c, id] = key.split('/');
        if ((this.col(c).get(id)?.version ?? 0) !== version) valid = false;
      }
      for (const [c, sig] of colReads) {
        if ([...this.col(c).keys()].sort().join('|') !== sig) valid = false;
      }
      if (!valid) {
        this.retries += 1;
        continue;
      }
      for (const w of writes) w();
      return result;
    }
    throw new Error('10 ABORTED: too much contention');
  }
}

function seedFullSites(db: FakeFirestore, overrides: Record<string, Data> = {}) {
  for (const id of ['den-1', 'slc-2', 'phx-3', 'abq-4']) {
    db.write(
      'sites',
      id,
      { id, state: 'live', phase: 'running', drivers: 32, spectators: 0, updatedAt: Date.now(), ...overrides[id] },
      false,
    );
  }
}

async function twoInstances(db: FakeFirestore) {
  const mk = async () =>
    buildLobbyServer({
      store: new FirestoreLobbyStore(db as never, {}),
      ticketSecret: SECRET,
      now: () => Date.now(),
      rateLimitPerMin: 10_000,
    });
  return [await mk(), await mk()] as const;
}

// ---------------------------------------------------------------------------
// 1. Resume codes
// ---------------------------------------------------------------------------

describe('resume codes and existing callsign lookup', () => {
  it('raw clientId or unknown callsign never resumes or creates a player; existing callsign or secret code resolves', async () => {
    const store = new InMemoryLobbyStore([makeSite('den-1')]);
    const app = await buildLobbyServer({ store, ticketSecret: SECRET, now: () => NOW });

    const victim = (await app.inject({ method: 'POST', url: '/api/join', payload: { clientId: 'victim-1' } })).json();
    expect(victim.resumeToken).toBe(resumeTokenFor('victim-1', SECRET));
    expect(isResumeTokenFormat(victim.resumeToken)).toBe(true);

    // Raw clientId or non-existent callsigns -> rejected with 404 invalid_resume_code, never added.
    for (const resume of ['victim-1', 'brand-new-driver-99', 'unknown-otter-11']) {
      const res = await app.inject({ method: 'POST', url: '/api/join', payload: { clientId: 'attacker', resume } });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('invalid_resume_code');
      expect(res.body).not.toContain('victim-1');
    }

    // Well-formed but forged code / code minted with another secret → rejected.
    const forged = ['wr1_' + 'A'.repeat(32), resumeTokenFor('victim-1', 'some-other-secret-value')];
    for (const resume of forged) {
      const res = await app.inject({ method: 'POST', url: '/api/join', payload: { clientId: 'attacker', resume } });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('invalid_resume_code');
    }

    // Another player's callsign from a new browser -> rejected (cannot assume another player without their secret resume code).
    const byOtherCallsign = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { clientId: 'new-browser', resume: victim.name },
    });
    expect(byOtherCallsign.statusCode).toBe(404);
    expect(byOtherCallsign.json().error).toBe('invalid_resume_code');
    expect(byOtherCallsign.body).not.toContain('victim-1');

    // Valid code from a new browser → restores identity and returns the same code.
    const ok = await app.inject({ method: 'POST', url: '/api/join', payload: { clientId: 'new-browser', resume: victim.resumeToken } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ clientId: 'victim-1', name: victim.name, resumeToken: victim.resumeToken });

    await app.close();
  });

  it('keeps backward compatibility for a player re-entering their OWN callsign from the same browser', async () => {
    const store = new InMemoryLobbyStore([makeSite('den-1')]);
    const app = await buildLobbyServer({ store, ticketSecret: SECRET, now: () => NOW });
    const first = (await app.inject({ method: 'POST', url: '/api/join', payload: { clientId: 'same-browser' } })).json();
    const again = await app.inject({ method: 'POST', url: '/api/join', payload: { clientId: 'same-browser', resume: first.name } });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ clientId: 'same-browser', name: first.name });
    await app.close();
  });

  it('bots never receive a resume code', async () => {
    const store = new InMemoryLobbyStore([makeSite('den-1')]);
    const app = await buildLobbyServer({ store, ticketSecret: SECRET, now: () => NOW });
    const bot = (await app.inject({ method: 'POST', url: '/api/join', payload: { clientId: 'bot-x', name: 'loadtest-bot-9' } })).json();
    expect(bot.isBot).toBe(true);
    expect(bot.resumeToken).toBeUndefined();
    await app.close();
  });

  it('Firestore store persists only the code hash, blocks cross-browser callsign hijacking, and resolves resume hashes across instances', async () => {
    const db = new FakeFirestore();
    seedFullSites(db, { 'den-1': { drivers: 0 } });
    const [a, b] = await twoInstances(db);

    const first = (await a.inject({ method: 'POST', url: '/api/join', payload: { clientId: 'fs-player' } })).json();
    const doc = db.raw('players').find((p) => p.clientId === 'fs-player')!;
    expect(doc.resumeTokenHash).toBe(hashResumeToken(first.resumeToken));
    expect(JSON.stringify(db.raw('players'))).not.toContain(first.resumeToken);

    const byUnknownName = await b.inject({ method: 'POST', url: '/api/join', payload: { clientId: 'other', resume: 'no-such-callsign-99' } });
    expect(byUnknownName.statusCode).toBe(404);

    const byOtherPlayerName = await b.inject({ method: 'POST', url: '/api/join', payload: { clientId: 'other', resume: first.name } });
    expect(byOtherPlayerName.statusCode).toBe(404);
    expect(byOtherPlayerName.json().error).toBe('invalid_resume_code');

    const bySameBrowserName = await b.inject({ method: 'POST', url: '/api/join', payload: { clientId: 'fs-player', resume: first.name } });
    expect(bySameBrowserName.statusCode).toBe(200);
    expect(bySameBrowserName.json().clientId).toBe('fs-player');
    expect(bySameBrowserName.json().name).toBe(first.name);

    const byCode = await b.inject({ method: 'POST', url: '/api/join', payload: { clientId: 'other', resume: first.resumeToken } });
    expect(byCode.statusCode).toBe(200);
    expect(byCode.json().clientId).toBe('fs-player');

    await a.close();
    await b.close();
  });

  it('verifyResumeToken is bound to clientId and secret', () => {
    const t = resumeTokenFor('c1', SECRET);
    expect(verifyResumeToken(t, 'c1', SECRET)).toBe(true);
    expect(verifyResumeToken(t, 'c2', SECRET)).toBe(false);
    expect(verifyResumeToken(t, 'c1', SECRET + 'x')).toBe(false);
    expect(verifyResumeToken('short', 'c1', SECRET)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Client IP
// ---------------------------------------------------------------------------

describe('public player ids (clientId exposure regression)', () => {
  it('derives an opaque, secret-bound publicId matching the shared site vector', () => {
    const id = publicIdFor('client-alpha-123', 'secret-one');
    expect(id).toMatch(PUBLIC_ID_PATTERN);
    expect(id).not.toContain('client-alpha');
    expect(publicIdFor('client-alpha-123', 'secret-two')).not.toBe(id);
    // Same known-answer vector as apps/site/test/public-id.test.ts (lobby/site parity).
    expect(publicIdFor('vector-client', 'vector-secret')).toBe('p1_eak1foHd37nBA3DRKHmMAt');
  });

  it('/api/network never exposes raw clientIds; join returns the caller\'s own publicId', async () => {
    const store = new InMemoryLobbyStore(
      [makeSite('den-1')],
      [
        { clientId: 'victim-secret-client', name: 'Turbo-Badger', siteId: 'den-1', points: 900, deliveries: 9 },
        { clientId: 'other-secret-client', name: 'Cosmic-Forklift', siteId: 'den-1', points: 500, deliveries: 5 },
      ],
    );
    const app = await buildLobbyServer({ store, ticketSecret: SECRET, now: () => NOW });

    const net = await app.inject({ method: 'GET', url: '/api/network' });
    expect(net.statusCode).toBe(200);
    expect(net.body).not.toContain('victim-secret-client');
    expect(net.body).not.toContain('other-secret-client');
    const rows = net.json().leaderboard as Array<{ clientId: string; publicId: string; name: string }>;
    expect(rows.map((r) => r.publicId)).toEqual([
      publicIdFor('victim-secret-client', SECRET),
      publicIdFor('other-secret-client', SECRET),
    ]);
    for (const r of rows) expect(r.clientId).toBe(r.publicId);

    // A leaked leaderboard id is useless as a credential: it is not the victim's clientId, so a
    // queue claim / join with it gets a fresh identity, never the victim's.
    const asVictim = await app.inject({ method: 'POST', url: '/api/join', payload: { clientId: rows[0].publicId } });
    expect(asVictim.statusCode).toBe(200);
    expect(asVictim.json().name).not.toBe('Turbo-Badger');

    // The victim's own join returns its publicId so the client can find its own leaderboard row.
    const own = await app.inject({ method: 'POST', url: '/api/join', payload: { clientId: 'victim-secret-client' } });
    expect(own.statusCode).toBe(200);
    expect(own.json().publicId).toBe(rows[0].publicId);
    expect(own.json().clientId).toBe('victim-secret-client');

    await app.close();
  });
});

describe('client IP resolution (spoofable XFF regression)', () => {
  it('trusts exactly one hop: the right-most XFF entry appended by the Cloud Run front end', () => {
    // Cloud Run appends the real peer to whatever the client sent.
    expect(resolveClientIp('6.6.6.6, 203.0.113.9', '169.254.1.1', 1)).toBe('203.0.113.9');
    expect(resolveClientIp(['6.6.6.6', '7.7.7.7, 203.0.113.9'], '169.254.1.1', 1)).toBe('203.0.113.9');
    expect(resolveClientIp(undefined, '198.51.100.4', 1)).toBe('198.51.100.4');
    expect(resolveClientIp('6.6.6.6, 203.0.113.9', '10.0.0.1', 0)).toBe('10.0.0.1');
    expect(resolveClientIp('6.6.6.6, 203.0.113.9, 35.191.0.1', '169.254.1.1', 2)).toBe('203.0.113.9');
    // Not enough hops present → left-most available, never beyond the chain.
    expect(resolveClientIp('203.0.113.9', '169.254.1.1', 3)).toBe('203.0.113.9');
  });

  it('per-IP join limit cannot be bypassed by rotating a spoofed left-most X-Forwarded-For', async () => {
    const store = new InMemoryLobbyStore([makeSite('den-1')]);
    const app = await buildLobbyServer({ store, ticketSecret: SECRET, now: () => NOW, rateLimitPerMin: 2 });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/join',
        headers: { 'x-forwarded-for': `10.9.${i}.1, 203.0.113.9` },
        payload: { clientId: `spoof-${i}`, name: 'loadtest-x' },
      });
      codes.push(res.statusCode);
    }
    expect(codes).toEqual([200, 200, 429, 429]);

    // A genuinely different client (different right-most entry) has its own bucket.
    const other = await app.inject({
      method: 'POST',
      url: '/api/join',
      headers: { 'x-forwarded-for': '203.0.113.77' },
      payload: { clientId: 'other-ip', name: 'loadtest-y' },
    });
    expect(other.statusCode).toBe(200);
    await app.close();
  });

  it('limiter evicts idle buckets (TTL) and enforces a hard size cap', () => {
    const limiter = new TokenBucketRateLimiter(30, 30 / 60_000, 100, 1_000);
    for (let i = 0; i < 80; i++) limiter.allow(`ip-${i}`, NOW);
    expect(limiter.size).toBe(80);
    // After a full refill window everything is idle → swept on the next call.
    limiter.allow('fresh', NOW + 61_000);
    expect(limiter.size).toBe(1);

    for (let i = 0; i < 500; i++) limiter.allow(`burst-${i}`, NOW + 61_000 + i);
    expect(limiter.size).toBeLessThanOrEqual(101);
  });

  it('client-IP signature is bound to the proxy token and the IP', () => {
    const sig = signClientIp('203.0.113.9', 'tokenA', SECRET);
    expect(signClientIp('203.0.113.9', 'tokenA', SECRET)).toBe(sig);
    expect(signClientIp('6.6.6.6', 'tokenA', SECRET)).not.toBe(sig);
    expect(signClientIp('203.0.113.9', 'tokenB', SECRET)).not.toBe(sig);
    expect(signClientIp('203.0.113.9', 'tokenA', 'wrong-secret-value')).not.toBe(sig);
  });
});

// ---------------------------------------------------------------------------
// 2b + 5. WebSocket proxy: forwarded headers and maxPayload
// ---------------------------------------------------------------------------

describe('lobby WebSocket proxy', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  async function startPair() {
    const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => upstream.once('listening', () => r()));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    const seen: Array<Record<string, string | string[] | undefined>> = [];
    upstream.on('connection', (_sock, req) => seen.push(req.headers));

    const prevUrls = process.env.SITE_URLS_JSON;
    process.env.SITE_URLS_JSON = JSON.stringify({ 'den-1': `http://127.0.0.1:${upstreamPort}` });
    const app = await buildLobbyServer({
      store: new InMemoryLobbyStore([makeSite('den-1')]),
      ticketSecret: SECRET,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const lobbyPort = (app.server.address() as AddressInfo).port;
    cleanups.push(async () => {
      await app.close();
      await new Promise<void>((r) => upstream.close(() => r()));
      if (prevUrls === undefined) delete process.env.SITE_URLS_JSON;
      else process.env.SITE_URLS_JSON = prevUrls;
    });
    return { lobbyPort, seen };
  }

  it('sends the lobby-resolved client IP (signed) upstream and never the raw X-Forwarded-For', async () => {
    const { lobbyPort, seen } = await startPair();
    const ws = new WebSocket(`ws://127.0.0.1:${lobbyPort}/ws?site=den-1`, {
      headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' },
    });
    cleanups.push(() => ws.terminate());
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('upstream never connected')), 3_000);
      const poll = setInterval(() => {
        if (seen.length > 0) {
          clearInterval(poll);
          clearTimeout(deadline);
          resolve();
        }
      }, 10);
    });
    const h = seen[0];
    expect(h['x-forwarded-for']).toBeUndefined();
    expect(h[CLIENT_IP_HEADER_NAME]).toBe('203.0.113.9');
    const proxyToken = String(h['x-warehouse-proxy']);
    expect(verifyProxyHeader(proxyToken, 'den-1', SECRET)).toBe(true);
    expect(h[CLIENT_IP_SIG_HEADER_NAME]).toBe(signClientIp('203.0.113.9', proxyToken, SECRET));
  });

  it(`closes client frames larger than MAX_WS_FRAME_BYTES (${MAX_WS_FRAME_BYTES}) with 1009`, async () => {
    const { lobbyPort } = await startPair();
    const ws = new WebSocket(`ws://127.0.0.1:${lobbyPort}/ws?site=den-1`);
    cleanups.push(() => ws.terminate());
    await new Promise<void>((r) => ws.once('open', () => r()));
    const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
    ws.send('x'.repeat(MAX_WS_FRAME_BYTES + 1));
    expect(await closed).toBe(1009);
  });
});

// ---------------------------------------------------------------------------
// 3. Seat / queue races across two lobby instances (shared Firestore)
// ---------------------------------------------------------------------------

describe('seat/queue allocation across two lobby instances', () => {
  it('the last open seat is admitted exactly once when two instances race', async () => {
    const db = new FakeFirestore();
    seedFullSites(db, { 'den-1': { drivers: 31 } });
    const [a, b] = await twoInstances(db);

    const [ra, rb] = await Promise.all([
      a.inject({ method: 'POST', url: '/api/join', payload: { clientId: 'race-a', name: 'loadtest-a' } }),
      b.inject({ method: 'POST', url: '/api/join', payload: { clientId: 'race-b', name: 'loadtest-b' } }),
    ]);
    const roles = [ra.json().role, rb.json().role].sort();
    expect(roles).toEqual(['driver', 'spectator']);
    const loser = ra.json().role === 'spectator' ? ra.json() : rb.json();
    expect(loser.queue).toMatchObject({ state: 'queued', position: 1, totalQueued: 1 });
    expect(db.retries).toBeGreaterThan(0);

    await a.close();
    await b.close();
  });

  it('a seat lease is claimed exactly once, and the claimed seat stays held for the other instance', async () => {
    const db = new FakeFirestore();
    seedFullSites(db, { 'den-1': { drivers: 31 } });
    const now = Date.now();
    db.write(
      'queue',
      'claimer',
      {
        clientId: 'claimer',
        name: 'Claimer',
        isBot: false,
        enqueuedAt: now - 5_000,
        lastPolledAt: now,
        state: 'ready',
        seatLeaseId: 'lease-claim-1234',
        assignedSiteId: 'den-1',
        leaseExpiresAt: now + 20_000,
      },
      false,
    );
    const [a, b] = await twoInstances(db);

    const claims = await Promise.all(
      [a, b].map((app) =>
        app.inject({
          method: 'POST',
          url: '/api/queue/claim',
          payload: { clientId: 'claimer', seatLeaseId: 'lease-claim-1234' },
        }),
      ),
    );
    expect(claims.map((c) => c.statusCode).sort()).toEqual([200, 410]);

    // The heartbeat still says 31/32, but the claimed seat is held in the shared queue, so the
    // other instance must not hand it out again.
    const late = await b.inject({ method: 'POST', url: '/api/join', payload: { clientId: 'late', name: 'loadtest-late' } });
    expect(late.json().role).toBe('spectator');
    expect(late.json().queue.state).toBe('queued');

    await a.close();
    await b.close();
  });

  it('a claimed hold is released as soon as a post-grant heartbeat lists the driver as connected', async () => {
    const db = new FakeFirestore();
    seedFullSites(db, { 'den-1': { drivers: 31 } });
    const t0 = Date.now();
    db.write(
      'queue',
      'claimer',
      {
        clientId: 'claimer',
        name: 'Claimer',
        isBot: false,
        enqueuedAt: t0 - 5_000,
        lastPolledAt: t0,
        state: 'ready',
        seatLeaseId: 'lease-claim-5678',
        assignedSiteId: 'den-1',
        leaseExpiresAt: t0 + 20_000,
      },
      false,
    );
    const [a, b] = await twoInstances(db);
    const claim = await a.inject({
      method: 'POST',
      url: '/api/queue/claim',
      payload: { clientId: 'claimer', seatLeaseId: 'lease-claim-5678' },
    });
    expect(claim.statusCode).toBe(200);
    const heldSince = Number(db.raw('queue').find((q) => q.clientId === 'claimer')?.leaseExpiresAt) - 45_000;

    const heartbeat = (data: Data) =>
      db.write('sites', 'den-1', { id: 'den-1', state: 'live', phase: 'running', spectators: 0, ...data }, false);

    // A lagging heartbeat from before the grant (e.g. the player's previous run) is not proof.
    heartbeat({ drivers: 31, driverClientIds: ['claimer'], updatedAt: heldSince - 1_000 });
    await b.inject({ method: 'GET', url: '/api/network' });
    expect(db.col('queue').has('claimer')).toBe(true);

    // A heartbeat written after the grant that lists the driver releases the hold immediately.
    heartbeat({ drivers: 32, driverClientIds: ['claimer'], updatedAt: Date.now() });
    await b.inject({ method: 'GET', url: '/api/network' });
    expect(db.col('queue').has('claimer')).toBe(false);

    // The driver leaves well inside the 45 s window: the freed seat is admissible right away
    // rather than staying reserved for a hold that was already consumed.
    heartbeat({ drivers: 31, driverClientIds: [], updatedAt: Date.now() });
    const next = await b.inject({ method: 'POST', url: '/api/join', payload: { clientId: 'next', name: 'loadtest-next' } });
    expect(next.json().role).toBe('driver');

    await a.close();
    await b.close();
  });

  it('queue positions and totals come from the shared queue, not instance-local state', async () => {
    const db = new FakeFirestore();
    seedFullSites(db);
    const [a, b] = await twoInstances(db);
    const q1 = (await a.inject({ method: 'POST', url: '/api/join', payload: { clientId: 'q1', name: 'loadtest-q1' } })).json();
    const q2 = (await b.inject({ method: 'POST', url: '/api/join', payload: { clientId: 'q2', name: 'loadtest-q2' } })).json();
    expect(q1.queue).toMatchObject({ position: 1, totalQueued: 1 });
    expect(q2.queue).toMatchObject({ position: 2, totalQueued: 2 });
    const status = (await a.inject({ method: 'GET', url: '/api/queue/status?clientId=q2' })).json();
    expect(status).toMatchObject({ state: 'queued', position: 2, totalQueued: 2 });
    await a.close();
    await b.close();
  });

  it('an empty Firestore queue is authoritative (no stale instance-local fallback)', async () => {
    const db = new FakeFirestore();
    const storeA = new FirestoreLobbyStore(db as never, {});
    const storeB = new FirestoreLobbyStore(db as never, {});
    await storeA.setQueueEntry({
      clientId: 'gone',
      name: 'Gone',
      isBot: false,
      enqueuedAt: 1,
      lastPolledAt: 1,
      state: 'queued',
      seatLeaseId: 'lease-gone-1',
    });
    expect(await storeA.getQueueEntries()).toHaveLength(1);
    await storeB.deleteQueueEntry('gone');
    expect(await storeA.getQueueEntries()).toEqual([]);
  });

  it('a real Firestore queue error surfaces as 503 queue_unavailable', async () => {
    const db = new FakeFirestore();
    seedFullSites(db);
    const [a, b] = await twoInstances(db);
    db.failQueueReads = true;
    const res = await a.inject({ method: 'GET', url: '/api/queue/status?clientId=anyone' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('queue_unavailable');
    await a.close();
    await b.close();
  });
});

// ---------------------------------------------------------------------------
// 4. Dev HMAC secret
// ---------------------------------------------------------------------------

describe('ticket secret resolution', () => {
  const KEYS = ['TICKET_HMAC_SECRET', 'TICKET_HMAC_KEY', 'TICKET_SECRET', 'TICKET_HMAC_SECRET_NAME', 'K_SERVICE'];
  const saved: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('uses a random per-process dev secret locally (no committed literal) and refuses on Cloud Run', async () => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    const s1 = await resolveTicketSecret();
    const s2 = await resolveTicketSecret();
    expect(s1).toBe(s2);
    expect(s1.length).toBeGreaterThanOrEqual(32);
    expect(s1).not.toContain('dev-local');

    process.env.K_SERVICE = 'warehouse-lobby';
    await expect(resolveTicketSecret()).rejects.toThrow(/must be configured in Cloud Run/);
  });
});
