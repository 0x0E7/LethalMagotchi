import {
  TOWN_SQUARE_CHANNEL_ID,
  dmChannelKey,
  type ChannelKind,
  type ChatChannelDto,
  type ChatMessageDto,
  type MessageModeration,
} from '@lethalmagotchi/shared';
import { withTransaction, type Db, type DbClient } from '../db/pool.js';
import { uuidv7 } from '../uuid.js';

export interface ChannelRow {
  id: string;
  kind: ChannelKind;
  key: string | null;
  name: string | null;
  created_at: Date;
  created_by: string | null;
  archived_at: Date | null;
}

export interface MessageRow {
  id: string;
  channel_id: string;
  author_account_id: string | null;
  author_character_id: string | null;
  author_name_snapshot: string;
  body: string;
  created_at: Date;
  deleted_at: Date | null;
  moderation: MessageModeration;
}

interface ChannelListRow extends ChannelRow {
  counterpart_account_id: string | null;
  counterpart_character_id: string | null;
  counterpart_nickname: string | null;
  last_message_at: Date | null;
  unread_count: number;
  blocked_by_me: boolean;
}

export interface ChannelExtras {
  counterpartAccountId?: string | null;
  counterpartCharacterId?: string | null;
  counterpartNickname?: string | null;
  blockedByMe?: boolean;
  unreadCount?: number;
  lastMessageAt?: Date | null;
}

export function toChannelDto(row: ChannelRow, extras: ChannelExtras = {}): ChatChannelDto {
  const counterpartAccountId = extras.counterpartAccountId ?? null;
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    createdAt: row.created_at.toISOString(),
    archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
    counterpart: counterpartAccountId
      ? {
          accountId: counterpartAccountId,
          characterId: extras.counterpartCharacterId ?? null,
          nickname: extras.counterpartNickname ?? '',
        }
      : null,
    blockedByMe: extras.blockedByMe ?? false,
    unreadCount: extras.unreadCount ?? 0,
    lastMessageAt: extras.lastMessageAt ? extras.lastMessageAt.toISOString() : null,
  };
}

export function toMessageDto(row: MessageRow): ChatMessageDto {
  return {
    id: row.id,
    channelId: row.channel_id,
    authorAccountId: row.author_account_id,
    authorCharacterId: row.author_character_id,
    authorName: row.author_name_snapshot,
    body: row.body,
    createdAt: row.created_at.toISOString(),
    moderation: row.moderation,
  };
}

/* ------------------------------- channels ------------------------------- */

export async function findChannelById(db: Db, channelId: string): Promise<ChannelRow | null> {
  const result = await db.query<ChannelRow>('SELECT * FROM chat_channels WHERE id = $1', [channelId]);
  return result.rows[0] ?? null;
}

export async function findTownSquare(db: Db): Promise<ChannelRow> {
  const result = await db.query<ChannelRow>('SELECT * FROM chat_channels WHERE id = $1', [
    TOWN_SQUARE_CHANNEL_ID,
  ]);
  const row = result.rows[0];
  // Created by migration 0005 and never deleted; missing means the schema is not applied.
  if (!row) throw new Error('Town Square channel is missing');
  return row;
}

export async function findDmChannelByKey(db: Db, key: string): Promise<ChannelRow | null> {
  const result = await db.query<ChannelRow>('SELECT * FROM chat_channels WHERE key = $1', [key]);
  return result.rows[0] ?? null;
}

/**
 * Idempotent by the sorted key rather than by a read-then-write: two callers racing to open
 * the same DM both end up on the one row the unique index allows to exist.
 */
