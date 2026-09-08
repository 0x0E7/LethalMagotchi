/**
 * Rejects the same body sent twice in a row into the same channel. The token buckets already
 * bound how *fast* a player can talk; this bounds how little they can say while doing it,
 * which is the shape spam actually takes.
 *
 * Memory-bounded the same way the rate limiter is: a per-account key that an abuser can mint
 * by reconnecting must never be able to grow without a ceiling.
 */
const DEFAULT_WINDOW_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 20_000;

interface Entry {
  body: string;
  at: number;
}

export interface DuplicateGuardOptions {
  windowMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export class DuplicateGuard {
  private readonly entries = new Map<string, Entry>();
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: DuplicateGuardOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? (() => Date.now());
  }

  /** True when this body repeats the previous one in this channel inside the window. */
  isRepeat(accountId: string, channelId: string, body: string): boolean {
    const key = `${accountId}:${channelId}`;
    const now = this.now();
    const previous = this.entries.get(key);
    const repeat = previous !== undefined && previous.body === body && now - previous.at < this.windowMs;

    // Delete first so the re-insert moves the key to the end of the iteration order, which
    // is what makes the eviction below least-recently-used rather than arbitrary.
    this.entries.delete(key);
    this.entries.set(key, { body, at: now });
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    return repeat;
  }

  reset(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}
