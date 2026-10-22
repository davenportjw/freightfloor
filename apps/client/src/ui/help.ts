/**
 * Intro modal (`#help`): "How to Play" (default view) with a single "🧠 How the AI works" link that
 * swaps to the AI Inside + Decision Lifecycle explainer (and "← How to Play" back). Shown on load (unless `warehouse.help.seen === 'skip'`)
 * and reopened anytime via `?` or the top-right `Intro & Rules ?` toolbar button.
 */
import type { UiCtx, UiModule } from './context.js';
import { button, el, kbd } from './dom.js';
import { HOTKEYS } from './hotkeys.js';
import { createFocusTrap, type TrapContainer } from './focusTrap.js';
import type { StorageLike } from './panel.js';

export const HELP_SEEN_KEY = 'warehouse.help.seen';

/** `ai` and `lifecycle` both open the single "How the AI works" view (both panes stacked). */
export type IntroTab = 'play' | 'ai' | 'lifecycle';

export interface HelpModule extends UiModule {
  switchTab(tab: IntroTab): void;
  /** "Start driving →" (button, Enter hotkey): validates the optional callsign, then drives. */
  start(): void;
}

/** Start button label: "Connecting…" while a drive is queued before the welcome arrived. */
export function introStartLabel(pendingDrive: boolean): string {
  return pendingDrive ? 'Connecting…' : 'Start driving →';
}

/** How frequently the cold-start quip rotates while a sleeping warehouse shard spins up. */
export const SPINUP_ROTATE_MS = 2_600;

/** Cheeky status quips shown on the Intro modal while a scale-to-zero shard wakes on Cloud Run. */
export const INTRO_SPINUP_QUIPS: readonly string[] = [
  'We let the warehouse nap between shifts so our Cloud Run bill stays ~$10/mo instead of $190/mo. Rattling the roll-up door now…',
  'Evicting 20 AI forklifts from their union-mandated espresso break and confiscating the tiny crossword puzzles…',
  'Pumping 80 miniature isometric tires to 10 Hz pressure and sweeping last shift’s dropped pallets under a rack…',
  'Booting Gemini 3.5 Flash-Lite dispatchers and reminding them that "RAM THE SHIPPING BAY" is not an OSHA-approved directive…',
  'Almost warm — unlocking the ignition keys, un-stacking the safety cones, and pre-heating the battery pads…',
];

export interface IntroSpinupState {
  welcomed: boolean;
  pendingDrive: boolean;
  elapsedMs: number;
  siteId?: string | null;
}

export interface IntroSpinupStatus {
  tone: 'waking' | 'ready';
  badge: string;
  headline: string;
  quip: string;
}

/**
 * Computes the live warehouse spin-up banner copy for the Intro modal.
 * Entertains visitors during the ~5–12s Pattern A Cloud Run cold start, then confirms 10 Hz readiness.
 */
export function introSpinupStatus(state: IntroSpinupState): IntroSpinupStatus {
  const site = (state.siteId || 'den-1').toUpperCase();
  if (state.welcomed) {
    return {
      tone: 'ready',
      badge: `⚡ ${site} LIVE`,
      headline: 'Warehouse floor is awake, caffeinated, and ticking at 10 Hz.',
      quip: 'All 20 AI forklifts have hidden their espresso cups and are pretending they were working the whole time.',
    };
  }
  const safeElapsed = Math.max(0, state.elapsedMs);
  const idx = Math.floor(safeElapsed / SPINUP_ROTATE_MS) % INTRO_SPINUP_QUIPS.length;
  const secs = Math.max(1, Math.floor(safeElapsed / 1000));
  const headline = state.pendingDrive
    ? `Door queued — dropping you onto ${site} the instant the lights click on (${secs}s)…`
    : `Waking ${site} from scale-to-zero nap (~5–12s cold start)…`;
  return {
    tone: 'waking',
    badge: state.pendingDrive ? `⏳ WAKING ${site} · ${secs}s` : `☕ WAKING ${site}`,
    headline,
    quip: INTRO_SPINUP_QUIPS[idx]!,
  };
}

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

