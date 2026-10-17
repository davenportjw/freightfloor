/**
 * Co-Pilot & Agent Designer modal (`#agent-designer-modal`).
 *
 * Lets any player design, tune, and direct their own vehicle's AI Co-Pilot using either:
 *  - Natural-language instructions (parsed by `gemini-3.5-flash-lite` on the server),
 *  - One-click Quick Intent Pills, or
 *  - Structured Agent Designer controls (persona archetype, priority mode, focus zones A–F,
 *    immediate task, tactics sliders, and boolean tactical flags).
 *
 * All controls wire directly to real WebSocket `agentCommand` messages via `ctx.actions.agentCommand`.
 */
import type { AgentDirective } from '@warehouse/protocol';
import { defaultTacticsFor, type Archetype, type Vehicle } from '@warehouse/sim';
import type { UiCtx, UiModule } from './context.js';
import { el } from './dom.js';

export interface QuickIntentPill {
  id: string;
  label: string;
  text: string;
  directive: AgentDirective;
}

export const QUICK_INTENT_PILLS: readonly QuickIntentPill[] = [
  {
    id: 'p0_responder',
    label: '★ P0 Responder',
    text: 'Prioritize urgent P0 orders across the warehouse with Sprinter speed and P0 preemption.',
    directive: {
      autopilot: true,
      persona: 'Sprinter',
      priority: 'p0_first',
      immediateTask: 'pick_p0',
      tactics: { speed: 1.35, preemptForP0: true, batch: 1 },
      summary: 'P0 Responder · Sprinter · P0 First',
    },
  },
  {
    id: 'card_hunter',
    label: '🃏 Card Hunter',
    text: 'Hunt high-value and card-bearing orders as an Opportunist with poaching enabled.',
    directive: {
      autopilot: true,
      persona: 'Opportunist',
      priority: 'high_value',
      immediateTask: 'auto',
      tactics: { speed: 1.2, poach: true, preemptForP0: true, batch: 2 },
      summary: 'Card Hunter · Opportunist · High-Value',
    },
  },
  {
    id: 'zone_cd_sweeper',
    label: '🧹 Zone C+D Sweeper',
    text: 'Focus exclusively on sweeping racks in Zones C and D with Batcher multi-order pickups.',
    directive: {
      autopilot: true,
      persona: 'Batcher',
      priority: 'zone_focus',
      focusZones: ['C', 'D'],
      immediateTask: 'zone',
      tactics: { speed: 1.15, batch: 3, preemptForP0: true },
      summary: 'Zone C+D Sweeper · Batcher · Zones C, D',
    },
  },
  {
    id: 'charge_now',
    label: '⚡ Charge Now',
    text: 'Head to the nearest available charger pad immediately and recharge battery.',
    directive: {
      autopilot: true,
      immediateTask: 'charge_now',
      tactics: { chargeAt: 40 },
      summary: 'Immediate Charger Run · Charge ≤40%',
    },
  },
  {
    id: 'deliver_cargo',
    label: '📦 Deliver Cargo',
    text: 'Deliver all currently carried cargo to its outbound dock bay immediately.',
    directive: {
      autopilot: true,
      immediateTask: 'deliver_cargo',
      summary: 'Deliver Loaded Cargo Immediately',
    },
  },
];

export const PERSONA_OPTIONS: ReadonlyArray<{ id: Archetype; label: string; desc: string }> = [
  { id: 'Sprinter', label: 'Sprinter', desc: 'Fast single-order responder (1.25× base speed)' },
  { id: 'Steady', label: 'Steady', desc: 'Balanced, polite aisle navigation & steady throughput' },
  { id: 'Batcher', label: 'Batcher', desc: 'Multi-stop rack sweeps (up to 3 orders per trip)' },
  { id: 'Opportunist', label: 'Opportunist', desc: 'Chases high-value & nearby unclaimed orders' },
  { id: 'Strategist', label: 'Strategist', desc: 'High battery reserve, low congestion paths' },
];

export type PriorityOptionId =
  | 'balanced'
  | 'p0_first'
  | 'high_value'
  | 'nearest'
  | 'zone_focus'
  | 'transfers_first';

