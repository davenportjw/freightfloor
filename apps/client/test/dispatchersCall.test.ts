import { beforeEach, describe, expect, it } from 'vitest';
import type { DispatchersCallMinigame, DispatchersCallRevealMessage, SimEvent, SiteLimits } from '@warehouse/protocol';
import { calloutFor } from '../src/render/fx.js';
import { ClientStore } from '../src/state.js';
import {
  DC_GRACE_MS,
  DC_REVEAL_MS,
  DISPATCHERS_CALL_KEY,
  dcActionId,
  dcApplyReveal,
  dcCanPick,
  dcRevealLine,
  dcSecondsLeft,
  dcTimeLeft,
  dcVisible,
  isDispatchersCallScreen,
  newDispatchersCallCard,
  readDispatchersCallOverride,
} from '../src/ui/dispatchersCall.js';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  };
}

const minigame: DispatchersCallMinigame = {
  id: 'dc-v1-950',
  kind: 'dispatchers_call',
  deadlineMs: 8000,
  deadlineT: 103,
  situation: 'p0_surge',
  question: 'Two P0s are open. Which do we send?',
  options: [
    {
      idx: 0,
      label: 'Rush both P0s',
      desc: 'Reroute 2 P0 pallets to E1',
      action: { sourceZone: 'any', targetBay: 'E1', priority: 'p0', count: 2, mode: 'reroute_only' },
    },
    {
      idx: 1,
      label: 'Spawn general freight',
      desc: 'Spawn 3 standard pallets to auto',
      action: { sourceZone: 'general', targetBay: 'auto', priority: 'standard', count: 3, mode: 'spawn_only' },
    },
  ],
};

const reveal = (over: Partial<DispatchersCallRevealMessage>): DispatchersCallRevealMessage => ({
  type: 'dispatchersCallReveal',
  id: minigame.id,
  playerIdx: 0,
  geminiIdx: 0,
  geminiLabel: 'Rush both P0s',
  geminiReason: 'P0 deadlines are closest',
  agreed: true,
  timedOut: false,
  summary: null,
  orderIds: [],
  evalUntil: null,
  ...over,
});

describe("Dispatcher's Call client helpers", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true, writable: true });
  });

  it('recognises minigame screens and builds dc-opt-N action ids', () => {
    expect(isDispatchersCallScreen({ minigame } as never)).toBe(true);
    expect(isDispatchersCallScreen({} as never)).toBe(false);
    expect(dcActionId(2)).toBe('dc-opt-2');
  });

  it('counts down the 8 s ring and locks picks at the deadline', () => {
    const card = newDispatchersCallCard(minigame, 1000);
    expect(dcTimeLeft(card, 1000)).toBe(1);
    expect(dcTimeLeft(card, 5000)).toBeCloseTo(0.5);
    expect(dcSecondsLeft(card, 1500)).toBe(8);
    expect(dcCanPick(card, 8999)).toBe(true);
    expect(dcCanPick(card, 9000)).toBe(false);
    expect(dcCanPick({ ...card, picked: 1 }, 2000)).toBe(false);
    expect(dcVisible(card, 9000 + DC_GRACE_MS - 1)).toBe(true);
    expect(dcVisible(card, 9000 + DC_GRACE_MS)).toBe(false);
  });

  it('applies only the matching reveal and keeps the card up for the reveal window', () => {
    const card = newDispatchersCallCard(minigame, 0);
    expect(dcApplyReveal(card, reveal({ id: 'other' }), 100)).toBe(card);
    const next = dcApplyReveal(card, reveal({ playerIdx: 1, agreed: false }), 2000)!;
    expect(next.picked).toBe(1);
    expect(dcCanPick(next, 2100)).toBe(false);
    expect(dcVisible(next, 2000 + DC_REVEAL_MS - 1)).toBe(true);
    expect(dcVisible(next, 2000 + DC_REVEAL_MS)).toBe(false);
  });

  it('writes the agreed / disagreed / timed-out reveal line', () => {
    expect(dcRevealLine(reveal({}))).toBe('You and Gemini agreed: P0 deadlines are closest');
    expect(dcRevealLine(reveal({ agreed: false, playerIdx: 1 }))).toBe(
      'Gemini would have picked “Rush both P0s”: P0 deadlines are closest',
    );
    expect(dcRevealLine(reveal({ agreed: false, playerIdx: null, timedOut: true }))).toMatch(/^Time's up\. Gemini would/);
  });

  it('shows a +N popup for a scored result and nothing for a timeout', () => {
    const ev = (over: Record<string, unknown>) => ({ t: 1, type: 'dispatchers_call_result', text: '', vid: 'v1', ...over }) as SimEvent;
    expect(calloutFor(ev({ pts: 15, timedOut: false }), 'v1')).toEqual({ text: "+15 DISPATCHER'S CALL", tone: 'good' });
    expect(calloutFor(ev({ pts: 0, timedOut: false }), 'v1')?.tone).toBe('info');
    expect(calloutFor(ev({ pts: 0, timedOut: true }), 'v1')).toBeNull();
    expect(calloutFor(ev({ pts: 15 }), 'v2')).toBeNull();
  });

  it('reads the localStorage override and gates on the server flag', () => {
    expect(readDispatchersCallOverride()).toBeNull();
    const store = new ClientStore();
    expect(store.isDispatchersCallEnabled()).toBe(false); // no welcome yet
    store.limits = { dispatchersCall: true } as SiteLimits;
    expect(store.isDispatchersCallEnabled()).toBe(true); // default ON
    store.dispatchersCall = newDispatchersCallCard(minigame, 0);
    store.setDispatchersCallPref(false);
    expect(store.isDispatchersCallEnabled()).toBe(false);
    expect(store.dispatchersCall).toBeNull();
    expect(localStorage.getItem(DISPATCHERS_CALL_KEY)).toBe('0');
    expect(readDispatchersCallOverride()).toBe(false);
    store.limits = { dispatchersCall: false } as SiteLimits;
    store.setDispatchersCallPref(true);
    expect(store.isDispatchersCallEnabled()).toBe(false);
  });
});
