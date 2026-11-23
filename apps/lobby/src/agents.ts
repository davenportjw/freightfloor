import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AGENT_KEY_PREFIX,
  AgentJoinRequestSchema,
  AgentKeySchema,
  AgentLeaderboardResponseSchema,
  AgentRegisterRequestSchema,
  AgentRegisterResponseSchema,
  BASE_SITE_IDS,
  JoinResponseSchema,
  signTicket,
  type LeaderboardEntry,
  type SiteId,
} from '@warehouse/protocol';
import { inspectPromptLocally, validateDisplayName } from '@warehouse/armor';
import {
  HEARTBEAT_STALE_MS,
  MAX_DRIVERS_PER_SITE,
  OVERFLOW_POOL_SITE_IDS,
  SEAT_HOLD_MS,
  TICKET_TTL_MS,
  TOP_PLAYERS_CACHE_TTL_MS,
  TokenBucketRateLimiter,
  type LobbyStore,
  type StoredPlayerDoc,
  type StoredSiteDoc,
} from './index.js';

export const DEFAULT_MAX_EXTERNAL_AGENTS_PER_SITE = 4;
export const AGENT_REGISTER_RATE_PER_MIN = 6;
export const AGENT_JOIN_RATE_PER_MIN = 30;

export interface StoredAgentKeyDoc {
  keyHash: string;
  agentId: string;
  publicId: string;
  name: string;
  model?: string;
  createdAt: number;
  revokedAt?: number;
}

export function hashAgentKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

