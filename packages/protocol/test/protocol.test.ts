import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_GEMINI_MODELS,
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
  BOARD_INTERVAL_MS,
  DeltaMessageSchema,
  HEAT_INTERVAL_MS,
  HEAT_MIN_VALUE,
  HeatLayerSchema,
  MAX_PATH_WAYPOINTS,
  SiteLimitsSchema,
  WelcomeMessageSchema,
} from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_PROTOCOL_PATH = resolve(__dirname, '../../../docs/protocol.md');

describe('@warehouse/protocol', () => {
  describe('Site IDs, Phases, and Difficulty', () => {
    it('validates all canonical site IDs and rejects unknown sites', () => {
      expect(SITE_IDS).toEqual(['den-1', 'slc-2', 'phx-3', 'abq-4']);
      expect(ALLOWED_GEMINI_MODELS).toEqual([
        'gemini-3.8-flash',
        'gemini-3.5-flash-lite',
        'gemini-4-argon',
      ]);
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
      { type: 'input' as const, up: true, down: false, left: false, right: false, boost: true, seq: 43 },
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
      { type: 'voteDifficulty' as const, level: 'medium' as const },
      { type: 'voteDifficulty' as const, level: 'turbo' as const },
      { type: 'voteDifficulty' as const, level: 3 },
      { type: 'nlCommand' as const, text: 'drop a cone at 10, 12' },
      { type: 'agentCommand' as const, text: 'clear P0s in Zone A and charge at 25%' },
      {
        type: 'agentCommand' as const,
        vid: 'FL-21',
        directive: {
          autopilot: true,
          strategy: 'Sprinter' as const,
          tactics: { speed: 1.25, chargeAt: 25, batch: 2 },
          focusZones: ['A', 'C'],
          focusBays: ['B1', 'E2'],
          priority: 'p0_first' as const,
          immediateTask: { kind: 'zone' as const, target: 'A' },
          summary: 'Clearing P0s in Zone A',
        },
      },
      { type: 'transferSite' as const, siteId: 'den-1' as const },
      { type: 'layers' as const, traffic: true },
      {
        type: 'a2uiAction' as const,
        screenId: 'scr-1',
        actionId: 'confirm',
        dispatch: { sourceZone: 'cold' as const, targetBay: 'E1' as const },
      },
      { type: 'setRunMode' as const, mode: 'blitz' as const },
      { type: 'setRunMode' as const, mode: 'freerange' as const },
      { type: 'acceptRelocation' as const, targetSite: 'slc-2' as const },
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
            autopilot: true,
            directive: {
              autopilot: true,
              strategy: 'Sprinter' as const,
              priority: 'p0_first' as const,
              summary: 'Prioritizing P0 orders',
            },
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
      {
        type: 'a2uiScreen' as const,
        screenId: 'scr-1',
        title: 'Route Freight',
        subtitle: 'Select zone and bay',
        telemetry: [{ id: 't1', label: 'Open', value: '4' }],
        selectors: [
          {
            field: 'sourceZone' as const,
            label: 'Zone',
            selected: 'cold',
            options: [{ value: 'cold', label: 'Cold' }],
          },
        ],
        presets: [{ id: 'p1', label: 'Cold -> E1', desc: 'Fast route' }],
        recommendedDispatch: { sourceZone: 'cold' as const, targetBay: 'E1' as const },
      },
      {
        type: 'relocationOffer' as const,
        fromSite: 'den-1' as const,
        targetSite: 'slc-2' as const,
        targetDrivers: 8,
        bonusPts: 75,
        expiresAt: 1760000030000,
        reason: 'Heavy floor traffic at DEN-1 (27 drivers). Relocate to SLC-2 (8 drivers) for +75 bonus pts!',
      },
      {
        type: 'relocateShard' as const,
        siteId: 'slc-2' as const,
        wsUrl: 'wss://warehouse-slc-2.example.com/ws',
        ticket: 'abc.def',
        bonusPts: 75,
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

    const fullVehicle = {
      id: 'FL-03',
      qx: quantiseCoord(4),
      qy: quantiseCoord(9),
      angle: 0,
      incidents: 2,
      nearMisses: 5,
      tactics: {
        speed: 1.1,
        respect: 0.7,
        buffer: 2,
        chargeAt: 25,
        batch: 2,
        flatPath: false,
        preemptForP0: true,
        poach: false,
        note: 'Balanced flow',
      },
      path: [4, 9, 5, 9, 6, 9],
      extra: false,
      decision: {
        kind: 'tactics' as const,
        model: 'gemini-3.8-flash',
        latencyMs: 412,
        reason: 'Balanced flow',
        t: 300.4,
      },
    };

    it('parses full deltas with typed stats (board/seriesAppend/history/hall/heat), own hand, and inspector vehicle detail', () => {
      const delta = {
        type: 'delta' as const,
        t: 300.5,
        vehicles: [fullVehicle],
        events: [],
        stats: {
          totals: { shipped: 10 },
          day: { shipped: 4 },
          shift: { shipped: 1 },
          shiftTime: 300.5,
          rushUntil: 0,
          board: [
            { strat: 'Greedy', vehicles: 3, count: 4, perHr: 2.1, onTimePct: 75, incidents: 1, kwhPerOrder: 0.42 },
            { strat: 'Human', vehicles: 0, count: 0, perHr: 0, onTimePct: null, incidents: 0, kwhPerOrder: null },
          ],
          seriesAppend: [{ t: 300, you: 0, avg: 38.5, best: 40 }],
          history: [
            {
              day: 1, shipped: 120, onTimePct: 88, incidents: 3, nearMisses: 7, lost: 0, damaged: 1, poaches: 2,
              per: { Greedy: { shipped: 40, onTimePct: 90, incidents: 1, kwhPerOrder: 0.4 } },
              winner: 'Greedy', tuned: {},
            },
          ],
          hall: [
            { shift: 'Day 1 · Shift A', id: 'FL-03', strat: 'Greedy', human: false, driver: 'FL-03', pts: 40, scored: 40, diff: 'normal' },
          ],
          heat: { w: 43, h: 60, cells: [[129, 0.5], [130, 33.2]] },
        },
        hands: {
          'client-1': { shift: 0, offer: null, cards: [] },
        },
      };
      const parsed = DeltaMessageSchema.parse(delta);
      expect(parsed.vehicles[0].decision?.model).toBe('gemini-3.8-flash');
      expect(parsed.stats?.heat?.cells).toHaveLength(2);
      expect(parsed.stats?.board?.[1].onTimePct).toBeNull();
      expect(parsed.hands?.['client-1']).toBeDefined();
      expect(ServerMessageSchema.safeParse(delta).success).toBe(true);
    });

    it('rejects malformed detail fields', () => {
      const base = { type: 'delta' as const, t: 1, vehicles: [fullVehicle], events: [] };
      const withVehicle = (patch: Record<string, unknown>) => ({
        ...base,
        vehicles: [{ ...fullVehicle, ...patch }],
      });
      expect(DeltaMessageSchema.safeParse(base).success).toBe(true);
      expect(
        DeltaMessageSchema.safeParse(withVehicle({ path: Array(MAX_PATH_WAYPOINTS * 2 + 2).fill(1) })).success,
      ).toBe(false);
      expect(DeltaMessageSchema.safeParse(withVehicle({ path: [1.5, 2] })).success).toBe(false);
      expect(
        DeltaMessageSchema.safeParse(withVehicle({ decision: { ...fullVehicle.decision, kind: 'vibes' } })).success,
      ).toBe(false);
      expect(
        DeltaMessageSchema.safeParse(withVehicle({ decision: { ...fullVehicle.decision, model: '' } })).success,
      ).toBe(false);
      expect(
        DeltaMessageSchema.safeParse(withVehicle({ decision: { ...fullVehicle.decision, latencyMs: -1 } })).success,
      ).toBe(false);
      expect(
        DeltaMessageSchema.safeParse({ ...base, stats: { heat: { w: 2, h: 2, cells: [[0.5, 1]] } } }).success,
      ).toBe(false);
      expect(HeatLayerSchema.safeParse({ w: 2, h: 2, cells: [[3, 1.2]] }).success).toBe(true);
    });

    it('parses welcome.limits and SiteStatus.maxDrivers', () => {
      const limits = {
        maxDrivers: 32,
        maxDriversPerClient: 2,
        fleetCap: 28,
        maxTier: 3,
        baseFleet: 14,
        tierStep: 4,
        minAutonomousAgents: 8,
        maxAutonomousAgents: 28,
      };
      expect(SiteLimitsSchema.parse(limits)).toEqual(limits);
      expect(SiteLimitsSchema.safeParse({ ...limits, maxDrivers: 0 }).success).toBe(false);
      const welcome = {
        type: 'welcome' as const,
        you: { clientId: 'c', playerId: 'P1', name: 'A', vid: null, siteId: 'den-1' as const, isBot: false },
        snapshot: { v: 5 },
        limits,
      };
      expect(WelcomeMessageSchema.parse(welcome).limits).toEqual(limits);

      const site = {
        id: 'den-1' as const,
        state: 'live' as const,
        drivers: 1,
        spectators: 0,
        tier: 0,
        shipped: 0,
        phase: 'running' as const,
        wsUrl: 'wss://x/ws',
        updatedAt: 1,
        maxDrivers: 32,
      };
      expect(SiteStatusSchema.parse(site).maxDrivers).toBe(32);
      expect(SiteStatusSchema.safeParse({ ...site, maxDrivers: 1.5 }).success).toBe(false);
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

      // UI-parity additions are documented
      for (const field of [
        'seriesAppend',
        'history',
        'hall',
        'heat',
        'board',
        'limits',
        'maxDrivers',
        'decision',
        'tactics',
        'path',
        'incidents',
        'nearMisses',
        'extra',
        'hands',
        'SiteLimitsSchema',
        'DeltaStatsSchema',
        'HeatLayerSchema',
        'VehicleDecisionSchema',
        'VehicleTacticsSchema',
      ]) {
        expect(doc).toContain(field);
      }
      for (const c of ['MAX_PATH_WAYPOINTS', 'HEAT_MIN_VALUE', 'HEAT_INTERVAL_MS', 'BOARD_INTERVAL_MS']) {
        expect(doc).toContain(c);
      }
      expect(doc).toContain(`HEAT_INTERVAL_MS = ${HEAT_INTERVAL_MS}`);
      expect(doc).toContain(`BOARD_INTERVAL_MS = ${BOARD_INTERVAL_MS}`);
      expect(doc).toContain(`MAX_PATH_WAYPOINTS = ${MAX_PATH_WAYPOINTS}`);
      expect(doc).toContain(`HEAT_MIN_VALUE = ${HEAT_MIN_VALUE}`);
    });
  });
});
