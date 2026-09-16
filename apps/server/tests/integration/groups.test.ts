import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  GROUP_MAX_MEMBERS,
  type GroupDto,
  type MyGroupResponse,
} from '@lethalmagotchi/shared';
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

/** Group names are globally unique, so every fixture has to bring its own. */
function groupName(label: string): string {
  return `${label} ${randomUUID().slice(0, 8)}`;
}

async function makePlayer(
  nickname: string,
  options: { accountAgeHours?: number; withCharacter?: boolean } = {},
): Promise<Player> {
  const account = await registerAccount(app, { username: uniqueUsername('grp') });
  let characterId = '';
  if (options.withCharacter !== false) {
    const response = await app.inject(
      authed(account, {
        method: 'POST',
        url: '/api/v1/characters',
        payload: { ...VALID_CHARACTER, nickname },
      }),
    );
    expect(response.statusCode, response.body).toBe(201);
    characterId = response.json().character.id;
  }

  // Groups open at 24h of account age, so fixtures are born two days ago by default.
  await db.query(`UPDATE accounts SET created_at = now() - ($2 || ' hours')::interval WHERE id = $1`, [
    account.accountId,
    String(options.accountAgeHours ?? 48),
  ]);
  return { ...account, characterId, nickname };
}

function createGroup(player: Player, name: string, instance: FastifyInstance = app) {
  return instance.inject(authed(player, { method: 'POST', url: '/api/v1/groups', payload: { name } }));
}

function invite(from: Player, groupId: string, to: Player, instance: FastifyInstance = app) {
  return instance.inject(
    authed(from, {
      method: 'POST',
      url: `/api/v1/groups/${groupId}/invites`,
      payload: { toAccountId: to.accountId },
    }),
  );
}

