# UI parity: shared contracts (read before editing)

Plan: docs/design/ui-parity-plan.md
Mock (source of truth for visuals/UX): docs/design/mock-v4.html
Repo root (baseline commit 0087fd2). Do NOT git commit; the orchestrator commits.

## Decisions (user-approved)
- Port the mock's ISOMETRIC 2.5D Canvas2D renderer. Drop the unused pixi.js dependency.
- Palette/styling = the MOCK's slate palette + frosted-glass HUDs exactly (NOT sepia). Readable sizes (>= 11px labels, 12.5-13px body).
- Layout = full-bleed canvas + floating collapsible HUD panels (left zone / bottom / right zone + slide-out right drawer).
- Speed buttons and "Reset world" are intentionally NOT implemented (shared server floor). Difficulty stays a vote.
- STRICT no-mock rule: never invent data or show fake defaults; show "—" / real error states until real data arrives.

## File ownership (avoid edit conflicts)
| Agent | Owns (may edit) | Must NOT edit |
|---|---|---|
| A: server/protocol | packages/protocol/**, packages/sim/**, apps/site/**, apps/lobby/** (only if needed for limits), docs/protocol.md, docs/architecture.md | apps/client/** |
| B: renderer | apps/client/src/renderer.ts, apps/client/src/render/** (new), apps/client/test/render.test.ts (new), apps/client/package.json (only to remove pixi.js) | main.ts, index.html, styles.css, src/ui/**, test/client.test.ts |
| C: client shell + UI | apps/client/index.html, src/styles.css, src/main.ts, src/net.ts, src/input.ts, src/state.ts, src/ui/**, test/client.test.ts, test/ui/**, docs/gameplay.md (UI/controls section) | renderer.ts, src/render/**, packages/**, apps/site/** |

## Protocol additions (Agent A implements; Agent C consumes)
All new fields are OPTIONAL (backward compatible). Replace `stats: z.any()` with a typed `DeltaStatsSchema` (keep passthrough for existing fields: totals, day, shift, shiftTime, rushUntil).

```ts
// DeltaStats (only on FULL deltas)
board?: BoardRow[];             // = sim board(world) output, recomputed at most 1 Hz
seriesAppend?: ValueSample[];   // value samples newer than the last one sent to THIS connection (welcome snapshot carries the full valueSeries)
history?: DayRecord[];          // full world.history, sent only when its length changed since last sent to THIS connection
hall?: HallEntry[];             // full world.hallOfFame, sent only when changed since last sent to THIS connection
heat?: { w: number; h: number; cells: [index: number, value: number][] }; // sparse world.heat, every ~2 s, ONLY to connections with traffic layer on
// BoardRow / ValueSample / DayRecord / HallEntry mirror the sim's existing types exactly (export them from @warehouse/sim if not already).

// QuantisedVehicleDelta additions (FULL deltas only)
incidents?: number; nearMisses?: number;
tactics?: string;               // the sim's tactics/policy summary string or object as the sim stores it (document the shape)
path?: number[];                // next <=12 waypoints flattened [x0,y0,x1,y1,...] in tile units (integers)
extra?: boolean;                // vehicle was added beyond the base fleet (removable via fleet -)
decision?: { kind: DecisionKind; model: string; latencyMs: number; reason: string; t: number }; // REAL metadata from the brain call

// hands: delta.hands now contains ONLY the recipient's own hand: { [recipientClientId]: Hand } (shape otherwise unchanged)

// WelcomeMessage addition
limits?: { maxDrivers: number; maxDriversPerClient: number; fleetCap: number; maxTier: number; baseFleet: number; tierStep: number };

// SiteStatus addition (lobby /api/network)
maxDrivers?: number;

// New client message
{ type: 'layers', traffic: boolean }   // subscribe/unsubscribe heat
```

## Renderer API (Agent B implements; Agent C consumes)
`apps/client/src/renderer.ts` keeps exporting `WarehouseRenderer`, `RenderVehicleOverlay`, `headingToIndex16`, `resolveVehicleSpriteKey` (keep the last two even if unused, existing tests import them).

```ts
export interface RenderVehicleOverlay { brainThinking?: boolean; brainError?: string | null; }
export interface RenderLayers { routes: boolean; traffic: boolean; labels: boolean; }
export interface RenderOptions {
  layers: RenderLayers;
  highlightStrategy: string | null;   // team highlight from Strategy Board row click (dim others to 0.4)
  selectedVid: string | null;         // selection ring
  myVid: string | null;               // driven vehicle: guidance ring/beam/pill + camera follow
  coneMode: boolean;                  // crosshair cursor + tile clicks
  overlays: Map<string, RenderVehicleOverlay>;
}
export class WarehouseRenderer {
  constructor(o: {
    canvas: HTMLCanvasElement;
    onSelectVehicle: (vid: string | null) => void;   // null = clicked empty floor (deselect)
    onClickTile: (x: number, y: number) => void;     // only invoked when coneMode
  });
  render(world: World, opts: RenderOptions, nowMs: number): void; // call every rAF; interpolates remote vehicles itself by detecting world.t changes (keep prev/curr pose per vid)
  fit(): void;                 // fit iso bounds of the current map
  zoomBy(factor: number): void;// about screen centre
  onMapRebuilt(): void;        // call after tier expansion; re-fits
  resize(): void;              // call on window resize only (NOT every frame)
  readonly zoom: number;
  destroy(): void;
}
```
Guidance data: the driven vehicle's `guide` ({kind,x,y,text,inRange}) arrives in deltas; renderer may also call the sim's `guide()` locally as the mock does.

## As implemented (2026-10-16)

The sections above are the agreed contract. These are the details of what actually shipped. `docs/protocol.md` §3.1–3.2 is the normative reference.

**Server → client (full deltas only; light deltas unchanged)**
- `stats.board`: `BoardRow { strat, vehicles, count, perHr, onTimePct | null, incidents, kwhPerOrder | null }[]`, recomputed at most once per `BOARD_INTERVAL_MS = 1000`.
- `stats.seriesAppend`: `ValueSample { t, you, avg, best }[]`.
  - Per socket, append-only. Only samples newer than the last one delivered are sent; the welcome `valueSeries` counts as delivered.
  - The client appends and trims to 300.
- `stats.history`: the last 60 `DayRecord`s. `stats.hall`: up to 10 `HallEntry`s.
  - Each is sent only when it changed for that socket. The client **replaces** its copy.
- `stats.heat`: `{ w, h, cells: [tileIndex = y*w + x, value][] }`.
  - Values are rounded to 0.1. Cells below `HEAT_MIN_VALUE = 0.5` are omitted. Practical range is 0.5 to about 33; render with `alpha ∝ min(1, v/14)`.
  - Sent at most every `HEAT_INTERVAL_MS = 2000`, and only after the client sends `{type:'layers', traffic:true}`.
  - Defaults to **off** on every (re)connect, so the client must re-send its layer state after each welcome.
- Vehicle extras:
  - `incidents`, `nearMisses`, `extra`.
  - `tactics` is an **object**: `{ speed, respect, buffer, chargeAt, batch: number; flatPath, preemptForP0, poach: boolean; note?: string }`.
  - `path` is a flat int array `[x0,y0,…]`, at most `MAX_PATH_WAYPOINTS = 12` waypoints.
  - `decision` is `{ kind, model, latencyMs, reason, t }`. It is set only by a real applied brain call, and absent until then.
- `hands`: `Record<clientId, CardHand>` containing **only the recipient's own hand** (`{}` if none), on every full delta.
  - Human hands are keyed by clientId only; the display-name alias was removed.
  - AI hands (keyed by vehicle id) appear only in the welcome snapshot.
  - The welcome snapshot, `/api/state` and `/api/status` strip other humans' hands.
- `welcome.limits`: `{ maxDrivers: 32, maxDriversPerClient: 2, fleetCap, maxTier, baseFleet, tierStep, minAutonomousAgents, maxAutonomousAgents }`. Exported as `SITE_LIMITS` from `@warehouse/site`.
- `SiteStatus.maxDrivers` (lobby `/api/network`) comes from the site heartbeat, falling back to 32.

**Renderer additions to the API above**
- `RenderOptions.guide?: GuideInfo | null`. Pass the driven vehicle's delta `guide`, or `null` when there is none.
  - If it is left `undefined`, the renderer calls the sim's `guide()` locally. That call mutates the client world (`v.orders`, `o.claimant`), so avoid it.
- The renderer sets the canvas cursor itself and auto-fits on first render and whenever the map size changes.
- Removed legacy members: `init()`, `modeLabel`, `fitFloor()`, `followActive`, public `coneMode`, and the settable `zoom`.
- Code layout: `src/render/{iso,motion,painter,scenery,vehicles}.ts`.
