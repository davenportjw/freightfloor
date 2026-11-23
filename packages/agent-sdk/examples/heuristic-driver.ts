/**
 * Zero-cost heuristic forklift driver using @warehouse/agent-sdk.
 *
 * Usage:
 *   LOBBY_URL=https://freightfloor.com AGENT_NAME=GreedyFork npx tsx packages/agent-sdk/examples/heuristic-driver.ts
 *   # Or reuse a previously minted key:
 *   LOBBY_URL=http://127.0.0.1:8080 AGENT_API_KEY=ffa_... npx tsx packages/agent-sdk/examples/heuristic-driver.ts
 */
import {
  FreightFloorAgentClient,
  PilotLoop,
  registerAgent,
  type AgentDecision,
  type FloorObservation,
} from '../src/index.js';

function decideGreedy(obs: FloorObservation): AgentDecision {
  const self = obs.self;
  if (!self) return { action: 'idle' };

  if (obs.dealtCards.length > 0) {
    return { action: 'keepCards', cardIds: obs.dealtCards.slice(0, 3), reason: 'keep dealt cards' };
  }

  // If carrying cargo and server gave a drop guide, deliver it immediately.
  if (self.cargoCount > 0 && self.guide?.kind === 'drop' && self.guide.x !== undefined && self.guide.y !== undefined) {
    return {
      action: 'driveTo',
      x: self.guide.x,
      y: self.guide.y,
      boost: true,
      reason: 'deliver carried pallet',
    };
  }

  // Pick the highest value-per-distance open order (favoring P0 urgent orders).
  if (obs.orders.length > 0) {
    let best = obs.orders[0];
    let bestScore = -Infinity;
    for (const o of obs.orders) {
      const dist = Math.hypot(o.pickupX - self.x, o.pickupY - self.y) + 1;
      const score = (o.value * (o.p0 ? 1.5 : 1)) / dist;
      if (score > bestScore) {
        bestScore = score;
        best = o;
      }
    }
    return {
      action: 'deliverOrder',
      orderId: typeof best.id === 'number' ? best.id : undefined,
      pickupX: best.pickupX,
      pickupY: best.pickupY,
      dropX: best.dropX,
      dropY: best.dropY,
      boost: best.p0,
      reason: `order ${best.id}`,
    };
  }

  return { action: 'idle', reason: 'waiting for orders' };
}

async function main(): Promise<void> {
  const lobbyUrl = process.env.LOBBY_URL ?? 'http://127.0.0.1:8080';
  let apiKey = process.env.AGENT_API_KEY;
  if (!apiKey) {
    const reg = await registerAgent(lobbyUrl, {
      name: process.env.AGENT_NAME ?? 'GreedyFork',
      model: 'heuristic-greedy-v1',
    });
    apiKey = reg.apiKey;
    console.log(`Registered agent "${reg.name}" (${reg.publicId}). Save AGENT_API_KEY=${apiKey}`);
  }

  const client = new FreightFloorAgentClient({
    lobbyUrl,
    apiKey,
    model: 'heuristic-greedy-v1',
    onErrorFrame: (e) => console.error(`[site error] ${e.code}: ${e.message}`),
  });
  const joined = await client.connect();
  console.log(`Connected to ${joined.siteId} as ${joined.name}`);

  const pilot = new PilotLoop(client, {
    decide: decideGreedy,
    decisionIntervalMs: 500,
    steeringIntervalMs: 100,
  });
  pilot.start();

  process.on('SIGINT', () => {
    pilot.stop();
    client.close();
    process.exit(0);
  });
}

void main();
