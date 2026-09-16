import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { GROUP_MAX_MEMBERS, type MyGroupResponse } from '@lethalmagotchi/shared';
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

/**
 * QA round 1 — the deadlock probe. Round 1's own fix was a lock-ordering deadlock that
 * surfaced as a raw 500, so the bar here is not "the right answer" but "no answer the
 * client cannot read": every response must carry a stated API error code, never a 500,
 * and every invariant must hold after the dust settles.
 */

interface Player extends TestAccount {
  characterId: string;
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

function groupName(label: string): string {
  return `${label.slice(0, 15)} ${randomUUID().slice(0, 6)}`;
}

async function makePlayer(nickname: string): Promise<Player> {
  const account = await registerAccount(app, { username: uniqueUsername('str') });
  const response = await app.inject(
    authed(account, { method: 'POST', url: '/api/v1/characters', payload: { ...VALID_CHARACTER, nickname } }),
  );
  expect(response.statusCode, response.body).toBe(201);
  await db.query(`UPDATE accounts SET created_at = now() - interval '48 hours' WHERE id = $1`, [
    account.accountId,
  ]);
  return { ...account, characterId: response.json().character.id };
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

async function foundGroup(leader: Player, name: string): Promise<string> {
  const created = await createGroup(leader, name);
  expect(created.statusCode, created.body).toBe(201);
  return (created.json() as MyGroupResponse).group!.id;
}

async function join(member: Player, groupId: string, inviter: Player): Promise<void> {
  const invited = await invite(inviter, groupId, member);
  expect(invited.statusCode, invited.body).toBe(201);
  expect((await respond(member, invited.json().invite.id, true)).statusCode).toBe(200);
}

/** A 500 is the shape the round-1 deadlock took; 40x with a code is a real answer. */
function assertNoRawFailures(responses: { statusCode: number; body: string }[], label: string): void {
  for (const response of responses) {
    expect(response.statusCode, `${label}: ${response.body}`).toBeLessThan(500);
  }
}

async function countDeadlocks(): Promise<number> {
  const result = await db.query<{ deadlocks: string }>(
    'SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()',
  );
  return Number(result.rows[0]?.deadlocks ?? 0);
}

describe('mixed roster traffic under contention', () => {
  it('never deadlocks and never leaves the roster inconsistent', async () => {
    const before = await countDeadlocks();

    const leader = await makePlayer('Stress Leader');
    const groupId = await foundGroup(leader, groupName('Pressure'));
    const members = await Promise.all(
      Array.from({ length: 12 }, (_unused, index) => makePlayer(`Body ${index}`)),
    );
    for (const member of members) await join(member, groupId, leader);

    const rival = await makePlayer('Rival Leader');
    const rivalGroup = await foundGroup(rival, groupName('Elsewhere'));

    // Invitations out of the rival group to people who are currently in the first one, then
    // revived — so an accept, a kick and a leave all contend for the same accounts at once.
    const poached = members.slice(0, 6);
    const inviteIds: string[] = [];
    for (const member of poached) {
      await leave(member);
      const issued = await invite(rival, rivalGroup, member);
      expect(issued.statusCode, issued.body).toBe(201);
      inviteIds.push(issued.json().invite.id);
      await join(member, groupId, leader);
      await db.query(`UPDATE group_invites SET state = 'pending', resolved_at = NULL WHERE id = $1`, [
        issued.json().invite.id,
      ]);
    }

    const work = [
      ...poached.map((member, index) => respond(member, inviteIds[index]!, true)),
      ...poached.map((member) => kick(leader, groupId, member)),
      ...members.slice(6).map((member) => leave(member)),
      leave(leader),
    ];
    const results = await Promise.all(work);
    assertNoRawFailures(results, 'mixed roster traffic');

    expect(await countDeadlocks(), 'Postgres recorded a deadlock').toBe(before);

    // Invariant 1: nobody holds two live memberships.
    const doubled = await db.query<{ account_id: string }>(
      `SELECT account_id FROM group_members WHERE left_at IS NULL
       GROUP BY account_id HAVING count(*) > 1`,
    );
    expect(doubled.rows).toEqual([]);

    // Invariant 2: every live group's leader is one of its own live members.
    const leaderless = await db.query<{ id: string }>(
      `SELECT g.id FROM groups g
       WHERE g.archived_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM group_members m
           WHERE m.group_id = g.id AND m.account_id = g.leader_account_id AND m.left_at IS NULL
         )`,
    );
    expect(leaderless.rows, 'a live group with a leader who is not in it').toEqual([]);

    // Invariant 3: a group is archived exactly when it is empty.
    const mismatched = await db.query<{ id: string }>(
      `SELECT g.id FROM groups g
       WHERE (g.archived_at IS NULL) <> EXISTS (
         SELECT 1 FROM group_members m WHERE m.group_id = g.id AND m.left_at IS NULL
       )`,
    );
    expect(mismatched.rows, 'archived-ness and emptiness disagree').toEqual([]);

    // Invariant 4: no group ever exceeded the cap.
    const oversized = await db.query<{ group_id: string; count: string }>(
      `SELECT group_id, count(*) FROM group_members WHERE left_at IS NULL
       GROUP BY group_id HAVING count(*) > $1`,
      [GROUP_MAX_MEMBERS],
    );
    expect(oversized.rows).toEqual([]);
  });

  it('serialises one account answering many invitations at once', async () => {
    const before = await countDeadlocks();
    const wanted = await makePlayer('Much In Demand');

    const hosts = await Promise.all(
      Array.from({ length: 8 }, (_unused, index) => makePlayer(`Suitor ${index}`)),
    );
    const invites: string[] = [];
    for (const [index, host] of hosts.entries()) {
      const groupId = await foundGroup(host, groupName(`Suit ${index}`));
      const issued = await invite(host, groupId, wanted);
      expect(issued.statusCode, issued.body).toBe(201);
      invites.push(issued.json().invite.id);
    }

    const results = await Promise.all(invites.map((inviteId) => respond(wanted, inviteId, true)));
    assertNoRawFailures(results, 'eight simultaneous accepts');
    expect(results.filter((response) => response.statusCode === 200)).toHaveLength(1);
    // Every loser gets a stated reason, not a generic one.
    for (const response of results.filter((entry) => entry.statusCode !== 200)) {
      expect([404, 409]).toContain(response.statusCode);
      expect(['NOT_FOUND', 'GROUP_MEMBERSHIP_EXISTS']).toContain(response.json().error.code);
    }
    expect(await countDeadlocks()).toBe(before);

    const live = await db.query<{ count: string }>(
      'SELECT count(*) FROM group_members WHERE account_id = $1 AND left_at IS NULL',
      [wanted.accountId],
    );
    expect(Number(live.rows[0]!.count)).toBe(1);
  });

  it('keeps two racing creates of the same name to one group', async () => {
    const before = await countDeadlocks();
    const name = groupName('Contested Name');
    const founders = await Promise.all(
      Array.from({ length: 4 }, (_unused, index) => makePlayer(`Founder ${index}`)),
    );

    const results = await Promise.all(founders.map((founder) => createGroup(founder, name)));
    assertNoRawFailures(results, 'four racing creates of one name');
    expect(results.filter((response) => response.statusCode === 201)).toHaveLength(1);
    for (const response of results.filter((entry) => entry.statusCode !== 201)) {
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('GROUP_NAME_TAKEN');
    }
    expect(await countDeadlocks()).toBe(before);

    // A refused create must leave no orphan channel behind. Scoped to this name, because the
    // integration database is shared and long-lived.
    const channels = await db.query<{ count: string }>(
      `SELECT count(*) FROM chat_channels c
       WHERE c.kind = 'group' AND c.name = $1
         AND NOT EXISTS (SELECT 1 FROM groups g WHERE g.channel_id = c.id)`,
      [name],
    );
    expect(Number(channels.rows[0]!.count), 'a refused create left an orphaned channel').toBe(0);

    // Exactly one channel for the one group that won.
    const total = await db.query<{ count: string }>(
      `SELECT count(*) FROM chat_channels WHERE kind = 'group' AND name = $1`,
      [name],
    );
    expect(Number(total.rows[0]!.count)).toBe(1);
  });

  it('keeps one account pressing Leave from many tabs to one departure', async () => {
    const leader = await makePlayer('Anchor');
    const quitter = await makePlayer('Impatient');
    const groupId = await foundGroup(leader, groupName('Many Tabs'));
    await join(quitter, groupId, leader);

    const results = await Promise.all(Array.from({ length: 6 }, () => leave(quitter)));
    assertNoRawFailures(results, 'six simultaneous leaves');
    expect(results.filter((response) => response.statusCode === 200)).toHaveLength(1);

    // One departure, one "left the group" line — not six.
    const announcements = await db.query<{ count: string }>(
      `SELECT count(*) FROM chat_messages m
       JOIN groups g ON g.channel_id = m.channel_id
       WHERE g.id = $1 AND m.author_account_id IS NULL AND m.body LIKE '%left the group%'`,
      [groupId],
    );
    expect(Number(announcements.rows[0]!.count)).toBe(1);
  });
});