export function mountHelp(overlay: HTMLElement, ctx: UiCtx, opts: HelpMountOptions = {}): HelpModule {
  const b = (t: string): HTMLElement => el('b', { text: t });

  const assignedBadge = el('span', {
    class: 'intro-callsign-badge num',
    attrs: { id: 'introAssignedCallsign', 'data-role': 'intro-assigned-callsign' },
    text: 'Assigning…',
  });
  const callsignList = el('datalist', {
    attrs: { id: 'introCallsignList' },
  });
  const callsignInput = el('input', {
    class: 'text-input intro-callsign-input',
    attrs: {
      id: 'introCallsign',
      type: 'text',
      maxlength: '64',
      autocomplete: 'off',
      list: 'introCallsignList',
      placeholder: 'Find your callsign (type to search)…',
      'aria-label': 'Find an existing callsign or paste a resume code (optional)',
    },
  });
  const callsignError = el('div', {
    class: 'form-error',
    attrs: { id: 'introCallsignError', role: 'alert' },
  });

  const knownCallsigns = new Set<string>();
  function syncCallsignOptions(extra: readonly string[] = []): void {
    for (const c of extra) {
      const cleaned = c.replace(/\s+Run\s+\d+$/i, '').trim();
      if (cleaned) knownCallsigns.add(cleaned);
    }
    for (const p of ctx.store.presence ?? []) {
      const cleaned = (p.name || '').replace(/\s+Run\s+\d+$/i, '').trim();
      if (cleaned) knownCallsigns.add(cleaned);
    }
    for (const row of ctx.store.network?.leaderboard ?? []) {
      const cleaned = (row.name || '').replace(/\s+Run\s+\d+$/i, '').trim();
      if (cleaned) knownCallsigns.add(cleaned);
    }
    const sorted = Array.from(knownCallsigns).sort((a, b) => a.localeCompare(b)).slice(0, 30);
    callsignList.replaceChildren(
      ...sorted.map((name) => el('option', { attrs: { value: name } })),
    );
  }

  let lookupSeq = 0;
  callsignInput.addEventListener('input', () => {
    callsignError.textContent = '';
    const q = callsignInput.value.trim();
    syncCallsignOptions();
    if (q.length < 2 || /^wr1_/i.test(q) || typeof globalThis.fetch !== 'function') return;
    const seq = ++lookupSeq;
    void globalThis
      .fetch(`/api/callsigns?q=${encodeURIComponent(q)}`)
      .then((res) => (res && res.ok ? res.json() : null))
      .then((body: { callsigns?: unknown } | null) => {
        if (seq !== lookupSeq || !body || !Array.isArray(body.callsigns)) return;
        const found = body.callsigns.filter((x): x is string => typeof x === 'string');
        syncCallsignOptions(found);
      })
      .catch(() => {
        /* ignore background lookup errors in offline/unit test environments */
      });
  });

  function enterFloor(): void {
    // Wired client: startDriving queues the drive (intro stays up, "Connecting…") until welcome.
    if (typeof ctx.actions.startDriving === 'function') {
      ctx.actions.startDriving();
      return;
    }
    ctx.actions.showHelp(false);
    // Drop the player straight into a forklift so WASD works immediately.
    // If evicted while reading the intro, driveFromFloor re-requests a fresh driver seat.
    if (ctx.store.you) {
      if (ctx.store.evictedReason !== null && typeof ctx.actions.driveFromFloor === 'function') {
        ctx.actions.driveFromFloor();
      } else {
        ctx.actions.quickDrive();
      }
    }
  }

  function showCallsignError(err: string): void {
    callsignError.textContent = err;
    callsignInput.focus();
  }

  function tryEnterFloor(): void {
    if (ctx.store.ui.pendingDrive || startBtn.disabled) return;
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

  // ---- view switch: one secondary pill button to the AI explainer, one back ----
  const aiLink = button('🧠 How the AI works', 'btn intro-ai-link', () => switchTab('ai'));
  aiLink.dataset.introTab = 'ai';
  aiLink.setAttribute('aria-expanded', 'false');

  const backLink = button('← How to Play', 'btn intro-back-link', () => switchTab('play'));
  backLink.dataset.introTab = 'play';
  backLink.hidden = true;

  // ---- How to Play ----
  const step = (n: string, icon: string, title: string, body: Array<Node | string> | HTMLElement): HTMLElement =>
    el('li', { class: 'intro-step' }, [
      el('div', { class: 'intro-step__icon', text: icon, attrs: { 'aria-hidden': 'true' } }),
      el('div', { class: 'intro-step__num', text: n }),
      el('h3', { class: 'intro-step__title', text: title }),
      Array.isArray(body) ? el('p', { class: 'intro-step__body' }, body) : body,
    ]);

  const step2Body = el('p', { class: 'intro-step__body' }, ['Pull up to a glowing pallet and press ', kbd('E'), '.']);
  const perfectLiftChip = el('span', { class: 'intro-chip' }, ['+$5–$10 perfect lift']);
  perfectLiftChip.hidden = true;
  let hotkeyECell: HTMLElement | null = null;
  const hotkeyRows = HOTKEYS.map((h) => {
    const actionCell = el('td', {
      text: h.key === 'E' ? 'Pick up pallet, drop at bay, or start charging' : h.action,
    });
    if (h.key === 'E') hotkeyECell = actionCell;
    return el('tr', {}, [el('td', {}, [kbd(h.key)]), actionCell]);
  });

  let lastRackLift: boolean | null = null;
  const syncRackLiftHelp = (rackLift: boolean): void => {
    if (lastRackLift === rackLift) return;
    lastRackLift = rackLift;
    if (rackLift) {
      step2Body.replaceChildren(
        'Pull up to a glowing rack pallet, hold ',
        kbd('E'),
        ' to raise forks (L1–L3), and release ',
        kbd('E'),
        ' in the sweet spot.',
      );
      perfectLiftChip.hidden = false;
      if (perfectLiftChip.style) {
        perfectLiftChip.style.display = '';
        perfectLiftChip.style.setProperty?.('display', '');
      }
      if (hotkeyECell) {
        hotkeyECell.textContent = 'Hold & release at rack to lift (L1–L3), or press at bay / charger';
      }
    } else {
      step2Body.replaceChildren('Pull up to a glowing pallet and press ', kbd('E'), '.');
      perfectLiftChip.hidden = true;
      if (perfectLiftChip.style) {
        perfectLiftChip.style.display = 'none';
        perfectLiftChip.style.setProperty?.('display', 'none');
      }
      if (hotkeyECell) {
        hotkeyECell.textContent = 'Pick up pallet, drop at bay, or start charging';
      }
    }
  };
  syncRackLiftHelp(ctx.store.isRackLiftEnabled());

  const playPane = el(
    'section',
    { class: 'intro-pane', attrs: { 'data-pane': 'rules', role: 'region', 'aria-label': 'How to Play' } },
    [
      el('ol', { class: 'intro-steps' }, [
        step('1', '🚜', 'Drive', ['Hit ', b('Start driving'), ' to grab a forklift. Steer with ', kbd('W'), kbd('A'), kbd('S'), kbd('D'), '.']),
        step('2', '📦', 'Pick up', step2Body),
        step('3', '🏁', 'Deliver', ['Drop it at the blue Shipping Bay with ', kbd('E'), '.']),
      ]),
      el('div', { class: 'intro-chips' }, [
        el('span', { class: 'intro-chip good' }, [b('+10'), ' pallet']),
        el('span', { class: 'intro-chip accent' }, [b('+40'), ' ★ rush order']),
        perfectLiftChip,
        el('span', { class: 'intro-chip bad' }, [b('−15'), ' crash']),
        el('span', { class: 'intro-chip' }, ['Hold ', kbd('Shift'), ' to boost — crashing drops your load']),
        el('span', { class: 'intro-chip' }, ['🔋 Low? Park on a green pad, press ', kbd('E')]),
      ]),
      el('p', { class: 'intro-goal' }, ['Out-ship the AI forklifts and finish the shift ', b('#1'), '.']),
      el('details', { class: 'intro-keys' }, [
        el('summary', { text: 'All controls' }),
        el('table', { class: 'keys' }, hotkeyRows),
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
      attrs: { 'data-pane': 'ai-concepts', role: 'region', 'aria-label': 'The AI Inside' },
    },
    [
      el('p', { class: 'intro-ai-lead' }, [
        'Every rival forklift splits work between the ',
        b('10 Hz Game Engine'),
        ' and a live ',
        b('Gemini (gemini-3.5-flash-lite)'),
        ' agent on Vertex AI:',
      ]),
      el('div', { class: 'ai-concept-grid' }, [
        aiCard(
          '⚡',
          'Fast reflexes, slow thinking',
          'Game Engine (10 Hz) runs locally: A* pathfinding, collision avoidance, P0 preemption, and auto-charging. Gemini plans in the background: contract picks (pre-fetched before drop-off), spill detours, shift cards, and tactics.',
        ),
        aiCard(
          '🏆',
          'Competing strategies',
          'Five AI personas compete — Sprinter, Steady, Batcher, Opportunist, Strategist — each pairing distinct engine physics (speed, safety buffer, 2-pallet forks, poaching) with its own Gemini strategy prompt.',
        ),
        aiCard(
          '🔍',
          'Glass-box decisions',
          'Click any AI forklift to see its Gemini model, latency, and why it made its last move. If a call fails, the truck holds and shows the real error — zero silent fallbacks.',
        ),
        aiCard(
          '🛡️',
          'Safe, cheap prompts',
          'Typed floor and Co-Pilot commands pass 7-layer Model Armor screening. The engine pre-scores the top 6 orders into a compact JSON prompt so every Gemini call stays small and fast.',
        ),
      ]),
    ],
  );
  aiPane.hidden = true;

  // ---- Decision Lifecycle (Visual SVG Swimlane Diagram + Compact Comparison Matrix) ----
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svgEl = (
    tag: string,
    attrs: Record<string, string | number> = {},
    children: Array<Element | Node | string> = [],
  ): Element => {
    const node =
      typeof document.createElementNS === 'function'
        ? document.createElementNS(SVG_NS, tag)
        : document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class' && 'className' in node && typeof (node as HTMLElement).className === 'string') {
        (node as HTMLElement).className = String(v);
      }
      node.setAttribute(k, String(v));
    }
    for (const c of children) {
      node.append(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  };

  const lcChip = (label: string, tone: 'engine' | 'gemini' | 'hybrid' | 'warn'): HTMLElement =>
    el('span', { class: 'lc-chip num', attrs: { 'data-tone': tone }, text: label });

  const matrixRow = (
    modeLabel: string,
    tone: 'gemini' | 'engine' | 'hybrid',
    col2: Array<Node | string>,
    col3: Array<Node | string>,
    col4: Array<Node | string>,
  ): HTMLElement =>
    el('div', { class: 'lifecycle-matrix-row', attrs: { role: 'row', 'data-mode-tone': tone } }, [
      el('div', { class: 'lifecycle-matrix-cell lifecycle-matrix-mode', attrs: { role: 'rowheader' } }, [
        el('strong', { class: 'lifecycle-mode-name', text: modeLabel }),
      ]),
      el('div', { class: 'lifecycle-matrix-cell', attrs: { role: 'cell' } }, col2),
      el('div', { class: 'lifecycle-matrix-cell', attrs: { role: 'cell' } }, col3),
      el('div', { class: 'lifecycle-matrix-cell', attrs: { role: 'cell' } }, col4),
    ]);

  const lifecycleSvg = svgEl(
    'svg',
    {
      class: 'lifecycle-svg',
      viewBox: '0 0 760 250',
      role: 'img',
      'aria-label': 'Forklift decision lifecycle between 10 Hz Game Engine and async Gemini model',
    },
    [
      svgEl('desc', {}, [
        '4-Step Autonomous Decision Lifecycle: 1. Trigger & Pre-Score (lookahead pre-fetch ≤6 tiles from drop-off), 2. Queue & Prompt (gemini-3.5-flash-lite async priority queue), 3. Validate & Reserve, and 4. Drive & Deliver (Local A* pathfinding at 10 Hz).',
      ]),
      svgEl('defs', {}, [
        svgEl(
          'marker',
          {
            id: 'lcArrowGreen',
            viewBox: '0 0 10 10',
            refX: '8',
            refY: '5',
            markerWidth: '6',
            markerHeight: '6',
            orient: 'auto-start-reverse',
          },
          [svgEl('path', { d: 'M 0 1 L 9 5 L 0 9 z', fill: '#16a34a' })],
        ),
        svgEl(
          'marker',
          {
            id: 'lcArrowPurple',
            viewBox: '0 0 10 10',
            refX: '8',
            refY: '5',
            markerWidth: '6',
            markerHeight: '6',
            orient: 'auto-start-reverse',
          },
          [svgEl('path', { d: 'M 0 1 L 9 5 L 0 9 z', fill: '#7c3aed' })],
        ),
        svgEl(
          'marker',
          {
            id: 'lcArrowRed',
            viewBox: '0 0 10 10',
            refX: '8',
            refY: '5',
            markerWidth: '5',
            markerHeight: '5',
            orient: 'auto-start-reverse',
          },
          [svgEl('path', { d: 'M 0 1 L 9 5 L 0 9 z', fill: '#dc2626' })],
        ),
      ]),

      // ---- Top Swimlane: 10 Hz Game Engine (y=8..118) ----
      svgEl('rect', {
        x: 8,
        y: 8,
        width: 744,
        height: 110,
        rx: 10,
        fill: '#f0fdf4',
        stroke: '#86efac',
        'stroke-width': 1.5,
      }),
      svgEl(
        'text',
        {
          x: 24,
          y: 27,
          fill: '#15803d',
          'font-size': 12,
          'font-weight': 800,
          'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
          'letter-spacing': '0.03em',
        },
        ['● 10 Hz GAME ENGINE — CONTINUOUS LOCAL LOOP (EVERY 100ms)'],
      ),
      // Fast-path low battery pill on top-right
      svgEl('rect', {
        x: 454,
        y: 13,
        width: 284,
        height: 20,
        rx: 10,
        fill: '#dcfce7',
        stroke: '#86efac',
        'stroke-width': 1,
      }),
      svgEl(
        'text',
        {
          x: 596,
          y: 26.5,
          'text-anchor': 'middle',
          fill: '#166534',
          'font-size': 12,
          'font-weight': 700,
        },
        ['🔋 Low Battery (< chargeAt) → Charger'],
      ),

      // Node 1: 1. Drive & Avoid (x=22..208)
      svgEl('rect', {
        x: 22,
        y: 40,
        width: 186,
        height: 68,
        rx: 8,
        fill: '#ffffff',
        stroke: '#22c55e',
        'stroke-width': 1.5,
      }),
      svgEl('text', { x: 34, y: 59, fill: '#0f172a', 'font-size': 12, 'font-weight': 800 }, [
        '1. Drive & Avoid',
      ]),
      svgEl(
        'text',
        {
          x: 196,
          y: 58,
          'text-anchor': 'end',
          fill: '#15803d',
          'font-size': 12,
          'font-weight': 700,
          'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
        },
        ['10 Hz'],
      ),
      svgEl('text', { x: 34, y: 78, fill: '#334155', 'font-size': 12, 'font-weight': 600 }, [
        'A* Path + 1–3 Tile Buffer',
      ]),
      svgEl('text', { x: 34, y: 94, fill: '#475569', 'font-size': 12 }, [
        'Yields, Brakes & Fork Lift',
      ]),

      // Arrow 1 -> 2 (x=208..234)
      svgEl('line', {
        x1: 208,
        y1: 74,
        x2: 234,
        y2: 74,
        stroke: '#16a34a',
        'stroke-width': 2,
        'marker-end': 'url(#lcArrowGreen)',
      }),

      // Node 2: 2. Trigger & Pre-Score (x=240..440)
      svgEl('rect', {
        x: 240,
        y: 40,
        width: 200,
        height: 68,
        rx: 8,
        fill: '#ffffff',
        stroke: '#22c55e',
        'stroke-width': 1.5,
      }),
      svgEl('text', { x: 252, y: 59, fill: '#0f172a', 'font-size': 12, 'font-weight': 800 }, [
        '2. Trigger & Pre-Score',
      ]),
      svgEl('text', { x: 252, y: 78, fill: '#334155', 'font-size': 12, 'font-weight': 600 }, [
        'Idle OR ≤6 Tiles from Drop',
      ]),
      svgEl('text', { x: 252, y: 94, fill: '#475569', 'font-size': 12 }, [
        'Engine Ranks Top 6 Orders',
      ]),

      // Dashed Arrow 2 -> 4 (80px gap x=440..520, center x=480)
      svgEl('line', {
        x1: 440,
        y1: 78,
        x2: 514,
        y2: 78,
        stroke: '#16a34a',
        'stroke-width': 2,
        'stroke-dasharray': '4 3',
        'marker-end': 'url(#lcArrowGreen)',
      }),
      svgEl(
        'text',
        {
          x: 480,
          y: 67,
          'text-anchor': 'middle',
          fill: '#15803d',
          'font-size': 12,
          'font-weight': 700,
        },
        ['drives on'],
      ),

      // Node 4: 4. Validate & Deliver (x=520..736)
      svgEl('rect', {
        x: 520,
        y: 40,
        width: 216,
        height: 68,
        rx: 8,
        fill: '#ffffff',
        stroke: '#0d9488',
        'stroke-width': 1.5,
      }),
      svgEl('text', { x: 532, y: 59, fill: '#0f172a', 'font-size': 12, 'font-weight': 800 }, [
        '4. Validate & Deliver',
      ]),
      svgEl('text', { x: 532, y: 78, fill: '#334155', 'font-size': 12, 'font-weight': 600 }, [
        'Verify Order ID · Log Latency',
      ]),
      svgEl('text', { x: 532, y: 94, fill: '#475569', 'font-size': 12 }, [
        'Chain Next Pick w/ 0ms Pause',
      ]),

      // ---- Bottom Swimlane: Gemini 3.5 Flash-Lite (y=144..242) ----
      svgEl('rect', {
        x: 8,
        y: 144,
        width: 744,
        height: 98,
        rx: 10,
        fill: '#f5f3ff',
        stroke: '#c4b5fd',
        'stroke-width': 1.5,
      }),
      svgEl(
        'text',
        {
          x: 24,
          y: 161,
          fill: '#6d28d9',
          'font-size': 12,
          'font-weight': 800,
          'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
          'letter-spacing': '0.03em',
        },
        ['✦ GEMINI 3.5 FLASH-LITE — ASYNC STRATEGY'],
      ),

      // Left summary badge inside Gemini lane
      svgEl('rect', {
        x: 22,
        y: 170,
        width: 96,
        height: 62,
        rx: 8,
        fill: '#ede9fe',
        stroke: '#c4b5fd',
        'stroke-width': 1,
      }),
      svgEl('text', { x: 70, y: 188, 'text-anchor': 'middle', fill: '#5b21b6', 'font-size': 12, 'font-weight': 800 }, [
        'Lookahead',
      ]),
      svgEl('text', { x: 70, y: 203, 'text-anchor': 'middle', fill: '#6d28d9', 'font-size': 12, 'font-weight': 600 }, [
        'Pre-Fetch ≤6',
      ]),
      svgEl('text', { x: 70, y: 218, 'text-anchor': 'middle', fill: '#6d28d9', 'font-size': 12 }, [
        'Tiles Early',
      ]),

      // Node 3a: 3a. Priority Queue (Max 4) (x=128..370)
      svgEl('rect', {
        x: 128,
        y: 170,
        width: 242,
        height: 62,
        rx: 8,
        fill: '#ffffff',
        stroke: '#8b5cf6',
        'stroke-width': 1.5,
      }),
      svgEl('text', { x: 140, y: 188, fill: '#0f172a', 'font-size': 12, 'font-weight': 800 }, [
        '3a. Priority Queue (Max 4)',
      ]),
      svgEl('text', { x: 140, y: 205, fill: '#334155', 'font-size': 12, 'font-weight': 600 }, [
        'Spill > Contract > Cards > Tactics',
      ]),
      svgEl('text', { x: 140, y: 220, fill: '#475569', 'font-size': 12 }, [
        'Strips Untrusted Player Text',
      ]),

      // Arrow 3a -> 3b
      svgEl('line', {
        x1: 370,
        y1: 201,
        x2: 390,
        y2: 201,
        stroke: '#7c3aed',
        'stroke-width': 2,
        'marker-end': 'url(#lcArrowPurple)',
      }),

      // Node 3b: 3b. Persona Decision (x=396..600)
      svgEl('rect', {
        x: 396,
        y: 170,
        width: 204,
        height: 62,
        rx: 8,
        fill: '#ffffff',
        stroke: '#8b5cf6',
        'stroke-width': 1.5,
      }),
      svgEl('text', { x: 408, y: 188, fill: '#0f172a', 'font-size': 12, 'font-weight': 800 }, [
        '3b. Persona Decision',
      ]),
      svgEl('text', { x: 408, y: 205, fill: '#334155', 'font-size': 12, 'font-weight': 600 }, [
        'Sprinter · Steady · Batcher',
      ]),
      svgEl('text', { x: 408, y: 220, fill: '#475569', 'font-size': 12 }, [
        'Opportunist · Strategist',
      ]),

      // Dashed Arrow 3b -> Error Branch
      svgEl('line', {
        x1: 600,
        y1: 201,
        x2: 610,
        y2: 201,
        stroke: '#dc2626',
        'stroke-width': 1.5,
        'stroke-dasharray': '3 2',
        'marker-end': 'url(#lcArrowRed)',
      }),

      // Error Branch Callout (x=614..744)
      svgEl('rect', {
        x: 614,
        y: 170,
        width: 130,
        height: 62,
        rx: 8,
        fill: '#fef2f2',
        stroke: '#fca5a5',
        'stroke-width': 1.5,
      }),
      svgEl('text', { x: 624, y: 188, fill: '#b91c1c', 'font-size': 12, 'font-weight': 800 }, [
        '⚠️ Real Error',
      ]),
      svgEl('text', { x: 624, y: 205, fill: '#991b1b', 'font-size': 12, 'font-weight': 600 }, [
        'Hold 3s',
      ]),
      svgEl('text', { x: 624, y: 220, fill: '#991b1b', 'font-size': 12 }, [
        '0 Mock Fallbacks',
      ]),

      // ---- Vertical Handoff Arrows Between Top Lane & Bottom Lane ----
      // Down Arrow: Node 2 -> Node 3a at x=355 (clear of bottom lane header text!)
      svgEl('line', {
        x1: 355,
        y1: 108,
        x2: 355,
        y2: 166,
        stroke: '#7c3aed',
        'stroke-width': 2,
        'stroke-dasharray': '3 2',
        'marker-end': 'url(#lcArrowPurple)',
      }),
      svgEl('rect', {
        x: 275,
        y: 122,
        width: 160,
        height: 18,
        rx: 9,
        fill: '#ede9fe',
        stroke: '#c4b5fd',
        'stroke-width': 1,
      }),
      svgEl(
        'text',
        {
          x: 355,
          y: 135,
          'text-anchor': 'middle',
          fill: '#6d28d9',
          'font-size': 12,
          'font-weight': 800,
          'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
        },
        ['↓ Async JSON (Top 6)'],
      ),

      // Up Arrow: Node 3b -> Node 4 at x=560
      svgEl('line', {
        x1: 560,
        y1: 170,
        x2: 560,
        y2: 112,
        stroke: '#7c3aed',
        'stroke-width': 2,
        'marker-end': 'url(#lcArrowPurple)',
      }),
      svgEl('rect', {
        x: 488,
        y: 122,
        width: 144,
        height: 18,
        rx: 9,
        fill: '#ede9fe',
        stroke: '#c4b5fd',
        'stroke-width': 1,
      }),
      svgEl(
        'text',
        {
          x: 560,
          y: 135,
          'text-anchor': 'middle',
          fill: '#6d28d9',
          'font-size': 12,
          'font-weight': 800,
          'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
        },
        ['↑ Chosen Order ID'],
      ),
    ],
  );

  const lifecyclePane = el(
    'section',
    {
      class: 'intro-pane',
      attrs: { 'data-pane': 'decision-lifecycle', role: 'region', 'aria-label': 'Decision Lifecycle' },
    },
    [
      el('div', { class: 'lifecycle-block' }, [
        el('div', { class: 'lifecycle-section-head' }, [
          el('h3', {
            class: 'lifecycle-section-title',
            text: 'Autonomous Decision Pipeline (10 Hz Engine ↔ Async Gemini)',
          }),
          el('span', {
            class: 'lifecycle-section-note',
            text: 'Pre-fetches ≤6 tiles before drop-off so AI trucks chain orders with 0ms pause',
          }),
        ]),
        el('div', { class: 'lifecycle-diagram lifecycle-diagram-card' }, [lifecycleSvg]),
      ]),
      el('div', { class: 'lifecycle-block' }, [
        el('h3', {
          class: 'lifecycle-section-title',
          text: 'Who Calls Gemini vs. Game Engine? (By Forklift Mode)',
        }),
        el(
          'div',
          {
            class: 'lifecycle-matrix',
            attrs: { role: 'table', 'aria-label': 'Forklift mode decision comparison' },
          },
          [
            el('div', { class: 'lifecycle-matrix-head', attrs: { role: 'row' } }, [
              el('div', { class: 'lifecycle-matrix-th', attrs: { role: 'columnheader' }, text: 'Forklift Mode' }),
              el('div', {
                class: 'lifecycle-matrix-th',
                attrs: { role: 'columnheader' },
                text: 'Driving & Safety (10 Hz)',
              }),
              el('div', {
                class: 'lifecycle-matrix-th',
                attrs: { role: 'columnheader' },
                text: 'Order & Spill Dispatch',
              }),
              el('div', {
                class: 'lifecycle-matrix-th',
                attrs: { role: 'columnheader' },
                text: 'If Gemini Is Slow / Fails',
              }),
            ]),
            matrixRow(
              '🤖 AI Fleet (F-01..F-20)',
              'gemini',
              [lcChip('● Engine', 'engine'), ' A* path, collision buffer, auto-charge'],
              [lcChip('✦ Gemini', 'gemini'), ' Pre-fetched ≤6 tiles before drop'],
              [lcChip('■ No Fallback', 'warn'), ' Holds 3s & shows real error'],
            ),
            matrixRow(
              '🕹️ Player Manual (Drive / Take Wheel)',
              'engine',
              [lcChip('● Human + Engine', 'engine'), ' WASD steering & physics'],
              [lcChip('● Engine Only', 'engine'), ' Ranks 3 offers (Q), auto-picks in 5s'],
              [lcChip('● 0 LLM Calls', 'engine'), ' Pending requests stripped on takeover'],
            ),
            matrixRow(
              '🧭 Player Co-Pilot (Autopilot ON)',
              'hybrid',
              [lcChip('● Engine', 'engine'), ' A* path, collision buffer, auto-charge'],
              [lcChip('◆ Gemini + Armor', 'hybrid'), ' Parses typed rules & dispatches'],
              [lcChip('◆ 1.0s Fallback', 'hybrid'), ' Engine dispatches top order if ≥1s'],
            ),
          ],
        ),
      ]),
    ],
  );
  lifecyclePane.hidden = true;

  function switchTab(tab: IntroTab): void {
    const ai = tab !== 'play';
    playPane.hidden = ai;
    aiPane.hidden = !ai;
    lifecyclePane.hidden = !ai;
    aiLink.hidden = ai;
    aiLink.setAttribute('aria-expanded', String(ai));
    backLink.hidden = !ai;
  }

  // ---- cold-start / floor spin-up ticker ----
  const mountedAtMs = Date.now();
  const spinupBadge = el('span', {
    class: 'intro-spinup__badge num',
    attrs: { 'data-role': 'intro-spinup-badge' },
  });
  const spinupHeadline = el('span', {
    class: 'intro-spinup__headline',
    attrs: { 'data-role': 'intro-spinup-headline' },
  });
  const spinupQuip = el('p', {
    class: 'intro-spinup__quip',
    attrs: { 'data-role': 'intro-spinup-quip' },
  });
  const spinupBox = el(
    'aside',
    {
      class: 'intro-spinup',
      attrs: {
        id: 'introSpinup',
        'data-role': 'intro-spinup',
        'data-tone': 'waking',
        'aria-live': 'polite',
      },
    },
    [
      el('div', { class: 'intro-spinup__top' }, [spinupBadge, spinupHeadline]),
      spinupQuip,
    ],
  );

  const syncSpinup = (): void => {
    const status = introSpinupStatus({
      welcomed: Boolean(ctx.store.welcomed),
      pendingDrive: Boolean(ctx.store.ui.pendingDrive),
      elapsedMs: Math.max(0, Date.now() - mountedAtMs),
      siteId: ctx.store.siteId,
    });
    if (spinupBox.dataset.tone !== status.tone) {
      spinupBox.dataset.tone = status.tone;
    }
    if (spinupBadge.textContent !== status.badge) {
      spinupBadge.textContent = status.badge;
    }
    if (spinupHeadline.textContent !== status.headline) {
      spinupHeadline.textContent = status.headline;
    }
    if (spinupQuip.textContent !== status.quip) {
      spinupQuip.textContent = status.quip;
    }
  };
  syncSpinup();

  // ---- footer: callsign + CTA ----
  const footer = el('form', { class: 'intro-footer' }, [
    el('div', { class: 'intro-callsign-box' }, [
      el('span', { class: 'muted', text: 'You are' }),
      assignedBadge,
      callsignInput,
      callsignList,
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
        el('img', {
          class: 'intro-logo-banner',
          attrs: {
            src: '/assets/freightfloor-logo.svg',
            alt: 'Freight Floor — Grab pallets. Thread the aisles. Beat the 3-minute clock.',
            width: '560',
            height: '136',
          },
        }),
        el('h2', { class: 'sr-only', text: 'Freight Floor', attrs: { id: 'helpTitle' } }),
        el(
          'a',
          {
            class: 'intro-github-link',
            attrs: {
              href: 'https://github.com/davenportjw/freightfloor',
              target: '_blank',
              rel: 'noopener noreferrer',
              'aria-label': 'View source on GitHub',
              title: 'View source on GitHub',
            },
          },
          [
            svgEl('svg', { viewBox: '0 0 16 16', width: '18', height: '18', 'aria-hidden': 'true' }, [
              svgEl('path', {
                fill: 'currentColor',
                d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z',
              }),
            ]),
          ],
        ),
      ]),
      el('div', { class: 'intro-tabs', attrs: { 'aria-label': 'Intro sections' } }, [aiLink, backLink]),
      playPane,
      aiPane,
      lifecyclePane,
      spinupBox,
      footer,
    ],
  );

  overlay.replaceChildren(card);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) tryEnterFloor();
  });

  const focusTrap = createFocusTrap(overlay as unknown as TrapContainer<HTMLElement>);

  return {
    switchTab,
    start: tryEnterFloor,
    update() {
      syncRackLiftHelp(ctx.store.isRackLiftEnabled());
      syncSpinup();
      const pending = Boolean(ctx.store.ui.pendingDrive);
      const label = introStartLabel(pending);
      if (startBtn.textContent !== label) startBtn.textContent = label;
      startBtn.setAttribute('aria-busy', String(pending));
      const open = ctx.store.ui.helpOpen;
      const current = ctx.store.you?.name || opts.getCallsign?.() || 'Assigning…';
      if (assignedBadge.textContent !== current) {
        assignedBadge.textContent = current;
      }
      syncCallsignOptions();
      if (overlay.hidden === !open) return;
      overlay.hidden = !open;
      // Trap Tab inside the dialog while open; return focus to where it was on close.
      if (open) focusTrap.activate(startBtn);
      else focusTrap.deactivate();
    },
  };
}
