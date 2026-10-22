import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { JoinResponseSchema, LeaderboardEntrySchema, PUBLIC_ID_PATTERN } from '@warehouse/protocol';
import { adoptRawClientId, isOwnLeaderboardRow, isPublicId } from '../src/identity.js';
import { ClientStore } from '../src/state.js';

const PUB = 'p1_' + 'A'.repeat(20) + '-_';
const OTHER_PUB = 'p1_' + 'B'.repeat(22);
const RAW = '5f0c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';

describe('publicId protocol fields', () => {
  it('PUBLIC_ID_PATTERN accepts p1_ + 22 base64url chars only', () => {
    expect(PUBLIC_ID_PATTERN.test(PUB)).toBe(true);
    expect(PUBLIC_ID_PATTERN.test('p1_' + 'A'.repeat(21))).toBe(false);
    expect(PUBLIC_ID_PATTERN.test('p1_' + 'A'.repeat(23))).toBe(false);
    expect(PUBLIC_ID_PATTERN.test('p2_' + 'A'.repeat(22))).toBe(false);
    expect(PUBLIC_ID_PATTERN.test(RAW)).toBe(false);
  });

  it('JoinResponseSchema carries an optional, validated publicId', () => {
    const base = { siteId: 'den-1', wsUrl: 'wss://x/ws', ticket: 't', expiresAt: 1 };
    expect(JoinResponseSchema.parse({ ...base, publicId: PUB }).publicId).toBe(PUB);
    expect(JoinResponseSchema.safeParse(base).success).toBe(true);
    expect(JoinResponseSchema.safeParse({ ...base, publicId: RAW }).success).toBe(false);
  });

  it('LeaderboardEntrySchema: publicId optional during rollout, clientId kept', () => {
    const row = { clientId: PUB, name: 'Swift-Pallet', deliveries: 3 };
    expect(LeaderboardEntrySchema.safeParse(row).success).toBe(true);
    expect(LeaderboardEntrySchema.parse({ ...row, publicId: PUB }).publicId).toBe(PUB);
    expect(LeaderboardEntrySchema.safeParse({ ...row, publicId: 'nope' }).success).toBe(false);
  });
});

describe('raw clientId adoption', () => {
  it('adopts a raw lobby clientId that differs', () => {
    expect(adoptRawClientId('old-raw', RAW)).toBe(RAW);
    expect(adoptRawClientId(RAW, RAW)).toBe(RAW);
  });

  it('never adopts a publicId (e.g. welcome.you.clientId) as the raw clientId', () => {
    expect(isPublicId(PUB)).toBe(true);
    expect(adoptRawClientId(RAW, PUB)).toBe(RAW);
  });

  it('ignores missing, blank, oversized or non-string candidates', () => {
    expect(adoptRawClientId(RAW, undefined)).toBe(RAW);
    expect(adoptRawClientId(RAW, null)).toBe(RAW);
    expect(adoptRawClientId(RAW, '   ')).toBe(RAW);
    expect(adoptRawClientId(RAW, 'x'.repeat(129))).toBe(RAW);
    expect(adoptRawClientId(RAW, 42)).toBe(RAW);
  });

  it('main.ts only persists the raw clientId from loadClientId or adoptRawClientId(…, join.clientId)', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');
    const writes = [...src.matchAll(/storageSet\(CLIENT_ID_KEY,\s*([^)]+)\)/g)].map((m) => m[1]!.trim());
    // `id` = the freshly generated UUID in loadClientId(); `adopted` = adoptRawClientId(...) result.
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(['id', 'adopted']).toContain(w);
    const adoptions = [...src.matchAll(/const adopted = ([^;]+);/g)].map((m) => m[1]!.trim());
    expect(adoptions.length).toBeGreaterThan(0);
    for (const a of adoptions) expect(a).toBe('adoptRawClientId(clientId, join.clientId)');
    // The in-memory credential is only ever reassigned from `adopted` (never from welcome/you/presence).
    const reassigns = [...src.matchAll(/(?<![.\w])clientId = ([^;]+);/g)].map((m) => m[1]!.trim());
    for (const r of reassigns) expect(['loadClientId()', 'adopted']).toContain(r);
    expect(src).not.toMatch(/storageSet\(CLIENT_ID_KEY,[^)]*you/);
  });
});

describe('own leaderboard row', () => {
  it('matches row.publicId first, falling back to row.clientId', () => {
    expect(isOwnLeaderboardRow({ clientId: PUB, publicId: PUB }, PUB)).toBe(true);
    expect(isOwnLeaderboardRow({ clientId: PUB }, PUB)).toBe(true);
    expect(isOwnLeaderboardRow({ clientId: OTHER_PUB, publicId: OTHER_PUB }, PUB)).toBe(false);
    expect(isOwnLeaderboardRow({ clientId: PUB }, null)).toBe(false);
  });

  it('store.selfPublicId prefers the lobby publicId, else welcome.you.clientId', () => {
    const store = new ClientStore();
    expect(store.selfPublicId()).toBeNull();
    store.you = { clientId: OTHER_PUB, name: 'Swift-Pallet', vid: null, siteId: 'den-1' };
    expect(store.selfPublicId()).toBe(OTHER_PUB);
    store.publicId = PUB;
    expect(store.selfPublicId()).toBe(PUB);
  });
});
