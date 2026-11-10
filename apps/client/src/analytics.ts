/**
 * GA4 key-event reporting for the Freight Floor client.
 *
 * The measurement ID comes from the lobby (`GET /api/config`, set by `GA_MEASUREMENT_ID` on the
 * lobby service). When it is unset, nothing loads and `track()` drops events: there is no local
 * fallback and nothing is invented.
 *
 * Privacy: events never carry display names, client IDs, publicIds, resume codes, vehicle IDs, or
 * free text typed by the player (manager orders and agent commands send only their kind).
 */
import { isLiveryId, type ClientMessage, type LiveryId, type ServerMessage } from '@warehouse/protocol';

export type AnalyticsParams = Record<string, string | number | boolean>;
export interface AnalyticsEvent {
  name: string;
  params: AnalyticsParams;
}

const MEASUREMENT_ID_PATTERN = /^G-[A-Z0-9]{4,16}$/;
const GTAG_SRC = 'https://www.googletagmanager.com/gtag/js?id=';

export function isMeasurementId(raw: unknown): raw is string {
  return typeof raw === 'string' && MEASUREMENT_ID_PATTERN.test(raw);
}

/**
 * Maps a client→site message to its GA4 event (or null for high-frequency / plumbing traffic such
 * as `input`, `interact`, `hello`, and `layers`). Only fires for messages the socket accepted.
 */
export function eventForClientMessage(msg: ClientMessage): AnalyticsEvent | null {
  switch (msg.type) {
    case 'takeWheel':
      return { name: 'take_wheel', params: {} };
    case 'release':
      return { name: 'release_wheel', params: {} };
    case 'manager':
      return { name: 'floor_order', params: { op: msg.op } };
    case 'keepCards':
      return { name: 'contracts_kept', params: { count: msg.ids.length } };
    case 'chooseOrder':
      return { name: 'order_chosen', params: {} };
    case 'voteDifficulty':
      return { name: 'difficulty_vote', params: { level: String(msg.level) } };
    case 'nlCommand':
      return { name: 'manager_command', params: {} };
    case 'agentCommand': {
      const kind = msg.directive ? 'directive' : msg.text ? 'text' : 'mode';
      const params: AnalyticsParams = { kind };
      if (msg.mode) params.mode = msg.mode;
      return { name: 'agent_command', params };
    }
    case 'transferSite':
      return { name: 'site_transfer', params: { site_id: msg.siteId } };
    case 'a2uiAction': {
      const params: AnalyticsParams = {};
      if (msg.managerOp) params.op = msg.managerOp;
      return { name: 'ai_card_action', params };
    }
    case 'setRunMode':
      return { name: 'run_mode_select', params: { run_mode: msg.mode } };
    case 'acceptRelocation':
      return { name: 'relocation_accept', params: {} };
    case 'dispatchersCallPref':
      return { name: 'dispatchers_call_pref', params: { enabled: msg.enabled } };
    case 'setLivery':
      // Catalog ids only (never raw text the site would reject).
      return isLiveryId(msg.id) ? { name: 'livery_equip', params: { livery_id: msg.id } } : null;
    default:
      return null;
  }
}

/** GA4 recommended `unlock_achievement`, one per newly announced livery. */
export function unlockEvents(ids: readonly LiveryId[]): AnalyticsEvent[] {
  return ids.map((id) => ({ name: 'unlock_achievement', params: { achievement_id: `livery_${id}` } }));
}

/** Seat on a site (lobby join or queued seat claim). */
export function joinEvent(join: { siteId: string; role?: string }, via: 'join' | 'queue'): AnalyticsEvent {
  const params: AnalyticsParams = { site_id: join.siteId, via };
  if (join.role) params.role = join.role;
  return { name: 'site_join', params };
}

/** GA4 recommended `level_start`: a new run began on the player's forklift. */
export function runStartEvent(runMode: string, siteId: string | null): AnalyticsEvent {
  const params: AnalyticsParams = { level_name: runMode };
  if (siteId) params.site_id = siteId;
  return { name: 'level_start', params };
}

