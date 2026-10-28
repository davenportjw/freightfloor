/**
 * DRIVE HUD → `#objective` pill (top:96) with the server guide text, the order-choice pills under it
 * (Q cycle / F reserve, restyled — no sepia) + rival strip, the surge relocation pill (FLOOR), and
 * the single DRIVE alert line `#alert` (top:140): low battery / a nearby spill (raised when the
 * condition starts), relocation offers and refusals/errors routed by ui/notify.ts. One at a time,
 * newest wins, auto-clears (`store.ui.alert`).
 */
import { rivalReasonText } from './aiInsight.js';
import { coachText } from './runOne.js';
import { guide as simGuide, requiresRackLift, type Order, type Vehicle, type World } from '@warehouse/sim';
import type { GuideInfo } from '../state.js';
import type { UiCtx, UiModule } from './context.js';
import { button, el, kbd, KeyedView } from './dom.js';
import { activeAlert, ALERT_MS, type AlertState } from './notify.js';
import {
  countdownText,
  FARE_CONFIRM_KEY,
  FARE_CYCLE_KEY,
  fareOfferKey,
  optionPills,
  rivalDraftText,
  rivalPillText,
} from './fareChoice.js';

/** Battery % under which the low-battery alert shows. */
export const LOW_BATTERY_PCT = 20;
/** Hazard alert radius (tiles, Manhattan). */
export const HAZARD_ALERT_TILES = 4;

export interface AlertView {
  tone: 'bad' | 'warn';
  text: string;
  /** Condition category: a new category raises the alert line again. */
  cond: 'flat' | 'low' | 'spill';
}

/** Contextual alert: flat/low battery (red) beats a nearby spill (amber). Null = no alert. */
export function alertView(
  me: { battery: number; tile: { x: number; y: number }; autopilot?: boolean },
  hazards: ReadonlyArray<{ x: number; y: number }> | null | undefined,
): AlertView | null {
  const bat = Math.round(me.battery);
  if (bat <= 0) return { tone: 'bad', cond: 'flat', text: '🪫 Battery flat — limping. Drive to a ⚡ charger and press E.' };
  if (bat < LOW_BATTERY_PCT) return { tone: 'bad', cond: 'low', text: `🔋 Battery ${bat}% — head to a ⚡ charger (E to charge).` };
  let best: number | null = null;
  for (const h of hazards ?? []) {
    const d = Math.abs(h.x - me.tile.x) + Math.abs(h.y - me.tile.y);
    if (d <= HAZARD_ALERT_TILES && (best === null || d < best)) best = d;
  }
  if (best !== null) return { tone: 'warn', cond: 'spill', text: `⚠ Spill ${best === 0 ? 'here' : `${best} tile${best === 1 ? '' : 's'} away`} — slow down or route around it.` };
  return null;
}

/**
 * The alert to show now. A condition alert (battery / spill) keeps live text and goes away with its
 * condition; a relocation alert goes away with its offer.
 */
export function shownAlert(
  a: AlertState | null,
  cond: AlertView | null,
  hasOffer: boolean,
  now: number,
): AlertState | null {
  const cur = activeAlert(a, now);
  if (!cur) return null;
  if (cur.cond) return cond && cond.cond === cur.cond ? { ...cur, text: cond.text, tone: cond.tone } : null;
  if (cur.action === 'relocation' && !hasOffer) return null;
  return cur;
}

/** A condition category must be absent this long (ms) before it can raise the alert line again. */
export const COND_REARM_MS = 30_000;

/**
 * Hysteresis for condition alerts. `lastSeen` maps category → wall-clock ms it was last present
 * (mutated: the present category is stamped `now`). True when `key` should raise the alert line:
 * it is present and was not seen within the last COND_REARM_MS (so a spill flapping in and out of
 * the radius, or a battery hovering at the threshold, raises once rather than every few seconds).
 */
export function shouldRaiseCond(lastSeen: Map<string, number>, key: string | null, now: number): boolean {
  if (!key) return false;
  const prev = lastSeen.get(key);
  lastSeen.set(key, now);
  return prev === undefined || now - prev > COND_REARM_MS;
}

