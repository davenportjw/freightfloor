> Snapshot of the live client (baseline commit 0087fd2) compared with mock v4, written 2026-10-16 before the UI parity rewrite. Line numbers refer to that commit.

# Gap inventory: MOCK v4 (warehouse_sim_mock_v4.html) vs the live client (apps/client)
Abbreviations: M = mock line, idx = apps/client/index.html, main = src/main.ts, rnd = src/renderer.ts, css = src/styles.css, eng = packages/sim/src/engine.ts, srv = apps/site/src/server.ts, proto = packages/protocol/src/index.ts

## 0. Top-line findings
- **Different layout model.** The mock is a full-bleed canvas (`position:fixed; inset:0`, M14) with floating glass HUDs. Live uses a 52px top bar plus a fixed grid `360px | 1fr | 340px` (css:50-52, 134-145). The canvas is only the center column.
- **The renderer is not PixiJS and not isometric.** rnd imports pixi and builds `PIXI.Texture`s (rnd:133-147). It never creates a `PIXI.Application`: `pixiApp` is always null (rnd:91, 191). All drawing is Canvas2D, **top-down orthographic**, at `TILE_PX = 36` (rnd:45, 416-423). `modeLabel` claims "Pixi vX Atlas · N frames" (rnd:143), which is misleading. The default label says "Atlas 48px" but tiles draw at 36px.
- **Several panels are stale after the welcome message.** They read sim fields that the server never sends in `delta`:
  - `deliveries` and `incidentLog` feed `board()`
  - `valueSeries` feeds the chart
  - `history`, `hallOfFame`, `heat`
  - `vehicle.path`
  
  See section 4.
- **Human contract cards never show.** Hands are keyed by clientId/name on the server (eng:912-915, srv:1017). The client looks them up by vid (main:994-998).

## 1. RENDERER

**Projection**
- Mock: Canvas2D isometric 2:1. `TW=64, TH=32` (M1409). `SX=(gx-gy)*TW/2`, `SY=(gx+gy)*TH/2 - z` (M1428-1430). Boxes are extruded with `oBox`/`aaBox`, with shaded side faces (M1455-1471). DPR is capped at 2 (M1417).
- Live: Canvas2D top-down. `translate(view/2)` → `scale(zoom)` → `translate(-cam)` (rnd:421-423). Sprites are flat 36px atlas cells, with no z or height. DPR is uncapped (rnd:184).

**Camera**
| Feature | Mock | Live | Status |
|---|---|---|---|
| Fit | `fitCamera` fits the iso bounding box; zoom ≥0.12 (M1422-1427). Re-fits on `expand` events (M1817). | `fitFloor` uses `map.w*36`; zoom clamped 0.42–1.8 (rnd:196-208). Not re-fit on tier change. | DIFFERENT |
| Wheel zoom | Zooms at the cursor, `exp(-dY*0.0015)`, range 0.12–3.2 (M1435-1438, 2095) | Steps ×1.12 / ×0.89 around the **screen center**, range 0.4–2.4 (rnd:241-249) | DIFFERENT |
| Zoom buttons | ×1.25 / ×0.8 about the center (M1947-1948) | ×1.18 / ×0.84; zoom-out floor 0.4 (main:377-382) | ~present |
| Drag pan | Pointer events with capture; 4px threshold before moving; grab/grabbing cursor (M2074-2081) | mouse events only (no touch or pen). The camera moves before the 4px threshold (rnd:219-231). | DIFFERENT |
| Follow driven vehicle | Lerp 0.12; on first follow, sets zoom=1 if zoom <0.9; also sets `ui.sel` (M2131-2137) | Lerp 0.18; follows `myVid || selectedVid`, i.e. it also follows a merely *selected* AI. Has a "Follow Active" toggle button (rnd:403-410, idx:185). | DIFFERENT (live adds the toggle) |
| Interpolation | `pose()` lerps prev→current with `alphaNow` (M1490-1493, 2123-2127) | None. Remote vehicles snap to each 10Hz delta (main:120-126). The plan requires interpolation (plan:352). | MISSING |

