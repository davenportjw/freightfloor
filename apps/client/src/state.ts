/**
 * Client store: the single source of truth that every HUD module reads.
 *
 * All data here comes from real server messages (welcome snapshot, deltas,
 * presence, brainHealth, phase, /api/network). Nothing is invented: values that
 * have not arrived yet stay `null` and the UI renders "—".
 */
import {
  dequantiseCoord,
  type BoardRow,
  type BrainHealthMessage,
  type DeltaMessage,
  type HeatLayer,
  type LeaderboardEntry,
  type Phase,
  type PlayerSessionInfo,
  type PresenceEntry,
  type QuantisedVehicleDelta,
  type SiteId,
  type SiteLimits,
  type SiteStatus,
  type ValueSample,
  type VehicleDecision,
  type WelcomeMessage,
} from '@warehouse/protocol';
import {
  board as simBoard,
  buildMap,
  createWorld,
  defaultTacticsFor,
  DIFFICULTY,
  restore,
  type Archetype,
  type CardHand,
  type DayHistoryEntry,
  type HallEntry,
  type Point,
  type SimEvent,
  type Vehicle,
  type VehicleType,
  type World,
  type WorldSnapshotV5,
} from '@warehouse/sim';
import type { RenderLayers, RenderVehicleOverlay } from './renderer.js';

export const EVENT_CAP = 120;
export const BRAIN_LOG_CAP = 120;

export interface GuideInfo {
  kind: string;
  x?: number;
  y?: number;
  text?: string;
  inRange?: boolean;
}

/** Per-vehicle data that the sim Vehicle type has no slot for. */
export interface VehicleSideState {
  /** Latest brain reason text (lastReason) — shown without model/latency unless a real decision matches. */
  reasons: Map<string, string>;
  /** Server-computed guidance for human-driven vehicles. */
  guides: Map<string, GuideInfo>;
  /** Real brain-call metadata (delta.decision or `decision` events). */
  decisions: Map<string, VehicleDecision>;
}

export function createSideState(): VehicleSideState {
  return { reasons: new Map(), guides: new Map(), decisions: new Map() };
}

