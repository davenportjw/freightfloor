import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prefersMarkdown } from '../src/agentDiscovery.js';
import { buildLobbyServer, InMemoryLobbyStore } from '../src/index.js';

const TEST_SECRET = 'test-hmac-secret-key-for-warehouse-lobby-2026';
const headers = { 'x-forwarded-host': 'freightfloor.com' };

describe('@warehouse/lobby: agent discovery', () => {
  let app: FastifyInstance;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lobby-agents-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Freight Floor</title>');
    writeFileSync(join(dir, 'llms.txt'), '# Freight Floor\n\n> A forklift game.\n');
    app = await buildLobbyServer({
      store: new InMemoryLobbyStore([]),
      ticketSecret: TEST_SECRET,
      gaMeasurementId: null,
      staticDir: dir,
    });
  });

  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('only prefers markdown when it is asked for at least as strongly as HTML', () => {
    expect(prefersMarkdown('text/markdown')).toBe(true);
    expect(prefersMarkdown('text/markdown, text/html;q=0.5')).toBe(true);
    expect(prefersMarkdown('text/html,application/xhtml+xml,*/*;q=0.8')).toBe(false);
    expect(prefersMarkdown('text/html, text/markdown;q=0.5')).toBe(false);
    expect(prefersMarkdown('text/markdown;q=0')).toBe(false);
    expect(prefersMarkdown(undefined)).toBe(false);
  });

  it('serves HTML with Link headers to browsers and markdown to agents', async () => {
    const html = await app.inject({ method: 'GET', url: '/', headers: { ...headers, accept: 'text/html' } });
    expect(html.statusCode).toBe(200);
    expect(html.headers['content-type']).toContain('text/html');
    expect(String(html.headers.link)).toContain('</.well-known/api-catalog>; rel="api-catalog"');
    expect(String(html.headers.vary)).toContain('Accept');

    const md = await app.inject({ method: 'GET', url: '/', headers: { ...headers, accept: 'text/markdown' } });
    expect(md.statusCode).toBe(200);
    expect(md.headers['content-type']).toContain('text/markdown');
    expect(md.body).toContain('# Freight Floor');
    expect(md.body).toContain('https://freightfloor.com/.well-known/agent-skills/freightfloor/SKILL.md');
    expect(String(md.headers.link)).toContain('rel="api-catalog"');
  });

  it('adds Content-Signal and Agentmap to robots.txt', async () => {
    const robots = await app.inject({ method: 'GET', url: '/robots.txt', headers });
    expect(robots.body).toMatch(/User-agent: \*\nContent-Signal: search=yes, ai-input=yes, ai-train=yes\n/);
    expect(robots.body).toContain('Agentmap: https://freightfloor.com/.well-known/ai-catalog.json');
  });

  it('publishes an RFC 9727 API catalog that points at the OpenAPI description', async () => {
    const res = await app.inject({ method: 'GET', url: '/.well-known/api-catalog', headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/linkset+json');
    const entry = res.json().linkset[0];
    expect(entry.anchor).toBe('https://freightfloor.com/api/');
    expect(entry['service-desc'][0].href).toBe('https://freightfloor.com/openapi.json');
    expect(entry.status[0].href).toBe('https://freightfloor.com/healthz/');

    const spec = await app.inject({ method: 'GET', url: '/openapi.json', headers });
    expect(spec.statusCode).toBe(200);
    const doc = JSON.parse(spec.body);
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(['/api/network', '/api/daily', '/healthz/']);
  });

  it('publishes an agent skills index whose digest matches the served SKILL.md', async () => {
    const index = await app.inject({ method: 'GET', url: '/.well-known/agent-skills/index.json', headers });
    expect(index.statusCode).toBe(200);
    const body = index.json();
    expect(body.$schema).toBe('https://schemas.agentskills.io/discovery/0.2.0/schema.json');
    const [skill] = body.skills;
    expect(skill).toMatchObject({ name: 'freightfloor', type: 'skill-md' });

    const md = await app.inject({ method: 'GET', url: new URL(skill.url).pathname, headers });
    expect(md.statusCode).toBe(200);
    expect(md.headers['content-type']).toContain('text/markdown');
    expect(skill.digest).toBe(`sha256:${createHash('sha256').update(md.body, 'utf8').digest('hex')}`);
  });

  it('publishes an ai-catalog with exactly one of url/data per entry and open CORS', async () => {
    const res = await app.inject({ method: 'GET', url: '/.well-known/ai-catalog.json', headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    const body = res.json();
    expect(body.specVersion).toBe('1.0');
    expect(body.host.identifier).toBe('did:web:freightfloor.com');
    for (const e of body.entries) {
      expect(e.identifier).toMatch(/^urn:air:freightfloor\.com:/);
      expect('url' in e !== 'data' in e).toBe(true);
      expect(e.representativeQueries.length).toBeGreaterThanOrEqual(2);
      expect(e.representativeQueries.length).toBeLessThanOrEqual(5);
    }
  });

  it('publishes poppy.json for the requested domain and a self-contained auth.md', async () => {
    const poppy = await app.inject({
      method: 'GET',
      url: '/.well-known/poppy.json',
      headers: { 'x-forwarded-host': 'www.freightfloor.com' },
    });
    expect(poppy.json()).toEqual({
      protocol_version: '0.1',
      organization: { name: 'Freight Floor', domain: 'freightfloor.com' },
      web: {},
    });

    const auth = await app.inject({ method: 'GET', url: '/auth.md', headers });
    expect(auth.statusCode).toBe(200);
    expect(auth.headers['content-type']).toContain('text/markdown');
    expect(auth.body.split('\n')[0]).toMatch(/^# .*auth\.md/);
  });

  it('returns real 404s for unpublished well-known documents instead of the SPA shell', async () => {
    for (const url of ['/.well-known/openid-configuration', '/.well-known/oauth-protected-resource']) {
      const res = await app.inject({ method: 'GET', url, headers });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('<title>');
    }
  });
});

describe('@warehouse/lobby: agent discovery markdown URLs', () => {
  it('never wraps absolute URLs in code spans (scanners read the closing backtick as part of the URL)', async () => {
    const app = await buildLobbyServer({ store: new InMemoryLobbyStore([]), ticketSecret: TEST_SECRET, gaMeasurementId: null });
    try {
      for (const url of ['/auth.md', '/.well-known/agent-skills/freightfloor/SKILL.md']) {
        const res = await app.inject({ method: 'GET', url, headers });
        expect(res.statusCode).toBe(200);
        expect(res.body).not.toMatch(/https?:\/\/[^\s`]*`/);
      }
    } finally {
      await app.close();
    }
  });
});
