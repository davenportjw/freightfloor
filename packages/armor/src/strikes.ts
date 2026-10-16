export const PLAYER_RATE_LIMIT_PER_MIN = 6;
export const IP_RATE_LIMIT_PER_MIN = 30;
export const RATE_WINDOW_MS = 60_000;
export const STRIKE_LIMIT = 3;
export const STRIKE_WINDOW_MS = 10 * 60_000; // 10 minutes
export const MUTE_DURATION_MS = 15 * 60_000; // 15 minutes
export const BLOCK_HISTORY_WINDOW_MS = 60 * 60_000; // 1 hour

export type GuardCheckResult =
  | { ok: true }
  | { ok: false; code: 'muted' | 'rate_limited'; message: string; retryAfterMs: number };

export interface StrikeRecordResult {
  strikes: number;
  muted: boolean;
  mutedUntil?: number;
}

export interface ArmorGuardOptions {
  playerRateLimitPerMin?: number;
  ipRateLimitPerMin?: number;
  rateWindowMs?: number;
  strikeLimit?: number;
  strikeWindowMs?: number;
  muteDurationMs?: number;
}

/**
 * Layer 1 & Layer 7 Rate Limiter + Strike Counter:
 * - Enforces 6 `nlCommand` requests per real minute per player (`clientId`)
 * - Enforces 30 `nlCommand` requests per real minute per IP
 * - Tracks armor strikes: 3 strikes within 10 minutes mutes `nlCommand` for both `clientId` and `ip` for 15 minutes
 * - Tracks 1-hour armor block count for `brainHealth.armorBlocks1h`
 */
export class ArmorGuard {
  private readonly playerLimit: number;
  private readonly ipLimit: number;
  private readonly rateWindowMs: number;
  private readonly strikeLimit: number;
  private readonly strikeWindowMs: number;
  private readonly muteDurationMs: number;

  private readonly playerRequests = new Map<string, number[]>();
  private readonly ipRequests = new Map<string, number[]>();
  private readonly clientStrikes = new Map<string, number[]>();
  private readonly ipStrikes = new Map<string, number[]>();
  private readonly mutedClients = new Map<string, number>();
  private readonly mutedIps = new Map<string, number>();
  private readonly blockTimestamps: number[] = [];

  constructor(opts: ArmorGuardOptions = {}) {
    this.playerLimit = opts.playerRateLimitPerMin ?? PLAYER_RATE_LIMIT_PER_MIN;
    this.ipLimit = opts.ipRateLimitPerMin ?? IP_RATE_LIMIT_PER_MIN;
    this.rateWindowMs = opts.rateWindowMs ?? RATE_WINDOW_MS;
    this.strikeLimit = opts.strikeLimit ?? STRIKE_LIMIT;
    this.strikeWindowMs = opts.strikeWindowMs ?? STRIKE_WINDOW_MS;
    this.muteDurationMs = opts.muteDurationMs ?? MUTE_DURATION_MS;
  }

  private pruneWindow(arr: number[] | undefined, cutoff: number): number[] {
    if (!arr || arr.length === 0) return [];
    let idx = 0;
    while (idx < arr.length && arr[idx] <= cutoff) {
      idx++;
    }
    return idx === 0 ? arr : arr.slice(idx);
  }

  public isMuted(clientId: string, ip: string, nowMs: number = Date.now()): { muted: boolean; retryAfterMs: number } {
    const clientUntil = this.mutedClients.get(clientId) ?? 0;
    const ipUntil = this.mutedIps.get(ip) ?? 0;
    const until = Math.max(clientUntil, ipUntil);
    if (until > nowMs) {
      return { muted: true, retryAfterMs: until - nowMs };
    }
    if (clientUntil && clientUntil <= nowMs) this.mutedClients.delete(clientId);
    if (ipUntil && ipUntil <= nowMs) this.mutedIps.delete(ip);
    return { muted: false, retryAfterMs: 0 };
  }

