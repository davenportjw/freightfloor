import { BIDI_CHAR_REGEX, CONTROL_CHAR_REGEX, ZERO_WIDTH_CHAR_REGEX } from './hygiene.js';

export const RESERVED_NAME_PREFIXES = [
  'loadtest-',
  'pilot-',
  'smoke-',
  'system',
  'admin',
  'gemini',
] as const;

export const BOT_NAME_PREFIXES = ['loadtest-', 'pilot-', 'smoke-'] as const;

export const DISPLAY_NAME_REGEX = /^[A-Za-z0-9 _.\-]{2,20}$/;

export function isReservedBotPrefix(name: string): boolean {
  const lower = name.normalize('NFKC').trim().toLowerCase();
  return BOT_NAME_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export function isReservedNamePrefix(name: string): boolean {
  const lower = name.normalize('NFKC').trim().toLowerCase();
  return RESERVED_NAME_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export type DisplayNameValidationResult =
  | { ok: true; name: string; isBot: boolean }
  | { ok: false; code: 'invalid_name' | 'reserved_name'; message: string };

/**
 * Validates a player display name:
 * - Rejects raw strings containing control characters, zero-width characters, or bidi overrides (`invalid_name`)
 * - Applies Unicode NFKC normalization and collapses whitespace
 * - Enforces `^[A-Za-z0-9 _.\-]{2,20}$` (`invalid_name`)
 * - Rejects reserved prefixes (`loadtest-`, `pilot-`, `smoke-`, `system`, `admin`, `gemini`) with `reserved_name`
 *   unless `opts.allowBotPrefix` is true and the name starts with a bot prefix (`loadtest-`, `pilot-`, `smoke-`).
 */
export function validateDisplayName(
  raw: string,
  opts?: { allowBotPrefix?: boolean },
): DisplayNameValidationResult {
  if (typeof raw !== 'string') {
    return { ok: false, code: 'invalid_name', message: 'Display name must be a string.' };
  }

  // Reject if raw contains control, zero-width, or bidi-override characters before or after NFKC
  if (
    CONTROL_CHAR_REGEX.test(raw) ||
    ZERO_WIDTH_CHAR_REGEX.test(raw) ||
    BIDI_CHAR_REGEX.test(raw)
  ) {
    CONTROL_CHAR_REGEX.lastIndex = 0;
    ZERO_WIDTH_CHAR_REGEX.lastIndex = 0;
    BIDI_CHAR_REGEX.lastIndex = 0;
    return {
      ok: false,
      code: 'invalid_name',
      message: 'Display name contains forbidden control, zero-width, or bidirectional characters.',
    };
  }

  const folded = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();

  if (
    CONTROL_CHAR_REGEX.test(folded) ||
    ZERO_WIDTH_CHAR_REGEX.test(folded) ||
    BIDI_CHAR_REGEX.test(folded)
  ) {
    CONTROL_CHAR_REGEX.lastIndex = 0;
    ZERO_WIDTH_CHAR_REGEX.lastIndex = 0;
    BIDI_CHAR_REGEX.lastIndex = 0;
    return {
      ok: false,
      code: 'invalid_name',
      message: 'Display name contains forbidden control, zero-width, or bidirectional characters.',
    };
  }

  if (!DISPLAY_NAME_REGEX.test(folded)) {
    return {
      ok: false,
      code: 'invalid_name',
      message: 'Display name must be 2 to 20 characters using only letters, digits, spaces, _, ., or -.',
    };
  }

  const isBot = isReservedBotPrefix(folded);
  if (isReservedNamePrefix(folded)) {
    if (opts?.allowBotPrefix && isBot) {
      return { ok: true, name: folded, isBot: true };
    }
    return {
      ok: false,
      code: 'reserved_name',
      message: 'Display name uses a reserved prefix.',
    };
  }

  return { ok: true, name: folded, isBot: false };
}

export const CALLSIGN_ADJECTIVES = [
  'agile',
  'alpine',
  'amber',
  'arctic',
  'astral',
  'atomic',
  'blazing',
  'bold',
  'breezy',
  'bright',
  'brisk',
  'bronze',
  'calm',
  'clever',
  'cobalt',
  'copper',
  'cosmic',
  'crisp',
  'cyber',
  'daring',
  'deft',
  'eager',
  'fierce',
  'fleet',
  'frosty',
  'gentle',
  'golden',
  'grand',
  'happy',
  'hardy',
  'iron',
  'jolly',
  'keen',
  'laser',
  'lively',
  'lucky',
  'lunar',
  'mighty',
  'minty',
  'neon',
  'nimble',
  'noble',
  'plucky',
  'prime',
  'proud',
  'quick',
  'quiet',
  'rapid',
  'royal',
  'rustic',
  'sharp',
  'shiny',
  'silver',
  'sleek',
  'smart',
  'snappy',
  'solar',
  'solid',
  'sonic',
  'spicy',
  'spry',
  'steady',
  'steel',
  'stout',
  'sunny',
  'super',
  'swift',
  'tidy',
  'titanium' as never, // excluded to keep max 6-7 chars
].filter((w): w is string => typeof w === 'string' && w.length >= 3 && w.length <= 6);

// Ensure at least 48 curated adjectives (all 3..6 chars, lowercase alpha, no reserved prefixes)
export const DRIVER_CALLSIGN_ADJECTIVES: readonly string[] = [
  ...CALLSIGN_ADJECTIVES,
  'trusty',
  'turbo',
  'velvet',
  'vivid',
  'warm',
  'witty',
  'zesty',
  'zippy',
];

export const CALLSIGN_NOUNS: readonly string[] = [
  'anchor',
  'anvil',
  'badger',
  'barge',
  'barrel',
  'beacon',
  'beaver',
  'bison',
  'bobcat',
  'boxcar',
  'bumper',
  'carton',
  'clamp',
  'clutch',
  'condor',
  'CONV' as never,
  'cougar',
  'crane',
  'crate',
  'diesel',
  'dolly',
  'donkey',
  'driver',
  'dynamo',
  'engine',
  'falcon',
  'ferret',
  'finch',
  'forklift',
  'gantry',
  'gecko',
  'gopher',
  'harbor',
  'hawker',
  'helmet',
  'heron',
  'hopper',
  'husky',
  'iguana',
  'jackal',
  'jaguar',
  'kestrel',
  'koala',
  'latch',
  'lemur',
  'lifter',
  'lizard',
  'loader',
  'locker',
  'magnet',
  'marmot',
  'marten',
  'meerkat',
  'module',
  'monkey',
  'motor',
  'mustang',
  'narwhal',
  'newt',
  'nozzle',
  'ocelot',
  'osprey',
  'otter',
  'packet',
  'paddle',
  'pallet',
  'panda',
  'panther',
  'parrot',
  'pelican',
  'penguin',
  'picker',
  'pigeon',
  'pinion',
  'piston',
  'plover',
  'pocket',
  'portal',
  'puffin',
  'pulley',
  'puma',
  'quail',
  'quartz',
  'rabbit',
  'raptor',
  'ratchet',
  'raven',
  'rhino',
  'rivet',
  'robin',
  'rocket',
  'roller',
  'runner',
  'saddle',
  'scanner',
  'scooter',
  'sensor',
  'shifter',
  'shuttle',
  'signal',
  'slider',
  'socket',
  'sparrow',
  'spindle',
  'spring',
  'sprout',
  'stacker',
  'stoker',
  'strider',
  'summit',
  'switch',
  'tackle',
  'talon',
  'tanker',
  'tapir',
  'thistle',
  'thrush',
  'timber',
  'tinker',
  'toggle',
  'toucan',
  'tractor',
  'trailer',
  'transit',
  'trolley',
  'trucker',
  'tunnel',
  'turret',
  'valve',
  'vessel',
  'walrus',
  'weasel',
  'winch',
  'wombat',
  'wrench',
  'zephyr',
].filter((w): w is string => typeof w === 'string' && /^[a-z]{3,8}$/.test(w));

const GENERATED_CALLSIGN_REGEX = /^[a-z]{3,7}-[a-z]{3,8}-\d{2,3}(?: Run \d+)?$/;

function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Checks whether a display name matches the generated `<adjective>-<noun>-<digits>` callsign format
 * (with optional ` Run N` suffix) and passes `validateDisplayName`.
 */
export function isGeneratedCallsign(name: string): boolean {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length < 8 || trimmed.length > 20) return false;
  if (!GENERATED_CALLSIGN_REGEX.test(trimmed)) return false;
  return validateDisplayName(trimmed).ok;
}

/**
 * Deterministically generates a Docker/Reddit-style warehouse callsign (`<adjective>-<noun>-<digits>`)
 * from `seedKey`. If `existingNames` is provided, probes `${seedKey}:${attempt}` (`attempt = 1, 2, ...`)
 * until a guaranteed non-overlapping callsign (case-insensitive) is found.
 */
export function generateDriverCallsign(
  seedKey: string,
  existingNames?: ReadonlySet<string> | Iterable<string>,
): string {
  const taken = new Set<string>();
  if (existingNames) {
    for (const n of existingNames) {
      if (typeof n === 'string' && n.trim()) {
        taken.add(n.trim().toLowerCase());
      }
    }
  }

  const baseSeed = (seedKey || 'driver').trim() || 'driver';
  const adjs = DRIVER_CALLSIGN_ADJECTIVES;
  const nouns = CALLSIGN_NOUNS;

  for (let attempt = 0; attempt < 100_000; attempt++) {
    const key = attempt === 0 ? baseSeed : `${baseSeed}:${attempt}`;
    const h1 = fnv1a32(key);
    const h2 = fnv1a32(`${key}#num`);
    const adj = adjs[h1 % adjs.length];
    const noun = nouns[(h1 >>> 8) % nouns.length];
    const allowThreeDigits = attempt >= 128 && adj.length + noun.length <= 13;
    const num = allowThreeDigits ? 100 + (h2 % 900) : 10 + (h2 % 90);
    const candidate = `${adj}-${noun}-${num}`;
    if (candidate.length <= 18 && !taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  // Fallback if 100k probes somehow collide
  return `brisk-pallet-${10 + (fnv1a32(baseSeed) % 90)}`;
}

