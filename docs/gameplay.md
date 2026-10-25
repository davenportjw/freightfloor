# Gameplay, Expansion & Multiplayer Governance

## 1. Core Warehouse Mechanics & Scoring

Players and AI agents operate forklifts across a live warehouse floor organized into storage districts, inbound west docks, outbound shipping bays, east cross-site transfer bays (`→ network`), and charging stations.

### Pickup & Drop Reach (`1.6` Tiles) & Opt-In Rack Height Fork-Lift Minigame
- Every vehicle has an interaction reach of **1.6 tiles** (`INTERACT_REACH = 1.6`, plus any card reach perk) from its center to the target pickup rack, dock pallet, or shipping bay.
- When a human driver is within `1.6` tiles of a valid pickup or drop target, the HUD highlights the guide ring (`inRange = true`) and pressing `E` (sending `{ type: 'interact' }`) picks up or stows the pallet.
- **Opt-In Rack Height Fork-Lift Minigame (`rackLiftMinigame`, default `false`)**:
  - Gated behind a multi-layer opt-in feature flag (`enable_rack_lift_minigame = false` in Terraform, `ENABLE_RACK_LIFT_MINIGAME` / `FEATURE_RACK_LIFT_MINIGAME` on `@warehouse/site`, `welcome.limits.rackLiftMinigame`, `?rackLift=1|0` URL query override, `localStorage['warehouse.feature.rackLift']`, and the **☰ → Settings (`⚙`)** flyout toggle). When disabled, pressing `E` uses the classic instant single-tap pickup/stow.
  - **Option A Hold-to-Raise & Release-to-Grab**: Rack slots spawn on 3 shelf elevations (`RACK_LEVEL_FORK_TARGETS`: `L1 Low = 0.14`, `L2 Mid = 0.54`, `L3 High = 0.92`). When within reach of a rack pickup or putaway stow slot (`L2`/`L3`), holding `E` raises the 3D forklift forks (`v.fork`) and displays a world-space vertical **Mast Height Slider** gauge beside the forklift; releasing `E` sends `{ type: 'interact', forkHeight }` to grab or stow at that elevation.
  - **Quick-Tap `< 140 ms` Safety Net**: A quick tap (`< 140 ms`) on `E` (or any `L1 Low` / dock / shipping bay interaction) bypasses the slider and performs a standard pickup/stow with zero penalty.
  - **Perfect Lift (`perfect_lift`)**: Releasing `E` inside the green shelf sweet spot (`evaluateRackLift`: `±0.085` × `forkLiftMul` (the **Crazy Stop** perk, up to `1.5×`) × district (`1.2×` fast, `0.9×` hazmat)) awards a flat **`+$5`** (`+$8` in a hazmat district) straight to your points (`addPts`; it is not added to the pallet's value, so the fare rating and combo never multiply it) and a **`0.6` game-min exit surge: `1.2×` top speed and `1.35×` acceleration** (`liftBoostUntil`). Releasing within `±0.185` (same multipliers) is a clean lift with no bonus.
  - **Slide & Snatch (`slide_snatch`)**: Combining an armed **Crazy Stop** (`precision_stop`) with a **Perfect Lift** triggers a **Slide & Snatch** combo worth **`+$10` total** (`+$5` over `perfect_lift`; `+$13` in a hazmat district).
  - **Forgiving Rack Scrape (`rack_scrape`)**: Releasing `E` outside the shelf target band on `L2`/`L3` still loads or stows the pallet (never fails the pickup), deducts **`-$2`** from your points (`-$4` in a hazmat district; clamped at `0` by `addPts`; the pallet's value is untouched), and applies a brief **`0.45` game-min (`0.55×` top speed) wobble** (`liftScrapeUntil`).

### Vehicle Collisions, Occupancy, Speed Boost & Pallet Drop
- **Vehicle-to-Vehicle Collisions & Occupancy**: Dedicated player vehicles (`DRV-*`) and human-taken AI vehicles register in floor occupancy (`buildOccupancy`) and space reservations (`res`) so AI agents and other human drivers see and yield to them. Driving into any AI or player vehicle stops movement immediately (`speedNow = 0`) and allows reversing or steering away cleanly after contact. Above `COLLISION_SPEED = 1.65` tiles/min (or while at boost risk) the contact is a crash (`incident`):
  - **Rammer** (the vehicle that drove into the other): `CRASH_STUN_MIN = 4` game-min stun, an incident (`runIncidents`, `INCIDENT_PENALTY`), streak and combo reset, a possible pallet drop, and a lost **Clean Shift**.
  - **Victim**: only a short `VICTIM_STUN_MIN = 1` game-min stun — no incident, no penalty, no combo/streak reset, no pallet drop and no Clean Shift failure — **unless it was also driving faster than `COLLISION_SPEED` toward the rammer**, in which case both vehicles take the full crash. The `incident` event carries `vid` (rammer), `victim` and `victimAtFault`. Player vehicles also skid if driving over floor spills at `|speedNow| > 1.2`.
- **Speed Boost**: Holding **`Shift`** or **`Space`** (or pressing and holding the **Boost** meter in the bottom dash) engages **Speed Boost** (`BOOST_SPEED_MUL = 2.2`, `+120%` top speed and faster acceleration while battery `> 0%`).
- **High-Speed Collision Risk**: A crash with another vehicle (`incident`) while boosting **drops all carried pallets** (`v.cargo`); a non-boost crash has a 50% chance to drop one pallet. Colliding with a rack, wall or safety cone while boosting (`inp.boost` or `|speedNow| > 4.35 × difficulty speed` tiles/min, `dropPalletOnCollision`) also drops all carried pallets. Dropped pallets go back onto the warehouse floor at the vehicle's current tile (`state = 'open'`, `claimant = null`, `slot` updated to `(tile.x, tile.y)` at floor level `0`). The crash also lowers the forks, increments `day.damaged`, stuns the vehicle, and emits an `incident` event so the dropped pallet can be re-picked by you or any other driver/AI agent.
- **Points never go negative**: every penalty and award (collision and incident penalties, skids, scrapes, High Roller, fares, card payouts) goes through one helper, `addPts`, which clamps both `sPts` and `runPts` at `0` for humans and AI alike.

### Order Scoring & Value Series
- **Standard Orders**: Award base contract points upon delivery to the designated outbound bay before the order's due time. Early deliveries earn slack bonuses; late deliveries incur penalties.
- **P0 Critical Orders**: High-priority urgent contracts with tight deadlines and elevated point rewards.
- **Inbound Receiving & Putaway (West Docks)**: An inbound trailer drops a pallet at a free west dock about every **18 game-min** (`INBOUND_INTERVAL_MIN = 18`, divided by fleet size ÷ base AI fleet once the floor grows; 1 game-min ≈ 1 real second). Each inbound pallet is a putaway order: pick it at the dock and **stow it at its assigned rack slot** (press `E` within reach of the rack's access tile) for **8 pts** base (`PUTAWAY_VALUE = 8`), rated and comboed like any fare. Due time is 150 game-min × difficulty. Racks hold no inventory counts; they stay infinite sources for outbound picks, and a slot reserved as a pending putaway destination is never used for a new outbound pick.
  - **Cross-Dock Bonus**: For **45 game-min** after arrival (`XDOCK_WINDOW_MIN = 45`), a **human driver** may instead run the pallet straight to its listed outbound bay for **value + 10** (`XDOCK_BONUS = 10`, `xdock` event). After the window closes the bay refuses it ("Cross-dock window closed") and it must be stowed. AI agents never cross-dock and leave a fresh inbound pallet alone for its first **15 game-min** (`XDOCK_AI_HOLD_MIN = 15`), so humans get first shot at the bonus.
  - **Network Transfers**: Pallets arriving from sibling sites (`den-1`, `slc-2`, `phx-3`, `abq-4`) land at a west dock as putaway orders worth **8 + 5 = 13 pts**, with the same cross-dock option.
- **Returns & QA Containment Bay (`RET`)**: An interior drop bench at `(x: 10..12, y: 32, dropX: 11)` inside the **Returns & QA** zone (`x: 9..17, y: 31..35`). Routing Hazmat (Zone Z) or inspection pallets to `RET` awards a **+6 point containment bonus** upon delivery and auto-clears the QA inspection batch when full (`8/8`) without trailer departure downtime.
- **Shift vs. Lifetime Points**:
  - **Shift points** are tracked on the active site shard (`valueSeries` chart, shift leaderboard, and site Hall of Fame at shift end).
  - **Shift rollover banks only the delta**: `onShiftEnd` adds `sPts − bankedPts` to `bank`. A human whose Blitz run is still live keeps their `sPts` (the run is not over) and `bankedPts` is set to it, so the next rollover doesn't bank it twice. Everyone else is zeroed. The value series samples `bank + sPts − bankedPts`, so it doesn't jump at rollover. A new run (`startDriverRun`) resets `bankedPts` to `0`.
  - **Dispatch values are capped**: Floor Dispatch (`dispatchOrderRoute`) can't mint extra points. An urgent reroute is capped at `ORDER_VALUE = 10`, a P0 reroute at `P0_ORDER_VALUE = 40` and a spawned order at its class's standard value.
  - **Lifetime points** and delivery totals are persisted in Firestore under `players/{clientId}` and follow the player across site transfers.

### 3-Minute Blitz Mode vs. Free Range Mode, Fast Charging & Limp Mode
- **Auto-Assigned Callsigns & Per-Browser Identity**: Every new browser is automatically assigned a unique, non-overlapping `Adjective-Noun-NN` callsign by the lobby server (`generateDriverCallsign`, e.g. `Turbo-Badger-42`, `Cosmic-Forklift-11`) rather than choosing arbitrary freeform handles or browsing/assuming other players' names. The Intro modal displays the assigned callsign badge (`#introAssignedCallsign`) with no callsign autocomplete or lookup dropdown. Players can copy their secret **resume code** (`wr1_…`, returned by the lobby as `resumeToken`) from the Drivers HUD panel and paste it on another browser to restore their callsign and lifetime score. Callsigns are public and `clientId`s are private (the leaderboard shows only an opaque `publicId`), so neither resumes across browsers; a bare callsign only works from the same browser that already owns it.
- **Two Personal Run Modes (`runMode`)**:
  - **⏱️ 3-Minute Blitz (`'blitz'`, default)**: A personal 3-real-minute (`BLITZ_DURATION_MIN = 180` game-min at 10 Hz) high-score run whose clock only starts when you actually drive — your first steering or interact (`E`) input, or engaging Co-Pilot (`startBlitzClock`). **Keeping your opening cards does not start the clock** (drive-first), and idle time on the intro never burns run time; `runGraceUntil` / `RUN_CARD_GRACE_MIN = 15` is informational only. Once your Blitz clock starts, the 60s idle eviction is suppressed while the countdown is active so your run always completes at `00:00`. If a run ends while the intro is open, the `#runEnd` modal waits until the intro closes. Your personal timer and stats (`runPts`, `runDeliveries`, `runOnTime`, `runIncidents`, `streak`, `bestStreak`) are completely decoupled from global 480-minute site shift rollovers (`onShiftEnd`). When your 3-minute countdown expires, `runFinished` becomes `true` and the **3-Minute Blitz Complete** modal (`#runEnd`) opens with your Final Score, Best Streak, Pallets & PPM (`computeDriverPpm`), Shift Rank, and Safety Record.
  - **🌐 Free Range (`'freerange'`)**: Open-ended sandbox driving with no personal countdown timer, normalized by **PPM** (Points Per Real Minute) and **On-Time %** (`computeDriverOnTimePct`) on the leaderboard. Drivers can switch modes at any time via `{ type: 'setRunMode', mode }` from the contract pick sheet or by clicking the mode segment of the run capsule (`[data-role="run-mode-pill"]`). A real switch (or restarting a finished run) starts a **completely fresh run** (`setDriverRunMode` → `startDriverRun`): run points, deliveries, streak, combo and fare stats reset (nothing carries into a new Blitz clock), Free Range PPM is measured from the switch (`runStartedAt = w.t`), and the hand is re-dealt for the new mode.
- **Fast Pit-Stop Charging & Limp Mode at `0%` Battery**:
  - Reaching `0%` battery in Blitz mode **does not end your run**. Instead, at `0%` battery, Speed Boost is disabled and top speed drops to `55%` (`batFactor = 0.55`, or `0.72` below `10%`), allowing you to limp to any green charger pad.
  - Stopping on a charger pad automatically engages fast pit-stop charging (`15%/s` plus any card `chargeBonus`, recharging `0% → 100%` in ~6.7 real seconds), or you can press `E` on a charger pad.
  - At `0%` battery, `E` only drops or stows pallets you already carry, or charges; new pickups are refused with a "charge first" hint. Rejoining at `0%` while your Blitz clock is still running keeps your vehicle and run; only a vehicle outside a live Blitz is replaced.
- **Run end releases everything you held**: when a Blitz clock hits `00:00` (or your vehicle is removed), unresolved active cards expire (`Contract expired`). Claimed and carried orders go back to `open` for anyone. Your route pallets lose their `reservedFor` / `card` tag, and fare and hand offers are cleared. Every new vehicle (Run N+1) is dealt a fresh hand.
- **Taking the wheel of an AI truck** (`takeWheel`) parks your dedicated `DRV-*`. Its Blitz clock pauses (no movement, drain or run end), and the clock is shifted forward by the time you were away when you return. The AI's stats are stashed and restored on `release`. Your run on the truck never carries over to the AI, and card perks apply only to the vehicle you are actually driving.
- **Post-Run Slot Release, AFK Eviction, Free-Range Contention Lease & FIFO Waiting Queue**:
  - **Post-Run Driver Eviction (`runEvicted`)**: When a 3-Minute Blitz finishes (`reason: 'run_complete'`), your temporary forklift (`DRV-*`) is despawned and your driver seat is immediately released back to the warehouse pool while you remain connected in spectator Floor view.
  - **60-Second AFK Timeout & 5-Minute Free-Range Contention Lease**: Drivers who are inactive for **60 seconds** before starting a run or in Free Range (`reason: 'afk_timeout'` / `'idle_timeout'`) or who reach the **5-minute Free-Range contention lease** while the shard is near capacity (`drivers >= 28`, `reason: 'freerange_lease_expired'`) also release their driver slot automatically and see the eviction reason on the `#runEnd` sheet.
  - **Play Again / Get Back in Line (`Run N+1`)**: Clicking **Play again `↵`** (or **Get Back in Line `↵`** when all shards are full or you are already queued) on `#runEnd` records the completed run's score (and `bestBlitzPts`) to lifetime player stats, increments your callsign to the next run number (`Run 2`, `Run 3`, ...), and requests a fresh driver seat via `POST /api/join` (`role: 'driver'`).
  - **FIFO Waiting Queue & 20s Seat Claim Lease**: If all shards are at their 32-driver cap (>128 players across the baseline 4 shards, or scaling across dynamic overflow shards like `den-2`, `slc-3`, etc.), you are placed into the FIFO waiting queue while spectating the live floor. The Floor banner (`#floorBanner`) and `#runEnd` sheet display your live queue position, estimated wait (`~Ns`), an **Auto-join when ready** checkbox (`autoClaimSeat`, default on), and a **🚜 Take Driver Seat Now `F`** button when your **20-second seat reservation lease** (`state: 'ready'`) arrives.


---

## 2. Fares (speed rating, combo & delivery streaks)

Every delivered pallet is a **fare**, rated against a **par time** fixed at pickup (the "planner's" estimate for the loaded leg).

- **Par** (`parLoadedFor` / `parFor`): the `findPath` route from the pickup access tile to the nearest tile of the order's bay, timed tile by tile at `PAR_BASE_SPEED = 4.2` × floor-kind speed × difficulty speed, times `PAR_OVERHEAD = 1.35`, plus `PAR_DROP_TIME = 0.75` game-min of fork time. Deterministic for a given map, cones and heat. Stamped on the order as `parLoaded` at pickup (human `E` pick or AI fork timer), together with the difficulty speed at that moment (`parDiffSpeed`). If the difficulty changes mid-leg, the fare is rated against par rescaled by `stamped speed / current speed` (`ratedParLoaded`).
- **Rating** (`rateFare`), with `actual = deliveredAt − pickedAt`:

| Rating | Condition | Points multiplier |
|---|---|---|
| **Speedy** | on time and `actual ≤ 0.8 × par` | **1.5×** |
| **Normal** | everything else (or no par) | **1.0×** |
| **Slow** | `actual > 1.3 × par` **or late** (past `due`) | **0.5×** |

- **Delivery streak (stat only)**: Consecutive on-time deliveries increment `v.streak` (and update `v.bestStreak`, shown on the run capsule and results). There is **no streak multiplier** — the combo meter is the only chain bonus. Late deliveries, crashes you cause (`incident`), or dropping a pallet on boost collision reset `v.streak = 0`.
- **Fare points** = `(order value + bonuses) × rating multiplier × combo × (1 + payoutBonus)`. Bonuses: `+6` RET containment, legacy card `ptsBonus`/`p0Bonus`. `payoutBonus` is only non-zero while a **High Roller** wild card is active (+25%).
- **Combo meter** (`COMBO_STEPS`): `×1.0 → ×1.2 → ×1.5 → ×2.0` (cap). Each non-Slow fare steps it up *after* paying at the current combo. It resets to `×1.0` on a **Slow** fare, a **crash** you cause (incident; a rammed victim keeps its combo), a **dropped pallet** (boost collision) or a **spill skid**, emitting `combo_reset`.
- **Battery tip (humans only)**: `+3%` per Speedy fare, `+1%` per Normal, `+1%` extra when 2+ pallets land in one drop (batch). Slow fares tip nothing; AI never gets tips.
- **Trailer Closer**: dropping the pallet that fills a regular outbound trailer (`bay.load` reaches `cap`; not RET or transfer bays) pays a flat **+5** and steps the combo once more (`trailer_closer` event). A multi-pallet drop that overfills the trailer carries the overflow into the next load (`bay.load = load − cap`).
- **Crazy Stop (precision stop)**: braking from above `4.0 × difficulty speed` to below `0.8 × difficulty speed` arms a stop point (stopping against a wall doesn't count). A pick or drop within `PRECISION_WINDOW_MIN = 2.0` game-min whose target is inside the reach ring of that point emits `precision_stop` and advances the Crazy Stop card.
- **Calibration**: with `PAR_OVERHEAD = 1.35` the AI fleet (tactics speed 1.15, seed 424242, 3 000 ticks) rates about 0–1% Speedy (measured: 0 of 148 fares Speedy, 65.5% Normal, 34.5% Slow; Slow is mostly congestion/lateness). `PAR_OVERHEAD = 1.35` is a deliberate design choice so Speedy is effectively a human-only reward: clean lines and boost (`×2.2`) beat par. Guarded by `packages/sim/test/fare.test.ts`.

> Time units: the server ticks at 10 Hz with `dt = 0.1` game-min, so **1 game-min ≈ 1 real second**. A 3-Minute Blitz run is `BLITZ_DURATION_MIN = 180` game-min (≈ 180 s / 3 real minutes) whose clock starts on first move, first interact, or Co-Pilot (never while idle, and not on keeping cards). The contract reservation and Last Call windows are **90 game-min (≈ 90 s)** in shift (Free Range) play; in a finite blitz run they are clamped to `min(90, runLength / 3)` (`runWindowMin` → `contractReserveMin(v)` / `lastCallMin(v)`, where `runLength = runEndsAt − runStartedAt`, or `BLITZ_DURATION_MIN` before the clock starts), so a default 180-min blitz uses 60 while a shorter run never spends more than a third of itself in either window. The precision window is 2 game-min (≈ 2 s).

Every fare emits a `fare` event (`{vid, orderId, rating, actual, par, combo, pts, base, ratingMul, payoutMul}`, where `base` = order value + bonuses before multipliers and `pts = base × ratingMul × combo × payoutMul`, e.g. `8 → ×1.5 Speedy → ×1.5 combo = 18`); vehicles keep the last 10 in `fareLog` and per-run `fareTrips`, `speedyTrips`, `combo`, `comboBest` (sent on driver deltas, shown on the combo meter and run-end screen).

---

## 3. Skill Cards

At the start of each shift (or blitz run) every driver and AI agent is dealt **3 cards** and keeps at least one (`keepCards` for humans; `cards` decision kind for Gemini brains).

- **3-Minute Blitz deck (`BLITZ_DECK`)**: a Blitz run deals `BLITZ_DEAL_SIZE = 3` cards **once** at run start from a small pool of simple single-goal cards: **Speed Demon, Overdrive, Long Reach, Eco Cell, Trailer Closer, Clean Shift**. No wild cards, no route contracts / poaching, and no replacement offers during the run.
- **Free Range** keeps the full deck below (route contracts, every skill, the wild slot and auto-redraw replacement offers).

- **Permanent Perks & Legacy Modifiers**: A card's `perk` applies **only once it is completed** (`status === 'done'`); while active it gives nothing (`getCardModifiers` / `driverCardModifiers`). In **3-Minute Blitz**, completed card perks persist for the entire run; in **Free Range**, completed card perks last `180` game-min after `completedAt`. Combined perk caps (`PERK_CAPS`): speed ≤ `1.25×`, reach ≤ `+0.5`, battery drain ≥ `0.7×`, boost drain (`drainMul`) ≥ `0.65×`, charger bonus (`chargeBonus`) ≤ `+6 %/s`, fork speed ≤ `1.5×`, combo floor ≤ `×1.2`.
- **Hand limit** `HAND_LIMIT = 3` active cards; **at most one wild** card held.
- **Wild cards** (Free Range / AI only): each deal has a `WILD_CHANCE = 20%` slot for a wild card, only if you don't already hold one.
- **Auto-Redraw Replacement Deals** (Free Range only): Whenever a human driver completes, loses, or has a card poached and holds fewer than `HAND_LIMIT` active cards (`activeCount < 3`, `autoRedrawIfNeeded`) with no pending `hand.offer`, the engine automatically deals a 1-of-2 replacement offer (`dealCards(w, key, true)`) so drivers always have fresh objectives. Blitz runs never get replacement offers.
- **humanOnly** cards are never dealt to AI agents (and are filtered out of the brain prompt).
- **Route contracts** (purple pallets, `type: 'route'`; Free Range deck only): `Zone → Bay` deliveries. Their pallets are **reserved for the owner** for `contractReserveMin(owner)` game-min — `CONTRACT_RESERVE_MIN = 90` (≈ 90 s), clamped to a third of a blitz run (rivals and AI can't claim or pick them). After that a rival can take them; delivering one **poaches** it: the owner's card is lost (`poach` event with `cardId`) and the owner gets a replacement offer. Perk: `+0.1` reach.
- **User cards are perk cards** (`Turbo Courier`, `Tele-Fork Extension`, `Regen Capacitor`, `Priority Broker`): like every other card they unlock their perk on completion and stay within `PERK_CAPS`. Their old payout bonuses were removed (Turbo Courier's `+4 pts/order` dropped; Priority Broker's `+12 P0 / +3 pts` replaced by `+0.15` reach; Tele-Fork reach clipped from `0.55` to the `0.5` cap). Their goals and progress rules are unchanged (Turbo Courier counts trips ≤ 6 min; Priority Broker counts on-time deliveries cumulatively).
- **Legacy modifier cards**: a card with `modifiers` but no `perk` (only possible in old persisted snapshots) still uses the legacy path — its modifiers, including `ptsBonus` / `p0Bonus` / uncapped `chargeBonus` and a `0.55` reach cap, apply while active and after completion.

| Card | Type | Goal | Pts | Perk (once done) | Notes |
|---|---|---|---|---|---|
| Speed Demon | `quick` | 2 Speedy fares | 20 | +8% speed | |
| No Slowpokes | `ontime` | 5 fares in a row without Slow | 25 | +5% speed, +0.1 reach | Slow resets progress |
| Carpool | `batch` | 2+ pallets in one drop | 20 | +0.2 reach | only dealt when feasible |
| Clean Shift | `clean` | finish the run crash-free | 20 | −15% drain | lost on a crash you cause (being rammed doesn't count) |
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
| Last Call | `last_call` | — | +10 per Speedy | — | **wild**; pays `LAST_CALL_PTS = 10` per Speedy fare in the final `lastCallMin(v)` game-min of the run (`LAST_CALL_MIN = 90`, clamped to a third of a blitz run) or the final 90 game-min of the 480-min shift; done if it paid at least once, else expires |
| Turbo Courier | `quick` | 2 pallets within 6 min of pickup | 25 | +18% speed | old `+4 pts/order` payout dropped |
| Tele-Fork Extension | `batch` | a 2-pallet batch | 20 | +0.5 reach, +2 %/s charge | reach clipped from 0.55 to the 0.5 cap |
| Regen Capacitor | `charge` | finish the run above 40% battery | 15 | −35% boost drain (`drainMul 0.65`), +4 %/s charge | boost drain only; base drain unaffected |
| Priority Broker | `ontime` | 3 on-time pallets (cumulative) | 30 | +0.15 reach | old `+12 P0 / +3 pts` payouts replaced by reach |

| Long Haul | `long_haul` | 2 🔴 long-haul deliveries (P0, or loaded par ≥ `LONG_PAR_MIN = 14` min) | 30 | +8% speed | |
| Local Hero | `local_hero` | 4 🟢 short hops in a row (loaded par ≤ `SHORT_PAR_MAX = 10.5` min) | 20 | −10% drain | any other delivery resets progress |
| Poacher | `poacher` | reserve 2 P0 orders via order choice | 25 | +5% speed | humanOnly; progresses on `chooseOrder` (incl. the Co-Pilot timeout pick) of a P0 order |
| Rival Grudge | `rival_grudge` | out-deliver your AI rival in a `RIVAL_GRUDGE_MIN = 90` game-min window | 30 | +5% speed | **wild**, humanOnly; window clamped to a third of a blitz run (`runWindowMin`), resolved at the window end or run end; voided on keep if no AI is on the floor; a loss emits `rival_taunt` |
| Ghost Hunter | `ghost_hunter` | 1 loaded leg ≤ `GHOST_RATIO = 0.7` × par | 25 | — | **wild**, humanOnly |

> The Rival Grudge window is `RIVAL_GRUDGE_MIN = 90` game-min (≈ 90 real seconds; clamped to a third of a blitz run, i.e. 60 game-min in the default 180 game-min 3-Minute Blitz). The original plan said "3 game-min", but since 1 game-min = 1 real second that would be only 3 s; the 90 game-min window is the approved value.

---

## 3b. Order Choice, Co-Pilot & Rival (Phase 3)

Manual (non-bot, non-Co-Pilot) drivers **choose** their next order instead of having it auto-claimed:

- **Options** (`fareOptions`): up to `FARE_OPTION_COUNT = 3` orders, deterministic (no rng). The **Co-Pilot pick** (the old guide scoring: distance − 20 for P0 − 25 for your own contract + 8 if claimed + 18 per closer human) is always first, then the best-scored orders of other colour classes, then the next best. Orders claimed or reserved by someone else are excluded.
- **Colour classes** (`farClassFor`, by the loaded-leg par, vehicle-independent): 🟣 `contract` (your own route-card pallet), 🔴 `long` (P0 or par ≥ `LONG_PAR_MIN = 14`), 🟢 `short` (par ≤ `SHORT_PAR_MAX = 10.5`), 🟡 `cross` (in between). The thresholds were calibrated from the measured loaded-par distribution (p33 ≈ 10.6, p67 ≈ 13.9 game-min).
- **Choosing**: `Q` cycles the highlighted option in the order-choice strip under the objective pill and `F` (or clicking a pill) sends `chooseOrder` (rate-limited to one per `CHOOSE_ORDER_COOLDOWN_SEC = 0.25` s). The order becomes `claimed` for you and the guide arrow follows it. Each option shows its class, value, par and the Co-Pilot's real reason (e.g. `Recommended #42: 6 tiles closer than #17, P0 +20.`).
- **Co-Pilot timeout**: after `FARE_CHOICE_TIMEOUT_MIN = 5` game-min (≈ 5 s) without a choice the Co-Pilot reserves its pick (`fare_choice` event with `auto: true` and the reason). The timer keeps running while the offer refreshes; it restarts only when a new offer opens. In a Blitz run the timer is held at zero until the Blitz clock starts, so the auto-pick never fires before you drive.
- **Carpool**: carrying one pallet with a free fork slot, the options are same-bay orders only. A Carpool offer never forces a detour: on timeout it lapses for that load.
- No offer while battery < 20% with empty forks (the guide sends you to a charger), while the Co-Pilot drives, or after the run ends. Load-test bots keep the old auto-claim.
- On pickup, claimed orders bound for a different bay are released (same-bay ones are kept if forks allow).
- **Claim TTL**: a chosen order that isn't picked up within `CHOSEN_ORDER_TTL_MIN = 60` game-min goes back to `open` (`fare_choice` event with `expired: true`). Run end and despawn also release it.
- **Ghost planner**: the client draws the planner's path (`findPath`) to the highlighted order as a faint dashed ghost line (☰ → Layers → Ghost planner). Beating par by ≥ 30% (`GHOST_RATIO`) is what Ghost Hunter counts.
- **Rival** (`assignRival`): the AI agent whose shift score is closest to yours (ties → lower id), assigned at run start and reassigned if it leaves. If **any** AI vehicle claims or picks the order you are heading to (your claimed order or the Co-Pilot pick the guide arrow follows), or your assigned rival reserves any of your open options, you get a `rival_snipe` event (`{vid, rival, orderId, isRival, reason?}`, `rival` = the AI's vehicle id) carrying that AI's real last brain reason; `reason` is omitted when the AI has none (never a canned quote). At most one per `RIVAL_SNIPE_COOLDOWN_MIN = 15` game-min per driver. The order-choice strip shows a neutral (non-alert) head-to-head pill from both trucks' live `sPts`: `Rival FL-03 · 120 pts · you −15` (`you +5` / `tied`).

---

## 3c. Dispatcher's Call (A2UI minigame)

Once per **Blitz** run, near the midpoint, Gemini spots a real floor situation and asks you to make the dispatch call. Flag: `ENABLE_DISPATCHERS_CALL` on `@warehouse/site` (default **on**; see `docs/operations.md`).

- **Window**: from `DISPATCHERS_CALL_OPEN_MIN = 90` to `DISPATCHERS_CALL_CLOSE_MIN = 120` game-min into the run (≈ 1:30–2:00 of a 3:00 Blitz). Humans on a live, non-bot connection that have not opted out only. If nothing qualifies by the close, the call is skipped for that run.
- **Situations** (`detectDispatchersCallSituation`, live world counts, first match wins): an open spill → a P0 surge (open P0 ≥ `DISPATCHERS_CALL_P0_SURGE = 2`) → an outbound trailer near cap (load/cap ≥ `DISPATCHERS_CALL_BAY_FILL = 0.75`) → a hazmat backlog (open hazmat/RET orders ≥ `DISPATCHERS_CALL_HAZMAT_BACKLOG = 3`) → a dock backlog (open inbound pallets ≥ `DISPATCHERS_CALL_DOCK_BACKLOG = 3`).
- **The question**: the site sends only numeric telemetry (no player text) to `gemini-3.5-flash-lite` (Vertex AI, ADC) with a strict response schema. Gemini writes a short question and 2–3 concrete dispatch options (`DispatchParams`: source zone, target bay, priority, count, mode), plus its own pick and reason, which stay on the server until you answer. The card shows the question, the option chips and an 8 s countdown ring.
- **Pick**: you have `DISPATCHERS_CALL_PICK_MIN = 8` game-min (8 s). Picking executes the server-stored option through the same path as Floor dispatch (`dispatchOrderRoute`), then the card shows **You and Gemini agreed** or **Gemini would have picked X: reason**.
- **Score**: for `DISPATCHERS_CALL_EVAL_MIN = 30` game-min after the pick (or until run end if sooner), every dispatched pallet delivered on time (by anyone) pays `DISPATCHERS_CALL_PTS_PER_PALLET = 5`, capped at `DISPATCHERS_CALL_MAX_PTS = 25`, added to run points and shift points. A `+N DISPATCHER'S CALL` popup shows the result. Agreeing with Gemini is not scored; only the real outcome is.
- **Timeout**: no pick in 8 s → nothing is dispatched, 0 points, and the card reveals Gemini's pick with "Time's up".
- **No fabrication**: if the model call fails, times out (4 s), returns invalid output, or the agent budget is exhausted, no card appears, the error is logged and the call is skipped for that run. There is no canned fallback question.

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
| **Difficulty Level** (`voteDifficulty`) | **Vote by connected drivers** | Applied **immediately** when a mode has a plurality or `>= 50%` of active connected player votes (and re-evaluated at shift rollover) | Four tiers: **Easy** (`speed ×1.15`, `demand ×1.0`, `score ×1.0`), **Medium** (`speed ×1.35`, `demand ×1.3`, `score ×1.35`), **Hard** (`speed ×1.6`, `demand ×1.65`, `score ×1.75`), and **Turbo** (`speed ×2.0`, `demand ×2.1`, `score ×2.2`). The `score` multiplier only scales the Hall of Fame ranking (`scored` at shift end); live fare points are unaffected. Cannot be changed via `nlCommand`. |
| **Typed Orders** (`nlCommand`) | Anyone | **6 per player per real minute** (and **30 per IP per minute**) | Parsed by Gemini after Model Armor inspection, then clamped by the **exact same governance limiter** as the corresponding button. Ambiguous commands return a live `a2uiScreen` clarification card. |
| **Order Choice** (`chooseOrder`) | Driver (own vehicle) | **1 per player per 0.25 s** (`CHOOSE_ORDER_COOLDOWN_SEC`) | Reserves one of your `fareOffer` options; rejected picks return the sim's reason. |
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
- **Inbound (West Docks)**: The destination site receives the Pub/Sub push at `/internal/transfer` and invokes `receiveTransfer(world, transfer)` (idempotent by `transfer.id`), placing an inbound putaway pallet at a west dock worth **8 + 5 = 13 pts** (stow at its rack, or cross-dock within 45 game-min for +10; see §1).
- **Player Site Switching**: Players can open **☰ → Network** to inspect live facility names, specialties, driver counts, facility tiers, phases, and shipped totals across `DEN-1`, `SLC-2`, `PHX-3`, and `ABQ-4`. Clicking **Switch** (`switchSite`) releases their current vehicle and reconnects them to the target shard via the lobby while preserving their `clientId` profile and lifetime score.

---

## 7. Client UI & Controls

The client is a full-bleed isometric (2.5D) floor with frosted HUD cards floating over it (HUD v3). Everything shown comes from the live site server. When nothing has arrived yet, or a call fails, the HUD shows `—` or the real error (see **Notifications** below); it never shows placeholder numbers. Disabled buttons always carry a tooltip that says why.

### Two modes: Drive and Floor

The HUD has two layouts, chosen automatically (`hudMode` in `apps/client/src/ui/mode.ts`; `body[data-mode]` is `driving` or `floor`):

- **Drive**: you hold a wheel (manual or Co-Pilot) and have not walked away from a finished run.
- **Floor**: you are watching or managing the floor. This covers not driving, and **Watch the floor** after a run. The camera is free (drag to pan, scroll to zoom; clicking a feed row pans to it).

| Region | Drive HUD | Floor HUD |
|---|---|---|
| Top left | **☰** menu button (`#menuBtn`, `M`) · GitHub link (`#githubBtn`) | **☰** · GitHub link (`#githubBtn`) · KPI strip (`#kpis`): site + `Day · HH:MM` clock · Shipped · On-time · Backlog · connection pill |
| Top centre | **Run capsule** (`#run`): Blitz clock (or PPM in Free Range) · points + 🔥 streak count (on-time deliveries in a row; no multiplier) · combo × with 4 pips (shown from the first delivery of the run) · position `P n of N` with ▲/▼ since the run started. Below it the **objective pill** (`#objective`, next goal + distance or `E`), the order-choice strip (`#fare`, which also carries the rival row and the **rival reasoning pill**), the single **alert line** (`#alert`, see Notifications) and the 🛡 **shield card** (`#shieldCard`). | — |
| Top right | **Contracts** card (`#contracts`, 250px, collapsible): one row per contract with a segmented progress bar; a replacement "pick 1 of 2" offer slides in here | Floor banner (`#floorBanner`): `Floor view · <status>` (after a run: `your run is over · N pts`) and **🚜 Drive `F`** (or **Play again** after a run; disabled with a reason when the driver cap is reached) · event feed (`#feed`, last 3 items, fading after 6 s) · surge relocation pill (`#reloc`) |
| Bottom centre | **Dash** (`#dash`): Battery meter (shown below 50%, while charging, or once boost starts draining battery) · driving keys legend (`WASD` Drive · `E` Pick / Drop) · **Boost** meter (hold it, or `Shift`/`Space`) · Co-Pilot toggle (`C`) · key hints (`↵` Chat · `Tab` Standings · `?` Controls) | **Floor orders** bar (`#orders`) · fleet ± stepper · 💬 Ask |
| Bottom left | — | Inspector (`#inspector`) while a vehicle is selected |

On mobile and iPad touch devices (`pointer: coarse`), the Drive HUD displays a virtual thumbstick (`#touchStick`) and action cluster (`#touchActions`). Pulling the thumbstick in any screen direction converts the drag vector through the 2:1 isometric inverse projection (`screenVectorToWorldAngle` -> `moveAngle`) so the forklift smoothly turns toward that direction on the board and drives forward (`speedNow >= 0`), sliding along aisle walls on diagonal contact without backing up in reverse. Keyboard `WASD` / arrow keys continue to use classic tank controls.

### Notifications

There is no toast stack. Each event or client notice goes to exactly one place, chosen by mode (`apps/client/src/ui/notify.ts`, unit-tested in `test/ui/notify.test.ts`):

| What | Drive | Floor |
|---|---|---|
| Your own scoring / run events (fare rating, combo reset, trailer closed, crazy stop, order reserved, contract done / failed, crash, skid, contract poached, run over) | World popup over your forklift (the contracts card flashes the row that progressed) | Feed (run over: the floor banner) |
| Things you must act on: low / flat battery, a spill within 4 tiles, your own interact hints, server refusals and errors, Co-Pilot / floor commands that were not executed | **Alert line** (`#alert`) under the objective: one at a time, newest wins, clears after ~4 s (errors ~5 s). Battery / spill alerts are raised when the condition starts and keep live text; the same condition re-raises only after it has been gone for 30 s (`COND_REARM_MS`), so a spill at the edge of the radius doesn't keep re-popping | Feed |
| Surge relocation offer | Alert line with **Relocate** / ✕ (8 s) | Relocation pill (`#reloc`) |
| Floor-order refusals (an error within 3 s of a Floor order, a floor-wide hint such as "No free rack slot for a P0", or pressing a disabled order key) | — | One transient line above the orders bar (`#orderNote`, the cone-hint spot), ~4 s |
| Everything else: other trucks' deliveries, trailers, poaching between others, transfers, other players' run results, status notes ("Sent: …", "Resumed …") | Dropped | Feed (deduped by text, at most 3) |

Contract-pick refusals show inline in the pick sheet (`[data-role="pick-note"]`), because the sheet covers the alert line.

Overlays (one at a time; `activeOverlay`: results > contract pick > chat / standings / menu):

- **Run 1 is drive-first**: on a callsign's first run (`… Run 1` or no suffix) in a browser that has never finished a run (`localStorage['warehouse.runs.done']`), the pick sheet is skipped: the client auto-keeps one dealt card (the starter card, else the first) with `keepCards`, the run is Blitz only (the run-mode pill is locked), and a 3-step coach rides on the objective pill: **Drive to the glowing pallet → E**, **Take it to Bay X → E** (bay from your real cargo / the server guide), then **Nice! +N** (N from your real `fare` event) for 4 s. The pick sheet returns from Run 2.
- **Contract pick sheet** (`#pickSheet`, Run 2 on): Blitz deals 3 cards; you keep 1–3 (`1 2 3` toggle, `Enter` keeps them). Keeping cards does not start the clock: your first drive or interact does. `Esc` tucks the sheet away; the contracts card then shows an "offer waiting" row that reopens it.
- **Standings sheet** (`#standingsSheet`, hold `Tab`): live drivers table (#, Driver, Pts, Best ×) with your row tinted, the **gap to next** place, and the difficulty vote (`voteDifficulty`, the only place to vote).
- **Results sheet** (`#runEnd`): opens only when a 3-Minute Blitz clock hits `00:00` (at 0% battery the forklift limps; the run does not end). The header carries **▲/▼ N vs last run** (`[data-role="run-delta"]`, from the last finished run's points kept in `localStorage['warehouse.runs.lastPts']`). It shows points · final position (▲/▼ from the start of the run) · deliveries (+ speedy share) · best combo, then a ✓/✕ contracts line. When there is real data, a **You vs Gemini** recap (`[data-role="ai-recap"]`) lists the top 3 rival decisions that mattered most to you (contract > cards / hazard > tactics, plus any that touched orders offered to or carried by you), each with the model's verbatim note and measured latency, and your Co-Pilot directive echoes with whether each executed; the section is omitted when there is none. There is one primary button, **Run again `↵`** (`data-role="play-again"`, `.go`), which re-joins or re-queues in Blitz mode (`'blitz'`) with an incremented `<Callsign> Run N` label. **Free Range** (`data-role="go-freerange"`) and **Watch the floor** (`data-role="watch-floor"`, or `Esc`) are secondary `.ghost` buttons.
- **Fare popup**: each delivery's popup shows the real breakdown from the `fare` event, e.g. `8 → ×1.5 Speedy → ×1.5 combo = 18` (`base` → rating multiplier → combo → card payout multiplier, multipliers of 1 omitted). Without those fields it falls back to `+18 SPEEDY ×1.5`.
- **Rival reasoning pill** (`[data-role="rival-reason"]`): your rival's (`me.rivalId`) latest real Gemini decision from the `brainDecision` broadcast, e.g. `🧠 FL-03 Sprinter: "<note>" · 410 ms`. Nothing is shown until a decision with a note arrives. When any AI takes the order you were heading to (`rival_snipe`), a speech bubble over that AI shows its real `reason` (or the event text when it has none).
- **🛡 Shield card** (`#shieldCard`): when Model Armor blocks one of your typed commands, `🛡 Blocked · L2 input · pi_and_jailbreak` (layer, stage and filter from `commandEcho.armor`) plus a per-session strike counter, for 6 s, instead of the generic refusal line.
- **Chat** (`#chat`, `Enter`): a **🤖 Co-Pilot / 🏭 Floor** toggle. Co-Pilot sends `agentCommand` to your own forklift; Floor sends `nlCommand` (shows the remaining per-minute budget).
- **HUD Minimal** (`V`, saved in `localStorage`): hides the dash driving-keys legend, key hints and the contracts card.

### ☰ Menu

The menu (`#menu`) opens flyouts beside it:

| Group | Items |
|---|---|
| Floor | **Team Standings** (`B`) · Fleet · Drivers (online count) · Value created · Network (live sites, Switch) |
| View | Layers ▸ (Routes · Traffic heat · Labels · Ghost planner) · Day history (`H`, the drawer) · HUD Full / Minimal (`V`) |
| Co-Pilot | Tune Co-Pilot (`G`, Co-Pilot & Agent Designer modal) |
| Game | Settings (rename, camera fit/zoom) · Leaderboard & awards (`L`) · How to play (`?`) |

- **Team Standings** (`#standFly`, formerly the Strategy board): every AI driving style and the Humans, ranked by orders/hr **per truck** (so a style does not win by headcount), from the server's `stats.board`. Clicking a row highlights that team on the floor.
- **🏆 Leaderboard & awards** (`[data-action="open-leaderboard-modal"]`, `L`) opens the **Full-Screen Leaderboard & Silly Superlatives** modal (`#leaderboardModal`). It shows Live Shift Standings, Floor Superlatives & Silly Awards, and Cross-Site Network Champions & Shift Hall of Fame.
- **Intro Page (`#help`)**: opens on boot unless `localStorage['warehouse.help.seen'] === 'skip'` (`shouldShowHelpOnBoot`). Its header includes a GitHub repository icon link (`.intro-github-link` → `https://github.com/davenportjw/freightfloor`), and it opens on **How to Play** (`[data-pane="rules"]`, step tiles, scoring chips, and the **All controls** hotkey table). A single **🧠 How the AI works** secondary pill button (`[data-intro-tab="ai"]`, `.btn.intro-ai-link`) swaps to The AI Inside (`[data-pane="ai-concepts"]`) and the 🔄 Decision Lifecycle (`[data-pane="decision-lifecycle"]`) stacked, with **← How to Play** (`[data-intro-tab="play"]`, `.btn.intro-back-link`) to go back. **Start driving →** (`[data-action="close-intro"]`, or `Enter`) closes it and puts you in a forklift (`quickDrive()`); pressed before the server's welcome arrives, it shows **Connecting…** and drives as soon as you are connected. No other hotkey fires behind the intro.
- **Resume code**: when the lobby returns `resumeToken` on a human join, the client stores it in `localStorage['warehouse.resumeCode']` and shows it as **Your resume code** with a **Copy** button in the Drivers panel (`[data-role="resume-code"]`). Pasting it into the **Resume** field in the Drivers panel sends it as the join request's `resume`; on success the client adopts the returned `clientId` (a different identity reconnects on a fresh socket). The raw `clientId` in `localStorage['warehouse_client_id']` is a private credential for lobby calls: only the lobby's `JoinResponse.clientId` (fresh join or resume) may replace it, never `welcome.you.clientId` or any other site-sent id (those are publicIds, and the client refuses any `p1_…` value; `apps/client/src/identity.ts`), and it is never displayed. The client keeps `JoinResponse.publicId` to highlight its own `/api/network` leaderboard row (`row.publicId`, falling back to `row.clientId`; then `welcome.you.clientId`). A bare callsign only resumes on the browser that already owns it. A bad code shows the lobby's `invalid_resume_code` message under the field. A `503 queue_unavailable` from `/api/join` is shown in the connection line with the normal reconnect countdown; from `/api/queue*` it raises one **Waiting line unavailable** alert per outage while polling keeps retrying.

### Floor orders

The Floor HUD's bottom bar (`#orders`, keys `1`–`4`). Button state comes only from the server's per-player `floorOrders` status, counted down locally between updates, plus the `limits.*` caps. Before the status arrives, a button is disabled with a reason and shows `—`. Cooling buttons show the seconds left and a ring.

| Key | Order | Notes |
|---|---|---|
| `1` | **⚡ Rush** | Rush the whole floor. While active it shows the game-minutes left. |
| `2` | **★ P0** | Post an urgent P0 order. Shows `open/max`; disabled at the site cap. |
| `3` | **🚧 Cones** | Cone mode: a ghost cone follows the cursor (red when the tile is not allowed: bays, chargers, pickups, vehicles, racks). Click places or removes; **right-click removes one of your own cones**; your cones get a teal ring. `Esc` finishes. Shows `mine/cap`. |
| `4` | **📦 Dispatch** | Drawer (`#dispatchPop`): From zone · To bay · pallets ± · ★ P0 · **Send** (`Enter`). While it is open, the map tints the source racks teal and the target bay blue, with a dashed line between them. |

The fleet stepper adds or removes AI agents (shared cooldown; only removable agents can go). **💬 Ask** (`Enter`) opens the chat on the Floor target.

### Hotkeys

Hotkeys never fire while you are typing in a text box (the one exception: `Esc` on an A2UI screen closes it). Driving keys are only captured while you are driving. Some keys mean different things in the Drive HUD, the Floor HUD, and the contract pick sheet.

**Single modal policy** (`topLayer` in `apps/client/src/ui/modal.ts`). Exactly one layer is "on top", by this priority: intro (`#help`) > results sheet > contract pick sheet > Agent Designer / Leaderboard modal > Dispatcher's Call card > A2UI builder > chat / standings / menu. That layer gates every hotkey and the driving keys:

- **Blocking layers** (intro, results, pick sheet, Agent Designer, Leaderboard) swallow the driving keys (W A S D / arrows / Shift / Space / E) and get only their own keys: intro `Enter`; results `Enter`; pick sheet `Enter` and `1 2 3`; Agent Designer `G`; Leaderboard `L`. Keyboard focus is trapped inside the intro, Leaderboard and results sheet while they are open, and returns to where it was when they close.
- **In-HUD cards** (Dispatcher's Call card, A2UI builder) let you keep driving, but no other hotkey fires while they are up; `Esc` closes them.
- Opening the results sheet closes the Agent Designer and Leaderboard. A modal opened on top of a sheet (for example **Full standings** from results) hides that sheet until the modal closes, so `Enter` never acts on a sheet you cannot see.

| Key | Action |
|---|---|
| W A S D / arrows | Drive (instant manual takeover from Co-Pilot; only while driving; key auto-repeat is ignored and keys are released when the window loses focus) |
| Shift / Space | Speed boost (+120% speed; collisions drop carried pallets!), or hold the Boost meter |
| E | Pick up / drop / charge (only while driving; the map tag says which: `E · Pick up #id`, `E · Drop at Bay X`, `E · Charge`) |
| Q | Cycle the highlighted order option (only while driving with an order choice open) |
| F | Drive HUD: reserve the highlighted option (`chooseOrder`; clicking a pill also works) · Floor HUD: 🚜 Drive (jump back in) |
| Enter | Open chat · intro: Start driving · pick sheet: keep the cards · results: Run again · dispatch drawer: Send |
| Tab | Hold to show the Standings sheet |
| C | Co-Pilot on / off: hand the wheel to your Co-Pilot or take it back (only while driving, with no sheet open) |
| M | Open / close the ☰ menu |
| V | HUD Full / Minimal |
| 1 2 3 | Contract pick sheet: toggle card 1 / 2 / 3 |
| 1 2 3 4 | Floor HUD: Floor orders: 1 ⚡ Rush · 2 ★ P0 · 3 🚧 Cones · 4 📦 Dispatch |
| B | Floor HUD: open / close Team Standings |
| G | Open / close Co-Pilot & Agent Designer modal (`#agent-designer-modal`) |
| T | Take the wheel of the selected vehicle |
| H | Open / close the day history drawer |
| L | Toggle Full-Screen Leaderboard & Silly Superlatives modal (`#leaderboardModal`) |
| Esc | Close things only: the top layer first (intro, results, pick sheet, Agent Designer, Leaderboard, Dispatcher's Call card, A2UI screen), then the menu / flyout / dispatch drawer, finish cone placing, hand back an AI vehicle, deselect, or close the drawer (in that order). On the pick sheet it tucks the deal away; on results it means Watch the floor. It never toggles the Co-Pilot (that is `C`). |
| ? | Open the Intro & Rules page (`#help`); `Esc` or the close button dismisses it |

This table, the in-app **All controls** table (`HOTKEYS` in `apps/client/src/ui/hotkeys.ts`) and the real key resolver (`resolveHotkey`) are kept in sync by `apps/client/test/hotkeys.test.ts`, which checks in both directions across the Drive, Floor and pick-sheet contexts.

Typed orders go through Model Armor and the same limiter as the buttons. Natural-language district/bay routing commands (e.g. `"get hazmats to returns"`, `"move cold storage to bay E2"`) execute directly via `dispatchOrderRoute`, while ambiguous or exploratory commands (e.g. `"help"`, `"what can I do"`, `"reroute"`) open the live `a2uiScreen` clarification builder.
