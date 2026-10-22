import { PUBLIC_ID_PATTERN } from '@warehouse/protocol';

/**
 * Player identity rules on the client.
 *
 * - The raw clientId (localStorage `warehouse_client_id`) is a bearer credential for lobby calls
 *   (`/api/join`, `/api/queue/*`). Only the lobby's `JoinResponse.clientId` (fresh join or resume
 *   adoption) may replace it, and it is never displayed.
 * - Every id the site or the `/api/network` leaderboard sends (`welcome.you.clientId`, presence,
 *   votes, cards/hands keys, events, leaderboard rows) is an opaque publicId (`p1_…`). Those must
 *   never be persisted as the raw clientId.
 */
export function isPublicId(value: unknown): value is string {
  return typeof value === 'string' && PUBLIC_ID_PATTERN.test(value);
}

/**
 * The raw clientId to keep after a lobby join response: `candidate` (the lobby's
 * `JoinResponse.clientId`) when it is a usable raw id that differs from `current`, else `current`.
 * A publicId is refused, so a server-sent id can never overwrite the stored credential.
 */
export function adoptRawClientId(current: string, candidate: unknown): string {
  if (typeof candidate !== 'string') return current;
  const id = candidate.trim();
  if (!id || id.length > 128 || isPublicId(id)) return current;
  return id;
}

/** Own-row match for `/api/network` leaderboard rows: `publicId` first, falling back to `clientId`. */
export function isOwnLeaderboardRow(
  row: { publicId?: string; clientId: string },
  selfPublicId: string | null | undefined,
): boolean {
  if (!selfPublicId) return false;
  return (row.publicId ?? row.clientId) === selfPublicId;
}
