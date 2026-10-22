import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JoinResponseSchema } from '@warehouse/protocol';
import { NetClient, type NetStatus } from '../src/net.js';
import {
  isResumeCode,
  lobbyErrorMessage,
  loadResumeCode,
  RESUME_CODE_KEY,
  resumeInputError,
  saveResumeCode,
} from '../src/resumeCode.js';
import { serverErrorText } from '../src/ui/notify.js';

const CODE = `wr1_${'A'.repeat(16)}${'b_-9'.repeat(4)}`;

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

class MemStorage {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

describe('resume code helpers', () => {
  it('recognises only well-formed lobby codes', () => {
    expect(CODE).toHaveLength(36);
    expect(isResumeCode(CODE)).toBe(true);
    expect(isResumeCode('wr1_short')).toBe(false);
    expect(isResumeCode('Turbo-Badger')).toBe(false);
    expect(isResumeCode(undefined)).toBe(false);
  });

  it('persists and reloads the code, ignoring junk', () => {
    const st = new MemStorage();
    expect(saveResumeCode(st, 'nope')).toBe(false);
    expect(loadResumeCode(st)).toBeNull();
    expect(saveResumeCode(st, CODE)).toBe(true);
    expect(st.getItem(RESUME_CODE_KEY)).toBe(CODE);
    expect(loadResumeCode(st)).toBe(CODE);
    st.setItem(RESUME_CODE_KEY, 'tampered');
    expect(loadResumeCode(st)).toBeNull();
    expect(loadResumeCode(null)).toBeNull();
  });

  it('validates the Resume field input', () => {
    expect(resumeInputError('')).toMatch(/existing callsign or paste your resume code/i);
    expect(resumeInputError(`  ${CODE}  `)).toBeNull();
    expect(resumeInputError('wr1_abc')).toMatch(/incomplete/);
    expect(resumeInputError('Turbo-Badger')).toBeNull(); // existing callsign lookup: lobby decides
    expect(resumeInputError('x')).toMatch(/resume code/);
  });

  it('maps lobby error bodies to the copy the player sees', () => {
    expect(lobbyErrorMessage(404, { error: 'invalid_resume_code', message: 'That resume code is not valid.' })).toBe(
      'That resume code is not valid.',
    );
    expect(lobbyErrorMessage(404, { error: 'invalid_resume_code' })).toMatch(/No existing driver callsign matches/);
    expect(lobbyErrorMessage(503, { error: 'queue_unavailable' })).toMatch(/queue_unavailable, HTTP 503.*Try again/);
    expect(lobbyErrorMessage(400, { error: 'invalid_name', message: 'Pick another' })).toBe('Pick another');
    expect(lobbyErrorMessage(500, null)).toBe('HTTP 500');
  });

  it('protocol: JoinResponse.resumeToken is optional and must be a wr1_ code', () => {
    const base = { siteId: 'den-1', wsUrl: '/ws?site=den-1', ticket: 't', expiresAt: 0 };
    expect(JoinResponseSchema.safeParse(base).success).toBe(true);
    expect(JoinResponseSchema.safeParse({ ...base, resumeToken: CODE }).success).toBe(true);
    expect(JoinResponseSchema.safeParse({ ...base, resumeToken: 'Turbo-Badger' }).success).toBe(false);
  });
});

describe('server error copy', () => {
  it('maps internal_error / spectator_forbidden / vehicle_changed to short human copy', () => {
    expect(serverErrorText('internal_error', 'TypeError: x is undefined')).toMatch(/went wrong/);
    expect(serverErrorText('spectator_forbidden', 'raw')).toMatch(/Spectators/);
    expect(serverErrorText('vehicle_changed', 'raw')).toMatch(/forklift changed/);
    expect(serverErrorText('rate_limited', 'Slow down: 6/min')).toBe('Slow down: 6/min');
  });
});

describe('NetClient resume code + lobby errors', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    TestSocket.instances = [];
    vi.stubGlobal('WebSocket', TestSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('hands resumeToken from the join response to onJoined', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ siteId: 'den-1', wsUrl: '/ws?site=den-1', ticket: 't', expiresAt: 0, clientId: 'c', resumeToken: CODE })),
      ),
    );
    const joined: unknown[] = [];
    const net = new NetClient(() => ({ clientId: 'c' }), { onStatus: () => {}, onMessage: () => {}, onJoined: (j) => joined.push(j) });
    await net.join('den-1');
    expect(joined).toHaveLength(1);
    expect((joined[0] as { resumeToken?: string }).resumeToken).toBe(CODE);
    net.stop();
  });

  it('resumeIdentity sends the code in `resume`, adopts the new identity on a fresh socket', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        const clientId = body.resume ? 'original-client' : 'c';
        return new Response(
          JSON.stringify({ siteId: 'den-1', wsUrl: '/ws?site=den-1', ticket: `t-${clientId}`, expiresAt: 0, clientId, name: 'Turbo-Badger', resumeToken: CODE }),
        );
      }),
    );
    const net = new NetClient(() => ({ clientId: 'c' }), { onStatus: () => {}, onMessage: () => {} });
    await net.join('den-1');
    TestSocket.instances[0]!.accept();
    const res = await net.resumeIdentity(`  ${CODE} `);
    expect(bodies[1]!.resume).toBe(CODE);
    expect(res).toEqual({ ok: true, name: 'Turbo-Badger', clientId: 'original-client', resumeToken: CODE });
    expect(TestSocket.instances).toHaveLength(2); // new identity → new connection
    TestSocket.instances[1]!.accept();
    expect(TestSocket.instances[1]!.sent[0]).toContain('t-original-client');
    net.stop();
  });

  it('resumeIdentity surfaces invalid_resume_code and keeps the live socket', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call++;
        if (call === 1) return new Response(JSON.stringify({ siteId: 'den-1', wsUrl: '/ws?site=den-1', ticket: 't', expiresAt: 0, clientId: 'c' }));
        return new Response(
          JSON.stringify({ error: 'invalid_resume_code', message: 'That resume code is not valid. Paste the resume code from your original browser.' }),
          { status: 404 },
        );
      }),
    );
    const net = new NetClient(() => ({ clientId: 'c' }), { onStatus: () => {}, onMessage: () => {} });
    await net.join('den-1');
    TestSocket.instances[0]!.accept();
    const res = await net.resumeIdentity(CODE);
    expect(res).toEqual({ ok: false, message: 'That resume code is not valid. Paste the resume code from your original browser.' });
    expect(TestSocket.instances).toHaveLength(1);
    expect(net.isOpen).toBe(true);
    net.stop();
  });

  it('503 queue_unavailable on /api/join is a real error with a reconnect retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'queue_unavailable' }), { status: 503 })));
    const statuses: NetStatus[] = [];
    const net = new NetClient(() => ({ clientId: 'c' }), { onStatus: (s) => statuses.push(s), onMessage: () => {} });
    await net.connect('den-1');
    const retry = statuses.at(-1)!;
    expect(retry.kind).toBe('retrying');
    expect(retry.kind === 'retrying' && retry.reason).toMatch(/queue_unavailable/);
    expect(TestSocket.instances).toHaveLength(0);
    net.stop();
  });

  it('503 queue_unavailable on /api/queue/status reports onQueueError and clears it on recovery', async () => {
    let fail = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fail
          ? new Response(JSON.stringify({ error: 'queue_unavailable' }), { status: 503 })
          : new Response(JSON.stringify({ state: 'queued', position: 1, totalQueued: 2, estimatedWaitSec: 5 })),
      ),
    );
    const errors: Array<string | null> = [];
    const net = new NetClient(() => ({ clientId: 'c' }), {
      onStatus: () => {},
      onMessage: () => {},
      onQueueError: (m) => errors.push(m),
    });
    await net.pollQueueStatus();
    expect(errors.at(-1)).toMatch(/queue_unavailable/);
    fail = false;
    await net.pollQueueStatus();
    expect(errors.at(-1)).toBeNull();
    net.stop();
  });
});
