import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { STARTING_STATS, type CharacterDto } from '@lethalmagotchi/shared';
import { DEFAULT_TOURNAMENT_CONFIG } from '../../src/config.js';
import type { Db } from '../../src/db/pool.js';
import { insertScheduledTournament, updateTournamentState } from '../../src/repos/tournaments.js';
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

/**
 * Real sharding starts above 3125 entrants, which no integration test can populate. The
 * threshold — and only the threshold — is lowered so the actual shard creation, entry
 * re-parenting and activation code runs for real against the database.
 */
vi.mock('@lethalmagotchi/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lethalmagotchi/shared')>();
  return { ...actual, shardCountFor: (entrantCount: number) => (entrantCount >= 6 ? Math.ceil(entrantCount / 3) : 1) };
});

const FAST = {
  ...DEFAULT_TOURNAMENT_CONFIG,
  enabled: true,
  mode: 'interval' as const,
  turnMs: 60_000,
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

async function boot() {
  const hub = new Hub();
  const tournaments = new TournamentService({ db, hub, config: FAST, clock: new ManualClock() });
  const { app } = await createTestApp({ config: { tournament: FAST }, hub, tournaments });
  return {
    app,
    tournaments,
    async close() {
      await tournaments.stop();
      hub.closeAll();
      await app.close();
    },
  };
}

async function makeEntrants(app: FastifyInstance, count: number, prefix: string): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const account = await registerAccount(app, { username: uniqueUsername('shard') });
    const response = await app.inject(
      authed(account, {
        method: 'POST',
        url: '/api/v1/characters',
        payload: { ...VALID_CHARACTER, nickname: `${prefix}${index}` },
      }),
    );
    if (response.statusCode !== 201) throw new Error(`character create failed: ${response.body}`);
    const character = response.json().character as CharacterDto;
    await db.query(
      `UPDATE characters SET lethal_coins = 12, tournament_opt_in = true, stats = $2, last_simulated_at = now()
       WHERE id = $1`,
      [character.id, JSON.stringify({ ...STARTING_STATS, hp: 100 })],
    );
    ids.push(character.id);
  }
  return ids;
}

async function resetOptIns(): Promise<void> {
  await db.query('UPDATE characters SET tournament_opt_in = false, seated_table_id = NULL');
  await db.query('UPDATE characters SET lethal_coins = 50 WHERE lethal_coins < 5');
}

async function makeTournament(slotKey: string) {
  const scheduledFor = new Date(Date.now() - 60_000);
  const row = await insertScheduledTournament(db, {
    scope: 'global',
    slotKey,
    scheduledFor,
    registrationOpensAt: scheduledFor,
  });
  return row!;
}

async function shardsOf(slotKey: string) {
  const result = await db.query<{
    id: string;
    state: string;
    shard_index: number;
    shard_count: number;
    entrant_count: number;
  }>(
    'SELECT id, state, shard_index, shard_count, entrant_count FROM tournaments WHERE slot_key = $1 ORDER BY shard_index',
    [slotKey],
  );
  return result.rows;
}

async function escrowSum(tournamentId: string): Promise<number> {
  const result = await db.query<{ total: number }>(
    'SELECT COALESCE(sum(current_stack), 0)::int AS total FROM tournament_entries WHERE tournament_id = $1',
    [tournamentId],
  );
  return result.rows[0]!.total;
}

async function walletSum(characterIds: string[]): Promise<number> {
  const result = await db.query<{ total: number }>(
    'SELECT COALESCE(sum(lethal_coins), 0)::int AS total FROM characters WHERE id = ANY($1)',
    [characterIds],
  );
  return result.rows[0]!.total;
}

describe('shard creation and activation are one step', () => {
  it('splits a large field into siblings that are running the moment they exist', async () => {
    const server = await boot();
    await resetOptIns();
    try {
      const ids = await makeEntrants(server.app, 6, 'Split');
      const slotKey = `shard-ok:${crypto.randomUUID()}`;
      const tournament = await makeTournament(slotKey);
      await updateTournamentState(db, tournament.id, { state: 'registration' });

      await server.tournaments.closeRegistration({ ...tournament, state: 'registration' });
      await settle();

      const shards = await shardsOf(slotKey);
      expect(shards).toHaveLength(2);
      for (const shard of shards) {
        expect(shard.state).toBe('running');
        expect(shard.shard_count).toBe(2);
        expect(shard.entrant_count).toBe(3);
        expect(await escrowSum(shard.id)).toBe(3 * 3);
      }

      const orphanEntries = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM tournament_entries e
         JOIN tournaments t ON t.id = e.tournament_id
         WHERE t.slot_key = $1 AND t.state = 'scheduled'`,
        [slotKey],
      );
      expect(Number(orphanEntries.rows[0]!.n)).toBe(0);
      expect(await walletSum(ids)).toBe(6 * (12 - 3));
    } finally {
      await server.close();
    }
  }, 120_000);

  /**
   * The interrupted-sharding case, driven through the service's own failure: the third
   * shard cannot be created because its row already exists. Whatever the close leaves
   * behind must be a state boot recovery settles — never a `scheduled` tournament sitting
   * on other characters' escrow, which nothing would ever refund.
   */
  it('leaves only recoverable states when a sibling cannot be created', async () => {
    const server = await boot();
    await resetOptIns();
    try {
      const ids = await makeEntrants(server.app, 9, 'Crash');
      const walletsBefore = await walletSum(ids);
      const slotKey = `shard-crash:${crypto.randomUUID()}`;
      const tournament = await makeTournament(slotKey);
      await updateTournamentState(db, tournament.id, { state: 'registration' });

      const decoy = (await insertScheduledTournament(db, {
        scope: 'global',
        slotKey,
        scheduledFor: tournament.scheduled_for,
        registrationOpensAt: tournament.registration_opens_at,
        shardIndex: 2,
        shardCount: 3,
      }))!;

      await server.tournaments.closeRegistration({ ...tournament, state: 'registration' });
      await settle();

      const sibling = (await shardsOf(slotKey)).find((shard) => shard.shard_index === 1)!;
      // The sibling that did get created was activated in the same transaction, so it is
      // playable and its escrow is accounted for rather than stranded.
      expect(sibling.state).toBe('running');

      const hub = new Hub();
      const recovered = new TournamentService({ db, hub, config: FAST, clock: new ManualClock() });
      await recovered.start();
      await recovered.stop();
      hub.closeAll();

      for (const shard of await shardsOf(slotKey)) {
        if (shard.id === decoy.id) continue;
        expect(shard.state).not.toBe('scheduled');
        expect(await escrowSum(shard.id)).toBe(0);
      }
      const stranded = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM tournaments t
         WHERE t.state = 'scheduled'
           AND EXISTS (SELECT 1 FROM tournament_entries e WHERE e.tournament_id = t.id AND e.current_stack > 0)`,
      );
      expect(Number(stranded.rows[0]!.n)).toBe(0);
      expect(await walletSum(ids)).toBe(walletsBefore);
    } finally {
      await db.query(`UPDATE tournaments SET state = 'cancelled' WHERE slot_key LIKE 'shard-%'`);
      await server.close();
    }
  }, 120_000);
});
