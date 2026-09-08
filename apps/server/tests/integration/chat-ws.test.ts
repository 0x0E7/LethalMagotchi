import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { TOWN_SQUARE_CHANNEL_ID } from '@lethalmagotchi/shared';
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

interface Booted {
  app: FastifyInstance;
  baseUrl: string;
  close: () => Promise<void>;
}

let db: Db;

beforeAll(() => {
  db = testPool();
});

afterAll(async () => {
  await closeTestPool();
});

async function boot(limiters?: Limiters): Promise<Booted> {
  const { app } = await createTestApp(limiters ? { limiters } : {});
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => app.close(),
  };
}

async function makePlayer(app: FastifyInstance, nickname: string): Promise<Player> {
  const account = await registerAccount(app, { username: uniqueUsername('cws') });
  const response = await app.inject(
    authed(account, {
      method: 'POST',
      url: '/api/v1/characters',
      payload: { ...VALID_CHARACTER, nickname },
    }),
  );
  expect(response.statusCode, response.body).toBe(201);
  return { ...account, characterId: response.json().character.id, nickname };
}

async function openDm(app: FastifyInstance, from: Player, to: Player): Promise<string> {
  const response = await app.inject(
    authed(from, { method: 'POST', url: '/api/v1/chat/dm', payload: { targetAccountId: to.accountId } }),
  );
  expect([200, 201]).toContain(response.statusCode);
  return response.json().channel.id;
}

