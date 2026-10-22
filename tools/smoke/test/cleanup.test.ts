import { describe, expect, it } from 'vitest';
import { isSmokePlayerDoc, SMOKE_ID_PREFIX } from '../src/index.js';

// Doc shapes: the site keys `players/{clientId}` stats docs by clientId; `smoke-` names are a
// reserved bot prefix, so smoke joins keep their `smoke-…` name verbatim.
describe('isSmokePlayerDoc (smoke cleanup matcher)', () => {
  it('matches every identity the smoke tools create', () => {
    // live.ts
    expect(isSmokePlayerDoc('smoke-client-1792214000000', { clientId: 'smoke-client-1792214000000', name: 'smoke-driver-1', isBot: true })).toBe(true);
    expect(isSmokePlayerDoc('smoke-client-2-1792214000000', { clientId: 'smoke-client-2-1792214000000', name: 'smoke-driver-2', isBot: true })).toBe(true);
    // armor.ts
    expect(isSmokePlayerDoc('smoke-armor-1-1792214000000-ab12', { clientId: 'smoke-armor-1-1792214000000-ab12', name: 'smoke-armor-1' })).toBe(true);
    // ui.mjs seeds a smoke-ui-* clientId into the browser
    expect(isSmokePlayerDoc('smoke-ui-1792214000000-k3j9', { clientId: 'smoke-ui-1792214000000-k3j9', name: 'smoke-k3j9x2' })).toBe(true);
    // older UI runs used a random browser UUID but still a smoke- name
    expect(isSmokePlayerDoc('9f1c2d3e-0000-4000-8000-000000000000', { clientId: '9f1c2d3e-0000-4000-8000-000000000000', name: `${SMOKE_ID_PREFIX}ab12cd` })).toBe(true);
  });

  it('never matches real or ambiguous players', () => {
    expect(isSmokePlayerDoc('1c55b366-c560-4cba-a1c4-16bd132b16ba', { clientId: '1c55b366-c560-4cba-a1c4-16bd132b16ba', name: 'THAGOMIZER' })).toBe(false);
    expect(isSmokePlayerDoc('op-caxiu838-mvazu2pj', { clientId: 'op-caxiu838-mvazu2pj', name: 'Operator-1' })).toBe(false);
    expect(isSmokePlayerDoc('probe-client-20261016', { clientId: 'probe-client-20261016', name: 'zippy-turret-43' })).toBe(false);
    expect(isSmokePlayerDoc('human-probe-1792191436929', { clientId: 'human-probe-1792191436929', name: 'laser-sensor-16' })).toBe(false);
    // case-sensitive and anchored at the start
    expect(isSmokePlayerDoc('abc', { name: 'Smoke-Jumper' })).toBe(false);
    expect(isSmokePlayerDoc('abc', { name: 'blue-smoke-7' })).toBe(false);
  });

  it('tolerates missing or non-string fields', () => {
    expect(isSmokePlayerDoc('abc', undefined)).toBe(false);
    expect(isSmokePlayerDoc('abc', { name: 42, clientId: null })).toBe(false);
    expect(isSmokePlayerDoc('smoke-client-1', null)).toBe(true);
  });
});
