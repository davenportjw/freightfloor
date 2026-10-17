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

function defaultDraftFromScreen(screen: A2uiScreenMessage): DispatchParams {
  let sourceZone: DispatchSourceZone = 'haz';
  let targetBay: DispatchTargetBay = 'RET';
  let priority: DispatchPriority = 'rush';
  const mode: DispatchMode = 'nearest';
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
    priority: 'rush',
    mode: 'nearest',
    count: 2,
  };

  zone.append(root);

  return {
    update() {
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
      ]);

      view.render(key, () => {
        const header = el('div', { class: 'a2ui-head' }, [
          el('div', { class: 'a2ui-head__titles' }, [
            el('div', { class: 'a2ui-badge', text: 'A2UI · FLOOR OBJECTIVE BUILDER' }),
            el('h3', { class: 'a2ui-title', text: screen.title }),
            el('p', { class: 'a2ui-subtitle', text: screen.subtitle }),
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
                `btn a2ui-preset${p.tone === 'warn' ? ' warn' : p.tone === 'accent' ? ' drive' : ''}`,
                () => {
                  actions.submitA2ui(p.id, p.dispatch, p.managerOp);
                },
                p.description,
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

        const summaryText = `Route ${draft.count} order(s) from ${draft.sourceZone.toUpperCase()} → ${draft.targetBay} (${draft.priority.toUpperCase()})`;
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
