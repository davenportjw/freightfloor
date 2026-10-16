/**
 * Shared contract between main.ts (wiring) and the HUD modules in src/ui/.
 * Modules read the store and call actions; they never touch the socket directly.
 */
import type { DifficultyLevel, ManagerOp, SiteId } from '@warehouse/protocol';
import type { ClientStore, DrawerTab } from '../state.js';
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
  setHighlight(strat: string | null): void;
  vote(level: DifficultyLevel): void;
  keepCards(ids: string[]): void;
  manager(op: Exclude<ManagerOp, 'cone'>): void;
  nlCommand(text: string): void;
  switchSite(siteId: SiteId): void;
  refreshNetwork(): void;
  rename(name: string): string | null;
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
