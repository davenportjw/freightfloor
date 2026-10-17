import {
  NlOrderParseSchema,
  type NlOrderAction,
  type NlOrderClarify,
  type NlOrderParse,
} from '@warehouse/protocol';
import type { ArmorReasonCode } from './hygiene.js';

export type ArmorFilterCategory = 'pi_and_jailbreak' | 'malicious_uri' | 'rai' | 'unknown';

export interface ModelArmorVerdict {
  flagged: boolean;
  filter?: ArmorFilterCategory;
  reasonCode?: ArmorReasonCode;
  detail?: string;
}

export interface ModelArmorClient {
  sanitizeUserPrompt(text: string): Promise<ModelArmorVerdict>;
  sanitizeModelResponse(text: string): Promise<ModelArmorVerdict>;
}

const PROMPT_INJECTION_PATTERNS: RegExp[] = [
  /\bignore\s+(?:all\s+)?(?:previous|prior|above|earlier|system|initial)\s+(?:instructions?|rules?|prompts?|directives?|constraints?)/i,
  /\bdisregard\s+(?:all\s+)?(?:previous|prior|above|earlier|system)\b/i,
  /\bforget\s+(?:all\s+)?(?:previous|prior|above|everything|your\s+instructions)/i,
  /\b(?:system\s+prompt|system\s+instruction|developer\s+mode|jailbreak|dan\s+mode|do\s+anything\s+now)\b/i,
  /\b(?:repeat|reveal|print|output|show|leak|echo|dump|translate)\s+(?:your|the)\s+(?:system|initial|hidden|secret|fenced)?\s*(?:prompt|instructions?|rules?|nonce|hmac|key|config)/i,
  /\bwhat\s+(?:are|is)\s+your\s+(?:system\s+)?(?:instructions?|prompt|rules?|nonce)\b/i,
  /<\/?\s*order(?:-|[>\s])/i,
  /<\/?\s*(?:system|instruction|assistant|user|prompt|tool_call|function_call)\b/i,
  /(?:\[INST\]|\[\/INST\]|<\|im_start\|>|<\|im_end\|>|<\|system\|>)/i,
  /\byou\s+are\s+now\s+(?:an?\s+)?(?:unrestricted|admin|root|superuser|god|developer|helpful\s+assistant)/i,
  /\b(?:sudo|as\s+admin|grant\s+admin|override\s+governance|bypass\s+(?:cooldown|limit|armor|security|filter)|disable\s+(?:cooldown|limit|armor|security))\b/i,
  /\b(?:act|execute|issue|run)\s+(?:on\s+behalf\s+of|as\s+player|for\s+all\s+players)/i,
  /\b(?:secret[_\s-]?key|hmac[_\s-]?key|api[_\s-]?key|process\.env|google_application_credentials)\b/i,
  /\b(?:set\s+(?:shift\s+)?difficulty|without\s+voting|bonus\s+points\s+on\s+the\s+leaderboard|force\s+site\s+\S+\s+into\s+factory\s+break|disconnect\s+all\s+other\s+drivers|release\s+their\s+vehicle\s+leases)\b/i,
];

const MALICIOUS_URI_AND_XSS_PATTERNS: RegExp[] = [
  /\b(?:https?|ftp|javascript|data|vbscript|file):\/\/\S+/i,
  /\b(?:javascript|vbscript|data):[a-z0-9_;,=%+-]+/i,
  /\bwww\.[a-z0-9.-]+\.[a-z]{2,}/i,
  /!\[[^\]]*\]\([^)]*\)/i,
  /<\s*\/?\s*(?:script|img|svg|iframe|object|embed|link|style|meta|body|form|input|a)\b[^>]*>/i,
  /\bon(?:error|load|click|mouseover|focus|blur)\s*=/i,
  /\b(?:document\.cookie|window\.location|eval\s*\(|alert\s*\(|fetch\s*\()/i,
];

const RAI_PATTERNS: RegExp[] = [
  /\b(?:kill\s+yourself|kys|self[ -]?harm|suicide|bomb\s+threat|terrorist\s+attack)\b/i,
  /\b(?:racial\s+slur|hate\s+speech|nazi|white\s+supremac)/i,
];

/**
 * Fast local deterministic pre-filter that inspects user text for prompt injection,
 * fence escape attempts, secret/system-prompt exfiltration, XSS/URI smuggling, and RAI violations.
 */
export function inspectPromptLocally(raw: string): ModelArmorVerdict {
  const folded = raw.normalize('NFKC');

  for (const pattern of MALICIOUS_URI_AND_XSS_PATTERNS) {
    if (pattern.test(folded) || pattern.test(raw)) {
      return {
        flagged: true,
        filter: 'malicious_uri',
        reasonCode: 'armor_blocked',
        detail: `Matched URI/XSS filter (${pattern.source})`,
      };
    }
  }

  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(folded) || pattern.test(raw)) {
      return {
        flagged: true,
        filter: 'pi_and_jailbreak',
        reasonCode: 'armor_blocked',
        detail: `Matched prompt-injection/jailbreak filter (${pattern.source})`,
      };
    }
  }

  for (const pattern of RAI_PATTERNS) {
    if (pattern.test(folded) || pattern.test(raw)) {
      return {
        flagged: true,
        filter: 'rai',
        reasonCode: 'armor_blocked',
        detail: `Matched RAI safety filter`,
      };
    }
  }

  return { flagged: false };
}

export type ValidatedOrderResult =
  | { ok: true; command: NlOrderAction | NlOrderClarify }
  | { ok: false; code: 'parse_invalid' | 'parse_refused'; reason: string };

/**
 * Layer 4 Typed Validation:
 * Validates raw JSON string or object from Gemini against the strict command union
 * (`rush | p0 | cone{x,y} | fleetAdd | fleetRemove | dispatch | clarify | refuse`) and map bounds.
 */
export function validateParsedOrder(
  rawJsonOrObj: unknown,
  mapBounds: { width: number; height: number } = { width: 60, height: 120 },
): ValidatedOrderResult {
  let obj: unknown = rawJsonOrObj;
  if (typeof rawJsonOrObj === 'string') {
    try {
      obj = JSON.parse(rawJsonOrObj);
    } catch {
      return {
        ok: false,
        code: 'parse_invalid',
        reason: 'Model output was not valid JSON.',
      };
    }
  }

  const parsed = NlOrderParseSchema.safeParse(obj);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'parse_invalid',
      reason: parsed.error.issues[0]?.message ?? 'Output violated manager command schema.',
    };
  }

  const data: NlOrderParse = parsed.data;
  if (data.action === 'refuse') {
    return {
      ok: false,
      code: 'parse_refused',
      reason: data.refuse,
    };
  }

  if (data.action === 'cone') {
    if (
      typeof data.x !== 'number' ||
      typeof data.y !== 'number' ||
      data.x < 1 ||
      data.x >= mapBounds.width - 1 ||
      data.y < 1 ||
      data.y >= mapBounds.height - 1
    ) {
      return {
        ok: false,
        code: 'parse_invalid',
        reason: `Cone coordinates (${data.x}, ${data.y}) are outside legal floor bounds.`,
      };
    }
  }

  if (data.action === 'dispatch' && !data.dispatch) {
    data.dispatch = {
      sourceZone: 'haz',
      targetBay: 'RET',
      priority: 'p0',
      count: 3,
      mode: 'reroute_and_spawn',
    };
  }

  return {
    ok: true,
    command: data,
  };
}
