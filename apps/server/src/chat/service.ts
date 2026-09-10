import {
  MAX_SUBSCRIBED_CHANNELS,
  MESSAGE_MAX,
  TOWN_SQUARE_CHANNEL_ID,
  sanitizeMessageBody,
  type ChatChannelDto,
  type ChatRejectCode,
  type ServerMessage,
} from '@lethalmagotchi/shared';
import type { Db } from '../db/pool.js';
import type { Limiters } from '../deps.js';
import {
  findChannelById,
  findCounterpartAccountId,
  insertMessage,
  isBlockedEitherWay,
  isChannelMember,
  listActiveMemberAccountIds,
  listBlockersOf,
  setLastRead,
  toMessageDto,
  unreadCountFor,
  type ChannelRow,
  type MessageRow,
} from '../repos/chat.js';
import type { Connection, Hub } from '../ws/hub.js';
import { DuplicateGuard } from './duplicate-guard.js';
import { screenMessage, type Classifier } from './moderation.js';

export interface ChatSendInput {
  clientMsgId: string;
  channelId: string;
  body: string;
}

export interface ChatServiceOptions {
  db: Db;
  hub: Hub;
  limiters: Limiters;
  classify?: Classifier;
  duplicates?: DuplicateGuard;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export class ChatService {
  private readonly db: Db;
  private readonly hub: Hub;
  private readonly limiters: Limiters;
  private readonly duplicates: DuplicateGuard;
  private readonly classify: Classifier | undefined;
  private readonly log: (message: string, meta?: Record<string, unknown>) => void;

  /**
   * What each socket wants delivered live. It narrows fan-out, it never widens it: a socket
   * is only ever handed a channel it is already a member of, so a forged subscribe buys
   * nothing. The Town Square is implicit and is not stored here.
   */
  private readonly subscriptions = new Map<string, Set<string>>();

  constructor(options: ChatServiceOptions) {
    this.db = options.db;
    this.hub = options.hub;
    this.limiters = options.limiters;
    this.duplicates = options.duplicates ?? new DuplicateGuard();
    this.classify = options.classify;
    this.log = options.log ?? (() => {});
  }

  /* --------------------------- socket lifecycle --------------------------- */

  onDisconnect(connectionId: string): void {
    this.subscriptions.delete(connectionId);
  }

  private subscribe(connectionId: string, channelId: string): void {
    if (channelId === TOWN_SQUARE_CHANNEL_ID) return;
    const set = this.subscriptions.get(connectionId) ?? new Set<string>();
    if (set.size >= MAX_SUBSCRIBED_CHANNELS && !set.has(channelId)) return;
    set.add(channelId);
    this.subscriptions.set(connectionId, set);
  }

  private isSubscribed(connectionId: string, channelId: string): boolean {
    if (channelId === TOWN_SQUARE_CHANNEL_ID) return true;
    return this.subscriptions.get(connectionId)?.has(channelId) ?? false;
  }

  /* ------------------------------- access -------------------------------- */

  /** The one predicate every read and every write goes through. */
  private async canAccess(channel: ChannelRow, accountId: string): Promise<boolean> {
    if (channel.kind === 'global') return true;
    return isChannelMember(this.db, channel.id, accountId);
  }

  async assertAccess(channelId: string, accountId: string): Promise<ChannelRow | null> {
    const channel = await findChannelById(this.db, channelId);
    if (!channel) return null;
    return (await this.canAccess(channel, accountId)) ? channel : null;
  }

  /* -------------------------------- send --------------------------------- */

  async handleSend(connection: Connection, input: ChatSendInput): Promise<void> {
    const { accountId, characterId } = connection;

    /**
     * Ahead of every content check, mirroring the socket's own budget: an attempt costs its
     * budget whether or not the body turns out to be sendable, so a flood of empty or
     * oversized frames cannot spend nothing and leave the real allowance intact.
     *
     * Both buckets are charged, never short-circuited: a burst that squeaks under the
     * 10-second limit must still count against the minute.
     */
    const burst = this.limiters.chatBurst.check(accountId);
    const sustained = this.limiters.chatSustained.check(accountId);
    if (!burst.allowed || !sustained.allowed) {
      const retryAfterSeconds = Math.max(
        burst.allowed ? 0 : burst.retryAfterSeconds,
        sustained.allowed ? 0 : sustained.retryAfterSeconds,
      );
      this.reject(connection, input.clientMsgId, 'RATE_LIMITED', retryAfterSeconds * 1000);
      return;
    }

    if (!characterId) {
      this.reject(connection, input.clientMsgId, 'NOT_MEMBER');
      return;
    }

    const body = sanitizeMessageBody(input.body);
    if (body.length === 0) {
      this.reject(connection, input.clientMsgId, 'EMPTY');
      return;
    }
    if (body.length > MESSAGE_MAX) {
      this.reject(connection, input.clientMsgId, 'TOO_LONG');
      return;
    }

    const channel = await findChannelById(this.db, input.channelId);
    if (!channel || !(await this.canAccess(channel, accountId))) {
      this.reject(connection, input.clientMsgId, 'NOT_MEMBER');
      return;
    }
    if (channel.archived_at) {
      this.reject(connection, input.clientMsgId, 'ARCHIVED');
      return;
    }

    if (channel.kind === 'dm') {
      const counterpart = await findCounterpartAccountId(this.db, channel.id, accountId);
      if (counterpart && (await isBlockedEitherWay(this.db, accountId, counterpart))) {
        this.reject(connection, input.clientMsgId, 'BLOCKED_BY_RECIPIENT');
        return;
      }
    }

    if (this.duplicates.isRepeat(accountId, channel.id, body)) {
      this.reject(connection, input.clientMsgId, 'DUPLICATE');
      return;
    }

    const disposition = await screenMessage(body, {
      ...(this.classify ? { classify: this.classify } : {}),
      onFailure: (error) => this.log('chat moderation failed open', { error }),
    });
    if (disposition === 'blocked') {
      this.reject(connection, input.clientMsgId, 'BLOCKED_CONTENT');
      return;
    }

    const row = await insertMessage(this.db, {
      channelId: channel.id,
      accountId,
      characterId,
      body,
      moderation: disposition,
    });
    if (!row) {
      // The character was deleted between the socket binding it and this insert.
      this.reject(connection, input.clientMsgId, 'NOT_MEMBER');
      return;
    }

    this.subscribe(connection.id, channel.id);
    connection.socket.send(
      JSON.stringify({ type: 'chat:ack', clientMsgId: input.clientMsgId, messageId: row.id } satisfies ServerMessage),
    );

    const message: ServerMessage = { type: 'chat:message', channelId: channel.id, message: toMessageDto(row) };
    if (channel.kind === 'global') await this.fanOutGlobal(message, accountId);
    else await this.fanOutDirect(channel.id, message, accountId);
  }

  /**
   * A system message reaches every connected player with no exclusions: it has no author
   * account, so there is nobody to have blocked. Callers hand over a row they have already
   * committed, never a body to write.
   */
  broadcastSystemMessage(channelId: string, row: MessageRow): void {
    const payload = JSON.stringify({
      type: 'chat:message',
      channelId,
      message: toMessageDto(row),
    } satisfies ServerMessage);
    for (const connection of this.hub.playerConnections()) connection.socket.send(payload);
  }

  /**
   * Recipients are every player currently connected, minus whoever has blocked the author.
   * There is no client-supplied list anywhere in this path.
   */
  private async fanOutGlobal(message: ServerMessage, authorAccountId: string): Promise<void> {
    const blockers = new Set(await listBlockersOf(this.db, authorAccountId));
    const payload = JSON.stringify(message);
    for (const connection of this.hub.playerConnections(blockers)) {
      connection.socket.send(payload);
    }
  }

  /** Recipients are the channel's own member rows, read fresh from the database. */
  private async fanOutDirect(
    channelId: string,
    message: ServerMessage,
    authorAccountId: string,
  ): Promise<void> {
    const members = await listActiveMemberAccountIds(this.db, channelId);
    const payload = JSON.stringify(message);
    for (const connection of this.hub.connectionsForAccounts(members)) {
      if (!this.isSubscribed(connection.id, channelId)) continue;
      connection.socket.send(payload);
    }

    for (const member of members) {
      if (member === authorAccountId) continue;
      const unreadCount = await unreadCountFor(this.db, channelId, member);
      this.hub.sendToAccounts([member], { type: 'chat:unread', channelId, unreadCount });
    }
  }

  /* ------------------------- subscribe / read ---------------------------- */

  async handleSubscribe(connection: Connection, channelIds: string[]): Promise<void> {
    if (channelIds.length === 0) return;
    const result = await this.db.query<{ channel_id: string }>(
      `SELECT channel_id FROM chat_channel_members
       WHERE account_id = $1 AND left_at IS NULL AND channel_id = ANY($2::uuid[])`,
      [connection.accountId, channelIds],
    );
    // Ids the caller is not a member of are dropped in silence: answering them would turn
    // a subscribe frame into a membership oracle.
    for (const row of result.rows) this.subscribe(connection.id, row.channel_id);
  }

  handleUnsubscribe(connection: Connection, channelIds: string[]): void {
    const set = this.subscriptions.get(connection.id);
    if (!set) return;
    for (const channelId of channelIds) set.delete(channelId);
  }

  async handleRead(connection: Connection, channelId: string, lastReadMessageId: string): Promise<void> {
    const channel = await this.assertAccess(channelId, connection.accountId);
    // The Town Square keeps no member rows, so it has no server-side read watermark.
    if (!channel || channel.kind === 'global') return;

    await setLastRead(this.db, channelId, connection.accountId, lastReadMessageId);
    const unreadCount = await unreadCountFor(this.db, channelId, connection.accountId);
    this.hub.sendToAccounts([connection.accountId], { type: 'chat:unread', channelId, unreadCount });
  }

  /* ------------------------------ channels ------------------------------- */

  /**
   * A new DM has to reach both participants without either of them having asked for a
   * channel they could not have known existed, so their live sockets are subscribed here
   * rather than waiting for a `chat:subscribe` round trip.
   */
  announceChannel(accountIds: string[], channelFor: (accountId: string) => ChatChannelDto): void {
    for (const accountId of accountIds) {
      const channel = channelFor(accountId);
      for (const connection of this.hub.connectionsForAccounts([accountId])) {
        this.subscribe(connection.id, channel.id);
        connection.socket.send(JSON.stringify({ type: 'chat:channel', channel } satisfies ServerMessage));
      }
    }
  }

  private reject(
    connection: Connection,
    clientMsgId: string,
    code: ChatRejectCode,
    retryAfterMs?: number,
  ): void {
    const message: ServerMessage = {
      type: 'chat:rejected',
      clientMsgId,
      code,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
    connection.socket.send(JSON.stringify(message));
  }
}
