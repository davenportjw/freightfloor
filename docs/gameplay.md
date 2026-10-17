# Gameplay, Expansion & Multiplayer Governance

## 1. Core Warehouse Mechanics & Scoring

Players and AI agents operate forklifts across a live warehouse floor organized into storage districts, inbound west docks, outbound shipping bays, east cross-site transfer bays (`→ network`), and charging stations.

### Pickup & Drop Reach (`1.6` Tiles)
- Every vehicle has an interaction reach of **1.6 tiles** (`REACH_TILES = 1.6`) from its center to the target pickup rack, dock pallet, or shipping bay.
- When a human driver is within `1.6` tiles of a valid pickup or drop target, the HUD highlights the guide ring (`inRange = true`) and pressing `E` (sending `{ type: 'interact' }`) picks up or stows the pallet.

### Vehicle Collisions, Occupancy, Speed Boost & Pallet Drop
- **Vehicle-to-Vehicle Collisions & Occupancy**: Dedicated player vehicles (`DRV-*`) and human-taken AI vehicles register in floor occupancy (`buildOccupancy`) and space reservations (`res`) so AI agents and other human drivers see and yield to them. Driving into any AI or player vehicle stops movement immediately (`speedNow = 0`), triggers a 4-minute stun `incident` on both vehicles when `|speedNow| > 1.3` tiles/min, and allows reversing or steering away cleanly after contact. Player vehicles also skid if driving over floor spills at `|speedNow| > 1.2`.
- **Speed Boost**: Holding **`Shift`** or **`Space`** (or pressing and holding the HUD **`⚡ Boost [Shift]`** button in the drive bar) engages **Speed Boost** (`BOOST_SPEED_MUL = 1.65`, `+65%` top speed and faster acceleration while battery `> 0%`).
- **High-Speed Collision Risk**: Colliding with a rack, wall, safety cone, or another vehicle while boosting (`inp.boost` or `|speedNow| > 3.05` tiles/min) immediately **drops any carried pallet** (`v.cargo`) back onto the warehouse floor at the vehicle's current tile (`state = 'open'`, `claimant = null`, `slot` updated to `(tile.x, tile.y)`), lowers the forks, increments `day.damaged`, stuns the vehicle, and emits an `incident` event so the dropped pallet can be re-picked by you or any other driver/AI agent.

### Order Scoring & Value Series
- **Standard Orders**: Award base contract points upon delivery to the designated outbound bay before the order's due time. Early deliveries earn slack bonuses; late deliveries incur penalties.
- **P0 Critical Orders**: High-priority urgent contracts with tight deadlines and elevated point rewards.
- **Inbound Network Transfers**: Pallets arriving at the west docks from sibling sites (`den-1`, `slc-2`, `phx-3`, `abq-4`) award a **+5 point bonus** to the driver or agent who stows them.
- **Returns & QA Containment Bay (`RET`)**: An interior drop bench at `(x: 10..12, y: 32, dropX: 11)` inside the **Returns & QA** zone (`x: 9..17, y: 31..35`). Routing Hazmat (Zone Z) or inspection pallets to `RET` awards a **+6 point containment bonus** upon delivery and auto-clears the QA inspection batch when full (`8/8`) without trailer departure downtime.
- **Shift vs. Lifetime Points**:
  - **Shift points** are tracked on the active site shard (`valueSeries` chart, shift leaderboard, and site Hall of Fame at shift end).
  - **Lifetime points** and delivery totals are persisted in Firestore under `players/{clientId}` and follow the player across site transfers.

