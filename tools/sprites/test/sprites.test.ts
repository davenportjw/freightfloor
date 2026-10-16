import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateAtlas, TEAM_TINTS } from '../src/index.js';

describe('@warehouse/sprites procedural atlas generator', () => {
  it('generates atlas.png and atlas.json with all vehicle headings, load states, tints, and environment tiles', () => {
    const { pngPath, jsonPath, manifest } = generateAtlas();
    expect(existsSync(pngPath)).toBe(true);
    expect(existsSync(jsonPath)).toBe(true);
    expect(statSync(pngPath).size).toBeGreaterThan(10000);
    expect(statSync(jsonPath).size).toBeGreaterThan(1000);

    for (const vtype of ['reach', 'counterbalance', 'turret'] as const) {
      for (const tint of Object.keys(TEAM_TINTS)) {
        for (const load of ['empty', 'loaded'] as const) {
          for (let h = 0; h < 16; h++) {
            const key = `vehicle_${vtype}_${tint}_${load}_h${h}`;
            expect(manifest.frames[key]).toBeDefined();
            expect(manifest.vehicles[vtype][tint][load][h]).toBeDefined();
          }
        }
      }
    }

    for (const tile of [
      'rack_empty',
      'rack_stocked',
      'conveyor_h',
      'trailer',
      'charger',
      'cone',
      'spill',
      'transfer_bay_net',
      'floor_main',
    ]) {
      expect(manifest.frames[tile]).toBeDefined();
    }
  });
});
