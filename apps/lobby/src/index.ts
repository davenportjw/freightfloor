import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { Firestore } from '@google-cloud/firestore';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  JoinRequestSchema,
  JoinResponseSchema,
  NetworkResponseSchema,
  PHASES,
  SITE_IDS,
  SiteIdSchema,
  signTicket,
  type LeaderboardEntry,
  type Phase,
  type SiteId,
  type SiteStatus,
} from '@warehouse/protocol';
import {
  inspectPromptLocally,
  isReservedBotPrefix,
  validateDisplayName,
  type ModelArmorClient,
} from '@warehouse/armor';

export const LOBBY_VERSION = 1;
export const HEARTBEAT_STALE_MS = 15_000;
export const MAX_DRIVERS_PER_SITE = 32;
export const TICKET_TTL_MS = 60_000;

export const CSP_HEADER =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss: http: https:;";

export type SitePhaseInput = Phase | 'on_break';

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
  updatedAt: number;
}

export interface StoredPlayerDoc {
  clientId: string;
  name: string;
  siteId?: SiteId;
  points?: number;
  lifetimePoints?: number;
  deliveries: number;
  isBot?: boolean;
  updatedAt?: number;
}

export interface LobbyStore {
  getSites(): Promise<StoredSiteDoc[]>;
  getTopPlayers(limit: number): Promise<StoredPlayerDoc[]>;
  wakeSite?(siteId: SiteId, nowMs: number): Promise<void>;
  recordAssignment?(
    siteId: SiteId,
    clientId: string,
    role: 'driver' | 'spectator',
    nowMs: number,
  ): void;
}

export function parseSiteUrlsMap(): Partial<Record<SiteId, string>> {
  const raw = process.env.SITE_URLS_JSON;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<Record<SiteId, string>> = {};
    for (const id of SITE_IDS) {
      if (typeof parsed[id] === 'string' && parsed[id]) {
        out[id] = (parsed[id] as string).replace(/\/$/, '');
      }
    }
    return out;
  } catch {
    return {};
  }
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

/**
 * Production Firestore-backed store for `sites/{id}` and `players/{clientId}`.
 */
export class FirestoreLobbyStore implements LobbyStore {
  private readonly db: Firestore;
  private readonly suffix: string;
  private readonly pendingDrivers = new Map<SiteId, Map<string, number>>();
  private readonly wokenUntil = new Map<SiteId, number>();

  constructor(db?: Firestore) {
    this.suffix = process.env.SUFFIX || '';
    this.db =
      db ??
      new Firestore({
        projectId:
          process.env.GOOGLE_CLOUD_PROJECT ||
          process.env.GCP_PROJECT_ID ||
          process.env.GCP_PROJECT ||
          'davenport-boutique',
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
    if (role !== 'driver') return;
    let map = this.pendingDrivers.get(siteId);
    if (!map) {
      map = new Map<string, number>();
      this.pendingDrivers.set(siteId, map);
    }
    map.set(clientId, nowMs);
  }

  async getSites(): Promise<StoredSiteDoc[]> {
    const nowMs = Date.now();
    const snap = await this.db.collection(this.colName('sites')).get();
    const byId = new Map<SiteId, StoredSiteDoc>();

    snap.forEach((doc) => {
      const data = doc.data();
      const id = (data.id || data.siteId || doc.id) as SiteId;
      if (!SITE_IDS.includes(id)) return;
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
      const driverClientIds = Array.isArray(data.driverClientIds)
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
          if (nowMs - assignedAt > 45_000) {
            pendingMap.delete(cid);
          }
        }
      }
      const pendingCount = pendingMap ? pendingMap.size : 0;
      const combinedCount =
        driverClientIds.length > 0
          ? new Set([
              ...driverClientIds,
              ...(pendingMap ? pendingMap.keys() : []),
            ]).size
          : rawDrivers + pendingCount;
      const drivers = Math.max(rawDrivers, combinedCount);

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
      const configuredHttpUrl = configuredUrls[id];
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
          drivers: Math.max(existing?.drivers ?? 0, pendingCount),
          spectators: existing?.spectators ?? 0,
          tier: existing?.tier ?? 0,
          shipped: existing?.shipped ?? 0,
          wsUrl: httpUrlToWsUrl(configuredHttpUrl),
          ...(existing?.maxDrivers !== undefined ? { maxDrivers: existing.maxDrivers } : {}),
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
      const deliveries =
        typeof data.deliveries === 'number'
          ? data.deliveries
          : typeof data.totalDeliveries === 'number'
            ? data.totalDeliveries
            : 0;
      const siteRaw = data.siteId || data.lastSiteId;
      players.push({
        clientId,
        name,
        siteId: SITE_IDS.includes(siteRaw) ? siteRaw : undefined,
        points,
        lifetimePoints,
        deliveries,
        isBot: Boolean(data.isBot),
      });
    });
    return players
      .filter((p) => !p.isBot && !isReservedBotPrefix(p.name))
      .sort((a, b) => (b.points ?? 0) - (a.points ?? 0))
      .slice(0, limit);
  }

