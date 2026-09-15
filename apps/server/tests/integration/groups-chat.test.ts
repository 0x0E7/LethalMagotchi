import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { TOWN_SQUARE_CHANNEL_ID, type ChatChannelDto, type DuelCardDto } from '@lethalmagotchi/shared';
import type { Db } from '../../src/db/pool.js';
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
import { TestClient, closeAll } from '../helpers/ws.js';

interface Player extends TestAccount {
  characterId: string;
  nickname: string;
}

let app: FastifyInstance;
let baseUrl: string;
let db: Db;

beforeAll(async () => {
  db = testPool();
  ({ app } = await createTestApp());
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app.close();
  await closeTestPool();
});

function groupName(label: string): string {
  return `${label} ${randomUUID().slice(0, 8)}`;
}

async function makePlayer(nickname: string): Promise<Player> {
  const account = await registerAccount(app, { username: uniqueUsername('gch') });
  const response = await app.inject(
    authed(account, { method: 'POST', url: '/api/v1/characters', payload: { ...VALID_CHARACTER, nickname } }),
  );
  expect(response.statusCode, response.body).toBe(201);
  await db.query(`UPDATE accounts SET created_at = now() - interval '48 hours' WHERE id = $1`, [
    account.accountId,
  ]);
  return { ...account, characterId: response.json().character.id, nickname };
}

async function foundGroup(leader: Player, name: string): Promise<{ groupId: string; channelId: string }> {
  const response = await app.inject(
    authed(leader, { method: 'POST', url: '/api/v1/groups', payload: { name } }),
  );
  expect(response.statusCode, response.body).toBe(201);
  return { groupId: response.json().group.id, channelId: response.json().group.channelId };
}

async function join(member: Player, groupId: string, inviter: Player): Promise<void> {
  const invited = await app.inject(
    authed(inviter, {
      method: 'POST',
      url: `/api/v1/groups/${groupId}/invites`,
      payload: { toAccountId: member.accountId },
    }),
  );
  expect(invited.statusCode, invited.body).toBe(201);
  const accepted = await app.inject(
    authed(member, {
      method: 'POST',
      url: `/api/v1/groups/invites/${invited.json().invite.id}/respond`,
      payload: { accept: true },
    }),
  );
  expect(accepted.statusCode, accepted.body).toBe(200);
}

