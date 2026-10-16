import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_MESSAGE_TYPES,
  ClientMessageSchema,
  ContractDecisionSchema,
  CardsDecisionSchema,
  DIFFICULTY_NAMES,
  DifficultyLevelSchema,
  GEMINI_RESPONSE_SCHEMAS,
  HazardDecisionSchema,
  JoinRequestSchema,
  JoinResponseSchema,
  LeaderboardEntrySchema,
  MANAGER_OPS,
  NL_ORDER_RESPONSE_SCHEMA,
  NetworkResponseSchema,
  NlOrderParseSchema,
  PHASES,
  PhaseSchema,
  SERVER_MESSAGE_TYPES,
  SITE_IDS,
  ServerMessageSchema,
  SiteIdSchema,
  SiteStatusSchema,
  TacticsDecisionSchema,
  TicketPayloadSchema,
  TransferSchema,
  dequantiseCoord,
  normaliseDifficultyKey,
  quantiseCoord,
  schemaForDecisionKind,
  signTicket,
  verifyTicket,
} from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_PROTOCOL_PATH = resolve(__dirname, '../../../docs/protocol.md');

describe('@warehouse/protocol', () => {
  describe('Site IDs, Phases, and Difficulty', () => {
    it('validates all canonical site IDs and rejects unknown sites', () => {
      expect(SITE_IDS).toEqual(['den-1', 'slc-2', 'phx-3', 'abq-4']);
      for (const id of SITE_IDS) {
        expect(SiteIdSchema.parse(id)).toBe(id);
      }
      expect(SiteIdSchema.safeParse('nyc-5').success).toBe(false);
    });

    it('validates all phases', () => {
      expect(PHASES).toEqual(['running', 'winding_down', 'break', 'resuming']);
      for (const p of PHASES) {
        expect(PhaseSchema.parse(p)).toBe(p);
      }
      expect(PhaseSchema.safeParse('paused').success).toBe(false);
    });

    it('validates numeric and string difficulty levels and normalises to sim keys', () => {
      for (const name of DIFFICULTY_NAMES) {
        expect(DifficultyLevelSchema.parse(name)).toBe(name);
      }
      for (const n of [1, 2, 3, 4, 5]) {
        expect(DifficultyLevelSchema.parse(n)).toBe(n);
      }
      expect(DifficultyLevelSchema.safeParse(0).success).toBe(false);
      expect(DifficultyLevelSchema.safeParse(6).success).toBe(false);
      expect(normaliseDifficultyKey('calm')).toBe('easy');
      expect(normaliseDifficultyKey(1)).toBe('easy');
      expect(normaliseDifficultyKey('normal')).toBe('normal');
      expect(normaliseDifficultyKey(2)).toBe('normal');
      expect(normaliseDifficultyKey('surge')).toBe('hard');
      expect(normaliseDifficultyKey('crisis')).toBe('hard');
      expect(normaliseDifficultyKey(4)).toBe('hard');
    });
  });

  describe('Coordinate Quantisation (1/32 tile precision)', () => {
    it('quantises and dequantises coordinates at 1/32 tile precision', () => {
      expect(quantiseCoord(0)).toBe(0);
      expect(quantiseCoord(1)).toBe(32);
      expect(quantiseCoord(10.5)).toBe(336);
      expect(dequantiseCoord(336)).toBe(10.5);

      for (const coord of [0, 0.5, 5.25, 12.125, 42.875, 59.5]) {
        const q = quantiseCoord(coord);
        expect(Number.isInteger(q)).toBe(true);
        expect(dequantiseCoord(q)).toBeCloseTo(coord, 5);
      }

      // Arbitrary float stays within 1/64 tile error
      const arbitrary = 17.3419;
      const roundTripped = dequantiseCoord(quantiseCoord(arbitrary));
      expect(Math.abs(roundTripped - arbitrary)).toBeLessThanOrEqual(1 / 64);
    });
  });

  describe('Lobby Schemas and HMAC Tickets', () => {
    it('round-trips JoinRequest and JoinResponse schemas', () => {
      const req = { name: 'Alice_01', clientId: 'client-uuid-12345678', prefer: 'den-1' as const };
      expect(JoinRequestSchema.parse(req)).toEqual(req);

      const res = {
        siteId: 'den-1' as const,
        wsUrl: 'wss://site-den-1.example.run.app/ws',
        ticket: 'eyJjbGllbnRJZCI6ImNsaWVudC0xIn0.sig',
        expiresAt: 1760000060000,
      };
      expect(JoinResponseSchema.parse(res)).toEqual(res);
    });

    it('round-trips SiteStatus, LeaderboardEntry, and NetworkResponse schemas', () => {
      const site = {
        id: 'slc-2' as const,
        state: 'live' as const,
        drivers: 14,
        spectators: 3,
        tier: 2,
        shipped: 420,
        phase: 'running' as const,
        wsUrl: 'wss://site-slc-2.example.run.app/ws',
        updatedAt: 1760000000000,
      };
      expect(SiteStatusSchema.parse(site)).toEqual(site);

      const lbEntry = {
        clientId: 'c-101',
        name: 'DriverOne',
        siteId: 'den-1' as const,
        points: 180,
        lifetimePoints: 1450,
        deliveries: 18,
        isBot: false,
      };
      expect(LeaderboardEntrySchema.parse(lbEntry)).toEqual(lbEntry);

      const net = { sites: [site], leaderboard: [lbEntry] };
      expect(NetworkResponseSchema.parse(net)).toEqual(net);
    });

    it('signs and verifies HMAC tickets and rejects tampered or expired tickets', () => {
      const secret = 'test-hmac-secret-key-32-bytes-long!!';
      const now = 1_760_000_000_000;
      const payload = TicketPayloadSchema.parse({
        clientId: 'client-abc-123',
        name: 'ForkliftAce',
        siteId: 'den-1',
        isBot: false,
        exp: now + 60_000,
      });

      const token = signTicket(payload, secret);
      const verified = verifyTicket(token, secret, now + 10_000);
      expect(verified).toEqual({ ok: true, payload });

      // Expired
      const expired = verifyTicket(token, secret, now + 61_000);
      expect(expired).toEqual({ ok: false, error: 'expired' });

      // Wrong secret
      const wrongSecret = verifyTicket(token, 'wrong-secret', now);
      expect(wrongSecret).toEqual({ ok: false, error: 'bad_signature' });

      // Tampered payload
      const [body, sig] = token.split('.');
      const tamperedBody = Buffer.from(JSON.stringify({ ...payload, siteId: 'phx-3' })).toString('base64url');
      expect(verifyTicket(`${tamperedBody}.${sig}`, secret, now)).toEqual({
        ok: false,
        error: 'bad_signature',
      });

      // Malformed
      expect(verifyTicket('not-a-valid-ticket', secret, now)).toEqual({
        ok: false,
        error: 'malformed',
      });
    });
  });

  describe('ClientMessageSchema round-trip validation', () => {
    const validClientMessages = [
      { type: 'hello' as const, ticket: 'abc.def' },
      { type: 'input' as const, up: true, down: false, left: false, right: true, seq: 42 },
      { type: 'interact' as const },
      { type: 'takeWheel' as const, vid: 'FL-01' },
      { type: 'release' as const },
      { type: 'manager' as const, op: 'rush' as const },
      { type: 'manager' as const, op: 'p0' as const },
      { type: 'manager' as const, op: 'cone' as const, x: 12, y: 20 },
      { type: 'manager' as const, op: 'fleetAdd' as const },
      { type: 'manager' as const, op: 'fleetRemove' as const },
      { type: 'keepCards' as const, ids: ['c1', 'c2'] },
      { type: 'voteDifficulty' as const, level: 'surge' as const },
      { type: 'voteDifficulty' as const, level: 3 },
      { type: 'nlCommand' as const, text: 'drop a cone at 10, 12' },
      { type: 'transferSite' as const, siteId: 'phx-3' as const },
    ];

    it('parses every valid ClientMessage variant', () => {
      const seenTypes = new Set<string>();
      for (const msg of validClientMessages) {
        const parsed = ClientMessageSchema.parse(msg);
        expect(parsed).toEqual(msg);
        seenTypes.add(parsed.type);
      }
      expect([...seenTypes].sort()).toEqual([...CLIENT_MESSAGE_TYPES].sort());
    });

    it('rejects unknown client message types', () => {
      expect(ClientMessageSchema.safeParse({ type: 'evalCode', code: 'alert(1)' }).success).toBe(false);
    });
  });

  describe('ServerMessageSchema round-trip validation', () => {
    const validServerMessages = [
      {
        type: 'welcome' as const,
        you: {
          clientId: 'client-1',
          playerId: 'P1',
          name: 'Alice',
          vid: 'FL-21',
          siteId: 'den-1' as const,
          isBot: false,
        },
        snapshot: { v: 5, t: 120.5, tier: 0 },
      },
      {
        type: 'delta' as const,
        t: 120.6,
        vehicles: [
          {
            id: 'FL-01',
            qx: quantiseCoord(10.5),
            qy: quantiseCoord(20.25),
            angle: 1.57,
            state: 'toPick',
            battery: 88,
          },
        ],
        orders: [{ id: 1001, bay: 'E1', state: 'open' }],
        hazards: [{ id: 1, x: 15, y: 11, until: 130 }],
        events: [{ t: 120.6, type: 'p0', text: 'P0 #1001 posted' }],
      },
      {
        type: 'ack' as const,
        seq: 42,
        x: 10.5,
        y: 20.25,
        vx: 1.2,
        vy: 0,
      },
      {
        type: 'presence' as const,
        players: [
          {
            clientId: 'client-1',
            playerId: 'P1',
            name: 'Alice',
            vid: 'FL-21',
            points: 50,
            score: 50,
            role: 'driver' as const,
            isBot: false,
          },
        ],
      },
      {
        type: 'brainHealth' as const,
        ok: true,
        model: 'gemini-3.8-flash',
        errors1m: 0,
        p50ms: 340,
        budgetLeftUsd: 23.45,
        armorBlocks1h: 2,
      },
      {
        type: 'phase' as const,
        phase: 'resuming' as const,
        resumesAt: 1760000010000,
        reason: 'Player connected',
      },
      {
        type: 'error' as const,
        code: 'armor_blocked',
        message: 'Order blocked by prompt armor.',
      },
      {
        type: 'commandEcho' as const,
        text: 'trigger a rush wave',
        parsed: { action: 'rush', echo: 'Rush wave triggered' },
        executed: true,
      },
    ];

    it('parses every valid ServerMessage variant', () => {
      const seenTypes = new Set<string>();
      for (const msg of validServerMessages) {
        const parsed = ServerMessageSchema.parse(msg);
        expect(parsed).toEqual(msg);
        seenTypes.add(parsed.type);
      }
      expect([...seenTypes].sort()).toEqual([...SERVER_MESSAGE_TYPES].sort());
    });
  });

  describe('Brain Decision & NlOrderParse Schemas', () => {
    it('validates ContractDecision, HazardDecision, TacticsDecision, and CardsDecision', () => {
      const contract = { orderIds: ['1001', '1004'], reason: 'Both bound for bay E2 with tight slack.' };
      expect(ContractDecisionSchema.parse(contract)).toEqual(contract);

      const hazard = { choice: 'reroute' as const, reason: 'Carrying P0 cargo; avoiding 30% skid risk.' };
      expect(HazardDecisionSchema.parse(hazard)).toEqual(hazard);

      const tactics = {
        speed: 1.15,
        buffer: 2,
        respect: 0.85,
        chargeAt: 20,
        batch: 2,
        note: 'Increasing speed slightly to catch shift median.',
      };
      expect(TacticsDecisionSchema.parse(tactics)).toEqual(tactics);

      const cards = { keep: ['c1', 'c3'], reason: 'Route card matches cold storage zone.' };
      expect(CardsDecisionSchema.parse(cards)).toEqual(cards);

      for (const kind of ['contract', 'hazard', 'tactics', 'cards'] as const) {
        expect(schemaForDecisionKind(kind)).toBe(GEMINI_RESPONSE_SCHEMAS[kind]);
        expect(schemaForDecisionKind(kind).type).toBe('OBJECT');
      }
      expect(NL_ORDER_RESPONSE_SCHEMA.type).toBe('OBJECT');
    });

    it('validates NlOrderParseSchema for valid manager commands and refusals, and rejects illegal actions', () => {
      for (const op of MANAGER_OPS) {
        const sample =
          op === 'cone'
            ? { action: op, x: 10, y: 12, echo: 'Cone at (10, 12)' }
            : { action: op, echo: `Action ${op}` };
        expect(NlOrderParseSchema.parse(sample)).toEqual(sample);
      }

      // Cone missing x/y must fail
      expect(NlOrderParseSchema.safeParse({ action: 'cone', echo: 'Missing coords' }).success).toBe(false);

      // Refusal with action: 'refuse'
      const refusal = { action: 'refuse' as const, refuse: 'Cannot change shift difficulty by voice/text.' };
      expect(NlOrderParseSchema.parse(refusal)).toEqual(refusal);

      // Simple { refuse: reason } object transforms to canonical refusal
      expect(NlOrderParseSchema.parse({ refuse: 'Out of scope' })).toEqual({
        action: 'refuse',
        refuse: 'Out of scope',
      });

      // Extra unknown fields or invalid action must fail
      expect(
        NlOrderParseSchema.safeParse({ action: 'rush', extraField: 'hacked' }).success,
      ).toBe(false);
      expect(
        NlOrderParseSchema.safeParse({ action: 'grantAdmin' }).success,
      ).toBe(false);
    });
  });

  describe('TransferSchema', () => {
    it('round-trips cross-site Transfer payloads', () => {
      const xfer = {
        id: 'xfer-den-1-1042',
        fromSite: 'den-1' as const,
        toSite: 'slc-2' as const,
        orderRef: '1042',
        sku: 'PALLET-COLD-09',
        value: 25,
        shippedAt: 1760000000000,
        carrier: 'FL-04',
      };
      expect(TransferSchema.parse(xfer)).toEqual(xfer);
    });
  });

  describe('Doc Parity with docs/protocol.md', () => {
    it('verifies every HTTP endpoint, ClientMessage type, ServerMessage type, and Transfer field in docs/protocol.md matches @warehouse/protocol', () => {
      const doc = readFileSync(DOCS_PROTOCOL_PATH, 'utf8');

      // HTTP endpoints
      expect(doc).toContain('POST /api/join');
      expect(doc).toContain('GET /api/network');
      expect(doc).toContain('JoinRequestSchema');
      expect(doc).toContain('JoinResponseSchema');
      expect(doc).toContain('NetworkResponseSchema');
      expect(doc).toContain('TransferSchema');

      // Extract `{ type: '...'` from the ClientMessage and ServerMessage union code blocks
      const typeLiteralRegex = /\|\s*\{\s*type:\s*'([a-zA-Z0-9_]+)'/g;
      const documentedTypes: string[] = [];
      let match: RegExpExecArray | null;
      while ((match = typeLiteralRegex.exec(doc)) !== null) {
        documentedTypes.push(match[1]);
      }

      const allSchemaTypes = [...CLIENT_MESSAGE_TYPES, ...SERVER_MESSAGE_TYPES];
      expect(documentedTypes.sort()).toEqual(allSchemaTypes.sort());

      // Every site ID is documented
      for (const siteId of SITE_IDS) {
        expect(doc).toContain(`'${siteId}'`);
      }

      // Every phase is documented
      for (const phase of PHASES) {
        expect(doc).toContain(`'${phase}'`);
      }

      // Every manager op is documented
      for (const op of MANAGER_OPS) {
        expect(doc).toContain(`'${op}'`);
      }
    });
  });
});
