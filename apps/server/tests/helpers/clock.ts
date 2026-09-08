import type { Clock, Timer } from '../../src/tournament/clock.js';

interface Scheduled {
  at: number;
  run: () => void;
}

/**
 * The `Clock` port driven by hand. Every tournament deadline goes through it, so a whole
 * tournament can be played out by advancing time rather than by waiting for it — and,
 * crucially, two tables armed at the same instant fire in the same batch, which is the
 * only way to reproduce a simultaneous round-completion race on purpose.
 */
export class ManualClock implements Clock {
  private current: number;
  private nextId = 1;
  private readonly scheduled = new Map<number, Scheduled>();

  constructor(startedAt: number = Date.UTC(2026, 0, 1, 12, 0, 0)) {
    this.current = startedAt;
  }

  now(): number {
    return this.current;
  }

  after(ms: number, run: () => void): Timer {
    const id = this.nextId;
    this.nextId += 1;
    this.scheduled.set(id, { at: this.current + ms, run });
    return {
      cancel: () => {
        this.scheduled.delete(id);
      },
    };
  }

  get pending(): number {
    return this.scheduled.size;
  }

  /**
   * Moves to `now + ms`, firing every timer that comes due. Timers sharing a deadline fire
   * together, and `settle` after each batch lets the database work those callbacks start
   * actually land before the next batch goes off.
   */
  async advance(ms: number, settleMs = 40): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      const due = [...this.scheduled.entries()].filter(([, entry]) => entry.at <= target);
      if (due.length === 0) break;

      const earliest = Math.min(...due.map(([, entry]) => entry.at));
      const batch = due.filter(([, entry]) => entry.at === earliest);
      this.current = earliest;
      for (const [id] of batch) this.scheduled.delete(id);
      for (const [, entry] of batch) entry.run();
      await settle(settleMs);
    }
    this.current = target;
    await settle(settleMs);
  }
}

/** Real time, deliberately: the work the fired timers kicked off is real database I/O. */
export function settle(ms = 40): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
