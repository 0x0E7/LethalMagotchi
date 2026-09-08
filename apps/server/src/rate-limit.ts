export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface Entry {
  count: number;
  windowStartedAt: number;
  lastSeenAt: number;
  strikes: number;
  blockedUntil: number;
}

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  maxBackoffMs?: number;
  /** Quiet time after which accumulated strikes are forgiven. Never, by default. */
  strikeDecayMs?: number;
  /** Hard ceiling on retained keys, enforced by evicting the least recently seen. */
  maxEntries?: number;
  now?: () => number;
}

/** Below this the map is too small to be worth walking. */
const SWEEP_MIN_ENTRIES = 1_000;
const SWEEP_MAX_INTERVAL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 50_000;

export class RateLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxBackoffMs: number;
  private readonly strikeDecayMs: number;
  private readonly maxEntries: number;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private nextSweepAt = 0;

  constructor(options: RateLimiterOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.maxBackoffMs = options.maxBackoffMs ?? 15 * 60_000;
    this.strikeDecayMs = options.strikeDecayMs ?? Number.POSITIVE_INFINITY;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.sweepIntervalMs = Math.min(this.windowMs, SWEEP_MAX_INTERVAL_MS);
    this.now = options.now ?? (() => Date.now());
  }

  check(key: string): RateLimitDecision {
    const now = this.now();
    this.sweep(now);
    const entry = this.entries.get(key);

    if (entry && entry.blockedUntil > now) {
      // Hammering while blocked keeps the key "seen", so an attacker cannot idle out its
      // own escalation by flooding through the block.
      entry.lastSeenAt = now;
      return { allowed: false, retryAfterSeconds: Math.ceil((entry.blockedUntil - now) / 1000) };
    }
    if (!entry || now - entry.windowStartedAt >= this.windowMs) {
      const strikes = entry ? this.survivingStrikes(entry, now) : 0;
      this.entries.set(key, { count: 1, windowStartedAt: now, lastSeenAt: now, strikes, blockedUntil: 0 });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    entry.lastSeenAt = now;
    if (entry.count < this.limit) {
      entry.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }

    entry.strikes += 1;
    const backoff = Math.min(this.windowMs * 2 ** (entry.strikes - 1), this.maxBackoffMs);
    entry.blockedUntil = now + backoff;
    return { allowed: false, retryAfterSeconds: Math.ceil(backoff / 1000) };
  }

  reset(key?: string): void {
    if (key === undefined) this.entries.clear();
    else this.entries.delete(key);
  }

  /** Retained keys. Exposed so a test can assert the sweep actually bounds the map. */
  size(): number {
    return this.entries.size;
  }

  private survivingStrikes(entry: Entry, now: number): number {
    if (entry.strikes === 0) return 0;
    return now - entry.lastSeenAt < this.strikeDecayMs ? entry.strikes : 0;
  }

  /**
   * An entry *is* its strike history, so evicting one with live strikes hands the key back
   * its first-offence backoff. Only records whose strikes have already decayed — for which
   * deleting and re-creating fresh is behaviourally identical — may be forgotten here.
   * Rate-limited by time as well as by size: the walk is O(n) and `check` is hot.
   */
  private sweep(now: number): void {
    if (this.entries.size < SWEEP_MIN_ENTRIES || now < this.nextSweepAt) return;
    this.nextSweepAt = now + this.sweepIntervalMs;

    for (const [key, entry] of this.entries) {
      if (entry.blockedUntil > now) continue;
      if (now - entry.windowStartedAt < this.windowMs) continue;
      if (this.survivingStrikes(entry, now) > 0) continue;
      this.entries.delete(key);
    }

    // Backstop for limiters that never decay strikes: without it a distributed attack
    // would pin one un-evictable record per source address for the process lifetime.
    if (this.entries.size > this.maxEntries) {
      const surplus = this.entries.size - this.maxEntries;
      const oldest = [...this.entries]
        .sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt)
        .slice(0, surplus);
      for (const [key] of oldest) this.entries.delete(key);
    }
  }
}
