import { beforeEach, describe, expect, it } from 'vitest';
import { createWorld, postOrder } from '@warehouse/sim';
import { ClientStore, RACK_LIFT_KEY, readRackLiftOverride } from '../src/state.js';
import { RackLiftController, TWO_TAP_THRESHOLD_MS } from '../src/ui/rackLiftMinigame.js';

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  };
}

describe('RackLiftController & Rack Lift Minigame feature flag', () => {
  let memStorage: Storage;

  beforeEach(() => {
    memStorage = createMemoryStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      value: memStorage,
      configurable: true,
      writable: true,
    });
  });

  it('1. defaults the feature flag to OFF (store.isRackLiftEnabled() === false)', () => {
    const store = new ClientStore();
    expect(readRackLiftOverride(memStorage)).toBeNull();
    expect(store.isRackLiftEnabled()).toBe(false);
  });

  it('2. store.setRackLiftMinigame(true) enables the minigame and persists to localStorage', () => {
    const store = new ClientStore();
    store.setRackLiftMinigame(true);
    expect(store.isRackLiftEnabled()).toBe(true);
    expect(memStorage.getItem(RACK_LIFT_KEY)).toBe('1');
    expect(readRackLiftOverride(memStorage)).toBe(true);

    store.setRackLiftMinigame(false);
    expect(store.isRackLiftEnabled()).toBe(false);
    expect(memStorage.getItem(RACK_LIFT_KEY)).toBe('0');
    expect(readRackLiftOverride(memStorage)).toBe(false);
  });

  it('3. returns { action: "immediate" } when disabled (1-tap legacy behavior)', () => {
    const world = createWorld({ seed: 42 });
    const v = world.vehicles[0]!;
    v.cargo = [];
    const order = postOrder(world)!;
    order.slot = { ...order.slot, id: 'R1-1', zone: 'A', level: 2 };
    v.x = order.slot.ax;
    v.y = order.slot.ay;
    v.px = v.x + 0.5;
    v.py = v.y + 0.5;

    const ctrl = new RackLiftController();
    const res = ctrl.onKeyDown(1000, world, v, false);
    expect(res).toEqual({ action: 'immediate' });
    expect(ctrl.isActive()).toBe(false);
  });

  it('4. holding E on an L3 rack order raises me.fork into the L3 sweet spot (~0.90) and commits a perfect lift on release', () => {
    const world = createWorld({ seed: 42 });
    const v = world.vehicles[0]!;
    v.cargo = [];
    const order = postOrder(world)!;
    order.slot = { ...order.slot, id: 'R1-1', zone: 'A', level: 2 };
    expect(order.slot.level).toBe(2);

    v.x = order.slot.ax;
    v.y = order.slot.ay;
    v.px = v.x + 0.5;
    v.py = v.y + 0.5;
    v.speed = 2.0;

    const ctrl = new RackLiftController();
    const downRes = ctrl.onKeyDown(1000, world, v, true);
    expect(downRes).toEqual({ action: 'lifting', level: 2 });
    expect(ctrl.isActive()).toBe(true);

    // Step 750ms -> fork rises from 0.08 by 0.75 * 1.12 = 0.84 -> 0.92 (inside L3 sweet spot 0.90 ± 0.11)
    ctrl.step(750, world, v, true);
    expect(v.fork).toBeGreaterThanOrEqual(0.85);
    expect(v.fork).toBeLessThanOrEqual(0.96);

    const upRes = ctrl.onKeyUp(1000 + 750, v);
    expect(upRes.action).toBe('commit');
    if (upRes.action === 'commit') {
      expect(upRes.forkHeight).toBeCloseTo(0.92, 2);
      expect(upRes.evaluation.grade).toBe('perfect');
      expect(upRes.evaluation.bonusPts).toBeGreaterThanOrEqual(5);
    }
    expect(ctrl.isActive()).toBe(false);
    expect(ctrl.lastFlash(1800)?.grade).toBe('perfect');
  });

  it('5. quick-tapping E (< 140ms) on an L2 rack order switches to twoTapConfirm mode instead of scraping at fork=0.08, and a second tap commits', () => {
    const world = createWorld({ seed: 42 });
    const v = world.vehicles[0]!;
    v.cargo = [];
    const order = postOrder(world)!;
    order.slot = { ...order.slot, id: 'R1-1', zone: 'A', level: 1 };
    expect(order.slot.level).toBe(1);

    v.x = order.slot.ax;
    v.y = order.slot.ay;
    v.px = v.x + 0.5;
    v.py = v.y + 0.5;

    const ctrl = new RackLiftController();
    const downRes = ctrl.onKeyDown(2000, world, v, true);
    expect(downRes).toEqual({ action: 'lifting', level: 1 });

    // Release after 80ms (< TWO_TAP_THRESHOLD_MS = 140ms)
    expect(80).toBeLessThan(TWO_TAP_THRESHOLD_MS);
    const upRes = ctrl.onKeyUp(2080, v);
    expect(upRes).toEqual({ action: 'continue_two_tap' });
    expect(ctrl.isActive()).toBe(true);
    expect(ctrl.isTwoTapConfirmPending()).toBe(true);

    // Step ~410ms so fork reaches ~0.54 (L2 sweet spot)
    ctrl.step(410, world, v, true);
    expect(v.fork).toBeGreaterThan(0.45);
    expect(v.fork).toBeLessThan(0.65);

    // Second keydown commits at the current fork height
    const secondTap = ctrl.onKeyDown(2490, world, v, true);
    expect(secondTap.action).toBe('commit');
    if (secondTap.action === 'commit') {
      expect(secondTap.evaluation.grade).toBe('perfect');
      expect(secondTap.forkHeight).toBeCloseTo(v.fork, 3);
    }
    expect(ctrl.isActive()).toBe(false);
  });

  it('6. non-rack interactions (inbound DOCK-* pickup, outbound bay drop, charger) always return { action: "immediate" } even when enabled', () => {
    const world = createWorld({ seed: 42 });
    const v = world.vehicles[0]!;
    v.cargo = [];
    const ctrl = new RackLiftController();

    // Case A: Inbound dock pickup (slot.id starts with DOCK-)
    const dockOrder = postOrder(world)!;
    dockOrder.slot = {
      ...dockOrder.slot,
      id: 'DOCK-IN-1',
      zone: 'IN',
      level: 0,
    };
    v.x = dockOrder.slot.ax;
    v.y = dockOrder.slot.ay;
    v.px = v.x + 0.5;
    v.py = v.y + 0.5;
    expect(ctrl.onKeyDown(3000, world, v, true)).toEqual({ action: 'immediate' });

    // Case B: Outbound bay drop
    const bay = world.map.bays[0]!;
    const bayTile = bay.tiles[0]!;
    dockOrder.state = 'picked';
    dockOrder.bay = bay.id;
    delete dockOrder.putaway;
    v.cargo = [dockOrder];
    v.x = bayTile.x;
    v.y = bayTile.y;
    v.px = v.x + 0.5;
    v.py = v.y + 0.5;
    expect(ctrl.onKeyDown(3100, world, v, true)).toEqual({ action: 'immediate' });

    // Case C: Charger interaction
    v.cargo = [];
    const charger = world.map.chargers[0]!;
    v.x = charger.x;
    v.y = charger.y;
    v.px = v.x + 0.5;
    v.py = v.y + 0.5;
    v.battery = 40;
    expect(ctrl.onKeyDown(3200, world, v, true)).toEqual({ action: 'immediate' });
  });

  it('7. mountHelp reactively updates Step 2, .intro-chips (+$5–$10 perfect lift), and All controls E row when rackLiftMinigame toggles', async () => {
    class MiniNode {
      children: Array<MiniElement | MiniText> = [];
      get textContent(): string {
        return this.children.map((c) => c.textContent).join('');
      }
      set textContent(v: string) {
        this.children = v ? [new MiniText(String(v))] : [];
      }
    }
    class MiniText extends MiniNode {
      constructor(public raw: string) {
        super();
      }
      override get textContent(): string {
        return this.raw;
      }
      override set textContent(v: string) {
        this.raw = String(v);
      }
    }
    class MiniElement extends MiniNode {
      tagName: string;
      className = '';
      title = '';
      hidden = false;
      readonly dataset: Record<string, string> = {};
      readonly style: Record<string, string> & { setProperty: (k: string, v: string) => void } = {
        display: '',
        setProperty(k: string, v: string) {
          this[k] = v;
        },
      };
      readonly classList = {
        toggle: () => false,
        add: () => {},
        remove: () => {},
        contains: () => false,
      };
      private attrs = new Map<string, string>();
      private listeners = new Map<string, Array<(ev: unknown) => void>>();
      constructor(tag: string) {
        super();
        this.tagName = tag.toUpperCase();
      }
      setAttribute(k: string, v: string): void {
        this.attrs.set(k, String(v));
      }
      getAttribute(k: string): string | null {
        return this.attrs.get(k) ?? null;
      }
      append(...nodes: Array<MiniElement | MiniText | string>): void {
        for (const n of nodes) {
          this.children.push(typeof n === 'string' ? new MiniText(n) : n);
        }
      }
      replaceChildren(...nodes: Array<MiniElement | MiniText | string>): void {
        this.children = [];
        this.append(...nodes);
      }
      addEventListener(type: string, fn: (ev: unknown) => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(fn);
        this.listeners.set(type, list);
      }
      click(): void {
        for (const fn of this.listeners.get('click') ?? []) {
          fn({ target: this, preventDefault() {} });
        }
      }
      focus(): void {}
      queryAll(pred: (el: MiniElement) => boolean): MiniElement[] {
        const out: MiniElement[] = [];
        const walk = (node: MiniElement | MiniText) => {
          if (node instanceof MiniElement) {
            if (pred(node)) out.push(node);
            for (const ch of node.children) walk(ch);
          }
        };
        walk(this);
        return out;
      }
    }

    const prevDoc = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = {
      createElement: (tag: string) => new MiniElement(tag),
      createElementNS: (_ns: string, tag: string) => new MiniElement(tag),
      createTextNode: (text: string) => new MiniText(text),
    };

    try {
      const { mountHelp } = await import('../src/ui/help.js');
      const store = new ClientStore();
      const overlay = new MiniElement('div');
      const ctx = {
        store,
        actions: {
          enterFloorFromIntro: () => true,
        },
      } as unknown as import('../src/ui/context.js').UiCtx;

      const helpMod = mountHelp(overlay as unknown as HTMLElement, ctx, {});

      // Default OFF
      const steps = overlay.queryAll((e) => e.className === 'intro-step__body');
      expect(steps[1]?.textContent).toBe('Pull up to a glowing pallet and press E.');
      const chips = overlay.queryAll((e) => e.className === 'intro-chip');
      const liftChip = chips.find((c) => c.textContent.includes('perfect lift'))!;
      expect(liftChip).toBeDefined();
      expect(liftChip.hidden).toBe(true);
      expect(liftChip.style.display).toBe('none');
      const rows = overlay.queryAll((e) => e.tagName === 'TR');
      const eRow = rows.find((r) => r.children[0]?.textContent === 'E')!;
      expect(eRow.children[1]?.textContent).toBe('Pick up pallet, drop at bay, or start charging');

      const toggleBtn = overlay.queryAll((e) => e.getAttribute('data-role') === 'lift-mode-toggle')[0]!;
      const explainer = overlay.queryAll((e) => e.getAttribute('data-role') === 'lift-mode-explainer')[0]!;
      expect(toggleBtn).toBeDefined();
      expect(explainer).toBeDefined();
      expect(toggleBtn.textContent).toBe('Lift Mode: OFF');
      expect(toggleBtn.getAttribute('aria-pressed')).toBe('false');
      expect(explainer.hidden).toBe(true);
      expect(explainer.style.display).toBe('none');

      // Clicking the intro page Lift Mode toggle button enables the feature flag and shows the explanation
      toggleBtn.click();
      expect(store.isRackLiftEnabled()).toBe(true);
      expect(toggleBtn.textContent).toBe('Lift Mode: ON');
      expect(toggleBtn.getAttribute('aria-pressed')).toBe('true');
      expect(explainer.hidden).toBe(false);
      expect(explainer.style.display).toBe('');
      expect(explainer.textContent).toContain('How Lift Mode works:');
      expect(explainer.textContent).toContain('L1 Low');
      expect(explainer.textContent).toContain('L2 Mid');
      expect(explainer.textContent).toContain('L3 High');
      expect(explainer.textContent).toContain('Perfect Lift');
      expect(explainer.textContent).toContain('Clean Lift');
      expect(explainer.textContent).toContain('Rack Scrape');
      expect(steps[1]?.textContent).toBe(
        'Pull up to a glowing rack pallet, hold E to raise forks (L1–L3), and release E in the sweet spot.',
      );
      expect(liftChip.hidden).toBe(false);
      expect(liftChip.style.display).toBe('');
      expect(eRow.children[1]?.textContent).toBe(
        'Hold & release at rack to lift (L1–L3), or press at bay / charger',
      );

      // Disable again -> reverts cleanly and hides the explanation
      store.setRackLiftMinigame(false);
      helpMod.update();
      expect(toggleBtn.textContent).toBe('Lift Mode: OFF');
      expect(toggleBtn.getAttribute('aria-pressed')).toBe('false');
      expect(explainer.hidden).toBe(true);
      expect(explainer.style.display).toBe('none');
      expect(steps[1]?.textContent).toBe('Pull up to a glowing pallet and press E.');
      expect(liftChip.hidden).toBe(true);
      expect(liftChip.style.display).toBe('none');
      expect(eRow.children[1]?.textContent).toBe('Pick up pallet, drop at bay, or start charging');
    } finally {
      (globalThis as Record<string, unknown>).document = prevDoc;
    }
  });

  it('8. mountObjective shows Hold E · L3 and [L3] in objective text when rackLiftMinigame is enabled on an L3 rack order, and reverts to E when false', async () => {
    class MiniNode {
      children: Array<MiniElement | MiniText> = [];
      get textContent(): string {
        return this.children.map((c) => c.textContent).join('');
      }
      set textContent(v: string) {
        this.children = v ? [new MiniText(String(v))] : [];
      }
    }
    class MiniText extends MiniNode {
      constructor(public raw: string) {
        super();
      }
      override get textContent(): string {
        return this.raw;
      }
    }
    class MiniElement extends MiniNode {
      tagName: string;
      className = '';
      title = '';
      hidden = false;
      readonly dataset: Record<string, string> = {};
      readonly style: Record<string, string> & { setProperty: (k: string, v: string) => void } = {
        setProperty(k: string, v: string) {
          this[k] = v;
        },
      };
      constructor(tag: string) {
        super();
        this.tagName = tag.toUpperCase();
      }
      setAttribute(): void {}
      append(...nodes: Array<MiniElement | MiniText | string>): void {
        for (const n of nodes) {
          this.children.push(typeof n === 'string' ? new MiniText(n) : n);
        }
      }
      replaceChildren(...nodes: Array<MiniElement | MiniText | string>): void {
        this.children = [];
        this.append(...nodes);
      }
      addEventListener(): void {}
    }

    const prevDoc = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = {
      createElement: (tag: string) => new MiniElement(tag),
      createElementNS: (_ns: string, tag: string) => new MiniElement(tag),
      createTextNode: (text: string) => new MiniText(text),
    };

    try {
      const { mountObjective } = await import('../src/ui/objective.js');
      const store = new ClientStore();
      store.world = createWorld({ seed: 42 });
      const order = postOrder(store.world)!;
      order.slot = { ...order.slot, id: 'R1-1', rackId: 'R1', zone: 'A', level: 2 };
      const v = store.world.vehicles[0]!;
      v.human = true;
      v.x = order.slot.ax;
      v.y = order.slot.ay;
      v.px = v.x + 0.5;
      v.py = v.y + 0.5;
      v.tile = { x: v.x, y: v.y };
      store.myVid = v.id;
      store.you = { clientId: 'c1', name: 'Pilot', role: 'driver', vid: v.id };
      store.side.guides.set(v.id, {
        kind: 'pick',
        x: order.slot.ax,
        y: order.slot.ay,
        inRange: true,
        text: `Pick #${order.id} at R1 — press E`,
        order: {
          id: order.id,
          slot: { rackId: 'R1', level: 2 },
        },
      });

      const objectiveEl = new MiniElement('div');
      const fareEl = new MiniElement('div');
      const alertEl = new MiniElement('div');
      const relocEl = new MiniElement('div');
      const ctx = {
        store,
        actions: {
          acceptRelocation: () => {},
          dismissRelocation: () => {},
          selectFareOption: () => {},
          confirmFareOption: () => {},
        },
      } as unknown as import('../src/ui/context.js').UiCtx;

      const objMod = mountObjective(
        objectiveEl as unknown as HTMLElement,
        fareEl as unknown as HTMLElement,
        alertEl as unknown as HTMLElement,
        relocEl as unknown as HTMLElement,
        ctx,
        () => 'Steady',
      );

      // Enabled: shows [L3], hold E, and · Hold E · L3 badge
      store.setRackLiftMinigame(true);
      objMod.update();
      expect(objectiveEl.textContent).toContain('[L3]');
      expect(objectiveEl.textContent).toContain('hold E');
      expect(objectiveEl.textContent).toContain('· Hold E · L3');

      // Disabled: reverts to standard press E and · E
      store.setRackLiftMinigame(false);
      objMod.update();
      expect(objectiveEl.textContent).not.toContain('[L3]');
      expect(objectiveEl.textContent).toContain('press E');
      expect(objectiveEl.textContent).toContain('· E');
      expect(objectiveEl.textContent).not.toContain('Hold E · L3');
    } finally {
      (globalThis as Record<string, unknown>).document = prevDoc;
    }
  });

  it('9. computeRackLiftGaugeLayout produces enlarged dimensions and clamps safely on desktop (1440×900) and mobile (390×844)', async () => {
    const { computeRackLiftGaugeLayout } = await import('../src/renderer.js');

    // Desktop (1440×900)
    const desktop = computeRackLiftGaugeLayout(1440, 900, 720, 450, false);
    expect(desktop.isCompact).toBe(false);
    expect(desktop.trackW).toBeGreaterThanOrEqual(22);
    expect(desktop.trackH).toBeGreaterThanOrEqual(112);
    expect(desktop.cardW).toBe(desktop.trackW + 40);
    expect(desktop.cardH).toBe(desktop.trackH + 28);
    expect(desktop.cursorH).toBe(6);
    expect(desktop.labelFontPx).toBe(11);

    // Desktop active (holding E boosts width +2, height +6)
    const desktopActive = computeRackLiftGaugeLayout(1440, 900, 720, 450, true);
    expect(desktopActive.trackW).toBe(desktop.trackW + 2);
    expect(desktopActive.trackH).toBe(desktop.trackH + 6);

    // Mobile (390×844) near bottom-right corner to verify viewport clamping
    const mobile = computeRackLiftGaugeLayout(390, 844, 385, 820, false);
    expect(mobile.isCompact).toBe(true);
    expect(mobile.trackW).toBeGreaterThanOrEqual(26);
    expect(mobile.trackH).toBeGreaterThanOrEqual(126);
    expect(mobile.cardW).toBe(mobile.trackW + 44);
    expect(mobile.cardH).toBe(mobile.trackH + 28);
    expect(mobile.cursorH).toBe(7);
    expect(mobile.labelFontPx).toBe(12);
    expect(mobile.cardX).toBeGreaterThanOrEqual(12);
    expect(mobile.cardX + mobile.cardW).toBeLessThanOrEqual(390 - 12);
    expect(mobile.cardY).toBeGreaterThanOrEqual(88);
    expect(mobile.cardY + mobile.cardH).toBeLessThanOrEqual(844 - 160);
  });
});