export const PRIORITY_OPTIONS: ReadonlyArray<{ id: PriorityOptionId; label: string }> = [
  { id: 'balanced', label: 'Balanced' },
  { id: 'p0_first', label: '★ P0 First' },
  { id: 'high_value', label: '🃏 High-Value / Cards' },
  { id: 'nearest', label: '📍 Nearest Rack' },
  { id: 'zone_focus', label: '🗂️ Zone Focus' },
  { id: 'transfers_first', label: '🔄 Transfers First' },
];

export type ImmediateTaskOptionId =
  | 'auto'
  | 'pick_p0'
  | 'deliver_cargo'
  | 'charge_now'
  | 'clear_spill';

export const IMMEDIATE_TASK_OPTIONS: ReadonlyArray<{ id: ImmediateTaskOptionId; label: string }> = [
  { id: 'auto', label: 'Auto Shift Loop' },
  { id: 'pick_p0', label: '★ Pick P0 Order' },
  { id: 'deliver_cargo', label: '📦 Deliver Cargo' },
  { id: 'charge_now', label: '⚡ Charge Now' },
  { id: 'clear_spill', label: '🧹 Clear Spill' },
];

export const ZONE_CODES = ['A', 'B', 'C', 'D', 'E', 'F'] as const;

export interface AgentDraft {
  persona: Archetype;
  priority: PriorityOptionId;
  focusZones: string[];
  immediateTask: ImmediateTaskOptionId;
  speed: number;
  respect: number;
  chargeAt: number;
  batch: number;
  preemptForP0: boolean;
  poach: boolean;
  flatPath: boolean;
  note: string;
}

export function createDraftFromVehicle(v: Vehicle | null): AgentDraft {
  const persona: Archetype =
    (v?.directive?.persona as Archetype | undefined) ??
    (v?.directive?.strategy as Archetype | undefined) ??
    v?.strategy ??
    v?.strat ??
    'Steady';
  const baseTactics = defaultTacticsFor(persona);
  const t = { ...baseTactics, ...(v?.tactics ?? {}), ...(v?.directive?.tactics ?? {}) };
  const rawPriority = v?.directive?.priority;
  const priority: PriorityOptionId =
    rawPriority === 'p0_first' ||
    rawPriority === 'high_value' ||
    rawPriority === 'nearest' ||
    rawPriority === 'zone_focus' ||
    rawPriority === 'transfers_first'
      ? rawPriority
      : rawPriority === 'transfers'
        ? 'transfers_first'
        : 'balanced';

  const rawImmediate = v?.directive?.immediateTask;
  const immediateTask: ImmediateTaskOptionId =
    rawImmediate === 'pick_p0' ||
    rawImmediate === 'deliver_cargo' ||
    rawImmediate === 'charge_now' ||
    rawImmediate === 'clear_spill'
      ? rawImmediate
      : rawImmediate === 'charge'
        ? 'charge_now'
        : 'auto';

  const focusZones = Array.isArray(v?.directive?.focusZones)
    ? v!.directive!.focusZones.filter((z) => /^[A-F]$/.test(z))
    : v?.directive?.preferredZone && /^[A-F]$/.test(v.directive.preferredZone)
      ? [v.directive.preferredZone]
      : [];

  return {
    persona,
    priority,
    focusZones: [...new Set(focusZones)],
    immediateTask,
    speed: Number(Math.min(1.4, Math.max(0.6, t.speed ?? 1.0)).toFixed(2)),
    respect: Number(Math.min(1.0, Math.max(0.3, t.respect ?? 0.85)).toFixed(2)),
    chargeAt: Math.round(Math.min(40, Math.max(8, t.chargeAt ?? 20))),
    batch: Math.round(Math.min(3, Math.max(1, t.batch ?? 1))),
    preemptForP0: Boolean(t.preemptForP0 ?? true),
    poach: Boolean(t.poach ?? false),
    flatPath: Boolean(t.flatPath ?? false),
    note: typeof t.note === 'string' ? t.note : '',
  };
}

export function buildAgentDirectiveFromDraft(draft: AgentDraft): AgentDirective {
  const zones = draft.focusZones.filter((z) => /^[A-Z]$/.test(z)).slice(0, 6);
  const priorityLabel =
    PRIORITY_OPTIONS.find((p) => p.id === draft.priority)?.label.replace(/^[^\w]+/, '').trim() ??
    draft.priority;
  const zonePart = zones.length > 0 ? ` · Zones ${zones.join(',')}` : '';
  const summary = `${draft.persona} · ${priorityLabel}${zonePart} · ${draft.speed.toFixed(2)}× spd · charge ≤${draft.chargeAt}%`;

  return {
    autopilot: true,
    persona: draft.persona,
    strategy: draft.persona,
    priority: draft.priority,
    focusZones: zones,
    preferredZone: zones[0] ?? null,
    immediateTask: draft.immediateTask,
    tactics: {
      speed: draft.speed,
      respect: draft.respect,
      chargeAt: draft.chargeAt,
      batch: draft.batch,
      preemptForP0: draft.preemptForP0,
      poach: draft.poach,
      flatPath: draft.flatPath,
      ...(draft.note.trim() ? { note: draft.note.trim().slice(0, 120) } : {}),
    },
    summary,
  };
}

