import WebSocket from 'ws';
import { Firestore } from '@google-cloud/firestore';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { GoogleAuth } from 'google-auth-library';
import {
  PROXY_HEADER_NAME,
  ServerMessageSchema,
  SiteIdSchema,
  signProxyHeader,
  type ServerMessage,
  type SiteId,
} from '@warehouse/protocol';

/**
 * How the live smoke reaches site services (which are private on Cloud Run):
 * - `idtoken`: directly at the site's Cloud Run URL with a Google-signed ID token
 *   (requires ADC that can mint ID tokens, i.e. a service account / metadata server).
 * - `lobby-proxy`: through the public lobby gateway routes `/sites/:siteId/...`
 *   (used when ADC is a user account that cannot mint ID tokens, or for local http lobbies).
 */
export type SiteAuthMode = 'idtoken' | 'lobby-proxy';

export interface LiveSmokeOptions {
  lobbyUrl: string;
  driveDurationMs?: number;
  inputIntervalMs?: number;
  secondarySiteId?: string;
  cleanupFirestore?: boolean;
  firestoreProjectId?: string;
  firestorePrefix?: string;
  silent?: boolean;
  /** Force a site auth mode instead of auto-detecting (default: auto). */
  siteAuthMode?: SiteAuthMode;
  /**
   * HMAC secret for the `x-warehouse-proxy` header. When omitted and the lobby is https,
   * it is read from TICKET_HMAC_SECRET or Secret Manager (TICKET_HMAC_SECRET_NAME, default
   * `projects/<project>/secrets/ticket-hmac-key/versions/latest`). Never hardcode it.
   */
  proxySecret?: string;
}

export interface LiveSmokeReport {
  ok: boolean;
  lobbyHealthOk: boolean;
  /** Lobby path that answered the health check (`/healthz/` or `/api/network`). */
  lobbyHealthPath: string;
  siteAuthMode: SiteAuthMode | '';
  /** Why the selected site auth mode was chosen (e.g. ID token minting error). */
  siteAuthNote: string;
  /** Site path that answered the health check (`/healthz/` or `/api/status`). */
  siteHealthPath: string;
  joinedSiteId: string;
  secondarySiteId: string;
  welcomeReceived: boolean;
  playerId: string;
  vehicleId: string;
  inputsSent: number;
  acksReceived: number;
  deltasReceived: number;
  siteHealthOk: boolean;
  siteStateOk: boolean;
  brainModel: string;
  transferVerified: boolean;
  cleanedPlayerDocs: number;
  durationMs: number;
  errors: string[];
}

export function wsUrlToHttpUrl(wsUrl: string): string {
  const u = new URL(wsUrl);
  const httpProto = u.protocol === 'wss:' ? 'https:' : 'http:';
  const siteParam = u.searchParams.get('site');
  if (u.pathname === '/ws' && siteParam) {
    return `${httpProto}//${u.host}/sites/${siteParam}`;
  }
  u.protocol = httpProto;
  u.pathname = '';
  u.search = '';
  u.hash = '';
  return u.toString().replace(/\/$/, '');
}

/** Prefix every smoke-run identity uses (clientId and, where honoured, display name). */
export const SMOKE_ID_PREFIX = 'smoke-';

/**
 * True when a `players` doc clearly belongs to a smoke run. `smoke-` is a reserved bot name
 * prefix (`BOT_NAME_PREFIXES` in @warehouse/armor), so smoke joins keep their `smoke-…` name
 * and the lobby writes no identity doc for them; a doc only appears when the site persists
 * run stats (keyed by clientId). Every smoke tool therefore marks both the name and the
 * clientId (live `smoke-client-*`, armor `smoke-armor-*`, UI `smoke-ui-*`); either matches.
 */
export function isSmokePlayerDoc(docId: string, data: unknown): boolean {
  const rec = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const name = typeof rec.name === 'string' ? rec.name : '';
  const clientId = typeof rec.clientId === 'string' ? rec.clientId : '';
  return [docId, clientId, name].some((v) => v.startsWith(SMOKE_ID_PREFIX));
}

