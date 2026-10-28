/**
 * Warehouse client entry: wires the store (state.ts), lobby/socket (net.ts), driving input
 * (input.ts), the canvas renderer (renderer.ts) and the HUD modules (src/ui/**).
 *
 * Everything shown comes from the live site. When a call fails the real error is surfaced
 * (alert line / floor feed / connection pill); nothing is simulated locally.
 */
import type { ClientMessage, ServerMessage, SiteId } from '@warehouse/protocol';
import {
  blitzLeaderboard,
  dayIndex,
  flatPathFlag,
  leaderboard,
  parseDriverRunInfo,
  shiftIndex,
  type Vehicle,
} from '@warehouse/sim';
import { InputController } from './input.js';
import { fetchNetwork, isStaleJoin, NetClient, type NetStatus } from './net.js';
import { guardedFrame } from './frameLoop.js';
import { NetworkPoller } from './networkPoller.js';
import { blocksDriving } from './ui/modal.js';
import { WarehouseRenderer, type RenderGhost, type RenderLayers } from './renderer.js';
import type { CabRenderer } from './fpv/cabRenderer.js';
import { cabTouchDirs } from './fpv/cabMath.js';
import { calloutFor, rivalBubbleFor } from './render/fx.js';
import { GhostPlanner, ghostPolyline, ghostTarget } from './render/ghost.js';
import { cycleIndex } from './ui/fareChoice.js';
import {
  ClientStore,
  formatRunDisplayName,
  isLeaseEvictionReason,
  nextRunDisplayName,
  parseRunDisplayName,
  saveHudMinimal,
} from './state.js';
import { mountA2ui } from './ui/a2ui.js';
import { formatDirectiveSummary, mountAgentDesigner } from './ui/agentDesigner.js';
import { offerKey } from './ui/cards.js';
import { mountChat } from './ui/chat.js';
import { pickDriveTarget } from './ui/commandBar.js';
import type { Actions, UiCtx, UiModule } from './ui/context.js';
import { mountContractPick, pickKeep, pickToggle } from './ui/contractPick.js';
import { mountContracts } from './ui/contracts.js';
import { mountDash } from './ui/dash.js';
import { byId } from './ui/dom.js';
import { mountDrawer } from './ui/drawer.js';
import { mountFloorOrders } from './ui/floorOrders.js';
import { FEED_MAX, mountFloorView } from './ui/floorView.js';
import { markHelpSeen, mountHelp, shouldShowHelpOnBoot } from './ui/help.js';
import { isTypingTarget, resolveHotkey, type HotkeyAction } from './ui/hotkeys.js';
import { mountInspector } from './ui/inspector.js';
import { mountLeaderboardModal } from './ui/leaderboardModal.js';
import { mountFlyouts, mountMenu } from './ui/menu.js';
import { mountObjective } from './ui/objective.js';
import { mountRunCapsule } from './ui/runCapsule.js';
import { mountRunEnd } from './ui/runEnd.js';
import { autoKeepIds, isDriveFirstRun, readRunsDone, recordFinishedRun } from './ui/runOne.js';
import {
  buildAiRecap,
  createRunAiLog,
  directiveEchoFrom,
  pushCapped,
  resolveDecisionVid,
  shieldCardFor,
} from './ui/aiInsight.js';
import { mountShieldCard, SHIELD_CARD_MS } from './ui/shieldCard.js';
import { presenceView } from './ui/presence.js';
import { mountStandings } from './ui/standings.js';
import { mountTeamStandings } from './ui/teamStandings.js';
import { mountTouchControls } from './ui/touchControls.js';
import { RackLiftController } from './ui/rackLiftMinigame.js';
import {
  dcActionId,
  dcApplyReveal,
  dcCanPick,
  isDispatchersCallScreen,
  newDispatchersCallCard,
} from './ui/dispatchersCall.js';
import {
  errorKind,
  noticeAlert,
  noticeText,
  noticeTone,
  ORDER_NOTE_MS,
  pushFeedNote,
  routeNotice,
  routeSimEvent,
  serverErrorText,
  type NoticeKind,
} from './ui/notify.js';
import { isResumeCode, loadResumeCode, resumeInputError, saveResumeCode } from './resumeCode.js';
import { adoptRawClientId, isPublicId } from './identity.js';

