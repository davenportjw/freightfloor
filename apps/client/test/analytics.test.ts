import { describe, expect, it, vi } from 'vitest';
import { ClientMessageSchema, type ClientMessage } from '@warehouse/protocol';
import {
  Analytics,
  eventForClientMessage,
  fetchAnalyticsConfig,
  isMeasurementId,
  joinEvent,
  runEndEvents,
  runStartEvent,
} from '../src/analytics.js';

const FORBIDDEN_KEYS = ['name', 'clientId', 'client_id', 'publicId', 'resumeToken', 'vid', 'text', 'ticket'];

function fakeWindow() {
  const appended: Array<{ src: string; async: boolean }> = [];
  const win = {
    document: {
      createElement: () => ({ src: '', async: false }),
      head: { appendChild: (el: { src: string; async: boolean }) => appended.push(el) },
    },
  } as unknown as Window & { dataLayer?: unknown[] };
  return { win, appended };
}

describe('GA4 event mapping', () => {
  it('maps player actions to events without free text or identifiers', () => {
    const msgs: ClientMessage[] = [
      { type: 'nlCommand', text: 'send everyone to zone B, my name is Alice' },
      { type: 'agentCommand', vid: 'v12', text: 'go charge' },
      { type: 'agentCommand', vid: 'v12', mode: 'autopilot' },
      { type: 'takeWheel', vid: 'v3' },
      { type: 'keepCards', ids: ['a', 'b', 'c'] },
      { type: 'setRunMode', mode: 'blitz' },
      { type: 'transferSite', siteId: 'slc-2' },
    ];
    for (const msg of msgs) {
      expect(ClientMessageSchema.safeParse(msg).success).toBe(true);
      const ev = eventForClientMessage(msg);
      expect(ev).not.toBeNull();
      for (const key of FORBIDDEN_KEYS) expect(ev!.params).not.toHaveProperty(key);
      expect(JSON.stringify(ev)).not.toMatch(/Alice|zone B|go charge|v12|v3/);
    }
    expect(eventForClientMessage(msgs[0]!)).toEqual({ name: 'manager_command', params: {} });
    expect(eventForClientMessage(msgs[1]!)).toEqual({ name: 'agent_command', params: { kind: 'text' } });
    expect(eventForClientMessage(msgs[2]!)).toEqual({
      name: 'agent_command',
      params: { kind: 'mode', mode: 'autopilot' },
    });
    expect(eventForClientMessage(msgs[4]!)).toEqual({ name: 'contracts_kept', params: { count: 3 } });
  });

  it('ignores high-frequency and plumbing messages', () => {
    expect(eventForClientMessage({ type: 'layers', traffic: true })).toBeNull();
    expect(eventForClientMessage({ type: 'release' })).toEqual({ name: 'release_wheel', params: {} });
  });

  it('builds join and run lifecycle events with GA4 recommended names', () => {
    expect(joinEvent({ siteId: 'den-1', role: 'driver' }, 'join')).toEqual({
      name: 'site_join',
      params: { site_id: 'den-1', via: 'join', role: 'driver' },
    });
    expect(runStartEvent('blitz', 'den-1')).toEqual({
      name: 'level_start',
      params: { level_name: 'blitz', site_id: 'den-1' },
    });
    const [end, score] = runEndEvents(
      { runMode: 'blitz', runNumber: 2, score: 410, deliveries: 9, onTimePct: 88, humanRank: 1, totalHumanRuns: 4 },
      null,
    );
    expect(end).toEqual({ name: 'level_end', params: { level_name: 'blitz', success: true } });
    expect(score!.name).toBe('post_score');
    expect(score!.params).toMatchObject({ score: 410, level: 2, character: 'blitz', deliveries: 9 });
  });
});

describe('Analytics sink', () => {
  it('validates measurement IDs', () => {
    expect(isMeasurementId('G-ABC123XYZ9')).toBe(true);
    expect(isMeasurementId('UA-1234-1')).toBe(false);
    expect(isMeasurementId('G-<script>')).toBe(false);
    expect(isMeasurementId(null)).toBe(false);
  });

  it('holds early events, then loads gtag and flushes them when enabled', () => {
    const { win, appended } = fakeWindow();
    const a = new Analytics();
    a.track({ name: 'site_join', params: { site_id: 'den-1' } });
    a.start('G-ABC123XYZ9', win);
    expect(a.enabled).toBe(true);
    expect(appended[0]!.src).toBe('https://www.googletagmanager.com/gtag/js?id=G-ABC123XYZ9');
    const calls = (win.dataLayer ?? []).map((args) => Array.from(args as ArrayLike<unknown>));
    expect(calls[1]).toEqual([
      'config',
      'G-ABC123XYZ9',
      { allow_google_signals: false, allow_ad_personalization_signals: false },
    ]);
    expect(calls[2]).toEqual(['event', 'site_join', { site_id: 'den-1' }]);
  });

  it('drops everything and loads nothing when no measurement ID is configured', () => {
    const { win, appended } = fakeWindow();
    const a = new Analytics();
    a.track({ name: 'site_join', params: {} });
    a.start(null, win);
    a.track({ name: 'level_start', params: {} });
    expect(a.enabled).toBe(false);
    expect(appended).toHaveLength(0);
    expect(win.dataLayer).toBeUndefined();
  });

  it('reads the measurement ID from /api/config and rejects malformed values', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ gaMeasurementId: 'G-ABC123XYZ9' })));
    expect(await fetchAnalyticsConfig(ok as unknown as typeof fetch)).toBe('G-ABC123XYZ9');
    const bad = vi.fn(async () => new Response(JSON.stringify({ gaMeasurementId: 'nope' })));
    expect(await fetchAnalyticsConfig(bad as unknown as typeof fetch)).toBeNull();
    const down = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(await fetchAnalyticsConfig(down as unknown as typeof fetch)).toBeNull();
  });
});
