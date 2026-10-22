import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as sim from '../src/index.js';

/**
 * Doc ↔ code parity for docs/gameplay.md §1–6 (scoring, timing, cards). Every
 * `NAME = value` the doc states must match the exported constant, and the key tables /
 * lists (rating multipliers, combo steps, perk caps, Blitz deck) must match the code.
 */
const here = dirname(fileURLToPath(import.meta.url));
const full = readFileSync(resolve(here, '../../../docs/gameplay.md'), 'utf8');
const doc = full.slice(0, full.indexOf('## 7. Client UI'));

const num = (s: string): number => Number(s.replace(/[^\d.]/g, ''));

/** All values the doc assigns to `NAME = <number>`. */
function documented(name: string): number[] {
  const re = new RegExp(`\\b${name}\\s*=\\s*\`?([\\d.]+)`, 'g');
  return [...doc.matchAll(re)].map((m) => Number(m[1]));
}

const NUMERIC: Record<string, number> = {
  BLITZ_DURATION_MIN: sim.BLITZ_DURATION_MIN,
  RUN_CARD_GRACE_MIN: sim.RUN_CARD_GRACE_MIN,
  BOOST_SPEED_MUL: sim.BOOST_SPEED_MUL,
  INTERACT_REACH: sim.INTERACT_REACH,
  PAR_BASE_SPEED: sim.PAR_BASE_SPEED,
  PAR_OVERHEAD: sim.PAR_OVERHEAD,
  PAR_DROP_TIME: sim.PAR_DROP_TIME,
  PRECISION_WINDOW_MIN: sim.PRECISION_WINDOW_MIN,
  INBOUND_INTERVAL_MIN: sim.INBOUND_INTERVAL_MIN,
  PUTAWAY_VALUE: sim.PUTAWAY_VALUE,
  XDOCK_WINDOW_MIN: sim.XDOCK_WINDOW_MIN,
  XDOCK_BONUS: sim.XDOCK_BONUS,
  XDOCK_AI_HOLD_MIN: sim.XDOCK_AI_HOLD_MIN,
  HAND_LIMIT: sim.HAND_LIMIT,
  CONTRACT_RESERVE_MIN: sim.CONTRACT_RESERVE_MIN,
  LAST_CALL_MIN: sim.LAST_CALL_MIN,
  LAST_CALL_PTS: sim.LAST_CALL_PTS,
  LONG_PAR_MIN: sim.LONG_PAR_MIN,
  SHORT_PAR_MAX: sim.SHORT_PAR_MAX,
  GHOST_RATIO: sim.GHOST_RATIO,
  RIVAL_GRUDGE_MIN: sim.RIVAL_GRUDGE_MIN,
  FARE_OPTION_COUNT: sim.FARE_OPTION_COUNT,
  FARE_CHOICE_TIMEOUT_MIN: sim.FARE_CHOICE_TIMEOUT_MIN,
  COLLISION_SPEED: sim.COLLISION_SPEED,
  CRASH_STUN_MIN: sim.CRASH_STUN_MIN,
  VICTIM_STUN_MIN: sim.VICTIM_STUN_MIN,
  RIVAL_SNIPE_COOLDOWN_MIN: sim.RIVAL_SNIPE_COOLDOWN_MIN,
  BLITZ_DEAL_SIZE: sim.BLITZ_DEAL_SIZE,
  DISPATCHERS_CALL_OPEN_MIN: sim.DISPATCHERS_CALL_OPEN_MIN,
  DISPATCHERS_CALL_CLOSE_MIN: sim.DISPATCHERS_CALL_CLOSE_MIN,
  DISPATCHERS_CALL_PICK_MIN: sim.DISPATCHERS_CALL_PICK_MIN,
  DISPATCHERS_CALL_EVAL_MIN: sim.DISPATCHERS_CALL_EVAL_MIN,
  DISPATCHERS_CALL_PTS_PER_PALLET: sim.DISPATCHERS_CALL_PTS_PER_PALLET,
  DISPATCHERS_CALL_MAX_PTS: sim.DISPATCHERS_CALL_MAX_PTS,
  DISPATCHERS_CALL_P0_SURGE: sim.DISPATCHERS_CALL_P0_SURGE,
  DISPATCHERS_CALL_BAY_FILL: sim.DISPATCHERS_CALL_BAY_FILL,
  DISPATCHERS_CALL_HAZMAT_BACKLOG: sim.DISPATCHERS_CALL_HAZMAT_BACKLOG,
  DISPATCHERS_CALL_DOCK_BACKLOG: sim.DISPATCHERS_CALL_DOCK_BACKLOG,
  CHOSEN_ORDER_TTL_MIN: sim.CHOSEN_ORDER_TTL_MIN,
  ORDER_VALUE: sim.ORDER_VALUE,
  P0_ORDER_VALUE: sim.P0_ORDER_VALUE,
};