  /**
   * Checks whether `clientId` and `ip` are allowed to issue a typed order right now,
   * and records the request timestamp if allowed.
   */
  public consumeRequest(clientId: string, ip: string, nowMs: number = Date.now()): GuardCheckResult {
    const muteStatus = this.isMuted(clientId, ip, nowMs);
    if (muteStatus.muted) {
      return {
        ok: false,
        code: 'muted',
        message: `Typed orders are muted for ${Math.ceil(muteStatus.retryAfterMs / 1000)}s due to repeated armor strikes.`,
        retryAfterMs: muteStatus.retryAfterMs,
      };
    }

    const rateCutoff = nowMs - this.rateWindowMs;
    const playerHistory = this.pruneWindow(this.playerRequests.get(clientId), rateCutoff);
    const ipHistory = this.pruneWindow(this.ipRequests.get(ip), rateCutoff);

    if (playerHistory.length >= this.playerLimit) {
      const retryAfterMs = Math.max(1, playerHistory[0] + this.rateWindowMs - nowMs);
      this.playerRequests.set(clientId, playerHistory);
      return {
        ok: false,
        code: 'rate_limited',
        message: `Player rate limit exceeded (${this.playerLimit} orders per minute).`,
        retryAfterMs,
      };
    }

    if (ipHistory.length >= this.ipLimit) {
      const retryAfterMs = Math.max(1, ipHistory[0] + this.rateWindowMs - nowMs);
      this.ipRequests.set(ip, ipHistory);
      return {
        ok: false,
        code: 'rate_limited',
        message: `IP rate limit exceeded (${this.ipLimit} orders per minute).`,
        retryAfterMs,
      };
    }

    playerHistory.push(nowMs);
    ipHistory.push(nowMs);
    this.playerRequests.set(clientId, playerHistory);
    this.ipRequests.set(ip, ipHistory);

    return { ok: true };
  }

  /**
   * Alias for `consumeRequest` so callers using `checkAndRecord` or `consumeRequest` both work.
   */
  public checkAndRecord(clientId: string, ip: string, nowMs: number = Date.now()): GuardCheckResult {
    return this.consumeRequest(clientId, ip, nowMs);
  }

  /**
   * Records an armor strike for `clientId` and `ip`.
   * If 3 strikes accumulate within 10 minutes, mutes both `clientId` and `ip` for 15 minutes.
   */
  public recordStrike(clientId: string, ip: string, nowMs: number = Date.now()): StrikeRecordResult {
    this.recordBlock(nowMs);
    const cutoff = nowMs - this.strikeWindowMs;
    const cList = this.pruneWindow(this.clientStrikes.get(clientId), cutoff);
    const iList = this.pruneWindow(this.ipStrikes.get(ip), cutoff);

    cList.push(nowMs);
    iList.push(nowMs);
    this.clientStrikes.set(clientId, cList);
    this.ipStrikes.set(ip, iList);

    const strikes = Math.max(cList.length, iList.length);
    if (strikes >= this.strikeLimit) {
      const mutedUntil = nowMs + this.muteDurationMs;
      this.mutedClients.set(clientId, mutedUntil);
      this.mutedIps.set(ip, mutedUntil);
      return { strikes, muted: true, mutedUntil };
    }

    return { strikes, muted: false };
  }

  public recordBlock(nowMs: number = Date.now()): void {
    this.blockTimestamps.push(nowMs);
    this.pruneBlocks(nowMs);
  }

  private pruneBlocks(nowMs: number): void {
    const cutoff = nowMs - BLOCK_HISTORY_WINDOW_MS;
    while (this.blockTimestamps.length > 0 && this.blockTimestamps[0] <= cutoff) {
      this.blockTimestamps.shift();
    }
  }

  public getBlocksLastHour(nowMs: number = Date.now()): number {
    this.pruneBlocks(nowMs);
    return this.blockTimestamps.length;
  }
}
