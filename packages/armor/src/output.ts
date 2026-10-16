import { BIDI_CHAR_REGEX, CONTROL_CHAR_REGEX, ZERO_WIDTH_CHAR_REGEX } from './hygiene.js';

export const MAX_OUTPUT_REASON_LENGTH = 120;

/**
 * Layer 6 Output Sanitiser:
 * - Normalises with NFKC
 * - Strips control, zero-width, and bidi-override characters
 * - Strips Markdown images/links, URLs (`https?://...`, `www....`), HTML/XML tags (`<...>`), and `@mentions`
 * - Collapses whitespace and truncates to `maxLen` (default 120 characters)
 */
export function sanitiseOutputText(raw: string, maxLen: number = MAX_OUTPUT_REASON_LENGTH): string {
  if (typeof raw !== 'string') return '';

  const cleaned = raw
    .normalize('NFKC')
    .replace(CONTROL_CHAR_REGEX, ' ')
    .replace(ZERO_WIDTH_CHAR_REGEX, '')
    .replace(BIDI_CHAR_REGEX, '')
    // Strip markdown images ![alt](url)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    // Replace markdown links [label](url) with label
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Strip URLs
    .replace(/\b(?:https?|ftp|javascript|data|vbscript):\/\/\S+/gi, '')
    .replace(/\b(?:javascript|data|vbscript):\S+/gi, '')
    .replace(/\bwww\.\S+/gi, '')
    // Strip HTML/XML tags
    .replace(/<[^>]*>/g, '')
    .replace(/[<>]/g, '')
    // Strip @mentions
    .replace(/@[A-Za-z0-9_.\-]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length <= maxLen) {
    return cleaned;
  }
  return cleaned.slice(0, maxLen).trimEnd();
}

export const sanitizeOutputText = sanitiseOutputText;
