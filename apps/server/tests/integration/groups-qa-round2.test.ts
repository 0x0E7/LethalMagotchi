import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { MyGroupResponse } from '@lethalmagotchi/shared';
import type { Db } from '../../src/db/pool.js';
import { withTransaction } from '../../src/db/pool.js';
import {
  findActiveGroupForAccount,
  findGroupById,
  lockActiveGroupForAccount,
  lockGroup,
} from '../../src/repos/groups.js';
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

/**
 * QA round 2 — independent re-verification of the five round-1 findings (G-1, G-2, G-4,
 * G-5, G-6) and the documented risk G-3. These reproduce each reported failure from the
 * outside rather than reading the fix, so a fix that only moves the symptom still fails.
 */

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
  const unique = `${nickname} ${randomUUID().slice(0, 6)}`;
  const account = await registerAccount(app, { username: uniqueUsername('r2') });
  const response = await app.inject(
    authed(account, {
      method: 'POST',
      url: '/api/v1/characters',
      payload: { ...VALID_CHARACTER, nickname: unique },
    }),
  );
  expect(response.statusCode, response.body).toBe(201);
  await db.query(`UPDATE accounts SET created_at = now() - interval '48 hours' WHERE id = $1`, [
    account.accountId,
  ]);
  return { ...account, characterId: response.json().character.id, nickname: unique };
}

function createGroup(player: Player, name: string) {
  return app.inject(authed(player, { method: 'POST', url: '/api/v1/groups', payload: { name } }));
}

function invite(from: Player, groupId: string, to: Player) {
  return app.inject(
    authed(from, {
      method: 'POST',
      url: `/api/v1/groups/${groupId}/invites`,
      payload: { toAccountId: to.accountId },
    }),
  );
}

function respond(player: Player, inviteId: string, accept: boolean) {
  return app.inject(
    authed(player, { method: 'POST', url: `/api/v1/groups/invites/${inviteId}/respond`, payload: { accept } }),
  );
}

function leave(player: Player) {
  return app.inject(authed(player, { method: 'DELETE', url: '/api/v1/groups/me/membership' }));
}

function kick(leader: Player, groupId: string, target: Player) {
  return app.inject(
    authed(leader, { method: 'DELETE', url: `/api/v1/groups/${groupId}/members/${target.accountId}` }),
  );
}

function myGroup(player: Player) {
  return app.inject(authed(player, { method: 'GET', url: '/api/v1/groups/me' }));
}

function channels(player: Player) {
  return app.inject(authed(player, { method: 'GET', url: '/api/v1/chat/channels' }));
}

function messages(player: Player, channelId: string) {
  return app.inject(
    authed(player, { method: 'GET', url: `/api/v1/chat/channels/${channelId}/messages` }),
  );
}

async function foundGroup(leader: Player, name: string): Promise<{ id: string; channelId: string }> {
  const created = await createGroup(leader, name);
  expect(created.statusCode, created.body).toBe(201);
  const group = (created.json() as MyGroupResponse).group!;
  return { id: group.id, channelId: group.channelId };
}

async function join(member: Player, groupId: string, inviter: Player): Promise<void> {
  const invited = await invite(inviter, groupId, member);
  expect(invited.statusCode, invited.body).toBe(201);
  const answered = await respond(member, invited.json().invite.id, true);
  expect(answered.statusCode, answered.body).toBe(200);
}

/** The unread count for one channel exactly as the client's channel list reports it. */
async function unreadOf(player: Player, channelId: string): Promise<number> {
  const response = await channels(player);
  expect(response.statusCode, response.body).toBe(200);
  const found = response.json().channels.find((entry: { id: string }) => entry.id === channelId);
  return found?.unreadCount ?? -1;
}

async function inviteStateOf(inviteId: string): Promise<{ state: string; resolved_at: Date | null }> {
  const result = await db.query<{ state: string; resolved_at: Date | null }>(
    'SELECT state, resolved_at FROM group_invites WHERE id = $1',
    [inviteId],
  );
  return result.rows[0]!;
}

/* =============================== G-1 =============================== */