/** Lets a fan-out that should *not* happen actually fail to happen before we assert. */
async function settle(ms = 250): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('town square over the socket', () => {
  it('delivers a message to every connected player and acks the sender', async () => {
    const booted = await boot();
    const alice = await makePlayer(booted.app, 'Miso');
    const bob = await makePlayer(booted.app, 'Pepper');
    const clients: TestClient[] = [];

    try {
      const aliceSocket = await TestClient.connect(booted.baseUrl, alice.accessToken);
      const bobSocket = await TestClient.connect(booted.baseUrl, bob.accessToken);
      clients.push(aliceSocket, bobSocket);

      aliceSocket.send({
        type: 'chat:send',
        clientMsgId: 'c1',
        channelId: TOWN_SQUARE_CHANNEL_ID,
        body: 'hello town square',
      });

      const ack = await aliceSocket.next('chat:ack');
      expect(ack.clientMsgId).toBe('c1');

      const delivered = await bobSocket.next('chat:message', (message) =>
        message.message.body === 'hello town square',
      );
      expect(delivered.channelId).toBe(TOWN_SQUARE_CHANNEL_ID);
      expect(delivered.message.id).toBe(ack.messageId);
      // Identity is the character nickname, never the account username.
      expect(delivered.message.authorName).toBe('Miso');
      expect(delivered.message.authorAccountId).toBe(alice.accountId);
      expect(delivered.message.body).not.toContain(alice.username);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('takes the author from the socket, not from anything the client can say', async () => {
    const booted = await boot();
    const alice = await makePlayer(booted.app, 'Truth');
    const mallory = await makePlayer(booted.app, 'Forger');
    const clients: TestClient[] = [];

    try {
      const mallorySocket = await TestClient.connect(booted.baseUrl, mallory.accessToken);
      clients.push(mallorySocket);

      // A forged author is not a field the schema even has: the frame is refused outright.
      mallorySocket.send({
        type: 'chat:send',
        clientMsgId: 'forge',
        channelId: TOWN_SQUARE_CHANNEL_ID,
        body: 'not from me',
        authorAccountId: alice.accountId,
        authorName: 'Truth',
      } as never);

      const error = await mallorySocket.next('error');
      expect(error.code).toBe('BAD_MESSAGE');

      mallorySocket.send({
        type: 'chat:send',
        clientMsgId: 'honest',
        channelId: TOWN_SQUARE_CHANNEL_ID,
        body: 'this one is mine',
      });
      const delivered = await mallorySocket.next('chat:message', (message) =>
        message.message.body === 'this one is mine',
      );
      expect(delivered.message.authorName).toBe('Forger');
      expect(delivered.message.authorAccountId).toBe(mallory.accountId);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('keeps a blocked author out of the blocker stream', async () => {
    const booted = await boot();
    const alice = await makePlayer(booted.app, 'Quiet');
    const loud = await makePlayer(booted.app, 'Loud');
    const bystander = await makePlayer(booted.app, 'Bystander');
    const clients: TestClient[] = [];

    try {
      await booted.app.inject(
        authed(alice, { method: 'POST', url: '/api/v1/blocks', payload: { blockedAccountId: loud.accountId } }),
      );

      const aliceSocket = await TestClient.connect(booted.baseUrl, alice.accessToken);
      const loudSocket = await TestClient.connect(booted.baseUrl, loud.accessToken);
      const bystanderSocket = await TestClient.connect(booted.baseUrl, bystander.accessToken);
      clients.push(aliceSocket, loudSocket, bystanderSocket);

      loudSocket.send({
        type: 'chat:send',
        clientMsgId: 'b1',
        channelId: TOWN_SQUARE_CHANNEL_ID,
        body: 'blocked-author-marker',
      });

      await bystanderSocket.next('chat:message', (message) =>
        message.message.body === 'blocked-author-marker',
      );
      await settle();
      expect(aliceSocket.transcript()).not.toContain('blocked-author-marker');
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

describe('direct message confidentiality', () => {
  /**
   * The chat equivalent of the hole-card leak tests: every socket records its raw frames and
   * the assertion is made against the serialized text, so a DM body reaching a third party
   * through *any* field — a new one added later included — fails loudly.
   */
  it('never lets a DM reach a socket that is not a member, even one that asks for it', async () => {
    const booted = await boot();
    const alice = await makePlayer(booted.app, 'Ada');
    const bob = await makePlayer(booted.app, 'Bo');
    const eve = await makePlayer(booted.app, 'Eve');
    const clients: TestClient[] = [];

    try {
      const channelId = await openDm(booted.app, alice, bob);

      const aliceSocket = await TestClient.connect(booted.baseUrl, alice.accessToken);
      const bobSocket = await TestClient.connect(booted.baseUrl, bob.accessToken);
      const eveSocket = await TestClient.connect(booted.baseUrl, eve.accessToken);
      clients.push(aliceSocket, bobSocket, eveSocket);

      aliceSocket.send({ type: 'chat:subscribe', channelIds: [channelId] });
      bobSocket.send({ type: 'chat:subscribe', channelIds: [channelId] });
      // Eve asks for the channel too. A subscription can only ever narrow delivery, never
      // widen it, so this buys her nothing.
      eveSocket.send({ type: 'chat:subscribe', channelIds: [channelId] });
      await settle(100);

      const secret = 'sealed-envelope-9f13';
      aliceSocket.send({ type: 'chat:send', clientMsgId: 'dm1', channelId, body: secret });

      const delivered = await bobSocket.next('chat:message', (message) => message.channelId === channelId);
      expect(delivered.message.body).toBe(secret);
      await aliceSocket.next('chat:ack');
      await settle();

      expect(eveSocket.transcript()).not.toContain(secret);
      expect(eveSocket.transcript()).not.toContain(channelId);
      expect(eveSocket.received('chat:message')).toHaveLength(0);
      expect(eveSocket.received('chat:unread')).toHaveLength(0);
      expect(eveSocket.received('chat:channel')).toHaveLength(0);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('refuses a send into a channel the sender is not a member of', async () => {
    const booted = await boot();
    const alice = await makePlayer(booted.app, 'Mem1');
    const bob = await makePlayer(booted.app, 'Mem2');
    const eve = await makePlayer(booted.app, 'Mem3');
    const clients: TestClient[] = [];

    try {
      const channelId = await openDm(booted.app, alice, bob);
      const eveSocket = await TestClient.connect(booted.baseUrl, eve.accessToken);
      const bobSocket = await TestClient.connect(booted.baseUrl, bob.accessToken);
      clients.push(eveSocket, bobSocket);
      bobSocket.send({ type: 'chat:subscribe', channelIds: [channelId] });

      eveSocket.send({ type: 'chat:send', clientMsgId: 'x1', channelId, body: 'intrusion-marker' });
      const rejected = await eveSocket.next('chat:rejected');
      expect(rejected.code).toBe('NOT_MEMBER');

      await settle();
      expect(bobSocket.transcript()).not.toContain('intrusion-marker');
      const stored = await db.query('SELECT id FROM chat_messages WHERE body = $1', ['intrusion-marker']);
      expect(stored.rowCount).toBe(0);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('announces a new DM to both participants and to nobody else', async () => {
    const booted = await boot();
    const alice = await makePlayer(booted.app, 'New1');
    const bob = await makePlayer(booted.app, 'New2');
    const eve = await makePlayer(booted.app, 'New3');
    const clients: TestClient[] = [];

    try {
      const aliceSocket = await TestClient.connect(booted.baseUrl, alice.accessToken);
      const bobSocket = await TestClient.connect(booted.baseUrl, bob.accessToken);
      const eveSocket = await TestClient.connect(booted.baseUrl, eve.accessToken);
      clients.push(aliceSocket, bobSocket, eveSocket);

      const channelId = await openDm(booted.app, alice, bob);

      const announced = await bobSocket.next('chat:channel');
      expect(announced.channel.id).toBe(channelId);
      // Each side is labelled with the other participant.
      expect(announced.channel.counterpart?.nickname).toBe('New1');
      expect((await aliceSocket.next('chat:channel')).channel.counterpart?.nickname).toBe('New2');

      await settle();
      expect(eveSocket.received('chat:channel')).toHaveLength(0);

      // The announcement subscribes both sides, so the first message lands live without a
      // round trip the client could not have made yet.
      aliceSocket.send({ type: 'chat:send', clientMsgId: 'first', channelId, body: 'first word' });
      expect((await bobSocket.next('chat:message')).message.body).toBe('first word');
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('refuses a DM send once either side has blocked the other', async () => {
    const booted = await boot();
    const alice = await makePlayer(booted.app, 'Blk1');
    const bob = await makePlayer(booted.app, 'Blk2');
    const clients: TestClient[] = [];

    try {
      const channelId = await openDm(booted.app, alice, bob);
      const aliceSocket = await TestClient.connect(booted.baseUrl, alice.accessToken);
      const bobSocket = await TestClient.connect(booted.baseUrl, bob.accessToken);
      clients.push(aliceSocket, bobSocket);
      aliceSocket.send({ type: 'chat:subscribe', channelIds: [channelId] });
      bobSocket.send({ type: 'chat:subscribe', channelIds: [channelId] });
      await settle(100);

      await booted.app.inject(
        authed(bob, { method: 'POST', url: '/api/v1/blocks', payload: { blockedAccountId: alice.accountId } }),
      );

      aliceSocket.send({ type: 'chat:send', clientMsgId: 'nope', channelId, body: 'blocked-dm-marker' });
      const rejected = await aliceSocket.next('chat:rejected');
      expect(rejected.code).toBe('BLOCKED_BY_RECIPIENT');

      await settle();
      expect(bobSocket.transcript()).not.toContain('blocked-dm-marker');
      const stored = await db.query('SELECT id FROM chat_messages WHERE body = $1', ['blocked-dm-marker']);
      expect(stored.rowCount).toBe(0);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('reports unread to a member socket that has not subscribed', async () => {
    const booted = await boot();
    const alice = await makePlayer(booted.app, 'Unr1');
    const bob = await makePlayer(booted.app, 'Unr2');
    const clients: TestClient[] = [];

    try {
      const channelId = await openDm(booted.app, alice, bob);
      const aliceSocket = await TestClient.connect(booted.baseUrl, alice.accessToken);
      const bobSocket = await TestClient.connect(booted.baseUrl, bob.accessToken);
      clients.push(aliceSocket, bobSocket);
      bobSocket.send({ type: 'chat:unsubscribe', channelIds: [channelId] });
      aliceSocket.send({ type: 'chat:subscribe', channelIds: [channelId] });
      await settle(100);

      aliceSocket.send({ type: 'chat:send', clientMsgId: 'u1', channelId, body: 'ping one' });
      const unread = await bobSocket.next('chat:unread', (message) => message.channelId === channelId);
      expect(unread.unreadCount).toBe(1);

      const messageId = (await aliceSocket.next('chat:ack')).messageId;
      bobSocket.send({ type: 'chat:read', channelId, lastReadMessageId: messageId });
      const cleared = await bobSocket.next('chat:unread', (message) => message.unreadCount === 0);
      expect(cleared.channelId).toBe(channelId);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

describe('protocol discipline', () => {
  it('rejects unknown keys on every chat frame', async () => {
    const booted = await boot();
    const alice = await makePlayer(booted.app, 'Strict');
    const clients: TestClient[] = [];

    try {
      const socket = await TestClient.connect(booted.baseUrl, alice.accessToken);
      clients.push(socket);

      const frames = [
        { type: 'chat:send', clientMsgId: 'a', channelId: TOWN_SQUARE_CHANNEL_ID, body: 'hi', extra: 1 },
        { type: 'chat:subscribe', channelIds: [TOWN_SQUARE_CHANNEL_ID], sneaky: true },
        { type: 'chat:unsubscribe', channelIds: [TOWN_SQUARE_CHANNEL_ID], sneaky: true },
        {
          type: 'chat:read',
          channelId: TOWN_SQUARE_CHANNEL_ID,
          lastReadMessageId: TOWN_SQUARE_CHANNEL_ID,
          asAccountId: alice.accountId,
        },
      ];

      for (const frame of frames) {
        socket.send(frame as never);
        expect((await socket.next('error')).code).toBe('BAD_MESSAGE');
      }

      expect(socket.received('chat:ack')).toHaveLength(0);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('refuses chat from a socket with no character', async () => {
    const booted = await boot();
    const account = await registerAccount(booted.app, { username: uniqueUsername('bare') });
    const clients: TestClient[] = [];

    try {
      const socket = await TestClient.connect(booted.baseUrl, account.accessToken);
      clients.push(socket);

      socket.send({
        type: 'chat:send',
        clientMsgId: 'z',
        channelId: TOWN_SQUARE_CHANNEL_ID,
        body: 'characterless-marker',
      });
      const error = await socket.next('error');
      expect(error.code).toBe('NO_CHARACTER');

      const stored = await db.query('SELECT id FROM chat_messages WHERE body = $1', ['characterless-marker']);
      expect(stored.rowCount).toBe(0);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('rejects an empty body and one past the sanitized cap', async () => {
    const booted = await boot();
    const alice = await makePlayer(booted.app, 'Edges');
    const clients: TestClient[] = [];

    try {
      const socket = await TestClient.connect(booted.baseUrl, alice.accessToken);
      clients.push(socket);

      socket.send({ type: 'chat:send', clientMsgId: 'e1', channelId: TOWN_SQUARE_CHANNEL_ID, body: '   ' });
      expect((await socket.next('chat:rejected')).code).toBe('EMPTY');

      socket.send({
        type: 'chat:send',
        clientMsgId: 'e2',
        channelId: TOWN_SQUARE_CHANNEL_ID,
        body: 'x'.repeat(600),
      });
      expect((await socket.next('chat:rejected', (message) => message.clientMsgId === 'e2')).code).toBe('TOO_LONG');
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

/**
 * A socket resolves its character once, at auth. Both of these are the same bug seen from
 * two ends: a binding that never re-resolves leaves a live, open, permanently mute socket —
 * and because it never closes, the client never reconnects its way out of it either.
 */
describe('character binding over the life of a socket', () => {
  it('starts chatting the moment the character is created, on the same connection', async () => {
    const booted = await boot();
    const account = await registerAccount(booted.app, { username: uniqueUsername('fresh') });
    const clients: TestClient[] = [];

    try {
      const socket = await TestClient.connect(booted.baseUrl, account.accessToken);
      clients.push(socket);
      // The handshake `next('ready')` inside connect() already took this frame; read it back
      // out of the transcript rather than waiting for a second one that has no reason to come.
      expect(socket.received('ready')[0]?.characterId).toBeNull();

      socket.send({
        type: 'chat:send',
        clientMsgId: 'before',
        channelId: TOWN_SQUARE_CHANNEL_ID,
        body: 'too-early-marker',
      });
      expect((await socket.next('error')).code).toBe('NO_CHARACTER');

      const created = await booted.app.inject(
        authed(account, {
          method: 'POST',
          url: '/api/v1/characters',
          payload: { ...VALID_CHARACTER, nickname: 'JustBorn' },
        }),
      );
      expect(created.statusCode, created.body).toBe(201);
      const characterId = created.json().character.id;

      const rebound = await socket.next('ready', (message) => message.characterId !== null);
      expect(rebound.characterId).toBe(characterId);
      expect(rebound.accountId).toBe(account.accountId);

      socket.send({
        type: 'chat:send',
        clientMsgId: 'after',
        channelId: TOWN_SQUARE_CHANNEL_ID,
        body: 'first-words-marker',
      });
      const ack = await socket.next('chat:ack', (message) => message.clientMsgId === 'after');

      const delivered = await socket.next('chat:message', (message) =>
        message.message.body === 'first-words-marker',
      );
      expect(delivered.message.id).toBe(ack.messageId);
      expect(delivered.message.authorName).toBe('JustBorn');
      expect(delivered.message.authorCharacterId).toBe(characterId);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('follows a delete and rebuild without needing a reconnect', async () => {
    const booted = await boot();
    const alice = await makePlayer(booted.app, 'Before');
    const clients: TestClient[] = [];

    try {
      const socket = await TestClient.connect(booted.baseUrl, alice.accessToken);
      clients.push(socket);

      // Unique per run: these two lines really are stored, in a Town Square every run shares.
      const firstLife = `old-body-marker ${randomUUID()}`;
      const secondLife = `new-body-marker ${randomUUID()}`;

      socket.send({ type: 'chat:send', clientMsgId: 'v1', channelId: TOWN_SQUARE_CHANNEL_ID, body: firstLife });
      await socket.next('chat:ack', (message) => message.clientMsgId === 'v1');

      const deleted = await booted.app.inject(authed(alice, { method: 'DELETE', url: '/api/v1/characters/me' }));
      expect(deleted.statusCode).toBe(204);
      expect((await socket.next('ready', (message) => message.characterId === null)).accountId).toBe(
        alice.accountId,
      );

      // With no character the socket is mute, and says so rather than pretending.
      socket.send({
        type: 'chat:send',
        clientMsgId: 'gone',
        channelId: TOWN_SQUARE_CHANNEL_ID,
        body: 'between-lives-marker',
      });
      expect((await socket.next('error')).code).toBe('NO_CHARACTER');

      const rebuilt = await booted.app.inject(
        authed(alice, {
          method: 'POST',
          url: '/api/v1/characters',
          payload: { ...VALID_CHARACTER, nickname: 'After' },
        }),
      );
      expect(rebuilt.statusCode, rebuilt.body).toBe(201);
      const newCharacterId = rebuilt.json().character.id;
      expect(newCharacterId).not.toBe(alice.characterId);

      expect(
        (await socket.next('ready', (message) => message.characterId === newCharacterId)).characterId,
      ).toBe(newCharacterId);

      socket.send({ type: 'chat:send', clientMsgId: 'v2', channelId: TOWN_SQUARE_CHANNEL_ID, body: secondLife });
      const ack = await socket.next('chat:ack', (message) => message.clientMsgId === 'v2');
      expect(socket.received('chat:rejected')).toHaveLength(0);

      const stored = await db.query<{ author_character_id: string; author_name_snapshot: string }>(
        'SELECT author_character_id, author_name_snapshot FROM chat_messages WHERE id = $1',
        [ack.messageId],
      );
      expect(stored.rows[0]?.author_character_id).toBe(newCharacterId);
      expect(stored.rows[0]?.author_name_snapshot).toBe('After');

      // History is not rewritten by the rebuild: the old line keeps the old name.
      const old = await db.query<{ author_name_snapshot: string }>(
        'SELECT author_name_snapshot FROM chat_messages WHERE body = $1',
        [firstLife],
      );
      expect(old.rows[0]?.author_name_snapshot).toBe('Before');
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

describe('moderation over the socket', () => {
  it('refuses a high-confidence violation without persisting or fanning it out', async () => {
    const booted = await boot();
    const alice = await makePlayer(booted.app, 'Mod1');
    const bob = await makePlayer(booted.app, 'Mod2');
    const clients: TestClient[] = [];

    try {
      const aliceSocket = await TestClient.connect(booted.baseUrl, alice.accessToken);
      const bobSocket = await TestClient.connect(booted.baseUrl, bob.accessToken);
      clients.push(aliceSocket, bobSocket);

      const nasty = 'you are a faggot mod-marker';
      aliceSocket.send({
        type: 'chat:send',
        clientMsgId: 'm1',
        channelId: TOWN_SQUARE_CHANNEL_ID,
        body: nasty,
      });

      const rejected = await aliceSocket.next('chat:rejected');
      expect(rejected.code).toBe('BLOCKED_CONTENT');
      await settle();

      expect(bobSocket.transcript()).not.toContain('mod-marker');
      const stored = await db.query('SELECT id FROM chat_messages WHERE body = $1', [nasty]);
      expect(stored.rowCount).toBe(0);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('delivers borderline content but records the flag', async () => {
    const booted = await boot();
    const alice = await makePlayer(booted.app, 'Mod3');
    const bob = await makePlayer(booted.app, 'Mod4');
    const clients: TestClient[] = [];

    try {
      const aliceSocket = await TestClient.connect(booted.baseUrl, alice.accessToken);
      const bobSocket = await TestClient.connect(booted.baseUrl, bob.accessToken);
      clients.push(aliceSocket, bobSocket);

      aliceSocket.send({
        type: 'chat:send',
        clientMsgId: 'm2',
        channelId: TOWN_SQUARE_CHANNEL_ID,
        body: 'that beat was bullshit borderline-marker',
      });

      const delivered = await bobSocket.next('chat:message', (message) =>
        message.message.body.includes('borderline-marker'),
      );
      expect(delivered.message.moderation).toBe('flagged');

      const stored = await db.query<{ moderation: string }>(
        'SELECT moderation FROM chat_messages WHERE id = $1',
        [delivered.message.id],
      );
      expect(stored.rows[0]?.moderation).toBe('flagged');
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

describe('chat rate limiting', () => {
  function chatLimits(): Limiters {
    const limiters = relaxedLimiters();
    limiters.chatBurst = new RateLimiter({ limit: 5, windowMs: 10_000, maxBackoffMs: 60_000 });
    limiters.chatSustained = new RateLimiter({ limit: 30, windowMs: 60_000 });
    return limiters;
  }

  it('refuses the sixth message in a ten second burst and says when to retry', async () => {
    const booted = await boot(chatLimits());
    const alice = await makePlayer(booted.app, 'Fast');
    const clients: TestClient[] = [];

    try {
      const socket = await TestClient.connect(booted.baseUrl, alice.accessToken);
      clients.push(socket);

      for (let index = 0; index < 5; index += 1) {
        socket.send({
          type: 'chat:send',
          clientMsgId: `r${index}`,
          channelId: TOWN_SQUARE_CHANNEL_ID,
          body: `burst ${index}`,
        });
        await socket.next('chat:ack', (message) => message.clientMsgId === `r${index}`);
      }

      socket.send({
        type: 'chat:send',
        clientMsgId: 'r5',
        channelId: TOWN_SQUARE_CHANNEL_ID,
        body: 'burst 5',
      });
      const rejected = await socket.next('chat:rejected', (message) => message.clientMsgId === 'r5');
      expect(rejected.code).toBe('RATE_LIMITED');
      expect(rejected.retryAfterMs).toBeGreaterThan(0);

      const stored = await db.query('SELECT id FROM chat_messages WHERE body = $1', ['burst 5']);
      expect(stored.rowCount).toBe(0);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('shares one budget across every socket the account has open', async () => {
    const booted = await boot(chatLimits());
    const alice = await makePlayer(booted.app, 'Multi');
    const clients: TestClient[] = [];

    try {
      const first = await TestClient.connect(booted.baseUrl, alice.accessToken);
      const second = await TestClient.connect(booted.baseUrl, alice.accessToken);
      clients.push(first, second);

      for (let index = 0; index < 5; index += 1) {
        first.send({
          type: 'chat:send',
          clientMsgId: `s${index}`,
          channelId: TOWN_SQUARE_CHANNEL_ID,
          body: `shared ${index}`,
        });
        await first.next('chat:ack', (message) => message.clientMsgId === `s${index}`);
      }

      // A second tab is not a second allowance.
      second.send({
        type: 'chat:send',
        clientMsgId: 's5',
        channelId: TOWN_SQUARE_CHANNEL_ID,
        body: 'shared 5',
      });
      expect((await second.next('chat:rejected')).code).toBe('RATE_LIMITED');
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('charges the budget for frames it rejects as junk, so garbage buys nothing', async () => {
    const booted = await boot(chatLimits());
    const alice = await makePlayer(booted.app, 'Junk');
    const clients: TestClient[] = [];

    try {
      const socket = await TestClient.connect(booted.baseUrl, alice.accessToken);
      clients.push(socket);

      // A body that *can* legitimately be stored has to be unique per run: the Town Square is
      // one long-lived channel shared by every run against this database.
      const real = `a perfectly ordinary sentence ${randomUUID()}`;
      const junk = ['   ', '\t\t', ' ', 'x'.repeat(600), 'y'.repeat(600)];
      for (const [index, body] of junk.entries()) {
        socket.send({
          type: 'chat:send',
          clientMsgId: `j${index}`,
          channelId: TOWN_SQUARE_CHANNEL_ID,
          body,
        });
        const rejected = await socket.next('chat:rejected', (message) => message.clientMsgId === `j${index}`);
        expect(['EMPTY', 'TOO_LONG']).toContain(rejected.code);
      }

      // The five junk frames spent the whole ten-second allowance: a real message now waits
      // like any other sixth message would.
      socket.send({ type: 'chat:send', clientMsgId: 'real', channelId: TOWN_SQUARE_CHANNEL_ID, body: real });
      const refused = await socket.next('chat:rejected', (message) => message.clientMsgId === 'real');
      expect(refused.code).toBe('RATE_LIMITED');
      expect(refused.retryAfterMs).toBeGreaterThan(0);

      const stored = await db.query('SELECT id FROM chat_messages WHERE body = $1', [real]);
      expect(stored.rowCount).toBe(0);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('refuses the same body sent twice in a row', async () => {
    const booted = await boot(chatLimits());
    const alice = await makePlayer(booted.app, 'Parrot');
    const clients: TestClient[] = [];

    try {
      const socket = await TestClient.connect(booted.baseUrl, alice.accessToken);
      clients.push(socket);

      socket.send({
        type: 'chat:send',
        clientMsgId: 'd1',
        channelId: TOWN_SQUARE_CHANNEL_ID,
        body: 'same thing twice',
      });
      await socket.next('chat:ack', (message) => message.clientMsgId === 'd1');

      socket.send({
        type: 'chat:send',
        clientMsgId: 'd2',
        channelId: TOWN_SQUARE_CHANNEL_ID,
        body: 'same thing twice',
      });
      expect((await socket.next('chat:rejected', (message) => message.clientMsgId === 'd2')).code).toBe(
        'DUPLICATE',
      );

      // Something else in between clears the guard.
      socket.send({
        type: 'chat:send',
        clientMsgId: 'd3',
        channelId: TOWN_SQUARE_CHANNEL_ID,
        body: 'something else',
      });
      await socket.next('chat:ack', (message) => message.clientMsgId === 'd3');
      socket.send({
        type: 'chat:send',
        clientMsgId: 'd4',
        channelId: TOWN_SQUARE_CHANNEL_ID,
        body: 'same thing twice',
      });
      await socket.next('chat:ack', (message) => message.clientMsgId === 'd4');
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});
