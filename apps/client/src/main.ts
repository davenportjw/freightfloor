import {
  dequantiseCoord,
  SITE_IDS,
  type AckMessage,
  type BrainHealthMessage,
  type ClientMessage,
  type CommandEchoMessage,
  type DeltaMessage,
  type LeaderboardEntry,
  type Phase,
  type PlayerSessionInfo,
  type PresenceEntry,
  type QuantisedVehicleDelta,
  type ServerMessage,
  type SiteId,
  type SiteStatus,
} from '@warehouse/protocol';
import {
  board,
  buildMap,
  clockText,
  createWorld,
  dayIndex,
  DIFFICULTY,
  guide,
  HUMAN,
  leaderboard,
  phaseText,
  restore,
  shiftName,
  stepHuman,
  STRATEGIES,
  type DriverInput,
  type Vehicle,
  type World,
} from '@warehouse/sim';
import {
  WarehouseRenderer,
  type RenderVehicleOverlay,
} from './renderer.js';

export const CLIENT_VERSION = 1;

const DISPLAY_NAME_REGEX = /^[A-Za-z0-9 _.-]{1,18}$/;

export function validateClientDisplayName(raw: string): {
  ok: boolean;
  name: string;
  error?: string;
} {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (!trimmed) {
    return { ok: false, name: '', error: 'Display name cannot be empty.' };
  }
  if (trimmed.length > 18) {
    return { ok: false, name: '', error: 'Display name must be at most 18 characters.' };
  }
  if (!DISPLAY_NAME_REGEX.test(trimmed)) {
    return {
      ok: false,
      name: '',
      error: 'Only letters, numbers, spaces, _, ., and - are allowed.',
    };
  }
  return { ok: true, name: trimmed };
}

/**
 * Safely creates an element with textContent — never innerHTML.
 */
export function createSafeElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

export interface PendingInputFrame {
  seq: number;
  input: DriverInput;
  dt: number;
}

/**
 * Applies quantised vehicle deltas (`qx, qy` in 1/32 tile units) to the client World state.
 */