**Visual elements**
| Element | Mock | Live | Status |
|---|---|---|---|
| Floor tiles by district (KFLOOR palette), wall, highway | M1610-1616 | Atlas `floor_*` baked into 16×16 chunks (rnd:313-388). Only cold, haz, bulk and ambient are mapped; fast, returns, staging, charging and office fall back to `floor_main` (rnd:344-350). | DIFFERENT / partial |
| One-way lane arrows | M1617-1624 | Present, as filled triangles (rnd:367-381) | present |
| Dashed lane centre lines (white) | M1626-1629 | — | MISSING |
| Rack shadows | M1630 | — | MISSING |
| District outlines (dashed, KOUT colors) | M1632-1637 | — | MISSING |
| District name pills (`AREAS`) | M1735 | — | MISSING |
| Zone id labels (e.g. "A", colored), shown when zoom >0.45 | M1734 | Shows "`KIND` ZONE" in grey 10px text; not gated on zoom; not hidden by any layer toggle (rnd:437-447) | DIFFERENT |
| Racks: 3D frames with 2–3 levels, decorative stock per kind, LOD box when zoom <0.7 | M1558-1593 | Flat sprite `rack_empty_<kind>` or `rack_stocked_<kind>` (rnd:465-496). Kind `haz` builds `rack_*_haz`, but the atlas key is `rack_*_hazmat`, so it falls back to the generic rack. Rack state encodes whether an order is open. | DIFFERENT |
| Structures (office, break room, bench with monitors) | M1594-1607, 1674 | — (`map.structs` is not drawn) | MISSING |
| Conveyors plus moving totes | M1675-1684 | `conveyor_f0..3` animated sprite; no totes (rnd:498-511) | partial |
| West dock trucks | M1685-1688 | — (atlas has `dock_west`, unused) | MISSING |
| Bay drop pads (blue `#BFD3F2`) | M1639 | Pad tiles drawn with the **`trailer`** sprite, or `bay_east` when away (rnd:519-536). Semantically wrong: the pads become trailers. | DIFFERENT |
| East trailers: slide out on depart, fade, load fill bar (orange above 75%) | M1689-1704 | None. Shows a text label "`B1 (3/8)`" (rnd:539-550) | MISSING |
| Bay id pills | M1736 | Text-only label (above) | DIFFERENT |
| Charger pads (green + ⚡) plus charger post | M1640-1644, 1705 | `charger` / `charger_busy` sprite (rnd:554-568) | ~present (busy state is a live extra) |
| Traffic heatmap layer | M1645-1650 (`world.heat`) | — (heat is not sent; see section 4) | MISSING |
| Order pickup rings: pulse; team color if claimed; P0 gold, 3px; card purple | M1653-1659 | — | MISSING |
| Order pallets on slot `ax,ay`, P0 star | M1706-1710 | — (atlas has `pallet`, `pallet_p0` and `pallet_card`, unused). Orders show only as rack sprite swaps. | MISSING |
| Hazards/spills: yellow pulsing rings shrinking with TTL | M1660-1664 | `spill` sprite (rnd:571-585) | DIFFERENT |
| Incident / near-miss markers: pulsing fill | M1665-1668 | Static stroked circle, drawn after the sort (rnd:753-762) | DIFFERENT |
| "Incident" pill above the marker | M1738 | — | MISSING |
| Cones (3D) | M1711-1713 | `cone` sprite (rnd:588-606) | present |
| Vehicles | 3D parts per type (AGV, counterbalance, reach), team-colored counterweight, forks raise with `v.fork`, cargo stacks, blinking beacon, brake lights (M1494-1528) | Atlas sprite: 16 headings × empty/loaded × tint (rnd:686-705). No fork height, beacon or brake lights. | DIFFERENT |
| Vehicle contact shadow and team ring (thicker when emphasized) | M1533-1535 | Ring only when selected or driven (teal or indigo), not team-colored (rnd:666-674) | DIFFERENT |
| Headlight pool | M1536-1540 | — | MISSING |
| Charging pulse ring | M1541 | — | MISSING |
| Stunned dashed red ring | M1543-1545 | — (`stunnedUntil` is received but unused) | MISSING |
| Highlighted team (dim others to 0.4; routes filtered) | M1531, 1722 | — (no `hl` concept) | MISSING |
| Route lines for **all** AI vehicles: team color, gold if P0, alpha 1 when selected; Routes layer toggle | M1718-1729 | Only the **focus** vehicle's path, in fixed teal (rnd:613-625). No toggle. `path` is stale (not in deltas). | DIFFERENT |
| Vehicle id plus battery bar, shown only when zoom >1.1 and Labels is on | M1739-1746 | Always drawn: id + driver + `[BOT]` label plus battery bar (rnd:707-727) | DIFFERENT |
| "★ id" pill for human, selected, or P0 carrier | M1747-1752 | — | MISSING |
| Brain badges ("⋯ AI", "! BRAIN ERR", red ring) | not in mock (plan:356) | Present (rnd:676-684, 729-742) | live extra (plan) |
| Guidance ring | Only for **your** driven vehicle. Pulsing; green radius `REACH` when in range; amber=pick, blue=drop, green=charge; vertical gradient beam; dotted line from you; label pill "Press E" / "Pick #id" / "Bay X" / "Charger", clamped to screen edges (M1754-1773) | Drawn for the focused vehicle (mine **or any selected AI**). Fixed 0.48-tile dashed ring; colors pick #d97706 / drop **teal** / else green; never changes color for in-range; no beam, no label pill, no pulse (rnd:627-646) | DIFFERENT |
| Transfer bay (→ NET) and transfer order outline | not in mock | Present (rnd:489-493, 525-547) | live extra (plan) |
| Background | `#CBD5E1` slate (M1775) | `#e5e0d3` sepia (rnd:418) | DIFFERENT |

