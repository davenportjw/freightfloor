import { z } from 'zod';

export const ARMOR_REASON_CODES = [
  'empty_input',
  'too_long',
  'frame_too_large',
  'rate_limited',
  'muted',
  'invalid_name',
  'reserved_name',
  'armor_blocked',
  'armor_unavailable',
  'parse_invalid',
  'parse_refused',
  'governance_limit',
  'budget_exhausted',
] as const;

export const ArmorReasonCodeSchema = z.enum(ARMOR_REASON_CODES);
export type ArmorReasonCode = z.infer<typeof ArmorReasonCodeSchema>;

export const MAX_NL_COMMAND_LENGTH = 200;
export const MAX_FRAME_BYTES = 4096;

// Control chars: U+0000..U+001F, U+007F..U+009F
export const CONTROL_CHAR_REGEX = /[\u0000-\u001F\u007F-\u009F]/g;
// Zero-width & line/paragraph separators: U+200B..U+200F, U+2028..U+2029, U+2060, U+FEFF
export const ZERO_WIDTH_CHAR_REGEX = /[\u200B-\u200F\u2028-\u2029\u2060\uFEFF]/g;
// Bidirectional override / isolate chars: U+061C, U+202A..U+202E, U+2066..U+2069
export const BIDI_CHAR_REGEX = /[\u061C\u202A-\u202E\u2066-\u2069]/g;

export type HygieneResult =
  | { ok: true; text: string }
  | { ok: false; code: ArmorReasonCode; message: string };

/**
 * Layer 1 Input Hygiene:
 * - Applies Unicode NFKC normalization
 * - Strips ASCII/Unicode control characters, zero-width characters, and bidi overrides
 * - Collapses repeated whitespace and trims
 * - Enforces non-empty (`empty_input`) and <= 200-character max length (`too_long`)
 */
export function normaliseInput(raw: string, maxLen: number = MAX_NL_COMMAND_LENGTH): HygieneResult {
  if (typeof raw !== 'string') {
    return { ok: false, code: 'empty_input', message: 'Input must be a string.' };
  }

  const folded = raw
    .normalize('NFKC')
    .replace(CONTROL_CHAR_REGEX, ' ')
    .replace(ZERO_WIDTH_CHAR_REGEX, '')
    .replace(BIDI_CHAR_REGEX, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (folded.length === 0) {
    return {
      ok: false,
      code: 'empty_input',
      message: 'Order text is empty after normalization.',
    };
  }

  if (folded.length > maxLen) {
    return {
      ok: false,
      code: 'too_long',
      message: `Order text exceeds maximum length of ${maxLen} characters (${folded.length}).`,
    };
  }

  return { ok: true, text: folded };
}

export const normalizeInput = normaliseInput;

export type FrameSizeResult =
  | { ok: true; byteLength: number }
  | { ok: false; code: 'frame_too_large'; message: string; byteLength: number };

/**
 * Layer 1 WebSocket frame size check (max 4096 bytes).
 */
export function checkFrameSize(
  frameOrByteLength: number | string | Buffer | Uint8Array | ArrayBuffer,
  maxBytes: number = MAX_FRAME_BYTES,
): FrameSizeResult {
  let byteLength: number;
  if (typeof frameOrByteLength === 'number') {
    byteLength = frameOrByteLength;
  } else if (typeof frameOrByteLength === 'string') {
    byteLength = Buffer.byteLength(frameOrByteLength, 'utf8');
  } else if ( frameOrByteLength instanceof ArrayBuffer) {
    byteLength = frameOrByteLength.byteLength;
  } else {
    byteLength = frameOrByteLength.byteLength;
  }

  if (byteLength > maxBytes) {
    return {
      ok: false,
      code: 'frame_too_large',
      message: `WebSocket frame size (${byteLength} bytes) exceeds ${maxBytes}-byte limit.`,
      byteLength,
    };
  }

  return { ok: true, byteLength };
}
