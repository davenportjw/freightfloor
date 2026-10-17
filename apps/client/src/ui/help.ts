/**
 * Intro modal (`#help`): a short "How to Play" tab (default) and a separate
 * "The AI Inside" tab. Shown on load (unless `warehouse.help.seen === 'skip'`)
 * and reopened anytime via `?` or the top-right `Intro & Rules ?` toolbar button.
 */
import type { UiCtx, UiModule } from './context.js';
import { button, el, kbd } from './dom.js';
import { HOTKEYS } from './hotkeys.js';
import type { StorageLike } from './panel.js';

export const HELP_SEEN_KEY = 'warehouse.help.seen';

export type IntroTab = 'play' | 'ai';

export interface HelpMountOptions {
  /** Current saved or default callsign to pre-populate the callsign input. */
  getCallsign?: () => string;
  /**
   * Invoked when the player clicks "Start driving →" or submits the callsign bar.
   * Returns (or resolves to) `null` if valid (allowing the modal to close) or an error message if invalid.
   */
  onEnterFloor?: (callsign: string) => string | null | Promise<string | null>;
}

/**
 * Returns `true` both on first visit (`null`) and on subsequent visits (`'1'`),
 * only returning `false` if `warehouse.help.seen === 'skip'`.
 */
export function shouldShowHelpOnBoot(storage: StorageLike | null | undefined): boolean {
  try {
    return storage?.getItem(HELP_SEEN_KEY) !== 'skip';
  } catch {
    return true;
  }
}

export function markHelpSeen(storage: StorageLike | null | undefined): void {
  try {
    storage?.setItem(HELP_SEEN_KEY, '1');
  } catch {
    /* storage unavailable (private mode): help simply shows again next time */
  }
}