## 2. HUD PANELS
| Mock element | Mock behavior | Live equivalent | Gap |
|---|---|---|---|
| **Top-left clock + KPIs + speed** (M57-78, 1827-1839) | Live dot (blue, or grey when paused). Clock `Day N · HH:MM`. Phase pill `Shift A · <phaseText>`. KPIs: Shipped, On-time ("—" if 0), Incidents, Backlog (open+claimed), Lost, all from `world.day`. Speed buttons ❚❚ / 1× / 2× / 4× (M1938-1942). | `#clockPill` (idx:18, main:821-824) shows a **duplicated "Day 1 · Day 1 · 06:00 · A"**. `#phasePill` / `#phaseText` (idx:27-30, main:836-858). Only shift shipped/on-time, in the left-panel subtitle `#shiftTotalsSub` (main:877-882). No Incidents, Backlog or Lost KPIs. No speed buttons. No live dot (the pill dot is decorative). | KPIs MISSING (3 of 5); speed MISSING (needs server op; plan says 24/7 at 1×, so maybe intentionally omitted) |
| **Strategy Board (foldable)** (M81-93, 1852-1862, 1950-1951) | Header button `#boardToggle` folds `#boardBody` (chevron ▾/▸). Columns: Strategy (color swatch + ×vehicles), /hr, On-time, ⚠ incidents (red if >0), kWh/ord. Sorted by /hr. **Row click toggles team highlight** (`ui.hl`), with highlight styling. Footer hint. | `#strategyTableBody` table (idx:72-90, main:872-908). Columns: Strategy / Fleet / Ship / On-Time / Crash / **"Pts" header showing perHr** (mislabelled). No kWh/ord. Not sorted. **No row click or highlight. Not foldable.** Data is stale (section 4). | DIFFERENT; fold, highlight and kWh MISSING |
| **Top-right toolbar** (M97-109) | Layers: Routes (on), Traffic, Labels (on) toggles · − / + / Fit · History (toggles drawer) · ? (help) | `.stage-toolbar` top-left of the stage (idx:181-187): Zoom + / Zoom − / Fit Floor / Follow Active + renderer badge | Layers MISSING (all 3); History → "Telemetry Drawer" in the top bar (idx:51); ? / help MISSING |
| **Drivers presence pill** (M110-114, 1838) | "You (driving vX)" / "You (spectating)" | Right drawer "Connected Operators" pill list (idx:262-268, main:1091-1125) plus `#presenceCountSub` | DIFFERENT (richer, multiplayer); no compact pill |
| **Fleet pill** (M115-120, 1841-1850) | "`N vehicles · wing T/MAX`". Tooltip: AI vs human counts and next-wing threshold. **+ Agent** (disabled at `FLEET_CAP`) and **−** (disabled if no extra vehicles). Toast on failure. | Left panel buttons "+1 Forklift" / "-1 Forklift" (idx:101-102, main:405-410). No count, wing or tier info (tier is only in `#siteBadge`). No disabled states. | DIFFERENT; info MISSING |
| **Win-the-shift leaderboard** (M121, 2004-2032) | Header "Win the shift · #1 · ends in H:MM". Top 5 plus "⋯" plus your row if you are outside the top 5. Swatch, "★ you", strategy, pts. Rules line plus "Your record: W wins in N shifts". **Mode Easy/Normal/Hard buttons** with tooltip of demand, deadline, spills, crash and score multipliers. "Spills N · agent calls N (reroute/wait/push)". **Hall of fame** (top 5). Row click selects the vehicle. | Right drawer "Site Shift Leaderboard" table (idx:244-260, main:1046-1089): all rows; Unit / Driver / Ship / Pts; YOU and BOT tags; row click selects (OK). Difficulty is a **vote** in the left panel (idx:106-122, main:413-421; labels "1 · Calm / 2 · Normal / 3 · Surge" but they send easy/normal/hard). A difficulty pill shows the vote count (main:826-834). | Countdown, top-5 condensing, rules, record, spills/decisions line and Hall of fame MISSING. Mode is a vote (per plan:290), but there is no tooltip and no current-level highlight. |
| **Value Created chart** (M122, 2035-2056) | SVG 270×92. Windows **4h / 8h / 24h** (`data-vw`). Lines **relative to window start**: You `#0D9488` (2.6px), Agent avg `#64748B`, Best agent `#EA580C`. Legend with current values. Zero line. Empty state "Collecting samples…". Footnote "Cards done: you N, agents M". | `#sparklineCanvas` (idx:270-281, main:1127-1174): absolute values; whole series; best line is **indigo**; no legend, no windows, no zero line, no footnote. The 290×110 canvas is CSS-stretched with no DPR handling, so it renders blurry. **Data is frozen after welcome.** | DIFFERENT; tabs and legend MISSING |
| **Contracts card hand** bottom-right (M126, 1959-1999) | Empty state: dashed card "Take the wheel to be dealt 3 cards… Agents hold cards too (N done)". Otherwise 176px cards: Route/Skill label, +pts, title, progress bar, `progress/goal` or status; color by status (done green / active violet / grey); "Agents: N cards done". | `#cardsHud` (idx:226-238, main:993-1044): title pills only; no pts, progress or status. Empty text "Complete 6 deliveries to unlock shift skill cards." is **inaccurate** (cards are dealt on takeWheel/spawn, eng:793, 912). **Wrong hand key** (section 5). | DIFFERENT / broken |
| **Deal / contract offer modal** (M144, 1982-1999) | Non-blocking floating panel above the command bar. Up to 3 tiles (Starter/Route/Skill, +pts, title, desc). **Multi-select** (starter preselected). "Keep N cards" button, disabled at 0. Errors shown as toasts. | Inline `#cardOfferBox` inside the cards HUD (idx:232-237). Each button immediately sends `keepCards` with **one id** (main:1033-1035). No multi-select, no pts. | DIFFERENT |
| **Inspector** bottom-left (M129, 1863-1904) | **Hidden when nothing is selected.** Header: swatch, id, strategy, "· you", **✕ close**. 3×2 grid: Battery (red <20), Speed, Fork% (if driving) or State, Shift pts, Incidents, Near-miss. Guide box (amber) when driving. Contract "#id ★ → bay X · N min left (+k)". `v.msg`. Policy blurb with respect and speed. **Take the wheel [T]** / **Hand back [Esc]**. WASD/E hint. Re-rendered on a change key. | `#inspectorHud` (idx:194-223, main:924-991): **always visible**, defaults to v1 or `vehicles[0]`. Title "Forklift V1 · <driver/strategy> (type)". BOT / BRAIN ERROR / AI THINKING badges. One status text row (state, battery, speed, cargo). Guide box (shown for AI too). Brain reason box. Take / Release buttons. Interact (E) button. | No close/hide; incidents, near-miss, pts, contract due and policy MISSING; T/Esc hints MISSING; brain box is a live extra |
| **Command bar** bottom-center (M132-141, 1952-1954, 2057-2066) | 🚜 Drive (selected AI, else the best idle vehicle with battery >35 and not stunned) · ⚡ Rush wave · ★ P0 order · 🚧 Cones (toggle, `crosshair` cursor) · NL input (disabled in the mock) | Left panel "Floor Manager Controls" (idx:92-104): "+6 Rush Orders" (server posts **12**, eng:3462) · "+2 P0 Critical" (server posts **1**, eng:3472) · "Cone Tool (Click Tile)" toggle (main:400-404; no cursor change) · NL form + Dispatch + echo box (idx:124-145, main:423-432, 910-922; wired to the server) | **Drive quick-pick MISSING**; labels wrong; placement different |
| **driveBar** guidance (M147, 2022-2026) | Shown only while you drive. "✓ / ▶ guide text", "N tiles" (Manhattan) unless in range, "#rank · pts". Green or amber. | Nothing equivalent (guide text only inside the inspector) | MISSING |
| **How-to-win help modal** (M150-169, 2067-2070) | Overlay with "Got it". **Auto-opens on first visit** (localStorage `warehouse-sim-v4-help`). Opened by ?. | — | MISSING |
| **Toasts** (M172, 1806-1823) | Bottom-right stack, max 4. 5.5s (retune 9s). Left border colored by event type (`TOAST_COLOR`). `nearmiss` is log-only. A `decision` toasts only for the selected vehicle. | — (events only go to the drawer list; errors overwrite `#commandEchoBox`, main:729-735) | MISSING |
| **Right drawer** (M175-188, 1910-1935) | `.closed` slide-out (`translateX`, M47-48). Opened by History, closed by ✕. Tabs **Days** (`world.history`: per-day shipped, on-time, incidents, lost, poaches, best strategy + per-strategy grid) / **Events** (last 120, newest first, time + colored dot). Footer "Saved in this browser" + **Reset world…** (confirm). | `#rightDrawer` (idx:242-291) is a grid column collapsed by `#toggleDrawerBtn` (main:368-374, css:143-169). Contains the leaderboard, presence, sparkline and "Live Floor & Gemini Brain Log" (35 items, main:1176-1194). No tabs. **No Days history.** No reset. | Days tab MISSING; Events present but ordering bug; Reset N/A (server-authoritative; must not be faked) |

