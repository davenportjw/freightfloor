import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { quantiseCoord } from '@warehouse/protocol';
import { createWorld, stepHuman } from '@warehouse/sim';
import {
  applyQuantisedDelta,
  reconcilePredictedVehicle,
  validateClientDisplayName,
} from '../src/main.js';
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

    // v1 position is preserved (predicted locally), battery updated
    expect(v1.px).toBe(10);
    expect(v1.py).toBe(10);
    expect(v1.battery).toBe(88);
    expect(overlays.get(v1.id)?.brainThinking).toBe(true);

    // v2 position is updated from quantised coordinates
    expect(v2.px).toBeCloseTo(22.5, 5);
    expect(v2.py).toBeCloseTo(24.75, 5);
    expect(v2.battery).toBe(72);
    expect(v2.brainError).toBe('Quota limit reached');
    expect(v2.lastDecision?.reason).toBe('Holding position safely');
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
});
