/**
 * `#chat` (bottom centre, both modes): one input with a Co-Pilot / Floor target toggle.
 * Co-Pilot → `agentCommand { text }` for the driven vehicle; Floor → `nlCommand` (Floor orders in
 * plain language, rate-limited server-side — the remaining budget comes from `floorOrders.nl`).
 * Results arrive as `commandEcho` / `error` and surface via ui/notify.ts (alert line in Drive, floor feed in Floor).
 */
import type { UiCtx, UiModule } from './context.js';
import { NL_MAX_LEN } from './commandBar.js';
import { el, kbd } from './dom.js';

/** Example prompts — each chip sends exactly this text to the real endpoint. */
export const CHAT_CHIPS: Record<'copilot' | 'floor', readonly string[]> = {
  copilot: ['Go charge now', 'Take the nearest P0 order', 'Play it safe around people', 'Focus on zone A'],
  floor: ['Rush the floor', 'Dispatch 2 pallets from cold to any bay', 'Add a truck to the fleet', 'What is slowing us down?'],
};

export function chatTargetState(
  target: 'copilot' | 'floor',
  hasVehicle: boolean,
  nlLeft: number | null,
): { target: 'copilot' | 'floor'; copilotDisabled: string | null; floorDisabled: string | null } {
  const copilotDisabled = hasVehicle ? null : 'Take the wheel first — the Co-Pilot rides with your vehicle.';
  const floorDisabled = nlLeft === 0 ? 'Floor command budget used up — it refills shortly.' : null;
  const t = target === 'copilot' && copilotDisabled ? 'floor' : target;
  return { target: t, copilotDisabled, floorDisabled };
}

export function mountChat(root: HTMLElement, ctx: UiCtx): UiModule {
  const { actions } = ctx;
  const segCopilot = el('button', { class: 'seg-btn', text: '🤖 Co-Pilot', attrs: { type: 'button' } });
  const segFloor = el('button', { class: 'seg-btn', text: '🏭 Floor', attrs: { type: 'button' } });
  segCopilot.addEventListener('click', () => actions.setChatTarget('copilot'));
  segFloor.addEventListener('click', () => actions.setChatTarget('floor'));
  const input = el('input', {
    class: 'text-input chat-input',
    attrs: { type: 'text', maxlength: String(NL_MAX_LEN), autocomplete: 'off', 'aria-label': 'Chat message' },
  });
  const budget = el('span', { class: 'muted num chat-budget' });
  const sendBtn = el('button', { class: 'go small', text: 'Send', attrs: { type: 'submit' } });
  const close = el('button', { class: 'x', text: '✕', title: 'Close chat (Esc)', attrs: { type: 'button', 'aria-label': 'Close chat' } });
  close.addEventListener('click', () => actions.setOverlay(null));
  const chips = el('div', { class: 'chips' });
  const form = el('form', { class: 'chat-row' }, [input, sendBtn]);
  root.replaceChildren(
    el('div', { class: 'chat-head' }, [el('div', { class: 'seg-toggle' }, [segCopilot, segFloor]), budget, el('span', { class: 'grow' }), close]),
    form,
    chips,
    el('div', { class: 'hint' }, [kbd('↵'), ' send · ', kbd('Esc'), ' close']),
  );

  let target: 'copilot' | 'floor' = 'copilot';
  const submit = (text: string): void => {
    const t = text.trim().slice(0, NL_MAX_LEN);
    if (!t) return;
    if (target === 'copilot') actions.agentCommand({ text: t });
    else actions.nlCommand(t);
    input.value = '';
    actions.setOverlay(null);
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit(input.value);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      actions.setOverlay(null);
    }
  });

  let wasOpen = false;
  let lastKey = '';
  return {
    update() {
      const { store } = ctx;
      const open = store.activeOverlay() === 'chat';
      root.hidden = !open;
      if (!open) {
        wasOpen = false;
        lastKey = '';
        return;
      }
      const nl = store.floorOrdersNow()?.nl ?? null;
      const s = chatTargetState(store.ui.chatTarget, store.isDriving(), nl ? nl.left : null);
      target = s.target;
      const key = JSON.stringify([s, nl?.left ?? null, nl ? Math.ceil(nl.resetInMs / 1000) : null]);
      if (key !== lastKey) {
        lastKey = key;
        segCopilot.classList.toggle('on', target === 'copilot');
        segFloor.classList.toggle('on', target === 'floor');
        segCopilot.disabled = s.copilotDisabled !== null;
        segCopilot.title = s.copilotDisabled ?? 'Talk to your Co-Pilot (it drives when you hand over with C)';
        segFloor.title = 'Give the floor an order in plain language';
        const blocked = target === 'floor' ? s.floorDisabled : null;
        input.disabled = blocked !== null;
        sendBtn.disabled = blocked !== null;
        sendBtn.title = blocked ?? 'Send (Enter)';
        input.placeholder = target === 'copilot' ? 'Tell your Co-Pilot what to do…' : 'Order the floor, e.g. “rush” or “dispatch 2 from cold”…';
        budget.textContent =
          target === 'floor' && nl ? `${nl.left} left${nl.left === 0 && nl.resetInMs > 0 ? ` · refills in ${Math.ceil(nl.resetInMs / 1000)}s` : ''}` : '';
        chips.replaceChildren(
          ...CHAT_CHIPS[target].map((c) => {
            const b = el('button', { class: 'chip', text: c, attrs: { type: 'button' } });
            b.disabled = blocked !== null;
            if (blocked) b.title = blocked;
            b.addEventListener('click', () => submit(c));
            return b;
          }),
        );
      }
      if (!wasOpen) {
        wasOpen = true;
        input.focus();
      }
    },
  };
}