**Live-only (from plan):** site badge, brain-health pill, reconnect pill, name/join form, Network tab with site cards + Switch + network leaderboard (idx:148-176, main:1196-1301).

**Every collapsible / foldable / closable behavior in the mock**
1. Strategy Board fold (`#boardToggle`, chevron ▾/▸; M82-86, 1950). Live: ✗
2. Right drawer open/close: History toggles, ✕ closes, slide animation (M175-181, 1928-1929). Live: ~ (grid column collapse via the top-bar button, main:371-374; no ✕ inside, no slide)
3. Inspector hide/show: hidden with no selection, ✕ `#inspClose` clears the selection (M1865, 1875, 1894). Esc also deselects. Live: ✗ (always shown)
4. Deal panel auto-show/hide when an offer exists (M1991-1993). Live: ~ (`#cardOfferBox` hidden/shown, main:1022-1041)
5. Help modal open (?) / close ("Got it"), auto-open on first visit (M2067-2070). Live: ✗
6. driveBar auto-show only while driving (M2023-2025). Live: ✗
7. Toasts auto-dismiss, cap 4 (M1813-1814). Live: ✗
8. Drawer tabs Days/Events (M1930-1931). Live: ✗
9. Value-chart window tabs 4h/8h/24h (M2056). Live: ✗
10. Layer toggles Routes/Traffic/Labels (M1943-1946). Live: ✗
11. Cones mode toggle; Esc exits it (M1954, 2106). Live: toggle ~ (no cursor, no Esc)
12. `prefers-reduced-motion` disables toast and drawer animation (M50). Live: ✗

