# AI Agents & Gemini Brain Service (`@warehouse/site` & `@warehouse/sim`)

## Overview

Every AI vehicle in the Warehouse distribution network is controlled by an asynchronous **Gemini 3.8 Flash** brain (`gemini-3.8-flash`) hosted on Vertex AI (`location: 'global'`, `project: 'davenport-boutique'`), authenticated via Google Cloud Application Default Credentials (ADC).

- **10 Hz Non-Blocking Execution**: The 10 Hz deterministic simulation loop (`packages/sim`) never blocks on network I/O. Instead, `packages/sim` emits `DecisionRequest` events ahead of time, and deterministic pathfinding (`A*`, reservation tables, steering) drives the vehicle between decisions.
- **Asynchronous Validation (`applyDecision`)**: When the Vertex AI response arrives, the site server passes it into `applyDecision(world, reqId, decision, meta)`. The simulation validates that the request has not expired (`deadline`) and that the chosen option is still legal in the current world state.
- **Strict No-Mock Policy**: There is **no rule-based fallback** when a Gemini call fails or when the daily budget is exhausted.

---

## 1. Vertex AI Configuration

Brain requests use the official `@google/genai` SDK configured for Vertex AI with ADC:

```ts
const ai = new GoogleGenAI({
  vertexai: true,
  project: 'davenport-boutique',
  location: 'global',
});

const res = await ai.models.generateContent({
  model: env.GEMINI_MODEL, // 'gemini-3.8-flash'
  contents: [{ role: 'user', parts: [{ text: renderRequest(req) }] }],
  config: {
    cachedContent: personaCache[req.persona],
    responseMimeType: 'application/json',
    responseSchema: schemaFor(req.kind),
    temperature: 0.4,
    maxOutputTokens: 200,
  },
});
```

- **Isolation from Player Text**: Agent brain prompts are constructed strictly from simulation numbers and enums (order IDs, distances, slack times, district codes, congestion counts, and opaque player IDs like `P7`). Player display names and chat/order strings are **never** interpolated into agent brain contexts (`assertNoUntrustedText` verifies this invariant in automated tests).

---

## 2. The Four Decision Kinds

| Decision Kind | Emitted When | Options Computed by Sim | Validated JSON Reply Schema |
|---|---|---|---|
| `contract` | Agent is ~6 tiles from its current drop-off, or idle without a task | Top 6 open orders with distance, slack time, point value, district, current claimant count, aisle congestion, and cross-site `transfer` flag | `{ orderIds: string[], reason: string }` |
| `hazard` | A floor spill or obstacle is within 3 tiles of the agent's planned path | `reroute`, `wait`, or `push`, each annotated with detour tile length, remaining spill duration, and skid risk | `{ choice: 'reroute' \| 'wait' \| 'push', reason: string }` |
| `tactics` | Every game-hour and at shift change | Agent's own delivery metrics, shift standings, battery level, and current tactical parameters | Bounded `{ speed: number, buffer: number, respect: number, chargeAt: number, batch: number, note: string }` |
| `cards` | At each shift deal | Three dealt skill cards with their modifiers and trade-offs | `{ keep: string[], reason?: string }` |

Every applied decision is recorded in the **Decision Journal** (`journal` collection in Firestore with 7-day TTL and in-memory ring buffer for `/api/journal`), capturing `model`, `kind`, `agentId`, `latencyMs`, `promptTokens`, `outputTokens`, and sanitized `reason` (capped at 120 chars). Clicking any AI vehicle in the client HUD inspector displays its persona, last decision reason, and latency.

---

## 3. Personas & Context Caching

Each AI agent is assigned one of the warehouse archetypes (personas), which defines its initial tactical parameters and decision-making priorities:
- **Sprinter**: Prioritizes short-slack urgent contracts, higher speed, and lower battery charge thresholds.
- **Hauler**: Prefers high-value multi-pallet batches and cross-site network transfers (`→ network`).
- **Strategist**: Optimizes district balance, avoids congested aisles, and cleanly reroutes around hazards.
- **Sentinel**: Prioritizes P0 critical orders, high safety buffers, and disciplined charger rotation.

Because the system instructions, warehouse rules, and persona definitions are static across calls for a given archetype, `apps/site` caches the persona prompt prefix per archetype (`personaCache[req.persona]`) using Vertex AI **Context Caching**, reducing both input token cost and time-to-first-token latency.

---

## 4. Priority Queue & Concurrency Control

Each site server manages an asynchronous brain request queue with:
- **Max Concurrency**: Up to **8 calls in flight** simultaneously per site shard.
- **Strict Priority Ordering**:
  1. `hazard` (highest priority — immediate path safety within 3 tiles)
  2. `contract` (keeps forklifts moving seamlessly before drop completion)
  3. `cards` (shift boundary card selection)
  4. `tactics` (hourly parameter tuning)
- **Bounded Retries**: Transient Vertex AI errors are retried with jittered exponential backoff for at most **2 attempts** (`maxAttempts = 2`).

---

## 5. Global $25/Day Firestore Budget Ledger

To enforce a strict cost ceiling across all running shards:
- **Shared Daily Cap**: All sites share a single global budget of **$25.00/day** tracked in Firestore at `budget/{yyyy-mm-dd}`.
- **Dedicated Typed-Order Slice**: Natural-language player commands (`nlCommand`) draw from an isolated **$3.00/day sub-slice** (`typedOrdersSpentUsd <= 3.00`) of the global ledger so that an attacker spamming `nlCommand` can never starve the warehouse AI agents' `$22.00/day` operational brain budget.
- **1-Minute Transactional Reservations**: Each active site reserves spend in 1-minute blocks via a Firestore transaction on `budget/{yyyy-mm-dd}`, reconciling actual spend from measured `usageMetadata` token counts × Gemini 3.8 Flash token pricing.
- **Overflow Site Scaling**:
  - `den-1` runs 20 agents (`IDLE_POLICY=run`).
  - Overflow sites (`slc-2`, `phx-3`, `abq-4`) run 12 agents and enter `break` when empty, dropping their Gemini token burn to zero.

---

## 6. Strict Failure Semantics (Zero Silent Fallbacks)

When a Gemini brain call fails after retry (or when a budget reservation on `budget/{yyyy-mm-dd}` is refused):
1. **No Synthetic Decisions**: The server **never** synthesizes a default, random, or rule-based decision.
2. **Finish Committed Leg & Hold**: The agent finishes the movement leg it already committed to, then holds position and enters `brainError` state.
3. **Visible Telemetry**:
   - The vehicle displays a red **"brain error"** badge on the PixiJS stage.
   - If the daily cap is reached, agents hold with the explicit error `"daily brain budget reached"`.
   - The error is surfaced in the vehicle inspector, the site event log, and the HUD `brainHealth` pill (`ok: false`, `errors1m`, `budgetLeftUsd`).
   - If Vertex AI experiences an outage, the AI fleet visibly stalls until service recovers.
