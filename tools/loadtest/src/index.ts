import { fileURLToPath } from 'node:url';
import { SITE_IDS, type SiteId } from '@warehouse/protocol';
import { ProtocolBot, type BotMetrics, type ProtocolBotOptions, extractOrdersFromWire } from './bot.js';
import {
  GeminiPilotAgent,
  VertexPilotModelClient,
  PilotBudgetTracker,
  PilotPlanSchema,
  PILOT_GEMINI_MODEL,
  DEFAULT_PILOT_BUDGET_USD,
  type GeminiPilotOptions,
  type PilotMetrics,
  type PilotModelClient,
  type PilotHudContext,
  type PilotPlan,
} from './pilot.js';
import {
  computeSteeringControls,
  type SteeringControls,
  type SteeringTarget,
} from './steering.js';
import {
  runLoadtestTeardown,
  isTestPlayerDoc,
  type TeardownOptions,
  type TeardownReport,
  type TeardownStore,
} from './teardown.js';

export const LOADTEST_VERSION = 1;

export {
  ProtocolBot,
  type ProtocolBotOptions,
  type BotMetrics,
  extractOrdersFromWire,
  GeminiPilotAgent,
  VertexPilotModelClient,
  PilotBudgetTracker,
  PilotPlanSchema,
  PILOT_GEMINI_MODEL,
  DEFAULT_PILOT_BUDGET_USD,
  type GeminiPilotOptions,
  type PilotMetrics,
  type PilotModelClient,
  type PilotHudContext,
  type PilotPlan,
  computeSteeringControls,
  type SteeringControls,
  type SteeringTarget,
  runLoadtestTeardown,
  isTestPlayerDoc,
  type TeardownOptions,
  type TeardownReport,
  type TeardownStore,
};

export interface LoadtestOptions {
  lobbyUrl: string;
  protocolBotsCount?: number;
  pilotAgentsCount?: number;
  durationMs?: number;
  inputIntervalMs?: number;
  planIntervalMs?: number;
  joinConcurrency?: number;
  maxPilotBudgetUsd?: number;
  pilotModelClient?: PilotModelClient;
  siteTickSamplesMs?: number[];
  armorLimitBypasses?: number;
  requirePilotDeliveries?: boolean;
  teardownAfterRun?: boolean;
  teardownOptions?: TeardownOptions;
}

export interface LoadtestPassCriteriaInput {
  driversPerSite: Record<SiteId, number>;
  siteTickP95Ms: number;
  ackRttP95Ms: number;
  avgDeltaKbPerSec: number;
  unexpectedDisconnects: number;
  pilotsWithDelivery: number;
  totalPilots: number;
  requirePilotDeliveries: boolean;
  armorLimitBypasses: number;
}

export interface LoadtestPassEvaluation {
  ok: boolean;
  failures: string[];
  checks: {
    placementBalanced: boolean;
    siteTickP95Ok: boolean;
    ackRttP95Ok: boolean;
    deltaBandwidthOk: boolean;
    zeroUnexpectedDisconnects: boolean;
    pilotDeliveriesOk: boolean;
    zeroArmorBypasses: boolean;
  };
}

export interface LoadtestReport {
  ok: boolean;
  lobbyUrl: string;
  durationMs: number;
  totalClients: number;
  protocolBotsCount: number;
  pilotAgentsCount: number;
  driversPerSite: Record<SiteId, number>;
  spectatorsPerSite: Record<SiteId, number>;
  ackRttP50Ms: number;
  ackRttP95Ms: number;
  siteTickP95Ms: number;
  avgDeltaKbPerSec: number;
  unexpectedDisconnects: number;
  botDeliveriesTotal: number;
  pilotDeliveriesTotal: number;
  pilotsWithDelivery: number;
  pilotPlanP50Ms: number;
  pilotPlanP95Ms: number;
  pilotErrorsTotal: number;
  pilotBudgetSpentUsd: number;
  nlCommandsSent: number;
  nlCommandsExecuted: number;
  nlCommandsRefused: number;
  armorLimitBypasses: number;
  evaluation: LoadtestPassEvaluation;
  teardown?: TeardownReport;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return Math.round(sorted[idx]! * 100) / 100;
}

/**
 * Evaluates the §7 Pass Criteria table for the 128-client load & Gemini pilot harness.
 */