function respond(player: Player, inviteId: string, accept: boolean, instance: FastifyInstance = app) {
  return instance.inject(
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

/** create → invite → accept, the path every other test starts from. */
async function foundGroup(leader: Player, name: string): Promise<string> {
  const created = await createGroup(leader, name);
  expect(created.statusCode, created.body).toBe(201);
  return (created.json() as MyGroupResponse).group!.id;
}

async function join(member: Player, groupId: string, inviter: Player): Promise<void> {
  const invited = await invite(inviter, groupId, member);
  expect(invited.statusCode, invited.body).toBe(201);
  const accepted = await respond(member, invited.json().invite.id, true);
  expect(accepted.statusCode, accepted.body).toBe(200);
}

describe('creating a group', () => {
  it('creates the group, its channel, and the leader membership in one go', async () => {
    const leader = await makePlayer('Founder');
    const name = groupName('Otter Society');

    const response = await createGroup(leader, name);
    expect(response.statusCode, response.body).toBe(201);

    const body = response.json() as MyGroupResponse;
    expect(body.group).toMatchObject({
      name,
      leaderAccountId: leader.accountId,
      role: 'leader',
      memberCount: 1,
    });
    expect(body.group!.members[0]).toMatchObject({ accountId: leader.accountId, role: 'leader' });

    const channel = await db.query<{ kind: string; key: string; name: string; archived_at: Date | null }>(
      'SELECT kind, key, name, archived_at FROM chat_channels WHERE id = $1',
      [body.group!.channelId],
    );
    expect(channel.rows[0]).toMatchObject({ kind: 'group', key: `group:${body.group!.id}`, name });
    expect(channel.rows[0]!.archived_at).toBeNull();

    const membership = await db.query(
      'SELECT 1 FROM chat_channel_members WHERE channel_id = $1 AND account_id = $2 AND left_at IS NULL',
      [body.group!.channelId, leader.accountId],
    );
    expect(membership.rowCount).toBe(1);
  });

  it('refuses a name that is taken, case- and NFKC-folded', async () => {
    const first = await makePlayer('First');
    const second = await makePlayer('Second');
    const name = groupName('Fold Test');

    expect((await createGroup(first, name)).statusCode).toBe(201);

    const clash = await createGroup(second, name.toUpperCase());
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe('GROUP_NAME_TAKEN');
  });

  it('refuses an account with no character', async () => {
    const drifter = await makePlayer('Nobody', { withCharacter: false });
    const response = await createGroup(drifter, groupName('Ghosts'));
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NO_CHARACTER');
  });

  it('lets a brand-new account found a group straight away', async () => {
    // The day-old account floor was removed: starting a group is immediate.
    const newborn = await makePlayer('Newborn', { accountAgeHours: 0 });
    const response = await createGroup(newborn, groupName('Hatchlings'));
    expect(response.statusCode, response.body).toBe(201);
  });

  it('refuses a second group while one is already held', async () => {
    const leader = await makePlayer('Greedy');
    await foundGroup(leader, groupName('One'));

    const second = await createGroup(leader, groupName('Two'));
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('GROUP_MEMBERSHIP_EXISTS');
  });

  it('lets a departed member found another group immediately', async () => {
    // The post-leave cooldown was removed too: leaving one group does not park you.
    const leader = await makePlayer('Restless');
    const other = await makePlayer('Stayer');
    const groupId = await foundGroup(leader, groupName('Revolving'));
    await join(other, groupId, leader);
    expect((await leave(leader)).statusCode).toBe(200);

    const rebound = await createGroup(leader, groupName('Rebound'));
    expect(rebound.statusCode, rebound.body).toBe(201);
  });

  it('rejects a name moderation refuses', async () => {
    const leader = await makePlayer('Mouthy');
    const response = await createGroup(leader, 'the retards');
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('GROUP_NAME_REJECTED');
  });

  it('validates the name shape', async () => {
    const leader = await makePlayer('Typo');
    expect((await createGroup(leader, 'ab')).statusCode).toBe(422);
    expect((await createGroup(leader, 'x'.repeat(40))).statusCode).toBe(422);
    expect((await createGroup(leader, '<script>')).statusCode).toBe(422);
  });

  it('caps how many groups one account can found in an hour', async () => {
    const limiters = relaxedLimiters();
    limiters.groupCreate = new RateLimiter({ limit: 1, windowMs: 60 * 60_000 });
    const { app: limited } = await createTestApp({ limiters });
    try {
      const founder = await makePlayer('Serial');
      expect((await createGroup(founder, groupName('Once'), limited)).statusCode).toBe(201);
      const again = await createGroup(founder, groupName('Twice'), limited);
      expect(again.statusCode).toBe(429);
      expect(again.json().error.code).toBe('RATE_LIMITED');
    } finally {
      await limited.close();
    }
  });
});

describe('the public roster', () => {
  it('is readable by anyone, member or not, and hides nothing private', async () => {
    const leader = await makePlayer('Public');
    const member = await makePlayer('Joiner');
    const stranger = await makePlayer('Passerby');
    const name = groupName('Open Book');
    const groupId = await foundGroup(leader, name);
    await join(member, groupId, leader);

    const response = await app.inject(authed(stranger, { method: 'GET', url: `/api/v1/groups/${groupId}` }));
    expect(response.statusCode).toBe(200);

    const group: GroupDto = response.json().group;
    expect(group).toMatchObject({ name, memberCount: 2, leaderAccountId: leader.accountId });
    expect(group.members.map((entry) => entry.nickname)).toEqual(['Public', 'Joiner']);
    // A roster is who is in the group, not a channel: nothing about the chat side leaks.
    expect(response.body).not.toContain('channelId');
  });

  it('404s an archived group and an id that never existed', async () => {
    const leader = await makePlayer('Solo');
    const stranger = await makePlayer('Curious');
    const groupId = await foundGroup(leader, groupName('Brief'));
    await leave(leader);

    expect(
      (await app.inject(authed(stranger, { method: 'GET', url: `/api/v1/groups/${groupId}` }))).statusCode,
    ).toBe(404);
    expect(
      (await app.inject(authed(stranger, { method: 'GET', url: `/api/v1/groups/${randomUUID()}` }))).statusCode,
    ).toBe(404);
  });
});

describe('invitations', () => {
  it('lets any member invite, and lands the invite on the target', async () => {
    const leader = await makePlayer('Chief');
    const member = await makePlayer('Regular');
    const newcomer = await makePlayer('Fresh');
    const name = groupName('Any Member');
    const groupId = await foundGroup(leader, name);
    await join(member, groupId, leader);

    // Not the leader: inviting is everybody's job.
    const invited = await invite(member, groupId, newcomer);
    expect(invited.statusCode, invited.body).toBe(201);

    const mine = await myGroup(newcomer);
    const body = mine.json() as MyGroupResponse;
    expect(body.group).toBeNull();
    expect(body.invites).toHaveLength(1);
    expect(body.invites[0]).toMatchObject({ groupId, groupName: name, fromNickname: 'Regular' });
  });

  it('refuses an invite from someone outside the group', async () => {
    const leader = await makePlayer('Inside');
    const outsider = await makePlayer('Outside');
    const target = await makePlayer('Target');
    const groupId = await foundGroup(leader, groupName('Closed'));

    const response = await invite(outsider, groupId, target);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('GROUP_NOT_MEMBER');
  });

  it('refuses a target who already belongs to a group, or has no character, or is too new', async () => {
    const leader = await makePlayer('Recruiter');
    const groupId = await foundGroup(leader, groupName('Recruiting'));

    const taken = await makePlayer('Spoken For');
    await foundGroup(taken, groupName('Elsewhere'));
    const already = await invite(leader, groupId, taken);
    expect(already.statusCode).toBe(409);
    expect(already.json().error.code).toBe('GROUP_MEMBERSHIP_EXISTS');

    const bodiless = await makePlayer('Bodiless', { withCharacter: false });
    expect((await invite(leader, groupId, bodiless)).statusCode).toBe(404);

    // No age floor any more: a fresh account can be invited and can accept.
    const newborn = await makePlayer('Newborn', { accountAgeHours: 0 });
    const fresh = await invite(leader, groupId, newborn);
    expect(fresh.statusCode, fresh.body).toBe(201);
  });

  it('refuses a second live invitation to the same person from the same group', async () => {
    const leader = await makePlayer('Keen');
    const member = await makePlayer('Also Keen');
    const target = await makePlayer('Popular');
    const groupId = await foundGroup(leader, groupName('Eager'));
    await join(member, groupId, leader);

    expect((await invite(leader, groupId, target)).statusCode).toBe(201);
    const second = await invite(member, groupId, target);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('GROUP_INVITE_PENDING');
  });

  it('refuses either direction of a block', async () => {
    const leader = await makePlayer('Blocker');
    const target = await makePlayer('Blocked');
    const groupId = await foundGroup(leader, groupName('Frosty'));
    await app.inject(
      authed(target, { method: 'POST', url: '/api/v1/blocks', payload: { blockedAccountId: leader.accountId } }),
    );

    const response = await invite(leader, groupId, target);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('BLOCKED');
  });

  it('treats an invitation addressed to somebody else as one that does not exist', async () => {
    const leader = await makePlayer('Host');
    const target = await makePlayer('Invitee');
    const nosy = await makePlayer('Nosy');
    const groupId = await foundGroup(leader, groupName('Private Party'));
    const invited = await invite(leader, groupId, target);

    const stolen = await respond(nosy, invited.json().invite.id, true);
    expect(stolen.statusCode).toBe(404);
    const unknown = await respond(nosy, randomUUID(), true);
    expect(unknown.statusCode).toBe(404);
    expect(stolen.json()).toEqual(unknown.json());
  });

  it('refuses an expired invitation and lets a fresh one through', async () => {
    const leader = await makePlayer('Patient');
    const target = await makePlayer('Slow');
    const groupId = await foundGroup(leader, groupName('Week Long'));
    const invited = await invite(leader, groupId, target);
    const inviteId = invited.json().invite.id;

    await db.query(`UPDATE group_invites SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
      inviteId,
    ]);

    expect((await respond(target, inviteId, true)).statusCode).toBe(404);
    // The lapsed invite must not hold the pending-index slot hostage forever.
    const again = await invite(leader, groupId, target);
    expect(again.statusCode, again.body).toBe(201);
    expect((await respond(target, again.json().invite.id, true)).statusCode).toBe(200);
  });

  it('drops a lapsed invitation out of the target own view', async () => {
    const leader = await makePlayer('Lapser');
    const target = await makePlayer('Forgetful');
    const groupId = await foundGroup(leader, groupName('Lapsing'));
    const invited = await invite(leader, groupId, target);
    await db.query(`UPDATE group_invites SET expires_at = now() - interval '1 second' WHERE id = $1`, [
      invited.json().invite.id,
    ]);

    const mine = await myGroup(target);
    expect((mine.json() as MyGroupResponse).invites).toEqual([]);
    const state = await db.query<{ state: string }>('SELECT state FROM group_invites WHERE id = $1', [
      invited.json().invite.id,
    ]);
    expect(state.rows[0]?.state).toBe('expired');
  });

  it('cancels everything else outstanding once the target joins somewhere', async () => {
    const first = await makePlayer('Suitor One');
    const second = await makePlayer('Suitor Two');
    const target = await makePlayer('Courted');
    const firstGroup = await foundGroup(first, groupName('House One'));
    const secondGroup = await foundGroup(second, groupName('House Two'));

    const fromFirst = await invite(first, firstGroup, target);
    const fromSecond = await invite(second, secondGroup, target);
    expect((await respond(target, fromFirst.json().invite.id, true)).statusCode).toBe(200);

    expect((await respond(target, fromSecond.json().invite.id, true)).statusCode).toBe(404);
    expect((await myGroup(target)).json().invites).toEqual([]);
  });

  it('cancels everything else outstanding when the target founds a group instead', async () => {
    const host = await makePlayer('Recruiter');
    const founder = await makePlayer('Independent');
    const hostGroup = await foundGroup(host, groupName('Open House'));
    const invited = await invite(host, hostGroup, founder);
    expect(invited.statusCode, invited.body).toBe(201);

    // Founding and accepting both end in a membership, so they settle invitations alike.
    const created = await createGroup(founder, groupName('Own Thing'));
    expect(created.statusCode, created.body).toBe(201);
    expect((created.json() as MyGroupResponse).invites).toEqual([]);
    expect((await myGroup(founder)).json().invites).toEqual([]);

    const state = await db.query<{ state: string; resolved_at: Date | null }>(
      'SELECT state, resolved_at FROM group_invites WHERE id = $1',
      [invited.json().invite.id],
    );
    expect(state.rows[0]?.state).toBe('cancelled');
    expect(state.rows[0]?.resolved_at).not.toBeNull();
  });

  it('cancels an invitation into a group that ends before it is answered', async () => {
    const leader = await makePlayer('Fading');
    const target = await makePlayer('Too Late');
    const groupId = await foundGroup(leader, groupName('Closing Down'));
    const invited = await invite(leader, groupId, target);
    expect(invited.statusCode, invited.body).toBe(201);

    // The last member out archives the group; the invitation into it dies with it rather
    // than sitting pending forever, unanswerable and holding a seat in the pending index.
    expect((await leave(leader)).statusCode).toBe(200);

    const state = await db.query<{ state: string; resolved_at: Date | null }>(
      'SELECT state, resolved_at FROM group_invites WHERE id = $1',
      [invited.json().invite.id],
    );
    expect(state.rows[0]?.state).toBe('cancelled');
    expect(state.rows[0]?.resolved_at).not.toBeNull();
    expect((await respond(target, invited.json().invite.id, true)).statusCode).toBe(404);
  });

  it('declining leaves the player free and the group open to them', async () => {
    const leader = await makePlayer('Asker');
    const target = await makePlayer('Decliner');
    const groupId = await foundGroup(leader, groupName('No Thanks'));
    const invited = await invite(leader, groupId, target);

    const declined = await respond(target, invited.json().invite.id, false);
    expect(declined.statusCode).toBe(200);
    expect((declined.json() as MyGroupResponse).group).toBeNull();

    // A decline is not a cooldown: only a kick is.
    const again = await invite(leader, groupId, target);
    expect(again.statusCode).toBe(201);
    expect((await respond(target, again.json().invite.id, true)).statusCode).toBe(200);
  });
});

describe('leaving, promotion and the end of a group', () => {
  it('promotes the longest-standing remaining member when the leader walks', async () => {
    const leader = await makePlayer('Boss');
    const elder = await makePlayer('Elder');
    const youngster = await makePlayer('Youngster');
    const groupId = await foundGroup(leader, groupName('Succession'));
    await join(elder, groupId, leader);
    await join(youngster, groupId, leader);

    expect((await leave(leader)).statusCode).toBe(200);

    const roster = await app.inject(authed(elder, { method: 'GET', url: `/api/v1/groups/${groupId}` }));
    expect(roster.json().group.leaderAccountId).toBe(elder.accountId);
    expect((await myGroup(elder)).json().group.role).toBe('leader');
    expect((await myGroup(youngster)).json().group.role).toBe('member');
  });

  it('breaks a same-instant join tie by account id, deterministically', async () => {
    const leader = await makePlayer('Chief');
    const twinA = await makePlayer('Twin A');
    const twinB = await makePlayer('Twin B');
    const groupId = await foundGroup(leader, groupName('Twins'));
    await join(twinA, groupId, leader);
    await join(twinB, groupId, leader);

    // Exactly what two members joining in one transaction would leave behind.
    await db.query(
      `UPDATE group_members SET joined_at = now() WHERE group_id = $1 AND account_id = ANY($2::uuid[])`,
      [groupId, [twinA.accountId, twinB.accountId]],
    );
    const expected = [twinA.accountId, twinB.accountId].sort()[0];

    expect((await leave(leader)).statusCode).toBe(200);
    const roster = await app.inject(authed(twinA, { method: 'GET', url: `/api/v1/groups/${groupId}` }));
    expect(roster.json().group.leaderAccountId).toBe(expected);
  });

  it('archives the group and its channel when the last member leaves', async () => {
    const leader = await makePlayer('Last One');
    const groupId = await foundGroup(leader, groupName('Sunset'));
    const channelId = (await myGroup(leader)).json().group.channelId;

    const left = await leave(leader);
    expect(left.statusCode).toBe(200);
    expect((left.json() as MyGroupResponse).group).toBeNull();

    const group = await db.query<{ archived_at: Date | null }>(
      'SELECT archived_at FROM groups WHERE id = $1',
      [groupId],
    );
    expect(group.rows[0]!.archived_at).not.toBeNull();

    const channel = await db.query<{ archived_at: Date | null }>(
      'SELECT archived_at FROM chat_channels WHERE id = $1',
      [channelId],
    );
    expect(channel.rows[0]!.archived_at).not.toBeNull();
  });

  it('frees the name only in the sense that nothing reclaims it', async () => {
    const leader = await makePlayer('Namer');
    const other = await makePlayer('Latecomer');
    const name = groupName('Held Name');
    await foundGroup(leader, name);
    await leave(leader);

    // Documented behaviour, not an accident: an archived group keeps its name.
    const reuse = await createGroup(other, name);
    expect(reuse.statusCode).toBe(409);
    expect(reuse.json().error.code).toBe('GROUP_NAME_TAKEN');
  });

  it('404s a leave from someone who is not in a group', async () => {
    const drifter = await makePlayer('Unaffiliated');
    const response = await leave(drifter);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('GROUP_NOT_MEMBER');
  });

  /**
   * No account-deletion feature exists yet, so this reproduces the only thing such a feature
   * could do: the row goes. A leader's account disappearing must be the same handoff their
   * voluntary departure is — no one person ends other people's community, and that has to
   * hold for an admin or an erasure request too.
   */
  it('hands the group over when the leader account is deleted outright', async () => {
    const leader = await makePlayer('Erased');
    const elder = await makePlayer('Second In');
    const youngster = await makePlayer('Third In');
    const groupId = await foundGroup(leader, groupName('Outlives'));
    await join(elder, groupId, leader);
    await join(youngster, groupId, leader);
    const channelId = (await myGroup(elder)).json().group.channelId;

    await db.query('DELETE FROM accounts WHERE id = $1', [leader.accountId]);

    const row = await db.query<{ leader_account_id: string | null; archived_at: Date | null }>(
      'SELECT leader_account_id, archived_at FROM groups WHERE id = $1',
      [groupId],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]!.archived_at).toBeNull();
    expect(row.rows[0]!.leader_account_id).toBeNull();

    // The first read resolves the leaderless state the same way a voluntary handoff does.
    const roster = await app.inject(authed(elder, { method: 'GET', url: `/api/v1/groups/${groupId}` }));
    expect(roster.json().group.leaderAccountId).toBe(elder.accountId);
    expect(roster.json().group.memberCount).toBe(2);
    expect((await myGroup(elder)).json().group.role).toBe('leader');
    expect((await myGroup(youngster)).json().group.role).toBe('member');

    const channel = await db.query<{ archived_at: Date | null }>(
      'SELECT archived_at FROM chat_channels WHERE id = $1',
      [channelId],
    );
    expect(channel.rows[0]!.archived_at).toBeNull();
    expect(
      (await app.inject(authed(elder, { method: 'GET', url: `/api/v1/chat/channels/${channelId}/messages` })))
        .statusCode,
    ).toBe(200);

    // The promoted leader holds the leader's one responsibility, and the room can still be left.
    expect((await kick(elder, groupId, youngster)).statusCode).toBe(200);
    expect((await leave(elder)).statusCode).toBe(200);
  });
});

describe('removal', () => {
  it('is the leader only, and blocks a re-invite from that group for a day', async () => {
    const leader = await makePlayer('Judge');
    const member = await makePlayer('Regular');
    const trouble = await makePlayer('Trouble');
    const groupId = await foundGroup(leader, groupName('Discipline'));
    await join(member, groupId, leader);
    await join(trouble, groupId, leader);

    const byMember = await kick(member, groupId, trouble);
    expect(byMember.statusCode).toBe(403);
    expect(byMember.json().error.code).toBe('GROUP_NOT_LEADER');

    const removed = await kick(leader, groupId, trouble);
    expect(removed.statusCode, removed.body).toBe(200);
    expect((await myGroup(trouble)).json().group).toBeNull();

    const tooSoon = await invite(leader, groupId, trouble);
    expect(tooSoon.statusCode).toBe(429);
    expect(tooSoon.json().error.code).toBe('GROUP_KICK_COOLDOWN');

    // The block belongs to the group, so routing round the leader does not lift it.
    const viaMember = await invite(member, groupId, trouble);
    expect(viaMember.statusCode).toBe(429);
  });

  it('lets a different group invite them immediately', async () => {
    const leader = await makePlayer('Strict');
    const rival = await makePlayer('Rival');
    const trouble = await makePlayer('Wanderer');
    const groupId = await foundGroup(leader, groupName('Strict House'));
    const rivalGroup = await foundGroup(rival, groupName('Rival House'));
    await join(trouble, groupId, leader);
    expect((await kick(leader, groupId, trouble)).statusCode).toBe(200);

    const invited = await invite(rival, rivalGroup, trouble);
    expect(invited.statusCode, invited.body).toBe(201);
    expect((await respond(trouble, invited.json().invite.id, true)).statusCode).toBe(200);
  });

  it('lets the original group invite them back once the day is up', async () => {
    const leader = await makePlayer('Forgiving');
    const trouble = await makePlayer('Reformed');
    const groupId = await foundGroup(leader, groupName('Second Chance'));
    await join(trouble, groupId, leader);
    await kick(leader, groupId, trouble);

    await db.query(
      `UPDATE group_members SET removed_at = now() - interval '25 hours', left_at = now() - interval '25 hours'
       WHERE group_id = $1 AND account_id = $2`,
      [groupId, trouble.accountId],
    );

    const invited = await invite(leader, groupId, trouble);
    expect(invited.statusCode, invited.body).toBe(201);
    expect((await respond(trouble, invited.json().invite.id, true)).statusCode).toBe(200);
    expect((await myGroup(trouble)).json().group.id).toBe(groupId);
  });

  it('refuses kicking yourself, a non-member, and an unknown group', async () => {
    const leader = await makePlayer('Alone');
    const stranger = await makePlayer('Elsewhere');
    const groupId = await foundGroup(leader, groupName('Tiny'));

    expect((await kick(leader, groupId, leader)).statusCode).toBe(422);
    const notMember = await kick(leader, groupId, stranger);
    expect(notMember.statusCode).toBe(404);
    expect(notMember.json().error.code).toBe('GROUP_NOT_MEMBER');

    const unknown = await app.inject(
      authed(leader, { method: 'DELETE', url: `/api/v1/groups/${randomUUID()}/members/${stranger.accountId}` }),
    );
    expect(unknown.statusCode).toBe(404);
  });
});

describe('the size cap', () => {
  it('fills to exactly the cap and refuses the next accept', async () => {
    const leader = await makePlayer('Cap Leader');
    const groupId = await foundGroup(leader, groupName('Full House'));

    const joiners = await Promise.all(
      Array.from({ length: GROUP_MAX_MEMBERS - 1 }, (_unused, index) => makePlayer(`Member ${index}`)),
    );
    for (const joiner of joiners) await join(joiner, groupId, leader);

    const roster = await app.inject(authed(leader, { method: 'GET', url: `/api/v1/groups/${groupId}` }));
    expect(roster.json().group.memberCount).toBe(GROUP_MAX_MEMBERS);

    const extra = await makePlayer('One Too Many');
    const invited = await invite(leader, groupId, extra);
    expect(invited.statusCode).toBe(409);
    expect(invited.json().error.code).toBe('GROUP_FULL');
  });

  it('gives the last seat to exactly one of two simultaneous accepts', async () => {
    const leader = await makePlayer('Doorman');
    const groupId = await foundGroup(leader, groupName('One Seat Left'));

    const joiners = await Promise.all(
      Array.from({ length: GROUP_MAX_MEMBERS - 2 }, (_unused, index) => makePlayer(`Early ${index}`)),
    );
    for (const joiner of joiners) await join(joiner, groupId, leader);

    const racerA = await makePlayer('Racer A');
    const racerB = await makePlayer('Racer B');
    const inviteA = await invite(leader, groupId, racerA);
    const inviteB = await invite(leader, groupId, racerB);
    expect(inviteA.statusCode).toBe(201);
    expect(inviteB.statusCode).toBe(201);

    const [first, second] = await Promise.all([
      respond(racerA, inviteA.json().invite.id, true),
      respond(racerB, inviteB.json().invite.id, true),
    ]);

    const codes = [first.statusCode, second.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const refused = first.statusCode === 409 ? first : second;
    expect(refused.json().error.code).toBe('GROUP_FULL');

    const count = await db.query<{ count: string }>(
      'SELECT count(*) FROM group_members WHERE group_id = $1 AND left_at IS NULL',
      [groupId],
    );
    expect(Number(count.rows[0]!.count)).toBe(GROUP_MAX_MEMBERS);

    // The loser's invite claim rolled back with the rest of its transaction.
    const loserId = first.statusCode === 409 ? inviteA.json().invite.id : inviteB.json().invite.id;
    const state = await db.query<{ state: string }>('SELECT state FROM group_invites WHERE id = $1', [loserId]);
    expect(state.rows[0]!.state).toBe('pending');
  });
});

describe('one group at a time, under concurrency', () => {
  it('lets exactly one of two simultaneous accepts from different groups through', async () => {
    const houseOne = await makePlayer('House One');
    const houseTwo = await makePlayer('House Two');
    const wanted = await makePlayer('Wanted');
    const groupOne = await foundGroup(houseOne, groupName('First House'));
    const groupTwo = await foundGroup(houseTwo, groupName('Second House'));

    const inviteOne = await invite(houseOne, groupOne, wanted);
    const inviteTwo = await invite(houseTwo, groupTwo, wanted);

    const [first, second] = await Promise.all([
      respond(wanted, inviteOne.json().invite.id, true),
      respond(wanted, inviteTwo.json().invite.id, true),
    ]);

    expect([first.statusCode, second.statusCode].filter((code) => code === 200)).toHaveLength(1);
    const refused = first.statusCode === 200 ? second : first;
    /**
     * Whichever way the two land, the refusal is a stated outcome rather than a constraint
     * violation or a deadlock: the loser either lost the claim to an invitation the winner
     * cancelled (404), or lost the membership index (409).
     */
    expect([404, 409]).toContain(refused.statusCode);
    expect(['NOT_FOUND', 'GROUP_MEMBERSHIP_EXISTS']).toContain(refused.json().error.code);

    const memberships = await db.query<{ count: string }>(
      'SELECT count(*) FROM group_members WHERE account_id = $1 AND left_at IS NULL',
      [wanted.accountId],
    );
    expect(Number(memberships.rows[0]!.count)).toBe(1);
  });

  /**
   * The index refusing a second membership, reached deterministically rather than by winning
   * a race: an invitation that is live again after the player has joined somewhere else is
   * exactly the row a concurrent accept leaves behind.
   */
  it('turns the partial unique index into a stated error, not a constraint failure', async () => {
    const houseOne = await makePlayer('Host One');
    const houseTwo = await makePlayer('Host Two');
    const wanted = await makePlayer('Double Booked');
    const groupOne = await foundGroup(houseOne, groupName('Booked House'));
    const groupTwo = await foundGroup(houseTwo, groupName('Other House'));

    const inviteOne = await invite(houseOne, groupOne, wanted);
    const inviteTwo = await invite(houseTwo, groupTwo, wanted);
    expect((await respond(wanted, inviteOne.json().invite.id, true)).statusCode).toBe(200);

    await db.query(`UPDATE group_invites SET state = 'pending', resolved_at = NULL WHERE id = $1`, [
      inviteTwo.json().invite.id,
    ]);

    const refused = await respond(wanted, inviteTwo.json().invite.id, true);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('GROUP_MEMBERSHIP_EXISTS');
    expect((await myGroup(wanted)).json().group.id).toBe(groupOne);
  });

  it('survives the same invitation being accepted twice at once', async () => {
    const leader = await makePlayer('Steady');
    const eager = await makePlayer('Double Tapper');
    const groupId = await foundGroup(leader, groupName('Double Tap'));
    const invited = await invite(leader, groupId, eager);
    const inviteId = invited.json().invite.id;

    const results = await Promise.all([
      respond(eager, inviteId, true),
      respond(eager, inviteId, true),
      respond(eager, inviteId, true),
    ]);
    expect(results.filter((response) => response.statusCode === 200)).toHaveLength(1);
    for (const response of results) expect(response.statusCode).not.toBe(500);

    const rows = await db.query<{ count: string }>(
      'SELECT count(*) FROM group_members WHERE group_id = $1 AND left_at IS NULL',
      [groupId],
    );
    expect(Number(rows.rows[0]!.count)).toBe(2);
  });
});

describe('the delete-and-recreate path', () => {
  it('keeps the membership and gives the channel back', async () => {
    const leader = await makePlayer('Anchor');
    const rebuilder = await makePlayer('Shapeshifter');
    const groupId = await foundGroup(leader, groupName('Enduring'));
    await join(rebuilder, groupId, leader);
    const channelId = (await myGroup(rebuilder)).json().group.channelId;

    expect(
      (await app.inject(authed(rebuilder, { method: 'DELETE', url: '/api/v1/characters/me' }))).statusCode,
    ).toBe(204);

    const membership = await db.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND account_id = $2 AND left_at IS NULL',
      [groupId, rebuilder.accountId],
    );
    expect(membership.rowCount).toBe(1);

    const rebuilt = await app.inject(
      authed(rebuilder, {
        method: 'POST',
        url: '/api/v1/characters',
        payload: { ...VALID_CHARACTER, nickname: 'Reborn' },
      }),
    );
    expect(rebuilt.statusCode).toBe(201);

    const channelMembership = await db.query(
      'SELECT 1 FROM chat_channel_members WHERE channel_id = $1 AND account_id = $2 AND left_at IS NULL',
      [channelId, rebuilder.accountId],
    );
    expect(channelMembership.rowCount).toBe(1);
    expect((await myGroup(rebuilder)).json().group.id).toBe(groupId);
  });

  /**
   * Rebuilding a character re-opens the conversations the deletion closed — and must not
   * re-open a group channel the player was thrown out of in between.
   */
  it('does not hand a kicked player their old group channel back', async () => {
    const leader = await makePlayer('Bouncer');
    const evicted = await makePlayer('Evicted');
    const groupId = await foundGroup(leader, groupName('No Return'));
    await join(evicted, groupId, leader);
    const channelId = (await myGroup(evicted)).json().group.channelId;

    await app.inject(authed(evicted, { method: 'DELETE', url: '/api/v1/characters/me' }));
    expect((await kick(leader, groupId, evicted)).statusCode).toBe(200);

    const rebuilt = await app.inject(
      authed(evicted, {
        method: 'POST',
        url: '/api/v1/characters',
        payload: { ...VALID_CHARACTER, nickname: 'Returned' },
      }),
    );
    expect(rebuilt.statusCode).toBe(201);

    const channelMembership = await db.query(
      'SELECT 1 FROM chat_channel_members WHERE channel_id = $1 AND account_id = $2 AND left_at IS NULL',
      [channelId, evicted.accountId],
    );
    expect(channelMembership.rowCount).toBe(0);
    expect((await myGroup(evicted)).json().group).toBeNull();
  });
});

describe('authentication', () => {
  it('is required everywhere', async () => {
    const urls: [string, string][] = [
      ['POST', '/api/v1/groups'],
      ['GET', '/api/v1/groups/me'],
      ['GET', `/api/v1/groups/${randomUUID()}`],
      ['POST', `/api/v1/groups/${randomUUID()}/invites`],
      ['POST', `/api/v1/groups/invites/${randomUUID()}/respond`],
      ['DELETE', '/api/v1/groups/me/membership'],
      ['DELETE', `/api/v1/groups/${randomUUID()}/members/${randomUUID()}`],
    ];
    for (const [method, url] of urls) {
      const response = await app.inject({ method: method as 'GET', url, payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});
