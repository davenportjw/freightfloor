import { FieldValue, Firestore, Timestamp } from '@google-cloud/firestore';
import { PubSub, type Message, type Subscription } from '@google-cloud/pubsub';
import type { ArmorReasonCode } from '@warehouse/armor';
import {
  DAILY_ENTRY_TTL_DAYS,
  LEAGUE_ENTRY_TTL_DAYS,
  GEMINI_FLASH_LITE_PRICE_PER_M_TOKENS,
  addDays,
  dailyInfoFor,
  dayKeyToMs,
  nextDailyStreak,
  nextLeagueRuns,
  weekEndMs,
  type DailyStreakState,
  type DecisionKind,
  type LiveryId,
  type LiveryProfile,
  type Phase,
  type SiteId,
  type Transfer,
} from '@warehouse/protocol';
import type { WorldSnapshotV5 } from '@warehouse/sim';
import type { BrainHealth } from './brain.js';

export type SitePhase = Phase;
export type WorldSnapshot = WorldSnapshotV5;

export const AGENT_DAILY_BUDGET_USD =
  Number(process.env.AGENT_DAILY_BUDGET_USD) > 0
    ? Number(process.env.AGENT_DAILY_BUDGET_USD)
    : 10;
export const NL_COMMAND_DAILY_BUDGET_USD =
  Number(process.env.NL_COMMAND_DAILY_BUDGET_USD) > 0
    ? Number(process.env.NL_COMMAND_DAILY_BUDGET_USD)
    : 1.5;
export const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
export const JOURNAL_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface SiteHeartbeatDoc {
  siteId: SiteId;
  url: string;
  region: string;
  phase: SitePhase;
  players: number;
  spectators: number;
  agents: number;
  maxDrivers: number;
  backlog: number;
  revenue: number;
  shipped: number;
  streak: number;
  difficulty: number;
  tier?: number;
  driverClientIds?: string[];
  brainHealth: BrainHealth;
  updatedAt: number;
}

export interface HallOfFameEntry {
  id: string;
  siteId: SiteId;
  shift: number;
  revenue: number;
  shipped: number;
  L0: number;
  streak: number;
  difficulty: number;
  topDriverName: string | null;
  topDriverScore: number;
  createdAt: number;
}

export interface PlayerProfileDoc {
  clientId: string;
  name: string;
  isBot: boolean;
  totalDeliveries: number;
  totalScore: number;
  bestBlitzPts?: number;
  /** Best pallets-per-real-minute of a run (sim `computeDriverPpm`). */
  ppm?: number;
  shiftsPlayed: number;
  lastSiteId: SiteId;
  updatedAt: number;
  /** Consecutive UTC days with a completed Daily Shift (decayed at read time, `displayStreak`). */
  dailyStreak?: number;
  bestDailyStreak?: number;
  /** Day key of the last completed Daily Shift. */
  lastDailyKey?: string;
  /** Distinct days with a completed Daily Shift. */
  dailiesCompleted?: number;
  /** Weekly League championships (rank 1 of a finalized week; written by the lobby finalizer). */
  leagueWins?: number;
  /** Best finalized weekly podium place (1–3; written by the lobby finalizer). */
  bestLeagueRank?: number;
  /** Equipped cosmetic livery (validated against `unlockedLiveries` on every `setLivery`). */
  livery?: LiveryId;
  /** Distinct days the player finished a Daily Shift in that day's top 10. */
  dailyTop10s?: number;
  /** Day key last counted in `dailyTop10s` (once-per-day guard). */
  lastDailyTop10Key?: string;
  /** Sites the player completed a Daily Shift on (regional livery unlocks). */
  dailySites?: string[];
}

/** The unlock-rule view of a stored profile (`unlockedLiveries`). */
export function liveryProfileOf(doc: Partial<PlayerProfileDoc> | null | undefined): LiveryProfile {
  return {
    bestDailyStreak: doc?.bestDailyStreak ?? 0,
    dailiesCompleted: doc?.dailiesCompleted ?? 0,
    totalDeliveries: doc?.totalDeliveries ?? 0,
    dailyTop10s: doc?.dailyTop10s ?? 0,
    dailySites: Array.isArray(doc?.dailySites) ? doc.dailySites : [],
    leagueWins: doc?.leagueWins ?? 0,
  };
}

/**
 * Pure core of `recordDailyTop10`: the fields to merge when `dayKey` hasn't been counted yet,
 * or null when it already has (each day counts once, however many top-10 runs).
 */
export function applyDailyTop10(
  player: Partial<PlayerProfileDoc> | null,
  dayKey: string,
): { dailyTop10s: number; lastDailyTop10Key: string } | null {
  if (player?.lastDailyTop10Key === dayKey) return null;
  return { dailyTop10s: (player?.dailyTop10s ?? 0) + 1, lastDailyTop10Key: dayKey };
}

/** Daily sites with `siteId` added (deduplicated, insertion order). */
export function addDailySite(sites: readonly string[] | null | undefined, siteId: string): string[] {
  const list = Array.isArray(sites) ? [...sites] : [];
  if (!list.includes(siteId)) list.push(siteId);
  return list;
}

/** One finished (or abandoned) run's contribution to a player's lifetime totals. */
export interface RunStatsInput {
  clientId: string;
  name: string;
  isBot: boolean;
  siteId: SiteId;
  /** Deliveries to add to `totalDeliveries`. */
  deliveries: number;
  /** Points to add to `totalScore`. */
  score: number;
  /** Blitz run score to fold into `bestBlitzPts` (omit for other modes). */
  blitzPts?: number;
  /** Run pallets-per-real-minute to fold into `ppm` (omit or 0 when not applicable). */
  ppm?: number;
  nowMs: number;
}

/** A completed Daily Shift run (clock reached 00:00 with ≥ 1 delivery; humans only). */
export interface DailyResultInput {
  clientId: string;
  /** Opaque public id stored on the board entry (raw clientIds never leave the server). */
  publicId: string;
  name: string;
  siteId: SiteId;
  dayKey: string;
  pts: number;
  tape: string;
  nowMs: number;
}

export interface DailyResultRecord {
  /** The player's best score for `dayKey` after this run. */
  bestPts: number;
  /** True when this run created or raised the day's best. */
  improved: boolean;
  attempts: number;
  streak: number;
  streakDelta: number;
}

/** `daily/{dayKey}/entries/{clientId}`: a player's best Daily Shift of a day. */
export interface DailyEntryDoc {
  dayKey: string;
  publicId: string;
  name: string;
  bestPts: number;
  attempts: number;
  siteId: SiteId;
  /** Player's daily streak as of their latest completion that day. */
  streak: number;
  /** Run tape of the best run. */
  tape: string;
  bestAt: number;
  /** Epoch ms; stored as a Firestore Timestamp for the `entries` TTL policy. */
  expireAt: number;
}