export async function cleanupSmokePlayers(options: {
  projectId?: string;
  prefix?: string;
  /** Collection suffix (lobby/site use `players${SUFFIX}`; '' in prod, '-stg' in staging). */
  suffix?: string;
}): Promise<number> {
  const projectId = options.projectId ?? process.env.GCP_PROJECT_ID ?? 'davenporter-freightfloor';
  const prefix = options.prefix ?? process.env.FIRESTORE_PREFIX ?? '';
  const suffix = options.suffix ?? process.env.SUFFIX ?? '';
  const db = new Firestore({ projectId });
  const col = db.collection(`${prefix}players${suffix}`);
  const snap = await col.get();
  let deleted = 0;
  const batch = db.batch();
  for (const doc of snap.docs) {
    if (isSmokePlayerDoc(doc.id, doc.data())) {
      batch.delete(doc.ref);
      deleted++;
    }
  }
  if (deleted > 0) {
    await batch.commit();
  }
  return deleted;
}

/** Resolves the `x-warehouse-proxy` HMAC secret from env or Secret Manager (never hardcoded). */
export async function resolveProxySecret(projectId: string): Promise<string> {
  const fromEnv =
    process.env.TICKET_HMAC_SECRET || process.env.TICKET_HMAC_KEY || process.env.TICKET_SECRET;
  if (fromEnv) return fromEnv;
  const name =
    process.env.TICKET_HMAC_SECRET_NAME ||
    `projects/${projectId}/secrets/ticket-hmac-key/versions/latest`;
  const client = new SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({ name });
  const payload = version.payload?.data
    ? Buffer.from(version.payload.data).toString('utf8').trim()
    : '';
  if (payload.length < 16) {
    throw new Error(`Secret ${name} is empty or too short to be the ticket HMAC key`);
  }
  return payload;
}

/** Converts a stored site URL (ws/wss/http/https, optional `/ws`) to its HTTP base URL. */
export function siteUrlToHttpBase(raw: string): string {
  const trimmed = raw.trim().replace(/\/ws(\?.*)?$/, '').replace(/\/$/, '');
  if (trimmed.startsWith('wss://')) return `https://${trimmed.slice('wss://'.length)}`;
  if (trimmed.startsWith('ws://')) return `http://${trimmed.slice('ws://'.length)}`;
  return trimmed;
}

/**
 * Resolves a site's direct Cloud Run base URL from SITE_URLS_JSON or the Firestore
 * `sites` heartbeat docs. Returns null when no direct URL is known.
 */
export async function resolveDirectSiteHttpUrl(
  siteId: SiteId,
  projectId: string,
  prefix: string,
): Promise<string | null> {
  const rawMap = process.env.SITE_URLS_JSON;
  if (rawMap) {
    const parsed = JSON.parse(rawMap) as Record<string, unknown>;
    const v = parsed[siteId];
    if (typeof v === 'string' && v) return siteUrlToHttpBase(v);
  }
  const db = new Firestore({ projectId });
  const snap = await db.collection(`${prefix}sites`).get();
  for (const doc of snap.docs) {
    const data = doc.data();
    const id = data.id || data.siteId || doc.id;
    if (id !== siteId) continue;
    const url =
      typeof data.wsUrl === 'string'
        ? data.wsUrl
        : typeof data.url === 'string'
          ? data.url
          : '';
    if (url && !url.includes('localhost') && !url.includes('127.0.0.1')) {
      return siteUrlToHttpBase(url);
    }
  }
  return null;
}

interface SiteAccessContext {
  lobbyUrl: string;
  mode: SiteAuthMode;
  proxySecret?: string;
  projectId: string;
  prefix: string;
  auth: GoogleAuth;
}

export interface SiteClient {
  siteId: SiteId;
  mode: SiteAuthMode;
  baseUrl: string;
  fetch(path: string, init?: { method?: string; body?: unknown }): Promise<Response>;
}

