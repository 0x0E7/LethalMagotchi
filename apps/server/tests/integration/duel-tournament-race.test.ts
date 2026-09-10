import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { STARTING_LETHAL_COINS, STARTING_STATS, type DuelThrow } from '@lethalmagotchi/shared';
import { ChatService } from '../../src/chat/service.js';
import { DEFAULT_TOURNAMENT_CONFIG } from '../../src/config.js';
import type { Db } from '../../src/db/pool.js';
import { DuelService } from '../../src/duel/service.js';
import { insertScheduledTournament, updateTournamentState } from '../../src/repos/tournaments.js';
import { TournamentService } from '../../src/tournament/service.js';
import { Hub } from '../../src/ws/hub.js';
import {
  authed,
  closeTestPool,
  createTestApp,
  registerAccount,
  relaxedLimiters,
  testPool,
  uniqueUsername,
  VALID_CHARACTER,
  type TestAccount,
} from '../helpers/app.js';
import { ManualClock } from '../helpers/clock.js';
import { TestClient, closeAll } from '../helpers/ws.js';

const FAST = {
  ...DEFAULT_TOURNAMENT_CONFIG,
  enabled: false,
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

interface Player extends TestAccount {
  characterId: string;
  nickname: string;
}

async function boot() {
  const pool = testPool();
  const hub = new Hub();
  const limiters = relaxedLimiters();
  const chat = new ChatService({ db: pool, hub, limiters });
  const duels = new DuelService({ db: pool, hub, chat, limiters, revealMs: 20 });
  // The tournament runs on a hand-driven clock so nothing advances except what a test asks
  // for; the duel keeps the real one, since it is the thing racing the seating step.
  const clock = new ManualClock();
  const tournaments = new TournamentService({ db: pool, hub, config: FAST, clock });
  const { app } = await createTestApp({
    config: { tournament: FAST },
    hub,
    chat,
    duels,
    tournaments,
    limiters,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    app,
    duels,
    tournaments,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await duels.stop();
      await tournaments.stop();
      hub.closeAll();
      await app.close();
    },
  };
}

async function makePlayer(app: FastifyInstance, nickname: string, coins: number): Promise<Player> {
  const account = await registerAccount(app, { username: uniqueUsername('race') });
  const response = await app.inject(
    authed(account, { method: 'POST', url: '/api/v1/characters', payload: { ...VALID_CHARACTER, nickname } }),
  );
  expect(response.statusCode, response.body).toBe(201);
  const characterId = response.json().character.id as string;
  await db.query(
    `UPDATE characters
     SET created_at = now() - interval '48 hours', lethal_coins = $2, stats = $3, last_simulated_at = now()
     WHERE id = $1`,
    [characterId, coins, JSON.stringify({ ...STARTING_STATS, hp: 100 })],
  );
  return { ...account, characterId, nickname };
}

async function characterRow(characterId: string): Promise<{
  lethal_coins: number;
  active_duel_id: string | null;
  seated_table_id: string | null;
  rebirth_count: number;
}> {
  const result = await db.query<{
    lethal_coins: number;
    active_duel_id: string | null;
    seated_table_id: string | null;
    rebirth_count: number;
  }>(
    'SELECT lethal_coins, active_duel_id, seated_table_id, rebirth_count FROM characters WHERE id = $1',
    [characterId],
  );
  return result.rows[0]!;
}

async function entryOf(tournamentId: string, characterId: string) {
  const result = await db.query<{ current_stack: number; eliminated_in_round: number | null }>(
    'SELECT current_stack, eliminated_in_round FROM tournament_entries WHERE tournament_id = $1 AND character_id = $2',
    [tournamentId, characterId],
  );
  return result.rows[0]!;
}

async function chargeOf(tournamentId: string, characterId: string): Promise<string | null> {
  const result = await db.query<{ charge: string }>(
    'SELECT charge FROM tournament_charges WHERE tournament_id = $1 AND character_id = $2',
    [tournamentId, characterId],
  );
  return result.rows[0]?.charge ?? null;
}

async function hpOf(characterId: string): Promise<number> {
  const result = await db.query<{ hp: number }>(
    `SELECT (stats->>'hp')::float AS hp FROM characters WHERE id = $1`,
    [characterId],
  );
  return result.rows[0]!.hp;
}

async function seatedCharacterIds(tournamentId: string): Promise<string[]> {
  const result = await db.query<{ character_id: string }>(
    `SELECT s.character_id FROM table_seats s
     JOIN tournament_tables t ON t.id = s.table_id
     WHERE t.tournament_id = $1`,
    [tournamentId],
  );
  return result.rows.map((row) => row.character_id);
}

async function playRound(
  challenger: TestClient,
  opponent: TestClient,
  duelId: string,
  challengerThrow: DuelThrow,
  opponentThrow: DuelThrow,
): Promise<void> {
  const forChallenger = await challenger.next('duel:round', (message) => message.duelId === duelId);
  const forOpponent = await opponent.next('duel:round', (message) => message.duelId === duelId);
  challenger.send({
    type: 'duel:throw',
    duelId,
    round: forChallenger.round,
    replay: forChallenger.replay,
    seq: forChallenger.seq,
    throw: challengerThrow,
  });
  opponent.send({
    type: 'duel:throw',
    duelId,
    round: forOpponent.round,
    replay: forOpponent.replay,
    seq: forOpponent.seq,
    throw: opponentThrow,
  });
  await challenger.next('duel:round_result', (message) => message.seq === forChallenger.seq);
  await opponent.next('duel:round_result', (message) => message.seq === forOpponent.seq);
}

/**
 * Regression, QA round 1 (bug 3). The engagement lock was only checked in one direction: the
 * duel accept path looks at `seated_table_id`, but nothing re-checked `active_duel_id` at the
 * moment a tournament actually seats a character. `seated_table_id` is written in
 * `startRoundLocked`, which runs after the whole population has been charged and sharded — a
 * window that scales with population size, and wide enough for a duel invite to be accepted
 * in. A character could end up seated at a poker table with live escrow while already dying
 * in a duel somewhere else.
 */
describe('a duel accepted between the entry charge and the seat', () => {
  it('leaves the character committed to exactly one of the two systems', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const duelist = await makePlayer(booted.app, 'Torn', 60);
      const opponent = await makePlayer(booted.app, 'Challenger', 60);
      const first = await makePlayer(booted.app, 'Seatable1', 60);
      const second = await makePlayer(booted.app, 'Seatable2', 60);

      const tournament = (await insertScheduledTournament(db, {
        scope: 'global',
        slotKey: `race:${crypto.randomUUID()}`,
        scheduledFor: new Date(Date.now() + 60_000),
        registrationOpensAt: new Date(),
      }))!;
      const entrants = [duelist.characterId, first.characterId, second.characterId];
      // The state the stall leaves behind: charged, escrowed, and not yet seated.
      for (const characterId of entrants) {
        await db.query(
          'INSERT INTO tournament_entries (tournament_id, character_id, current_stack) VALUES ($1, $2, 3)',
          [tournament.id, characterId],
        );
        await db.query('UPDATE characters SET lethal_coins = lethal_coins - 3 WHERE id = $1', [characterId]);
      }
      const running = await updateTournamentState(db, tournament.id, {
        state: 'running',
        currentRound: 0,
        totalRounds: 1,
        entrantCount: entrants.length,
      });

      // The duel lands inside that window.
      const a = await TestClient.connect(booted.baseUrl, opponent.accessToken);
      const b = await TestClient.connect(booted.baseUrl, duelist.accessToken);
      clients.push(a, b);
      a.send({ type: 'duel:invite', targetCharacterId: duelist.characterId });
      const invited = await b.next('duel:invited');
      b.send({ type: 'duel:respond', inviteId: invited.inviteId, accept: true });
      const start = await a.next('duel:start');
      await b.next('duel:start');

      const beforeSeating = await characterRow(duelist.characterId);
      expect(beforeSeating.active_duel_id).toBe(start.duelId);
      expect(beforeSeating.seated_table_id).toBeNull();

      // Seating resumes.
      await booted.tournaments.startRound(running, 1, entrants);

      // The duelist was refused a seat; the other two got their table.
      const seated = await seatedCharacterIds(tournament.id);
      expect(seated).not.toContain(duelist.characterId);
      expect(seated.sort()).toEqual([first.characterId, second.characterId].sort());
      expect((await characterRow(duelist.characterId)).seated_table_id).toBeNull();

      // And they left the tournament the way any table exit does: escrow back, entry closed.
      expect(await entryOf(tournament.id, duelist.characterId)).toEqual({
        current_stack: 0,
        eliminated_in_round: 1,
      });
      expect((await characterRow(duelist.characterId)).lethal_coins).toBe(60);
      const eliminated = await b.next('tourney:eliminated');
      expect(eliminated.coinsReturned).toBe(3);

      // The duel then runs to its real conclusion, on a character no tournament owns.
      await playRound(a, b, start.duelId, 'rock', 'scissors');
      await playRound(a, b, start.duelId, 'paper', 'rock');
      const end = await a.next('duel:end');
      expect(end.outcome).toBe('death');
      expect(end.loserCharacterId).toBe(duelist.characterId);

      const after = await characterRow(duelist.characterId);
      expect(after).toMatchObject({
        lethal_coins: STARTING_LETHAL_COINS,
        active_duel_id: null,
        seated_table_id: null,
        rebirth_count: 1,
      });
      // No live tournament entry survived the death.
      expect(await entryOf(tournament.id, duelist.characterId)).toMatchObject({
        eliminated_in_round: 1,
        current_stack: 0,
      });
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  /**
   * Regression, QA round 2 (new 2). `reservedInviteStake` was only consulted by the action
   * routes, so registration close charged a challenger whose whole wallet was already
   * promised to a pending challenge — the duel then played for less than the target had
   * consented to, or the entry charge converted HP for coins that were spoken for.
   */
  it('does not charge tournament entry into a stake a pending challenge has reserved', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const challenger = await makePlayer(booted.app, 'Promised', 200);
      const target = await makePlayer(booted.app, 'Considering', 500);
      // Opted in, so what registration close would take is the 3-coin entry, not the penalty.
      await db.query('UPDATE characters SET tournament_opt_in = true WHERE id = $1', [
        challenger.characterId,
      ]);

      const a = await TestClient.connect(booted.baseUrl, challenger.accessToken);
      const b = await TestClient.connect(booted.baseUrl, target.accessToken);
      clients.push(a, b);

      a.send({ type: 'duel:invite', targetCharacterId: target.characterId });
      const invited = await b.next('duel:invited');
      expect(invited.stakeCoins).toBe(200);

      const tournament = (await insertScheduledTournament(db, {
        scope: 'global',
        slotKey: `reserved:${crypto.randomUUID()}`,
        scheduledFor: new Date(Date.now() + 60_000),
        registrationOpensAt: new Date(),
      }))!;
      await booted.tournaments.closeRegistration(tournament);

      // Not charged the 3-coin entry and not entered: the whole wallet is the stake the
      // target is looking at, and it is left untouched. The 1-coin participation tax lands
      // anyway, out of HP, because not entering is exactly what happened (new 15).
      expect((await characterRow(challenger.characterId)).lethal_coins).toBe(200);
      expect(await chargeOf(tournament.id, challenger.characterId)).toBe('miss_penalty');
      expect(await hpOf(challenger.characterId)).toBeCloseTo(90, 1);
      const entered = await db.query(
        'SELECT 1 FROM tournament_entries WHERE tournament_id = $1 AND character_id = $2',
        [tournament.id, challenger.characterId],
      );
      expect(entered.rowCount).toBe(0);

      // And the duel is played for exactly the number that was advertised.
      b.send({ type: 'duel:respond', inviteId: invited.inviteId, accept: true });
      const start = await b.next('duel:start');
      expect(start.stakeCoins).toBe(200);
      await playRound(a, b, start.duelId, 'rock', 'scissors');
      await playRound(a, b, start.duelId, 'paper', 'rock');
      const end = await a.next('duel:end');
      expect(end.coinsTransferred).toBe(200);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  /**
   * Regression, QA round 3 (new 9). The new-2 fix applied the reservation guard to both
   * charge kinds, so a character holding a pending challenge worth their whole wallet was
   * given no charge row at all at registration close — not the entry, not the miss penalty,
   * not the HP conversion a broke character takes. Closes run on a predictable schedule and
   * invites live 60s, so one challenge issued before each close dodged the participation tax
   * permanently. Entry is skippable that way because the target consented to the stake; the
   * miss penalty is the tax for *not* taking part, and holding a challenge is not taking part.
   */
  it('still charges the miss penalty when a pending challenge has reserved the wallet', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const dodger = await makePlayer(booted.app, 'Dodger', 4);
      const doomed = await makePlayer(booted.app, 'Lastbreath', 4);
      const firstTarget = await makePlayer(booted.app, 'Mark', 50);
      const secondTarget = await makePlayer(booted.app, 'Othermark', 50);
      // One HP short of affording the conversion, which is the rebirth the plan calls for.
      await db.query(`UPDATE characters SET stats = jsonb_set(stats, '{hp}', '5') WHERE id = $1`, [
        doomed.characterId,
      ]);

      const a = await TestClient.connect(booted.baseUrl, dodger.accessToken);
      const b = await TestClient.connect(booted.baseUrl, doomed.accessToken);
      const c = await TestClient.connect(booted.baseUrl, firstTarget.accessToken);
      const d = await TestClient.connect(booted.baseUrl, secondTarget.accessToken);
      clients.push(a, b, c, d);

      a.send({ type: 'duel:invite', targetCharacterId: firstTarget.characterId });
      expect((await c.next('duel:invited')).stakeCoins).toBe(4);
      b.send({ type: 'duel:invite', targetCharacterId: secondTarget.characterId });
      expect((await d.next('duel:invited')).stakeCoins).toBe(4);

      const tournament = (await insertScheduledTournament(db, {
        scope: 'global',
        slotKey: `misspenalty:${crypto.randomUUID()}`,
        scheduledFor: new Date(Date.now() + 60_000),
        registrationOpensAt: new Date(),
      }))!;
      await booted.tournaments.closeRegistration(tournament);

      // Charged, on the same insufficient-funds path an empty wallet takes: the reserved
      // stake is untouched and the coin comes out of HP at 10% instead.
      expect(await chargeOf(tournament.id, dodger.characterId)).toBe('miss_penalty');
      const chargedRow = await characterRow(dodger.characterId);
      expect(chargedRow.lethal_coins).toBe(4);
      expect(chargedRow.rebirth_count).toBe(0);
      expect(await hpOf(dodger.characterId)).toBeCloseTo(90, 1);

      // And when that conversion would exhaust HP it kills, exactly as entry does.
      expect(await chargeOf(tournament.id, doomed.characterId)).toBe('miss_penalty');
      expect(await characterRow(doomed.characterId)).toMatchObject({
        lethal_coins: STARTING_LETHAL_COINS,
        rebirth_count: 1,
      });
      const reborn = await b.next('character:rebirth');
      expect(reborn.cause).toBe('tournament_entry_hp_exhausted');

      // The challenge the dodger was hiding behind is still theirs to play, for the stake
      // their target agreed to.
      c.send({ type: 'duel:respond', inviteId: (await c.received('duel:invited'))[0]!.inviteId, accept: true });
      const start = await a.next('duel:start');
      expect(start.stakeCoins).toBe(4);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  /**
   * Regression, QA round 4 (new 15). The new-9 fix scoped the reservation guard to the entry
   * charge, which closed the dodge for an opted-*out* character and left it open for an
   * opted-in one: their entry was refused for the reservation and nothing took its place —
   * no entry, no penalty, no charge row at all. Since the stake is the smaller of the two
   * wallets, anyone can reserve their whole wallet by challenging a richer player, so
   * `tournament_opt_in = true` plus one challenge before each close was a standing exemption
   * from the participation tax. Opting in is not taking part; entering is.
   */
  it('charges the miss penalty to an opted-in character whose stake is reserved', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const dodger = await makePlayer(booted.app, 'Optedin', 200);
      const doomed = await makePlayer(booted.app, 'Optedinbroke', 4);
      // Opted in with nothing promised away: the control that still enters normally.
      const control = await makePlayer(booted.app, 'Richer', 500);
      const otherTarget = await makePlayer(booted.app, 'Richest', 500);
      await db.query('UPDATE characters SET tournament_opt_in = true WHERE id = ANY($1)', [
        [dodger.characterId, doomed.characterId, control.characterId],
      ]);
      // One HP short of affording the conversion, which is the rebirth the plan calls for.
      await db.query(`UPDATE characters SET stats = jsonb_set(stats, '{hp}', '5') WHERE id = $1`, [
        doomed.characterId,
      ]);

      const a = await TestClient.connect(booted.baseUrl, dodger.accessToken);
      const b = await TestClient.connect(booted.baseUrl, doomed.accessToken);
      const c = await TestClient.connect(booted.baseUrl, control.accessToken);
      const d = await TestClient.connect(booted.baseUrl, otherTarget.accessToken);
      clients.push(a, b, c, d);

      // The stake is the smaller wallet, so challenging up reserves all of it.
      a.send({ type: 'duel:invite', targetCharacterId: control.characterId });
      expect((await c.next('duel:invited')).stakeCoins).toBe(200);
      b.send({ type: 'duel:invite', targetCharacterId: otherTarget.characterId });
      expect((await d.next('duel:invited')).stakeCoins).toBe(4);

      const tournament = (await insertScheduledTournament(db, {
        scope: 'global',
        slotKey: `optedin:${crypto.randomUUID()}`,
        scheduledFor: new Date(Date.now() + 60_000),
        registrationOpensAt: new Date(),
      }))!;
      await booted.tournaments.closeRegistration(tournament);

      // Not entered, since the entry would be paid out of coins the target consented to —
      // and charged the tax for not entering, out of HP, with the reservation intact.
      expect(await chargeOf(tournament.id, dodger.characterId)).toBe('miss_penalty');
      expect((await characterRow(dodger.characterId)).lethal_coins).toBe(200);
      expect(await hpOf(dodger.characterId)).toBeCloseTo(90, 1);
      const dodgerEntry = await db.query(
        'SELECT 1 FROM tournament_entries WHERE tournament_id = $1 AND character_id = $2',
        [tournament.id, dodger.characterId],
      );
      expect(dodgerEntry.rowCount).toBe(0);

      // And when that conversion would exhaust HP it kills, exactly as an entry does.
      expect(await chargeOf(tournament.id, doomed.characterId)).toBe('miss_penalty');
      expect(await characterRow(doomed.characterId)).toMatchObject({
        lethal_coins: STARTING_LETHAL_COINS,
        rebirth_count: 1,
      });
      expect((await b.next('character:rebirth')).cause).toBe('tournament_entry_hp_exhausted');
      // Their join is cleared too: they opted in and did not get in.
      expect((await b.next('tourney:entry_failed')).code).toBe('REBORN');

      // The guard is still exactly as narrow as it was: an opted-in character with nothing
      // reserved pays the entry and takes a seat.
      expect(await chargeOf(tournament.id, control.characterId)).toBe('entry');
      expect((await characterRow(control.characterId)).lethal_coins).toBe(497);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('gives the last player standing a bye when a duel empties the table', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const duelist = await makePlayer(booted.app, 'Leaver', 60);
      const opponent = await makePlayer(booted.app, 'Caller', 60);
      const survivor = await makePlayer(booted.app, 'Alone', 60);

      const tournament = (await insertScheduledTournament(db, {
        scope: 'global',
        slotKey: `race:${crypto.randomUUID()}`,
        scheduledFor: new Date(Date.now() + 60_000),
        registrationOpensAt: new Date(),
      }))!;
      const entrants = [duelist.characterId, survivor.characterId];
      for (const characterId of entrants) {
        await db.query(
          'INSERT INTO tournament_entries (tournament_id, character_id, current_stack) VALUES ($1, $2, 3)',
          [tournament.id, characterId],
        );
      }
      const running = await updateTournamentState(db, tournament.id, {
        state: 'running',
        currentRound: 0,
        totalRounds: 1,
        entrantCount: entrants.length,
        prizePotCoins: 4,
      });

      const a = await TestClient.connect(booted.baseUrl, opponent.accessToken);
      const b = await TestClient.connect(booted.baseUrl, duelist.accessToken);
      clients.push(a, b);
      a.send({ type: 'duel:invite', targetCharacterId: duelist.characterId });
      const invited = await b.next('duel:invited');
      b.send({ type: 'duel:respond', inviteId: invited.inviteId, accept: true });
      await a.next('duel:start');
      await b.next('duel:start');

      await booted.tournaments.startRound(running, 1, entrants);

      // Nobody was seated with a duelist, and the round still resolved rather than wedging.
      expect(await seatedCharacterIds(tournament.id)).toEqual([]);
      expect((await characterRow(duelist.characterId)).seated_table_id).toBeNull();
      const state = await db.query<{ state: string; winner_character_id: string | null }>(
        'SELECT state, winner_character_id FROM tournaments WHERE id = $1',
        [tournament.id],
      );
      expect(state.rows[0]).toMatchObject({
        state: 'complete',
        winner_character_id: survivor.characterId,
      });

      /**
       * QA round 2 (new 6). The round collapsed without a hand being dealt, so the survivor
       * takes their own escrow back and nothing else: the house prize pot is paid for
       * winning a tournament, and a group that duel-locks each other at seating has not
       * won one.
       */
      const winnerFrame = await b.next('tourney:winner');
      expect(winnerFrame).toMatchObject({ characterId: survivor.characterId, stackCoins: 3, prizeCoins: 0 });
      expect((await characterRow(survivor.characterId)).lethal_coins).toBe(63);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
  /**
   * QA round 5, new 15 verification. The fix turned the reservation guard from an early
   * return into a term in deriving the charge kind, which puts three boundaries in one
   * expression. Each is asserted here against what a player can actually observe.
   */
  it('leaves the reserved challenge fully playable after the miss penalty it caused', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const dodger = await makePlayer(booted.app, 'Stillplays', 200);
      const target = await makePlayer(booted.app, 'Wealthy', 500);
      await db.query('UPDATE characters SET tournament_opt_in = true WHERE id = $1', [
        dodger.characterId,
      ]);

      const a = await TestClient.connect(booted.baseUrl, dodger.accessToken);
      const b = await TestClient.connect(booted.baseUrl, target.accessToken);
      clients.push(a, b);

      a.send({ type: 'duel:invite', targetCharacterId: target.characterId });
      const invited = await b.next('duel:invited');
      expect(invited.stakeCoins).toBe(200);

      const tournament = (await insertScheduledTournament(db, {
        scope: 'global',
        slotKey: `plays:${crypto.randomUUID()}`,
        scheduledFor: new Date(Date.now() + 60_000),
        registrationOpensAt: new Date(),
      }))!;
      await booted.tournaments.closeRegistration(tournament);

      expect(await chargeOf(tournament.id, dodger.characterId)).toBe('miss_penalty');
      expect((await characterRow(dodger.characterId)).lethal_coins).toBe(200);

      /**
       * The point of preserving the wallet rather than the entry: the target was shown a
       * 200-coin duel and still gets one. A penalty taken out of the reservation would have
       * silently shrunk the stake the two of them agreed on.
       */
      b.send({ type: 'duel:respond', inviteId: invited.inviteId, accept: true });
      const start = await a.next('duel:start');
      expect(start.stakeCoins).toBe(200);
      await b.next('duel:start');
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('still enters an opted-in character whose spare coins cover the entry above the reservation', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      // Exactly the boundary: three coins of headroom above the reserved stake is enough.
      const spare = await makePlayer(booted.app, 'Headroom', 13);
      const tight = await makePlayer(booted.app, 'Nohead', 12);
      const target = await makePlayer(booted.app, 'Bigwallet', 500);
      const other = await makePlayer(booted.app, 'Bigger', 500);
      await db.query('UPDATE characters SET tournament_opt_in = true WHERE id = ANY($1)', [
        [spare.characterId, tight.characterId],
      ]);

      const a = await TestClient.connect(booted.baseUrl, spare.accessToken);
      const b = await TestClient.connect(booted.baseUrl, tight.accessToken);
      const c = await TestClient.connect(booted.baseUrl, target.accessToken);
      const d = await TestClient.connect(booted.baseUrl, other.accessToken);
      clients.push(a, b, c, d);

      // Reserve a 10-coin stake for each by challenging a much richer player and having
      // them decline nothing — the invite stays pending, which is what reserves.
      await db.query('UPDATE characters SET lethal_coins = 10 WHERE id = $1', [spare.characterId]);
      a.send({ type: 'duel:invite', targetCharacterId: target.characterId });
      expect((await c.next('duel:invited')).stakeCoins).toBe(10);
      await db.query('UPDATE characters SET lethal_coins = 13 WHERE id = $1', [spare.characterId]);

      await db.query('UPDATE characters SET lethal_coins = 10 WHERE id = $1', [tight.characterId]);
      b.send({ type: 'duel:invite', targetCharacterId: other.characterId });
      expect((await d.next('duel:invited')).stakeCoins).toBe(10);
      await db.query('UPDATE characters SET lethal_coins = 12 WHERE id = $1', [tight.characterId]);

      const tournament = (await insertScheduledTournament(db, {
        scope: 'global',
        slotKey: `headroom:${crypto.randomUUID()}`,
        scheduledFor: new Date(Date.now() + 60_000),
        registrationOpensAt: new Date(),
      }))!;
      await booted.tournaments.closeRegistration(tournament);

      // 13 - 10 reserved = 3, exactly the entry fee: they enter, they pay it in coins, and
      // the 10 they promised the target is still there to pay the duel with.
      expect(await chargeOf(tournament.id, spare.characterId)).toBe('entry');
      const entered = await a.next('tourney:entered');
      expect(entered).toMatchObject({ tournamentId: tournament.id, stack: 3, hpConverted: 0 });
      expect(await hpOf(spare.characterId)).toBeCloseTo(100, 1);
      expect((await characterRow(spare.characterId)).lethal_coins).toBeGreaterThanOrEqual(10);

      /**
       * 12 - 10 = 2, one short of the entry: refused, and the tax taken instead. New 9's
       * restore math is what is being read here — the penalty comes out of the two free
       * coins, and the ten the target was shown are still there afterwards.
       */
      expect(await chargeOf(tournament.id, tight.characterId)).toBe('miss_penalty');
      expect((await characterRow(tight.characterId)).lethal_coins).toBe(11);
      expect(await hpOf(tight.characterId)).toBeCloseTo(100, 1);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('still enters a broke opted-in character with nothing reserved, out of HP', async () => {
    const booted = await boot();
    try {
      // The `reserved === 0` disjunct: no challenge out, so the ordinary HP conversion path
      // is untouched by the new-15 fix.
      const broke = await makePlayer(booted.app, 'Brokejoiner', 0);
      await db.query('UPDATE characters SET tournament_opt_in = true WHERE id = $1', [
        broke.characterId,
      ]);

      const tournament = (await insertScheduledTournament(db, {
        scope: 'global',
        slotKey: `brokein:${crypto.randomUUID()}`,
        scheduledFor: new Date(Date.now() + 60_000),
        registrationOpensAt: new Date(),
      }))!;
      await booted.tournaments.closeRegistration(tournament);

      // Entered, with the three coins found by converting 30% of its HP.
      expect(await chargeOf(tournament.id, broke.characterId)).toBe('entry');
      expect(await entryOf(tournament.id, broke.characterId)).toBeDefined();
      expect(await hpOf(broke.characterId)).toBeCloseTo(70, 1);
    } finally {
      await booted.close();
    }
  });

  it('says nothing at all to an opted-in character miss-penalized without a rebirth', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const quiet = await makePlayer(booted.app, 'Nofeedback', 200);
      const target = await makePlayer(booted.app, 'Silenttarget', 500);
      await db.query('UPDATE characters SET tournament_opt_in = true WHERE id = $1', [
        quiet.characterId,
      ]);

      const a = await TestClient.connect(booted.baseUrl, quiet.accessToken);
      const b = await TestClient.connect(booted.baseUrl, target.accessToken);
      clients.push(a, b);
      a.send({ type: 'duel:invite', targetCharacterId: target.characterId });
      await b.next('duel:invited');

      const tournament = (await insertScheduledTournament(db, {
        scope: 'global',
        slotKey: `quiet:${crypto.randomUUID()}`,
        scheduledFor: new Date(Date.now() + 60_000),
        registrationOpensAt: new Date(),
      }))!;
      await booted.tournaments.closeRegistration(tournament);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(await chargeOf(tournament.id, quiet.characterId)).toBe('miss_penalty');
      /**
       * Characterisation, not approval. This player asked to be in the tournament and was
       * not put in it, and the only frame they get is a `character:update` that silently
       * docks 10 HP: no `tourney:entry_failed`, so a client showing a pending "joining"
       * state has nothing to clear it with. Documented as the known gap it is.
       */
      expect(a.received('tourney:entry_failed')).toHaveLength(0);
      expect(a.received('tourney:entered')).toHaveLength(0);
      expect(a.received('character:update').length).toBeGreaterThan(0);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});