function isRackCandidate(order: Order | GuideInfo['order'] | undefined, action: 'pick' | 'stow'): boolean {
  if (!order) return false;
  const slot = (action === 'stow' ? order.putaway : order.slot) as
    | (Order['slot'] & { id?: string })
    | undefined;
  if (!slot) return false;
  const rackId = String(slot.rackId ?? slot.id ?? '');
  if (rackId.startsWith('WD') || rackId.startsWith('DOCK-') || /^W\d+$/.test(rackId)) {
    return false;
  }
  if (typeof slot.key === 'string' && typeof slot.rx === 'number' && typeof slot.ax === 'number') {
    return requiresRackLift(order as Order, action);
  }
  return Boolean(rackId);
}

export function resolveRackLiftGuideLevel(
  g: GuideInfo | null,
  world?: World | null,
  me?: Vehicle | null,
): 0 | 1 | 2 | null {
  if (!g) return null;
  const isStow = g.kind === 'drop' ? Boolean(g.stow || g.order?.putaway) : Boolean(g.stow);
  const isPick = g.kind === 'pick' || (!g.kind && !isStow && Boolean(g.order));
  if (isPick) {
    const order =
      world?.orders?.find(
        (o) => (g.order?.id != null && o.id === g.order.id) || (g.x != null && g.y != null && o.slot.ax === g.x && o.slot.ay === g.y),
      ) ?? g.order;
    if (isRackCandidate(order, 'pick')) {
      return ((order?.slot?.level ?? 0) as 0 | 1 | 2);
    }
    return null;
  }
  if (isStow || g.kind === 'drop') {
    const carried = me?.cargo ?? [];
    const stowOrder =
      carried.find(
        (o) =>
          (g.order?.id != null && o.id === g.order.id) ||
          (o.putaway && g.x != null && g.y != null && o.putaway.ax === g.x && o.putaway.ay === g.y),
      ) ?? g.order;
    if ((g.stow || stowOrder?.putaway) && isRackCandidate(stowOrder, 'stow')) {
      return ((stowOrder?.putaway?.level ?? 0) as 0 | 1 | 2);
    }
  }
  return null;
}

/** Objective text: the server guide while manual, the Co-Pilot status while on autopilot. */
export function objectiveText(
  g: GuideInfo | null,
  me: { id: string; tile: { x: number; y: number }; autopilot?: boolean; msg?: string },
  copilotSummary: string,
  rackLiftLevel: 0 | 1 | 2 | null = null,
): { text: string; inRange: boolean; dist: number | null } {
  if (me.autopilot) return { text: `🤖 ${me.msg ? `${me.msg} · ` : ''}${copilotSummary}`, inRange: false, dist: null };
  const dist = g && typeof g.x === 'number' && typeof g.y === 'number' ? Math.round(Math.abs(g.x - me.tile.x) + Math.abs(g.y - me.tile.y)) : null;
  if (g?.text) {
    let rawText = g.text;
    if (rackLiftLevel !== null) {
      const tier = `L${rackLiftLevel + 1}`;
      rawText = rawText.replace(/\bpress E\b/gi, 'hold E');
      if (!rawText.includes(`[${tier}]`)) {
        rawText = `${rawText} [${tier}]`;
      }
    }
    return { text: `${g.inRange ? '✓' : '▶'} ${rawText}`, inRange: Boolean(g.inRange), dist };
  }
  return { text: `Driving ${me.id} · WASD to steer · C for Co-Pilot`, inRange: false, dist: null };
}

