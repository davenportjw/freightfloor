import { createCanvas, SKRSContext2D } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SPRITES_VERSION = 1;

export type SpriteVehicleType = 'reach' | 'counterbalance' | 'turret';
export type SpriteLoadState = 'empty' | 'loaded';
export type SpriteTeamTint = 'amber' | 'teal' | 'indigo' | 'emerald' | 'rose' | 'slate';

export interface AtlasFrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AtlasFrameEntry extends AtlasFrameRect {
  frame: AtlasFrameRect;
  rotated: boolean;
  trimmed: boolean;
  spriteSourceSize: AtlasFrameRect;
  sourceSize: { w: number; h: number };
  anchor: { x: number; y: number };
}

export interface SpriteAtlasManifest {
  version: number;
  tileSize: number;
  vehicleCellSize: number;
  meta: {
    app: string;
    version: string;
    image: string;
    format: string;
    size: { w: number; h: number };
    scale: string;
  };
  tints: Record<SpriteTeamTint, { primary: string; dark: string; light: string }>;
  strategyTintMap: Record<string, SpriteTeamTint>;
  vehicleTypeAliases: Record<string, SpriteVehicleType>;
  frames: Record<string, AtlasFrameEntry>;
  sprites: Record<string, AtlasFrameRect>;
  vehicles: Record<
    string,
    Record<string, Record<SpriteLoadState, Record<number, AtlasFrameRect>>>
  >;
}

const VEHICLE_TYPES: SpriteVehicleType[] = ['reach', 'counterbalance', 'turret'];
const HEADINGS = 16;
const LOAD_STATES: SpriteLoadState[] = ['empty', 'loaded'];

export const TEAM_TINTS: Record<
  SpriteTeamTint,
  { primary: string; dark: string; light: string }
> = {
  amber: { primary: '#D97706', dark: '#92400E', light: '#FBBF24' },
  teal: { primary: '#0D9488', dark: '#115E59', light: '#2DD4BF' },
  indigo: { primary: '#4F46E5', dark: '#3730A3', light: '#818CF8' },
  emerald: { primary: '#16A34A', dark: '#166534', light: '#4ADE80' },
  rose: { primary: '#E11D48', dark: '#9F1239', light: '#FB7185' },
  slate: { primary: '#475569', dark: '#1E293B', light: '#94A3B8' },
};

export const STRATEGY_TINT_MAP: Record<string, SpriteTeamTint> = {
  Sprinter: 'rose',
  Steady: 'indigo',
  Batcher: 'emerald',
  Opportunist: 'amber',
  Strategist: 'slate',
  Human: 'teal',
};

export const VEHICLE_TYPE_ALIASES: Record<string, SpriteVehicleType> = {
  reach: 'reach',
  counterbalance: 'counterbalance',
  forklift: 'counterbalance',
  turret: 'turret',
  pallet_jack: 'turret',
  agv: 'turret',
};

const CELL = 48; // 48x48 per cell in atlas
const COLS = 32; // 32 columns * 48px = 1536px wide

function roundRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

function drawPalletLoad(ctx: SKRSContext2D, x: number, y: number, w: number, h: number): void {
  // Wooden pallet base
  ctx.fillStyle = '#B47B38';
  roundRect(ctx, x, y, w, h, 2);
  ctx.fill();
  ctx.strokeStyle = '#6B4216';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Slats
  ctx.fillStyle = '#8F5B22';
  ctx.fillRect(x + 1, y + 2, w - 2, 2);
  ctx.fillRect(x + 1, y + h / 2 - 1, w - 2, 2);
  ctx.fillRect(x + 1, y + h - 4, w - 2, 2);

  // Strapped carton on top
  ctx.fillStyle = '#D6A35C';
  roundRect(ctx, x + 2, y + 2, w - 4, h - 4, 1.5);
  ctx.fill();
  ctx.strokeStyle = '#FEF3C7';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 2, y + h / 2);
  ctx.lineTo(x + w - 2, y + h / 2);
  ctx.stroke();
}

