import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECT_TIMEOUT_MS, NetClient, type NetStatus } from '../src/net.js';

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
}

const joinBody = { siteId: 'den-1', wsUrl: '/ws?site=den-1', ticket: 't', expiresAt: 0, clientId: 'c' };

describe('NetClient connect watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    TestSocket.instances = [];
    vi.stubGlobal('WebSocket', TestSocket);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(joinBody), { status: 200 })));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('abandons a socket stuck in CONNECTING and reconnects with backoff', async () => {
    const statuses: NetStatus[] = [];
    const net = new NetClient(() => ({ clientId: 'c' }), { onStatus: (s) => statuses.push(s), onMessage: () => {} });
    await net.join('den-1', undefined, undefined, true);
    expect(TestSocket.instances).toHaveLength(1);
    const stuck = TestSocket.instances[0]!;

    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS + 1);
    expect(stuck.readyState).toBe(TestSocket.CLOSED);
    const retry = statuses.find((s) => s.kind === 'retrying');
    expect(retry && retry.kind === 'retrying' && retry.reason).toMatch(/timed out/);

    // The backoff timer re-joins through the lobby and opens a fresh socket.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(TestSocket.instances.length).toBeGreaterThanOrEqual(2);
    const fresh = TestSocket.instances[1]!;
    fresh.accept();
    expect(fresh.sent[0]).toContain('"hello"');
    expect(statuses.at(-1)).toEqual({ kind: 'open', siteId: 'den-1' });
    net.stop();
  });

  it('leaves a socket that opens in time alone', async () => {
    const statuses: NetStatus[] = [];
    const net = new NetClient(() => ({ clientId: 'c' }), { onStatus: (s) => statuses.push(s), onMessage: () => {} });
    await net.join('den-1');
    TestSocket.instances[0]!.accept();
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS * 2);
    expect(TestSocket.instances).toHaveLength(1);
    expect(statuses.some((s) => s.kind === 'retrying')).toBe(false);
    expect(net.isOpen).toBe(true);
    net.stop();
  });

  it('polls /api/queue when queued, auto-claims when state becomes ready, and supports leaveQueue()', async () => {
    const queueEvents: unknown[] = [];
    let pollCount = 0;

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/join')) {
        return new Response(
          JSON.stringify({
            ...joinBody,
            role: 'spectator',
            queue: { state: 'queued', position: 2, totalQueued: 5, estimatedWaitSec: 24 },
          }),
          { status: 200 },
        );
      }
      if (url.startsWith('/api/queue/status?')) {
        pollCount++;
        if (pollCount === 1) {
          return new Response(
            JSON.stringify({
              state: 'queued',
              position: 1,
              totalQueued: 4,
              estimatedWaitSec: 10,
              seatLeaseId: 'lease-1',
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            state: 'ready',
            position: 0,
            totalQueued: 3,
            assignedSiteId: 'slc-2',
            seatLeaseId: 'lease-1',
            leaseExpiresAt: Date.now() + 20_000,
          }),
          { status: 200 },
        );
      }
      if (url.startsWith('/api/queue/claim')) {
        return new Response(
          JSON.stringify({
            siteId: 'slc-2',
            wsUrl: '/ws?site=slc-2',
            ticket: 'claimed-ticket',
            expiresAt: Date.now() + 60_000,
            clientId: 'c',
            role: 'driver',
          }),
          { status: 200 },
        );
      }
      if (url.startsWith('/api/queue/leave')) {
        return new Response(JSON.stringify({ ok: true, removed: true }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const net = new NetClient(
      () => ({ clientId: 'c', name: 'Turbo-Badger' }),
      {
        onStatus: () => {},
        onMessage: () => {},
        onQueueUpdate: (q) => queueEvents.push(q),
      },
    );

    await net.join('den-1', { requeue: true });
    expect(net.queue?.state).toBe('queued');
    expect(net.queue?.position).toBe(2);
    TestSocket.instances[0]!.accept();

    // First 3s poll updates position to #1
    await vi.advanceTimersByTimeAsync(3_000);
    expect(net.queue?.state).toBe('queued');
    expect(net.queue?.position).toBe(1);

    // Second 3s poll receives 'ready' and auto-claims seat on slc-2
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/queue/claim',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(net.siteId).toBe('slc-2');
    expect(net.queue).toBeNull();

    // Re-enter queue and test leaveQueue()
    await net.join('den-1', { requeue: true });
    expect(net.queue?.state).toBe('queued');
    await net.leaveQueue();
    expect(net.queue).toBeNull();
    net.stop();
  });
});

