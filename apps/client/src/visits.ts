/**
 * Browser-local return-visit ledger (`localStorage['ff.visits']`).
 *
 * Feeds the GA4 `return_visit` event so retention can be read from analytics. The server keeps
 * an authoritative copy on `players/{clientId}` (lobby `recordVisit`), so this ledger is only a
 * reporting signal: clearing storage restarts it and is never used for game state.
 */
import { dayKey, nextVisitLedger, type VisitLedger, type VisitUpdate } from '@warehouse/protocol';

export const VISIT_LEDGER_KEY = 'ff.visits';

type LedgerStorage = Pick<Storage, 'getItem' | 'setItem'>;

function readLedger(storage: LedgerStorage): Partial<VisitLedger> | null {
  const raw = storage.getItem(VISIT_LEDGER_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Partial<VisitLedger>) : null;
  } catch {
    return null;
  }
}

/**
 * Advances and persists the ledger for `nowMs`. Returns the update, or null when storage is
 * unavailable (private mode / blocked), in which case no return signal is reported.
 */
export function recordLocalVisit(
  storage: LedgerStorage | null | undefined,
  nowMs: number,
): VisitUpdate | null {
  if (!storage) return null;
  try {
    const update = nextVisitLedger(readLedger(storage), dayKey(nowMs));
    if (update.isNewDay) storage.setItem(VISIT_LEDGER_KEY, JSON.stringify(update.ledger));
    return update;
  } catch (err) {
    console.warn('[visits] ledger unavailable', err);
    return null;
  }
}
