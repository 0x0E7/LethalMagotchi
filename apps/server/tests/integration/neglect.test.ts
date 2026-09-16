import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { STARTING_STATS, type CharacterStats, type ServerMessage } from '@lethalmagotchi/shared';
import { withTransaction, type Db } from '../../src/db/pool.js';
import { reapLocked, type NeglectService } from '../../src/neglect/service.js';
import type { CharacterRow } from '../../src/repos/characters.js';
import { Hub } from '../../src/ws/hub.js';
import {
  authed,
  closeTestPool,
  createTestApp,
  registerAccount,
  testPool,
  uniqueUsername,
  VALID_CHARACTER,
  type TestAccount,
} from '../helpers/app.js';

/**
 * Death by neglect.
 *
 * HP always fell to zero correctly — nothing ever acted on it, so a starved pet sat at zero
 * indefinitely. These tests are about the *event*: that it fires, that it fires exactly once,
 * that it cannot be raced, and that nothing else in the product is damaged by it.
 */

interface Player extends TestAccount {
  characterId: string;
}

let app: FastifyInstance;
let hub: Hub;
let neglect: NeglectService;
let db: Db;

beforeAll(async () => {
  db = testPool();
  hub = new Hub();
  ({ app, neglect } = await createTestApp({ hub }));
});

afterAll(async () => {
  await app.close();
  await closeTestPool();
});

async function makePlayer(): Promise<Player> {
  const account = await registerAccount(app, { username: uniqueUsername('neg') });
  const response = await app.inject(
    authed(account, {
      method: 'POST',
      url: '/api/v1/characters',
      payload: { ...VALID_CHARACTER, nickname: `Doomed${randomUUID().slice(0, 6)}` },
    }),
  );
  expect(response.statusCode, response.body).toBe(201);
  return { ...account, characterId: response.json().character.id };
}

/** Sets the stored stats and rewinds the watermark, so the next read simulates the gap. */
async function setState(
  player: Player,
  stats: Partial<CharacterStats>,
  simulatedHoursAgo = 0,
): Promise<void> {
  await db.query(
    `UPDATE characters
       SET stats = $2, last_simulated_at = now() - make_interval(hours => $3)
     WHERE id = $1`,
    [player.characterId, JSON.stringify({ ...STARTING_STATS, ...stats }), simulatedHoursAgo],
  );
}

/** Everything at zero and a fortnight of silence: dead by any reading. */
async function starve(player: Player): Promise<void> {
  await setState(player, { hp: 0, hunger: 0, energy: 0, hygiene: 0 }, 14 * 24);
}

const frames: ServerMessage[] = [];

function connect(player: Player): string {
  const id = randomUUID();
  hub.add({
    id,
    accountId: player.accountId,
    characterId: player.characterId,
    socket: {
      send: (data: string) => frames.push(JSON.parse(data) as ServerMessage),
      close: () => {},
    },
  });
  return id;
}

async function characterRow(player: Player): Promise<{
  stats: CharacterStats;
  lethal_coins: number;
  rebirth_count: number;
  deleted_at: Date | null;
}> {
  const result = await db.query<{
    stats: CharacterStats;
    lethal_coins: number;
    rebirth_count: number;
    deleted_at: Date | null;
  }>('SELECT stats, lethal_coins, rebirth_count, deleted_at FROM characters WHERE id = $1', [
    player.characterId,
  ]);
  return result.rows[0]!;
}

function rebirthEvents(player: Player) {
  return db.query<{ cause: string; stats_before: CharacterStats; coins_before: number }>(
    'SELECT cause, stats_before, coins_before FROM rebirth_events WHERE character_id = $1',
    [player.characterId],
  );
}

