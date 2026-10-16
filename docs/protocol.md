# Protocol Reference (`@warehouse/protocol`)

All network payloads between the browser client, the lobby server (`apps/lobby`), the site shard servers (`apps/site`), and Pub/Sub (`site-transfers`) are strictly validated at runtime using Zod schemas exported from `packages/protocol`.

---

## 1. Lobby HTTP Endpoints (`apps/lobby`)

### `POST /api/join`
Authenticates display name hygiene, enforces per-IP connection rate limits, selects a target shard according to the placement policy, and returns a short-lived HMAC ticket.

**Request Body (`JoinRequestSchema`)**
| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Player display name (`2..20` chars after NFKC normalization, matching `^[A-Za-z0-9 _.\-]{2,20}$`). |
| `clientId` | `string` | Yes | Persistent anonymous client UUID/token stored in browser `localStorage` (`8..64` chars). |
| `prefer` | `SiteId` (`'den-1' \| 'slc-2' \| 'phx-3' \| 'abq-4'`) | No | Optional preferred site ID (used when reconnecting or transferring sites). |

**Response Body (`JoinResponseSchema`)**
| Field | Type | Description |
|---|---|---|
| `siteId` | `SiteId` | Assigned shard ID (`'den-1' \| 'slc-2' \| 'phx-3' \| 'abq-4'`). |
| `wsUrl` | `string` | WebSocket endpoint URL for the assigned shard (`wss://...` or `ws://...`). |
| `ticket` | `string` | Base64url-encoded payload + HMAC-SHA256 signature valid for 60 seconds. |
| `expiresAt` | `number` | Unix epoch timestamp (ms) when `ticket` expires. |

---

### `GET /api/network`
Returns aggregated live status for all four warehouse shards (from Firestore heartbeats) and the cross-site network leaderboard.

**Response Body (`NetworkResponseSchema`)**
| Field | Type | Description |
|---|---|---|
| `sites` | `SiteStatus[]` | Array of shard statuses: `{ id: SiteId, state: 'live' \| 'online' \| 'break' \| 'offline', drivers: number, spectators: number, tier: number, shipped: number, phase: Phase, wsUrl?: string, updatedAt?: number, maxDrivers?: number }`. `maxDrivers` is the per-site driver cap reported by the site heartbeat (site `MAX_DRIVERS`), falling back to the lobby's `MAX_DRIVERS_PER_SITE` (32) when the heartbeat has not reported one. |
| `leaderboard` | `LeaderboardEntry[]` | Top players across the distribution network: `{ clientId: string, name: string, siteId?: SiteId, points?: number, lifetimePoints?: number, deliveries: number, isBot?: boolean }`. |

---

## 2. Client-to-Site WebSocket Messages (`ClientMessageSchema`)

All WebSocket frames sent from client to site must be UTF-8 JSON strings `<= 4096` bytes (`4 KB`) matching the discriminated union on `type`:

```ts
type ClientMessage =
  | { type: 'hello'; ticket: string }
  | { type: 'input'; up: boolean; down: boolean; left: boolean; right: boolean; seq: number }
  | { type: 'interact' }
  | { type: 'takeWheel'; vid: string }
  | { type: 'release' }
  | { type: 'manager'; op: 'rush' | 'p0' | 'cone' | 'fleetAdd' | 'fleetRemove'; x?: number; y?: number }
  | { type: 'keepCards'; ids: string[] }
  | { type: 'voteDifficulty'; level: DifficultyLevel }
  | { type: 'nlCommand'; text: string }
  | { type: 'transferSite'; siteId: SiteId }
  | { type: 'layers'; traffic: boolean };
```

