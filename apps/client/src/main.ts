/**
 * Warehouse client entry: wires the store (state.ts), lobby/socket (net.ts), driving input
 * (input.ts), the canvas renderer (renderer.ts) and the HUD modules (src/ui/**).
 *
 * Everything shown comes from the live site. When a call fails the real error is surfaced
 * (toast / connection pill); nothing is simulated locally.
 */
import type { ClientMessage, ServerMessage, SiteId } from '@warehouse/protocol';
import { dayIndex, leaderboard, shiftIndex } from '@warehouse/sim';
import { InputController } from './input.js';
import { fetchNetwork, NetClient, type NetStatus } from './net.js';
import { WarehouseRenderer, type RenderLayers } from './renderer.js';
import { calloutFor } from './render/fx.js';
import { ClientStore } from './state.js';
import { mountA2ui } from './ui/a2ui.js';
import { mountAgentDesigner } from './ui/agentDesigner.js';
import { mountCards } from './ui/cards.js';
import { mountCommandBar, mountDriveBar, pickDriveTarget } from './ui/commandBar.js';
import type { Actions, UiCtx, UiModule } from './ui/context.js';
import { byId } from './ui/dom.js';
import { mountDrawer } from './ui/drawer.js';
import { mountFleet } from './ui/fleet.js';
import { markHelpSeen, mountHelp, shouldShowHelpOnBoot } from './ui/help.js';
import { isTypingTarget, resolveHotkey, type HotkeyAction } from './ui/hotkeys.js';
import { mountInspector } from './ui/inspector.js';
import { mountKpiBar } from './ui/kpiBar.js';
import { mountLeaderboard } from './ui/leaderboard.js';
import { mountLeaderboardModal } from './ui/leaderboardModal.js';
import { mountNetwork } from './ui/network.js';
import type { PanelHandle } from './ui/panel.js';
import { mountPresence } from './ui/presence.js';
import { mountRunEnd } from './ui/runEnd.js';
import { mountStrategyBoard } from './ui/strategyBoard.js';
import { shouldToast, ToastStack } from './ui/toasts.js';
import { mountToolbar } from './ui/toolbar.js';
import { mountValueChart } from './ui/valueChart.js';

// Re-exported for the existing test suite (test/client.test.ts).
export { applyQuantisedDelta } from './state.js';
export { reconcilePredictedVehicle } from './input.js';

export const CLIENT_VERSION = 1;

const DISPLAY_NAME_REGEX = /^[A-Za-z0-9 _.-]{2,18}$/;
const RUN_SUFFIX_RE = /^(.*?)\s+Run\s+(\d+)$/i;
export const DISPLAY_NAME_KEY = 'warehouse_display_name';
export const CLIENT_ID_KEY = 'warehouse_client_id';
export const NETWORK_POLL_MS = 5_000;
const UI_TICK_MS = 250;

/**
 * Parse a display name into its base screen name and run number (e.g. `"Alex Run 2"` -> `{ baseName: "Alex", runNumber: 2 }`).
 * If no `Run N` suffix is present, `runNumber` defaults to 1.
 */
export function parseRunDisplayName(raw: string): { baseName: string; runNumber: number } {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  const m = RUN_SUFFIX_RE.exec(trimmed);
  if (m) {
    const base = m[1].trim();
    const num = Math.max(1, Number.parseInt(m[2], 10) || 1);
    return { baseName: base || 'Driver', runNumber: num };
  }
  return { baseName: trimmed || 'Driver', runNumber: 1 };
}

/**
 * Format a base screen name and run number so the combined name fits within the 18-char display name limit
 * (e.g. `"Alex"`, `1` -> `"Alex Run 1"`).
 */
export function formatRunDisplayName(rawBase: string, runNumber: number): string {
  const { baseName } = parseRunDisplayName(rawBase);
  const runNum = Math.max(1, Math.floor(runNumber));
  const suffix = ` Run ${runNum}`;
  const maxBaseLen = Math.max(2, 18 - suffix.length);
  const clippedBase = baseName.slice(0, maxBaseLen).trim() || 'Dr';
  return `${clippedBase}${suffix}`;
}

