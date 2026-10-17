import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { quantiseCoord } from '@warehouse/protocol';
import { createWorld, stepHuman } from '@warehouse/sim';
import {
  applyQuantisedDelta,
  formatRunDisplayName,
  nextRunDisplayName,
  parseRunDisplayName,
  reconcilePredictedVehicle,
  validateClientDisplayName,
} from '../src/main.js';
import { InputController, PREDICTION_GRACE_MS } from '../src/input.js';
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

  it('keeps predicting while vehicle is coasting past PREDICTION_GRACE_MS and smooths ack visual corrections', () => {
    const w = createWorld({ seed: 13, siteId: 'den-1' });
    const v = w.vehicles[0];
    v.human = true;
    v.state = 'driven';
    v.px = 10;
    v.py = 2.5;
    v.tile = { x: 10, y: 2 };
    v.angle = 0;
    v.speedNow = 0;

    const ctrl = new InputController(() => {}, () => true);
    ctrl.keyDown({ code: 'KeyW' }, 0);
    ctrl.predict(w, v, 50); // seq 1 advances 50ms
    ctrl.keyUp({ code: 'KeyW' }, 50); // seq 2 (release)
    ctrl.predict(w, v, 30); // seq 2 advances 30ms

    // Even after PREDICTION_GRACE_MS has elapsed since keyUp, predicting(now, v) stays true while coasting
    expect(v.speedNow).toBeGreaterThan(0.1);
    expect(ctrl.predicting(50 + PREDICTION_GRACE_MS + 500, v)).toBe(true);

    // First ack at server tick t=1.0 for seq=1
    const visualBeforeAck = ctrl.visualPose(v);
    ctrl.applyAck(w, v, {
      type: 'ack',
      seq: 1,
      t: 1.0,
      x: 10.02,
      y: 2.5,
      angle: 0,
      speedNow: 0.2,
    });
    const visualImmediatelyAfterAck = ctrl.visualPose(v);
    // Visual pose must be C0 continuous across ack (no instantaneous screen jump)
    expect(visualImmediatelyAfterAck.x).toBeCloseTo(visualBeforeAck.x, 4);
    expect(visualImmediatelyAfterAck.y).toBeCloseTo(visualBeforeAck.y, 4);

    // Duplicate ack from the same server tick (t=1.0) for seq=2 must NOT erase seq=2's sub-tick dt
    const pxBeforeSameTickAck = v.px;
    ctrl.applyAck(w, v, {
      type: 'ack',
      seq: 2,
      t: 1.0,
      x: 10.02,
      y: 2.5,
      angle: 0,
      speedNow: 0.2,
    });
    expect(v.px).toBeCloseTo(pxBeforeSameTickAck, 6);
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
  });
});



