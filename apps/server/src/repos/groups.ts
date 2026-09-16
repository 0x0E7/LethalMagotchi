import {
  groupChannelKey,
  type GroupDto,
  type GroupInviteDto,
  type GroupInviteState,
  type GroupMemberDto,
  type MyGroupDto,
} from '@lethalmagotchi/shared';
import type { Db, DbClient } from '../db/pool.js';
import { uuidv7 } from '../uuid.js';

export interface GroupRow {
  id: string;
  name: string;
  name_normalized: string;
  /** NULL while the group is between leaders — see `healLeaderlessGroup`. */
  leader_account_id: string | null;
  channel_id: string;
  created_at: Date;
  archived_at: Date | null;
}

export interface GroupInviteRow {
  id: string;
  group_id: string;
  from_account_id: string;
  to_account_id: string;
  state: GroupInviteState;
  created_at: Date;
  expires_at: Date;
  resolved_at: Date | null;
}

export interface RosterRow {
  account_id: string;
  joined_at: Date;
  character_id: string | null;
  nickname: string | null;
}

interface InviteListRow extends GroupInviteRow {
  group_name: string;
  from_nickname: string | null;
}

export function toMemberDto(row: RosterRow, leaderAccountId: string | null): GroupMemberDto {
  return {
    accountId: row.account_id,
    characterId: row.character_id,
    nickname: row.nickname,
    role: row.account_id === leaderAccountId ? 'leader' : 'member',
    joinedAt: row.joined_at.toISOString(),
  };
}

export function toGroupDto(group: GroupRow, roster: RosterRow[]): GroupDto {
  return {
    id: group.id,
    name: group.name,
    leaderAccountId: group.leader_account_id,
    createdAt: group.created_at.toISOString(),
    memberCount: roster.length,
    members: roster.map((row) => toMemberDto(row, group.leader_account_id)),
  };
}

export function toMyGroupDto(group: GroupRow, roster: RosterRow[], accountId: string): MyGroupDto {
  return {
    ...toGroupDto(group, roster),
    channelId: group.channel_id,
    role: group.leader_account_id === accountId ? 'leader' : 'member',
  };
}

function toInviteDto(row: InviteListRow): GroupInviteDto {
  return {
    id: row.id,
    groupId: row.group_id,
    groupName: row.group_name,
    fromAccountId: row.from_account_id,
    fromNickname: row.from_nickname,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  };
}

/* -------------------------------- groups -------------------------------- */

export async function findGroupById(db: Db | DbClient, groupId: string): Promise<GroupRow | null> {
  const result = await db.query<GroupRow>('SELECT * FROM groups WHERE id = $1', [groupId]);
  return healLeaderlessGroup(db, result.rows[0] ?? null);
}

/**
 * Taken first by every join, before any group row, so two invitations answered at once by
 * one person serialise here instead of deadlocking: each would otherwise hold its own group
 * and its own invite row while waiting for the other's — a cycle Postgres resolves by
 * killing one transaction, which is a 500 where a 409 belongs.
 *
 * The lock order is account-then-group everywhere; nothing in the product takes them the
 * other way round.
 */
export async function lockAccountForJoin(client: DbClient, accountId: string): Promise<void> {
  await client.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
}

/**
 * The serialisation point for everything that changes a roster. Joining, leaving and kicking
 * all take it, so the size cap is counted against a membership set nobody else can be
 * writing to — which is what makes the 30th seat go to exactly one of two racing accepts.
 */
export async function lockGroup(client: DbClient, groupId: string): Promise<GroupRow | null> {
  const result = await client.query<GroupRow>('SELECT * FROM groups WHERE id = $1 FOR UPDATE', [groupId]);
  return healLeaderlessGroup(client, result.rows[0] ?? null);
}

/**
 * The group a channel belongs to, created in one transaction with it so a group can never
 * exist without somewhere to talk. The channel key is the group id, so `ux_chat_channels_key`
 * is what makes this idempotent under concurrency rather than a read-then-write.
 */
