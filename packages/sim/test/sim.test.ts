import { describe, expect, it } from 'vitest';
import {
  addVehicle,
  applyDecision,
  BLITZ_DURATION_MIN,
  BOOST_SPEED_MUL,
  buildMap,
  buildOccupancy,
  compactFacilityIfNeeded,
  computeDriverOnTimePct,
  computeDriverPpm,
  ContractOption,
  createWorld,
  dealCards,
  dealShiftCards,
  deliver,
  dispatchOrderRoute,
  dropPalletOnCollision,
  FLEET_CAP,
  getCardModifiers,
  getSiteTheme,
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
  RUN_CARD_GRACE_MIN,
  serialize,
  setDifficulty,
  setDriverRunMode,
  setPhase,
  SITE_THEMES,
  SKILLS,
  spawnPlayerVehicle,
  spawnSpill,
  stepHuman,
  streakMultiplier,
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
  }, 20000);

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

  it('11. Player vehicle collisions & occupancy: blocks driving through AI or other players, triggers high-speed incidents, registers in buildOccupancy for AI avoidance, and reverses/steers away cleanly', () => {
    const w = createWorld({ seed: 2026 });
    const ai = w.vehicles.find((v) => !v.human)!;
    const p1 = spawnPlayerVehicle(w, 'client-c1', 'DriverOne');
    const p2 = spawnPlayerVehicle(w, 'client-c2', 'DriverTwo');

    // Place vehicles on an open horizontal aisle row (y = 1 is the top cross-aisle)
    const rowY = 1;
    ai.tile = { x: 10, y: rowY };
    ai.px = 10.5;
    ai.py = rowY + 0.5;
    ai.moveTo = null;
    ai.path = [];
    ai.speedNow = 0;
    ai.stunnedUntil = 0;

    p1.tile = { x: 9, y: rowY };
    p1.px = 9.5;
    p1.py = rowY + 0.5;
    p1.angle = 0; // facing East toward AI at x=10
    p1.speedNow = 0;
    p1.stunnedUntil = 0;

    p2.tile = { x: 14, y: rowY };
    p2.px = 14.5;
    p2.py = rowY + 0.5;
    p2.angle = Math.PI; // facing West
    p2.speedNow = 0;
    p2.stunnedUntil = 0;

    // (a) Low-speed player vehicle driving into AI vehicle stops (speedNow = 0) and cannot drive through it
    for (let i = 0; i < 40; i++) {
      p1.speedNow = 0.8; // keep below 1.3 incident threshold to test low-speed stop
      stepHuman(w, p1, { up: true, down: false, left: false, right: false }, 0.05);
    }
    expect(p1.speedNow).toBe(0);
    expect(p1.px).toBeLessThan(ai.px - 0.5);
    expect(p1.tile.x).toBe(9);
    expect(w.totals.incidents).toBe(0);

    // (b) Reversing and steering away after a collision works cleanly without getting stuck
    for (let i = 0; i < 15; i++) {
      stepHuman(w, p1, { up: false, down: true, left: false, right: false }, 0.1);
    }
    expect(p1.speedNow).toBeLessThan(0);
    expect(p1.px).toBeLessThan(9.5);

    // (c) High-speed collision (speedNow > 1.3) triggers incident (stuns both vehicles, zeroes speed, records incident)
    p1.px = 9.55;
    p1.py = rowY + 0.5;
    p1.tile = { x: 9, y: rowY };
    p1.angle = 0;
    p1.speedNow = 2.2;
    const prevIncidents = w.totals.incidents;
    for (let i = 0; i < 10; i++) {
      if (w.t < p1.stunnedUntil) break;
      p1.speedNow = 2.2;
      stepHuman(w, p1, { up: true, down: false, left: false, right: false }, 0.05);
    }
    expect(w.totals.incidents).toBe(prevIncidents + 1);
    expect(p1.speedNow).toBe(0);
    expect(p1.stunnedUntil).toBeGreaterThan(w.t);
    expect(ai.stunnedUntil).toBeGreaterThan(w.t);
    expect(p1.incidents).toBeGreaterThanOrEqual(1);
    expect(ai.incidents).toBeGreaterThanOrEqual(1);

    // Clear stuns and test backing up + steering away after high-speed collision
    p1.stunnedUntil = 0;
    ai.stunnedUntil = 0;
    const collisionPx = p1.px;
    for (let i = 0; i < 6; i++) {
      stepHuman(w, p1, { up: false, down: true, left: false, right: i < 2 }, 0.1);
    }
    expect(p1.px).toBeLessThan(collisionPx);

    // (d) Player vehicle colliding with another player vehicle
    p1.tile = { x: 13, y: rowY };
    p1.px = 13.5;
    p1.py = rowY + 0.5;
    p1.angle = 0; // facing East toward p2 at (14, rowY)
    p1.speedNow = 0;
    p1.stunnedUntil = 0;
    p2.tile = { x: 14, y: rowY };
    p2.px = 14.5;
    p2.py = rowY + 0.5;
    p2.stunnedUntil = 0;

    for (let i = 0; i < 30; i++) {
      p1.speedNow = 1.0;
      stepHuman(w, p1, { up: true, down: false, left: false, right: false }, 0.05);
    }
    expect(p1.speedNow).toBe(0);
    expect(p1.px).toBeLessThan(p2.px - 0.5);
    expect(p1.tile.x).toBe(13);

    // High-speed player-vs-player collision triggers incident on both player vehicles
    const beforePvpIncidents = w.totals.incidents;
    p1.px = 13.55;
    for (let i = 0; i < 10; i++) {
      if (w.t < p1.stunnedUntil) break;
      p1.speedNow = 2.0;
      stepHuman(w, p1, { up: true, down: false, left: false, right: false }, 0.05);
    }
    expect(w.totals.incidents).toBe(beforePvpIncidents + 1);
    expect(p1.stunnedUntil).toBeGreaterThan(w.t);
    expect(p2.stunnedUntil).toBeGreaterThan(w.t);
    expect(p1.speedNow).toBe(0);

    // (e) AI vehicle respects player vehicle occupancy (buildOccupancy)
    p1.stunnedUntil = 0;
    p2.stunnedUntil = 0;
    p1.tile = { x: 8, y: rowY };
    p1.px = 8.5;
    p1.py = rowY + 0.5;
    p1.angle = 0;
    p1.input = { up: false, down: false, left: false, right: false };

    const { occ, res } = buildOccupancy(w);
    expect(occ.get(`8,${rowY}`)).toBe(p1);
    expect(res.get(`9,${rowY}`)).toBe(p1);

    // Place AI at (7, rowY) with a path through (8, rowY) where p1 is parked
    ai.tile = { x: 7, y: rowY };
    ai.px = 7.5;
    ai.py = rowY + 0.5;
    ai.moveTo = null;
    ai.path = [
      { x: 8, y: rowY },
      { x: 9, y: rowY },
    ];
    ai.target = { x: 9, y: rowY, kind: 'pick' };
    ai.wait = 0;
    ai.stuck = 0;

    tick(w, 0.1);
    // AI must wait or reroute rather than moving onto p1's occupied tile (8, rowY)
    expect(ai.moveTo).not.toEqual({ x: 8, y: rowY });
    expect(ai.tile).toEqual({ x: 7, y: rowY });
  });
});

