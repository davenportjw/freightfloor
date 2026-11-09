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
