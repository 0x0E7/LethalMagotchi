import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RandomOpponentResponse } from '@lethalmagotchi/shared';
import type { Db } from '../../src/db/pool.js';
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
 * "Random opponent" is the one duel surface that picks *for* the player, so it is the one
 * that has to apply every floor `duel:invite` applies. Offering someone the server will then
 * refuse is worse than offering nobody: the player reads it as the button being broken.
 */

interface Player extends TestAccount {
  characterId: string;
  nickname: string;
}

let app: FastifyInstance;
let hub: Hub;
let db: Db;

beforeAll(async () => {
  db = testPool();
  hub = new Hub();
  ({ app } = await createTestApp({ hub }));
});

afterAll(async () => {
  await app.close();
  await closeTestPool();
});

// The hub is shared by every test in this file, and an online character left behind would
// silently become a candidate for the next one.
afterEach(() => {
  for (const id of [...hub.onlineCharacterIds()]) offline(id);
});

const connections = new Map<string, string>();

function online(player: Player): void {
  const id = randomUUID();
  connections.set(player.characterId, id);
  hub.add({
    id,
    accountId: player.accountId,
    characterId: player.characterId,
    socket: { send: () => {}, close: () => {} },
  });
}

function offline(characterId: string): void {
  const id = connections.get(characterId);
  if (id) hub.remove(id);
  connections.delete(characterId);
}

/** Duels read the character's own age, and a test cannot wait a day for it. */
async function age(player: Player, hours = 48): Promise<void> {
  await db.query(`UPDATE characters SET created_at = now() - make_interval(hours => $2) WHERE id = $1`, [
    player.characterId,
    hours,
  ]);
}

async function makePlayer(label: string, aged = true): Promise<Player> {
  const account = await registerAccount(app, { username: uniqueUsername('rnd') });
  const nickname = `${label}${randomUUID().slice(0, 6)}`;
  const response = await app.inject(
    authed(account, {
      method: 'POST',
      url: '/api/v1/characters',
      payload: { ...VALID_CHARACTER, nickname },
    }),
  );
  expect(response.statusCode, response.body).toBe(201);
  const player: Player = { ...account, characterId: response.json().character.id, nickname };
  if (aged) await age(player);
  return player;
}

async function roll(viewer: Player): Promise<RandomOpponentResponse> {
  const response = await app.inject(authed(viewer, { method: 'GET', url: '/api/v1/duels/random' }));
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as RandomOpponentResponse;
}

