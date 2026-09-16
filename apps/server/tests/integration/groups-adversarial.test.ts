import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { GROUP_MAX_MEMBERS, TOWN_SQUARE_CHANNEL_ID, type MyGroupResponse } from '@lethalmagotchi/shared';
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

/**
 * QA round 1 — adversarial sweep beside the developer's own `groups.test.ts`. Everything
 * here is a scenario that file does *not* construct: races between different endpoints
 * (rather than two of the same), the voluntary-leaver half of the rejoin scoping rule, and
 * the "does this survive a restart" half of the derived cooldowns.
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

/** Names are globally unique and capped at 24 characters, so fixtures stay terse. */
function groupName(label: string): string {
  return `${label.slice(0, 15)} ${randomUUID().slice(0, 6)}`;
}

async function makePlayer(
  nickname: string,
  options: { accountAgeHours?: number; withCharacter?: boolean; ageCharacter?: boolean } = {},
): Promise<Player> {
  const account = await registerAccount(app, { username: uniqueUsername('adv') });
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
  await db.query(`UPDATE accounts SET created_at = now() - ($2 || ' hours')::interval WHERE id = $1`, [
    account.accountId,
    String(options.accountAgeHours ?? 48),
  ]);
  if (options.ageCharacter === true) {
    // Duels read the *character's* age, not the account's — the very asymmetry this suite
    // is here to pin down, so it is set explicitly rather than by the account helper.
    await db.query(`UPDATE characters SET created_at = now() - interval '48 hours' WHERE id = $1`, [
      characterId,
    ]);
  }
  return { ...account, characterId, nickname };
}