export async function ensureDmChannel(
  db: Db,
  creatorAccountId: string,
  otherAccountId: string,
): Promise<{ channel: ChannelRow; created: boolean }> {
  const key = dmChannelKey(creatorAccountId, otherAccountId);
  return withTransaction(db, async (client) => {
    const inserted = await client.query<ChannelRow>(
      `INSERT INTO chat_channels (id, kind, key, name, created_by)
       VALUES ($1, 'dm', $2, NULL, $3)
       ON CONFLICT (key) WHERE key IS NOT NULL DO NOTHING
       RETURNING *`,
      [uuidv7(), key, creatorAccountId],
    );

    const existing =
      inserted.rows[0] ??
      (await client.query<ChannelRow>('SELECT * FROM chat_channels WHERE key = $1', [key])).rows[0];
    if (!existing) throw new Error(`dm channel ${key} vanished during creation`);

    await client.query(
      `INSERT INTO chat_channel_members (channel_id, account_id)
       VALUES ($1, $2), ($1, $3)
       ON CONFLICT (channel_id, account_id) DO NOTHING`,
      [existing.id, creatorAccountId, otherAccountId],
    );

    return { channel: existing, created: inserted.rows.length > 0 };
  });
}

export async function isChannelMember(db: Db, channelId: string, accountId: string): Promise<boolean> {
  const result = await db.query(
    'SELECT 1 FROM chat_channel_members WHERE channel_id = $1 AND account_id = $2 AND left_at IS NULL',
    [channelId, accountId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Every account the fan-out for `channelId` may reach. The only source of recipients. */
export async function listActiveMemberAccountIds(db: Db, channelId: string): Promise<string[]> {
  const result = await db.query<{ account_id: string }>(
    'SELECT account_id FROM chat_channel_members WHERE channel_id = $1 AND left_at IS NULL',
    [channelId],
  );
  return result.rows.map((row) => row.account_id);
}

export async function findCounterpartAccountId(
  db: Db,
  channelId: string,
  accountId: string,
): Promise<string | null> {
  const result = await db.query<{ account_id: string }>(
    'SELECT account_id FROM chat_channel_members WHERE channel_id = $1 AND account_id <> $2 LIMIT 1',
    [channelId, accountId],
  );
  return result.rows[0]?.account_id ?? null;
}

const CHANNEL_LIST_SQL = `
  SELECT
    c.*,
    other.account_id AS counterpart_account_id,
    ch.id AS counterpart_character_id,
    ch.nickname AS counterpart_nickname,
    last.created_at AS last_message_at,
    COALESCE(unread.count, 0) AS unread_count,
    (block.blocker_account_id IS NOT NULL) AS blocked_by_me
  FROM chat_channels c
  JOIN chat_channel_members me
    ON me.channel_id = c.id AND me.account_id = $1 AND me.left_at IS NULL
  LEFT JOIN LATERAL (
    SELECT m.account_id FROM chat_channel_members m
    WHERE m.channel_id = c.id AND m.account_id <> $1
    LIMIT 1
  ) other ON true
  LEFT JOIN characters ch ON ch.account_id = other.account_id AND ch.deleted_at IS NULL
  LEFT JOIN chat_blocks block
    ON block.blocker_account_id = $1 AND block.blocked_account_id = other.account_id
  LEFT JOIN LATERAL (
    SELECT m.created_at FROM chat_messages m
    WHERE m.channel_id = c.id AND m.deleted_at IS NULL
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 1
  ) last ON true
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS count FROM chat_messages m
    WHERE m.channel_id = c.id
      AND m.deleted_at IS NULL
      AND m.author_account_id IS DISTINCT FROM $1
      AND (
        me.last_read_message_id IS NULL
        OR (m.created_at, m.id) > (
          SELECT r.created_at, r.id FROM chat_messages r WHERE r.id = me.last_read_message_id
        )
      )
  ) unread ON true
  WHERE c.kind = 'dm' AND ($2::uuid IS NULL OR c.id = $2)
  ORDER BY last.created_at DESC NULLS LAST, c.created_at DESC
`;

function listRowToDto(row: ChannelListRow): ChatChannelDto {
  return toChannelDto(row, {
    counterpartAccountId: row.counterpart_account_id,
    counterpartCharacterId: row.counterpart_character_id,
    counterpartNickname: row.counterpart_nickname,
    blockedByMe: row.blocked_by_me,
    unreadCount: row.unread_count,
    lastMessageAt: row.last_message_at,
  });
}

export async function listDmChannelsForAccount(db: Db, accountId: string): Promise<ChatChannelDto[]> {
  const result = await db.query<ChannelListRow>(CHANNEL_LIST_SQL, [accountId, null]);
  return result.rows.map(listRowToDto);
}

/** The same projection as the list, for one channel, as one member sees it. */
export async function findDmChannelDto(
  db: Db,
  channelId: string,
  accountId: string,
): Promise<ChatChannelDto | null> {
  const result = await db.query<ChannelListRow>(CHANNEL_LIST_SQL, [accountId, channelId]);
  const row = result.rows[0];
  return row ? listRowToDto(row) : null;
}

/** Set when a DM loses a participant, and cleared if they come back. Read-only while set. */
export async function leaveChatForAccount(db: Db, accountId: string): Promise<void> {
  await db.query(
    'UPDATE chat_channel_members SET left_at = now() WHERE account_id = $1 AND left_at IS NULL',
    [accountId],
  );
  await db.query(
    `UPDATE chat_channels c SET archived_at = now()
     WHERE c.archived_at IS NULL
       AND c.kind = 'dm'
       AND c.id IN (SELECT channel_id FROM chat_channel_members WHERE account_id = $1)
       AND (SELECT count(*) FROM chat_channel_members m WHERE m.channel_id = c.id AND m.left_at IS NULL) < 2`,
    [accountId],
  );
}

export async function rejoinChatForAccount(db: Db, accountId: string): Promise<void> {
  await db.query(
    'UPDATE chat_channel_members SET left_at = NULL WHERE account_id = $1 AND left_at IS NOT NULL',
    [accountId],
  );
  await db.query(
    `UPDATE chat_channels c SET archived_at = NULL
     WHERE c.archived_at IS NOT NULL
       AND c.kind = 'dm'
       AND c.id IN (SELECT channel_id FROM chat_channel_members WHERE account_id = $1)
       AND (SELECT count(*) FROM chat_channel_members m WHERE m.channel_id = c.id AND m.left_at IS NULL) >= 2`,
    [accountId],
  );
}

/* ------------------------------- messages ------------------------------- */

/**
 * Author identity is read out of the character row inside the insert itself, so there is no
 * window in which a caller could pass a name or an account that is not the socket's own.
 */
export async function insertMessage(
  db: Db | DbClient,
  input: {
    channelId: string;
    accountId: string;
    characterId: string;
    body: string;
    moderation: MessageModeration;
  },
): Promise<MessageRow | null> {
  const result = await db.query<MessageRow>(
    `INSERT INTO chat_messages (
       id, channel_id, author_account_id, author_character_id, author_name_snapshot, body, moderation
     )
     SELECT $1, $2, ch.account_id, ch.id, ch.nickname, $5, $6
     FROM characters ch
     WHERE ch.id = $3 AND ch.account_id = $4 AND ch.deleted_at IS NULL
     RETURNING *`,
    [uuidv7(), input.channelId, input.characterId, input.accountId, input.body, input.moderation],
  );
  return result.rows[0] ?? null;
}

export async function listMessages(
  db: Db,
  input: { channelId: string; viewerAccountId: string; before?: string | undefined; limit: number },
): Promise<{ messages: MessageRow[]; hasMore: boolean }> {
  const result = await db.query<MessageRow>(
    `SELECT m.* FROM chat_messages m
     WHERE m.channel_id = $1
       AND m.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM chat_blocks b
         WHERE b.blocker_account_id = $2 AND b.blocked_account_id = m.author_account_id
       )
       AND (
         $3::uuid IS NULL
         OR (m.created_at, m.id) < (
           -- Scoped to this channel on purpose: an id from a conversation the caller cannot
           -- read must behave exactly like an id that does not exist, or the cursor answers
           -- "does this message exist, and roughly when" for channels it has no business in.
           SELECT c.created_at, c.id FROM chat_messages c WHERE c.id = $3 AND c.channel_id = $1
         )
       )
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT $4`,
    [input.channelId, input.viewerAccountId, input.before ?? null, input.limit + 1],
  );
  const hasMore = result.rows.length > input.limit;
  return { messages: result.rows.slice(0, input.limit), hasMore };
}

/** Only ever moves forward: an out-of-order ack must not un-read what was already read. */
export async function setLastRead(
  db: Db,
  channelId: string,
  accountId: string,
  messageId: string,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE chat_channel_members me
     SET last_read_message_id = $3
     WHERE me.channel_id = $1
       AND me.account_id = $2
       AND EXISTS (SELECT 1 FROM chat_messages m WHERE m.id = $3 AND m.channel_id = $1)
       AND (
         me.last_read_message_id IS NULL
         OR EXISTS (
           SELECT 1 FROM chat_messages n
           JOIN chat_messages o ON o.id = me.last_read_message_id
           WHERE n.id = $3 AND (n.created_at, n.id) > (o.created_at, o.id)
         )
       )`,
    [channelId, accountId, messageId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function unreadCountFor(db: Db, channelId: string, accountId: string): Promise<number> {
  const result = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM chat_messages m
     JOIN chat_channel_members me ON me.channel_id = m.channel_id AND me.account_id = $2
     WHERE m.channel_id = $1
       AND m.deleted_at IS NULL
       AND m.author_account_id IS DISTINCT FROM $2
       AND (
         me.last_read_message_id IS NULL
         OR (m.created_at, m.id) > (
           SELECT r.created_at, r.id FROM chat_messages r WHERE r.id = me.last_read_message_id
         )
       )`,
    [channelId, accountId],
  );
  return result.rows[0]?.count ?? 0;
}

export async function purgeGlobalMessagesBefore(db: Db | DbClient, before: Date): Promise<number> {
  const result = await db.query('DELETE FROM chat_messages WHERE channel_id = $1 AND created_at < $2', [
    TOWN_SQUARE_CHANNEL_ID,
    before,
  ]);
  return result.rowCount ?? 0;
}

/* -------------------------------- blocks -------------------------------- */

export async function isBlockedEitherWay(db: Db, accountA: string, accountB: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM chat_blocks
     WHERE (blocker_account_id = $1 AND blocked_account_id = $2)
        OR (blocker_account_id = $2 AND blocked_account_id = $1)
     LIMIT 1`,
    [accountA, accountB],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Accounts that have blocked `authorAccountId` — subtracted from Town Square fan-out. */
export async function listBlockersOf(db: Db, authorAccountId: string): Promise<string[]> {
  const result = await db.query<{ blocker_account_id: string }>(
    'SELECT blocker_account_id FROM chat_blocks WHERE blocked_account_id = $1',
    [authorAccountId],
  );
  return result.rows.map((row) => row.blocker_account_id);
}

export async function insertBlock(db: Db, blockerAccountId: string, blockedAccountId: string): Promise<void> {
  await db.query(
    `INSERT INTO chat_blocks (blocker_account_id, blocked_account_id)
     VALUES ($1, $2)
     ON CONFLICT (blocker_account_id, blocked_account_id) DO NOTHING`,
    [blockerAccountId, blockedAccountId],
  );
}

export async function deleteBlock(db: Db, blockerAccountId: string, blockedAccountId: string): Promise<void> {
  await db.query(
    'DELETE FROM chat_blocks WHERE blocker_account_id = $1 AND blocked_account_id = $2',
    [blockerAccountId, blockedAccountId],
  );
}
