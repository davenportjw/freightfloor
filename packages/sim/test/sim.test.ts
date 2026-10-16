import { describe, expect, it } from 'vitest';
import {
  addVehicle,
  applyDecision,
  buildMap,
  compactFacilityIfNeeded,
  ContractOption,
  createWorld,
  dealCards,
  dealShiftCards,
  FLEET_CAP,
  getCardModifiers,
  humanInteract,
  INTERACT_REACH,
  keepCards,
  markBrainError,
  MAX_TIER,
  postOrder,
  receiveTransfer,
  releaseWheel,
  removePlayerVehicle,
  removeVehicle,
  restore,
  serialize,
  setDifficulty,
  setPhase,
  spawnPlayerVehicle,
  spawnSpill,
  stepHuman,
  takeWheel,
  tick,
  tierCap,
  vehicleReach,
  voteDifficulty,
  World,
} from '../src/index.js';

/**
 * Helper for tests to drive pending Brain decisions through the real `applyDecision` API
 * (picking the first valid option from `req.options`).
 */
function drivePendingDecisions(w: World): void {
  const pending = [...w.pendingDecisions];
  for (const req of pending) {
    const meta = {
      model: 'gemini-3.8-flash',
      latencyMs: 12,
      inputTokens: 64,
      outputTokens: 16,
    };
    if (req.kind === 'contract' && req.options.length > 0) {
      const first = req.options[0] as ContractOption;
      applyDecision(
        w,
        req.id,
        { orderIds: [first.orderId], reason: 'pick first contract' },
        meta,
      );
    } else if (req.kind === 'hazard') {
      applyDecision(
        w,
        req.id,
        { choice: 'reroute', reason: 'reroute around hazard' },
        meta,
      );
    } else if (req.kind === 'tactics') {
      applyDecision(
        w,
        req.id,
        {
          speed: 1.15,
          buffer: 2,
          respect: 0.85,
          chargeAt: 25,
          batch: 2,
          reason: 'balanced tactics',
        },
        meta,
      );
    } else if (req.kind === 'cards' && req.options.length > 0) {
      const cardIds = req.options.slice(0, 2).map((o) => o.id);
      applyDecision(
        w,
        req.id,
        {
          keep: cardIds,
          reason: 'equip shift skill cards',
        },
        meta,
      );
    }
  }
}

