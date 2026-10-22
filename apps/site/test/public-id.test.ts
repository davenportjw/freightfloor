import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { signTicket, type ServerMessage } from '@warehouse/protocol';
import { createWorld, serialize, type SimEvent } from '@warehouse/sim';
import {
  DEFAULT_TICKET_SECRET,
  createSiteServer,
  type BrainModelClient,
  type SiteServerInstance,
} from '../src/index.js';
import {
  PUBLIC_ID_PATTERN,
  createPublicIdMapper,
  publicIdFor,
  publicizeEvents,
  publicizeSnapshot,
} from '../src/public-id.js';

/**
 * Raw clientIds are bearer credentials at the lobby (`/api/queue/claim`, own-clientId joins), so
 * the site must never send them to clients. Every site → client payload carries the opaque
 * `publicId` (HMAC of the clientId) instead.
 */

const pid = (id: string) => publicIdFor(id, DEFAULT_TICKET_SECRET);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('publicIdFor', () => {
  it('is deterministic, opaque, secret-bound, and matches the lobby derivation vector', () => {
    const a = publicIdFor('client-alpha-123', 'secret-one');
    expect(a).toMatch(PUBLIC_ID_PATTERN);
    expect(publicIdFor('client-alpha-123', 'secret-one')).toBe(a);
    expect(publicIdFor('client-alpha-123', 'secret-two')).not.toBe(a);
    expect(publicIdFor('client-alpha-124', 'secret-one')).not.toBe(a);
    expect(a).not.toContain('client-alpha');
    // Shared known-answer vector (also asserted in apps/lobby/test/security.test.ts).
    expect(publicIdFor('vector-client', 'vector-secret')).toBe(PUBLIC_ID_VECTOR);
    const mapper = createPublicIdMapper('secret-one');
    expect(mapper('client-alpha-123')).toBe(a);
  });
});

// HMAC-SHA256("vector-secret", "warehouse-public:v1:vector-client") → base64url[0..22].
const PUBLIC_ID_VECTOR = 'p1_eak1foHd37nBA3DRKHmMAt';

describe('publicizeEvents / publicizeSnapshot', () => {
  it('hashes clientId fields and non-vehicle poach owners; leaves vehicle ids alone', () => {
    const map = createPublicIdMapper('s');
    const isClient = (k: string) => k !== 'FL-01';
    const events: SimEvent[] = [
      { t: 1, type: 'drive', text: 'x', vid: 'DRV-1', clientId: 'raw-a' },
      { t: 2, type: 'poach', text: 'y', vid: 'FL-02', owner: 'raw-b', cardId: 'c1' },
      { t: 3, type: 'poach', text: 'z', vid: 'DRV-1', owner: 'FL-01', cardId: 'c2' },
      { t: 4, type: 'note', text: 'w' },
    ];
    const out = publicizeEvents(events, map, isClient);
    expect(out[0].clientId).toBe(map('raw-a'));
    expect(out[1].owner).toBe(map('raw-b'));
    expect(out[2].owner).toBe('FL-01');
    expect(out[3]).toBe(events[3]);
    expect(events[0].clientId).toBe('raw-a'); // input not mutated
  });

  it('maps every clientId-bearing snapshot field without mutating the world', () => {
    const world = createWorld('den-1');
    const v = world.vehicles[0];
    v.ownerClientId = 'raw-owner';
    v.controlledByClientId = 'raw-owner';
    world.players.set('raw-owner', {
      clientId: 'raw-owner',
      name: 'Owner',
      opaqueId: 'P1',
      dedicatedVehicleId: v.id,
      controlledVehicleId: v.id,
      isBot: false,
    });
    world.difficultyVotes['raw-owner'] = 'normal' as never;
    world.cards['raw-owner'] = { shift: 1, offer: null, cards: [] };
    world.completedRuns = [
      { id: 'r', vehicleId: v.id, clientId: 'raw-owner', driver: 'Owner · Run 1', baseName: 'Owner', runNumber: 1 } as never,
    ];
    const map = createPublicIdMapper('s');
    const snap = publicizeSnapshot(serialize(world), map, (k) => !world.vehicles.some((x) => x.id === k));
    const json = JSON.stringify(snap);
    expect(json).not.toContain('raw-owner');
    expect(snap.vehicles[0].ownerClientId).toBe(map('raw-owner'));
    expect(snap.vehicles[0].controlledByClientId).toBe(map('raw-owner'));
    expect(snap.players[0][0]).toBe(map('raw-owner'));
    expect(snap.players[0][1].clientId).toBe(map('raw-owner'));
    expect(Object.keys(snap.difficultyVotes)).toEqual([map('raw-owner')]);
    expect(snap.cards[map('raw-owner')]).toBeDefined();
    expect(snap.completedRuns?.[0].clientId).toBe(map('raw-owner'));
    // World state keeps raw ids.
    expect(world.vehicles[0].ownerClientId).toBe('raw-owner');
    expect(world.cards['raw-owner']).toBeDefined();
  });
});

