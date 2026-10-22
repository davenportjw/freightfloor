/**
 * Shared contract between main.ts (wiring) and the HUD modules in src/ui/.
 * Modules read the store and call actions; they never touch the socket directly.
 */
import type { AgentDirective, DifficultyLevel, DispatchParams, ManagerOp, RunMode, SiteId } from '@warehouse/protocol';
import type { ClientStore, DrawerTab, FlyoutId, LeaderboardModalTab, UiOverlay } from '../state.js';
import type { RenderLayers } from '../renderer.js';
import type { NoticeKind } from './notify.js';

export interface Actions {
  select(vid: string | null): void;
  /** Take the wheel of `vid` (defaults to the selected vehicle). */
  takeWheel(vid?: string | null): void;
  handBack(): void;
  /** 🚜 Drive: selected AI vehicle, else the best idle one. */
  quickDrive(): void;
  interact(forkHeight?: number): void;
  /** Begin a rack-lift hold/press interaction (KeyE down / touch E pointerdown). */
  interactDown?(): void;
  /** Release a rack-lift hold interaction (KeyE up / touch E pointerup). */
  interactUp?(): void;
  /** Reserve one of the driver's order options (`chooseOrder`). */
  chooseOrder(orderId: number): void;
  /** Move the local highlight to the next order option (Q). */
  cycleFare(): void;
  setConeMode(on: boolean): void;
  toggleLayer(key: keyof RenderLayers): void;
  zoomBy(factor: number): void;
  fit(): void;
  setDrawer(open: boolean, tab?: DrawerTab): void;
  showHelp(open: boolean): void;
  /** Open or close the full-screen Leaderboard & Silly Superlatives modal (#leaderboardModal). */
  showLeaderboardModal(open: boolean, tab?: LeaderboardModalTab): void;
  /** Open or close the Co-Pilot & Agent Designer modal (#agent-designer-modal). */
  showAgentDesigner(open: boolean): void;
  /** Send an `agentCommand` message to direct or configure the player's vehicle Co-Pilot. */
  agentCommand(opts: {
    vid?: string;
    text?: string;
    mode?: 'autopilot' | 'manual';
    directive?: AgentDirective;
  }): void;
  /** Toggle Co-Pilot autopilot (`true`) or Manual WASD (`false`) on the player's vehicle while keeping the lease. */
  setAutopilot(on: boolean, vid?: string | null): void;
  /** Hold the boost (⇧ meter pointer hold / Shift). */
  setBoost(on: boolean): void;
  /** Set directional touch inputs from the virtual thumbstick. */
  setTouchDirs(
    dirs: Partial<Record<'up' | 'down' | 'left' | 'right', boolean>> & {
      moveAngle?: number | null;
    },
  ): void;
  /** Release all active touch inputs (directions + boost). */
  releaseTouch(): void;
  /** Open one HUD overlay (chat / standings / menu) or close it with null. Closes flyouts + dispatch. */
  setOverlay(overlay: UiOverlay | null): void;
  /** Open one menu flyout (toggle when re-selected) or close it with null. */
  setFlyout(id: FlyoutId | null): void;
  /** Open / close the Floor-orders 📦 Dispatch popover. */
  setDispatchOpen(open: boolean): void;
  /** Send the dispatch draft (`ui.dispatchDraft`) as a real `manager` dispatch order. */
  sendDispatch(): void;
  /** Chat target: Co-Pilot or the Floor. */
  setChatTarget(target: 'copilot' | 'floor'): void;
  /** HUD Full / Minimal (V). */
  toggleMinimal(): void;
  /** Floor camera: follow `vid` (null = free camera). */
  follow(vid: string | null): void;
  /** Floor camera: pan to a tile. */
  panTo(x: number, y: number): void;
  /** Floor view 🚜 Drive (F): Play again if my run finished, else take the best vehicle. */
  driveFromFloor(): void;
  /**
   * Intro "Start driving →": closes the intro and takes a wheel. Before the site `welcome` it queues
   * a drive-on-welcome intent (`ui.pendingDrive`, the button shows "Connecting…").
   */
  startDriving?(): void;
  setHighlight(strat: string | null): void;
  vote(level: DifficultyLevel): void;
  keepCards(ids: string[]): void;
  /** Switch personal driver run mode between 'blitz' (3-minute timed run) and 'freerange' (continuous floor play). */
  setRunMode(mode: RunMode): void;
  /** Accept a cross-site surge relocation offer and claim the +75 pt relocation bonus. */
  acceptRelocation(toSite: SiteId): void;
  /** Dismiss the active surge relocation offer banner. */
  dismissRelocation(): void;
  manager(op: Exclude<ManagerOp, 'cone'>): void;
  dispatchRoute(dispatch: DispatchParams): void;
  openObjectives(): void;
  submitA2ui(actionId: string, dispatch?: DispatchParams, managerOp?: ManagerOp): void;
  dismissA2ui(): void;
  /** Pick option `idx` on the open Dispatcher's Call card. */
  pickDispatchersCall(idx: number): void;
  /** Turn Dispatcher's Call on/off for this player (persisted; sent to the site). */
  setDispatchersCallPref(on: boolean): void;
  nlCommand(text: string): void;
  switchSite(siteId: SiteId): void;
  refreshNetwork(): void;
  /**
   * Find and switch to an existing callsign or resume code (`wr1_…`) via the lobby.
   * Returns null on success or an error string (new names are rejected).
   */
  resumeCallsign(resumeCode: string): Promise<string | null>;
  /** Start a fresh run (Run N+1) with a new full-battery vehicle and new contract card offer, optionally in `mode`. */
  retryNewRun(mode?: RunMode): void;
  /** Claim a ready waiting-line seat lease (`POST /api/queue/claim`) and take the wheel. */
  claimQueueSeat(): void;
  /** Leave the FIFO waiting line (`POST /api/queue/leave`) and continue spectating. */
  leaveQueue(): void;
  /** Toggle automatic seat claiming when our queue lease becomes ready. */
  toggleAutoClaimSeat(): void;
  /** Close the results sheet without starting a new run ("Watch the floor" → Floor view). */
  dismissRunEnd(): void;
  /** Re-open the results sheet for the current finished run. */
  showRunEnd(): void;
  /** Raise a client notice; ui/notify.ts routes it (alert line / floor feed / order line / popup / drop). */
  notify(kind: NoticeKind, text: string, extra?: string): void;
  /** Re-render everything (e.g. after a local UI-only change). */
  refresh(): void;
}

export interface UiCtx {
  store: ClientStore;
  actions: Actions;
}

export interface UiModule {
  /** Called on every store change and ~4x/s for clock-driven text. Must be cheap when nothing changed. */
  update(): void;
}