### 5-Minute Blitz Mode vs. Free Range Mode, Fast Charging & Limp Mode
- **Auto-Assigned Callsigns & Resume Lookup**: Human drivers are automatically assigned a unique, non-overlapping `Adjective-Noun` callsign by the lobby server (`generateDriverCallsign`, e.g. `Turbo-Badger`, `Cosmic-Forklift`, `forklift-42`) rather than choosing arbitrary freeform handles. Players can copy their assigned callsign or `clientId` and enter it in the **Resume** field (`#introCallsign` or the Drivers HUD panel) on any browser or device to look up and restore their callsign and lifetime score.
- **Two Personal Run Modes (`runMode`)**:
  - **⏱️ 5-Minute Blitz (`'blitz'`, default)**: A personal 5-real-minute (`BLITZ_DURATION_MIN = 300` game-min at 10 Hz) high-score run whose clock only starts when you actually play — your first steering input, keeping your opening cards, or engaging Co-Pilot (idle time on the intro never burns run time; `runGraceUntil` / `RUN_CARD_GRACE_MIN = 15` is informational only). If a run ends while the intro is open, the `#runEnd` modal waits until the intro closes. Your personal timer and stats (`runPts`, `runDeliveries`, `runOnTime`, `runIncidents`, `streak`, `bestStreak`) are completely decoupled from global 480-minute site shift rollovers (`onShiftEnd`). When your 5-minute countdown expires, `runFinished` becomes `true` and the **5-Minute Blitz Complete** modal (`#runEnd`) opens with your Final Score, Best Streak, Pallets & PPM (`computeDriverPpm`), Shift Rank, and Safety Record.
  - **🌐 Free Range (`'freerange'`)**: Open-ended sandbox driving with no personal countdown timer, normalized by **PPM** (Points Per Real Minute) and **On-Time %** (`computeDriverOnTimePct`) on the leaderboard. Drivers can switch modes at any time via `{ type: 'setRunMode', mode }` from the initial card deal modal or the drive bar pill.
- **Fast Pit-Stop Charging & Limp Mode at `0%` Battery**:
  - Reaching `0%` battery in Blitz mode **does not end your run**. Instead, at `0%` battery, Speed Boost is disabled and top speed drops to `55%` (`batFactor = 0.55`, or `0.72` below `10%`), allowing you to limp to any green charger pad.
  - Stopping on a charger pad automatically engages fast pit-stop charging (`15%/s` plus any card `chargeBonus`, recharging `0% → 100%` in ~6.7 real seconds), or you can press `E` on a charger pad.
- **Retry with a New Run (`Run N+1`)**: Clicking **🏁 Play Again — Start `<Name> Run N+1`** at the end of a 5-Minute Blitz records the completed run's score (and `bestBlitzPts`) to lifetime player stats, increments the player's screen name to the next run number (`Run 2`, `Run 3`, ...), and spawns a fresh `100%`-battery vehicle with a new 3-card contract offer.

---

## 2. Fares (speed rating, combo & delivery streaks)

Every delivered pallet is a **fare**, rated against a **par time** fixed at pickup (the "planner's" estimate for the loaded leg).

- **Par** (`parLoadedFor` / `parFor`): the `findPath` route from the pickup access tile to the nearest tile of the order's bay, timed tile by tile at `PAR_BASE_SPEED = 4.2` × floor-kind speed × difficulty speed, times `PAR_OVERHEAD = 1.35`, plus `PAR_DROP_TIME = 0.75` game-min of fork time. Deterministic for a given map, cones and heat. Stamped on the order as `parLoaded` at pickup (human `E` pick or AI fork timer).
- **Rating** (`rateFare`), with `actual = deliveredAt − pickedAt`:

| Rating | Condition | Points multiplier |
|---|---|---|
| **Speedy** | on time and `actual ≤ 0.8 × par` | **1.5×** |
| **Normal** | everything else (or no par) | **1.0×** |
| **Slow** | `actual > 1.3 × par` **or late** (past `due`) | **0.5×** |

- **Delivery Streak Multiplier (`streakMultiplier`)**: Consecutive on-time deliveries increment `v.streak` (and update `v.bestStreak`), multiplying order points on on-time deliveries:
  - `streak >= 8`: **`×1.5`**
  - `streak >= 5`: **`×1.3`**
  - `streak >= 3`: **`×1.15`**
  - `streak < 3`: **`×1.0`**
  - Late deliveries, crashes (`incident`), or dropping a pallet on boost collision reset `v.streak = 0`.
