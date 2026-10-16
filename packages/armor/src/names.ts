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
