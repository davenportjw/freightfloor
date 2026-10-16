# Design addendum: persistence, multiplayer, scoring and contract cards

Answers the two open questions in `design_review_and_revised_premise.md`, and records the decisions made while building mock v4.

## Persistence: the warehouse keeps history across days
- Server build: the authoritative sim snapshots world state, day history and the Strategist's tuned parameters on every shift change. In-flight orders and vehicle positions are rebuilt on restart.
- Mock v4: the same shape is saved to `localStorage["warehouse-sim-v4-map2"]` every 10 s and on unload. It restores clock, day history, totals, event log, cones and Strategist tuning. In-flight orders and vehicle positions are not restored, and the event log says so. "Reset world…" clears it after a confirm.

## Multiplayer and the lease model
- **One lease per vehicle, keyed by player.** `takeWheel(world, vehicleId, player)` returns an error string or null. A vehicle holds its own `input` and `driver`, so any number of players can drive different vehicles at once. The server rejects a lease on a vehicle someone else holds. Leases expire after a few seconds without input and the vehicle returns to its AI.
- Input goes to the server as throttle and steer at 10 Hz. Clients only render interpolated server state.
- A presence list shows who is driving what.
- Manager commands (rush, P0, cones) are rate-limited per player and written to the event log with the player name.
- Mock v4 is single-player only. The presence chip says "local only" and shows no simulated remote players.

## Scoring: what you are trying to win
- Each vehicle, AI or human, earns shift points: +10 per pallet delivered, +40 for a P0 order, half if late, −15 for the at-fault vehicle in a crash.
- A leaderboard ranks all 20 vehicles. At each shift end the top 3 and the human's rank are logged, the human's win and shift counters update, and shift points reset.
- The win condition in v4 is "finish a shift ranked #1". Open question: whether a shared team score suits multiplayer better than one human per vehicle.
- Guidance: `guide(world, vehicle)` returns the next step (pick, drop, charge or wait) with a target tile. The renderer draws a beam and a ring to it. It prefers pallets from the player's active contracts.

## Contract cards (Ticket-to-Ride style objectives)
- **Deal:** one offer of 3 cards per player per shift, made when a player takes the wheel and again at each shift change for players still driving. The first deal ever includes an easy starter card. The player must keep at least one card.
- **Route cards** post real tagged orders for a chosen rack zone and bay. AI vehicles can take them. If a rival delivers the pallets first, the card is lost.
- **Skill cards** are predicates over the delivery and incident stream: batch (2 pallets, one trip), clean (no crash this shift), ontime (5 on time), quick (2 runs under 8 min) and charge (be driving above 40% battery at shift end).
- **Rewards:** bonus points are added to the driven vehicle's shift score. Typical bonus is 30–40% of a normal shift score.
- **No penalty in v1.** Unfinished cards expire at shift end and tagged orders are released to the pool.
- **Never-mock:** card progress comes only from sim events. Card orders are real orders. No fake players hold cards.
- **Future ideas:**
  - Rival cards: beat a named vehicle or strategy.
  - Bold cards: higher reward with a penalty on failure.
  - Secret hands in multiplayer, with a shared reveal at shift end.
  - Team cards that need several players.

## Floor layout and districts (mock v4, 60x43)
- Four rack bands of nine block slots, with paired one-way highways between them and two-way highways every 5 columns. Eight outbound bays on the east wall, a conveyor line, west docks, and a 20-charger bank on the south wall.
- Districts change play, not just looks:

| District | Effect | Contract bonus |
|---|---|---|
| Ambient racking | Baseline | 0 |
| Cold storage | Battery drains 1.6x, slower pick | +3 |
| Fast pick | Pick takes 0.7 s | 0 |
| Bulk floor stack | Slower pick, drain 1.15x | +2 |
| Hazmat cage | Speed capped at 0.6x | +5 |

- Also on the floor: returns and QA benches, outbound staging, admin and break-room buildings, and the charging bank.
- The map is generated from a layout table in the sim core, so districts and effects are data.
- Demand is scaled by one constant (`FLOW`) and due times were lengthened (120 min normal, 30 min P0) so a 20-vehicle fleet keeps up. Headless result: 906–953 shipped per 50 game-hours, 64–73% on time.
- The old save is ignored because the floor changed (new localStorage key).
- Not verified in a real browser: the new rack, building and label drawing has only run against a stub canvas.

## Verification so far
- Headless Node tests only: sim smoke over 50 game-hours, a card-engine test, and a stub-DOM render and drive test. Nothing has been run in a real browser.
- Finding: with 20 vehicles, a two-row gap in the conveyor line gridlocked on some seeds (lost orders from 2 to 272 over 50 hours). Widening the gap to four rows (y 10–13) cut that to 0–53.

## Honest mock boundaries
| Piece | Mock v4 | Server build |
|---|---|---|
| Sim | Browser, seeded RNG | Authoritative 10 Hz service |
| Strategist retune | Rule-based, labelled as such | Gemini 3.8 Flash via ADC |
| Typed orders | Disabled input | Parsed by Gemini 3.8 Flash |
| Remote players | None | WebSocket leases |
| Contract cards | Local, dealt by seeded RNG | Server-dealt, per-player hands |
| Persistence | localStorage | Server snapshots |
