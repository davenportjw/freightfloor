/**
 * Out-of-Charge End-of-Run modal overlay.
 * Appears when the player's driven vehicle runs out of battery (0%), summarizing
 * the run's score, deliveries, rank, and safety record, and offering a one-click
 * "Retry — Start Run N+1" action.
 */
import type { RunEndSummary } from '../state.js';
import type { UiCtx, UiModule } from './context.js';
import { button, el } from './dom.js';

/** Fare-core run stats: best combo, SPEEDY share of rated trips, cards completed. */
export function runEndFareStats(
  s: Pick<RunEndSummary, 'comboBest' | 'fareTrips' | 'speedyTrips' | 'cardsDone'>,
): Array<{ label: string; value: string; tone: string }> {
  const best = s.comboBest ?? 1;
  const trips = s.fareTrips ?? 0;
  const speedy = s.speedyTrips ?? 0;
  const cards = s.cardsDone ?? 0;
  return [
    { label: 'Best Combo', value: `×${best.toFixed(1)}`, tone: best >= 2 ? 'accent' : '' },
    {
      label: 'Speedy Trips',
      value: trips > 0 ? `${Math.round((100 * speedy) / trips)}% (${speedy}/${trips})` : '—',
      tone: trips > 0 && speedy / trips >= 0.5 ? 'good' : '',
    },
    { label: 'Cards Completed', value: String(cards), tone: cards > 0 ? 'good' : '' },
  ];
}

export function mountRunEnd(overlay: HTMLElement, ctx: UiCtx): UiModule {
  let lastRenderedSummary: RunEndSummary | null = null;

  function renderModal(s: RunEndSummary): void {
    const isBattery = s.reason === 'battery';
    const retryBtn = button(
      isBattery
        ? `🔋 Try again with a new run (${s.nextRunName})`
        : `⚡ Play Another 5-Min Blitz (${s.nextRunName})`,
      'btn drive run-end-retry',
      () => ctx.actions.retryNewRun('blitz'),
      `Start a fresh 5-Minute Blitz run as ${s.nextRunName} with 100% battery and new contract cards`,
    );
    const freeRangeBtn = button(
      '🌐 Continue in Free Range',
      'btn',
      () => ctx.actions.retryNewRun('freerange'),
      'Switch to open-ended Free Range mode with no countdown timer',
    );
    const spectateBtn = button(
      'View Leaderboard & Awards',
      'btn',
      () => {
        ctx.store.ui.runEnd = null;
        ctx.actions.showLeaderboardModal(true, 'all');
        ctx.actions.refresh();
      },
      'Dismiss summary and open the full Leaderboard & Silly Awards modal',
    );

    const statBox = (label: string, val: string, tone = ''): HTMLElement =>
      el('div', { class: `run-end-stat ${tone}`.trim() }, [
        el('div', { class: 'run-end-stat-val', text: val }),
        el('div', { class: 'run-end-stat-lbl', text: label }),
      ]);

    const badgeText = isBattery
      ? `🪫 OUT OF CHARGE · RUN ${s.runNumber} COMPLETE`
      : `🏁 5-MINUTE BLITZ COMPLETE · RUN ${s.runNumber}`;
    const subText = isBattery
      ? `${s.playerName} (${s.vehicleId}) ran out of battery on Day ${s.day}, Shift ${s.shift}. Your run score has been recorded on the leaderboard.`
      : `${s.playerName} (${s.vehicleId}) completed a 5-Minute Blitz on Day ${s.day}, Shift ${s.shift}. Your score and pace have been recorded on the leaderboard.`;

    const card = el(
      'div',
      {
        class: 'hud run-end-card',
        attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'runEndTitle' },
      },
      [
        el('div', { class: 'run-end-badge', text: badgeText }),
        el('h2', {
          class: 'run-end-title',
          text: "Thanks for playing — here's how you did",
          attrs: { id: 'runEndTitle' },
        }),
        el('p', {
          class: 'run-end-sub',
          text: subText,
        }),
        el('div', { class: 'run-end-stats' }, [
          statBox('Final Score', `${s.score} pts`, 'accent'),
          statBox('Pallets Shipped', `${s.deliveries}`, 'good'),
          ...(typeof s.ppm === 'number'
            ? [statBox('Pace (PPM)', `${s.ppm.toFixed(1)} /m`, s.ppm >= 2 ? 'good' : '')]
            : []),
          ...(typeof s.bestStreak === 'number'
            ? [statBox('Best Streak', `🔥 ×${s.bestStreak}`, s.bestStreak >= 3 ? 'accent' : '')]
            : []),
          statBox('Shift Rank', `#${s.rank} of ${s.totalVehicles}`),
          statBox(
            'Safety Record',
            s.incidents === 0 ? 'Clean (0 crashes)' : `${s.incidents} crash${s.incidents === 1 ? '' : 'es'}`,
            s.incidents === 0 ? 'good' : 'warn',
          ),
          ...runEndFareStats(s).map((x) => statBox(x.label, x.value, x.tone)),
        ]),
        el('div', {
          class: 'run-end-tip',
          text: 'Tip: Chain 3, 5, and 8 on-time deliveries for up to 1.5× streak points, and roll onto any south-wall ⚡ charger pad for a 6-second fast pit-stop!',
        }),
        el('div', { class: 'run-end-actions' }, [retryBtn, freeRangeBtn, spectateBtn]),
      ],
    );
    overlay.replaceChildren(card);
    retryBtn.focus();
  }

  return {
    update() {
      const summary = ctx.store.ui.runEnd;
      const open = summary !== null;
      if (!open) {
        if (!overlay.hidden) overlay.hidden = true;
        lastRenderedSummary = null;
        return;
      }
      if (overlay.hidden) overlay.hidden = false;
      if (summary !== lastRenderedSummary) {
        lastRenderedSummary = summary;
        renderModal(summary);
      }
    },
  };
}