// Re-exported for the existing test suite (test/client.test.ts).
export { applyQuantisedDelta, formatRunDisplayName, nextRunDisplayName, parseRunDisplayName } from './state.js';
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
  let clientId = loadClientId();
  let depletedRunVid: string | null = null;
  /** Finished vehicle we are replacing via retryNewRun; its results stay down until the new welcome. */
  let rejoinFinishedVid: string | null = null;
  let displayName: string | null = (() => {
    const saved = storageGet(DISPLAY_NAME_KEY);
    if (!saved || !validateClientDisplayName(saved).ok) return null;
    return saved;
  })();

  /** When we last sent a Floor order (manager op): an `error` right after it is that order's refusal. */
  let lastOrderAt: number | null = null;
  const canvas = byId<HTMLCanvasElement>('world');

  // ---- network ------------------------------------------------------------
  const net = new NetClient(
    () => ({
      name: displayName ?? undefined,
      clientId,
      runMode: store.ui.runMode,
      autoClaimSeat: store.autoClaimSeat,
    }),
    {
      onStatus: (s: NetStatus) => onNetStatus(s),
      onMessage: (m: ServerMessage) => onMessage(m),
      onQueueUpdate: (q) => store.setQueue(q),
      onSeatClaimed: (join) => {
        store.evictedReason = null;
        store.ui.runEnd = null;
        store.setQueue(null);
        notify('status', `Seat claimed on ${join.siteId.toUpperCase()}`, 'Taking the wheel of your assigned forklift.');
      },
      onJoined: (join) => {
        if (join.name) {
          displayName = join.name;
          storageSet(DISPLAY_NAME_KEY, join.name);
        }
        // Only the lobby's JoinResponse.clientId may replace the stored raw clientId (never a
        // site-sent id such as welcome.you.clientId, which is a publicId).
        const adopted = adoptRawClientId(clientId, join.clientId);
        if (adopted !== clientId) {
          clientId = adopted;
          storageSet(CLIENT_ID_KEY, adopted);
        }
        store.publicId = isPublicId(join.publicId) ? join.publicId : null;
        // Human joins carry the player's resume code: keep it and show it as the "resume code".
        if (isResumeCode(join.resumeToken) && join.resumeToken !== store.resumeCode) {
          saveResumeCode(safeStorage(), join.resumeToken);
          store.resumeCode = join.resumeToken;
        }
        store.changed();
      },
      onQueueError: (message) => {
        // e.g. 503 queue_unavailable: a real error (polling keeps retrying), shown once per outage.
        if (message === store.queueError) return;
        store.queueError = message;
        if (message) notify('error', 'Waiting line unavailable', message);
        store.changed();
      },
    },
  );

  const send = (msg: ClientMessage, quiet = false): boolean => {
    const ok = net.send(msg);
    if (!ok && !quiet) notify('error', 'Not connected to the site.', store.conn.text || undefined);
    return ok;
  };

  /** Deliver a client notice where ui/notify.ts routes it for the current HUD mode. */
  function notify(kind: NoticeKind, text: string, extra?: string): void {
    const now = Date.now();
    switch (routeNotice(kind, store.hudMode())) {
      case 'alert':
        store.ui.alert = noticeAlert(kind, noticeText(text, extra), now);
        break;
      case 'feed':
        store.ui.feedNotes = pushFeedNote(store.ui.feedNotes, { text: noticeText(text, extra), tone: noticeTone(kind), at: now }, FEED_MAX);
        break;
      case 'orderLine':
        store.ui.orderNote = { text, until: now + ORDER_NOTE_MS };
        break;
      case 'popup':
        renderer.pushCallout({ text, tone: kind === 'runSummary' ? 'good' : 'info' }, performance.now());
        cab?.pushCallout({ text, tone: kind === 'runSummary' ? 'good' : 'info' }, performance.now());
        break;
      default:
        // 'banner' is derived from state (floor banner); 'drop' shows nothing.
        return;
    }
    store.changed();
  }

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
    // Right-click removes one of *my* cones (a left-click on any cone also toggles it off).
    onRightClickTile: (x, y) => {
      const mine = store.floorOrdersNow()?.cones.mine ?? [];
      if (mine.includes(`${x},${y}`)) send({ type: 'manager', op: 'cone', x, y });
    },
    onFollowLost: () => {
      if (store.ui.followVid === null) return;
      store.ui.followVid = null;
      store.changed();
    },
  });

  // ---- actions ------------------------------------------------------------
  const setSwitching = (s: ClientStore['network']['switching']): void => {
    store.network = { ...store.network, switching: s };
    store.changed();
  };

  // `/api/network`: one poller (hidden-tab pause, no overlapping requests, out-of-order drop).
  const poller = new NetworkPoller({
    fetchNetwork,
    onStart: () => {
      if (store.network.status === 'idle') store.network = { ...store.network, status: 'loading' };
    },
    apply: (res) => {
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
    },
    isHidden: () => document.hidden,
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (h) => window.clearInterval(h as number),
    intervalMs: NETWORK_POLL_MS,
  });
  const pollNetwork = (): Promise<void> => poller.poll();

  const rackLift = new RackLiftController();

  // ---- Cab View (first-person) ----------------------------------------------
  // three.js + the cab renderer are a separate chunk, fetched the first time the player drives in
  // the cab. A missing WebGL context is a real error: we switch back to iso and say so.
  let cab: CabRenderer | null = null;
  let cabLoading = false;
  let cabFailed = false;
  function ensureCab(): void {
    if (cab || cabLoading || cabFailed) return;
    cabLoading = true;
    import('./fpv/cabRenderer.js')
      .then((m) => {
        cab = new m.CabRenderer({ container: canvas.parentElement ?? document.body });
      })
      .catch((err: unknown) => {
        cabFailed = true;
        console.error('Cab View failed to start', err);
        store.setCabView(false);
        notify('error', 'Cab View unavailable on this device', err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        cabLoading = false;
      });
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
      rackLift.cancel(store.myVehicle());
      input.reset();
      send({ type: 'release' });
    },
    quickDrive() {
      if (store.isDriving()) return;
      const id = pickDriveTarget(store.world.vehicles, store.selectedVid, store.world.t);
      if (!id) {
        notify('hint', 'No AI vehicle is free to drive right now.');
        return;
      }
      actions.takeWheel(id);
    },
    interact(forkHeight?: number) {
      if (!store.isDriving()) return;
      send(forkHeight !== undefined ? { type: 'interact', forkHeight } : { type: 'interact' }, true);
    },
    interactDown() {
      if (!store.isDriving()) return;
      const me = store.myVehicle();
      if (!me || !store.isRackLiftActive()) {
        actions.interact();
        return;
      }
      const res = rackLift.onKeyDown(performance.now(), store.world, me, true);
      if (res.action === 'immediate') {
        actions.interact();
      } else if (res.action === 'commit') {
        actions.interact(res.forkHeight);
      }
    },
    interactUp() {
      if (!store.isDriving()) return;
      const me = store.myVehicle();
      if (!me || !store.isRackLiftActive()) return;
      // Pass the world so a hold-release commit detects an armed precision stop (Slide & Snatch).
      const res = rackLift.onKeyUp(performance.now(), me, store.world);
      if (res.action === 'commit') {
        actions.interact(res.forkHeight);
      }
    },
    chooseOrder(orderId) {
      // Failures (governance_limit / choose_order_failed) come back as `error` → the alert line.
      if (store.myFareOffer()) send({ type: 'chooseOrder', orderId });
    },
    cycleFare() {
      const off = store.myFareOffer();
      if (!off) return;
      store.ui.fareSel = cycleIndex(store.ui.fareSel, off.options.length);
      store.changed();
    },
    setConeMode(on) {
      store.coneMode = on;
      if (on) store.ui.dispatchOpen = false;
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
      const wasOpen = store.ui.helpOpen;
      store.ui.helpOpen = open;
      if (!open) {
        store.ui.pendingDrive = false;
        markHelpSeen(safeStorage());
        if (wasOpen) {
          introDismissedAutoKeep = true;
          maybeAutoKeep(true);
        }
        checkRunEnd();
      }
      store.changed();
    },
    setBoost(on) {
      input.setBoost(on, performance.now());
    },
    setTouchDirs(dirs) {
      // Cab View: the camera turns with the truck, so the stick is throttle + steer (tank style).
      input.setTouchDirs(store.isCabViewActive() ? cabTouchDirs(dirs) : dirs, performance.now());
    },
    releaseTouch() {
      input.releaseTouch(performance.now());
    },
    setOverlay(overlay) {
      store.ui.overlay = overlay;
      if (overlay) {
        store.ui.flyout = null;
        store.ui.dispatchOpen = false;
      }
      store.changed();
    },
    setFlyout(id) {
      const next = id !== null && store.ui.flyout === id ? null : id;
      store.ui.flyout = next;
      if (next) {
        if (store.ui.overlay === 'menu') store.ui.overlay = null;
        store.ui.dispatchOpen = false;
        if (next === 'network' || next === 'drivers') void pollNetwork();
      }
      store.changed();
    },
    setDispatchOpen(open) {
      store.ui.dispatchOpen = open;
      if (open) {
        store.coneMode = false;
        store.ui.flyout = null;
        if (store.ui.overlay === 'menu') store.ui.overlay = null;
      }
      store.changed();
    },
    sendDispatch() {
      const d = store.ui.dispatchDraft;
      actions.dispatchRoute({
        sourceZone: d.sourceZone,
        targetBay: d.targetBay,
        count: d.count,
        priority: d.p0 ? 'p0' : undefined,
      });
      store.ui.dispatchOpen = false;
      store.changed();
    },
    setChatTarget(target) {
      store.ui.chatTarget = target;
      store.changed();
    },
    toggleMinimal() {
      store.ui.hudMinimal = !store.ui.hudMinimal;
      saveHudMinimal(store.ui.hudMinimal);
      store.changed();
    },
    toggleDriveCamera() {
      store.toggleDriveCameraMode();
    },
    toggleCabView() {
      const on = store.toggleCabView();
      if (on && store.hudMode() !== 'driving') {
        notify('hint', 'Cab View starts when you drive.');
      }
    },
    setDriveCameraMode(mode) {
      store.setDriveCameraMode(mode);
    },
    follow(vid) {
      store.ui.followVid = vid;
      renderer.follow(vid);
      store.changed();
    },
    panTo(x, y) {
      renderer.panTo(x, y);
    },
    startDriving() {
      introDismissedAutoKeep = true;
      // Pressed before the welcome: keep the intro up ("Connecting…") and drive when it lands.
      if (!store.welcomed || !store.you) {
        store.ui.pendingDrive = true;
        store.changed();
        return;
      }
      actions.showHelp(false);
      // Drop the player straight into a forklift so WASD works immediately. If evicted while
      // reading the intro, driveFromFloor re-requests a fresh driver seat.
      if (store.evictedReason !== null) actions.driveFromFloor();
      else actions.quickDrive();
      maybeAutoKeep(true);
    },
    driveFromFloor() {
      const pres = presenceView(store);
      if (
        store.myVehicle()?.runFinished ||
        store.evictedReason !== null ||
        store.you?.role === 'spectator' ||
        pres.full
      ) {
        actions.retryNewRun(store.ui.runMode);
      } else {
        actions.quickDrive();
      }
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
      if (send({ type: 'manager', op })) lastOrderAt = Date.now();
    },
    dispatchRoute: (dispatch) => {
      if (send({ type: 'manager', op: 'dispatch', dispatch })) lastOrderAt = Date.now();
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
    pickDispatchersCall: (idx) => {
      const card = store.dispatchersCall;
      if (!card || !dcCanPick(card, Date.now())) return;
      if (send({ type: 'a2uiAction', screenId: card.minigame.id, actionId: dcActionId(idx) })) {
        store.dispatchersCall = { ...card, picked: idx };
        store.changed();
      }
    },
    setDispatchersCallPref: (on) => {
      store.setDispatchersCallPref(on);
      send({ type: 'dispatchersCallPref', enabled: on }, true);
    },
    dismissA2ui: () => {
      const screenId = store.activeA2ui?.screenId ?? 'a2ui';
      store.setA2ui(null);
      send({ type: 'a2uiAction', screenId, actionId: 'dismiss' }, true);
    },
    nlCommand: (text) => {
      if (send({ type: 'nlCommand', text })) notify('status', `Sent: “${text}”`);
    },
    showAgentDesigner(open) {
      store.ui.agentDesignerOpen = open;
      store.changed();
    },
    agentCommand(opts) {
      const targetVid = opts.vid ?? store.myVehicle()?.id ?? store.selectedVid ?? undefined;
      if (send({ type: 'agentCommand', vid: targetVid, directive: opts.directive, text: opts.text })) {
        store.markAgentCommandPending(Date.now());
        const v = targetVid ? store.vehicle(targetVid) : store.myVehicle();
        if (v && opts.directive) {
          if (typeof opts.directive.autopilot === 'boolean') {
            v.autopilot = opts.directive.autopilot;
            if (opts.directive.autopilot) input.reset();
          }
          if (opts.directive.strategy) v.strategy = opts.directive.strategy;
          if (opts.directive.tactics) {
            const patch = opts.directive.tactics;
            v.tactics = {
              ...v.tactics,
              ...patch,
              flatPath: patch.flatPath === undefined ? v.tactics.flatPath : flatPathFlag(patch.flatPath),
            };
          }
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
        if (isStaleJoin(err)) return; // superseded by a newer join; that one owns the outcome
        setSwitching({ siteId, status: 'error', message: err instanceof Error ? err.message : String(err) });
        void net.connect(store.siteId ?? undefined);
      });
    },
    refreshNetwork: () => void pollNetwork(),
    async resumeCallsign(raw) {
      const trimmed = raw.trim();
      const inputErr = resumeInputError(trimmed);
      if (inputErr) return inputErr;
      store.ui.runEnd = null;
      depletedRunVid = null;
      input.reset();
      const join = await net.resumeIdentity(trimmed);
      if (!join.ok) {
        notify('error', 'Could not resume', join.message);
        return join.message;
      }
      if (join.resumeToken) {
        saveResumeCode(safeStorage(), join.resumeToken);
        store.resumeCode = join.resumeToken;
      }
      displayName = join.name;
      storageSet(DISPLAY_NAME_KEY, join.name);
      const adopted = adoptRawClientId(clientId, join.clientId);
      if (adopted !== clientId) {
        clientId = adopted;
        storageSet(CLIENT_ID_KEY, adopted);
      }
      notify('status', `Resumed ${join.name}`, 'Your identity and lifetime stats have been restored.');
      void pollNetwork();
      store.changed();
      return null;
    },
    retryNewRun(mode) {
      const current = displayName || store.you?.name || 'Swift-Pallet';
      const nextName = nextRunDisplayName(current);
      const v = validateClientDisplayName(nextName);
      if (v.ok) {
        displayName = v.name;
        storageSet(DISPLAY_NAME_KEY, v.name);
      }
      // The lobby join carries runMode (NetClient reads store.ui.runMode), so set it before re-joining.
      if (mode) store.ui.runMode = mode;
      store.ui.runEnd = null;
      store.evictedReason = null;
      // Leave runEndDismissedVid alone (Floor view stays Floor until the fresh run's welcome) and
      // block the finished car's results from re-popping while the rejoin is in flight.
      rejoinFinishedVid = store.myVehicle()?.runFinished ? (store.myVehicle()?.id ?? null) : null;
      depletedRunVid = null;
      input.reset();
      // Drop any in-progress rack-lift and the last run's stale alert / order line.
      rackLift.cancel(store.myVehicle());
      store.ui.alert = null;
      store.ui.orderNote = null;
      const fullShard = presenceView(store).full;
      notify(
        'status',
        fullShard ? `Joining waiting line as ${displayName}…` : `Starting ${displayName}…`,
        fullShard
          ? 'All 32 driver slots are full; requesting a FIFO waiting-line seat.'
          : `Spawning a fresh vehicle with 100% battery${store.ui.runMode === 'freerange' ? ' in Free Range (no timer)' : ' for a 3-minute Blitz'}.`,
      );
      store.changed();
      // A fresh socket + requeue: true so evicted / spectator players or full shards enter the FIFO line or get a fresh slot.
      net
        .join(store.siteId ?? undefined, undefined, store.ui.runMode, true, { requeue: true })
        .catch((err: unknown) => {
          if (isStaleJoin(err)) return;
          rejoinFinishedVid = null;
          notify('error', 'Could not start new run', err instanceof Error ? err.message : String(err));
          void net.connect(store.siteId ?? undefined);
        });
    },
    claimQueueSeat() {
      void net.claimQueueSeat().then((ok) => {
        if (ok) {
          store.evictedReason = null;
          store.ui.runEnd = null;
          store.changed();
        }
      });
    },
    leaveQueue() {
      void net.leaveQueue();
    },
    toggleAutoClaimSeat() {
      store.autoClaimSeat = !store.autoClaimSeat;
      net.autoClaimSeat = store.autoClaimSeat;
      if (store.autoClaimSeat && store.queue?.state === 'ready') {
        void net.claimQueueSeat();
      }
      store.changed();
    },
    dismissRunEnd() {
      if (store.ui.runEnd) store.ui.runEndDismissedVid = store.ui.runEnd.vehicleId;
      store.ui.runEnd = null;
      store.changed();
    },
    showRunEnd() {
      store.ui.runEndDismissedVid = null;
      depletedRunVid = null;
      checkRunEnd();
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
    notify: (kind, text, extra) => notify(kind, text, extra),
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
  // HUD v3: floating cards over a full-bleed canvas. DRIVE mode (holding a wheel) shows the
  // run capsule, objective, contracts and dash; FLOOR mode shows KPIs, the event feed,
  // Floor orders and the inspector. Sheets (contract pick, standings, results) sit over a scrim.
  const ctx: UiCtx = { store, actions };
  const scrim = byId('scrim');
  scrim.addEventListener('click', () => {
    const ov = store.activeOverlay();
    if (ov === 'standings' || ov === 'menu' || ov === 'chat') actions.setOverlay(null);
  });
  const flyouts = mountFlyouts(byId('flyout'), ctx);
  // 🛡 Model Armor shield card (created here so index.html stays untouched).
  const shieldEl = document.createElement('div');
  shieldEl.id = 'shieldCard';
  shieldEl.hidden = true;
  document.body.appendChild(shieldEl);
  const modules: UiModule[] = [
    mountRunCapsule(byId('run'), ctx),
    mountObjective(byId('objective'), byId('fare'), byId('alert'), byId('reloc'), ctx, (vid) =>
      formatDirectiveSummary(store.vehicle(vid)),
    ),
    mountContracts(byId('contracts'), ctx),
    mountDash(byId('dash'), ctx),
    mountChat(byId('chat'), ctx),
    mountFloorView(byId('kpis'), byId('floorBanner'), byId('feed'), ctx),
    mountFloorOrders(byId('orders'), byId('dispatchPop'), byId('coneHint'), byId('orderNote'), ctx),
    mountInspector(byId('inspector'), ctx),
    mountMenu(byId('menuBtn'), byId('menu'), ctx),
    mountTeamStandings(byId('standFly'), ctx),
    flyouts,
    mountContractPick(byId('pickSheet'), ctx),
    mountStandings(byId('standingsSheet'), ctx),
    mountRunEnd(byId('runEnd'), ctx),
    mountA2ui(byId('a2uiZone'), ctx),
    mountDrawer(byId('drawer'), ctx),
  ];
  const lbModalEl = document.getElementById('leaderboardModal');
  if (lbModalEl) modules.push(mountLeaderboardModal(lbModalEl, ctx));
  const agentDesignerEl = document.getElementById('agent-designer-modal');
  if (agentDesignerEl) modules.push(mountAgentDesigner(agentDesignerEl, ctx));
  const touchControlsEl = document.getElementById('touchControls');
  if (touchControlsEl) {
    modules.push(mountTouchControls(touchControlsEl, ctx, () => Boolean(input.held.boost)));
  }
  modules.push(mountShieldCard(shieldEl, ctx));
  const help = mountHelp(byId('help'), ctx, {
      getCallsign: () => store.you?.name || displayName || 'Assigning…',
  });
  modules.push(help);

  function updateUi(): void {
    const mode = store.hudMode();
    const ov = store.activeOverlay();
    // Leaving floor mode drops floor-only state (cone placing, dispatch drawer, follow).
    if (mode === 'driving' && (store.coneMode || store.ui.dispatchOpen)) {
      store.coneMode = false;
      store.ui.dispatchOpen = false;
    }
    document.body.dataset.mode = mode;
    document.body.classList.toggle('hud-minimal', store.ui.hudMinimal);
    scrim.hidden = !(ov === 'pick' || ov === 'standings' || ov === 'results');
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
  setInterval(() => {
    // A Co-Pilot command that never got an echo/error must not leave the UI stuck "pending".
    if (store.expireAgentCommandPending(Date.now())) {
      notify('error', 'Co-Pilot did not answer (timed out)');
    }
    updateUi();
  }, UI_TICK_MS);

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
        store.clearAgentCommandPending(); // the socket died: no echo is coming
        store.setConn('reconnecting', `Retrying in ${Math.ceil(s.inMs / 1000)}s · ${s.reason}`);
        break;
      default:
        store.setConn('idle');
    }
  }

  // ---- Run 1 drive-first onboarding + per-run AI log ---------------------------
  function currentRunNumber(): number {
    return parseRunDisplayName(store.you?.name || displayName || '').runNumber;
  }
  function refreshDriveFirst(): void {
    store.driveFirst = isDriveFirstRun({ runNumber: currentRunNumber(), runsDone: readRunsDone(safeStorage()) });
  }
  /** Run 1 (or immediately after dismissing the Intro modal): auto-keep one card instead of opening a second intro sheet. */
  let autoKeptKey: string | null = null;
  let introDismissedAutoKeep = false;
  function maybeAutoKeep(force = false): void {
    if ((!store.driveFirst && !force && !introDismissedAutoKeep) || store.hudMode() !== 'driving') return;
    const hand = store.myHand();
    const offer = hand?.offer;
    if (!hand || !offer?.length || hand.pick != null) return;
    const key = offerKey(offer);
    if (autoKeptKey === key) return;
    const ids = autoKeepIds(offer);
    if (!ids.length) return;
    autoKeptKey = key;
    introDismissedAutoKeep = false;
    store.ui.dealMinimizedKey = key;
    actions.keepCards(ids);
  }
  /** The per-run AI log (recap source); a new vehicle or run number starts a fresh one. */
  function runAiLog(): ReturnType<typeof createRunAiLog> | null {
    const me = store.isDriving() ? store.myVehicle() : null;
    if (!me) return store.runAiLog;
    const key = `${me.id}:${currentRunNumber()}`;
    if (store.runAiLog?.runKey !== key) {
      store.runAiLog = createRunAiLog(key);
      store.ui.coachFare = null;
    }
    return store.runAiLog;
  }
  /** Track order ids offered to / carried by me this run (recap weights decisions touching them). */
  function noteMyOrders(): void {
    const log = runAiLog();
    const me = store.isDriving() ? store.myVehicle() : null;
    if (!log || !me || me.runFinished) return;
    for (const o of me.cargo ?? []) log.myOrderIds.add(String(o.id));
    for (const opt of store.myFareOffer()?.options ?? []) log.myOrderIds.add(String(opt.orderId));
  }
  /** Finished-run memory (localStorage) once per run: previous run's points for the headline. */
  const finishedRunPrev = new Map<string, number | null>();
  function lastRunPtsFor(key: string, pts: number): number | null {
    if (!finishedRunPrev.has(key)) {
      finishedRunPrev.set(key, recordFinishedRun(safeStorage(), pts));
      refreshDriveFirst();
    }
    return finishedRunPrev.get(key) ?? null;
  }

  function checkRunEnd(): void {
    const me = store.myVehicle();
    if (!me || !store.isDriving()) return;
    if (
      !me.runFinished &&
      me.runMode === 'blitz' &&
      me.runEndsAt != null &&
      store.world.t >= me.runEndsAt
    ) {
      me.runFinished = true;
      me.speedNow = 0;
    }
    if (!me.runFinished) {
      if (depletedRunVid === me.id) depletedRunVid = null;
      return;
    }
    if (store.ui.helpOpen) {
      if (me.runMode === 'blitz') {
        store.ui.helpOpen = false;
      } else {
        return;
      }
    }
    // Replacing this finished run (Play again / Drive [F]): don't re-show its results meanwhile.
    if (rejoinFinishedVid === me.id) return;
    // Dismissed by the player: the drive bar's "Run over" strip stays up instead.
    if (store.ui.runEndDismissedVid === me.id) return;
    if (depletedRunVid === me.id && store.ui.runEnd) return;
    depletedRunVid = me.id;
    input.reset();
    const currentName = displayName || store.you?.name || me.driver || 'Swift-Pallet';
    const { baseName, runNumber } = parseRunDisplayName(currentName);
    const nextName = nextRunDisplayName(currentName);
    const rows = blitzLeaderboard(store.world);
    const rankIdx = rows.findIndex((v) => v.id === me.id);
    const rank = rankIdx >= 0 ? rankIdx + 1 : rows.length;
    const deliveries = Math.max(me.runDeliveries ?? 0, me.deliveries ?? 0, me.sShipped ?? 0);
    const onTime = me.runOnTime ?? deliveries;
    const onTimePct = deliveries > 0 ? Math.min(100, Math.round((onTime / deliveries) * 100)) : 100;
    const elapsedMin = Math.max(1, (me.runEndsAt ?? store.world.t) - (me.runStartedAt ?? 0));
    const realMinutes = elapsedMin / 60;
    const ppm = Math.round((deliveries / Math.max(0.25, realMinutes)) * 10) / 10;
    const finalScore = Math.round(me.runPts ?? me.sPts);
    const lastRunPts = lastRunPtsFor(`${me.id}:${me.runStartedAt ?? ''}`, finalScore);
    const recap = buildAiRecap(runAiLog(), (vid) => store.vehicle(vid)?.strategy);

    const activeVehicleIds = new Set(store.world.vehicles.map((v) => v.id));
    const leaderboardRows = rows.map((v, i) => {
      const driverLabel = v.driver || `${v.id} (${v.strat})`;
      const parsed = parseDriverRunInfo(driverLabel);
      const isHuman = Boolean(v.human);
      const isArchived = !activeVehicleIds.has(v.id);
      const vScore = Math.round(v.blitzPts ?? v.pts ?? 0);
      return {
        rank: i + 1,
        id: v.id,
        driver: driverLabel,
        baseName: v.baseName || parsed.baseName,
        runNumber: v.runNumber || parsed.runNumber,
        score: vScore,
        deliveries: v.shipped ?? 0,
        ppm: v.ppm ?? 0,
        onTimePct: v.onTimePct ?? 100,
        bestStreak: v.bestStreak ?? v.streak ?? 0,
        incidents: v.incidents ?? 0,
        isYou: v.id === me.id,
        isYourPastRun:
          v.id !== me.id &&
          isHuman &&
          (v.baseName || parsed.baseName).toLowerCase() === baseName.toLowerCase(),
        isHuman,
        isArchived,
        runMode: v.runMode,
      };
    });

    const humanRows = leaderboardRows.filter((r) => r.isHuman);
    const humanIdx = humanRows.findIndex((r) => r.isYou);
    const humanRank = humanIdx >= 0 ? humanIdx + 1 : Math.max(1, humanRows.length);

    const yourPastRuns = leaderboardRows
      .filter((r) => r.isYourPastRun)
      .sort((a, b) => b.runNumber - a.runNumber);
    const previousRun = yourPastRuns[0];
    const allYourRuns = leaderboardRows.filter((r) => r.isYou || r.isYourPastRun);
    const bestRunPts = allYourRuns.reduce((max, r) => Math.max(max, r.score), finalScore);

    const rivalAbove = rankIdx > 0 ? leaderboardRows[rankIdx - 1] : undefined;
    const rivalNext = rivalAbove
      ? {
          driver: rivalAbove.driver,
          ptsAhead: Math.max(1, rivalAbove.score - finalScore),
          rank: rivalAbove.rank,
          isAi: !rivalAbove.isHuman,
        }
      : undefined;

    const topAi = leaderboardRows.find((r) => !r.isHuman);
    const aiBenchmark = topAi
      ? {
          topAiDriver: topAi.driver,
          topAiPts: topAi.score,
          topAiPpm: topAi.ppm,
          topAiOnTimePct: topAi.onTimePct,
        }
      : undefined;

    // Results take the top layer: close any modal that would otherwise suspend the sheet.
    store.ui.agentDesignerOpen = false;
    store.ui.leaderboardModalOpen = false;
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
      humanRank,
      totalHumanRuns: Math.max(1, humanRows.length),
      shift: shiftIndex(store.world.t) + 1,
      day: dayIndex(store.world.t) + 1,
      bestStreak: Math.max(me.bestStreak ?? 0, me.streak ?? 0),
      onTimePct,
      ppm,
      runMode: me.runMode ?? store.ui.runMode,
      // The sim ends runs only on the Blitz clock (a flat battery just limps the forklift).
      reason: 'timer',
      comboBest: me.comboBest,
      fareTrips: me.fareTrips,
      speedyTrips: me.speedyTrips,
      cardsDone: (store.myHand()?.cards ?? []).filter((c) => c.status === 'done').length,
      previousRunPts: previousRun?.score,
      previousRunNumber: previousRun?.runNumber,
      bestRunPts,
      rivalNext,
      aiBenchmark,
      leaderboardRows,
      lastRunPts,
      recap,
    };
    // Drive: a world popup over the forklift (the results sheet has the details); Floor: the banner.
    notify('runSummary', `RUN OVER · ${finalScore} PTS`);
    store.changed();
  }

  /** Remember our leaderboard rank when a run starts (new vehicle or new `runStartedAt`). */
  let runStartKey = '';
  function noteRunStart(): void {
    const me = store.myVehicle();
    if (!me || me.runFinished || !store.isDriving()) return;
    const key = `${me.id}:${me.runStartedAt ?? ''}`;
    if (key === runStartKey) return;
    runStartKey = key;
    const idx = blitzLeaderboard(store.world).findIndex((r) => r.id === me.id);
    store.ui.runStartRank = idx >= 0 ? { vid: me.id, rank: idx + 1 } : null;
  }

  function onMessage(msg: ServerMessage): void {
    const now = performance.now();
    switch (msg.type) {
      case 'welcome': {
        // A welcome for a different site (switch / relocation) or vehicle (new run) starts a new
        // session: drop the old session's view state *before* applying the new snapshot.
        const prevSite = store.siteId;
        const prevVid = store.you?.vid ?? store.myVid;
        const siteChanged = prevSite !== null && prevSite !== msg.you.siteId;
        const vidChanged = prevVid != null && prevVid !== (msg.you.vid ?? null);
        if (siteChanged || vidChanged) {
          store.resetForNewSession(siteChanged);
          renderer.follow(null);
        }
        store.clearAgentCommandPending(); // a fresh connection: no echo for the old command
        const err = store.applyWelcome(msg);
        if (err) {
          store.setConn('error', `Bad snapshot: ${err}`);
          notify('error', 'Could not load the site snapshot.', err);
          return;
        }
        if (msg.you.name) {
          displayName = msg.you.name;
          storageSet(DISPLAY_NAME_KEY, msg.you.name);
        }
        const welcomedMe = store.myVehicle();
        rejoinFinishedVid = null;
        if (welcomedMe && !welcomedMe.runFinished) {
          store.ui.runEnd = null;
          store.ui.runEndDismissedVid = null;
          depletedRunVid = null;
          if (welcomedMe.runMode) store.ui.runMode = welcomedMe.runMode;
        }
        input.reset();
        // Layer subscriptions are per connection: re-send after every welcome.
        send({ type: 'layers', traffic: store.layers.traffic }, true);
        // Dispatcher's Call opt-out is per connection too (server default: opted in).
        store.dispatchersCall = null;
        if (msg.limits?.dispatchersCall && !store.ui.dispatchersCall) {
          send({ type: 'dispatchersCallPref', enabled: false }, true);
        }
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
        refreshDriveFirst();
        if (store.driveFirst && store.ui.runMode !== 'blitz') actions.setRunMode('blitz');
        noteRunStart();
        maybeAutoKeep();
        checkRunEnd();
        if (store.ui.pendingDrive && store.ui.helpOpen) actions.startDriving?.();
        void pollNetwork();
        break;
      }
      case 'delta': {
        const me = store.myVehicle();
        const predicting = store.isDriving() && input.predicting(now, me);
        const events = store.applyDelta(msg, { acceptMyPose: !predicting });
        if (!predicting) input.settle(store.world.t, now);
        // Routing (ui/notify.ts): my scoring/run events → world popup; my interact hints → the
        // alert line (Drive); floor-wide hints answering a Floor order → the order line (Floor).
        // The FLOOR feed reads store.events itself; everything else is dropped.
        const hudMode = store.hudMode();
        const calloutVid = store.renderMyVid();
        const calloutKey = store.you?.clientId ?? null;
        for (const ev of events) {
          if (ev.type === 'fare' && calloutVid && ev.vid === calloutVid && typeof ev.pts === 'number') {
            store.ui.coachFare = { pts: ev.pts, at: Date.now() };
          }
          const c = calloutFor(ev, calloutVid, calloutKey);
          if (c) {
            renderer.pushCallout(c, now);
            cab?.pushCallout(c, now);
          }
          const b = rivalBubbleFor(ev, calloutVid);
          if (b) {
            renderer.pushBubble(b, now);
            cab?.pushBubble(b, now);
          }
          const route = routeSimEvent(ev, hudMode, calloutVid, calloutKey);
          if (route === 'alert') store.ui.alert = noticeAlert('hint', ev.text, Date.now());
          else if (route === 'orderLine') store.ui.orderNote = { text: ev.text, until: Date.now() + ORDER_NOTE_MS };
        }
        noteRunStart();
        noteMyOrders();
        maybeAutoKeep();
        checkRunEnd();
        break;
      }
      case 'brainDecision': {
        const vid = resolveDecisionVid(msg, store.world.vehicles);
        if (!vid) break;
        const d = {
          vid,
          reqId: msg.reqId,
          kind: msg.kind,
          note: msg.note,
          latencyMs: msg.latencyMs,
          model: msg.model,
          decision: msg.decision,
          at: Date.now(),
        };
        store.brainDecisions.set(vid, d);
        const me = store.isDriving() ? store.myVehicle() : null;
        const log = runAiLog();
        if (me && log && !me.runFinished) {
          const ids = Array.isArray(msg.decision.orderIds) ? (msg.decision.orderIds as unknown[]) : [];
          const touchesMine = ids.some((id) => log.myOrderIds.has(String(id)));
          if (vid === me.rivalId || touchesMine) pushCapped(log.rivalDecisions, d);
        }
        if (store.isDriving() && vid === store.myVehicle()?.rivalId) store.changed();
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
        if (msg.code === 'REQUEUE_REQUIRED') {
          if (store.you) {
            store.you = { ...store.you, role: 'spectator', vid: null };
          }
          store.myVid = null;
          store.dedicatedVid = null;
          notify('hint', msg.message || 'Your driver slot expired. Re-join the waiting line to drive.');
          store.changed();
          break;
        }
        notify(errorKind(store.hudMode(), Date.now(), lastOrderAt), serverErrorText(msg.code, msg.message));
        // Any server refusal (incl. internal_error / spectator_forbidden / vehicle_changed) answers
        // an in-flight Co-Pilot command: it will not echo.
        store.clearAgentCommandPending();
        const sw = store.network.switching;
        if (sw?.status === 'pending' && /transfer|site/i.test(msg.code)) {
          setSwitching({ siteId: sw.siteId, status: 'error', message: msg.message });
        }
        break;
      }
      case 'runEvicted': {
        input.reset();
        store.applyRunEvicted(msg, displayName);
        const reasonText =
          msg.reason === 'idle_timeout'
            ? 'Session ended due to inactivity · Forklift released for the next driver in line'
            : isLeaseEvictionReason(msg.reason)
              ? 'Contention lease expired · Forklift released for the next driver in line'
              : 'Shift complete · Forklift released for the next driver in line';
        notify('runSummary', `RUN OVER · ${Math.round(msg.pts)} PTS`, reasonText);
        break;
      }
      case 'commandEcho': {
        const copilotEcho = Boolean(msg.directive || store.ui.agentCommandPending);
        if (copilotEcho) {
          const log = runAiLog();
          const echo = directiveEchoFrom(msg, Date.now());
          if (log && echo) pushCapped(log.directives, echo);
          store.applyAgentEcho(msg);
        }
        const shield = shieldCardFor(msg, store.shieldStrikes + 1);
        if (shield) {
          // Model Armor blocked it: the 🛡 card replaces the generic refusal line.
          store.shieldStrikes += 1;
          store.ui.shield = { ...shield, until: Date.now() + SHIELD_CARD_MS };
          store.changed();
          break;
        }
        const detail = msg.parsed && 'echo' in msg.parsed ? msg.parsed.echo : undefined;
        notify(
          msg.executed ? 'status' : 'refusal',
          `“${msg.text}” → ${msg.executed ? 'executed' : 'not executed'}`,
          detail ? `${detail}${msg.reason ? ` (${msg.reason})` : ''}` : (msg.reason ?? undefined),
        );
        break;
      }
      case 'a2uiScreen':
        if (isDispatchersCallScreen(msg)) {
          // Minigame card: only for players with it on; otherwise the sim deadline lapses.
          if (store.isDispatchersCallEnabled()) {
            store.dispatchersCall = newDispatchersCallCard(msg.minigame, Date.now());
            store.changed();
          }
          break;
        }
        store.setA2ui(msg);
        break;
      case 'dispatchersCallReveal':
        store.dispatchersCall = dcApplyReveal(store.dispatchersCall, msg, Date.now());
        store.changed();
        break;
      case 'relocationOffer':
        store.ui.relocationOffer = msg;
        // Drive: the alert line (with Accept); Floor: the relocation pill already shows it.
        notify('relocation', `🚨 ${msg.fromSite.toUpperCase()} surge — ${msg.reason}`);
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
        notify(
          'status',
          `Relocating to ${target.toUpperCase()} (+${msg.bonusPts} pts)`,
          'Carrying over your shift score, streak, and active cards.',
        );
        net.joinWithTicket(target, msg.ticket, msg.expiresAt, msg.wsUrl);
        break;
      }
    }
  }

  // ---- render loop --------------------------------------------------------
  let lastFrame = performance.now();
  // No per-welcome refit: the renderer refits itself when the map (site or size) changes.
  const ghostPlanner = new GhostPlanner();
  /** Opt-in per-frame motion diagnostics (`?motionlog=1`): rendered pose, ack error, camera. */
  const motionLog: Array<Record<string, unknown>> | null = new URLSearchParams(location.search).has('motionlog')
    ? []
    : null;
  if (motionLog) (window as unknown as { __motion: typeof motionLog }).__motion = motionLog;
  /** Ghost planner path (sim findPath on our local World) to the highlighted option / guide target. */
  function ghostFor(me: Vehicle, pose: { x: number; y: number } | null): RenderGhost | null {
    const p = pose ?? { x: me.px, y: me.py };
    const target = ghostTarget(store.myFareOffer(), store.ui.fareSel, store.world.orders, store.myGuide());
    const path = ghostPlanner.plan(store.world, Math.floor(p.x), Math.floor(p.y), target, store.mapVersion);
    const points = ghostPolyline(p, path);
    if (!target || !points.length) return null;
    return { points, label: target.orderId != null ? `Ghost · #${target.orderId}` : 'Ghost' };
  }
  function frame(now: number): void {
    const elapsed = Math.min(250, now - lastFrame);
    lastFrame = now;
    const me = store.isDriving() ? store.myVehicle() : null;
    if (
      me &&
      me.runMode === 'blitz' &&
      (me.runFinished || (me.runEndsAt != null && store.world.t >= me.runEndsAt)) &&
      !store.ui.runEnd &&
      store.ui.runEndDismissedVid !== me.id
    ) {
      checkRunEnd();
      updateUi();
    }
    const predicting = Boolean(me && input.predicting(now, me));
    if (me && predicting) input.predict(store.world, me, elapsed);
    input.tick(now, document.hasFocus(), Boolean(me && Math.abs(me.speedNow) > 0.001));
    const cabWanted = store.isCabViewActive();
    if (cabWanted) ensureCab();
    const useCab = Boolean(cabWanted && cab);
    if (cab && cab.isVisible() !== useCab) cab.setVisible(useCab);
    // Lift Mode: the player's toggle, or forced on in the cab. Ungraded sites → PRACTICE flashes.
    const rackLiftEnabled = store.isRackLiftActive();
    rackLift.practice = rackLiftEnabled && !store.isRackLiftGraded();
    rackLift.step(elapsed, store.world, me, rackLiftEnabled);
    const myPose = me && predicting ? input.visualPose(me) : null;
    (useCab && cab ? cab : renderer).render(
      store.world,
      {
        layers: store.layers,
        highlightStrategy: store.highlightStrategy,
        selectedVid: store.selectedVid,
        myVid: store.hudMode() === 'driving' ? store.renderMyVid() : null,
        coneMode: store.coneMode,
        overlays: store.overlays,
        guide: store.myGuide(),
        myPose,
        ghost: store.layers.ghost && me ? ghostFor(me, myPose) : null,
        myCones: store.coneMode ? (store.floorOrders?.cones.mine ?? []) : undefined,
        dispatchPreview: store.ui.dispatchOpen
          ? { sourceZone: store.ui.dispatchDraft.sourceZone, targetBay: store.ui.dispatchDraft.targetBay }
          : null,
        rackLiftEnabled,
        rackLift,
        driveCameraMode: store.driveCameraMode(),
      },
      now,
    );
    if (motionLog && me) {
      const cam = renderer.cameraSnapshot();
      const p = myPose ?? { x: me.px, y: me.py, a: me.angle };
      motionLog.push({
        t: now,
        el: elapsed,
        pred: predicting,
        x: p.x,
        y: p.y,
        a: p.a,
        ex: input.errorX,
        ey: input.errorY,
        ea: input.errorAngle,
        cx: cam.x,
        cy: cam.y,
        cr: cam.rot ?? 0,
        s: me.speedNow,
        rivals: useCab
          ? 0
          : [...renderer.renderedPoses()]
              .filter(([id]) => id !== me.id)
              .map(([id, rp]) => [id, Math.round(rp.x * 1e4) / 1e4, Math.round(rp.y * 1e4) / 1e4]),
      });
      if (motionLog.length > 20_000) motionLog.splice(0, 10_000);
    }
  }
  // try/finally around every frame: one bad frame logs (throttled) instead of killing the loop.
  guardedFrame(frame, {
    requestFrame: (cb) => requestAnimationFrame(cb),
    logError: (message, err) => console.error(message, err),
  }).start();

  // 10 Hz input scheduler (+ 2 s keepalive while focused so the 5 s server lease holds).
  setInterval(() => {
    const me = store.isDriving() ? store.myVehicle() : null;
    input.tick(performance.now(), document.hasFocus(), Boolean(me && Math.abs(me.speedNow) > 0.001));
  }, 100);

  // ---- keyboard / window --------------------------------------------------
  /** Floor-order hotkeys press the real button, so cooldown / disabled rules stay in one place. */
  function pressOrder(id: string): void {
    const b = document.querySelector<HTMLButtonElement>(`#orders [data-order="${id}"]`);
    if (!b || b.closest('[hidden]')) return;
    if (b.disabled) {
      if (b.title) notify('orderRefusal', b.title);
      return;
    }
    b.click();
  }

  function closeOverlay(): void {
    const ov = store.activeOverlay();
    if (ov === 'pick') {
      // Minimise the initial deal into the contracts card (it can be reopened from there).
      store.ui.dealMinimizedKey = offerKey(store.myHand()?.offer);
      store.changed();
      return;
    }
    if (ov === 'results') {
      actions.dismissRunEnd();
      return;
    }
    store.ui.overlay = null;
    store.ui.flyout = null;
    store.ui.dispatchOpen = false;
    store.changed();
  }

  function runHotkey(a: HotkeyAction): void {
    switch (a) {
      case 'handBack':
        actions.handBack();
        break;
      case 'toggleCopilot':
        actions.setAutopilot(!store.isMyVehicleAutopilot());
        break;
      case 'intro:start':
        if (store.ui.helpOpen) help.start();
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
      case 'closeOverlay':
        closeOverlay();
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
        actions.setFlyout('board');
        break;
      case 'menu':
        actions.setOverlay(store.ui.overlay === 'menu' ? null : 'menu');
        break;
      case 'standings': {
        // Hold Tab: opens on keydown, the keyup handler closes it. Sheets (pick / results) win.
        const ov = store.activeOverlay();
        if (ov !== 'pick' && ov !== 'results' && ov !== 'standings') actions.setOverlay('standings');
        break;
      }
      case 'chat': {
        const ov = store.activeOverlay();
        if (ov === 'pick' || ov === 'results') break;
        actions.setOverlay('chat');
        break;
      }
      case 'hudMinimal':
        actions.toggleMinimal();
        break;
      case 'driveCamera':
        actions.toggleDriveCamera?.();
        break;
      case 'cabView':
        actions.toggleCabView?.();
        break;
      case 'drive':
        actions.driveFromFloor();
        break;
      case 'pick:1':
        pickToggle(ctx, 0);
        break;
      case 'pick:2':
        pickToggle(ctx, 1);
        break;
      case 'pick:3':
        pickToggle(ctx, 2);
        break;
      case 'pick:keep':
        if (store.activeOverlay() === 'pick') pickKeep(ctx);
        break;
      case 'results:again':
        // Only from the visible results sheet (never an invisible / suspended one).
        if (store.activeOverlay() === 'results') actions.retryNewRun('blitz');
        break;
      case 'closeDispatchersCall':
        store.dispatchersCall = null;
        store.changed();
        break;
      case 'closeA2ui':
        actions.dismissA2ui();
        break;
      case 'dispatch:send':
        actions.sendDispatch();
        break;
      case 'order:rush':
        pressOrder('rush');
        break;
      case 'order:p0':
        pressOrder('p0');
        break;
      case 'order:cones':
        pressOrder('cones');
        break;
      case 'order:dispatch':
        pressOrder('dispatch');
        break;
      case 'fare:cycle':
        actions.cycleFare();
        break;
      case 'fare:confirm': {
        const opt = store.highlightedFareOption();
        if (opt) actions.chooseOrder(opt.orderId);
        break;
      }
      case 'help':
        actions.showHelp(true);
        break;
    }
  }

  window.addEventListener('keydown', (ev) => {
    // Single modal policy (ui/modal.ts): one top layer gates the driving keys and every hotkey.
    const layer = store.topLayer();
    const drivingBlocked = blocksDriving(layer);
    const typing = isTypingTarget(ev.target);
    if (!typing && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      // A finished run freezes the car server-side; instead of silently ignoring
      // WASD, bring the run summary (Play again / Free roam) back up.
      if (
        !ev.repeat &&
        (!drivingBlocked || layer === 'results') &&
        store.isDriving() &&
        store.myVehicle()?.runFinished &&
        store.hudMode() === 'driving' &&
        /^(Key[WASD]|Arrow(Up|Down|Left|Right))$/.test(ev.code)
      ) {
        ev.preventDefault();
        if (!store.ui.runEnd) actions.showRunEnd();
        return;
      }
      // Blocking layers (intro, results, pick, Agent Designer, Leaderboard) swallow driving keys.
      if (!drivingBlocked && store.hudMode() === 'driving' && input.keyDown(ev, performance.now())) {
        ev.preventDefault();
        return;
      }
      if (!drivingBlocked && ev.code === 'KeyE' && store.isDriving() && store.hudMode() === 'driving') {
        ev.preventDefault();
        if (!ev.repeat) {
          if (actions.interactDown) actions.interactDown();
          else actions.interact();
        }
        return;
      }
    }
    const overlay = store.activeOverlay();
    const action = resolveHotkey(ev, {
      typing,
      canHandBack: store.canHandBack(),
      helpOpen: store.ui.helpOpen,
      agentDesignerOpen: store.ui.agentDesignerOpen,
      leaderboardModalOpen: store.ui.leaderboardModalOpen,
      drawerOpen: store.ui.drawerOpen,
      coneMode: store.coneMode,
      selectedVid: store.selectedVid,
      driving: store.hudMode() === 'driving',
      autopilot: store.isMyVehicleAutopilot(),
      fareOpen: store.myFareOffer() !== null,
      overlay,
      flyoutOpen: store.ui.flyout !== null,
      dispatchOpen: store.ui.dispatchOpen,
      dispatchersCallOpen: store.dispatchersCallVisible(),
      a2uiOpen: store.activeA2ui !== null,
    });
    if (!action) {
      // Keep Tab from moving focus around the page while the standings sheet is held open.
      if (ev.code === 'Tab' && !typing && overlay === 'standings') ev.preventDefault();
      return;
    }
    ev.preventDefault();
    runHotkey(action);
  });
  window.addEventListener('keyup', (ev) => {
    if (ev.code === 'Tab' && store.ui.overlay === 'standings') {
      ev.preventDefault();
      actions.setOverlay(null);
      return;
    }
    if (ev.code === 'KeyE' && store.isDriving() && store.hudMode() === 'driving') {
      ev.preventDefault();
      // Always release: a hold that started before a modal opened must not stick.
      actions.interactUp?.();
      return;
    }
    if (input.keyUp(ev, performance.now())) ev.preventDefault();
  });
  window.addEventListener('blur', () => {
    rackLift.cancel(store.myVehicle());
    input.blur(performance.now());
    if (store.ui.overlay === 'standings') actions.setOverlay(null);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      rackLift.cancel(store.myVehicle());
      input.blur(performance.now());
    }
    poller.onVisibilityChange();
  });
  window.addEventListener('resize', () => {
    renderer.resize();
    for (const p of flyouts.panels) p.onViewportResize();
    help.update();
  });

  // ---- start --------------------------------------------------------------
  poller.start();
  store.resumeCode = loadResumeCode(safeStorage());
  if (shouldShowHelpOnBoot(safeStorage())) store.ui.helpOpen = true;
  updateUi();
  void net.connect();
}

if (typeof document !== 'undefined' && typeof window !== 'undefined' && document.getElementById('world')) {
  boot();
}