export function applyQuantisedDelta(
  w: World,
  deltas: QuantisedVehicleDelta[],
  myVid: string | null,
  overlays: Map<string, RenderVehicleOverlay>,
): void {
  const byId = new Map<string, Vehicle>();
  for (const v of w.vehicles) {
    byId.set(v.id, v);
  }

  for (const d of deltas) {
    const v = byId.get(d.id);
    if (!v) continue;

    const targetX =
      typeof d.qx === 'number'
        ? dequantiseCoord(d.qx)
        : typeof d.px === 'number'
          ? d.px
          : v.px;
    const targetY =
      typeof d.qy === 'number'
        ? dequantiseCoord(d.qy)
        : typeof d.py === 'number'
          ? d.py
          : v.py;

    // If this is not our locally predicted human vehicle, update position from server delta
    if (v.id !== myVid) {
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
    if (typeof d.strategy === 'string' && d.strategy !== 'Human') {
      v.strategy = d.strategy as Vehicle['strategy'];
    }
    if (typeof d.type === 'string') v.type = d.type as Vehicle['type'];
    if (typeof d.braking === 'boolean') v.braking = d.braking;
    if (typeof d.stunnedUntil === 'number') v.stunnedUntil = d.stunnedUntil;
    if (typeof d.sPts === 'number') v.sPts = d.sPts;
    if (typeof d.sShipped === 'number') v.sShipped = d.sShipped;
    if (typeof d.msg === 'string') v.msg = d.msg;

    if (d.brainError !== undefined) {
      v.brainError = d.brainError;
    }
    if (typeof d.lastReason === 'string' && d.lastReason) {
      v.lastDecision = {
        id: v.lastDecision?.id || `dec-${w.t}`,
        kind: v.lastDecision?.kind || 'contract',
        reason: d.lastReason,
        model: v.lastDecision?.model || 'gemini-3.8-flash',
        latencyMs: v.lastDecision?.latencyMs || 0,
        t: w.t,
      };
    }

    const prevOv = overlays.get(v.id) || {};
    overlays.set(v.id, {
      ...prevOv,
      brainThinking: Boolean(d.brainThinking),
      brainError: d.brainError !== undefined ? d.brainError : prevOv.brainError,
    });
  }
}

/**
 * Reconciles client-predicted vehicle position with authoritative server ack and replays unacked inputs.
 */
export function reconcilePredictedVehicle(
  w: World,
  v: Vehicle,
  ack: AckMessage,
  pendingInputs: PendingInputFrame[],
): PendingInputFrame[] {
  if (typeof ack.x === 'number') v.px = ack.x;
  if (typeof ack.y === 'number') v.py = ack.y;
  v.tile = { x: Math.floor(v.px), y: Math.floor(v.py) };
  if (typeof ack.angle === 'number') v.angle = ack.angle;
  if (typeof ack.speedNow === 'number') v.speedNow = ack.speedNow;

  const remaining = pendingInputs.filter((frame) => frame.seq > ack.seq);
  for (const frame of remaining) {
    stepHuman(w, v, frame.input, frame.dt);
  }
  return remaining;
}

class WarehouseClientApp {
  public world: World;
  private renderer: WarehouseRenderer;

  private clientId: string;
  private displayName: string;
  private currentSiteId: SiteId = 'den-1';
  private you: PlayerSessionInfo | null = null;
  private selectedVid: string | null = 'v1';

  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isConnecting = false;

  private inputState: DriverInput = { up: false, down: false, left: false, right: false };
  private inputSeq = 0;
  private pendingInputs: PendingInputFrame[] = [];
  private overlays = new Map<string, RenderVehicleOverlay>();
  private presence: PresenceEntry[] = [];
  private networkSites: SiteStatus[] = [];
  private networkLeaderboard: LeaderboardEntry[] = [];
  private phaseInfo: { phase: Phase; resumesAt?: number; reason?: string } = {
    phase: 'running',
  };
  private brainHealth: BrainHealthMessage = {
    type: 'brainHealth',
    ok: true,
    model: 'gemini-3.8-flash',
    errors1m: 0,
    p50ms: 0,
    budgetLeftUsd: 10.0,
    armorBlocks1h: 0,
  };

  constructor(canvas: HTMLCanvasElement) {
    this.clientId = this.loadOrCreateClientId();
    this.displayName = this.loadSavedDisplayName();
    this.world = createWorld({ seed: 42, siteId: 'den-1' });

    this.renderer = new WarehouseRenderer({
      canvas,
      onSelectVehicle: (vid) => {
        this.selectedVid = vid;
        this.updateInspectorHud();
        this.updateCardsHud();
      },
      onClickTile: (tileX, tileY) => {
        this.sendWs({ type: 'manager', op: 'cone', x: tileX, y: tileY });
      },
    });
  }

  private loadOrCreateClientId(): string {
    try {
      const existing = localStorage.getItem('warehouse_client_id');
      if (existing && existing.length >= 6) return existing;
      const created = `op-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
      localStorage.setItem('warehouse_client_id', created);
      return created;
    } catch {
      return `op-${Date.now().toString(36)}`;
    }
  }

  private loadSavedDisplayName(): string {
    try {
      const saved = localStorage.getItem('warehouse_display_name');
      if (saved && validateClientDisplayName(saved).ok) return saved;
    } catch {
      // Ignore storage errors
    }
    return 'Operator-1';
  }

  public async start(): Promise<void> {
    await this.renderer.init();
    const rendererBadge = document.getElementById('rendererBadge');
    if (rendererBadge) rendererBadge.textContent = this.renderer.modeLabel;

    this.bindUiControls();
    this.bindKeyboardControls();
    this.renderAllPanels();

    // Join via Lobby and connect WebSocket
    void this.joinAndConnect();

    // Poll /api/network every 5 seconds
    void this.fetchNetworkStatus();
    setInterval(() => {
      void this.fetchNetworkStatus();
    }, 5_000);

    // 60fps render & local prediction loop
    let lastFrameMs = performance.now();
    const frameLoop = (nowMs: number) => {
      const elapsedSec = Math.min(0.1, Math.max(0.001, (nowMs - lastFrameMs) / 1000));
      lastFrameMs = nowMs;

      this.stepLocalPrediction(elapsedSec);
      this.renderer.render(
        this.world,
        this.selectedVid,
        this.you?.vid ?? null,
        this.overlays,
      );
      this.updateTopBarDynamicPills();
      requestAnimationFrame(frameLoop);
    };
    requestAnimationFrame(frameLoop);
  }

  private stepLocalPrediction(elapsedSec: number): void {
    const myVid = this.you?.vid;
    if (!myVid || this.world.phase === 'break') return;
    const v = this.world.vehicles.find((x) => x.id === myVid);
    if (!v || !v.human) return;

    const hasInput =
      this.inputState.up ||
      this.inputState.down ||
      this.inputState.left ||
      this.inputState.right;
    if (hasInput || Math.abs(v.speedNow) > 0.01) {
      // Sim time dt: 10 Hz server tick is ~0.05 sim minutes per 100ms (0.5 sim min / sec)
      const simDt = elapsedSec * 0.5;
      stepHuman(this.world, v, this.inputState, simDt);
    }
  }

  private bindUiControls(): void {
    const nameInput = document.getElementById('displayNameInput') as HTMLInputElement | null;
    if (nameInput) nameInput.value = this.displayName;

    const joinForm = document.getElementById('joinForm');
    joinForm?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const raw = nameInput?.value ?? '';
      const check = validateClientDisplayName(raw);
      const errBadge = document.getElementById('nameErrorBadge');
      if (!check.ok) {
        if (errBadge) {
          errBadge.textContent = check.error || 'Invalid display name';
          errBadge.classList.remove('hidden');
        }
        return;
      }
      errBadge?.classList.add('hidden');
      this.displayName = check.name;
      try {
        localStorage.setItem('warehouse_display_name', this.displayName);
      } catch {
        // Ignore storage errors
      }
      void this.joinAndConnect(this.currentSiteId);
    });

    // Left Panel Tabs
    const tabStratBtn = document.getElementById('tabStrategyBtn');
    const tabNetBtn = document.getElementById('tabNetworkBtn');
    const tabStratContent = document.getElementById('tabStrategyContent');
    const tabNetContent = document.getElementById('tabNetworkContent');

    tabStratBtn?.addEventListener('click', () => {
      tabStratBtn.classList.add('active');
      tabNetBtn?.classList.remove('active');
      tabStratContent?.classList.remove('hidden');
      tabNetContent?.classList.add('hidden');
    });

    tabNetBtn?.addEventListener('click', () => {
      tabNetBtn.classList.add('active');
      tabStratBtn?.classList.remove('active');
      tabNetContent?.classList.remove('hidden');
      tabStratContent?.classList.add('hidden');
      void this.fetchNetworkStatus();
    });

    // Right Drawer Toggle
    const toggleDrawerBtn = document.getElementById('toggleDrawerBtn');
    const workspaceGrid = document.getElementById('workspaceGrid');
    toggleDrawerBtn?.addEventListener('click', () => {
      workspaceGrid?.classList.toggle('drawer-collapsed');
      setTimeout(() => this.renderer.resize(), 200);
    });

    // Stage Camera Toolbar
    document.getElementById('zoomInBtn')?.addEventListener('click', () => {
      this.renderer.zoom = Math.min(2.4, this.renderer.zoom * 1.18);
    });
    document.getElementById('zoomOutBtn')?.addEventListener('click', () => {
      this.renderer.zoom = Math.max(0.4, this.renderer.zoom * 0.84);
    });
    document.getElementById('fitViewBtn')?.addEventListener('click', () => {
      this.renderer.fitFloor(this.world.map);
      document.getElementById('followCamBtn')?.classList.remove('active-mode');
    });
    const followCamBtn = document.getElementById('followCamBtn');
    followCamBtn?.addEventListener('click', () => {
      this.renderer.followActive = !this.renderer.followActive;
      followCamBtn.classList.toggle('active-mode', this.renderer.followActive);
    });

    // Manager Dispatch Buttons
    document.getElementById('opRushBtn')?.addEventListener('click', () => {
      this.sendWs({ type: 'manager', op: 'rush' });
    });
    document.getElementById('opP0Btn')?.addEventListener('click', () => {
      this.sendWs({ type: 'manager', op: 'p0' });
    });
    const coneBtn = document.getElementById('opConeModeBtn');
    coneBtn?.addEventListener('click', () => {
      this.renderer.coneMode = !this.renderer.coneMode;
      coneBtn.classList.toggle('active-mode', this.renderer.coneMode);
    });
    document.getElementById('opFleetAddBtn')?.addEventListener('click', () => {
      this.sendWs({ type: 'manager', op: 'fleetAdd' });
    });
    document.getElementById('opFleetRemoveBtn')?.addEventListener('click', () => {
      this.sendWs({ type: 'manager', op: 'fleetRemove' });
    });

    // Difficulty Votes
    document.getElementById('voteEasyBtn')?.addEventListener('click', () => {
      this.sendWs({ type: 'voteDifficulty', level: 'easy' });
    });
    document.getElementById('voteNormalBtn')?.addEventListener('click', () => {
      this.sendWs({ type: 'voteDifficulty', level: 'normal' });
    });
    document.getElementById('voteHardBtn')?.addEventListener('click', () => {
      this.sendWs({ type: 'voteDifficulty', level: 'hard' });
    });

    // Natural Language Command Form
    const nlForm = document.getElementById('nlCommandForm');
    const nlInput = document.getElementById('nlCommandInput') as HTMLInputElement | null;
    nlForm?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const text = nlInput?.value.trim() ?? '';
      if (!text) return;
      this.sendWs({ type: 'nlCommand', text });
      if (nlInput) nlInput.value = '';
    });

    // HUD Drive Controls
    document.getElementById('takeWheelBtn')?.addEventListener('click', () => {
      const targetVid = this.selectedVid || 'v1';
      this.sendWs({ type: 'takeWheel', vid: targetVid });
    });
    document.getElementById('releaseWheelBtn')?.addEventListener('click', () => {
      this.sendWs({ type: 'release' });
    });
    document.getElementById('interactBtn')?.addEventListener('click', () => {
      this.sendWs({ type: 'interact' });
    });

    document.getElementById('refreshNetworkBtn')?.addEventListener('click', () => {
      void this.fetchNetworkStatus();
    });
  }

  private bindKeyboardControls(): void {
    const isTypingInInput = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName.toLowerCase();
      return tag === 'input' || tag === 'textarea' || target.isContentEditable;
    };

    const updateKey = (code: string, down: boolean): boolean => {
      if (code === 'KeyW' || code === 'ArrowUp') {
        this.inputState.up = down;
        return true;
      }
      if (code === 'KeyS' || code === 'ArrowDown') {
        this.inputState.down = down;
        return true;
      }
      if (code === 'KeyA' || code === 'ArrowLeft') {
        this.inputState.left = down;
        return true;
      }
      if (code === 'KeyD' || code === 'ArrowRight') {
        this.inputState.right = down;
        return true;
      }
      return false;
    };

    window.addEventListener('keydown', (ev) => {
      if (isTypingInInput(ev.target)) return;
      if (ev.code === 'KeyE') {
        ev.preventDefault();
        this.sendWs({ type: 'interact' });
        return;
      }
      if (updateKey(ev.code, true)) {
        ev.preventDefault();
        this.dispatchDriverInput();
      }
    });

    window.addEventListener('keyup', (ev) => {
      if (isTypingInInput(ev.target)) return;
      if (updateKey(ev.code, false)) {
        ev.preventDefault();
        this.dispatchDriverInput();
      }
    });
  }

  private dispatchDriverInput(): void {
    const seq = ++this.inputSeq;
    const frame: PendingInputFrame = {
      seq,
      input: { ...this.inputState },
      dt: 0.05,
    };
    this.pendingInputs.push(frame);
    if (this.pendingInputs.length > 60) {
      this.pendingInputs.shift();
    }
    this.sendWs({
      type: 'input',
      up: this.inputState.up,
      down: this.inputState.down,
      left: this.inputState.left,
      right: this.inputState.right,
      seq,
    });
  }

  public async joinAndConnect(preferredSite?: SiteId): Promise<void> {
    if (this.isConnecting) return;
    this.isConnecting = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const reconnectPill = document.getElementById('reconnectPill');
    const reconnectText = document.getElementById('reconnectText');

    try {
      const res = await fetch('/api/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: this.displayName,
          clientId: this.clientId,
          preferredSite: preferredSite ?? this.currentSiteId,
          prefer: preferredSite ?? this.currentSiteId,
        }),
      });

      if (!res.ok) {
        const errData = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(errData.message || `Join HTTP ${res.status}`);
      }

      const joinData = (await res.json()) as {
        siteId: SiteId;
        wsUrl: string;
        ticket: string;
        role?: 'driver' | 'spectator';
        isBot?: boolean;
      };

      this.currentSiteId = joinData.siteId;
      this.connectWebSocket(joinData.wsUrl, joinData.ticket);
      reconnectPill?.classList.add('hidden');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection failed';
      if (reconnectPill && reconnectText) {
        reconnectPill.classList.remove('hidden');
        reconnectText.textContent = `Lobby error: ${msg} — retrying…`;
      }
      this.scheduleReconnect();
    } finally {
      this.isConnecting = false;
    }
  }

  private connectWebSocket(rawWsUrl: string, ticket: string): void {
    if (this.ws) {
      try {
        this.ws.onclose = null;
        this.ws.close();
      } catch {
        // Ignore close errors
      }
    }

    let targetUrl = rawWsUrl;
    if (
      typeof window !== 'undefined' &&
      rawWsUrl.startsWith('ws://localhost') &&
      window.location.hostname !== 'localhost'
    ) {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      targetUrl = `${proto}//${window.location.host}/ws?site=${this.currentSiteId}`;
    }

    const socket = new WebSocket(targetUrl);
    this.ws = socket;

    socket.onopen = () => {
      this.reconnectAttempts = 0;
      document.getElementById('reconnectPill')?.classList.add('hidden');
      this.sendWs({ type: 'hello', ticket });
    };

    socket.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      try {
        const msg = JSON.parse(ev.data) as ServerMessage;
        this.handleServerMessage(msg);
      } catch {
        // Ignore malformed frame
      }
    };

    socket.onclose = () => {
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose will trigger reconnect
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delayMs = Math.min(8_000, 500 * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts++;

    const reconnectPill = document.getElementById('reconnectPill');
    const reconnectText = document.getElementById('reconnectText');
    if (reconnectPill && reconnectText) {
      reconnectPill.classList.remove('hidden');
      reconnectText.textContent = `Reconnecting in ${(delayMs / 1000).toFixed(1)}s…`;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.joinAndConnect(this.currentSiteId);
    }, delayMs);
  }

  private sendWs(msg: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  public handleServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'welcome': {
        this.you = msg.you;
        this.currentSiteId = msg.you.siteId;
        if (msg.you.vid) {
          this.selectedVid = msg.you.vid;
        }
        if (msg.snapshot) {
          try {
            const restored = restore(msg.snapshot);
            if (restored) {
              this.world = restored;
            }
          } catch {
            // Apply snapshot fields directly if partial snapshot
            const snap = msg.snapshot as Partial<World>;
            if (typeof snap.tier === 'number' && snap.tier !== this.world.tier) {
              this.world.tier = snap.tier;
              this.world.map = buildMap(snap.tier);
            }
            if (Array.isArray(snap.vehicles)) this.world.vehicles = snap.vehicles;
            if (Array.isArray(snap.orders)) this.world.orders = snap.orders;
          }
        }
        this.renderAllPanels();
        break;
      }

      case 'delta': {
        this.applyDeltaMessage(msg);
        break;
      }

      case 'ack': {
        const myVid = this.you?.vid;
        if (myVid) {
          const myV = this.world.vehicles.find((v) => v.id === myVid);
          if (myV) {
            this.pendingInputs = reconcilePredictedVehicle(
              this.world,
              myV,
              msg,
              this.pendingInputs,
            );
          }
        }
        break;
      }

      case 'presence': {
        this.presence = msg.players;
        for (const p of msg.players) {
          if (p.vid) {
            const prev = this.overlays.get(p.vid) || {};
            this.overlays.set(p.vid, { ...prev, isBot: Boolean(p.isBot) });
          }
        }
        this.renderPresenceList();
        this.renderShiftLeaderboard();
        break;
      }

      case 'brainHealth': {
        this.brainHealth = msg;
        this.renderBrainHealthPill();
        break;
      }

      case 'phase': {
        this.phaseInfo = {
          phase: msg.phase,
          resumesAt: msg.resumesAt,
          reason: msg.reason,
        };
        this.world.phase = msg.phase;
        this.updateTopBarDynamicPills();
        break;
      }

      case 'commandEcho': {
        this.renderCommandEcho(msg);
        break;
      }

      case 'error': {
        const echoBox = document.getElementById('commandEchoBox');
        if (echoBox) {
          echoBox.className = 'event-item ev-error';
          echoBox.textContent = `[${msg.code}] ${msg.message}`;
        }
        break;
      }
    }
  }

  private applyDeltaMessage(msg: DeltaMessage): void {
    this.world.t = msg.t;

    if (typeof msg.tier === 'number' && msg.tier !== this.world.tier) {
      this.world.tier = msg.tier;
      this.world.map = buildMap(msg.tier);
    }

    applyQuantisedDelta(
      this.world,
      msg.vehicles,
      this.you?.vid ?? null,
      this.overlays,
    );

    if (Array.isArray(msg.orders)) this.world.orders = msg.orders;
    if (Array.isArray(msg.hazards)) this.world.spills = msg.hazards;
    if (Array.isArray(msg.cones)) this.world.cones = new Set(msg.cones);
    if (Array.isArray(msg.bays)) this.world.bays = msg.bays;
    if (Array.isArray(msg.markers)) this.world.markers = msg.markers;
    if (msg.stats) {
      if (msg.stats.shift) this.world.shift = msg.stats.shift;
      if (msg.stats.day) this.world.day = msg.stats.day;
      if (msg.stats.totals) this.world.totals = msg.stats.totals;
      if (Array.isArray(msg.stats.series)) this.world.series = msg.stats.series;
    }
    if (msg.votes && typeof msg.votes === 'object') {
      this.world.difficultyVotes = msg.votes;
    }
    if (msg.hands && typeof msg.hands === 'object') {
      this.world.cards = msg.hands;
    }
    if (typeof msg.difficulty === 'string' && msg.difficulty in DIFFICULTY) {
      this.world.difficulty = msg.difficulty as World['difficulty'];
    }

    if (Array.isArray(msg.events) && msg.events.length > 0) {
      for (const ev of msg.events) {
        this.world.events.unshift(ev);
      }
      if (this.world.events.length > 120) {
        this.world.events.length = 120;
      }
    }

    this.renderAllPanels();
  }

  private async fetchNetworkStatus(): Promise<void> {
    try {
      const res = await fetch('/api/network');
      if (!res.ok) return;
      const data = (await res.json()) as {
        sites: SiteStatus[];
        leaderboard: LeaderboardEntry[];
      };
      this.networkSites = data.sites;
      this.networkLeaderboard = data.leaderboard;
      this.renderNetworkTab();
    } catch {
      // Network tab retains last known state
    }
  }

  private renderAllPanels(): void {
    this.updateTopBarDynamicPills();
    this.renderStrategyTable();
    this.updateInspectorHud();
    this.updateCardsHud();
    this.renderShiftLeaderboard();
    this.renderPresenceList();
    this.renderSparklineChart();
    this.renderEventLog();
  }

  private updateTopBarDynamicPills(): void {
    const siteBadge = document.getElementById('siteBadge');
    if (siteBadge) {
      siteBadge.textContent = `${this.currentSiteId.toUpperCase()} · Tier ${this.world.tier}`;
    }

    const clockPill = document.getElementById('clockPill');
    if (clockPill) {
      clockPill.textContent = `Day ${dayIndex(this.world.t) + 1} · ${clockText(this.world.t)} · ${shiftName(this.world.t)}`;
    }

    const diffCfg = DIFFICULTY[this.world.difficulty] || DIFFICULTY.normal;
    const diffPill = document.getElementById('difficultyPill');
    if (diffPill) {
      const voteCount = Object.keys(this.world.difficultyVotes || {}).length;
      diffPill.textContent =
        voteCount > 0
          ? `Difficulty: ${diffCfg.label} (${voteCount} vote${voteCount === 1 ? '' : 's'})`
          : `Difficulty: ${diffCfg.label}`;
    }

    const phasePill = document.getElementById('phasePill');
    const phaseTextEl = document.getElementById('phaseText');
    if (phasePill && phaseTextEl) {
      if (this.phaseInfo.phase === 'break' || this.world.phase === 'break') {
        phasePill.className = 'intent-pill warn';
        const remSec = this.phaseInfo.resumesAt
          ? Math.max(0, Math.ceil((this.phaseInfo.resumesAt - Date.now()) / 1000))
          : 0;
        const mm = String(Math.floor(remSec / 60)).padStart(2, '0');
        const ss = String(remSec % 60).padStart(2, '0');
        phaseTextEl.textContent =
          remSec > 0 ? `Factory Break · Resumes ${mm}:${ss}` : 'Factory Break';
      } else if (
        this.phaseInfo.phase === 'winding_down' ||
        this.world.phase === 'winding_down'
      ) {
        phasePill.className = 'intent-pill warn';
        phaseTextEl.textContent = 'Winding Down for Break';
      } else {
        phasePill.className = 'intent-pill live';
        phaseTextEl.textContent = phaseText(this.world);
      }
    }
  }

  private renderBrainHealthPill(): void {
    const pill = document.getElementById('brainHealthPill');
    const textEl = document.getElementById('brainHealthText');
    if (!pill || !textEl) return;

    const bh = this.brainHealth;
    pill.className = bh.ok ? 'intent-pill live' : 'intent-pill danger';
    const modelName = bh.model || 'gemini-3.8-flash';
    textEl.textContent = `Brain: ${modelName} · p50 ${Math.round(bh.p50ms)}ms · err ${bh.errors1m} · $${bh.budgetLeftUsd.toFixed(2)}`;
  }

  private renderStrategyTable(): void {
    const tbody = document.getElementById('strategyTableBody');
    if (!tbody) return;

    const rows = board(this.world);
    const totalsSub = document.getElementById('shiftTotalsSub');
    if (totalsSub) {
      const sh = this.world.shift.shipped;
      const ot = sh > 0 ? Math.round((this.world.shift.onTime / sh) * 100) : 100;
      totalsSub.textContent = `${sh} shipped · ${ot}% on-time`;
    }

    const trNodes: HTMLTableRowElement[] = [];
    for (const r of rows) {
      const tr = document.createElement('tr');

      const tdName = document.createElement('td');
      const dot = createSafeElement('span', '● ');
      dot.style.color =
        r.strat === 'Human' ? HUMAN.color : STRATEGIES[r.strat]?.color || '#64748b';
      const label = createSafeElement('strong', r.strat);
      tdName.append(dot, label);

      const tdFleet = createSafeElement('td', String(r.vehicles));
      const tdShip = createSafeElement('td', String(r.count));
      const tdOt = createSafeElement(
        'td',
        r.onTimePct !== null ? `${Math.round(r.onTimePct)}%` : '—',
      );
      const tdCrash = createSafeElement('td', String(r.incidents));
      const tdPts = createSafeElement('td', `${r.perHr.toFixed(1)}/h`);

      tr.append(tdName, tdFleet, tdShip, tdOt, tdCrash, tdPts);
      trNodes.push(tr);
    }
    tbody.replaceChildren(...trNodes);
  }

  private renderCommandEcho(msg: CommandEchoMessage): void {
    const echoBox = document.getElementById('commandEchoBox');
    if (!echoBox) return;

    echoBox.className = msg.executed ? 'event-item ev-transfer' : 'event-item ev-error';
    const statusLabel = msg.executed ? 'Executed' : 'Refused';
    const detail = msg.reason
      ? ` — ${msg.reason}`
      : msg.parsed
        ? ` — ${JSON.stringify(msg.parsed)}`
        : '';
    echoBox.textContent = `[${statusLabel}] "${msg.text}"${detail}`;
  }

  private updateInspectorHud(): void {
    const targetId = this.selectedVid || this.you?.vid || 'v1';
    const v =
      this.world.vehicles.find((x) => x.id === targetId) || this.world.vehicles[0];
    if (!v) return;

    const titleEl = document.getElementById('hudVehicleTitle');
    if (titleEl) {
      const who = v.driver ? `${v.driver}` : v.human ? 'Human Slot' : v.strategy;
      titleEl.textContent = `Forklift ${v.id.toUpperCase()} · ${who} (${v.type})`;
    }

    const badgesEl = document.getElementById('hudVehicleBadges');
    if (badgesEl) {
      const badgeNodes: HTMLElement[] = [];
      const ov = this.overlays.get(v.id);
      if (ov?.isBot) {
        badgeNodes.push(createSafeElement('span', 'BOT', 'intent-pill warn'));
      }
      if (v.brainError || ov?.brainError) {
        badgeNodes.push(createSafeElement('span', 'BRAIN ERROR', 'intent-pill danger'));
      } else if (
        ov?.brainThinking ||
        this.world.pendingDecisions.some((r) => r.agentId === v.id)
      ) {
        badgeNodes.push(createSafeElement('span', 'AI THINKING…', 'intent-pill indigo'));
      }
      badgesEl.replaceChildren(...badgeNodes);
    }

    const statusRow = document.getElementById('hudStatusRow');
    if (statusRow) {
      const cargoStr =
        v.cargo.length > 0
          ? v.cargo.map((o) => `#${o.id}→${o.bay}${o.p0 ? '!' : ''}`).join(', ')
          : 'Empty forks';
      statusRow.textContent = `State: ${v.state} · Battery: ${Math.round(v.battery)}% · Speed: ${v.speedNow.toFixed(1)} t/m · Cargo: ${cargoStr}`;
    }

    const guideBox = document.getElementById('hudGuideBox');
    if (guideBox) {
      const g = guide(this.world, v);
      guideBox.textContent = g?.text || v.msg || 'Standing by for next dispatch.';
    }

    const brainBox = document.getElementById('hudBrainBox');
    if (brainBox) {
      const errText = v.brainError || this.overlays.get(v.id)?.brainError;
      if (errText) {
        brainBox.className = 'event-item ev-error';
        brainBox.textContent = `Brain Error: ${errText} (Agent holding safely)`;
      } else if (v.lastDecision) {
        brainBox.className = 'event-item ev-decision';
        brainBox.textContent = `Gemini (${v.lastDecision.model}, ${v.lastDecision.latencyMs}ms) [${v.lastDecision.kind}]: ${v.lastDecision.reason}`;
      } else {
        brainBox.className = 'event-item ev-decision';
        brainBox.textContent = v.human
          ? 'Human manual control active — use WASD / Arrows and E to interact.'
          : `Autonomous ${v.strategy} persona active — awaiting next Gemini decision point.`;
      }
    }

    const takeBtn = document.getElementById('takeWheelBtn');
    const releaseBtn = document.getElementById('releaseWheelBtn');
    const isDrivingThis = this.you?.vid === v.id;
    takeBtn?.classList.toggle('hidden', isDrivingThis);
    releaseBtn?.classList.toggle('hidden', !isDrivingThis);
  }

  private updateCardsHud(): void {
    const targetId = this.you?.vid || this.selectedVid || 'v1';
    const ownerSub = document.getElementById('cardsOwnerSub');
    if (ownerSub) ownerSub.textContent = targetId.toUpperCase();

    const hand = this.world.cards?.[targetId];
    const activeList = document.getElementById('activeCardsList');
    if (activeList) {
      if (!hand || hand.cards.length === 0) {
        activeList.replaceChildren(
          createSafeElement(
            'span',
            'Complete 6 deliveries to unlock shift skill cards.',
            'section-sub',
          ),
        );
      } else {
        const pills = hand.cards.map((c) => {
          const pill = createSafeElement('span', `${c.title}`, 'intent-pill indigo');
          pill.title = c.desc;
          return pill;
        });
        activeList.replaceChildren(...pills);
      }
    }

    const offerBox = document.getElementById('cardOfferBox');
    const offerOptions = document.getElementById('cardOfferOptions');
    if (offerBox && offerOptions) {
      if (hand?.offer && hand.offer.length > 0) {
        offerBox.classList.remove('hidden');
        const btns = hand.offer.map((card) => {
          const btn = createSafeElement(
            'button',
            `${card.title} — ${card.desc}`,
            'btn',
          );
          btn.type = 'button';
          btn.style.justifyContent = 'flex-start';
          btn.style.textAlign = 'left';
          btn.addEventListener('click', () => {
            this.sendWs({ type: 'keepCards', ids: [card.id] });
          });
          return btn;
        });
        offerOptions.replaceChildren(...btns);
      } else {
        offerBox.classList.add('hidden');
        offerOptions.replaceChildren();
      }
    }
  }

  private renderShiftLeaderboard(): void {
    const tbody = document.getElementById('shiftLeaderboardBody');
    if (!tbody) return;

    const entries = leaderboard(this.world);
    const rows: HTMLTableRowElement[] = [];

    for (const e of entries) {
      const tr = document.createElement('tr');
      tr.style.cursor = 'pointer';
      tr.addEventListener('click', () => {
        this.selectedVid = e.id;
        this.updateInspectorHud();
        this.updateCardsHud();
      });

      const tdUnit = createSafeElement('td', e.id.toUpperCase());
      const tdWho = document.createElement('td');
      const whoText = e.driver || (e.human ? 'Human' : e.strat);
      const nameSpan = createSafeElement('span', whoText);
      tdWho.appendChild(nameSpan);

      if (this.you?.vid === e.id) {
        const youTag = createSafeElement('span', 'YOU', 'intent-pill live');
        youTag.style.marginLeft = '4px';
        youTag.style.padding = '1px 6px';
        tdWho.appendChild(youTag);
      }
      if (this.overlays.get(e.id)?.isBot) {
        const botTag = createSafeElement('span', 'BOT', 'intent-pill warn');
        botTag.style.marginLeft = '4px';
        botTag.style.padding = '1px 6px';
        tdWho.appendChild(botTag);
      }

      const tdShip = createSafeElement('td', String(e.shipped));
      const tdPts = createSafeElement('td', String(e.pts));

      tr.append(tdUnit, tdWho, tdShip, tdPts);
      rows.push(tr);
    }

    tbody.replaceChildren(...rows);
  }

  private renderPresenceList(): void {
    const listEl = document.getElementById('presenceList');
    const countSub = document.getElementById('presenceCountSub');
    if (!listEl) return;

    const list =
      this.presence.length > 0
        ? this.presence
        : this.you
          ? [
              {
                clientId: this.you.clientId,
                name: this.you.name,
                vid: this.you.vid,
                isBot: this.you.isBot,
              },
            ]
          : [];

    if (countSub) {
      countSub.textContent = `${list.length} connected`;
    }

    const pills = list.map((p) => {
      const unitStr = p.vid ? ` (${p.vid})` : ' (spectator)';
      const botStr = p.isBot ? ' [BOT]' : '';
      return createSafeElement(
        'span',
        `${p.name}${unitStr}${botStr}`,
        p.isBot ? 'intent-pill warn' : 'intent-pill',
      );
    });

    listEl.replaceChildren(...pills);
  }

  private renderSparklineChart(): void {
    const canvas = document.getElementById('sparklineCanvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const series = this.world.series;
    if (!series || series.length < 2) {
      ctx.fillStyle = '#64748b';
      ctx.font = '11px Inter, sans-serif';
      ctx.fillText('Collecting shift trajectory points…', 12, h / 2);
      return;
    }

    let minV = 0;
    let maxV = 50;
    for (const pt of series) {
      for (const val of [pt.you, pt.avg, pt.best]) {
        if (val < minV) minV = val;
        if (val > maxV) maxV = val;
      }
    }
    const range = Math.max(10, maxV - minV);

    const lines: Array<{ key: 'you' | 'avg' | 'best'; color: string; width: number }> = [
      { key: 'avg', color: '#64748b', width: 1.5 },
      { key: 'best', color: '#6366f1', width: 1.8 },
      { key: 'you', color: HUMAN.color, width: 2.2 },
    ];

    for (const line of lines) {
      ctx.strokeStyle = line.color;
      ctx.lineWidth = line.width;
      ctx.beginPath();
      series.forEach((pt, idx) => {
        const x = 8 + (idx / (series.length - 1)) * (w - 16);
        const val = pt[line.key] ?? 0;
        const y = h - 10 - ((val - minV) / range) * (h - 20);
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }

  private renderEventLog(): void {
    const listEl = document.getElementById('eventLogList');
    if (!listEl) return;

    const recent = this.world.events.slice(0, 35);
    const items = recent.map((ev) => {
      let cls = 'event-item';
      const kind = String(ev.kind ?? ev.type ?? '');
      if (kind === 'decision' || kind === 'retune') cls += ' ev-decision';
      else if (kind === 'brain_error' || kind === 'incident') cls += ' ev-error';
      else if (kind === 'transfer_out' || kind === 'transfer_in')
        cls += ' ev-transfer';
      else if (kind === 'p0' || kind === 'p0done') cls += ' ev-p0';

      return createSafeElement('div', `[${clockText(ev.t)}] ${ev.text}`, cls);
    });

    listEl.replaceChildren(...items);
  }

  private renderNetworkTab(): void {
    const sitesList = document.getElementById('networkSitesList');
    if (sitesList) {
      const cards = (
        this.networkSites.length > 0
          ? this.networkSites
          : SITE_IDS.map((id) => ({
              id,
              state: id === this.currentSiteId ? ('live' as const) : ('online' as const),
              drivers: id === this.currentSiteId ? 1 : 0,
              spectators: 0,
              tier: id === this.currentSiteId ? this.world.tier : 0,
              shipped: id === this.currentSiteId ? this.world.totals.shipped : 0,
              phase: 'running' as const,
            }))
      ).map((s) => {
        const isCurrent = s.id === this.currentSiteId;
        const card = createSafeElement(
          'div',
          undefined,
          isCurrent ? 'site-card current-site' : 'site-card',
        );

        const topRow = document.createElement('div');
        topRow.style.display = 'flex';
        topRow.style.justifyContent = 'space-between';
        topRow.style.alignItems = 'center';

        const title = createSafeElement(
          'strong',
          `${s.id.toUpperCase()} ${isCurrent ? '(Current Site)' : ''}`,
        );
        const statePillClass =
          s.state === 'live' || s.state === 'online'
            ? 'intent-pill live'
            : s.state === 'break'
              ? 'intent-pill warn'
              : 'intent-pill danger';
        const statePill = createSafeElement(
          'span',
          s.state.toUpperCase(),
          statePillClass,
        );
        topRow.append(title, statePill);

        const metaRow = createSafeElement(
          'div',
          `Drivers: ${s.drivers}/8 · Spectators: ${s.spectators} · Tier ${s.tier} · Shipped: ${s.shipped}`,
          'section-sub',
        );

        const actionRow = document.createElement('div');
        actionRow.style.display = 'flex';
        actionRow.style.justifyContent = 'flex-end';

        const switchBtn = createSafeElement(
          'button',
          isCurrent ? 'Connected' : `Switch to ${s.id.toUpperCase()}`,
          isCurrent ? 'btn' : 'btn btn-primary',
        );
        switchBtn.type = 'button';
        switchBtn.disabled = isCurrent;
        switchBtn.addEventListener('click', () => {
          this.sendWs({ type: 'transferSite', siteId: s.id });
          void this.joinAndConnect(s.id);
        });
        actionRow.appendChild(switchBtn);

        card.append(topRow, metaRow, actionRow);
        return card;
      });

      sitesList.replaceChildren(...cards);
    }

    const lbBody = document.getElementById('networkLeaderboardBody');
    if (lbBody) {
      if (this.networkLeaderboard.length === 0) {
        const tr = document.createElement('tr');
        const td = createSafeElement(
          'td',
          'No human operator scores recorded yet.',
          'section-sub',
        );
        td.colSpan = 5;
        tr.appendChild(td);
        lbBody.replaceChildren(tr);
      } else {
        const rows = this.networkLeaderboard.map((entry, idx) => {
          const tr = document.createElement('tr');
          tr.append(
            createSafeElement('td', String(idx + 1)),
            createSafeElement('td', entry.name),
            createSafeElement('td', (entry.siteId || 'den-1').toUpperCase()),
            createSafeElement('td', String(entry.deliveries)),
            createSafeElement(
              'td',
              String(Math.round(entry.points ?? entry.lifetimePoints ?? 0)),
            ),
          );
          return tr;
        });
        lbBody.replaceChildren(...rows);
      }
    }
  }
}

if (typeof document !== 'undefined') {
  const boot = () => {
    const canvas = document.getElementById('view') as HTMLCanvasElement | null;
    if (canvas) {
      const app = new WarehouseClientApp(canvas);
      void app.start();
    }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}
