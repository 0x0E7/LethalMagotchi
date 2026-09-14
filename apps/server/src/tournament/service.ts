import { randomInt } from 'node:crypto';
import {
  CHAMPION_COSMETIC_ID,
  HOUSE_PRIZE_PER_ENTRANT,
  MIN_ENTRANTS,
  chargeCoinsFor,
  nextSlotAfter,
  planRound,
  resolveEntryCharge,
  roundStats,
  roundsNeededFor,
  shardCountFor,
  shardEntrants,
  type CharacterStats,
  type ServerMessage,
} from '@lethalmagotchi/shared';
import type { TournamentConfig } from '../config.js';
import { SCHEDULER_LOCK_KEY } from '../db/advisory-locks.js';
import { withTransaction, type Db, type DbClient } from '../db/pool.js';
import { grantCosmetic } from '../repos/accounts.js';
import {
  commitCharacterState,
  creditCoins,
  lockCharacterById,
  recordTournamentWin,
  setSeatedTable,
  simulatedStats,
  toCharacterDto,
  type CharacterRow,
} from '../repos/characters.js';
import { reservedInviteStake } from '../repos/duels.js';
import { rebirthCharacter } from '../repos/rebirth.js';
import {
  claimCharge,
  claimRegistrationClose,
  claimRoundAdvance,
  findActiveTournament,
  findTournamentById,
  findTournamentsInState,
  insertEntry,
  insertScheduledTournament,
  insertTable,
  listAbandonedCloses,
  listCharacterBadges,
  listEligibleCharacterIds,
  listEntries,
  listLiveEntries,
  listSeats,
  listTables,
  setSeatConnected,
  toTournamentSummary,
  tournamentHandsPlayed,
  updateEntry,
  updateTable,
  updateTournamentState,
  type TournamentRow,
} from '../repos/tournaments.js';
import type { Hub } from '../ws/hub.js';
import { systemClock, type Clock, type Timer } from './clock.js';
import { TableRunner, type RunnerSeat, type TableCompletion } from './table-runner.js';

/** Kept below the pool's 10 connections so registration close never starves live play. */
const CHARGE_CONCURRENCY = 6;

export interface TournamentServiceOptions {
  db: Db;
  hub: Hub;
  config: TournamentConfig;
  clock?: Clock;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export class TournamentService {
  private readonly db: Db;
  private readonly hub: Hub;
  private readonly config: TournamentConfig;
  private readonly clock: Clock;
  private readonly log: (message: string, meta?: Record<string, unknown>) => void;

  private readonly tables = new Map<string, TableRunner>();
  private readonly tablesByCharacter = new Map<string, TableRunner>();

  /** One promise chain per tournament: round advance and round start are single-writer. */
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Tournaments with an armed round-break timer, so the watchdog leaves them alone. */
  private readonly pendingRounds = new Set<string>();

  private lockClient: DbClient | null = null;
  private ticking = false;
  private tickTimer: Timer | null = null;
  private stopped = false;
  private starting: Promise<void> | null = null;

  constructor(options: TournamentServiceOptions) {
    this.db = options.db;
    this.hub = options.hub;
    this.config = options.config;
    this.clock = options.clock ?? systemClock;
    this.log = options.log ?? (() => {});
  }

  async start(): Promise<void> {
    if (!this.config.enabled || this.stopped) return;
    this.starting ??= this.startOnce().finally(() => {
      this.starting = null;
    });
    await this.starting;
  }

  private async startOnce(): Promise<void> {
    this.lockClient = await this.db.connect();
    const held = await this.lockClient.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [SCHEDULER_LOCK_KEY],
    );
    if (!held.rows[0]?.locked) {
      // Another instance owns the schedule. Play still works here; only the
      // scheduler is single-writer.
      this.lockClient.release();
      this.lockClient = null;
      this.log('tournament scheduler not started: lock held elsewhere');
      return;
    }

    await this.recoverOnBoot();
    if (this.stopped) return;
    this.scheduleTick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.tickTimer?.cancel();
    // A stop that lands mid-boot must not race recovery to the same rows.
    await this.starting?.catch(() => undefined);
    for (const table of this.tables.values()) await table.stop();
    this.tables.clear();
    this.tablesByCharacter.clear();
    await Promise.allSettled([...this.chains.values()]);
    if (this.lockClient) {
      await this.lockClient.query('SELECT pg_advisory_unlock($1)', [SCHEDULER_LOCK_KEY]);
      this.lockClient.release();
      this.lockClient = null;
    }
  }