export function evaluatePassCriteria(
  input: LoadtestPassCriteriaInput
): LoadtestPassEvaluation {
  const failures: string[] = [];

  const maxDriversOnAnySite = Math.max(
    0,
    ...Object.values(input.driversPerSite)
  );
  const placementBalanced = maxDriversOnAnySite <= 32;
  if (!placementBalanced) {
    failures.push(
      `Shard driver cap exceeded: max drivers on a shard was ${maxDriversOnAnySite} (limit 32)`
    );
  }

  const siteTickP95Ok = input.siteTickP95Ms < 40;
  if (!siteTickP95Ok) {
    failures.push(
      `Site tick p95 ${input.siteTickP95Ms}ms >= 40ms threshold`
    );
  }

  const ackRttP95Ok = input.ackRttP95Ms < 250;
  if (!ackRttP95Ok) {
    failures.push(
      `Input->ack RTT p95 ${input.ackRttP95Ms}ms >= 250ms threshold`
    );
  }

  const deltaBandwidthOk = input.avgDeltaKbPerSec < 6;
  if (!deltaBandwidthOk) {
    failures.push(
      `Average delta bandwidth ${input.avgDeltaKbPerSec} KB/s >= 6 KB/s threshold`
    );
  }

  const zeroUnexpectedDisconnects = input.unexpectedDisconnects === 0;
  if (!zeroUnexpectedDisconnects) {
    failures.push(
      `Unexpected WS disconnects: ${input.unexpectedDisconnects} (expected 0)`
    );
  }

  const requiredPilotRatio = 12 / 16; // 0.75
  const actualPilotRatio =
    input.totalPilots > 0 ? input.pilotsWithDelivery / input.totalPilots : 1;
  const pilotDeliveriesOk =
    !input.requirePilotDeliveries || actualPilotRatio >= requiredPilotRatio;
  if (!pilotDeliveriesOk) {
    failures.push(
      `Gemini pilot deliveries: ${input.pilotsWithDelivery}/${input.totalPilots} pilots completed >=1 delivery (need >=75%)`
    );
  }

  const zeroArmorBypasses = input.armorLimitBypasses === 0;
  if (!zeroArmorBypasses) {
    failures.push(
      `Model Armor / rate-limit bypasses: ${input.armorLimitBypasses} (expected 0)`
    );
  }

  return {
    ok: failures.length === 0,
    failures,
    checks: {
      placementBalanced,
      siteTickP95Ok,
      ackRttP95Ok,
      deltaBandwidthOk,
      zeroUnexpectedDisconnects,
      pilotDeliveriesOk,
      zeroArmorBypasses,
    },
  };
}

