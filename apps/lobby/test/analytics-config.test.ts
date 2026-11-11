import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCspHeader,
  buildLobbyServer,
  CSP_HEADER,
  InMemoryLobbyStore,
  resolveGaMeasurementId,
} from '../src/index.js';

const TEST_SECRET = 'test-hmac-secret-key-for-warehouse-lobby-2026';

describe('@warehouse/lobby: GA4 client config', () => {
  it('only accepts well-formed GA4 measurement IDs', () => {
    expect(resolveGaMeasurementId(' G-ABC123XYZ9 ')).toBe('G-ABC123XYZ9');
    expect(resolveGaMeasurementId('')).toBeNull();
    expect(resolveGaMeasurementId('UA-1234-1')).toBeNull();
    expect(resolveGaMeasurementId("G-ABC'; script-src *")).toBeNull();
  });

  it('keeps the strict CSP when GA is off and adds only Google tag hosts when on', () => {
    expect(buildCspHeader(null)).toBe(CSP_HEADER);
    const csp = buildCspHeader('G-ABC123XYZ9');
    expect(csp).toContain(
      "script-src 'self' https://static.cloudflareinsights.com https://*.googletagmanager.com;",
    );
    expect(csp).toContain('https://*.google-analytics.com');
    expect(csp).toContain("connect-src 'self' ws: wss: https://cloudflareinsights.com");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it('always allows the edge-injected Cloudflare Web Analytics beacon', () => {
    for (const csp of [CSP_HEADER, buildCspHeader('G-ABC123XYZ9')]) {
      expect(csp).toMatch(/script-src [^;]*https:\/\/static\.cloudflareinsights\.com/);
      expect(csp).toMatch(/connect-src [^;]*https:\/\/cloudflareinsights\.com/);
    }
    expect(CSP_HEADER).not.toContain('google');
  });

  it('serves the measurement ID at /api/config and sends the matching CSP', async () => {
    const app = await buildLobbyServer({
      store: new InMemoryLobbyStore([]),
      ticketSecret: TEST_SECRET,
      gaMeasurementId: 'G-ABC123XYZ9',
    });
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ gaMeasurementId: 'G-ABC123XYZ9' });
    expect(res.headers['content-security-policy']).toBe(buildCspHeader('G-ABC123XYZ9'));
    await app.close();
  });

  it('reports null (and the strict CSP) when GA is not configured', async () => {
    const app = await buildLobbyServer({
      store: new InMemoryLobbyStore([]),
      ticketSecret: TEST_SECRET,
      gaMeasurementId: null,
    });
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    expect(res.json()).toEqual({ gaMeasurementId: null });
    expect(res.headers['content-security-policy']).toBe(CSP_HEADER);
    await app.close();
  });
});

describe('@warehouse/lobby: crawler files', () => {
  it('serves robots.txt and a one-page sitemap for the forwarded public host', async () => {
    const app = await buildLobbyServer({
      store: new InMemoryLobbyStore([]),
      ticketSecret: TEST_SECRET,
      gaMeasurementId: null,
    });
    const headers = { 'x-forwarded-host': 'freightfloor.com' };
    const robots = await app.inject({ method: 'GET', url: '/robots.txt', headers });
    expect(robots.statusCode).toBe(200);
    expect(robots.headers['content-type']).toContain('text/plain');
    expect(robots.body).toContain('Disallow: /api/');
    expect(robots.body).toContain('Sitemap: https://freightfloor.com/sitemap.xml');

    const sitemap = await app.inject({ method: 'GET', url: '/sitemap.xml', headers });
    expect(sitemap.statusCode).toBe(200);
    expect(sitemap.headers['content-type']).toContain('application/xml');
    expect(sitemap.body).toContain('<loc>https://freightfloor.com/</loc>');

    const evil = await app.inject({
      method: 'GET',
      url: '/sitemap.xml',
      headers: { 'x-forwarded-host': 'x"><script>' },
    });
    expect(evil.body).not.toContain('<script>');
    expect(evil.body).toContain('<loc>https://freightfloor.com/</loc>');
    await app.close();
  });

  it('points robots.txt at llms.txt', async () => {
    const app = await buildLobbyServer({
      store: new InMemoryLobbyStore([]),
      ticketSecret: TEST_SECRET,
      gaMeasurementId: null,
    });
    const robots = await app.inject({
      method: 'GET',
      url: '/robots.txt',
      headers: { 'x-forwarded-host': 'freightfloor.com' },
    });
    expect(robots.body).toContain('# LLMs: https://freightfloor.com/llms.txt');
    await app.close();
  });

  it('serves real 404s for missing files but falls back to index.html for page paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lobby-static-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Freight Floor</title>');
    writeFileSync(join(dir, 'llms.txt'), '# Freight Floor\n');
    const app = await buildLobbyServer({
      store: new InMemoryLobbyStore([]),
      ticketSecret: TEST_SECRET,
      gaMeasurementId: null,
      staticDir: dir,
    });
    try {
      const llms = await app.inject({ method: 'GET', url: '/llms.txt' });
      expect(llms.statusCode).toBe(200);
      expect(llms.body).toContain('# Freight Floor');

      const missing = await app.inject({ method: 'GET', url: '/apple-touch-icon.png?v=1' });
      expect(missing.statusCode).toBe(404);
      expect(missing.body).not.toContain('<title>');

      const page = await app.inject({ method: 'GET', url: '/play?site=site-den-1' });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('<title>Freight Floor</title>');
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
