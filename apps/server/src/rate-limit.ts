export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface Entry {
  count: number;
  windowStartedAt: number;
  strikes: number;
  blockedUntil: number;
}

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  maxBackoffMs?: number;
  now?: () => number;
}

export class RateLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;

  constructor(options: RateLimiterOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.maxBackoffMs = options.maxBackoffMs ?? 15 * 60_000;
    this.now = options.now ?? (() => Date.now());
  }

  check(key: string): RateLimitDecision {
    const now = this.now();
    this.sweep(now);
    const entry = this.entries.get(key);

    if (entry && entry.blockedUntil > now) {
      return { allowed: false, retryAfterSeconds: Math.ceil((entry.blockedUntil - now) / 1000) };
    }
    if (!entry || now - entry.windowStartedAt >= this.windowMs) {
      this.entries.set(key, { count: 1, windowStartedAt: now, strikes: entry?.strikes ?? 0, blockedUntil: 0 });
      return { allowed: true, retryAfterSeconds: 0 };
    }
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

  private sweep(now: number): void {
    if (this.entries.size < 1000) return;
    for (const [key, entry] of this.entries) {
      if (entry.blockedUntil <= now && now - entry.windowStartedAt >= this.windowMs) {
        this.entries.delete(key);
      }
    }
  }
}