/** A finished timed run (Blitz or Daily, ≥ 1 delivery; humans only) folded into the Weekly League. */
export interface LeagueRunInput {
  clientId: string;
  /** Opaque public id stored on the entry (raw clientIds never leave the server). */
  publicId: string;
  name: string;
  siteId: SiteId;
  weekKey: string;
  pts: number;
  nowMs: number;
}

export interface LeagueRunRecord {
  weekPts: number;
  /** Week points gained from this run (0 when not counted). */
  delta: number;
  counted: boolean;
  /** Runs currently summed into `weekPts`. */
  runsCounted: number;
}

/** `league/{weekKey}/entries/{clientId}`: a player's Weekly League standing. */
export interface LeagueEntryDoc {
  weekKey: string;
  publicId: string;
  name: string;
  weekPts: number;
  /** Best run scores of the week, descending (≤ `LEAGUE_TOP_RUNS`). */
  topRuns: number[];
  /** Timed runs finished this week (counted or not). */
  runs: number;
  siteId: SiteId;
  updatedAt: number;
  /** Epoch ms; stored as a Firestore Timestamp for the `entries` TTL policy. */
  expireAt: number;
}

/** Firestore TTL deadline for a week's league entries: `LEAGUE_ENTRY_TTL_DAYS` after the week ends. */
export function leagueEntryExpireAt(weekKey: string): number {
  return weekEndMs(weekKey) + LEAGUE_ENTRY_TTL_DAYS * 86_400_000;
}

/** Pure core of `recordLeagueRun`: folds one run into the player's existing entry for the week. */
export function applyLeagueRun(entry: LeagueEntryDoc | null, input: LeagueRunInput): { entry: LeagueEntryDoc; result: LeagueRunRecord } {
  const step = nextLeagueRuns(entry?.topRuns, input.pts);
  const next: LeagueEntryDoc = {
    weekKey: input.weekKey,
    publicId: input.publicId,
    name: input.name,
    weekPts: step.weekPts,
    topRuns: step.topRuns,
    runs: (entry?.runs ?? 0) + 1,
    siteId: input.siteId,
    updatedAt: input.nowMs,
    expireAt: leagueEntryExpireAt(input.weekKey),
  };
  return {
    entry: next,
    result: { weekPts: step.weekPts, delta: step.delta, counted: step.counted, runsCounted: step.topRuns.length },
  };
}

/** Firestore TTL deadline for a day's board entries: `DAILY_ENTRY_TTL_DAYS` after the day. */
export function dailyEntryExpireAt(dayKey: string): number {
  return dayKeyToMs(addDays(dayKey, DAILY_ENTRY_TTL_DAYS));
}

/** Folds a run into existing lifetime totals (pure; shared by both stores). */
export function applyRunStats(existing: PlayerProfileDoc | null, input: RunStatsInput): PlayerProfileDoc {
  const prevBestBlitz = existing?.bestBlitzPts ?? 0;
  const bestBlitz = Math.max(prevBestBlitz, input.blitzPts ?? 0);
  const runPpm = Number.isFinite(input.ppm) ? (input.ppm as number) : 0;
  const ppm = Math.max(existing?.ppm ?? 0, runPpm);
  const next: PlayerProfileDoc = {
    ...(existing ?? {}),
    clientId: input.clientId,
    name: input.name,
    isBot: input.isBot,
    totalDeliveries: (existing?.totalDeliveries ?? 0) + input.deliveries,
    totalScore: (existing?.totalScore ?? 0) + input.score,
    shiftsPlayed: (existing?.shiftsPlayed ?? 0) + 1,
    lastSiteId: input.siteId,
    updatedAt: input.nowMs,
  };
  if (bestBlitz > 0) next.bestBlitzPts = bestBlitz;
  if (ppm > 0) next.ppm = ppm;
  return next;
}

function streakStateOf(doc: Partial<PlayerProfileDoc> | null | undefined): Partial<DailyStreakState> {
  return {
    dailyStreak: doc?.dailyStreak,
    bestDailyStreak: doc?.bestDailyStreak,
    lastDailyKey: doc?.lastDailyKey ?? null,
    dailiesCompleted: doc?.dailiesCompleted,
  };
}

/**
 * Pure core of `recordDailyResult`: given the player's doc and their existing entry for the
 * day, returns the streak fields to merge into the player, the next entry, and the result.
 */
export function applyDailyResult(
  player: Partial<PlayerProfileDoc> | null,
  entry: DailyEntryDoc | null,
  input: DailyResultInput,
): {
  streak: DailyStreakState;
  dailySites: string[];
  entry: DailyEntryDoc;
  result: DailyResultRecord;
} {
  const step = nextDailyStreak(streakStateOf(player), input.dayKey);
  const pts = Math.round(input.pts);
  const improved = !entry || pts > entry.bestPts;
  const next: DailyEntryDoc = {
    dayKey: input.dayKey,
    publicId: input.publicId,
    name: input.name,
    bestPts: improved ? pts : entry.bestPts,
    attempts: (entry?.attempts ?? 0) + 1,
    siteId: improved ? input.siteId : entry.siteId,
    streak: step.next.dailyStreak,
    tape: improved ? input.tape : entry.tape,
    bestAt: improved ? input.nowMs : entry.bestAt,
    expireAt: dailyEntryExpireAt(input.dayKey),
  };
  return {
    streak: step.next,
    dailySites: addDailySite(player?.dailySites, input.siteId),
    entry: next,
    result: {
      bestPts: next.bestPts,
      improved,
      attempts: next.attempts,
      streak: step.next.dailyStreak,
      streakDelta: step.streakDelta,
    },
  };
}

export interface DecisionJournalEntry {
  id: string;
  siteId: SiteId;
  reqId: number;
  agentId: number;
  agentName: string;
  kind: DecisionKind;
  promptSummary: string;
  decision: Record<string, unknown> | null;
  note: string;
  model: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  error?: string;
  createdAt: number;
  expireAt: number;
}

export interface ArmorJournalEntry {
  id: string;
  siteId: SiteId;
  clientId: string;
  ipHash: string;
  code: ArmorReasonCode;
  layer: string;
  strikes: number;
  muted: boolean;
  mutedUntil?: number;
  inputPreview: string;
  createdAt: number;
  expireAt: number;
}

export interface BudgetDayDoc {
  date: string;
  agentSpentUsd: number;
  nlCommandSpentUsd: number;
  agentCapUsd: number;
  nlCommandCapUsd: number;
  agentTokensIn: number;
  agentTokensOut: number;
  nlTokensIn: number;
  nlTokensOut: number;
  agentCalls: number;
  nlCalls: number;
  updatedAt: number;
}

