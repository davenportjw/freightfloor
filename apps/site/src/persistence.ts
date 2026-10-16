import { Firestore, Timestamp } from '@google-cloud/firestore';
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

export const AGENT_DAILY_BUDGET_USD = 25.0;
export const NL_COMMAND_DAILY_BUDGET_USD = 3.0;
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
 * Estimates Gemini 3.8 Flash cost in USD from input/output token counts.
 * Uses $0.15 / 1M input tokens and $0.60 / 1M output tokens with a minimum floor of $0.00001 per call.
 */
export function estimateGeminiFlashCostUsd(tokensIn: number, tokensOut: number): number {
  const raw = (Math.max(0, tokensIn) * 0.15 + Math.max(0, tokensOut) * 0.6) / 1_000_000;
  return Math.max(0.00001, raw);
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
}

export class CloudPersistenceStore implements PersistenceStore {
  private readonly db: Firestore;
  private readonly pubsub: PubSub;
  private readonly suffix: string;
  private readonly transfersTopic: string;
  private readonly fallback = new InMemoryPersistenceStore();

  constructor(opts: CloudPersistenceOptions = {}) {
    const projectId = opts.projectId ?? process.env.GCP_PROJECT_ID ?? 'davenport-boutique';
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

  async checkBudget(
    category: 'agent' | 'nlCommand',
    nowMs: number = Date.now(),
  ): Promise<{ allowed: boolean; spentUsd: number; capUsd: number }> {
    const doc = await this.getBudget(nowMs);
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

  async recordUsage(
    category: 'agent' | 'nlCommand',
    tokensIn: number,
    tokensOut: number,
    costUsd?: number,
    nowMs: number = Date.now(),
  ): Promise<BudgetDayDoc> {
    const key = formatUtcDateKey(nowMs);
    const ref = this.db.collection(this.colName('budget')).doc(key);
    const deltaUsd = costUsd ?? estimateGeminiFlashCostUsd(tokensIn, tokensOut);

    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const current: BudgetDayDoc = snap.exists
        ? (snap.data() as BudgetDayDoc)
        : {
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

      if (category === 'agent') {
        current.agentSpentUsd = Number((current.agentSpentUsd + deltaUsd).toFixed(6));
        current.agentTokensIn += Math.max(0, tokensIn);
        current.agentTokensOut += Math.max(0, tokensOut);
        current.agentCalls += 1;
      } else {
        current.nlCommandSpentUsd = Number((current.nlCommandSpentUsd + deltaUsd).toFixed(6));
        current.nlTokensIn += Math.max(0, tokensIn);
        current.nlTokensOut += Math.max(0, tokensOut);
        current.nlCalls += 1;
      }
      current.updatedAt = nowMs;
      tx.set(ref, current, { merge: true });
    });

    return this.fallback.recordUsage(category, tokensIn, tokensOut, costUsd, nowMs);
  }

  async getBudget(nowMs: number = Date.now()): Promise<BudgetDayDoc> {
    const key = formatUtcDateKey(nowMs);
    const snap = await this.db.collection(this.colName('budget')).doc(key).get();
    if (!snap.exists) {
      return this.fallback.getBudget(nowMs);
    }
    return snap.data() as BudgetDayDoc;
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
