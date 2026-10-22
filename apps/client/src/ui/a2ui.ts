/**
 * Dynamic Agent-to-UI (A2UI) Intent & Objective Clarification Screen.
 *
 * Mounted in `#a2uiZone` above the bottom Command Bar. Renders real-time
 * floor telemetry, interactive source/destination/priority/batch selectors,
 * and 1-click objective presets computed dynamically by the site server.
 */
import type {
  A2uiScreenMessage,
  DispatchMode,
  DispatchParams,
  DispatchPriority,
  DispatchSourceZone,
  DispatchTargetBay,
} from '@warehouse/protocol';
import type { UiCtx, UiModule } from './context.js';
import { button, el, KeyedView } from './dom.js';
import {
  dcCanPick,
  dcRevealLine,
  dcSecondsLeft,
  dcTimeLeft,
  dcVisible,
  type DispatchersCallCard,
} from './dispatchersCall.js';

/** Dispatcher's Call card: question, countdown ring, option chips, then the reveal line. */
function renderDispatchersCall(
  dc: DispatchersCallCard,
  canPick: boolean,
  secs: number,
  pick: (idx: number) => void,
): HTMLElement[] {
  const m = dc.minigame;
  const ring = el('div', {
    class: 'dc-ring num',
    text: dc.reveal || dc.picked != null ? '✓' : String(secs),
    attrs: { 'aria-label': `${secs} seconds left` },
  });
  const header = el('div', { class: 'a2ui-head' }, [
    el('div', { class: 'a2ui-head__titles' }, [
      el('div', { class: 'a2ui-badge', text: "DISPATCHER'S CALL" }),
      el('h3', { class: 'a2ui-title', text: m.question }),
    ]),
    ring,
  ]);
  const chips = el(
    'div',
    { class: 'a2ui-presets__grid' },
    m.options.map((o) => {
      const mine = dc.picked === o.idx;
      const gem = dc.reveal != null && dc.reveal.geminiIdx === o.idx;
      const b = button(
        gem ? `${o.label} · Gemini` : o.label,
        `btn a2ui-preset dc-option${mine ? ' on' : ''}${gem ? ' dc-gemini' : ''}`,
        () => pick(o.idx),
        o.desc,
      );
      b.disabled = !canPick;
      return b;
    }),
  );
  const status = dc.reveal
    ? el('p', { class: `a2ui-subtitle dc-reveal${dc.reveal.agreed ? ' agreed' : ''}`, text: dcRevealLine(dc.reveal) })
    : dc.picked != null
      ? el('p', { class: 'a2ui-subtitle', text: 'Dispatched. Waiting for Gemini…' })
      : canPick
        ? null
        : el('p', { class: 'a2ui-subtitle', text: "Time's up." });
  return status ? [header, chips, status] : [header, chips];
}

/**
 * Honest attribution for the pre-filled dispatch (`a2uiScreen.recommendedSource`): only a
 * model-proposed draft says Gemini; a keyword-match draft says so; absent shows nothing.
 */
export function recommendedSourceLabel(source: A2uiScreenMessage['recommendedSource']): string | null {
  if (source === 'model') return 'Suggested by Gemini';
  if (source === 'heuristic') return 'Pre-filled from your words (keyword match)';
  return null;
}

function defaultDraftFromScreen(screen: A2uiScreenMessage): DispatchParams {
  let sourceZone: DispatchSourceZone = 'haz';
  let targetBay: DispatchTargetBay = 'RET';
  let priority: DispatchPriority = 'p0';
  const mode: DispatchMode = 'reroute_and_spawn';
  let count = 2;

  for (const sel of screen.selectors) {
    if (sel.field === 'sourceZone') {
      sourceZone = sel.selected as DispatchSourceZone;
    } else if (sel.field === 'targetBay') {
      targetBay = sel.selected as DispatchTargetBay;
    } else if (sel.field === 'priority') {
      priority = sel.selected as DispatchPriority;
    } else if (sel.field === 'count') {
      const parsed = Number.parseInt(sel.selected, 10);
      if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 6) {
        count = parsed;
      }
    }
  }

  return { sourceZone, targetBay, priority, mode, count };
}