Live has extra fold-like controls: left-panel tabs Strategy/Network (main:348-366) and the Follow toggle.

## 3. INTERACTIONS
| Input | Mock | Live |
|---|---|---|
| W/A/S/D and arrows | Only while driving; sets `input` (M2098-2103); keyup clears; `blur` clears all keys (M2109) | Always captured, even when not driving: `preventDefault` stops arrow-key page scrolling and sends `input` (main:458-497). **No `blur` handler**, so keys stick. **Auto-repeat keydown is not filtered**, so it floods `input` messages and `pendingInputs`. |
| E | Interact, only while driving (M2104) | Always sends `interact` (main:480-484) |
| T | Take the wheel of the selected vehicle (M2105) | MISSING |
| Esc | Driving → hand back; else cone mode → exit; else deselect (M2106) | MISSING |
| Number keys | Not in the mock (vote labels "1·/2·/3·" imply hotkeys) | Not implemented, though the labels suggest them |
| Input-focus guard | `tagName === 'INPUT'` (M2101) | Present: input, textarea, contentEditable (main:452-456) |
| Click a vehicle | Picks the nearest interpolated pose within 1.1 tiles (M2090-2093) | Nearest raw pose within 0.85 (rnd:277-289) |
| Click empty floor | Deselects (M2093) | No-op (selection is kept) |
| Cone mode click | `toggleCone` (M2085-2088); error shown as a toast | rnd gates it on `coneMode` (rnd:272-275, 290-292), then main sends `manager/cone` (main:237-239); errors go to the echo box |
| Drag pan / wheel zoom | See section 1 | See section 1 |
| Leaderboard row click | Selects the vehicle (M2031) | Present (main:1056-1060) |
| Board row click | Team highlight (M1951) | MISSING |