describe('a pet that reaches 0 HP', () => {
  it('dies, and comes back renewed rather than deleted', async () => {
    const player = await makePlayer();
    await db.query('UPDATE characters SET lethal_coins = 40 WHERE id = $1', [player.characterId]);
    await starve(player);
    connect(player);

    expect(await neglect.sweep()).toBeGreaterThanOrEqual(1);

    const row = await characterRow(player);
    // Renewal, not deletion: same row, same id, same nickname and history.
    expect(row.deleted_at).toBeNull();
    expect(row.stats.hp).toBe(100);
    expect(row.lethal_coins).toBe(5);
    expect(row.rebirth_count).toBe(1);

    const events = await rebirthEvents(player);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]!.cause).toBe('neglect');
    // The card quotes what they looked like when they died, not the blank slate.
    expect(events.rows[0]!.stats_before.hp).toBe(0);
    expect(events.rows[0]!.coins_before).toBe(40);
  });

  it('tells the player, naming neglect rather than a duel or a tournament', async () => {
    const player = await makePlayer();
    await starve(player);
    connect(player);
    frames.length = 0;

    await neglect.sweep();

    const rebirth = frames.find((frame) => frame.type === 'character:rebirth');
    expect(rebirth, 'the death has to be announced, or it is invisible').toBeDefined();
    if (rebirth?.type !== 'character:rebirth') throw new Error('unreachable');
    expect(rebirth.cause).toBe('neglect');
    expect(rebirth.character.stats.hp).toBe(100);
    expect(rebirth.statsBefore.hp).toBe(0);
  });

  it('dies exactly once, however many times it is swept', async () => {
    const player = await makePlayer();
    await starve(player);
    connect(player);

    await neglect.sweep();
    await neglect.sweep();
    await neglect.sweep();

    // The second sweep re-reads a pet that is now at 100 HP with a fresh watermark, so
    // there is nothing to kill. A double rebirth would silently eat a wallet.
    expect((await rebirthEvents(player)).rows).toHaveLength(1);
    expect((await characterRow(player)).rebirth_count).toBe(1);
  });

  it('dies exactly once under concurrent reapers', async () => {
    const player = await makePlayer();
    await starve(player);
    connect(player);

    /**
     * Driven through `reap` rather than `sweep`, deliberately: `sweep` refuses to overlap
     * itself, so racing four sweeps would prove nothing. Four reapers on one character is
     * the race that can actually happen — a sweep firing as the owner's socket binds.
     *
     * This one passes on timing as much as on correctness; the test below it is the one
     * that holds the guarantee down.
     */
    const outcomes = await Promise.all([
      neglect.reap(player.characterId),
      neglect.reap(player.characterId),
      neglect.reap(player.characterId),
      neglect.reap(player.characterId),
    ]);

    expect(outcomes.filter((outcome) => outcome !== null)).toHaveLength(1);
    expect((await rebirthEvents(player)).rows).toHaveLength(1);
    expect((await characterRow(player)).rebirth_count).toBe(1);
  });

  it('refuses a stale reaper that read the pet before someone else killed it', async () => {
    const player = await makePlayer();
    await starve(player);

    /**
     * The exactly-once test above cannot fail reliably, and that is the point of this one.
     * Timing proved the race is real — widening the read-to-write window artificially gave
     * four reapers four rebirths and four reset wallets — but the natural window is
     * sub-millisecond, so a racing test passes by luck rather than by correctness.
     *
     * So exactly-once does not rest on lock ordering. The write is a conditional claim on
     * the `rebirth_count` the reaper read, and this drives that branch deterministically:
     * one caller holds a genuinely stale row, the other kills the pet first, and the stale
     * one must come away with nothing.
     */
    const stale = (
      await db.query<CharacterRow>('SELECT * FROM characters WHERE id = $1', [player.characterId])
    ).rows[0]!;

    const first = await neglect.reap(player.characterId);
    expect(first, 'the first reaper should take the death').not.toBeNull();

    const second = await withTransaction(db, (client) => reapLocked(client, stale, Date.now()));
    expect(second.rebirth, 'a stale reaper must not kill an already-renewed pet').toBeNull();

    expect((await rebirthEvents(player)).rows).toHaveLength(1);
    expect((await characterRow(player)).rebirth_count).toBe(1);
  });

  it('is reaped when the socket binds, for a pet that died while nobody was watching', async () => {
    const player = await makePlayer();
    await starve(player);
    frames.length = 0;

    // No sweep at all — this is the reconnect path, which is how an away player finds out.
    neglect.onCharacterOnline(player.characterId);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect((await characterRow(player)).rebirth_count).toBe(1);
  });

  it('leaves a healthy pet completely alone', async () => {
    const player = await makePlayer();
    await setState(player, {}, 1);
    connect(player);

    await neglect.sweep();

    const row = await characterRow(player);
    expect(row.rebirth_count).toBe(0);
    expect((await rebirthEvents(player)).rows).toHaveLength(0);
  });

  it('leaves a pet alone while it is engaged, rather than corrupting the engagement', async () => {
    const player = await makePlayer();
    await starve(player);
    await db.query('UPDATE characters SET seated_table_id = gen_random_uuid() WHERE id = $1', [
      player.characterId,
    ]);
    connect(player);

    await neglect.sweep();

    // Their coins are escrowed at the table and a rebirth resets the wallet the settlement
    // is counting on. They die when the table releases them, not in the middle of a hand.
    expect((await characterRow(player)).rebirth_count).toBe(0);
  });
});

describe('acting on a pet that has already died', () => {
  it('is refused, and kills it rather than letting the action through', async () => {
    const player = await makePlayer();
    await starve(player);
    connect(player);
    frames.length = 0;

    // No sweep first: this is the narrow window where HP crossed zero between the last
    // sweep and this request.
    const response = await app.inject(
      authed(player, { method: 'POST', url: '/api/v1/characters/me/actions/feed', payload: { itemId: 'kibble' } }),
    );

    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { code: string } }).error.code).toBe('CHARACTER_DIED');

    // The death is committed even though the request failed — the error is raised after the
    // transaction, precisely so throwing cannot roll the rebirth back.
    expect((await characterRow(player)).rebirth_count).toBe(1);
    expect(frames.some((frame) => frame.type === 'character:rebirth')).toBe(true);
  });

  it('lets an ordinary action through untouched on a living pet', async () => {
    const player = await makePlayer();
    await setState(player, { hunger: 40 }, 0);
    connect(player);

    const response = await app.inject(
      authed(player, { method: 'POST', url: '/api/v1/characters/me/actions/feed', payload: { itemId: 'kibble' } }),
    );

    // Paired with the test above so neither can pass vacuously.
    expect(response.statusCode, response.body).toBe(200);
    expect((await characterRow(player)).rebirth_count).toBe(0);
  });
});