describe('G-1: an invitation reaches an online recipient without being asked for', () => {
  it('pushes group:sync to the invitee and to nobody else', async () => {
    const leader = await makePlayer('Sync Host');
    const invitee = await makePlayer('Sync Guest');
    const bystander = await makePlayer('Sync Bystander');
    const group = await foundGroup(leader, groupName('Signal'));

    const inviteeSocket = await TestClient.connect(baseUrl, invitee.accessToken);
    const bystanderSocket = await TestClient.connect(baseUrl, bystander.accessToken);
    const leaderSocket = await TestClient.connect(baseUrl, leader.accessToken);

    const issued = await invite(leader, group.id, invitee);
    expect(issued.statusCode, issued.body).toBe(201);

    await inviteeSocket.next('group:sync');

    // The frame reaches exactly one account. Give the others a beat to be wrong in.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(bystanderSocket.received('group:sync'), 'an uninvolved player was told').toEqual([]);
    expect(leaderSocket.received('group:sync'), 'the inviter was told about their own action').toEqual([]);

    await closeAll([inviteeSocket, bystanderSocket, leaderSocket]);
  });

  it('carries no group-identifying payload in the raw frame', async () => {
    const leader = await makePlayer('Quiet Host');
    const invitee = await makePlayer('Quiet Guest');
    const name = groupName('Secret Society');
    const group = await foundGroup(leader, name);

    const socket = await TestClient.connect(baseUrl, invitee.accessToken);
    expect((await invite(leader, group.id, invitee)).statusCode).toBe(201);
    await socket.next('group:sync');

    const syncFrames = socket.frames.filter((frame) => frame.includes('group:sync'));
    expect(syncFrames).toHaveLength(1);
    expect(syncFrames[0]).toBe('{"type":"group:sync"}');

    // Nothing anywhere in this socket's transcript names the group it was invited to.
    const transcript = socket.transcript();
    expect(transcript, 'the group id leaked into the nudge').not.toContain(group.id);
    expect(transcript, 'the group name leaked into the nudge').not.toContain(name);
    expect(transcript, 'the channel id leaked into the nudge').not.toContain(group.channelId);
    expect(transcript, 'the inviter leaked into the nudge').not.toContain(leader.accountId);

    await closeAll([socket]);
  });

  it('shows an invitation issued while the recipient was offline on their next connect', async () => {
    const leader = await makePlayer('Patient Host');
    const invitee = await makePlayer('Absent Guest');
    const group = await foundGroup(leader, groupName('Left A Note'));

    // No socket at all when the invitation is issued: the push has nowhere to land.
    expect((await invite(leader, group.id, invitee)).statusCode).toBe(201);

    const socket = await TestClient.connect(baseUrl, invitee.accessToken);
    // `ready` is the only frame they get, and the provider re-reads on it.
    expect(socket.received('ready')).toHaveLength(1);
    expect(socket.received('group:sync'), 'a sync arrived that was never sent').toEqual([]);

    const mine = await myGroup(invitee);
    expect(mine.statusCode).toBe(200);
    expect((mine.json() as MyGroupResponse).invites).toHaveLength(1);
    expect((mine.json() as MyGroupResponse).invites[0]!.groupId).toBe(group.id);

    await closeAll([socket]);
  });
});

/* =============================== G-4 =============================== */

