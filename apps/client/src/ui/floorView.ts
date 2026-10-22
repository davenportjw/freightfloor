/**
 * FLOOR view chrome (shown when not driving, or after "Watch the floor"):
 *  - `#kpis` strip (left:70 top:12): site · Day/Shift clock, Shipped, On-time, Backlog.
 *  - `#floorBanner` (top-right): "Floor view · …" + teal "🚜 Drive F" (`driveFromFloor`); after a
 *    run it reads "your run is over · N pts" (the run summary lives here, not in a notification).
 *  - `#feed` (right:12 top:80): the FLOOR mode's only notification stream — the last ≤3 live sim
 *    events merged with client notices (`store.ui.feedNotes`, ui/notify.ts), deduped by text, each
 *    fading after 6 s. Events about my own vehicle are teal ("you"); clicking an event pans to it.
 * All values come from the live store (kpiView / store.events); nothing is synthesised.
 */
import type { SimEvent } from '@warehouse/sim';
import type { UiCtx, UiModule } from './context.js';
import { el, kbd, KeyedView } from './dom.js';
import { DASH, shiftLeft } from './format.js';
import { kpiView } from './kpiBar.js';
import { presenceView } from './presence.js';

export const FEED_MAX = 3;
export const FEED_TTL_MS = 6000;

export type FeedTone = 'good' | 'bad' | 'warn' | 'you' | '';

const GOOD = new Set(['card', 'p0done', 'retune', 'expand', 'deliver', 'delivered', 'shift', 'day']);
const BAD = new Set(['incident', 'brain_error', 'error', 'crash', 'collision', 'drop']);
const WARN = new Set(['hazard', 'poach', 'preempt', 'rush', 'p0', 'late', 'spill']);

/** Feed tone: my own vehicle → you (teal), else by event type. Decisions / near-misses are skipped. */
export function feedTone(ev: Pick<SimEvent, 'type'> & { vid?: unknown; clientId?: unknown }, myVid: string | null, myClientId: string | null): FeedTone | null {
  if (ev.type === 'nearmiss' || ev.type === 'decision' || ev.type === 'hint') return null;
  if ((myVid && ev.vid === myVid) || (myClientId && ev.clientId === myClientId)) return 'you';
  if (GOOD.has(ev.type)) return 'good';
  if (BAD.has(ev.type)) return 'bad';
  if (WARN.has(ev.type)) return 'warn';
  return '';
}

/** Feed rows to show: newest first, at most FEED_MAX, each younger than FEED_TTL_MS (wall clock). */
export function feedRows<T>(arrived: ReadonlyArray<{ ev: T; at: number }>, now: number): Array<{ ev: T; at: number; fading: boolean }> {
  return arrived
    .filter((a) => now - a.at < FEED_TTL_MS)
    .slice(0, FEED_MAX)
    .map((a) => ({ ...a, fading: now - a.at > FEED_TTL_MS - 1000 }));
}

/** Keep the first (newest) row per text: a repeated notice or event shows once. */
export function dedupeByText<T extends { text: string }>(rows: ReadonlyArray<T>): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.text) ? false : (seen.add(r.text), true)));
}