## 4. DATA WIRING (server → client today)
What `delta` carries: full-state deltas (every tick in the foreground; every 10th tick in the background, srv:679) contain `vehicles` (rich fields + `guide{kind,x,y,text,inRange}`), `orders`, `hazards`, `cones`, `bays`, `markers`, `events`, `stats{totals, day, shift, shiftTime, rushUntil}`, `votes`, `hands` (gated, srv:680), `difficulty`, `tier` (srv:444-465). Light deltas carry only pose, `cargoCount`, `sShipped`, `sPts`, `inRange`, `guide` (srv:338-371). `welcome` carries a full `serialize(world)` snapshot (srv:815-824; eng:3622-3692).

| Mock panel | Data needed | Available today? |
|---|---|---|
| Clock / phase | `t`, `phase` | ✓ `delta.t`, `phase` message |
| KPIs: Shipped / On-time / Incidents / Lost | `world.day` | ✓ `delta.stats.day` |
| KPI: Backlog | orders open+claimed | ✓ `delta.orders` |
| Speed buttons | sim speed control | ✗ needs a new client op + server support (conflicts with the shared 1× site; recommend dropping) |
| Strategy Board | `board(w)` needs `w.deliveries` and `w.incidentLog` | ✗ **only in the welcome snapshot**; deltas never update them, so the board decays to zero after 60 game-min. Needs a `stats.board` (server-computed `board(world)`) or deliveries/incident deltas. |
| Fleet pill | vehicle count, tier, `MAX_TIER`, `FLEET_CAP`, `BASE_FLEET`/`TIER_STEP`, extras | ✓ count/tier from `delta.vehicles` and `delta.tier`; constants exported from sim; "extra" flag not in deltas (needs a field, or rely on the server error) |
| Leaderboard rows | `sPts`, `sShipped`, `strategy`, `human`, `driver` | ✓ (`leaderboard()` locally from vehicle deltas). Note: sim `leaderboard()` filters `isBot`, which is not in deltas, so client and server rankings may differ. |
| Shift countdown | `t` | ✓ |
| Record (wins / humanShifts) | `totals` | ✓ `stats.totals` |
| Spills / agent calls | `totals.hazards`, `totals.decisions` | ✓ `stats.totals` |
| Hall of fame | `world.hallOfFame` | ✗ snapshot only. Needs `stats.hall`, or reuse `/api/network` hall from Firestore. |
| Mode / difficulty | `difficulty`, `votes` | ✓ |
| Value chart | `world.valueSeries` | ✗ **client reads `msg.stats.series` (main:764), but the server never sends it** (srv:454-460). The chart is frozen at the welcome snapshot. Needs `stats.series` (or append-only samples). |
| Cards hand / offer | `hands[clientId]` | ✓ sent, but **all players' hands** are broadcast (privacy/bandwidth) and the client looks them up by the wrong key. Should be per-recipient. |
| Inspector: battery, state, fork, `msg`, `orders` (due) | vehicle full fields | ✓ |
| Inspector: incidents, near-misses, policy/tactics, `deliveries` | `v.incidents`, `v.nearMisses`, `v.tactics` | ✗ not in `QuantisedVehicleDelta` (proto:281-309); snapshot only |
| driveBar | `guide.text`, `inRange`, rank, pts | ✓ (`guide` in deltas for humans; rank from `sPts`) |
| Guidance ring | `guide` | ✓ (client also recomputes locally) |
| Routes layer (all vehicles) | `v.path` | ✗ snapshot only. Needs a path field (bandwidth: maybe next N nodes) |
| Traffic layer | `world.heat` | ✗ snapshot only. Needs a periodic heat delta (quantised/sparse) |
| Toasts | `events` | ✓ `delta.events` |
| Drawer Days | `world.history` | ✗ snapshot only (`history` restored once). Needs a `stats.history` or a day-close event payload |
| Drawer Events | `events` | ✓ |
| Reset world | — | N/A for multiplayer; omit (do not fake) |
| Help modal | static | ✓ |