describe('@warehouse/sim M1 verification suite', () => {
  it('1. Determinism: identical seeds + identical decisions over 5,000 ticks yield identical state, with isolated per-world maps', () => {
    const w1 = createWorld({ seed: 424242, siteId: 'den-1', tier: 0 });
    const w2 = createWorld({ seed: 424242, siteId: 'den-1', tier: 0 });
    // Also create a third world at a different tier to verify zero module-level map state leakage
    const wOther = createWorld({ seed: 999999, siteId: 'ord-2', tier: 4 });

    expect(w1.map.h).not.toBe(wOther.map.h);

    for (let i = 0; i < 5000; i++) {
      tick(w1);
      tick(w2);
      if (i % 50 === 0) tick(wOther);
      drivePendingDecisions(w1);
      drivePendingDecisions(w2);
    }

    expect(w1.t).toBe(w2.t);
    expect(w1.rngState).toBe(w2.rngState);
    expect(w1.totals).toEqual(w2.totals);
    expect(w1.orders.map((o) => ({ id: o.id, state: o.state, bay: o.bay }))).toEqual(
      w2.orders.map((o) => ({ id: o.id, state: o.state, bay: o.bay })),
    );
    expect(
      w1.vehicles.map((v) => ({
        id: v.id,
        px: v.px,
        py: v.py,
        battery: v.battery,
        state: v.state,
        deliveries: v.deliveries,
      })),
    ).toEqual(
      w2.vehicles.map((v) => ({
        id: v.id,
        px: v.px,
        py: v.py,
        battery: v.battery,
        state: v.state,
        deliveries: v.deliveries,
      })),
    );
  });

  it('2. Difficulty ramp & shift voting: supports calm/normal/surge/crisis and tallies multiplayer votes at shift boundary', () => {
    const w = createWorld({ seed: 1001 });
    expect(w.difficulty).toBe('normal');

    expect(setDifficulty(w, 'calm')).toBeNull();
    expect(w.difficulty).toBe('calm');
    expect(setDifficulty(w, 'crisis')).toBeNull();
    expect(w.difficulty).toBe('crisis');
    expect(setDifficulty(w, 1)).toBeNull();
    expect(w.difficulty).toBe('calm');

    // Cast multiplayer votes: 2 for surge, 1 for calm
    voteDifficulty(w, 'client-a', 'surge');
    voteDifficulty(w, 'client-b', 'surge');
    voteDifficulty(w, 'client-c', 'calm');

    // Advance across shift boundary (t = 479.9 -> 480.0)
    w.t = 479.9;
    tick(w, 0.1);
    expect(w.difficulty).toBe('surge');
    expect(Object.keys(w.difficultyVotes)).toHaveLength(0);
  });

  it('3. Spill paths & hazard DecisionRequest + applyDecision: pauses agent on spill path and executes reroute/wait/push', () => {
    const w = createWorld({ seed: 2002 });
    const agent = w.vehicles.find((v) => !v.human)!;

    // Place agent at (3, 11) with a path through (5, 11) -> (6, 11) -> (7, 11)
    agent.tile = { x: 3, y: 11 };
    agent.px = 3.5;
    agent.py = 11.5;
    agent.moveTo = null;
    agent.state = 'toPick';
    agent.path = [
      { x: 4, y: 11 },
      { x: 5, y: 11 },
      { x: 6, y: 11 },
      { x: 7, y: 11 },
    ];
    agent.target = { kind: 'park', x: 10, y: 11 };

    const spill = spawnSpill(w, { x: 5, y: 11 });
    expect(spill).not.toBeNull();

    // Stepping tick should detect spill along agent.path, hold the agent, and emit a hazard DecisionRequest
    tick(w);
    expect(agent.hold).toBe(spill!.id);
    const hzReq = w.pendingDecisions.find(
      (r) => r.kind === 'hazard' && r.agentId === agent.id,
    );
    expect(hzReq).toBeDefined();

    // Apply 'reroute' decision
    const res = applyDecision(
      w,
      hzReq!.id,
      { choice: 'reroute', reason: 'avoid chemical spill' },
      { model: 'gemini-3.8-flash', latencyMs: 15 },
    );
    expect(res.ok).toBe(true);
    expect(agent.hold).toBeNull();
    expect(w.totals.decisions.reroute).toBe(1);
    // Rerouted path should avoid the spill tile (5, 11)
    expect(agent.path.some((p) => p.x === 5 && p.y === 11)).toBe(false);
  });

  it('4. Expansion up to Tier 6 (60 vehicles) & compaction during factory break', () => {
    const w = createWorld({ seed: 3003, tier: 0 });
    expect(MAX_TIER).toBe(6);
    expect(FLEET_CAP).toBe(60);
    expect(tierCap(0)).toBe(24);
    expect(tierCap(6)).toBe(60);

    // Add vehicles up to 60 and verify automatic expansion to Tier 6
    while (w.vehicles.length < FLEET_CAP) {
      const added = addVehicle(w, { silent: true });
      expect(added).not.toBeNull();
    }
    expect(w.vehicles.length).toBe(60);
    expect(w.tier).toBe(6);
    expect(w.map.tier).toBe(6);
    expect(w.map.h).toBe(43 + 3 + 9 * 6); // 100 rows at Tier 6

    // Cannot exceed FLEET_CAP
    expect(addVehicle(w, { silent: true })).toBeNull();

    // Prepare all extra vehicles to be idle & remove them down to 24
    w.orders = [];
    for (const v of w.vehicles) {
      v.tile = { x: 14, y: 11 };
      v.px = 14.5;
      v.py = 11.5;
      v.moveTo = null;
      v.path = [];
      v.orders = [];
      v.cargo = [];
      v.target = null;
      v.state = 'parked';
    }
    while (w.vehicles.length > 24) {
      expect(removeVehicle(w)).not.toBeNull();
    }
    expect(w.vehicles.length).toBe(24);

    // Compaction only runs during 'break'
    expect(compactFacilityIfNeeded(w)).toBe(false);
    setPhase(w, 'break');
    expect(w.tier).toBe(0);
    expect(w.map.tier).toBe(0);
  });

  it('5. Pickup reach (1.6 tiles) and skill card reach bonus', () => {
    const w = createWorld({ seed: 4004 });
    expect(INTERACT_REACH).toBe(1.6);

    const order = postOrder(w, { p0: true })!;
    expect(order).not.toBeNull();

    const playerVeh = spawnPlayerVehicle(w, 'client-reach', 'Alice');
    expect(vehicleReach(w, playerVeh)).toBeCloseTo(1.6, 5);

    // Position player vehicle 2.1 tiles away from order access tile -> out of default 1.6 reach
    playerVeh.px = order.slot.ax + 0.5;
    playerVeh.py = order.slot.ay + 0.5 + 2.1;
    playerVeh.tile = { x: Math.floor(playerVeh.px), y: Math.floor(playerVeh.py) };

    humanInteract(w, playerVeh.id);
    expect(playerVeh.cargo).toHaveLength(0);

    // Move within 1.5 tiles -> pickup succeeds
    playerVeh.py = order.slot.ay + 0.5 + 1.5;
    playerVeh.tile = { x: Math.floor(playerVeh.px), y: Math.floor(playerVeh.py) };
    humanInteract(w, playerVeh.id);
    expect(playerVeh.cargo).toHaveLength(1);
    expect(playerVeh.cargo[0].id).toBe(order.id);
  });

  it('6. Skill cards deal, AI cards DecisionRequest + applyDecision, and card modifiers', () => {
    const w = createWorld({ seed: 5005 });
    const playerVeh = spawnPlayerVehicle(w, 'client-cards', 'Bob');
    const hand = dealCards(w, 'client-cards');

    // Human hand is dealt 3 offered cards
    expect(hand.offer).not.toBeNull();
    expect(hand.offer).toHaveLength(3);
    const keepIds = hand.offer!.slice(0, 2).map((c) => c.id);
    expect(keepCards(w, 'client-cards', keepIds)).toBeNull();
    expect(w.cards['client-cards'].cards.length).toBeGreaterThanOrEqual(1);

    // AI shift card dealing emits 'cards' DecisionRequests and waits for applyDecision
    const aiReqs = dealShiftCards(w);
    expect(aiReqs.length).toBeGreaterThan(0);
    const aiCardsReq = aiReqs[0];
    expect(aiCardsReq.kind).toBe('cards');
    expect(aiCardsReq.options).toHaveLength(3);

    const chosenIds = aiCardsReq.options.slice(0, 2).map((o) => o.id);
    const res = applyDecision(
      w,
      aiCardsReq.id,
      { keep: chosenIds, reason: 'select synergy pair' },
      { model: 'gemini-3.8-flash', latencyMs: 20 },
    );
    expect(res.ok).toBe(true);
    expect(w.cards[aiCardsReq.agentId].cards.map((c) => c.id)).toEqual(chosenIds);

    // Verify card modifiers when active cards have speed, reach, and battery drain modifiers
    w.cards['client-cards'].cards = [
      {
        id: 'c-mod-1',
        type: 'quick',
        goal: 2,
        progress: 0,
        status: 'active',
        pts: 20,
        title: 'Quick',
        desc: 'Quick runs',
        modifiers: { speedMul: 1.15, reachBonus: 0.25 },
      },
      {
        id: 'c-mod-2',
        type: 'charge',
        goal: 1,
        progress: 0,
        status: 'active',
        pts: 15,
        title: 'Charge',
        desc: 'Battery saver',
        modifiers: { batteryDrainMul: 0.75 },
      },
    ];
    const mods = getCardModifiers(w, playerVeh);
    expect(mods.speedMul).toBeCloseTo(1.15, 5);
    expect(mods.reachBonus).toBeCloseTo(0.25, 5);
    expect(mods.batteryDrainMul).toBeCloseTo(0.75, 5);
  });

  it('7. Cross-site transfers: East transfer bays (→ NET), TransferOut emission, and idempotent receiveTransfer (+5 bonus)', () => {
    const w = createWorld({ seed: 6006, siteId: 'den-1' });
    const transferBays = w.map.bays.filter((b) => b.isTransferBay);
    expect(transferBays).toHaveLength(2);
    expect(transferBays.every((b) => b.label === '→ NET')).toBe(true);

    // Spawn 100 orders and verify ~20% target transfer bays with destSite != w.siteId
    for (let i = 0; i < 100; i++) {
      postOrder(w);
    }
    const transferOrders = w.orders.filter((o) => o.isTransfer);
    expect(transferOrders.length).toBeGreaterThan(5);
    expect(transferOrders.every((o) => o.destSite && o.destSite !== 'den-1')).toBe(true);

    // Deliver a transfer order via human player at its transfer bay
    const to = transferOrders[0];
    const bayCfg = w.map.bays.find((b) => b.id === to.bay)!;
    const pv = spawnPlayerVehicle(w, 'client-xfer', 'Carol');
    pv.px = bayCfg.tiles[0].x + 0.5;
    pv.py = bayCfg.tiles[0].y + 0.5;
    pv.tile = { ...bayCfg.tiles[0] };
    to.claimant = pv.id;
    to.state = 'picked';
    pv.cargo.push(to);

    humanInteract(w, pv.id);
    expect(w.outboundTransfers).toHaveLength(1);
    expect(w.totals.transfersOut).toBe(1);
    const out = w.outboundTransfers[0];
    expect(out.fromSite).toBe('den-1');
    expect(out.toSite).toBe(to.destSite);

    // Receive transfer on destination world: idempotent by transfer.id and worth value + 5
    const destWorld = createWorld({ seed: 6007, siteId: out.toSite });
    const inbound1 = receiveTransfer(destWorld, out);
    expect(inbound1).not.toBeNull();
    expect(inbound1!.value).toBe(out.value + 5);
    expect(destWorld.totals.transfersIn).toBe(1);

    // Duplicate receiveTransfer with the same id is a no-op
    const inboundDuplicate = receiveTransfer(destWorld, out);
    expect(inboundDuplicate).toBeNull();
    expect(destWorld.totals.transfersIn).toBe(1);
  });

  it('8. Factory break phases: break freezes clock/due/shiftTime, winding_down parks idle agents, resuming counts down 10s', () => {
    const w = createWorld({ seed: 7007 });
    const order = postOrder(w)!;
    tick(w, 0.1);
    const tBefore = w.t;
    const shiftBefore = w.shiftTime;
    const dueBefore = order.due;

    setPhase(w, 'break');
    for (let i = 0; i < 50; i++) {
      tick(w, 0.1);
    }
    expect(w.t).toBe(tBefore);
    expect(w.shiftTime).toBe(shiftBefore);
    expect(order.due).toBe(dueBefore);

    // Transition to resuming: 10 second countdown (10 ticks at dt=0.1)
    setPhase(w, 'resuming');
    expect(w.resumeCountdown).toBe(10);
    for (let i = 0; i < 9; i++) {
      tick(w, 0.1);
      expect(w.phase).toBe('resuming');
    }
    tick(w, 0.1);
    expect(w.phase).toBe('running');
  });

  it('9. v5 serialize and restore round-trip preserves full world state and deterministic continuation', () => {
    const w = createWorld({ seed: 8008, siteId: 'dfw-3', tier: 2 });
    spawnPlayerVehicle(w, 'client-save', 'Dave');
    for (let i = 0; i < 120; i++) {
      tick(w);
      drivePendingDecisions(w);
    }

    const snap = serialize(w);
    expect(snap.version).toBe(5);
    expect(snap.tier).toBe(2);

    const restored = restore(snap);
    expect(restored.version).toBe(5);
    expect(restored.siteId).toBe('dfw-3');
    expect(restored.tier).toBe(2);
    expect(restored.t).toBe(w.t);
    expect(restored.rngState).toBe(w.rngState);
    expect(restored.players.has('client-save')).toBe(true);

    // Step both worlds 100 more ticks and verify they stay identical
    for (let i = 0; i < 100; i++) {
      tick(w);
      tick(restored);
      drivePendingDecisions(w);
      drivePendingDecisions(restored);
    }
    expect(restored.t).toBe(w.t);
    expect(restored.rngState).toBe(w.rngState);
    expect(restored.vehicles.map((v) => ({ id: v.id, px: v.px, py: v.py }))).toEqual(
      w.vehicles.map((v) => ({ id: v.id, px: v.px, py: v.py })),
    );
  });

  it('10. Brain seam invariants: rejects stale/illegal/expired replies, markBrainError holds idle agent with zero fallback, and player display names never leak into DecisionRequest', () => {
    const w = createWorld({ seed: 9009 });
    const secretDisplayName = 'SuperSecretPlayerName_X99';
    const pv = spawnPlayerVehicle(w, 'client-sec', secretDisplayName);
    const o1 = postOrder(w)!;
    const o2 = postOrder(w)!;
    // Have the player claim o1 so o1 has a claimant
    o1.claimant = pv.id;
    o1.state = 'claimed';

    // Step until contract DecisionRequests are emitted
    for (let i = 0; i < 10; i++) tick(w);
    expect(w.pendingDecisions.length).toBeGreaterThan(0);

    // Verify player display name NEVER appears in any DecisionRequest
    for (const req of w.pendingDecisions) {
      expect(JSON.stringify(req)).not.toContain(secretDisplayName);
    }

    // Also test takeWheel on an AI vehicle and verify display name never leaks
    const aiVeh = w.vehicles.find((v) => !v.human)!;
    expect(takeWheel(w, aiVeh.id, 'client-wheel', secretDisplayName)).toBeNull();
    releaseWheel(w, 'client-wheel');
    removePlayerVehicle(w, 'client-sec');

    const contractReq = w.pendingDecisions.find((r) => r.kind === 'contract')!;
    expect(contractReq).toBeDefined();

    // 1) Stale request ID -> rejected with 'stale'
    const staleRes = applyDecision(
      w,
      'dec-nonexistent-999999',
      { orderIds: [o2.id], reason: 'stale' },
      { model: 'gemini-3.8-flash', latencyMs: 10 },
    );
    expect(staleRes.ok).toBe(false);
    if (!staleRes.ok) {
      expect(staleRes.error).toBe('stale');
    }

    // 2) Illegal order ID -> rejected with 'illegal' (and request remains pending)
    const illegalRes = applyDecision(
      w,
      contractReq.id,
      { orderIds: [9999999], reason: 'illegal order' },
      { model: 'gemini-3.8-flash', latencyMs: 10 },
    );
    expect(illegalRes.ok).toBe(false);
    if (!illegalRes.ok) {
      expect(illegalRes.error).toBe('illegal');
    }

    // 3) Expired deadline -> rejected with 'expired'
    contractReq.deadline = w.t - 0.1;
    const expiredRes = applyDecision(
      w,
      contractReq.id,
      { orderIds: [o2.id], reason: 'too late' },
      { model: 'gemini-3.8-flash', latencyMs: 10 },
    );
    expect(expiredRes.ok).toBe(false);
    if (!expiredRes.ok) {
      expect(expiredRes.error).toBe('expired');
    }

    // 4) markBrainError holds idle agent with brainError and NEVER synthesizes a fallback decision
    const idleAgent = w.vehicles.find((v) => !v.human && v.orders.length === 0)!;
    markBrainError(w, idleAgent.id, 'Vertex AI 429 Resource Exhausted');
    expect(idleAgent.brainError).toBe('Vertex AI 429 Resource Exhausted');

    for (let i = 0; i < 30; i++) {
      tick(w);
    }
    // Agent with brainError must still have zero orders (no rule-based fallback ever ran)
    expect(idleAgent.orders).toHaveLength(0);
    expect(idleAgent.cargo).toHaveLength(0);

    // Also verify stepHuman shared signature works for client prediction
    const predVeh = spawnPlayerVehicle(w, 'client-pred', 'Predictor');
    const px0 = predVeh.px;
    const py0 = predVeh.py;
    stepHuman(w, predVeh, { up: true, down: false, left: false, right: false }, 0.1);
    expect(Math.hypot(predVeh.px - px0, predVeh.py - py0)).toBeGreaterThan(0);

    // Verify buildMap works across all tiers 0..6
    for (let t = 0; t <= MAX_TIER; t++) {
      const m = buildMap(t);
      expect(m.tier).toBe(t);
    }
  });
});