describe('G-4: a system message about you is not unread news to you', () => {
  it('does not count a member own arrival towards their own unread badge', async () => {
    const leader = await makePlayer('Unread Host');
    const joiner = await makePlayer('Unread Joiner');
    const group = await foundGroup(leader, groupName('Arrivals'));

    await join(joiner, group.id, leader);

    expect(await unreadOf(joiner, group.channelId), 'own join inflated own unread').toBe(0);
    // The message itself is still there to read — suppressed from the count, not from the room.
    const room = await messages(joiner, group.channelId);
    expect(room.statusCode).toBe(200);
    expect(room.json().messages.some((m: { body: string }) => m.body.includes('joined the group'))).toBe(
      true,
    );
  });

  it('still counts someone else arrival as unread for an existing member', async () => {
    const leader = await makePlayer('Watcher Host');
    const first = await makePlayer('Watcher B');
    const second = await makePlayer('Watcher A');
    const group = await foundGroup(leader, groupName('Two Arrivals'));

    await join(first, group.id, leader);
    expect(await unreadOf(first, group.channelId)).toBe(0);

    await join(second, group.id, leader);

    // B must still see "A joined the group." as a normal unread line: only A's own arrival
    // is excluded from A's own count, never from anybody else's.
    expect(await unreadOf(first, group.channelId), 'B lost a legitimate unread').toBe(1);
    // And the leader, subject of neither, sees both arrivals.
    expect(await unreadOf(leader, group.channelId)).toBe(2);

    // A joined into an existing backlog, so their count is not zero — but the one row it
    // holds must be the *other* arrival, never their own. Reading up to B's line, which is
    // older than A's own, must therefore clear A's badge completely.
    const bJoined = await db.query<{ id: string }>(
      `SELECT m.id FROM chat_messages m
       WHERE m.channel_id = $1 AND m.subject_account_id = $2`,
      [group.channelId, first.accountId],
    );
    expect(bJoined.rowCount).toBe(1);
    await db.query(
      'UPDATE chat_channel_members SET last_read_message_id = $3 WHERE channel_id = $1 AND account_id = $2',
      [group.channelId, second.accountId, bJoined.rows[0]!.id],
    );
    expect(await unreadOf(second, group.channelId), 'A own arrival counted for A').toBe(0);
  });

  it('counts a leadership promotion as unread for the member being promoted', async () => {
    const leader = await makePlayer('Departing Host');
    const heir = await makePlayer('Heir');
    const group = await foundGroup(leader, groupName('Succession'));

    await join(heir, group.id, leader);
    expect(await unreadOf(heir, group.channelId)).toBe(0);

    expect((await leave(leader)).statusCode).toBe(200);

    // "X left the group." and "Y is now the leader." — the promotion is genuine news to Y,
    // who did not cause it, so suppressing it would be an over-correction of this fix.
    const room = await messages(heir, group.channelId);
    const bodies = room.json().messages.map((m: { body: string }) => m.body);
    expect(bodies.some((body: string) => body.includes('is now the leader'))).toBe(true);
    expect(await unreadOf(heir, group.channelId), 'the promotion was suppressed too').toBe(2);

    const promotionSubject = await db.query<{ subject_account_id: string | null }>(
      `SELECT subject_account_id FROM chat_messages
       WHERE channel_id = $1 AND body LIKE '%is now the leader%'`,
      [group.channelId],
    );
    expect(promotionSubject.rows[0]!.subject_account_id).toBeNull();
  });

  it('leaves a departure and a removal as ordinary unread news for those still in the room', async () => {
    const leader = await makePlayer('Roster Host');
    const stayer = await makePlayer('Stayer');
    const quitter = await makePlayer('Quitter');
    const ejected = await makePlayer('Ejected');
    const group = await foundGroup(leader, groupName('Departures'));

    await join(stayer, group.id, leader);
    await join(quitter, group.id, leader);
    await join(ejected, group.id, leader);
    const before = await unreadOf(stayer, group.channelId);

    expect((await leave(quitter)).statusCode).toBe(200);
    expect((await kick(leader, group.id, ejected)).statusCode).toBe(200);

    // Both lines are news to a member who is still there.
    expect(await unreadOf(stayer, group.channelId)).toBe(before + 2);

    const subjects = await db.query<{ body: string; subject_account_id: string | null }>(
      `SELECT body, subject_account_id FROM chat_messages
       WHERE channel_id = $1 AND (body LIKE '%left the group%' OR body LIKE '%was removed%')`,
      [group.channelId],
    );
    expect(subjects.rows).toHaveLength(2);
    for (const row of subjects.rows) expect(row.subject_account_id, row.body).toBeNull();

    // And neither departed player can read the room any more, so unread-for-them is moot.
    // 404, not 403: a room you are out of is indistinguishable from one that never existed.
    expect((await messages(quitter, group.channelId)).statusCode).toBe(404);
    expect((await messages(ejected, group.channelId)).statusCode).toBe(404);
  });

  it('refuses a message that claims both an author and a subject', async () => {
    const leader = await makePlayer('Constraint Host');
    const group = await foundGroup(leader, groupName('Constraint'));

    await expect(
      db.query(
        `INSERT INTO chat_messages (
           id, channel_id, author_account_id, author_character_id, author_name_snapshot, body,
           moderation, subject_account_id
         ) VALUES (gen_random_uuid(), $1, $2, $3, 'x', 'forged', 'clean', $2)`,
        [group.channelId, leader.accountId, leader.characterId],
      ),
    ).rejects.toThrow(/chat_messages_subject_is_system/);
  });
});

/* =============================== G-5 =============================== */

