import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import { Firestore } from '@google-cloud/firestore';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { GoogleAuth } from 'google-auth-library';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { z } from 'zod';
import {
  BASE_SITE_IDS,
  getCanonicalBaseSiteId,
  isValidSiteId,
  JoinRequestSchema,
  JoinResponseSchema,
  MAX_WS_FRAME_BYTES,
  NetworkResponseSchema,
  LeaderboardEntrySchema,
  PHASES,
  PROXY_HEADER_NAME,
  QueueStatusSchema,
  SITE_IDS,
  SiteIdSchema,
  signProxyHeader,
  signTicket,
  verifyProxyHeader,
  verifyTicket,
  type LeaderboardEntry,
  type Phase,
  type QueueStatus,
  type RunMode,
  type SiteId,
  type SiteStatus,
} from '@warehouse/protocol';
import {
  generateDriverCallsign,
  inspectPromptLocally,
  isReservedBotPrefix,
  validateDisplayName,
  type ModelArmorClient,
} from '@warehouse/armor';

export const LOBBY_VERSION = 1;
export const HEARTBEAT_STALE_MS = 15_000;
export const FREE_RANGE_SOFT_CAP = 26;
export const FREE_RANGE_HARD_CAP = 30;
export const MAX_DRIVERS_PER_SITE = 32;
export const TICKET_TTL_MS = 60_000;

export const DEFAULT_MAX_WAREHOUSES = 4;
export const DEFAULT_QUEUE_SCALE_THRESHOLD = 8;
export const DEFAULT_SEAT_CLAIM_LEASE_MS = 20_000;
export const DEFAULT_QUEUE_HEARTBEAT_TTL_MS = 20_000;
export const DEFAULT_OVERFLOW_IDLE_COOLDOWN_MS = 300_000;
/** Shared seat-hold window after admission (matches the pending-driver expiry in getSites). */
export const SEAT_HOLD_MS = 45_000;

export const OVERFLOW_POOL_SITE_IDS: readonly SiteId[] = [
  'den-2',
  'slc-3',
  'phx-4',
  'abq-5',
  'den-3',
  'slc-4',
  'phx-5',
  'abq-6',
];

export const ALL_POOL_SITE_IDS: readonly SiteId[] = [
  ...BASE_SITE_IDS,
  ...OVERFLOW_POOL_SITE_IDS,
];

export const CSP_HEADER =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:;";

export type SitePhaseInput = Phase | 'on_break' | 'day';

export interface StoredSiteDoc {
  id: SiteId;
  state?: 'live' | 'online' | 'break' | 'offline';
  phase?: SitePhaseInput;
  drivers: number;
  spectators: number;
  tier: number;
  shipped: number;
  wsUrl?: string;
  /** Driver cap reported by the site heartbeat (`MAX_DRIVERS`). */
  maxDrivers?: number;
  /**
   * clientIds already included in `drivers` (heartbeat roster ∪ this instance's pending
   * assignments). Used so shared seat holds are not double-counted once a driver is visible.
   */
  driverClientIds?: string[];
  /**
   * clientIds the site heartbeat itself reports as connected drivers (excludes this instance's
   * pending assignments). A `claimed` seat hold for a clientId listed here is released at once:
   * the driver has actually connected, so the 45 s hold is no longer needed (and must not linger
   * after they leave). When absent (e.g. in-memory/test stores whose site docs are the heartbeat),
   * `driverClientIds` is used instead.
   */
  connectedDriverClientIds?: string[];
  updatedAt: number;
}

export interface StoredPlayerDoc {
  clientId: string;
  name: string;
  siteId?: SiteId;
  points?: number;
  lifetimePoints?: number;
  bestBlitzPts?: number;
  /** Points per minute from the site's player stats doc (nonnegative); omitted when absent. */
  ppm?: number;
  deliveries: number;
  isBot?: boolean;
  updatedAt?: number;
  /** SHA-256 (hex) of the player's secret resume code; the raw code is never stored. */
  resumeTokenHash?: string;
}

export interface QueueEntry {
  clientId: string;
  name: string;
  preferredSite?: SiteId;
  mode?: RunMode;
  isBot: boolean;
  enqueuedAt: number;
  lastPolledAt: number;
  /**
   * `queued` waiting · `ready` seat leased until `leaseExpiresAt` · `claimed` seat hold: the driver
   * was admitted to `assignedSiteId` and the seat stays reserved (shared across lobby instances)
   * until the site heartbeat lists the driver or `leaseExpiresAt` lapses · `expired` terminal.
   */
  state: 'queued' | 'ready' | 'claimed' | 'expired';
  seatLeaseId: string;
  assignedSiteId?: SiteId;
  leaseExpiresAt?: number;
}

export type PlayerIdentityResult =
  | { ok: true; clientId: string; name: string }
  | { ok: false; error: string; message: string };

export interface ResolvePlayerIdentityParams {
  /** Browser-local clientId sent with the join request. */
  clientId: string;
  /**
   * SHA-256 hash of a well-formed resume code (`wr1_…`) supplied by the caller. The store looks
   * the player up by this hash only; it never matches on display names or raw clientIds.
   */
  resumeTokenHash?: string;
  /**
   * A non-code `resume` value (existing callsign lookup). Resolves an existing human driver
   * callsign in the store and never adds or creates a new custom name.
   */
  resumeCallsign?: string;
  /** Derives the resume-code hash for a clientId so the store can persist/backfill it. */
  resumeTokenHashFor?: (clientId: string) => string;
  siteId?: SiteId;
  nowMs: number;
}

/** Snapshot + buffered writes for one atomic queue mutation (Firestore transaction when available). */
export interface QueueTxn {
  /** Authoritative queue entries read inside the transaction, FIFO-sorted. */
  readonly entries: QueueEntry[];
  set(entry: QueueEntry): void;
  delete(clientId: string): void;
}