  async wakeSite(siteId: SiteId, nowMs: number): Promise<void> {
    this.wokenUntil.set(siteId, nowMs + 25_000);
    await this.db
      .collection(this.colName('sites'))
      .doc(siteId)
      .set(
        {
          id: siteId,
          siteId,
          phase: 'running',
          state: 'live',
          updatedAt: nowMs,
        },
        { merge: true },
      );

    const configuredUrls = parseSiteUrlsMap();
    const siteHttpUrl = configuredUrls[siteId];
    if (siteHttpUrl) {
      try {
        await fetch(`${siteHttpUrl}/internal/wake`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ immediate: true }),
        });
      } catch {
        // Ignore network errors during wake ping; client WS connection will also wake Cloud Run
      }
    }
  }
}

/**
 * In-memory store implementation for deterministic unit tests and local single-node dev.
 */
export class InMemoryLobbyStore implements LobbyStore {
  private sites = new Map<SiteId, StoredSiteDoc>();
  private players = new Map<string, StoredPlayerDoc>();
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

  async wakeSite(siteId: SiteId, nowMs: number): Promise<void> {
    this.wokenSites.push(siteId);
    const existing = this.sites.get(siteId);
    if (existing) {
      existing.phase = 'running';
      existing.state = 'online';
      existing.updatedAt = nowMs;
    }
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
  const fromUrlsJson = configuredUrls[siteId];
  if (fromUrlsJson) return httpUrlToWsUrl(fromUrlsJson);
  if (siteDoc?.wsUrl) return siteDoc.wsUrl;
  const envKey = `SITE_WS_URL_${siteId.replace('-', '_').toUpperCase()}`;
  const fromEnv = process.env[envKey];
  if (fromEnv) return fromEnv;
  const basePattern = process.env.SITE_WS_URL_TEMPLATE;
  if (basePattern) return basePattern.replace('{siteId}', siteId);
  return `ws://localhost:8080/ws?site=${siteId}`;
}

/**
 * 4-step placement algorithm:
 * 1. `preferredSite` if live (`updatedAt` within 15s, not `on_break`/`break`) and `drivers < 8`.
 * 2. Live site with the most active human drivers (`0 < drivers < 8`), so casual players land together.
 * 3. First empty live site (`drivers === 0`) in `['den-1', 'slc-2', 'phx-3', 'abq-4']` order,
 *    waking a sleeping/break site if needed.
 * 4. Spectator on `preferredSite` (or fullest live site) when all 4 sites have `drivers >= 8`.
 */
export async function selectSiteForJoin(
  sites: StoredSiteDoc[],
  preferredSite: SiteId | undefined,
  nowMs: number,
  onWakeSite?: (siteId: SiteId) => Promise<void>,
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

  const byId = new Map<SiteId, StoredSiteDoc>();
  for (const s of sites) {
    byId.set(s.id, s);
  }

  // Step 1: preferredSite if live and drivers < 8
  if (preferredSite) {
    const pref = byId.get(preferredSite);
    if (pref && isFreshLiveSite(pref, nowMs) && pref.drivers < MAX_DRIVERS_PER_SITE) {
      return {
        siteId: pref.id,
        wsUrl: defaultWsUrlForSite(pref.id, pref),
        role: 'driver',
        wokeBreakSite: false,
      };
    }
  }

  // Step 2: Live site with the MOST active human drivers (0 < drivers < 8)
  const populatedLiveOpen: StoredSiteDoc[] = [];
  for (const id of SITE_IDS) {
    const s = byId.get(id);
    if (s && isFreshLiveSite(s, nowMs) && s.drivers > 0 && s.drivers < MAX_DRIVERS_PER_SITE) {
      populatedLiveOpen.push(s);
    }
  }
  if (populatedLiveOpen.length > 0) {
    populatedLiveOpen.sort((a, b) => {
      if (b.drivers !== a.drivers) return b.drivers - a.drivers;
      return SITE_IDS.indexOf(a.id) - SITE_IDS.indexOf(b.id);
    });
    const chosen = populatedLiveOpen[0];
    return {
      siteId: chosen.id,
      wsUrl: defaultWsUrlForSite(chosen.id, chosen),
      role: 'driver',
      wokeBreakSite: false,
    };
  }

  // Step 3a: First empty live site (drivers === 0) in SITE_IDS order
  for (const id of SITE_IDS) {
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
  const breakOrder: SiteId[] = preferredSite
    ? [preferredSite, ...SITE_IDS.filter((id) => id !== preferredSite)]
    : [...SITE_IDS];
  for (const id of breakOrder) {
    const s = byId.get(id);
    if (s && isWakingCandidateBreakSite(s, nowMs) && s.drivers < MAX_DRIVERS_PER_SITE) {
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

  // Step 4: Spectator on preferredSite (if live) or fullest live site when all live sites have drivers >= 8
  if (preferredSite) {
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
  for (const id of SITE_IDS) {
    const s = byId.get(id);
    if (s && isFreshLiveSite(s, nowMs)) {
      allLive.push(s);
    }
  }
  if (allLive.length > 0) {
    allLive.sort((a, b) => {
      if (b.drivers !== a.drivers) return b.drivers - a.drivers;
      return SITE_IDS.indexOf(a.id) - SITE_IDS.indexOf(b.id);
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

class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; lastRefillMs: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
  ) {}

  allow(ip: string, nowMs: number): boolean {
    const existing = this.buckets.get(ip);
    if (!existing) {
      this.buckets.set(ip, { tokens: this.capacity - 1, lastRefillMs: nowMs });
      return true;
    }
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

  return 'dev-local-warehouse-hmac-secret-key-2026';
}

const ExtendedJoinRequestSchema = JoinRequestSchema.extend({
  preferredSite: SiteIdSchema.optional(),
});

const ExtendedJoinResponseSchema = JoinResponseSchema.extend({
  role: z.enum(['driver', 'spectator']),
  isBot: z.boolean(),
});

export interface LobbyServerOptions {
  store?: LobbyStore;
  ticketSecret?: string;
  now?: () => number;
  armorClient?: ModelArmorClient;
  rateLimitPerMin?: number;
  staticDir?: string;
}

export async function buildLobbyServer(opts: LobbyServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true });
  const store = opts.store ?? new FirestoreLobbyStore();
  const nowFn = opts.now ?? (() => Date.now());
  const secret = await resolveTicketSecret(opts.ticketSecret);
  const envRateLimit = Number(process.env.RATE_LIMIT_PER_MIN);
  const rateLimitPerMin =
    opts.rateLimitPerMin ?? (Number.isFinite(envRateLimit) && envRateLimit > 0 ? envRateLimit : 30);
  const limiter = new TokenBucketRateLimiter(rateLimitPerMin, rateLimitPerMin / 60_000);

  let joinLockChain = Promise.resolve();
  function withJoinLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = joinLockChain.then(fn, fn);
    joinLockChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Content-Security-Policy', CSP_HEADER);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    return payload;
  });

  app.get('/healthz', async () => {
    return { ok: true, service: 'lobby' };
  });

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

    const { name: rawName, prefer, preferredSite: prefAlias, clientId } = parsedBody.data;
    const preferredSite = prefAlias ?? prefer;

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

    const placement = await withJoinLock(async () => {
      const sites = await store.getSites();
      const placed = await selectSiteForJoin(
        sites,
        preferredSite,
        nowMs,
        store.wakeSite ? (siteId) => store.wakeSite!(siteId, nowMs) : undefined,
      );
      if (placed && store.recordAssignment) {
        store.recordAssignment(placed.siteId, clientId, placed.role, nowMs);
      }
      return placed;
    });

    if (!placement) {
      return reply.code(503).send({
        error: 'no_sites_available',
        message: 'No live warehouse sites are currently reachable.',
      });
    }

    const expiresAt = nowMs + TICKET_TTL_MS;
    const ticket = signTicket(
      {
        clientId,
        name: nameCheck.name,
        siteId: placement.siteId,
        isBot: nameCheck.isBot,
        exp: expiresAt,
      },
      secret,
    );

    const responsePayload = ExtendedJoinResponseSchema.parse({
      siteId: placement.siteId,
      wsUrl: placement.wsUrl,
      ticket,
      expiresAt,
      role: placement.role,
      isBot: nameCheck.isBot,
    });

    return reply.code(200).send(responsePayload);
  });

  app.get('/api/network', async (_req, reply) => {
    const nowMs = nowFn();
    const [storedSites, topPlayers] = await Promise.all([
      store.getSites(),
      store.getTopPlayers(10),
    ]);

    const byId = new Map<SiteId, StoredSiteDoc>();
    for (const s of storedSites) {
      byId.set(s.id, s);
    }

    const sites: SiteStatus[] = SITE_IDS.map((id) => {
      const s = byId.get(id);
      if (!s) {
        return {
          id,
          state: 'offline',
          drivers: 0,
          spectators: 0,
          tier: 0,
          shipped: 0,
          phase: 'running',
          wsUrl: defaultWsUrlForSite(id),
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
        wsUrl: defaultWsUrlForSite(id, s),
        maxDrivers: s.maxDrivers ?? MAX_DRIVERS_PER_SITE,
        updatedAt: s.updatedAt,
      };
    });

    const leaderboard: LeaderboardEntry[] = topPlayers
      .filter((p) => !p.isBot && !isReservedBotPrefix(p.name))
      .slice(0, 10)
      .map((p) => ({
        clientId: p.clientId,
        name: p.name,
        siteId: p.siteId,
        points: p.points ?? p.lifetimePoints ?? 0,
        lifetimePoints: p.lifetimePoints ?? p.points ?? 0,
        deliveries: p.deliveries,
        isBot: false,
      }));

    const payload = NetworkResponseSchema.parse({ sites, leaderboard });
    return reply.code(200).send(payload);
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
      if (req.url.startsWith('/api/')) {
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
