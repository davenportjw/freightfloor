import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { quantiseCoord } from '@warehouse/protocol';
import { applyClientInputSlice, createWorld, spawnPlayerVehicle, stepHuman } from '@warehouse/sim';
import {
  applyQuantisedDelta,
  formatRunDisplayName,
  nextRunDisplayName,
  parseRunDisplayName,
  reconcilePredictedVehicle,
  validateClientDisplayName,
} from '../src/main.js';
import { InputController, PREDICTION_GRACE_MS, thumbstickDirsFromVector } from '../src/input.js';
import {
  headingToIndex16,
  resolveVehicleSpriteKey,
  type AtlasManifest,
  type RenderVehicleOverlay,
} from '../src/renderer.js';

describe('@warehouse/client (M4)', () => {
  it('validates display names and rejects XSS payloads', () => {
    expect(validateClientDisplayName('<script>x</script>').ok).toBe(false);
    expect(validateClientDisplayName('img onerror=1').ok).toBe(false);
    expect(validateClientDisplayName('').ok).toBe(false);
    expect(validateClientDisplayName('   ').ok).toBe(false);
    expect(validateClientDisplayName('A'.repeat(19)).ok).toBe(false);

    const valid = validateClientDisplayName('  Alice_Op-1.0  ');
    expect(valid.ok).toBe(true);
    expect(valid.name).toBe('Alice_Op-1.0');
  });

  it('formats and increments Run N screen names within the 18-char display name limit', () => {
    expect(parseRunDisplayName('Alex')).toEqual({ baseName: 'Alex', runNumber: 1 });
    expect(parseRunDisplayName('Alex Run 3')).toEqual({ baseName: 'Alex', runNumber: 3 });
    expect(formatRunDisplayName('Alex', 1)).toBe('Alex Run 1');
    expect(nextRunDisplayName('Alex Run 1')).toBe('Alex Run 2');
    expect(nextRunDisplayName('Alex Run 2')).toBe('Alex Run 3');

    // Long base names are clipped so `Base Run N` never exceeds 18 chars and stays valid
    const longFormatted = formatRunDisplayName('ForkliftMaster99', 12);
    expect(longFormatted.length).toBeLessThanOrEqual(18);
    expect(validateClientDisplayName(longFormatted).ok).toBe(true);
    expect(parseRunDisplayName(longFormatted).runNumber).toBe(12);
  });

  it('resolves all 576 vehicle sprite keys against public/assets/atlas.json', () => {
    const atlasPath = resolve(import.meta.dirname, '../public/assets/atlas.json');
    expect(existsSync(atlasPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(atlasPath, 'utf8')) as AtlasManifest;

    const types = ['reach', 'counterbalance', 'turret', 'pallet_jack', 'forklift', 'agv'];
    const strategies = ['Sprinter', 'Steady', 'Batcher', 'Opportunist', 'Strategist'];

    for (const vType of types) {
      for (const strat of strategies) {
        for (const human of [false, true]) {
          for (const loaded of [false, true]) {
            for (let h = 0; h < 16; h++) {
              const angle = (h / 16) * Math.PI * 2;
              expect(headingToIndex16(angle)).toBe(h);
              const key = resolveVehicleSpriteKey(
                vType,
                strat,
                human,
                loaded,
                angle,
                manifest,
              );
              expect(manifest.sprites[key]).toBeDefined();
            }
          }
        }
      }
    }

    // Verify transfer bay and hazard sprites exist in atlas
    expect(manifest.sprites.transfer_bay_net).toBeDefined();
    expect(manifest.sprites.cone).toBeDefined();
    expect(manifest.sprites.spill).toBeDefined();
  });

  it('applies quantised deltas to AI vehicles while preserving local prediction on myVid', () => {
    const w = createWorld({ seed: 7, siteId: 'den-1' });
    const v1 = w.vehicles[0];
    const v2 = w.vehicles[1];
    v1.px = 10;
    v1.py = 10;
    v2.px = 20;
    v2.py = 20;

    const overlays = new Map<string, RenderVehicleOverlay>();
    applyQuantisedDelta(
      w,
      [
        {
          id: v1.id,
          qx: quantiseCoord(14.5),
          qy: quantiseCoord(15.25),
          battery: 88,
          humanCharging: true,
          brainThinking: true,
        },
        {
          id: v2.id,
          qx: quantiseCoord(22.5),
          qy: quantiseCoord(24.75),
          battery: 72,
          brainError: 'Quota limit reached',
          lastReason: 'Holding position safely',
        },
      ],
      v1.id, // v1 is locally driven by this player
      overlays,
    );

    // v1 position is preserved (predicted locally), battery and humanCharging updated
    expect(v1.px).toBe(10);
    expect(v1.py).toBe(10);
    expect(v1.battery).toBe(88);
    expect(v1.humanCharging).toBe(true);
    expect(overlays.get(v1.id)?.brainThinking).toBe(true);

    // v2 position is updated from quantised coordinates
    expect(v2.px).toBeCloseTo(22.5, 5);
    expect(v2.py).toBeCloseTo(24.75, 5);
    expect(v2.battery).toBe(72);
    expect(v2.brainError).toBe('Quota limit reached');
    // A bare lastReason must NOT fabricate a decision (no invented model/latency).
    expect(v2.lastDecision ?? null).toBeNull();
  });

  it('reconciles client-predicted vehicle against server ack and replays unacked inputs', () => {
    const w = createWorld({ seed: 11, siteId: 'den-1' });
    const v = w.vehicles[0];
    v.human = true;
    v.state = 'driven';
    v.px = 10;
    v.py = 2; // On highway row y=2
    v.tile = { x: 10, y: 2 };
    v.angle = 0;
    v.speedNow = 0;

    const inputForward = { up: true, down: false, left: false, right: false };
    stepHuman(w, v, inputForward, 0.05);
    const afterOneStepX = v.px;
    expect(afterOneStepX).toBeGreaterThan(10);

    // Server acks seq=1 at (10, 2), with seq=2 still unacked
    const remaining = reconcilePredictedVehicle(
      w,
      v,
      {
        type: 'ack',
        seq: 1,
        t: w.t,
        x: 10,
        y: 2,
        angle: 0,
        speedNow: 0,
      },
      [
        { seq: 1, input: inputForward, dt: 0.05 },
        { seq: 2, input: inputForward, dt: 0.05 },
      ],
    );

    expect(remaining).toHaveLength(1);
    expect(remaining[0].seq).toBe(2);
    expect(v.px).toBeCloseTo(afterOneStepX, 5);
  });

  it('syncs forkTarget from server fork deltas so local prediction does not bob the forks', async () => {
    const { RackLiftController } = await import('../src/ui/rackLiftMinigame.js');
    const { drawVehicle } = await import('../src/render/vehicles.js');
    const { dashView } = await import('../src/ui/dash.js');
    const w = createWorld({ seed: 11, siteId: 'den-1' });
    const v = w.vehicles[0];
    v.human = true;
    v.state = 'driven';
    v.px = 10;
    v.py = 2;
    v.tile = { x: 10, y: 2 };
    v.fork = 0.15;
    v.forkTarget = 0; // stale target, e.g. left over from join or a cancelled rack lift
    v.cargo = [{ id: 101, p0: false, bay: 'E1', value: 10, due: 100 } as any];

    applyQuantisedDelta(
      w,
      [{ id: v.id, qx: quantiseCoord(10), qy: quantiseCoord(2), fork: 0.3 }],
      v.id,
      new Map<string, RenderVehicleOverlay>(),
    );
    expect(v.fork).toBe(0.3);
    expect(v.forkTarget).toBe(0.3);

    // Stepping RackLiftController while disabled (the default) must not reset forkTarget to 0,
    // and drawVehicle must keep using sprite cargo at travel fork height 0.3 without blinking.
    const rackLift = new RackLiftController();
    const inputForward = { up: true, down: false, left: false, right: false };
    const spriteFrames: number[] = [];
    const mockPt: any = {
      ctx: { save() {}, restore() {}, setLineDash() {}, globalAlpha: 1 },
      circleGrid: () => [],
      poly: () => {},
      P: (x: number, y: number, z = 0) => [x, y - z],
      oBox: () => {},
      hasSprite: (k: string) => k.startsWith('cargo_'),
      sprite: () => {
        spriteFrames.push(1);
        return true;
      },
    };
    for (let i = 0; i < 10; i++) {
      rackLift.step(16, w, v, false);
      stepHuman(w, v, inputForward, 0.05);
      drawVehicle(mockPt, v, { x: v.px, y: v.py, a: v.angle }, {
        worldT: w.t,
        dim: false,
        emphasised: true,
        brainError: false,
        pulse: () => 0.5,
        nowMs: i * 16,
        siteId: 'den-1',
      });
    }
    expect(v.fork).toBeCloseTo(0.3, 6);
    expect(v.forkTarget).toBe(0.3);
    expect(spriteFrames).toHaveLength(10);

    // dashView shows Battery immediately when boost is held and reflects fractional drain below 100%
    expect(dashView({ battery: 100, input: { boost: false } }).showBattery).toBe(false);
    const boostedDash = dashView({ battery: 99.8, input: { boost: true } });
    expect(boostedDash.showBattery).toBe(true);
    expect(boostedDash.battery).toBe(99);
    expect(boostedDash.boosting).toBe(true);
  });

  it('keeps predicting while coasting, streams at 10 Hz while moving, and keeps the visual pose continuous across acks', () => {
    const w = createWorld({ seed: 13, siteId: 'den-1' });
    const v = w.vehicles[0];
    v.human = true;
    v.state = 'driven';
    v.px = 10;
    v.py = 2.5;
    v.tile = { x: 10, y: 2 };
    v.angle = 0;
    v.speedNow = 0;

    const sent: Array<{ seq: number; dt?: number; up: boolean }> = [];
    const ctrl = new InputController((m) => sent.push(m), () => true);
    ctrl.keyDown({ code: 'KeyW' }, 0);
    ctrl.predict(w, v, 50);
    ctrl.keyUp({ code: 'KeyW' }, 50); // seq 2 closes the 50 ms W slice
    expect(sent.at(-1)).toMatchObject({ seq: 2, up: false, dt: 0.05 });
    ctrl.predict(w, v, 30);

    // Still coasting: prediction stays on, and the stream keeps flowing at 10 Hz so the
    // server never has to guess the coast on its own.
    expect(v.speedNow).toBeGreaterThan(0.1);
    expect(ctrl.predicting(50 + PREDICTION_GRACE_MS + 500, v)).toBe(true);
    expect(ctrl.tick(150, false, true)).toBe(true);
    expect(sent.at(-1)).toMatchObject({ seq: 3, dt: 0.03 });
    expect(ctrl.tick(150, false, false)).toBe(false);

    // A genuine correction is blended: the visual pose is C0 continuous across the ack.
    const before = ctrl.visualPose(v);
    ctrl.applyAck(w, v, { type: 'ack', seq: 1, t: 1.0, x: 10.02, y: 2.5, angle: 0, speedNow: 0.2 });
    const after = ctrl.visualPose(v);
    expect(after.x).toBeCloseTo(before.x, 4);
    expect(after.y).toBeCloseTo(before.y, 4);
    expect(after.a).toBeCloseTo(before.a, 4);
  });

  it('accepts server pose on myVid when Co-Pilot autopilot is active and updates directive', () => {
    const w = createWorld({ seed: 19, siteId: 'den-1' });
    const v1 = w.vehicles[0]!;
    v1.px = 5;
    v1.py = 5;
    v1.autopilot = false;

    const overlays = new Map<string, RenderVehicleOverlay>();
    applyQuantisedDelta(
      w,
      [
        {
          id: v1.id,
          qx: quantiseCoord(12.25),
          qy: quantiseCoord(8.5),
          angle: 1.5,
          battery: 76,
          autopilot: true,
          directive: {
            autopilot: true,
            persona: 'Sprinter',
            priority: 'p0_first',
            immediateTask: 'auto',
            tactics: { chargeAt: 35 },
            summary: 'Sprinter · P0 First',
          },
        },
      ],
      v1.id, // v1 is myVid, but autopilot is true in delta
      overlays,
    );

    expect(v1.autopilot).toBe(true);
    expect(v1.px).toBeCloseTo(12.25, 5);
    expect(v1.py).toBeCloseTo(8.5, 5);
    expect(v1.directive?.persona).toBe('Sprinter');
    expect(v1.directive?.priority).toBe('p0_first');
    expect(v1.directive?.tactics?.chargeAt).toBe(35);
  });

  it('applies personal Blitz run telemetry and streak fields from quantised delta', () => {
    const w = createWorld({ seed: 23, siteId: 'den-1' });
    const v1 = w.vehicles[0]!;
    const overlays = new Map<string, RenderVehicleOverlay>();
    applyQuantisedDelta(
      w,
      [
        {
          id: v1.id,
          qx: quantiseCoord(v1.px),
          qy: quantiseCoord(v1.py),
          angle: 0,
          battery: 0,
          runMode: 'blitz',
          runStartedAt: 100,
          runEndsAt: 130,
          runPts: 145,
          runDeliveries: 6,
          runOnTime: 5,
          runIncidents: 0,
          streak: 5,
          bestStreak: 6,
          runFinished: true,
        },
      ],
      v1.id,
      overlays,
    );

    expect(v1.runMode).toBe('blitz');
    expect(v1.runStartedAt).toBe(100);
    expect(v1.runEndsAt).toBe(130);
    expect(v1.runPts).toBe(145);
    expect(v1.runDeliveries).toBe(6);
    expect(v1.runOnTime).toBe(5);
    expect(v1.streak).toBe(5);
    expect(v1.bestStreak).toBe(6);
    expect(v1.runFinished).toBe(true);

    // A stale in-flight delta generated 1 tick earlier must not reset myVid's started Blitz clock or finished state
    w.t = 130;
    applyQuantisedDelta(
      w,
      [
        {
          id: v1.id,
          qx: quantiseCoord(v1.px),
          qy: quantiseCoord(v1.py),
          angle: 0,
          runMode: 'blitz',
          runStartedAt: null,
          runEndsAt: null,
          runFinished: false,
        },
      ],
      v1.id,
      overlays,
    );
    expect(v1.runStartedAt).toBe(100);
    expect(v1.runEndsAt).toBe(130);
    expect(v1.runFinished).toBe(true);
  });

  it('quantises virtual thumbstick vectors into 8-way driving directions and 2:1 isometric world moveAngle', () => {
    // Inside deadzone -> neutral with null moveAngle
    const dead = thumbstickDirsFromVector(4, -5, 10, 38);
    expect(dead).toMatchObject({
      up: false,
      down: false,
      left: false,
      right: false,
      active: false,
      moveAngle: null,
    });

    // Straight up on screen (dx=0, dy=-30) -> isometric world (-1, -1) = -3*pi/4
    const up = thumbstickDirsFromVector(0, -30, 10, 38);
    expect(up).toMatchObject({ up: true, down: false, left: false, right: false, active: true });
    expect(up.moveAngle).toBeCloseTo(-3 * (Math.PI / 4), 2);

    // Straight down on screen (dx=0, dy=30) -> isometric world (+1, +1) = +pi/4
    const down = thumbstickDirsFromVector(0, 30, 10, 38);
    expect(down.moveAngle).toBeCloseTo(Math.PI / 4, 2);

    // Straight right on screen (dx=30, dy=0) -> isometric world (+1, -1) = -pi/4
    const right = thumbstickDirsFromVector(30, 0, 10, 38);
    expect(right.moveAngle).toBeCloseTo(-Math.PI / 4, 2);

    // Straight left on screen (dx=-30, dy=0) -> isometric world (-1, +1) = +3*pi/4
    const left = thumbstickDirsFromVector(-25, 0, 10, 38);
    expect(left).toMatchObject({ up: false, down: false, left: true, right: false, active: true });
    expect(left.moveAngle).toBeCloseTo(3 * (Math.PI / 4), 2);

    // Forward-right diagonal on screen (dx=28, dy=-28) -> clamped radius 38
    const upRight = thumbstickDirsFromVector(28, -28, 10, 38);
    expect(upRight).toMatchObject({ up: true, down: false, left: false, right: true, active: true });
    expect(Math.hypot(upRight.clampedX, upRight.clampedY)).toBeCloseTo(38, 4);

    // Reverse-left diagonal on screen (dx=-22, dy=22 -> wx=22, wy=66 -> atan2(3, 1))
    const downLeft = thumbstickDirsFromVector(-22, 22, 10, 38);
    expect(downLeft).toMatchObject({ up: false, down: true, left: true, right: false, active: true });
    expect(downLeft.moveAngle).toBeCloseTo(Math.atan2(3, 1), 2);

    // 2:1 isometric +Y world axis on screen (dx=-28, dy=14 -> wx=0, wy=56 -> +pi/2)
    const isoWorldSouth = thumbstickDirsFromVector(-28, 14, 10, 38);
    expect(isoWorldSouth.moveAngle).toBeCloseTo(Math.PI / 2, 2);
  });

  it('merges touch moveAngle and keyboard directions in InputController without clobbering held keys', () => {
    const sent: Array<{
      seq: number;
      up: boolean;
      down: boolean;
      left: boolean;
      right: boolean;
      boost?: boolean;
      moveAngle?: number | null;
    }> = [];
    const ctrl = new InputController((msg) => sent.push(msg), () => true);

    // Touch thumbstick steers with continuous board moveAngle
    ctrl.setTouchDirs({ up: true, right: true, moveAngle: -0.5 }, 100);
    expect(sent.at(-1)).toMatchObject({
      up: true,
      down: false,
      left: false,
      right: true,
      boost: false,
      moveAngle: -0.5,
    });

    // Sub-threshold moveAngle jitter (< 0.06 rad) with identical booleans does not spam network packets
    const countBeforeJitter = sent.length;
    ctrl.setTouchDirs({ up: true, right: true, moveAngle: -0.52 }, 105);
    expect(sent.length).toBe(countBeforeJitter);

    // Meaningful moveAngle rotation (>= 0.06 rad) sends an updated packet even within the same 8-way sector
    ctrl.setTouchDirs({ up: true, right: true, moveAngle: -0.35 }, 110);
    expect(sent.length).toBe(countBeforeJitter + 1);
    expect(sent.at(-1)?.moveAngle).toBeCloseTo(-0.35, 5);

    // Keyboard Shift held for boost while thumbstick is held
    ctrl.keyDown({ code: 'ShiftLeft' }, 120);
    expect(ctrl.isBoostHeld()).toBe(true);
    expect(sent.at(-1)).toMatchObject({ up: true, right: true, boost: true, moveAngle: -0.35 });

    // Releasing touch clears moveAngle to null while preserving keyboard Shift boost until keyUp
    ctrl.releaseTouch(150);
    expect(ctrl.isBoostHeld()).toBe(true);
    expect(sent.at(-1)).toMatchObject({
      up: false,
      down: false,
      left: false,
      right: false,
      boost: true,
      moveAngle: null,
    });

    ctrl.keyUp({ code: 'ShiftLeft' }, 180);
    expect(ctrl.isBoostHeld()).toBe(false);
    expect(sent.at(-1)).toMatchObject({ up: false, boost: false });
  });

  it('client-timed stream: server slices reproduce client prediction so steering taps never wobble the heading', () => {
    // Minimal client <-> server loop with jittered latency. The server applies each input's
    // client-measured slice on arrival (as apps/site does) and acks the pose; the client
    // reconciles. Corrections must be ~0, i.e. no left-right heading/position wobble.
    const sw = createWorld({ seed: 29, agents: 0 });
    const cw = createWorld({ seed: 29, agents: 0 });
    const sv = spawnPlayerVehicle(sw, 'wob', 'Wobble')!;
    const cv = cw.vehicles.find((x) => x.id === sv.id) ?? spawnPlayerVehicle(cw, 'wob', 'Wobble')!;
    const hy = sw.map.hwyY[1]!;
    for (const v of [sv, cv]) {
      v.px = 4.5;
      v.py = hy + 0.5;
      v.tile = { x: 4, y: hy };
      v.angle = 0;
      v.speedNow = 0;
    }
    let seed = 7;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const pending: Array<{ at: number; fn: () => void }> = [];
    let up = 0;
    let down = 0;
    let now = 0;
    const ctrl = new InputController(
      (msg) => {
        up = Math.max(up, now + 40 + (rand() - 0.5) * 30);
        pending.push({
          at: up,
          fn: () => {
            const next = { up: msg.up, down: msg.down, left: msg.left, right: msg.right, boost: Boolean(msg.boost) };
            applyClientInputSlice(sw, sv, { ...sv.input }, msg.dt ?? 0, next);
            const ack = { type: 'ack' as const, seq: msg.seq, t: sw.t, x: sv.px, y: sv.py, angle: sv.angle, speedNow: sv.speedNow };
            down = Math.max(down, up + 40 + (rand() - 0.5) * 30);
            pending.push({ at: down, fn: () => ctrl.applyAck(cw, cv, ack) });
          },
        });
      },
      () => true,
    );
    const held = { KeyW: false, KeyA: false, KeyD: false };
    let maxAngleErr = 0;
    let maxPosErr = 0;
    let last = 0;
    for (now = 0; now < 2400; now += 1000 / 60) {
      const want = {
        KeyW: now > 50,
        KeyA: now % 700 > 400 && now % 700 < 520,
        KeyD: now % 1100 > 800 && now % 1100 < 900,
      };
      for (const code of Object.keys(held) as Array<keyof typeof held>) {
        if (want[code] !== held[code]) {
          held[code] = want[code];
          if (want[code]) ctrl.keyDown({ code }, now);
          else ctrl.keyUp({ code }, now);
        }
      }
      pending.sort((a, b) => a.at - b.at);
      while (pending.length && pending[0]!.at <= now) {
        pending.shift()!.fn();
        maxAngleErr = Math.max(maxAngleErr, Math.abs(ctrl.errorAngle));
        maxPosErr = Math.max(maxPosErr, Math.hypot(ctrl.errorX, ctrl.errorY));
      }
      if (ctrl.predicting(now, cv)) ctrl.predict(cw, cv, now - last);
      last = now;
      ctrl.tick(now, false, Math.abs(cv.speedNow) > 0.001);
    }
    expect(Math.abs(cv.angle)).toBeGreaterThan(0.1); // it really steered
    expect(maxAngleErr).toBeLessThan(0.005);
    expect(maxPosErr).toBeLessThan(0.01);
  });

  it('styles #dash .hint-key and .meter.boost buttons without native browser button chrome', () => {
    const cssPath = resolve(import.meta.dirname, '../src/styles.css');
    const css = readFileSync(cssPath, 'utf8');
    const hintKeyMatch = css.match(/#dash\s+\.hint-key\s*\{([^}]*)\}/);
    expect(hintKeyMatch).not.toBeNull();
    const hintKeyBody = hintKeyMatch![1]!;
    expect(hintKeyBody).toContain('appearance: none');
    expect(hintKeyBody).toContain('background: transparent');
    expect(hintKeyBody).toContain('font: inherit');
    expect(hintKeyBody).toContain('border-radius: 8px');
    expect(hintKeyBody).toContain('cursor: pointer');
    expect(css).toContain('#dash .hint-key > span { text-box: trim-both cap alphabetic; }');
    expect(css).toContain('#dash .hint-key:hover');
  });

  it('shows the driving keys legend (WASD / E) left of Boost in #dash, with a ? Controls shortcut', () => {
    const dash = readFileSync(resolve(import.meta.dirname, '../src/ui/dash.ts'), 'utf8');
    const css = readFileSync(resolve(import.meta.dirname, '../src/styles.css'), 'utf8');
    expect(dash).toContain("root.replaceChildren(battery, driveKeys, boost, hints)");
    expect(dash).toContain("legend(['WASD'], 'Drive'");
    expect(dash).toContain("legend(['E'], 'Pick / Drop'");
    expect(dash).toContain("'data-role': 'all-controls'");
    expect(dash).toContain('actions.showHelp(true)');
    expect(css).toMatch(/#dash \.drive-keys \{[^}]*display: flex/);
  });

  it('enforces button, pill, and segmented-control QA invariants across help.ts, agentDesigner.ts, and styles.css', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../src/styles.css'), 'utf8');
    const help = readFileSync(resolve(import.meta.dirname, '../src/ui/help.ts'), 'utf8');
    const ad = readFileSync(resolve(import.meta.dirname, '../src/ui/agentDesigner.ts'), 'utf8');

    // Intro "How the AI works" / "How to Play" buttons use .btn pill styling (never .textlink underline inside a bordered box)
    expect(help).toContain("button('🧠 How the AI works', 'btn intro-ai-link'");
    expect(help).toContain("button('← How to Play', 'btn intro-back-link'");
    expect(help).not.toContain('textlink intro-ai-link');
    expect(help).not.toContain('textlink intro-back-link');
    expect(css).toMatch(/\.intro-tabs\s*\{[^}]*background:\s*transparent;[^}]*border:\s*0;/);
    expect(css).toMatch(/\.intro-ai-link,\s*\.intro-back-link\s*\{[^}]*text-decoration:\s*none;[^}]*border-radius:\s*999px;/);

    // Core button primitives support both .on/.active and .small/.sm and .drive/.primary aliases
    expect(css).toContain('.btn.on, .btn.active');
    expect(css).toContain('.btn.drive, .btn.primary');
    expect(css).toContain('.btn.small, .btn.sm');
    expect(css).toContain('.seg-btn.on, .seg-btn.active, .seg-btn.current');

    // Co-Pilot & Agent Designer classes exist in styles.css and sync both .active/.on + aria-pressed
    expect(css).toContain('.ad-persona-chip');
    expect(css).toContain('.ad-choice-pill');
    expect(css).toContain('.ad-intent-pill');
    expect(ad).toContain("b.classList.toggle('active', on)");
    expect(ad).toContain("b.classList.toggle('on', on)");
    expect(ad).toContain("b.setAttribute('aria-pressed', String(on))");

    // Run capsule mode button suppresses hover highlight and pointer cursor when disabled on Run 1
    expect(css).toContain('#run button.seg:not(:disabled):hover');
    expect(css).toContain('#run button.seg:disabled { cursor: default; }');
  });
});


