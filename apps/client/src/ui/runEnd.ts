/**
 * HUD v3 results sheet (760 px, centred over a scrim) shown when the driven run finishes:
 * - Clean header with run mode/reason and operator/shift context
 * - Four stat boxes: points (with vs prev run / PB delta), position (with ▲/▼ from start),
 *   deliveries + PPM + speedy share, and best combo / on-time %
 * - Progression & rival callout bar (PB / delta vs previous run, and next rival or #1 status)
 * - Compact embedded leaderboard table with filter tabs (All: Humans + AI vs Human Runs Only)
 * - AI telemetry coach line and contracts outcome line
 * - Footer actions: Full Standings, Watch the floor, Play again ↵
 * Every number comes from `ui.runEnd` (built from the live vehicle and world in main.ts checkRunEnd).
 */
import { isLeaseEvictionReason, type RunEndLeaderboardRow, type RunEndSummary } from '../state.js';
import type { UiCtx, UiModule } from './context.js';
import { button, el, kbd } from './dom.js';
import { presenceView } from './presence.js';
import { createFocusTrap, type TrapContainer } from './focusTrap.js';
import { recapDecisionText, recapDirectiveText } from './aiInsight.js';
import { runDeltaHeadline } from './runOne.js';

export type RunEndFilterTab = 'all' | 'humans';

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

/** "P3/12 ▲2 from start" — the ▲/▼ part only when the starting rank is known for this vehicle. */
export function resultsPosition(
  s: Pick<RunEndSummary, 'rank' | 'totalVehicles'>,
  startRank: number | null,
): { value: string; sub: string } {
  const value = `P${s.rank}/${s.totalVehicles}`;
  if (startRank == null) return { value, sub: 'final position' };
  const d = startRank - s.rank;
  return { value, sub: d > 0 ? `▲${d} from start` : d < 0 ? `▼${-d} from start` : 'same as start' };
}

/** Contract outcome per card in the hand: ✓ done, ✕ lost / expired / unfinished. */
export function contractsLine(cards: ReadonlyArray<{ title: string; status: string }>): string {
  if (!cards.length) return 'No contracts this run.';
  return cards.map((c) => `${c.status === 'done' ? '✓' : '✕'} ${c.title}`).join('  ·  ');
}

/**
 * Selects up to `maxRows` leaderboard rows to display in the Blitz Complete dialog,
 * guaranteeing that Top 3, the player's current run, and the player's past runs are included
 * when they fit or prioritized around the player's rank.
 */
export function selectRunEndRows(
  rows: ReadonlyArray<RunEndLeaderboardRow>,
  tab: RunEndFilterTab,
  maxRows = 6,
): RunEndLeaderboardRow[] {
  const filtered = tab === 'humans' ? rows.filter((r) => r.isHuman) : rows.slice();
  if (filtered.length <= maxRows) return filtered;

  const pickedIndices = new Set<number>();
  // Always include top 3
  for (let i = 0; i < Math.min(3, filtered.length); i++) pickedIndices.add(i);

  // Include current run and rival above
  const myIdx = filtered.findIndex((r) => r.isYou);
  if (myIdx >= 0) {
    if (myIdx - 1 >= 0 && pickedIndices.size < maxRows) pickedIndices.add(myIdx - 1);
    pickedIndices.add(myIdx);
  }

  // Include most recent past run(s) of the same user if room remains
  for (let i = 0; i < filtered.length && pickedIndices.size < maxRows; i++) {
    if (filtered[i]!.isYourPastRun) pickedIndices.add(i);
  }

  // Include neighbor below current run if room remains
  if (myIdx >= 0 && myIdx + 1 < filtered.length && pickedIndices.size < maxRows) {
    pickedIndices.add(myIdx + 1);
  }

  // Fill remaining slots from top down
  for (let i = 0; i < filtered.length && pickedIndices.size < maxRows; i++) {
    pickedIndices.add(i);
  }

  return Array.from(pickedIndices)
    .sort((a, b) => a - b)
    .slice(0, maxRows)
    .map((idx) => filtered[idx]!);
}