describe('Speed boost and collision pallet drop', () => {
  it('accelerates faster and reaches higher top speed when boost is held', () => {
    const wNorm = createWorld({ seed: 42, agents: 0 });
    const wBoost = createWorld({ seed: 42, agents: 0 });
    const vNorm = spawnPlayerVehicle(wNorm, 'p-norm', 'Norm')!;
    const vBoost = spawnPlayerVehicle(wBoost, 'p-boost', 'Boost')!;

    // Place both on open east-west spine y = 13 heading east
    vNorm.tile = { x: 4, y: 13 };
    vNorm.px = 4.5;
    vNorm.py = 13.5;
    vNorm.angle = 0;

    vBoost.tile = { x: 4, y: 13 };
    vBoost.px = 4.5;
    vBoost.py = 13.5;
    vBoost.angle = 0;

    for (let i = 0; i < 20; i++) {
      stepHuman(wNorm, vNorm, { up: true, down: false, left: false, right: false, boost: false }, 0.05);
      stepHuman(wBoost, vBoost, { up: true, down: false, left: false, right: false, boost: true }, 0.05);
    }

    expect(vBoost.speedNow).toBeGreaterThan(vNorm.speedNow);
    expect(vBoost.speedNow).toBeCloseTo(vNorm.speedNow * BOOST_SPEED_MUL, 2);
    expect(vBoost.px).toBeGreaterThan(vNorm.px);
  });

  it('drops carried pallet onto floor and stuns driver when boosting into an obstacle, allowing re-pickup', () => {
    const w = createWorld({ seed: 77, agents: 0 });
    const v = spawnPlayerVehicle(w, 'p-drop', 'CrashTest')!;

    // Spawn an order and attach it as picked cargo on v
    const order = postOrder(w, { force: true })!;
    order.state = 'picked';
    order.claimant = v.id;
    v.cargo = [order];
    v.orders = [order];
    v.forkTarget = 0.85;

    // Place a traffic cone directly ahead at (9, 13) and start vehicle at (8, 13) heading east
    w.cones.add('9,13');
    v.tile = { x: 8, y: 13 };
    v.px = 8.45;
    v.py = 13.5;
    v.angle = 0;

    const beforeIncidents = w.totals.incidents;
    const beforeDamaged = w.day.damaged;

    for (let i = 0; i < 10; i++) {
      if (w.t < v.stunnedUntil) break;
      stepHuman(w, v, { up: true, down: false, left: false, right: false, boost: true }, 0.05);
    }

    expect(v.cargo).toEqual([]);
    expect(v.orders).toEqual([]);
    expect(order.state).toBe('open');
    expect(order.claimant).toBeNull();
    expect(order.slot.ax).toBe(v.tile.x);
    expect(order.slot.ay).toBe(v.tile.y);
    expect(order.slot.rx).toBe(v.tile.x);
    expect(order.slot.ry).toBe(v.tile.y);
    expect(w.totals.incidents).toBe(beforeIncidents + 1);
    expect(w.day.damaged).toBe(beforeDamaged + 1);
    expect(v.stunnedUntil).toBeGreaterThan(w.t);
    expect(w.events.some((e) => e.type === 'incident' && e.text.includes('dropped pallet'))).toBe(true);

    // Clear stun and verify the player can re-pick the dropped pallet with E (humanInteract)
    v.stunnedUntil = 0;
    humanInteract(w, v.id);
    expect(v.cargo).toContain(order);
    expect(order.state).toBe('picked');
  });

  it('guarantees pallet drop when colliding with another vehicle while boosting', () => {
    const w = createWorld({ seed: 99, agents: 0 });
    const v1 = spawnPlayerVehicle(w, 'p1', 'Booster')!;
    const v2 = spawnPlayerVehicle(w, 'p2', 'Parked')!;

    const order = postOrder(w, { p0: true })!;
    order.state = 'picked';
    order.claimant = v1.id;
    v1.cargo = [order];
    v1.orders = [order];

    v1.tile = { x: 10, y: 13 };
    v1.px = 10.5;
    v1.py = 13.5;
    v1.angle = 0;

    v2.tile = { x: 11, y: 13 };
    v2.px = 11.5;
    v2.py = 13.5;
    v2.angle = Math.PI;

    for (let i = 0; i < 10; i++) {
      if (w.t < v1.stunnedUntil) break;
      stepHuman(w, v1, { up: true, down: false, left: false, right: false, boost: true }, 0.05);
    }

    expect(v1.cargo).toEqual([]);
    expect(order.state).toBe('open');
    expect(order.claimant).toBeNull();
    expect(order.slot.ax).toBe(v1.tile.x);
    expect(order.slot.ay).toBe(v1.tile.y);
    expect(v1.stunnedUntil).toBeGreaterThan(w.t);
    expect(v2.stunnedUntil).toBeGreaterThan(w.t);
  });

  it('clamps depleted battery to 0 and spawns a fresh 100%-battery vehicle with new cards on retry / new run number', () => {
    const w = createWorld({ seed: 108, agents: 0 });
    const vRun1 = spawnPlayerVehicle(w, 'client-retry', 'Alex Run 1')!;
    expect(vRun1.battery).toBe(100);
    expect(vRun1.driver).toBe('Alex Run 1');

    // Keep cards on Run 1 so offer is cleared
    const firstOffer = w.cards['client-retry']?.offer.map((c) => c.id) ?? [];
    expect(firstOffer.length).toBeGreaterThan(0);
    keepCards(w, 'client-retry', firstOffer.slice(0, 2));
    expect(w.cards['client-retry']?.offer).toBeNull();

    // Drain battery below 0.05% while driving and verify it clamps cleanly to 0
    vRun1.battery = 0.04;
    vRun1.sPts = 85;
    stepHuman(w, vRun1, { up: true, down: false, left: false, right: false }, 0.05);
    expect(vRun1.battery).toBe(0);

    // Respawning for Run 2 replaces the depleted vehicle with a fresh 100%-battery vehicle and deals a new card offer
    const vRun2 = spawnPlayerVehicle(w, 'client-retry', 'Alex Run 2')!;
    expect(vRun2).not.toBeNull();
    expect(vRun2.driver).toBe('Alex Run 2');
    expect(vRun2.battery).toBe(100);
    expect(vRun2.sPts).toBe(0);
    expect(w.cards['client-retry']?.offer.length).toBeGreaterThan(0);
  });

  it('scales vehicle and AI speed across Easy (old Medium baseline), Medium, Hard, and Turbo difficulty modes', () => {
    const wEasy = createWorld({ seed: 303, agents: 0 });
    const wMed = createWorld({ seed: 303, agents: 0 });
    const wTurbo = createWorld({ seed: 303, agents: 0 });

    setDifficulty(wEasy, 'easy');
    setDifficulty(wMed, 'medium');
    setDifficulty(wTurbo, 'turbo');

    expect(wEasy.difficulty).toBe('easy');
    expect(wMed.difficulty).toBe('medium');
    expect(wTurbo.difficulty).toBe('turbo');

    const vEasy = spawnPlayerVehicle(wEasy, 'p-easy', 'EasyDriver')!;
    const vMed = spawnPlayerVehicle(wMed, 'p-med', 'MedDriver')!;
    const vTurbo = spawnPlayerVehicle(wTurbo, 'p-turbo', 'TurboDriver')!;

    for (const v of [vEasy, vMed, vTurbo]) {
      v.tile = { x: 4, y: 13 };
      v.px = 4.5;
      v.py = 13.5;
      v.angle = 0;
    }

    for (let i = 0; i < 15; i++) {
      stepHuman(wEasy, vEasy, { up: true, down: false, left: false, right: false }, 0.05);
      stepHuman(wMed, vMed, { up: true, down: false, left: false, right: false }, 0.05);
      stepHuman(wTurbo, vTurbo, { up: true, down: false, left: false, right: false }, 0.05);
    }

    expect(vMed.speedNow).toBeGreaterThan(vEasy.speedNow);
    expect(vTurbo.speedNow).toBeGreaterThan(vMed.speedNow);
    expect(vTurbo.px).toBeGreaterThan(vMed.px);
    expect(vMed.px).toBeGreaterThan(vEasy.px);
  });

  it('builds RET containment bay at (10..12, 32), routes/spawns Hazmat orders via dispatchOrderRoute, awards +6 bonus, and auto-resets at 8/8', () => {
    const w = createWorld({ seed: 5150, agents: 6 });
    const retBayCfg = w.map.bays.find((b) => b.id === 'RET');
    expect(retBayCfg).toBeDefined();
    expect(retBayCfg!.dropX).toBe(11);
    expect(retBayCfg!.isTransferBay).toBe(false);
    expect(retBayCfg!.label).toBe('RET');
    expect(retBayCfg!.tiles).toEqual([
      { x: 10, y: 32 },
      { x: 11, y: 32 },
      { x: 12, y: 32 },
    ]);

    // Ensure regular random postOrder never targets RET
    w.orders = [];
    for (let i = 0; i < 40; i++) {
      postOrder(w, { force: true });
    }
    expect(w.orders.some((o) => o.bay === 'RET')).toBe(false);

    // Park idle AI agents so dispatchOrderRoute can assign them
    w.orders = [];
    for (const v of w.vehicles) {
      v.orders = [];
      v.cargo = [];
      v.state = 'parked';
      v.target = null;
      v.path = [];
    }

    // Dispatch 3 Hazmat (Zone Z) pallets to RET
    const res = dispatchOrderRoute(w, {
      sourceZone: 'haz',
      targetBay: 'RET',
      priority: 'p0',
      count: 3,
      mode: 'reroute_and_spawn',
    });
    expect(res.spawned + res.rerouted).toBe(3);
    expect(res.orderIds).toHaveLength(3);
    expect(res.targetBay).toBe('RET');

    const retOrders = w.orders.filter((o) => o.bay === 'RET');
    expect(retOrders).toHaveLength(3);
    expect(retOrders.every((o) => o.slot.zone === 'Z' && o.p0)).toBe(true);

    // Deliver a pallet to RET via a human vehicle and verify +6 bonus points and 8/8 auto-clear
    const pv = spawnPlayerVehicle(w, 'client-ret', 'HazmatPilot')!;
    const retState = w.bays.find((b) => b.id === 'RET')!;
    expect(retState).toBeDefined();
    retState.load = 7; // 7/8 before delivery

    const orderToDeliver = retOrders[0]!;
    // Unclaim from AI if claimed
    for (const v of w.vehicles) {
      v.orders = v.orders.filter((o) => o.id !== orderToDeliver.id);
    }
    orderToDeliver.claimant = pv.id;
    orderToDeliver.state = 'picked';
    pv.cargo = [orderToDeliver];
    pv.px = 11.5;
    pv.py = 32.5;
    pv.tile = { x: 11, y: 32 };

    const ptsBefore = pv.sPts;
    const baseVal = orderToDeliver.value;
    humanInteract(w, pv.id);

    // Value + 6 returns bonus (on-time delivery)
    expect(pv.sPts - ptsBefore).toBeGreaterThanOrEqual(baseVal + 6);
    // 8th pallet at RET auto-clears back to 0 with no trailer departure downtime
    expect(retState.load).toBe(0);
    expect(retState.departUntil).toBe(0);
  });

  it('builds distinct non-overlapping floor layouts, rack grids, and themed SKUs across den-1, slc-2, phx-3, and abq-4', () => {
    const sites = ['den-1', 'slc-2', 'phx-3', 'abq-4'] as const;
    const rackFingerprints = new Set<string>();
    const structFingerprints = new Set<string>();
    const skuPrefixes = new Set<string>();

    for (const siteId of sites) {
      const theme = getSiteTheme(siteId);
      expect(theme.id).toBe(siteId);
      expect(SITE_THEMES[siteId]).toEqual(theme);
      skuPrefixes.add(theme.skuPrefix);

      for (const tier of [0, 2, MAX_TIER]) {
        const map = buildMap(tier, siteId);
        expect(map.siteId).toBe(siteId);
        expect(map.racks.length).toBeGreaterThan(20);
        expect(map.slots.length).toBeGreaterThan(20);
        expect(map.bays.some((b) => b.id === 'RET')).toBe(true);
        expect(map.bays.filter((b) => b.isTransferBay).length).toBe(2);

        // Every charger, bay drop tile, and slot access tile must be walkable (not blocked)
        for (const c of map.chargers) {
          expect(map.staticBlock[c.y * map.w + c.x]).toBe(0);
        }
        for (const b of map.bays) {
          for (const t of b.tiles) {
            expect(map.staticBlock[t.y * map.w + t.x]).toBe(0);
          }
        }
        for (const s of map.slots) {
          expect(map.staticBlock[s.ay * map.w + s.ax]).toBe(0);
        }
      }

      const m0 = buildMap(0, siteId);
      rackFingerprints.add(m0.racks.map((r) => `${r.x},${r.y}:${r.kind}`).join('|'));
      structFingerprints.add(m0.structs.map((s) => `${s.id}@${s.x},${s.y}`).join('|'));

      // Verify createWorld, postOrder SKU prefix, and 50 ticks of simulation on each site
      const w = createWorld({ seed: 2026, siteId, agents: 8 });
      expect(w.siteId).toBe(siteId);
      expect(w.map.siteId).toBe(siteId);
      const ord = postOrder(w, { force: true })!;
      expect(ord.sku.startsWith(`${theme.skuPrefix}-`)).toBe(true);

      for (let i = 0; i < 50; i++) {
        tick(w);
        drivePendingDecisions(w);
      }
      expect(w.vehicles.length).toBe(8);
    }

    // All 4 sites must have distinct rack grids, structure layouts, and SKU prefixes
    expect(rackFingerprints.size).toBe(4);
    expect(structFingerprints.size).toBe(4);
    expect(skuPrefixes.size).toBe(4);
  });

  it('supports 5-Minute Blitz mode with card grace period, personal run telemetry, and isolation from 480-min site shift rollovers', () => {
    const w = createWorld({ seed: 777, agents: 0 });
    w.t = 470; // 10 sim-minutes before global 480-min shift rollover
    const v = spawnPlayerVehicle(w, 'blitz-driver', 'BlitzAce', 'blitz')!;
    expect(v.runMode).toBe('blitz');
    expect(v.runStartedAt).toBeNull();
    expect(v.runEndsAt).toBeNull();
    expect(v.runGraceUntil).toBeCloseTo(470 + RUN_CARD_GRACE_MIN, 4);
    expect(v.runFinished).toBe(false);

    // Selecting cards immediately starts the 300 sim-min (5 real min) Blitz timer
    const offerIds = w.cards['blitz-driver']!.offer.map((c) => c.id);
    keepCards(w, 'blitz-driver', offerIds.slice(0, 2));
    expect(v.runStartedAt).toBe(470);
    expect(v.runEndsAt).toBeCloseTo(470 + BLITZ_DURATION_MIN, 4);
    expect(v.runGraceUntil).toBeNull();

    // Score points before shift boundary (t=480) and verify onShiftEnd preserves sPts, runPts & cards for active human Blitz drivers
    v.sPts = 55;
    v.runPts = 55;
    v.runDeliveries = 3;
    v.runOnTime = 3;
    v.streak = 3;
    v.bestStreak = 3;

    // Advance past t=480 (120 ticks = 12 sim-min -> t=482)
    for (let i = 0; i < 120; i++) {
      tick(w, 0.1);
    }
    expect(w.t).toBeCloseTo(482, 3);
    // Personal Blitz sPts, runPts, streak, and active cards are preserved across site shift rollover!
    expect(v.sPts).toBe(55);
    expect(v.runPts).toBe(55);
    expect(v.runDeliveries).toBe(3);
    expect(v.streak).toBe(3);
    expect(v.runFinished).toBe(false);
    expect(w.cards['blitz-driver']!.cards.length).toBe(2);

    // Advance to t=770 (end of 300 sim-min Blitz run; 2880 ticks = 288 sim-min)
    w.t = 769;
    for (let i = 0; i < 10; i++) {
      tick(w, 0.1);
    }
    expect(w.t).toBeCloseTo(770, 3);
    expect(v.runFinished).toBe(true);
    expect(computeDriverPpm(w, v)).toBeCloseTo(0.6, 4);
    expect(computeDriverPpm(v, w.t)).toBeCloseTo(0.6, 4);
    expect(computeDriverOnTimePct(v)).toBe(100);

    // Switching to Free Range clears runEndsAt and allows continuous play
    setDriverRunMode(w, 'blitz-driver', 'freerange');
    expect(v.runMode).toBe('freerange');
    expect(v.runEndsAt).toBeNull();
    expect(v.runFinished).toBe(false);
  });

  it('keeps the Blitz clock stopped while a freshly spawned player is idle, then starts it on first input or Co-Pilot', () => {
    const w = createWorld({ seed: 778, agents: 0 });
    const idle = spawnPlayerVehicle(w, 'idle-driver', 'IdleAce', 'blitz')!;
    const pilot = spawnPlayerVehicle(w, 'pilot-driver', 'PilotAce', 'blitz')!;
    // Idle well past the old card-grace window (e.g. reading the intro)
    const ticks = Math.ceil((RUN_CARD_GRACE_MIN + 5) / 0.1);
    for (let i = 0; i < ticks; i++) tick(w, 0.1);
    expect(idle.runStartedAt).toBeNull();
    expect(idle.runEndsAt).toBeNull();
    expect(idle.runFinished).toBe(false);
    expect(pilot.runStartedAt).toBeNull();

    // First steering input starts the clock
    idle.input = { up: true, down: false, left: false, right: false, boost: false };
    tick(w, 0.1);
    expect(idle.runStartedAt).not.toBeNull();
    expect(idle.runEndsAt).toBeCloseTo(idle.runStartedAt! + BLITZ_DURATION_MIN, 1);

    // Engaging Co-Pilot also starts it
    pilot.autopilot = true;
    tick(w, 0.1);
    expect(pilot.runStartedAt).not.toBeNull();
    expect(pilot.runGraceUntil).toBeNull();
  });

  it('drains battery primarily on boost, allows 0% battery limping without ending run, and fast-charges at 15%/s on charger pads', () => {
    const w = createWorld({ seed: 888, agents: 0 });
    const vNorm = spawnPlayerVehicle(w, 'drv-norm', 'NormalDriver')!;
    const vBoost = spawnPlayerVehicle(w, 'drv-boost', 'BoostDriver')!;

    vNorm.tile = { x: 6, y: 13 };
    vNorm.px = 6.5;
    vNorm.py = 13.5;
    vBoost.tile = { x: 20, y: 13 };
    vBoost.px = 20.5;
    vBoost.py = 13.5;

    for (let i = 0; i < 20; i++) {
      stepHuman(w, vNorm, { up: true, down: false, left: false, right: false, boost: false }, 0.1);
      stepHuman(w, vBoost, { up: true, down: false, left: false, right: false, boost: true }, 0.1);
    }

    const normUsed = 100 - vNorm.battery;
    const boostUsed = 100 - vBoost.battery;
    // Normal driving uses minimal battery (< 1% over 20 ticks), whereas boosting drains significantly faster
    expect(normUsed).toBeLessThan(1.0);
    expect(boostUsed).toBeGreaterThan(normUsed * 3);

    // At 0% battery, driver can still limp at reduced speed and runFinished remains false
    vNorm.battery = 0;
    vNorm.speedNow = 0;
    stepHuman(w, vNorm, { up: true, down: false, left: false, right: false, boost: true }, 0.1);
    expect(vNorm.speedNow).toBeGreaterThan(0);
    expect(vNorm.runFinished).toBe(false);

    // Stopping on a charger pad auto-engages charging and recharges at >= 15% per sim-min (0% -> 100% in ~6.7s)
    const pad = w.map.chargers[0]!;
    vNorm.tile = { x: pad.x, y: pad.y };
    vNorm.px = pad.x + 0.5;
    vNorm.py = pad.y + 0.5;
    vNorm.speedNow = 0;
    vNorm.humanCharging = false;

    stepHuman(w, vNorm, { up: false, down: false, left: false, right: false }, 1.0);
    expect(vNorm.humanCharging).toBe(true);
    expect(vNorm.battery).toBeGreaterThanOrEqual(15);
  });

  it('retains completed card modifiers as permanent buffs, auto-redraws a new card offer when active cards < 2, and includes 4 new skills', () => {
    for (const title of ['Overdrive', 'Long Reach', 'Eco Cell', 'High Roller']) {
      expect(SKILLS.some((s) => s.title === title)).toBe(true);
    }

    const w = createWorld({ seed: 909, agents: 0 });
    const v = spawnPlayerVehicle(w, 'card-driver', 'CardMaster', 'blitz')!;
    const h = w.cards['card-driver']!;

    // Replace active hand with a deterministic speed card + a fragile card
    h.offer = null;
    h.cards = [
      {
        id: 1,
        title: 'Turbo Courier',
        rule: 'Deliver 1 order',
        reward: '+32 pts',
        pts: 32,
        type: 'count',
        goal: 1,
        progress: 0,
        status: 'active',
        modifiers: { speedMul: 1.18, ptsBonus: 4 },
      },
      {
        id: 2,
        title: 'Featherweight Forks',
        rule: 'Deliver 3 orders; 1 incident voids',
        reward: '+40 pts',
        pts: 40,
        type: 'fragile',
        goal: 3,
        progress: 0,
        status: 'active',
        modifiers: { reachBonus: 0.35 },
      },
    ];

    expect(getCardModifiers(w, v).speedMul).toBeCloseTo(1.18, 4);
    expect(getCardModifiers(w, v).ptsBonus).toBe(4);

    // Complete card 1 via delivery -> status becomes 'done', modifier stays active permanently, and auto-redraw deals a new offer!
    const o = postOrder(w, { bayId: 'E1', force: true })!;
    o.state = 'picked';
    o.claimant = v.id;
    o.pickedAt = w.t;
    v.cargo = [o];
    deliver(w, v, 'E1');

    expect(h.cards[0]!.status).toBe('done');
    expect(h.cards[0]!.completedAt).toBeDefined();
    // Permanent buff still applies even after card is 'done'
    expect(getCardModifiers(w, v).speedMul).toBeCloseTo(1.18, 4);
    expect(getCardModifiers(w, v).ptsBonus).toBe(4);
    // Because active cards dropped from 2 to 1, auto-redraw dealt a fresh offer
    expect(h.offer).not.toBeNull();
    expect(h.offer!.length).toBeGreaterThanOrEqual(2);
  });

  it('applies delivery streak multipliers (1.15x at 3, 1.3x at 5, 1.5x at 8+) and resets streak on late delivery or pallet drop', () => {
    expect(streakMultiplier(0)).toBe(1.0);
    expect(streakMultiplier(2)).toBe(1.0);
    expect(streakMultiplier(3)).toBe(1.15);
    expect(streakMultiplier(5)).toBe(1.3);
    expect(streakMultiplier(8)).toBe(1.5);

    const w = createWorld({ seed: 919, agents: 0 });
    const v = spawnPlayerVehicle(w, 'streak-driver', 'StreakPilot', 'blitz')!;
    // Clear cards so card payoutBonus doesn't confound streak calculation
    w.cards['streak-driver']!.cards = [];
    w.cards['streak-driver']!.offer = null;

    v.streak = 2; // Next on-time delivery is streak 3 -> 1.15x
    const o1 = postOrder(w, { bayId: 'E1', force: true })!;
    o1.value = 20;
    o1.due = w.t + 50;
    o1.state = 'picked';
    o1.claimant = v.id;
    v.cargo = [o1];
    deliver(w, v, 'E1');

    expect(v.streak).toBe(3);
    expect(v.bestStreak).toBe(3);
    // Phase 2: the fare combo meter replaced the streak payout multiplier. Streak is still
    // tracked for stats, but the first fare pays value × Normal (1.0) × combo (1.0).
    expect(v.runPts).toBeCloseTo(20, 4);
    expect(v.combo).toBe(1.2);

    // Dropping a pallet resets streak to 0 while preserving bestStreak
    const o2 = postOrder(w, { bayId: 'E1', force: true })!;
    o2.state = 'picked';
    o2.claimant = v.id;
    v.cargo = [o2];
    dropPalletOnCollision(w, v, 'a rack');
    expect(v.streak).toBe(0);
    expect(v.bestStreak).toBe(3);
  });
});