export interface RunEndSummary {
  runMode: string;
  runNumber: number;
  score: number;
  deliveries: number;
  onTimePct: number;
  humanRank: number;
  totalHumanRuns: number;
}

/** GA4 recommended `level_end` + `post_score` for a finished run. */
export function runEndEvents(run: RunEndSummary, siteId: string | null): AnalyticsEvent[] {
  const base: AnalyticsParams = siteId ? { site_id: siteId } : {};
  return [
    { name: 'level_end', params: { ...base, level_name: run.runMode, success: true } },
    {
      name: 'post_score',
      params: {
        ...base,
        score: run.score,
        level: run.runNumber,
        character: run.runMode,
        deliveries: run.deliveries,
        on_time_pct: run.onTimePct,
        human_rank: run.humanRank,
        human_runs: run.totalHumanRuns,
      },
    },
  ];
}

/** Server messages worth a key event (currently Dispatcher's Call reveals). */
export function eventForServerMessage(msg: ServerMessage): AnalyticsEvent | null {
  if (msg.type === 'dispatchersCallReveal') return { name: 'dispatchers_call_reveal', params: {} };
  return null;
}

/**
 * `return_visit`: first boot on a later UTC day than the player's previous visit. Not sent on the
 * first-ever day (GA4 reports `first_visit` itself) or for repeat visits within a day.
 */
export function returnVisitEvent(
  update: { isReturn: boolean; daysSinceLast: number | null; ledger: { activeDays: number } } | null,
): AnalyticsEvent | null {
  if (!update?.isReturn || update.daysSinceLast === null) return null;
  return {
    name: 'return_visit',
    params: { days_since_last: update.daysSinceLast, active_days: update.ledger.activeDays },
  };
}

type Gtag = (...args: unknown[]) => void;
interface GtagWindow {
  dataLayer?: unknown[];
  gtag?: Gtag;
}

/**
 * Client-side GA4 sink. Events tracked before the config resolves are held, then flushed (GA on)
 * or dropped (GA off).
 */
export class Analytics {
  private state: 'pending' | 'on' | 'off' = 'pending';
  private pending: AnalyticsEvent[] = [];
  private gtag: Gtag | null = null;

  get enabled(): boolean {
    return this.state === 'on';
  }

  /** Enable with a measurement ID (or disable with null). Safe to call once. */
  start(measurementId: string | null, win: Window | undefined = globalThis.window): void {
    if (this.state !== 'pending') return;
    if (!isMeasurementId(measurementId) || !win?.document) {
      this.state = 'off';
      this.pending = [];
      return;
    }
    const w = win as unknown as GtagWindow;
    w.dataLayer = w.dataLayer ?? [];
    const gtag: Gtag = function gtag() {
      // gtag.js expects the `arguments` object itself, not an array copy.
      // eslint-disable-next-line prefer-rest-params
      w.dataLayer!.push(arguments);
    };
    w.gtag = gtag;
    gtag('js', new Date());
    gtag('config', measurementId, {
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
    });
    const script = win.document.createElement('script');
    script.async = true;
    script.src = `${GTAG_SRC}${encodeURIComponent(measurementId)}`;
    win.document.head.appendChild(script);

    this.gtag = gtag;
    this.state = 'on';
    const queued = this.pending;
    this.pending = [];
    for (const ev of queued) this.emit(ev);
  }

  track(ev: AnalyticsEvent | null): void {
    if (!ev) return;
    if (this.state === 'off') return;
    if (this.state === 'pending') {
      if (this.pending.length < 50) this.pending.push(ev);
      return;
    }
    this.emit(ev);
  }

  private emit(ev: AnalyticsEvent): void {
    try {
      this.gtag?.('event', ev.name, ev.params);
    } catch (err) {
      console.error('[analytics] event failed', ev.name, err);
    }
  }
}

/** Reads `{ gaMeasurementId }` from the lobby. Returns null when unset or unreachable. */
export async function fetchAnalyticsConfig(fetchFn: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchFn('/api/config', { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as { gaMeasurementId?: unknown };
    return isMeasurementId(body.gaMeasurementId) ? body.gaMeasurementId : null;
  } catch (err) {
    console.warn('[analytics] config unavailable', err);
    return null;
  }
}