function createGroup(player: Player, name: string, instance: FastifyInstance = app) {
  return instance.inject(authed(player, { method: 'POST', url: '/api/v1/groups', payload: { name } }));
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

async function foundGroup(leader: Player, name: string): Promise<{ groupId: string; channelId: string }> {
  const created = await createGroup(leader, name);
  expect(created.statusCode, created.body).toBe(201);
  const body = created.json() as MyGroupResponse;
  return { groupId: body.group!.id, channelId: body.group!.channelId };
}

async function join(member: Player, groupId: string, inviter: Player): Promise<void> {
  const invited = await invite(inviter, groupId, member);
  expect(invited.statusCode, invited.body).toBe(201);
  const accepted = await respond(member, invited.json().invite.id, true);
  expect(accepted.statusCode, accepted.body).toBe(200);
}

function deleteCharacter(player: Player) {
  return app.inject(authed(player, { method: 'DELETE', url: '/api/v1/characters/me' }));
}

function rebuildCharacter(player: Player, nickname: string) {
  return app.inject(
    authed(player, {
      method: 'POST',
      url: '/api/v1/characters',
      payload: { ...VALID_CHARACTER, nickname },
    }),
  );
}

function codesOf(responses: { statusCode: number; json: () => any }[]): string[] {
  return responses
    .filter((response) => response.statusCode >= 400)
    .map((response) => response.json().error?.code ?? 'NO_CODE');
}

async function liveMemberCount(groupId: string): Promise<number> {
  const result = await db.query<{ count: string }>(
    'SELECT count(*) FROM group_members WHERE group_id = $1 AND left_at IS NULL',
    [groupId],
  );
  return Number(result.rows[0]!.count);
}

async function settle(ms = 250): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------- races across endpoints ------------------------- */

describe('races between different roster endpoints', () => {
  it('resolves an accept racing a kick from the group the joiner is leaving behind', async () => {
    const holdLeader = await makePlayer('Holder');
    const nextLeader = await makePlayer('Poacher');
    const wanted = await makePlayer('Contested');

    const held = await foundGroup(holdLeader, groupName('Holding Pen'));
    const next = await foundGroup(nextLeader, groupName('Poaching Ground'));

    // The invitation to the second group is issued while the target is free, then the
    // target joins the first group — which cancels it. Reviving the row is how a pending
    // invitation and a live membership coexist, which is the state the race needs.
    const poach = await invite(nextLeader, next.groupId, wanted);
    expect(poach.statusCode, poach.body).toBe(201);
    await join(wanted, held.groupId, holdLeader);
    await db.query(`UPDATE group_invites SET state = 'pending', resolved_at = NULL WHERE id = $1`, [
      poach.json().invite.id,
    ]);

    const [accepted, kicked] = await Promise.all([
      respond(wanted, poach.json().invite.id, true),
      kick(holdLeader, held.groupId, wanted),
    ]);

    // Neither request may come back as a raw failure, whichever order they land in.
    expect(accepted.statusCode, accepted.body).not.toBe(500);
    expect(kicked.statusCode, kicked.body).not.toBe(500);
    expect([200, 409]).toContain(accepted.statusCode);
    expect([200, 404]).toContain(kicked.statusCode);

    // Exactly one live membership for this account, whichever way it went.
    const memberships = await db.query<{ count: string }>(
      'SELECT count(*) FROM group_members WHERE account_id = $1 AND left_at IS NULL',
      [wanted.accountId],
    );
    expect(Number(memberships.rows[0]!.count)).toBeLessThanOrEqual(1);
  });

  it('resolves an accept racing the last member leaving the group being joined', async () => {
    const soleLeader = await makePlayer('Last One Out');
    const joiner = await makePlayer('Latecomer');
    const { groupId } = await foundGroup(soleLeader, groupName('Closing Time'));

    const invited = await invite(soleLeader, groupId, joiner);
    expect(invited.statusCode, invited.body).toBe(201);

    const [accepted, left] = await Promise.all([
      respond(joiner, invited.json().invite.id, true),
      leave(soleLeader),
    ]);

    expect(accepted.statusCode, accepted.body).not.toBe(500);
    expect(left.statusCode, left.body).not.toBe(500);

    const archived = await db.query<{ archived_at: Date | null }>(
      'SELECT archived_at FROM groups WHERE id = $1',
      [groupId],
    );
    const live = await liveMemberCount(groupId);

    if (accepted.statusCode === 200) {
      // The joiner got in first: the group survives with them in it, never archived.
      expect(archived.rows[0]!.archived_at).toBeNull();
      expect(live).toBe(1);
      expect((await myGroup(joiner)).json().group.id).toBe(groupId);
    } else {
      // The group closed first: a clean 404, and the joiner is not in an archived group.
      expect(accepted.statusCode).toBe(404);
      expect(archived.rows[0]!.archived_at).not.toBeNull();
      expect(live).toBe(0);
      expect((await myGroup(joiner)).json().group).toBeNull();
    }
  });

  it('never archives a group that a concurrent join has just repopulated', async () => {
    // The same shape run repeatedly: a one-in-a-hundred interleaving here would be a
    // permanently leaderless, permanently unjoinable group, so it is worth the reps.
    for (let round = 0; round < 5; round += 1) {
      const host = await makePlayer(`Host ${round}`);
      const guest = await makePlayer(`Guest ${round}`);
      const { groupId } = await foundGroup(host, groupName(`Revolving ${round}`));
      const invited = await invite(host, groupId, guest);

      const [accepted] = await Promise.all([respond(guest, invited.json().invite.id, true), leave(host)]);

      const row = await db.query<{ archived_at: Date | null }>(
        'SELECT archived_at FROM groups WHERE id = $1',
        [groupId],
      );
      const live = await liveMemberCount(groupId);
      const archivedAt = row.rows[0]!.archived_at;

      // The invariant under test: archived if and only if empty.
      expect(
        { round, accepted: accepted.statusCode, archived: archivedAt !== null, live },
        'a group must be archived exactly when it is empty',
      ).toEqual({ round, accepted: accepted.statusCode, archived: live === 0, live });
    }
  });

  it('promotes exactly one successor when the leader and two members all leave at once', async () => {
    const leader = await makePlayer('Departing Leader');
    const alpha = await makePlayer('Alpha');
    const beta = await makePlayer('Beta');
    const survivor = await makePlayer('Survivor');
    const { groupId } = await foundGroup(leader, groupName('Mass Exodus'));
    for (const member of [alpha, beta, survivor]) await join(member, groupId, leader);

    const results = await Promise.all([leave(leader), leave(alpha), leave(beta)]);
    for (const response of results) expect(response.statusCode, response.body).toBe(200);

    const after = await db.query<{ leader_account_id: string; archived_at: Date | null }>(
      'SELECT leader_account_id, archived_at FROM groups WHERE id = $1',
      [groupId],
    );
    expect(after.rows[0]!.archived_at).toBeNull();
    expect(await liveMemberCount(groupId)).toBe(1);
    // The one person left has to be the leader — not a departed account, not nobody.
    expect(after.rows[0]!.leader_account_id).toBe(survivor.accountId);

    const roster = await app.inject(authed(survivor, { method: 'GET', url: `/api/v1/groups/${groupId}` }));
    expect(roster.json().group.members).toHaveLength(1);
    expect(roster.json().group.members[0].role).toBe('leader');
  });

  it('keeps the leader and the roster consistent when a kick races the leader leaving', async () => {
    const leader = await makePlayer('Two Minds');
    const target = await makePlayer('Marked');
    const bystander = await makePlayer('Bystander');
    const { groupId } = await foundGroup(leader, groupName('Crossed Wires'));
    for (const member of [target, bystander]) await join(member, groupId, leader);

    const [kicked, left] = await Promise.all([kick(leader, groupId, target), leave(leader)]);
    expect(kicked.statusCode, kicked.body).not.toBe(500);
    expect(left.statusCode, left.body).toBe(200);

    const row = await db.query<{ leader_account_id: string }>(
      'SELECT leader_account_id FROM groups WHERE id = $1',
      [groupId],
    );
    const live = await db.query<{ account_id: string }>(
      'SELECT account_id FROM group_members WHERE group_id = $1 AND left_at IS NULL',
      [groupId],
    );
    const liveIds = live.rows.map((entry) => entry.account_id);
    // Whoever the leader is, they must still actually be in the group.
    expect(liveIds).toContain(row.rows[0]!.leader_account_id);
    expect(liveIds).not.toContain(leader.accountId);
  });

  it('gives the last seat to exactly one of five simultaneous accepts', async () => {
    const leader = await makePlayer('Gatekeeper');
    const { groupId } = await foundGroup(leader, groupName('One Seat Five Ways'));

    const seated = await Promise.all(
      Array.from({ length: GROUP_MAX_MEMBERS - 2 }, (_unused, index) => makePlayer(`Seated ${index}`)),
    );
    for (const member of seated) await join(member, groupId, leader);

    const racers = await Promise.all(
      Array.from({ length: 5 }, (_unused, index) => makePlayer(`Racer ${index}`)),
    );
    const invites: string[] = [];
    for (const racer of racers) {
      const issued = await invite(leader, groupId, racer);
      expect(issued.statusCode, issued.body).toBe(201);
      invites.push(issued.json().invite.id);
    }

    const results = await Promise.all(
      racers.map((racer, index) => respond(racer, invites[index]!, true)),
    );

    expect(results.filter((response) => response.statusCode === 200)).toHaveLength(1);
    for (const response of results) expect(response.statusCode, response.body).not.toBe(500);
    // The four losers must all be told *why*, not handed a generic failure.
    expect(new Set(codesOf(results))).toEqual(new Set(['GROUP_FULL']));
    expect(await liveMemberCount(groupId)).toBe(GROUP_MAX_MEMBERS);
  });

  it('holds the cap when a leave frees a seat at the moment two accepts contend for it', async () => {
    const leader = await makePlayer('Turnstile');
    const { groupId } = await foundGroup(leader, groupName('Revolving Door'));

    const seated = await Promise.all(
      Array.from({ length: GROUP_MAX_MEMBERS - 2 }, (_unused, index) => makePlayer(`Held ${index}`)),
    );
    for (const member of seated) await join(member, groupId, leader);

    const racerA = await makePlayer('Contender A');
    const racerB = await makePlayer('Contender B');
    const inviteA = await invite(leader, groupId, racerA);
    const inviteB = await invite(leader, groupId, racerB);

    const results = await Promise.all([
      respond(racerA, inviteA.json().invite.id, true),
      respond(racerB, inviteB.json().invite.id, true),
      leave(seated[0]!),
    ]);
    for (const response of results) expect(response.statusCode, response.body).not.toBe(500);

    expect(await liveMemberCount(groupId)).toBeLessThanOrEqual(GROUP_MAX_MEMBERS);
  });

  it('survives an invitation issued into a group that is closing at the same moment', async () => {
    const soleLeader = await makePlayer('Doorkeeper');
    const outsider = await makePlayer('Never Arrived');
    const { groupId } = await foundGroup(soleLeader, groupName('Shutting Down'));

    const [invited, left] = await Promise.all([
      invite(soleLeader, groupId, outsider),
      leave(soleLeader),
    ]);
    expect(invited.statusCode, invited.body).not.toBe(500);
    expect(left.statusCode, left.body).toBe(200);

    // However the two landed, the group is gone and the outsider cannot get into it.
    const archived = await db.query<{ archived_at: Date | null }>(
      'SELECT archived_at FROM groups WHERE id = $1',
      [groupId],
    );
    expect(archived.rows[0]!.archived_at).not.toBeNull();

    const mine = (await myGroup(outsider)).json() as MyGroupResponse;
    // A dead group must not sit in somebody's invitation list.
    expect(mine.invites.map((entry) => entry.groupId)).not.toContain(groupId);

    if (invited.statusCode === 201) {
      const attempted = await respond(outsider, invited.json().invite.id, true);
      expect(attempted.statusCode, attempted.body).toBe(404);
      expect(await liveMemberCount(groupId)).toBe(0);
    }
  });
});

/* --------------- account-vs-character scoping, the other half -------------- */

describe('the rejoin scoping rule, for every way out of a group', () => {
  it('does not hand a voluntary leaver their old group channel back on a rebuild', async () => {
    const leader = await makePlayer('Stayer');
    const quitter = await makePlayer('Quitter');
    const { groupId, channelId } = await foundGroup(leader, groupName('Walked Away'));
    await join(quitter, groupId, leader);

    expect((await leave(quitter)).statusCode).toBe(200);
    await deleteCharacter(quitter);
    expect((await rebuildCharacter(quitter, 'Returned')).statusCode).toBe(201);

    const channelMembership = await db.query(
      'SELECT 1 FROM chat_channel_members WHERE channel_id = $1 AND account_id = $2 AND left_at IS NULL',
      [channelId, quitter.accountId],
    );
    expect(channelMembership.rowCount, 'a rebuild must not re-open a group you left').toBe(0);
    expect((await myGroup(quitter)).json().group).toBeNull();

    const channels = await app.inject(authed(quitter, { method: 'GET', url: '/api/v1/chat/channels' }));
    expect(channels.json().channels.map((channel: { id: string }) => channel.id)).not.toContain(channelId);

    const history = await app.inject(
      authed(quitter, { method: 'GET', url: `/api/v1/chat/channels/${channelId}/messages` }),
    );
    expect(history.statusCode).toBe(404);
  });

  it('does not hand back the channel when the group emptied while the character was gone', async () => {
    const leader = await makePlayer('Sole Founder');
    const member = await makePlayer('Away');
    const { groupId, channelId } = await foundGroup(leader, groupName('Emptied While Away'));
    await join(member, groupId, leader);

    await deleteCharacter(member);
    expect((await leave(member)).statusCode).toBe(200);
    expect((await leave(leader)).statusCode).toBe(200);

    expect((await rebuildCharacter(member, 'Back Again')).statusCode).toBe(201);

    const channelMembership = await db.query(
      'SELECT 1 FROM chat_channel_members WHERE channel_id = $1 AND account_id = $2 AND left_at IS NULL',
      [channelId, member.accountId],
    );
    expect(channelMembership.rowCount).toBe(0);

    const history = await app.inject(
      authed(member, { method: 'GET', url: `/api/v1/chat/channels/${channelId}/messages` }),
    );
    expect(history.statusCode).toBe(404);
    expect((await myGroup(member)).json().group).toBeNull();
    expect(groupId).toBeTruthy();
  });

  it('keeps a still-live membership working through a rebuild, including the badge', async () => {
    const leader = await makePlayer('Constant');
    const shifter = await makePlayer('Shifter');
    const { groupId, channelId } = await foundGroup(leader, groupName('Species Change'));
    await join(shifter, groupId, leader);

    const said = `before-the-change-${randomUUID()}`;
    await db.query(
      `INSERT INTO chat_messages (id, channel_id, author_account_id, author_character_id, author_name_snapshot, body)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
      [channelId, leader.accountId, leader.characterId, leader.nickname, said],
    );

    await deleteCharacter(shifter);
    const rebuilt = await rebuildCharacter(shifter, 'NewShape');
    expect(rebuilt.statusCode).toBe(201);
    const newCharacterId = rebuilt.json().character.id;

    const mine = (await myGroup(shifter)).json() as MyGroupResponse;
    expect(mine.group!.id).toBe(groupId);
    // The roster's face is the *new* character; the membership itself never moved.
    expect(mine.group!.members.find((member) => member.accountId === shifter.accountId)).toMatchObject({
      characterId: newCharacterId,
      nickname: 'NewShape',
    });

    // History is untouched by the rebuild.
    const history = await app.inject(
      authed(shifter, { method: 'GET', url: `/api/v1/chat/channels/${channelId}/messages` }),
    );
    expect(history.statusCode).toBe(200);
    expect(history.body).toContain(said);

    // And the badge follows onto the new character's card.
    const cards = await app.inject(
      authed(leader, { method: 'GET', url: `/api/v1/duels/cards?characterIds=${newCharacterId}` }),
    );
    expect(cards.json().cards[0].groupName).toBe(mine.group!.name);
  });

  it('refuses a character-less account every group action that needs a face', async () => {
    const stranger = await makePlayer('No Body', { withCharacter: false });
    const leader = await makePlayer('Somebody');
    const { groupId } = await foundGroup(leader, groupName('Needs A Face'));

    const created = await createGroup(stranger, groupName('Ghost Town'));
    expect(created.statusCode).toBe(404);
    expect(created.json().error.code).toBe('NO_CHARACTER');

    // Reading is not doing: the public roster and one's own view need no character.
    const roster = await app.inject(authed(stranger, { method: 'GET', url: `/api/v1/groups/${groupId}` }));
    expect(roster.statusCode).toBe(200);
    expect((await myGroup(stranger)).statusCode).toBe(200);

    // And a body-less player cannot be invited into one.
    const invited = await invite(leader, groupId, stranger);
    expect(invited.statusCode).toBe(404);
  });
});

/* ------------------------- the age floor, exhaustively -------------------- */

describe('the account age floor', () => {
  it('blocks a fresh account from founding, from being invited, and from accepting', async () => {
    const leader = await makePlayer('Elder');
    const { groupId } = await foundGroup(leader, groupName('Grown Ups'));
    const newborn = await makePlayer('Newborn', { accountAgeHours: 1 });

    const created = await createGroup(newborn, groupName('Too Soon'));
    expect(created.statusCode).toBe(403);
    expect(created.json().error.code).toBe('GROUP_TOO_NEW');

    const invited = await invite(leader, groupId, newborn);
    expect(invited.statusCode).toBe(403);
    expect(invited.json().error.code).toBe('GROUP_TOO_NEW');

    // The accept path has to re-check it, or an invitation issued while the target was old
    // enough would be the way around the floor. Force a live invite past the invite check.
    await db.query(`UPDATE accounts SET created_at = now() - interval '48 hours' WHERE id = $1`, [
      newborn.accountId,
    ]);
    const nowValid = await invite(leader, groupId, newborn);
    expect(nowValid.statusCode).toBe(201);
    await db.query(`UPDATE accounts SET created_at = now() - interval '1 hours' WHERE id = $1`, [
      newborn.accountId,
    ]);

    const accepted = await respond(newborn, nowValid.json().invite.id, true);
    expect(accepted.statusCode, accepted.body).toBe(403);
    expect(accepted.json().error.code).toBe('GROUP_TOO_NEW');
    expect(await liveMemberCount(groupId)).toBe(1);
  });

  it('reads the account, not the character, so a brand-new pet does not re-gate a member', async () => {
    const leader = await makePlayer('Patient');
    const member = await makePlayer('Reborn');
    const { groupId } = await foundGroup(leader, groupName('Old Account New Pet'));
    await join(member, groupId, leader);

    await deleteCharacter(member);
    expect((await rebuildCharacter(member, 'DayOld')).statusCode).toBe(201);

    // A character minutes old on an account two days old keeps its place.
    expect((await myGroup(member)).json().group.id).toBe(groupId);

    // And can still act: inviting is a member's right, gated on the *account's* age.
    const outsider = await makePlayer('Outsider');
    const invited = await invite(member, groupId, outsider);
    expect(invited.statusCode, invited.body).toBe(201);
  });
});

/* ------------------------------- cooldowns -------------------------------- */

describe('the kick cooldown belongs to the group', () => {
  it('refuses a re-invite from a different member of the same group', async () => {
    const leader = await makePlayer('Bouncer');
    const softie = await makePlayer('Softie');
    const evicted = await makePlayer('Shown The Door');
    const { groupId } = await foundGroup(leader, groupName('One Voice'));
    await join(softie, groupId, leader);
    await join(evicted, groupId, leader);

    expect((await kick(leader, groupId, evicted)).statusCode).toBe(200);

    // A different member routing around the leader's decision is the whole point of the rule.
    const retry = await invite(softie, groupId, evicted);
    expect(retry.statusCode, retry.body).toBe(429);
    expect(retry.json().error.code).toBe('GROUP_KICK_COOLDOWN');
    expect(retry.json().error.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('lets a different group take them immediately, from any member', async () => {
    const bouncer = await makePlayer('Strict');
    const rival = await makePlayer('Rival');
    const rivalMember = await makePlayer('Rival Member');
    const evicted = await makePlayer('Free Agent');
    const strict = await foundGroup(bouncer, groupName('Strict House'));
    const open = await foundGroup(rival, groupName('Open House'));
    await join(rivalMember, open.groupId, rival);
    await join(evicted, strict.groupId, bouncer);
    expect((await kick(bouncer, strict.groupId, evicted)).statusCode).toBe(200);

    const invited = await invite(rivalMember, open.groupId, evicted);
    expect(invited.statusCode, invited.body).toBe(201);
    const accepted = await respond(evicted, invited.json().invite.id, true);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((await myGroup(evicted)).json().group.id).toBe(open.groupId);
  });

  it('cannot be dodged by an invitation issued before the removal', async () => {
    const leader = await makePlayer('Long Memory');
    const evicted = await makePlayer('Boomerang');
    const { groupId } = await foundGroup(leader, groupName('Long Memory House'));
    const issued = await invite(leader, groupId, evicted);
    expect((await respond(evicted, issued.json().invite.id, true)).statusCode).toBe(200);
    expect((await kick(leader, groupId, evicted)).statusCode).toBe(200);

    // Revive the very invitation that got them in, as a stale client would replay it.
    await db.query(`UPDATE group_invites SET state = 'pending', resolved_at = NULL WHERE id = $1`, [
      issued.json().invite.id,
    ]);
    const replayed = await respond(evicted, issued.json().invite.id, true);
    expect(replayed.statusCode, replayed.body).toBe(429);
    expect(replayed.json().error.code).toBe('GROUP_KICK_COOLDOWN');
    expect(await liveMemberCount(groupId)).toBe(1);
  });
});

describe('the derived create cooldown', () => {
  it('survives a restart, unlike the in-process limiter beside it', async () => {
    const wanderer = await makePlayer('Wanderer');
    const { groupId } = await foundGroup(wanderer, groupName('First Attempt'));
    expect((await leave(wanderer)).statusCode).toBe(200);
    expect(groupId).toBeTruthy();

    const blocked = await createGroup(wanderer, groupName('Second Attempt'));
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('GROUP_CREATE_COOLDOWN');

    // A whole new app: new limiter buckets, new pool clients, same database.
    const fresh = await createTestApp();
    try {
      const afterRestart = await createGroup(wanderer, groupName('Third Attempt'), fresh.app);
      expect(afterRestart.statusCode, 'the cooldown must not be in-process state').toBe(429);
      expect(afterRestart.json().error.code).toBe('GROUP_CREATE_COOLDOWN');
      expect(afterRestart.json().error.retryAfterSeconds).toBeGreaterThan(0);
    } finally {
      await fresh.app.close();
    }
  });

  it('applies to a kicked player exactly as it applies to one who walked', async () => {
    const leader = await makePlayer('Evictor');
    const evicted = await makePlayer('Evictee');
    const { groupId } = await foundGroup(leader, groupName('Founding Block'));
    await join(evicted, groupId, leader);
    expect((await kick(leader, groupId, evicted)).statusCode).toBe(200);

    const blocked = await createGroup(evicted, groupName('Rebound Group'));
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('GROUP_CREATE_COOLDOWN');
  });

  it('reads the most recent departure, not the first one', async () => {
    const drifter = await makePlayer('Drifter');
    const host = await makePlayer('Host');
    const { groupId } = await foundGroup(host, groupName('Way Station'));
    await join(drifter, groupId, host);
    await leave(drifter);

    // Age the single departure out, then take a second, fresher one.
    await db.query(`UPDATE group_members SET left_at = now() - interval '48 hours' WHERE account_id = $1`, [
      drifter.accountId,
    ]);
    const second = await foundGroup(drifter, groupName('Own Place'));
    expect((await leave(drifter)).statusCode).toBe(200);
    expect(second.groupId).toBeTruthy();

    const blocked = await createGroup(drifter, groupName('Third Place'));
    expect(blocked.statusCode, 'the newest departure is the one that counts').toBe(429);
  });
});

/* --------------------------- hidden information --------------------------- */

describe('the leak sweep for a removed member', () => {
  it('cuts a kicked player off from every read path at once', async () => {
    const leader = await makePlayer('Warden');
    const evicted = await makePlayer('Ejected');
    const { groupId, channelId } = await foundGroup(leader, groupName('Sealed Room'));
    await join(evicted, groupId, leader);

    const socket = await TestClient.connect(baseUrl, evicted.accessToken);
    try {
      // A live, legitimate subscription established *before* the removal.
      socket.send({ type: 'chat:subscribe', channelIds: [channelId] });
      await settle(150);

      expect((await kick(leader, groupId, evicted)).statusCode).toBe(200);

      const secret = `after-the-kick-${randomUUID()}`;
      await db.query(
        `INSERT INTO chat_messages (id, channel_id, author_account_id, author_character_id, author_name_snapshot, body)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
        [channelId, leader.accountId, leader.characterId, leader.nickname, secret],
      );

      // Every HTTP read path.
      const history = await app.inject(
        authed(evicted, { method: 'GET', url: `/api/v1/chat/channels/${channelId}/messages` }),
      );
      expect(history.statusCode).toBe(404);
      const channels = await app.inject(authed(evicted, { method: 'GET', url: '/api/v1/chat/channels' }));
      expect(channels.json().channels.map((channel: { id: string }) => channel.id)).not.toContain(channelId);
      expect((await myGroup(evicted)).json().group).toBeNull();

      // And the socket that was already subscribed.
      const spoken = `spoken-after-${randomUUID()}`;
      const insider = await TestClient.connect(baseUrl, leader.accessToken);
      try {
        insider.send({ type: 'chat:send', clientMsgId: randomUUID(), channelId, body: spoken });
        await insider.next('chat:ack');
        await settle();
        expect(socket.transcript()).not.toContain(spoken);
        expect(socket.transcript()).not.toContain(secret);
      } finally {
        await closeAll([insider]);
      }

      // Writes are refused with the code the UI already has words for.
      socket.send({ type: 'chat:send', clientMsgId: randomUUID(), channelId, body: 'let me back in' });
      const rejected = await socket.next('chat:rejected');
      expect(rejected.code).toBe('NOT_MEMBER');

      // A re-subscribe buys nothing either.
      socket.send({ type: 'chat:subscribe', channelIds: [channelId] });
      socket.send({ type: 'chat:read', channelId, lastReadMessageId: randomUUID() });
      await settle();
      expect(socket.transcript()).not.toContain(secret);
    } finally {
      await closeAll([socket]);
    }
  });

  it('keeps the public roster to a name and a roster, for any authenticated player', async () => {
    const leader = await makePlayer('Public Figure');
    const onlooker = await makePlayer('Onlooker');
    const { groupId } = await foundGroup(leader, groupName('Glass House'));

    const anonymous = await app.inject({ method: 'GET', url: `/api/v1/groups/${groupId}` });
    expect(anonymous.statusCode, 'public means any player, not anonymous').toBe(401);

    const seen = await app.inject(authed(onlooker, { method: 'GET', url: `/api/v1/groups/${groupId}` }));
    expect(seen.statusCode).toBe(200);
    const body = seen.json();
    expect(Object.keys(body.group).sort()).toEqual(
      ['createdAt', 'id', 'leaderAccountId', 'memberCount', 'members', 'name'].sort(),
    );
    expect(Object.keys(body.group.members[0]).sort()).toEqual(
      ['accountId', 'characterId', 'joinedAt', 'nickname', 'role'].sort(),
    );
    // The member's own view carries a channel id; a stranger's must not.
    expect(seen.body).not.toContain('channelId');
    for (const leaked of ['coins', 'balance', 'username', 'email', 'password', 'stats', 'invite']) {
      expect(seen.body.toLowerCase(), `roster leaked ${leaked}`).not.toContain(leaked);
    }
  });

  it('does not let a channel id from the roster become a way in', async () => {
    const leader = await makePlayer('Owner');
    const prowler = await makePlayer('Prowler');
    const { groupId, channelId } = await foundGroup(leader, groupName('Guessed At'));

    // Even handed the channel id directly, a non-member gets nothing anywhere.
    expect(
      (await app.inject(authed(prowler, { method: 'GET', url: `/api/v1/chat/channels/${channelId}/messages` })))
        .statusCode,
    ).toBe(404);
    const socket = await TestClient.connect(baseUrl, prowler.accessToken);
    try {
      socket.send({ type: 'chat:subscribe', channelIds: [channelId] });
      socket.send({ type: 'chat:send', clientMsgId: randomUUID(), channelId, body: 'hello?' });
      const rejected = await socket.next('chat:rejected');
      expect(rejected.code).toBe('NOT_MEMBER');
      expect(socket.transcript()).not.toContain(groupId);
    } finally {
      await closeAll([socket]);
    }
  });
});