describe('G-5: founding a group settles the invitations you were holding', () => {
  it('cancels outstanding invitations from other groups', async () => {
    const hostA = await makePlayer('Suitor A');
    const hostB = await makePlayer('Suitor B');
    const founder = await makePlayer('Founder');
    const groupA = await foundGroup(hostA, groupName('Offer A'));
    const groupB = await foundGroup(hostB, groupName('Offer B'));

    const inviteA = (await invite(hostA, groupA.id, founder)).json().invite.id;
    const inviteB = (await invite(hostB, groupB.id, founder)).json().invite.id;
    expect((await myGroup(founder)).json().invites).toHaveLength(2);

    const created = await createGroup(founder, groupName('Own Roof'));
    expect(created.statusCode, created.body).toBe(201);

    // The create response is what the client renders, so it has to be right on its own.
    expect((created.json() as MyGroupResponse).invites, 'the create reply still offered them').toEqual([]);
    // And so is the next read.
    expect((await myGroup(founder)).json().invites).toEqual([]);

    for (const inviteId of [inviteA, inviteB]) {
      const row = await inviteStateOf(inviteId);
      expect(row.state, 'invitation left in a non-terminal state').toBe('cancelled');
      expect(row.resolved_at, 'cancelled without a resolution time').not.toBeNull();
    }
  });

  it('refuses a stale invitation that is acted on after founding', async () => {
    const host = await makePlayer('Stale Host');
    const founder = await makePlayer('Stale Founder');
    const group = await foundGroup(host, groupName('Stale Offer'));
    const inviteId = (await invite(host, group.id, founder)).json().invite.id;

    expect((await createGroup(founder, groupName('Stale Roof'))).statusCode).toBe(201);

    const accepted = await respond(founder, inviteId, true);
    expect(accepted.statusCode, accepted.body).toBe(404);
    expect(accepted.json().error.code).toBe('NOT_FOUND');
    // Declining a cancelled invitation is equally a no-op, not a crash.
    expect((await respond(founder, inviteId, false)).statusCode).toBe(404);
    expect((await inviteStateOf(inviteId)).state).toBe('cancelled');
  });

  it('frees the pending-invite seat so the same group can invite them again later', async () => {
    const host = await makePlayer('Seat Host');
    const founder = await makePlayer('Seat Founder');
    const group = await foundGroup(host, groupName('Seat Offer'));
    expect((await invite(host, group.id, founder)).statusCode).toBe(201);

    expect((await createGroup(founder, groupName('Seat Roof'))).statusCode).toBe(201);
    expect((await leave(founder)).statusCode).toBe(200);

    // The partial unique index must genuinely be free, not merely hidden by the API.
    const reissued = await db.query(
      `INSERT INTO group_invites (id, group_id, from_account_id, to_account_id, expires_at)
       VALUES (gen_random_uuid(), $1, $2, $3, now() + interval '7 days')`,
      [group.id, host.accountId, founder.accountId],
    );
    expect(reissued.rowCount).toBe(1);
  });
});

/* =============================== G-6 =============================== */

describe('G-6: an invitation into a group that has ended is cancelled with it', () => {
  it('cancels the pending invitation when the last member leaves', async () => {
    const host = await makePlayer('Last Host');
    const outsider = await makePlayer('Never Answered');
    const group = await foundGroup(host, groupName('Closing Down'));
    const inviteId = (await invite(host, group.id, outsider)).json().invite.id;

    // The last member walking away is the only way a group ends.
    expect((await leave(host)).statusCode).toBe(200);
    const archived = await db.query<{ archived_at: Date | null }>(
      'SELECT archived_at FROM groups WHERE id = $1',
      [group.id],
    );
    expect(archived.rows[0]!.archived_at).not.toBeNull();

    const row = await inviteStateOf(inviteId);
    expect(row.state, 'the invitation was left dangling as pending').toBe('cancelled');
    expect(row.resolved_at).not.toBeNull();

    // Not merely invisible through the API — the index seat is actually released.
    const seat = await db.query(
      `INSERT INTO group_invites (id, group_id, from_account_id, to_account_id, expires_at)
       VALUES (gen_random_uuid(), $1, $2, $3, now() + interval '7 days')`,
      [group.id, host.accountId, outsider.accountId],
    );
    expect(seat.rowCount, 'ux_group_invites_pending still holds the cancelled seat').toBe(1);
    await db.query(`DELETE FROM group_invites WHERE group_id = $1 AND state = 'pending'`, [group.id]);
  });

  it('archives the group chat channel alongside it', async () => {
    const host = await makePlayer('Channel Host');
    const group = await foundGroup(host, groupName('Lights Out'));
    expect((await leave(host)).statusCode).toBe(200);

    const channel = await db.query<{ archived_at: Date | null }>(
      'SELECT archived_at FROM chat_channels WHERE id = $1',
      [group.channelId],
    );
    expect(channel.rows[0]!.archived_at).not.toBeNull();
  });
});

/* =============================== G-2 =============================== */

/** The original repro: there is no product path to account deletion, so drive it at the DB. */
async function deleteAccount(accountId: string): Promise<void> {
  await db.query('DELETE FROM accounts WHERE id = $1', [accountId]);
}

async function rawLeader(groupId: string): Promise<string | null> {
  const result = await db.query<{ leader_account_id: string | null; archived_at: Date | null }>(
    'SELECT leader_account_id, archived_at FROM groups WHERE id = $1',
    [groupId],
  );
  expect(result.rowCount, 'the group row is gone').toBe(1);
  return result.rows[0]!.leader_account_id;
}

