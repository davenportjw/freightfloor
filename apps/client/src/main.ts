/**
 * Warehouse client entry: wires the store (state.ts), lobby/socket (net.ts), driving input
 * (input.ts), the canvas renderer (renderer.ts) and the HUD modules (src/ui/**).
 *
 * Everything shown comes from the live site. When a call fails the real error is surfaced
 * (toast / connection pill); nothing is simulated locally.
 */
import type { ClientMessage, ServerMessage, SiteId } from '@warehouse/protocol';
import { InputController } from './input.js';
import { fetchNetwork, NetClient, type NetStatus } from './net.js';
import { WarehouseRenderer, type RenderLayers } from './renderer.js';
import { ClientStore } from './state.js';
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
import { mountNetwork } from './ui/network.js';
import type { PanelHandle } from './ui/panel.js';
import { mountPresence } from './ui/presence.js';
import { mountStrategyBoard } from './ui/strategyBoard.js';
import { shouldToast, ToastStack } from './ui/toasts.js';
import { mountToolbar } from './ui/toolbar.js';
import { mountValueChart } from './ui/valueChart.js';

// Re-exported for the existing test suite (test/client.test.ts).
export { applyQuantisedDelta } from './state.js';
export { reconcilePredictedVehicle } from './input.js';

export const CLIENT_VERSION = 1;

const DISPLAY_NAME_REGEX = /^[A-Za-z0-9 _.-]{2,18}$/;
export const DISPLAY_NAME_KEY = 'warehouse_display_name';
export const CLIENT_ID_KEY = 'warehouse_client_id';
export const NETWORK_POLL_MS = 5_000;
const UI_TICK_MS = 250;

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
  const clientId = loadClientId();
  let displayName: string | null = (() => {
    const saved = storageGet(DISPLAY_NAME_KEY);
    return saved && validateClientDisplayName(saved).ok ? validateClientDisplayName(saved).name : null;
  })();

  const toasts = new ToastStack(byId('toasts'));
  const canvas = byId<HTMLCanvasElement>('world');

  // ---- network ------------------------------------------------------------
  const net = new NetClient(() => ({ name: displayName ?? '', clientId }), {
    onStatus: (s: NetStatus) => onNetStatus(s),
    onMessage: (m: ServerMessage) => onMessage(m),
  });

  const send = (msg: ClientMessage, quiet = false): boolean => {
    const ok = net.send(msg);
    if (!ok && !quiet) toasts.push('error', 'Not connected to the site.', store.conn.text || undefined);
    return ok;
  };

  const input = new InputController(
    (m) => {
      net.send(m);
    },
    () => store.isDriving(),
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
    showHelp(open) {
      store.ui.helpOpen = open;
      if (!open) markHelpSeen(safeStorage());
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
    nlCommand: (text) => {
      if (send({ type: 'nlCommand', text })) toasts.push('echo', `Sent: “${text}”`);
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
      displayName = v.name;
      storageSet(DISPLAY_NAME_KEY, v.name);
      input.reset();
      // The name is part of the signed lobby ticket: re-join the current site to apply it.
      net.join(store.siteId ?? undefined).catch((err: unknown) => {
        toasts.push('error', 'Rename failed', err instanceof Error ? err.message : String(err));
        void net.connect(store.siteId ?? undefined);
      });
      return null;
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
  const driveBar = mountDriveBar(zoneBottom, ctx);
  const commandBar = mountCommandBar(zoneBottom, ctx);
  const inspector = mountInspector(byId('zoneInspector'), ctx);
  const drawer = mountDrawer(byId('drawer'), ctx);
  const help = mountHelp(byId('help'), ctx);
  const panels: PanelHandle[] = [kpi.panel, board.panel, lb.panel, value.panel, network.panel];
  const modules: UiModule[] = [kpi, board, toolbar, presence, fleet, lb, value, network, cards, driveBar, commandBar, inspector, drawer, help];
  const hudHint = byId('hudHiddenHint');

  function updateUi(): void {
    document.body.classList.toggle('hud-hidden', store.hudHidden);
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
        void pollNetwork();
        break;
      }
      case 'delta': {
        const predicting = store.isDriving() && input.predicting(now);
        const events = store.applyDelta(msg, { acceptMyPose: !predicting });
        if (!predicting) input.settle();
        const tctx = { selectedVid: store.selectedVid, driving: store.isDriving() };
        for (const ev of events) if (shouldToast(ev, tctx)) toasts.push(ev.type, ev.text);
        break;
      }
      case 'ack': {
        const v = store.myVehicle();
        if (v && v.human) input.applyAck(store.world, v, msg);
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
      case 'commandEcho':
        toasts.push(
          'echo',
          `“${msg.text}” → ${msg.executed ? 'executed' : 'not executed'}`,
          msg.reason ?? undefined,
        );
        break;
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
    if (me && input.predicting(now)) input.predict(store.world, me, elapsed);
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
      case 'closeHelp':
        actions.showHelp(false);
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
      case 'drawer':
        actions.setDrawer(!store.ui.drawerOpen);
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
      drawerOpen: store.ui.drawerOpen,
      coneMode: store.coneMode,
      selectedVid: store.selectedVid,
      driving: store.isDriving(),
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

  const joinOverlay = byId('joinOverlay');
  const joinForm = byId<HTMLFormElement>('joinForm');
  const joinName = byId<HTMLInputElement>('joinName');
  const joinError = byId('joinError');
  if (displayName) {
    void net.connect();
  } else {
    store.setConn('idle', 'Choose a display name to join');
    joinOverlay.hidden = false;
    joinName.focus();
    joinForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = validateClientDisplayName(joinName.value);
      if (!v.ok) {
        joinError.textContent = v.error ?? 'Invalid name.';
        return;
      }
      displayName = v.name;
      storageSet(DISPLAY_NAME_KEY, v.name);
      joinOverlay.hidden = true;
      void net.connect();
    });
  }
}

if (typeof document !== 'undefined' && typeof window !== 'undefined' && document.getElementById('world')) {
  boot();
}