export interface ApplyDeltaOptions {
  /** Accept the server pose for our own vehicle (no input in flight, so nothing to predict). */
  acceptMyPose?: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** `[x0,y0,x1,y1,...]` → `[{x,y},...]` (drops a trailing odd value). */
export function unflattenPath(flat: readonly number[]): Point[] {
  const out: Point[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push({ x: flat[i], y: flat[i + 1] });
  return out;
}

/**
 * Merge incoming server events (emit order = oldest-first) into a newest-first
 * list capped at `cap`.
 */
export function mergeEvents<T>(existingNewestFirst: readonly T[], incomingOldestFirst: readonly T[], cap = EVENT_CAP): T[] {
  const merged = [...incomingOldestFirst].reverse().concat(existingNewestFirst);
  if (merged.length > cap) merged.length = cap;
  return merged;
}

/** Client-side cap on the value series (the sim keeps 300 too). */
export const SERIES_CAP = 300;

/** Append value samples strictly newer than the last one we hold, then trim to `cap` (in place). */
export function appendSeries(
  series: ValueSample[],
  samples: readonly ValueSample[],
  cap = SERIES_CAP,
): ValueSample[] {
  let lastT = series.length ? series[series.length - 1].t : -Infinity;
  for (const s of samples) {
    if (s.t > lastT) {
      series.push(s);
      lastT = s.t;
    }
  }
  if (series.length > cap) series.splice(0, series.length - cap);
  return series;
}

/**
 * `delta.hands` carries ONLY the recipient's own hand (`{}` when it has none). Merge it into
 * the client's card map so the agent hands from the welcome snapshot survive (in place).
 */
export function mergeOwnHand(
  cards: Record<string, CardHand>,
  incoming: Record<string, CardHand>,
  myClientId: string | null | undefined,
): Record<string, CardHand> {
  for (const [k, hand] of Object.entries(incoming)) cards[k] = hand;
  if (myClientId && !(myClientId in incoming)) delete cards[myClientId];
  return cards;
}

/** Rebuild a dense `w*h` heat array from the sparse server layer. */
export function denseHeat(layer: HeatLayer): Float32Array {
  const dense = new Float32Array(layer.w * layer.h);
  for (const [idx, value] of layer.cells) {
    if (idx >= 0 && idx < dense.length) dense[idx] = value;
  }
  return dense;
}

/** The player's own card hand. Human hands are keyed by clientId on the server (sim takeWheel/dealCards). */
export function findMyHand(
  cards: Record<string, CardHand> | null | undefined,
  you: Pick<PlayerSessionInfo, 'clientId'> | null | undefined,
): CardHand | null {
  if (!cards || !you) return null;
  return cards[you.clientId] ?? null;
}

const VEHICLE_TYPES: VehicleType[] = ['reach', 'counterbalance', 'turret', 'pallet_jack', 'forklift', 'agv'];
const ARCHETYPES: Archetype[] = ['Sprinter', 'Steady', 'Batcher', 'Opportunist', 'Strategist'];

/**
 * Build a client-side Vehicle for an id that first appears in a delta (a vehicle that
 * joined after our welcome snapshot). Only structural defaults are used; every visible
 * field is overwritten from the delta immediately afterwards.
 */
export function makeClientVehicle(d: QuantisedVehicleDelta): Vehicle {
  const x = typeof d.qx === 'number' ? dequantiseCoord(d.qx) : (d.px ?? 0);
  const y = typeof d.qy === 'number' ? dequantiseCoord(d.qy) : (d.py ?? 0);
  const strategy = (ARCHETYPES as string[]).includes(d.strategy ?? '') ? (d.strategy as Archetype) : 'Steady';
  const type = (VEHICLE_TYPES as string[]).includes(d.type ?? '') ? (d.type as VehicleType) : 'forklift';
  return {
    id: d.id,
    type,
    strategy,
    human: Boolean(d.human),
    extra: Boolean(d.extra),
    isPlayerVehicle: false,
    ownerClientId: null,
    controlledByClientId: null,
    playerOpaqueId: null,
    isBot: false,
    px: x,
    py: y,
    angle: d.angle ?? 0,
    tile: { x: Math.floor(x), y: Math.floor(y) },
    moveTo: null,
    path: [],
    state: (d.state as Vehicle['state']) ?? 'idle',
    orders: [],
    cargo: [],
    battery: d.battery ?? 0,
    fork: d.fork ?? 0,
    forkTarget: d.fork ?? 0,
    timer: 0,
    wait: 0,
    stuck: 0,
    waitKey: null,
    waitRespect: true,
    stunnedUntil: d.stunnedUntil ?? 0,
    idleSince: 0,
    energySince: 0,
    deliveries: 0,
    incidents: d.incidents ?? 0,
    nearMisses: d.nearMisses ?? 0,
    chargerIdx: -1,
    speedNow: d.speedNow ?? 0,
    braking: false,
    humanCharging: false,
    msg: '',
    driver: d.driver ?? null,
    input: { up: false, down: false, left: false, right: false },
    sPts: d.sPts ?? 0,
    sShipped: d.sShipped ?? 0,
    hzSeen: new Set<number>(),
    hold: null,
    pushing: null,
    skidRolled: false,
    bank: 0,
    aiValue: 0,
    lastTot: 0,
    tactics: defaultTacticsFor(strategy),
    brainError: null,
    lastDecision: null,
    lastTacticsReqAt: 0,
    target: null,
  };
}

/**
 * Applies quantised vehicle deltas (`qx, qy` in 1/32 tile units) to the client World.
 * Vehicles missing from the delta are removed; new ids are created.
 */
export function applyQuantisedDelta(
  w: World,
  deltas: QuantisedVehicleDelta[],
  myVid: string | null,
  overlays: Map<string, RenderVehicleOverlay>,
  side: VehicleSideState = createSideState(),
  opts: ApplyDeltaOptions = {},
): void {
  const byId = new Map<string, Vehicle>();
  for (const v of w.vehicles) byId.set(v.id, v);

  const seen = new Set<string>();
  const ordered: Vehicle[] = [];
  for (const d of deltas) {
    let v = byId.get(d.id);
    if (!v) {
      v = makeClientVehicle(d);
      byId.set(v.id, v);
    }
    seen.add(v.id);
    ordered.push(v);

    const targetX = typeof d.qx === 'number' ? dequantiseCoord(d.qx) : typeof d.px === 'number' ? d.px : v.px;
    const targetY = typeof d.qy === 'number' ? dequantiseCoord(d.qy) : typeof d.py === 'number' ? d.py : v.py;

    // Our own driven vehicle is predicted locally and corrected by `ack`, unless no input is in flight.
    if (v.id !== myVid || opts.acceptMyPose) {
      v.px = targetX;
      v.py = targetY;
      v.tile = { x: Math.floor(targetX), y: Math.floor(targetY) };
      if (typeof d.angle === 'number') v.angle = d.angle;
      if (typeof d.speedNow === 'number') v.speedNow = d.speedNow;
    }

    if (typeof d.state === 'string') v.state = d.state as Vehicle['state'];
    if (typeof d.battery === 'number') v.battery = d.battery;
    if (typeof d.fork === 'number') v.fork = d.fork;
    if (Array.isArray(d.cargo)) v.cargo = d.cargo;
    if (Array.isArray(d.orders)) v.orders = d.orders;
    if (d.driver !== undefined) v.driver = d.driver;
    if (typeof d.human === 'boolean') v.human = d.human;
    if (typeof d.strategy === 'string' && (ARCHETYPES as string[]).includes(d.strategy)) {
      v.strategy = d.strategy as Archetype;
    }
    if (typeof d.type === 'string' && (VEHICLE_TYPES as string[]).includes(d.type)) v.type = d.type as VehicleType;
    if (typeof d.braking === 'boolean') v.braking = d.braking;
    if (typeof d.stunnedUntil === 'number') v.stunnedUntil = d.stunnedUntil;
    if (typeof d.sPts === 'number') v.sPts = d.sPts;
    if (typeof d.sShipped === 'number') v.sShipped = d.sShipped;
    if (typeof d.msg === 'string') v.msg = d.msg;
    if (typeof d.incidents === 'number') v.incidents = d.incidents;
    if (typeof d.nearMisses === 'number') v.nearMisses = d.nearMisses;
    if (typeof d.extra === 'boolean') v.extra = d.extra;
    if (d.tactics && typeof d.tactics === 'object') v.tactics = { ...v.tactics, ...d.tactics };
    if (Array.isArray(d.path)) v.path = unflattenPath(d.path);
    if (d.brainError !== undefined) v.brainError = d.brainError;

    if (typeof d.lastReason === 'string' && d.lastReason) side.reasons.set(v.id, d.lastReason);
    if (d.decision) {
      side.decisions.set(v.id, d.decision);
      v.lastDecision = {
        id: `${v.id}-${d.decision.kind}-${d.decision.t}`,
        kind: d.decision.kind,
        reason: d.decision.reason,
        model: d.decision.model,
        latencyMs: d.decision.latencyMs,
        t: d.decision.t,
      };
    }

    if (d.guide && typeof d.guide === 'object') {
      const g = d.guide as GuideInfo;
      const prev = side.guides.get(v.id);
      // Light deltas omit the text; keep the last text while the target kind is unchanged.
      const text = typeof g.text === 'string' ? g.text : prev && prev.kind === g.kind ? prev.text : undefined;
      side.guides.set(v.id, { kind: g.kind, x: g.x, y: g.y, inRange: g.inRange, text });
    } else if (d.guide === null) {
      side.guides.delete(v.id);
    }

    const prevOv = overlays.get(v.id) ?? {};
    overlays.set(v.id, {
      ...prevOv,
      // Light deltas omit brainThinking: keep the last known value instead of flickering to false.
      brainThinking: typeof d.brainThinking === 'boolean' ? d.brainThinking : prevOv.brainThinking,
      brainError: d.brainError !== undefined ? d.brainError : prevOv.brainError,
    });
  }

  if (deltas.length > 0) {
    // Server deltas always list every vehicle on the floor: drop the ones that left.
    w.vehicles = ordered;
    for (const id of [...overlays.keys()]) if (!seen.has(id)) overlays.delete(id);
    for (const id of [...side.guides.keys()]) if (!seen.has(id)) side.guides.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface BrainLogEntry {
  t: number;
  vid: string | null;
  kind: string;
  text: string;
  model?: string;
  latencyMs?: number;
  error?: boolean;
}

export type ConnStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'error';

export interface NetworkState {
  status: 'idle' | 'loading' | 'ok' | 'error';
  error: string | null;
  sites: SiteStatus[];
  leaderboard: LeaderboardEntry[];
  updatedAt: number | null;
  switching: { siteId: SiteId; status: 'pending' | 'error' | 'done'; message: string } | null;
}

export interface PhaseInfo {
  phase: Phase;
  resumesAt?: number;
  reason?: string;
}

export type DrawerTab = 'leaderboard' | 'value' | 'days' | 'events' | 'brain';
export const DRAWER_TABS: DrawerTab[] = ['leaderboard', 'value', 'days', 'events', 'brain'];

export interface UiState {
  drawerOpen: boolean;
  drawerTab: DrawerTab;
  helpOpen: boolean;
  /** Value chart window in game-minutes (240 / 480 / 1440). */
  valueWindow: number;
  /** Card ids selected in the current deal offer. */
  offerSel: Set<string>;
  /** Identity of the offer the selection belongs to (reset when a new offer arrives). */
  offerKey: string | null;
}

function eventVid(ev: SimEvent): string | null {
  return typeof ev.vid === 'string' ? ev.vid : null;
}

export function brainEntryFromEvent(ev: SimEvent): BrainLogEntry | null {
  if (ev.type !== 'decision' && ev.type !== 'retune' && ev.type !== 'brain_error') return null;
  return {
    t: ev.t,
    vid: eventVid(ev),
    kind: typeof ev.kind === 'string' ? ev.kind : ev.type,
    text: ev.text,
    model: typeof ev.model === 'string' ? ev.model : undefined,
    latencyMs: typeof ev.latencyMs === 'number' ? ev.latencyMs : undefined,
    error: ev.type === 'brain_error',
  };
}

export class ClientStore {
  world: World;
  you: PlayerSessionInfo | null = null;
  /** The vehicle spawned for us at join (a player vehicle, cannot be "handed back"). */
  dedicatedVid: string | null = null;
  siteId: SiteId | null = null;
  welcomed = false;

  selectedVid: string | null = null;
  highlightStrategy: string | null = null;
  layers: RenderLayers = { routes: true, traffic: false, labels: true };
  coneMode = false;
  hudHidden = false;

  readonly overlays = new Map<string, RenderVehicleOverlay>();
  side: VehicleSideState = createSideState();
  events: SimEvent[] = [];
  brainLog: BrainLogEntry[] = [];
  presence: PresenceEntry[] = [];
  brainHealth: BrainHealthMessage | null = null;
  phaseInfo: PhaseInfo | null = null;
  limits: SiteLimits | null = null;
  board: BoardRow[] | null = null;
  conn: { status: ConnStatus; text: string } = { status: 'idle', text: '' };
  network: NetworkState = {
    status: 'idle',
    error: null,
    sites: [],
    leaderboard: [],
    updatedAt: null,
    switching: null,
  };

  /** Bumped when the floor map is rebuilt (welcome / tier change) so the renderer can re-fit. */
  mapVersion = 0;
  /** Bumped on every applied change; UI modules use it as a cheap dirty flag. */
  version = 0;

  /** Pure view state shared by panels and hotkeys (never sent to the server except via actions). */
  ui: UiState = {
    drawerOpen: false,
    drawerTab: 'leaderboard',
    helpOpen: false,
    valueWindow: 480,
    offerSel: new Set<string>(),
    offerKey: null,
  };

  private listeners = new Set<() => void>();

  constructor() {
    // Empty local container until the welcome snapshot replaces it. Nothing from it is displayed
    // as data: every panel waits for `welcomed` before rendering numbers.
    this.world = createWorld({ seed: 1, siteId: 'den-1' });
    this.world.vehicles = [];
    this.world.orders = [];
    this.world.events = [];
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  vehicle(id: string | null | undefined): Vehicle | null {
    if (!id) return null;
    return this.world.vehicles.find((v) => v.id === id) ?? null;
  }

  myVehicle(): Vehicle | null {
    return this.vehicle(this.you?.vid ?? null);
  }

  /** True while we hold the wheel of a human-driven vehicle. */
  isDriving(): boolean {
    const v = this.myVehicle();
    return Boolean(v && v.human);
  }

  /** Driving a vehicle that belongs to an AI (Esc / Hand back returns it). */
  canHandBack(): boolean {
    const v = this.myVehicle();
    return Boolean(v && v.human && !v.isPlayerVehicle && v.id !== this.dedicatedVid);
  }

  /** Vehicle id the renderer should follow (only our own driven vehicle). */
  renderMyVid(): string | null {
    return this.isDriving() ? (this.you?.vid ?? null) : null;
  }

  botVids(): Set<string> {
    const s = new Set<string>();
    for (const p of this.presence) if (p.isBot && p.vid) s.add(p.vid);
    return s;
  }

  myHand(): CardHand | null {
    return findMyHand(this.world.cards, this.you);
  }

  /** Server guidance for our driven vehicle; null (never undefined) when there is none. */
  myGuide(): GuideInfo | null {
    const vid = this.renderMyVid();
    return vid ? (this.side.guides.get(vid) ?? null) : null;
  }

  // ---- message application -------------------------------------------------

  /** Returns an error string when the snapshot could not be restored (nothing is applied then). */
  applyWelcome(msg: WelcomeMessage): string | null {
    let restored: World | null = null;
    if (msg.snapshot) {
      try {
        restored = restore(msg.snapshot as WorldSnapshotV5);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }
    if (!restored) return 'Welcome message carried no world snapshot.';

    const siteChanged = this.siteId !== null && this.siteId !== msg.you.siteId;
    this.world = restored;
    this.you = msg.you;
    this.dedicatedVid = msg.you.vid;
    this.siteId = msg.you.siteId;
    this.limits = msg.limits ?? null;
    this.welcomed = true;

    this.overlays.clear();
    this.side = createSideState();
    for (const v of restored.vehicles) {
      if (v.lastDecision) {
        this.side.decisions.set(v.id, {
          kind: v.lastDecision.kind,
          model: v.lastDecision.model,
          latencyMs: v.lastDecision.latencyMs,
          reason: v.lastDecision.reason,
          t: v.lastDecision.t,
        });
        this.side.reasons.set(v.id, v.lastDecision.reason);
      }
    }
    this.events = mergeEvents([], restored.events ?? [], EVENT_CAP);
    this.brainLog = (restored.decisionJournal ?? [])
      .slice(-BRAIN_LOG_CAP)
      .reverse()
      .map((j) => ({
        t: j.tApplied,
        vid: j.agentId,
        kind: j.kind,
        text: `${j.agentId} (${j.persona}) [${j.kind}]: ${j.reason}`,
        model: j.model,
        latencyMs: j.latencyMs,
      }));
    // The snapshot carries the real deliveries/incident log, so the board computed from it is genuine
    // until the server's periodic stats.board arrives.
    this.board = simBoard(restored);
    appendSeries(restored.valueSeries, [], SERIES_CAP);
    restored.series = restored.valueSeries;
    this.ui.offerSel = new Set();
    this.ui.offerKey = null;

    if (siteChanged || !this.vehicle(this.selectedVid)) this.selectedVid = null;
    if (!this.selectedVid && this.isDriving()) this.selectedVid = msg.you.vid;
    if (siteChanged) this.highlightStrategy = null;
    this.mapVersion++;
    this.changed();
    return null;
  }

  /** Applies a delta; returns the new events (oldest-first) for toasts. */
  applyDelta(msg: DeltaMessage, opts: ApplyDeltaOptions = {}): SimEvent[] {
    const w = this.world;
    w.t = msg.t;

    if (typeof msg.tier === 'number' && msg.tier !== w.tier) {
      w.tier = msg.tier;
      w.map = buildMap(msg.tier);
      const heat = new Float32Array(w.map.w * w.map.h);
      heat.set(w.heat.subarray(0, Math.min(w.heat.length, heat.length)));
      w.heat = heat;
      this.mapVersion++;
    }

    const prevMyVid = this.you?.vid ?? null;
    applyQuantisedDelta(w, msg.vehicles, prevMyVid, this.overlays, this.side, opts);

    if (Array.isArray(msg.orders)) w.orders = msg.orders;
    if (Array.isArray(msg.hazards)) {
      w.spills = msg.hazards;
      w.hazards = msg.hazards;
    }
    if (Array.isArray(msg.cones)) w.cones = new Set(msg.cones);
    if (Array.isArray(msg.bays)) w.bays = msg.bays;
    if (Array.isArray(msg.markers)) w.markers = msg.markers;

    const st = msg.stats;
    if (st) {
      if (st.shift) w.shift = st.shift;
      if (st.day) w.day = st.day;
      if (st.totals) w.totals = st.totals;
      if (typeof st.shiftTime === 'number') w.shiftTime = st.shiftTime;
      if (typeof st.rushUntil === 'number') w.rushUntil = st.rushUntil;
      if (Array.isArray(st.board)) this.board = st.board;
      if (Array.isArray(st.seriesAppend)) {
        appendSeries(w.valueSeries, st.seriesAppend);
        w.series = w.valueSeries;
      }
      if (Array.isArray(st.history)) w.history = st.history as unknown as DayHistoryEntry[];
      if (Array.isArray(st.hall)) {
        w.hallOfFame = st.hall as unknown as HallEntry[];
        w.hall = w.hallOfFame;
      }
      if (st.heat) w.heat = denseHeat(st.heat);
    }
    if (msg.votes && typeof msg.votes === 'object') w.difficultyVotes = msg.votes;
    if (msg.hands && typeof msg.hands === 'object') {
      w.cards = mergeOwnHand(w.cards ?? {}, msg.hands as unknown as World['cards'], this.you?.clientId);
      w.hands = w.cards;
    }
    if (typeof msg.difficulty === 'string' && msg.difficulty in DIFFICULTY) {
      w.difficulty = msg.difficulty as World['difficulty'];
    }

    const incoming = (Array.isArray(msg.events) ? msg.events : []) as SimEvent[];
    if (incoming.length) {
      this.events = mergeEvents(this.events, incoming, EVENT_CAP);
      const brain = incoming.map(brainEntryFromEvent).filter((e): e is BrainLogEntry => !!e);
      if (brain.length) this.brainLog = mergeEvents(this.brainLog, brain, BRAIN_LOG_CAP);
      for (const ev of incoming) {
        if (ev.type === 'decision' && typeof ev.vid === 'string' && typeof ev.model === 'string') {
          const kind = (typeof ev.kind === 'string' ? ev.kind : 'contract') as VehicleDecision['kind'];
          const reason = ev.text.includes(']: ') ? ev.text.slice(ev.text.indexOf(']: ') + 3) : ev.text;
          this.side.decisions.set(ev.vid, {
            kind,
            model: ev.model,
            latencyMs: typeof ev.latencyMs === 'number' ? ev.latencyMs : 0,
            reason,
            t: ev.t,
          });
          this.side.reasons.set(ev.vid, reason);
        }
      }
    }
    if (this.selectedVid && !this.vehicle(this.selectedVid)) this.selectedVid = null;
    this.changed();
    return incoming;
  }

  applyPresence(players: PresenceEntry[]): void {
    this.presence = players;
    const bots = this.botVids();
    for (const v of this.world.vehicles) v.isBot = bots.has(v.id);
    for (const [vid, ov] of this.overlays) this.overlays.set(vid, { ...ov, isBot: bots.has(vid) });
    if (this.you) {
      const me = players.find((p) => p.clientId === this.you!.clientId);
      if (me && me.vid !== this.you.vid) {
        this.you = { ...this.you, vid: me.vid };
        if (me.vid) this.selectedVid = me.vid;
      }
    }
    this.changed();
  }

  setBrainHealth(msg: BrainHealthMessage): void {
    this.brainHealth = msg;
    this.changed();
  }

  setPhase(info: PhaseInfo): void {
    this.phaseInfo = info;
    this.world.phase = info.phase;
    this.changed();
  }

  setConn(status: ConnStatus, text = ''): void {
    this.conn = { status, text };
    this.changed();
  }

  select(vid: string | null): void {
    this.selectedVid = vid;
    this.changed();
  }
}
