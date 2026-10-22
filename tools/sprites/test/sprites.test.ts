import { existsSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CELL,
  COLS,
  generateAtlas,
  REGIONAL_CARGO_SPRITE_NAMES,
  REGIONAL_CONVEYOR_SPRITE_NAMES,
  STRATEGY_TINT_MAP,
  TEAM_TINTS,
  VEHICLE_TYPE_ALIASES,
} from '../src/index.js';

describe('@warehouse/sprites isometric 3D atlas generator', () => {
  it('generates 96x96 isometric 3D atlas.png and atlas.json with all 576 vehicle headings, regional cargo/conveyor sprites, and environment tiles', () => {
    const { pngPath, jsonPath, manifest } = generateAtlas();
    expect(existsSync(pngPath)).toBe(true);
    expect(existsSync(jsonPath)).toBe(true);
    expect(statSync(pngPath).size).toBeGreaterThan(25000);
    expect(statSync(jsonPath).size).toBeGreaterThan(5000);

    expect(manifest.tileSize).toBe(96);
    expect(manifest.vehicleCellSize).toBe(96);
    expect(CELL).toBe(96);
    expect(COLS).toBe(24);
    expect(manifest.meta.size.w).toBe(COLS * CELL);

    for (const vtype of ['reach', 'counterbalance', 'turret'] as const) {
      for (const tint of Object.keys(TEAM_TINTS)) {
        for (const load of ['empty', 'loaded'] as const) {
          for (let h = 0; h < 16; h++) {
            const key = `vehicle_${vtype}_${tint}_${load}_h${h}`;
            const frame = manifest.frames[key];
            expect(frame).toBeDefined();
            expect(frame.w).toBe(96);
            expect(frame.h).toBe(96);
            expect(frame.anchor).toEqual({ x: 0.5, y: 0.62 });
            expect(manifest.vehicles[vtype][tint][load][h]).toBeDefined();
          }
        }
      }
    }

    // Verify all type and strategy aliases resolve cleanly
    for (const aliasType of Object.keys(VEHICLE_TYPE_ALIASES)) {
      for (const strat of Object.keys(STRATEGY_TINT_MAP)) {
        const key = `vehicle_${aliasType}_${strat}_loaded_h7`;
        expect(manifest.frames[key]).toBeDefined();
        expect(manifest.sprites[key]).toBeDefined();
      }
    }

    // Verify all 20 regional cargo sprites and 8 regional conveyor sprites exist
    expect(REGIONAL_CARGO_SPRITE_NAMES).toHaveLength(20);
    for (const cargoKey of REGIONAL_CARGO_SPRITE_NAMES) {
      expect(manifest.frames[cargoKey]).toBeDefined();
      expect(manifest.sprites[cargoKey]).toEqual(
        expect.objectContaining({ w: 96, h: 96 }),
      );
    }

    expect(REGIONAL_CONVEYOR_SPRITE_NAMES).toHaveLength(8);
    for (const convKey of REGIONAL_CONVEYOR_SPRITE_NAMES) {
      expect(manifest.frames[convKey]).toBeDefined();
      expect(manifest.sprites[convKey]).toEqual(
        expect.objectContaining({ w: 96, h: 96 }),
      );
    }

    for (const tile of [
      'rack_empty',
      'rack_stocked',
      'conveyor_h',
      'trailer',
      'charger',
      'charger_busy',
      'cone',
      'spill',
      'transfer_bay_net',
      'floor_main',
    ]) {
      expect(manifest.frames[tile]).toBeDefined();
    }
  });
});