describe('G-2: a deleted leader hands the group over instead of destroying it', () => {
  it('leaves the group and its chat channel intact', async () => {
    const leader = await makePlayer('Doomed Leader');
    const heir = await makePlayer('Heir Apparent');
    const later = await makePlayer('Latecomer');
    const group = await foundGroup(leader, groupName('Survivor'));
    await join(heir, group.id, leader);
    await join(later, group.id, leader);

    await deleteAccount(leader.accountId);

    // The group row survives, leaderless for the moment.
    expect(await rawLeader(group.id)).toBeNull();
    const channel = await db.query<{ archived_at: Date | null }>(
      'SELECT archived_at FROM chat_channels WHERE id = $1',
      [group.channelId],
    );
    expect(channel.rowCount, 'the chat channel was destroyed with the leader').toBe(1);
    expect(channel.rows[0]!.archived_at).toBeNull();

    // And it is still readable by the people still in it.
    const room = await messages(heir, group.channelId);
    expect(room.statusCode, room.body).toBe(200);
    expect(room.json().messages.length).toBeGreaterThan(0);

    // Close the NULL window before leaving: the integration database is shared, and the
    // stress suite's "every live group's leader is one of its members" invariant is global.
    expect((await findGroupById(db, group.id))!.leader_account_id).toBe(heir.accountId);
  });

  it('heals through a plain public GET', async () => {
    const leader = await makePlayer('GET Leader');
    const heir = await makePlayer('GET Heir');
    const group = await foundGroup(leader, groupName('Heal By Get'));
    await join(heir, group.id, leader);
    await deleteAccount(leader.accountId);
    expect(await rawLeader(group.id)).toBeNull();

    const response = await app.inject(
      authed(heir, { method: 'GET', url: `/api/v1/groups/${group.id}` }),
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().group.leaderAccountId).toBe(heir.accountId);
    expect(await rawLeader(group.id), 'the heal was cosmetic, not persisted').toBe(heir.accountId);
  });

  it('heals through the caller own group read', async () => {
    const leader = await makePlayer('Me Leader');
    const heir = await makePlayer('Me Heir');
    const group = await foundGroup(leader, groupName('Heal By Me'));
    await join(heir, group.id, leader);
    await deleteAccount(leader.accountId);

    const response = await myGroup(heir);
    expect(response.statusCode).toBe(200);
    const mine = (response.json() as MyGroupResponse).group!;
    expect(mine.leaderAccountId).toBe(heir.accountId);
    expect(mine.role, 'the heir is still shown as a plain member').toBe('leader');
    expect(await rawLeader(group.id)).toBe(heir.accountId);
  });

  it('heals through lockGroup inside a write transaction', async () => {
    const leader = await makePlayer('Lock Leader');
    const heir = await makePlayer('Lock Heir');
    const group = await foundGroup(leader, groupName('Heal By Lock'));
    await join(heir, group.id, leader);
    await deleteAccount(leader.accountId);
    expect(await rawLeader(group.id)).toBeNull();

    const healed = await withTransaction(db, (client) => lockGroup(client, group.id));
    expect(healed!.leader_account_id).toBe(heir.accountId);
    expect(await rawLeader(group.id)).toBe(heir.accountId);
  });

  it('heals through lockActiveGroupForAccount inside a write transaction', async () => {
    const leader = await makePlayer('Active Leader');
    const heir = await makePlayer('Active Heir');
    const group = await foundGroup(leader, groupName('Heal By Active'));
    await join(heir, group.id, leader);
    await deleteAccount(leader.accountId);
    expect(await rawLeader(group.id)).toBeNull();

    const healed = await withTransaction(db, (client) =>
      lockActiveGroupForAccount(client, heir.accountId),
    );
    expect(healed!.leader_account_id).toBe(heir.accountId);
    expect(await rawLeader(group.id)).toBe(heir.accountId);
  });

  it('heals through the two unlocked repo reads as well', async () => {
    const leader = await makePlayer('Repo Leader');
    const heir = await makePlayer('Repo Heir');
    const group = await foundGroup(leader, groupName('Heal By Repo'));
    await join(heir, group.id, leader);

    await deleteAccount(leader.accountId);
    expect((await findGroupById(db, group.id))!.leader_account_id).toBe(heir.accountId);

    // And the other unlocked path, from a fresh NULL.
    await db.query('UPDATE groups SET leader_account_id = NULL WHERE id = $1', [group.id]);
    expect((await findActiveGroupForAccount(db, heir.accountId))!.leader_account_id).toBe(heir.accountId);
  });

  it('promotes the longest-standing remaining member, not an arbitrary one', async () => {
    const leader = await makePlayer('Order Leader');
    const first = await makePlayer('Joined First');
    const second = await makePlayer('Joined Second');
    const third = await makePlayer('Joined Third');
    const group = await foundGroup(leader, groupName('Seniority'));
    await join(first, group.id, leader);
    await join(second, group.id, leader);
    await join(third, group.id, leader);

    await deleteAccount(leader.accountId);
    const response = await app.inject(authed(third, { method: 'GET', url: `/api/v1/groups/${group.id}` }));
    expect(response.json().group.leaderAccountId).toBe(first.accountId);
  });

  it('breaks a joined_at tie by account id, the same way a voluntary handoff does', async () => {
    const leader = await makePlayer('Tie Leader');
    const one = await makePlayer('Tie One');
    const two = await makePlayer('Tie Two');
    const group = await foundGroup(leader, groupName('Dead Heat'));
    await join(one, group.id, leader);
    await join(two, group.id, leader);

    // Same instant for both, so only the account-id tie-break can decide.
    const at = new Date(Date.now() - 60_000);
    await db.query('UPDATE group_members SET joined_at = $2 WHERE group_id = $1 AND account_id = ANY($3)', [
      group.id,
      at,
      [one.accountId, two.accountId],
    ]);
    const expected = [one.accountId, two.accountId].sort()[0];

    await deleteAccount(leader.accountId);
    const response = await app.inject(authed(one, { method: 'GET', url: `/api/v1/groups/${group.id}` }));
    expect(response.json().group.leaderAccountId).toBe(expected);
  });

  it('lets the promoted leader use leader powers immediately', async () => {
    const leader = await makePlayer('Power Leader');
    const heir = await makePlayer('Power Heir');
    const target = await makePlayer('Power Target');
    const group = await foundGroup(leader, groupName('New Authority'));
    await join(heir, group.id, leader);
    await join(target, group.id, leader);

    await deleteAccount(leader.accountId);

    // Straight to a leader-only action with no read in between: the kick path takes
    // `lockGroup`, so the heal has to fire there or this is a 403.
    const removed = await kick(heir, group.id, target);
    expect(removed.statusCode, removed.body).toBe(200);
    expect((removed.json() as MyGroupResponse).group!.memberCount).toBe(1);
    expect((removed.json() as MyGroupResponse).group!.role).toBe('leader');
  });

  it('lets a non-leader member leave normally through the whole sequence', async () => {
    const leader = await makePlayer('Exit Leader');
    const heir = await makePlayer('Exit Heir');
    const other = await makePlayer('Exit Other');
    const group = await foundGroup(leader, groupName('Orderly Exit'));
    await join(heir, group.id, leader);
    await join(other, group.id, leader);

    await deleteAccount(leader.accountId);

    // The non-leader leaves first, which is the read that heals the group.
    const left = await leave(other);
    expect(left.statusCode, left.body).toBe(200);
    expect((left.json() as MyGroupResponse).group).toBeNull();
    expect(await rawLeader(group.id)).toBe(heir.accountId);

    // And the heir can still leave afterwards, ending the group cleanly.
    expect((await leave(heir)).statusCode).toBe(200);
    const archived = await db.query<{ archived_at: Date | null }>(
      'SELECT archived_at FROM groups WHERE id = $1',
      [group.id],
    );
    expect(archived.rows[0]!.archived_at).not.toBeNull();
  });

  it('cannot be raced into two different promotions during the NULL window', async () => {
    const leader = await makePlayer('Race Leader');
    const members = await Promise.all(
      Array.from({ length: 6 }, (_unused, index) => makePlayer(`Racer ${index}`)),
    );
    const group = await foundGroup(leader, groupName('Photo Finish'));
    for (const member of members) await join(member, group.id, leader);
    const expected = members[0]!.accountId;

    await deleteAccount(leader.accountId);

    // Eight readers hit the NULL window at once, across every healing path.
    const readers = [
      ...members.map((member) => app.inject(authed(member, { method: 'GET', url: `/api/v1/groups/${group.id}` }))),
      withTransaction(db, (client) => lockGroup(client, group.id)),
      findGroupById(db, group.id),
    ];
    const results = await Promise.all(readers);

    for (const result of results.slice(0, members.length)) {
      const response = result as { statusCode: number; body: string };
      expect(response.statusCode, response.body).toBe(200);
    }
    // Exactly one leader, and it is the longest-standing member.
    expect(await rawLeader(group.id)).toBe(expected);

    // No reader is allowed to have observed a *different* winner.
    const seen = new Set(
      results
        .slice(0, members.length)
        .map((result) => JSON.parse((result as { body: string }).body).group.leaderAccountId),
    );
    expect([...seen].filter((value) => value !== null)).toEqual([expected]);
  });

  it('never promotes somebody who is not a live member', async () => {
    const leader = await makePlayer('Ghost Leader');
    const heir = await makePlayer('Ghost Heir');
    const gone = await makePlayer('Already Left');
    const group = await foundGroup(leader, groupName('No Ghosts'));
    await join(gone, group.id, leader);
    await join(heir, group.id, leader);
    expect((await leave(gone)).statusCode).toBe(200);

    await deleteAccount(leader.accountId);
    const response = await app.inject(authed(heir, { method: 'GET', url: `/api/v1/groups/${group.id}` }));
    expect(response.json().group.leaderAccountId).toBe(heir.accountId);
    expect(response.json().group.members.map((m: { accountId: string }) => m.accountId)).toEqual([
      heir.accountId,
    ]);
  });

  it('leaves an archived group alone rather than resurrecting a leader for it', async () => {
    const leader = await makePlayer('Archived Leader');
    const group = await foundGroup(leader, groupName('Already Over'));
    expect((await leave(leader)).statusCode).toBe(200);

    await deleteAccount(leader.accountId);
    expect(await rawLeader(group.id)).toBeNull();

    // Reading it must not promote a departed member back into charge of a dead group.
    expect((await findGroupById(db, group.id))!.leader_account_id).toBeNull();
    expect(await rawLeader(group.id)).toBeNull();
  });
});