- **Fare points** = `(order value + bonuses) × rating multiplier × combo × (1 + payoutBonus) × streakMultiplier`. Bonuses: `+6` RET containment, legacy card `ptsBonus`/`p0Bonus`. `payoutBonus` is only non-zero while a **High Roller** wild card is active (+25%).
- **Combo meter** (`COMBO_STEPS`): `×1.0 → ×1.2 → ×1.5 → ×2.0` (cap). Each non-Slow fare steps it up *after* paying at the current combo. It resets to `×1.0` on a **Slow** fare, a **crash** (incident), a **dropped pallet** (boost collision) or a **spill skid**, emitting `combo_reset`.
- **Battery tip (humans only)**: `+3%` per Speedy fare, `+1%` per Normal, `+1%` extra when 2+ pallets land in one drop (batch). Slow fares tip nothing; AI never gets tips.
- **Trailer Closer**: dropping the pallet that fills a regular outbound trailer (`bay.load` reaches `cap`; not RET or transfer bays) pays a flat **+5** and steps the combo once more (`trailer_closer` event).
- **Crazy Stop (precision stop)**: braking from above `4.0 × difficulty speed` to below `0.8 × difficulty speed` arms a stop point (stopping against a wall doesn't count). A pick or drop within `PRECISION_WINDOW_MIN = 2.0` game-min whose target is inside the reach ring of that point emits `precision_stop` and advances the Crazy Stop card.
- **Calibration**: with `PAR_OVERHEAD = 1.35` the AI fleet (tactics speed 1.15, seed 424242, 3 000 ticks) rates ~66% Normal, ~1% Speedy and ~33% Slow (Slow is mostly congestion/lateness). Speedy is meant to be a human skill: clean lines and boost (`×1.65`) beat par. Guarded by `packages/sim/test/fare.test.ts`.

> Time units: the server ticks at 10 Hz with `dt = 0.1` game-min, so **1 game-min ≈ 1 real second**. A 5-Minute Blitz run is `BLITZ_DURATION_MIN = 300` game-min (≈ 300 s / 5 real minutes) whose clock starts on first move, card pick, or Co-Pilot (never while idle). The contract reservation and Last Call windows are **90 game-min (≈ 90 s)**; the precision window is 2 game-min (≈ 2 s).

Every fare emits a `fare` event (`{vid, orderId, rating, actual, par, combo, pts}`); vehicles keep the last 10 in `fareLog` and per-run `fareTrips`, `speedyTrips`, `combo`, `comboBest` (sent on driver deltas, shown on the combo meter and run-end screen).

---

## 3. Skill Cards

At the start of each shift (or blitz run) every driver and AI agent is dealt **3 cards** and keeps at least one (`keepCards` for humans; `cards` decision kind for Gemini brains).

- **Permanent Perks & Active Modifiers**: Both active cards (`status === 'active'`) and completed cards (`status === 'done'`) contribute their buffs (`card.perk ?? card.modifiers`) to the vehicle (`driverCardModifiers`). In **5-Minute Blitz**, completed card perks persist for the entire run; in **Free Range**, completed card perks last `180` game-min after `completedAt`. Combined caps (`PERK_CAPS`): speed ≤ `1.25×`, reach ≤ `+0.5`, battery drain ≥ `0.7×`, fork speed ≤ `1.5×`, combo floor ≤ `×1.2`.
- **Hand limit** `HAND_LIMIT = 3` active cards; **at most one wild** card held.
- **Wild cards**: each deal has a `WILD_CHANCE = 20%` slot for a wild card, only if you don't already hold one.
- **Auto-Redraw Replacement Deals**: Whenever a human driver completes, loses, or has a card poached and holds fewer than 2 active cards (`activeCount < 2`, or `< 3` via `maybeOfferReplacement`) with no pending `hand.offer`, the engine automatically deals a replacement offer (`dealCards(w, key, true)`) so drivers always have fresh objectives.
- **humanOnly** cards are never dealt to AI agents (and are filtered out of the brain prompt).
- **Route contracts** (purple pallets, `type: 'route'`): `Zone → Bay` deliveries. Their pallets are **reserved for the owner** for `CONTRACT_RESERVE_MIN = 90` game-min (≈ 90 s; rivals and AI can't claim or pick them). After that a rival can take them; delivering one **poaches** it: the owner's card is lost (`poach` event with `cardId`) and the owner gets a replacement offer. Perk: `+0.1` reach.
- **Legacy & Modifier Cards** (`Turbo Courier`, `Tele-Fork Extension`, `Regen Capacitor`, `Priority Broker`) apply their speed, reach, charge rate, and order point bonuses both while active and after completion.

| Card | Type | Goal | Pts | Perk (once done) | Notes |
|---|---|---|---|---|---|
| Speed Demon | `quick` | 2 Speedy fares | 20 | +8% speed | |
| No Slowpokes | `ontime` | 5 fares in a row without Slow | 25 | +5% speed, +0.1 reach | Slow resets progress |
| Carpool | `batch` | 2+ pallets in one drop | 20 | +0.2 reach | only dealt when feasible |
| Clean Shift | `clean` | finish the run crash-free | 20 | −15% drain | lost on a crash |
| Juice Saver | `charge` | finish the run above 40% battery | 15 | −15% drain | |
| Overdrive | `overdrive` | deliver 2 pallets | 10 | +15% speed | |
| Long Reach | `long_reach` | deliver 2 pallets | 10 | +0.35 reach | |
| Eco Cell | `eco_cell` | deliver 2 pallets | 10 | −25% drain | |
| Trailer Closer | `trailer_closer` | close 2 trailers | 25 | +0.1 reach | |
| Crazy Stop | `crazy_stop` | 3 precision stops | 15 | forks 1.5× faster | humanOnly; fork speed only affects autopilot/Co-Pilot fork timers |
| Combo King | `combo_king` | reach ×2.0 combo | 30 | combo never resets below ×1.2 | humanOnly |
| Beat the Planner | `beat_planner` | 3 loaded legs ≤ 0.8× par | 30 | +0.15 reach | humanOnly |
| High Roller | `high_roller` | 4 deliveries | 20 | — | **wild**; +25% fare points while active; a crash costs an extra incident penalty and burns it |
| Double or Nothing | `double_nothing` | 3 Speedy in a row | 40 | — | **wild**; any non-Speedy fare burns it |
| Last Call | `last_call` | — | +10 per Speedy | — | **wild**; pays `LAST_CALL_PTS = 10` per Speedy fare in the final `LAST_CALL_MIN = 90` game-min of the run (or shift); done if it paid at least once, else expires |
| Turbo Courier | `quick` | 2 pallets within 6 min of pickup | 25 | — | legacy: +18% speed, +4 pts/order **while active** |
| Tele-Fork Extension | `batch` | a 2-pallet batch | 20 | — | legacy: +0.55 reach, +2%/s charge while active |
| Regen Capacitor | `charge` | stay above 40% battery | 15 | — | legacy: −35% boost drain, +4%/s charge while active |
| Priority Broker | `ontime` | 3 on-time pallets | 30 | — | legacy: +12 pts on P0, +3 pts on all orders while active |

Typed but not yet dealt (Phase 3): `long_haul`, `local_hero`, `poacher`, `rival_grudge`, `ghost_hunter`.

---

## 4. Facility Tiers & Expansion (Up to Tier 6 / 60 Vehicles)

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

## 5. Multiplayer Governance Limits

Because the game runs on a public URL without login, all strategy board actions are governed by strict per-player and site-wide rate limits enforced on the authoritative site server:

| Action | Who Can Trigger | Enforced Limit | Notes |
|---|---|---|---|
| **Drive / Take the Wheel** | Anyone | **1 vehicle per player** (max 2 driver sessions per `clientId`) | Spectators can watch without leasing a vehicle. Vehicle lease expires after 5 s of no input. |
| **Rush Wave** (`rush`) | Anyone | **Site-wide cooldown of 30 game-min**; max **1 per player per game-hour** | Spawns a burst of high-value orders. Logged in the event stream with the player's name (e.g., `"Turbo-Badger: rush wave"`). |
| **P0 Order** (`p0`) | Anyone | **1 per player per game-hour**; max **3 open P0 orders** on the site simultaneously | Spawns an urgent P0 contract. |
| **Floor Dispatch** (`dispatch`) | Anyone | **10 real-second cooldown per player** (`DISPATCH_PLAYER_COOLDOWN_SEC = 10`) | Routes/spawns up to `1..6` orders from a source zone (`haz`, `cold`, `bulk`, `high`, `dock`, `any`) to a target bay (`RET`, `E1..E8`, `any`) and assigns nearest idle AI forklifts. |
| **Safety Cones** (`cone`) | Anyone | Up to **6 live cones per player**; expire after **60 game-min**; players can remove their own | Cones block/reroute A* pathfinding. Cannot be placed on shipping bays, chargers, or pickup tiles. |
| **Fleet + / −** (`fleetAdd` / `fleetRemove`) | Anyone | **+1 per player per 10 game-min**; site cap is **60 vehicles** (`FLEET_CAP`) | Only **player-added** AI agents can be removed via `fleetRemove` (core site agents cannot be despawned). |
| **Difficulty Level** (`voteDifficulty`) | **Vote by connected drivers** | Applied **immediately** when a mode has a plurality or `>= 50%` of active connected player votes (and re-evaluated at shift rollover) | Four tiers: **Easy** (`speed ×1.0`, `demand ×1.0`, old Medium baseline), **Medium** (`speed ×1.15`, `demand ×1.3`), **Hard** (`speed ×1.3`, `demand ×1.65`), and **Turbo** (`speed ×1.6`, `demand ×2.1`, `score ×2.2`). Cannot be changed via `nlCommand`. |
| **Typed Orders** (`nlCommand`) | Anyone | **6 per player per real minute** (and **30 per IP per minute**) | Parsed by Gemini after Model Armor inspection, then clamped by the **exact same governance limiter** as the corresponding button. Ambiguous commands return a live `a2uiScreen` clarification card. |
| **Co-Pilot & Agent Directives** (`agentCommand`) | Driver (own vehicle or idle AI vehicle) | **6 per player per real minute** when natural-language `text` is included | Directs your own vehicle's Co-Pilot Autopilot (`autopilot: true/false`), strategy persona (`Sprinter`, `Hauler`, `Strategist`, `Sentinel`), tactics (`respect`, `speed`), zone focus (`haz`, `cold`, `bulk`, `high`, `dock`, `any`), priority (`p0`, `transfers`, `slack`, `any`), and immediate task (`charge`, `deliver`, `pickup`, `patrol`). Pressing `W/A/S/D` immediately disengages `autopilot` for manual driving; pressing `Esc` re-engages Co-Pilot. |

---

## 6. Cross-Site Transfers & Regional Factory Specialties

Each of the four regional shards has its own distinct warehouse floor layout, district architecture, visual palette, and specialized cargo models:

| Site ID | Facility Name | Specialty & Visual Theme | Cargo Models (`cargoKind`) | SKU Prefix |
|---|---|---|---|---|
| **DEN-1** | **Rocky Mountain Freight Hub** | Alpine Logistics & General Freight (Cool Slate & Pine) | Banded shipping cartons, cold-chain coolers, and hazmat drums (`boxes`) | `DEN` |
| **SLC-2** | **Bonneville Hydroponics & Nursery** | Living Botanicals & Terrariums (Greenhouse Sage & Emerald) | Terracotta planters with lush leafy crowns, blooming succulents, and nutrient tanks (`plants`) | `BOT` |
| **PHX-3** | **Sonoran Silicon & Solar Fab** | Cleanroom Wafer Pods & Cryo-Optics (Cleanroom Cyan & Cobalt) | FOUP silicon wafer pods, solar-cell array crates, and liquid-nitrogen Dewars (`tech`) | `FAB` |
| **ABQ-4** | **Mesa Verde Kiln & Artisan Works** | Adobe Pottery, Glassware & Kiln Goods (Terracotta & Turquoise) | Banded adobe amphorae, turquoise-glazed ceramics, and kiln crucible casks (`artisan`) | `KLN` |

- **Outbound (`→ network`)**: Orders tagged with `dest: { siteId }` must be delivered to one of the two east **transfer bays**. Dropping the pallet emits a `TransferOut` event and publishes a `Transfer` payload to Pub/Sub (`site-transfers`).
- **Inbound (West Docks)**: The destination site receives the Pub/Sub push at `/internal/transfer` and invokes `receiveTransfer(world, transfer)` (idempotent by `transfer.id`), placing an inbound pallet at a west dock with a **+5 stow bonus**.
- **Player Site Switching**: Players can open the **Network** panel in the right HUD to inspect live facility names, specialties, driver counts, facility tiers, phases, and shipped totals across `DEN-1`, `SLC-2`, `PHX-3`, and `ABQ-4`. Clicking **Switch** (`switchSite`) releases their current vehicle and reconnects them to the target shard via the lobby while preserving their `clientId` profile and lifetime score.

---

## 7. Client UI & Controls

The client is a full-bleed isometric (2.5D) floor with frosted HUD panels floating over it, matching [`docs/design/mock-v4.html`](design/mock-v4.html). Everything shown comes from the live site server. When nothing has arrived yet, or a call fails, the HUD shows `—` or the real error; it never shows placeholder numbers.

### Panels (all collapsible & hideable)

| Panel | Zone | Default | Collapsed pill shows |
|---|---|---|---|
| Floor (KPI bar): clock, shift/phase, Shipped/On-time/Incidents/Backlog/Lost, site, brain health, connection | top-left | open | clock · shipped · on-time |
| Strategy Board: `/hr`, On-time, ⚠ incidents, kWh/order; click a row to highlight that team | left | open | leading team `/hr` |
| Drivers (Presence): connected players/drivers, driver cap, assigned callsign & resume lookup | right | collapsed | you · driver count/cap |
| Fleet: vehicle count, wing tier, `+ Agent` / `−` controls, AI vs. human breakdown | right | collapsed | vehicles · wing tier |
| Leaderboard: rank, shift countdown, top 5 + your row, difficulty vote, hall of fame, Full Board button | right | open | your rank & shift countdown |
| Value Created chart: 4h/8h/24h windows, Human drivers / Agent avg / Best agent | right | collapsed | latest values |
| Network: live sites from `/api/network`, Switch | right | collapsed | site count |
| Inspector | bottom-left | shown only while a vehicle is selected (✕ closes) | — |
| History drawer: Leaderboard · Value · Days · Events · Brain log | right edge | closed | — |

- Clicking a panel header folds it to a compact summary pill. The choice is saved in `localStorage` (`warehouse.panel.<id>`), so it survives a reload.
- In the top-right toolbar:
  - **Fold** collapses all open panels into compact 1-line summary pills (or expands them if all are folded).
  - **Panels** hides or restores the left and right side docks (`Floor`, `Strategy Board`, `Drivers`, `Fleet`, `Leaderboard`, `Value Created`, `Network`) while keeping the top toolbar and bottom command bar visible.
  - **🏆 Leaderboard** (`[data-action="open-leaderboard-modal"]`, or hotkey `L`) opens or closes the **Full-Screen Leaderboard & Silly Superlatives** modal (`#leaderboardModal`), displaying: (1) full **Live Shift Standings** across all human and AI vehicles with deliveries, crashes, and dropped pallets, (2) **Floor Superlatives & Silly Awards** (*Demolition Derby Champion*, *Butterfingers Award*, *Tokyo Drift Laureate*, *Thread-the-Needle*, *Living on a Prayer*, and *Parking Brake Award*), and (3) **Cross-Site Network Champions & Shift Hall of Fame**.
  - **Intro & Rules ?** (`[data-action="open-intro"]`) opens or closes the full-screen **Intro Page** (`#help`) at any time.
- Below 1366 px wide, panels that are open by default start folded, unless you have explicitly chosen a state for them.
- **Intro Page (`#help`)**: Opens by default on both initial and subsequent visits (`shouldShowHelpOnBoot`, unless `localStorage['warehouse.help.seen'] === 'skip'`). Uses the same slate/white palette as the HUD and keeps text short, with two tabs (`[data-intro-tab]`):
  - **🎮 How to Play (`[data-pane="rules"]`, default)**: Three step tiles (`.intro-step`): **Drive** (WASD), **Pick up** (`E` at a glowing pallet), **Deliver** (`E` at the blue Shipping Bay). Below them are scoring chips (`+10` pallet, `+40` ★ rush order, `−15` crash, `Shift` boost drops your load on a crash, green charger pad), the goal line, and a collapsed **All controls** hotkey table.
  - **🧠 The AI Inside (`[data-pane="ai-concepts"]`)**: Four one-line concept cards (`.ai-concept-card`): fast reflexes vs. slow thinking (10 Hz local A* + async `gemini-3.5-flash-lite`), competing personas (Strategy Board), glass-box decisions (Inspector / Brain log, real errors surfaced), and safe, cheap prompts (Model Armor + context caching).
  - **Footer (`[data-action="close-intro"]`)**: The server-assigned callsign badge (`#introAssignedCallsign`), an optional **Resume** field (`#introCallsign`), and a **"Start driving →"** button. The button closes the intro and calls `quickDrive()`, so the player starts in a free forklift right away. If none is free, a toast says so.

### Hotkeys

Hotkeys never fire while you are typing in a text box. Driving keys are only captured while you are driving.

| Key | Action |
|---|---|
| W A S D / arrows | Drive (instant manual takeover from Co-Pilot; only while driving; key auto-repeat is ignored and keys are released when the window loses focus) |
| Shift / Space | Speed boost (+65% speed; collisions drop carried pallets!) |
| E | Pick up / drop / charge (only while driving; charging on a charger pad adds `+5%/min` with a rising `⚡ +5` floating visual cue, ascending energy ring, and Inspector badge) |
| G | Open / close Co-Pilot & Agent Designer modal (`#agent-designer-modal`) |
| T | Take the wheel of the selected vehicle |
| Esc |Close modal (`#agent-designer-modal`, `#help`, `#leaderboardModal`), hand back AI vehicle, or engage Co-Pilot Autopilot if driving manually |
| L | Toggle Full-Screen Leaderboard & Silly Superlatives modal (`#leaderboardModal`) |
| Tab | Hide / show all panels (clean floor view) |
| H | Open / close the history drawer |
| B | Fold / unfold the Strategy Board |
| 1 / 2 / 3 | Toggle the Routes / Traffic / Labels layers (Traffic subscribes to the server heat layer) |
| C | Toggle cone mode (click the floor to place a cone) |
| ? | Toggle Intro & Rules page (`#help`) |

The command bar's buttons and Quick Intent Pills:
- **🤖 My Car: P0s**: immediately engages Co-Pilot Autopilot on your own forklift with P0 rush contract priority.
- **☣ Hazmat → Returns**: immediately dispatches 2 Hazmat (Zone Z) pallets to the Returns & QA containment bay (`RET`, `+6` bonus pts) with P0 priority.
- **❄ Cold → Bay E2**: immediately dispatches 2 Cold Storage (Zone W) pallets to East Dock Bay `E2` with P0 priority.
- **🔥 Clear Backlog**: expedites up to 3 open floor orders to P0 priority and dispatches nearest idle forklifts.
- **🎯 Objectives**: toggles the interactive **A2UI Floor Objective & Route Clarification Builder** card above the command bar, showing real-time floor telemetry (`Open Orders`, `Hazmat Queue`, `Returns & QA`, `Dispatch Status`), interactive chips for `sourceZone`, `targetBay`, `priority`, and `count`, and 1-click floor presets.
- **🤖 Co-Pilot `[G]`**: opens the **Co-Pilot & Agent Designer** modal (`#agent-designer-modal`), where you can toggle **Co-Pilot Autopilot** vs. **Manual WASD**, choose an AI persona (`Sprinter`, `Hauler`, `Strategist`, `Sentinel`), tune `Speed` and `Safety` sliders, select district focus zones (`haz`, `cold`, `bulk`, `high`, `dock`) and contract priority (`p0`, `transfers`, `slack`), trigger 1-click Quick Intent Pills, or type a natural-language directive to your forklift's Gemini brain.
- **🚜 Drive**: takes the selected AI vehicle, otherwise the best idle agent with more than 35% battery that is not stunned.
- **⚡ Rush wave**: posts an immediate 12-order wave, boosts order arrivals (`+32/hr`), and tightens deadlines for 30 game-minutes (shows live `⚡ Rush (Xm)` countdown while active).
- **★ P0 order**: posts 1 urgent 40-pt contract with a 30-minute deadline (shows live `★ P0 (N/4)` count when open P0 orders are on the floor).
- **🚧 Cones**: toggles cone mode (`[C]`) to place or remove traffic cones on open floor tiles and reroute AI pathfinding.
- **ⓘ Ops**: toggles an inline Floor & Manager Operations reference card right above the command bar.
- **🤖 My Car / 🏭 Floor toggle**: switches the natural-language command input between floor-wide manager dispatch (`nlCommand`) and personal Co-Pilot instructions (`agentCommand`).

Typed orders go through Model Armor and the same limiter as the buttons. Natural-language district/bay routing commands (e.g. `"get hazmats to returns"`, `"move cold storage to bay E2"`) execute directly via `dispatchOrderRoute`, while ambiguous or exploratory commands (e.g. `"help"`, `"what can I do"`, `"reroute"`) open the live `a2uiScreen` clarification builder.

