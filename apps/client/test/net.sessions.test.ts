import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backoffDelay,
  isStaleJoin,
  NetClient,
  POLICY_CLOSE_RETRY_MS,
  RECONNECT_BASE_MS,
  RECONNECT_JITTER,
  RECONNECT_MAX_MS,
  StaleJoinError,
  type NetStatus,
} from '../src/net.js';

/** Minimal stand-in for the browser WebSocket: records instances, never connects on its own. */
class TestSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: TestSocket[] = [];
  readyState = TestSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    TestSocket.instances.push(this);
  }
  send(s: string): void {
    this.sent.push(s);
  }
  close(): void {
    this.readyState = TestSocket.CLOSED;
  }
  accept(): void {
    this.readyState = TestSocket.OPEN;
    this.onopen?.();
  }
  serverClose(code: number, reason = ''): void {
    this.readyState = TestSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
  welcome(): void {
    this.onmessage?.({ data: JSON.stringify({ type: 'welcome' }) });
  }
}

const joinFor = (siteId: string) => ({ siteId, wsUrl: `/ws?site=${siteId}`, ticket: `t-${siteId}`, expiresAt: 0, clientId: 'c' });

/** Lobby fake: answers `/api/join` with the `prefer`red site (den-1 by default). */
function lobbyFetch() {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as { prefer?: string }) : {};
    return new Response(JSON.stringify(joinFor(body.prefer ?? 'den-1')), { status: 200 });
  });
}

function makeNet(statuses: NetStatus[] = []) {
  return new NetClient(() => ({ clientId: 'c' }), { onStatus: (s) => statuses.push(s), onMessage: () => {} });
}

describe('backoffDelay jitter', () => {
  it('stays within ±30% of the exponential base and caps at RECONNECT_MAX_MS', () => {
    expect(RECONNECT_JITTER).toBe(0.3);
    expect(backoffDelay(0, () => 0)).toBe(Math.round(RECONNECT_BASE_MS * 0.7));
    expect(backoffDelay(0, () => 1)).toBe(Math.round(RECONNECT_BASE_MS * 1.3));
    expect(backoffDelay(0, () => 0.5)).toBe(RECONNECT_BASE_MS);
    expect(backoffDelay(20, () => 1)).toBe(Math.round(RECONNECT_MAX_MS * 1.3));
    const seen = new Set(Array.from({ length: 20 }, () => backoffDelay(3)));
    expect(seen.size).toBeGreaterThan(1); // not lockstep
  });
});

describe('NetClient site moves, join races and reconnect policy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    TestSocket.instances = [];
    vi.stubGlobal('WebSocket', TestSocket);
    vi.stubGlobal('fetch', lobbyFetch());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('switching site opens a new socket to the new site (no re-hello on the old shard)', async () => {
    const net = makeNet();
    await net.join('den-1');
    const den = TestSocket.instances[0]!;
    den.accept();
    expect(den.url).toContain('den-1');

    await net.join('slc-2');
    expect(TestSocket.instances).toHaveLength(2);
    const slc = TestSocket.instances[1]!;
    expect(slc.url).toContain('slc-2');
    expect(den.readyState).toBe(TestSocket.CLOSED);
    // The old socket got exactly one hello (its own), never the slc ticket.
    expect(den.sent.filter((s) => s.includes('t-slc-2'))).toHaveLength(0);
    slc.accept();
    expect(slc.sent[0]).toContain('t-slc-2');
    net.stop();
  });

  it('re-hellos on the open socket only for the same site', async () => {
    const net = makeNet();
    await net.join('den-1');
    const den = TestSocket.instances[0]!;
    den.accept();
    await net.join('den-1');
    expect(TestSocket.instances).toHaveLength(1);
    expect(den.sent.filter((s) => s.includes('"hello"'))).toHaveLength(2);
    net.stop();
  });

  it('relocateShard ticket (joinWithTicket) always opens a fresh socket on the target', async () => {
    const net = makeNet();
    await net.join('den-1');
    TestSocket.instances[0]!.accept();
    net.joinWithTicket('phx-3', 'relo-ticket', Date.now() + 60_000);
    expect(TestSocket.instances).toHaveLength(2);
    const phx = TestSocket.instances[1]!;
    expect(phx.url).toContain('phx-3');
    phx.accept();
    expect(phx.sent[0]).toContain('relo-ticket');
    expect(net.siteId).toBe('phx-3');
    net.stop();
  });

  it('overlapping joins: the superseded one rejects with StaleJoinError and only the newest opens a socket', async () => {
    const resolvers: Array<() => void> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { prefer?: string };
        return new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          resolvers.push(() => resolve(new Response(JSON.stringify(joinFor(body.prefer ?? 'den-1')), { status: 200 })));
        });
      }),
    );
    const net = makeNet();
    const first = net.join('den-1');
    const second = net.join('slc-2');
    resolvers[1]!();
    await expect(second).resolves.toMatchObject({ siteId: 'slc-2' });
    const err = await first.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleJoinError);
    expect(isStaleJoin(err)).toBe(true);
    expect(TestSocket.instances).toHaveLength(1);
    expect(TestSocket.instances[0]!.url).toContain('slc-2');
    net.stop();
  });

  it('does not reset the backoff on open; only a welcome resets it', async () => {
    const statuses: NetStatus[] = [];
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // no jitter: exact base delays
    const net = makeNet(statuses);
    await net.join('den-1');
    const retries = (): number[] =>
      statuses.flatMap((s) => (s.kind === 'retrying' ? [s.inMs] : []));

    // Open then immediately closed (generic code) three times: delays keep doubling.
    for (let i = 0; i < 3; i++) {
      const sock = TestSocket.instances.at(-1)!;
      sock.accept();
      sock.serverClose(1006);
      await vi.advanceTimersByTimeAsync(retries().at(-1)! + 1);
    }
    expect(retries()).toEqual([500, 1000, 2000]);

    // A welcome resets the counter: the next drop starts from the base delay again.
    const sock = TestSocket.instances.at(-1)!;
    sock.accept();
    sock.welcome();
    sock.serverClose(1006);
    expect(retries().at(-1)).toBe(500);
    net.stop();
  });

  it('4008 (site full) and 4003 (rejected) wait at least POLICY_CLOSE_RETRY_MS and say why', async () => {
    const statuses: NetStatus[] = [];
    const net = makeNet(statuses);
    await net.join('den-1');
    const sock = TestSocket.instances[0]!;
    sock.accept();
    sock.serverClose(4008, 'Site full');
    const retry = statuses.at(-1)!;
    expect(retry.kind).toBe('retrying');
    if (retry.kind !== 'retrying') return;
    expect(retry.inMs).toBeGreaterThanOrEqual(POLICY_CLOSE_RETRY_MS);
    expect(retry.reason).toMatch(/^Site full/);

    // Nothing reconnects in the old 500 ms cadence.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(TestSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(POLICY_CLOSE_RETRY_MS);
    expect(TestSocket.instances).toHaveLength(2);

    TestSocket.instances[1]!.accept();
    TestSocket.instances[1]!.serverClose(4003, 'Ticket consumed');
    const r2 = statuses.at(-1)!;
    expect(r2.kind === 'retrying' && r2.inMs).toBeGreaterThanOrEqual(POLICY_CLOSE_RETRY_MS);
    expect(r2.kind === 'retrying' && r2.reason).toMatch(/Connection rejected: Ticket consumed/);
    net.stop();
  });
});