/* ============================ new: R2-2 ============================ */

/**
 * Round-2 finding R2-2. The heal is safe under a race — the conditional `WHERE
 * leader_account_id IS NULL` plus the row lock means exactly one promotion ever lands — but
 * the *losing* reader returns the stale row it selected before the winner committed, so an
 * unlocked read path can answer `leaderAccountId: null` for a group that is, by then,
 * already led. Locked paths (`lockGroup`, `lockActiveGroupForAccount`) re-read under the
 * lock and are unaffected, which is why kicking and leaving still work.
 */
describe('R2-2: the lazy heal is race-safe but its loser answers stale', () => {
  it('never produces two promotions, whatever loses the race', async () => {
    const leader = await makePlayer('Safety Leader');
    const members = await Promise.all(
      Array.from({ length: 5 }, (_unused, index) => makePlayer(`Safety ${index}`)),
    );
    const group = await foundGroup(leader, groupName('One Winner'));
    for (const member of members) await join(member, group.id, leader);
    // The column is blanked rather than the account deleted, so the founder is still the
    // longest-standing live member and is the correct pick every round.
    const expected = leader.accountId;

    let staleAnswers = 0;
    for (let round = 0; round < 10; round += 1) {
      await db.query('UPDATE groups SET leader_account_id = NULL WHERE id = $1', [group.id]);
      const reads = await Promise.all(
        Array.from({ length: 6 }, () => findGroupById(db, group.id)),
      );
      // Safety: one persisted winner, and it is the longest-standing member.
      expect(await rawLeader(group.id)).toBe(expected);
      // Liveness: nobody is ever handed a *different* leader.
      for (const read of reads) {
        if (read!.leader_account_id === null) staleAnswers += 1;
        else expect(read!.leader_account_id).toBe(expected);
      }
    }

    // The defect, measured rather than asserted away: under contention most readers get a
    // NULL leader back for a group that is already led. It is transient and self-correcting
    // on the next read, and only reachable inside the account-deletion window.
    expect(staleAnswers).toBeGreaterThan(0);
  });

  it('shows the healed leader their own leader role once the window closes', async () => {
    const leader = await makePlayer('Role Leader');
    const heir = await makePlayer('Role Heir');
    const group = await foundGroup(leader, groupName('Role Check'));
    await join(heir, group.id, leader);
    await deleteAccount(leader.accountId);

    // A single uncontended read is always correct; it is only the concurrent loser that is
    // stale, and the very next read fixes it.
    const mine = (await myGroup(heir)).json() as MyGroupResponse;
    expect(mine.group!.role).toBe('leader');
    expect((await myGroup(heir)).json().group.role).toBe('leader');
  });
});