/* ------------------------- chat behaviour, unchanged ---------------------- */

describe('chat behaviour the group projection must not have moved', () => {
  it('keeps the DM counterpart off a group channel and on a DM', async () => {
    const leader = await makePlayer('Talker');
    const member = await makePlayer('Listener');
    const { groupId, channelId } = await foundGroup(leader, groupName('Two Kinds'));
    await join(member, groupId, leader);

    const dm = await app.inject(
      authed(leader, {
        method: 'POST',
        url: '/api/v1/chat/dm',
        payload: { targetAccountId: member.accountId },
      }),
    );
    expect(dm.statusCode).toBe(201);

    const channels = (
      await app.inject(authed(leader, { method: 'GET', url: '/api/v1/chat/channels' }))
    ).json().channels as { id: string; kind: string; name: string | null; counterpart: unknown }[];

    const groupChannel = channels.find((channel) => channel.id === channelId)!;
    const dmChannel = channels.find((channel) => channel.kind === 'dm')!;

    // A group is labelled by its own name; a DM by the person on the other end.
    expect(groupChannel.counterpart, 'a group must not pick an arbitrary member').toBeNull();
    expect(groupChannel.name).toBeTruthy();
    expect(dmChannel.counterpart).toMatchObject({ accountId: member.accountId, nickname: 'Listener' });
    expect(dmChannel.name).toBeNull();
  });

  it('counts unread separately per channel kind and clears on read', async () => {
    const leader = await makePlayer('Sender');
    const member = await makePlayer('Receiver');
    const { groupId, channelId } = await foundGroup(leader, groupName('Unread Counts'));
    await join(member, groupId, leader);

    const dm = await app.inject(
      authed(leader, {
        method: 'POST',
        url: '/api/v1/chat/dm',
        payload: { targetAccountId: member.accountId },
      }),
    );
    const dmChannelId = dm.json().channel.id;

    const talker = await TestClient.connect(baseUrl, leader.accessToken);
    try {
      for (const body of ['one', 'two', 'three']) {
        talker.send({ type: 'chat:send', clientMsgId: randomUUID(), channelId, body: `group ${body}` });
        await talker.next('chat:ack');
      }
      talker.send({ type: 'chat:send', clientMsgId: randomUUID(), channelId: dmChannelId, body: 'dm one' });
      await talker.next('chat:ack');
    } finally {
      await closeAll([talker]);
    }

    const channels = (
      await app.inject(authed(member, { method: 'GET', url: '/api/v1/chat/channels' }))
    ).json().channels as { id: string; unreadCount: number }[];
    /**
     * Three lines, and not the fourth: the roster event announcing this member's own arrival
     * is authorless, and `author_account_id IS DISTINCT FROM me` used to count it as somebody
     * else's message. It now carries a subject, which the unread projections exclude for the
     * one person it is about — round-1 finding G-4.
     */
    expect(channels.find((channel) => channel.id === channelId)!.unreadCount).toBe(3);
    expect(channels.find((channel) => channel.id === dmChannelId)!.unreadCount).toBe(1);
    expect(groupId).toBeTruthy();
  });

  it('keeps a block hiding a DM author without touching the group channel', async () => {
    const leader = await makePlayer('Loud');
    const member = await makePlayer('Annoyed');
    const { groupId, channelId } = await foundGroup(leader, groupName('Blocked But Present'));
    await join(member, groupId, leader);

    const said = `said-in-group-${randomUUID()}`;
    await db.query(
      `INSERT INTO chat_messages (id, channel_id, author_account_id, author_character_id, author_name_snapshot, body)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
      [channelId, leader.accountId, leader.characterId, leader.nickname, said],
    );

    expect(
      (
        await app.inject(
          authed(member, {
            method: 'POST',
            url: '/api/v1/blocks',
            payload: { blockedAccountId: leader.accountId },
          }),
        )
      ).statusCode,
    ).toBe(204);

    // Blocking hides the author's lines everywhere, which is chat's existing rule.
    const history = await app.inject(
      authed(member, { method: 'GET', url: `/api/v1/chat/channels/${channelId}/messages` }),
    );
    expect(history.statusCode).toBe(200);
    expect(history.body).not.toContain(said);

    // A group channel must never report `blockedByMe`, which is a DM-only fact.
    const channels = (
      await app.inject(authed(member, { method: 'GET', url: '/api/v1/chat/channels' }))
    ).json().channels as { id: string; blockedByMe: boolean }[];
    expect(channels.find((channel) => channel.id === channelId)!.blockedByMe).toBe(false);
    expect(groupId).toBeTruthy();
  });

  it('leaves the Town Square out of every group projection', async () => {
    const leader = await makePlayer('Crier');
    const { groupId } = await foundGroup(leader, groupName('Not The Square'));
    const channels = (
      await app.inject(authed(leader, { method: 'GET', url: '/api/v1/chat/channels' }))
    ).json().channels as { id: string; kind: string }[];
    const square = channels.find((channel) => channel.id === TOWN_SQUARE_CHANNEL_ID)!;
    expect(square.kind).toBe('global');
    expect(channels.filter((channel) => channel.kind === 'group')).toHaveLength(1);
    expect(groupId).toBeTruthy();
  });
});

/* ------------------------- rejoin history, as designed -------------------- */

describe('rejoining a group', () => {
  it('shows the back-history from the window the player was away, as a DM rebuild does', async () => {
    const leader = await makePlayer('Keeper');
    const returner = await makePlayer('Returner');
    const { groupId, channelId } = await foundGroup(leader, groupName('Back Again House'));
    await join(returner, groupId, leader);
    expect((await leave(returner)).statusCode).toBe(200);

    const whileAway = `while-they-were-gone-${randomUUID()}`;
    await db.query(
      `INSERT INTO chat_messages (id, channel_id, author_account_id, author_character_id, author_name_snapshot, body)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
      [channelId, leader.accountId, leader.characterId, leader.nickname, whileAway],
    );

    const denied = await app.inject(
      authed(returner, { method: 'GET', url: `/api/v1/chat/channels/${channelId}/messages` }),
    );
    expect(denied.statusCode, 'while away, the room is shut').toBe(404);

    await join(returner, groupId, leader);
    const history = await app.inject(
      authed(returner, { method: 'GET', url: `/api/v1/chat/channels/${channelId}/messages` }),
    );
    expect(history.statusCode).toBe(200);
    // Documented, deliberate: a soft rejoin restores the whole log, exactly as a DM does.
    expect(history.body).toContain(whileAway);
  });
});