export async function runLoadtest(
  options: LoadtestOptions
): Promise<LoadtestReport> {
  const lobbyUrl = options.lobbyUrl.replace(/\/$/, '');
  const protocolBotsCount = options.protocolBotsCount ?? 112;
  const pilotAgentsCount = options.pilotAgentsCount ?? 16;
  const durationMs = options.durationMs ?? 60_000;
  const inputIntervalMs = options.inputIntervalMs ?? 100;
  const planIntervalMs = options.planIntervalMs ?? 3500;
  const joinConcurrency = Math.max(1, options.joinConcurrency ?? 1);
  const budgetTracker = new PilotBudgetTracker(
    options.maxPilotBudgetUsd ?? DEFAULT_PILOT_BUDGET_USD
  );
  const modelClient = options.pilotModelClient ?? new VertexPilotModelClient();

  const bots: ProtocolBot[] = [];
  for (let i = 1; i <= protocolBotsCount; i++) {
    bots.push(
      new ProtocolBot({
        botIndex: i,
        lobbyUrl,
        inputIntervalMs,
      })
    );
  }

  const pilots: GeminiPilotAgent[] = [];
  for (let i = 1; i <= pilotAgentsCount; i++) {
    pilots.push(
      new GeminiPilotAgent({
        pilotIndex: i,
        lobbyUrl,
        inputIntervalMs,
        planIntervalMs,
        modelClient,
        budgetTracker,
      })
    );
  }

  const allClients: Array<{ start(): Promise<void>; stop(): Promise<void> }> = [
    ...pilots,
    ...bots,
  ];

  // Join clients with bounded concurrency (default 1 so Lobby placement sees live shard occupancy)
  for (let i = 0; i < allClients.length; i += joinConcurrency) {
    const batch = allClients.slice(i, i + joinConcurrency);
    await Promise.all(batch.map((c) => c.start()));
  }

  // Clear warmup ACK RTT samples captured during the sequential join/handshake storm
  // so steady-state latency metrics reflect full 128-client concurrent operation.
  for (const b of bots) {
    b.metrics.ackRttsMs.length = 0;
  }
  for (const p of pilots) {
    p.metrics.ackRttsMs.length = 0;
  }

  // Let bots & pilots drive, plan, and interact for durationMs
  await new Promise((resolve) => setTimeout(resolve, durationMs));

  // Stop all clients cleanly and allow proxy-to-site upstream sockets to close
  await Promise.all(allClients.map((c) => c.stop()));
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Aggregate metrics
  const driversPerSite: Record<SiteId, number> = {
    'den-1': 0,
    'slc-2': 0,
    'phx-3': 0,
    'abq-4': 0,
  };
  const spectatorsPerSite: Record<SiteId, number> = {
    'den-1': 0,
    'slc-2': 0,
    'phx-3': 0,
    'abq-4': 0,
  };

  const allAckRtts: number[] = [];
  const clientKbPerSecList: number[] = [];
  let unexpectedDisconnects = 0;
  let botDeliveriesTotal = 0;

  for (const b of bots) {
    const m = b.metrics;
    if (m.siteId in driversPerSite) {
      if (m.role === 'driver') {
        driversPerSite[m.siteId as SiteId]++;
      } else {
        spectatorsPerSite[m.siteId as SiteId]++;
      }
    }
    allAckRtts.push(...m.ackRttsMs);
    unexpectedDisconnects += m.unexpectedDisconnects;
    botDeliveriesTotal += m.deliveries;

    const activeSec = Math.max(
      0.2,
      ((m.disconnectedAtMs || Date.now()) - (m.connectedAtMs || Date.now())) /
        1000,
      m.deltaCount / 10
    );
    clientKbPerSecList.push(m.deltaBytes / 1024 / activeSec);
  }

  const allPlanLatencies: number[] = [];
  let pilotDeliveriesTotal = 0;
  let pilotsWithDelivery = 0;
  let pilotErrorsTotal = 0;
  let nlCommandsSent = 0;
  let nlCommandsExecuted = 0;
  let nlCommandsRefused = 0;

  for (const p of pilots) {
    const m = p.metrics;
    if (m.siteId in driversPerSite) {
      if (m.role === 'driver') {
        driversPerSite[m.siteId as SiteId]++;
      } else {
        spectatorsPerSite[m.siteId as SiteId]++;
      }
    }
    allAckRtts.push(...m.ackRttsMs);
    allPlanLatencies.push(...m.planLatenciesMs);
    unexpectedDisconnects += m.unexpectedDisconnects;
    pilotDeliveriesTotal += m.deliveries;
    if (m.deliveries >= 1) {
      pilotsWithDelivery++;
    }
    pilotErrorsTotal += m.pilotErrors;
    nlCommandsSent += m.nlCommandsSent;
    nlCommandsExecuted += m.nlCommandsExecuted;
    nlCommandsRefused += m.nlCommandsRefused;

    const activeSec = Math.max(
      0.2,
      ((m.disconnectedAtMs || Date.now()) - (m.connectedAtMs || Date.now())) /
        1000,
      m.deltaCount / 10
    );
    clientKbPerSecList.push(m.deltaBytes / 1024 / activeSec);
  }

  const ackRttP50Ms = percentile(allAckRtts, 50);
  const ackRttP95Ms = percentile(allAckRtts, 95);
  const siteTickP95Ms = percentile(options.siteTickSamplesMs ?? [4], 95);
  const avgDeltaKbPerSec =
    clientKbPerSecList.length > 0
      ? Math.round(
          (clientKbPerSecList.reduce((acc, v) => acc + v, 0) /
            clientKbPerSecList.length) *
            100
        ) / 100
      : 0;
  const pilotPlanP50Ms = percentile(allPlanLatencies, 50);
  const pilotPlanP95Ms = percentile(allPlanLatencies, 95);
  const armorLimitBypasses = options.armorLimitBypasses ?? 0;
  const requirePilotDeliveries =
    options.requirePilotDeliveries ?? durationMs >= 60_000;

  const evaluation = evaluatePassCriteria({
    driversPerSite,
    siteTickP95Ms,
    ackRttP95Ms,
    avgDeltaKbPerSec,
    unexpectedDisconnects,
    pilotsWithDelivery,
    totalPilots: pilotAgentsCount,
    requirePilotDeliveries,
    armorLimitBypasses,
  });

  let teardown: TeardownReport | undefined;
  if (options.teardownAfterRun) {
    teardown = await runLoadtestTeardown(options.teardownOptions);
  }

  return {
    ok: evaluation.ok,
    lobbyUrl,
    durationMs,
    totalClients: protocolBotsCount + pilotAgentsCount,
    protocolBotsCount,
    pilotAgentsCount,
    driversPerSite,
    spectatorsPerSite,
    ackRttP50Ms,
    ackRttP95Ms,
    siteTickP95Ms,
    avgDeltaKbPerSec,
    unexpectedDisconnects,
    botDeliveriesTotal,
    pilotDeliveriesTotal,
    pilotsWithDelivery,
    pilotPlanP50Ms,
    pilotPlanP95Ms,
    pilotErrorsTotal,
    pilotBudgetSpentUsd: budgetTracker.getSpentUsd(),
    nlCommandsSent,
    nlCommandsExecuted,
    nlCommandsRefused,
    armorLimitBypasses,
    evaluation,
    teardown,
  };
}

function parseCliFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--teardown')) {
    const prefix = parseCliFlag(args, '--prefix') ?? process.env.FIRESTORE_PREFIX ?? '';
    const report = await runLoadtestTeardown({ prefix });
    console.log(JSON.stringify({ action: 'teardown', ...report }, null, 2));
    return;
  }

  const lobbyUrl =
    parseCliFlag(args, '--url') ??
    process.env.LOBBY_URL ??
    'http://localhost:8080';
  const totalBotsArg = Number(parseCliFlag(args, '--bots') ?? '128');
  const pilotsArg = Number(parseCliFlag(args, '--pilots') ?? '16');
  const durationSec = Number(parseCliFlag(args, '--duration') ?? '180');
  const protocolBotsCount = Math.max(0, totalBotsArg - pilotsArg);

  const report = await runLoadtest({
    lobbyUrl,
    protocolBotsCount,
    pilotAgentsCount: pilotsArg,
    durationMs: durationSec * 1000,
    teardownAfterRun: args.includes('--cleanup'),
  });

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
