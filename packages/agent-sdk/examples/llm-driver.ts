/**
 * BYO-LLM forklift driver template using @warehouse/agent-sdk.
 * Runs the 10 Hz steering loop locally while calling YOUR own LLM endpoint (OpenAI-compatible,
 * Gemini OpenAI endpoint, Ollama, etc.) at ~0.5 Hz on your own API key and budget.
 *
 * Usage:
 *   LOBBY_URL=https://freightfloor.com \
 *   LLM_BASE_URL=https://api.openai.com/v1 \
 *   LLM_API_KEY=sk-... \
 *   LLM_MODEL=gpt-4o-mini \
 *   npx tsx packages/agent-sdk/examples/llm-driver.ts
 */
import {
  FreightFloorAgentClient,
  PilotLoop,
  registerAgent,
  type AgentDecision,
  type FloorObservation,
} from '../src/index.js';

const SYSTEM_PROMPT = [
  'You are an autonomous forklift pilot in Freight Floor.',
  'Given the current JSON observation, reply with ONLY valid JSON matching one of:',
  '{"action":"deliverOrder","orderId":123,"pickupX":10,"pickupY":20,"dropX":58,"dropY":24,"boost":true,"reason":"..."}',
  '{"action":"keepCards","cardIds":["..."],"reason":"..."}',
  '{"action":"idle","reason":"..."}',
  'Prefer P0 urgent orders and nearby high-value pickups.',
].join('\n');

async function decideWithYourLlm(obs: FloorObservation): Promise<AgentDecision> {
  const baseUrl = (process.env.LLM_BASE_URL ?? 'http://127.0.0.1:11434/v1').replace(/\/$/, '');
  const model = process.env.LLM_MODEL ?? 'llama3.2';
  const llmApiKey = process.env.LLM_API_KEY ?? '';

  const compactObs = {
    self: obs.self,
    topOrders: obs.orders.slice(0, 6),
    dealtCards: obs.dealtCards,
    stats: obs.stats,
  };

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(llmApiKey ? { authorization: `Bearer ${llmApiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(compactObs) },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`LLM call failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) return { action: 'idle', reason: 'empty model output' };
  return JSON.parse(content) as AgentDecision;
}

async function main(): Promise<void> {
  const lobbyUrl = process.env.LOBBY_URL ?? 'http://127.0.0.1:8080';
  const modelLabel = (process.env.LLM_MODEL ?? 'byo-llm').slice(0, 48);
  let apiKey = process.env.AGENT_API_KEY;
  if (!apiKey) {
    const reg = await registerAgent(lobbyUrl, {
      name: process.env.AGENT_NAME ?? 'ByoLlmPilot',
      model: modelLabel,
    });
    apiKey = reg.apiKey;
    console.log(`Registered "${reg.name}" (${reg.publicId}). Save AGENT_API_KEY=${apiKey}`);
  }

  const client = new FreightFloorAgentClient({
    lobbyUrl,
    apiKey,
    model: modelLabel,
    onErrorFrame: (e) => console.error(`[site error] ${e.code}: ${e.message}`),
  });
  const joined = await client.connect();
  console.log(`Connected to ${joined.siteId} as ${joined.name}`);

  const pilot = new PilotLoop(client, {
    decide: decideWithYourLlm,
    decisionIntervalMs: 2_000,
    steeringIntervalMs: 100,
    onDecisionError: (err) => console.error('[pilot decide error]', err),
  });
  pilot.start();

  process.on('SIGINT', () => {
    pilot.stop();
    client.close();
    process.exit(0);
  });
}

void main();
