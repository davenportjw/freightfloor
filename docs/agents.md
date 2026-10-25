# AI Agents & Gemini Brain Service (`@warehouse/site` & `@warehouse/sim`)

## Overview

Every AI vehicle in the Warehouse distribution network is controlled by an asynchronous **Gemini 3.5 Flash-Lite** brain (`gemini-3.5-flash-lite`) hosted on Vertex AI (`location: 'global'`, `project: 'davenporter-freightfloor'`), authenticated via Google Cloud Application Default Credentials (ADC). Allowed models exported in `ALLOWED_GEMINI_MODELS` are `'gemini-3.8-flash'`, `'gemini-3.5-flash-lite'`, and `'gemini-4-argon'`.

- **10 Hz Non-Blocking Execution**: The 10 Hz deterministic simulation loop (`packages/sim`) never blocks on network I/O. Instead, `packages/sim` emits `DecisionRequest` events ahead of time, and deterministic pathfinding (`A*`, reservation tables, steering) drives the vehicle between decisions.
- **Asynchronous Validation (`applyDecision`)**: When the Vertex AI response arrives, the site server passes it into `applyDecision(world, reqId, decision, meta)`. The simulation validates that the request has not expired (`deadline`) and that the chosen option is still legal in the current world state.
- **Strict No-Mock Policy**: There is **no rule-based fallback** when a Gemini call fails or when the daily budget is exhausted.

---

## 1. Vertex AI Configuration

Brain requests use the official `@google/genai` SDK configured for Vertex AI with ADC:

```ts
const ai = new GoogleGenAI({
  vertexai: true,
  project: 'davenporter-freightfloor',
  location: 'global',
});

const res = await ai.models.generateContent({
  model: env.GEMINI_MODEL, // 'gemini-3.5-flash-lite'
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
| `hazard` | A floor spill or obstacle is within 3 tiles of the agent's planned path | `reroute` (omitted when `detourLen === null`), `wait`, or `clean`, each annotated with detour tile length, remaining spill duration, and cleanup bonus | `{ choice: 'reroute' \| 'wait' \| 'clean', reason: string }` |
| `tactics` | Every game-hour and at shift change | Agent's own delivery metrics, shift standings, battery level, and current tactical parameters | Bounded `{ speed: number, buffer: number, respect: number, chargeAt: number, batch: number, note: string }` |
| `cards` | At each shift deal | Three dealt skill cards with their modifiers and trade-offs | `{ keep: string[], reason?: string }` |

Every applied decision is recorded in the **Decision Journal** (`journal` collection in Firestore with 7-day TTL and in-memory ring buffer for `/api/journal`), capturing `model`, `kind`, `agentId`, `latencyMs`, `promptTokens`, `outputTokens`, and sanitized `reason` (capped at 120 chars). Clicking any AI vehicle in the client HUD inspector displays its persona, last decision reason, and latency.

---

## 3. Personas & Context Caching

Each AI agent is assigned one of the 5 warehouse `ARCHETYPES` (`packages/sim/src/engine.ts`), which pairs distinct 10 Hz engine physics with its own Gemini persona prompt on the Strategy Board:

| Persona (`Archetype`) | Speed | Safety Buffer | Respect | Charge At | Batch | Poach / Preempt P0 | Tactical Focus & Gemini Prompt |
|---|---|---|---|---|---|---|---|
| **Sprinter** | `1.3` | `1` tile | `0.35` | `12%` | `1` | Preempts P0 (`flatPath: true`) | Prioritizes short-slack urgent contracts, cuts through picking aisles, and pushes battery down to `12%`. |
| **Steady** | `0.9` | `3` tiles | `1.0` | `30%` | `1` | Respects all claims | Wide 3-tile collision buffer, respects every soft claim, charges early at `30%`, and finishes current work before P0. |
| **Batcher** | `1.0` | `2` tiles | `0.9` | `22%` | `2` | Standard | Pairs 2-pallet fork batching (`batch: 2`) bound for the same shipping bay or cross-site transfer dock. |
| **Opportunist** | `1.1` | `2` tiles | `0.7` | `20%` | `1` | `poach: true`, Preempts P0 | Grabs the highest-value contract even if another agent already holds a soft claim on it. |
| **Strategist** | `1.0` | `2` tiles | `0.9` | `22%` | `1` | `tunable: true` | Retunes its own tactical parameters (`speed`, `buffer`, `respect`, `chargeAt`, `batch`) via Gemini at shift boundaries and every game-hour. |

Because the system instructions, warehouse rules, and persona definitions are static across calls for a given archetype, `apps/site` caches the persona prompt prefix per archetype (`personaCache[req.persona]`) and uses compact top-6 pre-scored JSON candidates (`thinkingBudget: 0`, `maxOutputTokens: 120`) to keep calls small and fast.

---

## 4. Game Engine (10 Hz) vs. Gemini (`gemini-3.5-flash-lite`) Division

Work is strictly partitioned between the deterministic 10 Hz simulation loop (`@warehouse/sim`) and asynchronous Vertex AI calls (`@warehouse/site`):

- **Game Engine (`@warehouse/sim` · 10 Hz Local)**:
  - Binary-heap `A*` pathfinding (`findPath`) factoring one-way lane arrows, player cones, spills, and aisle traffic heat.
  - Forward 1–3 tile occupancy reservations (`buildOccupancy`), steering, and collision avoidance.
  - Deterministic pre-scoring (`scoreOrder` / `scoreOrdersFor`) to rank open orders into the top-6 candidates before prompting Gemini.
  - Immediate P0 alert preemption (`preemptForP0`) and automatic charger routing (`goCharge`) whenever `battery < chargeAt` (skipping the LLM call).
- **Gemini (`gemini-3.5-flash-lite` · Async Background)**:
  - Asynchronous contract dispatch pre-fetched when idle or `≤6` tiles before completing the current bay drop-off.
  - Hazard decisions (`reroute`, `wait`, or `clean`) when a spill is within 3 tiles of the planned path.
  - Shift skill card selection (`cards`) and `Strategist` hourly/shift parameter retuning (`tactics`).
  - Free-text floor commands (`nlCommand`) and Co-Pilot directives (`agentCommand`), guarded by the 7-layer Model Armor pipeline and `FacilityGovernor` bounds.

### Three Forklift Dispatch Modes

| Mode | LLM Usage | Dispatch & Fallback Behavior |
|---|---|---|
| **🤖 AI Fleet (`F-01`..`F-20`)** | **Gemini Dispatch (No Fallback)** | Gemini selects contracts, spill response, shift cards, and `Strategist` tactics. If a call fails, the truck holds and surfaces `brainError` (3s backoff) — zero silent mock fallbacks. |
| **🕹️ Player Manual (`DRV` / Take Wheel)** | **100% Game Engine (0 LLM Calls)** | WASD/Arrows driving (`stepHuman`). Contract offers (`Q`) are ranked deterministically by `scoreOrdersFor` (auto-picks Co-Pilot top choice after 5s). Pending LLM calls are stripped on takeover. |
| **🧭 Player Co-Pilot (Autopilot ON)** | **Gemini + 1s Engine Fallback** | Gemini parses free-text directives (Model Armor) and dispatches like an AI truck. If Gemini takes `≥1.0s` while idle or at a spill, the engine auto-dispatches the top-scored order or reroutes so the player's truck never stalls. |

---

## 5. Priority Queue & Concurrency Control

Each site server (`AgentBrainScheduler`) manages an asynchronous brain request queue with:
- **Max Concurrency**: Up to **4–8 calls in flight** simultaneously per site shard (` hazard > contract > cards > tactics`).
- **Strict Priority Ordering**:
  1. `hazard` (highest priority — immediate path safety within 3 tiles)
  2. `contract` (keeps forklifts moving seamlessly before drop completion)
  3. `cards` (shift boundary card selection)
  4. `tactics` (hourly parameter tuning)
- **Bounded Retries**: Transient Vertex AI errors are retried with jittered exponential backoff for at most **2 attempts** (`maxAttempts = 2`).

---

## 6. Global $12.50/Day Firestore Budget Ledger

To enforce a strict cost ceiling across all running shards:
- **Shared Daily Cap**: All sites share a single global agent brain budget of **$12.50/day** (`AGENT_DAILY_BUDGET_USD = 12.5`) tracked in Firestore at `budget/{yyyy-mm-dd}`.
- **Dedicated Typed-Order Slice**: Natural-language player commands (`nlCommand`) draw from an isolated **$1.50/day** cap (`NL_COMMAND_DAILY_BUDGET_USD = 1.5`) on the global ledger so that an attacker spamming `nlCommand` can never starve the warehouse AI agents' operational brain budget.
- **1-Minute Transactional Reservations**: Each active site reserves spend in 1-minute blocks via a Firestore transaction on `budget/{yyyy-mm-dd}`, reconciling actual spend from measured `usageMetadata` token counts × Gemini 3.5 Flash-Lite token pricing (`$0.075 / 1M` input tokens, `$0.30 / 1M` output tokens).
- **Overflow Site Scaling**:
  - `den-1` runs 20 agents (`IDLE_POLICY=run`).
  - Overflow sites (`slc-2`, `phx-3`, `abq-4`) run 12 agents and enter `break` when empty, dropping their Gemini token burn to zero.

---

## 7. Strict Failure Semantics (Zero Silent Fallbacks)

When a Gemini brain call fails after retry (or when a budget reservation on `budget/{yyyy-mm-dd}` is refused):
1. **No Synthetic Decisions**: The server **never** synthesizes a default, random, or rule-based decision.
2. **Finish Committed Leg & Hold**: The agent finishes the movement leg it already committed to, then holds position and enters `brainError` state.
3. **Visible Telemetry**:
   - The vehicle displays a red **"brain error"** badge on the PixiJS stage.
   - If the daily cap is reached, agents hold with the explicit error `"daily brain budget reached"`.
   - The error is surfaced in the vehicle inspector, the site event log, and the HUD `brainHealth` pill (`ok: false`, `errors1m`, `budgetLeftUsd`).
   - If Vertex AI experiences an outage, the AI fleet visibly stalls until service recovers.
