import { pathToFileURL } from 'node:url';
import type { SiteId } from '@warehouse/protocol';
import { resolveGeminiModel } from './brain.js';
import { CloudPersistenceStore, InMemoryPersistenceStore } from './persistence.js';
import { createSiteServer } from './server.js';

export const SITE_VERSION = 1;

export * from './persistence.js';
export * from './governance.js';
export * from './brain.js';
export * from './armor-pipeline.js';
export * from './server.js';

export async function startMainServer(): Promise<void> {
  const port = Number(process.env.PORT || 8080);
  const isCloudRun = Boolean(process.env.K_SERVICE);
  const host = process.env.HOST || (isCloudRun ? '0.0.0.0' : '127.0.0.1');
  const siteId = ((process.env.SITE_ID as SiteId) || 'den-1');
  const useCloud =
    process.env.USE_CLOUD_PERSISTENCE === '1' || isCloudRun;

  if (
    isCloudRun &&
    !process.env.TICKET_SECRET &&
    !process.env.TICKET_HMAC_KEY &&
    !process.env.TICKET_HMAC_SECRET
  ) {
    throw new Error(
      `[${siteId}] TICKET_SECRET (or TICKET_HMAC_KEY) must be injected via Secret Manager in Cloud Run`,
    );
  }

  // Fail loudly at boot on a non-allow-listed GEMINI_MODEL instead of
  // erroring on every brain / dispatcher call at runtime.
  const geminiModel = resolveGeminiModel(process.env.GEMINI_MODEL);
  console.log(`[${siteId}] Gemini model: ${geminiModel}`);

  installProcessErrorHandlers(siteId);

  const persistence = useCloud
    ? new CloudPersistenceStore({
        projectId:
          process.env.GOOGLE_CLOUD_PROJECT ||
          process.env.GCP_PROJECT_ID ||
          'davenporter-freightfloor',
      })
    : new InMemoryPersistenceStore();

  const initialAgents = process.env.AGENTS
    ? Number(process.env.AGENTS)
    : undefined;

  const server = await createSiteServer({
    siteId,
    initialAgents,
    persistence,
    wsPublicUrl: process.env.WS_PUBLIC_URL,
    enableIntervals: true,
    restoreFromPersistence: useCloud,
    requireProxyAuth:
      isCloudRun ||
      process.env.REQUIRE_PROXY_AUTH === '1' ||
      process.env.REQUIRE_PROXY_AUTH === 'true',
  });

  const onSignal = async (sig: string) => {
    console.log(`[${siteId}] Received ${sig}, starting graceful shutdown...`);
    await server.gracefulShutdown();
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void onSignal('SIGTERM');
  });
  process.on('SIGINT', () => {
    void onSignal('SIGINT');
  });

  await server.app.listen({ port, host });
  await server.flushHeartbeat();
  console.log(`[${siteId}] Site server listening on http://${host}:${port}`);
}

let processHandlersInstalled = false;

/**
 * A single stray rejection/exception (e.g. a Firestore write failing inside a
 * fire-and-forget path) must not take down an authoritative shard and every
 * connected driver with it. Log loudly and keep serving; the per-path handlers
 * in server.ts surface the real error to clients where applicable.
 */
export function installProcessErrorHandlers(siteId: string): void {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;
  process.on('unhandledRejection', (reason) => {
    console.error(
      `[${siteId}] unhandledRejection:`,
      reason instanceof Error ? reason.stack || reason.message : reason,
    );
  });
  process.on('uncaughtException', (err) => {
    console.error(`[${siteId}] uncaughtException:`, err.stack || err.message);
  });
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  startMainServer().catch((err) => {
    console.error('Fatal error starting site server:', err);
    process.exit(1);
  });
}
