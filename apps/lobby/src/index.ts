import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { Firestore } from '@google-cloud/firestore';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { GoogleAuth } from 'google-auth-library';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { z } from 'zod';
import {
  JoinRequestSchema,
  JoinResponseSchema,
  NetworkResponseSchema,
  PHASES,
  PROXY_HEADER_NAME,
  SITE_IDS,
  SiteIdSchema,
  signProxyHeader,
  signTicket,
  verifyProxyHeader,
  verifyTicket,
  type LeaderboardEntry,
  type Phase,
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

export const CSP_HEADER =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:;";

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
  bestBlitzPts?: number;
  deliveries: number;
  isBot?: boolean;
  updatedAt?: number;
}

export type PlayerIdentityResult =
  | { ok: true; clientId: string; name: string }
  | { ok: false; error: string; message: string };

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
  resolvePlayerIdentity?(params: {
    clientId: string;
    resume?: string;
    siteId?: SiteId;
    nowMs: number;
  }): Promise<PlayerIdentityResult>;
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
          drivers: pendingCount,
          spectators: 0,
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
      const bestBlitzPts =
        typeof data.bestBlitzPts === 'number' ? data.bestBlitzPts : undefined;
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
        ...(bestBlitzPts !== undefined ? { bestBlitzPts } : {}),
        deliveries,
        isBot: Boolean(data.isBot),
      });
    });
    return players
      .filter((p) => !p.isBot && !isReservedBotPrefix(p.name))
      .sort((a, b) => (b.points ?? 0) - (a.points ?? 0))
      .slice(0, limit);
  }

  async resolvePlayerIdentity(params: {
    clientId: string;
    resume?: string;
    siteId?: SiteId;
    nowMs: number;
  }): Promise<PlayerIdentityResult> {
    const col = this.db.collection(this.colName('players'));
    const snap = await col.limit(500).get();
    const docs: Array<{ clientId: string; name: string; isBot: boolean }> = [];
    snap.forEach((doc) => {
      const data = doc.data();
      const cid = String(data.clientId || doc.id);
      const name = String(data.name || '');
      const isBot = Boolean(data.isBot) || isReservedBotPrefix(name);
      docs.push({ clientId: cid, name, isBot });
    });

    const resumeQuery = params.resume?.trim();
    if (resumeQuery) {
      const lower = resumeQuery.toLowerCase();
      const matched = docs.find(
        (d) => !d.isBot && (d.clientId === resumeQuery || d.name.toLowerCase() === lower),
      );
      if (!matched) {
        return {
          ok: false,
          error: 'unknown_callsign',
          message: 'No tracked driver callsign or ID matches that value.',
        };
      }
      await col.doc(matched.clientId).set(
        {
          clientId: matched.clientId,
          name: matched.name,
          updatedAt: params.nowMs,
          ...(params.siteId ? { siteId: params.siteId } : {}),
        },
        { merge: true },
      );
      return { ok: true, clientId: matched.clientId, name: matched.name };
    }

    const existing = docs.find((d) => d.clientId === params.clientId && !d.isBot);
    if (existing && existing.name && existing.name !== 'Driver') {
      await col.doc(existing.clientId).set(
        {
          clientId: existing.clientId,
          name: existing.name,
          updatedAt: params.nowMs,
          ...(params.siteId ? { siteId: params.siteId } : {}),
        },
        { merge: true },
      );
      return { ok: true, clientId: existing.clientId, name: existing.name };
    }

    const existingNames = docs
      .filter((d) => d.clientId !== params.clientId && Boolean(d.name))
      .map((d) => d.name);
    const assignedName = generateDriverCallsign(params.clientId, existingNames);
    await col.doc(params.clientId).set(
      {
        clientId: params.clientId,
        name: assignedName,
        isBot: false,
        updatedAt: params.nowMs,
        ...(params.siteId ? { siteId: params.siteId } : {}),
      },
      { merge: true },
    );
    return { ok: true, clientId: params.clientId, name: assignedName };
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
        const secret = await resolveTicketSecret();
        const headers = await buildInternalBackendHeaders(
          siteId,
          siteHttpUrl,
          secret,
          nowMs,
          { 'content-type': 'application/json' },
        );
        await fetch(`${siteHttpUrl}/internal/wake`, {
          method: 'POST',
          headers,
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

  async resolvePlayerIdentity(params: {
    clientId: string;
    resume?: string;
    siteId?: SiteId;
    nowMs: number;
  }): Promise<PlayerIdentityResult> {
    const resumeQuery = params.resume?.trim();
    if (resumeQuery) {
      const lower = resumeQuery.toLowerCase();
      for (const p of this.players.values()) {
        if (p.isBot || isReservedBotPrefix(p.name)) continue;
        if (p.clientId === resumeQuery || p.name.toLowerCase() === lower) {
          p.updatedAt = params.nowMs;
          if (params.siteId) p.siteId = params.siteId;
          return { ok: true, clientId: p.clientId, name: p.name };
        }
      }
      return {
        ok: false,
        error: 'unknown_callsign',
        message: 'No tracked driver callsign or ID matches that value.',
      };
    }

    const existing = this.players.get(params.clientId);
    if (existing && !existing.isBot && existing.name && existing.name !== 'Driver') {
      existing.updatedAt = params.nowMs;
      if (params.siteId) existing.siteId = params.siteId;
      return { ok: true, clientId: existing.clientId, name: existing.name };
    }

    const existingNames: string[] = [];
    for (const [cid, p] of this.players.entries()) {
      if (cid !== params.clientId && p.name) {
        existingNames.push(p.name);
      }
    }
    const assignedName = generateDriverCallsign(params.clientId, existingNames);
    this.players.set(params.clientId, {
      clientId: params.clientId,
      name: assignedName,
      siteId: params.siteId ?? existing?.siteId,
      points: existing?.points ?? 0,
      lifetimePoints: existing?.lifetimePoints ?? 0,
      deliveries: existing?.deliveries ?? 0,
      isBot: false,
      updatedAt: params.nowMs,
    });
    return { ok: true, clientId: params.clientId, name: assignedName };
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

  const isFreeRange = mode === 'freerange';
  const softCap = isFreeRange ? FREE_RANGE_SOFT_CAP : FREE_RANGE_HARD_CAP;
  const hardCap = isFreeRange ? FREE_RANGE_HARD_CAP : MAX_DRIVERS_PER_SITE;
  const preferredCap = isFreeRange ? FREE_RANGE_SOFT_CAP : MAX_DRIVERS_PER_SITE;

  // Step 1: preferredSite if live and drivers < preferredCap
  if (preferredSite) {
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
  for (const id of SITE_IDS) {
    const s = byId.get(id);
    if (s && isFreshLiveSite(s, nowMs) && s.drivers > 0 && s.drivers < softCap) {
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
  if (preferredSite) {
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
  for (const id of SITE_IDS) {
    const s = byId.get(id);
    if (s && isFreshLiveSite(s, nowMs) && s.drivers < hardCap) {
      hardCapLiveOpen.push(s);
    }
  }
  if (hardCapLiveOpen.length > 0) {
    hardCapLiveOpen.sort((a, b) => {
      if (b.drivers !== a.drivers) return b.drivers - a.drivers;
      return SITE_IDS.indexOf(a.id) - SITE_IDS.indexOf(b.id);
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

  if (process.env.K_SERVICE) {
    throw new Error(
      'TICKET_HMAC_SECRET, TICKET_HMAC_SECRET_NAME, or TICKET_SECRET must be configured in Cloud Run',
    );
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

  const internalSiteWsUrls = new Map<SiteId, string>();
  const initialConfigured = parseSiteUrlsMap();
  for (const id of SITE_IDS) {
    if (initialConfigured[id]) {
      internalSiteWsUrls.set(id, httpUrlToWsUrl(initialConfigured[id]!));
    }
  }

  function recordInternalSiteUrls(sites: StoredSiteDoc[]): void {
    const configured = parseSiteUrlsMap();
    for (const s of sites) {
      if (configured[s.id]) {
        internalSiteWsUrls.set(s.id, httpUrlToWsUrl(configured[s.id]!));
      } else if (s.wsUrl && !s.wsUrl.includes('/ws?site=')) {
        internalSiteWsUrls.set(s.id, httpUrlToWsUrl(s.wsUrl));
      }
    }
  }

  async function resolveInternalSiteWsUrl(siteId: SiteId): Promise<string | undefined> {
    const configured = parseSiteUrlsMap()[siteId];
    if (configured) {
      const wsUrl = httpUrlToWsUrl(configured);
      internalSiteWsUrls.set(siteId, wsUrl);
      return wsUrl;
    }
    const cached = internalSiteWsUrls.get(siteId);
    if (cached) return cached;
    const sites = await store.getSites();
    recordInternalSiteUrls(sites);
    return internalSiteWsUrls.get(siteId);
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

    const {
      name: rawName,
      prefer,
      preferredSite: prefAlias,
      clientId,
      resume,
      mode,
    } = parsedBody.data;
    const preferredSite = prefAlias ?? prefer;

    // Screen callsign lookups for prompt-injection / URL smuggling before querying the store.
    if (typeof resume === 'string' && resume.trim().length > 0) {
      if (inspectPromptLocally(resume).flagged) {
        return reply.code(404).send({
          error: 'invalid_resume_code',
          message: 'No driver found for that callsign.',
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
      let resolvedClientId = clientId;
      let resolvedName = isBot
        ? botName
        : generateDriverCallsign(clientId);

      if (!isBot && store.resolvePlayerIdentity) {
        const identity = await store.resolvePlayerIdentity({
          clientId,
          resume,
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
        resolvedClientId = identity.clientId;
        const runSuffixMatch =
          !resume &&
          validatedHumanName &&
          validatedHumanName.toLowerCase().startsWith(`${identity.name.toLowerCase()} run `)
            ? validatedHumanName.slice(identity.name.length)
            : '';
        resolvedName = runSuffixMatch ? `${identity.name}${runSuffixMatch}` : identity.name;
      }

      const sites = await store.getSites();
      recordInternalSiteUrls(sites);
      const placed = await selectSiteForJoin(
        sites,
        preferredSite,
        nowMs,
        store.wakeSite ? (siteId) => store.wakeSite!(siteId, nowMs) : undefined,
        mode,
      );
      if (!placed) {
        return {
          ok: false as const,
          status: 503 as const,
          error: 'no_sites_available',
          message: 'No live warehouse sites are currently reachable.',
        };
      }
      if (store.recordAssignment) {
        store.recordAssignment(placed.siteId, resolvedClientId, placed.role, nowMs);
      }
      return {
        ok: true as const,
        placement: placed,
        resolvedClientId,
        resolvedName,
      };
    });

    if (!outcome.ok) {
      return reply.code(outcome.status).send({
        error: outcome.error,
        message: outcome.message,
      });
    }

    const { placement, resolvedClientId, resolvedName } = outcome;
    const expiresAt = nowMs + TICKET_TTL_MS;
    const ticket = signTicket(
      {
        clientId: resolvedClientId,
        name: resolvedName,
        siteId: placement.siteId,
        isBot,
        exp: expiresAt,
        ...(mode ? { runMode: mode } : {}),
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
    });

    return reply.code(200).send(responsePayload);
  });

  app.get('/api/network', async (req, reply) => {
    const nowMs = nowFn();
    const [storedSites, topPlayers] = await Promise.all([
      store.getSites(),
      store.getTopPlayers(10),
    ]);
    recordInternalSiteUrls(storedSites);

    const byId = new Map<SiteId, StoredSiteDoc>();
    for (const s of storedSites) {
      byId.set(s.id, s);
    }

    const sites: SiteStatus[] = SITE_IDS.map((id) => {
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

    const leaderboard: LeaderboardEntry[] = topPlayers
      .filter((p) => !p.isBot && !isReservedBotPrefix(p.name))
      .slice(0, 10)
      .map((p) => ({
        clientId: p.clientId,
        name: p.name,
        siteId: p.siteId,
        points: p.points ?? p.lifetimePoints ?? 0,
        lifetimePoints: p.lifetimePoints ?? p.points ?? 0,
        ...(p.bestBlitzPts !== undefined ? { bestBlitzPts: p.bestBlitzPts } : {}),
        deliveries: p.deliveries,
        isBot: false,
      }));

    const payload = NetworkResponseSchema.parse({ sites, leaderboard });
    return reply.code(200).send(payload);
  });

  // Internal/dev gateway proxy routes for site inspection & wake/transfer (blocked externally in Cloud Run without proxy auth)
  app.get<{ Params: { siteId: string } }>('/sites/:siteId/healthz', async (req, reply) => {
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
  });

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
  const wss = new WebSocketServer({ noServer: true });
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

        const forwardedFor = req.headers['x-forwarded-for']
          ? String(req.headers['x-forwarded-for'])
          : req.socket.remoteAddress || '127.0.0.1';
        const upstreamHeaders = await buildInternalBackendHeaders(
          siteId,
          upstreamWsUrl,
          secret,
          nowFn(),
          { 'x-forwarded-for': forwardedFor },
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