export function mountA2ui(zone: HTMLElement, ctx: UiCtx): UiModule {
  const { store, actions } = ctx;
  const root = el('div', {
    class: 'hud a2ui-card',
    attrs: {
      role: 'dialog',
      'aria-label': 'Floor Dispatch & Objective Clarification',
    },
  });
  root.hidden = true;
  const view = new KeyedView(root);

  let activeScreenId: string | null = null;
  let draft: DispatchParams = {
    sourceZone: 'haz',
    targetBay: 'RET',
    priority: 'p0',
    mode: 'reroute_and_spawn',
    count: 2,
  };

  zone.append(root);

  return {
    update() {
      // Dispatcher's Call minigame card takes the zone while it is open.
      const now = Date.now();
      if (store.dispatchersCall && !dcVisible(store.dispatchersCall, now)) {
        store.dispatchersCall = null;
      }
      const dc = store.dispatchersCall;
      if (dc) {
        root.hidden = false;
        activeScreenId = null;
        const canPick = dcCanPick(dc, now);
        const secs = dcSecondsLeft(dc, now);
        const key = JSON.stringify(['dc', dc.minigame.id, dc.picked, dc.reveal?.id ?? null, canPick, secs]);
        view.render(key, () => renderDispatchersCall(dc, canPick, secs, (idx) => actions.pickDispatchersCall(idx)));
        const ring = root.querySelector<HTMLElement>('.dc-ring');
        if (ring) ring.style.setProperty('--dc-left', String(dcTimeLeft(dc, now)));
        return;
      }

      const screen = store.activeA2ui;
      if (!screen) {
        root.hidden = true;
        activeScreenId = null;
        view.invalidate();
        return;
      }

      if (screen.screenId !== activeScreenId) {
        activeScreenId = screen.screenId;
        draft = defaultDraftFromScreen(screen);
      }

      root.hidden = false;
      const key = JSON.stringify([
        screen.screenId,
        draft.sourceZone,
        draft.targetBay,
        draft.priority,
        draft.count,
        screen.telemetry,
        screen.recommendedSource ?? null,
      ]);

      const sourceLabel = recommendedSourceLabel(screen.recommendedSource);
      view.render(key, () => {
        const header = el('div', { class: 'a2ui-head' }, [
          el('div', { class: 'a2ui-head__titles' }, [
            el('div', { class: 'a2ui-badge', text: 'A2UI · FLOOR OBJECTIVE BUILDER' }),
            el('h3', { class: 'a2ui-title', text: screen.title }),
            el('p', { class: 'a2ui-subtitle', text: screen.subtitle }),
            ...(sourceLabel
              ? [el('p', { class: 'hint a2ui-source', text: sourceLabel, attrs: { 'data-source': screen.recommendedSource ?? '' } })]
              : []),
          ]),
          button(
            '✕',
            'btn small',
            () => actions.dismissA2ui(),
            'Dismiss objective builder [Esc]',
          ),
        ]);

        const telemetryRow = el(
          'div',
          { class: 'a2ui-telemetry' },
          screen.telemetry.map((t) =>
            el(
              'div',
              {
                class: 'a2ui-stat',
                attrs: t.tone ? { 'data-tone': t.tone } : undefined,
              },
              [
                el('span', { class: 'a2ui-stat__label', text: t.label }),
                el('span', { class: 'a2ui-stat__val num', text: t.value }),
              ],
            ),
          ),
        );

        const presetsRow = el('div', { class: 'a2ui-presets' }, [
          el('span', { class: 'label a2ui-section-label', text: '1-Click Floor Objectives' }),
          el(
            'div',
            { class: 'a2ui-presets__grid' },
            screen.presets.map((p) => {
              const btn = button(
                p.label,
                `btn a2ui-preset${p.dispatch?.priority === 'p0' ? ' warn' : p.managerOp ? ' drive' : ''}`,
                () => {
                  actions.submitA2ui(p.id, p.dispatch, p.managerOp);
                },
                p.desc,
              );
              return btn;
            }),
          ),
        ]);

        const selectorsGrid = el(
          'div',
          { class: 'a2ui-selectors' },
          screen.selectors.map((sel) => {
            const currentVal =
              sel.field === 'sourceZone'
                ? draft.sourceZone
                : sel.field === 'targetBay'
                  ? draft.targetBay
                  : sel.field === 'priority'
                    ? draft.priority
                    : String(draft.count);

            return el('div', { class: 'a2ui-selector-group' }, [
              el('span', { class: 'label a2ui-section-label', text: sel.label }),
              el(
                'div',
                { class: 'a2ui-chips' },
                sel.options.map((opt) => {
                  const active = opt.value === currentVal;
                  const chipText = opt.badge ? `${opt.label} · ${opt.badge}` : opt.label;
                  const chip = button(
                    chipText,
                    `btn small a2ui-chip${active ? ' on' : ''}`,
                    () => {
                      if (sel.field === 'sourceZone') {
                        draft = { ...draft, sourceZone: opt.value as DispatchSourceZone };
                      } else if (sel.field === 'targetBay') {
                        draft = { ...draft, targetBay: opt.value as DispatchTargetBay };
                      } else if (sel.field === 'priority') {
                        draft = { ...draft, priority: opt.value as DispatchPriority };
                      } else if (sel.field === 'count') {
                        draft = {
                          ...draft,
                          count: Math.max(1, Math.min(6, Number.parseInt(opt.value, 10) || 2)),
                        };
                      }
                      view.invalidate();
                      store.changed();
                    },
                  );
                  return chip;
                }),
              ),
            ]);
          }),
        );

        const summaryText = `Route ${draft.count} order(s) from ${draft.sourceZone.toUpperCase()} → ${draft.targetBay} (${(draft.priority ?? 'auto').toUpperCase()})`;
        const footer = el('div', { class: 'a2ui-foot' }, [
          el('span', { class: 'a2ui-summary num', text: summaryText }),
          el('div', { class: 'a2ui-foot__actions' }, [
            button('Dismiss', 'btn', () => actions.dismissA2ui(), 'Close without dispatching'),
            button(
              `🚀 Execute Dispatch (${draft.sourceZone.toUpperCase()} → ${draft.targetBay})`,
              'btn drive a2ui-submit',
              () => actions.submitA2ui('custom_dispatch', draft),
              'Execute this custom floor dispatch immediately',
            ),
          ]),
        ]);

        return [header, telemetryRow, presetsRow, selectorsGrid, footer];
      });
    },
  };
}
