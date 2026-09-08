import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { HOUSE_PRIZE_PER_ENTRANT, STARTING_STATS, type CharacterDto } from '@lethalmagotchi/shared';
import { DEFAULT_TOURNAMENT_CONFIG } from '../../src/config.js';
import type { Db } from '../../src/db/pool.js';
import {
  claimRoundAdvance,
  insertScheduledTournament,
  listEntries,
  updateTournamentState,
} from '../../src/repos/tournaments.js';
import { TournamentService } from '../../src/tournament/service.js';
import { Hub } from '../../src/ws/hub.js';
import {
  authed,
  closeTestPool,
  createTestApp,
  registerAccount,
  testPool,
  uniqueUsername,
  VALID_CHARACTER,
} from '../helpers/app.js';
import { ManualClock, settle } from '../helpers/clock.js';

const FAST = {
  ...DEFAULT_TOURNAMENT_CONFIG,
  enabled: true,
  mode: 'interval' as const,
  turnMs: 1_000,
  showdownMs: 10,
  roundBreakMs: 10,
  tickMs: 50,
};

let db: Db;

beforeAll(() => {
  db = testPool();
});

afterAll(async () => {
  await closeTestPool();
});

async function boot(clock: ManualClock) {
  const hub = new Hub();
  const tournaments = new TournamentService({ db, hub, config: FAST, clock });
  const { app } = await createTestApp({ config: { tournament: FAST }, hub, tournaments });
  return {
    app,
    hub,
    tournaments,
    async close() {
      await tournaments.stop();
      hub.closeAll();
      await app.close();
    },
  };
}

async function makePlayer(app: FastifyInstance, nickname: string): Promise<CharacterDto> {
  const account = await registerAccount(app, { username: uniqueUsername('sched') });
  const response = await app.inject(
    authed(account, { method: 'POST', url: '/api/v1/characters', payload: { ...VALID_CHARACTER, nickname } }),
  );
  if (response.statusCode !== 201) throw new Error(`character create failed: ${response.body}`);
  return response.json().character;
}

async function resetOptIns(): Promise<void> {
  await db.query('UPDATE characters SET tournament_opt_in = false, seated_table_id = NULL');
  await db.query('UPDATE characters SET lethal_coins = 50 WHERE lethal_coins < 5');
}

async function enrol(characterId: string, coins: number, optIn: boolean): Promise<void> {
  await db.query(
    `UPDATE characters SET lethal_coins = $2, tournament_opt_in = $3, stats = $4, last_simulated_at = now()
     WHERE id = $1`,
    [characterId, coins, optIn, JSON.stringify({ ...STARTING_STATS, hp: 100 })],
  );
}

async function walletOf(characterId: string): Promise<number> {
  const result = await db.query<{ lethal_coins: number }>(
    'SELECT lethal_coins FROM characters WHERE id = $1',
    [characterId],
  );
  return result.rows[0]!.lethal_coins;
}

async function walletSum(characterIds: string[]): Promise<number> {
  const result = await db.query<{ total: number }>(
    'SELECT COALESCE(sum(lethal_coins), 0)::int AS total FROM characters WHERE id = ANY($1)',
    [characterIds],
  );
  return result.rows[0]!.total;
}

async function escrowSum(tournamentId: string): Promise<number> {
  const result = await db.query<{ total: number }>(
    'SELECT COALESCE(sum(current_stack), 0)::int AS total FROM tournament_entries WHERE tournament_id = $1',
    [tournamentId],
  );
  return result.rows[0]!.total;
}

async function chargeCount(tournamentId: string): Promise<number> {
  const result = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM tournament_charges WHERE tournament_id = $1',
    [tournamentId],
  );
  return result.rows[0]!.n;
}

async function tablesPerRound(tournamentId: string): Promise<Record<number, number>> {
  const result = await db.query<{ round: number; count: string }>(
    'SELECT round, count(*)::text AS count FROM tournament_tables WHERE tournament_id = $1 GROUP BY round',
    [tournamentId],
  );
  return Object.fromEntries(result.rows.map((row) => [row.round, Number(row.count)]));
}

