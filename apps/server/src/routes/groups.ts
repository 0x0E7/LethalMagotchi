import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  GROUP_CREATE_COOLDOWN_MS,
  GROUP_INVITE_TTL_MS,
  GROUP_KICK_COOLDOWN_MS,
  GROUP_MAX_MEMBERS,
  containsBlockedTerm,
  cooldownEndsAt,
  groupCreateSchema,
  groupInviteRespondSchema,
  groupInviteSchema,
  isCreateCooldownActive,
  isKickCooldownActive,
  isOldEnoughForGroup,
  normalizeGroupName,
  type GroupInviteDto,
  type GroupResponse,
  type MyGroupResponse,
} from '@lethalmagotchi/shared';
import { isUniqueViolation, withTransaction, type DbClient } from '../db/pool.js';
import type { ServerDeps } from '../deps.js';
import { ApiError } from '../errors.js';
import { findAccountById, type AccountRow } from '../repos/accounts.js';
import { findActiveCharacterByAccount } from '../repos/characters.js';
import {
  findMemberChannelDto,
  insertSystemMessage,
  isBlockedEitherWay,
  type MessageRow,
} from '../repos/chat.js';
import {
  archiveGroup,
  cancelPendingInvitesFor,
  claimInviteResolution,
  countActiveMembers,
  expireStaleInvites,
  findActiveGroupForAccount,
  findGroupById,
  findInviteById,
  insertGroupWithChannel,
  insertInvite,
  insertMember,
  isActiveMember,
  joinGroupChannel,
  lastDepartureAt,
  lastRemovedAt,
  leaveGroupMembership,
  listPendingInvitesFor,
  listRoster,
  lockAccountForJoin,
  lockActiveGroupForAccount,
  lockGroup,
  promoteLongestStanding,
  toGroupDto,
  toMyGroupDto,
  type GroupRow,
} from '../repos/groups.js';
import { parseOrThrow } from '../validate.js';

const groupParamsSchema = z.object({ id: z.string().uuid() });
const memberParamsSchema = z.object({ id: z.string().uuid(), accountId: z.string().uuid() });

function secondsUntil(deadline: Date, now: number): number {
  return Math.max(1, Math.ceil((deadline.getTime() - now) / 1000));
}