export function mintAgentKey(): string {
  return `${AGENT_KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
}

export function extractBearerToken(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(raw.trim());
  return match ? match[1] : null;
}

export interface AgentRouteDeps {
  store: LobbyStore;
  ticketSecret: string;
  nowFn: () => number;
  toPublicId: (clientId: string) => string;
  publicLobbyWsUrl: (req: FastifyRequest, siteId: SiteId) => string;
  withJoinLock: <T>(fn: () => Promise<T>) => Promise<T>;
  recordInternalSiteUrls: (sites: StoredSiteDoc[]) => void;
  maxExternalAgentsPerSite?: number;
  maxWarehouses: number;
  registerRatePerMin?: number;
  joinRatePerMin?: number;
  wakeSite?: (siteId: SiteId, nowMs: number) => Promise<void>;
}

function isFreshSite(s: StoredSiteDoc, nowMs: number): boolean {
  return s.updatedAt > 0 && nowMs - s.updatedAt <= HEARTBEAT_STALE_MS && s.state !== 'offline';
}

function isLiveSite(s: StoredSiteDoc, nowMs: number): boolean {
  return isFreshSite(s, nowMs) && s.state !== 'break' && s.phase !== 'break';
}

export function registerAgentRoutes(app: FastifyInstance, deps: AgentRouteDeps): void {
  const {
    store,
    ticketSecret,
    nowFn,
    toPublicId,
    publicLobbyWsUrl,
    withJoinLock,
    recordInternalSiteUrls,
    maxWarehouses,
  } = deps;

  const maxExternalAgentsPerSite = Math.max(
    0,
    deps.maxExternalAgentsPerSite ?? DEFAULT_MAX_EXTERNAL_AGENTS_PER_SITE,
  );
  const registerPerMin = Math.max(1, deps.registerRatePerMin ?? AGENT_REGISTER_RATE_PER_MIN);
  const joinPerMin = Math.max(1, deps.joinRatePerMin ?? AGENT_JOIN_RATE_PER_MIN);
  const registerLimiter = new TokenBucketRateLimiter(registerPerMin, registerPerMin / 60_000);
  const joinLimiter = new TokenBucketRateLimiter(joinPerMin, joinPerMin / 60_000);

  // Local pending seat holds so rapid concurrent joins cannot race past per-site or per-key caps
  // before the next site heartbeat arrives.
  const pendingBySite = new Map<SiteId, Map<string, number>>();
  const prunePending = (sites: StoredSiteDoc[], nowMs: number): void => {
    const byId = new Map(sites.map((s) => [s.id, s]));
    for (const [siteId, map] of pendingBySite.entries()) {
      const site = byId.get(siteId);
      const liveIds = new Set([
        ...(site?.externalAgentClientIds ?? []),
        ...(site?.driverClientIds ?? []),
      ]);
      for (const [agentId, heldAt] of map.entries()) {
        if (liveIds.has(agentId) || nowMs - heldAt > SEAT_HOLD_MS) {
          map.delete(agentId);
        }
      }
      if (map.size === 0) pendingBySite.delete(siteId);
    }
  };

  const countExternalAgentsOnSite = (site: StoredSiteDoc): Set<string> => {
    const ids = new Set<string>(site.externalAgentClientIds ?? []);
    const pending = pendingBySite.get(site.id);
    if (pending) {
      for (const id of pending.keys()) ids.add(id);
    }
    return ids;
  };

  const isAgentActiveAnywhere = (agentId: string, sites: StoredSiteDoc[], nowMs: number): boolean => {
    for (const map of pendingBySite.values()) {
      const heldAt = map.get(agentId);
      if (heldAt !== undefined && nowMs - heldAt <= SEAT_HOLD_MS) return true;
    }
    for (const s of sites) {
      if (!isFreshSite(s, nowMs)) continue;
      if (s.externalAgentClientIds?.includes(agentId)) return true;
      if (s.connectedDriverClientIds?.includes(agentId)) return true;
      if (s.driverClientIds?.includes(agentId)) return true;
    }
    return false;
  };

  let cachedTopAgents: { atMs: number; value: Promise<StoredPlayerDoc[]> } | null = null;
  const getCachedTopAgents = (nowMs: number): Promise<StoredPlayerDoc[]> => {
    if (!store.getTopAgents) return Promise.resolve([]);
    if (cachedTopAgents && nowMs - cachedTopAgents.atMs < TOP_PLAYERS_CACHE_TTL_MS) {
      return cachedTopAgents.value;
    }
    const promise = store.getTopAgents(10).catch((err) => {
      if (cachedTopAgents?.value === promise) cachedTopAgents = null;
      throw err;
    });
    cachedTopAgents = { atMs: nowMs, value: promise };
    return promise;
  };

  /**
   * POST /api/agents/register
   * Mint a personal bearer API key (`ffa_...`) for a BYO external forklift agent.
   * Uses local callsign + prompt-hygiene checks only (zero remote LLM / Model Armor calls).
   */
  app.post('/api/agents/register', async (req, reply) => {
    const nowMs = nowFn();
    const ip = req.ip || '127.0.0.1';
    if (!registerLimiter.allow(ip, nowMs)) {
      return reply.code(429).send({
        error: 'rate_limited',
        message: 'Too many agent registrations from this IP. Please wait a moment.',
      });
    }
    if (!store.createAgentKey) {
      return reply.code(503).send({
        error: 'agent_registration_unavailable',
        message: 'Agent registration store is not configured.',
      });
    }

    const parsed = AgentRegisterRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: parsed.error.issues[0]?.message ?? 'Invalid agent registration payload.',
      });
    }

    const nameCheck = validateDisplayName(parsed.data.name);
    if (!nameCheck.ok) {
      return reply.code(400).send({
        error: nameCheck.code,
        message: nameCheck.message,
      });
    }
    if (inspectPromptLocally(nameCheck.name).flagged) {
      return reply.code(400).send({
        error: 'armor_blocked',
        message: 'Agent name rejected by safety filter.',
      });
    }
    if (parsed.data.model && inspectPromptLocally(parsed.data.model).flagged) {
      return reply.code(400).send({
        error: 'armor_blocked',
        message: 'Agent model label rejected by safety filter.',
      });
    }

    const apiKey = mintAgentKey();
    const keyHash = hashAgentKey(apiKey);
    const agentId = `agent_${randomBytes(12).toString('hex')}`;
    const publicId = toPublicId(agentId);

    const doc: StoredAgentKeyDoc = {
      keyHash,
      agentId,
      publicId,
      name: nameCheck.name,
      ...(parsed.data.model ? { model: parsed.data.model } : {}),
      createdAt: nowMs,
    };
    await store.createAgentKey(doc);

    const response = AgentRegisterResponseSchema.parse({
      apiKey,
      agentId,
      publicId,
      name: doc.name,
      ...(doc.model ? { model: doc.model } : {}),
    });
    return reply.code(201).header('Cache-Control', 'no-store').send(response);
  });

  /**
   * POST /api/agents/join
   * Authenticate with `Authorization: Bearer ffa_...` and claim a driver ticket for a BYO agent.
   * Bypasses browser crawler UA checks; enforces 1 active forklift per key and per-site agent cap.
   */
  app.post('/api/agents/join', async (req, reply) => {
    const nowMs = nowFn();
    const ip = req.ip || '127.0.0.1';
    if (!joinLimiter.allow(ip, nowMs)) {
      return reply.code(429).send({
        error: 'rate_limited',
        message: 'Too many agent join requests from this IP. Please wait a moment.',
      });
    }
    if (!store.lookupAgentKey) {
      return reply.code(503).send({
        error: 'agent_join_unavailable',
        message: 'Agent authentication store is not configured.',
      });
    }

    const token = extractBearerToken(req.headers.authorization);
    if (!token || !AgentKeySchema.safeParse(token).success) {
      return reply.code(401).send({
        error: 'invalid_agent_key',
        message: 'Provide a valid agent API key via Authorization: Bearer ffa_...',
      });
    }

    const keyDoc = await store.lookupAgentKey(hashAgentKey(token));
    if (!keyDoc || keyDoc.revokedAt !== undefined) {
      return reply.code(401).send({
        error: 'invalid_agent_key',
        message: 'Agent API key is invalid or revoked.',
      });
    }

    const parsedBody = AgentJoinRequestSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: parsedBody.error.issues[0]?.message ?? 'Invalid agent join payload.',
      });
    }

    const preferredSite = parsedBody.data.preferredSite ?? parsedBody.data.prefer;
    const runMode = parsedBody.data.runMode ?? parsedBody.data.mode ?? 'blitz';
    const resolvedModel = parsedBody.data.model ?? keyDoc.model;
    if (resolvedModel && inspectPromptLocally(resolvedModel).flagged) {
      return reply.code(400).send({
        error: 'armor_blocked',
        message: 'Agent model label rejected by safety filter.',
      });
    }

    if (maxExternalAgentsPerSite <= 0) {
      return reply.code(503).send({
        error: 'agent_capacity_full',
        message: 'External agent seats are currently disabled on this lobby.',
      });
    }

    const result = await withJoinLock(async () => {
      const sites = await store.getSites();
      recordInternalSiteUrls(sites);
      prunePending(sites, nowMs);

      if (isAgentActiveAnywhere(keyDoc.agentId, sites, nowMs)) {
        return {
          ok: false as const,
          status: 409,
          error: 'agent_already_active',
          message: 'This agent key already holds an active forklift seat (limit: 1 per key).',
        };
      }

      const candidateIds: SiteId[] = [
        ...BASE_SITE_IDS,
        ...OVERFLOW_POOL_SITE_IDS.slice(0, Math.max(0, maxWarehouses - BASE_SITE_IDS.length)),
      ];
      const byId = new Map<SiteId, StoredSiteDoc>(sites.map((s) => [s.id, s]));

      const canAcceptExternalAgent = (s: StoredSiteDoc): boolean => {
        const cap = Math.max(1, s.maxDrivers ?? MAX_DRIVERS_PER_SITE);
        if (s.drivers >= cap) return false;
        const extCount = countExternalAgentsOnSite(s).size;
        return extCount < maxExternalAgentsPerSite;
      };

      let chosen: StoredSiteDoc | null = null;
      let wokeBreakSite = false;

      if (preferredSite) {
        const pref = byId.get(preferredSite);
        if (pref && isLiveSite(pref, nowMs) && canAcceptExternalAgent(pref)) {
          chosen = pref;
        }
      }

      if (!chosen) {
        const liveCandidates = candidateIds
          .map((id) => byId.get(id))
          .filter((s): s is StoredSiteDoc => Boolean(s && isLiveSite(s, nowMs) && canAcceptExternalAgent(s)));
        if (liveCandidates.length > 0) {
          liveCandidates.sort((a, b) => {
            const extDiff = countExternalAgentsOnSite(a).size - countExternalAgentsOnSite(b).size;
            if (extDiff !== 0) return extDiff;
            if (a.drivers !== b.drivers) return a.drivers - b.drivers;
            return candidateIds.indexOf(a.id) - candidateIds.indexOf(b.id);
          });
          chosen = liveCandidates[0];
        }
      }

      if (!chosen) {
        const breakCandidate = (preferredSite ? [preferredSite, ...candidateIds] : candidateIds)
          .map((id) => byId.get(id))
          .find((s): s is StoredSiteDoc => Boolean(s && (s.state === 'break' || s.phase === 'break') && canAcceptExternalAgent(s)));
        if (breakCandidate) {
          chosen = breakCandidate;
          wokeBreakSite = true;
        }
      }

      if (!chosen) {
        return {
          ok: false as const,
          status: 503,
          error: 'agent_capacity_full',
          message: `All warehouse sites have reached the external agent cap (${maxExternalAgentsPerSite}/site) or are offline.`,
        };
      }

      if (wokeBreakSite) {
        if (deps.wakeSite) {
          await deps.wakeSite(chosen.id, nowMs);
        } else if (store.wakeSite) {
          await store.wakeSite(chosen.id, nowMs);
        }
      }

      let sitePending = pendingBySite.get(chosen.id);
      if (!sitePending) {
        sitePending = new Map<string, number>();
        pendingBySite.set(chosen.id, sitePending);
      }
      sitePending.set(keyDoc.agentId, nowMs);
      store.recordAssignment?.(chosen.id, keyDoc.agentId, 'driver', nowMs);

      const expiresAt = nowMs + TICKET_TTL_MS;
      const ticket = signTicket(
        {
          clientId: keyDoc.agentId,
          name: keyDoc.name,
          siteId: chosen.id,
          isBot: true,
          externalAgent: true,
          ...(resolvedModel ? { agentModel: resolvedModel } : {}),
          exp: expiresAt,
          runMode,
          role: 'driver',
          jti: randomBytes(12).toString('base64url'),
        },
        ticketSecret,
      );

      const wsUrl = publicLobbyWsUrl(req, chosen.id);
      return {
        ok: true as const,
        payload: JoinResponseSchema.parse({
          siteId: chosen.id,
          wsUrl,
          ticket,
          expiresAt,
          name: keyDoc.name,
          clientId: keyDoc.agentId,
          publicId: keyDoc.publicId,
          role: 'driver',
          isBot: true,
          externalAgent: true,
          ...(resolvedModel ? { agentModel: resolvedModel } : {}),
        }),
      };
    });

    if (!result.ok) {
      return reply.code(result.status).send({
        error: result.error,
        message: result.message,
      });
    }
    return reply.code(200).header('Cache-Control', 'no-store').send(result.payload);
  });

  /**
   * GET /api/agents/leaderboard
   * Public Agent League standings (external BYO agents only; never mixed with human leaderboard).
   */
  app.get('/api/agents/leaderboard', async (_req, reply) => {
    const nowMs = nowFn();
    const topAgents = await getCachedTopAgents(nowMs);
    const leaderboard: LeaderboardEntry[] = topAgents.map((p) => {
      const pid = toPublicId(p.clientId);
      return {
        clientId: pid,
        publicId: pid,
        name: p.name,
        ...(p.siteId ? { siteId: p.siteId } : {}),
        points: p.points ?? p.lifetimePoints ?? 0,
        lifetimePoints: p.lifetimePoints ?? p.points ?? 0,
        ...(p.bestBlitzPts !== undefined ? { bestBlitzPts: p.bestBlitzPts } : {}),
        ...(p.ppm !== undefined ? { ppm: p.ppm } : {}),
        deliveries: p.deliveries,
        isBot: true,
        externalAgent: true,
        ...(p.agentModel ? { agentModel: p.agentModel } : {}),
      };
    });
    const body = AgentLeaderboardResponseSchema.parse({ leaderboard });
    return reply
      .code(200)
      .header('Cache-Control', 'public, max-age=15')
      .send(body);
  });
}