async function stateOf(tournamentId: string): Promise<string> {
  const result = await db.query<{ state: string }>('SELECT state FROM tournaments WHERE id = $1', [
    tournamentId,
  ]);
  return result.rows[0]!.state;
}

async function makeTournament(scheduledFor = new Date(Date.now() + 60_000)) {
  const row = await insertScheduledTournament(db, {
    scope: 'global',
    slotKey: `sched:${crypto.randomUUID()}`,
    scheduledFor,
    registrationOpensAt: new Date(scheduledFor.getTime() - 60_000),
  });
  return row!;
}

describe('concurrent round advance', () => {
  /**
   * Ten entrants make two round-one tables. Nobody is connected, so every seat resolves on
   * its turn deadline — and because both tables arm their deadlines against the same
   * manual clock, both finish in the same batch and both reach the round advance at once.
   * That is the exact shape that used to schedule round two twice and mint coins.
   */
  it('starts the next round exactly once when two tables finish together', async () => {
    const clock = new ManualClock();
    const server = await boot(clock);
    await resetOptIns();
    try {
      const characters: CharacterDto[] = [];
      for (let index = 0; index < 10; index += 1) {
        const character = await makePlayer(server.app, `Sync${index}`);
        await enrol(character.id, 9, true);
        characters.push(character);
      }
      const walletBefore = 10 * 9;

      const tournament = await makeTournament();
      await server.tournaments.closeRegistration({ ...tournament, state: 'registration' });

      expect(await tablesPerRound(tournament.id)).toEqual({ 1: 2 });

      for (let step = 0; step < 200 && (await stateOf(tournament.id)) === 'running'; step += 1) {
        await clock.advance(FAST.turnMs);
      }

      expect(await stateOf(tournament.id)).toBe('complete');

      const rounds = await tablesPerRound(tournament.id);
      expect(rounds[1]).toBe(2);
      // The regression: one table per round after the first, never two.
      for (const [round, count] of Object.entries(rounds)) {
        if (Number(round) === 1) continue;
        expect(count).toBe(1);
      }

      const duplicateSeats = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM (
           SELECT s.character_id, t.round FROM table_seats s
           JOIN tournament_tables t ON t.id = s.table_id
           WHERE t.tournament_id = $1
           GROUP BY s.character_id, t.round HAVING count(*) > 1
         ) duplicates`,
        [tournament.id],
      );
      expect(Number(duplicateSeats.rows[0]!.n)).toBe(0);

      let walletAfter = 0;
      for (const character of characters) walletAfter += await walletOf(character.id);
      // Every escrowed coin returns, plus exactly the house prize — no coin drift.
      expect(walletAfter).toBe(walletBefore + 10 * HOUSE_PRIZE_PER_ENTRANT);
    } finally {
      await server.close();
    }
  }, 120_000);

  /**
   * The same collision one level up: two callers reaching round start for the same round
   * at the same moment. Before the per-tournament chain and the "tables already exist"
   * guard, this produced two parallel copies of the round — the seats duplicated, and the
   * coins behind them counted twice.
   */
  it('creates one set of tables when the same round is started twice at once', async () => {
    const clock = new ManualClock();
    const server = await boot(clock);
    await resetOptIns();
    try {
      const players: CharacterDto[] = [];
      for (let index = 0; index < 4; index += 1) {
        const character = await makePlayer(server.app, `Twice${index}`);
        await enrol(character.id, 9, false);
        players.push(character);
      }

      const tournament = await makeTournament();
      const running = await updateTournamentState(db, tournament.id, {
        state: 'running',
        currentRound: 0,
        totalRounds: 1,
        entrantCount: players.length,
      });
      for (const player of players) {
        await db.query(
          `INSERT INTO tournament_entries (tournament_id, character_id, current_stack) VALUES ($1, $2, 3)`,
          [tournament.id, player.id],
        );
      }

      const ids = players.map((player) => player.id);
      await Promise.all([
        server.tournaments.startRound(running, 1, ids),
        server.tournaments.startRound(running, 1, ids),
      ]);
      await settle();

      expect(await tablesPerRound(tournament.id)).toEqual({ 1: 1 });

      const seatCount = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM table_seats s
         JOIN tournament_tables t ON t.id = s.table_id
         WHERE t.tournament_id = $1`,
        [tournament.id],
      );
      expect(Number(seatCount.rows[0]!.n)).toBe(players.length);
    } finally {
      await server.close();
    }
  }, 60_000);

  it('hands the advance to exactly one of two simultaneous claimants', async () => {
    const tournament = await makeTournament();
    await updateTournamentState(db, tournament.id, { state: 'running', currentRound: 1 });

    const claims = await Promise.all([
      claimRoundAdvance(db, tournament.id, 1),
      claimRoundAdvance(db, tournament.id, 1),
      claimRoundAdvance(db, tournament.id, 1),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)!.current_round).toBe(2);
  });
});

