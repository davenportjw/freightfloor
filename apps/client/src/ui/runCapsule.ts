/**
 * DRIVE HUD → `#run` capsule (top centre): run clock (Blitz) or PPM (Free Range) · points + 🔥 streak ·
 * combo multiplier with 4 pips · position P n/total with ▲/▼ vs the start of the run.
 * Every number is read from the driven vehicle / live leaderboard; nothing is invented.
 */
import { computeDriverPpm, leaderboard, type Vehicle, type World } from '@warehouse/sim';
import { comboMeter, formatBlitzRemaining } from './commandBar.js';
import type { UiCtx, UiModule } from './context.js';
import { el, KeyedView } from './dom.js';
import { DASH } from './format.js';
import { showComboMeter } from './runOne.js';

export interface RunCapsuleView {
  mode: 'blitz' | 'freerange';
  /** Big text of the first segment: "04:12" (Blitz) or "3.4" (PPM). */
  clock: string;
  clockSub: string;
  /** Last minute of a Blitz. */
  overdrive: boolean;
  pts: string;
  streak: number;
  /** Progressive disclosure: combo pips appear after the first delivery of the run. */
  showCombo: boolean;
  combo: ReturnType<typeof comboMeter>;
  comboText: string;
  pos: string;
  posSub: string;
  /** Positions gained (+) / lost (−) since the run started; null when unknown. */
  delta: number | null;
}

export function runCapsuleView(
  me: Vehicle,
  w: Pick<World, 't'>,
  rows: ReadonlyArray<{ id: string }>,
  startRank: number | null,
): RunCapsuleView {
  const mode = me.runMode === 'freerange' ? 'freerange' : 'blitz';
  const rem = me.runEndsAt != null ? Math.max(0, me.runEndsAt - w.t) : null;
  const idx = rows.findIndex((r) => r.id === me.id);
  const rank = idx >= 0 ? idx + 1 : null;
  const streak = me.streak ?? 0;
  const combo = comboMeter(me.combo);
  return {
    mode,
    clock: mode === 'blitz' ? (me.runEndsAt != null ? formatBlitzRemaining(me, w.t) : DASH) : computeDriverPpm(me, w.t).toFixed(1),
    clockSub: mode === 'blitz' ? (me.runEndsAt != null ? 'Blitz' : 'Blitz · starts on move') : 'PPM · Free Range',
    overdrive: mode === 'blitz' && rem != null && rem <= 60,
    pts: String(Math.round(me.runPts ?? me.sPts ?? 0)),
    streak,
    showCombo: showComboMeter(me),
    combo,
    comboText: combo.label.replace(/^COMBO\s*/, ''),
    pos: rank ? `P${rank}` : DASH,
    posSub: rank ? `of ${rows.length}` : 'position',
    delta: rank && startRank ? startRank - rank : null,
  };
}

export function mountRunCapsule(root: HTMLElement, ctx: UiCtx): UiModule {
  const view = new KeyedView(root);
  return {
    update() {
      const { store, actions } = ctx;
      const me = store.hudMode() === 'driving' ? store.myVehicle() : null;
      root.hidden = !me;
      if (!me) {
        view.invalidate();
        return;
      }
      const rows = leaderboard(store.world);
      const start = store.ui.runStartRank?.vid === me.id ? store.ui.runStartRank.rank : null;
      const v = runCapsuleView(me, store.world, rows, start);
      // Run 1 (drive-first onboarding) is Blitz only: the mode toggle is locked until Run 2.
      const modeLocked = Boolean(store.driveFirst);
      view.render(JSON.stringify([v, modeLocked]), () => {
        const modeSeg = el(
          'button',
          {
            class: `seg seg-mode ${v.mode}${v.overdrive ? ' overdrive' : ''}`,
            title: modeLocked
              ? '3-Minute Blitz — Free Range unlocks after your first run'
              : v.mode === 'blitz'
                ? '3-Minute Blitz — click to switch to open-ended Free Range'
                : 'Free Range (no timer, scored by pallets per minute) — click to start a 3-Minute Blitz',
            attrs: { type: 'button', 'data-role': 'run-mode-pill', ...(modeLocked ? { disabled: '' } : {}) },
            onClick: () => {
              if (!modeLocked) actions.setRunMode(v.mode === 'blitz' ? 'freerange' : 'blitz');
            },
          },
          [el('span', { class: 'big num', text: v.clock }), el('span', { class: 'sub', text: v.clockSub })],
        );
        return [
          modeSeg,
          el('div', { class: 'seg' }, [
            el('span', { class: 'big num' }, [
              v.pts,
              v.streak > 0
                ? el('span', {
                    class: `streak${v.streak >= 3 ? ' hot' : ''}`,
                    attrs: { 'data-role': 'streak-pill' },
                    title: 'On-time streak: consecutive on-time deliveries. Resets on a late delivery, crash or pallet drop.',
                    text: ` 🔥${v.streak}`,
                  })
                : null,
            ]),
            el('span', { class: 'sub', text: v.streak > 0 ? `pts · ${v.streak} streak` : 'pts' }),
          ]),
          !v.showCombo
            ? null
            : el(
            'div',
            {
              class: `seg${v.combo.max ? ' max' : ''}`,
              attrs: { 'data-role': 'combo-meter' },
              title: 'Fare combo: SPEEDY/NORMAL trips climb ×1.0 → ×1.2 → ×1.5 → ×2.0; slow trips, crashes, drops and skids reset it.',
            },
            [
              el('span', { class: 'big num', text: v.comboText }),
              el(
                'span',
                { class: 'pips', attrs: { 'aria-label': `combo ${v.comboText}` } },
                v.combo.pips.map((p) => el('i', { class: p.on ? 'on' : '' })),
              ),
            ],
          ),
          el('div', { class: 'seg', title: 'Your position on this floor’s live leaderboard' }, [
            el('span', { class: 'big num' }, [
              v.pos,
              v.delta
                ? el('span', { class: `delta ${v.delta > 0 ? 'up' : 'down'}`, text: v.delta > 0 ? ` ▲${v.delta}` : ` ▼${-v.delta}` })
                : null,
            ]),
            el('span', { class: 'sub', text: v.posSub }),
          ]),
        ];
      });
    },
  };
}