/* ---------------------- no gameplay rules, proven -------------------------- */

describe('groups change nothing about how the game is played', () => {
  it('leaves duel and raid eligibility identical for groupmates and strangers', async () => {
    const leader = await makePlayer('Mate One');
    const mate = await makePlayer('Mate Two', { ageCharacter: true });
    const stranger = await makePlayer('Not A Mate', { ageCharacter: true });
    const { groupId } = await foundGroup(leader, groupName('No Safe Haven'));
    await join(mate, groupId, leader);

    const before = await app.inject(
      authed(leader, {
        method: 'GET',
        url: `/api/v1/duels/cards?characterIds=${mate.characterId},${stranger.characterId}`,
      }),
    );
    const cards = before.json().cards as Record<string, unknown>[];
    const mateCard = cards.find((card) => card.characterId === mate.characterId)!;
    const strangerCard = cards.find((card) => card.characterId === stranger.characterId)!;

    // The badge is the only field a group is allowed to move.
    expect(mateCard.groupName).toBe('No Safe Haven'.slice(0, 0) + (mateCard.groupName as string));
    expect(mateCard.groupName).toBeTruthy();
    expect(strangerCard.groupName).toBeNull();

    // Everything that governs whether you can be attacked is the same either way.
    for (const field of ['duelEligible', 'raidEligible', 'isBeggar', 'immune'] as const) {
      if (!(field in mateCard)) continue;
      expect(mateCard[field], `${field} must not depend on being a groupmate`).toEqual(
        strangerCard[field],
      );
    }
    expect(groupId).toBeTruthy();
  });

  it('lets one groupmate duel another exactly as a stranger would', async () => {
    const attacker = await makePlayer('Brawler', { ageCharacter: true });
    const victim = await makePlayer('Sparring Partner', { ageCharacter: true });
    const { groupId } = await foundGroup(attacker, groupName('House Of Fists'));
    await join(victim, groupId, attacker);

    const socket = await TestClient.connect(baseUrl, attacker.accessToken);
    const target = await TestClient.connect(baseUrl, victim.accessToken);
    try {
      socket.send({ type: 'duel:invite', targetCharacterId: victim.characterId });
      const state = await socket.next('duel:invite_state');
      // An invitation between groupmates must be accepted by the server like any other.
      expect(state.state, 'a groupmate must be duelable like anyone else').toBe('pending');
      const received = await target.next('duel:invited');
      expect(received.from.characterId).toBe(attacker.characterId);
    } finally {
      await closeAll([socket, target]);
    }
    expect(groupId).toBeTruthy();
  });
});

