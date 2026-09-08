import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { TOWN_SQUARE_CHANNEL_ID, dmChannelKey, type ChatChannelDto } from '@lethalmagotchi/shared';
import { ChatRetentionJob } from '../../src/chat/retention.js';
import type { Db } from '../../src/db/pool.js';
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

interface Player extends TestAccount {
  characterId: string;
  nickname: string;
}

let app: FastifyInstance;
let db: Db;

beforeAll(async () => {
  db = testPool();
  ({ app } = await createTestApp());
});

afterAll(async () => {
  await app.close();
  await closeTestPool();
});

async function makePlayer(nickname: string, instance: FastifyInstance = app): Promise<Player> {
  const account = await registerAccount(instance, { username: uniqueUsername('chat') });
  const response = await instance.inject(
    authed(account, {
      method: 'POST',
      url: '/api/v1/characters',
      payload: { ...VALID_CHARACTER, nickname },
    }),
  );
  expect(response.statusCode, response.body).toBe(201);
  return { ...account, characterId: response.json().character.id, nickname };
}

async function openDm(from: Player, to: Player, instance: FastifyInstance = app) {
  return instance.inject(
    authed(from, { method: 'POST', url: '/api/v1/chat/dm', payload: { targetAccountId: to.accountId } }),
  );
}