export function mountFloorView(kpis: HTMLElement, banner: HTMLElement, feed: HTMLElement, ctx: UiCtx): UiModule {
  const kpiKv = new KeyedView(kpis);
  const bannerKv = new KeyedView(banner);
  const feedKv = new KeyedView(feed);
  const arrivedAt = new WeakMap<SimEvent, number>();
  let primed = false;
  let lastWorld: unknown = null;

  return {
    update() {
      const { store, actions } = ctx;
      const floor = store.hudMode() === 'floor' && store.welcomed;
      const ov = store.activeOverlay();
      const covered = ov === 'results';
      kpis.hidden = !floor || covered;
      banner.hidden = !floor || covered;
      feed.hidden = !floor || covered || store.ui.dispatchOpen;
      const now = Date.now();

      // Track arrival times even while hidden so the feed never replays old events on entry.
      if (store.world !== lastWorld) {
        lastWorld = store.world;
        primed = false;
      }
      for (const ev of store.events.slice(0, 20)) {
        if (!arrivedAt.has(ev)) arrivedAt.set(ev, primed ? now : 0);
      }
      primed = true;
      if (!floor) {
        kpiKv.invalidate();
        bannerKv.invalidate();
        feedKv.invalidate();
        return;
      }

      const k = kpiView(store, now);
      kpiKv.render(JSON.stringify(k), () => [
        el('div', { class: 'kpi site', title: k.siteTitle ?? '' }, [
          el('span', { class: 'sub', text: k.site }),
          el('b', { class: 'clock num', text: k.clock }),
        ]),
        el('div', { class: 'kpi' }, [el('span', { class: 'sub', text: 'Shipped' }), el('b', { class: 'num', text: k.shipped })]),
        el('div', { class: 'kpi' }, [el('span', { class: 'sub', text: 'On-time' }), el('b', { class: 'num', text: k.onTime })]),
        el('div', { class: `kpi${k.backlog !== DASH && Number(k.backlog) > 0 ? ' bad' : ''}` }, [
          el('span', { class: 'sub', text: 'Backlog' }),
          el('b', { class: 'num', text: k.backlog }),
        ]),
        el('span', { class: `pill conn`, attrs: { 'data-tone': k.conn.tone }, text: k.conn.text }),
      ]);

      const me = store.myVehicle();
      const runOver = Boolean(me?.runFinished);
      const pres = presenceView(store);
      const q = store.queue;
      const runPts = me ? Math.round(me.runPts ?? me.sPts) : 0;
      const status = runOver
        ? `your run is over · ${runPts} pts`
        : store.isDriving()
          ? 'you are driving'
          : `shift ends in ${shiftLeft(store.world.t)}`;

      bannerKv.render(
        JSON.stringify([
          status,
          runOver,
          pres.full,
          pres.capText,
          store.autoClaimSeat,
          store.evictedReason,
          q?.state,
          q?.position,
          q?.totalQueued ?? q?.queueSize,
          q?.estimatedWaitSec,
          q?.seatLeaseId,
          q?.claimSiteId ?? q?.assignedSiteId,
        ]),
        () => {
          if (q?.state === 'queued') {
            const totalQueued = q.totalQueued ?? q.queueSize ?? q.position ?? 1;
            const waitSec = q.estimatedWaitSec ?? 0;
            const autoBtn = el('button', {
              class: 'ghost',
              text: `Auto-Drive: ${store.autoClaimSeat ? 'ON' : 'OFF'}`,
              title: 'Automatically claim your forklift when your seat lease becomes ready',
              attrs: { type: 'button', 'data-role': 'toggle-auto-claim' },
              onClick: () => actions.toggleAutoClaimSeat(),
            });
            const leaveBtn = el('button', {
              class: 'ghost',
              text: 'Leave Line',
              title: 'Leave the waiting line and continue watching the floor',
              attrs: { type: 'button', 'data-role': 'leave-queue' },
              onClick: () => actions.leaveQueue(),
            });
            return [
              el('span', {
                text: `● Waiting in line · #${q.position ?? 1} of ${totalQueued} · ~${waitSec}s est. wait`,
              }),
              autoBtn,
              leaveBtn,
            ];
          }

          if (q?.state === 'ready') {
            const targetSite = (q.claimSiteId ?? q.assignedSiteId ?? store.siteId ?? 'den-1').toUpperCase();
            const claimBtn = el(
              'button',
              {
                class: 'primary',
                title: `Claim your reserved driver seat on ${targetSite}`,
                attrs: { type: 'button', 'data-role': 'claim-seat' },
                onClick: () => actions.claimQueueSeat(),
              },
              ['🚜 Take the Wheel ', kbd('↵')],
            );
            return [
              el('span', { text: `● Forklift Ready on ${targetSite}` }),
              claimBtn,
            ];
          }

          if (!runOver && !store.isDriving() && pres.full) {
            const joinLine = el(
              'button',
              {
                class: 'primary',
                title: `Driver slots full (${pres.capText}) — join the FIFO waiting line (F)`,
                attrs: { type: 'button', 'data-role': 'drive-floor' },
                onClick: () => actions.driveFromFloor(),
              },
              ['🕒 Join Waiting Line ', kbd('F')],
            );
            return [el('span', { text: `Floor view · ${status}` }), joinLine];
          }

          const drive = el(
            'button',
            {
              class: 'primary',
              title: runOver ? 'Start a new run (F)' : 'Jump in and drive (F)',
              attrs: { type: 'button', 'data-role': 'drive-floor' },
              onClick: () => actions.driveFromFloor(),
            },
            [runOver ? '🚜 Play again ' : '🚜 Drive ', kbd('F')],
          );
          return [el('span', { text: `Floor view · ${status}` }), drive];
        },
      );

      const myVid = me?.id ?? null;
      const myClient = store.you?.clientId ?? null;
      type Row = { key: string; text: string; at: number; tone: FeedTone; ev: SimEvent | null };
      const arrived: Row[] = [];
      for (const ev of store.events.slice(0, 20)) {
        const tone = feedTone(ev as SimEvent & { vid?: unknown; clientId?: unknown }, myVid, myClient);
        if (tone === null) continue;
        arrived.push({ key: `e${ev.t}|${ev.type}`, text: ev.text, at: arrivedAt.get(ev) ?? 0, tone, ev });
      }
      for (const n of store.ui.feedNotes) arrived.push({ key: `n${n.at}`, text: n.text, at: n.at, tone: n.tone, ev: null });
      arrived.sort((a, b) => b.at - a.at);
      const rows = feedRows(dedupeByText(arrived).map((r) => ({ ev: r, at: r.at })), now).map((r) => ({ ...r.ev, fading: r.fading }));
      feedKv.render(JSON.stringify(rows.map((r) => [r.key, r.text, r.fading])), () =>
        rows.map((r) => {
          const x = (r.ev as { x?: unknown } | null)?.x;
          const y = (r.ev as { y?: unknown } | null)?.y;
          const vid = (r.ev as { vid?: unknown } | null)?.vid;
          const canPan = typeof x === 'number' && typeof y === 'number';
          return el('button', {
            class: `ev ${r.tone}${r.fading ? ' fading' : ''}`.trim(),
            text: r.text,
            title: canPan ? 'Show on the floor' : typeof vid === 'string' ? `Follow ${vid}` : r.text,
            attrs: { type: 'button', 'data-role': 'feed-item' },
            onClick: () => {
              if (canPan) actions.panTo(x, y);
              else if (typeof vid === 'string' && store.vehicle(vid)) {
                actions.select(vid);
                actions.follow(vid);
              }
            },
          });
        }),
      );
    },
  };
}