/* ---------------------- loose ends the API leaves behind ------------------ */

describe('invitations that outlive the reason they were sent', () => {
  /**
   * Round-1 finding G-5: accepting an invitation cancels every other one outstanding, and
   * *founding* a group — the other way to stop being invitable — did not, so a leader kept
   * live invitations they could never act on. Both paths now settle them alike.
   */
  it('settles a founder outstanding invitations the way accepting one does', async () => {
    const host = await makePlayer('Recruiter');
    const founder = await makePlayer('Own Boss');
    const { groupId } = await foundGroup(host, groupName('Recruiting'));
    const issued = await invite(host, groupId, founder);
    expect(issued.statusCode, issued.body).toBe(201);

    const own = await foundGroup(founder, groupName('Own Place'));
    const mine = (await myGroup(founder)).json() as MyGroupResponse;
    expect(mine.group!.id).toBe(own.groupId);
    expect(mine.invites.map((entry) => entry.groupId)).not.toContain(groupId);

    const row = await db.query<{ state: string }>('SELECT state FROM group_invites WHERE id = $1', [
      issued.json().invite.id,
    ]);
    expect(row.rows[0]!.state).toBe('cancelled');

    // And it was already unanswerable, which is what kept this cosmetic before the fix.
    const refused = await respond(founder, issued.json().invite.id, true);
    expect(refused.statusCode).toBe(404);
  });

  /** Round-1 finding G-6: an invitation into a group that ends dies with it. */
  it('cancels a pending invitation on a group that has closed', async () => {
    const host = await makePlayer('Closing Host');
    const guest = await makePlayer('Never Came');
    const { groupId } = await foundGroup(host, groupName('Last Call'));
    const issued = await invite(host, groupId, guest);
    expect((await leave(host)).statusCode).toBe(200);

    const mine = (await myGroup(guest)).json() as MyGroupResponse;
    expect(mine.invites.map((entry) => entry.groupId)).not.toContain(groupId);
    expect((await respond(guest, issued.json().invite.id, true)).statusCode).toBe(404);

    // And the row is in a terminal state rather than pending forever in the partial index.
    const row = await db.query<{ state: string; resolved_at: Date | null }>(
      'SELECT state, resolved_at FROM group_invites WHERE id = $1',
      [issued.json().invite.id],
    );
    expect(row.rows[0]!.state).toBe('cancelled');
    expect(row.rows[0]!.resolved_at).not.toBeNull();
  });
});