describe('registration close is charged once, ever', () => {
  /**
   * The restart-mid-charge scenario: the process dies before the tournament reaches
   * `running`, so the row is still in `registration` and every character has been
   * un-seated. Re-closing used to charge the whole population a second time — destroying
   * coins for entrants and reborning pets whose HP survived the first penalty.
   */
  it('charges nobody a second time when a re-close is attempted after a crash', async () => {
    const clock = new ManualClock();
    const server = await boot(clock);
    await resetOptIns();
    try {
      const entrant = await makePlayer(server.app, 'CrashEntrant');
      const partner = await makePlayer(server.app, 'CrashPartner');
      const skipper = await makePlayer(server.app, 'CrashSkipper');
      const frail = await makePlayer(server.app, 'CrashFrail');
      await enrol(entrant.id, 9, true);
      await enrol(partner.id, 9, true);
      await enrol(skipper.id, 9, false);
      await enrol(frail.id, 0, false);
      await db.query('UPDATE characters SET stats = $2 WHERE id = $1', [
        frail.id,
        JSON.stringify({ ...STARTING_STATS, hp: 15 }),
      ]);

      const tournament = await makeTournament();
      await updateTournamentState(db, tournament.id, { state: 'registration' });
      await server.tournaments.closeRegistration({ ...tournament, state: 'registration' });

      const afterFirst = {
        entrant: await walletOf(entrant.id),
        skipper: await walletOf(skipper.id),
        frail: await frailState(frail.id),
      };

      // The crash: the row never reached `running`, and boot recovery blanket-clears seats.
      await updateTournamentState(db, tournament.id, { state: 'registration' });
      await db.query('UPDATE characters SET seated_table_id = NULL WHERE seated_table_id IS NOT NULL');

      await server.tournaments.closeRegistration({ ...tournament, state: 'registration' });

      expect(await walletOf(entrant.id)).toBe(afterFirst.entrant);
      expect(await walletOf(skipper.id)).toBe(afterFirst.skipper);
      const frailAfter = await frailState(frail.id);
      expect(frailAfter.rebirths).toBe(afterFirst.frail.rebirths);
      expect(frailAfter.hp).toBeCloseTo(afterFirst.frail.hp, 3);

      const entries = await listEntries(db, tournament.id);
      const mine = entries.find((entry) => entry.character_id === entrant.id);
      // Escrow still matches the single charge that was actually taken.
      expect(mine?.current_stack).toBe(9 - afterFirst.entrant);
    } finally {
      await server.close();
    }
  }, 60_000);

  it('charges once when two closes run at the same moment', async () => {
    const clock = new ManualClock();
    const server = await boot(clock);
    await resetOptIns();
    try {
      const entrant = await makePlayer(server.app, 'RaceEntrant');
      const partner = await makePlayer(server.app, 'RacePartner');
      const skipper = await makePlayer(server.app, 'RaceSkipper');
      await enrol(entrant.id, 9, true);
      await enrol(partner.id, 9, true);
      await enrol(skipper.id, 9, false);

      const tournament = await makeTournament();
      await updateTournamentState(db, tournament.id, { state: 'registration' });
      const row = { ...tournament, state: 'registration' as const };

      await Promise.all([
        server.tournaments.closeRegistration(row),
        server.tournaments.closeRegistration(row),
      ]);
      await settle();

      expect(await walletOf(entrant.id)).toBe(6);
      expect(await walletOf(skipper.id)).toBe(8);
      expect(await tablesPerRound(tournament.id)).toEqual({ 1: 1 });
    } finally {
      await server.close();
    }
  }, 60_000);

  it('refunds and abandons a close that was claimed but never started', async () => {
    const clock = new ManualClock();
    const server = await boot(clock);
    await resetOptIns();
    try {
      const entrant = await makePlayer(server.app, 'HalfClosed');
      const partner = await makePlayer(server.app, 'HalfClosedToo');
      await enrol(entrant.id, 9, true);
      await enrol(partner.id, 9, true);

      const tournament = await makeTournament();
      await updateTournamentState(db, tournament.id, { state: 'registration' });
      await db.query('UPDATE tournaments SET registration_closed_at = now() WHERE id = $1', [
        tournament.id,
      ]);
      await db.query(
        `INSERT INTO tournament_entries (tournament_id, character_id, current_stack) VALUES ($1, $2, 3)`,
        [tournament.id, entrant.id],
      );
      await db.query('UPDATE characters SET lethal_coins = 6 WHERE id = $1', [entrant.id]);

      await server.tournaments.start();

      expect(await stateOf(tournament.id)).toBe('cancelled');
      expect(await walletOf(entrant.id)).toBe(9);
    } finally {
      await server.close();
    }
  }, 60_000);
});

