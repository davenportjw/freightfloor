/**
 * WebMCP (https://webmachinelearning.github.io/webmcp/): exposes read-only Freight Floor tools to
 * in-browser AI agents. Each tool wraps a public lobby endpoint the page already uses, so an agent
 * gets the same data a human sees. No-op in browsers without `document.modelContext`.
 */
import { fetchDaily, fetchNetwork } from './net.js';

interface WebMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
  execute: (input: Record<string, unknown>) => Promise<unknown>;
}

interface ModelContext {
  registerTool(tool: WebMcpTool, options?: { signal?: AbortSignal }): Promise<void> | void;
}

const HOW_TO_PLAY = [
  'Freight Floor: drive a forklift on a shared multiplayer warehouse floor against Gemini-driven AI rivals.',
  'Modes: 3-Minute Blitz (default, high-score run; clock starts on first move), Free Range (ranked by points per minute and on-time %), Floor mode (spectate and send floor orders to the AI fleet).',
  'Contract cards: each run deals 3 goal cards; completed cards grant perks such as speed, reach, or battery efficiency.',
  'Controls: WASD drive, E pick up/drop, Shift boost, C Co-Pilot, Tab standings, ? help.',
  'Sites: Denver (site-den-1), Salt Lake City (site-slc-2), Phoenix (site-phx-3), Albuquerque (site-abq-4).',
].join('\n');

function modelContext(): ModelContext | null {
  const doc = document as Document & { modelContext?: ModelContext };
  const nav = navigator as Navigator & { modelContext?: ModelContext };
  return doc.modelContext ?? nav.modelContext ?? null;
}

const text = (value: unknown) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
});

export function webMcpTools(): WebMcpTool[] {
  return [
    {
      name: 'get_warehouse_network',
      description:
        'Live Freight Floor status: each regional warehouse site (state, drivers, spectators, capacity, pallets shipped), the top-10 human leaderboard, and the seat queue size.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async () => {
        const res = await fetchNetwork();
        if (!res.ok) throw new Error(res.error);
        return text(res.data);
      },
    },
    {
      name: 'get_daily_shift_leaderboard',
      description:
        "Today's Freight Floor Daily Shift (UTC day): number, modifier, reset time, entry count, and ranked top scores.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async () => {
        const res = await fetchDaily();
        if (!res.ok) throw new Error(res.error);
        return text(res.data);
      },
    },
    {
      name: 'get_how_to_play',
      description: 'How Freight Floor is played: modes, contract cards, keyboard controls, and regional sites.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async () => text(HOW_TO_PLAY),
    },
  ];
}

/** Registers the tools if the browser supports WebMCP; returns the controller that unregisters them. */
export function registerWebMcpTools(): AbortController | null {
  const ctx = modelContext();
  if (!ctx) return null;
  const controller = new AbortController();
  for (const tool of webMcpTools()) {
    try {
      void Promise.resolve(ctx.registerTool(tool, { signal: controller.signal })).catch((err: unknown) => {
        console.warn(`[webmcp] registerTool(${tool.name}) failed`, err);
      });
    } catch (err) {
      console.warn(`[webmcp] registerTool(${tool.name}) failed`, err);
    }
  }
  return controller;
}
