# Protocol Reference (`@warehouse/protocol`)

All network payloads between the browser client, the lobby server (`apps/lobby`), the site shard servers (`apps/site`), and Pub/Sub (`site-transfers`) are strictly validated at runtime using Zod schemas exported from `packages/protocol`.

---

## 1. Lobby HTTP Endpoints (`apps/lobby`)

### `POST /api/join`
Authenticates display name hygiene, enforces per-IP connection rate limits, selects a target shard according to the placement policy, and returns a short-lived HMAC ticket.

**Request Body (`JoinRequestSchema`)**
| Field | Type | Required | Description |
|---|---|---|---|
| `clientId` | `string` | Yes | Persistent anonymous client UUID/token stored in browser `localStorage` (`8..64` chars). |
| `name` | `string` | No | Optional retry run callsign (`2..20` chars after NFKC normalization). For human drivers, the lobby assigns or preserves an official `Adjective-Noun-NN` callsign (`generateDriverCallsign`) and never adds custom user-defined names. |
| `resume` | `string` | No | Optional **resume code** (`wr1_` + 32 base64url chars, the `resumeToken` returned by a previous join) or **existing driver callsign** to find and switch to an existing driver identity in the game. Unknown callsigns, raw `clientId`s, and invalid resume codes are rejected (`404 invalid_resume_code`) and never create a new name. |
| `prefer` | `SiteId` (`^(den\|slc\|phx\|abq)-[1-9]\d*$`) | No | Optional preferred canonical or overflow regional site ID (used when reconnecting or transferring sites). |
| `mode` | `RunMode` (`'blitz' \| 'freerange'`) | No | Optional driver run mode (`'blitz'` for 3-Minute Blitz scored runs; `'freerange'` for open-ended continuous runs routed below the 26-driver soft cap). |
| `runMode` | `RunMode` (`'blitz' \| 'freerange'`) | No | Alias for `mode` accepted on both Lobby and Site `POST /api/join` endpoints and embedded into the signed HMAC ticket. |
| `requeue` | `boolean` | No | Optional flag requesting re-entry into the FIFO driver seat queue after a completed or evicted run. |
| `seatLeaseId` | `string` | No | Optional active or promoted seat lease ID (`4..64` chars) when claiming a reserved driver seat. |
| `spectateOnly` | `boolean` | No | Optional flag to connect strictly as a spectator without requesting or queuing for a driver seat. |

**Response Body (`JoinResponseSchema` / `ExtendedJoinResponseSchema`)**
| Field | Type | Description |
|---|---|---|
| `siteId` | `SiteId` | Assigned shard ID (e.g. `'den-1'`, `'den-2'`, `'slc-2'`, `'phx-3'`, `'abq-4'`). |
| `wsUrl` | `string` | WebSocket endpoint URL for the assigned shard (`wss://...` or `ws://...`). |
| `ticket` | `string` | Base64url-encoded payload + HMAC-SHA256 signature valid for 60 seconds (includes optional `role`, `jti`, `seatLeaseId`). |
| `expiresAt` | `number` | Unix epoch timestamp (ms) when `ticket` expires. |
| `name` | `string?` | Official server-assigned driver callsign (e.g. `Turbo-Badger`, `Turbo-Badger Run 2`). |
| `clientId` | `string?` | Canonical `clientId` resolved by the lobby (updated when resuming with a resume code from a new browser/device; clients should adopt it). |
| `resumeToken` | `string?` | Human drivers only: the player's resume code (`^wr1_[A-Za-z0-9_-]{32}$`, `HMAC-SHA256(TICKET_HMAC_SECRET, "warehouse-resume:v1:" + clientId)`). Clients store it and show it as the "resume code"; send it back in `resume` on another device. Deterministic per `clientId`; revoked only by rotating the secret. |
| `publicId` | `string?` | The caller's own opaque public id (`^p1_[A-Za-z0-9_-]{22}$`, `HMAC-SHA256(TICKET_HMAC_SECRET, "warehouse-public:v1:" + clientId)` truncated to 22 base64url chars). Matches the caller's `/api/network` leaderboard row and every id the site sends (§3). |
| `queue` | `QueueStatus?` | Optional FIFO driver seat queue status (`QueueStatusSchema`): `{ state: 'none' \| 'queued' \| 'ready' \| 'expired', position: number, totalQueued: number, estimatedWaitSec: number, preferredSite?: SiteId, seatLeaseId?: string, claimExpiresAt?: number, claimSiteId?: SiteId, claimTicket?: string, claimWsUrl?: string }`. |

**Name / Callsign Error Responses**
| Status | `error` | When |
|---|---|---|
| `400` | `invalid_name` | `name` or `resume` fails charset/length, contains control/zero-width/bidi characters, or fails local prompt-injection/URI checks. |
| `400` | `reserved_name` | `name` uses a reserved prefix. |
| `404` | `invalid_resume_code` | `resume` does not match any existing human driver callsign or valid resume code. Message: *"No existing driver callsign matches that name. Leave it blank to keep your assigned callsign, or enter an existing callsign / resume code."* |

**Queue / Upstream Errors**
| Status | `error` | When |
|---|---|---|
| `503` | `queue_unavailable` | The Firestore seat-queue transaction or read failed (any `/api/join` or `/api/queue*` path). Surfaced directly; the lobby never falls back to an in-memory queue in production. Retry later. |