/** Advance a screen name to its next run number (e.g. `"Alex Run 1"` -> `"Alex Run 2"`). */
export function nextRunDisplayName(currentName: string): string {
  const { baseName, runNumber } = parseRunDisplayName(currentName);
  return formatRunDisplayName(baseName, runNumber + 1);
}

/** 2..18 chars of letters, digits, space, `_`, `.`, `-` (the lobby accepts 2..20). */
export function validateClientDisplayName(raw: string): {
  ok: boolean;
  name: string;
  error?: string;
} {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (!trimmed) {
    return { ok: false, name: '', error: 'Display name cannot be empty.' };
  }
  if (trimmed.length < 2) {
    return { ok: false, name: '', error: 'Display name must be at least 2 characters.' };
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

/** Safe element factory (textContent only — server strings are never parsed as HTML). */
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

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    console.error(`Could not persist ${key}`, err);
  }
}

function loadClientId(): string {
  const existing = storageGet(CLIENT_ID_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  storageSet(CLIENT_ID_KEY, id);
  return id;
}

function boot(): void {
  const store = new ClientStore();
  let clientId = loadClientId();
  let netConnected = false;
  let depletedRunVid: string | null = null;
  let displayName: string | null = (() => {
    const saved = storageGet(DISPLAY_NAME_KEY);
    if (!saved || !validateClientDisplayName(saved).ok) return null;
    return saved;
  })();

  const toasts = new ToastStack(byId('toasts'));
  const canvas = byId<HTMLCanvasElement>('world');
  const joinOverlay = byId('joinOverlay');

  // ---- network ------------------------------------------------------------
  const net = new NetClient(
    () => ({ name: displayName ?? undefined, clientId, runMode: store.ui.runMode }),
    {
      onStatus: (s: NetStatus) => onNetStatus(s),
      onMessage: (m: ServerMessage) => onMessage(m),
      onJoined: (join) => {
        if (join.name) {
          displayName = join.name;
          storageSet(DISPLAY_NAME_KEY, join.name);
        }
        if (join.clientId && join.clientId !== clientId) {
          clientId = join.clientId;
          storageSet(CLIENT_ID_KEY, join.clientId);
        }
        store.changed();
      },
    },
  );

  const send = (msg: ClientMessage, quiet = false): boolean => {
    const ok = net.send(msg);
    if (!ok && !quiet) toasts.push('error', 'Not connected to the site.', store.conn.text || undefined);
    return ok;
  };

  const input = new InputController(
    (m) => {
      const me = store.myVehicle();
      if (me) me.input = { ...me.input, boost: Boolean(m.boost) };
      net.send(m);
      updateUi();
    },
    () => store.isDriving(),
    () => store.isMyVehicleAutopilot(),
    () => {
      const me = store.myVehicle();
      if (me && me.autopilot) {
        me.autopilot = false;
        store.changed();
      }
    },
  );

  // ---- renderer -----------------------------------------------------------
  const renderer = new WarehouseRenderer({
    canvas,
    onSelectVehicle: (vid) => store.select(vid),
    onClickTile: (x, y) => {
      send({ type: 'manager', op: 'cone', x, y });
    },
  });

  // ---- actions ------------------------------------------------------------
  const setSwitching = (s: ClientStore['network']['switching']): void => {
    store.network = { ...store.network, switching: s };
    store.changed();
  };

  async function pollNetwork(): Promise<void> {
    if (store.network.status === 'idle') store.network = { ...store.network, status: 'loading' };
    const res = await fetchNetwork();
    store.network = res.ok
      ? {
          ...store.network,
          status: 'ok',
          error: null,
          sites: res.data.sites,
          leaderboard: res.data.leaderboard,
          updatedAt: Date.now(),
        }
      : { ...store.network, status: 'error', error: res.error };
    store.changed();
  }

  const actions: Actions = {
    select: (vid) => store.select(vid),
    takeWheel(vid) {
      const id = vid ?? store.selectedVid;
      if (!id) return;
      if (send({ type: 'takeWheel', vid: id })) store.select(id);
    },
    handBack() {
      if (!store.canHandBack()) return;
      input.reset();
      send({ type: 'release' });
    },
    quickDrive() {
      if (store.isDriving()) return;
      const id = pickDriveTarget(store.world.vehicles, store.selectedVid, store.world.t);
      if (!id) {
        toasts.push('hint', 'No AI vehicle is free to drive right now.');
        return;
      }
      actions.takeWheel(id);
    },
    interact() {
      if (store.isDriving()) send({ type: 'interact' }, true);
    },
    setConeMode(on) {
      store.coneMode = on;
      store.changed();
    },
    toggleLayer(key: keyof RenderLayers) {
      store.layers = { ...store.layers, [key]: !store.layers[key] };
      if (key === 'traffic') {
        if (!store.layers.traffic) store.world.heat.fill(0);
        send({ type: 'layers', traffic: store.layers.traffic }, true);
      }
      store.changed();
    },
    zoomBy: (f) => renderer.zoomBy(f),
    fit: () => renderer.fit(),
    setDrawer(open, tab) {
      store.ui.drawerOpen = open;
      if (tab) store.ui.drawerTab = tab;
      store.changed();
    },
    showLeaderboardModal(open, tab) {
      store.ui.leaderboardModalOpen = open;
      if (tab) store.ui.leaderboardModalTab = tab;
      if (open) void pollNetwork();
      store.changed();
    },
    showHelp(open) {
      store.ui.helpOpen = open;
      if (!open) {
        markHelpSeen(safeStorage());
        if (!netConnected) {
          joinOverlay.hidden = true;
          netConnected = true;
          void net.connect();
        }
      }
      store.changed();
    },
    toggleDocks() {
      store.ui.docksHidden = !store.ui.docksHidden;
      store.changed();
    },
    foldPanels() {
      if (store.ui.docksHidden) store.ui.docksHidden = false;
      const anyOpen = panels.some((p) => p.isOpen());
      if (anyOpen) {
        for (const p of panels) p.setState('collapsed', true);
        presence.collapse();
      } else {
        for (const p of [kpi.panel, board.panel, fleet.panel, lb.panel]) p.setState('open', true);
      }
      store.changed();
    },
    setOpsGuide(open) {
      store.ui.opsGuideOpen = open;
      store.changed();
    },
    setHighlight(strat) {
      store.highlightStrategy = strat;
      store.changed();
    },
    vote: (level) => {
      send({ type: 'voteDifficulty', level });
    },
    keepCards: (ids) => {
      if (ids.length) send({ type: 'keepCards', ids });
    },
    manager: (op) => {
      send({ type: 'manager', op });
    },
    dispatchRoute: (dispatch) => {
      send({ type: 'manager', op: 'dispatch', dispatch });
    },
    openObjectives: () => {
      if (store.activeA2ui) {
        store.setA2ui(null);
        send({ type: 'a2uiAction', screenId: store.activeA2ui.screenId, actionId: 'dismiss' }, true);
      } else {
        send({ type: 'a2uiAction', screenId: 'open', actionId: 'open' });
      }
    },
    submitA2ui: (actionId, dispatch, managerOp) => {
      const screenId = store.activeA2ui?.screenId ?? 'a2ui';
      store.setA2ui(null);
      send({ type: 'a2uiAction', screenId, actionId, dispatch, managerOp });
    },
    dismissA2ui: () => {
      const screenId = store.activeA2ui?.screenId ?? 'a2ui';
      store.setA2ui(null);
      send({ type: 'a2uiAction', screenId, actionId: 'dismiss' }, true);
    },
    nlCommand: (text) => {
      if (send({ type: 'nlCommand', text })) toasts.push('echo', `Sent: “${text}”`);
    },
    showAgentDesigner(open) {
      store.ui.agentDesignerOpen = open;
      store.changed();
    },
    agentCommand(opts) {
      const targetVid = opts.vid ?? store.myVehicle()?.id ?? store.selectedVid ?? undefined;
      if (send({ type: 'agentCommand', vid: targetVid, directive: opts.directive, text: opts.text })) {
        store.ui.agentCommandPending = true;
        const v = targetVid ? store.vehicle(targetVid) : store.myVehicle();
        if (v && opts.directive) {
          if (typeof opts.directive.autopilot === 'boolean') {
            v.autopilot = opts.directive.autopilot;
            if (opts.directive.autopilot) input.reset();
          }
          if (opts.directive.strategy) v.strategy = opts.directive.strategy;
          if (opts.directive.tactics) v.tactics = { ...v.tactics, ...opts.directive.tactics };
        }
        store.changed();
      }
    },
    setAutopilot(on, vid) {
      const targetVid = vid ?? store.myVehicle()?.id ?? store.selectedVid ?? undefined;
      if (!targetVid) return;
      actions.agentCommand({
        vid: targetVid,
        directive: { autopilot: on },
      });
    },
    switchSite(siteId: SiteId) {
      if (siteId === store.siteId) return;
      if (!send({ type: 'transferSite', siteId })) return;
      input.reset();
      setSwitching({ siteId, status: 'pending', message: `Switching to ${siteId.toUpperCase()}…` });
      net.join(siteId).catch((err: unknown) => {
        setSwitching({ siteId, status: 'error', message: err instanceof Error ? err.message : String(err) });
        void net.connect(store.siteId ?? undefined);
      });
    },
    refreshNetwork: () => void pollNetwork(),
    rename(raw) {
      const v = validateClientDisplayName(raw);
      if (!v.ok) return v.error ?? 'Invalid name.';
      const parsed = parseRunDisplayName(v.name);
      const formatted = formatRunDisplayName(parsed.baseName, parsed.runNumber);
      const check = validateClientDisplayName(formatted);
      if (!check.ok) return check.error ?? 'Invalid name.';
      displayName = check.name;
      storageSet(DISPLAY_NAME_KEY, check.name);
      store.ui.runEnd = null;
      depletedRunVid = null;
      input.reset();
      // The name is part of the signed lobby ticket: re-join the current site to apply it.
      net.join(store.siteId ?? undefined).catch((err: unknown) => {
        toasts.push('error', 'Rename failed', err instanceof Error ? err.message : String(err));
        void net.connect(store.siteId ?? undefined);
      });
      return null;
    },
    async resumeCallsign(resumeToken) {
      const trimmed = resumeToken.trim();
      if (!trimmed) return 'Enter a callsign or client ID to resume.';
      if (trimmed.length < 2 || trimmed.length > 36) {
        return 'Callsign or client ID must be between 2 and 36 characters.';
      }
      store.ui.runEnd = null;
      depletedRunVid = null;
      input.reset();
      const join = await net.resumeIdentity(trimmed);
      if (!join.ok) {
        toasts.push('error', 'Could not resume callsign', join.message);
        return join.message;
      }
      displayName = join.name;
      storageSet(DISPLAY_NAME_KEY, join.name);
      if (join.clientId !== clientId) {
        clientId = join.clientId;
        storageSet(CLIENT_ID_KEY, join.clientId);
      }
      toasts.push('drive', `Resumed ${join.name}`, 'Your callsign and lifetime stats have been restored.');
      void pollNetwork();
      store.changed();
      return null;
    },
    retryNewRun() {
      const current = displayName || store.you?.name || 'Swift-Pallet';
      const nextName = nextRunDisplayName(current);
      const v = validateClientDisplayName(nextName);
      if (v.ok) {
        displayName = v.name;
        storageSet(DISPLAY_NAME_KEY, v.name);
      }
      store.ui.runEnd = null;
      depletedRunVid = null;
      input.reset();
      toasts.push('drive', `Starting ${displayName}…`, 'Spawning a fresh vehicle with 100% battery.');
      store.changed();
      net.join(store.siteId ?? undefined).catch((err: unknown) => {
        toasts.push('error', 'Could not start new run', err instanceof Error ? err.message : String(err));
        void net.connect(store.siteId ?? undefined);
      });
    },
    setRunMode(mode) {
      store.ui.runMode = mode;
      const me = store.myVehicle();
      if (me) me.runMode = mode;
      send({ type: 'setRunMode', mode }, true);
      store.changed();
    },
    acceptRelocation(toSite: SiteId) {
      store.ui.relocationOffer = null;
      send({ type: 'acceptRelocation', toSite, targetSite: toSite });
      store.changed();
    },
    dismissRelocation() {
      store.ui.relocationOffer = null;
      store.changed();
    },
    toast: (type, text, extra) => toasts.push(type, text, extra),
    refresh: () => updateUi(),
  };

  function safeStorage(): Storage | null {
    try {
      return localStorage;
    } catch {
      return null;
    }
  }

  // ---- HUD ----------------------------------------------------------------
  const ctx: UiCtx = { store, actions };
  const zoneLeft = byId('zoneLeft');
  const zoneRight = byId('zoneRight');
  const zoneBottom = byId('zoneBottom');
  const kpi = mountKpiBar(zoneLeft, ctx);
  const board = mountStrategyBoard(zoneLeft, ctx);
  const toolbar = mountToolbar(zoneRight, ctx);
  const presence = mountPresence(zoneRight, ctx);
  const fleet = mountFleet(zoneRight, ctx);
  const lb = mountLeaderboard(zoneRight, ctx);
  const value = mountValueChart(zoneRight, ctx);
  const network = mountNetwork(zoneRight, ctx);
  const cards = mountCards(byId('cardsTray'), zoneBottom, ctx);
  const driveBar = mountDriveBar(zoneBottom, ctx, {
    onBoostChange: (active) => input.setBoost(active, performance.now()),
  });
  const commandBar = mountCommandBar(zoneBottom, ctx);
  const a2ui = mountA2ui(byId('a2uiZone'), ctx);
  const inspector = mountInspector(byId('zoneInspector'), ctx);
  const drawer = mountDrawer(byId('drawer'), ctx);
  const lbModalEl = document.getElementById('leaderboardModal');
  const lbModal = lbModalEl ? mountLeaderboardModal(lbModalEl, ctx) : null;
  const agentDesignerEl = document.getElementById('agent-designer-modal');
  const agentDesigner = agentDesignerEl ? mountAgentDesigner(agentDesignerEl, ctx) : null;
  const help = mountHelp(byId('help'), ctx, {
    getCallsign: () => store.you?.name || displayName || 'Assigning…',
    onEnterFloor: (rawCallsign) => {
      const candidate = rawCallsign.trim();
      if (!candidate) return null;
      return actions.resumeCallsign(candidate);
    },
  });
  const runEnd = mountRunEnd(byId('runEnd'), ctx);
  const panels: PanelHandle[] = [kpi.panel, board.panel, fleet.panel, lb.panel, value.panel, network.panel];
  const modules: UiModule[] = [
    kpi,
    board,
    toolbar,
    presence,
    fleet,
    lb,
    value,
    network,
    cards,
    driveBar,
    commandBar,
    a2ui,
    inspector,
    drawer,
    ...(lbModal ? [lbModal] : []),
    ...(agentDesigner ? [agentDesigner] : []),
    help,
    runEnd,
  ];
  const hudHint = byId('hudHiddenHint');

  function updateUi(): void {
    document.body.classList.toggle('hud-hidden', store.hudHidden);
    document.body.classList.toggle('docks-hidden', store.ui.docksHidden);
    zoneLeft.classList.toggle('zone-docks-hidden', store.ui.docksHidden);
    zoneRight.classList.toggle('zone-docks-hidden', store.ui.docksHidden);
    hudHint.hidden = !store.hudHidden;
    canvas.classList.toggle('cone-mode', store.coneMode);
    for (const m of modules) {
      try {
        m.update();
      } catch (err) {
        console.error('HUD module update failed', err);
      }
    }
  }

  let uiQueued = false;
  store.subscribe(() => {
    if (uiQueued) return;
    uiQueued = true;
    requestAnimationFrame(() => {
      uiQueued = false;
      updateUi();
    });
  });
  setInterval(updateUi, UI_TICK_MS);

  // ---- server messages ----------------------------------------------------
  function onNetStatus(s: NetStatus): void {
    switch (s.kind) {
      case 'joining':
        store.setConn('connecting', 'Joining lobby…');
        break;
      case 'connecting':
        store.setConn('connecting', `Connecting to ${s.siteId.toUpperCase()}…`);
        break;
      case 'open':
        store.setConn('open');
        break;
      case 'retrying':
        input.reset();
        store.setConn('reconnecting', `Retrying in ${Math.ceil(s.inMs / 1000)}s · ${s.reason}`);
        break;
      default:
        store.setConn('idle');
    }
  }

  function checkRunEnd(): void {
    const me = store.myVehicle();
    if (!me || !store.isDriving()) return;
    if (!me.runFinished) {
      if (depletedRunVid === me.id) depletedRunVid = null;
      return;
    }
    // Never stack the run-over overlay on top of the intro; checkRunEnd runs on
    // every world update, so it surfaces as soon as the intro closes.
    if (store.ui.helpOpen) return;
    if (depletedRunVid === me.id && store.ui.runEnd) return;
    depletedRunVid = me.id;
    input.reset();
    const currentName = displayName || store.you?.name || me.driver || 'Swift-Pallet';
    const { runNumber } = parseRunDisplayName(currentName);
    const nextName = nextRunDisplayName(currentName);
    const rows = leaderboard(store.world);
    const rankIdx = rows.findIndex((v) => v.id === me.id);
    const rank = rankIdx >= 0 ? rankIdx + 1 : rows.length;
    const deliveries = Math.max(me.runDeliveries ?? 0, me.deliveries ?? 0, me.sShipped ?? 0);
    const onTime = me.runOnTime ?? me.onTime ?? deliveries;
    const onTimePct = deliveries > 0 ? Math.min(100, Math.round((onTime / deliveries) * 100)) : 100;
    const elapsedMin = Math.max(1, (me.runEndsAt ?? store.world.t) - (me.runStartedAt ?? 0));
    const realMinutes = elapsedMin / 60;
    const ppm = Math.round((deliveries / Math.max(0.25, realMinutes)) * 10) / 10;
    const finalScore = Math.round(me.runPts ?? me.sPts);
    store.ui.runEnd = {
      playerName: currentName,
      runNumber,
      nextRunName: nextName,
      vehicleId: me.id,
      score: finalScore,
      deliveries,
      incidents: me.runIncidents ?? me.incidents ?? 0,
      nearMisses: me.nearMisses ?? 0,
      rank,
      totalVehicles: Math.max(1, rows.length),
      shift: shiftIndex(store.world.t) + 1,
      day: dayIndex(store.world.t) + 1,
      bestStreak: Math.max(me.bestStreak ?? 0, me.streak ?? 0),
      onTimePct,
      ppm,
      runMode: me.runMode ?? store.ui.runMode,
      comboBest: me.comboBest,
      fareTrips: me.fareTrips,
      speedyTrips: me.speedyTrips,
      cardsDone: (store.myHand()?.cards ?? []).filter((c) => c.status === 'done').length,
    };
    toasts.push(
      'shift',
      `5-Minute Blitz Complete — ${finalScore} pts!`,
      `${deliveries} pallets (${ppm}/min) · Best streak ×${Math.max(me.bestStreak ?? 0, me.streak ?? 0)} · Click Run Again for ${nextName}.`,
    );
    store.changed();
  }

  function onMessage(msg: ServerMessage): void {
    const now = performance.now();
    switch (msg.type) {
      case 'welcome': {
        const err = store.applyWelcome(msg);
        if (err) {
          store.setConn('error', `Bad snapshot: ${err}`);
          toasts.push('error', 'Could not load the site snapshot.', err);
          return;
        }
        if (msg.you.name) {
          displayName = msg.you.name;
          storageSet(DISPLAY_NAME_KEY, msg.you.name);
        }
        const welcomedMe = store.myVehicle();
        if (welcomedMe && !welcomedMe.runFinished) {
          store.ui.runEnd = null;
          depletedRunVid = null;
          if (welcomedMe.runMode) store.ui.runMode = welcomedMe.runMode;
        }
        input.reset();
        // Layer subscriptions are per connection: re-send after every welcome.
        send({ type: 'layers', traffic: store.layers.traffic }, true);
        const sw = store.network.switching;
        if (sw?.status === 'pending') {
          setSwitching({
            siteId: sw.siteId,
            status: 'done',
            message:
              msg.you.siteId === sw.siteId
                ? `Now on ${msg.you.siteId.toUpperCase()}.`
                : `The lobby placed you on ${msg.you.siteId.toUpperCase()} (${sw.siteId.toUpperCase()} was unavailable).`,
          });
        }
        checkRunEnd();
        void pollNetwork();
        setTimeout(() => void pollNetwork(), 300);
        break;
      }
      case 'delta': {
        const me = store.myVehicle();
        const predicting = store.isDriving() && input.predicting(now, me);
        const events = store.applyDelta(msg, { acceptMyPose: !predicting });
        if (!predicting) input.settle();
        const tctx = { selectedVid: store.selectedVid, driving: store.isDriving() };
        for (const ev of events) if (shouldToast(ev, tctx)) toasts.push(ev.type, ev.text);
        const calloutVid = store.renderMyVid();
        const calloutKey = store.you?.clientId ?? null;
        for (const ev of events) {
          const c = calloutFor(ev, calloutVid, calloutKey);
          if (c) renderer.pushCallout(c, now);
        }
        checkRunEnd();
        break;
      }
      case 'ack': {
        const v = store.myVehicle();
        if (v && v.human) input.applyAck(store.world, v, msg);
        checkRunEnd();
        break;
      }
      case 'presence': {
        const before = store.you?.vid ?? null;
        store.applyPresence(msg.players);
        if ((store.you?.vid ?? null) !== before) input.reset();
        break;
      }
      case 'brainHealth':
        store.setBrainHealth(msg);
        break;
      case 'phase':
        store.setPhase({ phase: msg.phase, resumesAt: msg.resumesAt, reason: msg.reason });
        break;
      case 'error': {
        toasts.push('error', msg.message, msg.code);
        const sw = store.network.switching;
        if (sw?.status === 'pending' && /transfer|site/i.test(msg.code)) {
          setSwitching({ siteId: sw.siteId, status: 'error', message: msg.message });
        }
        break;
      }
      case 'commandEcho': {
        if (msg.directive || store.ui.agentCommandPending) {
          store.applyAgentEcho(msg);
        }
        const detail = msg.parsed && 'echo' in msg.parsed ? msg.parsed.echo : undefined;
        toasts.push(
          msg.executed ? 'echo' : 'warn',
          `“${msg.text}” → ${msg.executed ? 'executed' : 'not executed'}`,
          detail ? `${detail}${msg.reason ? ` (${msg.reason})` : ''}` : (msg.reason ?? undefined),
        );
        break;
      }
      case 'a2uiScreen':
        store.setA2ui(msg);
        break;
      case 'relocationOffer':
        store.ui.relocationOffer = msg;
        store.changed();
        break;
      case 'relocateShard': {
        const target = (msg.toSite ?? msg.siteId) as SiteId;
        store.ui.relocationOffer = null;
        input.reset();
        setSwitching({
          siteId: target,
          status: 'pending',
          message: `Relocating to ${target.toUpperCase()} (+${msg.bonusPts} pts bonus)…`,
        });
        toasts.push(
          'transfer',
          `Relocating to ${target.toUpperCase()} (+${msg.bonusPts} pts)`,
          'Carrying over your shift score, streak, and active cards.',
        );
        net.joinWithTicket(target, msg.ticket, msg.wsUrl);
        break;
      }
    }
  }

  // ---- render loop --------------------------------------------------------
  let lastFrame = performance.now();
  let seenMapVersion = -1;
  function frame(now: number): void {
    const elapsed = Math.min(250, now - lastFrame);
    lastFrame = now;
    if (store.mapVersion !== seenMapVersion) {
      seenMapVersion = store.mapVersion;
      renderer.onMapRebuilt();
    }
    const me = store.isDriving() ? store.myVehicle() : null;
    const predicting = Boolean(me && input.predicting(now, me));
    if (me && predicting) input.predict(store.world, me, elapsed);
    renderer.render(
      store.world,
      {
        layers: store.layers,
        highlightStrategy: store.highlightStrategy,
        selectedVid: store.selectedVid,
        myVid: store.renderMyVid(),
        coneMode: store.coneMode,
        overlays: store.overlays,
        guide: store.myGuide(),
        myPose: me && predicting ? input.visualPose(me) : null,
      },
      now,
    );
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // 10 Hz input scheduler (+ 2 s keepalive while focused so the 5 s server lease holds).
  setInterval(() => input.tick(performance.now(), document.hasFocus()), 100);

  // ---- keyboard / window --------------------------------------------------
  function runHotkey(a: HotkeyAction): void {
    switch (a) {
      case 'hideHud':
        store.hudHidden = !store.hudHidden;
        store.changed();
        break;
      case 'handBack':
        actions.handBack();
        break;
      case 'engageCopilot':
        actions.setAutopilot(true);
        break;
      case 'closeAgentDesigner':
        actions.showAgentDesigner(false);
        break;
      case 'closeHelp':
        actions.showHelp(false);
        break;
      case 'closeLeaderboardModal':
        actions.showLeaderboardModal(false);
        break;
      case 'closeDrawer':
        actions.setDrawer(false);
        break;
      case 'exitCone':
        actions.setConeMode(false);
        break;
      case 'deselect':
        actions.select(null);
        break;
      case 'takeWheel':
        actions.takeWheel();
        break;
      case 'agentDesigner':
        actions.showAgentDesigner(!store.ui.agentDesignerOpen);
        break;
      case 'drawer':
        actions.setDrawer(!store.ui.drawerOpen);
        break;
      case 'leaderboardModal':
        actions.showLeaderboardModal(!store.ui.leaderboardModalOpen);
        break;
      case 'board':
        board.panel.toggle(true);
        break;
      case 'layer:routes':
        actions.toggleLayer('routes');
        break;
      case 'layer:traffic':
        actions.toggleLayer('traffic');
        break;
      case 'layer:labels':
        actions.toggleLayer('labels');
        break;
      case 'cones':
        actions.setConeMode(!store.coneMode);
        break;
      case 'help':
        actions.showHelp(true);
        break;
    }
  }

  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && store.activeA2ui) {
      ev.preventDefault();
      actions.dismissA2ui();
      return;
    }
    const typing = isTypingTarget(ev.target);
    if (!typing && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      if (input.keyDown(ev, performance.now())) {
        ev.preventDefault();
        return;
      }
      if (ev.code === 'KeyE' && store.isDriving()) {
        ev.preventDefault();
        if (!ev.repeat) actions.interact();
        return;
      }
    }
    const action = resolveHotkey(ev, {
      typing,
      canHandBack: store.canHandBack(),
      helpOpen: store.ui.helpOpen,
      agentDesignerOpen: store.ui.agentDesignerOpen,
      leaderboardModalOpen: store.ui.leaderboardModalOpen,
      drawerOpen: store.ui.drawerOpen,
      coneMode: store.coneMode,
      selectedVid: store.selectedVid,
      driving: store.isDriving(),
      autopilot: store.isMyVehicleAutopilot(),
    });
    if (!action) return;
    ev.preventDefault();
    runHotkey(action);
  });
  window.addEventListener('keyup', (ev) => {
    if (input.keyUp(ev, performance.now())) ev.preventDefault();
  });
  window.addEventListener('blur', () => input.blur(performance.now()));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) input.blur(performance.now());
  });
  window.addEventListener('resize', () => {
    renderer.resize();
    for (const p of panels) p.onViewportResize();
  });

  // ---- start --------------------------------------------------------------
  void pollNetwork();
  setInterval(() => void pollNetwork(), NETWORK_POLL_MS);
  if (shouldShowHelpOnBoot(safeStorage())) store.ui.helpOpen = true;
  updateUi();

  const joinForm = byId<HTMLFormElement>('joinForm');
  const joinName = byId<HTMLInputElement>('joinName');
  const joinError = byId('joinError');
  joinOverlay.hidden = true;
  netConnected = true;
  void net.connect();

  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = joinName.value.trim();
    if (!raw) return;
    joinError.textContent = '';
    void actions.resumeCallsign(raw).then((err) => {
      if (err) {
        joinError.textContent = err;
        return;
      }
      joinOverlay.hidden = true;
    });
  });
}

if (typeof document !== 'undefined' && typeof window !== 'undefined' && document.getElementById('world')) {
  boot();
}
