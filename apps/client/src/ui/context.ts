/**
 * Shared contract between main.ts (wiring) and the HUD modules in src/ui/.
 * Modules read the store and call actions; they never touch the socket directly.
 */
import type { AgentDirective, DifficultyLevel, DispatchParams, ManagerOp, RunMode, SiteId } from '@warehouse/protocol';
import type { ClientStore, DrawerTab, LeaderboardModalTab } from '../state.js';
import type { RenderLayers } from '../renderer.js';

export interface Actions {
  select(vid: string | null): void;
  /** Take the wheel of `vid` (defaults to the selected vehicle). */
  takeWheel(vid?: string | null): void;
  handBack(): void;
  /** 🚜 Drive: selected AI vehicle, else the best idle one. */
  quickDrive(): void;
  interact(): void;
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
  /** Toggle showing/hiding the left & right side panel docks. */
  toggleDocks(): void;
  /** Fold all open panels to compact summary pills (or expand primary panels if all are folded). */
  foldPanels(): void;
  /** Toggle the bottom command bar's quick-reference Ops guide card. */
  setOpsGuide(open: boolean): void;
  setHighlight(strat: string | null): void;
  vote(level: DifficultyLevel): void;
  keepCards(ids: string[]): void;
  /** Switch personal driver run mode between 'blitz' (5-min timed run) and 'freerange' (continuous floor play). */
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
  nlCommand(text: string): void;
  switchSite(siteId: SiteId): void;
  refreshNetwork(): void;
  rename(name: string): string | null;
  /** Resume a previously assigned callsign or clientId via the lobby. Returns null on success or an error string. */
  resumeCallsign(resumeToken: string): Promise<string | null>;
  /** Start a fresh run (Run N+1) with a new full-battery vehicle and new contract card offer. */
  retryNewRun(): void;
  toast(type: string, text: string, extra?: string): void;
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