async function seedMessage(channelId: string, author: Player, body: string, createdAt?: Date): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO chat_messages (id, channel_id, author_account_id, author_character_id, author_name_snapshot, body, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, COALESCE($6, now()))
     RETURNING id`,
    [channelId, author.accountId, author.characterId, author.nickname, body, createdAt ?? null],
  );
  return result.rows[0]!.id;
}

describe('GET /api/v1/chat/channels', () => {
  it('always includes the Town Square once the caller has a character', async () => {
    const player = await makePlayer('Miso');
    const response = await app.inject(authed(player, { method: 'GET', url: '/api/v1/chat/channels' }));

    expect(response.statusCode).toBe(200);
    const channels: ChatChannelDto[] = response.json().channels;
    const town = channels.find((channel) => channel.id === TOWN_SQUARE_CHANNEL_ID);
    expect(town).toMatchObject({ kind: 'global', name: 'Town Square', counterpart: null });
  });

  it('refuses an account with no character', async () => {
    const account = await registerAccount(app, { username: uniqueUsername('nochar') });
    const response = await app.inject(authed(account, { method: 'GET', url: '/api/v1/chat/channels' }));

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NO_CHARACTER');
  });

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/chat/channels' });
    expect(response.statusCode).toBe(401);
  });

  it('lists the caller DMs with the other participant as the label', async () => {
    const alice = await makePlayer('Alice');
    const bob = await makePlayer('Bob');
    await openDm(alice, bob);

    const response = await app.inject(authed(alice, { method: 'GET', url: '/api/v1/chat/channels' }));
    const dm = (response.json().channels as ChatChannelDto[]).find((channel) => channel.kind === 'dm');
    expect(dm?.counterpart).toMatchObject({ accountId: bob.accountId, nickname: 'Bob' });
    expect(dm?.name).toBeNull();
  });

  it('never lists a DM the caller is not part of', async () => {
    const alice = await makePlayer('Ada');
    const bob = await makePlayer('Bo');
    const carol = await makePlayer('Cy');
    const opened = await openDm(alice, bob);
    const channelId = opened.json().channel.id;

    const response = await app.inject(authed(carol, { method: 'GET', url: '/api/v1/chat/channels' }));
    const ids = (response.json().channels as ChatChannelDto[]).map((channel) => channel.id);
    expect(ids).not.toContain(channelId);
  });
});

describe('POST /api/v1/chat/dm', () => {
  it('creates a channel and is idempotent from either side', async () => {
    const alice = await makePlayer('Rosa');
    const bob = await makePlayer('Kit');

    const first = await openDm(alice, bob);
    expect(first.statusCode).toBe(201);

    const again = await openDm(alice, bob);
    expect(again.statusCode).toBe(200);
    expect(again.json().channel.id).toBe(first.json().channel.id);

    const fromBob = await openDm(bob, alice);
    expect(fromBob.statusCode).toBe(200);
    expect(fromBob.json().channel.id).toBe(first.json().channel.id);
  });

  it('produces exactly one channel row under concurrent calls', async () => {
    const alice = await makePlayer('Nim');
    const bob = await makePlayer('Pip');

    const responses = await Promise.all(Array.from({ length: 8 }, () => openDm(alice, bob)));
    for (const response of responses) expect([200, 201]).toContain(response.statusCode);

    const rows = await db.query('SELECT id FROM chat_channels WHERE key = $1', [
      dmChannelKey(alice.accountId, bob.accountId),
    ]);
    expect(rows.rowCount).toBe(1);

    const created = responses.filter((response) => response.statusCode === 201);
    expect(created).toHaveLength(1);

    const members = await db.query('SELECT account_id FROM chat_channel_members WHERE channel_id = $1', [
      responses[0]!.json().channel.id,
    ]);
    expect(members.rowCount).toBe(2);
  });

  it('refuses a DM with yourself', async () => {
    const alice = await makePlayer('Solo');
    const response = await openDm(alice, alice);
    expect(response.statusCode).toBe(422);
  });

  it('404s for a player who does not exist', async () => {
    const alice = await makePlayer('Seeker');
    const response = await app.inject(
      authed(alice, {
        method: 'POST',
        url: '/api/v1/chat/dm',
        payload: { targetAccountId: '018f3a00-0000-7000-8000-0000000000ff' },
      }),
    );
    expect(response.statusCode).toBe(404);
  });

  it('rejects a non-uuid target', async () => {
    const alice = await makePlayer('Typo');
    const response = await app.inject(
      authed(alice, { method: 'POST', url: '/api/v1/chat/dm', payload: { targetAccountId: 'nope' } }),
    );
    expect(response.statusCode).toBe(422);
  });

  it('refuses when the caller has blocked the target', async () => {
    const alice = await makePlayer('Bl1');
    const bob = await makePlayer('Bl2');
    await app.inject(
      authed(alice, { method: 'POST', url: '/api/v1/blocks', payload: { blockedAccountId: bob.accountId } }),
    );

    const response = await openDm(alice, bob);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('BLOCKED');
  });

  it('refuses when the target has blocked the caller', async () => {
    const alice = await makePlayer('Bl3');
    const bob = await makePlayer('Bl4');
    await app.inject(
      authed(bob, { method: 'POST', url: '/api/v1/blocks', payload: { blockedAccountId: alice.accountId } }),
    );

    const response = await openDm(alice, bob);
    expect(response.statusCode).toBe(403);
  });

  it('caps new conversations per hour without charging for existing ones', async () => {
    const limiters = relaxedLimiters();
    limiters.chatDmCreate = new RateLimiter({ limit: 3, windowMs: 60 * 60_000 });
    const { app: limited } = await createTestApp({ limiters });

    try {
      const spammer = await makePlayer('Spam', limited);
      const targets = await Promise.all([
        makePlayer('T1', limited),
        makePlayer('T2', limited),
        makePlayer('T3', limited),
        makePlayer('T4', limited),
      ]);

      for (const target of targets.slice(0, 3)) {
        expect((await openDm(spammer, target, limited)).statusCode).toBe(201);
      }

      const refused = await openDm(spammer, targets[3]!, limited);
      expect(refused.statusCode).toBe(429);
      expect(refused.json().error.code).toBe('RATE_LIMITED');

      // Re-opening one that already exists costs nothing.
      expect((await openDm(spammer, targets[0]!, limited)).statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });
});

describe('GET /api/v1/chat/channels/:id/messages', () => {
  it('pages back with a keyset cursor, 50 rows at a time', async () => {
    const alice = await makePlayer('Pager');
    const bob = await makePlayer('Paged');
    const channelId = (await openDm(alice, bob)).json().channel.id;

    const base = Date.now() - 120 * 60_000;
    for (let index = 0; index < 60; index += 1) {
      await seedMessage(channelId, alice, `line ${index}`, new Date(base + index * 1_000));
    }

    const first = await app.inject(
      authed(alice, { method: 'GET', url: `/api/v1/chat/channels/${channelId}/messages` }),
    );
    expect(first.statusCode).toBe(200);
    expect(first.json().messages).toHaveLength(50);
    expect(first.json().hasMore).toBe(true);
    expect(first.json().messages[0].body).toBe('line 10');
    expect(first.json().messages.at(-1).body).toBe('line 59');

    const oldest = first.json().messages[0].id;
    const second = await app.inject(
      authed(alice, { method: 'GET', url: `/api/v1/chat/channels/${channelId}/messages?before=${oldest}` }),
    );
    expect(second.json().messages).toHaveLength(10);
    expect(second.json().hasMore).toBe(false);
    expect(second.json().messages.at(-1).body).toBe('line 9');
  });

  /**
   * A cursor is a message id, and resolving one outside its own channel makes the endpoint
   * answer "does this id exist, and roughly when" for conversations the caller cannot read.
   * It leaks no bodies, but it is an oracle, so a foreign id must be indistinguishable from
   * one that was never a message at all.
   */
  it('treats a cursor from another channel exactly like an unknown id', async () => {
    const alice = await makePlayer('Cur1');
    const bob = await makePlayer('Cur2');
    const carol = await makePlayer('Cur3');
    const dmId = (await openDm(alice, bob)).json().channel.id;
    const dmBody = `dm-cursor-${randomUUID()}`;
    const dmMessageId = await seedMessage(dmId, alice, dmBody);
    await seedMessage(TOWN_SQUARE_CHANNEL_ID, alice, `town-cursor-${randomUUID()}`);

    const town = `/api/v1/chat/channels/${TOWN_SQUARE_CHANNEL_ID}/messages`;
    const foreign = await app.inject(authed(carol, { method: 'GET', url: `${town}?before=${dmMessageId}` }));
    const unknown = await app.inject(authed(carol, { method: 'GET', url: `${town}?before=${randomUUID()}` }));

    expect(foreign.statusCode).toBe(200);
    expect(foreign.json()).toEqual(unknown.json());
    expect(foreign.json()).toEqual({ messages: [], hasMore: false });
    expect(foreign.body).not.toContain(dmBody);
  });

  it('caps limit at the page maximum', async () => {
    const alice = await makePlayer('Greedy');
    const response = await app.inject(
      authed(alice, {
        method: 'GET',
        url: `/api/v1/chat/channels/${TOWN_SQUARE_CHANNEL_ID}/messages?limit=5000`,
      }),
    );
    expect(response.statusCode).toBe(422);
  });

  it('refuses history for a DM the caller is not a member of', async () => {
    const alice = await makePlayer('Ins1');
    const bob = await makePlayer('Ins2');
    const carol = await makePlayer('Ins3');
    const channelId = (await openDm(alice, bob)).json().channel.id;
    await seedMessage(channelId, alice, 'a private thing');

    const response = await app.inject(
      authed(carol, { method: 'GET', url: `/api/v1/chat/channels/${channelId}/messages` }),
    );
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('a private thing');
  });

  it('lets anyone with a character read the Town Square', async () => {
    const alice = await makePlayer('Towny');
    const response = await app.inject(
      authed(alice, { method: 'GET', url: `/api/v1/chat/channels/${TOWN_SQUARE_CHANNEL_ID}/messages` }),
    );
    expect(response.statusCode).toBe(200);
  });

  it('hides messages from an author the caller has blocked', async () => {
    const alice = await makePlayer('Hider');
    const loud = await makePlayer('Loud');
    // The Town Square is one long-lived channel shared by every run, so the marker has to be
    // unique or an identical line written by an earlier run's account fails the assertion.
    const marker = `shouty-${randomUUID()}`;
    await seedMessage(TOWN_SQUARE_CHANNEL_ID, loud, marker);

    const before = await app.inject(
      authed(alice, { method: 'GET', url: `/api/v1/chat/channels/${TOWN_SQUARE_CHANNEL_ID}/messages` }),
    );
    expect(before.body).toContain(marker);

    await app.inject(
      authed(alice, { method: 'POST', url: '/api/v1/blocks', payload: { blockedAccountId: loud.accountId } }),
    );

    const after = await app.inject(
      authed(alice, { method: 'GET', url: `/api/v1/chat/channels/${TOWN_SQUARE_CHANNEL_ID}/messages` }),
    );
    expect(after.body).not.toContain(marker);
  });
});

describe('blocks', () => {
  it('is idempotent and reversible', async () => {
    const alice = await makePlayer('Bk1');
    const bob = await makePlayer('Bk2');

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.inject(
        authed(alice, { method: 'POST', url: '/api/v1/blocks', payload: { blockedAccountId: bob.accountId } }),
      );
      expect(response.statusCode).toBe(204);
    }

    const removed = await app.inject(
      authed(alice, { method: 'DELETE', url: `/api/v1/blocks/${bob.accountId}` }),
    );
    expect(removed.statusCode).toBe(204);
    expect((await openDm(alice, bob)).statusCode).toBe(201);
  });

  it('refuses blocking yourself', async () => {
    const alice = await makePlayer('Bk3');
    const response = await app.inject(
      authed(alice, { method: 'POST', url: '/api/v1/blocks', payload: { blockedAccountId: alice.accountId } }),
    );
    expect(response.statusCode).toBe(422);
  });

  it('404s blocking an account that does not exist', async () => {
    const alice = await makePlayer('Bk4');
    const response = await app.inject(
      authed(alice, {
        method: 'POST',
        url: '/api/v1/blocks',
        payload: { blockedAccountId: '018f3a00-0000-7000-8000-0000000000fe' },
      }),
    );
    expect(response.statusCode).toBe(404);
  });

  it('surfaces the block on the channel the blocker sees', async () => {
    const alice = await makePlayer('Bk5');
    const bob = await makePlayer('Bk6');
    const channelId = (await openDm(alice, bob)).json().channel.id;
    await app.inject(
      authed(alice, { method: 'POST', url: '/api/v1/blocks', payload: { blockedAccountId: bob.accountId } }),
    );

    const mine = await app.inject(authed(alice, { method: 'GET', url: '/api/v1/chat/channels' }));
    const channel = (mine.json().channels as ChatChannelDto[]).find((entry) => entry.id === channelId);
    expect(channel?.blockedByMe).toBe(true);

    // The blocked player is deliberately not told, so blocking is not a signal.
    const theirs = await app.inject(authed(bob, { method: 'GET', url: '/api/v1/chat/channels' }));
    const theirChannel = (theirs.json().channels as ChatChannelDto[]).find((entry) => entry.id === channelId);
    expect(theirChannel?.blockedByMe).toBe(false);
  });
});

describe('character deletion', () => {
  it('keeps the messages, leaves the membership, and archives the DM', async () => {
    const alice = await makePlayer('Leaver');
    const bob = await makePlayer('Stayer');
    const channelId = (await openDm(alice, bob)).json().channel.id;
    await seedMessage(channelId, alice, 'still here afterwards');

    const deleted = await app.inject(authed(alice, { method: 'DELETE', url: '/api/v1/characters/me' }));
    expect(deleted.statusCode).toBe(204);

    const messages = await db.query('SELECT id FROM chat_messages WHERE channel_id = $1', [channelId]);
    expect(messages.rowCount).toBe(1);

    const channel = await db.query<{ archived_at: Date | null }>(
      'SELECT archived_at FROM chat_channels WHERE id = $1',
      [channelId],
    );
    expect(channel.rows[0]?.archived_at).not.toBeNull();

    const bobsView = await app.inject(authed(bob, { method: 'GET', url: '/api/v1/chat/channels' }));
    const dm = (bobsView.json().channels as ChatChannelDto[]).find((entry) => entry.id === channelId);
    expect(dm?.archivedAt).not.toBeNull();
    // The counterpart has no active character any more, so the client renders a placeholder.
    expect(dm?.counterpart?.nickname).toBe('');
  });

  it('reopens the conversation when the player builds a new character', async () => {
    const alice = await makePlayer('Returner');
    const bob = await makePlayer('Patient');
    const channelId = (await openDm(alice, bob)).json().channel.id;

    await app.inject(authed(alice, { method: 'DELETE', url: '/api/v1/characters/me' }));
    const rebuilt = await app.inject(
      authed(alice, {
        method: 'POST',
        url: '/api/v1/characters',
        payload: { ...VALID_CHARACTER, nickname: 'Returned' },
      }),
    );
    expect(rebuilt.statusCode).toBe(201);

    const channel = await db.query<{ archived_at: Date | null }>(
      'SELECT archived_at FROM chat_channels WHERE id = $1',
      [channelId],
    );
    expect(channel.rows[0]?.archived_at).toBeNull();

    const mine = await app.inject(authed(alice, { method: 'GET', url: '/api/v1/chat/channels' }));
    expect((mine.json().channels as ChatChannelDto[]).map((entry) => entry.id)).toContain(channelId);
  });
});

describe('retention purge', () => {
  it('drops Town Square messages past the window and keeps DM history forever', async () => {
    const alice = await makePlayer('Old');
    const bob = await makePlayer('Keeper');
    const dmId = (await openDm(alice, bob)).json().channel.id;

    const ancient = new Date(Date.now() - 31 * 24 * 60 * 60_000);
    const recent = new Date(Date.now() - 60_000);
    const staleGlobal = await seedMessage(TOWN_SQUARE_CHANNEL_ID, alice, 'ancient town talk', ancient);
    const freshGlobal = await seedMessage(TOWN_SQUARE_CHANNEL_ID, alice, 'recent town talk', recent);
    const ancientDm = await seedMessage(dmId, alice, 'ancient private talk', ancient);

    const job = new ChatRetentionJob({ db });
    const deleted = await job.runOnce();
    expect(deleted).toBeGreaterThanOrEqual(1);

    const survivors = await db.query<{ id: string }>(
      'SELECT id FROM chat_messages WHERE id = ANY($1::uuid[])',
      [[staleGlobal, freshGlobal, ancientDm]],
    );
    const ids = survivors.rows.map((row) => row.id);
    expect(ids).not.toContain(staleGlobal);
    expect(ids).toContain(freshGlobal);
    expect(ids).toContain(ancientDm);
  });

  it('only lets one instance purge at a time', async () => {
    const alice = await makePlayer('Racer');
    const ancient = new Date(Date.now() - 40 * 24 * 60 * 60_000);
    await seedMessage(TOWN_SQUARE_CHANNEL_ID, alice, 'contended row', ancient);

    const holder = await db.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [0x4c4d_4348]);
      const job = new ChatRetentionJob({ db });
      // The lock is held elsewhere, so this instance declines rather than double-purging.
      expect(await job.runOnce()).toBe(0);
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [0x4c4d_4348]);
      holder.release();
    }

    const job = new ChatRetentionJob({ db });
    expect(await job.runOnce()).toBeGreaterThanOrEqual(1);
  });
});
