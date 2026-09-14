import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DONATION_APPEAL_COOLDOWN_MS, TOWN_SQUARE_CHANNEL_ID } from '@lethalmagotchi/shared';
import type { Db } from '../../src/db/pool.js';
import type { Limiters } from '../../src/deps.js';
import { RateLimiter } from '../../src/rate-limit.js';
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
import { TestClient, closeAll } from '../helpers/ws.js';

interface Player extends TestAccount {
  characterId: string;
  nickname: string;
}

let db: Db;
let seed = 0;

/** The Town Square is long-lived and shared, so a fixture name has to be unique per run. */
const RUN = randomUUID().slice(0, 6);

beforeAll(() => {
  db = testPool();
});

afterAll(async () => {
  await closeTestPool();
});

async function boot(options: { limiters?: Limiters } = {}) {
  const limiters = options.limiters ?? relaxedLimiters();
  const built = await createTestApp({ limiters });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const address = built.app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    ...built,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await built.raids.stop();
      await built.app.close();
    },
  };
}

async function makePlayer(app: FastifyInstance, label: string, coins: number): Promise<Player> {
  seed += 1;
  const nickname = `${label}${seed}-${RUN}`;
  const account = await registerAccount(app, { username: uniqueUsername('don') });
  const response = await app.inject(
    authed(account, { method: 'POST', url: '/api/v1/characters', payload: { ...VALID_CHARACTER, nickname } }),
  );
  expect(response.statusCode, response.body).toBe(201);
  const characterId = response.json().character.id as string;
  await db.query('UPDATE characters SET lethal_coins = $2 WHERE id = $1', [characterId, coins]);
  return { ...account, characterId, nickname };
}

async function coinsOf(characterId: string): Promise<number> {
  const result = await db.query<{ lethal_coins: number }>(
    'SELECT lethal_coins FROM characters WHERE id = $1',
    [characterId],
  );
  return result.rows[0]!.lethal_coins;
}

function donate(app: FastifyInstance, donor: TestAccount, toCharacterId: string, coins: number) {
  return app.inject(
    authed(donor, { method: 'POST', url: '/api/v1/donations', payload: { toCharacterId, coins } }),
  );
}

describe('who may receive a donation', () => {
  it('lands on a beggar, moves both wallets in one step, and records the row', async () => {
    const booted = await boot();
    try {
      const donor = await makePlayer(booted.app, 'Rich', 30);
      const beggar = await makePlayer(booted.app, 'Broke', 0);

      const response = await donate(booted.app, donor, beggar.characterId, 7);
      expect(response.statusCode, response.body).toBe(201);
      const body = response.json();
      expect(body.donation.coins).toBe(7);
      expect(body.character.lethalCoins).toBe(23);
      expect(body.character.isBeggar).toBe(false);

      expect(await coinsOf(donor.characterId)).toBe(23);
      expect(await coinsOf(beggar.characterId)).toBe(7);

      const rows = await db.query<{ coins: number; from_character_id: string; to_character_id: string }>(
        'SELECT coins, from_character_id, to_character_id FROM donations WHERE id = $1',
        [body.donation.id],
      );
      expect(rows.rows[0]).toEqual({
        coins: 7,
        from_character_id: donor.characterId,
        to_character_id: beggar.characterId,
      });
    } finally {
      await booted.close();
    }
  });

  it('refuses anyone who is not currently a beggar', async () => {
    const booted = await boot();
    try {
      const donor = await makePlayer(booted.app, 'Rich', 30);
      const solvent = await makePlayer(booted.app, 'Fine', 1);

      const response = await donate(booted.app, donor, solvent.characterId, 5);
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('NOT_A_BEGGAR');
      // A single coin is the whole of the difference between eligible and not.
      expect(await coinsOf(donor.characterId)).toBe(30);
      expect(await coinsOf(solvent.characterId)).toBe(1);
    } finally {
      await booted.close();
    }
  });

  it('refuses a donation from the recipient\'s own account, not merely their own character', async () => {
    const booted = await boot();
    try {
      const player = await makePlayer(booted.app, 'Solo', 20);
      const response = await donate(booted.app, player, player.characterId, 5);
      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe('SELF_DONATION');
      expect(await coinsOf(player.characterId)).toBe(20);
    } finally {
      await booted.close();
    }
  });

  it('refuses a donor who does not hold the coins, and one committed elsewhere', async () => {
    const booted = await boot();
    try {
      const donor = await makePlayer(booted.app, 'Thin', 3);
      const beggar = await makePlayer(booted.app, 'Broke', 0);

      const overdraft = await donate(booted.app, donor, beggar.characterId, 4);
      expect(overdraft.statusCode).toBe(402);
      expect(overdraft.json().error.code).toBe('INSUFFICIENT_FUNDS');
      expect(await coinsOf(beggar.characterId)).toBe(0);

      await db.query('UPDATE characters SET active_raid_id = $2 WHERE id = $1', [
        donor.characterId,
        '00000000-0000-0000-0000-0000000000ff',
      ]);
      const committed = await donate(booted.app, donor, beggar.characterId, 1);
      expect(committed.statusCode).toBe(409);
      expect(committed.json().error.code).toBe('CHARACTER_IN_RAID');
      expect(await coinsOf(donor.characterId)).toBe(3);
    } finally {
      await booted.close();
    }
  });

  it('refuses zero and negative amounts before they reach the transaction', async () => {
    const booted = await boot();
    try {
      const donor = await makePlayer(booted.app, 'Rich', 30);
      const beggar = await makePlayer(booted.app, 'Broke', 0);

      for (const coins of [0, -5, 1.5]) {
        const response = await donate(booted.app, donor, beggar.characterId, coins);
        expect(response.statusCode, `coins=${coins}`).toBe(422);
      }
      expect(await coinsOf(donor.characterId)).toBe(30);
      expect(await coinsOf(beggar.characterId)).toBe(0);
    } finally {
      await booted.close();
    }
  });
});

