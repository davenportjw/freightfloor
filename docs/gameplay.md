# Gameplay, Expansion & Multiplayer Governance

## 1. Core Warehouse Mechanics & Scoring

Players and AI agents operate forklifts across a live warehouse floor organized into storage districts, inbound west docks, outbound shipping bays, east cross-site transfer bays (`→ network`), and charging stations.

### Pickup & Drop Reach (`1.6` Tiles)
- Every vehicle has an interaction reach of **1.6 tiles** (`REACH_TILES = 1.6`) from its center to the target pickup rack, dock pallet, or shipping bay.
- When a human driver is within `1.6` tiles of a valid pickup or drop target, the HUD highlights the guide ring (`inRange = true`) and pressing `E` (sending `{ type: 'interact' }`) picks up or stows the pallet.

### Order Scoring & Value Series
- **Standard Orders**: Award base contract points upon delivery to the designated outbound bay before the order's due time. Early deliveries earn slack bonuses; late deliveries incur penalties.
- **P0 Critical Orders**: High-priority urgent contracts with tight deadlines and elevated point rewards.
- **Inbound Network Transfers**: Pallets arriving at the west docks from sibling sites (`den-1`, `slc-2`, `phx-3`, `abq-4`) award a **+5 point bonus** to the driver or agent who stows them.
- **Shift vs. Lifetime Points**:
  - **Shift points** are tracked on the active site shard (`valueSeries` chart, shift leaderboard, and site Hall of Fame at shift end).
  - **Lifetime points** and delivery totals are persisted in Firestore under `players/{clientId}` and follow the player across site transfers.

---

## 2. Skill Cards

At the start of each shift (shift deal), every driver and AI agent is dealt **3 skill cards** and selects which cards to keep (`keepCards` message for humans; `cards` decision kind for Gemini brains).

Cards modify vehicle or contract mechanics for the duration of the shift, such as:
- **Overdrive / High-Torque Motor**: Increases top travel speed at the cost of faster battery drain.
- **Deep Cycle Battery**: Extends battery capacity and increases regenerative braking or charger speed.
- **Long Forks**: Slightly extends effective interaction convenience and load stability on turns.
- **All-Terrain Tires**: Reduces skid risk and speed penalty when pushing through floor spills.
- **Express Courier / Network Broker**: Bonus points on P0 orders or cross-site `→ network` transfers.

---

## 3. Facility Tiers & Expansion (Up to Tier 6 / 60 Vehicles)

Each warehouse site dynamically expands its floor plan as the active vehicle count grows:
- **Maximum Tier**: `MAX_TIER = 6`.
- **Fleet Capacity Formula**: `FLEET_CAP = 24 + 6 * tier`. At Tier 6, a site supports up to **60 concurrent vehicles** (`24 + 6 × 6 = 60`), accommodating up to **32 human/pilot drivers** plus **20–28 AI agents** with headroom.
- **One Vehicle Per Driver**:
  - When a driver joins a shard, a **new player vehicle** is spawned on a free highway tile and leased to that player (`1 vehicle per player`, expiring after `5 s` without input). When the player disconnects or releases the lease, temporary player vehicles are removed.
  - Alternatively, a driver may click **"Take the Wheel"** (`takeWheel { vid }`) on any AI agent's vehicle; that AI agent's Gemini brain pauses while the human drives and resumes as soon as the human releases the vehicle.
- **Expansion & Compaction Rules**:
  - Adding player vehicles or using `Fleet +` (`fleetAdd`) increases the total vehicle count, triggering seamless map tier expansion (chunked `RenderTexture` floor re-bake on the client).
  - The facility **never shrinks during an active shift**.
  - During a **factory break** (`phase === 'break'`), the facility may compact back down to the minimum tier needed for its remaining base vehicles.

---

## 4. Multiplayer Governance Limits

Because the game runs on a public URL without login, all strategy board actions are governed by strict per-player and site-wide rate limits enforced on the authoritative site server:

| Action | Who Can Trigger | Enforced Limit | Notes |
|---|---|---|---|
| **Drive / Take the Wheel** | Anyone | **1 vehicle per player** (max 2 driver sessions per `clientId`) | Spectators can watch without leasing a vehicle. Vehicle lease expires after 5 s of no input. |
| **Rush Wave** (`rush`) | Anyone | **Site-wide cooldown of 30 game-min**; max **1 per player per game-hour** | Spawns a burst of high-value orders. Logged in the event stream with the player's name (e.g., `"Jason: rush wave"`). |
| **P0 Order** (`p0`) | Anyone | **1 per player per game-hour**; max **3 open P0 orders** on the site simultaneously | Spawns an urgent P0 contract. |
| **Safety Cones** (`cone`) | Anyone | Up to **6 live cones per player**; expire after **60 game-min**; players can remove their own | Cones block/reroute A* pathfinding. Cannot be placed on shipping bays, chargers, or pickup tiles. |
| **Fleet + / −** (`fleetAdd` / `fleetRemove`) | Anyone | **+1 per player per 10 game-min**; site cap is **60 vehicles** (`FLEET_CAP`) | Only **player-added** AI agents can be removed via `fleetRemove` (core site agents cannot be despawned). |
| **Difficulty Level** (`voteDifficulty`) | **Vote by connected drivers** | Applied at the **next shift change** via simple majority of connected drivers | Ties keep the current difficulty level. The HUD displays the live vote tally. Cannot be changed via `nlCommand`. |
| **Typed Orders** (`nlCommand`) | Anyone | **6 per player per real minute** (and **30 per IP per minute**) | Parsed by Gemini after Model Armor inspection, then clamped by the **exact same governance limiter** as the corresponding button. |

---

## 5. Cross-Site Transfers

- **Outbound (`→ network`)**: Orders tagged with `dest: { siteId }` must be delivered to one of the two east **transfer bays**. Dropping the pallet emits a `TransferOut` event and publishes a `Transfer` payload to Pub/Sub (`site-transfers`).
- **Inbound (West Docks)**: The destination site receives the Pub/Sub push at `/internal/transfer` and invokes `receiveTransfer(world, transfer)` (idempotent by `transfer.id`), placing an inbound pallet at a west dock with a **+5 stow bonus**.
- **Player Site Switching**: Players can open the **Network** panel in the left HUD to inspect live driver counts, facility tiers, phases, and shipped totals across `DEN-1`, `SLC-2`, `PHX-3`, and `ABQ-4`. Clicking **Transfer** (`transferSite`) releases their current vehicle and reconnects them to the target shard via the lobby while preserving their `clientId` profile and lifetime score.
