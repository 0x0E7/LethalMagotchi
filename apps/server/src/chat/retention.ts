import type { Db } from '../db/pool.js';
import { purgeGlobalMessagesBefore } from '../repos/chat.js';
import { systemClock, type Clock, type Timer } from '../tournament/clock.js';

/** DM history is kept indefinitely; only the Town Square rolls off. */
export const TOWN_SQUARE_RETENTION_DAYS = 30;

/** Distinct from the tournament scheduler's key so the two jobs never contend. */
const PURGE_LOCK_KEY = 0x4c4d_4348;

const DAY_MS = 24 * 60 * 60_000;

export interface ChatRetentionOptions {
  db: Db;
  clock?: Clock;
  intervalMs?: number;
  retentionDays?: number;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * Single-instance-safe the same way the tournament scheduler is — a Postgres advisory lock
 * decides who runs. The lock is taken and released around each run rather than held for the
 * process lifetime: a periodic job whose holder restarts must not leave the purge unrun
 * until every other instance also restarts.
 */
export class ChatRetentionJob {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly intervalMs: number;
  private readonly retentionDays: number;
  private readonly log: (message: string, meta?: Record<string, unknown>) => void;
  private timer: Timer | null = null;
  private stopped = false;
  private running: Promise<number> | null = null;

  constructor(options: ChatRetentionOptions) {
    this.db = options.db;
    this.clock = options.clock ?? systemClock;
    this.intervalMs = options.intervalMs ?? DAY_MS;
    this.retentionDays = options.retentionDays ?? TOWN_SQUARE_RETENTION_DAYS;
    this.log = options.log ?? (() => {});
  }

  start(): void {
    if (this.stopped) return;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = this.clock.after(this.intervalMs, () => {
      void this.runOnce()
        .catch((error: unknown) => this.log('chat retention purge failed', { error }))
        .finally(() => this.schedule());
    });
  }

  /** Exposed so a test can drive one pass without waiting a day. Returns rows deleted. */
  async runOnce(): Promise<number> {
    this.running ??= this.purge().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async purge(): Promise<number> {
    const client = await this.db.connect();
    try {
      const held = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
        PURGE_LOCK_KEY,
      ]);
      if (!held.rows[0]?.locked) return 0;

      try {
        const before = new Date(this.clock.now() - this.retentionDays * DAY_MS);
        const deleted = await purgeGlobalMessagesBefore(client, before);
        if (deleted > 0) this.log('purged town square messages', { deleted, before: before.toISOString() });
        return deleted;
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [PURGE_LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  }
}