describe('a random duel opponent', () => {
  it('offers someone who is online and able to fight', async () => {
    const viewer = await makePlayer('Seeker');
    const target = await makePlayer('Willing');
    online(target);

    const { card } = await roll(viewer);
    expect(card?.characterId).toBe(target.characterId);
    expect(card?.duelEligible).toBe(true);
  });

  it('offers nobody when nobody is online', async () => {
    const viewer = await makePlayer('Alone');
    await makePlayer('Elsewhere'); // aged and eligible, but not at the keyboard

    // Not an error: an invite expires in a minute, so an absent opponent is no opponent.
    expect((await roll(viewer)).card).toBeNull();
  });

  it('never offers the viewer themselves', async () => {
    const viewer = await makePlayer('Narcissus');
    online(viewer);

    expect((await roll(viewer)).card).toBeNull();
  });

  it('skips a character under the 24h age floor', async () => {
    const viewer = await makePlayer('Veteran');
    const fresh = await makePlayer('Hatchling', false);
    online(fresh);

    expect((await roll(viewer)).card).toBeNull();
  });

  it('skips a character already engaged elsewhere', async () => {
    const viewer = await makePlayer('Patient');
    const busy = await makePlayer('Occupied');
    online(busy);
    await db.query('UPDATE characters SET active_duel_id = gen_random_uuid() WHERE id = $1', [
      busy.characterId,
    ]);

    expect((await roll(viewer)).card).toBeNull();
  });

  it('skips a block in either direction', async () => {
    const viewer = await makePlayer('Blocker');
    const blocked = await makePlayer('Blocked');
    online(blocked);

    // Blocked *by* the candidate, not by the viewer — the check is symmetric, and the
    // asymmetric version would let a block be walked around by rolling the dice.
    await db.query(
      'INSERT INTO chat_blocks (blocker_account_id, blocked_account_id) VALUES ($1, $2)',
      [blocked.accountId, viewer.accountId],
    );

    expect((await roll(viewer)).card).toBeNull();
  });

  it('respects the per-pair decline cooldown', async () => {
    const viewer = await makePlayer('Rejected');
    const refuser = await makePlayer('Refuser');
    online(refuser);

    await db.query(
      `INSERT INTO duel_invites (id, from_character_id, to_character_id, state, expires_at, resolved_at, stake_coins)
       VALUES ($1, $2, $3, 'declined', now(), now(), 0)`,
      [randomUUID(), viewer.characterId, refuser.characterId],
    );

    // Otherwise the dice hand back the one person who has just said no, which is exactly
    // the repeat-targeting the cooldown exists to stop.
    expect((await roll(viewer)).card).toBeNull();
  });

  it('offers nobody to a viewer who is under the age floor themselves', async () => {
    const fresh = await makePlayer('Newcomer', false);
    const willing = await makePlayer('Available');
    online(willing);

    // Their own floor, checked before anyone else's: showing them an opponent they cannot
    // challenge would be a worse answer than an honest empty one.
    expect((await roll(fresh)).card).toBeNull();
  });

  it('offers nobody while the viewer is engaged elsewhere', async () => {
    const viewer = await makePlayer('Seated');
    const willing = await makePlayer('Waiting');
    online(willing);
    await db.query('UPDATE characters SET seated_table_id = gen_random_uuid() WHERE id = $1', [
      viewer.characterId,
    ]);

    expect((await roll(viewer)).card).toBeNull();
  });

  it('picks from the whole eligible field, not always the same row', async () => {
    const viewer = await makePlayer('Roller');
    const field = await Promise.all([
      makePlayer('OptionA'),
      makePlayer('OptionB'),
      makePlayer('OptionC'),
      makePlayer('OptionD'),
    ]);
    for (const player of field) online(player);

    const seen = new Set<string>();
    for (let i = 0; i < 25; i += 1) seen.add((await roll(viewer)).card?.characterId ?? 'none');

    expect(seen.has('none')).toBe(false);
    // 25 draws from 4 candidates hitting only one is ~1 in 10^14, so this is a real signal
    // rather than a flake waiting to happen.
    expect(seen.size).toBeGreaterThan(1);
  });

  it('needs a character, and a session', async () => {
    const accountOnly = await registerAccount(app, { username: uniqueUsername('rnd') });
    const withoutCharacter = await app.inject(
      authed(accountOnly, { method: 'GET', url: '/api/v1/duels/random' }),
    );
    expect(withoutCharacter.statusCode).toBe(404);
    expect((withoutCharacter.json() as { error: { code: string } }).error.code).toBe('NO_CHARACTER');

    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/duels/random' });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('the directory card', () => {
  it('reports an absent player as unavailable rather than eligible', async () => {
    const viewer = await makePlayer('Looker');
    const away = await makePlayer('Away');

    const response = await app.inject(
      authed(viewer, { method: 'GET', url: `/api/v1/players?q=${encodeURIComponent(away.nickname)}` }),
    );
    expect(response.statusCode, response.body).toBe(200);
    const card = (response.json() as { cards: { duelEligible: boolean; duelBlockedReason: string | null }[] })
      .cards[0];

    // The floor the card used to ignore: `duel:invite` refuses an offline target, so a card
    // that called them eligible offered a challenge that could only fail.
    expect(card?.duelEligible).toBe(false);
    expect(card?.duelBlockedReason).toBe('offline');
  });

  it('says why a raid is refused, not merely that it is', async () => {
    const viewer = await makePlayer('Raider');
    const target = await makePlayer('Mark');
    online(target);

    const read = async () => {
      const response = await app.inject(
        authed(viewer, { method: 'GET', url: `/api/v1/players?q=${encodeURIComponent(target.nickname)}` }),
      );
      return (
        response.json() as { cards: { raidEligible: boolean; raidBlockedReason: string | null }[] }
      ).cards[0]!;
    };

    // Characters start at 5 coins, which clears the `broke` floor, so an aged target is
    // raidable on its own merits.
    expect(await read()).toMatchObject({ raidEligible: true, raidBlockedReason: null });

    // Nothing worth taking. A raid on an empty wallet is griefing with no economic content,
    // and this is also what shields a beggar from being farmed through repeat bankruptcy.
    await db.query('UPDATE characters SET lethal_coins = 0 WHERE id = $1', [target.characterId]);
    expect(await read()).toMatchObject({ raidEligible: false, raidBlockedReason: 'too_poor' });

    // Immunity outranks poverty: they were just robbed, which is why they have nothing.
    await db.query(
      `UPDATE characters SET raid_immunity_until = now() + interval '12 hours' WHERE id = $1`,
      [target.characterId],
    );
    expect(await read()).toMatchObject({ raidEligible: false, raidBlockedReason: 'immune' });

    // And the age floor outranks both — the longest wait is the honest one to report.
    await db.query('UPDATE characters SET created_at = now() WHERE id = $1', [target.characterId]);
    expect(await read()).toMatchObject({ raidEligible: false, raidBlockedReason: 'too_new' });
  });

  it('reports a present player as eligible', async () => {
    const viewer = await makePlayer('Looker');
    const here = await makePlayer('Here');
    online(here);

    const response = await app.inject(
      authed(viewer, { method: 'GET', url: `/api/v1/players?q=${encodeURIComponent(here.nickname)}` }),
    );
    const card = (response.json() as { cards: { duelEligible: boolean; duelBlockedReason: string | null }[] })
      .cards[0];

    // Paired with the test above so neither can pass vacuously.
    expect(card?.duelEligible).toBe(true);
    expect(card?.duelBlockedReason).toBeNull();
  });
});