**Hardcoded / default / fake values in the live client** (no-mock rule)
- main:215-223: initial `brainHealth` with `budgetLeftUsd: 10.0`, `ok: true`, `p50ms: 0`. A fabricated default. (It is rendered only after the first real message, but it is still fake state; idx:25 shows "p50 —ms".)
- main:148-156: when only `lastReason` arrives, it **fabricates** `lastDecision`: model `'gemini-3.8-flash'`, `latencyMs: 0`, kind `'contract'`, id `dec-${t}`. The inspector then shows "Gemini (gemini-3.8-flash, 0ms) [contract]" (main:977). The protocol lacks model, latency and kind.
- main:1200-1210: when `/api/network` is empty or has failed, it **invents site cards**: current site `live` with drivers 1, others `online` with 0, phase `running`. A clear violation; it should show an error or empty state.
- main:1243: "Drivers: N/**8**" is hardcoded; the server cap is 32 (srv:62).
- main:1289: `entry.siteId || 'den-1'` default; main:1293 `?? 0` points.
- main:880: on-time shows **100%** when 0 shipped (the mock shows "—").
- main:198, 436, 925, 994: default `selectedVid = 'v1'` and `'v1'` fallbacks (takeWheel targets v1 if nothing is selected).
- main:262: default display name `'Operator-1'`.
- idx:15, 18, 19, 75, 197, 229, 247: placeholder text ("DEN-1 · Tier 0", "Day 1 · 06:00 · Morning Shift", "0 shipped · 100% on-time", "Forklift v1 · Human", "v1", "1 connected"). These are visible before data arrives; "Morning Shift" never matches the real format (A/B/C).
- rnd:104-105: `camX = 25*TILE`, `camY = 17*TILE` default; rnd:115/145: label "Atlas 48px" while tiles are 36px.
- rnd:353-361, 486, 506, 531, 563, 578, 599, 703: colored-rect fallbacks when atlas sprites are missing. These are rendering fallbacks, not data, but they silently hide asset failures (the `rack_*_haz` keys always miss).
- main:1005: "Complete 6 deliveries to unlock…" is untrue copy.
- idx:98-99: "+6 Rush" and "+2 P0" do not match the server (12 and 1).

## 5. BUGS in the live client
1. **Duplicated day**: `clockText()` already returns "Day N · HH:MM" (eng:268-271). main:823 prepends `Day ${dayIndex+1}`, giving "Day 1 · Day 1 · 06:00 · A".
2. **Cards hand key wrong**: main:994-998 uses `world.cards[vid]`. Human hands are keyed by `clientId` and `name` (eng:912-915; keepCards uses `conn.clientId`, srv:1017). Human offers and cards never render. While driving vX, an AI hand stored under `v.id` (eng:3053) may show instead.
3. **keepCards sends a single id per click** (main:1034). Multi-keep is impossible, and an accidental click commits immediately.
4. **Event log order**: the snapshot `events` are oldest-first (`emit` pushes, eng:324). Deltas are `unshift`ed (main:777-779), so the list mixes orders. On first load `slice(0,35)` (main:1180) shows the **35 oldest** events.
5. **brainThinking flicker**: `Boolean(d.brainThinking)` (main:162) resets to false on every light delta, because light deltas omit the field (srv:338-371).
6. **Strategy board, value chart, Days and Hall go stale.** Their sources are snapshot-only (section 4), and main:764 reads `stats.series`, which is never sent.
7. **Mislabelled column**: "Pts" header shows `perHr` with "/h" (idx:85, main:902). "Ship" is the 60-min count, not the shift total.
8. **Prediction / reconcile mismatch**: inputs are queued only on key change, with a fixed `dt: 0.05` (main:500-506). The local step uses `elapsed*0.5` (main:315). Replay after `ack` (main:183-186) re-steps 0.05 per *keypress*, not per elapsed tick, so it rubber-bands. No `ev.repeat` filter (main:478-489), so autorepeat spams seq/frames.
9. **No blur key-clear**: held keys stick after alt-tab.
10. **Keys captured when not driving**: arrows and WASD are `preventDefault`ed and sent always (main:485-488); E is always sent.
11. **Follow follows any selected AI** (rnd:403-404). Clicking a vehicle hijacks the camera unless Follow is off. The guide ring and path are also drawn for non-driven selected vehicles (rnd:609-647).
12. **Wheel zooms around the center, not the cursor** (rnd:245-246). The pan applies before the drag threshold (rnd:227-228).
13. **Fit not re-run on tier expansion** (main:743-746 rebuilds the map only).
14. **`rack_*_haz` sprite key mismatch**: the atlas has `rack_*_hazmat`, so it falls back (rnd:472-481). Floor kinds fast, returns, staging, charging and office are unmapped (rnd:344-350).
15. **Bay pads drawn as `trailer` sprites** (rnd:525-529).
16. **Vote labels vs values**: "1 · Calm" sends `easy` and "3 · Surge" sends `hard` (main:413-421). The pill then reads "Easy"/"Hard" (DIFFICULTY labels, eng:175-218). Inconsistent naming.
17. **Sparkline canvas**: a fixed 290×110 backing store stretched to `width:100%` with no DPR, so it renders blurry or distorted (idx:275-280, main:1133-1134). Not windowed and not relative.
18. **Welcome fallback**: if `restore()` throws, the partial path (main:659-667) leaves stale `deliveries`, `history` and so on, with no error surfaced.
19. **Network transfer**: sends `transferSite` then immediately re-joins (main:1259-1260). The `joinAndConnect` "isConnecting" guard can drop the call; no feedback.
20. **onClickTile** (main:237-239) sends `cone` unconditionally, but rnd only invokes it when `coneMode` is true (rnd:272, 290). **Not an active bug**, just fragile coupling; move the guard into main. Real related gaps: no cone cursor and no Esc exit.
21. **`rnd.render` calls `resize()` every frame** (rnd:397). That is wasteful, and resizing to the parent may reallocate during the drawer transition.
22. `modeLabel` claims Pixi while `PIXI.Application` is never created (rnd:143). The Pixi textures are built but unused (dead code, which also loads pixi.js into the bundle).