export async function insertGroupWithChannel(
  client: DbClient,
  input: { accountId: string; name: string; nameNormalized: string; at: Date },
): Promise<GroupRow> {
  const groupId = uuidv7();
  const channel = await client.query<{ id: string }>(
    `INSERT INTO chat_channels (id, kind, key, name, created_by)
     VALUES ($1, 'group', $2, $3, $4)
     RETURNING id`,
    [uuidv7(), groupChannelKey(groupId), input.name, input.accountId],
  );
  const channelId = channel.rows[0]!.id;

  const group = await client.query<GroupRow>(
    `INSERT INTO groups (id, name, name_normalized, leader_account_id, channel_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [groupId, input.name, input.nameNormalized, input.accountId, channelId, input.at],
  );
  return group.rows[0]!;
}

export async function archiveGroup(client: DbClient, groupId: string, at: Date): Promise<void> {
  await client.query('UPDATE groups SET archived_at = $2 WHERE id = $1 AND archived_at IS NULL', [
    groupId,
    at,
  ]);
  await client.query(
    `UPDATE chat_channels SET archived_at = $2
     WHERE archived_at IS NULL AND id = (SELECT channel_id FROM groups WHERE id = $1)`,
    [groupId, at],
  );
  // Nothing can be joined here any more, so an outstanding invitation is not left pending:
  // it would be unanswerable, invisible to its recipient, and still holding a seat in
  // `ux_group_invites_pending`.
  await cancelPendingInvitesToGroup(client, { groupId, at });
}

/* ------------------------------- members -------------------------------- */

export async function findActiveGroupForAccount(db: Db | DbClient, accountId: string): Promise<GroupRow | null> {
  const result = await db.query<GroupRow>(
    `SELECT g.* FROM groups g
     JOIN group_members m ON m.group_id = g.id AND m.account_id = $1 AND m.left_at IS NULL
     WHERE g.archived_at IS NULL`,
    [accountId],
  );
  return healLeaderlessGroup(db, result.rows[0] ?? null);
}

/**
 * The caller's own group, locked in the same statement that finds it — leaving has to count
 * the remaining roster and possibly promote off it, and a read-then-lock leaves a window
 * where two departures both see themselves as not-the-last member.
 */
export async function lockActiveGroupForAccount(
  client: DbClient,
  accountId: string,
): Promise<GroupRow | null> {
  const result = await client.query<GroupRow>(
    `SELECT g.* FROM groups g
     JOIN group_members m ON m.group_id = g.id AND m.account_id = $1 AND m.left_at IS NULL
     WHERE g.archived_at IS NULL
     FOR UPDATE OF g`,
    [accountId],
  );
  return healLeaderlessGroup(client, result.rows[0] ?? null);
}

export async function isActiveMember(db: Db | DbClient, groupId: string, accountId: string): Promise<boolean> {
  const result = await db.query(
    'SELECT 1 FROM group_members WHERE group_id = $1 AND account_id = $2 AND left_at IS NULL',
    [groupId, accountId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function countActiveMembers(db: Db | DbClient, groupId: string): Promise<number> {
  const result = await db.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM group_members WHERE group_id = $1 AND left_at IS NULL',
    [groupId],
  );
  return result.rows[0]?.count ?? 0;
}

/** Public: anyone may read who is in a group. Ordered the way leadership is decided. */
export async function listRoster(db: Db | DbClient, groupId: string): Promise<RosterRow[]> {
  const result = await db.query<RosterRow>(
    `SELECT m.account_id, m.joined_at, c.id AS character_id, c.nickname
     FROM group_members m
     LEFT JOIN characters c ON c.account_id = m.account_id AND c.deleted_at IS NULL
     WHERE m.group_id = $1 AND m.left_at IS NULL
     ORDER BY m.joined_at, m.account_id`,
    [groupId],
  );
  return result.rows;
}

/**
 * Throws the unique violation on `ux_group_members_account` when the account already holds a
 * live membership somewhere — the one-group-at-a-time rule, enforced by the index rather than
 * by a check the caller could race past.
 */
export async function insertMember(
  client: DbClient,
  input: { groupId: string; accountId: string; at: Date },
): Promise<void> {
  await client.query(
    `INSERT INTO group_members (group_id, account_id, joined_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (group_id, account_id)
     DO UPDATE SET joined_at = EXCLUDED.joined_at, left_at = NULL, removed_at = NULL, removed_by = NULL`,
    [input.groupId, input.accountId, input.at],
  );
}

/** Mirrors the group membership 1:1. Soft, so authorship history survives leaving. */
export async function joinGroupChannel(
  client: DbClient,
  input: { channelId: string; accountId: string },
): Promise<void> {
  await client.query(
    `INSERT INTO chat_channel_members (channel_id, account_id)
     VALUES ($1, $2)
     ON CONFLICT (channel_id, account_id) DO UPDATE SET left_at = NULL`,
    [input.channelId, input.accountId],
  );
}

/**
 * The departure, claimed conditionally so two tabs pressing Leave — or a leave racing a kick —
 * resolve to one departure rather than to two promotions.
 */
export async function leaveGroupMembership(
  client: DbClient,
  input: { groupId: string; accountId: string; at: Date; removedBy?: string },
): Promise<boolean> {
  const result = await client.query(
    `UPDATE group_members
     SET left_at = $3, removed_at = $4, removed_by = $5
     WHERE group_id = $1 AND account_id = $2 AND left_at IS NULL`,
    [input.groupId, input.accountId, input.at, input.removedBy ? input.at : null, input.removedBy ?? null],
  );
  if ((result.rowCount ?? 0) === 0) return false;

  await client.query(
    `UPDATE chat_channel_members SET left_at = $3
     WHERE channel_id = (SELECT channel_id FROM groups WHERE id = $1)
       AND account_id = $2
       AND left_at IS NULL`,
    [input.groupId, input.accountId, input.at],
  );
  return true;
}

/**
 * The longest-standing remaining member takes over, with `account_id` breaking the tie so two
 * people who joined in the same transaction still resolve to one deterministic leader. Null
 * means nobody is left, which is the only way a group ends.
 *
 * `onlyIfLeaderless` is what the account-deletion path reuses: the pick has to be the same
 * one a voluntary handoff makes, so both go through this statement rather than through two
 * copies of the rule that could drift apart.
 */
async function promote(
  db: Db | DbClient,
  groupId: string,
  onlyIfLeaderless: boolean,
): Promise<string | null> {
  const result = await db.query<{ leader_account_id: string }>(
    `UPDATE groups SET leader_account_id = next.account_id
     FROM (
       SELECT account_id FROM group_members
       WHERE group_id = $1 AND left_at IS NULL
       ORDER BY joined_at, account_id
       LIMIT 1
     ) next
     WHERE groups.id = $1 AND (NOT $2::boolean OR groups.leader_account_id IS NULL)
     RETURNING groups.leader_account_id`,
    [groupId, onlyIfLeaderless],
  );
  return result.rows[0]?.leader_account_id ?? null;
}

export function promoteLongestStanding(client: DbClient, groupId: string): Promise<string | null> {
  return promote(client, groupId, false);
}

/**
 * A leader's account disappearing sets `leader_account_id` to NULL rather than taking the
 * group with it, so a leaderless group is a state every read has to be able to resolve —
 * there is no "an account was just deleted" moment to hook the handoff onto. Swept here for
 * the same reason `expireStaleInvites` is swept on read: the paths that care about the fact
 * are the ones that fix it, and no timer has to own it.
 */
export async function healLeaderlessGroup(
  db: Db | DbClient,
  group: GroupRow | null,
): Promise<GroupRow | null> {
  if (!group || group.leader_account_id !== null || group.archived_at !== null) return group;
  const promoted = await promote(db, group.id, true);
  return promoted ? { ...group, leader_account_id: promoted } : group;
}

/* ------------------------------- cooldowns ------------------------------- */

/** When this group last removed this account. The 24h re-invite block reads it. */
export async function lastRemovedAt(db: Db | DbClient, groupId: string, accountId: string): Promise<Date | null> {
  const result = await db.query<{ removed_at: Date }>(
    `SELECT removed_at FROM group_members
     WHERE group_id = $1 AND account_id = $2 AND removed_at IS NOT NULL
     ORDER BY removed_at DESC
     LIMIT 1`,
    [groupId, accountId],
  );
  return result.rows[0]?.removed_at ?? null;
}

/* -------------------------------- invites -------------------------------- */

/**
 * Lazy expiry, because a 7-day TTL is not worth a timer that only one instance may own: the
 * sweep runs on the paths that care — reading someone's invites, and issuing a new one — so a
 * lapsed invitation can neither be accepted nor block a fresh one through the pending index.
 */
export async function expireStaleInvites(
  db: Db | DbClient,
  input: { at: Date; toAccountId?: string; groupId?: string },
): Promise<void> {
  await db.query(
    `UPDATE group_invites SET state = 'expired', resolved_at = $1
     WHERE state = 'pending'
       AND expires_at <= $1
       AND ($2::uuid IS NULL OR to_account_id = $2)
       AND ($3::uuid IS NULL OR group_id = $3)`,
    [input.at, input.toAccountId ?? null, input.groupId ?? null],
  );
}

export async function insertInvite(
  client: DbClient,
  input: {
    groupId: string;
    fromAccountId: string;
    toAccountId: string;
    createdAt: Date;
    expiresAt: Date;
  },
): Promise<GroupInviteRow> {
  const result = await client.query<GroupInviteRow>(
    `INSERT INTO group_invites (id, group_id, from_account_id, to_account_id, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [uuidv7(), input.groupId, input.fromAccountId, input.toAccountId, input.createdAt, input.expiresAt],
  );
  return result.rows[0]!;
}

export async function findInviteById(db: Db | DbClient, inviteId: string): Promise<GroupInviteRow | null> {
  const result = await db.query<GroupInviteRow>('SELECT * FROM group_invites WHERE id = $1', [inviteId]);
  return result.rows[0] ?? null;
}

/**
 * The single state transition, claimed conditionally: a double-tapped Accept, two tabs, and an
 * answer racing the deadline all resolve to one winner here rather than to two joins.
 */
export async function claimInviteResolution(
  client: DbClient,
  input: { inviteId: string; toAccountId: string; state: 'accepted' | 'declined'; at: Date },
): Promise<GroupInviteRow | null> {
  const result = await client.query<GroupInviteRow>(
    `UPDATE group_invites SET state = $3, resolved_at = $4
     WHERE id = $1 AND to_account_id = $2 AND state = 'pending' AND expires_at > $4
     RETURNING *`,
    [input.inviteId, input.toAccountId, input.state, input.at],
  );
  return result.rows[0] ?? null;
}

/** Everything else outstanding for someone who has just joined somewhere: no longer offerable. */
export async function cancelPendingInvitesFor(
  client: DbClient,
  input: { toAccountId: string; at: Date },
): Promise<void> {
  await client.query(
    `UPDATE group_invites SET state = 'cancelled', resolved_at = $2
     WHERE to_account_id = $1 AND state = 'pending'`,
    [input.toAccountId, input.at],
  );
}

/** The same, the other way round: everything still outstanding *into* a group that has ended. */
export async function cancelPendingInvitesToGroup(
  client: DbClient,
  input: { groupId: string; at: Date },
): Promise<void> {
  await client.query(
    `UPDATE group_invites SET state = 'cancelled', resolved_at = $2
     WHERE group_id = $1 AND state = 'pending'`,
    [input.groupId, input.at],
  );
}

export async function listPendingInvitesFor(
  db: Db | DbClient,
  accountId: string,
  now: Date,
): Promise<GroupInviteDto[]> {
  const result = await db.query<InviteListRow>(
    `SELECT i.*, g.name AS group_name, c.nickname AS from_nickname
     FROM group_invites i
     JOIN groups g ON g.id = i.group_id AND g.archived_at IS NULL
     LEFT JOIN characters c ON c.account_id = i.from_account_id AND c.deleted_at IS NULL
     WHERE i.to_account_id = $1 AND i.state = 'pending' AND i.expires_at > $2
     ORDER BY i.created_at DESC`,
    [accountId, now],
  );
  return result.rows.map(toInviteDto);
}

export async function hasPendingInvite(
  db: Db | DbClient,
  groupId: string,
  toAccountId: string,
): Promise<boolean> {
  const result = await db.query(
    "SELECT 1 FROM group_invites WHERE group_id = $1 AND to_account_id = $2 AND state = 'pending'",
    [groupId, toAccountId],
  );
  return (result.rowCount ?? 0) > 0;
}

/* ------------------------------- projection ------------------------------ */

/** The badge the Town Square renders beside a nickname, for a set of accounts at once. */
export async function groupNamesForAccounts(
  db: Db | DbClient,
  accountIds: string[],
): Promise<Map<string, string>> {
  if (accountIds.length === 0) return new Map();
  const result = await db.query<{ account_id: string; name: string }>(
    `SELECT m.account_id, g.name
     FROM group_members m
     JOIN groups g ON g.id = m.group_id AND g.archived_at IS NULL
     WHERE m.account_id = ANY($1::uuid[]) AND m.left_at IS NULL`,
    [accountIds],
  );
  return new Map(result.rows.map((row) => [row.account_id, row.name]));
}
