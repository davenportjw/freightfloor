import { describe, expect, it, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import {
  signTicket,
  type ServerMessage,
} from '@warehouse/protocol';
import {
  createWorld,
  applyAgentDirective,
  emitContractRequestIfNeeded,
  postOrder,
} from '@warehouse/sim';
import {
  createSiteServer,
  DEFAULT_TICKET_SECRET,
  renderDecisionPrompt,
  validateParsedAgentCommand,
  type SiteServerInstance,
  type ModelArmorClient,
  type NlOrderParserClient,
} from '../src/index.js';

interface WsClientHelper {
  ws: WebSocket;
  messages: ServerMessage[];
  waitForType: <T extends ServerMessage['type']>(
    type: T,
    timeoutMs?: number,
  ) => Promise<Extract<ServerMessage, { type: T }>>;
  send: (msg: unknown) => void;
  close: () => Promise<void>;
}

async function connectWsClient(url: string): Promise<WsClientHelper> {
  const messages: ServerMessage[] = [];
  const listeners: Array<(msg: ServerMessage) => void> = [];
  const ws = new WebSocket(url);

  ws.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString('utf8')) as ServerMessage;
      messages.push(parsed);
      for (const l of [...listeners]) {
        l(parsed);
      }
    } catch {
      // ignore
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (err) => reject(err));
  });

  return {
    ws,
    messages,
    waitForType<T extends ServerMessage['type']>(
      type: T,
      timeoutMs = 3000,
    ): Promise<Extract<ServerMessage, { type: T }>> {
      const existing = messages.find((m) => m.type === type) as
        | Extract<ServerMessage, { type: T }>
        | undefined;
      if (existing) {
        const idx = messages.indexOf(existing);
        if (idx >= 0) messages.splice(idx, 1);
        return Promise.resolve(existing);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for message type "${type}"`));
        }, timeoutMs);
        const onMsg = (m: ServerMessage) => {
          if (m.type === type) {
            clearTimeout(timer);
            const lIdx = listeners.indexOf(onMsg);
            if (lIdx >= 0) listeners.splice(lIdx, 1);
            const mIdx = messages.indexOf(m);
            if (mIdx >= 0) messages.splice(mIdx, 1);
            resolve(m as Extract<ServerMessage, { type: T }>);
          }
        };
        listeners.push(onMsg);
      });
    },
    send(msg: unknown) {
      ws.send(JSON.stringify(msg));
    },
    async close() {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    },
  };
}

describe('Co-Pilot & Agent Designer (@warehouse/site)', () => {
  let server: SiteServerInstance | null = null;
  const openClients: WsClientHelper[] = [];

  afterEach(async () => {
    for (const c of openClients.splice(0)) {
      await c.close();
    }
    if (server) {
      await server.close();
      server = null;
    }
  });

  it('validates parsed agent command JSON and rejects refusals or out-of-range tactics', () => {
    const valid = validateParsedAgentCommand(
      JSON.stringify({
        action: 'apply',
        persona: 'Sprinter',
        priority: 'p0_first',
        preferredZone: 'z',
        preferredBay: 'ret',
        immediateTask: 'pick_hazmat',
        tactics: { speed: 1.2, chargeAt: 25, preemptForP0: true },
        echo: 'Sprinter Co-Pilot: Hazmat P0 priority to Returns',
      }),
    );
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.action).toBe('apply');
      expect(valid.directive?.persona).toBe('Sprinter');
      expect(valid.directive?.priority).toBe('p0_first');
      expect(valid.directive?.preferredZone).toBe('Z');
      expect(valid.directive?.preferredBay).toBe('RET');
      expect(valid.directive?.tactics?.speed).toBe(1.2);
    }

    const refused = validateParsedAgentCommand(
      JSON.stringify({
        action: 'refuse',
        refuse: 'Cannot modify global leaderboard scores.',
      }),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe('parse_refused');
    }

    const badTactics = validateParsedAgentCommand(
      JSON.stringify({
        action: 'apply',
        tactics: { speed: 9.9 },
        echo: 'Overclock speed',
      }),
    );
    expect(badTactics.ok).toBe(false);
    if (!badTactics.ok) {
      expect(badTactics.code).toBe('parse_invalid');
    }
  });

  it('applies structured Agent Designer directives, engages Co-Pilot across input lease expiry, and pauses on manual WASD key press', async () => {
    const cleanArmor: ModelArmorClient = {
      sanitizeUserPrompt: async () => ({ flagged: false }),
      sanitizeModelResponse: async () => ({ flagged: false }),
    };
    const parserStub: NlOrderParserClient = {
      parseOrder: async () => ({
        text: JSON.stringify({ action: 'rush', echo: 'Rush' }),
        tokensIn: 20,
        tokensOut: 10,
      }),
      parseAgentCommand: async () => ({
        text: JSON.stringify({
          action: 'apply',
          persona: 'Batcher',
          priority: 'zone_focus',
          preferredZone: 'W',
          preferredBay: 'E2',
          tactics: { speed: 1.15, batch: 2, chargeAt: 30 },
          echo: 'Co-Pilot Batcher: Cold Storage (Zone W) to Bay E2',
        }),
        tokensIn: 35,
        tokensOut: 22,
      }),
    };

    server = await createSiteServer({
      siteId: 'den-1',
      seed: 42,
      armorClient: cleanArmor,
      nlParser: parserStub,
      brainClient: {
        generateDecision: async () => ({
          text: JSON.stringify({ action: 'hold', reason: 'Hold position' }),
          tokensIn: 25,
          tokensOut: 10,
        }),
      },
      inputLeaseMs: 500,
    });
    const addr = await server.app.listen({ port: 0, host: '127.0.0.1' });
    const wsUrl = addr.replace(/^http/, 'ws') + '/ws';

    const ticket = signTicket(
      {
        clientId: 'client-copilot-1',
        name: 'PilotOne',
        siteId: 'den-1',
        iat: Date.now(),
        exp: Date.now() + 60_000,
        nonce: 'nonce-cp-1',
        isBot: false,
      },
      DEFAULT_TICKET_SECRET,
    );

    const client = await connectWsClient(`${wsUrl}?ticket=${encodeURIComponent(ticket)}`);
    openClients.push(client);

    const welcome = await client.waitForType('welcome');
    expect(welcome.you.role).toBe('driver');
    const vid = welcome.you.vid!;
    expect(vid).toBeTruthy();

    // 1. Send structured Agent Designer directive
    client.send({
      type: 'agentCommand',
      vid,
      mode: 'autopilot',
      directive: {
        persona: 'Sprinter',
        priority: 'p0_first',
        preferredZone: 'Z',
        preferredBay: 'RET',
        tactics: {
          speed: 1.2,
          chargeAt: 25,
          preemptForP0: true,
        },
        summary: 'Sprinter P0 Hazmat Co-Pilot',
      },
    });

    const echo1 = await client.waitForType('commandEcho');
    expect(echo1.executed).toBe(true);
    expect(echo1.directive?.persona).toBe('Sprinter');
    expect(echo1.directive?.priority).toBe('p0_first');

    const v = server.world.vehicles.find((x) => x.id === vid)!;
    expect(v.autopilot).toBe(true);
    expect(v.strategy).toBe('Sprinter');
    expect(v.tactics.speed).toBe(1.2);
    expect(v.directive?.preferredZone).toBe('Z');

    // Delta carries autopilot: true and directive
    const delta = await client.waitForType('delta');
    const vDelta = delta.vehicles.find((x) => x.id === vid);
    expect(vDelta?.autopilot).toBe(true);
    expect(vDelta?.directive?.persona).toBe('Sprinter');

    // 2. Advance time past inputLeaseMs (500ms) without sending keyboard input:
    // Co-Pilot vehicle must remain in autopilot and NOT be released or stopped
    await server.stepTick(Date.now() + 2000);
    expect(v.autopilot).toBe(true);
    expect(v.human).toBe(true);

    // 3. Send natural-language Co-Pilot command
    client.send({
      type: 'agentCommand',
      text: 'Switch to Batcher and run Cold Storage Zone W pallets to Bay E2',
    });
    const echo2 = await client.waitForType('commandEcho');
    expect(echo2.executed).toBe(true);
    expect(v.autopilot).toBe(true);
    expect(v.strategy).toBe('Batcher');
    expect(v.directive?.preferredZone).toBe('W');
    expect(v.directive?.preferredBay).toBe('E2');
    expect(v.tactics.batch).toBe(2);

    // 4. Manual WASD override: pressing 'up' immediately pauses Co-Pilot autopilot
    client.send({
      type: 'input',
      seq: 1,
      up: true,
      down: false,
      left: false,
      right: false,
      boost: false,
    });
    await client.waitForType('ack');
    expect(v.autopilot).toBe(false);
    expect(v.input.up).toBe(true);
  });

  it('includes structured ActiveDirective in brain renderDecisionPrompt without leaking untrusted player text', () => {
    const world = createWorld({ siteId: 'den-1', seed: 99 });
    for (let i = 0; i < 6; i++) postOrder(world);
    const v = world.vehicles[0]!;
    v.human = true;
    v.driver = 'MaliciousPlayerName';
    applyAgentDirective(world, v, {
      persona: 'Strategist',
      priority: 'high_value',
      preferredZone: 'U',
      preferredBay: 'E4',
      tactics: { speed: 1.15, batch: 2 },
      summary: 'MaliciousPlayerName custom summary',
    });

    // Reset immediate heuristic claim so emitContractRequestIfNeeded sees v as idle-ready
    for (const o of v.orders) {
      o.state = 'open';
      o.claimant = null;
    }
    v.orders = [];
    v.state = 'idle';

    const req = emitContractRequestIfNeeded(world, v)!;
    expect(req).toBeTruthy();

    const rendered = renderDecisionPrompt(world, req, ['MaliciousPlayerName']);
    expect(rendered.prompt).toContain('ActiveDirective: persona=Strategist priority=high_value zone=U bay=E4 speed=1.15 batch=2');
    expect(rendered.prompt).not.toContain('MaliciousPlayerName');
    expect(rendered.systemInstruction).not.toContain('MaliciousPlayerName');
  });
});