| `type` | Fields | Description |
|---|---|---|
| `hello` | `ticket: string` | Must be the first message sent upon opening the WebSocket. Verifies the HMAC ticket, attaches the player session, and wakes the shard if in `break`. |
| `input` | `up: boolean`, `down: boolean`, `left: boolean`, `right: boolean`, `seq: number` | 10 Hz directional steering input for the player's currently leased vehicle. `seq` is a monotonically increasing sequence integer used for client-side prediction reconciliation. |
| `interact` | *(none)* | Equivalent to pressing `E`: picks up or drops a pallet within the **1.6-tile reach**, or clears a hazard/cone. |
| `takeWheel` | `vid: string` | Leases control of a specific vehicle ID (`vid`). If `vid` belongs to an AI agent, that agent's brain pauses while the human drives. |
| `release` | *(none)* | Releases the player's current vehicle lease (returning an AI vehicle to its Gemini brain or despawning a temporary player vehicle). |
| `manager` | `op: 'rush' \| 'p0' \| 'cone' \| 'fleetAdd' \| 'fleetRemove'`, `x?: number`, `y?: number` | Executes a direct strategy board action subject to multiplayer governance limits (`x, y` required when `op === 'cone'`). |
| `keepCards` | `ids: string[]` | Selects which dealt skill cards (`ids`) to keep at shift deal. |
| `voteDifficulty` | `level: DifficultyLevel` | Casts or updates the driver's vote for the next shift's difficulty level (`1..5` or `'easy' \| 'normal' \| 'hard' \| 'calm' \| 'surge' \| 'crisis'`). |
| `nlCommand` | `text: string` | Submits a natural-language manager order (`<= 200` chars) through the 7-layer Prompt Armor + Gemini parser pipeline. |
| `transferSite` | `siteId: SiteId` | Requests a clean handoff to another shard (`'den-1' \| 'slc-2' \| 'phx-3' \| 'abq-4'`), releasing the current vehicle lease and persisting player stats. |
| `layers` | `traffic: boolean` | Opt-in overlay subscription. `traffic: true` subscribes this connection to the sparse heat layer (`stats.heat`, see §3.2); `false` unsubscribes. Default is unsubscribed on every (re)connect. |

---

## 3. Site-to-Client WebSocket Messages (`ServerMessageSchema`)

All WebSocket frames sent from the site server to connected clients match the discriminated union on `type`:

```ts
type ServerMessage =
  | { type: 'welcome'; you: PlayerSessionInfo; snapshot: WorldSnapshot; limits?: SiteLimits }
  | { type: 'delta'; t: number; vehicles: QuantisedVehicleDelta[]; orders?: OrderDelta[]; hazards?: HazardDelta[]; events: SimEvent[]; stats?: DeltaStats; hands?: Record<string, CardHand> }
  | { type: 'ack'; seq: number; x?: number; y?: number; vx?: number; vy?: number }
  | { type: 'presence'; players: PresenceEntry[] }
  | { type: 'brainHealth'; ok: boolean; model?: string; errors1m: number; p50ms: number; budgetLeftUsd: number; armorBlocks1h?: number }
  | { type: 'phase'; phase: Phase; resumesAt?: number; reason?: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'commandEcho'; text: string; parsed: unknown; executed: boolean; reason?: string };
```