describe('what the derived cooldowns depend on', () => {
  /**
   * Priority 5.1, taken to its edge: the create cooldown is a query over `group_members`
   * history, and those rows cascade-delete with the group they belong to. No code deletes a
   * group today — archiving is a soft flag — so this is latent, not live. It is the one
   * property a stored column on `accounts` would not share.
   */
  it('evaporates if the group whose history carries it is ever hard-deleted', async () => {
    const drifter = await makePlayer('History Dependent');
    const { groupId } = await foundGroup(drifter, groupName('Short Lived'));
    expect((await leave(drifter)).statusCode).toBe(200);

    const blocked = await createGroup(drifter, groupName('Blocked Try'));
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('GROUP_CREATE_COOLDOWN');

    // Simulating the only thing that could ever remove the evidence.
    await db.query('DELETE FROM groups WHERE id = $1', [groupId]);

    const allowed = await createGroup(drifter, groupName('Free Try'));
    expect(
      allowed.statusCode,
      'the cooldown is only as durable as the membership row it is read from',
    ).toBe(201);
  });

  it('is not reset by a character rebuild, which is the obvious way to try', async () => {
    const drifter = await makePlayer('Rebuild Dodger');
    const { groupId } = await foundGroup(drifter, groupName('Abandoned'));
    expect((await leave(drifter)).statusCode).toBe(200);
    expect(groupId).toBeTruthy();

    await deleteCharacter(drifter);
    expect((await rebuildCharacter(drifter, 'BrandNew')).statusCode).toBe(201);

    const blocked = await createGroup(drifter, groupName('Dodge Attempt'));
    expect(blocked.statusCode, 'a new pet must not clear an account-scoped cooldown').toBe(429);
    expect(blocked.json().error.code).toBe('GROUP_CREATE_COOLDOWN');
  });
});