describe('the one-rescue property', () => {
  it('commits exactly one of two concurrent donations to the same beggar', async () => {
    const booted = await boot();
    try {
      const first = await makePlayer(booted.app, 'One', 50);
      const second = await makePlayer(booted.app, 'Two', 50);
      const beggar = await makePlayer(booted.app, 'Broke', 0);

      const [a, b] = await Promise.all([
        donate(booted.app, first, beggar.characterId, 10),
        donate(booted.app, second, beggar.characterId, 10),
      ]);

      const statuses = [a.statusCode, b.statusCode].sort();
      // Exactly one commits; the other finds a recipient who is no longer a beggar.
      expect(statuses).toEqual([201, 409]);
      const loser = a.statusCode === 409 ? a : b;
      expect(loser.json().error.code).toBe('NOT_A_BEGGAR');

      expect(await coinsOf(beggar.characterId)).toBe(10);
      const wallets = [await coinsOf(first.characterId), await coinsOf(second.characterId)].sort();
      expect(wallets).toEqual([40, 50]);
      // Wallet conservation across all three, exactly.
      expect(
        (await coinsOf(first.characterId)) +
          (await coinsOf(second.characterId)) +
          (await coinsOf(beggar.characterId)),
      ).toBe(100);

      const rows = await db.query('SELECT 1 FROM donations WHERE to_character_id = $1', [
        beggar.characterId,
      ]);
      expect(rows.rowCount).toBe(1);
    } finally {
      await booted.close();
    }
  });

  it('re-opens the state only when the rescued player is broke again', async () => {
    const booted = await boot();
    try {
      const donor = await makePlayer(booted.app, 'Rich', 50);
      const beggar = await makePlayer(booted.app, 'Broke', 0);

      expect((await donate(booted.app, donor, beggar.characterId, 2)).statusCode).toBe(201);
      expect((await donate(booted.app, donor, beggar.characterId, 2)).statusCode).toBe(409);

      // Spending back down to nothing is the same condition, reached a different way.
      await db.query('UPDATE characters SET lethal_coins = 0 WHERE id = $1', [beggar.characterId]);
      expect((await donate(booted.app, donor, beggar.characterId, 2)).statusCode).toBe(201);
      expect(await coinsOf(beggar.characterId)).toBe(2);
    } finally {
      await booted.close();
    }
  });
});