| `type` | Fields | Description |
|---|---|---|
| `welcome` | `you: { clientId, playerId?, name, vid, siteId, isBot? }`, `snapshot: WorldSnapshot`, `limits?: SiteLimits` | Sent immediately after a valid `hello`. Contains the player's assigned opaque ID (`P1`, etc.), leased vehicle ID, full v5 world snapshot, and the real server/sim caps (§3.1). `snapshot.cards` contains only agent hands (`ai: true`) plus the recipient's own hand. |
| `delta` | `t: number`, `vehicles: QuantisedVehicleDelta[]`, `orders?: OrderDelta[]`, `hazards?: HazardDelta[]`, `events: SimEvent[]`, `stats?: DeltaStats`, `hands?: Record<string, CardHand>` | Broadcast at 10 Hz. Vehicle coordinates are quantized to `1/32` of a tile. Light deltas (9 of every 10 background ticks) carry only pose/cargo fields; full deltas (1 Hz) add orders, stats, hands and inspector detail (§3.2). |
| `ack` | `seq: number`, `x?: number`, `y?: number`, `vx?: number`, `vy?: number` | Acknowledges the latest processed `input.seq` for the client's vehicle so client-side `stepHuman` prediction can reconcile smoothly. |
| `presence` | `players: Array<{ clientId?: string; playerId?: string; name: string; vid: string \| null; points?: number; score?: number; role?: 'driver' \| 'spectator'; isBot?: boolean }>` | Broadcast when players join, leave, or change vehicle leases. |
| `brainHealth` | `ok: boolean`, `model?: string`, `errors1m: number`, `p50ms: number`, `budgetLeftUsd: number`, `armorBlocks1h?: number` | Periodic telemetry update for the HUD brain-health pill showing Gemini decision health, p50 latency, remaining daily budget (`$12.50/day` cap), and recent armor blocks. |
| `phase` | `phase: 'running' \| 'winding_down' \| 'break' \| 'resuming'`, `resumesAt?: number`, `reason?: string` | Notifies clients when the site transitions between active shift and factory break states (`resumesAt` epoch ms included during `resuming`). |
| `error` | `code: string`, `message: string` | Surfaces explicit protocol, governance, brain, or prompt-armor errors (`ArmorReasonCode` or protocol error code) directly to the client UI. |
| `commandEcho` | `text: string`, `parsed: unknown`, `executed: boolean`, `reason?: string` | Structured feedback for `nlCommand` showing the sanitized parse result and whether it was executed or refused/clamped. |


### 3.1 `welcome.limits` (`SiteLimitsSchema`)

Populated from real constants (never hardcoded on the client):

| Field | Source | Meaning |
|---|---|---|
| `maxDrivers` | site `MAX_DRIVERS` | Driver cap per site (extra joiners spectate). |
| `maxDriversPerClient` | site `MAX_DRIVERS_PER_CLIENT` | Concurrent driven vehicles per `clientId`. |
| `fleetCap` | sim `FLEET_CAP` | Hard cap on vehicles on the floor. |
| `maxTier` | sim `MAX_TIER` | Highest facility expansion tier. |
| `baseFleet` | sim `BASE_FLEET` | Fleet size at tier 0. |
| `tierStep` | sim `TIER_STEP` | Vehicles added per tier. |
| `minAutonomousAgents?` / `maxAutonomousAgents?` | site governance `MIN_AUTONOMOUS_AGENTS` / `MAX_AUTONOMOUS_AGENTS` | Bounds enforced on `fleetAdd` / `fleetRemove`. |

### 3.2 Full-delta additions

**Cadence constants:** `BOARD_INTERVAL_MS = 1000`, `HEAT_INTERVAL_MS = 2000`, `HEAT_MIN_VALUE = 0.5`, `MAX_PATH_WAYPOINTS = 12`.

**`stats` (`DeltaStatsSchema`, passthrough).** Shared fields `totals`, `day`, `shift`, `shiftTime`, `rushUntil`, plus:

| Field | Shape | Semantics |
|---|---|---|
| `board` | `BoardRow[]` (`BoardRowSchema`) = `{ strat, vehicles, count, perHr, onTimePct: number \| null, incidents, kwhPerOrder: number \| null }[]` | Strategy Board (sim `board(world)`), recomputed at most once per `BOARD_INTERVAL_MS`; present on every full delta. |
| `seriesAppend` | `ValueSample[]` = `{ t, you, avg, best }[]` | Per-connection, append-only: the `world.valueSeries` samples with `t` strictly greater than the newest sample already delivered to this connection (the welcome snapshot's `valueSeries` counts as delivered). Omitted when there is nothing new. Clients append and trim to their own cap (sim keeps 300). |
| `history` | `DayRecord[]` (sim `DayHistoryEntry`) | Last 60 day records; sent only when `world.history` changed since this connection last received it (welcome counts). Replace, don't append. |
| `hall` | `HallEntry[]` = `{ shift, id, strat, human, driver, pts, scored, diff }[]` | Hall of Fame (≤ 10, sorted); sent only when it changed since this connection last received it. Replace, don't append. |
| `heat` | `HeatLayer` (`HeatLayerSchema`) = `{ w, h, cells: [index, value][] }` | Only for connections subscribed via `{ type: 'layers', traffic: true }`, at most every `HEAT_INTERVAL_MS`. `index = y * w + x`; `value` is raw sim heat rounded to 0.1. Cells below `HEAT_MIN_VALUE` are omitted. Raw heat grows `+0.1`/tick on occupied tiles and decays ×0.997/tick, so values range from 0.5 up to ≈33 (steady state for one parked vehicle). |

**`hands`** (`Record<string, CardHand>`): sent on every full delta and contains **only the recipient's own hand**, keyed by its `clientId` (`{}` when it has none). Other players' hands are never sent. Agent hands (keyed by vehicle id, `ai: true`) are visible in the welcome snapshot only.

**Vehicle inspector detail** (full deltas only, never light):

| Field | Shape | Semantics |
|---|---|---|
| `incidents` / `nearMisses` | `number` | Lifetime counters from the sim vehicle. |
| `tactics` | `VehicleTacticsSchema` = `{ speed, respect, buffer, chargeAt, batch: number; flatPath, preemptForP0, poach: boolean; note?: string }` | Current tuned tactics (numbers rounded to 2 dp). |
| `path` | `number[]` (ints) | Flattened `[x0, y0, x1, y1, …]` of the first `MAX_PATH_WAYPOINTS` planned waypoints. |
| `extra` | `boolean` | Vehicle was added above the base fleet. |
| `decision?` | `VehicleDecisionSchema` = `{ kind: 'contract' \| 'hazard' \| 'tactics' \| 'cards'; model: string; latencyMs: number; reason: string; t: number }` | The last **applied** Gemini decision for this agent: real model id and measured call latency (ms, including the one retry if it happened). Absent until a real decision has been applied; never synthesised. |

Measured cost of these additions per full delta (1 Hz, 14 agents, seed 42): vehicle detail ≈ 177 B/vehicle (≈ 2.5 KB total), `board` ≈ 0.5 KB, own `hands` ≈ 0.8 KB with a 3-card offer (`{}` = 2 B otherwise); `seriesAppend` ≈ 33 B per sample (one per 50 ticks); `heat` ≈ 10 B per hot cell (≈ 0.2 KB with 14 hot cells), every 2 s, subscribers only; `history`/`hall` only on change. Light deltas are unchanged.

---

## 4. Site-to-Site Pub/Sub Transfer Message (`TransferSchema`)

Published to the `site-transfers` Pub/Sub topic when an outbound network order is dropped at an east transfer bay (`→ network`), and delivered via push subscription to `POST /internal/transfer` on the destination shard.

```ts
interface Transfer {
  id: string;
  fromSite: SiteId;
  toSite: SiteId;
  orderRef: string;
  value: number;
  shippedAt: number;
  carrier: string;
}
```

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Globally unique transfer ID (used by `receiveTransfer` for idempotent deduplication). |
| `fromSite` | `SiteId` | Origin warehouse site (`'den-1' \| 'slc-2' \| 'phx-3' \| 'abq-4'`). |
| `toSite` | `SiteId` | Destination warehouse site (`'den-1' \| 'slc-2' \| 'phx-3' \| 'abq-4'`), also set as Pub/Sub message attribute `toSite` for subscription filtering. |
| `orderRef` | `string` | Reference ID of the originating outbound order. |
| `value` | `number` | Base point value of the freight pallet (receiving stow awards `+5` bonus points). |
| `shippedAt` | `number` | Unix epoch timestamp (ms) when the pallet departed `fromSite`. |
| `carrier` | `string` | Opaque driver/agent identifier that completed the outbound transfer leg. |