function headerValue(headers: unknown, key: string): string | undefined {
  if (headers && typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(key) ?? undefined;
  }
  const rec = headers as Record<string, string> | undefined;
  return rec?.[key] ?? rec?.[key.toLowerCase()];
}

async function mintIdTokenHeader(auth: GoogleAuth, audience: string): Promise<string> {
  const client = await auth.getIdTokenClient(audience);
  const reqHeaders = await client.getRequestHeaders(audience);
  const authz = headerValue(reqHeaders, 'Authorization');
  if (!authz) throw new Error(`ID token client returned no Authorization header for ${audience}`);
  return authz;
}

async function createSiteClient(ctx: SiteAccessContext, siteId: SiteId): Promise<SiteClient> {
  let baseUrl = `${ctx.lobbyUrl}/sites/${siteId}`;
  if (ctx.mode === 'idtoken') {
    const direct = await resolveDirectSiteHttpUrl(siteId, ctx.projectId, ctx.prefix);
    if (!direct) throw new Error(`No direct Cloud Run URL known for site ${siteId}`);
    baseUrl = direct;
  }
  return {
    siteId,
    mode: ctx.mode,
    baseUrl,
    async fetch(path, init) {
      const headers: Record<string, string> = {};
      if (ctx.proxySecret) {
        headers[PROXY_HEADER_NAME] = signProxyHeader(siteId, ctx.proxySecret);
      }
      if (ctx.mode === 'idtoken') {
        headers.authorization = await mintIdTokenHeader(ctx.auth, baseUrl);
      }
      if (init?.body !== undefined) headers['content-type'] = 'application/json';
      return fetch(`${baseUrl}${path}`, {
        method: init?.method ?? 'GET',
        headers,
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    },
  };
}

/**
 * Picks the site auth mode: `idtoken` when ADC can mint an ID token for the site's direct
 * Cloud Run URL, otherwise an explicit, logged fallback to `lobby-proxy`.
 */
async function selectSiteAuthMode(
  ctx: Omit<SiteAccessContext, 'mode'>,
  siteId: SiteId,
  remote: boolean,
  forced?: SiteAuthMode,
): Promise<{ mode: SiteAuthMode; note: string }> {
  if (forced) return { mode: forced, note: 'forced via options.siteAuthMode' };
  if (!remote) {
    return { mode: 'lobby-proxy', note: 'local http lobby: site checks routed via /sites/:siteId' };
  }
  try {
    // Probe ID token capability first (audience = lobby origin) so user-account ADC
    // falls back without touching Firestore.
    await mintIdTokenHeader(ctx.auth, ctx.lobbyUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { mode: 'lobby-proxy', note: `fallback: ADC cannot mint ID token (${msg.slice(0, 200)})` };
  }
  let direct: string | null;
  try {
    direct = await resolveDirectSiteHttpUrl(siteId, ctx.projectId, ctx.prefix);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      mode: 'lobby-proxy',
      note: `fallback: could not resolve direct Cloud Run URL for ${siteId} (${msg.slice(0, 200)})`,
    };
  }
  if (!direct) {
    return {
      mode: 'lobby-proxy',
      note: `fallback: no direct Cloud Run URL for ${siteId} in SITE_URLS_JSON or Firestore sites docs`,
    };
  }
  await mintIdTokenHeader(ctx.auth, direct);
  return { mode: 'idtoken', note: `ADC minted ID token for ${direct}` };
}

export interface SiteAccessOptions {
  lobbyUrl: string;
  /** Site used to probe ID-token capability / direct URL resolution. */
  probeSiteId: SiteId;
  projectId?: string;
  prefix?: string;
  siteAuthMode?: SiteAuthMode;
  proxySecret?: string;
}

export interface SiteAccess {
  mode: SiteAuthMode;
  note: string;
  clientFor(siteId: SiteId): Promise<SiteClient>;
}

/**
 * Shared authenticated access to private site services for every smoke tool: resolves the
 * `x-warehouse-proxy` HMAC secret (env / Secret Manager) for https lobbies, selects
 * `idtoken` vs explicit `lobby-proxy` fallback, and hands out per-site fetch clients.
 */
export async function openSiteAccess(opts: SiteAccessOptions): Promise<SiteAccess> {
  const lobbyUrl = opts.lobbyUrl.replace(/\/$/, '');
  const remote = lobbyUrl.startsWith('https://');
  const projectId = opts.projectId ?? process.env.GCP_PROJECT_ID ?? 'davenporter-freightfloor';
  const prefix = opts.prefix ?? process.env.FIRESTORE_PREFIX ?? '';
  const proxySecret = opts.proxySecret ?? (remote ? await resolveProxySecret(projectId) : undefined);
  const auth = new GoogleAuth();
  const selected = await selectSiteAuthMode(
    { lobbyUrl, proxySecret, projectId, prefix, auth },
    opts.probeSiteId,
    remote,
    opts.siteAuthMode,
  );
  const ctx: SiteAccessContext = { lobbyUrl, mode: selected.mode, proxySecret, projectId, prefix, auth };
  return {
    mode: selected.mode,
    note: selected.note,
    clientFor: (siteId) => createSiteClient(ctx, siteId),
  };
}

async function connectAndWelcome(
  wsUrl: string,
  ticket: string,
  onMessage?: (msg: ServerMessage) => void,
  timeoutMs = 5000
): Promise<{
  ws: WebSocket;
  welcome: Extract<ServerMessage, { type: 'welcome' }>;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.terminate();
        reject(new Error(`Timed out waiting for welcome from ${wsUrl}`));
      }
    }, timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', ticket }));
    });

    ws.on('message', (raw) => {
      try {
        const parsedJson = JSON.parse(raw.toString());
        const parsed = ServerMessageSchema.safeParse(parsedJson);
        const msg: ServerMessage = parsed.success ? parsed.data : (parsedJson as ServerMessage);
        if (onMessage) onMessage(msg);
        if (!settled && msg.type === 'welcome') {
          settled = true;
          clearTimeout(timer);
          resolve({ ws, welcome: msg });
        } else if (!settled && msg.type === 'error') {
          settled = true;
          clearTimeout(timer);
          ws.close();
          reject(new Error(`Server error before welcome: ${msg.code} - ${msg.message}`));
        }
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          ws.close();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });

    ws.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

export async function runLiveSmoke(options: LiveSmokeOptions): Promise<LiveSmokeReport> {
  const startedAt = Date.now();
  const lobbyUrl = options.lobbyUrl.replace(/\/$/, '');
  const driveDurationMs = options.driveDurationMs ?? 10_000;
  const inputIntervalMs = options.inputIntervalMs ?? 100;
  const targetSecondarySite = options.secondarySiteId ?? 'slc-2';

  const report: LiveSmokeReport = {
    ok: false,
    lobbyHealthOk: false,
    lobbyHealthPath: '',
    siteAuthMode: '',
    siteAuthNote: '',
    siteHealthPath: '',
    joinedSiteId: '',
    secondarySiteId: targetSecondarySite,
    welcomeReceived: false,
    playerId: '',
    vehicleId: '',
    inputsSent: 0,
    acksReceived: 0,
    deltasReceived: 0,
    siteHealthOk: false,
    siteStateOk: false,
    brainModel: '',
    transferVerified: false,
    cleanedPlayerDocs: 0,
    durationMs: 0,
    errors: [],
  };

  let primaryWs: WebSocket | null = null;
  let secondaryWs: WebSocket | null = null;

  const projectId =
    options.firestoreProjectId ?? process.env.GCP_PROJECT_ID ?? 'davenporter-freightfloor';
  const prefix = options.firestorePrefix ?? process.env.FIRESTORE_PREFIX ?? '';

  try {
    // 1. Check <lobby-url>/healthz/ — Google Front End intercepts the exact path `/healthz`
    //    on *.a.run.app, so probe with a trailing slash. Older lobbies without the
    //    `/healthz/` alias serve the SPA (HTML) or 404 there; fall back to /api/network
    //    and record which path answered.
    const lobbyHealthRes = await fetch(`${lobbyUrl}/healthz/`);
    const lobbyHealthIsJson = (lobbyHealthRes.headers.get('content-type') ?? '').includes(
      'application/json',
    );
    if (lobbyHealthRes.status === 200 && lobbyHealthIsJson) {
      const lobbyHealthBody = (await lobbyHealthRes.json()) as { ok?: boolean };
      if (!lobbyHealthBody.ok) {
        throw new Error('Lobby /healthz/ did not return { ok: true }');
      }
      report.lobbyHealthOk = true;
      report.lobbyHealthPath = '/healthz/';
    } else if (lobbyHealthRes.status === 404 || lobbyHealthRes.status === 200) {
      const lobbyNetRes = await fetch(`${lobbyUrl}/api/network`);
      if (lobbyNetRes.status !== 200) {
        throw new Error(`Lobby /api/network returned HTTP ${lobbyNetRes.status}`);
      }
      const lobbyNetBody = (await lobbyNetRes.json()) as { sites?: unknown[] };
      if (!Array.isArray(lobbyNetBody.sites)) {
        throw new Error('Lobby /api/network did not return { sites: [...] }');
      }
      report.lobbyHealthOk = true;
      report.lobbyHealthPath = '/api/network';
    } else {
      throw new Error(`Lobby /healthz/ returned HTTP ${lobbyHealthRes.status}`);
    }

    // 2. Join Lobby as smoke-driver-1
    const clientId = `smoke-client-${Date.now()}`;
    const joinRes = await fetch(`${lobbyUrl}/api/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'smoke-driver-1',
        clientId,
      }),
    });
    if (joinRes.status !== 200) {
      const errText = await joinRes.text();
      throw new Error(`Lobby POST /api/join returned HTTP ${joinRes.status}: ${errText}`);
    }
    const joinBody = (await joinRes.json()) as {
      siteId: string;
      wsUrl: string;
      ticket: string;
    };
    if (!joinBody.siteId || !joinBody.wsUrl || !joinBody.ticket) {
      throw new Error(`Invalid /api/join response: ${JSON.stringify(joinBody)}`);
    }
    report.joinedSiteId = joinBody.siteId;

    // 3. Connect WS to primary site, send hello { ticket }, await welcome
    const primaryConn = await connectAndWelcome(joinBody.wsUrl, joinBody.ticket, (msg) => {
      if (msg.type === 'ack') {
        report.acksReceived++;
      } else if (msg.type === 'delta') {
        report.deltasReceived++;
      }
    });
    primaryWs = primaryConn.ws;
    report.welcomeReceived = true;
    report.playerId = primaryConn.welcome.you.playerId ?? primaryConn.welcome.you.clientId;
    report.vehicleId = primaryConn.welcome.you.vid ?? '';

    // 4. Drive assigned vehicle for driveDurationMs sending input frames (seq: 1..N)
    const driveSteps = Math.max(2, Math.floor(driveDurationMs / inputIntervalMs));
    for (let seq = 1; seq <= driveSteps; seq++) {
      if (primaryWs.readyState === WebSocket.OPEN) {
        const phase = seq % 4;
        primaryWs.send(
          JSON.stringify({
            type: 'input',
            up: true,
            down: false,
            left: phase === 1,
            right: phase === 3,
            seq,
          })
        );
        report.inputsSent++;
      }
      await new Promise((r) => setTimeout(r, inputIntervalMs));
    }

    if (report.acksReceived === 0) {
      report.errors.push('Expected >= 1 ack message during driving, received 0');
    }
    if (report.deltasReceived === 0) {
      report.errors.push('Expected >= 1 delta message during driving, received 0');
    }

    // 5. Site checks. Site services are private on Cloud Run, so authenticate: ID token
    //    directly to the site when ADC can mint one, else explicit fallback via the lobby
    //    gateway (/sites/:siteId/...). Both paths carry the x-warehouse-proxy HMAC header
    //    (secret from env/Secret Manager) required by the site's /api/* and /internal/*.
    const primarySite = SiteIdSchema.parse(report.joinedSiteId);
    const siteAccess = await openSiteAccess({
      lobbyUrl,
      probeSiteId: primarySite,
      projectId,
      prefix,
      siteAuthMode: options.siteAuthMode,
      proxySecret: options.proxySecret,
    });
    const selected = { mode: siteAccess.mode, note: siteAccess.note };
    report.siteAuthMode = selected.mode;
    report.siteAuthNote = selected.note;
    const primarySiteClient = await siteAccess.clientFor(primarySite);

    // Health: `/healthz/` (GFE intercepts exact `/healthz` on *.a.run.app); `/api/status`
    // when the target has no trailing-slash health alias (direct site, or older lobby).
    let siteHealthRes = await primarySiteClient.fetch('/healthz/');
    report.siteHealthPath = '/healthz/';
    if (siteHealthRes.status === 404) {
      siteHealthRes = await primarySiteClient.fetch('/api/status');
      report.siteHealthPath = '/api/status';
    }
    if (siteHealthRes.status !== 200) {
      report.errors.push(
        `Site ${report.siteHealthPath} (${selected.mode}) returned HTTP ${siteHealthRes.status}: ${(await siteHealthRes.text()).slice(0, 200)}`,
      );
    } else {
      const siteHealth = (await siteHealthRes.json()) as {
        ok?: boolean;
        brainHealth?: { model?: string };
      };
      report.siteHealthOk = Boolean(siteHealth.ok);
      if (siteHealth.brainHealth?.model) {
        report.brainModel = siteHealth.brainHealth.model;
      }
    }

    const siteStateRes = await primarySiteClient.fetch('/api/state');
    if (siteStateRes.status !== 200) {
      report.errors.push(
        `Site /api/state (${selected.mode}) returned HTTP ${siteStateRes.status}: ${(await siteStateRes.text()).slice(0, 200)}`,
      );
    } else {
      const siteState = (await siteStateRes.json()) as {
        ok?: boolean;
        brainHealth?: { model?: string };
      };
      report.siteStateOk = Boolean(siteState.ok);
      if (siteState.brainHealth?.model) {
        report.brainModel = siteState.brainHealth.model;
      }
    }

    if (report.brainModel !== 'gemini-3.5-flash-lite') {
      report.errors.push(
        `Expected brainHealth.model === 'gemini-3.5-flash-lite', got '${report.brainModel}'`
      );
    }

    // 6. Cross-site transfer verification (e.g. den-1 -> slc-2)
    const netRes = await fetch(`${lobbyUrl}/api/network`);
    if (netRes.status !== 200) {
      report.errors.push(`Lobby /api/network returned HTTP ${netRes.status}`);
    } else {
      const netBody = (await netRes.json()) as {
        sites?: Array<{ id: string; wsUrl?: string }>;
      };
      const foundSec =
        netBody.sites?.find((s) => s.id === targetSecondarySite) ??
        netBody.sites?.find((s) => s.id !== report.joinedSiteId);
      if (foundSec) {
        report.secondarySiteId = foundSec.id;
      }
    }

    const secondarySite = SiteIdSchema.parse(report.secondarySiteId);
    const secondarySiteClient = await siteAccess.clientFor(secondarySite);

    // Wake the secondary site first (it may be idle on break).
    const wakeRes = await secondarySiteClient.fetch('/internal/wake', {
      method: 'POST',
      body: { immediate: true },
    });
    if (wakeRes.status !== 200) {
      report.errors.push(
        `Secondary site POST /internal/wake (${selected.mode}) returned HTTP ${wakeRes.status}: ${(await wakeRes.text()).slice(0, 200)}`,
      );
    }

    const joinSecRes = await fetch(`${lobbyUrl}/api/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'smoke-driver-2',
        clientId: `smoke-client-2-${Date.now()}`,
        prefer: report.secondarySiteId,
      }),
    });
    if (joinSecRes.status !== 200) {
      report.errors.push(`Secondary site join returned HTTP ${joinSecRes.status}`);
    } else {
      const joinSecBody = (await joinSecRes.json()) as {
        siteId: string;
        wsUrl: string;
        ticket: string;
      };
      if (joinSecBody.siteId === report.secondarySiteId) {
        const secConn = await connectAndWelcome(joinSecBody.wsUrl, joinSecBody.ticket);
        secondaryWs = secConn.ws;
      }

      // Deliver a cross-site transfer from primary site to secondary site
      const transferId = `TRF-SMOKE-${Date.now()}`;
      const transferPayload = {
        id: transferId,
        fromSite: report.joinedSiteId,
        toSite: report.secondarySiteId,
        orderRef: 'ORD-SMOKE-XFER',
        sku: 'SKU-SMOKE-01',
        value: 150,
        shippedAt: Math.floor(Date.now() / 1000),
        carrier: 'truck' as const,
      };
      const xferRes = await secondarySiteClient.fetch('/internal/transfer', {
        method: 'POST',
        body: transferPayload,
      });
      if (xferRes.status !== 200) {
        report.errors.push(
          `Secondary site POST /internal/transfer (${selected.mode}) returned HTTP ${xferRes.status}: ${(await xferRes.text()).slice(0, 200)}`
        );
      } else {
        const xferBody = (await xferRes.json()) as {
          ok?: boolean;
          orderId?: string | null;
          transfersIn?: number;
        };
        const secStateRes = await secondarySiteClient.fetch('/api/state');
        if (secStateRes.status !== 200) {
          report.errors.push(
            `Secondary site /api/state (${selected.mode}) returned HTTP ${secStateRes.status}: ${(await secStateRes.text()).slice(0, 200)}`,
          );
        } else {
          const secState = (await secStateRes.json()) as {
            ok?: boolean;
            snapshot?: {
              stats?: { transfersIn?: number };
              orders?: Array<{ id: string; fromSite?: string }>;
            };
          };
          const hasTransferOrder = Boolean(
            secState.snapshot?.orders?.some(
              (o) => o.id === xferBody.orderId || o.fromSite === report.joinedSiteId
            )
          );
          if (xferBody.ok && (hasTransferOrder || (secState.snapshot?.stats?.transfersIn ?? 0) >= 1)) {
            report.transferVerified = true;
          } else {
            report.errors.push('Cross-site transfer did not appear in secondary site state');
          }
        }
      }
    }
  } catch (err) {
    report.errors.push(err instanceof Error ? err.message : String(err));
  } finally {
    if (primaryWs && primaryWs.readyState === WebSocket.OPEN) {
      primaryWs.close();
    }
    if (secondaryWs && secondaryWs.readyState === WebSocket.OPEN) {
      secondaryWs.close();
    }
    if (options.cleanupFirestore) {
      try {
        report.cleanedPlayerDocs = await cleanupSmokePlayers({
          projectId: options.firestoreProjectId,
          prefix: options.firestorePrefix,
        });
      } catch (err) {
        // Cleanup was explicitly requested; surface the failure instead of skipping silently.
        report.errors.push(
          `Firestore smoke-* cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  report.durationMs = Date.now() - startedAt;
  report.ok =
    report.lobbyHealthOk &&
    report.welcomeReceived &&
    report.acksReceived > 0 &&
    report.deltasReceived > 0 &&
    report.siteHealthOk &&
    report.siteStateOk &&
    report.brainModel === 'gemini-3.5-flash-lite' &&
    report.transferVerified &&
    report.errors.length === 0;

  if (!options.silent) {
    console.log(JSON.stringify(report, null, 2));
  }

  return report;
}