describe('a failed charge loop leaves no money behind', () => {
  /**
   * One charge fails part-way through the pool (here: a pre-existing entry row makes
   * `insertEntry` violate its primary key, the shape a transient database error takes).
   * The close then refunds and cancels — so every worker must be finished before that
   * refund runs. A charge landing after the sweep is escrow the tournament no longer
   * holds, and the coins behind it are gone for good.
   */
  it('stops every worker before cancelling, conserving coins', async () => {
    const clock = new ManualClock();
    const server = await boot(clock);
    await resetOptIns();
    try {
      const players: CharacterDto[] = [];
      for (let index = 0; index < 36; index += 1) {
        const character = await makePlayer(server.app, `Halt${index}`);
        await enrol(character.id, 12, true);
        players.push(character);
      }
      const ids = players.map((player) => player.id);
      const walletsBefore = await walletSum(ids);

      const tournament = await makeTournament();
      await updateTournamentState(db, tournament.id, { state: 'registration' });

      // Characters are charged in id order and uuidv7 is time-ordered, so the poisoned
      // row is the first of this batch the loop reaches.
      await db.query(
        `INSERT INTO tournament_entries (tournament_id, character_id, current_stack) VALUES ($1, $2, 0)`,
        [tournament.id, ids[0]],
      );

      await server.tournaments.closeRegistration({ ...tournament, state: 'registration' });

      const chargesAtReturn = await chargeCount(tournament.id);
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(await stateOf(tournament.id)).toBe('cancelled');
      // Nothing was still charging when the close returned.
      expect(await chargeCount(tournament.id)).toBe(chargesAtReturn);

      const lateCharges = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM tournament_charges c
         JOIN tournaments t ON t.id = c.tournament_id
         WHERE c.tournament_id = $1 AND c.at > t.updated_at`,
        [tournament.id],
      );
      expect(Number(lateCharges.rows[0]!.n)).toBe(0);

      // Escrow is fully swept, and every coin taken came back to the wallet it left.
      expect(await escrowSum(tournament.id)).toBe(0);
      expect(await walletSum(ids)).toBe(walletsBefore);

      /**
       * The pool stopped dispatching rather than draining the rest of the queue. The exact
       * cut-off is not fixed — workers already inside a charge when the failure lands
       * finish it — so the assertion is that the tail of the queue was never reached at
       * all, which the old drain-everything loop always did.
       */
      const tail = ids.slice(ids.length / 2);
      const chargedTail = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM tournament_charges WHERE tournament_id = $1 AND character_id = ANY($2)',
        [tournament.id, tail],
      );
      expect(Number(chargedTail.rows[0]!.n)).toBe(0);
    } finally {
      await server.close();
    }
  }, 120_000);
});

describe('shard siblings are never left half-created', () => {
  /**
   * The interrupted-sharding state: a sibling created with entries re-parented onto it and
   * real escrow attached, but never flipped to `running`. Boot recovery used to walk past
   * it — it is neither `running` nor a claimed close — leaving live coins on a tournament
   * that would never be played, and blocking every later slot.
   */
  it('recovers a sibling stranded in `scheduled` with escrow', async () => {
    const clock = new ManualClock();
    const server = await boot(clock);
    await resetOptIns();
    try {
      const players: CharacterDto[] = [];
      for (let index = 0; index < 3; index += 1) {
        const character = await makePlayer(server.app, `Orphan${index}`);
        await enrol(character.id, 9, true);
        players.push(character);
      }
      const ids = players.map((player) => player.id);

      const slotKey = `shardcrash:${crypto.randomUUID()}`;
      const scheduledFor = new Date(Date.now() - 60_000);
      const parent = (await insertScheduledTournament(db, {
        scope: 'global',
        slotKey,
        scheduledFor,
        registrationOpensAt: scheduledFor,
        shardIndex: 0,
        shardCount: 2,
      }))!;
      await db.query(`UPDATE tournaments SET state = 'complete', registration_closed_at = now() WHERE id = $1`, [
        parent.id,
      ]);
      const sibling = (await insertScheduledTournament(db, {
        scope: 'global',
        slotKey,
        scheduledFor,
        registrationOpensAt: scheduledFor,
        shardIndex: 1,
        shardCount: 2,
      }))!;
      for (const id of ids) {
        await db.query(
          `INSERT INTO tournament_entries (tournament_id, character_id, current_stack) VALUES ($1, $2, 3)`,
          [sibling.id, id],
        );
        await db.query('UPDATE characters SET lethal_coins = lethal_coins - 3 WHERE id = $1', [id]);
      }
      const walletsBefore = await walletSum(ids);

      await server.tournaments.start();

      expect(await stateOf(sibling.id)).not.toBe('scheduled');
      expect(await escrowSum(sibling.id)).toBe(0);
      expect(await walletSum(ids)).toBe(walletsBefore + 3 * ids.length);

      const stranded = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM tournaments t
         WHERE t.state = 'scheduled'
           AND EXISTS (SELECT 1 FROM tournament_entries e WHERE e.tournament_id = t.id AND e.current_stack > 0)`,
      );
      expect(Number(stranded.rows[0]!.n)).toBe(0);
    } finally {
      await server.close();
    }
  }, 60_000);

});

