import { describe, expect, it } from 'vitest';
import {
  AGENT_COMMAND_RESPONSE_SCHEMA,
  AgentCommandMessageSchema,
  AgentDirectiveSchema,
  AgentPrioritySchema,
  BASE_SITE_IDS,
  ClientMessageSchema,
  CommandEchoMessageSchema,
  EvictionReasonSchema,
  ExtendedJoinResponseSchema,
  getCanonicalBaseSiteId,
  getOverflowSiteIds,
  getRegionPrefix,
  ImmediateTaskKindSchema,
  isValidSiteId,
  JoinRequestSchema,
  JoinResponseSchema,
  NetworkResponseSchema,
  OVERFLOW_SITE_IDS,
  PartialVehicleTacticsSchema,
  QuantisedVehicleDeltaSchema,
  QueueStatusSchema,
  RunEvictedMessageSchema,
  ServerMessageSchema,
  signTicket,
  SITE_IDS,
  SiteIdSchema,
  TicketPayloadSchema,
  verifyTicket,
} from '../src/index.js';

describe('@warehouse/protocol Co-Pilot & AgentDirective schemas', () => {
  it('accepts valid AgentCommandMessage with text only', () => {
    const msg = {
      type: 'agentCommand' as const,
      text: 'Focus on Zone A P0 orders and charge at 25%',
    };
    expect(AgentCommandMessageSchema.parse(msg)).toEqual(msg);
    expect(ClientMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts valid AgentCommandMessage with directive only', () => {
    const msg = {
      type: 'agentCommand' as const,
      vid: 'FL-02',
      directive: {
        autopilot: true,
        strategy: 'Sprinter' as const,
        tactics: {
          speed: 1.3,
          respect: 0.75,
          buffer: 2,
          chargeAt: 22,
          batch: 2,
          flatPath: 0.8,
          preemptForP0: true,
          poach: false,
          note: 'Fast P0 runner',
        },
        focusZones: ['A', 'C'],
        focusBays: ['B1', 'B4'],
        priority: 'p0_first' as const,
        immediateTask: {
          kind: 'zone' as const,
          target: 'A',
        },
        summary: 'Sprinter on Zone A/C P0s',
      },
    };
    expect(AgentCommandMessageSchema.parse(msg)).toEqual(msg);
    expect(ClientMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts valid AgentCommandMessage with both text and directive', () => {
    const msg = {
      type: 'agentCommand' as const,
      vid: 'FL-01',
      text: 'Go charge right now',
      directive: {
        autopilot: true,
        immediateTask: { kind: 'charge' as const },
        summary: 'Heading to nearest charger',
      },
    };
    expect(AgentCommandMessageSchema.parse(msg)).toEqual(msg);
  });

  it('rejects empty AgentCommandMessage without text or directive', () => {
    expect(AgentCommandMessageSchema.safeParse({ type: 'agentCommand' }).success).toBe(false);
    expect(AgentCommandMessageSchema.safeParse({ type: 'agentCommand', text: '   ' }).success).toBe(
      false,
    );
  });

  it('rejects out-of-range tactics values and invalid zones/bays/strategies', () => {
    expect(PartialVehicleTacticsSchema.safeParse({ speed: 0.2 }).success).toBe(false);
    expect(PartialVehicleTacticsSchema.safeParse({ speed: 1.9 }).success).toBe(false);
    expect(PartialVehicleTacticsSchema.safeParse({ respect: 0.1 }).success).toBe(false);
    expect(PartialVehicleTacticsSchema.safeParse({ buffer: 0 }).success).toBe(false);
    expect(PartialVehicleTacticsSchema.safeParse({ buffer: 5 }).success).toBe(false);
    expect(PartialVehicleTacticsSchema.safeParse({ chargeAt: 2 }).success).toBe(false);
    expect(PartialVehicleTacticsSchema.safeParse({ chargeAt: 60 }).success).toBe(false);
    expect(PartialVehicleTacticsSchema.safeParse({ batch: 4 }).success).toBe(false);

    expect(AgentDirectiveSchema.safeParse({ focusZones: ['AA'] }).success).toBe(false);
    expect(AgentDirectiveSchema.safeParse({ focusZones: ['a'] }).success).toBe(false);
    expect(
      AgentDirectiveSchema.safeParse({ focusZones: ['A', 'B', 'C', 'D', 'E', 'F', 'G'] }).success,
    ).toBe(false);
    expect(AgentDirectiveSchema.safeParse({ focusBays: ['BAY1'] }).success).toBe(false);
    expect(AgentDirectiveSchema.safeParse({ strategy: 'Rogue' }).success).toBe(false);
    expect(AgentPrioritySchema.safeParse('invalid_priority').success).toBe(false);
    expect(ImmediateTaskKindSchema.safeParse('explode').success).toBe(false);
  });

  it('validates QuantisedVehicleDeltaSchema with autopilot and directive', () => {
    const delta = {
      id: 'FL-05',
      qx: 320,
      qy: 640,
      human: true,
      autopilot: true,
      directive: {
        autopilot: true,
        strategy: 'Batcher' as const,
        priority: 'transfers_first' as const,
        focusZones: ['B'],
        focusBays: ['B2'],
        summary: 'Batching transfers from Zone B',
      },
    };
    expect(QuantisedVehicleDeltaSchema.parse(delta)).toEqual(delta);
  });

  it('validates CommandEchoMessageSchema with directive and status', () => {
    const echo = {
      type: 'commandEcho' as const,
      text: 'focus on zone A',
      status: 'executed' as const,
      summary: 'Focusing on Zone A',
      directive: {
        autopilot: true,
        focusZones: ['A'],
        summary: 'Focusing on Zone A',
      },
    };
    expect(CommandEchoMessageSchema.parse(echo)).toEqual(echo);
  });

  it('exports AGENT_COMMAND_RESPONSE_SCHEMA for Gemini structured output', () => {
    expect(AGENT_COMMAND_RESPONSE_SCHEMA.type).toBe('OBJECT');
    expect(AGENT_COMMAND_RESPONSE_SCHEMA.required).toContain('summary');
    expect(AGENT_COMMAND_RESPONSE_SCHEMA.properties.strategy.enum).toEqual([
      'Sprinter',
      'Batcher',
      'Steady',
      'Opportunist',
      'Strategist',
    ]);
  });
});

describe('@warehouse/protocol Stage 1: Regional Shards, Queue, Ticket & Eviction Schemas', () => {
  it('validates canonical and overflow regional site IDs and rejects malformed IDs', () => {
    expect(BASE_SITE_IDS).toEqual(['den-1', 'slc-2', 'phx-3', 'abq-4']);
    expect(SITE_IDS).toBe(BASE_SITE_IDS);
    expect(OVERFLOW_SITE_IDS).toEqual([
      'den-2', 'den-3', 'den-4', 'den-5',
      'slc-3', 'slc-4', 'slc-5',
      'phx-4', 'phx-5',
      'abq-5', 'abq-6',
    ]);
    expect(getOverflowSiteIds(5)).toContain('den-2');
    expect(getOverflowSiteIds(5)).toContain('slc-3');

    for (const validId of ['den-1', 'den-2', 'slc-2', 'slc-3', 'phx-3', 'phx-4', 'abq-4', 'abq-6']) {
      expect(SiteIdSchema.parse(validId)).toBe(validId);
      expect(isValidSiteId(validId)).toBe(true);
    }

    for (const invalidId of ['den-0', 'nyc-1', 'den-', '', 'den-01', 'slc--2']) {
      expect(SiteIdSchema.safeParse(invalidId).success).toBe(false);
      expect(isValidSiteId(invalidId)).toBe(false);
    }
  });

  it('extracts region prefixes and maps overflow IDs to canonical base site IDs', () => {
    expect(getRegionPrefix('den-2')).toBe('den');
    expect(getRegionPrefix('slc-3')).toBe('slc');
    expect(getRegionPrefix('phx-4')).toBe('phx');
    expect(getRegionPrefix('abq-5')).toBe('abq');
    expect(getRegionPrefix('unknown-9')).toBe('den');

    expect(getCanonicalBaseSiteId('den-1')).toBe('den-1');
    expect(getCanonicalBaseSiteId('den-4')).toBe('den-1');
    expect(getCanonicalBaseSiteId('slc-3')).toBe('slc-2');
    expect(getCanonicalBaseSiteId('phx-5')).toBe('phx-3');
    expect(getCanonicalBaseSiteId('abq-6')).toBe('abq-4');
    expect(getCanonicalBaseSiteId('invalid')).toBe('den-1');
  });

  it('signs and verifies TicketPayloadSchema with role, 4-char jti, 4-char seatLeaseId, and overflow siteId', () => {
    const secret = 'stage1-ticket-secret-key-32bytes';
    const now = 1_750_000_000_000;
    const payload = {
      clientId: 'client-overflow-99',
      name: 'AdaShard',
      siteId: 'den-2',
      isBot: false,
      exp: now + 30_000,
      runMode: 'freerange' as const,
      role: 'driver' as const,
      jti: 'jti1',
      seatLeaseId: 'ls01',
    };
    expect(TicketPayloadSchema.parse(payload)).toEqual(payload);
    const token = signTicket(payload, secret);
    const verified = verifyTicket(token, secret, now + 1000);
    expect(verified).toEqual({ ok: true, payload });
  });

  it('validates QueueStatusSchema, JoinRequestSchema, JoinResponseSchema, and NetworkResponseSchema extensions', () => {
    const req = {
      clientId: 'client-queue-01',
      name: 'QueuedDriver',
      prefer: 'slc-3',
      mode: 'blitz' as const,
      requeue: true,
      seatLeaseId: 'ls01',
      spectateOnly: false,
    };
    expect(JoinRequestSchema.parse(req)).toEqual(req);

    for (const state of ['none', 'queued', 'ready', 'expired'] as const) {
      expect(
        QueueStatusSchema.parse({
          state,
          position: 1,
          totalQueued: 4,
          estimatedWaitSec: 12,
        }).state,
      ).toBe(state);
    }

    const queueStatus = {
      state: 'ready' as const,
      position: 0,
      totalQueued: 4,
      estimatedWaitSec: 12,
      preferredSite: 'slc-3',
      seatLeaseId: 'ls01',
      claimExpiresAt: 1_750_000_030_000,
      claimSiteId: 'den-2',
      claimTicket: 'body.sig',
      claimWsUrl: 'wss://site-den-2.example.run.app/ws',
    };
    expect(QueueStatusSchema.parse(queueStatus)).toEqual(queueStatus);

    const joinRes = {
      siteId: 'den-2',
      wsUrl: 'wss://site-den-2.example.run.app/ws',
      ticket: 'body.sig',
      expiresAt: 1_750_000_030_000,
      name: 'QueuedDriver',
      clientId: 'client-queue-01',
      queue: queueStatus,
    };
    expect(JoinResponseSchema.parse(joinRes)).toEqual(joinRes);
    expect(ExtendedJoinResponseSchema.parse(joinRes)).toEqual(joinRes);

    const netRes = {
      sites: [
        {
          id: 'den-2',
          state: 'live' as const,
          drivers: 28,
          spectators: 5,
          tier: 2,
          shipped: 140,
          phase: 'running' as const,
          maxDrivers: 30,
        },
      ],
      leaderboard: [],
      queueSize: 7,
      maxTotalDrivers: 360,
      maxWarehouses: 12,
    };
    expect(NetworkResponseSchema.parse(netRes)).toEqual(netRes);
  });

  it('parses RunEvictedMessageSchema and ServerMessageSchema with all eviction reasons', () => {
    const reasons = [
      'run_complete',
      'idle_timeout',
      'session_lease_expired',
      'hard_cap_timeout',
      'zero_deliveries_timeout',
    ] as const;
    for (const reason of reasons) {
      expect(EvictionReasonSchema.parse(reason)).toBe(reason);
      const msg = {
        type: 'runEvicted' as const,
        vid: 14,
        reason,
        pts: 245,
        shipped: 9,
        incidents: 1,
        bestStreak: 6,
        runMode: 'freerange' as const,
      };
      expect(RunEvictedMessageSchema.parse(msg)).toEqual(msg);
      expect(ServerMessageSchema.parse(msg)).toEqual(msg);

      const strVidMsg = {
        ...msg,
        vid: 'DRV-01',
      };
      expect(RunEvictedMessageSchema.parse(strVidMsg)).toEqual(strVidMsg);
      expect(ServerMessageSchema.parse(strVidMsg)).toEqual(strVidMsg);
    }

    expect(
      RunEvictedMessageSchema.safeParse({
        type: 'runEvicted',
        vid: -1,
        reason: 'idle_timeout',
        pts: 0,
        shipped: 0,
        incidents: 0,
        bestStreak: 0,
        runMode: 'blitz',
      }).success,
    ).toBe(false);

    expect(
      RunEvictedMessageSchema.safeParse({
        type: 'runEvicted',
        vid: '',
        reason: 'idle_timeout',
        pts: 0,
        shipped: 0,
        incidents: 0,
        bestStreak: 0,
        runMode: 'blitz',
      }).success,
    ).toBe(false);
  });
});
