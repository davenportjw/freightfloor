import { FieldValue, Firestore, Timestamp } from '@google-cloud/firestore';
import { PubSub } from '@google-cloud/pubsub';
import type { ArmorReasonCode } from '@warehouse/armor';
import type {
  DecisionKind,
  Phase,
  SiteId,
  Transfer,
} from '@warehouse/protocol';
import type { WorldSnapshotV5 } from '@warehouse/sim';
import type { BrainHealth } from './brain.js';

export type SitePhase = Phase;
export type WorldSnapshot = WorldSnapshotV5;

export const AGENT_DAILY_BUDGET_USD =
  Number(process.env.AGENT_DAILY_BUDGET_USD) > 0
    ? Number(process.env.AGENT_DAILY_BUDGET_USD)
    : 12.5;
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

/**
 * Estimates Gemini 3.5 Flash-Lite cost in USD from input/output token counts.
 * Uses $0.075 / 1M input tokens and $0.30 / 1M output tokens with a minimum floor of $0.000005 per call.
 */
export function estimateGeminiFlashCostUsd(tokensIn: number, tokensOut: number): number {
  const raw = (Math.max(0, tokensIn) * 0.075 + Math.max(0, tokensOut) * 0.3) / 1_000_000;
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
}

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
