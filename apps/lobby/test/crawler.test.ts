import { describe, expect, it } from 'vitest';
import { buildLobbyServer, InMemoryLobbyStore, isCrawlerUserAgent, type StoredSiteDoc } from '../src/index.js';

const TEST_SECRET = 'test-hmac-secret-key-for-warehouse-lobby-2026';
const NOW = 1_700_000_000_000;

function makeSite(id: StoredSiteDoc['id']): StoredSiteDoc {
  return {
    id,
    state: 'live',
    phase: 'break',
    drivers: 0,
    spectators: 0,
    tier: 1,
    shipped: 0,
    wsUrl: `wss://${id}.warehouse.example/ws`,
    updatedAt: NOW - 2_000,
  };
}

// User agents observed on POST /api/join in production (Cloud Run request logs).
const CRAWLERS = [
  'AdsBot-Google (+http://www.google.com/adsbot.html)',
  'GoogleOther',
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.122 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse',
  'EconomyRadar-SourceAudit/1.0',
  'nvokebot/1.0 (+https://nvoke.run/bot)',
  'PulseWatchBot/0.1 (+public reputation monitoring; contact configured by operator)',
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ShapBot/0.1.0',
];

const HUMANS_AND_HARNESSES = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_3_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/144.0.7559.95 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:158.0) Gecko/20100101 Firefox/158.0',
  'Mozilla/5.0 (Linux; Android 9; Cubot X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.0.0 Safari/537.36',
  'node',
  '',
  undefined,
];

describe('isCrawlerUserAgent', () => {
  it.each(CRAWLERS)('flags crawler: %s', (ua) => {
    expect(isCrawlerUserAgent(ua)).toBe(true);
  });

  it.each(HUMANS_AND_HARNESSES)('allows browser/harness: %s', (ua) => {
    expect(isCrawlerUserAgent(ua)).toBe(false);
  });
});

describe('POST /api/join crawler gate', () => {
  async function build() {
    const store = new InMemoryLobbyStore([makeSite('den-1'), makeSite('slc-2'), makeSite('phx-3'), makeSite('abq-4')]);
    return buildLobbyServer({ store, ticketSecret: TEST_SECRET, now: () => NOW });
  }

  it('refuses crawler joins with 403 and issues no ticket', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/join',
      headers: { 'user-agent': CRAWLERS[0] },
      payload: { clientId: 'crawler-client-1' },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error).toBe('crawler_not_allowed');
    expect(body.ticket).toBeUndefined();
    await app.close();
  });

  it('still admits regular browsers', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/join',
      headers: { 'user-agent': HUMANS_AND_HARNESSES[0] as string },
      payload: { name: 'Alice', clientId: 'client-alice-ua' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ticket).toBeTruthy();
    await app.close();
  });
});