export function formatDirectiveSummary(
  v: Pick<Vehicle, 'autopilot' | 'strategy' | 'strat' | 'directive' | 'tactics'> | null | undefined,
): string {
  if (!v) return 'No vehicle assigned';
  if (!v.autopilot) {
    if (v.directive?.summary) return `Manual (WASD) · Saved: ${v.directive.summary}`;
    return 'Manual (WASD) · Press Esc or G to engage Co-Pilot';
  }
  if (v.directive?.summary) return v.directive.summary;
  const persona = v.directive?.persona ?? v.directive?.strategy ?? v.strategy ?? v.strat ?? 'Steady';
  const zones =
    v.directive?.focusZones && v.directive.focusZones.length > 0
      ? ` · Zones ${v.directive.focusZones.join(',')}`
      : v.directive?.preferredZone
        ? ` · Zone ${v.directive.preferredZone}`
        : '';
  const prio =
    v.directive?.priority && v.directive.priority !== 'balanced' && v.directive.priority !== 'normal'
      ? ` · ${v.directive.priority.replace(/_/g, ' ')}`
      : '';
  const spd = v.tactics?.speed ? ` · ${v.tactics.speed.toFixed(2)}×` : '';
  return `Co-Pilot (${persona}${prio}${zones}${spd})`;
}