describe('the appeal', () => {
  it('posts a Town Square system line every connected player sees', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const beggar = await makePlayer(booted.app, 'Broke', 0);
      const bystander = await makePlayer(booted.app, 'Watch', 10);
      const listener = await TestClient.connect(booted.baseUrl, bystander.accessToken);
      clients.push(listener);

      const response = await booted.app.inject(
        authed(beggar, { method: 'POST', url: '/api/v1/appeals', payload: {} }),
      );
      expect(response.statusCode, response.body).toBe(201);

      const line = await listener.next('chat:message');
      expect(line.channelId).toBe(TOWN_SQUARE_CHANNEL_ID);
      expect(line.message.body).toBe(`${beggar.nickname} is begging for coins.`);
      // A system line has no author account, so there is nobody to have blocked.
      expect(line.message.authorAccountId).toBeNull();
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('refuses anyone who is not a beggar', async () => {
    const booted = await boot();
    try {
      const solvent = await makePlayer(booted.app, 'Fine', 1);
      const response = await booted.app.inject(
        authed(solvent, { method: 'POST', url: '/api/v1/appeals', payload: {} }),
      );
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('NOT_A_BEGGAR');
    } finally {
      await booted.close();
    }
  });

  // The floor is a column, not an in-process window, so the limiters here are deliberately
  // wide open: what refuses the second appeal is the row.
  it('holds the three-hour cooldown per character, across separate requests', async () => {
    const booted = await boot({ limiters: relaxedLimiters() });
    try {
      const beggar = await makePlayer(booted.app, 'Broke', 0);

      const first = await booted.app.inject(
        authed(beggar, { method: 'POST', url: '/api/v1/appeals', payload: {} }),
      );
      expect(first.statusCode).toBe(201);

      const second = await booted.app.inject(
        authed(beggar, { method: 'POST', url: '/api/v1/appeals', payload: {} }),
      );
      expect(second.statusCode).toBe(429);
      expect(second.json().error.retryAfterSeconds).toBeGreaterThan(60 * 60);

      // A second, unrelated beggar has their own budget: the cooldown is per character.
      const other = await makePlayer(booted.app, 'AlsoBroke', 0);
      const theirs = await booted.app.inject(
        authed(other, { method: 'POST', url: '/api/v1/appeals', payload: {} }),
      );
      expect(theirs.statusCode).toBe(201);

      // Only one line reached the Town Square from the first beggar.
      const lines = await db.query('SELECT 1 FROM chat_messages WHERE body = $1', [
        `${beggar.nickname} is begging for coins.`,
      ]);
      expect(lines.rowCount).toBe(1);
    } finally {
      await booted.close();
    }
  });
});

describe('the beggar badge on the public card', () => {
  it('is derived from the wallet, and carries a band instead of a balance', async () => {
    const booted = await boot();
    try {
      const viewer = await makePlayer(booted.app, 'View', 10);
      const beggar = await makePlayer(booted.app, 'Broke', 0);
      const wealthy = await makePlayer(booted.app, 'Loaded', 8_317);

      const response = await booted.app.inject(
        authed(viewer, {
          method: 'GET',
          url: `/api/v1/duels/cards?characterIds=${beggar.characterId},${wealthy.characterId}`,
        }),
      );
      expect(response.statusCode).toBe(200);
      // The exact balance is nowhere in the payload, in any field.
      expect(response.body).not.toContain('8317');
      expect(response.body).not.toContain('lethalCoins');

      const cards = response.json().cards as {
        characterId: string;
        isBeggar: boolean;
        wealthBand: string;
        raidEligible: boolean;
      }[];
      const broke = cards.find((card) => card.characterId === beggar.characterId)!;
      const loaded = cards.find((card) => card.characterId === wealthy.characterId)!;

      expect(broke).toMatchObject({ isBeggar: true, wealthBand: 'broke' });
      // A beggar is below the wealth floor, so they are shielded from being raided too.
      expect(broke.raidEligible).toBe(false);
      expect(loaded).toMatchObject({ isBeggar: false, wealthBand: 'wealthy' });

      // One coin lifts the badge, with nothing to expire and nothing to sweep.
      await db.query('UPDATE characters SET lethal_coins = 1 WHERE id = $1', [beggar.characterId]);
      const after = await booted.app.inject(
        authed(viewer, { method: 'GET', url: `/api/v1/duels/cards?characterIds=${beggar.characterId}` }),
      );
      expect(after.json().cards[0].isBeggar).toBe(false);
    } finally {
      await booted.close();
    }
  });
});