  /**
   * All round advancement for one tournament runs on a single chain. Combined with the
   * `claimRoundAdvance` row claim this makes "start the next round" single-writer both
   * within a process and across instances.
   */
  private serialize<T>(tournamentId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(tournamentId) ?? Promise.resolve();
    const result = previous.then(work);
    const tail: Promise<void> = result.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      if (this.chains.get(tournamentId) === tail) this.chains.delete(tournamentId);
    });
    this.chains.set(tournamentId, tail);
    return result;
  }

  private hasRunnerFor(tournamentId: string): boolean {
    for (const runner of this.tables.values()) {
      if (runner.tournamentId === tournamentId) return true;
    }
    return false;
  }

  /* --------------------------- socket hooks --------------------------- */

  onCharacterOnline(characterId: string): void {
    const table = this.tablesByCharacter.get(characterId);
    if (!table) return;
    table.setConnected(characterId, true);
    void setSeatConnected(this.db, table.tableId, characterId, true).catch(() => undefined);
    table.resync(characterId);
  }

  onCharacterOffline(characterId: string): void {
    if (this.hub.isOnline(characterId)) return;
    const table = this.tablesByCharacter.get(characterId);
    if (!table) return;
    table.setConnected(characterId, false);
    void setSeatConnected(this.db, table.tableId, characterId, false).catch(() => undefined);
  }

  resync(characterId: string): void {
    this.tablesByCharacter.get(characterId)?.resync(characterId);
  }

  act(
    characterId: string,
    input: { handId: string; seq: number; action: Parameters<TableRunner['act']>[1]['action']; amount?: number },
  ): boolean {
    const table = this.tablesByCharacter.get(characterId);
    if (!table) return false;
    table.act(characterId, input);
    return true;
  }

  /* ----------------------------- scheduling ---------------------------- */

  private scheduleTick(): void {
    if (this.stopped) return;
    this.tickTimer = this.clock.after(this.config.tickMs, () => {
      void this.tick().finally(() => this.scheduleTick());
    });
  }

  /** Exposed for tests and boot: one full pass of the schedule state machine. */
  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      await this.ensureScheduled();
      await this.openRegistrations();
      await this.closeRegistrations();
      await this.sweepStalledTournaments();
    } catch (error) {
      this.log('tournament tick failed', { error });
    } finally {
      this.ticking = false;
    }
  }

  nextSlot(at: Date): { slotKey: string; scheduledFor: Date } {
    if (this.config.mode === 'interval') {
      const interval = this.config.intervalMs;
      const scheduledFor = new Date((Math.floor(at.getTime() / interval) + 1) * interval);
      return { slotKey: `interval:${scheduledFor.getTime()}`, scheduledFor };
    }
    const scheduledFor = nextSlotAfter(at);
    return { slotKey: `daily:${scheduledFor.toISOString()}`, scheduledFor };
  }

  private async ensureScheduled(): Promise<void> {
    const now = new Date(this.clock.now());
    const upcoming = await findTournamentsInState(this.db, ['scheduled', 'registration', 'running']);
    if (upcoming.length > 0) return;

    const { slotKey, scheduledFor } = this.nextSlot(now);
    const registrationOpensAt = new Date(
      Math.max(now.getTime(), scheduledFor.getTime() - this.config.registrationLeadMs),
    );
    const created = await insertScheduledTournament(this.db, {
      scope: 'global',
      slotKey,
      scheduledFor,
      registrationOpensAt,
    });
    if (created) this.log('tournament scheduled', { at: scheduledFor.toISOString() });
  }

  private async openRegistrations(): Promise<void> {
    const now = this.clock.now();
    for (const tournament of await findTournamentsInState(this.db, ['scheduled'])) {
      if (tournament.registration_opens_at.getTime() > now) continue;
      const updated = await updateTournamentState(this.db, tournament.id, { state: 'registration' });
      this.announce(updated);
    }
  }

  private async closeRegistrations(): Promise<void> {
    const now = this.clock.now();
    for (const tournament of await findTournamentsInState(this.db, ['registration'])) {
      if (tournament.scheduled_for.getTime() > now) continue;
      await this.closeRegistration(tournament);
    }
  }

  /**
   * A `running` tournament with no live table and no armed round break can never make
   * progress by itself, and `ensureScheduled` refuses to schedule anything while one
   * exists — so a wedged tournament would halt the scheduler for the whole server.
   * Re-driving the round it has already claimed unwedges it; `startRound` is idempotent,
   * so doing so when the tournament was in fact fine is a no-op.
   */
  private async sweepStalledTournaments(): Promise<void> {
    for (const tournament of await findTournamentsInState(this.db, ['running'])) {
      if (this.pendingRounds.has(tournament.id) || this.hasRunnerFor(tournament.id)) continue;

      await this.serialize(tournament.id, async () => {
        if (this.pendingRounds.has(tournament.id) || this.hasRunnerFor(tournament.id)) return;
        const fresh = await findTournamentById(this.db, tournament.id);
        if (!fresh || fresh.state !== 'running') return;

        const round = Math.max(fresh.current_round, 1);
        const tables = await listTables(this.db, fresh.id, round);
        if (tables.length > 0) return;

        const live = await listLiveEntries(this.db, fresh.id);
        this.log('tournament stalled; re-driving round', {
          tournamentId: fresh.id,
          round,
          remaining: live.length,
        });
        await this.startRoundLocked(fresh, round, live.map((entry) => entry.character_id));
      });
    }
  }

  private announce(tournament: TournamentRow): void {
    const message: ServerMessage = { type: 'tourney:announce', tournament: toTournamentSummary(tournament) };
    this.hub.sendToCharacters(this.hub.onlineCharacterIds(), message);
  }

  /* --------------------------- registration ---------------------------- */

  async closeRegistration(tournament: TournamentRow): Promise<void> {
    /**
     * The charge loop moves real money for every character in the population, so it runs
     * at most once per tournament, ever. A caller that loses this claim — a second tick, a
     * re-close after a crash — does nothing at all.
     */
    const claimed = await claimRegistrationClose(this.db, tournament.id);
    if (!claimed) {
      this.log('registration close already claimed', { tournamentId: tournament.id });
      return;
    }

    try {
      await this.runRegistrationClose(claimed);
    } catch (error) {
      this.log('registration close failed; refunding and abandoning', {
        tournamentId: tournament.id,
        error,
      });
      await this.cancelTournament(tournament.id, 'SERVER_RESTART');
    }
  }

  private async runRegistrationClose(tournament: TournamentRow): Promise<void> {
    const eligible = await listEligibleCharacterIds(this.db);
    this.log('closing registration', { tournamentId: tournament.id, eligible: eligible.length });

    /**
     * Every character is charged in its own transaction, but a strictly sequential loop
     * makes registration close scale as four round trips per character — tens of seconds
     * once the population is in the thousands, all of it delaying the tournament start.
     * A bounded worker pool keeps the per-character locking and atomicity exactly as-is
     * while staying well inside the connection pool.
     */
    const queue = [...eligible];
    /**
     * The first failure stops the whole pool, and every worker is awaited before it
     * propagates. The caller refunds and cancels on a failed close, so a charge that
     * lands after that refund is money the tournament no longer holds — the workers must
     * be provably finished, not merely losers of a `Promise.all` race.
     */
    const failures: unknown[] = [];
    const workers = Array.from({ length: CHARGE_CONCURRENCY }, async () => {
      for (;;) {
        if (failures.length > 0) return;
        const candidate = queue.shift();
        if (!candidate) return;
        try {
          await this.chargeCharacter(tournament.id, candidate.id, candidate.tournament_opt_in);
        } catch (error) {
          failures.push(error);
          return;
        }
      }
    });
    await Promise.all(workers);
    if (failures.length > 0) throw failures[0];

    const entries = await listEntries(this.db, tournament.id);
    const entrantIds = entries.map((entry) => entry.character_id);

    if (entrantIds.length < MIN_ENTRANTS) {
      await this.cancelTournament(tournament.id, 'NOT_ENOUGH_ENTRANTS');
      return;
    }

    const shardCount = shardCountFor(entrantIds.length);
    const shards = shardEntrants(shuffle(entrantIds), shardCount);

    /**
     * Paired explicitly rather than zipped by index: a shard whose sibling row is missing
     * would otherwise silently shift every later shard onto the wrong tournament, seating
     * characters whose escrow lives somewhere else.
     */
    const shardRuns: { tournament: TournamentRow; members: string[] }[] = [];

    for (let index = 1; index < shardCount; index += 1) {
      const members = shards[index] ?? [];
      /**
       * Created, re-parented and activated in one transaction. A sibling that exists at
       * all is therefore already `running` and holds its own escrow — a crash part-way
       * through sharding can only leave states boot recovery already rescues, never a
       * `scheduled` shard sitting on other people's coins.
       */
      const sibling = await withTransaction(this.db, async (client) => {
        const created = await insertScheduledTournament(client, {
          scope: 'global',
          slotKey: tournament.slot_key,
          scheduledFor: tournament.scheduled_for,
          registrationOpensAt: tournament.registration_opens_at,
          shardIndex: index,
          shardCount,
        });
        if (!created) {
          throw new Error(`shard ${index} already exists for slot ${tournament.slot_key}`);
        }
        await client.query(
          'UPDATE tournament_entries SET tournament_id = $1 WHERE tournament_id = $2 AND character_id = ANY($3)',
          [created.id, tournament.id, members],
        );
        return updateTournamentState(client, created.id, {
          state: 'running',
          entrantCount: members.length,
          totalRounds: roundsNeededFor(members.length),
          prizePotCoins: members.length * HOUSE_PRIZE_PER_ENTRANT,
          currentRound: 0,
        });
      });
      shardRuns.push({ tournament: sibling, members });
    }

    const ownMembers = shards[0] ?? [];
    await this.db.query('UPDATE tournaments SET shard_count = $2 WHERE id = $1', [tournament.id, shardCount]);
    const parent = await updateTournamentState(this.db, tournament.id, {
      state: 'running',
      entrantCount: ownMembers.length,
      totalRounds: roundsNeededFor(ownMembers.length),
      prizePotCoins: ownMembers.length * HOUSE_PRIZE_PER_ENTRANT,
      currentRound: 0,
    });
    shardRuns.unshift({ tournament: parent, members: ownMembers });

    for (const run of shardRuns) {
      await this.startRound(run.tournament, 1, run.members);
    }
  }

  /**
   * One character, one transaction: lazy stat catch-up, then either the 3-coin entry or
   * the 1-coin miss penalty down the same insufficient-funds path — HP conversion, or
   * rebirth if that conversion would exhaust HP.
   */
  private async chargeCharacter(tournamentId: string, characterId: string, optedIn: boolean): Promise<void> {
    const outcome = await withTransaction(this.db, async (client) => {
      const row = await lockCharacterById(client, characterId);
      if (!row) return null;
      /**
       * A character in a live duel has their wallet snapshotted and their life on the line
       * there. Charging entry here could rebirth them mid-duel, so they are skipped
       * entirely — the duel-side half of the same symmetric lock `seated_table_id` gets.
       */
      if (row.active_duel_id ?? row.active_raid_id) return null;

      const at = new Date(this.clock.now());
      /**
       * A pending challenge is not a duel lock, but it holds the challenger to the stake
       * their target was shown, exactly as the action routes do. Charging entry out of that
       * reservation would make the duel play for less than the target consented to — or,
       * with the wallet already at the stake, convert HP for coins that are spoken for. The
       * entry is refused instead; the challenge is the commitment they made first.
       *
       * What is not refused is the miss penalty that refusal earns them. It is the tax for
       * *not* taking part, holding an outbound challenge is not taking part, and opting in
       * to a tournament this character cannot pay to enter does not change that. Otherwise a
       * challenge issued before each registration close — always affordable, since the stake
       * is the smaller of the two wallets — is a standing exemption from the tax. It comes
       * out of whatever the reservation leaves, and out of HP for the rest: the same
       * insufficient-funds path an empty wallet takes, rebirth included.
       */
      const reserved = await reservedInviteStake(client, characterId, at);
      const canAffordEntry = row.lethal_coins - reserved >= chargeCoinsFor('entry');
      const charge = optedIn && (reserved === 0 || canAffordEntry) ? 'entry' : 'miss_penalty';

      // The charge ledger is the idempotency key: one row per character per tournament,
      // written in the same transaction as the coins it accounts for.
      if (!(await claimCharge(client, tournamentId, characterId, charge))) return null;

      const stats = simulatedStats(row, at.getTime());
      const spendableCoins = charge === 'entry' ? row.lethal_coins : Math.max(0, row.lethal_coins - reserved);
      const resolved = resolveEntryCharge({ stats, lethalCoins: spendableCoins }, charge);

      if (resolved.kind === 'rebirth') {
        const reborn = await rebirthCharacter(client, row, {
          statsBefore: roundStats(stats),
          cause: 'tournament_entry_hp_exhausted',
          tournamentId,
          at,
        });
        return { kind: 'reborn' as const, charge, optedIn, ...reborn };
      }

      const nextStats: CharacterStats = { ...stats, hp: resolved.hpAfter };
      const updated = await commitCharacterState(client, row.id, {
        stats: nextStats,
        // `resolved` only ever saw the spendable balance, so the reserved stake is put back.
        lethalCoins: resolved.coinsAfter + (row.lethal_coins - spendableCoins),
        actionCooldowns: row.action_cooldowns,
        simulatedAt: at,
      });

      if (charge === 'entry') {
        await insertEntry(client, {
          tournamentId,
          characterId,
          hpConverted: resolved.hpConverted,
          stack: resolved.stake,
        });
      }

      return {
        kind: charge === 'entry' ? ('entered' as const) : ('charged' as const),
        charge,
        character: updated,
        hpConverted: resolved.hpConverted,
        stake: resolved.stake,
      };
    });

    if (!outcome) return;

    if (outcome.kind === 'reborn') {
      this.hub.sendToCharacter(characterId, {
        type: 'character:rebirth',
        character: toCharacterDto(outcome.character, this.clock.now()),
        statsBefore: outcome.statsBefore,
        coinsBefore: outcome.coinsBefore,
        rebirthIndex: outcome.rebirthIndex,
        cause: 'tournament_entry_hp_exhausted',
      });
      // Keyed on the opt-in rather than on the charge: a character who opted in and was
      // miss-penalized instead still has a join in flight on their client to clear.
      if (outcome.optedIn) {
        this.hub.sendToCharacter(characterId, {
          type: 'tourney:entry_failed',
          tournamentId,
          code: 'REBORN',
        });
      }
      return;
    }

    this.hub.sendToCharacter(characterId, {
      type: 'character:update',
      character: toCharacterDto(outcome.character, this.clock.now()),
    });
    if (outcome.kind === 'entered') {
      this.hub.sendToCharacter(characterId, {
        type: 'tourney:entered',
        tournamentId,
        hpConverted: outcome.hpConverted,
        stack: outcome.stake,
      });
    }
  }

  /* ------------------------------- rounds ------------------------------ */

  /** Entry point for a round, from registration close, from round advance, and from tests. */
  async startRound(tournament: TournamentRow, round: number, entrantIds: string[]): Promise<void> {
    await this.serialize(tournament.id, () => this.startRoundLocked(tournament, round, entrantIds));
  }

  private async startRoundLocked(
    tournament: TournamentRow,
    round: number,
    entrantIds: string[],
  ): Promise<void> {
    if (this.stopped) return;

    // Idempotent by construction: a round whose tables already exist has already started.
    if ((await listTables(this.db, tournament.id, round)).length > 0) {
      this.log('round already started', { tournamentId: tournament.id, round });
      return;
    }

    if (entrantIds.length === 1) {
      await this.finishTournament(tournament.id, entrantIds[0]!);
      return;
    }
    if (entrantIds.length === 0) {
      await this.cancelTournament(tournament.id, 'NOT_ENOUGH_ENTRANTS');
      return;
    }

    const plan = planRound(shuffle(entrantIds));
    const totalRounds = Math.max(tournament.total_rounds, round);
    await updateTournamentState(this.db, tournament.id, { currentRound: round, totalRounds });

    const entries = new Map(
      (await listEntries(this.db, tournament.id)).map((entry) => [entry.character_id, entry]),
    );
    const badges = new Map(
      (await listCharacterBadges(this.db, entrantIds)).map((badge) => [badge.id, badge]),
    );

    this.hub.sendToCharacters(entrantIds, {
      type: 'tourney:round_start',
      tournamentId: tournament.id,
      round,
      totalRounds,
      remaining: entrantIds.length,
    });

    const byes = [...plan.byes];
    const withdrawn: string[] = [];
    let tablesStarted = 0;

    const buildSeat = (characterId: string, seatIndex: number): RunnerSeat => {
      const badge = badges.get(characterId);
      const entry = entries.get(characterId);
      // Seating without an entry would put a character at a table with no escrow behind
      // it — a shard mis-assignment, not a playable seat.
      if (!entry) {
        throw new Error(`character ${characterId} has no entry on tournament ${tournament.id}`);
      }
      return {
        seatIndex,
        characterId,
        nickname: badge?.nickname ?? 'Unknown',
        speciesId: badge?.species_id ?? 'otter',
        stack: entry.current_stack,
        handsWon: 0,
        connected: this.hub.isOnline(characterId),
      } satisfies RunnerSeat;
    };

    for (const seatIds of plan.tables) {
      /**
       * The duel half of the engagement lock, re-checked under the same row lock that
       * writes the seat. Registration close excludes duelists, but seating happens after
       * the whole population has been charged and sharded — a window wide enough for a
       * duel invite to be accepted in. Without this a character could be seated here while
       * already committed to a duel that can kill and rebirth them.
       */
      const claim = await withTransaction(this.db, async (client) => {
        const kept = new Set<string>();
        const refused: string[] = [];
        // Locked in id order, the same order duel settlement uses, so the two can never
        // deadlock on a shared character.
        for (const characterId of [...seatIds].sort()) {
          const row = await lockCharacterById(client, characterId);
          if (!row || (row.active_duel_id ?? row.active_raid_id)) refused.push(characterId);
          else kept.add(characterId);
        }

        const playable = seatIds.filter((characterId) => kept.has(characterId));
        // One player left is not a table; they take a bye into the next round instead.
        if (playable.length < 2) return { table: null, seats: [], playable, refused };

        const seats = playable.map(buildSeat);
        const created = await insertTable(client, {
          tournamentId: tournament.id,
          round,
          seats: seats.map((seat) => ({ characterId: seat.characterId, stack: seat.stack })),
        });
        for (const seat of seats) await setSeatedTable(client, seat.characterId, created.id);
        return { table: created, seats, playable, refused };
      });

      withdrawn.push(...claim.refused);
      if (claim.refused.length > 0) {
        this.log('seating refused: character claimed by a duel', {
          tournamentId: tournament.id,
          round,
          characterIds: claim.refused,
        });
      }

      if (!claim.table) {
        byes.push(...claim.playable);
        continue;
      }

      await updateTable(this.db, claim.table.id, { state: 'playing' });

      const runner = new TableRunner({
        tableId: claim.table.id,
        tournamentId: tournament.id,
        round,
        totalRounds,
        seats: claim.seats,
        db: this.db,
        hub: this.hub,
        clock: this.clock,
        turnMs: this.config.turnMs,
        showdownMs: this.config.showdownMs,
        handsPerTable: this.config.handsPerTable,
        log: this.log,
        onComplete: (completion) => {
          void this.onTableComplete(completion);
        },
      });

      this.tables.set(claim.table.id, runner);
      for (const seat of claim.seats) this.tablesByCharacter.set(seat.characterId, runner);
      runner.start();
      tablesStarted += 1;
    }

    for (const characterId of withdrawn) await this.withdrawEntrant(tournament.id, characterId, round);

    for (const characterId of byes) {
      this.hub.sendToCharacter(characterId, { type: 'tourney:bye', tournamentId: tournament.id, round });
    }

    if (tablesStarted === 0) {
      // Everyone got a bye (a one-entrant round, or a round nobody could be seated for), so
      // the round is already over.
      await this.advanceRoundLocked(tournament.id, round);
    }
  }

  /**
   * A character who became ineligible between the entry charge and the seat leaves the
   * tournament the same way a table exit does: escrow back to the wallet, entry closed out
   * for this round. Their coins and their life are committed to the other subsystem.
   */
  private async withdrawEntrant(tournamentId: string, characterId: string, round: number): Promise<void> {
    const outcome = await withTransaction(this.db, async (client) => {
      const result = await client.query<{ current_stack: number }>(
        `SELECT current_stack FROM tournament_entries
         WHERE tournament_id = $1 AND character_id = $2 AND eliminated_in_round IS NULL
         FOR UPDATE`,
        [tournamentId, characterId],
      );
      const stack = result.rows[0]?.current_stack;
      if (stack === undefined) return null;
      await updateEntry(client, tournamentId, characterId, {
        eliminatedInRound: round,
        currentStack: 0,
      });
      return { character: await creditCoins(client, characterId, stack), coinsReturned: stack };
    });
    if (!outcome) return;

    this.hub.sendToCharacter(characterId, {
      type: 'tourney:eliminated',
      tournamentId,
      round,
      coinsReturned: outcome.coinsReturned,
    });
    this.hub.sendToCharacter(characterId, {
      type: 'character:update',
      character: toCharacterDto(outcome.character, this.clock.now()),
    });
  }

  private async onTableComplete(completion: TableCompletion): Promise<void> {
    this.tables.delete(completion.tableId);
    for (const seat of completion.seats) this.tablesByCharacter.delete(seat.characterId);

    const eliminated: { characterId: string; coinsReturned: number; character: CharacterRow }[] = [];

    await withTransaction(this.db, async (client) => {
      for (const seat of completion.seats) {
        await updateEntry(client, completion.tournamentId, seat.characterId, { currentStack: seat.stack });
        await setSeatedTable(client, seat.characterId, null);

        if (seat.characterId === completion.qualifierCharacterId) continue;

        // A table exit settles immediately: whatever survives of the escrowed stack
        // goes straight back to the wallet.
        await updateEntry(client, completion.tournamentId, seat.characterId, {
          eliminatedInRound: completion.round,
          currentStack: 0,
        });
        const character = await creditCoins(client, seat.characterId, seat.stack);
        eliminated.push({ characterId: seat.characterId, coinsReturned: seat.stack, character });
      }
    });

    await updateTable(this.db, completion.tableId, {
      state: 'complete',
      qualifierCharacterId: completion.qualifierCharacterId,
      // Despite the column name this is the best single player's hands *won*, not a count of
      // hands dealt. It is only ever read as "did this table play at all" — every hand has
      // exactly one winner, so the maximum is >= 1 if and only if a hand was dealt.
      handsPlayed: completion.standings.reduce((max, standing) => Math.max(max, standing.handsWon), 0),
    });

    for (const entry of eliminated) {
      this.hub.sendToCharacter(entry.characterId, {
        type: 'tourney:eliminated',
        tournamentId: completion.tournamentId,
        round: completion.round,
        coinsReturned: entry.coinsReturned,
      });
      this.hub.sendToCharacter(entry.characterId, {
        type: 'character:update',
        character: toCharacterDto(entry.character, this.clock.now()),
      });
    }

    await this.advanceRound(completion.tournamentId, completion.round);
  }

  private async advanceRound(tournamentId: string, round: number): Promise<void> {
    await this.serialize(tournamentId, () => this.advanceRoundLocked(tournamentId, round));
  }

  private async advanceRoundLocked(tournamentId: string, round: number): Promise<void> {
    const tables = await listTables(this.db, tournamentId, round);
    if (tables.some((table) => table.state !== 'complete')) return;

    /**
     * Both tables of a round can reach here at the same moment with every table already
     * marked complete. The row claim decides which one owns the advance; the loser stops
     * here rather than starting a second copy of the next round.
     */
    const tournament = await claimRoundAdvance(this.db, tournamentId, round);
    if (!tournament) return;

    const live = await listLiveEntries(this.db, tournamentId);
    if (live.length <= 1) {
      // The claim moved the round counter forward; nothing further will be played, so put
      // it back on the round that was actually the last one.
      await updateTournamentState(this.db, tournamentId, { currentRound: round });
      const winner = live[0];
      if (winner) await this.finishTournament(tournamentId, winner.character_id);
      else await this.cancelTournament(tournamentId, 'NOT_ENOUGH_ENTRANTS');
      return;
    }

    const ids = live.map((entry) => entry.character_id);
    this.pendingRounds.add(tournamentId);
    this.clock.after(this.config.roundBreakMs, () => {
      void this.serialize(tournamentId, async () => {
        this.pendingRounds.delete(tournamentId);
        await this.startRoundLocked(tournament, round + 1, ids);
      }).catch((error: unknown) => this.log('failed to start round', { tournamentId, error }));
    });
  }

  private async finishTournament(tournamentId: string, winnerCharacterId: string): Promise<void> {
    const summary = await withTransaction(this.db, async (client) => {
      const tournamentResult = await client.query<TournamentRow>(
        'SELECT * FROM tournaments WHERE id = $1 FOR UPDATE',
        [tournamentId],
      );
      const tournament = tournamentResult.rows[0];
      if (!tournament || tournament.state !== 'running') return null;

      const entryResult = await client.query<{ current_stack: number }>(
        'SELECT current_stack FROM tournament_entries WHERE tournament_id = $1 AND character_id = $2',
        [tournamentId, winnerCharacterId],
      );
      const stackCoins = entryResult.rows[0]?.current_stack ?? 0;
      /**
       * A bracket that collapsed before a single hand was dealt — every table short of two
       * playable seats, which a group can arrange by duel-locking each other at seating —
       * still has to end, and the survivor still gets their own escrow back. What they do
       * not get is the house prize pot: it is paid for winning a tournament, and nothing
       * was played. Any tournament where one hand was dealt anywhere pays as before.
       */
      const prizeCoins =
        (await tournamentHandsPlayed(client, tournamentId)) > 0 ? tournament.prize_pot_coins : 0;

      const character = await creditCoins(client, winnerCharacterId, stackCoins + prizeCoins);
      await recordTournamentWin(client, winnerCharacterId);
      if (character.account_id) await grantCosmetic(client, character.account_id, CHAMPION_COSMETIC_ID);

      await updateEntry(client, tournamentId, winnerCharacterId, { currentStack: 0, finalRank: 1 });
      await setSeatedTable(client, winnerCharacterId, null);
      await updateTournamentState(client, tournamentId, {
        state: 'complete',
        winnerCharacterId,
      });

      return { character, stackCoins, prizeCoins };
    });

    if (!summary) return;

    const entries = await listEntries(this.db, tournamentId);
    this.hub.sendToCharacters(
      entries.map((entry) => entry.character_id),
      {
        type: 'tourney:winner',
        tournamentId,
        characterId: winnerCharacterId,
        nickname: summary.character.nickname,
        prizeCoins: summary.prizeCoins,
        stackCoins: summary.stackCoins,
      },
    );
    this.hub.sendToCharacter(winnerCharacterId, {
      type: 'character:update',
      character: toCharacterDto(summary.character, this.clock.now()),
    });
    this.log('tournament complete', { tournamentId, winnerCharacterId });
  }

  private async cancelTournament(
    tournamentId: string,
    reason: 'NOT_ENOUGH_ENTRANTS' | 'SERVER_RESTART',
  ): Promise<void> {
    const refunded = await withTransaction(this.db, async (client) => {
      const entries = await client.query<{ character_id: string; current_stack: number }>(
        `SELECT character_id, current_stack FROM tournament_entries
         WHERE tournament_id = $1 AND eliminated_in_round IS NULL FOR UPDATE`,
        [tournamentId],
      );
      const characters: CharacterRow[] = [];
      for (const entry of entries.rows) {
        // Cancelling never keeps a player's escrow: the stake goes back whole.
        if (entry.current_stack > 0) characters.push(await creditCoins(client, entry.character_id, entry.current_stack));
        await setSeatedTable(client, entry.character_id, null);
        await updateEntry(client, tournamentId, entry.character_id, { currentStack: 0 });
      }
      await updateTournamentState(client, tournamentId, { state: 'cancelled' });
      return { characters, characterIds: entries.rows.map((entry) => entry.character_id) };
    });

    this.hub.sendToCharacters(refunded.characterIds, { type: 'tourney:cancelled', tournamentId, reason });
    for (const character of refunded.characters) {
      this.hub.sendToCharacter(character.id, {
        type: 'character:update',
        character: toCharacterDto(character, this.clock.now()),
      });
    }
    this.log('tournament cancelled', { tournamentId, reason });
  }

  /**
   * In-flight table state lives in memory, so a restart cannot resume a half-played
   * hand. Rather than inventing a partial replay, a restart returns every escrowed coin
   * and cancels the tournament — the players are made whole and the next slot runs clean.
   */
  private async recoverOnBoot(): Promise<void> {
    for (const tournament of await findTournamentsInState(this.db, ['running'])) {
      await this.cancelTournament(tournament.id, 'SERVER_RESTART');
    }
    /**
     * A crash inside the charge loop leaves a tournament with its close claimed but never
     * started. The claim means it will never be charged again; refunding whatever escrow
     * did land and abandoning it is what makes the entrants whole.
     */
    for (const tournament of await listAbandonedCloses(this.db)) {
      await this.cancelTournament(tournament.id, 'SERVER_RESTART');
    }
    await this.db.query('UPDATE characters SET seated_table_id = NULL WHERE seated_table_id IS NOT NULL');
  }

  /* ------------------------------ queries ------------------------------ */

  async currentTournament(): Promise<TournamentRow | null> {
    return findActiveTournament(this.db);
  }

  async tableSnapshot(tableId: string): Promise<{ seats: Awaited<ReturnType<typeof listSeats>> }> {
    return { seats: await listSeats(this.db, tableId) };
  }
}

/** Fisher-Yates over `crypto.randomInt`. `Math.random` is banned across this feature. */
function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = randomInt(index + 1);
    const held = copy[index]!;
    copy[index] = copy[swap]!;
    copy[swap] = held;
  }
  return copy;
}