describe('site → client wire never carries raw clientIds', () => {
  const servers: SiteServerInstance[] = [];
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.close();
    for (const s of servers.splice(0)) await s.close().catch(() => undefined);
  });

  const brain: BrainModelClient = {
    async generateDecision() {
      return { text: JSON.stringify({ speed: 1, buffer: 2, respect: 0.6, chargeAt: 20, batch: 1, note: 'ok', reason: 'ok' }), tokensIn: 1, tokensOut: 1 };
    },
  };

  async function connect(wsUrl: string, clientId: string, name: string) {
    const ticket = signTicket(
      { clientId, siteId: 'den-1', name, exp: Date.now() + 60_000, isBot: false },
      DEFAULT_TICKET_SECRET,
    );
    const ws = new WebSocket(`${wsUrl}?ticket=${encodeURIComponent(ticket)}`);
    sockets.push(ws);
    const raw: string[] = [];
    ws.on('message', (d) => raw.push(d.toString('utf8')));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const parsed = () => raw.map((r) => JSON.parse(r) as ServerMessage);
    const deadline = Date.now() + 3000;
    while (!parsed().some((m) => m.type === 'welcome')) {
      if (Date.now() > deadline) throw new Error('no welcome');
      await sleep(10);
    }
    return { ws, raw, parsed };
  }

  it('presence, welcome, votes, hands, events and completed runs use publicIds', async () => {
    const server = await createSiteServer({
      siteId: 'den-1',
      seed: 11,
      initialAgents: 6,
      enableIntervals: false,
      brainClient: brain,
    });
    servers.push(server);
    const addr = await server.app.listen({ port: 0, host: '127.0.0.1' });
    const wsUrl = addr.replace(/^http/, 'ws') + '/ws';

    const alphaId = 'secret-alpha-client-0001';
    const bravoId = 'secret-bravo-client-0002';
    const alpha = await connect(wsUrl, alphaId, 'Alpha');
    const bravo = await connect(wsUrl, bravoId, 'Bravo');

    alpha.ws.send(JSON.stringify({ type: 'voteDifficulty', level: 3 }));
    await sleep(50);
    await server.stepTick(Date.now());
    const deadline = Date.now() + 3000;
    while (!bravo.parsed().some((m) => m.type === 'delta' && (m as { votes?: object }).votes)) {
      if (Date.now() > deadline) throw new Error('no full delta');
      await server.stepTick(Date.now());
      await sleep(20);
    }
    // Wait for presence with both players.
    while (
      !bravo
        .parsed()
        .some((m) => m.type === 'presence' && m.players.some((p) => p.clientId === pid(alphaId)))
    ) {
      if (Date.now() > deadline) throw new Error('no presence');
      await sleep(10);
    }

    // The sim still keys everything by raw clientId internally.
    expect(server.world.players.has(alphaId)).toBe(true);
    expect(server.world.difficultyVotes[alphaId]).toBeDefined();

    // Nothing Bravo receives contains either raw clientId.
    for (const r of bravo.raw) {
      expect(r).not.toContain(alphaId);
      expect(r).not.toContain(bravoId);
    }
    for (const r of alpha.raw) {
      expect(r).not.toContain(alphaId);
      expect(r).not.toContain(bravoId);
    }

    const welcome = bravo.parsed().find((m) => m.type === 'welcome') as Extract<ServerMessage, { type: 'welcome' }>;
    expect(welcome.you.clientId).toBe(pid(bravoId));
    const snapVehicles = welcome.snapshot.vehicles as Array<{ ownerClientId?: string | null }>;
    expect(snapVehicles.some((v) => v.ownerClientId === pid(alphaId))).toBe(true);

    const fullDelta = bravo
      .parsed()
      .filter((m): m is Extract<ServerMessage, { type: 'delta' }> => m.type === 'delta')
      .find((m) => m.votes)!;
    expect(Object.keys(fullDelta.votes ?? {})).toContain(pid(alphaId));
    expect(Object.keys(fullDelta.hands ?? {})).toEqual([pid(bravoId)]);
  });
});