export interface LobbyStore {
  getSites(): Promise<StoredSiteDoc[]>;
  getTopPlayers(limit: number): Promise<StoredPlayerDoc[]>;
  listCallsigns?(query?: string, limit?: number): Promise<string[]>;
  wakeSite?(siteId: SiteId, nowMs?: number): Promise<void>;
  recordAssignment?(
    siteId: SiteId,
    clientId: string,
    role: 'driver' | 'spectator',
    nowMs: number,
  ): void;
  resolvePlayerIdentity?(params: ResolvePlayerIdentityParams): Promise<PlayerIdentityResult>;
  getQueueEntries?(): Promise<QueueEntry[]>;
  setQueueEntry?(entry: QueueEntry): Promise<void>;
  deleteQueueEntry?(clientId: string): Promise<void>;
  /**
   * Runs `fn` against an authoritative queue snapshot and commits its buffered writes atomically.
   * Implementations backed by shared storage must serialize concurrent callers across instances
   * (Firestore: `runTransaction`, retried on contention). `fn` may be re-invoked on retry.
   */
  runQueueTransaction?<T>(fn: (tx: QueueTxn) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Resume codes: secret, per-player bearer codes replacing callsign-based resume.
// ---------------------------------------------------------------------------

export const RESUME_TOKEN_PREFIX = 'wr1_';
const RESUME_TOKEN_PATTERN = /^wr1_[A-Za-z0-9_-]{32}$/;

/** Deterministic resume code for a clientId: `wr1_` + 32 base64url chars of HMAC-SHA256. */
export function resumeTokenFor(clientId: string, secret: string): string {
  const mac = createHmac('sha256', secret)
    .update(`warehouse-resume:v1:${clientId}`)
    .digest('base64url')
    .slice(0, 32);
  return `${RESUME_TOKEN_PREFIX}${mac}`;
}

/**
 * Opaque public player id (`p1_` + 22 base64url chars of
 * `HMAC-SHA256(secret, "warehouse-public:v1:" + clientId)`). Raw clientIds act as bearer secrets
 * (queue claims, own-identity joins), so public responses such as the `/api/network` leaderboard
 * expose only this id. `apps/site/src/public-id.ts` uses the identical derivation with the same
 * `TICKET_HMAC_SECRET`, so leaderboard rows and site presence/welcome ids match.
 */
export const PUBLIC_ID_PREFIX = 'p1_';
export const PUBLIC_ID_PATTERN = /^p1_[A-Za-z0-9_-]{22}$/;

export function publicIdFor(clientId: string, secret: string): string {
  const mac = createHmac('sha256', secret)
    .update(`warehouse-public:v1:${clientId}`)
    .digest('base64url')
    .slice(0, 22);
  return `${PUBLIC_ID_PREFIX}${mac}`;
}

export function isResumeTokenFormat(value: string): boolean {
  return RESUME_TOKEN_PATTERN.test(value);
}

const INVALID_RESUME_ERROR = 'invalid_resume_code';
const INVALID_RESUME_MESSAGE =
  'No existing driver callsign matches that name. Leave it blank to keep your assigned callsign, or enter an existing callsign / resume code.';
const INVALID_RESUME_CODE: PlayerIdentityResult = {
  ok: false,
  error: INVALID_RESUME_ERROR,
  message: INVALID_RESUME_MESSAGE,
};

/** SHA-256 (hex) of a resume code; this is what is persisted on the player doc. */
export function hashResumeToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time check that `token` is the resume code minted for `clientId`. */
export function verifyResumeToken(token: string, clientId: string, secret: string): boolean {
  const expected = Buffer.from(resumeTokenFor(clientId, secret), 'utf8');
  const actual = Buffer.from(token, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// ---------------------------------------------------------------------------
// Client IP resolution and lobby → site signed client-IP header.
// ---------------------------------------------------------------------------

/** Header carrying the lobby-computed client IP to site shards. */
export const CLIENT_IP_HEADER_NAME = 'x-warehouse-client-ip';
/** HMAC binding `CLIENT_IP_HEADER_NAME` to the accompanying `x-warehouse-proxy` token. */
export const CLIENT_IP_SIG_HEADER_NAME = 'x-warehouse-client-ip-sig';

/**
 * Number of trusted reverse-proxy hops in front of the lobby. Direct `*.run.app` traffic passes
 * through exactly one Google Front End, which appends the real peer address as the right-most
 * `X-Forwarded-For` entry (anything to its left is client-supplied). Set `TRUSTED_PROXY_HOPS=2`
 * only if an external HTTPS load balancer is placed in front of Cloud Run.
 */
export function resolveTrustedProxyHops(raw: string | undefined = process.env.TRUSTED_PROXY_HOPS): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 4 ? n : 1;
}

/**
 * Resolves the client IP the same way Fastify `trustProxy: <hops>` does: walk from the socket peer
 * leftward through `X-Forwarded-For`, trusting exactly `trustedHops` entries, and return the first
 * untrusted address. Never returns the raw left-most (client-controlled) entry when more hops exist.
 */
export function resolveClientIp(
  forwardedFor: string | string[] | undefined,
  remoteAddress: string | undefined,
  trustedHops: number,
): string {
  const socketAddr = remoteAddress || '127.0.0.1';
  const raw = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor ?? '';
  const xff = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // Nearest hop first: socket peer, then XFF right-to-left.
  const chain = [socketAddr, ...xff.reverse()];
  const idx = Math.min(Math.max(0, trustedHops), chain.length - 1);
  return chain[idx];
}

/** Signs the client IP bound to a specific `x-warehouse-proxy` token value. */
export function signClientIp(ip: string, proxyToken: string, secret: string): string {
  return createHmac('sha256', secret).update(`client-ip:${proxyToken}:${ip}`).digest('base64url');
}

export function parseSiteUrlsMap(): Partial<Record<SiteId, string>> {
  const raw = process.env.SITE_URLS_JSON;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<Record<SiteId, string>> = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (isValidSiteId(key) && typeof val === 'string' && val) {
        out[key] = val.replace(/\/$/, '');
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function resolveSiteHttpBaseUrl(
  siteId: SiteId,
  siteUrls: Partial<Record<SiteId, string>> = parseSiteUrlsMap(),
): string | undefined {
  const direct = siteUrls[siteId];
  if (direct) return direct.replace(/\/$/, '');
  const baseId = getCanonicalBaseSiteId(siteId);
  const fallback = siteUrls[baseId];
  if (fallback) return fallback.replace(/\/$/, '');
  return undefined;
}

export function httpUrlToWsUrl(httpUrl: string): string {
  const trimmed = httpUrl.trim().replace(/\/$/, '');
  if (trimmed.startsWith('wss://') || trimmed.startsWith('ws://')) {
    return trimmed.endsWith('/ws') ? trimmed : `${trimmed}/ws`;
  }
  if (trimmed.startsWith('https://')) {
    return `wss://${trimmed.slice('https://'.length)}/ws`;
  }
  if (trimmed.startsWith('http://')) {
    return `ws://${trimmed.slice('http://'.length)}/ws`;
  }
  return `${trimmed}/ws`;
}

export function wsUrlToInternalHttpUrl(wsOrHttpUrl: string): string {
  const trimmed = wsOrHttpUrl.trim().replace(/\/ws(\?.*)?$/, '').replace(/\/$/, '');
  if (trimmed.startsWith('wss://')) {
    return `https://${trimmed.slice('wss://'.length)}`;
  }
  if (trimmed.startsWith('ws://')) {
    return `http://${trimmed.slice('ws://'.length)}`;
  }
  return trimmed;
}

export function publicLobbyWsUrl(
  req: { headers: Record<string, unknown>; protocol?: string },
  siteId: SiteId,
): string {
  const rawProto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const wsProto = rawProto === 'https' ? 'wss' : 'ws';
  const rawHost = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost:8080')
    .split(',')[0]
    .trim();
  return `${wsProto}://${rawHost}/ws?site=${siteId}`;
}

const googleAuth = new GoogleAuth();

/** Returns a finite, nonnegative ppm value, or undefined when the site did not supply one. */
export function normalizePpm(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

export async function buildInternalBackendHeaders(
  siteId: SiteId,
  targetUrl: string,
  secret: string,
  nowMs: number = Date.now(),
  extraHeaders?: Record<string, string>,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    [PROXY_HEADER_NAME]: signProxyHeader(siteId, secret, nowMs),
    ...extraHeaders,
  };
  if (targetUrl.startsWith('https://') || targetUrl.startsWith('wss://')) {
    try {
      const parsed = new URL(targetUrl);
      const targetOrigin = `https://${parsed.host}`;
      const client = await googleAuth.getIdTokenClient(targetOrigin);
      const reqHeaders = await client.getRequestHeaders(targetOrigin);
      const authHeader =
        reqHeaders instanceof Headers
          ? reqHeaders.get('Authorization') || reqHeaders.get('authorization')
          : (reqHeaders as Record<string, string>).Authorization ||
            (reqHeaders as Record<string, string>).authorization;
      if (authHeader) {
        headers.authorization = authHeader;
      }
    } catch {
      // Continue with HMAC proxy header in local/non-GCP environments
    }
  }
  return headers;
}

/**
 * Production Firestore-backed store for `sites/{id}` and `players/{clientId}`.
 */
export class FirestoreLobbyStore implements LobbyStore {
  private readonly db: Firestore;
  private readonly suffix: string;
  private readonly siteUrls: Partial<Record<SiteId, string>>;
  private readonly pendingDrivers = new Map<SiteId, Map<string, number>>();
  private readonly wokenUntil = new Map<SiteId, number>();
  private readonly localQueue = new Map<string, QueueEntry>();

  constructor(db?: Firestore, siteUrls?: Partial<Record<SiteId, string>>) {
    this.suffix = process.env.SUFFIX || '';
    this.siteUrls = siteUrls ?? parseSiteUrlsMap();
    this.db =
      db ??
      new Firestore({
        projectId:
          process.env.GOOGLE_CLOUD_PROJECT ||
          process.env.GCP_PROJECT_ID ||
          process.env.GCP_PROJECT ||
          'davenporter-freightfloor',
        databaseId: process.env.FIRESTORE_DATABASE_ID || '(default)',
      });
  }

  private colName(base: string): string {
    return `${base}${this.suffix}`;
  }

  recordAssignment(
    siteId: SiteId,
    clientId: string,
    role: 'driver' | 'spectator',
    nowMs: number,
  ): void {
    for (const map of this.pendingDrivers.values()) {
      map.delete(clientId);
    }
    if (role !== 'driver') return;
    let map = this.pendingDrivers.get(siteId);
    if (!map) {
      map = new Map<string, number>();
      this.pendingDrivers.set(siteId, map);
    }
    map.set(clientId, nowMs);
  }

  async getSites(nowMs: number = Date.now()): Promise<StoredSiteDoc[]> {
    const snap = await this.db.collection(this.colName('sites')).get();
    const byId = new Map<SiteId, StoredSiteDoc>();

    snap.forEach((doc) => {
      const data = doc.data();
      const id = String(data.id || data.siteId || doc.id);
      if (!isValidSiteId(id)) return;
      const updatedAt =
        typeof data.updatedAt === 'number'
          ? data.updatedAt
          : data.updatedAt && typeof data.updatedAt.toMillis === 'function'
            ? data.updatedAt.toMillis()
            : 0;

      const rawDrivers =
        typeof data.drivers === 'number'
          ? data.drivers
          : typeof data.players === 'number'
            ? data.players
            : 0;
      const hasDriverClientIds = Array.isArray(data.driverClientIds);
      const driverClientIds = hasDriverClientIds
        ? (data.driverClientIds as unknown[]).filter(
            (x): x is string => typeof x === 'string',
          )
        : [];

      const pendingMap = this.pendingDrivers.get(id);
      if (pendingMap) {
        for (const cid of driverClientIds) {
          pendingMap.delete(cid);
        }
        for (const [cid, assignedAt] of pendingMap.entries()) {
          if (
            nowMs - assignedAt > 45_000 ||
            (hasDriverClientIds && updatedAt > assignedAt + 2_000)
          ) {
            pendingMap.delete(cid);
          }
        }
      }
      const pendingCount = pendingMap ? pendingMap.size : 0;
      const drivers = hasDriverClientIds
        ? new Set([
            ...driverClientIds,
            ...(pendingMap ? pendingMap.keys() : []),
          ]).size
        : rawDrivers + pendingCount;
      const countedDriverIds = [
        ...new Set([...driverClientIds, ...(pendingMap ? pendingMap.keys() : [])]),
      ];

      const rawWsUrl =
        typeof data.wsUrl === 'string'
          ? data.wsUrl
          : typeof data.url === 'string' && !data.url.includes('localhost')
            ? httpUrlToWsUrl(data.url)
            : undefined;

      const wokenExp = this.wokenUntil.get(id) ?? 0;
      const isRecentlyWoken = wokenExp > nowMs;

      byId.set(id, {
        id,
        state: isRecentlyWoken
          ? 'live'
          : data.state ?? (data.phase === 'break' ? 'break' : 'live'),
        phase: isRecentlyWoken ? 'running' : data.phase,
        drivers,
        driverClientIds: countedDriverIds,
        connectedDriverClientIds: driverClientIds,
        spectators: typeof data.spectators === 'number' ? data.spectators : 0,
        tier: typeof data.tier === 'number' ? data.tier : 0,
        shipped: typeof data.shipped === 'number' ? data.shipped : 0,
        wsUrl: rawWsUrl,
        ...(typeof data.maxDrivers === 'number' && data.maxDrivers > 0
          ? { maxDrivers: data.maxDrivers }
          : {}),
        updatedAt: isRecentlyWoken ? Math.max(updatedAt, nowMs) : updatedAt,
      });
    });

    const configuredUrls = parseSiteUrlsMap();
    for (const id of SITE_IDS) {
      const configuredHttpUrl = configuredUrls[id] ?? this.siteUrls[id];
      if (!configuredHttpUrl) continue;
      const existing = byId.get(id);
      const pendingMap = this.pendingDrivers.get(id);
      if (pendingMap) {
        for (const [cid, assignedAt] of pendingMap.entries()) {
          if (nowMs - assignedAt > 45_000) {
            pendingMap.delete(cid);
          }
        }
      }
      const pendingCount = pendingMap ? pendingMap.size : 0;
      const wokenExp = this.wokenUntil.get(id) ?? 0;
      const isRecentlyWoken = wokenExp > nowMs;

      if (!existing || nowMs - existing.updatedAt > HEARTBEAT_STALE_MS) {
        byId.set(id, {
          id,
          state: isRecentlyWoken ? 'live' : 'break',
          phase: isRecentlyWoken ? 'running' : 'break',
          drivers: pendingCount,
          driverClientIds: pendingMap ? [...pendingMap.keys()] : [],
          connectedDriverClientIds: [],
          spectators: 0,
          tier: existing?.tier ?? 0,
          shipped: existing?.shipped ?? 0,
          wsUrl: httpUrlToWsUrl(configuredHttpUrl),
          ...(existing?.maxDrivers !== undefined ? { maxDrivers: existing.maxDrivers } : {}),
          updatedAt: nowMs,
        });
      }
    }

    for (const [id, wokenExp] of this.wokenUntil.entries()) {
      if (wokenExp > nowMs && !byId.has(id)) {
        const pendingMap = this.pendingDrivers.get(id);
        const pendingCount = pendingMap ? pendingMap.size : 0;
        const baseHttpUrl = resolveSiteHttpBaseUrl(id, { ...configuredUrls, ...this.siteUrls });
        byId.set(id, {
          id,
          state: 'live',
          phase: 'running',
          drivers: pendingCount,
          driverClientIds: pendingMap ? [...pendingMap.keys()] : [],
          connectedDriverClientIds: [],
          spectators: 0,
          tier: 0,
          shipped: 0,
          ...(baseHttpUrl ? { wsUrl: httpUrlToWsUrl(baseHttpUrl) } : {}),
          updatedAt: nowMs,
        });
      }
    }

    return Array.from(byId.values());
  }

  async getTopPlayers(limit: number): Promise<StoredPlayerDoc[]> {
    const snap = await this.db.collection(this.colName('players')).limit(100).get();
    const players: StoredPlayerDoc[] = [];
    snap.forEach((doc) => {
      const data = doc.data();
      const clientId = String(data.clientId || doc.id);
      const name = String(data.name || 'Driver');
      const points =
        typeof data.points === 'number'
          ? data.points
          : typeof data.lifetimePoints === 'number'
            ? data.lifetimePoints
            : typeof data.totalScore === 'number'
              ? data.totalScore
              : 0;
      const lifetimePoints =
        typeof data.lifetimePoints === 'number' ? data.lifetimePoints : points;
      const bestBlitzPts =
        typeof data.bestBlitzPts === 'number' ? data.bestBlitzPts : undefined;
      const ppm = normalizePpm(data.ppm);
      const deliveries =
        typeof data.deliveries === 'number'
          ? data.deliveries
          : typeof data.totalDeliveries === 'number'
            ? data.totalDeliveries
            : 0;
      const siteRaw = String(data.siteId || data.lastSiteId || '');
      players.push({
        clientId,
        name,
        siteId: isValidSiteId(siteRaw) ? siteRaw : undefined,
        points,
        lifetimePoints,
        ...(bestBlitzPts !== undefined ? { bestBlitzPts } : {}),
        ...(ppm !== undefined ? { ppm } : {}),
        deliveries,
        isBot: Boolean(data.isBot),
      });
    });
    return players
      .filter((p) => !p.isBot && !isReservedBotPrefix(p.name))
      .sort((a, b) => (b.points ?? 0) - (a.points ?? 0))
      .slice(0, limit);
  }

  async listCallsigns(_query: string = '', _limit: number = 20): Promise<string[]> {
    // Public callsign enumeration/autocomplete is disabled so players cannot browse or assume another player's identity.
    return [];
  }

  async resolvePlayerIdentity(params: ResolvePlayerIdentityParams): Promise<PlayerIdentityResult> {
    const col = this.db.collection(this.colName('players'));
    const normalizeBaseName = (name: string) => name.replace(/\s+Run\s+\d+$/i, '').trim().toLowerCase();
    const touch = async (clientId: string, name: string, extra: Record<string, unknown> = {}) => {
      const resumeTokenHash = params.resumeTokenHashFor?.(clientId);
      await col.doc(clientId).set(
        {
          clientId,
          name,
          updatedAt: params.nowMs,
          ...(params.siteId ? { siteId: params.siteId } : {}),
          ...(resumeTokenHash ? { resumeTokenHash } : {}),
          ...extra,
        },
        { merge: true },
      );
    };
    const toIdentity = (id: string, data: Record<string, unknown>) => {
      const name = String(data.name || '');
      return {
        clientId: String(data.clientId || id),
        name,
        isBot: Boolean(data.isBot) || isReservedBotPrefix(name),
      };
    };

    // Resume by secret code: exact hash lookup, never by raw clientId.
    if (params.resumeTokenHash) {
      const snap = await col.where('resumeTokenHash', '==', params.resumeTokenHash).limit(1).get();
      let matched: { clientId: string; name: string; isBot: boolean } | undefined;
      snap.forEach((doc) => {
        if (!matched) matched = toIdentity(doc.id, doc.data());
      });
      if (!matched || matched.isBot || !matched.name) {
        return INVALID_RESUME_CODE;
      }
      await touch(matched.clientId, matched.name);
      return { ok: true, clientId: matched.clientId, name: matched.name };
    }

    const ownSnap = await col.doc(params.clientId).get();
    const own = ownSnap.exists ? toIdentity(params.clientId, ownSnap.data() ?? {}) : undefined;

    // A bare callsign only resumes on the same browser that already owns it; never allow assuming another player.
    if (params.resumeCallsign) {
      const targetCallsign = normalizeBaseName(params.resumeCallsign);
      if (own && !own.isBot && own.name && normalizeBaseName(own.name) === targetCallsign) {
        await touch(own.clientId, own.name);
        return { ok: true, clientId: own.clientId, name: own.name };
      }
      return INVALID_RESUME_CODE;
    }

    if (own && !own.isBot && own.name && own.name !== 'Driver') {
      await touch(own.clientId, own.name);
      return { ok: true, clientId: own.clientId, name: own.name };
    }

    const snap = await col.limit(500).get();
    const existingNames: string[] = [];
    snap.forEach((doc) => {
      const d = toIdentity(doc.id, doc.data());
      if (d.clientId !== params.clientId && d.name) existingNames.push(d.name);
    });
    const assignedName = generateDriverCallsign(params.clientId, existingNames);
    await touch(params.clientId, assignedName, { isBot: false });
    return { ok: true, clientId: params.clientId, name: assignedName };
  }

  async wakeSite(siteId: SiteId, nowMs: number = Date.now()): Promise<void> {
    this.wokenUntil.set(siteId, nowMs + 25_000);
    try {
      const col = this.db.collection(this.colName('sites'));
      if (typeof col.doc === 'function') {
        await col.doc(siteId).set(
          {
            id: siteId,
            siteId,
            phase: 'day',
            state: 'live',
            updatedAt: nowMs,
          },
          { merge: true },
        );
      }
    } catch {
      // Ignore Firestore write error if mocked db does not implement doc().set
    }

    const configuredUrls = { ...parseSiteUrlsMap(), ...this.siteUrls };
    const siteHttpUrl = resolveSiteHttpBaseUrl(siteId, configuredUrls);
    if (siteHttpUrl) {
      try {
        const secret = await resolveTicketSecret();
        const headers = await buildInternalBackendHeaders(
          siteId,
          siteHttpUrl,
          secret,
          nowMs,
          { 'content-type': 'application/json' },
        );
        const wakeReq = fetch(`${siteHttpUrl}/internal/wake?site=${encodeURIComponent(siteId)}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ immediate: true, siteId }),
        }).catch(() => {
          // Ignore network errors during wake ping; client WS connection will also wake Cloud Run
        });
        await Promise.race([
          wakeReq,
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 250);
            t.unref?.();
          }),
        ]);
      } catch {
        // Ignore network errors during wake ping; client WS connection will also wake Cloud Run
      }
    }
  }

  async getQueueEntries(): Promise<QueueEntry[]> {
    const col = this.db.collection(this.colName('queue'));
    if (typeof col.get !== 'function') {
      // Minimal DB stubs (unit tests) without a queue collection: instance-local queue.
      return sortQueueEntries(Array.from(this.localQueue.values()).map((e) => ({ ...e })));
    }
    let snap: Awaited<ReturnType<typeof col.get>>;
    try {
      snap = await col.get();
    } catch (err) {
      // Never silently substitute instance-local state for the shared queue (max 2 instances).
      throw new QueueStoreUnavailableError('read', err);
    }
    const out: QueueEntry[] = [];
    snap.forEach((doc) => {
      const d = doc.data() as unknown as QueueEntry;
      if (d && typeof d.clientId === 'string') {
        out.push({ ...d });
      }
    });
    // An empty authoritative queue is returned as-is.
    return sortQueueEntries(out);
  }

  async setQueueEntry(entry: QueueEntry): Promise<void> {
    const col = this.db.collection(this.colName('queue'));
    if (typeof col.doc !== 'function') {
      this.localQueue.set(entry.clientId, { ...entry });
      return;
    }
    try {
      await col.doc(entry.clientId).set(toFirestoreQueueEntry(entry));
    } catch (err) {
      throw new QueueStoreUnavailableError('write', err);
    }
  }

  async deleteQueueEntry(clientId: string): Promise<void> {
    const col = this.db.collection(this.colName('queue'));
    if (typeof col.doc !== 'function') {
      this.localQueue.delete(clientId);
      return;
    }
    try {
      await col.doc(clientId).delete();
    } catch (err) {
      throw new QueueStoreUnavailableError('write', err);
    }
  }

  /**
   * Atomic queue mutation across lobby instances. Reads the allocator ledger doc and the whole
   * queue collection inside a Firestore transaction, runs `fn`, then commits its buffered writes
   * plus a ledger version bump. Because every mutating transaction reads and writes the same
   * ledger doc, concurrent allocations/claims on two instances serialize (the loser retries
   * against fresh data), so one seat can never be leased twice.
   */
  async runQueueTransaction<T>(fn: (tx: QueueTxn) => Promise<T>): Promise<T> {
    const col = this.db.collection(this.colName('queue'));
    if (typeof this.db.runTransaction !== 'function' || typeof col.doc !== 'function') {
      return runBufferedQueueTxn(
        () => this.getQueueEntries(),
        (e) => this.setQueueEntry(e),
        (id) => this.deleteQueueEntry(id),
        fn,
      );
    }
    const ledgerRef = this.db.collection(this.colName('queue_meta')).doc('allocator');
    try {
      return await this.db.runTransaction(async (t) => {
        const ledgerSnap = await t.get(ledgerRef);
        const snap = await t.get(col);
        const entries: QueueEntry[] = [];
        snap.forEach((doc) => {
          const d = doc.data() as unknown as QueueEntry;
          if (d && typeof d.clientId === 'string') entries.push({ ...d });
        });
        const sets = new Map<string, QueueEntry>();
        const deletes = new Set<string>();
        const result = await fn({
          entries: sortQueueEntries(entries),
          set: (e) => {
            deletes.delete(e.clientId);
            sets.set(e.clientId, { ...e });
          },
          delete: (id) => {
            sets.delete(id);
            deletes.add(id);
          },
        });
        if (sets.size > 0 || deletes.size > 0) {
          for (const e of sets.values()) t.set(col.doc(e.clientId), toFirestoreQueueEntry(e));
          for (const id of deletes) t.delete(col.doc(id));
          const prev = Number(ledgerSnap.exists ? ledgerSnap.data()?.version : 0) || 0;
          t.set(ledgerRef, { version: prev + 1, updatedAt: Date.now() });
        }
        return result;
      });
    } catch (err) {
      if (err instanceof QueueStoreUnavailableError) throw err;
      throw new QueueStoreUnavailableError('transaction', err);
    }
  }
}

/** Raised when the shared Firestore queue cannot be read/written; routes surface it as 503. */
export class QueueStoreUnavailableError extends Error {
  readonly code = 'queue_unavailable';
  constructor(
    readonly op: 'read' | 'write' | 'transaction',
    readonly detail: unknown,
  ) {
    super(
      `Firestore queue ${op} failed: ${detail instanceof Error ? detail.message : String(detail)}`,
    );
    this.name = 'QueueStoreUnavailableError';
  }
}

function sortQueueEntries(entries: QueueEntry[]): QueueEntry[] {
  return entries.sort(
    (a, b) => a.enqueuedAt - b.enqueuedAt || a.clientId.localeCompare(b.clientId),
  );
}

/** Firestore rejects `undefined` field values; drop them. */
function toFirestoreQueueEntry(entry: QueueEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Snapshot + buffered-commit queue transaction for single-process stores. Callers must already be
 * serialized in-process (the lobby's `withJoinLock`).
 */
export async function runBufferedQueueTxn<T>(
  read: () => Promise<QueueEntry[]>,
  write: (entry: QueueEntry) => Promise<void>,
  remove: (clientId: string) => Promise<void>,
  fn: (tx: QueueTxn) => Promise<T>,
): Promise<T> {
  const entries = sortQueueEntries((await read()).map((e) => ({ ...e })));
  const ops: Array<{ kind: 'set'; entry: QueueEntry } | { kind: 'delete'; clientId: string }> = [];
  const result = await fn({
    entries,
    set: (entry) => ops.push({ kind: 'set', entry: { ...entry } }),
    delete: (clientId) => ops.push({ kind: 'delete', clientId }),
  });
  for (const op of ops) {
    if (op.kind === 'set') await write(op.entry);
    else await remove(op.clientId);
  }
  return result;
}

/**
 * In-memory store implementation for deterministic unit tests and local single-node dev.
 */
export class InMemoryLobbyStore implements LobbyStore {
  private sites = new Map<SiteId, StoredSiteDoc>();
  private players = new Map<string, StoredPlayerDoc>();
  private queue = new Map<string, QueueEntry>();
  public wokenSites: SiteId[] = [];

  constructor(initialSites?: StoredSiteDoc[], initialPlayers?: StoredPlayerDoc[]) {
    if (initialSites) {
      for (const s of initialSites) {
        this.sites.set(s.id, { ...s });
      }
    }
    if (initialPlayers) {
      for (const p of initialPlayers) {
        this.players.set(p.clientId, { ...p });
      }
    }
  }

  setSite(site: StoredSiteDoc): void {
    this.sites.set(site.id, { ...site });
  }

  setPlayer(player: StoredPlayerDoc): void {
    this.players.set(player.clientId, { ...player });
  }

  async getSites(): Promise<StoredSiteDoc[]> {
    return Array.from(this.sites.values()).map((s) => ({ ...s }));
  }

  async getTopPlayers(limit: number): Promise<StoredPlayerDoc[]> {
    return Array.from(this.players.values())
      .filter((p) => !p.isBot && !isReservedBotPrefix(p.name))
      .sort((a, b) => (b.points ?? b.lifetimePoints ?? 0) - (a.points ?? a.lifetimePoints ?? 0))
      .slice(0, limit)
      .map((p) => ({
        ...p,
        points: p.points ?? p.lifetimePoints ?? 0,
        lifetimePoints: p.lifetimePoints ?? p.points ?? 0,
      }));
  }

  async listCallsigns(_query: string = '', _limit: number = 20): Promise<string[]> {
    // Public callsign enumeration/autocomplete is disabled so players cannot browse or assume another player's identity.
    return [];
  }

  async resolvePlayerIdentity(params: ResolvePlayerIdentityParams): Promise<PlayerIdentityResult> {
    const isHuman = (p: StoredPlayerDoc) => !p.isBot && !isReservedBotPrefix(p.name);
    const normalizeBaseName = (name: string) => name.replace(/\s+Run\s+\d+$/i, '').trim().toLowerCase();
    const touch = (p: StoredPlayerDoc) => {
      p.updatedAt = params.nowMs;
      if (params.siteId) p.siteId = params.siteId;
      const hash = params.resumeTokenHashFor?.(p.clientId);
      if (hash) p.resumeTokenHash = hash;
    };

    // Resume by secret code: exact hash lookup, never by raw clientId.
    if (params.resumeTokenHash) {
      for (const p of this.players.values()) {
        if (p.resumeTokenHash === params.resumeTokenHash && isHuman(p) && p.name) {
          touch(p);
          return { ok: true, clientId: p.clientId, name: p.name };
        }
      }
      return INVALID_RESUME_CODE;
    }

    const own = this.players.get(params.clientId);

    // A bare callsign only resumes on the same browser that already owns it; never allow assuming another player.
    if (params.resumeCallsign) {
      const targetCallsign = normalizeBaseName(params.resumeCallsign);
      if (own && isHuman(own) && own.name && normalizeBaseName(own.name) === targetCallsign) {
        touch(own);
        return { ok: true, clientId: own.clientId, name: own.name };
      }
      return INVALID_RESUME_CODE;
    }

    const existing = own;
    if (existing && !existing.isBot && existing.name && existing.name !== 'Driver') {
      touch(existing);
      return { ok: true, clientId: existing.clientId, name: existing.name };
    }

    const existingNames: string[] = [];
    for (const [cid, p] of this.players.entries()) {
      if (cid !== params.clientId && p.name) {
        existingNames.push(p.name);
      }
    }
    const assignedName = generateDriverCallsign(params.clientId, existingNames);
    const created: StoredPlayerDoc = {
      clientId: params.clientId,
      name: assignedName,
      siteId: params.siteId ?? existing?.siteId,
      points: existing?.points ?? 0,
      lifetimePoints: existing?.lifetimePoints ?? 0,
      deliveries: existing?.deliveries ?? 0,
      isBot: false,
      updatedAt: params.nowMs,
    };
    touch(created);
    this.players.set(params.clientId, created);
    return { ok: true, clientId: params.clientId, name: assignedName };
  }

  async wakeSite(siteId: SiteId, nowMs: number = Date.now()): Promise<void> {
    this.wokenSites.push(siteId);
    const existing = this.sites.get(siteId);
    if (existing) {
      existing.phase = 'running';
      existing.state = 'live';
      existing.updatedAt = nowMs;
    } else {
      this.sites.set(siteId, {
        id: siteId,
        state: 'live',
        phase: 'day',
        drivers: 0,
        spectators: 0,
        tier: 0,
        shipped: 0,
        updatedAt: nowMs,
      });
    }
  }

  async getQueueEntries(): Promise<QueueEntry[]> {
    return Array.from(this.queue.values()).map((e) => ({ ...e }));
  }

  async setQueueEntry(entry: QueueEntry): Promise<void> {
    this.queue.set(entry.clientId, { ...entry });
  }

  async deleteQueueEntry(clientId: string): Promise<void> {
    this.queue.delete(clientId);
  }
}

export interface PlacementResult {
  siteId: SiteId;
  wsUrl: string;
  role: 'driver' | 'spectator';
  wokeBreakSite: boolean;
}

function isBreakSite(site: StoredSiteDoc): boolean {
  return site.phase === 'on_break' || site.phase === 'break' || site.state === 'break';
}

function normalizePhase(phase?: SitePhaseInput): Phase {
  if (!phase) return 'running';
  if (phase === 'on_break') return 'break';
  if ((PHASES as readonly string[]).includes(phase)) return phase as Phase;
  return 'running';
}

function isFreshLiveSite(site: StoredSiteDoc, nowMs: number): boolean {
  if (site.state === 'offline') return false;
  if (isBreakSite(site)) return false;
  return nowMs - site.updatedAt <= HEARTBEAT_STALE_MS;
}

function isWakingCandidateBreakSite(site: StoredSiteDoc, nowMs: number): boolean {
  if (!isBreakSite(site)) return false;
  return nowMs - site.updatedAt <= HEARTBEAT_STALE_MS * 4 || site.updatedAt > 0;
}

export function defaultWsUrlForSite(siteId: SiteId, siteDoc?: StoredSiteDoc): string {
  if (siteDoc?.wsUrl && !siteDoc.wsUrl.includes('localhost')) return siteDoc.wsUrl;
  const configuredUrls = parseSiteUrlsMap();
  const fromUrlsJson = resolveSiteHttpBaseUrl(siteId, configuredUrls);
  if (fromUrlsJson) return httpUrlToWsUrl(fromUrlsJson);
  if (siteDoc?.wsUrl) return siteDoc.wsUrl;
  const envKey = `SITE_WS_URL_${siteId.replace('-', '_').toUpperCase()}`;
  const fromEnv = process.env[envKey];
  if (fromEnv) return fromEnv;
  const basePattern = process.env.SITE_WS_URL_TEMPLATE;
  if (basePattern) return basePattern.replace('{siteId}', siteId);
  return `ws://localhost:8080/ws?site=${siteId}`;
}

function orderedPoolSiteIds(sites: StoredSiteDoc[], maxWarehouses?: number): SiteId[] {
  const limit = maxWarehouses ?? ALL_POOL_SITE_IDS.length;
  const pool = ALL_POOL_SITE_IDS.slice(0, limit);
  const seen = new Set<SiteId>(pool);
  const result: SiteId[] = [...pool];
  for (const s of sites) {
    if (!seen.has(s.id) && (maxWarehouses === undefined || result.length < maxWarehouses)) {
      seen.add(s.id);
      result.push(s.id);
    }
  }
  return result;
}

/**
 * Mode-aware 4-step shard placement algorithm:
 * - For Free Range (`mode === 'freerange'`), soft cap is `FREE_RANGE_SOFT_CAP` (26) and hard cap is `FREE_RANGE_HARD_CAP` (30).
 *   When a shard reaches >= 26 drivers, new Free Range joins route to the warmest shard with < 26 drivers (or wake a break site)
 *   so 4–6 slots remain reserved for 5-Minute Blitz drop-ins.
 * - For 5-Minute Blitz (`mode === 'blitz'` or default), auto-placement prefers shards < 30 drivers (`FREE_RANGE_HARD_CAP`)
 *   and allows up to `MAX_DRIVERS_PER_SITE` (32).
 */
export async function selectSiteForJoin(
  sites: StoredSiteDoc[],
  preferredSite: SiteId | undefined,
  nowMs: number,
  onWakeSite?: (siteId: SiteId) => Promise<void>,
  mode?: RunMode,
  maxWarehouses?: number,
): Promise<PlacementResult | null> {
  if (sites.length === 0) {
    const defaultSite: SiteId = preferredSite ?? 'den-1';
    return {
      siteId: defaultSite,
      wsUrl: defaultWsUrlForSite(defaultSite),
      role: 'driver',
      wokeBreakSite: false,
    };
  }

  const candidateIds = orderedPoolSiteIds(sites, maxWarehouses);
  const byId = new Map<SiteId, StoredSiteDoc>();
  for (const s of sites) {
    byId.set(s.id, s);
  }

  const isFreeRange = mode === 'freerange';
  const softCap = isFreeRange ? FREE_RANGE_SOFT_CAP : FREE_RANGE_HARD_CAP;
  const hardCap = isFreeRange ? FREE_RANGE_HARD_CAP : MAX_DRIVERS_PER_SITE;
  const preferredCap = isFreeRange ? FREE_RANGE_SOFT_CAP : MAX_DRIVERS_PER_SITE;

  // Step 1: preferredSite if live and drivers < preferredCap
  if (preferredSite && candidateIds.includes(preferredSite)) {
    const pref = byId.get(preferredSite);
    if (pref && isFreshLiveSite(pref, nowMs) && pref.drivers < preferredCap) {
      return {
        siteId: pref.id,
        wsUrl: defaultWsUrlForSite(pref.id, pref),
        role: 'driver',
        wokeBreakSite: false,
      };
    }
  }

  // Step 2: Live site with the MOST active human drivers below softCap (0 < drivers < softCap)
  const populatedLiveOpen: StoredSiteDoc[] = [];
  for (const id of candidateIds) {
    const s = byId.get(id);
    if (s && isFreshLiveSite(s, nowMs) && s.drivers > 0 && s.drivers < softCap) {
      populatedLiveOpen.push(s);
    }
  }
  if (populatedLiveOpen.length > 0) {
    populatedLiveOpen.sort((a, b) => {
      if (b.drivers !== a.drivers) return b.drivers - a.drivers;
      return candidateIds.indexOf(a.id) - candidateIds.indexOf(b.id);
    });
    const chosen = populatedLiveOpen[0];
    return {
      siteId: chosen.id,
      wsUrl: defaultWsUrlForSite(chosen.id, chosen),
      role: 'driver',
      wokeBreakSite: false,
    };
  }

  // Step 3a: First empty live site (drivers === 0) in pool order
  for (const id of candidateIds) {
    const s = byId.get(id);
    if (s && isFreshLiveSite(s, nowMs) && s.drivers === 0) {
      return {
        siteId: s.id,
        wsUrl: defaultWsUrlForSite(s.id, s),
        role: 'driver',
        wokeBreakSite: false,
      };
    }
  }

  // Step 3b: Wake a sleeping / break site if needed
  const breakOrder: SiteId[] =
    preferredSite && candidateIds.includes(preferredSite)
      ? [preferredSite, ...candidateIds.filter((id) => id !== preferredSite)]
      : [...candidateIds];
  for (const id of breakOrder) {
    const s = byId.get(id);
    if (s && isWakingCandidateBreakSite(s, nowMs) && s.drivers < softCap) {
      if (onWakeSite) {
        await onWakeSite(s.id);
      }
      return {
        siteId: s.id,
        wsUrl: defaultWsUrlForSite(s.id, s),
        role: 'driver',
        wokeBreakSite: true,
      };
    }
  }

  // Step 3c: Fallback to any live site below hardCap if all sites are >= softCap and no break site could be woken
  if (preferredSite && candidateIds.includes(preferredSite)) {
    const pref = byId.get(preferredSite);
    if (pref && isFreshLiveSite(pref, nowMs) && pref.drivers < hardCap) {
      return {
        siteId: pref.id,
        wsUrl: defaultWsUrlForSite(pref.id, pref),
        role: 'driver',
        wokeBreakSite: false,
      };
    }
  }
  const hardCapLiveOpen: StoredSiteDoc[] = [];
  for (const id of candidateIds) {
    const s = byId.get(id);
    if (s && isFreshLiveSite(s, nowMs) && s.drivers < hardCap) {
      hardCapLiveOpen.push(s);
    }
  }
  if (hardCapLiveOpen.length > 0) {
    hardCapLiveOpen.sort((a, b) => {
      if (b.drivers !== a.drivers) return b.drivers - a.drivers;
      return candidateIds.indexOf(a.id) - candidateIds.indexOf(b.id);
    });
    const chosen = hardCapLiveOpen[0];
    return {
      siteId: chosen.id,
      wsUrl: defaultWsUrlForSite(chosen.id, chosen),
      role: 'driver',
      wokeBreakSite: false,
    };
  }

  // Step 4: Spectator on preferredSite (if live) or fullest live site when all live sites are at cap
  if (preferredSite && candidateIds.includes(preferredSite)) {
    const pref = byId.get(preferredSite);
    if (pref && isFreshLiveSite(pref, nowMs)) {
      return {
        siteId: pref.id,
        wsUrl: defaultWsUrlForSite(pref.id, pref),
        role: 'spectator',
        wokeBreakSite: false,
      };
    }
  }

  const allLive: StoredSiteDoc[] = [];
  for (const id of candidateIds) {
    const s = byId.get(id);
    if (s && isFreshLiveSite(s, nowMs)) {
      allLive.push(s);
    }
  }
  if (allLive.length > 0) {
    allLive.sort((a, b) => {
      if (b.drivers !== a.drivers) return b.drivers - a.drivers;
      return candidateIds.indexOf(a.id) - candidateIds.indexOf(b.id);
    });
    const fullest = allLive[0];
    return {
      siteId: fullest.id,
      wsUrl: defaultWsUrlForSite(fullest.id, fullest),
      role: 'spectator',
      wokeBreakSite: false,
    };
  }

  return null;
}

export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; lastRefillMs: number }>();
  private lastSweepMs = 0;
  /** A bucket idle this long has fully refilled, so forgetting it is lossless. */
  private readonly idleTtlMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
    private readonly maxEntries: number = 50_000,
    private readonly sweepIntervalMs: number = 60_000,
  ) {
    this.idleTtlMs = Math.max(1_000, Math.ceil(capacity / Math.max(refillPerMs, 1e-9)));
  }

  get size(): number {
    return this.buckets.size;
  }

  /** Evicts buckets idle past the full-refill TTL; enforces a hard cap by evicting oldest first. */
  sweep(nowMs: number): void {
    this.lastSweepMs = nowMs;
    for (const [key, b] of this.buckets) {
      if (nowMs - b.lastRefillMs >= this.idleTtlMs) this.buckets.delete(key);
    }
    if (this.buckets.size > this.maxEntries) {
      // Map iteration is insertion order; re-inserted keys (below) move to the tail.
      const excess = this.buckets.size - this.maxEntries;
      let i = 0;
      for (const key of this.buckets.keys()) {
        if (i++ >= excess) break;
        this.buckets.delete(key);
      }
    }
  }

  allow(ip: string, nowMs: number): boolean {
    if (nowMs - this.lastSweepMs >= this.sweepIntervalMs || this.buckets.size > this.maxEntries) {
      this.sweep(nowMs);
    }
    const existing = this.buckets.get(ip);
    if (!existing) {
      this.buckets.set(ip, { tokens: this.capacity - 1, lastRefillMs: nowMs });
      return true;
    }
    this.buckets.delete(ip);
    this.buckets.set(ip, existing);
    const elapsed = Math.max(0, nowMs - existing.lastRefillMs);
    const refilled = Math.min(this.capacity, existing.tokens + elapsed * this.refillPerMs);
    if (refilled < 1) {
      existing.tokens = refilled;
      existing.lastRefillMs = nowMs;
      return false;
    }
    existing.tokens = refilled - 1;
    existing.lastRefillMs = nowMs;
    return true;
  }
}

let cachedSecret: string | null = null;
let devProcessSecret: string | null = null;

export async function resolveTicketSecret(explicitSecret?: string): Promise<string> {
  if (explicitSecret) return explicitSecret;
  if (process.env.TICKET_HMAC_SECRET) return process.env.TICKET_HMAC_SECRET;
  if (process.env.TICKET_HMAC_KEY) return process.env.TICKET_HMAC_KEY;
  if (process.env.TICKET_SECRET) return process.env.TICKET_SECRET;
  if (cachedSecret) return cachedSecret;

  const secretName = process.env.TICKET_HMAC_SECRET_NAME;
  if (secretName) {
    const client = new SecretManagerServiceClient();
    const [version] = await client.accessSecretVersion({ name: secretName });
    const payload = version.payload?.data
      ? Buffer.from(version.payload.data).toString('utf8').trim()
      : '';
    if (payload.length >= 16) {
      cachedSecret = payload;
      return payload;
    }
  }

  if (process.env.K_SERVICE) {
    throw new Error(
      'TICKET_HMAC_SECRET, TICKET_HMAC_SECRET_NAME, or TICKET_SECRET must be configured in Cloud Run',
    );
  }

  // Local dev only: random per-process secret (never a committed literal). Tickets and proxy
  // headers minted with it are only valid for this process; set TICKET_HMAC_SECRET to the same
  // value for the lobby and site shards to run them together (docs/operations.md).
  if (!devProcessSecret) {
    devProcessSecret = randomBytes(32).toString('base64url');
    console.warn(
      '[lobby] TICKET_HMAC_SECRET is unset; using a random per-process dev secret. ' +
        'Set TICKET_HMAC_SECRET for both lobby and site to connect them locally.',
    );
  }
  return devProcessSecret;
}

const LobbyQueueStatusSchema = QueueStatusSchema.extend({
  state: z.enum(['none', 'queued', 'ready', 'claimed', 'expired']),
  assignedSiteId: SiteIdSchema.optional(),
  leaseExpiresAt: z.number().int().nonnegative().optional(),
});
type LobbyQueueStatus = z.infer<typeof LobbyQueueStatusSchema>;

const ExtendedJoinRequestSchema = JoinRequestSchema.extend({
  preferredSite: SiteIdSchema.optional(),
  runMode: z.enum(['blitz', 'freerange']).optional(),
});

const ExtendedJoinResponseSchema = JoinResponseSchema.extend({
  role: z.enum(['driver', 'spectator']),
  isBot: z.boolean(),
  queue: LobbyQueueStatusSchema.optional(),
  /**
   * Secret resume code for this player (`wr1_` + 32 base64url chars). Humans only. Send it back as
   * `resume` on POST /api/join from another browser to restore this identity. Treat it like a
   * password: it is never shown on leaderboards or sent to other players.
   */
  resumeToken: z.string().regex(/^wr1_[A-Za-z0-9_-]{32}$/).optional(),
  /** The caller's own opaque public id (matches its `/api/network` leaderboard row). */
  publicId: z.string().regex(PUBLIC_ID_PATTERN).optional(),
});

/**
 * Public leaderboard row: `clientId` carries the opaque publicId (never the raw clientId) so the
 * existing protocol schema (`clientId` required) still validates; `publicId` is the explicit field.
 */
const PublicLeaderboardEntrySchema = LeaderboardEntrySchema.extend({
  publicId: z.string().regex(PUBLIC_ID_PATTERN),
});
const PublicNetworkResponseSchema = NetworkResponseSchema.extend({
  leaderboard: z.array(PublicLeaderboardEntrySchema),
});

const QueueClaimRequestSchema = z.object({
  clientId: JoinRequestSchema.shape.clientId,
  seatLeaseId: z.string().min(4).max(96),
  name: z.string().optional(),
});

const QueueLeaveRequestSchema = z.object({
  clientId: JoinRequestSchema.shape.clientId,
});

export interface LobbyServerOptions {
  store?: LobbyStore;
  ticketSecret?: string;
  now?: () => number;
  armorClient?: ModelArmorClient;
  rateLimitPerMin?: number;
  staticDir?: string;
  maxWarehouses?: number;
  queueScaleThreshold?: number;
  seatClaimLeaseMs?: number;
  queueHeartbeatTtlMs?: number;
  overflowIdleCooldownMs?: number;
  /** Trusted reverse-proxy hops in front of the lobby (default `TRUSTED_PROXY_HOPS` or 1). */
  trustedProxyHops?: number;
}

export type LobbyOptions = LobbyServerOptions;

export async function buildLobbyServer(opts: LobbyServerOptions = {}): Promise<FastifyInstance> {
  // Trust exactly the Cloud Run front-end hop: `req.ip` is the right-most X-Forwarded-For entry
  // (appended by Google's front end), never a client-supplied left-most value.
  const trustedProxyHops = opts.trustedProxyHops ?? resolveTrustedProxyHops();
  const app = Fastify({
    logger: false,
    // proxy-addr hop index: 0 = socket peer, 1 = right-most XFF entry, ...
    trustProxy: (_address: string, hop: number) => hop < trustedProxyHops,
  });
  const store = opts.store ?? new FirestoreLobbyStore();
  const nowFn = opts.now ?? (() => Date.now());
  const secret = await resolveTicketSecret(opts.ticketSecret);
  const envRateLimit = Number(process.env.RATE_LIMIT_PER_MIN);
  const rateLimitPerMin =
    opts.rateLimitPerMin ?? (Number.isFinite(envRateLimit) && envRateLimit > 0 ? envRateLimit : 30);
  const limiter = new TokenBucketRateLimiter(rateLimitPerMin, rateLimitPerMin / 60_000);

  const envMaxWarehouses = Number(process.env.MAX_WAREHOUSES);
  const rawMaxWarehouses =
    opts.maxWarehouses ??
    (Number.isFinite(envMaxWarehouses) && envMaxWarehouses >= 4
      ? envMaxWarehouses
      : DEFAULT_MAX_WAREHOUSES);
  const maxWarehouses = Math.min(16, Math.max(4, Math.floor(rawMaxWarehouses)));

  const envQueueScaleThreshold = Number(process.env.QUEUE_SCALE_THRESHOLD);
  const queueScaleThreshold = Math.max(
    1,
    Math.floor(
      opts.queueScaleThreshold ??
        (Number.isFinite(envQueueScaleThreshold) && envQueueScaleThreshold > 0
          ? envQueueScaleThreshold
          : DEFAULT_QUEUE_SCALE_THRESHOLD),
    ),
  );

  const envSeatClaimLeaseMs = Number(process.env.SEAT_CLAIM_LEASE_MS);
  const seatClaimLeaseMs = Math.max(
    1_000,
    Math.floor(
      opts.seatClaimLeaseMs ??
        (Number.isFinite(envSeatClaimLeaseMs) && envSeatClaimLeaseMs > 0
          ? envSeatClaimLeaseMs
          : DEFAULT_SEAT_CLAIM_LEASE_MS),
    ),
  );

  const envQueueHeartbeatTtlMs = Number(process.env.QUEUE_HEARTBEAT_TTL_MS);
  const queueHeartbeatTtlMs = Math.max(
    1_000,
    Math.floor(
      opts.queueHeartbeatTtlMs ??
        (Number.isFinite(envQueueHeartbeatTtlMs) && envQueueHeartbeatTtlMs > 0
          ? envQueueHeartbeatTtlMs
          : DEFAULT_QUEUE_HEARTBEAT_TTL_MS),
    ),
  );

  const envOverflowIdleCooldownMs = Number(process.env.OVERFLOW_IDLE_COOLDOWN_MS);
  const overflowIdleCooldownMs = Math.max(
    1_000,
    Math.floor(
      opts.overflowIdleCooldownMs ??
        (Number.isFinite(envOverflowIdleCooldownMs) && envOverflowIdleCooldownMs > 0
          ? envOverflowIdleCooldownMs
          : DEFAULT_OVERFLOW_IDLE_COOLDOWN_MS),
    ),
  );

  // Fallback in-memory queue map if a custom LobbyStore implementation does not provide queue methods
  const fallbackQueue = new Map<string, QueueEntry>();
  const emptyOverflowSince = new Map<SiteId, number>();

  async function getQueueEntries(): Promise<QueueEntry[]> {
    if (store.getQueueEntries) {
      return store.getQueueEntries();
    }
    return Array.from(fallbackQueue.values())
      .map((entry) => ({ ...entry }))
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt || a.clientId.localeCompare(b.clientId));
  }

  async function setQueueEntry(entry: QueueEntry): Promise<void> {
    if (store.setQueueEntry) {
      await store.setQueueEntry(entry);
      return;
    }
    fallbackQueue.set(entry.clientId, { ...entry });
  }

  async function deleteQueueEntry(clientId: string): Promise<void> {
    if (store.deleteQueueEntry) {
      await store.deleteQueueEntry(clientId);
      return;
    }
    fallbackQueue.delete(clientId);
  }

  /**
   * Atomic queue mutation: a Firestore transaction when the store supports it (serializes the
   * two lobby instances), otherwise a buffered snapshot serialized in-process by `withJoinLock`.
   */
  function queueTxn<T>(fn: (tx: QueueTxn) => Promise<T>): Promise<T> {
    if (store.runQueueTransaction) {
      return store.runQueueTransaction(fn);
    }
    return runBufferedQueueTxn(getQueueEntries, setQueueEntry, deleteQueueEntry, fn);
  }

  function reservedSeatsForSite(
    siteId: SiteId,
    entries: QueueEntry[],
    nowMs: number,
    countedDriverIds?: readonly string[],
  ): number {
    let count = 0;
    for (const entry of entries) {
      if (entry.assignedSiteId !== siteId) continue;
      const live = entry.leaseExpiresAt === undefined || entry.leaseExpiresAt > nowMs;
      if (!live) continue;
      if (entry.state === 'ready') {
        count += 1;
      } else if (
        entry.state === 'claimed' &&
        entry.leaseExpiresAt !== undefined &&
        !countedDriverIds?.includes(entry.clientId)
      ) {
        // Shared seat hold: admitted but not yet reflected in the site heartbeat.
        count += 1;
      }
    }
    return count;
  }

  function effectiveDriversForSite(
    site: StoredSiteDoc,
    entries: QueueEntry[],
    nowMs: number,
  ): number {
    return site.drivers + reservedSeatsForSite(site.id, entries, nowMs, site.driverClientIds);
  }

  function applyReservedSeats(
    sites: StoredSiteDoc[],
    entries: QueueEntry[],
    nowMs: number,
  ): StoredSiteDoc[] {
    return sites.map((s) => {
      const cap = s.maxDrivers ?? MAX_DRIVERS_PER_SITE;
      const eff = Math.min(cap, effectiveDriversForSite(s, entries, nowMs));
      return {
        ...s,
        drivers: eff,
      };
    });
  }

  function isExpiredQueueEntry(entry: QueueEntry, nowMs: number): boolean {
    const leaseExpired =
      entry.state === 'ready' &&
      entry.leaseExpiresAt !== undefined &&
      nowMs > entry.leaseExpiresAt;
    const pollExpired =
      entry.state === 'queued' && nowMs - entry.lastPolledAt > queueHeartbeatTtlMs;
    // `claimed` entries are shared seat holds; they live until the site heartbeat lists the
    // driver as connected (released in pruneExpiredQueueEntries) or their hold window lapses.
    const holdExpired =
      entry.state === 'claimed' &&
      (entry.leaseExpiresAt === undefined || nowMs > entry.leaseExpiresAt);
    const terminalState = entry.state === 'expired';
    return leaseExpired || pollExpired || holdExpired || terminalState;
  }

  async function pruneExpiredQueueEntries(nowMs: number): Promise<QueueEntry[]> {
    return queueTxn(async (tx) => {
      // Holds whose driver the site heartbeat already lists as connected are released at once;
      // only clients that never show up keep their hold for the full SEAT_HOLD_MS window.
      const hasHolds = tx.entries.some((e) => e.state === 'claimed' && e.assignedSiteId);
      const connectedBySite = new Map<SiteId, { ids: Set<string>; updatedAt: number }>();
      if (hasHolds) {
        for (const s of await store.getSites()) {
          connectedBySite.set(s.id, {
            ids: new Set(s.connectedDriverClientIds ?? s.driverClientIds ?? []),
            updatedAt: s.updatedAt,
          });
        }
      }
      const kept: QueueEntry[] = [];
      for (const entry of tx.entries) {
        const roster = entry.assignedSiteId ? connectedBySite.get(entry.assignedSiteId) : undefined;
        // Only a heartbeat written after the hold was granted proves this admission connected
        // (a lagging roster may still list the player's previous run on the same site).
        const heldSince =
          entry.leaseExpiresAt !== undefined ? entry.leaseExpiresAt - SEAT_HOLD_MS : Infinity;
        const holdConfirmed =
          entry.state === 'claimed' &&
          roster !== undefined &&
          roster.updatedAt >= heldSince &&
          roster.ids.has(entry.clientId);
        if (holdConfirmed || isExpiredQueueEntry(entry, nowMs)) {
          tx.delete(entry.clientId);
        } else {
          kept.push(entry);
        }
      }
      return kept;
    });
  }

  async function selectOpenSeatForQueuedPlayer(
    sites: StoredSiteDoc[],
    entries: QueueEntry[],
    entry: QueueEntry,
    nowMs: number,
  ): Promise<SiteId | null> {
    const effectiveSites = applyReservedSeats(sites, entries, nowMs);
    const placed = await selectSiteForJoin(
      effectiveSites,
      entry.preferredSite,
      nowMs,
      store.wakeSite ? (siteId) => store.wakeSite!(siteId, nowMs) : undefined,
      entry.mode,
      maxWarehouses,
    );
    if (placed && placed.role === 'driver') {
      return placed.siteId;
    }
    return null;
  }

  async function allocateAvailableSeats(nowMs: number): Promise<QueueEntry[]> {
    // One transaction per allocation pass: the queue snapshot (and therefore the reserved-seat
    // counts) and the `ready` leases written from it commit atomically across lobby instances.
    return queueTxn(async (tx) => {
      let sites = await store.getSites();
      recordInternalSiteUrls(sites);
      const entries = tx.entries;
      const queued = entries
        .filter((e) => e.state === 'queued')
        .sort((a, b) => a.enqueuedAt - b.enqueuedAt || a.clientId.localeCompare(b.clientId));

      for (const entry of queued) {
        const assignedSiteId = await selectOpenSeatForQueuedPlayer(sites, entries, entry, nowMs);
        if (!assignedSiteId) {
          break;
        }
        entry.state = 'ready';
        entry.assignedSiteId = assignedSiteId;
        entry.leaseExpiresAt = nowMs + seatClaimLeaseMs;
        entry.lastPolledAt = nowMs;
        tx.set(entry);
        sites = await store.getSites();
        recordInternalSiteUrls(sites);
      }

      return entries;
    });
  }

  async function maybeScaleWarehouses(nowMs: number): Promise<void> {
    await allocateAvailableSeats(nowMs);
    let sites = await store.getSites();
    recordInternalSiteUrls(sites);
    let entries = await getQueueEntries();

    const maxAllowedOverflow = OVERFLOW_POOL_SITE_IDS.slice(
      0,
      Math.max(0, maxWarehouses - BASE_SITE_IDS.length),
    );

    // Scale down idle overflow shards that have remained at 0 effective drivers past cooldown
    for (const site of sites) {
      if (!OVERFLOW_POOL_SITE_IDS.includes(site.id)) continue;
      if (isFreshLiveSite(site, nowMs)) {
        const eff = effectiveDriversForSite(site, entries, nowMs);
        if (eff === 0) {
          const since = emptyOverflowSince.get(site.id) ?? nowMs;
          emptyOverflowSince.set(site.id, since);
          if (nowMs - since >= overflowIdleCooldownMs && store instanceof InMemoryLobbyStore) {
            store.setSite({
              ...site,
              state: 'offline',
              drivers: 0,
              spectators: 0,
              updatedAt: 0,
            });
            emptyOverflowSince.delete(site.id);
          }
        } else {
          emptyOverflowSince.delete(site.id);
        }
      } else {
        emptyOverflowSince.delete(site.id);
      }
    }

    // Scale up overflow shards when queued players >= queueScaleThreshold and all current warehouses are full
    while (true) {
      const queuedCount = entries.filter((e) => e.state === 'queued').length;
      if (queuedCount < queueScaleThreshold) {
        break;
      }

      const byId = new Map<SiteId, StoredSiteDoc>();
      for (const s of sites) {
        byId.set(s.id, s);
      }

      const activeWarehouseCount = ALL_POOL_SITE_IDS.filter((id) => {
        const s = byId.get(id);
        return s !== undefined && isFreshLiveSite(s, nowMs);
      }).length;

      if (activeWarehouseCount >= maxWarehouses) {
        break;
      }

      const nextOverflowId = maxAllowedOverflow.find((id) => {
        const s = byId.get(id);
        return !s || !isFreshLiveSite(s, nowMs);
      });

      if (!nextOverflowId || !store.wakeSite) {
        break;
      }

      await store.wakeSite(nextOverflowId, nowMs);
      emptyOverflowSince.set(nextOverflowId, nowMs);
      entries = await allocateAvailableSeats(nowMs);
      sites = await store.getSites();
      recordInternalSiteUrls(sites);
    }
  }

  function countActiveLiveSites(sites: StoredSiteDoc[], nowMs: number): number {
    let count = 0;
    for (const s of sites) {
      if (isFreshLiveSite(s, nowMs)) {
        count += 1;
      }
    }
    return Math.max(1, count);
  }

  function buildQueueStatusForEntry(
    entry: QueueEntry,
    entries: QueueEntry[],
    activeSiteCount: number,
  ): LobbyQueueStatus {
    const queuedList = entries
      .filter((e) => e.state === 'queued')
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt || a.clientId.localeCompare(b.clientId));
    const totalQueued = queuedList.length;

    if (entry.state === 'ready' && entry.assignedSiteId) {
      return LobbyQueueStatusSchema.parse({
        state: 'ready',
        position: 0,
        totalQueued,
        estimatedWaitSec: 0,
        assignedSiteId: entry.assignedSiteId,
        claimSiteId: entry.assignedSiteId,
        seatLeaseId: entry.seatLeaseId,
        ...(entry.leaseExpiresAt !== undefined
          ? { leaseExpiresAt: entry.leaseExpiresAt, claimExpiresAt: entry.leaseExpiresAt }
          : {}),
      });
    }

    const idx = queuedList.findIndex((e) => e.clientId === entry.clientId);
    const position = idx >= 0 ? idx + 1 : totalQueued + 1;
    const estimatedWaitSec = Math.max(5, Math.ceil((position * 45) / Math.max(1, activeSiteCount)));
    return LobbyQueueStatusSchema.parse({
      state: 'queued',
      position,
      totalQueued: Math.max(totalQueued, position),
      estimatedWaitSec,
      seatLeaseId: entry.seatLeaseId,
    });
  }

  const internalSiteWsUrls = new Map<SiteId, string>();
  const initialConfigured = parseSiteUrlsMap();
  for (const id of ALL_POOL_SITE_IDS) {
    const resolvedUrl = resolveSiteHttpBaseUrl(id, initialConfigured);
    if (resolvedUrl) {
      internalSiteWsUrls.set(id, httpUrlToWsUrl(resolvedUrl));
    }
  }

  function recordInternalSiteUrls(sites: StoredSiteDoc[]): void {
    const configured = parseSiteUrlsMap();
    for (const s of sites) {
      const resolvedUrl = resolveSiteHttpBaseUrl(s.id, configured);
      if (resolvedUrl) {
        internalSiteWsUrls.set(s.id, httpUrlToWsUrl(resolvedUrl));
      } else if (s.wsUrl && !s.wsUrl.includes('/ws?site=')) {
        internalSiteWsUrls.set(s.id, httpUrlToWsUrl(s.wsUrl));
      }
    }
  }

  async function resolveInternalSiteWsUrl(siteId: SiteId): Promise<string | undefined> {
    const configured = resolveSiteHttpBaseUrl(siteId, parseSiteUrlsMap());
    if (configured) {
      const wsUrl = httpUrlToWsUrl(configured);
      internalSiteWsUrls.set(siteId, wsUrl);
      return wsUrl;
    }
    const cached = internalSiteWsUrls.get(siteId);
    if (cached) return cached;
    const sites = await store.getSites();
    recordInternalSiteUrls(sites);
    const direct = internalSiteWsUrls.get(siteId);
    if (direct) return direct;
    const baseSiteId = getCanonicalBaseSiteId(siteId);
    return internalSiteWsUrls.get(baseSiteId);
  }

  let joinLockChain = Promise.resolve();
  function withJoinLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = joinLockChain.then(fn, fn);
    joinLockChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Atomically consumes a `ready` seat lease. Exactly one caller (across lobby instances) can claim
   * a given lease; `totalQueued` comes from the same authoritative snapshot.
   */
  async function claimReadyLease(
    clientIds: string[],
    seatLeaseId: string,
    nowMs: number,
  ): Promise<{ entry: QueueEntry; siteId: SiteId; totalQueued: number } | null> {
    return queueTxn(async (tx) => {
      const entry = tx.entries.find(
        (e) => clientIds.includes(e.clientId) && e.seatLeaseId === seatLeaseId,
      );
      if (
        !entry ||
        entry.state !== 'ready' ||
        !entry.assignedSiteId ||
        (entry.leaseExpiresAt !== undefined && nowMs > entry.leaseExpiresAt)
      ) {
        return null;
      }
      // Convert the lease into a shared seat hold so the other lobby instance keeps counting this
      // seat until the site heartbeat lists the driver (or the hold window lapses).
      tx.set({ ...entry, state: 'claimed', leaseExpiresAt: nowMs + SEAT_HOLD_MS, lastPolledAt: nowMs });
      const totalQueued = tx.entries.filter(
        (e) => e.state === 'queued' && e.clientId !== entry.clientId,
      ).length;
      return { entry: { ...entry }, siteId: entry.assignedSiteId, totalQueued };
    });
  }

  /**
   * Direct driver admission, decided inside a queue transaction: re-checks against the
   * authoritative queue that nobody is waiting ahead and the site still has a free seat (heartbeat
   * drivers + shared leases/holds), then records a shared seat hold. Returns false if the seat was
   * taken concurrently, in which case the caller enqueues instead.
   */
  async function admitDirectDriver(
    site: StoredSiteDoc,
    hold: Omit<QueueEntry, 'state' | 'assignedSiteId' | 'leaseExpiresAt' | 'seatLeaseId'>,
    nowMs: number,
  ): Promise<boolean> {
    return queueTxn(async (tx) => {
      const others = tx.entries.filter((e) => e.clientId !== hold.clientId);
      if (others.some((e) => e.state === 'queued')) return false;
      const cap = site.maxDrivers ?? MAX_DRIVERS_PER_SITE;
      if (effectiveDriversForSite(site, others, nowMs) >= cap) return false;
      tx.set({
        ...hold,
        state: 'claimed',
        assignedSiteId: site.id,
        leaseExpiresAt: nowMs + SEAT_HOLD_MS,
        seatLeaseId: randomUUID(),
      });
      return true;
    });
  }

  /**
   * Heartbeat/mode update applied to the authoritative entry inside a transaction, so a stale
   * in-memory copy can never overwrite a concurrent `queued → ready` promotion.
   */
  async function touchQueueEntry(
    clientId: string,
    nowMs: number,
    patch: Partial<Pick<QueueEntry, 'mode'>> = {},
  ): Promise<QueueEntry | undefined> {
    return queueTxn(async (tx) => {
      const entry = tx.entries.find((e) => e.clientId === clientId);
      if (!entry || entry.state === 'claimed') return undefined;
      entry.lastPolledAt = nowMs;
      if (patch.mode !== undefined) entry.mode = patch.mode;
      tx.set(entry);
      return { ...entry };
    });
  }

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof QueueStoreUnavailableError) {
      console.error(`[lobby] ${err.message}`);
      return reply.code(503).send({
        error: 'queue_unavailable',
        message: 'The shared seat queue is temporarily unavailable. Please retry.',
      });
    }
    return reply.send(err);
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Content-Security-Policy', CSP_HEADER);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    return payload;
  });

  const lobbyHealth = async () => {
    return { ok: true, service: 'lobby' };
  };
  app.get('/healthz', lobbyHealth);
  // Google Front End intercepts the exact path `/healthz` on *.a.run.app; `/healthz/` reaches us.
  app.get('/healthz/', lobbyHealth);

  app.post('/api/join', async (req, reply) => {
    const nowMs = nowFn();
    const ip = req.ip || '127.0.0.1';
    if (!limiter.allow(ip, nowMs)) {
      return reply.code(429).send({
        error: 'rate_limited',
        message: 'Too many join requests from this IP. Please wait a moment.',
      });
    }

    const parsedBody = ExtendedJoinRequestSchema.safeParse(req.body);
    if (!parsedBody.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: parsedBody.error.issues[0]?.message ?? 'Invalid join request payload.',
      });
    }

    const {
      name: rawName,
      prefer,
      preferredSite: prefAlias,
      clientId,
      resume,
      mode: modeField,
      runMode: runModeField,
      requeue,
      seatLeaseId: requestedLeaseId,
      spectateOnly,
    } = parsedBody.data;
    const mode = runModeField ?? modeField;
    const preferredSite = prefAlias ?? prefer;

    // `resume` is either a secret resume code (`wr1_…`, minted by this lobby) or an existing callsign.
    // Callsign lookups are validated for display-name hygiene and prompt injection before querying the
    // store, and can only return an existing human player's callsign (never adding a new name).
    const resumeValue = typeof resume === 'string' ? resume.trim() : '';
    const resumeIsToken = resumeValue.length > 0 && isResumeTokenFormat(resumeValue);
    if (resumeValue.length > 0 && !resumeIsToken) {
      const resumeCheck = validateDisplayName(resumeValue);
      if (!resumeCheck.ok || inspectPromptLocally(resumeValue).flagged) {
        return reply.code(400).send({
          error: resumeCheck.ok ? 'invalid_name' : resumeCheck.code,
          message: resumeCheck.ok ? 'Invalid callsign lookup query.' : resumeCheck.message,
        });
      }
    }

    let isBot = false;
    let botName = '';
    let validatedHumanName = '';
    if (typeof rawName === 'string' && rawName.trim().length > 0) {
      const nameCheck = validateDisplayName(rawName, { allowBotPrefix: true });
      if (!nameCheck.ok) {
        return reply.code(400).send({
          error: nameCheck.code,
          message: nameCheck.message,
        });
      }

      // Screen display name with local RAI/XSS/injection filter + optional Model Armor client
      const localVerdict = inspectPromptLocally(nameCheck.name);
      if (localVerdict.flagged) {
        return reply.code(400).send({
          error: 'armor_blocked',
          message: 'Display name rejected by safety filter.',
        });
      }
      if (opts.armorClient) {
        const remoteVerdict = await opts.armorClient.sanitizeUserPrompt(nameCheck.name);
        if (remoteVerdict.flagged) {
          return reply.code(400).send({
            error: 'armor_blocked',
            message: 'Display name rejected by Model Armor safety filter.',
          });
        }
      }
      if (nameCheck.isBot) {
        isBot = true;
        botName = nameCheck.name;
      } else {
        validatedHumanName = nameCheck.name;
      }
    }

    const outcome = await withJoinLock(async () => {
      await pruneExpiredQueueEntries(nowMs);

      let resolvedClientId = clientId;
      let resolvedName = isBot ? botName : generateDriverCallsign(clientId);

      if (!isBot && store.resolvePlayerIdentity) {
        const identity = await store.resolvePlayerIdentity({
          clientId,
          ...(resumeIsToken ? { resumeTokenHash: hashResumeToken(resumeValue) } : {}),
          ...(resumeValue && !resumeIsToken ? { resumeCallsign: resumeValue } : {}),
          resumeTokenHashFor: (id) => hashResumeToken(resumeTokenFor(id, secret)),
          siteId: preferredSite,
          nowMs,
        });
        if (!identity.ok) {
          return {
            ok: false as const,
            status: 404 as const,
            error: identity.error,
            message: identity.message,
          };
        }
        // Defense in depth: the code must be the HMAC of the clientId it resolved to.
        if (resumeIsToken && !verifyResumeToken(resumeValue, identity.clientId, secret)) {
          return {
            ok: false as const,
            status: 404 as const,
            error: INVALID_RESUME_ERROR,
            message: INVALID_RESUME_MESSAGE,
          };
        }
        resolvedClientId = identity.clientId;
        const runSuffixMatch =
          !resumeValue &&
          validatedHumanName &&
          validatedHumanName.toLowerCase().startsWith(`${identity.name.toLowerCase()} run `)
            ? validatedHumanName.slice(identity.name.length)
            : '';
        resolvedName = runSuffixMatch ? `${identity.name}${runSuffixMatch}` : identity.name;
      }

      // Case 1: Explicit seatLeaseId claim via POST /api/join
      if (requestedLeaseId) {
        const claimed = await claimReadyLease(
          [resolvedClientId, clientId],
          requestedLeaseId,
          nowMs,
        );
        if (!claimed) {
          return {
            ok: false as const,
            status: 410 as const,
            error: 'lease_expired',
            message: 'Seat reservation lease has expired or is invalid.',
          };
        }
        const { entry, totalQueued } = claimed;
        const assignedSiteId = claimed.siteId;
        if (store.recordAssignment) {
          store.recordAssignment(assignedSiteId, resolvedClientId, 'driver', nowMs);
        }
        return {
          ok: true as const,
          placement: {
            siteId: assignedSiteId,
            wsUrl: defaultWsUrlForSite(assignedSiteId),
            role: 'driver' as const,
            wokeBreakSite: false,
          },
          resolvedClientId,
          resolvedName,
          seatLeaseId: entry.seatLeaseId,
          effectiveMode: mode ?? entry.mode,
          queueStatus: LobbyQueueStatusSchema.parse({
            state: 'claimed',
            position: 0,
            totalQueued,
            estimatedWaitSec: 0,
            assignedSiteId,
            claimSiteId: assignedSiteId,
            seatLeaseId: entry.seatLeaseId,
          }),
        };
      }

      const sites = await store.getSites();
      recordInternalSiteUrls(sites);

      // Case 2: Explicit spectateOnly request (bypass driver placement & queue)
      if (spectateOnly) {
        const candidateIds = orderedPoolSiteIds(sites, maxWarehouses);
        const byId = new Map<SiteId, StoredSiteDoc>();
        for (const s of sites) {
          byId.set(s.id, s);
        }
        let chosenSiteId: SiteId | undefined;
        if (preferredSite && candidateIds.includes(preferredSite)) {
          const pref = byId.get(preferredSite);
          if (pref && isFreshLiveSite(pref, nowMs)) {
            chosenSiteId = pref.id;
          }
        }
        if (!chosenSiteId) {
          const liveSites = candidateIds
            .map((id) => byId.get(id))
            .filter((s): s is StoredSiteDoc => s !== undefined && isFreshLiveSite(s, nowMs))
            .sort((a, b) => b.drivers - a.drivers);
          chosenSiteId = liveSites[0]?.id ?? (sites.length === 0 ? (preferredSite ?? 'den-1') : undefined);
        }
        if (!chosenSiteId) {
          return {
            ok: false as const,
            status: 503 as const,
            error: 'no_sites_available',
            message: 'No live warehouse sites are currently reachable.',
          };
        }
        if (store.recordAssignment) {
          store.recordAssignment(chosenSiteId, resolvedClientId, 'spectator', nowMs);
        }
        return {
          ok: true as const,
          placement: {
            siteId: chosenSiteId,
            wsUrl: defaultWsUrlForSite(chosenSiteId, byId.get(chosenSiteId)),
            role: 'spectator' as const,
            wokeBreakSite: false,
          },
          resolvedClientId,
          resolvedName,
          seatLeaseId: undefined,
          effectiveMode: mode,
          queueStatus: undefined,
        };
      }

      // Case 3: Normal join or requeue after eviction
      if (requeue) {
        await queueTxn(async (tx) => {
          tx.delete(resolvedClientId);
          if (resolvedClientId !== clientId) {
            tx.delete(clientId);
          }
        });
      }

      await maybeScaleWarehouses(nowMs);
      const currentEntries = await allocateAvailableSeats(nowMs);
      const refreshedSites = await store.getSites();
      recordInternalSiteUrls(refreshedSites);

      // If this client already holds a queue entry (and did not pass requeue: true), return their status
      let existingEntry = currentEntries.find(
        (e) => e.clientId === resolvedClientId && e.state !== 'claimed',
      );
      if (existingEntry && !requeue) {
        existingEntry = await touchQueueEntry(
          resolvedClientId,
          nowMs,
          mode !== undefined ? { mode } : {},
        );
        if (existingEntry && existingEntry.state === 'ready' && existingEntry.assignedSiteId) {
          const qStatus = buildQueueStatusForEntry(
            existingEntry,
            currentEntries,
            countActiveLiveSites(refreshedSites, nowMs),
          );
          return {
            ok: true as const,
            placement: {
              siteId: existingEntry.assignedSiteId,
              wsUrl: defaultWsUrlForSite(existingEntry.assignedSiteId),
              role: 'spectator' as const,
              wokeBreakSite: false,
            },
            resolvedClientId,
            resolvedName,
            seatLeaseId: existingEntry.seatLeaseId,
            effectiveMode: existingEntry.mode,
            queueStatus: qStatus,
          };
        }
      }

      const effectiveMode = mode ?? existingEntry?.mode;
      const queuedAheadCount = currentEntries.filter(
        (e) => e.state === 'queued' && e.clientId !== resolvedClientId,
      ).length;
      const effectiveSites = applyReservedSeats(refreshedSites, currentEntries, nowMs);

      const placed = await selectSiteForJoin(
        effectiveSites,
        preferredSite,
        nowMs,
        store.wakeSite ? (siteId) => store.wakeSite!(siteId, nowMs) : undefined,
        effectiveMode,
        maxWarehouses,
      );
      if (!placed) {
        return {
          ok: false as const,
          status: 503 as const,
          error: 'no_sites_available',
          message: 'No live warehouse sites are currently reachable.',
        };
      }

      // Direct driver admission if a driver seat is open and no FIFO queue is waiting ahead.
      // Re-validated and recorded as a shared seat hold inside a queue transaction so the other
      // lobby instance cannot hand out the same seat before the site heartbeat catches up.
      if (placed.role === 'driver' && queuedAheadCount === 0) {
        const siteDoc: StoredSiteDoc = refreshedSites.find((s) => s.id === placed.siteId) ?? {
          id: placed.siteId,
          drivers: 0,
          spectators: 0,
          tier: 0,
          shipped: 0,
          updatedAt: nowMs,
        };
        const admitted = await admitDirectDriver(
          siteDoc,
          {
            clientId: resolvedClientId,
            name: resolvedName,
            isBot,
            preferredSite,
            mode: effectiveMode,
            enqueuedAt: nowMs,
            lastPolledAt: nowMs,
          },
          nowMs,
        );
        if (admitted) {
          if (store.recordAssignment) {
            store.recordAssignment(placed.siteId, resolvedClientId, 'driver', nowMs);
          }
          return {
            ok: true as const,
            placement: placed,
            resolvedClientId,
            resolvedName,
            seatLeaseId: undefined,
            effectiveMode,
            queueStatus: undefined,
          };
        }
      }

      // All active warehouses are at 32/32 capacity (or queue is ahead): enqueue player into FIFO queue
      const spectateSiteId = placed.siteId;
      // Enqueue atomically and derive position / totalQueued from the same authoritative snapshot.
      const { newEntry, initialQueueStatus } = await queueTxn(async (tx) => {
        const fresh = tx.entries.find(
          (e) => e.clientId === resolvedClientId && e.state !== 'claimed',
        );
        const entry: QueueEntry = fresh && !requeue
          ? {
              ...fresh,
              name: resolvedName,
              isBot,
              preferredSite,
              mode: effectiveMode,
              lastPolledAt: nowMs,
            }
          : {
              clientId: resolvedClientId,
              name: resolvedName,
              isBot,
              preferredSite,
              mode: effectiveMode,
              enqueuedAt: nowMs,
              lastPolledAt: nowMs,
              state: 'queued',
              seatLeaseId: randomUUID(),
            };
        tx.set(entry);
        const after = [...tx.entries.filter((e) => e.clientId !== entry.clientId), entry];
        return {
          newEntry: entry,
          initialQueueStatus: buildQueueStatusForEntry(
            entry,
            after,
            countActiveLiveSites(refreshedSites, nowMs),
          ),
        };
      });

      // Trigger auto-scaler after enqueue in case this arrival reached queueScaleThreshold
      await maybeScaleWarehouses(nowMs);

      if (store.recordAssignment) {
        store.recordAssignment(spectateSiteId, resolvedClientId, 'spectator', nowMs);
      }

      return {
        ok: true as const,
        placement: {
          siteId: spectateSiteId,
          wsUrl: placed.wsUrl,
          role: 'spectator' as const,
          wokeBreakSite: false,
        },
        resolvedClientId,
        resolvedName,
        seatLeaseId: newEntry.seatLeaseId,
        effectiveMode,
        queueStatus: initialQueueStatus,
      };
    });

    if (!outcome.ok) {
      return reply.code(outcome.status).send({
        error: outcome.error,
        message: outcome.message,
      });
    }

    const { placement, resolvedClientId, resolvedName, seatLeaseId, effectiveMode, queueStatus } = outcome;
    const expiresAt = nowMs + TICKET_TTL_MS;
    const ticket = signTicket(
      {
        clientId: resolvedClientId,
        name: resolvedName,
        siteId: placement.siteId,
        isBot,
        role: placement.role,
        jti: randomUUID(),
        ...(seatLeaseId ? { seatLeaseId } : {}),
        exp: expiresAt,
        ...(effectiveMode ? { runMode: effectiveMode } : {}),
      },
      secret,
    );

    const responsePayload = ExtendedJoinResponseSchema.parse({
      siteId: placement.siteId,
      wsUrl: publicLobbyWsUrl(req, placement.siteId),
      ticket,
      expiresAt,
      role: placement.role,
      isBot,
      name: resolvedName,
      clientId: resolvedClientId,
      publicId: publicIdFor(resolvedClientId, secret),
      ...(queueStatus ? { queue: queueStatus } : {}),
      ...(!isBot && store.resolvePlayerIdentity
        ? { resumeToken: resumeTokenFor(resolvedClientId, secret) }
        : {}),
    });

    return reply.code(200).send(responsePayload);
  });

  app.get<{ Querystring: { clientId?: string } }>('/api/queue/status', async (req, reply) => {
    const nowMs = nowFn();
    const parsedClient = JoinRequestSchema.shape.clientId.safeParse(req.query?.clientId);
    if (!parsedClient.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: 'Valid clientId query parameter is required.',
      });
    }
    const clientId = parsedClient.data;

    const statusPayload = await withJoinLock(async () => {
      // Heartbeat first (transactional) so a live poller is never pruned as stale.
      await queueTxn(async (tx) => {
        const existing = tx.entries.find((e) => e.clientId === clientId);
        if (existing && existing.state === 'queued') {
          existing.lastPolledAt = nowMs;
          tx.set(existing);
        }
      });

      await pruneExpiredQueueEntries(nowMs);
      await maybeScaleWarehouses(nowMs);
      const entries = await allocateAvailableSeats(nowMs);
      const sites = await store.getSites();
      recordInternalSiteUrls(sites);

      const entry = entries.find((e) => e.clientId === clientId && e.state !== 'claimed');
      if (!entry) {
        const totalQueued = entries.filter((e) => e.state === 'queued').length;
        return LobbyQueueStatusSchema.parse({
          state: 'expired',
          position: 0,
          totalQueued,
          estimatedWaitSec: 0,
        });
      }

      const touched = (await touchQueueEntry(clientId, nowMs)) ?? entry;

      return buildQueueStatusForEntry(touched, entries, countActiveLiveSites(sites, nowMs));
    });

    return reply.code(200).send(statusPayload);
  });

  app.post('/api/queue/claim', async (req, reply) => {
    const nowMs = nowFn();
    const parsedBody = QueueClaimRequestSchema.safeParse(req.body);
    if (!parsedBody.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: parsedBody.error.issues[0]?.message ?? 'Invalid queue claim payload.',
      });
    }
    const { clientId, seatLeaseId } = parsedBody.data;

    const outcome = await withJoinLock(async () => {
      await pruneExpiredQueueEntries(nowMs);
      const claimed = await claimReadyLease([clientId], seatLeaseId, nowMs);
      if (!claimed) {
        return {
          ok: false as const,
          status: 410 as const,
          error: 'lease_expired',
          message: 'Seat reservation lease has expired or is invalid.',
        };
      }

      if (store.recordAssignment) {
        store.recordAssignment(claimed.siteId, claimed.entry.clientId, 'driver', nowMs);
      }

      return {
        ok: true as const,
        entry: claimed.entry,
        siteId: claimed.siteId,
        totalQueued: claimed.totalQueued,
      };
    });

    if (!outcome.ok) {
      return reply.code(outcome.status).send({
        error: outcome.error,
        message: outcome.message,
      });
    }

    const { entry, siteId, totalQueued } = outcome;
    const expiresAt = nowMs + TICKET_TTL_MS;
    const ticket = signTicket(
      {
        clientId: entry.clientId,
        name: entry.name,
        siteId,
        isBot: entry.isBot,
        role: 'driver',
        jti: randomUUID(),
        seatLeaseId: entry.seatLeaseId,
        exp: expiresAt,
        ...(entry.mode ? { runMode: entry.mode } : {}),
      },
      secret,
    );

    const responsePayload = ExtendedJoinResponseSchema.parse({
      siteId,
      wsUrl: publicLobbyWsUrl(req, siteId),
      ticket,
      expiresAt,
      role: 'driver',
      isBot: entry.isBot,
      name: entry.name,
      clientId: entry.clientId,
      queue: {
        state: 'claimed',
        position: 0,
        totalQueued,
        estimatedWaitSec: 0,
        assignedSiteId: siteId,
        claimSiteId: siteId,
        seatLeaseId: entry.seatLeaseId,
      },
    });

    return reply.code(200).send(responsePayload);
  });

  app.post('/api/queue/leave', async (req, reply) => {
    const nowMs = nowFn();
    const parsedBody = QueueLeaveRequestSchema.safeParse(req.body);
    if (!parsedBody.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: parsedBody.error.issues[0]?.message ?? 'Invalid queue leave payload.',
      });
    }
    const { clientId } = parsedBody.data;

    await withJoinLock(async () => {
      await queueTxn(async (tx) => {
        tx.delete(clientId);
      });
      await pruneExpiredQueueEntries(nowMs);
      await allocateAvailableSeats(nowMs);
    });

    return reply.code(200).send({ ok: true });
  });

  app.get('/api/callsigns', async (req, reply) => {
    const queryObj = (req.query ?? {}) as Record<string, unknown>;
    const rawQ = typeof queryObj.q === 'string' ? queryObj.q.trim().slice(0, 24) : '';
    if (rawQ && inspectPromptLocally(rawQ).flagged) {
      return reply.code(200).send({ callsigns: [] });
    }
    const callsigns = store.listCallsigns ? await store.listCallsigns(rawQ, 20) : [];
    return reply.code(200).send({ callsigns });
  });

  app.get('/api/network', async (req, reply) => {
    const nowMs = nowFn();
    await withJoinLock(async () => {
      await pruneExpiredQueueEntries(nowMs);
    });
    const [storedSites, topPlayers, queueEntries] = await Promise.all([
      store.getSites(),
      store.getTopPlayers(10),
      getQueueEntries(),
    ]);
    recordInternalSiteUrls(storedSites);

    const byId = new Map<SiteId, StoredSiteDoc>();
    for (const s of storedSites) {
      byId.set(s.id, s);
    }

    const visibleSiteIds: SiteId[] = [...BASE_SITE_IDS];
    for (const overflowId of OVERFLOW_POOL_SITE_IDS.slice(
      0,
      Math.max(0, maxWarehouses - BASE_SITE_IDS.length),
    )) {
      const s = byId.get(overflowId);
      if (s && nowMs - s.updatedAt <= HEARTBEAT_STALE_MS && s.state !== 'offline') {
        visibleSiteIds.push(overflowId);
      }
    }

    const sites: SiteStatus[] = visibleSiteIds.map((id) => {
      const s = byId.get(id);
      const gatewayWsUrl = publicLobbyWsUrl(req, id);
      if (!s) {
        return {
          id,
          state: 'offline',
          drivers: 0,
          spectators: 0,
          tier: 0,
          shipped: 0,
          phase: 'running',
          wsUrl: gatewayWsUrl,
          maxDrivers: MAX_DRIVERS_PER_SITE,
          updatedAt: 0,
        };
      }

      const fresh = nowMs - s.updatedAt <= HEARTBEAT_STALE_MS;
      let state: SiteStatus['state'] = 'offline';
      let phase: Phase = normalizePhase(s.phase);

      if (isBreakSite(s) && (fresh || s.updatedAt > 0)) {
        state = 'break';
        phase = 'break';
      } else if (fresh && s.state !== 'offline') {
        state = s.state === 'live' ? 'live' : 'online';
      } else {
        state = 'offline';
      }

      return {
        id,
        state,
        drivers: state === 'offline' ? 0 : s.drivers,
        spectators: state === 'offline' ? 0 : s.spectators,
        tier: s.tier,
        shipped: s.shipped,
        phase,
        wsUrl: gatewayWsUrl,
        maxDrivers: s.maxDrivers ?? MAX_DRIVERS_PER_SITE,
        updatedAt: s.updatedAt,
      };
    });

    const leaderboard: Array<LeaderboardEntry & { publicId: string }> = topPlayers
      .filter((p) => !p.isBot && !isReservedBotPrefix(p.name))
      .slice(0, 10)
      .map((p) => {
        const publicId = publicIdFor(p.clientId, secret);
        return {
          // Never expose the raw clientId (a bearer secret for queue claims / own-identity joins).
          clientId: publicId,
          publicId,
          name: p.name,
          siteId: p.siteId,
          points: p.points ?? p.lifetimePoints ?? 0,
          lifetimePoints: p.lifetimePoints ?? p.points ?? 0,
          ...(p.bestBlitzPts !== undefined ? { bestBlitzPts: p.bestBlitzPts } : {}),
          ...(normalizePpm(p.ppm) !== undefined ? { ppm: normalizePpm(p.ppm) } : {}),
          deliveries: p.deliveries,
          isBot: false,
        };
      });

    const queueSize = queueEntries.filter((e) => e.state === 'queued').length;
    const activeOrBaseCount = Math.max(
      BASE_SITE_IDS.length,
      sites.filter((s) => s.state !== 'offline').length,
    );
    const maxTotalDrivers = activeOrBaseCount * MAX_DRIVERS_PER_SITE;

    const payload = PublicNetworkResponseSchema.parse({
      sites,
      leaderboard,
      queueSize,
      maxTotalDrivers,
      maxWarehouses,
    });
    return reply.code(200).send(payload);
  });

  // Internal/dev gateway proxy routes for site inspection & wake/transfer (blocked externally in Cloud Run without proxy auth)
  const siteHealthProxy = async (
    req: { params: { siteId: string } },
    reply: FastifyReply,
  ) => {
    const parsedSite = SiteIdSchema.safeParse(req.params.siteId);
    if (!parsedSite.success) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const siteId = parsedSite.data;
    const internalWsUrl = await resolveInternalSiteWsUrl(siteId);
    if (!internalWsUrl) {
      return reply.code(502).send({ error: 'bad_gateway', message: `Unknown site ${siteId}` });
    }
    const baseHttpUrl = wsUrlToInternalHttpUrl(internalWsUrl);
    const targetUrl = `${baseHttpUrl}/healthz`;
    const headers = await buildInternalBackendHeaders(siteId, targetUrl, secret, nowFn());
    const upstreamRes = await fetch(targetUrl, { method: 'GET', headers });
    const text = await upstreamRes.text();
    reply.code(upstreamRes.status);
    reply.header('content-type', upstreamRes.headers.get('content-type') || 'application/json');
    return reply.send(text);
  };
  app.get<{ Params: { siteId: string } }>('/sites/:siteId/healthz', siteHealthProxy);
  // Trailing-slash alias: GFE intercepts paths ending in `/healthz` on *.a.run.app.
  app.get<{ Params: { siteId: string } }>('/sites/:siteId/healthz/', siteHealthProxy);

  app.get<{ Params: { siteId: string; endpoint: string } }>(
    '/sites/:siteId/api/:endpoint',
    async (req, reply) => {
      const parsedSite = SiteIdSchema.safeParse(req.params.siteId);
      const endpoint = req.params.endpoint;
      if (!parsedSite.success || !['status', 'state', 'journal'].includes(endpoint)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const siteId = parsedSite.data;
      if (process.env.K_SERVICE) {
        const proxyCheck = verifyProxyHeader(
          req.headers[PROXY_HEADER_NAME] as string | undefined,
          siteId,
          secret,
          nowFn(),
        );
        if (!proxyCheck) {
          return reply.code(403).send({
            error: 'forbidden',
            message: 'Direct site diagnostics are restricted in production',
          });
        }
      }
      const internalWsUrl = await resolveInternalSiteWsUrl(siteId);
      if (!internalWsUrl) {
        return reply.code(502).send({ error: 'bad_gateway', message: `Unknown site ${siteId}` });
      }
      const baseHttpUrl = wsUrlToInternalHttpUrl(internalWsUrl);
      const qsIndex = req.url.indexOf('?');
      const qs = qsIndex >= 0 ? req.url.slice(qsIndex) : '';
      const targetUrl = `${baseHttpUrl}/api/${endpoint}${qs}`;
      const headers = await buildInternalBackendHeaders(siteId, targetUrl, secret, nowFn());
      const upstreamRes = await fetch(targetUrl, { method: 'GET', headers });
      const text = await upstreamRes.text();
      reply.code(upstreamRes.status);
      reply.header('content-type', upstreamRes.headers.get('content-type') || 'application/json');
      return reply.send(text);
    },
  );

  app.post<{ Params: { siteId: string; endpoint: string } }>(
    '/sites/:siteId/internal/:endpoint',
    async (req, reply) => {
      const parsedSite = SiteIdSchema.safeParse(req.params.siteId);
      const endpoint = req.params.endpoint;
      if (!parsedSite.success || !['wake', 'transfer'].includes(endpoint)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const siteId = parsedSite.data;
      if (process.env.K_SERVICE) {
        const proxyCheck = verifyProxyHeader(
          req.headers[PROXY_HEADER_NAME] as string | undefined,
          siteId,
          secret,
          nowFn(),
        );
        if (!proxyCheck) {
          return reply.code(403).send({
            error: 'forbidden',
            message: 'Internal site control routes are restricted in production',
          });
        }
      }
      const internalWsUrl = await resolveInternalSiteWsUrl(siteId);
      if (!internalWsUrl) {
        return reply.code(502).send({ error: 'bad_gateway', message: `Unknown site ${siteId}` });
      }
      if (endpoint === 'wake' && store.wakeSite) {
        await store.wakeSite(siteId, nowFn());
      }
      const baseHttpUrl = wsUrlToInternalHttpUrl(internalWsUrl);
      const targetUrl = `${baseHttpUrl}/internal/${endpoint}`;
      const headers = await buildInternalBackendHeaders(siteId, targetUrl, secret, nowFn(), {
        'content-type': 'application/json',
      });
      const upstreamRes = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(req.body ?? {}),
      });
      const text = await upstreamRes.text();
      reply.code(upstreamRes.status);
      reply.header('content-type', upstreamRes.headers.get('content-type') || 'application/json');
      return reply.send(text);
    },
  );

  // Authenticated WebSocket reverse proxy to isolated backend site engines
  // Client → lobby frames are capped at the site's MAX_WS_FRAME_BYTES (the site closes with 1009
  // on anything larger), so oversized frames are rejected here before being buffered or relayed.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_FRAME_BYTES });
  const activeProxyPairs = new Set<{ client: WebSocket; upstream: WebSocket }>();

  app.server.on('upgrade', (req, socket, head) => {
    void (async () => {
      try {
        const parsed = new URL(req.url ?? '/', 'http://localhost');
        let rawSiteId: string | null = null;
        const sitePathMatch = /^\/sites\/([^/]+)\/ws$/.exec(parsed.pathname);
        if (sitePathMatch) {
          rawSiteId = sitePathMatch[1];
        } else if (parsed.pathname === '/ws') {
          rawSiteId = parsed.searchParams.get('site');
          if (!rawSiteId) {
            const ticketParam = parsed.searchParams.get('ticket');
            if (ticketParam) {
              const verified = verifyTicket(ticketParam, secret, nowFn());
              if (verified.ok) {
                rawSiteId = verified.payload.siteId;
              }
            }
          }
          if (!rawSiteId) {
            rawSiteId = 'den-1';
          }
        } else {
          socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }

        const parsedSiteId = SiteIdSchema.safeParse(rawSiteId);
        if (!parsedSiteId.success) {
          socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        const siteId = parsedSiteId.data;

        const internalWsBase = await resolveInternalSiteWsUrl(siteId);
        if (!internalWsBase) {
          socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }

        const upstreamParsed = new URL(internalWsBase);
        const ticketParam = parsed.searchParams.get('ticket');
        if (ticketParam) {
          upstreamParsed.searchParams.set('ticket', ticketParam);
        }
        const upstreamWsUrl = upstreamParsed.toString();

        // Never forward the raw (client-influenced) X-Forwarded-For upstream. Send the lobby's own
        // resolution of the client IP, HMAC-bound to this request's x-warehouse-proxy token.
        const clientIp = resolveClientIp(
          req.headers['x-forwarded-for'],
          req.socket.remoteAddress,
          trustedProxyHops,
        );
        const proxyNowMs = nowFn();
        const proxyToken = signProxyHeader(siteId, secret, proxyNowMs);
        const upstreamHeaders = await buildInternalBackendHeaders(
          siteId,
          upstreamWsUrl,
          secret,
          proxyNowMs,
          {
            [PROXY_HEADER_NAME]: proxyToken,
            [CLIENT_IP_HEADER_NAME]: clientIp,
            [CLIENT_IP_SIG_HEADER_NAME]: signClientIp(clientIp, proxyToken, secret),
          },
        );

        wss.handleUpgrade(req, socket, head, (clientWs) => {
          const pendingClientMessages: Array<{ data: RawData; isBinary: boolean }> = [];
          const upstreamWs = new WebSocket(upstreamWsUrl, { headers: upstreamHeaders });
          const pair = { client: clientWs, upstream: upstreamWs };
          activeProxyPairs.add(pair);

          const safeCloseCode = (code: number): number =>
            code >= 1000 &&
            code <= 4999 &&
            code !== 1004 &&
            code !== 1005 &&
            code !== 1006 &&
            code !== 1015
              ? code
              : 1000;

          upstreamWs.on('open', () => {
            while (
              pendingClientMessages.length > 0 &&
              upstreamWs.readyState === WebSocket.OPEN
            ) {
              const msg = pendingClientMessages.shift()!;
              upstreamWs.send(msg.data, { binary: msg.isBinary });
            }
          });

          upstreamWs.on('message', (data, isBinary) => {
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(data, { binary: isBinary });
            }
          });

          upstreamWs.on('close', (code, reason) => {
            activeProxyPairs.delete(pair);
            if (
              clientWs.readyState === WebSocket.OPEN ||
              clientWs.readyState === WebSocket.CONNECTING
            ) {
              try {
                clientWs.close(safeCloseCode(code), reason.toString());
              } catch {
                clientWs.terminate();
              }
            }
          });

          upstreamWs.on('error', () => {
            activeProxyPairs.delete(pair);
            if (
              clientWs.readyState === WebSocket.OPEN ||
              clientWs.readyState === WebSocket.CONNECTING
            ) {
              try {
                clientWs.close(1011, 'Upstream site connection error');
              } catch {
                clientWs.terminate();
              }
            }
          });

          clientWs.on('message', (data, isBinary) => {
            if (upstreamWs.readyState === WebSocket.OPEN) {
              upstreamWs.send(data, { binary: isBinary });
            } else if (
              upstreamWs.readyState === WebSocket.CONNECTING &&
              pendingClientMessages.length < 32
            ) {
              pendingClientMessages.push({ data, isBinary });
            }
          });

          clientWs.on('close', (code, reason) => {
            activeProxyPairs.delete(pair);
            if (
              upstreamWs.readyState === WebSocket.OPEN ||
              upstreamWs.readyState === WebSocket.CONNECTING
            ) {
              try {
                upstreamWs.close(safeCloseCode(code), reason.toString());
              } catch {
                upstreamWs.terminate();
              }
            }
          });

          clientWs.on('error', () => {
            activeProxyPairs.delete(pair);
            try {
              upstreamWs.terminate();
            } catch {
              // ignore
            }
          });
        });
      } catch {
        try {
          socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        } catch {
          // ignore
        }
        socket.destroy();
      }
    })();
  });

  const cleanupProxySockets = async () => {
    for (const pair of activeProxyPairs) {
      try {
        pair.client.terminate();
      } catch {
        // ignore
      }
      try {
        pair.upstream.terminate();
      } catch {
        // ignore
      }
    }
    activeProxyPairs.clear();
  };

  app.addHook('preClose', async () => {
    await cleanupProxySockets();
  });

  app.addHook('onClose', async () => {
    await cleanupProxySockets();
    await new Promise<void>((res) => wss.close(() => res()));
  });

  const here = dirname(fileURLToPath(import.meta.url));
  const staticRoot = opts.staticDir ?? resolve(here, '../../client/dist');
  if (existsSync(staticRoot)) {
    await app.register(fastifyStatic, {
      root: staticRoot,
      prefix: '/',
      wildcard: false,
    });

    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/sites/')) {
        return reply.code(404).send({ error: 'not_found', message: 'API route not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '0.0.0.0';
  buildLobbyServer()
    .then((app) => app.listen({ port, host }))
    .then((addr) => {
      console.log(`[@warehouse/lobby] listening on ${addr}`);
    })
    .catch((err) => {
      console.error('[@warehouse/lobby] fatal startup error:', err);
      process.exit(1);
    });
}