export function mountHelp(overlay: HTMLElement, ctx: UiCtx, opts: HelpMountOptions = {}): UiModule {
  const b = (t: string): HTMLElement => el('b', { text: t });

  const assignedBadge = el('span', {
    class: 'intro-callsign-badge num',
    attrs: { id: 'introAssignedCallsign', 'data-role': 'intro-assigned-callsign' },
    text: 'Assigning…',
  });
  const callsignInput = el('input', {
    class: 'text-input intro-callsign-input',
    attrs: {
      id: 'introCallsign',
      type: 'text',
      maxlength: '36',
      autocomplete: 'off',
      placeholder: 'Resume an old callsign (optional)',
      'aria-label': 'Resume previous callsign (optional)',
    },
  });
  const callsignError = el('div', {
    class: 'form-error',
    attrs: { id: 'introCallsignError', role: 'alert' },
  });

  function enterFloor(): void {
    ctx.actions.showHelp(false);
    // Drop the player straight into a forklift so WASD works immediately.
    // quickDrive is a no-op if already driving and toasts honestly if none is free.
    if (ctx.store.you) ctx.actions.quickDrive();
  }

  function showCallsignError(err: string): void {
    callsignError.textContent = err;
    callsignInput.focus();
  }

  function tryEnterFloor(): void {
    callsignError.textContent = '';
    const raw = callsignInput.value.trim();
    if (!raw || !opts.onEnterFloor) {
      enterFloor();
      return;
    }
    const result = opts.onEnterFloor(raw);
    if (result instanceof Promise) {
      startBtn.disabled = true;
      result
        .then((err) => {
          if (err) return showCallsignError(err);
          callsignInput.value = '';
          enterFloor();
        })
        .catch((e: unknown) => showCallsignError(e instanceof Error ? e.message : String(e)))
        .finally(() => {
          startBtn.disabled = false;
        });
      return;
    }
    if (result) return showCallsignError(result);
    callsignInput.value = '';
    enterFloor();
  }

  const startBtn = el('button', {
    class: 'btn drive intro-start-btn',
    attrs: { type: 'submit', 'data-action': 'close-intro' },
    text: 'Start driving →',
  });

  // ---- tabs ----
  const tabPlay = button('🎮 How to Play', 'btn intro-tab on', () => setTab('play'));
  tabPlay.dataset.introTab = 'play';
  tabPlay.setAttribute('role', 'tab');
  tabPlay.setAttribute('aria-selected', 'true');

  const tabAi = button('🧠 The AI Inside', 'btn intro-tab', () => setTab('ai'));
  tabAi.dataset.introTab = 'ai';
  tabAi.setAttribute('role', 'tab');
  tabAi.setAttribute('aria-selected', 'false');

  // ---- How to Play ----
  const step = (n: string, icon: string, title: string, body: Array<Node | string>): HTMLElement =>
    el('li', { class: 'intro-step' }, [
      el('div', { class: 'intro-step__icon', text: icon, attrs: { 'aria-hidden': 'true' } }),
      el('div', { class: 'intro-step__num', text: n }),
      el('h3', { class: 'intro-step__title', text: title }),
      el('p', { class: 'intro-step__body' }, body),
    ]);

  const playPane = el(
    'section',
    { class: 'intro-pane', attrs: { 'data-pane': 'rules', role: 'tabpanel', 'aria-label': 'How to Play' } },
    [
      el('ol', { class: 'intro-steps' }, [
        step('1', '🚜', 'Drive', ['Hit ', b('Start driving'), ' to grab a forklift. Steer with ', kbd('W'), kbd('A'), kbd('S'), kbd('D'), '.']),
        step('2', '📦', 'Pick up', ['Pull up to a glowing pallet and press ', kbd('E'), '.']),
        step('3', '🏁', 'Deliver', ['Drop it at the blue Shipping Bay with ', kbd('E'), '.']),
      ]),
      el('div', { class: 'intro-chips' }, [
        el('span', { class: 'intro-chip good' }, [b('+10'), ' pallet']),
        el('span', { class: 'intro-chip accent' }, [b('+40'), ' ★ rush order']),
        el('span', { class: 'intro-chip bad' }, [b('−15'), ' crash']),
        el('span', { class: 'intro-chip' }, ['Hold ', kbd('Shift'), ' to boost — crashing drops your load']),
        el('span', { class: 'intro-chip' }, ['🔋 Low? Park on a green pad, press ', kbd('E')]),
      ]),
      el('p', { class: 'intro-goal' }, ['Out-ship the AI forklifts and finish the shift ', b('#1'), '.']),
      el('details', { class: 'intro-keys' }, [
        el('summary', { text: 'All controls' }),
        el(
          'table',
          { class: 'keys' },
          HOTKEYS.map((h) => el('tr', {}, [el('td', {}, [kbd(h.key)]), el('td', { text: h.action })])),
        ),
      ]),
    ],
  );

  // ---- The AI Inside ----
  const aiCard = (icon: string, title: string, body: string): HTMLElement =>
    el('article', { class: 'ai-concept-card' }, [
      el('div', { class: 'ai-concept-card__icon', text: icon, attrs: { 'aria-hidden': 'true' } }),
      el('div', {}, [
        el('h4', { class: 'ai-concept-card__title', text: title }),
        el('p', { class: 'ai-concept-desc', text: body }),
      ]),
    ]);

  const aiPane = el(
    'section',
    {
      class: 'intro-pane',
      attrs: { 'data-pane': 'ai-concepts', role: 'tabpanel', 'aria-label': 'The AI Inside' },
    },
    [
      el('p', { class: 'intro-ai-lead' }, [
        'Every rival forklift is driven by a live ',
        b('Gemini'),
        ' agent on Vertex AI. Here’s what’s going on under the hood:',
      ]),
      el('div', { class: 'ai-concept-grid' }, [
        aiCard(
          '⚡',
          'Fast reflexes, slow thinking',
          'Pathfinding and collision avoidance run locally 10× a second. Gemini plans strategy in the background, so nobody freezes waiting on the model.',
        ),
        aiCard(
          '🏆',
          'Competing strategies',
          'Each AI forklift runs a different persona — Sprinter, Hauler, Strategist, Sentinel. The Strategy Board shows which one is winning.',
        ),
        aiCard(
          '🔍',
          'Glass-box decisions',
          'Click any AI forklift to see the model, its latency, and why it made its last move. If a call fails, you see the real error.',
        ),
        aiCard(
          '🛡️',
          'Safe, cheap prompts',
          'Typed floor commands pass Model Armor screening, and context caching keeps each call small and fast.',
        ),
      ]),
    ],
  );
  aiPane.hidden = true;

  function setTab(tab: IntroTab): void {
    playPane.hidden = tab !== 'play';
    aiPane.hidden = tab !== 'ai';
    for (const [btn, id] of [
      [tabPlay, 'play'],
      [tabAi, 'ai'],
    ] as const) {
      const on = id === tab;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-selected', String(on));
    }
  }

  // ---- footer: callsign + CTA ----
  const footer = el('form', { class: 'intro-footer' }, [
    el('div', { class: 'intro-callsign-box' }, [
      el('span', { class: 'muted', text: 'You are' }),
      assignedBadge,
      callsignInput,
      callsignError,
    ]),
    startBtn,
  ]);
  footer.addEventListener('submit', (ev) => {
    ev.preventDefault();
    tryEnterFloor();
  });

  const card = el(
    'div',
    {
      class: 'hud help-card intro-modal',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'helpTitle' },
    },
    [
      el('header', { class: 'intro-head' }, [
        el('h2', { text: 'Warehouse', attrs: { id: 'helpTitle' } }),
        el('p', { class: 'intro-subtitle', text: 'Drive a forklift. Beat the AI. Ship the most pallets.' }),
      ]),
      el('div', { class: 'intro-tabs', attrs: { role: 'tablist', 'aria-label': 'Intro sections' } }, [tabPlay, tabAi]),
      playPane,
      aiPane,
      footer,
    ],
  );

  overlay.replaceChildren(card);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) tryEnterFloor();
  });

  return {
    update() {
      const open = ctx.store.ui.helpOpen;
      const current = ctx.store.you?.name || opts.getCallsign?.() || 'Assigning…';
      if (assignedBadge.textContent !== current) {
        assignedBadge.textContent = current;
      }
      if (overlay.hidden === !open) return;
      overlay.hidden = !open;
      if (open) startBtn.focus();
    },
  };
}