export function mountRunEnd(overlay: HTMLElement, ctx: UiCtx): UiModule {
  let lastRenderedSummary: RunEndSummary | null = null;
  let activeTab: RunEndFilterTab = 'all';
  const focusTrap = createFocusTrap(overlay as unknown as TrapContainer<HTMLElement>);
  /** The primary "Run again" button of the last render (initial focus for the trap). */
  let playAgainBtn: HTMLElement | null = null;

  function render(s: RunEndSummary): void {
    const { store, actions } = ctx;
    const start = store.ui.runStartRank?.vid === s.vehicleId ? store.ui.runStartRank.rank : null;
    const pos = resultsPosition(s, start);
    const trips = s.fareTrips ?? 0;
    const speedy = s.speedyTrips ?? 0;
    const cards = (store.myHand()?.cards ?? []).filter((c) => c.status !== 'offer');

    const box = (value: string, label: string, tone = ''): HTMLElement =>
      el('div', { class: `stat ${tone}`.trim() }, [
        el('div', { class: 'stat-val num', text: value }),
        el('div', { class: 'sub', text: label }),
      ]);

    // Points subtitle: compare with previous run if available
    let ptsSub = 'points';
    if (s.previousRunPts !== undefined && s.previousRunNumber !== undefined) {
      const diff = s.score - s.previousRunPts;
      const sign = diff > 0 ? `+${diff}` : String(diff);
      ptsSub = `points (${sign} vs Run ${s.previousRunNumber})`;
    } else if (s.bestRunPts !== undefined && s.score >= s.bestRunPts && s.runNumber > 1) {
      ptsSub = 'points · New PB!';
    }

    const delivSub =
      trips > 0
        ? `deliveries · ${s.ppm.toFixed(1)}/m · ${speedy} speedy`
        : `deliveries · ${s.ppm.toFixed(1)}/m`;

    // Progression & Rival Callout Bar
    const contextPills: HTMLElement[] = [];
    if (s.previousRunPts !== undefined && s.previousRunNumber !== undefined) {
      const diff = s.score - s.previousRunPts;
      const isPb = s.bestRunPts !== undefined && s.score >= s.bestRunPts;
      const text = isPb
        ? `★ Personal Best (${diff >= 0 ? '+' : ''}${diff} pts vs Run ${s.previousRunNumber})`
        : `${diff >= 0 ? '+' : ''}${diff} pts vs Run ${s.previousRunNumber} (PB: ${s.bestRunPts ?? s.score} pts)`;
      contextPills.push(
        el('span', {
          class: `results-pill ${diff >= 0 ? 'good' : 'warn'}`,
          attrs: { 'data-role': 'progression-pill' },
          text,
        }),
      );
    } else {
      contextPills.push(
        el('span', {
          class: 'results-pill good',
          attrs: { 'data-role': 'progression-pill' },
          text: `★ Baseline set: ${s.score} pts on Run ${s.runNumber}`,
        }),
      );
    }

    if (s.rivalNext) {
      const tag = s.rivalNext.isAi ? 'AI' : 'Human';
      contextPills.push(
        el('span', {
          class: 'results-pill rival',
          attrs: { 'data-role': 'rival-pill' },
          text: `${s.rivalNext.ptsAhead} pts behind #${s.rivalNext.rank} ${s.rivalNext.driver} (${tag})`,
        }),
      );
    } else {
      contextPills.push(
        el('span', {
          class: 'results-pill good',
          attrs: { 'data-role': 'rival-pill' },
          text: '🏆 #1 Overall on 3m Blitz Standings',
        }),
      );
    }

    // Embedded Leaderboard Section
    const allRows = s.leaderboardRows ?? [];
    const humanCount = allRows.filter((r) => r.isHuman).length;
    const tabAllBtn = el('button', {
      class: `seg-btn ${activeTab === 'all' ? 'active' : ''}`.trim(),
      text: `All: Humans + AI (${allRows.length})`,
      attrs: {
        type: 'button',
        role: 'tab',
        'aria-selected': String(activeTab === 'all'),
        'data-tab': 'all',
      },
    });
    tabAllBtn.addEventListener('click', () => {
      if (activeTab !== 'all') {
        activeTab = 'all';
        render(s);
      }
    });

    const tabHumansBtn = el('button', {
      class: `seg-btn ${activeTab === 'humans' ? 'active' : ''}`.trim(),
      text: `Human Runs Only (${humanCount})`,
      attrs: {
        type: 'button',
        role: 'tab',
        'aria-selected': String(activeTab === 'humans'),
        'data-tab': 'humans',
      },
    });
    tabHumansBtn.addEventListener('click', () => {
      if (activeTab !== 'humans') {
        activeTab = 'humans';
        render(s);
      }
    });

    const displayedRows = selectRunEndRows(allRows, activeTab, 6);
    const tbody = el('tbody');
    for (const r of displayedRows) {
      const displayRank =
        activeTab === 'humans'
          ? allRows.filter((x) => x.isHuman).findIndex((x) => x.id === r.id) + 1
          : r.rank;
      const badgeLabel = r.isYou
        ? 'YOU · NOW'
        : r.isYourPastRun
          ? `YOU · RUN ${r.runNumber}`
          : r.isHuman
            ? 'HUMAN'
            : 'AI · 3M PACE';
      const badgeTone = r.isYou ? 'you' : r.isYourPastRun ? 'past' : r.isHuman ? 'human' : 'ai';

      const tr = el(
        'tr',
        {
          class: [
            r.isYou ? 'me' : '',
            r.isYourPastRun ? 'past-run' : '',
            !r.isArchived ? 'clickable' : '',
          ]
            .filter(Boolean)
            .join(' '),
          attrs: {
            'data-vid': r.id,
            ...(r.isArchived
              ? {}
              : { title: `Inspect ${r.driver} (${r.id}) on the floor` }),
          },
        },
        [
          el('td', { class: 'num b', text: `#${displayRank}` }),
          el('td', { class: 'grow' }, [
            el('span', { class: 'driver-name', text: r.driver }),
            el('span', { class: `role-badge ${badgeTone}`, text: badgeLabel }),
          ]),
          el('td', { class: 'num r b', text: String(r.score) }),
          el('td', { class: 'num r', text: String(r.deliveries) }),
          el('td', { class: 'num r', text: r.ppm.toFixed(1) }),
          el('td', { class: 'num r', text: `${r.onTimePct}%` }),
        ],
      );

      if (!r.isArchived) {
        tr.addEventListener('click', () => {
          actions.select(r.id);
          actions.dismissRunEnd();
        });
      }
      tbody.append(tr);
    }

    const lbTable = el('table', { class: 'tbl results-lb-table', attrs: { 'data-role': 'results-leaderboard' } }, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: '#' }),
          el('th', { text: 'Driver / Run' }),
          el('th', { class: 'r', text: '3m Pts' }),
          el('th', { class: 'r', text: 'Pallets' }),
          el('th', { class: 'r', text: 'PPM' }),
          el('th', { class: 'r', text: 'On-Time' }),
        ]),
      ]),
      tbody,
    ]);

    // AI Benchmark Telemetry Coach Line
    let aiCoachEl: HTMLElement | null = null;
    if (s.aiBenchmark) {
      const ppmDelta = Math.round((s.ppm - s.aiBenchmark.topAiPpm) * 10) / 10;
      const ppmSign = ppmDelta >= 0 ? `+${ppmDelta.toFixed(1)}` : ppmDelta.toFixed(1);
      aiCoachEl = el('div', {
        class: 'results-ai-coach',
        attrs: { 'data-role': 'ai-benchmark' },
        text: `vs Top AI (${s.aiBenchmark.topAiDriver} · ${s.aiBenchmark.topAiPts} pts @ ${s.aiBenchmark.topAiPpm.toFixed(1)}/m): Your pace ${s.ppm.toFixed(1)}/m (${ppmSign}/m) · On-time ${s.onTimePct}% vs ${s.aiBenchmark.topAiOnTimePct}%`,
      });
    }

    // Headline vs the last finished run in this browser (local), else this shift's previous run.
    const lastPts = s.lastRunPts ?? s.previousRunPts ?? null;
    const deltaText = runDeltaHeadline(s.score, lastPts);
    const deltaEl = deltaText
      ? el('span', {
          class: `run-delta ${deltaText.startsWith('▲') ? 'up' : deltaText.startsWith('▼') ? 'down' : ''}`,
          attrs: { 'data-role': 'run-delta' },
          title: `Last run: ${Math.round(lastPts ?? 0)} pts`,
          text: deltaText,
        })
      : null;

    // "You vs Gemini": real rival decisions (verbatim note + latency) and my Co-Pilot echoes.
    const recap = s.recap;
    const recapEl =
      recap && (recap.rival.length || recap.directives.length)
        ? el('div', { class: 'ai-recap', attrs: { 'data-role': 'ai-recap' } }, [
            el('h4', { text: 'You vs Gemini' }),
            recap.rival.length
              ? el(
                  'ul',
                  { attrs: { 'data-role': 'ai-recap-rival' } },
                  recap.rival.map((r) => el('li', { text: recapDecisionText(r) })),
                )
              : null,
            recap.directives.length
              ? el('div', {}, [
                  el('span', { class: 'sub', text: 'Your Co-Pilot directives' }),
                  el(
                    'ul',
                    { attrs: { 'data-role': 'ai-recap-directives' } },
                    recap.directives.map((d) => el('li', { text: recapDirectiveText(d) })),
                  ),
                ])
              : null,
          ])
        : null;

    const fullStandingsBtn = button(
      'Full Standings',
      'ghost',
      () => {
        actions.dismissRunEnd();
        actions.showLeaderboardModal(true, 'all');
      },
      'Open full shift standings modal',
    );
    fullStandingsBtn.dataset.role = 'full-standings';

    const pres = presenceView(store);
    const queue = store.queue;
    const isQueuedOrFull = pres.full || Boolean(queue && (queue.state === 'queued' || queue.state === 'ready'));
    const evictedReason =
      store.evictedReason ??
      (s.reason === 'idle_timeout' || s.reason === 'run_complete' || isLeaseEvictionReason(s.reason)
        ? s.reason
        : null);

    const slotStatusText =
      evictedReason === 'idle_timeout'
        ? '● Session ended due to inactivity · Re-enter line to drive'
        : isLeaseEvictionReason(evictedReason)
          ? '● Contention lease expired · Forklift released for the next driver in line'
          : '● Shift complete · Forklift released for the next driver in line';

    const slotStatusEl = el('div', {
      class: 'ct-line muted',
      attrs: { 'data-role': 'slot-status' },
      text: slotStatusText,
    });

    let queueRowEl: HTMLElement | null = null;
    if (queue?.state === 'queued') {
      const totalQueued = queue.totalQueued ?? queue.queueSize ?? queue.position ?? 1;
      const waitSec = queue.estimatedWaitSec ?? 0;
      const autoBtn = button(
        `Auto-Drive: ${store.autoClaimSeat ? 'ON' : 'OFF'}`,
        'ghost',
        () => actions.toggleAutoClaimSeat(),
        'Automatically claim your forklift when your seat lease is ready',
      );
      autoBtn.dataset.role = 'toggle-auto-claim';
      const leaveBtn = button(
        'Leave Line',
        'ghost',
        () => actions.leaveQueue(),
        'Leave the waiting line and continue watching the floor',
      );
      leaveBtn.dataset.role = 'leave-queue';
      queueRowEl = el(
        'div',
        { class: 'ct-line', attrs: { 'data-role': 'queue-status' } },
        [
          el('span', {
            text: `● Waiting in line · #${queue.position ?? 1} of ${totalQueued} · ~${waitSec}s est. wait `,
          }),
          autoBtn,
          leaveBtn,
        ],
      );
    } else if (queue?.state === 'ready') {
      const targetSite = (queue.claimSiteId ?? queue.assignedSiteId ?? store.siteId ?? 'den-1').toUpperCase();
      const claimBtn = button(
        '',
        'go',
        () => actions.claimQueueSeat(),
        `Claim your reserved driver seat on ${targetSite}`,
      );
      claimBtn.append('🚜 Take the Wheel ', kbd('↵'));
      claimBtn.dataset.role = 'claim-seat';
      queueRowEl = el(
        'div',
        { class: 'ct-line', attrs: { 'data-role': 'queue-status' } },
        [
          el('span', { text: `● Forklift Ready on ${targetSite} ` }),
          claimBtn,
        ],
      );
    }

    const again = button(
      '',
      'go',
      () => actions.retryNewRun('blitz'),
      isQueuedOrFull
        ? `Join the FIFO waiting line for ${s.nextRunName}`
        : `Start ${s.nextRunName} with a fresh vehicle and new contracts`,
    );
    again.append(isQueuedOrFull ? 'Get Back in Line ' : 'Run again ', kbd('↵'));
    again.dataset.role = 'play-again';
    again.setAttribute('data-role', 'play-again');
    playAgainBtn = again;

    // One primary action (Run again ↵); secondary actions use the ghost button style.
    const freeRangeBtn = button(
      'Free Range',
      'ghost',
      () => actions.retryNewRun('freerange'),
      'Switch to open-ended Free Range mode with no countdown timer',
    );
    freeRangeBtn.dataset.role = 'go-freerange';
    freeRangeBtn.setAttribute('data-role', 'go-freerange');

    const watch = button(
      'Watch the floor',
      'ghost',
      () => actions.dismissRunEnd(),
      'Close the results and manage the floor',
    );
    watch.dataset.role = 'watch-floor';

    const reason =
      s.reason === 'battery'
        ? '🪫 Out of charge'
        : evictedReason === 'idle_timeout'
          ? '⏱ Session Idle'
          : isLeaseEvictionReason(evictedReason)
            ? '⏱ Lease Complete'
            : s.runMode === 'freerange'
              ? '🏁 Run over'
              : '🏁 Blitz complete';

    const card = el(
      'div',
      {
        class: 'hud sheet results',
        attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'runEndTitle' },
      },
      [
        el('div', { class: 'sheet-head' }, [
          el('h2', { text: `${reason} · Run ${s.runNumber}`, attrs: { id: 'runEndTitle' } }),
          el('span', { class: 'muted', text: `${s.playerName} · Day ${s.day} · Shift ${s.shift}` }),
          deltaEl,
        ]),
        slotStatusEl,
        ...(queueRowEl ? [queueRowEl] : []),
        el('div', { class: 'stats4' }, [
          box(String(s.score), ptsSub, 'accent'),
          box(pos.value, pos.sub),
          box(String(s.deliveries), delivSub),
          box(`×${(s.comboBest ?? 1).toFixed(1)}`, `best combo · ${s.onTimePct}% on-time`),
        ]),
        el('div', { class: 'results-context-bar', attrs: { 'data-role': 'results-context' } }, contextPills),
        el('div', { class: 'results-lb' }, [
          el('div', { class: 'results-lb-head' }, [
            el('span', { class: 'sub', text: '3-Minute Blitz Standings (Normalized Pace)' }),
            el('div', { class: 'seg-tabs', attrs: { role: 'tablist' } }, [tabAllBtn, tabHumansBtn]),
          ]),
          lbTable,
        ]),
        ...(aiCoachEl ? [aiCoachEl] : []),
        ...(recapEl ? [recapEl] : []),
        el('div', { class: 'ct-line', attrs: { 'data-role': 'results-contracts' }, text: contractsLine(cards) }),
        el('div', { class: 'sheet-foot' }, [
          fullStandingsBtn,
          el('span', { class: 'grow' }),
          watch,
          freeRangeBtn,
          again,
        ]),
      ],
    );
    overlay.replaceChildren(card);
    again.focus();
  }

  let lastRenderKey = '';

  return {
    update() {
      const summary = ctx.store.ui.runEnd;
      // Single modal policy: a modal opened over the results (e.g. Full standings) suspends the
      // sheet, so it is hidden (not just covered) and can never take Enter while invisible.
      const shown = summary !== null && ctx.store.activeOverlay() === 'results';
      if (!summary || !shown) {
        if (!overlay.hidden) overlay.hidden = true;
        focusTrap.deactivate();
        if (!summary) {
          lastRenderedSummary = null;
          lastRenderKey = '';
        }
        return;
      }
      if (overlay.hidden) overlay.hidden = false;
      if (!focusTrap.active) focusTrap.activate(playAgainBtn);
      const pres = presenceView(ctx.store);
      const q = ctx.store.queue;
      const renderKey = JSON.stringify([
        summary.vehicleId,
        summary.score,
        summary.reason,
        ctx.store.evictedReason,
        pres.full,
        ctx.store.autoClaimSeat,
        q?.state,
        q?.position,
        q?.totalQueued ?? q?.queueSize,
        q?.estimatedWaitSec,
        q?.seatLeaseId,
      ]);
      if (summary !== lastRenderedSummary || renderKey !== lastRenderKey) {
        if (summary !== lastRenderedSummary) activeTab = 'all';
        lastRenderedSummary = summary;
        lastRenderKey = renderKey;
        render(summary);
      }
    },
  };
}
