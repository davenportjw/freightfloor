/**
 * Fleet pill (mock lines 115-120): vehicle count, wing tier, add/remove agents via manager ops.
 */
import type { SiteLimits } from '@warehouse/protocol';
import { BASE_FLEET, FLEET_CAP, MAX_TIER, TIER_STEP, type Vehicle } from '@warehouse/sim';
import type { UiCtx, UiModule } from './context.js';
import { button, el } from './dom.js';
import { DASH } from './format.js';

export interface FleetView {
  text: string;
  title: string;
  canAdd: boolean;
  canRemove: boolean;
  addTitle: string;
  removeTitle: string;
}

/**
 * Limits come from the welcome message; the sim constants are the same values the site
 * server is built with and are only used when an older site omits `limits`.
 */
export function fleetView(
  vehicles: readonly Vehicle[],
  tier: number,
  limits: SiteLimits | null,
  welcomed: boolean,
): FleetView {
  if (!welcomed) {
    return { text: DASH, title: 'Waiting for the site.', canAdd: false, canRemove: false, addTitle: '', removeTitle: '' };
  }
  const cap = limits?.fleetCap ?? FLEET_CAP;
  const maxTier = limits?.maxTier ?? MAX_TIER;
  const base = limits?.baseFleet ?? BASE_FLEET;
  const step = limits?.tierStep ?? TIER_STEP;
  const n = vehicles.length;
  const humans = vehicles.filter((v) => v.human).length;
  const agents = n - humans;
  const removable = vehicles.filter((v) => v.extra && !v.human).length;
  const next = base + step * tier + 1;
  const minAgents = limits?.minAutonomousAgents ?? 0;
  const maxAgents = limits?.maxAutonomousAgents ?? Infinity;
  const canAdd = n < cap && agents < maxAgents;
  const canRemove = removable > 0 && agents > minAgents;
  return {
    text: `${n} vehicles · wing ${tier}/${maxTier}`,
    title:
      `${agents} AI agents, ${humans} human-driven. ` +
      (tier < maxTier ? `Next wing at ${next} vehicles.` : 'Facility is at full size.'),
    canAdd,
    canRemove,
    addTitle: canAdd
      ? 'Add a real AI agent. Past the base fleet size the warehouse builds a new wing.'
      : n >= cap
        ? `Fleet is at its cap (${cap}).`
        : `Agent limit reached (${maxAgents}).`,
    removeTitle: canRemove
      ? 'Remove the most recently added idle agent'
      : removable === 0
        ? 'No added agents to remove.'
        : `Minimum of ${minAgents} agents.`,
  };
}

export function mountFleet(zone: HTMLElement, ctx: UiCtx): UiModule {
  const info = el('span', { class: 'num fleet-info' });
  const down = button('−', 'btn', () => ctx.actions.manager('fleetRemove'));
  const up = button('+ Agent', 'btn', () => ctx.actions.manager('fleetAdd'));
  const root = el('div', { class: 'hud pill-row fleet' }, [el('span', { class: 'label', text: 'Fleet' }), info, down, up]);
  zone.append(root);
  return {
    update() {
      const s = ctx.store;
      const v = fleetView(s.world.vehicles, s.world.tier, s.limits, s.welcomed);
      info.textContent = v.text;
      info.title = v.title;
      up.disabled = !v.canAdd;
      up.title = v.addTitle;
      down.disabled = !v.canRemove;
      down.title = v.removeTitle;
    },
  };
}