function drawVehicleCell(
  ctx: SKRSContext2D,
  cx: number,
  cy: number,
  vtype: SpriteVehicleType,
  headingIdx: number,
  loadState: SpriteLoadState,
  tint: { primary: string; dark: string; light: string },
): void {
  const angle = (headingIdx / HEADINGS) * Math.PI * 2;
  ctx.save();
  ctx.translate(cx + CELL / 2, cy + CELL / 2);
  ctx.rotate(angle);

  // Soft drop shadow
  ctx.fillStyle = 'rgba(15, 23, 42, 0.22)';
  roundRect(ctx, -15, -11, 31, 24, 6);
  ctx.fill();

  // Wheels (4 industrial rubber tires)
  ctx.fillStyle = '#1E293B';
  ctx.fillRect(-13, -12, 7, 3);
  ctx.fillRect(4, -12, 7, 3);
  ctx.fillRect(-13, 9, 7, 3);
  ctx.fillRect(4, 9, 7, 3);

  // Steel forks extending forward (+X is heading 0)
  ctx.fillStyle = '#475569';
  const forkLen = vtype === 'reach' ? 14 : vtype === 'counterbalance' ? 12 : 11;
  ctx.fillRect(6, -7, forkLen, 2.6);
  ctx.fillRect(6, 4.4, forkLen, 2.6);
  // High-visibility fork tips
  ctx.fillStyle = '#F59E0B';
  ctx.fillRect(6 + forkLen - 2.5, -7, 2.5, 2.6);
  ctx.fillRect(6 + forkLen - 2.5, 4.4, 2.5, 2.6);

  if (loadState === 'loaded') {
    drawPalletLoad(ctx, 8, -8.5, 12, 17);
  }

  // Mast bar
  ctx.fillStyle = '#1E293B';
  ctx.fillRect(5, -9.5, 3, 19);

  if (vtype === 'counterbalance') {
    // Rear counterweight
    ctx.fillStyle = tint.dark;
    roundRect(ctx, -15, -10, 9, 20, 4);
    ctx.fill();

    // Main body
    ctx.fillStyle = tint.primary;
    roundRect(ctx, -10, -9.5, 16, 19, 3.5);
    ctx.fill();
    ctx.strokeStyle = '#0F172A';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Overhead guard cage
    ctx.fillStyle = '#0F172A';
    roundRect(ctx, -7, -7, 10, 14, 2);
    ctx.fill();
    ctx.strokeStyle = tint.light;
    ctx.lineWidth = 1.1;
    ctx.stroke();
  } else if (vtype === 'reach') {
    // Outrigger reach legs
    ctx.fillStyle = tint.dark;
    ctx.fillRect(2, -10.5, 10, 2.5);
    ctx.fillRect(2, 8, 10, 2.5);

    // Compact narrow-aisle chassis
    ctx.fillStyle = tint.primary;
    roundRect(ctx, -13, -9, 18, 18, 3);
    ctx.fill();
    ctx.strokeStyle = '#0F172A';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Pantograph scissor mechanism
    ctx.strokeStyle = tint.light;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(4, -5);
    ctx.lineTo(8, 5);
    ctx.moveTo(4, 5);
    ctx.lineTo(8, -5);
    ctx.stroke();

    // Side-stance operator bay
    ctx.fillStyle = '#0F172A';
    roundRect(ctx, -9, -6, 9, 12, 2);
    ctx.fill();
  } else {
    // Turret / VNA / Pallet jack: sleek low-profile body with swiveling turret head
    ctx.fillStyle = tint.primary;
    roundRect(ctx, -14, -8.5, 20, 17, 5);
    ctx.fill();
    ctx.strokeStyle = '#0F172A';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Turret pivot ring
    ctx.fillStyle = tint.dark;
    ctx.beginPath();
    ctx.arc(0, 0, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = tint.light;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  // Beacon light on roof
  ctx.fillStyle = '#FEF08A';
  ctx.beginPath();
  ctx.arc(-5, 0, 2.2, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawTileSprite(ctx: SKRSContext2D, cx: number, cy: number, name: string): void {
  ctx.save();
  ctx.translate(cx, cy);

  if (name.startsWith('floor_')) {
    const palette: Record<string, { bg: string; grid: string; accent?: string }> = {
      floor_main: { bg: '#ECE7DC', grid: '#DFD8C8' },
      floor_aisle: { bg: '#E5DEC9', grid: '#D5CCB4', accent: '#C8BFA6' },
      floor_ambient: { bg: '#EFECE6', grid: '#E2DDD3' },
      floor_cold: { bg: '#E0F2FE', grid: '#BAE6FD', accent: '#38BDF8' },
      floor_hazmat: { bg: '#FEF3C7', grid: '#FDE68A', accent: '#F59E0B' },
      floor_bulk: { bg: '#E7E5E4', grid: '#D6D3D1', accent: '#78716C' },
      floor_staging: { bg: '#E2E8F0', grid: '#CBD5E1', accent: '#64748B' },
    };
    const p = palette[name] || palette.floor_main;
    ctx.fillStyle = p.bg;
    ctx.fillRect(0, 0, CELL, CELL);
    ctx.strokeStyle = p.grid;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, CELL - 1, CELL - 1);
    if (p.accent) {
      ctx.fillStyle = p.accent;
      ctx.globalAlpha = 0.25;
      ctx.fillRect(3, 3, 6, 6);
      ctx.globalAlpha = 1;
    }
  } else if (name === 'wall' || name === 'pillar') {
    ctx.fillStyle = '#334155';
    ctx.fillRect(0, 0, CELL, CELL);
    ctx.strokeStyle = '#1E293B';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, CELL - 2, CELL - 2);
    if (name === 'pillar') {
      ctx.fillStyle = '#F59E0B';
      ctx.fillRect(6, 6, CELL - 12, 4);
      ctx.fillRect(6, CELL - 10, CELL - 12, 4);
    }
  } else if (name.startsWith('rack_')) {
    const stocked = name.includes('stocked');
    const isCold = name.includes('cold');
    const isHaz = name.includes('hazmat');
    const isBulk = name.includes('bulk');
    const isP0 = name.includes('p0');
    const isCard = name.includes('card');

    // Rack upright frame
    ctx.fillStyle = isCold
      ? '#0369A1'
      : isHaz
        ? '#B45309'
        : isBulk
          ? '#44403C'
          : '#1E3A8A';
    roundRect(ctx, 3, 3, CELL - 6, CELL - 6, 4);
    ctx.fill();

    // Crossbeams
    ctx.fillStyle = '#F97316';
    ctx.fillRect(4, 4, CELL - 8, 4);
    ctx.fillRect(4, CELL - 8, CELL - 8, 4);

    // Inner shelf wire deck
    ctx.fillStyle = '#1E293B';
    ctx.fillRect(7, 9, CELL - 14, CELL - 18);

    if (stocked) {
      drawPalletLoad(ctx, 10, 11, CELL - 20, CELL - 22);
      if (isP0 || isCard) {
        ctx.strokeStyle = isP0 ? '#EF4444' : '#A855F7';
        ctx.lineWidth = 2.5;
        ctx.strokeRect(8, 9, CELL - 16, CELL - 18);
      }
    }
  } else if (name.startsWith('conveyor_')) {
    ctx.fillStyle = '#334155';
    roundRect(ctx, 2, 6, CELL - 4, CELL - 12, 3);
    ctx.fill();
    // Rollers
    const phase = name.endsWith('1')
      ? 2
      : name.endsWith('2')
        ? 4
        : name.endsWith('3')
          ? 6
          : 0;
    ctx.fillStyle = '#94A3B8';
    for (let x = 6 + (phase % 6); x < CELL - 6; x += 6) {
      ctx.fillRect(x, 9, 3, CELL - 18);
    }
    // Side guardrails
    ctx.fillStyle = '#F59E0B';
    ctx.fillRect(2, 6, CELL - 4, 2.5);
    ctx.fillRect(2, CELL - 8.5, CELL - 4, 2.5);
  } else if (
    name === 'trailer' ||
    name === 'trailer_transfer' ||
    name === 'dock_west' ||
    name === 'bay_east' ||
    name === 'bay_transfer'
  ) {
    const isTransfer = name.includes('transfer');
    ctx.fillStyle = isTransfer ? '#312E81' : '#1E293B';
    roundRect(ctx, 2, 4, CELL - 4, CELL - 8, 4);
    ctx.fill();
    ctx.strokeStyle = isTransfer ? '#818CF8' : '#F59E0B';
    ctx.lineWidth = 2;
    ctx.strokeRect(4, 6, CELL - 8, CELL - 12);

    // Striping
    ctx.fillStyle = isTransfer ? '#A5B4FC' : '#FBBF24';
    ctx.fillRect(8, CELL / 2 - 2, CELL - 16, 4);
  } else if (name === 'transfer_bay_net' || name === 'sign_net') {
    // Indigo transfer bay signage with '→ NET'
    ctx.fillStyle = '#1E1B4B';
    roundRect(ctx, 2, 8, CELL - 4, CELL - 16, 5);
    ctx.fill();
    ctx.strokeStyle = '#818CF8';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#E0E7FF';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('→ NET', CELL / 2, CELL / 2);
  } else if (name === 'charger' || name === 'charger_busy') {
    const busy = name === 'charger_busy';
    ctx.fillStyle = busy ? '#064E3B' : '#0F172A';
    roundRect(ctx, 5, 5, CELL - 10, CELL - 10, 6);
    ctx.fill();
    ctx.strokeStyle = busy ? '#34D399' : '#10B981';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Lightning bolt icon
    ctx.fillStyle = busy ? '#FDE047' : '#34D399';
    ctx.beginPath();
    ctx.moveTo(26, 11);
    ctx.lineTo(16, 25);
    ctx.lineTo(23, 25);
    ctx.lineTo(20, 37);
    ctx.lineTo(31, 22);
    ctx.lineTo(24, 22);
    ctx.closePath();
    ctx.fill();
  } else if (name === 'cone') {
    // Safety traffic cone
    ctx.fillStyle = '#EA580C';
    roundRect(ctx, 11, 11, CELL - 22, CELL - 22, 4);
    ctx.fill();
    ctx.fillStyle = '#F97316';
    ctx.beginPath();
    ctx.arc(CELL / 2, CELL / 2, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(CELL / 2, CELL / 2, 6, 0, Math.PI * 2);
    ctx.stroke();
  } else if (name === 'spill') {
    // Chemical / oil spill puddle
    ctx.fillStyle = 'rgba(234, 179, 8, 0.78)';
    ctx.beginPath();
    ctx.arc(21, 23, 12, 0, Math.PI * 2);
    ctx.arc(29, 20, 9, 0, Math.PI * 2);
    ctx.arc(25, 29, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#B45309';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  } else if (name.startsWith('pallet')) {
    drawPalletLoad(ctx, 9, 9, CELL - 18, CELL - 18);
    if (name === 'pallet_p0') {
      ctx.strokeStyle = '#EF4444';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(7, 7, CELL - 14, CELL - 14);
    } else if (name === 'pallet_card') {
      ctx.strokeStyle = '#A855F7';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(7, 7, CELL - 14, CELL - 14);
    } else if (name === 'pallet_transfer') {
      ctx.strokeStyle = '#6366F1';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(7, 7, CELL - 14, CELL - 14);
    }
  }

  ctx.restore();
}

const STATIC_SPRITE_NAMES = [
  'floor_main',
  'floor_aisle',
  'floor_ambient',
  'floor_cold',
  'floor_hazmat',
  'floor_bulk',
  'floor_staging',
  'wall',
  'pillar',
  'rack_empty',
  'rack_stocked',
  'rack_empty_ambient',
  'rack_stocked_ambient',
  'rack_empty_cold',
  'rack_stocked_cold',
  'rack_empty_hazmat',
  'rack_stocked_hazmat',
  'rack_empty_bulk',
  'rack_stocked_bulk',
  'rack_empty_p0',
  'rack_stocked_p0',
  'rack_stocked_card',
  'conveyor_h',
  'conveyor_v',
  'conveyor_f0',
  'conveyor_f1',
  'conveyor_f2',
  'conveyor_f3',
  'trailer',
  'trailer_transfer',
  'dock_west',
  'bay_east',
  'bay_transfer',
  'transfer_bay_net',
  'sign_net',
  'charger',
  'charger_busy',
  'cone',
  'spill',
  'pallet',
  'pallet_p0',
  'pallet_card',
  'pallet_transfer',
];

function makeFrameEntry(rect: AtlasFrameRect): AtlasFrameEntry {
  return {
    ...rect,
    frame: { ...rect },
    rotated: false,
    trimmed: false,
    spriteSourceSize: { x: 0, y: 0, w: rect.w, h: rect.h },
    sourceSize: { w: rect.w, h: rect.h },
    anchor: { x: 0.5, y: 0.5 },
  };
}

export function generateAtlas(outDir?: string): {
  pngPath: string;
  jsonPath: string;
  manifest: SpriteAtlasManifest;
} {
  const tintKeys = Object.keys(TEAM_TINTS) as SpriteTeamTint[];
  const totalVehicleSprites =
    VEHICLE_TYPES.length * tintKeys.length * LOAD_STATES.length * HEADINGS;
  const totalCells = totalVehicleSprites + STATIC_SPRITE_NAMES.length;
  const rows = Math.ceil(totalCells / COLS);
  const width = COLS * CELL;
  const height = rows * CELL;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);

  const frames: Record<string, AtlasFrameEntry> = {};
  const sprites: Record<string, AtlasFrameRect> = {};
  const vehicles: SpriteAtlasManifest['vehicles'] = {};

  let cellIndex = 0;
  const nextCellRect = (): AtlasFrameRect => {
    const col = cellIndex % COLS;
    const row = Math.floor(cellIndex / COLS);
    cellIndex++;
    return { x: col * CELL, y: row * CELL, w: CELL, h: CELL };
  };

  for (const vtype of VEHICLE_TYPES) {
    vehicles[vtype] = {};
    for (const tintKey of tintKeys) {
      vehicles[vtype][tintKey] = { empty: {}, loaded: {} };
      const tint = TEAM_TINTS[tintKey];
      for (const loadState of LOAD_STATES) {
        for (let h = 0; h < HEADINGS; h++) {
          const rect = nextCellRect();
          drawVehicleCell(ctx, rect.x, rect.y, vtype, h, loadState, tint);
          const key = `vehicle_${vtype}_${tintKey}_${loadState}_h${h}`;
          const entry = makeFrameEntry(rect);
          frames[key] = entry;
          sprites[key] = rect;
          vehicles[vtype][tintKey][loadState][h] = rect;
        }
      }
    }
  }

  // Register vehicle type aliases (forklift -> counterbalance, pallet_jack/agv -> turret)
  for (const [alias, canonical] of Object.entries(VEHICLE_TYPE_ALIASES)) {
    if (alias === canonical) continue;
    vehicles[alias] = vehicles[canonical];
    for (const tintKey of tintKeys) {
      for (const loadState of LOAD_STATES) {
        for (let h = 0; h < HEADINGS; h++) {
          const srcKey = `vehicle_${canonical}_${tintKey}_${loadState}_h${h}`;
          const aliasKey = `vehicle_${alias}_${tintKey}_${loadState}_h${h}`;
          frames[aliasKey] = frames[srcKey];
          sprites[aliasKey] = sprites[srcKey];
        }
      }
    }
  }

  // Register strategy tint aliases (Sprinter, Steady, Batcher, Opportunist, Strategist, Human)
  for (const [strat, tintKey] of Object.entries(STRATEGY_TINT_MAP)) {
    for (const vtype of Object.keys(VEHICLE_TYPE_ALIASES)) {
      const canonical = VEHICLE_TYPE_ALIASES[vtype];
      vehicles[vtype][strat] = vehicles[canonical][tintKey];
      for (const loadState of LOAD_STATES) {
        for (let h = 0; h < HEADINGS; h++) {
          const srcKey = `vehicle_${canonical}_${tintKey}_${loadState}_h${h}`;
          const stratKey = `vehicle_${vtype}_${strat}_${loadState}_h${h}`;
          frames[stratKey] = frames[srcKey];
          sprites[stratKey] = sprites[srcKey];
        }
      }
    }
  }

  // Draw static environment, rack, dock, transfer bay, and floor tiles
  for (const name of STATIC_SPRITE_NAMES) {
    const rect = nextCellRect();
    drawTileSprite(ctx, rect.x, rect.y, name);
    frames[name] = makeFrameEntry(rect);
    sprites[name] = rect;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const targetDir = outDir || resolve(here, '../../../apps/client/public/assets');
  mkdirSync(targetDir, { recursive: true });

  const pngPath = resolve(targetDir, 'atlas.png');
  const jsonPath = resolve(targetDir, 'atlas.json');

  const pngBuffer = canvas.toBuffer('image/png');
  writeFileSync(pngPath, pngBuffer);

  const manifest: SpriteAtlasManifest = {
    version: SPRITES_VERSION,
    tileSize: CELL,
    vehicleCellSize: CELL,
    meta: {
      app: '@warehouse/sprites',
      version: String(SPRITES_VERSION),
      image: 'atlas.png',
      format: 'RGBA8888',
      size: { w: width, h: height },
      scale: '1',
    },
    tints: TEAM_TINTS,
    strategyTintMap: STRATEGY_TINT_MAP,
    vehicleTypeAliases: VEHICLE_TYPE_ALIASES,
    frames,
    sprites,
    vehicles,
  };

  writeFileSync(jsonPath, JSON.stringify(manifest, null, 2));
  return { pngPath, jsonPath, manifest };
}

// Run automatically when invoked via CLI (`npm run sprites` / `node dist/index.js`)
const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const { pngPath, jsonPath, manifest } = generateAtlas();
  console.log(
    `[@warehouse/sprites] Generated ${Object.keys(manifest.frames).length} sprite frames (${manifest.meta.size.w}x${manifest.meta.size.h}) -> ${pngPath} & ${jsonPath}`,
  );
}