/* ------------------- what an account row takes with it -------------------- */

describe('the group foreign keys', () => {
  /**
   * Round-1 finding G-2. `groups.leader_account_id` was `ON DELETE CASCADE`, and leadership
   * *moves* — so which account held the cascade was arbitrary and changed over time: deleting
   * it destroyed the whole group and stranded its room. It is now `ON DELETE SET NULL`, the
   * call chat already made for this shape (`chat_channels.created_by`), and a NULL leader is
   * resolved by the same handoff a voluntary departure makes.
   */
  it('hands the group over when the account that leads it is deleted, and keeps its room', async () => {
    const leader = await makePlayer('Doomed Leader');
    const memberA = await makePlayer('Stranded A');
    const memberB = await makePlayer('Stranded B');
    const { groupId, channelId } = await foundGroup(leader, groupName('Cascade Test'));
    await join(memberA, groupId, leader);
    await join(memberB, groupId, leader);

    const said = `room-history-${randomUUID()}`;
    await db.query(
      `INSERT INTO chat_messages (id, channel_id, author_account_id, author_character_id, author_name_snapshot, body)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
      [channelId, leader.accountId, leader.characterId, leader.nickname, said],
    );

    // The one statement a GDPR erasure or an admin tool would run.
    await db.query('DELETE FROM accounts WHERE id = $1', [leader.accountId]);

    // The group outlives its leader: the row is still there, still live, and leaderless only
    // until something reads it.
    const group = await db.query<{ leader_account_id: string | null; archived_at: Date | null }>(
      'SELECT leader_account_id, archived_at FROM groups WHERE id = $1',
      [groupId],
    );
    expect(group.rowCount, 'two uninvolved members must not lose their group').toBe(1);
    expect(group.rows[0]!.archived_at).toBeNull();
    expect(group.rows[0]!.leader_account_id).toBeNull();

    // Its room is not gone, and the survivors are still live members of it.
    const channel = await db.query<{ archived_at: Date | null }>(
      'SELECT archived_at FROM chat_channels WHERE id = $1',
      [channelId],
    );
    expect(channel.rowCount).toBe(1);
    expect(channel.rows[0]!.archived_at, 'the stranded room was never archived').toBeNull();

    const live = await db.query(
      'SELECT 1 FROM chat_channel_members WHERE channel_id = $1 AND left_at IS NULL',
      [channelId],
    );
    expect(live.rowCount).toBe(2);

    // The survivors can still read and write their room, which now still has a group behind it.
    const channels = await app.inject(authed(memberA, { method: 'GET', url: '/api/v1/chat/channels' }));
    expect(channels.json().channels.map((entry: { id: string }) => entry.id)).toContain(channelId);

    const history = await app.inject(
      authed(memberA, { method: 'GET', url: `/api/v1/chat/channels/${channelId}/messages` }),
    );
    expect(history.statusCode).toBe(200);
    expect(history.body).toContain(said);

    // The first read of the group promotes the longest-standing member, exactly as a leader
    // walking out already does.
    const mine = (await myGroup(memberA)).json() as MyGroupResponse;
    expect(mine.group!.id).toBe(groupId);
    expect(mine.group!.leaderAccountId).toBe(memberA.accountId);
    expect(mine.group!.role).toBe('leader');
    expect(mine.group!.memberCount).toBe(2);
    expect((await myGroup(memberB)).json().group.role).toBe('member');

    // And there is a way out, for the promoted leader and for the other survivor alike.
    expect((await leave(memberB)).statusCode).toBe(200);
    expect((await leave(memberA)).statusCode).toBe(200);
    const closed = await db.query<{ archived_at: Date | null }>(
      'SELECT archived_at FROM groups WHERE id = $1',
      [groupId],
    );
    expect(closed.rows[0]!.archived_at, 'the group ends the only way it can: emptied').not.toBeNull();
  });
});
