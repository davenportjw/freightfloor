import { describe, expect, it } from 'vitest';
import {
  AGENT_COMMAND_RESPONSE_SCHEMA,
  AgentCommandMessageSchema,
  AgentDirectiveSchema,
  AgentPrioritySchema,
  ClientMessageSchema,
  CommandEchoMessageSchema,
  ImmediateTaskKindSchema,
  PartialVehicleTacticsSchema,
  QuantisedVehicleDeltaSchema,
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
