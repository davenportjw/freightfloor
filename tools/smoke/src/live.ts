import WebSocket from 'ws';
import { Firestore } from '@google-cloud/firestore';
import { ServerMessageSchema, type ServerMessage } from '@warehouse/protocol';

export interface LiveSmokeOptions {
  lobbyUrl: string;
  driveDurationMs?: number;
  inputIntervalMs?: number;
  secondarySiteId?: string;
  cleanupFirestore?: boolean;
  firestoreProjectId?: string;
  firestorePrefix?: string;
  silent?: boolean;
}

export interface LiveSmokeReport {
  ok: boolean;
  lobbyHealthOk: boolean;
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

export async function cleanupSmokePlayers(options: {
  projectId?: string;
  prefix?: string;
}): Promise<number> {
  const projectId = options.projectId ?? process.env.GCP_PROJECT_ID ?? 'davenport-boutique';
  const prefix = options.prefix ?? process.env.FIRESTORE_PREFIX ?? '';
  const db = new Firestore({ projectId });
  const col = db.collection(`${prefix}players`);
  const snap = await col.get();
  let deleted = 0;
  const batch = db.batch();
  for (const doc of snap.docs) {
    const data = doc.data();
    const name = typeof data?.name === 'string' ? data.name : '';
    const clientId = typeof data?.clientId === 'string' ? data.clientId : '';
    if (
      doc.id.startsWith('smoke-') ||
      name.startsWith('smoke-') ||
      clientId.startsWith('smoke-')
    ) {
      batch.delete(doc.ref);
      deleted++;
    }
  }
  if (deleted > 0) {
    await batch.commit();
  }
  return deleted;
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

  try {
    // 1. Check <lobby-url>/healthz (fallback to /api/network when Google Frontend intercepts /healthz on *.a.run.app)
    const lobbyHealthRes = await fetch(`${lobbyUrl}/healthz`);
    if (lobbyHealthRes.status === 200) {
      const lobbyHealthBody = (await lobbyHealthRes.json()) as { ok?: boolean };
      if (!lobbyHealthBody.ok) {
        throw new Error('Lobby /healthz did not return { ok: true }');
      }
      report.lobbyHealthOk = true;
    } else if (lobbyHealthRes.status === 404) {
      const lobbyNetRes = await fetch(`${lobbyUrl}/api/network`);
      if (lobbyNetRes.status !== 200) {
        throw new Error(`Lobby /api/network returned HTTP ${lobbyNetRes.status}`);
      }
      const lobbyNetBody = (await lobbyNetRes.json()) as { sites?: unknown[] };
      if (!Array.isArray(lobbyNetBody.sites)) {
        throw new Error('Lobby /api/network did not return { sites: [...] }');
      }
      report.lobbyHealthOk = true;
    } else {
      throw new Error(`Lobby /healthz returned HTTP ${lobbyHealthRes.status}`);
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

    // 5. Query <site-http-url>/healthz (or /api/status when GFE intercepts /healthz) and <site-http-url>/api/state
    const primaryHttpUrl = wsUrlToHttpUrl(joinBody.wsUrl);
    let siteHealthRes = await fetch(`${primaryHttpUrl}/healthz`);
    if (siteHealthRes.status === 404) {
      siteHealthRes = await fetch(`${primaryHttpUrl}/api/status`);
    }
    if (siteHealthRes.status !== 200) {
      report.errors.push(`Site health endpoint returned HTTP ${siteHealthRes.status}`);
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

    const siteStateRes = await fetch(`${primaryHttpUrl}/api/state`);
    if (siteStateRes.status !== 200) {
      report.errors.push(`Site /api/state returned HTTP ${siteStateRes.status}`);
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
    let secWsUrl = '';
    if (netRes.status === 200) {
      const netBody = (await netRes.json()) as {
        sites?: Array<{ id: string; wsUrl?: string }>;
      };
      const foundSec =
        netBody.sites?.find((s) => s.id === targetSecondarySite) ??
        netBody.sites?.find((s) => s.id !== report.joinedSiteId);
      if (foundSec) {
        report.secondarySiteId = foundSec.id;
        if (foundSec.wsUrl) {
          secWsUrl = foundSec.wsUrl;
        }
      }
    }

    // If we found secondary site wsUrl from /api/network, wake it first
    if (secWsUrl) {
      const secHttpWake = wsUrlToHttpUrl(secWsUrl);
      await fetch(`${secHttpWake}/internal/wake`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ immediate: true }),
      }).catch(() => undefined);
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
      const effectiveSecWsUrl =
        joinSecBody.siteId === report.secondarySiteId || !secWsUrl
          ? joinSecBody.wsUrl
          : secWsUrl;
      if (joinSecBody.siteId === report.secondarySiteId) {
        report.secondarySiteId = joinSecBody.siteId;
      }
      const secondaryHttpUrl = wsUrlToHttpUrl(effectiveSecWsUrl);

      // Ensure secondary site is awake
      await fetch(`${secondaryHttpUrl}/internal/wake`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ immediate: true }),
      }).catch(() => undefined);

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
      const xferRes = await fetch(`${secondaryHttpUrl}/internal/transfer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(transferPayload),
      });
      if (xferRes.status !== 200) {
        report.errors.push(
          `Secondary site POST /internal/transfer returned HTTP ${xferRes.status}`
        );
      } else {
        const xferBody = (await xferRes.json()) as {
          ok?: boolean;
          orderId?: string | null;
          transfersIn?: number;
        };
        const secStateRes = await fetch(`${secondaryHttpUrl}/api/state`);
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
      } catch {
        // Ignore Firestore cleanup error in environments without Firestore
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
