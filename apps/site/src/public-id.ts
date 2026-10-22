/**
 * Opaque public player ids for everything the site sends to clients.
 *
 * A raw `clientId` works like a bearer credential: the lobby trusts it to restore a player's
 * identity, seat claims, and lifetime score. It must therefore never reach other players. Every
 * site → client payload replaces each clientId with
 * `publicId = "p1_" + base64url(HMAC-SHA256(secret, "warehouse-public:v1:" + clientId))[0..22]`.
 * The substitution is uniform: the recipient's own `welcome.you.clientId` and own-hand key are
 * mapped too, so client-side equality checks (presence row, hands, completed runs, poach owner)
 * keep working entirely in publicId space. The lobby (`apps/lobby`, `publicIdFor`) uses the same
 * derivation and the same `TICKET_HMAC_SECRET`, so lobby leaderboard ids match site ids.
 *
 * Internal state (sim world, Firestore snapshots, heartbeats) keeps raw clientIds.
 */
import { createHmac } from 'node:crypto';
import type { SimEvent } from '@warehouse/sim';

export const PUBLIC_ID_PREFIX = 'p1_';
export const PUBLIC_ID_PATTERN = /^p1_[A-Za-z0-9_-]{22}$/;
const PUBLIC_ID_DOMAIN = 'warehouse-public:v1:';
const MAPPER_CACHE_MAX = 20_000;

/** Derives the opaque public id for a raw clientId. Deterministic per (secret, clientId). */
export function publicIdFor(clientId: string, secret: string): string {
  const mac = createHmac('sha256', secret).update(PUBLIC_ID_DOMAIN + clientId).digest('base64url');
  return PUBLIC_ID_PREFIX + mac.slice(0, 22);
}

export type PublicIdMapper = (clientId: string) => string;

/** Memoising mapper (bounded cache; cleared wholesale when full). */
export function createPublicIdMapper(secret: string): PublicIdMapper {
  const cache = new Map<string, string>();
  return (clientId: string): string => {
    let id = cache.get(clientId);
    if (id === undefined) {
      if (cache.size >= MAPPER_CACHE_MAX) cache.clear();
      id = publicIdFor(clientId, secret);
      cache.set(clientId, id);
    }
    return id;
  };
}

function mapNullable(id: string | null | undefined, pub: PublicIdMapper): string | null | undefined {
  return typeof id === 'string' && id.length > 0 ? pub(id) : id;
}

/** Event fields that always hold a raw clientId (any `*ClientId` key is treated the same way). */
const EVENT_CLIENT_ID_FIELDS = new Set(['clientId']);
/**
 * Event fields that hold a card-hand key: a clientId for humans, a vehicle id for AI hands
 * (`owner` on `poach`, `player` on `card` events).
 */
const EVENT_HAND_KEY_FIELDS = new Set(['owner', 'player']);

/**
 * Maps clientId-bearing fields in sim events: `clientId` / `*ClientId` always; hand-key fields
 * (`owner`, `player`) whenever `isClientId` says the value may be a clientId. Callers pass a
 * default-deny predicate ("anything that is not a live vehicle id"), so a player who already
 * left the site is still hashed, never leaked.
 */
export function publicizeEvents<E extends SimEvent>(
  events: E[],
  pub: PublicIdMapper,
  isClientId: (key: string) => boolean,
): E[] {
  let changed = false;
  const out = events.map((ev) => {
    let copy: Record<string, unknown> | null = null;
    for (const [k, val] of Object.entries(ev)) {
      if (typeof val !== 'string' || val.length === 0) continue;
      const isIdField = EVENT_CLIENT_ID_FIELDS.has(k) || k.endsWith('ClientId');
      const isHandKey = EVENT_HAND_KEY_FIELDS.has(k) && isClientId(val);
      if (!isIdField && !isHandKey) continue;
      copy ??= { ...ev };
      copy[k] = pub(val);
    }
    if (!copy) return ev;
    changed = true;
    return copy as E;
  });
  return changed ? out : events;
}

/** Re-keys a clientId-keyed record (difficulty votes). */
export function publicizeKeyedRecord<V>(
  rec: Record<string, V> | undefined,
  pub: PublicIdMapper,
  shouldMap: (key: string, value: V) => boolean = () => true,
): Record<string, V> | undefined {
  if (!rec) return rec;
  const out: Record<string, V> = {};
  for (const [k, v] of Object.entries(rec)) out[shouldMap(k, v) ? pub(k) : k] = v;
  return out;
}

interface CompletedRunLike {
  clientId?: string | null;
}

export function publicizeCompletedRuns<R extends CompletedRunLike>(
  runs: R[] | undefined,
  pub: PublicIdMapper,
): R[] | undefined {
  if (!runs) return runs;
  return runs.map((r) =>
    typeof r.clientId === 'string' && r.clientId.length > 0 ? { ...r, clientId: pub(r.clientId) } : r,
  );
}

interface VehicleIdsLike {
  ownerClientId?: string | null;
  controlledByClientId?: string | null;
}

export function publicizeVehicleIds<V extends VehicleIdsLike>(vehicles: V[], pub: PublicIdMapper): V[] {
  return vehicles.map((v) =>
    v.ownerClientId || v.controlledByClientId
      ? {
          ...v,
          ownerClientId: mapNullable(v.ownerClientId, pub) as V['ownerClientId'],
          controlledByClientId: mapNullable(v.controlledByClientId, pub) as V['controlledByClientId'],
        }
      : v,
  );
}

interface SnapshotLike {
  vehicles: VehicleIdsLike[];
  players: Array<[string, { clientId: string }]>;
  difficultyVotes: Record<string, unknown>;
  cards: Record<string, { ai?: boolean }>;
  events: SimEvent[];
  completedRuns?: CompletedRunLike[];
}

/**
 * Returns a copy of a serialized world snapshot (`welcome.snapshot`) with every clientId replaced
 * by its publicId: vehicle owner/driver ids, `players` entries, `difficultyVotes` keys, human
 * `cards` keys, `completedRuns[].clientId`, and event `clientId`/`owner` fields.
 */
export function publicizeSnapshot<S extends SnapshotLike>(
  snap: S,
  pub: PublicIdMapper,
  isClientId: (key: string) => boolean,
): S {
  return {
    ...snap,
    vehicles: publicizeVehicleIds(snap.vehicles, pub),
    players: snap.players.map(([key, sess]) => [pub(key), { ...sess, clientId: pub(sess.clientId) }]),
    difficultyVotes: publicizeKeyedRecord(snap.difficultyVotes, pub) ?? {},
    cards: publicizeKeyedRecord(snap.cards, pub, (k) => isClientId(k)) ?? {},
    events: publicizeEvents(snap.events, pub, isClientId),
    ...(snap.completedRuns ? { completedRuns: publicizeCompletedRuns(snap.completedRuns, pub) } : {}),
  };
}