export function mountObjective(
  objectiveEl: HTMLElement,
  fareEl: HTMLElement,
  alertEl: HTMLElement,
  relocEl: HTMLElement,
  ctx: UiCtx,
  copilotSummary: (vid: string) => string,
): UiModule {
  const objView = new KeyedView(objectiveEl);
  const fareView = new KeyedView(fareEl);
  const relocView = new KeyedView(relocEl);
  const alertKv = new KeyedView(alertEl);
  /** Condition category → last time present; a category re-raises only after COND_REARM_MS absent. */
  const condSeen = new Map<string, number>();
  relocEl.dataset.role = 'relocation-pill';
  fareEl.dataset.role = 'fare-choice';
  return {
    update() {
      const { store, actions } = ctx;
      const driving = store.hudMode() === 'driving';
      const me = driving ? store.myVehicle() : null;
      const blocked = store.activeOverlay() === 'results' || store.activeOverlay() === 'pick';

      // ---- relocation offer (either mode) ----
      const offer = store.ui.relocationOffer;
      const toSite = offer ? (offer.toSite ?? offer.targetSite) : undefined;
      // DRIVE shows the offer in the alert line instead (one line under the objective).
      relocEl.hidden = !offer || !toSite || blocked || driving;
      if (offer && toSite) {
        relocView.render(`${offer.fromSite}|${toSite}|${offer.bonusPts}|${offer.expiresAt}`, () => {
          const accept = button(
            `⚡ Relocate to ${toSite.toUpperCase()} (+${offer.bonusPts} pts)`,
            'go small',
            () => actions.acceptRelocation(toSite),
            `Move to ${toSite.toUpperCase()} and keep your score, streak and completed perks, plus ${offer.bonusPts} bonus pts`,
          );
          accept.dataset.action = 'accept-relocation';
          const dismiss = button('✕', 'x', () => actions.dismissRelocation(), 'Dismiss surge relocation offer');
          dismiss.dataset.action = 'dismiss-relocation';
          return [el('span', { text: `🚨 ${offer.fromSite.toUpperCase()} surge — ${offer.reason}` }), accept, dismiss];
        });
      }

      if (!me || blocked) {
        objectiveEl.hidden = true;
        fareEl.hidden = true;
        alertEl.hidden = true;
        objView.invalidate();
        fareView.invalidate();
        return;
      }

      // ---- objective ----
      const rackLiftOn = typeof store.isRackLiftActive === 'function' ? store.isRackLiftActive() : store.isRackLiftEnabled();
      const activeGuide =
        store.myGuide() ?? (rackLiftOn && store.world.orders.length > 0 ? (simGuide(store.world, me) as GuideInfo | null) : null);
      const rackLiftLevel = rackLiftOn ? resolveRackLiftGuideLevel(activeGuide, store.world, me) : null;
      const base = objectiveText(activeGuide, me, copilotSummary(me.id), rackLiftLevel);
      // Run 1 drive-first: a 3-step coach rides on the objective pill (real cargo / guide / fare).
      const coach = store.driveFirst
        ? coachText({ me, guide: activeGuide, lastFare: store.ui.coachFare, now: Date.now() })
        : null;
      const o = coach ? { ...base, text: coach } : base;
      objectiveEl.hidden = false;
      objView.render(JSON.stringify({ ...o, rackLiftLevel }), () => [
        el('span', { class: o.inRange ? 'ok' : '', text: o.text, title: o.text }),
        o.dist !== null && !o.inRange ? el('span', { class: 'dist num', text: ` · ${o.dist} tiles` }) : null,
        o.inRange
          ? el(
              'span',
              { class: 'dist' },
              rackLiftLevel !== null ? [' · Hold ', kbd('E'), ` · L${rackLiftLevel + 1}`] : [' · ', kbd('E')],
            )
          : null,
      ]);

      // ---- order choice + rival ----
      const off = store.myFareOffer();
      const offKey = fareOfferKey(off);
      const pills = off && offKey ? optionPills(off, store.ui.fareSel) : [];
      const rivalText = rivalPillText(me.rivalId, store.world.vehicles, me.sPts);
      const draftText = me.rivalId ? rivalDraftText(store.myHand(), store.side.cardDecisions.get(me.rivalId)) : null;
      // My rival's latest real Gemini decision (`brainDecision`): verbatim note + measured latency.
      const reasonText = me.rivalId ? rivalReasonText(store.vehicle(me.rivalId), store.brainDecisions.get(me.rivalId)) : null;
      fareEl.hidden = !pills.length && !rivalText && !draftText && !reasonText;
      if (!fareEl.hidden) {
        fareView.render(JSON.stringify([offKey, store.ui.fareSel, off?.reason ?? '', Boolean(rivalText), draftText, reasonText]), () => {
          const rows: HTMLElement[] = [];
          if (off && pills.length) {
            rows.push(
              el('div', { class: 'fare-row' }, [
                off.carpool ? el('span', { class: 'fare-tag', text: 'Carpool' }) : null,
                ...pills.map((p) =>
                  el(
                    'button',
                    {
                      class: `fare-pill${p.highlighted ? ' highlighted' : ''}${p.isCopilot ? ' copilot' : ''}`,
                      title: p.title,
                      attrs: {
                        type: 'button',
                        'data-role': 'fare-option',
                        'data-order-id': String(p.orderId),
                        'aria-pressed': p.highlighted ? 'true' : 'false',
                      },
                      onClick: () => actions.chooseOrder(p.orderId),
                    },
                    [
                      el('i', { class: 'fare-dot', style: { background: p.classColor }, attrs: { 'aria-hidden': 'true' } }),
                      el('b', { text: p.label }),
                      el('span', { class: 'num', text: p.valueText }),
                      el('span', { class: 'muted num', text: p.parText }),
                      p.isCopilot ? el('span', { class: 'fare-star', text: '★', title: 'Co-Pilot pick' }) : null,
                    ],
                  ),
                ),
                el('span', { class: 'fare-countdown num', text: countdownText(off, store.world.t) }),
                el('span', { class: 'fare-keys' }, [kbd(FARE_CYCLE_KEY), ' cycle · ', kbd(FARE_CONFIRM_KEY), ' reserve']),
              ]),
            );
            if (off.reason) rows.push(el('div', { class: 'fare-reason', text: `Co-Pilot: ${off.reason}`, title: off.reason }));
          }
          if (rivalText || draftText || reasonText) {
            rows.push(
              el('div', { class: 'fare-row rival' }, [
                rivalText ? el('span', { class: 'rival-pill num', text: rivalText, attrs: { 'data-role': 'rival-pill' } }) : null,
                draftText ? el('span', { class: 'rival-draft', text: draftText, title: draftText, attrs: { 'data-role': 'rival-draft' } }) : null,
                reasonText
                  ? el('span', { class: 'rival-reason', text: `🧠 ${reasonText}`, title: reasonText, attrs: { 'data-role': 'rival-reason' } })
                  : null,
              ]),
            );
          }
          return rows;
        });
        const cdEl = fareEl.querySelector<HTMLElement>('.fare-countdown');
        if (cdEl && off) {
          const cdText = countdownText(off, store.world.t);
          if (cdEl.textContent !== cdText) cdEl.textContent = cdText;
        }
        const rpEl = fareEl.querySelector<HTMLElement>('[data-role="rival-pill"]');
        if (rpEl && rivalText && rpEl.textContent !== rivalText) {
          rpEl.textContent = rivalText;
        }
      }

      // ---- alert: one line, newest wins ----
      const now = Date.now();
      const cond = alertView(me, store.world.hazards ?? store.world.spills);
      const condKey = cond?.cond ?? null;
      if (shouldRaiseCond(condSeen, condKey, now)) {
        if (cond) store.ui.alert = { text: cond.text, tone: cond.tone, at: now, until: now + ALERT_MS, cond: cond.cond };
      }
      const a = shownAlert(store.ui.alert, cond, Boolean(offer && toSite), now);
      alertEl.hidden = !a;
      if (!a) {
        alertKv.invalidate();
        return;
      }
      alertEl.className = `hud${a.tone === 'warn' ? ' warn' : ''}`;
      alertEl.dataset.role = 'alert-line';
      alertKv.render(JSON.stringify([a.text, a.tone, a.action ?? '', a.at]), () => {
        if (a.action === 'relocation' && offer && toSite) {
          const accept = button(`Relocate (+${offer.bonusPts})`, 'go small', () => actions.acceptRelocation(toSite), `Move to ${toSite.toUpperCase()} and keep your score, streak and completed perks`);
          accept.dataset.action = 'accept-relocation';
          const dismiss = button('✕', 'x', () => actions.dismissRelocation(), 'Dismiss surge relocation offer');
          dismiss.dataset.action = 'dismiss-relocation';
          return [el('span', { text: a.text }), accept, dismiss];
        }
        return [el('span', { text: a.text })];
      });
    },
  };
}