/** Lets a fan-out that should *not* happen actually fail to happen before we assert. */
async function settle(ms = 250): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('the group channel', () => {
  it('appears in the channel list for members and for nobody else', async () => {
    const leader = await makePlayer('Chatter');
    const member = await makePlayer('Listener');
    const stranger = await makePlayer('Outsider');
    const name = groupName('Talkers');
    const { groupId, channelId } = await foundGroup(leader, name);
    await join(member, groupId, leader);

    for (const player of [leader, member]) {
      const response = await app.inject(authed(player, { method: 'GET', url: '/api/v1/chat/channels' }));
      const channel = (response.json().channels as ChatChannelDto[]).find((entry) => entry.id === channelId);
      expect(channel).toMatchObject({ kind: 'group', name, counterpart: null });
    }

    const theirs = await app.inject(authed(stranger, { method: 'GET', url: '/api/v1/chat/channels' }));
    expect((theirs.json().channels as ChatChannelDto[]).map((entry) => entry.id)).not.toContain(channelId);
  });

  it('keeps DMs and the Town Square exactly as they were', async () => {
    const alice = await makePlayer('Ada');
    const bob = await makePlayer('Bo');
    const dm = await app.inject(
      authed(alice, { method: 'POST', url: '/api/v1/chat/dm', payload: { targetAccountId: bob.accountId } }),
    );
    expect(dm.statusCode).toBe(201);
    await foundGroup(alice, groupName('Side Project'));

    const response = await app.inject(authed(alice, { method: 'GET', url: '/api/v1/chat/channels' }));
    const channels = response.json().channels as ChatChannelDto[];
    const dmChannel = channels.find((entry) => entry.id === dm.json().channel.id);
    // The DM still carries its counterpart label; the group channel did not blur it.
    expect(dmChannel?.counterpart).toMatchObject({ accountId: bob.accountId, nickname: 'Bo' });
    expect(channels.find((entry) => entry.id === TOWN_SQUARE_CHANNEL_ID)).toMatchObject({ kind: 'global' });
  });

  /**
   * The leak sweep for the new `kind`. The access predicate branches on membership rather
   * than on kind, so this should already hold — which is exactly why it is worth proving.
   */
  it('refuses a non-member every way into the room', async () => {
    const leader = await makePlayer('Insider');
    const stranger = await makePlayer('Prowler');
    const { groupId, channelId } = await foundGroup(leader, groupName('Closed Doors'));
    const secret = `group-secret-${randomUUID()}`;
    await db.query(
      `INSERT INTO chat_messages (id, channel_id, author_account_id, author_character_id, author_name_snapshot, body)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
      [channelId, leader.accountId, leader.characterId, leader.nickname, secret],
    );

    const history = await app.inject(
      authed(stranger, { method: 'GET', url: `/api/v1/chat/channels/${channelId}/messages` }),
    );
    expect(history.statusCode).toBe(404);
    expect(history.body).not.toContain(secret);

    const insider = await TestClient.connect(baseUrl, leader.accessToken);
    const prowler = await TestClient.connect(baseUrl, stranger.accessToken);
    try {
      // Subscribing to somebody else's channel is dropped in silence and buys nothing.
      prowler.send({ type: 'chat:subscribe', channelIds: [channelId] });
      prowler.send({
        type: 'chat:send',
        clientMsgId: randomUUID(),
        channelId,
        body: `intrusion-${randomUUID()}`,
      });
      const rejected = await prowler.next('chat:rejected');
      expect(rejected.code).toBe('NOT_MEMBER');

      const said = `members-only-${randomUUID()}`;
      insider.send({ type: 'chat:send', clientMsgId: randomUUID(), channelId, body: said });
      await insider.next('chat:ack');
      await settle();

      expect(prowler.transcript()).not.toContain(said);
      expect(prowler.transcript()).not.toContain(secret);
      expect(prowler.transcript()).not.toContain(groupId);
    } finally {
      await closeAll([insider, prowler]);
    }
  });

  it('delivers a group line to members live and leaves the Town Square alone', async () => {
    const leader = await makePlayer('Speaker');
    const member = await makePlayer('Hearer');
    const stranger = await makePlayer('Townsfolk');
    const { groupId, channelId } = await foundGroup(leader, groupName('Live Wire'));
    await join(member, groupId, leader);

    const speaker = await TestClient.connect(baseUrl, leader.accessToken);
    const hearer = await TestClient.connect(baseUrl, member.accessToken);
    const townsfolk = await TestClient.connect(baseUrl, stranger.accessToken);
    try {
      hearer.send({ type: 'chat:subscribe', channelIds: [channelId] });
      const said = `group-live-${randomUUID()}`;
      speaker.send({ type: 'chat:send', clientMsgId: randomUUID(), channelId, body: said });

      const delivered = await hearer.next('chat:message', (message) => message.message.body === said);
      expect(delivered.channelId).toBe(channelId);
      await settle();
      expect(townsfolk.transcript()).not.toContain(said);
    } finally {
      await closeAll([speaker, hearer, townsfolk]);
    }
  });

  it('announces the channel to a joiner who could not have known it existed', async () => {
    const leader = await makePlayer('Recruiter');
    const joiner = await makePlayer('Recruit');
    const { groupId, channelId } = await foundGroup(leader, groupName('Welcoming'));
    const invited = await app.inject(
      authed(leader, {
        method: 'POST',
        url: `/api/v1/groups/${groupId}/invites`,
        payload: { toAccountId: joiner.accountId },
      }),
    );

    const client = await TestClient.connect(baseUrl, joiner.accessToken);
    try {
      await app.inject(
        authed(joiner, {
          method: 'POST',
          url: `/api/v1/groups/invites/${invited.json().invite.id}/respond`,
          payload: { accept: true },
        }),
      );
      const announced = await client.next('chat:channel', (message) => message.channel.id === channelId);
      expect(announced.channel.kind).toBe('group');
      // And the roster event lands in the room itself.
      const system = await client.next(
        'chat:message',
        (message) => message.message.body === 'Recruit joined the group.',
      );
      expect(system.message.authorAccountId).toBeNull();
    } finally {
      await closeAll([client]);
    }
  });

  it('writes the roster events the group can see, and only to the group', async () => {
    const leader = await makePlayer('Chief');
    const elder = await makePlayer('Elder');
    const stranger = await makePlayer('Nobody');
    const { groupId, channelId } = await foundGroup(leader, groupName('Chronicle'));
    await join(elder, groupId, leader);

    const townsfolk = await TestClient.connect(baseUrl, stranger.accessToken);
    try {
      expect(
        (await app.inject(authed(leader, { method: 'DELETE', url: '/api/v1/groups/me/membership' })))
          .statusCode,
      ).toBe(200);
      await settle();

      const bodies = (
        await db.query<{ body: string }>(
          'SELECT body FROM chat_messages WHERE channel_id = $1 ORDER BY created_at, id',
          [channelId],
        )
      ).rows.map((row) => row.body);
      expect(bodies).toEqual([
        'Elder joined the group.',
        'Chief left the group.',
        'Elder is now the leader.',
      ]);

      // A roster event is a private room's business, not a Town Square broadcast.
      expect(townsfolk.transcript()).not.toContain('left the group');
      expect(townsfolk.transcript()).not.toContain('is now the leader');
    } finally {
      await closeAll([townsfolk]);
    }
  });

  it('closes the room to a member who has left, and to the last one out', async () => {
    const leader = await makePlayer('Stayer');
    const quitter = await makePlayer('Quitter');
    const { groupId, channelId } = await foundGroup(leader, groupName('Departures'));
    await join(quitter, groupId, leader);

    await app.inject(authed(quitter, { method: 'DELETE', url: '/api/v1/groups/me/membership' }));
    const afterLeaving = await app.inject(
      authed(quitter, { method: 'GET', url: `/api/v1/chat/channels/${channelId}/messages` }),
    );
    expect(afterLeaving.statusCode).toBe(404);

    // The last member out archives the room; what was said in it stays readable to them
    // until they go too, and the channel is closed rather than deleted.
    await app.inject(authed(leader, { method: 'DELETE', url: '/api/v1/groups/me/membership' }));
    const channel = await db.query<{ archived_at: Date | null }>(
      'SELECT archived_at FROM chat_channels WHERE id = $1',
      [channelId],
    );
    expect(channel.rows[0]!.archived_at).not.toBeNull();
  });

  it('refuses a send from someone who was kicked mid-conversation', async () => {
    const leader = await makePlayer('Bouncer');
    const evicted = await makePlayer('Rowdy');
    const { groupId, channelId } = await foundGroup(leader, groupName('Short Stay'));
    await join(evicted, groupId, leader);

    const client = await TestClient.connect(baseUrl, evicted.accessToken);
    try {
      client.send({ type: 'chat:send', clientMsgId: randomUUID(), channelId, body: `before-${randomUUID()}` });
      await client.next('chat:ack');

      await app.inject(
        authed(leader, { method: 'DELETE', url: `/api/v1/groups/${groupId}/members/${evicted.accountId}` }),
      );

      client.send({ type: 'chat:send', clientMsgId: randomUUID(), channelId, body: `after-${randomUUID()}` });
      const rejected = await client.next('chat:rejected');
      expect(rejected.code).toBe('NOT_MEMBER');
    } finally {
      await closeAll([client]);
    }
  });
});

describe('the unread count in a group channel', () => {
  /**
   * A system row has no author, and `IS DISTINCT FROM` treats NULL as distinct from every
   * account id — so "X joined the group." used to count towards X's own badge. New to groups:
   * DMs carry no system rows and the Town Square keeps no watermark.
   */
  it('does not count a member own arrival against their own badge', async () => {
    const leader = await makePlayer('Host');
    const joiner = await makePlayer('Newcomer');
    const { groupId, channelId } = await foundGroup(leader, groupName('Tally'));
    await join(joiner, groupId, leader);

    const speaker = await TestClient.connect(baseUrl, leader.accessToken);
    try {
      for (const index of [1, 2, 3]) {
        speaker.send({
          type: 'chat:send',
          clientMsgId: randomUUID(),
          channelId,
          body: `line ${index} ${randomUUID()}`,
        });
        await speaker.next('chat:ack');
      }
      await settle();

      const theirs = await app.inject(authed(joiner, { method: 'GET', url: '/api/v1/chat/channels' }));
      const channel = (theirs.json().channels as ChatChannelDto[]).find((entry) => entry.id === channelId);
      // Three messages they have not seen, not four: their own arrival is not news to them.
      expect(channel?.unreadCount).toBe(3);

      // And the exclusion is about *whose* event it is, not about system rows in general:
      // somebody else joining is still something the leader has not read.
      const mine = await app.inject(authed(leader, { method: 'GET', url: '/api/v1/chat/channels' }));
      const asLeader = (mine.json().channels as ChatChannelDto[]).find((entry) => entry.id === channelId);
      expect(asLeader?.unreadCount).toBe(1);
    } finally {
      await closeAll([speaker]);
    }
  });
});

describe('an invitation reaching a player who is already online', () => {
  it('pushes a re-sync to the invited account and to nobody else', async () => {
    const leader = await makePlayer('Inviter');
    const target = await makePlayer('Idle');
    const bystander = await makePlayer('Uninvolved');
    const { groupId } = await foundGroup(leader, groupName('Signal'));

    const invited = await TestClient.connect(baseUrl, target.accessToken);
    const uninvolved = await TestClient.connect(baseUrl, bystander.accessToken);
    try {
      const response = await app.inject(
        authed(leader, {
          method: 'POST',
          url: `/api/v1/groups/${groupId}/invites`,
          payload: { toAccountId: target.accountId },
        }),
      );
      expect(response.statusCode, response.body).toBe(201);

      // Without this frame the Groups tab badge can only learn of an invitation by being
      // clicked — which is the affordance that was supposed to prompt the click.
      await invited.next('group:sync');

      const mine = await app.inject(authed(target, { method: 'GET', url: '/api/v1/groups/me' }));
      expect((mine.json().invites as { groupId: string }[]).map((entry) => entry.groupId)).toContain(groupId);

      await settle();
      expect(uninvolved.received('group:sync')).toEqual([]);
      // The nudge says nothing about who or what: the re-read is the only source of that.
      expect(invited.transcript()).not.toContain(groupId);
    } finally {
      await closeAll([invited, uninvolved]);
    }
  });
});

describe('the group badge on a player card', () => {
  it('rides the card the Town Square already fetches', async () => {
    const leader = await makePlayer('Badged');
    const loner = await makePlayer('Unbadged');
    const name = groupName('Badge Bearers');
    await foundGroup(leader, name);

    const response = await app.inject(
      authed(loner, {
        method: 'GET',
        url: `/api/v1/duels/cards?characterIds=${leader.characterId},${loner.characterId}`,
      }),
    );
    expect(response.statusCode).toBe(200);

    const cards: DuelCardDto[] = response.json().cards;
    expect(cards.find((card) => card.characterId === leader.characterId)?.groupName).toBe(name);
    expect(cards.find((card) => card.characterId === loner.characterId)?.groupName).toBeNull();
  });

  it('drops off the card when the group is left', async () => {
    const leader = await makePlayer('Briefly');
    const viewer = await makePlayer('Watcher');
    await foundGroup(leader, groupName('Fleeting'));
    await app.inject(authed(leader, { method: 'DELETE', url: '/api/v1/groups/me/membership' }));

    const response = await app.inject(
      authed(viewer, { method: 'GET', url: `/api/v1/duels/cards?characterIds=${leader.characterId}` }),
    );
    expect(response.json().cards[0].groupName).toBeNull();
  });
});