export async function registerGroupRoutes(app: FastifyInstance, deps: ServerDeps): Promise<void> {
  const { db, limiters, chat, hub } = deps;

  /** Same gate chat uses: a group is a place in the world, and you stand in it as somebody. */
  const requireCharacter = async (accountId: string) => {
    const character = await findActiveCharacterByAccount(db, accountId);
    if (!character) throw new ApiError(404, 'NO_CHARACTER', 'You do not have a character yet.');
    return character;
  };

  const requireAccount = async (accountId: string): Promise<AccountRow> => {
    const account = await findAccountById(db, accountId);
    if (!account) throw new ApiError(401, 'UNAUTHORIZED', 'Account no longer exists.');
    return account;
  };

  /**
   * Everything a caller is told about their own group, read after whatever just changed it —
   * one shape for create, accept, leave and the plain GET, so the client never has to merge
   * a partial answer into what it already holds.
   */
  const myGroupPayload = async (accountId: string, now: number): Promise<MyGroupResponse> => {
    const group = await findActiveGroupForAccount(db, accountId);
    await expireStaleInvites(db, { at: new Date(now), toAccountId: accountId });
    const invites = await listPendingInvitesFor(db, accountId, new Date(now));
    if (!group) return { group: null, invites };
    return { group: toMyGroupDto(group, await listRoster(db, group.id), accountId), invites };
  };

  /**
   * A roster event, written inside the transaction that makes it true. `subjectAccountId` is
   * the member the event reports, and only when it is their own doing: their arrival is not
   * unread news to them, the way their own message would not be.
   */
  const announce = (
    client: DbClient,
    group: GroupRow,
    body: string,
    at: Date,
    subjectAccountId?: string,
  ): Promise<MessageRow> =>
    insertSystemMessage(client, {
      channelId: group.channel_id,
      body,
      at,
      ...(subjectAccountId ? { subjectAccountId } : {}),
    });

  const deliver = async (group: GroupRow, rows: MessageRow[]): Promise<void> => {
    for (const row of rows) await chat.deliverSystemMessage(group.channel_id, row);
  };

  /** The new member's socket cannot ask for a channel it has never heard of. */
  const announceChannelTo = async (accountId: string, channelId: string): Promise<void> => {
    const view = await findMemberChannelDto(db, channelId, accountId);
    if (view) chat.announceChannel([accountId], () => view);
  };

  app.post('/api/v1/groups', { onRequest: app.authenticate }, async (request, reply) => {
    const accountId = request.accountId;
    const { name } = parseOrThrow(groupCreateSchema, request.body);
    if (containsBlockedTerm(name)) {
      throw new ApiError(422, 'GROUP_NAME_REJECTED', 'That group name is not allowed.', {
        fields: { name: 'That group name is not allowed.' },
      });
    }

    await requireCharacter(accountId);
    const account = await requireAccount(accountId);
    const now = Date.now();
    if (!isOldEnoughForGroup(account.created_at, now)) {
      throw new ApiError(403, 'GROUP_TOO_NEW', 'Groups open up once your account is a day old.');
    }

    const departed = await lastDepartureAt(db, accountId);
    if (departed && isCreateCooldownActive(departed, now)) {
      throw new ApiError(429, 'GROUP_CREATE_COOLDOWN', 'You left a group recently. Try again tomorrow.', {
        retryAfterSeconds: secondsUntil(cooldownEndsAt(departed, GROUP_CREATE_COOLDOWN_MS), now),
      });
    }

    const budget = limiters.groupCreate.check(accountId);
    if (!budget.allowed) {
      throw new ApiError(429, 'RATE_LIMITED', 'Too many groups. Try again later.', {
        retryAfterSeconds: budget.retryAfterSeconds,
      });
    }

    const at = new Date(now);
    let group: GroupRow;
    try {
      group = await withTransaction(db, async (client) => {
        await lockAccountForJoin(client, accountId);
        const created = await insertGroupWithChannel(client, {
          accountId,
          name,
          nameNormalized: normalizeGroupName(name),
          at,
        });
        await insertMember(client, { groupId: created.id, accountId, at });
        await joinGroupChannel(client, { channelId: created.channel_id, accountId });
        // Founding a group ends the same way accepting an invitation does — in a membership —
        // so it settles outstanding invitations the same way too.
        await cancelPendingInvitesFor(client, { toAccountId: accountId, at });
        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'ux_groups_name_normalized')) {
        throw new ApiError(409, 'GROUP_NAME_TAKEN', 'That group name is taken.', {
          fields: { name: 'That group name is taken.' },
        });
      }
      // The one-group-at-a-time index, caught rather than surfaced as a constraint failure.
      if (isUniqueViolation(error, 'ux_group_members_account')) {
        throw new ApiError(409, 'GROUP_MEMBERSHIP_EXISTS', 'You are already in a group.');
      }
      throw error;
    }

    await announceChannelTo(accountId, group.channel_id);
    return reply.code(201).send(await myGroupPayload(accountId, now));
  });

  app.get('/api/v1/groups/me', { onRequest: app.authenticate }, async (request, reply) => {
    return reply.code(200).send(await myGroupPayload(request.accountId, Date.now()));
  });

  /** Public: a group is who you are seen with, so its roster is not a members-only fact. */
  app.get('/api/v1/groups/:id', { onRequest: app.authenticate }, async (request, reply) => {
    const { id } = parseOrThrow(groupParamsSchema, request.params);
    const group = await findGroupById(db, id);
    if (!group || group.archived_at) throw new ApiError(404, 'NOT_FOUND', 'No such group.');

    const payload: GroupResponse = { group: toGroupDto(group, await listRoster(db, group.id)) };
    return reply.code(200).send(payload);
  });

  app.post('/api/v1/groups/:id/invites', { onRequest: app.authenticate }, async (request, reply) => {
    const accountId = request.accountId;
    const { id } = parseOrThrow(groupParamsSchema, request.params);
    const { toAccountId } = parseOrThrow(groupInviteSchema, request.body);
    const inviter = await requireCharacter(accountId);
    const now = Date.now();

    if (toAccountId === accountId) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'You are already in this group.', {
        fields: { toAccountId: 'Pick another player.' },
      });
    }

    const group = await findGroupById(db, id);
    if (!group || group.archived_at) throw new ApiError(404, 'NOT_FOUND', 'No such group.');
    if (!(await isActiveMember(db, group.id, accountId))) {
      throw new ApiError(403, 'GROUP_NOT_MEMBER', 'You are not in that group.');
    }

    if (!(await findActiveCharacterByAccount(db, toAccountId))) {
      throw new ApiError(404, 'NOT_FOUND', 'That player is not around.');
    }
    const targetAccount = await findAccountById(db, toAccountId);
    if (!targetAccount) throw new ApiError(404, 'NOT_FOUND', 'That player is not around.');
    if (!isOldEnoughForGroup(targetAccount.created_at, now)) {
      throw new ApiError(403, 'GROUP_TOO_NEW', 'Their account is too new to join a group.');
    }
    if (await isBlockedEitherWay(db, accountId, toAccountId)) {
      throw new ApiError(403, 'BLOCKED', 'You cannot invite this player.');
    }
    if (await findActiveGroupForAccount(db, toAccountId)) {
      throw new ApiError(409, 'GROUP_MEMBERSHIP_EXISTS', 'They already belong to a group.');
    }

    /**
     * The block belongs to the group, not to whoever pressed the button: any member issuing
     * the invite would otherwise route straight around the leader's decision to remove them.
     */
    const removed = await lastRemovedAt(db, group.id, toAccountId);
    if (removed && isKickCooldownActive(removed, now)) {
      throw new ApiError(429, 'GROUP_KICK_COOLDOWN', 'This group removed them recently.', {
        retryAfterSeconds: secondsUntil(cooldownEndsAt(removed, GROUP_KICK_COOLDOWN_MS), now),
      });
    }
    // Checked again under the group's row lock when the invite is answered: a group can fill
    // up in the days an invitation is allowed to sit unanswered.
    if ((await countActiveMembers(db, group.id)) >= GROUP_MAX_MEMBERS) {
      throw new ApiError(409, 'GROUP_FULL', `A group holds ${GROUP_MAX_MEMBERS} members.`);
    }

    const budget = limiters.groupInvite.check(accountId);
    if (!budget.allowed) {
      throw new ApiError(429, 'RATE_LIMITED', 'Too many invitations. Take a breath.', {
        retryAfterSeconds: budget.retryAfterSeconds,
      });
    }

    const at = new Date(now);
    await expireStaleInvites(db, { at, groupId: group.id, toAccountId });

    let invite;
    try {
      invite = await withTransaction(db, (client) =>
        insertInvite(client, {
          groupId: group.id,
          fromAccountId: accountId,
          toAccountId,
          createdAt: at,
          expiresAt: new Date(now + GROUP_INVITE_TTL_MS),
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error, 'ux_group_invites_pending')) {
        throw new ApiError(409, 'GROUP_INVITE_PENDING', 'They already have an invitation from this group.');
      }
      throw error;
    }

    /**
     * The one group event a player cannot see for themselves: everything else they either did
     * or is written into a room they are already in. Without this the Groups tab's invitation
     * badge is computed from page-load state and can only learn of an invitation by being
     * clicked — which is the affordance that was supposed to prompt the click.
     */
    hub.sendToAccounts([toAccountId], { type: 'group:sync' });

    const payload: { invite: GroupInviteDto } = {
      invite: {
        id: invite.id,
        groupId: group.id,
        groupName: group.name,
        fromAccountId: accountId,
        fromNickname: inviter.nickname,
        createdAt: invite.created_at.toISOString(),
        expiresAt: invite.expires_at.toISOString(),
      },
    };
    return reply.code(201).send(payload);
  });

  app.post('/api/v1/groups/invites/:id/respond', { onRequest: app.authenticate }, async (request, reply) => {
    const accountId = request.accountId;
    const { id } = parseOrThrow(groupParamsSchema, request.params);
    const { accept } = parseOrThrow(groupInviteRespondSchema, request.body);
    const now = Date.now();
    const at = new Date(now);

    const invite = await findInviteById(db, id);
    // An invitation addressed to someone else is indistinguishable from one that never
    // existed: answering differently would make this endpoint an invite oracle.
    if (!invite || invite.to_account_id !== accountId) {
      throw new ApiError(404, 'NOT_FOUND', 'That invitation is no longer around.');
    }

    if (!accept) {
      const declined = await withTransaction(db, (client) =>
        claimInviteResolution(client, { inviteId: id, toAccountId: accountId, state: 'declined', at }),
      );
      if (!declined) throw new ApiError(404, 'NOT_FOUND', 'That invitation is no longer around.');
      return reply.code(200).send(await myGroupPayload(accountId, now));
    }

    const character = await requireCharacter(accountId);
    const account = await requireAccount(accountId);
    if (!isOldEnoughForGroup(account.created_at, now)) {
      throw new ApiError(403, 'GROUP_TOO_NEW', 'Groups open up once your account is a day old.');
    }

    let joined: { group: GroupRow; system: MessageRow };
    try {
      joined = await withTransaction(db, async (client) => {
        // Always before the group, so two invitations answered at once cannot deadlock.
        await lockAccountForJoin(client, accountId);
        /**
         * Taken before the invite is claimed, so every accept for this group queues behind
         * the same lock: the last free seat goes to exactly one of two simultaneous answers,
         * and the loser's claim rolls back with the rest of its transaction.
         */
        const group = await lockGroup(client, invite.group_id);
        if (!group || group.archived_at) {
          throw new ApiError(404, 'NOT_FOUND', 'That group is no longer around.');
        }

        const claimed = await claimInviteResolution(client, {
          inviteId: id,
          toAccountId: accountId,
          state: 'accepted',
          at,
        });
        if (!claimed) throw new ApiError(404, 'NOT_FOUND', 'That invitation is no longer around.');

        const removed = await lastRemovedAt(client, group.id, accountId);
        if (removed && isKickCooldownActive(removed, now)) {
          throw new ApiError(429, 'GROUP_KICK_COOLDOWN', 'This group removed you recently.', {
            retryAfterSeconds: secondsUntil(cooldownEndsAt(removed, GROUP_KICK_COOLDOWN_MS), now),
          });
        }
        if ((await countActiveMembers(client, group.id)) >= GROUP_MAX_MEMBERS) {
          throw new ApiError(409, 'GROUP_FULL', 'That group is full.');
        }

        await insertMember(client, { groupId: group.id, accountId, at });
        await joinGroupChannel(client, { channelId: group.channel_id, accountId });
        // Anything else outstanding is unanswerable now, so it is not left on their screen.
        await cancelPendingInvitesFor(client, { toAccountId: accountId, at });

        const system = await announce(
          client,
          group,
          `${character.nickname} joined the group.`,
          at,
          accountId,
        );
        return { group, system };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'ux_group_members_account')) {
        throw new ApiError(409, 'GROUP_MEMBERSHIP_EXISTS', 'You are already in a group.');
      }
      throw error;
    }

    await announceChannelTo(accountId, joined.group.channel_id);
    await deliver(joined.group, [joined.system]);
    return reply.code(200).send(await myGroupPayload(accountId, now));
  });

  app.delete('/api/v1/groups/me/membership', { onRequest: app.authenticate }, async (request, reply) => {
    const accountId = request.accountId;
    const now = Date.now();
    const at = new Date(now);
    const character = await findActiveCharacterByAccount(db, accountId);
    const who = character?.nickname ?? 'A member';

    const outcome = await withTransaction(db, async (client) => {
      const group = await lockActiveGroupForAccount(client, accountId);
      if (!group) throw new ApiError(404, 'GROUP_NOT_MEMBER', 'You are not in a group.');

      const left = await leaveGroupMembership(client, { groupId: group.id, accountId, at });
      if (!left) throw new ApiError(404, 'GROUP_NOT_MEMBER', 'You are not in a group.');

      const remaining = await countActiveMembers(client, group.id);
      /**
       * The only way a group ends: not a button anyone presses, but the last person turning
       * the light off. The channel is archived with it, exactly as a DM's last participant
       * leaving already does.
       */
      if (remaining === 0) {
        await archiveGroup(client, group.id, at);
        return { group, rows: [] as MessageRow[] };
      }

      const rows = [await announce(client, group, `${who} left the group.`, at)];
      if (group.leader_account_id === accountId) {
        const promoted = await promoteLongestStanding(client, group.id);
        const nickname = promoted ? await nicknameOf(client, promoted) : null;
        if (nickname) rows.push(await announce(client, group, `${nickname} is now the leader.`, at));
      }
      return { group, rows };
    });

    await deliver(outcome.group, outcome.rows);
    return reply.code(200).send(await myGroupPayload(accountId, now));
  });

  app.delete('/api/v1/groups/:id/members/:accountId', { onRequest: app.authenticate }, async (request, reply) => {
    const leaderAccountId = request.accountId;
    const { id, accountId } = parseOrThrow(memberParamsSchema, request.params);
    const now = Date.now();
    const at = new Date(now);

    if (accountId === leaderAccountId) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Leave the group instead.');
    }

    const outcome = await withTransaction(db, async (client) => {
      const group = await lockGroup(client, id);
      if (!group || group.archived_at) throw new ApiError(404, 'NOT_FOUND', 'No such group.');
      // Removing is the leader's single clear responsibility; inviting is everybody's.
      if (group.leader_account_id !== leaderAccountId) {
        throw new ApiError(403, 'GROUP_NOT_LEADER', 'Only the leader can remove members.');
      }

      const nickname = await nicknameOf(client, accountId);
      const removed = await leaveGroupMembership(client, {
        groupId: group.id,
        accountId,
        at,
        removedBy: leaderAccountId,
      });
      if (!removed) throw new ApiError(404, 'GROUP_NOT_MEMBER', 'They are not in that group.');

      const rows = [await announce(client, group, `${nickname ?? 'A member'} was removed from the group.`, at)];
      return { group, rows };
    });

    await deliver(outcome.group, outcome.rows);
    return reply.code(200).send(await myGroupPayload(leaderAccountId, now));
  });

  async function nicknameOf(client: DbClient, accountId: string): Promise<string | null> {
    const result = await client.query<{ nickname: string }>(
      'SELECT nickname FROM characters WHERE account_id = $1 AND deleted_at IS NULL',
      [accountId],
    );
    return result.rows[0]?.nickname ?? null;
  }
}