/* ============================ new: R2-1 ============================ */

/**
 * Round-2 finding R2-1, pinned. G-2 replaced the leader cascade with SET NULL plus a lazy
 * heal that promotes "the longest-standing remaining member" — but when the deleted leader
 * *was* the last member there is nobody to promote, and nothing archives the group either.
 * The row is then live, empty and leaderless forever: the one state `archiveGroup` exists
 * to prevent, and the exact shape the stress suite's third invariant forbids.
 *
 * `it.fails` on purpose: this passes while the defect is present and starts failing the
 * moment it is fixed, which is the signal to turn it into a normal assertion.
 */
describe('R2-1: a solo founder whose account is deleted leaves the group half-alive', () => {
  it.fails('archives a group that has been left empty by an account deletion', async () => {
    const founder = await makePlayer('Solo Founder');
    const group = await foundGroup(founder, groupName('Zombie'));

    await deleteAccount(founder.accountId);

    // Nobody is left, so the heal has nobody to promote.
    expect((await findGroupById(db, group.id))!.leader_account_id).toBeNull();

    try {
      // The invariant: a group is archived exactly when it is empty. This is the assertion
      // that currently fails — the group is empty but still live.
      const row = await db.query<{ archived_at: Date | null; count: number }>(
        `SELECT g.archived_at,
                (SELECT count(*)::int FROM group_members m
                 WHERE m.group_id = g.id AND m.left_at IS NULL) AS count
         FROM groups g WHERE g.id = $1`,
        [group.id],
      );
      expect(row.rows[0]!.count).toBe(0);
      expect(row.rows[0]!.archived_at, 'an empty group was left unarchived').not.toBeNull();
    } finally {
      // The integration database is shared and the stress suite checks this invariant
      // globally, so tidy the zombie away however this assertion lands.
      await db.query('UPDATE groups SET archived_at = now() WHERE id = $1 AND archived_at IS NULL', [
        group.id,
      ]);
      await db.query('UPDATE chat_channels SET archived_at = now() WHERE id = $1 AND archived_at IS NULL', [
        group.channelId,
      ]);
    }
  });

  it('serves the half-alive group as a live, memberless group over the public API', async () => {
    const founder = await makePlayer('Ghost Founder');
    const looker = await makePlayer('Passer By');
    const group = await foundGroup(founder, groupName('Ghost Town'));
    await deleteAccount(founder.accountId);

    // Documented current behaviour, not desired behaviour: `GET /groups/:id` answers 200
    // for a group with nobody in it and nobody able to lead it.
    const response = await app.inject(
      authed(looker, { method: 'GET', url: `/api/v1/groups/${group.id}` }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().group.memberCount).toBe(0);
    expect(response.json().group.leaderAccountId).toBeNull();

    await db.query('UPDATE groups SET archived_at = now() WHERE id = $1', [group.id]);
    await db.query('UPDATE chat_channels SET archived_at = now() WHERE id = $1', [group.channelId]);
  });

  it('still lets a surviving invitation revive a group emptied this way', async () => {
    // The variant that does recover, recorded so a fix for the above does not break it:
    // an invitation issued by a member other than the deleted leader outlives them, and
    // accepting it puts somebody back in charge.
    const leader = await makePlayer('Revive Leader');
    const middle = await makePlayer('Revive Middle');
    const outsider = await makePlayer('Revive Outsider');
    const group = await foundGroup(leader, groupName('Revivable'));
    await join(middle, group.id, leader);

    const issued = await invite(middle, group.id, outsider);
    expect(issued.statusCode, issued.body).toBe(201);
    const inviteId = issued.json().invite.id;
    expect((await leave(middle)).statusCode).toBe(200);

    await deleteAccount(leader.accountId);

    const accepted = await respond(outsider, inviteId, true);
    expect(accepted.statusCode, accepted.body).toBe(200);
    const mine = (accepted.json() as MyGroupResponse).group!;
    expect(mine.leaderAccountId).toBe(outsider.accountId);
    expect(mine.role).toBe('leader');
    expect(mine.memberCount).toBe(1);
  });
});

/* =============================== G-3 =============================== */

describe('G-3: nothing in the product hard-deletes a group', () => {
  it('has no reachable path that removes a groups row', async () => {
    const leader = await makePlayer('Persist Leader');
    const member = await makePlayer('Persist Member');
    const group = await foundGroup(leader, groupName('Indelible'));
    await join(member, group.id, leader);

    // Every roster-ending action the product offers, in sequence.
    expect((await kick(leader, group.id, member)).statusCode).toBe(200);
    expect((await leave(leader)).statusCode).toBe(200);

    const still = await db.query('SELECT 1 FROM groups WHERE id = $1', [group.id]);
    expect(still.rowCount, 'a product action hard-deleted the group row').toBe(1);

    // The departure history the create cooldown is derived from also survives.
    const history = await db.query<{ count: string }>(
      'SELECT count(*) FROM group_members WHERE group_id = $1',
      [group.id],
    );
    expect(Number(history.rows[0]!.count)).toBe(2);
  });

  it('keeps the create cooldown derivable after the leader account is deleted', async () => {
    const leader = await makePlayer('Cooldown Leader');
    const member = await makePlayer('Cooldown Member');
    const group = await foundGroup(leader, groupName('Cooldown Kept'));
    await join(member, group.id, leader);
    expect((await leave(member)).statusCode).toBe(200);

    await deleteAccount(leader.accountId);

    // The departing member's own history is what their cooldown reads, and deleting
    // somebody else's account must not clear it.
    const departure = await db.query<{ count: string }>(
      'SELECT count(*) FROM group_members WHERE account_id = $1 AND left_at IS NOT NULL',
      [member.accountId],
    );
    expect(Number(departure.rows[0]!.count)).toBe(1);

    const blocked = await createGroup(member, groupName('Too Soon'));
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('GROUP_CREATE_COOLDOWN');

    // Shared database: this test deletes the last remaining account, so it leaves behind an
    // instance of R2-1 — a live, empty, leaderless group that the heal provably cannot
    // resolve (there is nobody to promote and nothing archives it). Tidy it by hand, which
    // is itself the clearest demonstration that the product has no way to.
    expect((await findGroupById(db, group.id))!.leader_account_id).toBeNull();
    await db.query('UPDATE groups SET archived_at = now() WHERE id = $1 AND archived_at IS NULL', [
      group.id,
    ]);
    await db.query('UPDATE chat_channels SET archived_at = now() WHERE id = $1 AND archived_at IS NULL', [
      group.channelId,
    ]);
  });
});