## 6. Visual styling differences
| Aspect | Mock | Live |
|---|---|---|
| Layout | Full-bleed canvas (M14) with floating fixed HUDs at the corners and bottom-center, z-20/30/40 | App shell: 52px top bar + 3-column grid 360/1fr/340 (css:50-56, 134-145). Only the inspector and cards float (absolute within the stage, css:360-388). |
| Framework | Tailwind CDN utility classes plus a small `<style>` block (M6-51) | Tailwind v4 is imported (css:1) but almost unused; hand-written CSS vars |
| Palette | Slate: body `#CBD5E1`, text `#0F172A`; buttons `#F8FAFC` / `#CBD5E1` border; hover blue `#EFF6FF` / `#3B82F6`; `.on` blue `#2563EB`; `.warn` orange; `.drive` teal `#0D9488` | Sepia: `--bg #f7f4eb`, `--panel #faf8f3`, `--border #dfd8c8`; accent teal `#0f766e`; amber `active-mode`; rose danger (css:3-22). The canvas bg is `#e5e0d3`. Note: the user's global rule asks for sepia/academic light, which conflicts with the mock's slate. Needs a decision. |
| HUD glass | `.hud`: `rgba(255,255,255,.9)` + `blur(12px)`, border `rgba(148,163,184,.45)`, radius **14px**, two-layer shadow (M17-23) | Panels are opaque `#fff` cards with radius **10px** (css:204-210). Floating HUDs: `rgba(250,248,243,.96)` + `blur(8px)`, radius 12px (css:366-371) |
| Buttons | radius 9px, 5px×10px, 12.5px/600; states on / warn / drive / disabled | radius 7px, 6px×11px, 12.5px/600; primary / danger / active-mode (css:258-305) |
| Labels | `.label`: 11px/700, uppercase, `.06em`, `#64748B` (M36); `.num` tabular numbers | `.section-title`: 13px/700, sentence case (css:219-224); tabular numbers only in tables |
| Fonts | Inter stack, 13px base (M11-12) | Inter stack, 14px base (css:36-46) |
| Pills | Rounded-md slate chips; canvas pills with radius 7 | `intent-pill`, fully rounded (999px), colored variants (css:88-124) |
| Keycaps | `.kbd` mono with a 2px bottom border (M46) | `.kbd-key`, not monospace (css:446-455) |
| Motion | Toast slide-in, drawer slide, reduced-motion support (M41-50) | Only the grid-column transition (css:140); no reduced-motion handling |
| Scrollbars | Custom 6px (M49) | Default |
| Cursor | grab / grabbing / crosshair (cone) on the canvas (M14-16) | grab, plus grabbing via `:active` (css:342-347); no crosshair |

## Live-only features to keep (plan-driven)
Network tab with transfers, brain-health pill, reconnect pill, phase break/resume countdown, BOT and brain badges, NL command echo, join/name form, transfer bays.

Tests (test/client.test.ts) cover only name validation, atlas key resolution, delta apply and reconcile (lines 19, 31, 67, 114). Nothing covers HUD panels, cards keying, the clock text or event ordering.
