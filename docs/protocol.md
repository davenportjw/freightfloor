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
| `sites` | `SiteStatus[]` | Array of shard statuses: `{ id: SiteId, state: 'live' \| 'online' \| 'break' \| 'offline', drivers: number, spectators: number, tier: number, shipped: number, phase: Phase, wsUrl?: string, updatedAt?: number }`. |
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
  | { type: 'transferSite'; siteId: SiteId };
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

---

## 3. Site-to-Client WebSocket Messages (`ServerMessageSchema`)

All WebSocket frames sent from the site server to connected clients match the discriminated union on `type`:

```ts
type ServerMessage =
  | { type: 'welcome'; you: PlayerSessionInfo; snapshot: WorldSnapshot }
  | { type: 'delta'; t: number; vehicles: QuantisedVehicleDelta[]; orders?: OrderDelta[]; hazards?: HazardDelta[]; events: SimEvent[] }
  | { type: 'ack'; seq: number; x?: number; y?: number; vx?: number; vy?: number }
  | { type: 'presence'; players: PresenceEntry[] }
  | { type: 'brainHealth'; ok: boolean; model?: string; errors1m: number; p50ms: number; budgetLeftUsd: number; armorBlocks1h?: number }
  | { type: 'phase'; phase: Phase; resumesAt?: number; reason?: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'commandEcho'; text: string; parsed: unknown; executed: boolean; reason?: string };
```

| `type` | Fields | Description |
|---|---|---|
| `welcome` | `you: { clientId, playerId?, name, vid, siteId, isBot? }`, `snapshot: WorldSnapshot` | Sent immediately after a valid `hello`. Contains the player's assigned opaque ID (`P1`, etc.), leased vehicle ID, and full v5 world snapshot. |
| `delta` | `t: number`, `vehicles: QuantisedVehicleDelta[]`, `orders?: OrderDelta[]`, `hazards?: HazardDelta[]`, `events: SimEvent[]` | Broadcast at 10 Hz. Vehicle coordinates are quantized to `1/32` of a tile and only changed fields are sent to keep bandwidth under `6 KB/s` per client at 60 vehicles. |
| `ack` | `seq: number`, `x?: number`, `y?: number`, `vx?: number`, `vy?: number` | Acknowledges the latest processed `input.seq` for the client's vehicle so client-side `stepHuman` prediction can reconcile smoothly. |
| `presence` | `players: Array<{ clientId?: string; playerId?: string; name: string; vid: string \| null; points?: number; score?: number; role?: 'driver' \| 'spectator'; isBot?: boolean }>` | Broadcast when players join, leave, or change vehicle leases. |
| `brainHealth` | `ok: boolean`, `model?: string`, `errors1m: number`, `p50ms: number`, `budgetLeftUsd: number`, `armorBlocks1h?: number` | Periodic telemetry update for the HUD brain-health pill showing Gemini decision health, p50 latency, remaining daily budget (`$25/day` cap), and recent armor blocks. |
| `phase` | `phase: 'running' \| 'winding_down' \| 'break' \| 'resuming'`, `resumesAt?: number`, `reason?: string` | Notifies clients when the site transitions between active shift and factory break states (`resumesAt` epoch ms included during `resuming`). |
| `error` | `code: string`, `message: string` | Surfaces explicit protocol, governance, brain, or prompt-armor errors (`ArmorReasonCode` or protocol error code) directly to the client UI. |
| `commandEcho` | `text: string`, `parsed: unknown`, `executed: boolean`, `reason?: string` | Structured feedback for `nlCommand` showing the sanitized parse result and whether it was executed or refused/clamped. |

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