export function mountAgentDesigner(overlay: HTMLElement, ctx: UiCtx): UiModule {
  const { store, actions } = ctx;

  let draft: AgentDraft = createDraftFromVehicle(store.myVehicle());
  let wasOpen = false;
  let lastEchoRef = store.ui.lastAgentEcho;

  // Header elements
  const titleBadge = el('span', { class: 'ad-veh-badge', text: 'DRV-01' });
  const modeBadge = el('span', { class: 'ad-mode-badge', text: 'MANUAL (WASD)' });
  const closeBtn = el('button', {
    class: 'btn sm ad-close-btn',
    title: 'Close Agent Designer (Esc or G)',
    text: '✕ Close (Esc)',
    attrs: { type: 'button' },
    onClick: () => actions.showAgentDesigner(false),
  });

  // Natural Language section
  const nlInput = el('textarea', {
    class: 'ad-nl-input',
    attrs: {
      id: 'agent-nl-input',
      rows: '2',
      maxlength: '280',
      placeholder:
        'Instruct your Co-Pilot in plain English (e.g. "Sweep Zones C & D, prioritize P0 orders, charge at 30%, drive fast")…',
    },
  });

  const dispatchNlPrompt = () => {
    const text = nlInput.value.trim();
    if (!text) return;
    actions.agentCommand({
      vid: store.you?.vid ?? undefined,
      mode: 'autopilot',
      text,
    });
  };

  const nlSendBtn = el('button', {
    class: 'btn primary ad-nl-send-btn',
    text: '✨ Ask Gemini Co-Pilot',
    attrs: { id: 'agent-nl-send', type: 'button' },
    onClick: dispatchNlPrompt,
  });

  nlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      dispatchNlPrompt();
    }
  });

  // Quick Intent Pills
  const pillsWrap = el('div', { class: 'ad-intent-pills' });
  for (const pill of QUICK_INTENT_PILLS) {
    const btn = el('button', {
      class: 'btn sm ad-intent-pill',
      title: pill.text,
      text: pill.label,
      attrs: { type: 'button', 'data-intent-id': pill.id },
      onClick: () => {
        if (pill.directive.persona) {
          draft.persona = pill.directive.persona;
          const defaults = defaultTacticsFor(draft.persona);
          draft.speed = defaults.speed;
          draft.respect = defaults.respect;
          draft.chargeAt = defaults.chargeAt;
          draft.batch = defaults.batch;
        }
        if (pill.directive.priority && PRIORITY_OPTIONS.some((p) => p.id === pill.directive.priority)) {
          draft.priority = pill.directive.priority as PriorityOptionId;
        }
        if (Array.isArray(pill.directive.focusZones)) {
          draft.focusZones = [...pill.directive.focusZones];
        }
        if (
          typeof pill.directive.immediateTask === 'string' &&
          IMMEDIATE_TASK_OPTIONS.some((t) => t.id === pill.directive.immediateTask)
        ) {
          draft.immediateTask = pill.directive.immediateTask as ImmediateTaskOptionId;
        }
        if (pill.directive.tactics) {
          if (typeof pill.directive.tactics.speed === 'number') draft.speed = pill.directive.tactics.speed;
          if (typeof pill.directive.tactics.respect === 'number') draft.respect = pill.directive.tactics.respect;
          if (typeof pill.directive.tactics.chargeAt === 'number') draft.chargeAt = pill.directive.tactics.chargeAt;
          if (typeof pill.directive.tactics.batch === 'number') draft.batch = pill.directive.tactics.batch;
          if (typeof pill.directive.tactics.preemptForP0 === 'boolean')
            draft.preemptForP0 = pill.directive.tactics.preemptForP0;
          if (typeof pill.directive.tactics.poach === 'boolean') draft.poach = pill.directive.tactics.poach;
          if (typeof pill.directive.tactics.flatPath === 'boolean')
            draft.flatPath = pill.directive.tactics.flatPath;
        }
        nlInput.value = pill.text;
        syncFormControlsFromDraft();
        actions.agentCommand({
          vid: store.you?.vid ?? undefined,
          mode: 'autopilot',
          text: pill.text,
          directive: pill.directive,
        });
      },
    });
    pillsWrap.appendChild(btn);
  }

  // Persona chips
  const personaWrap = el('div', { class: 'ad-chip-grid' });
  const personaButtons = new Map<Archetype, HTMLButtonElement>();
  for (const p of PERSONA_OPTIONS) {
    const b = el(
      'button',
      {
        class: 'ad-persona-chip',
        attrs: { type: 'button', 'data-persona': p.id },
        onClick: () => {
          draft.persona = p.id;
          const def = defaultTacticsFor(p.id);
          draft.speed = Number(def.speed.toFixed(2));
          draft.respect = Number(def.respect.toFixed(2));
          draft.chargeAt = Math.round(def.chargeAt);
          draft.batch = Math.round(def.batch);
          draft.preemptForP0 = Boolean(def.preemptForP0);
          draft.poach = Boolean(def.poach);
          draft.flatPath = Boolean(def.flatPath);
          syncFormControlsFromDraft();
        },
      },
      [el('strong', { text: p.label }), el('span', { class: 'ad-chip-desc', text: p.desc })],
    );
    personaButtons.set(p.id, b);
    personaWrap.appendChild(b);
  }

  // Priority mode chips
  const priorityWrap = el('div', { class: 'ad-pill-row' });
  const priorityButtons = new Map<PriorityOptionId, HTMLButtonElement>();
  for (const pr of PRIORITY_OPTIONS) {
    const b = el('button', {
      class: 'btn sm ad-choice-pill',
      text: pr.label,
      attrs: { type: 'button', 'data-priority': pr.id },
      onClick: () => {
        draft.priority = pr.id;
        syncFormControlsFromDraft();
      },
    });
    priorityButtons.set(pr.id, b);
    priorityWrap.appendChild(b);
  }

  // Focus Zones A-F multi-select
  const zonesWrap = el('div', { class: 'ad-pill-row' });
  const zoneButtons = new Map<string, HTMLButtonElement>();
  const allZonesBtn = el('button', {
    class: 'btn sm ad-choice-pill',
    text: 'All Zones',
    attrs: { type: 'button' },
    onClick: () => {
      draft.focusZones = [];
      syncFormControlsFromDraft();
    },
  });
  zonesWrap.appendChild(allZonesBtn);

  for (const z of ZONE_CODES) {
    const b = el('button', {
      class: 'btn sm ad-choice-pill ad-zone-pill',
      text: `Zone ${z}`,
      attrs: { type: 'button', 'data-zone': z },
      onClick: () => {
        if (draft.focusZones.includes(z)) {
          draft.focusZones = draft.focusZones.filter((x) => x !== z);
        } else {
          draft.focusZones = [...draft.focusZones, z].sort();
          if (draft.priority === 'balanced') draft.priority = 'zone_focus';
        }
        syncFormControlsFromDraft();
      },
    });
    zoneButtons.set(z, b);
    zonesWrap.appendChild(b);
  }

  // Immediate task chips
  const taskWrap = el('div', { class: 'ad-pill-row' });
  const taskButtons = new Map<ImmediateTaskOptionId, HTMLButtonElement>();
  for (const t of IMMEDIATE_TASK_OPTIONS) {
    const b = el('button', {
      class: 'btn sm ad-choice-pill',
      text: t.label,
      attrs: { type: 'button', 'data-task': t.id },
      onClick: () => {
        draft.immediateTask = t.id;
        syncFormControlsFromDraft();
      },
    });
    taskButtons.set(t.id, b);
    taskWrap.appendChild(b);
  }

  // Sliders
  const speedVal = el('span', { class: 'mono ad-slider-val', text: '1.00×' });
  const speedInput = el('input', {
    class: 'ad-slider',
    attrs: { type: 'range', min: '0.6', max: '1.4', step: '0.05', value: '1.0' },
  });
  speedInput.addEventListener('input', () => {
    draft.speed = Number(parseFloat(speedInput.value).toFixed(2));
    speedVal.textContent = `${draft.speed.toFixed(2)}×`;
  });

  const respectVal = el('span', { class: 'mono ad-slider-val', text: '0.85' });
  const respectInput = el('input', {
    class: 'ad-slider',
    attrs: { type: 'range', min: '0.3', max: '1.0', step: '0.05', value: '0.85' },
  });
  respectInput.addEventListener('input', () => {
    draft.respect = Number(parseFloat(respectInput.value).toFixed(2));
    respectVal.textContent = draft.respect.toFixed(2);
  });

  const chargeVal = el('span', { class: 'mono ad-slider-val', text: '20%' });
  const chargeInput = el('input', {
    class: 'ad-slider',
    attrs: { type: 'range', min: '8', max: '40', step: '2', value: '20' },
  });
  chargeInput.addEventListener('input', () => {
    draft.chargeAt = Math.round(parseFloat(chargeInput.value));
    chargeVal.textContent = `${draft.chargeAt}%`;
  });

  const batchVal = el('span', { class: 'mono ad-slider-val', text: '1' });
  const batchInput = el('input', {
    class: 'ad-slider',
    attrs: { type: 'range', min: '1', max: '3', step: '1', value: '1' },
  });
  batchInput.addEventListener('input', () => {
    draft.batch = Math.round(parseFloat(batchInput.value));
    batchVal.textContent = String(draft.batch);
  });

  // Checkboxes
  const preemptCb = el('input', { attrs: { type: 'checkbox' } });
  preemptCb.addEventListener('change', () => {
    draft.preemptForP0 = preemptCb.checked;
  });
  const poachCb = el('input', { attrs: { type: 'checkbox' } });
  poachCb.addEventListener('change', () => {
    draft.poach = poachCb.checked;
  });
  const flatPathCb = el('input', { attrs: { type: 'checkbox' } });
  flatPathCb.addEventListener('change', () => {
    draft.flatPath = flatPathCb.checked;
  });

  // Status & Echo readout
  const activeDirectiveText = el('div', { class: 'ad-status-line mono', text: '—' });
  const echoStatusText = el('div', { class: 'ad-echo-line', text: '' });

  // Footer buttons
  const deployBtn = el('button', {
    class: 'btn primary ad-deploy-btn',
    text: '🤖 Deploy Co-Pilot Directive',
    attrs: { id: 'agent-deploy-btn', type: 'button' },
    onClick: () => {
      const directive = buildAgentDirectiveFromDraft(draft);
      const nlText = nlInput.value.trim();
      actions.agentCommand({
        vid: store.you?.vid ?? undefined,
        mode: 'autopilot',
        directive,
        ...(nlText ? { text: nlText } : {}),
      });
    },
  });

  const manualBtn = el('button', {
    class: 'btn ad-manual-btn',
    text: '🕹️ Take Over Manually (WASD)',
    attrs: { id: 'agent-manual-btn', type: 'button' },
    onClick: () => {
      actions.setAutopilot(false);
      actions.showAgentDesigner(false);
    },
  });

  const resetBtn = el('button', {
    class: 'btn sm ad-reset-btn',
    text: '↺ Reset Persona Defaults',
    attrs: { type: 'button' },
    onClick: () => {
      const def = defaultTacticsFor(draft.persona);
      draft.priority = 'balanced';
      draft.focusZones = [];
      draft.immediateTask = 'auto';
      draft.speed = Number(def.speed.toFixed(2));
      draft.respect = Number(def.respect.toFixed(2));
      draft.chargeAt = Math.round(def.chargeAt);
      draft.batch = Math.round(def.batch);
      draft.preemptForP0 = Boolean(def.preemptForP0);
      draft.poach = Boolean(def.poach);
      draft.flatPath = Boolean(def.flatPath);
      nlInput.value = '';
      syncFormControlsFromDraft();
    },
  });

  function syncFormControlsFromDraft(): void {
    for (const [id, b] of personaButtons) {
      b.classList.toggle('active', id === draft.persona);
    }
    for (const [id, b] of priorityButtons) {
      b.classList.toggle('active', id === draft.priority);
    }
    allZonesBtn.classList.toggle('active', draft.focusZones.length === 0);
    for (const [z, b] of zoneButtons) {
      b.classList.toggle('active', draft.focusZones.includes(z));
    }
    for (const [id, b] of taskButtons) {
      b.classList.toggle('active', id === draft.immediateTask);
    }
    speedInput.value = String(draft.speed);
    speedVal.textContent = `${draft.speed.toFixed(2)}×`;
    respectInput.value = String(draft.respect);
    respectVal.textContent = draft.respect.toFixed(2);
    chargeInput.value = String(draft.chargeAt);
    chargeVal.textContent = `${draft.chargeAt}%`;
    batchInput.value = String(draft.batch);
    batchVal.textContent = String(draft.batch);
    preemptCb.checked = draft.preemptForP0;
    poachCb.checked = draft.poach;
    flatPathCb.checked = draft.flatPath;
  }

  const card = el(
    'div',
    {
      class: 'hud modal-card ad-modal-card',
      attrs: { role: 'dialog', 'aria-label': 'Co-Pilot & Agent Designer' },
    },
    [
      el('header', { class: 'ad-header' }, [
        el('div', { class: 'ad-header-left' }, [
          el('span', { class: 'ad-kicker', text: 'VEHICLE CO-PILOT & AGENT DESIGNER' }),
          el('div', { class: 'ad-title-row' }, [
            el('h2', { text: 'Direct Your Forklift Agent' }),
            titleBadge,
            modeBadge,
          ]),
        ]),
        closeBtn,
      ]),

      el('div', { class: 'ad-body' }, [
        // Section 1: Natural Language Co-Pilot + Quick Intent Pills
        el('section', { class: 'ad-section ad-nl-section' }, [
          el('div', { class: 'ad-section-head' }, [
            el('h3', { text: '1. Natural-Language Co-Pilot Instruction (Gemini 3.5 Flash-Lite)' }),
            el('span', { class: 'ad-hint', text: 'Press Enter to send or click a Quick Intent Pill' }),
          ]),
          el('div', { class: 'ad-nl-row' }, [nlInput, nlSendBtn]),
          el('div', { class: 'ad-pills-bar' }, [
            el('span', { class: 'ad-pills-label', text: 'Quick Intents:' }),
            pillsWrap,
          ]),
        ]),

        // Section 2: Persona & Priority
        el('section', { class: 'ad-section' }, [
          el('div', { class: 'ad-section-head' }, [
            el('h3', { text: '2. Agent Persona Archetype' }),
            resetBtn,
          ]),
          personaWrap,
        ]),

        // Section 3: Priority, Focus Zones, Immediate Task
        el('div', { class: 'ad-two-col' }, [
          el('section', { class: 'ad-section' }, [
            el('h3', { text: '3. Order Priority Mode' }),
            priorityWrap,
            el('h3', { class: 'ad-subhead', text: 'Immediate Task Override' }),
            taskWrap,
          ]),
          el('section', { class: 'ad-section' }, [
            el('h3', { text: '4. Rack Zone Focus (A–F)' }),
            el('p', {
              class: 'ad-small-note',
              text: 'Select up to 6 rack zones for your Co-Pilot to sweep, or leave on All Zones.',
            }),
            zonesWrap,
          ]),
        ]),

        // Section 4: Tactics Sliders & Flags
        el('section', { class: 'ad-section' }, [
          el('h3', { text: '5. Tactics & Operating Parameters' }),
          el('div', { class: 'ad-sliders-grid' }, [
            el('label', { class: 'ad-slider-row' }, [
              el('span', { class: 'ad-slider-lbl', text: 'Cruise Speed' }),
              speedInput,
              speedVal,
            ]),
            el('label', { class: 'ad-slider-row' }, [
              el('span', { class: 'ad-slider-lbl', text: 'Aisle Yield / Respect' }),
              respectInput,
              respectVal,
            ]),
            el('label', { class: 'ad-slider-row' }, [
              el('span', { class: 'ad-slider-lbl', text: 'Charge Threshold' }),
              chargeInput,
              chargeVal,
            ]),
            el('label', { class: 'ad-slider-row' }, [
              el('span', { class: 'ad-slider-lbl', text: 'Max Batch Size' }),
              batchInput,
              batchVal,
            ]),
          ]),
          el('div', { class: 'ad-flags-row' }, [
            el('label', { class: 'ad-flag-lbl' }, [
              preemptCb,
              el('span', { text: 'Preempt route for urgent ★ P0 orders' }),
            ]),
            el('label', { class: 'ad-flag-lbl' }, [
              poachCb,
              el('span', { text: 'Poach high-value / competitive orders' }),
            ]),
            el('label', { class: 'ad-flag-lbl' }, [
              flatPathCb,
              el('span', { text: 'Prefer low-traffic flat aisles' }),
            ]),
          ]),
        ]),

        // Section 5: Live Readout
        el('section', { class: 'ad-status-box' }, [
          el('div', { class: 'ad-status-header', text: 'ACTIVE VEHICLE DIRECTIVE & TELEMETRY' }),
          activeDirectiveText,
          echoStatusText,
        ]),
      ]),

      el('footer', { class: 'ad-footer' }, [
        el('div', {
          class: 'ad-footer-note',
          text: 'Tip: Press WASD or Arrow keys at any time on the floor to take manual control instantly. Press Esc to hand back to Co-Pilot.',
        }),
        el('div', { class: 'ad-footer-actions' }, [manualBtn, deployBtn]),
      ]),
    ],
  );

  overlay.replaceChildren(card);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) actions.showAgentDesigner(false);
  });

  return {
    update() {
      const open = store.ui.agentDesignerOpen;
      if (!open) {
        if (!overlay.hidden) overlay.hidden = true;
        wasOpen = false;
        return;
      }
      overlay.hidden = false;

      const me = store.myVehicle();
      if (!wasOpen) {
        wasOpen = true;
        draft = createDraftFromVehicle(me);
        syncFormControlsFromDraft();
      } else if (store.ui.lastAgentEcho !== lastEchoRef) {
        lastEchoRef = store.ui.lastAgentEcho;
        if (me) {
          draft = createDraftFromVehicle(me);
          syncFormControlsFromDraft();
        }
      }

      const vid = me?.id ?? store.you?.vid ?? 'No Vehicle';
      titleBadge.textContent = vid;
      const isAuto = Boolean(me?.autopilot);
      modeBadge.textContent = isAuto ? '🤖 CO-PILOT AUTO' : '🕹️ MANUAL (WASD)';
      modeBadge.className = `ad-mode-badge ${isAuto ? 'auto' : 'manual'}`;

      activeDirectiveText.textContent = formatDirectiveSummary(me);

      if (store.ui.agentCommandPending) {
        echoStatusText.textContent = '⏳ Synthesizing Co-Pilot directive via Gemini 3.5 Flash-Lite…';
        echoStatusText.className = 'ad-echo-line pending';
        nlSendBtn.disabled = true;
      } else {
        nlSendBtn.disabled = false;
        const echo = store.ui.lastAgentEcho;
        if (echo) {
          const msg = echo.summary ?? echo.reason ?? echo.raw ?? '';
          const ok = echo.status !== 'rejected' && echo.executed !== false;
          echoStatusText.textContent = ok ? `✓ ${msg}` : `⚠ ${msg}`;
          echoStatusText.className = `ad-echo-line ${ok ? 'ok' : 'err'}`;
        } else {
          echoStatusText.textContent =
            'Ready · Changes take effect immediately on your vehicle while keeping your driver lease and score.';
          echoStatusText.textContent =
            'Ready · Changes take effect immediately on your vehicle while keeping your driver lease and score.';
          echoStatusText.className = 'ad-echo-line';
        }
      }
    },
  };
}
