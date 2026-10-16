import { pathToFileURL } from 'node:url';
import type { SiteId } from '@warehouse/protocol';
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
  const host = process.env.HOST || '0.0.0.0';
  const siteId = ((process.env.SITE_ID as SiteId) || 'den-1');
  const useCloud =
    process.env.USE_CLOUD_PERSISTENCE === '1' || Boolean(process.env.K_SERVICE);

  const persistence = useCloud
    ? new CloudPersistenceStore({
        projectId:
          process.env.GOOGLE_CLOUD_PROJECT ||
          process.env.GCP_PROJECT_ID ||
          'davenport-boutique',
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

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  startMainServer().catch((err) => {
    console.error('Fatal error starting site server:', err);
    process.exit(1);
  });
}