**Lobby → Site WebSocket proxy headers**: the lobby strips client `X-Forwarded-For` and sends `x-warehouse-proxy` (signed proxy token), `x-warehouse-client-ip` (client IP resolved with `TRUSTED_PROXY_HOPS`), and `x-warehouse-client-ip-sig` (`HMAC-SHA256("client-ip:" + proxyToken + ":" + ip)`). The site uses the forwarded IP only when both the proxy token and the signature verify; otherwise it uses the socket peer address. Proxied frames are capped at `MAX_WS_FRAME_BYTES` (4096); larger frames close with code `1009`.

---

### `GET /api/network`
Returns aggregated live status for all warehouse shards (from Firestore heartbeats) and the cross-site network leaderboard.

**Response Body (`NetworkResponseSchema`)**
| Field | Type | Description |
|---|---|---|
| `sites` | `SiteStatus[]` | Array of shard statuses: `{ id: SiteId, state: 'live' \| 'online' \| 'break' \| 'offline', drivers: number, spectators: number, tier: number, shipped: number, phase: Phase, wsUrl?: string, updatedAt?: number, maxDrivers?: number }`. `maxDrivers` is the per-site driver cap reported by the site heartbeat (site `MAX_DRIVERS`), falling back to the lobby's `MAX_DRIVERS_PER_SITE` (32) when the heartbeat has not reported one. |
| `leaderboard` | `LeaderboardEntry[]` | Top players across the distribution network: `{ clientId: string, publicId: string, name: string, siteId?: SiteId, points?: number, lifetimePoints?: number, bestBlitzPts?: number, deliveries: number, isBot?: boolean, ppm?: number }` (`ppm` = the player's best pallets delivered per real minute in a run, sim `computeDriverPpm`; stored by the site on the Firestore player doc and omitted until the player has a delivery). **Raw clientIds are never exposed**: `clientId` and `publicId` both carry the opaque publicId (raw clientIds are bearer credentials for queue claims and own-identity joins). |
| `queueSize` | `number?` | Current number of players waiting in the global FIFO driver seat queue. |
| `maxTotalDrivers` | `number?` | Network-wide human driver cap across all active shards. |
| `maxWarehouses` | `number?` | Maximum number of active warehouse shards in the network. |

---

## 2. Client-to-Site WebSocket Messages (`ClientMessageSchema`)

All WebSocket frames sent from client to site must be UTF-8 JSON strings `<= 4096` bytes (`4 KB`) matching the discriminated union on `type`:

```ts
type ClientMessage =
  | { type: 'hello'; ticket: string }
  | { type: 'input'; up: boolean; down: boolean; left: boolean; right: boolean; boost?: boolean; moveAngle?: number | null; dt?: number; seq: number }
  | { type: 'interact'; forkHeight?: number }
  | { type: 'takeWheel'; vid: string }
  | { type: 'release' }
  | { type: 'manager'; op: 'rush' | 'p0' | 'cone' | 'fleetAdd' | 'fleetRemove' | 'dispatch'; x?: number; y?: number; dispatch?: DispatchParams }
  | { type: 'keepCards'; ids: string[] }
  | { type: 'chooseOrder'; orderId: number }
  | { type: 'voteDifficulty'; level: DifficultyLevel }
  | { type: 'nlCommand'; text: string }
  | { type: 'agentCommand'; vid?: string; text?: string; directive?: AgentDirective }
  | { type: 'transferSite'; siteId: SiteId }
  | { type: 'layers'; traffic: boolean }
  | { type: 'a2uiAction'; screenId: string; actionId: string; dispatch?: DispatchParams; managerOp?: ManagerOp }
  | { type: 'setRunMode'; mode: RunMode }
  | { type: 'acceptRelocation'; targetSite: SiteId }
  | { type: 'dispatchersCallPref'; enabled: boolean };
```

| `type` | Fields | Description |
|---|---|---|
| `hello` | `ticket: string` | Must be the first message sent upon opening the WebSocket. Verifies the HMAC ticket, attaches the player session, and wakes the shard if in `break`. |
| `input` | `up: boolean`, `down: boolean`, `left: boolean`, `right: boolean`, `boost?: boolean`, `moveAngle?: number \| null`, `dt?: number`, `seq: number` | 10 Hz directional steering + optional speed-boost (`Shift` / `Space`) input for the player's currently leased vehicle. When `moveAngle` (radians in world space) is set by the mobile/touch thumbstick, the forklift turns toward that isometric board heading and drives forward (`speedNow >= 0`). Optional `dt` (`0..2` game-minutes) opts into the **client-timed input stream**: it is the exact time the *previous* input was held, as measured by the client's own prediction. The site applies that slice immediately on arrival (`applyClientInputSlice`, capped by a wall-clock budget of at most 0.6 game-min so `dt` cannot be used to speed-hack), then makes this message's input current. Clients stream at 10 Hz while a key is held **or the vehicle is still moving**; if the stream goes stale for 0.25 game-min the server tick advances the vehicle itself and deducts that time from the next slices. `seq` is a monotonically increasing sequence integer used for client-side prediction reconciliation. |
| `interact` | `forkHeight?: number` (`0..1`) | Equivalent to pressing/releasing `E`: picks up or drops a pallet within the **1.6-tile reach**, or clears a hazard/cone. When the opt-in Rack Height Fork-Lift Minigame is enabled (`limits.rackLiftMinigame`), `forkHeight` (`0..1`) transmits the mast elevation released on `E` for rack pickups and putaway stows (omitted when disabled or on quick-tap `< 140 ms`). |
| `takeWheel` | `vid: string` | Leases control of a specific vehicle ID (`vid`). If `vid` belongs to an AI agent, that agent's brain pauses while the human drives. |
| `release` | *(none)* | Releases the player's current vehicle lease (returning an AI vehicle to its Gemini brain or despawning a temporary player vehicle). |
| `manager` | `op: 'rush' \| 'p0' \| 'cone' \| 'fleetAdd' \| 'fleetRemove' \| 'dispatch'`, `x?: number`, `y?: number`, `dispatch?: DispatchParams` | Executes a direct Floor order subject to multiplayer governance limits (`x, y` required when `op === 'cone'`). |
| `keepCards` | `ids: string[]` | Selects which dealt skill cards (`ids`) to keep at shift deal. Never starts the Blitz clock (it starts on the first drive / interact input or Co-Pilot). |
| `chooseOrder` | `orderId: int ≥ 0` | Reserves one of the driver's current order options (`fareOffer`, §3.4). Rate-limited by site governance to one per `CHOOSE_ORDER_COOLDOWN_SEC = 0.25` s per player (`error` code `governance_limit`); a rejected pick (not an option, taken, Co-Pilot driving, no choice open) returns `error` code `choose_order_failed` with the sim's reason. |
| `voteDifficulty` | `level: DifficultyLevel` | Casts or updates the driver's vote for the facility's difficulty level (`1..5` or `'easy' \| 'normal' \| 'medium' \| 'hard' \| 'turbo' \| 'calm' \| 'surge' \| 'crisis'`). |
| `nlCommand` | `text: string` | Submits a natural-language manager order (`<= 200` chars) through the 7-layer Prompt Armor + Gemini parser pipeline. |
| `agentCommand` | `vid?: string`, `text?: string`, `directive?: AgentDirective` | Submits a Co-Pilot natural-language instruction (`text`, `<= 200` chars) or structured Agent Designer `directive` to configure or engage autonomous Co-Pilot driving on the player's leased vehicle. |
| `transferSite` | `siteId: SiteId` | Requests a clean handoff to another shard (`'den-1' \| 'slc-2' \| 'phx-3' \| 'abq-4'`), releasing the current vehicle lease and persisting player stats. |
| `layers` | `traffic: boolean` | Opt-in overlay subscription. `traffic: true` subscribes this connection to the sparse heat layer (`stats.heat`, see §3.2); `false` unsubscribes. Default is unsubscribed on every (re)connect. |
| `a2uiAction` | `screenId: string`, `actionId: string`, `dispatch?: DispatchParams`, `managerOp?: ManagerOp` | Submits an interactive A2UI clarification screen selection. For a Dispatcher's Call card, `screenId` is the minigame `id` and `actionId` is `dc-opt-<idx>`; the server executes its own stored option and ignores `dispatch` (§3.7). |
| `setRunMode` | `mode: 'blitz' \| 'freerange'` | Switches the driver's active run mode between 3-Minute Blitz (`'blitz'`) and Free Range (`'freerange'`). |
| `acceptRelocation` | `targetSite: SiteId` | Accepts a Cross-Site Surge Relocation offer, awarding `+75` relocation bonus points and minting a carry-over ticket to `targetSite`. |
| `dispatchersCallPref` | `enabled: boolean` | Per-connection opt-out of the Dispatcher's Call minigame (§3.7). The client sends `enabled: false` after `welcome` when the player turned it off. |

---

## 3. Site-to-Client WebSocket Messages (`ServerMessageSchema`)

All WebSocket frames sent from the site server to connected clients match the discriminated union on `type`:

```ts
type ServerMessage =
  | { type: 'welcome'; you: PlayerSessionInfo; snapshot: WorldSnapshot; limits?: SiteLimits; floorOrders?: FloorOrdersStatus }
  | { type: 'delta'; t: number; vehicles: QuantisedVehicleDelta[]; orders?: OrderDelta[]; hazards?: HazardDelta[]; events: SimEvent[]; stats?: DeltaStats; hands?: Record<string, CardHand>; floorOrders?: FloorOrdersStatus }
  | { type: 'ack'; seq: number; t?: number; x?: number; y?: number; vx?: number; vy?: number; angle?: number; speedNow?: number }
  | { type: 'presence'; players: PresenceEntry[] }
  | { type: 'brainHealth'; ok: boolean; model?: string; errors1m: number; p50ms: number; budgetLeftUsd: number; armorBlocks1h?: number }
  | { type: 'phase'; phase: Phase; resumesAt?: number; reason?: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'commandEcho'; text: string; parsed?: unknown; executed?: boolean; reason?: string; status?: 'executed' | 'rejected'; summary?: string; directive?: AgentDirective; armor?: CommandEchoArmor }
  | { type: 'brainDecision'; reqId: number; agentId: number; vid?: string; kind: DecisionKind; decision: Record<string, unknown>; note: string; latencyMs: number; tokensIn: number; tokensOut: number; model: string }
  | { type: 'a2uiScreen'; screenId: string; title: string; subtitle: string; telemetry: A2uiTelemetryPill[]; selectors: A2uiSelectorGroup[]; presets: A2uiPresetButton[]; recommendedDispatch: DispatchParams; recommendedSource?: 'model' | 'heuristic'; minigame?: DispatchersCallMinigame }
  | { type: 'dispatchersCallReveal'; id: string; playerIdx: number | null; geminiIdx: number; geminiLabel: string; geminiReason: string; agreed: boolean; timedOut: boolean; summary: string | null; orderIds: number[]; evalUntil: number | null }
  | { type: 'relocationOffer'; fromSite: SiteId; targetSite: SiteId; targetDrivers: number; bonusPts: number; expiresAt: number; reason: string }
  | { type: 'relocateShard'; siteId: SiteId; wsUrl: string; ticket: string; expiresAt: number; bonusPts: number }
  | { type: 'runEvicted'; vid: number; reason: EvictionReason; pts: number; shipped: number; incidents: number; bestStreak: number; runMode: RunMode };
```

| `type` | Fields | Description |
|---|---|---|
| `welcome` | `you: { clientId, playerId?, name, vid, siteId, isBot? }`, `snapshot: WorldSnapshot`, `limits?: SiteLimits`, `floorOrders?: FloorOrdersStatus` | Sent immediately after a valid `hello`. Contains the player's assigned opaque ID (`P1`, etc.), leased vehicle ID, full v5 world snapshot, the real server/sim caps (§3.1), and the recipient's own Floor-order state (§3.2). `snapshot.cards` contains only agent hands (`ai: true`) plus the recipient's own hand. |
| `delta` | `t: number`, `vehicles: QuantisedVehicleDelta[]`, `orders?: OrderDelta[]`, `hazards?: HazardDelta[]`, `events: SimEvent[]; stats?: DeltaStats; hands?: Record<string, CardHand>; floorOrders?: FloorOrdersStatus` | Broadcast at 10 Hz. Vehicle coordinates are quantized to `1/32` of a tile. Light deltas (9 of every 10 background ticks) carry only pose/cargo fields; full deltas (1 Hz) add orders, stats, hands, the recipient's changed `floorOrders` and inspector detail (§3.2). |
| `ack` | `seq: number`, `t?: number`, `x?: number`, `y?: number`, `vx?: number`, `vy?: number`, `angle?: number`, `speedNow?: number` | Acknowledges the latest processed `input.seq` with the vehicle pose **after** that input's `dt` slice was applied, plus `world.t` as `t`. For client-timed streams, ack N therefore means "every input slice with seq <= N applied": the client rebases on the pose and replays only newer slices with the same sub-step partition, so steady driving reconciles to ~0 correction (no heading wobble). Legacy clients without `dt` also get a post-tick ack. |
| `presence` | `players: Array<{ clientId?: string; playerId?: string; name: string; vid: string \| null; points?: number; score?: number; role?: 'driver' \| 'spectator'; isBot?: boolean }>` | Broadcast when players join, leave, rename, change vehicle leases, or when any active driver's current shift points (`sPts`) change. |
| `brainHealth` | `ok: boolean`, `model?: string`, `errors1m: number`, `p50ms: number`, `budgetLeftUsd: number`, `armorBlocks1h?: number` | Periodic telemetry update for the HUD brain-health pill showing Gemini decision health, p50 latency, remaining daily budget (`$12.50/day` cap), and recent armor blocks. |
| `phase` | `phase: 'running' \| 'winding_down' \| 'break' \| 'resuming'`, `resumesAt?: number`, `reason?: string` | Notifies clients when the site transitions between active shift and factory break states (`resumesAt` epoch ms included during `resuming`). |
| `error` | `code: string`, `message: string` | Surfaces explicit protocol, governance, brain, or prompt-armor errors (`ArmorReasonCode` or protocol error code) directly to the client UI. |
| `commandEcho` | `text: string`, `parsed?: unknown`, `executed?: boolean`, `reason?: string`, `status?: 'executed' \| 'rejected'`, `summary?: string`, `directive?: AgentDirective`, `armor?: { layer: 1..7; stage: 'sanitizeUserPrompt' \| 'sanitizeModelResponse'; filter: string; strikes?: number; muted?: boolean }` | Structured feedback for `nlCommand` or `agentCommand` showing the sanitized parse result / applied `AgentDirective` and whether it was executed or refused/clamped. `armor` is present only when Model Armor blocked the command (`reason: 'armor_blocked'`): the pipeline layer (2 = input screen, 6 = output screen), the stage, the real verdict filter (`pi_and_jailbreak`, `malicious_uri`, `rai`, `unknown`) and the sender's server-side strike count. The client shows it as the 🛡 shield card. |
| `brainDecision` | `reqId: number`, `agentId: number`, `vid?: string`, `kind: 'contract' \| 'hazard' \| 'tactics' \| 'cards'`, `decision: Record<string, unknown>`, `note: string`, `latencyMs: number`, `tokensIn: number`, `tokensOut: number`, `model: string` | Broadcast to every socket when a Gemini decision for an AI vehicle completes. `agentId` is the numeric part of the vehicle id (`FL-03` → `3`); `vid` is the full id when included (the client otherwise resolves it from `agentId`). `note` is the model's own reason, shown verbatim in the DRIVE rival reasoning pill and the results "You vs Gemini" recap. |
| `a2uiScreen` | `screenId`, `title`, `subtitle`, `telemetry`, `selectors`, `presets`, `recommendedDispatch`, `recommendedSource?: 'model' \| 'heuristic'`, `minigame?: DispatchersCallMinigame` | Interactive A2UI clarification screen payload. `recommendedSource` says who pre-filled `recommendedDispatch`: `model` (the client shows "Suggested by Gemini"), `heuristic` ("Pre-filled from your words (keyword match)"); absent means no AI attribution is shown. With `minigame` it is a Dispatcher's Call card sent only to its driver (§3.7). |
| `dispatchersCallReveal` | `id`, `playerIdx: int \| null`, `geminiIdx`, `geminiLabel`, `geminiReason`, `agreed`, `timedOut`, `summary: string \| null`, `orderIds: int[]`, `evalUntil: number \| null` | Sent to the driver after a Dispatcher's Call pick or timeout: Gemini's pick and reason (§3.7). |
| `relocationOffer` | `fromSite: SiteId`, `targetSite: SiteId`, `targetDrivers: number`, `bonusPts: number`, `expiresAt: number`, `reason: string` | Sent to eligible Free Range drivers when a shard reaches the 26-driver soft cap, offering `+75` bonus points and full score/streak/card carry-over to relocate to a lighter shard. |
| `relocateShard` | `siteId: SiteId`, `wsUrl: string`, `ticket: string`, `expiresAt: number` (epoch ms, the ticket's `exp`), `bonusPts: number` | Sent after `acceptRelocation`, containing a pre-signed carry-over `ticket` and `wsUrl` so the client can seamlessly reconnect to `siteId` without losing progress. |
| `runEvicted` | `vid: number`, `reason: 'run_complete' \| 'idle_timeout' \| 'session_lease_expired' \| 'hard_cap_timeout' \| 'zero_deliveries_timeout'`, `pts: number`, `shipped: number`, `incidents: number`, `bestStreak: number`, `runMode: RunMode` | Sent to a driver when their seat lease is reclaimed upon run completion, idle timeout, session lease expiry, zero-delivery timeout, or Free Range hard-cap timeout, transitioning the connection to spectator mode with final run stats. |

**Opaque player ids on the wire**: every `clientId` the site sends (`welcome.you.clientId`, `presence.players[].clientId`, `snapshot.vehicles[].ownerClientId`/`controlledByClientId`, `snapshot.players`, `snapshot.difficultyVotes` / `delta.votes` keys, `snapshot.cards` / `delta.hands` keys, `completedRuns[].clientId`, and event `clientId` / `owner` / `player` fields) is the player's **publicId** (`p1_…`, same derivation as the lobby), never the raw clientId. The mapping is uniform, so the recipient's own id is also its publicId and client-side equality checks work unchanged. The sim, Firestore snapshots, and heartbeats keep raw clientIds internally.


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
| `maxOpenP0?` | site governance `MAX_OPEN_P0_ON_FLOOR` (4) | Site-wide cap on open P0 orders; `p0` is refused while `floorOrders.p0.open >= maxOpenP0`. |
| `conesPerPlayer?` | site governance `MAX_CONES_PER_PLAYER` (6) | Live cones one player may own (site-wide cap `MAX_CONES_ON_FLOOR` = 24 also applies). |
| `coneTtlGameMin?` | site governance `CONE_EXPIRY_SEC` (60) | Cone lifetime in game-minutes (1 game-minute = 1 real second at 10 Hz). |
| `dispatchMaxCount?` | protocol `DISPATCH_MAX_COUNT` (8) | Max `DispatchParams.count` (schema cap and sim clamp). |
| `nlPerMinute?` | armor `PLAYER_RATE_LIMIT_PER_MIN` (6) | `nlCommand` budget per player per real minute (sliding window). |
| `rackLiftMinigame?` | site `FEATURE_RACK_LIFT_MINIGAME` (`false` default) | Opt-in server default for the Rack Height Fork-Lift Minigame (`ENABLE_RACK_LIFT_MINIGAME=1\|true`). |
| `dispatchersCall?` | site `ENABLE_DISPATCHERS_CALL` (`true` default; `0\|false\|off\|no` disables) | Whether this site offers the Dispatcher's Call minigame (§3.7). |

### 3.2 Full-delta additions

**Cadence constants:** `BOARD_INTERVAL_MS = 1000`, `HEAT_INTERVAL_MS = 2000`, `HEAT_MIN_VALUE = 0.5`, `MAX_PATH_WAYPOINTS = 12`.

**`stats` (`DeltaStatsSchema`, passthrough).** Shared fields `totals`, `day`, `shift`, `shiftTime`, `rushUntil`, plus:

| Field | Shape | Semantics |
|---|---|---|
| `board` | `BoardRow[]` (`BoardRowSchema`) = `{ strat, vehicles, count, perHr, onTimePct: number \| null, incidents, kwhPerOrder: number \| null }[]` | Team Standings (sim `board(world)`), recomputed at most once per `BOARD_INTERVAL_MS`; present on every full delta. |
| `seriesAppend` | `ValueSample[]` = `{ t, you, avg, best }[]` | Per-connection, append-only: the `world.valueSeries` samples with `t` strictly greater than the newest sample already delivered to this connection (the welcome snapshot's `valueSeries` counts as delivered). Omitted when there is nothing new. Clients append and trim to their own cap (sim keeps 300). |
| `history` | `DayRecord[]` (sim `DayHistoryEntry`) | Last 60 day records; sent only when `world.history` changed since this connection last received it (welcome counts). Replace, don't append. |
| `hall` | `HallEntry[]` = `{ shift, id, strat, human, driver, pts, scored, diff }[]` | Hall of Fame (≤ 10, sorted); sent only when it changed since this connection last received it. Replace, don't append. |
| `heat` | `HeatLayer` (`HeatLayerSchema`) = `{ w, h, cells: [index, value][] }` | Only for connections subscribed via `{ type: 'layers', traffic: true }`, at most every `HEAT_INTERVAL_MS`. `index = y * w + x`; `value` is raw sim heat rounded to 0.1. Cells below `HEAT_MIN_VALUE` are omitted. Raw heat grows `+0.1`/tick on occupied tiles and decays ×0.997/tick, so values range from 0.5 up to ≈33 (steady state for one parked vehicle). |

**`hands`** (`Record<string, CardHand>`): sent on every full delta and contains **only the recipient's own hand**, keyed by its `clientId` (`{}` when it has none). Other players' hands are never sent. Agent hands (keyed by vehicle id, `ai: true`) are visible in the welcome snapshot only.

**`floorOrders`** (`FloorOrdersStatusSchema`): the **recipient's own** Floor-order state, computed read-only by `FacilityGovernor.getFloorOrdersStatus` from the same limiter state that `manager` ops and `nlCommand` are enforced against. Always present on `welcome`; on full deltas it is included only when it differs from what this connection last received, with countdown-only changes throttled to once per `FLOOR_ORDERS_INTERVAL_MS = 1000` (ready/blocked flips and count changes are sent immediately on the next full delta). Not sent on light deltas or lean bot deltas. All `*InMs` are real milliseconds until this player may issue the op again (`0` = ready); clients count down locally between updates.

```ts
type FloorOrdersStatus = {
  rush: { readyInMs: number };                    // max(active wave, site cooldown 20 s, per-player cooldown 30 s)
  p0: { open: number; readyInMs: number };        // open = site-wide open P0 orders; per-player cooldown 15 s
  cones: { mine: string[] };                      // sorted "x,y" keys of live (unexpired) cones this player placed
  dispatch: { readyInMs: number };                // per-player cooldown 10 s
  fleet: { addReadyInMs: number; removable: number }; // shared fleetAdd/fleetRemove cooldown 30 s; removable = autonomous agents above MIN_AUTONOMOUS_AGENTS
  nl: { left: number; resetInMs: number };        // nlCommand window: requests left (0 while muted), ms until the oldest slot frees (or mute ends)
};
```

`fleet.addReadyInMs` is the shared per-player fleet cooldown, so it also gates `fleetRemove`; `fleetAdd` is additionally refused at `maxAutonomousAgents`. Active rush end time remains `stats.rushUntil`.

**Vehicle inspector detail** (full deltas only, never light):

| Field | Shape | Semantics |
|---|---|---|
| `incidents` / `nearMisses` / `skids` / `palletDrops` / `deliveries` | `number` | Lifetime/shift counters from the sim vehicle (`incidents` crashes, `nearMisses`, `skids` on floor spills, `palletDrops` on high-speed collision, and `deliveries` completed). |
| `tactics` | `VehicleTacticsSchema` = `{ speed, respect, buffer, chargeAt, batch: number; flatPath, preemptForP0, poach: boolean; note?: string }` | Current tuned tactics (numbers rounded to 2 dp). |
| `path` | `number[]` (ints) | Flattened `[x0, y0, x1, y1, …]` of the first `MAX_PATH_WAYPOINTS` planned waypoints. |
| `extra` | `boolean` | Vehicle was added above the base fleet. |
| `humanCharging?` | `boolean` | True when a human-driven vehicle is actively charging on a charger pad (`+5%/min`); included on full deltas and on light deltas for human vehicles. |
| `decision?` | `VehicleDecisionSchema` = `{ kind: 'contract' \| 'hazard' \| 'tactics' \| 'cards'; model: string; latencyMs: number; reason: string; t: number }` | The last **applied** Gemini decision for this agent: real model id and measured call latency (ms, including the one retry if it happened). Absent until a real decision has been applied; never synthesised. |

Measured cost of these additions per full delta (1 Hz, 14 agents, seed 42): vehicle detail ≈ 177 B/vehicle (≈ 2.5 KB total), `board` ≈ 0.5 KB, own `hands` ≈ 0.8 KB with a 3-card offer (`{}` = 2 B otherwise); `seriesAppend` ≈ 33 B per sample (one per 50 ticks); `heat` ≈ 10 B per hot cell (≈ 0.2 KB with 14 hot cells), every 2 s, subscribers only; `history`/`hall` only on change. Light deltas are unchanged.

### 3.3 Fares, combo & cards (Phases 1–2)

See `docs/gameplay.md` §2–3 for the rules.

**Vehicle fare stats** (`QuantisedVehicleDeltaSchema`, all optional): on full deltas (inspector detail, every vehicle) **and** on light deltas for human-driven vehicles, so the combo meter is live.

| Field | Shape | Semantics |
|---|---|---|
| `combo` | `number` (1.0 \| 1.2 \| 1.5 \| 2.0) | Current combo multiplier. |
| `comboBest` | `number` | Best combo reached this run. |
| `fareTrips` | `int ≥ 0` | Fares (delivered pallets) rated this run. |
| `speedyTrips` | `int ≥ 0` | Speedy-rated fares this run. |

**Cards** (`CardSchema`, passthrough): new optional `rarity: 'common' | 'wild'`, `humanOnly: boolean`, `perk: Record<string, number>` (keys `speedMul`, `reachBonus`, `batteryDrainMul`, `forkLiftMul`, `comboFloor`; applies only once `status === 'done'`) and `completedAt`. `modifiers` mirrors `perk` for older clients. `type` is one of the 21 `CARD_TYPES`. **`CardHandSchema`** gains optional `pick: int > 0`: when present (1 on replacement draws), `keepCards` rejects more than `pick` ids. The hand limit is 3 active cards, with at most one wild.

**AI card decisions:** `CardOption` (in `DecisionRequest.options` for `kind: 'cards'`) also carries `rarity` and `perk`. humanOnly cards are never offered to agents.

**Events** (`SimEvent`, delivered in `delta.events`):

| `type` | Extra fields | When |
|---|---|---|
| `fare` | `vid, orderId: number, rating: 'speedy' \| 'normal' \| 'slow', actual: number, par: number \| null, combo: number, pts: number, base: number, ratingMul: number, payoutMul: number` | Every delivered pallet. `base` = order value + bonuses before multipliers (0.1 rounded); `pts = base × ratingMul × combo × payoutMul`, rounded to 0.1 (e.g. `8 → ×1.5 Speedy → ×1.5 combo = 18`). No streak multiplier. |
| `incident` | `vid, x, y` and, for vehicle-vehicle crashes, `victim: string, victimAtFault: boolean` | A crash. `vid` is the rammer (full crash). The victim gets only a short stun unless `victimAtFault` (it was also driving fast toward the rammer), in which case both take the full crash. |
| `combo_reset` | `vid, reason: 'slow' \| 'crash' \| 'drop' \| 'skid', combo` | Combo dropped (to ×1.0, or ×1.2 with the Combo King perk). |
| `trailer_closer` | `vid, bay, pts: 5, combo` | This drop filled a regular outbound trailer. |
| `poach` | `vid, owner, cardId, orderId` | **Card poach:** a rival delivered a route-contract pallet after the owner's reservation window (`contractReserveMin`: 90 game-min ≈ 90 s, clamped to a third of a blitz run), and the owner's card is lost. (The older order-poach variant carries only `vid`.) |
| `precision_stop` | `vid` | A Crazy Stop was cashed in by a pick or drop. |
| `card` | `player?`, `vid?`, `cardId?`, `pts?` | Deal, accept, done, failed and Last Call payout messages (e.g. `Replacement card offer ready: pick 1 of 2.`). |

### 3.4 Order choice & rival (Phase 3)

See `docs/gameplay.md` §4 for the rules.

**Vehicle choice state** (`QuantisedVehicleDeltaSchema`, optional, on light **and** full deltas for human non-bot vehicles only; AI vehicles never carry them):

| Field | Shape | Semantics |
|---|---|---|
| `fareOffer` | `FareOffer \| null` = `{ since: number, options: FareOption[] (≤ 3), copilotId: int, reason: string, carpool: boolean }` | Open order choice. `options[0]` is the Co-Pilot pick (`copilotId`); `reason` is the Co-Pilot's real scoring explanation (e.g. `Recommended #42: 6 tiles closer than #17, P0 +20.`). After `FARE_CHOICE_TIMEOUT_MIN = 5` game-min without a choice the Co-Pilot reserves `copilotId`; a Carpool offer lapses instead. `null` when no choice is open (order chosen, loaded, low battery, Co-Pilot driving, run finished). |
| `FareOption` | `{ orderId: int, farClass: 'short' \| 'cross' \| 'long' \| 'contract', carpool: boolean, p0: boolean, bay: string, value: number, tiles: number, parEmpty: number \| null, parLoaded: number \| null, putaway?: boolean, putawayRack?: string \| null, xdockBay?: string \| null, xdockLeft?: number \| null }` | `tiles` = Manhattan distance to the pickup; pars in game-min (2 dp). For inbound pallets `putaway: true`, `parLoaded` is dock → rack, `putawayRack` names the destination rack, and `xdockBay`/`xdockLeft` give the cross-dock bay and whole game-min left in its window (`xdockLeft: null` once closed). Putaway options never carpool. |
| `rivalId` | `string \| null` | The AI agent whose shift score is closest to this driver's (ties → lower id). |

**Cards** (`CardSchema`): optional `until: number` and `rivalBase: { rivalId, self, rival }` on an active Rival Grudge. `type` now also deals `long_haul`, `local_hero`, `poacher`, `rival_grudge`, `ghost_hunter`.

**Events:**

| `type` | Extra fields | When |
|---|---|---|
| `fare_choice` | `vid, orderId, farClass, carpool, auto: boolean, reason: string \| null` | A driver reserved an option; `auto: true` = Co-Pilot timeout pick, with its `reason`. |
| `rival_snipe` | `vid, rival, orderId, isRival: boolean, reason?: string` | An AI vehicle (`rival` = its vid) claimed or picked the order you were heading to (your claimed order or the Co-Pilot pick), or your assigned rival (`isRival`) reserved one of your open options. `reason` is that AI's last real brain decision reason, omitted if it has none. At most one per `RIVAL_SNIPE_COOLDOWN_MIN = 15` game-min per driver. |
| `rival_taunt` | `vid, rival, mine: number, theirs: number, cardId, reason: string \| null` | Your Rival Grudge was lost (`theirs ≥ mine` deliveries in the window). |

### 3.5 Inbound receiving, putaway & cross-dock

See `docs/gameplay.md` §1 for the rules (8 pts stow, +10 cross-dock within 45 game-min, humans only, AI 15 game-min hold).

- **Orders** (`delta.orders` on full deltas, sim `Order`): inbound pallets add `putaway: Slot | null` (rack destination; `slot` is the west-dock pickup tile `2,<dock.y>` with `rackId` = dock id), `xdockBay: string | null` and `xdockDue: number | null` (game time the cross-dock window closes).
- **Cargo** (`vehicles[].cargo`, full deltas): inbound entries add `rack`, `xdockBay`, `xdockDue`.
- **Guide** (`vehicles[].guide`): a carried inbound pallet keeps `kind: 'drop'` (client/loadtest compatible) with `x`/`y` at the rack access tile, plus `stow: true` and, while the window is open, `alt: { x, y, bay, left }` at the cross-dock bay.
- **Vehicle target** (sim `VehicleTarget.kind`): new `'stow'` for AI trips to a rack access tile.
- **Snapshot** (`WorldSnapshotV5`): optional `nextInboundAt` (game time of the next trailer); `totals` add optional `putaways` and `crossDocks`.
- **Events:**

| `type` | Extra fields | When |
|---|---|---|
| `inbound` | `orderId, dock, rack: string \| null, xdockBay: string \| null` | An inbound trailer dropped a pallet at a west dock. |
| `stow` | `vid, orderId, rack` | A pallet was stowed at its rack (also emits `fare`). |
| `xdock` | `vid, orderId, bay, bonus: 10` | A human cross-docked an inbound pallet inside the window (also emits `fare`). |

### 3.6 Rack Height Fork-Lift Minigame (Opt-In Feature Flag)

See `docs/gameplay.md` §1 for the rules (Option A Hold-`E` to raise, Release-`E` to grab, `< 140 ms` quick-tap safety net, Perfect Lift `+$5` + `0.6 s` exit surge, Slide & Snatch `+$10` combo, and Forgiving Rack Scrape).

- **`SlotSchema.level`** (`0 | 1 | 2`): rack shelf level (`0 = L1 Low`, `1 = L2 Mid`, `2 = L3 High`) on `Order.slot`, `Order.putaway`, and `QuantisedVehicleDelta.guide.level`.
- **`InteractCommandSchema.forkHeight`** (`number` in `0..1`, optional): normalized mast height released by the client on `{ type: 'interact', forkHeight }`. When omitted (minigame disabled, dock/bay interaction, or quick-tap `< 140 ms`), the server uses legacy instant pickup/stow.
- **`QuantisedVehicleDeltaSchema.fork`** (`0..1`): animated mast height on vehicles (`v.fork`), raised to target shelf height (`L1: 0.14`, `L2: 0.52`, `L3: 0.88`) during rack interactions.
- **Events (`SimEvent`)**:

| `type` | Extra fields | When |
|---|---|---|
| `perfect_lift` | `vid, orderId, level, pts: 5` | Human released `E` inside the Perfect Lift sweet spot (`±0.11` around target shelf height, widened up to `±0.15` by `forkLiftMul` perks), awarding `+$5` and a `0.6 s` (`1.22×`) exit acceleration surge. |
| `slide_snatch` | `vid, orderId, level, pts: 10` | Human combined an armed Crazy Stop (`precision_stop`) with a `perfect_lift`, awarding `+$10` total (`+$5` over `perfect_lift`). |
| `rack_scrape` | `vid, orderId, level` | Human released `E` outside the shelf band on L2/L3: pallet still loads/stows (forgiving miss), deducts `-$2` (clamped at `0`), and applies a brief `1.0 s` (`0.78×`) speed wobble. |

### 3.7 Dispatcher's Call (A2UI minigame)

See `docs/gameplay.md` §3c for the rules (window, situations, 8 s pick, scoring). Gated by `welcome.limits.dispatchersCall` (site `ENABLE_DISPATCHERS_CALL`, default on) and the per-connection `dispatchersCallPref`.

- **`a2uiScreen.minigame`** (`DispatchersCallMinigameSchema`): `{ id, kind: 'dispatchers_call', deadlineMs, deadlineT, situation, question (≤ 90 chars), options: [{ idx, label (≤ 48), desc, action: DispatchParams }] (2–3) }`, where `situation` is one of `spill | p0_surge | trailer_near_cap | hazmat_backlog | dock_backlog`. Sent only to the driver it is for. `screenId` equals `minigame.id`, and the `presets` are `dc-opt-<idx>`. `recommendedDispatch` is option 0 (it is required by the schema); Gemini's own pick is **not** in the screen.
- **Pick**: `a2uiAction { screenId: <id>, actionId: 'dc-opt-<idx>' }`. Errors come back as `commandEcho` (`executed: false`, `reason`: `no_challenge | not_owner | stale | bad_option`). Dismissing a live card is a no-op.
- **`dispatchersCallReveal`**: Gemini's pick (`geminiIdx`, `geminiLabel`, `geminiReason` ≤ 90 chars), `agreed`, and `timedOut` (`playerIdx: null`). `summary`, `orderIds` and `evalUntil` describe the executed dispatch (null / empty on timeout).
- **Events (`SimEvent`)**:

| `type` | Extra fields | When |
|---|---|---|
| `dispatchers_call` | `vid, id, situation, optionCount, deadline` | A card was offered (`deadline` = game time the pick closes). |
| `dispatchers_call_pick` | `vid, id, optionIdx, geminiIdx, agreed, orderIds, evalUntil` | The driver picked; the option was executed through `dispatchOrderRoute`. |
| `dispatchers_call_result` | `vid, id, situation, optionIdx, geminiIdx, agreed, timedOut, dispatched, delivered, onTime, pts` | The outcome window closed (or the run ended, or the pick timed out with `pts: 0`). `pts` was added to `runPts` / `sPts`. |

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
