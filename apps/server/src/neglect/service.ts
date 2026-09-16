import { isDeadHp, roundStats } from '@lethalmagotchi/shared';
import { withTransaction, type Db, type DbClient } from '../db/pool.js';
import {
  isEngaged,
  lockCharacterById,
  simulatedStats,
  toCharacterDto,
  type CharacterRow,
} from '../repos/characters.js';
import { rebirthCharacter, type RebirthOutcome } from '../repos/rebirth.js';
import { systemClock, type Clock, type Timer } from '../tournament/clock.js';
import type { Hub } from '../ws/hub.js';

/**
 * How often the online population is checked for deaths.
 *
 * Decay itself stays lazy — nothing is written on a tick, and the numbers a read produces are
 * identical with or without this sweep. What the sweep exists for is the *event*: a player
 * watching their HP bar drain to zero has to see the pet die, and a derived-on-read value
 * cannot announce itself. Only characters with a live socket are swept, so the work is bounded
 * by who is actually looking; everyone else is reaped the moment they reconnect.
 */
export const NEGLECT_SWEEP_MS = 60_000;

export interface NeglectDeps {
  db: Db;
  hub: Hub;
  clock?: Clock;
  /** Overridden in E2E so a starvation death lands inside a test's patience. */
  sweepMs?: number;
  log?: (message: string, fields: Record<string, unknown>) => void;
}

/**
 * Death by neglect.
 *
 * HP has always fallen to zero correctly; nothing ever acted on it. Tournament entry and duel
 * defeat both kill inside a transaction somebody else started, so there was no code path at
 * all for the death that happens when nobody does anything — the pet simply sat at zero.
 *
 * Every death goes through `reap`, which is idempotent under concurrency by construction: it
 * re-reads the character under a row lock and recomputes, so a second caller racing the first
 * finds a pet that has already been renewed and writes nothing.
 */
export class NeglectService {
  private readonly db: Db;
  private readonly hub: Hub;
  private readonly clock: Clock;
  private readonly sweepMs: number;
  private readonly log: (message: string, fields: Record<string, unknown>) => void;
  private timer: Timer | null = null;
  private running = false;

  constructor(deps: NeglectDeps) {
    this.db = deps.db;
    this.hub = deps.hub;
    this.clock = deps.clock ?? systemClock;
    this.sweepMs = deps.sweepMs ?? NEGLECT_SWEEP_MS;
    this.log = deps.log ?? (() => {});
  }

  start(): void {
    if (this.timer) return;
    this.arm();
  }

  stop(): void {
    this.timer?.cancel();
    this.timer = null;
  }

  private arm(): void {
    this.timer = this.clock.after(this.sweepMs, () => {
      void this.sweep()
        .catch((error: unknown) => this.log('neglect sweep failed', { error }))
        .finally(() => {
          // Re-armed after the work, never before: a sweep that outruns its own interval
          // must not overlap itself.
          if (this.timer) this.arm();
        });
    });
  }

  /** Every character with a live socket, checked once. */
  async sweep(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      let reaped = 0;
      for (const characterId of this.hub.onlineCharacterIds()) {
        if (await this.reap(characterId)) reaped += 1;
      }
      return reaped;
    } finally {
      this.running = false;
    }
  }

  /**
   * Called when a socket binds. A pet that died while its owner was away has been sitting at
   * zero for however long that was, and this is the moment they find out.
   */
  onCharacterOnline(characterId: string): void {
    void this.reap(characterId).catch((error: unknown) =>
      this.log('neglect reap failed', { characterId, error }),
    );
  }

  /**
   * One character, checked and reaped if dead. Safe to call concurrently with itself: the
   * row lock serializes the callers and the losers re-read a pet that is already renewed.
   */
  async reap(characterId: string): Promise<RebirthOutcome | null> {
    const now = this.clock.now();
    const outcome = await withTransaction(this.db, async (client) => {
      const row = await lockCharacterById(client, characterId);
      return row ? reapLocked(client, row, now) : null;
    });
    if (!outcome?.rebirth) return null;
    this.announce(characterId, outcome.rebirth, now);
    return outcome.rebirth;
  }

  /** The frame that makes a death visible, identical in shape to the duel and tournament ones. */
  announce(characterId: string, rebirth: RebirthOutcome, now: number): void {
    this.hub.sendToCharacter(characterId, {
      type: 'character:rebirth',
      character: toCharacterDto(rebirth.character, now),
      statsBefore: rebirth.statsBefore,
      coinsBefore: rebirth.coinsBefore,
      rebirthIndex: rebirth.rebirthIndex,
      cause: 'neglect',
    });
  }
}

export interface Reaped {
  row: CharacterRow;
  rebirth: RebirthOutcome | null;
}

/**
 * The death check itself, against a row the caller has already locked.
 *
 * Split out so a caller already inside a transaction — the action route, which must not let
 * anyone feed a corpse — reaps in that same transaction rather than opening a second one and
 * racing itself.
 *
 * An engaged character is deliberately never reaped. Their coins are escrowed at a table or
 * against a duel stake, and a rebirth resets the wallet those settlements are counting on;
 * tearing that down mid-hand would turn one death into a corrupted engagement. They stay
 * alive until the engagement releases them, and the next sweep takes them.
 */
export async function reapLocked(client: DbClient, row: CharacterRow, now: number): Promise<Reaped> {
  const stats = simulatedStats(row, now);
  if (!isDeadHp(stats.hp) || isEngaged(row)) return { row, rebirth: null };

  const rebirth = await rebirthCharacter(client, row, {
    // The snapshot the rebirth card quotes back: what they looked like when they died, not
    // the blank slate that replaced them.
    statsBefore: roundStats(stats),
    cause: 'neglect',
    tournamentId: null,
    duelId: null,
    at: new Date(now),
    /**
     * The row lock above is the first line of defence and the conditional claim is the
     * second, because the two protect against different things. The lock serializes reapers
     * that arrive together; the claim catches the one that read *before* the lock was taken
     * and is still holding a stale view of a pet somebody else has already renewed. Without
     * it, exactly-once depends on lock ordering — which is the kind of guarantee that holds
     * in testing and fails in production.
     */
    expectRebirthCount: row.rebirth_count,
  });
  if (!rebirth) return { row, rebirth: null };
  return { row: rebirth.character, rebirth };
}