export function formatUtcDateKey(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function positiveEnvNumber(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** USD per 1M input tokens (`GEMINI_PRICE_INPUT_PER_M`, default Vertex list price $0.30). */
export const GEMINI_PRICE_INPUT_PER_M = positiveEnvNumber(
  'GEMINI_PRICE_INPUT_PER_M',
  GEMINI_FLASH_LITE_PRICE_PER_M_TOKENS.input,
);
/** USD per 1M output tokens (`GEMINI_PRICE_OUTPUT_PER_M`, default Vertex list price $2.50). */
export const GEMINI_PRICE_OUTPUT_PER_M = positiveEnvNumber(
  'GEMINI_PRICE_OUTPUT_PER_M',
  GEMINI_FLASH_LITE_PRICE_PER_M_TOKENS.output,
);

/**
 * Estimates Gemini 3.5 Flash-Lite cost in USD from input/output token counts at
 * `GEMINI_PRICE_INPUT_PER_M` / `GEMINI_PRICE_OUTPUT_PER_M` (default $0.30 / $2.50 per 1M),
 * with a minimum floor of $0.000005 per call.
 */
export function estimateGeminiFlashCostUsd(tokensIn: number, tokensOut: number): number {
  const raw =
    (Math.max(0, tokensIn) * GEMINI_PRICE_INPUT_PER_M +
      Math.max(0, tokensOut) * GEMINI_PRICE_OUTPUT_PER_M) /
    1_000_000;
  return Math.max(0.000005, raw);
}

export interface PersistenceStore {
  writeHeartbeat(doc: SiteHeartbeatDoc): Promise<void>;
  getHeartbeats(): Promise<SiteHeartbeatDoc[]>;
  saveSnapshot(siteId: SiteId, snapshot: WorldSnapshot, nowMs?: number): Promise<void>;
  loadLatestSnapshot(siteId: SiteId, maxAgeMs?: number, nowMs?: number): Promise<WorldSnapshot | null>;
  recordHallOfFame(entry: HallOfFameEntry): Promise<void>;
  getHallOfFame(limit?: number): Promise<HallOfFameEntry[]>;
  upsertPlayerStats(stats: PlayerProfileDoc): Promise<void>;
  getPlayerStats(clientId: string): Promise<PlayerProfileDoc | null>;
  /** Atomically folds a run into `players/{clientId}` totals (no lost updates across shards). */
  recordRunStats(input: RunStatsInput): Promise<PlayerProfileDoc>;
  /**
   * Atomically records a completed Daily Shift: advances the player's streak, keeps the best
   * score of the day in `daily/{dayKey}/entries/{clientId}`, and writes `daily/{dayKey}` once.
   */
  recordDailyResult(input: DailyResultInput): Promise<DailyResultRecord>;
  /** Counts a Daily top-10 finish once per day (`dailyTop10s`); returns true when it counted. */
  recordDailyTop10(clientId: string, dayKey: string): Promise<boolean>;
  /** Persists the equipped livery on `players/{clientId}` (merge). Callers validate unlocks. */
  setPlayerLivery(clientId: string, livery: LiveryId, nowMs: number): Promise<void>;
  /** 1-based rank of `pts` among the day's entries (ties share a rank) and the entrant count. */
  getDailyRank(dayKey: string, pts: number): Promise<{ rank: number; of: number }>;
  /** Atomically folds a finished timed run into `league/{weekKey}/entries/{clientId}`. */
  recordLeagueRun(input: LeagueRunInput): Promise<LeagueRunRecord>;
  /** 1-based rank of `weekPts` among the week's entries (ties share a rank) and the entrant count. */
  getLeagueRank(weekKey: string, weekPts: number): Promise<{ rank: number; of: number }>;
  appendDecisionJournal(siteId: SiteId, entry: DecisionJournalEntry): Promise<void>;
  appendArmorJournal(siteId: SiteId, entry: ArmorJournalEntry): Promise<void>;
  getJournal(
    siteId: SiteId,
    limit?: number,
  ): Promise<{ decisions: DecisionJournalEntry[]; armor: ArmorJournalEntry[] }>;
  checkBudget(
    category: 'agent' | 'nlCommand',
    nowMs?: number,
  ): Promise<{ allowed: boolean; spentUsd: number; capUsd: number }>;
  recordUsage(
    category: 'agent' | 'nlCommand',
    tokensIn: number,
    tokensOut: number,
    costUsd?: number,
    nowMs?: number,
  ): Promise<BudgetDayDoc>;
  getBudget(nowMs?: number): Promise<BudgetDayDoc>;
  setBudgetForTesting(overrides: Partial<BudgetDayDoc>, nowMs?: number): Promise<void>;
  publishTransfer(transfer: Transfer): Promise<string>;
  /**
   * Starts a streaming pull on this site's filtered transfer subscription. `onTransfer`
   * receives each decoded JSON payload and returns `true` to ack (applied, duplicate or
   * permanently invalid) or `false` to nack for redelivery. Returns a stop function.
   * Pull (instead of push) means queued transfers never wake a scaled-to-zero shard; they
   * wait in the subscription until the shard next boots for a human.
   */
  subscribeTransfers?(siteId: SiteId, onTransfer: (payload: unknown) => boolean): () => Promise<void>;
  /** Flush any locally buffered budget usage to durable storage (no-op for in-memory stores). */
  flushUsage?(): Promise<void>;
}

/** How often buffered Gemini usage is written to the shared budget doc. */
export const BUDGET_FLUSH_INTERVAL_MS = 10_000;
/** Max age of the cached shared budget doc before `checkBudget` refreshes it in the background. */
export const BUDGET_CACHE_TTL_MS = 10_000;

interface UsageDelta {
  agentSpentUsd: number;
  agentTokensIn: number;
  agentTokensOut: number;
  agentCalls: number;
  nlCommandSpentUsd: number;
  nlTokensIn: number;
  nlTokensOut: number;
  nlCalls: number;
}

function emptyDelta(): UsageDelta {
  return {
    agentSpentUsd: 0,
    agentTokensIn: 0,
    agentTokensOut: 0,
    agentCalls: 0,
    nlCommandSpentUsd: 0,
    nlTokensIn: 0,
    nlTokensOut: 0,
    nlCalls: 0,
  };
}

function emptyBudgetDoc(key: string, nowMs: number): BudgetDayDoc {
  return {
    date: key,
    agentSpentUsd: 0,
    nlCommandSpentUsd: 0,
    agentCapUsd: AGENT_DAILY_BUDGET_USD,
    nlCommandCapUsd: NL_COMMAND_DAILY_BUDGET_USD,
    agentTokensIn: 0,
    agentTokensOut: 0,
    nlTokensIn: 0,
    nlTokensOut: 0,
    agentCalls: 0,
    nlCalls: 0,
    updatedAt: nowMs,
  };
}

export interface InMemoryPublishedTransfer {
  messageId: string;
  transfer: Transfer;
  attributes: {
    toSite: SiteId;
    fromSite: SiteId;
  };
  publishedAt: number;
}

export class InMemoryPersistenceStore implements PersistenceStore {
  private readonly heartbeats = new Map<SiteId, SiteHeartbeatDoc>();
  private readonly snapshots = new Map<SiteId, { snapshot: WorldSnapshot; updatedAt: number }>();
  private readonly hallOfFame: HallOfFameEntry[] = [];
  private readonly players = new Map<string, PlayerProfileDoc>();
  private readonly dailyEntries = new Map<string, Map<string, DailyEntryDoc>>();
  private readonly leagueEntries = new Map<string, Map<string, LeagueEntryDoc>>();
  private readonly decisionJournals = new Map<SiteId, DecisionJournalEntry[]>();
  private readonly armorJournals = new Map<SiteId, ArmorJournalEntry[]>();
  private readonly budgets = new Map<string, BudgetDayDoc>();
  public readonly publishedTransfers: InMemoryPublishedTransfer[] = [];
  private transferSeq = 1;
  private readonly onTransferPublished?: (transfer: Transfer) => void | Promise<void>;

  constructor(opts?: { onTransferPublished?: (transfer: Transfer) => void | Promise<void> }) {
    this.onTransferPublished = opts?.onTransferPublished;
  }

  private getOrCreateBudgetDoc(nowMs: number = Date.now()): BudgetDayDoc {
    const key = formatUtcDateKey(nowMs);
    let doc = this.budgets.get(key);
    if (!doc) {
      doc = {
        date: key,
        agentSpentUsd: 0,
        nlCommandSpentUsd: 0,
        agentCapUsd: AGENT_DAILY_BUDGET_USD,
        nlCommandCapUsd: NL_COMMAND_DAILY_BUDGET_USD,
        agentTokensIn: 0,
        agentTokensOut: 0,
        nlTokensIn: 0,
        nlTokensOut: 0,
        agentCalls: 0,
        nlCalls: 0,
        updatedAt: nowMs,
      };
      this.budgets.set(key, doc);
    }
    return doc;
  }

  async writeHeartbeat(doc: SiteHeartbeatDoc): Promise<void> {
    this.heartbeats.set(doc.siteId, { ...doc });
  }

  async getHeartbeats(): Promise<SiteHeartbeatDoc[]> {
    return Array.from(this.heartbeats.values());
  }

  async saveSnapshot(
    siteId: SiteId,
    snapshot: WorldSnapshot,
    nowMs: number = Date.now(),
  ): Promise<void> {
    this.snapshots.set(siteId, {
      snapshot: structuredClone(snapshot),
      updatedAt: nowMs,
    });
  }

  async loadLatestSnapshot(
    siteId: SiteId,
    maxAgeMs: number = SNAPSHOT_MAX_AGE_MS,
    nowMs: number = Date.now(),
  ): Promise<WorldSnapshot | null> {
    const entry = this.snapshots.get(siteId);
    if (!entry) return null;
    if (nowMs - entry.updatedAt > maxAgeMs) {
      return null;
    }
    return structuredClone(entry.snapshot);
  }

  async recordHallOfFame(entry: HallOfFameEntry): Promise<void> {
    this.hallOfFame.unshift({ ...entry });
    if (this.hallOfFame.length > 100) {
      this.hallOfFame.length = 100;
    }
  }

  async getHallOfFame(limit = 20): Promise<HallOfFameEntry[]> {
    return this.hallOfFame.slice(0, limit);
  }

  async upsertPlayerStats(stats: PlayerProfileDoc): Promise<void> {
    this.players.set(stats.clientId, { ...stats });
  }

  async getPlayerStats(clientId: string): Promise<PlayerProfileDoc | null> {
    const doc = this.players.get(clientId);
    return doc ? { ...doc } : null;
  }

  async recordRunStats(input: RunStatsInput): Promise<PlayerProfileDoc> {
    const next = applyRunStats(this.players.get(input.clientId) ?? null, input);
    this.players.set(input.clientId, next);
    return { ...next };
  }

  async recordDailyResult(input: DailyResultInput): Promise<DailyResultRecord> {
    let day = this.dailyEntries.get(input.dayKey);
    if (!day) {
      day = new Map();
      this.dailyEntries.set(input.dayKey, day);
    }
    const player = this.players.get(input.clientId) ?? null;
    const out = applyDailyResult(player, day.get(input.clientId) ?? null, input);
    day.set(input.clientId, out.entry);
    if (player)
      this.players.set(input.clientId, {
        ...player,
        ...out.streak,
        dailySites: out.dailySites,
        lastDailyKey: input.dayKey,
      });
    else
      this.players.set(input.clientId, {
        clientId: input.clientId,
        name: input.name,
        isBot: false,
        totalDeliveries: 0,
        totalScore: 0,
        shiftsPlayed: 0,
        lastSiteId: input.siteId,
        updatedAt: input.nowMs,
        ...out.streak,
        dailySites: out.dailySites,
        lastDailyKey: input.dayKey,
      });
    return out.result;
  }

  async recordDailyTop10(clientId: string, dayKey: string): Promise<boolean> {
    const player = this.players.get(clientId);
    if (!player) return false;
    const next = applyDailyTop10(player, dayKey);
    if (!next) return false;
    this.players.set(clientId, { ...player, ...next });
    return true;
  }

  async setPlayerLivery(clientId: string, livery: LiveryId, nowMs: number): Promise<void> {
    const player = this.players.get(clientId);
    if (!player) throw new Error(`no player profile for livery write`);
    this.players.set(clientId, { ...player, livery, updatedAt: nowMs });
  }

  async getDailyRank(dayKey: string, pts: number): Promise<{ rank: number; of: number }> {
    const entries = [...(this.dailyEntries.get(dayKey)?.values() ?? [])];
    return { rank: entries.filter((e) => e.bestPts > pts).length + 1, of: entries.length };
  }

  /** A day's entries (tests / diagnostics). */
  getDailyEntriesForTesting(dayKey: string): DailyEntryDoc[] {
    return [...(this.dailyEntries.get(dayKey)?.values() ?? [])].map((e) => ({ ...e }));
  }

  async recordLeagueRun(input: LeagueRunInput): Promise<LeagueRunRecord> {
    let week = this.leagueEntries.get(input.weekKey);
    if (!week) {
      week = new Map();
      this.leagueEntries.set(input.weekKey, week);
    }
    const out = applyLeagueRun(week.get(input.clientId) ?? null, input);
    week.set(input.clientId, out.entry);
    return out.result;
  }

  async getLeagueRank(weekKey: string, weekPts: number): Promise<{ rank: number; of: number }> {
    const entries = [...(this.leagueEntries.get(weekKey)?.values() ?? [])];
    return { rank: entries.filter((e) => e.weekPts > weekPts).length + 1, of: entries.length };
  }

  /** A week's league entries (tests / diagnostics). */
  getLeagueEntriesForTesting(weekKey: string): LeagueEntryDoc[] {
    return [...(this.leagueEntries.get(weekKey)?.values() ?? [])].map((e) => ({ ...e, topRuns: [...e.topRuns] }));
  }

  async appendDecisionJournal(siteId: SiteId, entry: DecisionJournalEntry): Promise<void> {
    let list = this.decisionJournals.get(siteId);
    if (!list) {
      list = [];
      this.decisionJournals.set(siteId, list);
    }
    list.unshift({ ...entry });
    if (list.length > 200) list.length = 200;
  }

  async appendArmorJournal(siteId: SiteId, entry: ArmorJournalEntry): Promise<void> {
    let list = this.armorJournals.get(siteId);
    if (!list) {
      list = [];
      this.armorJournals.set(siteId, list);
    }
    list.unshift({ ...entry });
    if (list.length > 200) list.length = 200;
  }

  async getJournal(
    siteId: SiteId,
    limit = 40,
  ): Promise<{ decisions: DecisionJournalEntry[]; armor: ArmorJournalEntry[] }> {
    const decisions = (this.decisionJournals.get(siteId) ?? []).slice(0, limit);
    const armor = (this.armorJournals.get(siteId) ?? []).slice(0, limit);
    return { decisions, armor };
  }

  async checkBudget(
    category: 'agent' | 'nlCommand',
    nowMs: number = Date.now(),
  ): Promise<{ allowed: boolean; spentUsd: number; capUsd: number }> {
    const doc = this.getOrCreateBudgetDoc(nowMs);
    if (category === 'agent') {
      return {
        allowed: doc.agentSpentUsd < doc.agentCapUsd,
        spentUsd: doc.agentSpentUsd,
        capUsd: doc.agentCapUsd,
      };
    }
    return {
      allowed: doc.nlCommandSpentUsd < doc.nlCommandCapUsd,
      spentUsd: doc.nlCommandSpentUsd,
      capUsd: doc.nlCommandCapUsd,
    };
  }

  /** Usage is written synchronously in memory; nothing is ever buffered. */
  async flushUsage(): Promise<void> {}

  async recordUsage(
    category: 'agent' | 'nlCommand',
    tokensIn: number,
    tokensOut: number,
    costUsd?: number,
    nowMs: number = Date.now(),
  ): Promise<BudgetDayDoc> {
    const doc = this.getOrCreateBudgetDoc(nowMs);
    const deltaUsd = costUsd ?? estimateGeminiFlashCostUsd(tokensIn, tokensOut);
    if (category === 'agent') {
      doc.agentSpentUsd = Number((doc.agentSpentUsd + deltaUsd).toFixed(6));
      doc.agentTokensIn += Math.max(0, tokensIn);
      doc.agentTokensOut += Math.max(0, tokensOut);
      doc.agentCalls += 1;
    } else {
      doc.nlCommandSpentUsd = Number((doc.nlCommandSpentUsd + deltaUsd).toFixed(6));
      doc.nlTokensIn += Math.max(0, tokensIn);
      doc.nlTokensOut += Math.max(0, tokensOut);
      doc.nlCalls += 1;
    }
    doc.updatedAt = nowMs;
    return { ...doc };
  }

  async getBudget(nowMs: number = Date.now()): Promise<BudgetDayDoc> {
    return { ...this.getOrCreateBudgetDoc(nowMs) };
  }

  async setBudgetForTesting(
    overrides: Partial<BudgetDayDoc>,
    nowMs: number = Date.now(),
  ): Promise<void> {
    const doc = this.getOrCreateBudgetDoc(nowMs);
    Object.assign(doc, overrides);
  }

  async publishTransfer(transfer: Transfer): Promise<string> {
    const messageId = `msg-${this.transferSeq++}`;
    this.publishedTransfers.push({
      messageId,
      transfer: structuredClone(transfer),
      attributes: {
        toSite: transfer.toSite,
        fromSite: transfer.fromSite,
      },
      publishedAt: Date.now(),
    });
    if (this.onTransferPublished) {
      await this.onTransferPublished(transfer);
    }
    return messageId;
  }
}

export interface CloudPersistenceOptions {
  projectId?: string;
  suffix?: string;
  transfersTopic?: string;
  firestore?: Firestore;
  pubsub?: PubSub;
  /** Budget usage flush cadence (default `BUDGET_FLUSH_INTERVAL_MS`); `0` disables the timer. */
  budgetFlushIntervalMs?: number;
  /** Budget doc cache TTL (default `BUDGET_CACHE_TTL_MS`). */
  budgetCacheTtlMs?: number;
}

export class CloudPersistenceStore implements PersistenceStore {
  private readonly db: Firestore;
  private readonly pubsub: PubSub;
  private readonly suffix: string;
  private readonly transfersTopic: string;
  private readonly fallback = new InMemoryPersistenceStore();
  private readonly budgetFlushIntervalMs: number;
  private readonly budgetCacheTtlMs: number;
  /** Usage recorded locally but not yet written to Firestore, keyed by UTC day. */
  private readonly pendingUsage = new Map<string, UsageDelta>();
  /** Usage currently being written (still counted by `checkBudget` until it lands in the cache). */
  private readonly flushingUsage = new Map<string, UsageDelta>();
  /** Last shared budget doc read from Firestore (all instances' flushed spend). */
  private budgetCache: { key: string; doc: BudgetDayDoc; fetchedAtMs: number } | null = null;
  private budgetRefresh: Promise<void> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushInFlight: Promise<void> | null = null;

  constructor(opts: CloudPersistenceOptions = {}) {
    this.budgetFlushIntervalMs = opts.budgetFlushIntervalMs ?? BUDGET_FLUSH_INTERVAL_MS;
    this.budgetCacheTtlMs = opts.budgetCacheTtlMs ?? BUDGET_CACHE_TTL_MS;
    const projectId = opts.projectId ?? process.env.GCP_PROJECT_ID ?? 'davenporter-freightfloor';
    this.suffix = opts.suffix ?? process.env.SUFFIX ?? '';
    this.transfersTopic =
      opts.transfersTopic ?? process.env.TRANSFERS_TOPIC ?? `site-transfers${this.suffix}`;
    this.db = opts.firestore ?? new Firestore({ projectId, ignoreUndefinedProperties: true });
    this.pubsub = opts.pubsub ?? new PubSub({ projectId });
  }

  private colName(base: string): string {
    return `${base}${this.suffix}`;
  }

  async writeHeartbeat(doc: SiteHeartbeatDoc): Promise<void> {
    await this.fallback.writeHeartbeat(doc);
    await this.db
      .collection(this.colName('sites'))
      .doc(doc.siteId)
      .set(
        {
          ...doc,
          id: doc.siteId,
          drivers: doc.players,
          tier: doc.tier ?? 0,
          state: doc.phase === 'break' ? 'break' : 'live',
          driverClientIds: doc.driverClientIds ?? [],
        },
        { merge: true },
      );
  }

  async getHeartbeats(): Promise<SiteHeartbeatDoc[]> {
    const snap = await this.db.collection(this.colName('sites')).get();
    return snap.docs.map((d) => d.data() as SiteHeartbeatDoc);
  }

  async saveSnapshot(
    siteId: SiteId,
    snapshot: WorldSnapshot,
    nowMs: number = Date.now(),
  ): Promise<void> {
    await this.fallback.saveSnapshot(siteId, snapshot, nowMs);
    await this.db
      .collection(this.colName('sites'))
      .doc(siteId)
      .collection('snapshots')
      .doc('latest')
      .set({
        siteId,
        updatedAt: nowMs,
        payloadJson: JSON.stringify(snapshot),
      });
  }

  async loadLatestSnapshot(
    siteId: SiteId,
    maxAgeMs: number = SNAPSHOT_MAX_AGE_MS,
    nowMs: number = Date.now(),
  ): Promise<WorldSnapshot | null> {
    const doc = await this.db
      .collection(this.colName('sites'))
      .doc(siteId)
      .collection('snapshots')
      .doc('latest')
      .get();
    if (!doc.exists) return null;
    const data = doc.data() as { updatedAt?: number; payloadJson?: string } | undefined;
    if (!data || !data.payloadJson || typeof data.updatedAt !== 'number') return null;
    if (nowMs - data.updatedAt > maxAgeMs) return null;
    return JSON.parse(data.payloadJson) as WorldSnapshot;
  }

  async recordHallOfFame(entry: HallOfFameEntry): Promise<void> {
    await this.fallback.recordHallOfFame(entry);
    await this.db.collection(this.colName('hallOfFame')).doc(entry.id).set(entry);
  }

  async getHallOfFame(limit = 20): Promise<HallOfFameEntry[]> {
    const snap = await this.db
      .collection(this.colName('hallOfFame'))
      .orderBy('revenue', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map((d) => d.data() as HallOfFameEntry);
  }

  async upsertPlayerStats(stats: PlayerProfileDoc): Promise<void> {
    await this.fallback.upsertPlayerStats(stats);
    await this.db.collection(this.colName('players')).doc(stats.clientId).set(stats, {
      merge: true,
    });
  }

  async getPlayerStats(clientId: string): Promise<PlayerProfileDoc | null> {
    const doc = await this.db.collection(this.colName('players')).doc(clientId).get();
    if (!doc.exists) return null;
    return doc.data() as PlayerProfileDoc;
  }

  async recordRunStats(input: RunStatsInput): Promise<PlayerProfileDoc> {
    const ref = this.db.collection(this.colName('players')).doc(input.clientId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const next = applyRunStats(snap.exists ? (snap.data() as PlayerProfileDoc) : null, input);
      tx.set(ref, next, { merge: true });
      return next;
    });
  }

  private dailyDoc(dayKey: string) {
    return this.db.collection(this.colName('daily')).doc(dayKey);
  }

  async recordDailyResult(input: DailyResultInput): Promise<DailyResultRecord> {
    const playerRef = this.db.collection(this.colName('players')).doc(input.clientId);
    const dayRef = this.dailyDoc(input.dayKey);
    const entryRef = dayRef.collection('entries').doc(input.clientId);
    return this.db.runTransaction(async (tx) => {
      // Firestore transactions require every read before the first write.
      const [playerSnap, entrySnap, daySnap] = await Promise.all([tx.get(playerRef), tx.get(entryRef), tx.get(dayRef)]);
      const player = playerSnap.exists ? (playerSnap.data() as PlayerProfileDoc) : null;
      const prevEntry = entrySnap.exists ? fromEntryData(entrySnap.data()) : null;
      const out = applyDailyResult(player, prevEntry, input);
      if (!daySnap.exists) {
        const info = dailyInfoFor(input.dayKey);
        tx.set(dayRef, {
          dayKey: input.dayKey,
          number: info.number,
          modifier: info.modifier.id,
          cards: info.cards,
          createdAt: input.nowMs,
        });
      }
      tx.set(
        playerRef,
        {
          clientId: input.clientId,
          ...(player ? {} : { name: input.name, isBot: false, lastSiteId: input.siteId, updatedAt: input.nowMs }),
          ...out.streak,
          dailySites: out.dailySites,
          lastDailyKey: input.dayKey,
        },
        { merge: true },
      );
      tx.set(entryRef, { ...out.entry, expireAt: Timestamp.fromMillis(out.entry.expireAt) });
      return out.result;
    });
  }

  async recordDailyTop10(clientId: string, dayKey: string): Promise<boolean> {
    const ref = this.db.collection(this.colName('players')).doc(clientId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const next = applyDailyTop10(snap.data() as PlayerProfileDoc, dayKey);
      if (!next) return false;
      tx.set(ref, next, { merge: true });
      return true;
    });
  }

  async setPlayerLivery(clientId: string, livery: LiveryId, nowMs: number): Promise<void> {
    await this.db
      .collection(this.colName('players'))
      .doc(clientId)
      .set({ clientId, livery, updatedAt: nowMs }, { merge: true });
  }

  async getDailyRank(dayKey: string, pts: number): Promise<{ rank: number; of: number }> {
    const entries = this.dailyDoc(dayKey).collection('entries');
    const [above, all] = await Promise.all([
      entries.where('bestPts', '>', pts).count().get(),
      entries.count().get(),
    ]);
    return { rank: above.data().count + 1, of: all.data().count };
  }

  async recordLeagueRun(input: LeagueRunInput): Promise<LeagueRunRecord> {
    const entryRef = this.db
      .collection(this.colName('league'))
      .doc(input.weekKey)
      .collection('entries')
      .doc(input.clientId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(entryRef);
      const out = applyLeagueRun(snap.exists ? fromLeagueEntryData(snap.data()) : null, input);
      tx.set(entryRef, { ...out.entry, expireAt: Timestamp.fromMillis(out.entry.expireAt) });
      return out.result;
    });
  }

  async getLeagueRank(weekKey: string, weekPts: number): Promise<{ rank: number; of: number }> {
    const entries = this.db.collection(this.colName('league')).doc(weekKey).collection('entries');
    const [above, all] = await Promise.all([
      entries.where('weekPts', '>', weekPts).count().get(),
      entries.count().get(),
    ]);
    return { rank: above.data().count + 1, of: all.data().count };
  }

  async appendDecisionJournal(siteId: SiteId, entry: DecisionJournalEntry): Promise<void> {
    await this.fallback.appendDecisionJournal(siteId, entry);
    await this.db
      .collection(this.colName('sites'))
      .doc(siteId)
      .collection('journal')
      .doc(entry.id)
      .set({
        ...entry,
        entryType: 'decision',
        expireAt: Timestamp.fromMillis(entry.expireAt),
      });
  }

  async appendArmorJournal(siteId: SiteId, entry: ArmorJournalEntry): Promise<void> {
    await this.fallback.appendArmorJournal(siteId, entry);
    await this.db
      .collection(this.colName('sites'))
      .doc(siteId)
      .collection('journal')
      .doc(entry.id)
      .set({
        ...entry,
        entryType: 'armor',
        expireAt: Timestamp.fromMillis(entry.expireAt),
      });
  }

  async getJournal(
    siteId: SiteId,
    limit = 40,
  ): Promise<{ decisions: DecisionJournalEntry[]; armor: ArmorJournalEntry[] }> {
    return this.fallback.getJournal(siteId, limit);
  }

  /**
   * Budget check against the cached shared doc plus this instance's unflushed delta. No
   * Firestore read on the hot path: a stale cache is refreshed in the background; only the
   * very first check of a day (no cache yet) awaits the read.
   */
  async checkBudget(
    category: 'agent' | 'nlCommand',
    nowMs: number = Date.now(),
  ): Promise<{ allowed: boolean; spentUsd: number; capUsd: number }> {
    const key = formatUtcDateKey(nowMs);
    if (!this.budgetCache || this.budgetCache.key !== key) {
      await this.refreshBudgetCache(nowMs);
    } else if (nowMs - this.budgetCache.fetchedAtMs >= this.budgetCacheTtlMs) {
      void this.refreshBudgetCache(nowMs);
    }
    const doc = this.mergedBudget(nowMs);
    if (category === 'agent') {
      return {
        allowed: doc.agentSpentUsd < doc.agentCapUsd,
        spentUsd: doc.agentSpentUsd,
        capUsd: doc.agentCapUsd,
      };
    }
    return {
      allowed: doc.nlCommandSpentUsd < doc.nlCommandCapUsd,
      spentUsd: doc.nlCommandSpentUsd,
      capUsd: doc.nlCommandCapUsd,
    };
  }

  /**
   * Accumulates usage in memory (no Firestore transaction per call). Buffered deltas are
   * written every `budgetFlushIntervalMs` with `FieldValue.increment`, so concurrent
   * instances never contend on a read-modify-write and never abort.
   */
  async recordUsage(
    category: 'agent' | 'nlCommand',
    tokensIn: number,
    tokensOut: number,
    costUsd?: number,
    nowMs: number = Date.now(),
  ): Promise<BudgetDayDoc> {
    const key = formatUtcDateKey(nowMs);
    const deltaUsd = costUsd ?? estimateGeminiFlashCostUsd(tokensIn, tokensOut);
    let pending = this.pendingUsage.get(key);
    if (!pending) {
      pending = emptyDelta();
      this.pendingUsage.set(key, pending);
    }
    if (category === 'agent') {
      pending.agentSpentUsd += deltaUsd;
      pending.agentTokensIn += Math.max(0, tokensIn);
      pending.agentTokensOut += Math.max(0, tokensOut);
      pending.agentCalls += 1;
    } else {
      pending.nlCommandSpentUsd += deltaUsd;
      pending.nlTokensIn += Math.max(0, tokensIn);
      pending.nlTokensOut += Math.max(0, tokensOut);
      pending.nlCalls += 1;
    }
    this.ensureFlushTimer();
    return this.mergedBudget(nowMs);
  }

  /** Writes all buffered usage with atomic increments; failed deltas are re-queued. */
  async flushUsage(): Promise<void> {
    if (this.flushInFlight) {
      await this.flushInFlight;
    }
    if (this.pendingUsage.size === 0) return;
    const batch = [...this.pendingUsage.entries()];
    this.pendingUsage.clear();
    for (const [key, d] of batch) this.flushingUsage.set(key, d);
    const run = (async () => {
      let flushedAny = false;
      for (const [key, d] of batch) {
        const ref = this.db.collection(this.colName('budget')).doc(key);
        try {
          await ref.set(
            {
              date: key,
              agentCapUsd: AGENT_DAILY_BUDGET_USD,
              nlCommandCapUsd: NL_COMMAND_DAILY_BUDGET_USD,
              agentSpentUsd: FieldValue.increment(Number(d.agentSpentUsd.toFixed(6))),
              agentTokensIn: FieldValue.increment(d.agentTokensIn),
              agentTokensOut: FieldValue.increment(d.agentTokensOut),
              agentCalls: FieldValue.increment(d.agentCalls),
              nlCommandSpentUsd: FieldValue.increment(Number(d.nlCommandSpentUsd.toFixed(6))),
              nlTokensIn: FieldValue.increment(d.nlTokensIn),
              nlTokensOut: FieldValue.increment(d.nlTokensOut),
              nlCalls: FieldValue.increment(d.nlCalls),
              updatedAt: Date.now(),
            },
            { merge: true },
          );
          flushedAny = true;
        } catch (err) {
          this.flushingUsage.delete(key);
          const back = this.pendingUsage.get(key) ?? emptyDelta();
          this.pendingUsage.set(key, sumDelta(back, d));
          console.error(
            `[persistence] budget flush failed for ${key}; re-queued: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (flushedAny) {
        // Re-read the shared doc (which now includes our increments) before dropping the
        // in-flight delta, so `checkBudget` never under-counts in between.
        if (this.budgetRefresh) await this.budgetRefresh;
        await this.refreshBudgetCache(Date.now());
      }
      for (const [key] of batch) this.flushingUsage.delete(key);
    })();
    this.flushInFlight = run;
    try {
      await run;
    } finally {
      this.flushInFlight = null;
    }
  }

  /** Stops the flush timer and writes any remaining buffered usage. */
  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushUsage();
  }

  private ensureFlushTimer(): void {
    if (this.flushTimer || this.budgetFlushIntervalMs <= 0) return;
    this.flushTimer = setInterval(() => {
      void this.flushUsage().catch((err) => {
        console.error(`[persistence] budget flush error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.budgetFlushIntervalMs);
    this.flushTimer.unref?.();
  }

  private refreshBudgetCache(nowMs: number): Promise<void> {
    if (this.budgetRefresh) return this.budgetRefresh;
    const key = formatUtcDateKey(nowMs);
    this.budgetRefresh = (async () => {
      try {
        const snap = await this.db.collection(this.colName('budget')).doc(key).get();
        const data = snap.exists ? (snap.data() as Partial<BudgetDayDoc>) : null;
        this.budgetCache = {
          key,
          doc: { ...emptyBudgetDoc(key, nowMs), ...(data ?? {}) },
          fetchedAtMs: nowMs,
        };
      } catch (err) {
        // Keep the previous value (or an empty doc for a new day) and retry on the next check.
        console.error(
          `[persistence] budget read failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (!this.budgetCache || this.budgetCache.key !== key) {
          this.budgetCache = { key, doc: emptyBudgetDoc(key, nowMs), fetchedAtMs: 0 };
        }
      } finally {
        this.budgetRefresh = null;
      }
    })();
    return this.budgetRefresh;
  }

  /** Cached shared doc + this instance's unflushed delta, with the code-defined caps. */
  private mergedBudget(nowMs: number): BudgetDayDoc {
    const key = formatUtcDateKey(nowMs);
    const base =
      this.budgetCache && this.budgetCache.key === key
        ? this.budgetCache.doc
        : emptyBudgetDoc(key, nowMs);
    let merged = { ...base };
    const flushing = this.flushingUsage.get(key);
    if (flushing) merged = addDelta(merged, flushing);
    const pending = this.pendingUsage.get(key);
    if (pending) merged = addDelta(merged, pending);
    merged.agentCapUsd = AGENT_DAILY_BUDGET_USD;
    merged.nlCommandCapUsd = NL_COMMAND_DAILY_BUDGET_USD;
    return merged;
  }

  async getBudget(nowMs: number = Date.now()): Promise<BudgetDayDoc> {
    await this.refreshBudgetCache(nowMs);
    return this.mergedBudget(nowMs);
  }

  async setBudgetForTesting(
    overrides: Partial<BudgetDayDoc>,
    nowMs: number = Date.now(),
  ): Promise<void> {
    await this.fallback.setBudgetForTesting(overrides, nowMs);
  }

  async publishTransfer(transfer: Transfer): Promise<string> {
    const topic = this.pubsub.topic(this.transfersTopic);
    const data = Buffer.from(JSON.stringify(transfer), 'utf8');
    return topic.publishMessage({
      data,
      attributes: {
        toSite: transfer.toSite,
        fromSite: transfer.fromSite,
      },
    });
  }

  /**
   * Streaming pull on `TRANSFERS_SUBSCRIPTION` (default `site-transfers-<siteId><suffix>`).
   * A non-retryable stream error (missing subscription, IAM) closes the stream; it is logged
   * once per failure streak and reopened with capped exponential backoff (5 s .. 5 min).
   */
  subscribeTransfers(
    siteId: SiteId,
    onTransfer: (payload: unknown) => boolean,
  ): () => Promise<void> {
    const name = process.env.TRANSFERS_SUBSCRIPTION || `site-transfers-${siteId}${this.suffix}`;
    let stopped = false;
    let current: Subscription | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = TRANSFER_PULL_MIN_BACKOFF_MS;
    let failureStreak = 0;

    const open = (): void => {
      if (stopped) return;
      const sub = this.pubsub.subscription(name, {
        flowControl: { maxMessages: 16, allowExcessMessages: false },
      });
      current = sub;
      sub.on('message', (message: Message) => {
        failureStreak = 0;
        backoffMs = TRANSFER_PULL_MIN_BACKOFF_MS;
        let payload: unknown;
        try {
          payload = JSON.parse(message.data.toString('utf8'));
        } catch {
          console.error(`[persistence] transfer ${message.id} on ${name} is not JSON; acked and dropped`);
          message.ack();
          return;
        }
        let ack = false;
        try {
          ack = onTransfer(payload);
        } catch (err) {
          console.error(
            `[persistence] transfer ${message.id} handler threw; nacked: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (ack) message.ack();
        else message.nack();
      });
      sub.on('error', (err: Error) => {
        failureStreak += 1;
        if (failureStreak === 1) {
          console.error(`[persistence] transfer pull on ${name} failed (retrying with backoff): ${err.message}`);
        }
        sub.removeAllListeners();
        void sub.close().catch(() => undefined);
        if (current === sub) current = null;
        if (stopped) return;
        retryTimer = setTimeout(open, backoffMs);
        retryTimer.unref?.();
        backoffMs = Math.min(TRANSFER_PULL_MAX_BACKOFF_MS, backoffMs * 2);
      });
    };

    open();
    return async () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      const sub = current;
      current = null;
      if (sub) {
        sub.removeAllListeners('message');
        await sub.close();
      }
    };
  }
}

const TRANSFER_PULL_MIN_BACKOFF_MS = 5_000;
const TRANSFER_PULL_MAX_BACKOFF_MS = 5 * 60_000;

function sumDelta(a: UsageDelta, b: UsageDelta): UsageDelta {
  return {
    agentSpentUsd: a.agentSpentUsd + b.agentSpentUsd,
    agentTokensIn: a.agentTokensIn + b.agentTokensIn,
    agentTokensOut: a.agentTokensOut + b.agentTokensOut,
    agentCalls: a.agentCalls + b.agentCalls,
    nlCommandSpentUsd: a.nlCommandSpentUsd + b.nlCommandSpentUsd,
    nlTokensIn: a.nlTokensIn + b.nlTokensIn,
    nlTokensOut: a.nlTokensOut + b.nlTokensOut,
    nlCalls: a.nlCalls + b.nlCalls,
  };
}

function addDelta(doc: BudgetDayDoc, d: UsageDelta): BudgetDayDoc {
  return {
    ...doc,
    agentSpentUsd: Number(((doc.agentSpentUsd ?? 0) + d.agentSpentUsd).toFixed(6)),
    agentTokensIn: (doc.agentTokensIn ?? 0) + d.agentTokensIn,
    agentTokensOut: (doc.agentTokensOut ?? 0) + d.agentTokensOut,
    agentCalls: (doc.agentCalls ?? 0) + d.agentCalls,
    nlCommandSpentUsd: Number(((doc.nlCommandSpentUsd ?? 0) + d.nlCommandSpentUsd).toFixed(6)),
    nlTokensIn: (doc.nlTokensIn ?? 0) + d.nlTokensIn,
    nlTokensOut: (doc.nlTokensOut ?? 0) + d.nlTokensOut,
    nlCalls: (doc.nlCalls ?? 0) + d.nlCalls,
  };
}

/** Reads a Firestore entry doc back into `DailyEntryDoc` (`expireAt` is a Timestamp there). */
function fromEntryData(data: FirebaseFirestore.DocumentData | undefined): DailyEntryDoc | null {
  if (!data || typeof data.bestPts !== 'number') return null;
  const exp = data.expireAt as { toMillis?: () => number } | number | undefined;
  return {
    ...(data as DailyEntryDoc),
    expireAt: typeof exp === 'number' ? exp : typeof exp?.toMillis === 'function' ? exp.toMillis() : 0,
  };
}

/** Reads a Firestore league entry back into `LeagueEntryDoc` (`expireAt` is a Timestamp there). */
function fromLeagueEntryData(data: FirebaseFirestore.DocumentData | undefined): LeagueEntryDoc | null {
  if (!data || typeof data.weekPts !== 'number') return null;
  const exp = data.expireAt as { toMillis?: () => number } | number | undefined;
  return {
    ...(data as LeagueEntryDoc),
    topRuns: Array.isArray(data.topRuns) ? (data.topRuns as number[]) : [],
    expireAt: typeof exp === 'number' ? exp : typeof exp?.toMillis === 'function' ? exp.toMillis() : 0,
  };
}