describe('stalled tournament watchdog', () => {
  /**
   * A `running` tournament with nothing in flight used to halt scheduling for the whole
   * server, because `ensureScheduled` refuses to schedule while any tournament is live.
   */
  it('re-drives a running tournament that has no tables and no timers', async () => {
    const clock = new ManualClock();
    const server = await boot(clock);
    await resetOptIns();
    try {
      const players: CharacterDto[] = [];
      for (let index = 0; index < 3; index += 1) {
        const character = await makePlayer(server.app, `Wedged${index}`);
        await enrol(character.id, 9, false);
        players.push(character);
      }

      const tournament = await makeTournament();
      await updateTournamentState(db, tournament.id, {
        state: 'running',
        currentRound: 2,
        totalRounds: 2,
        entrantCount: 3,
      });
      for (const player of players) {
        await db.query(
          `INSERT INTO tournament_entries (tournament_id, character_id, current_stack) VALUES ($1, $2, 3)`,
          [tournament.id, player.id],
        );
      }

      expect(await tablesPerRound(tournament.id)).toEqual({});

      await server.tournaments.tick();
      await settle();

      expect(await tablesPerRound(tournament.id)).toEqual({ 2: 1 });
    } finally {
      await server.close();
    }
  }, 60_000);
});

async function frailState(characterId: string): Promise<{ hp: number; rebirths: number }> {
  const result = await db.query<{ stats: { hp: number }; rebirth_count: number }>(
    'SELECT stats, rebirth_count FROM characters WHERE id = $1',
    [characterId],
  );
  return { hp: result.rows[0]!.stats.hp, rebirths: result.rows[0]!.rebirth_count };
}