describe('docs/gameplay.md §1–6 parity with @warehouse/sim', () => {
  for (const [name, value] of Object.entries(NUMERIC)) {
    it(`${name} = ${value}`, () => {
      const vals = documented(name);
      expect(vals.length, `${name} is not documented as \`${name} = …\``).toBeGreaterThan(0);
      for (const v of vals) expect(v).toBe(value);
    });
  }

  it('COMBO_STEPS', () => {
    const m = doc.match(/\(`COMBO_STEPS`\):\s*`([^`]+)`/);
    expect(m).not.toBeNull();
    const steps = [...m![1].matchAll(/×([\d.]+)/g)].map((x) => Number(x[1]));
    expect(steps).toEqual([...sim.COMBO_STEPS]);
  });

  it('rating table: multipliers and Speedy / Slow thresholds', () => {
    const row = (label: string) => doc.split('\n').find((l) => l.startsWith(`| **${label}**`))!;
    const speedy = row('Speedy');
    const normal = row('Normal');
    const slow = row('Slow');
    expect(num(speedy.match(/\*\*([\d.]+)×\*\*/)![1])).toBe(sim.RATING_MUL.speedy);
    expect(num(normal.match(/\*\*([\d.]+)×\*\*/)![1])).toBe(sim.RATING_MUL.normal);
    expect(num(slow.match(/\*\*([\d.]+)×\*\*/)![1])).toBe(sim.RATING_MUL.slow);
    expect(Number(speedy.match(/actual ≤ ([\d.]+) × par/)![1])).toBe(sim.SPEEDY_RATIO);
    expect(Number(slow.match(/actual > ([\d.]+) × par/)![1])).toBe(sim.SLOW_RATIO);
  });

  it('WILD_CHANCE', () => {
    const m = doc.match(/WILD_CHANCE = (\d+)%/);
    expect(m).not.toBeNull();
    expect(Number(m![1]) / 100).toBe(sim.WILD_CHANCE);
  });

  it('PERK_CAPS', () => {
    const m = doc.match(/\(`PERK_CAPS`\):([^\n]+)/);
    expect(m).not.toBeNull();
    const line = m![1];
    const pick = (re: RegExp) => Number(line.match(re)![1]);
    expect(pick(/speed ≤ `([\d.]+)×`/)).toBe(sim.PERK_CAPS.speedMul);
    expect(pick(/reach ≤ `\+([\d.]+)`/)).toBe(sim.PERK_CAPS.reachBonus);
    expect(pick(/battery drain ≥ `([\d.]+)×`/)).toBe(sim.PERK_CAPS.batteryDrainMul);
    expect(pick(/boost drain \(`drainMul`\) ≥ `([\d.]+)×`/)).toBe(sim.PERK_CAPS.boostDrainMul);
    expect(pick(/charger bonus \(`chargeBonus`\) ≤ `\+([\d.]+) %\/s`/)).toBe(sim.PERK_CAPS.chargeBonus);
    expect(pick(/fork speed ≤ `([\d.]+)×`/)).toBe(sim.PERK_CAPS.forkLiftMul);
    expect(pick(/combo floor ≤ `×([\d.]+)`/)).toBe(sim.COMBO_STEPS[sim.PERK_CAPS.comboFloor]);
  });

  it('Blitz deck card list', () => {
    const m = doc.match(/\(`BLITZ_DECK`\)[^\n]*?\*\*([^*]+)\*\*\./);
    expect(m).not.toBeNull();
    const listed = m![1].split(',').map((s) => s.trim());
    expect(listed).toEqual([...sim.BLITZ_DECK]);
    for (const title of sim.BLITZ_DECK) expect(sim.SKILLS.some((s) => s.title === title)).toBe(true);
  });

  it('no streak multiplier is documented or exported', () => {
    expect(doc).not.toMatch(/streakMultiplier/);
    expect((sim as Record<string, unknown>).streakMultiplier).toBeUndefined();
  });

  it("Dispatcher's Call is documented in gameplay, protocol and operations", () => {
    expect(doc).toMatch(/## 3c\. Dispatcher's Call/);
    const protocol = readFileSync(resolve(here, '../../../docs/protocol.md'), 'utf8');
    const ops = readFileSync(resolve(here, '../../../docs/operations.md'), 'utf8');
    for (const name of [
      'dispatchersCallPref',
      'dispatchersCallReveal',
      'dispatchers_call',
      'dispatchers_call_pick',
      'dispatchers_call_result',
      'dc-opt-<idx>',
      '`dispatchersCall?`',
      'minigame?: DispatchersCallMinigame',
    ]) {
      expect(protocol, name).toContain(name);
    }
    for (const kind of ['spill', 'p0_surge', 'trailer_near_cap', 'hazmat_backlog', 'dock_backlog']) {
      expect(protocol, kind).toContain(kind);
    }
    for (const name of ['ENABLE_DISPATCHERS_CALL', 'enable_dispatchers_call', '?dispatch=1|0', 'warehouse.feature.dispatchersCall']) {
      expect(ops, name).toContain(name);
    }
  });
});
