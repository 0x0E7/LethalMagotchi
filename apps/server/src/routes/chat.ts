import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  blockCreateSchema,
  dmChannelKey,
  dmCreateSchema,
  messageHistoryQuerySchema,
  type ChatChannelResponse,
  type ChatChannelsResponse,
  type ChatMessagesResponse,
} from '@lethalmagotchi/shared';
import type { ServerDeps } from '../deps.js';
import { ApiError } from '../errors.js';
import { findAccountById } from '../repos/accounts.js';
import { findActiveCharacterByAccount } from '../repos/characters.js';
import {
  deleteBlock,
  ensureDmChannel,
  findDmChannelByKey,
  findDmChannelDto,
  findTownSquare,
  insertBlock,
  isBlockedEitherWay,
  listDmChannelsForAccount,
  listMessages,
  toChannelDto,
  toMessageDto,
} from '../repos/chat.js';
import { parseOrThrow } from '../validate.js';

const channelParamsSchema = z.object({ id: z.string().uuid() });
const blockParamsSchema = z.object({ blockedAccountId: z.string().uuid() });

export async function registerChatRoutes(app: FastifyInstance, deps: ServerDeps): Promise<void> {
  const { db, limiters, chat } = deps;

  /** Chat is a place in the world, so standing in it requires a body to stand in it with. */
  const requireCharacter = async (accountId: string) => {
    const character = await findActiveCharacterByAccount(db, accountId);
    if (!character) throw new ApiError(404, 'NO_CHARACTER', 'You do not have a character yet.');
    return character;
  };

  app.get('/api/v1/chat/channels', { onRequest: app.authenticate }, async (request, reply) => {
    await requireCharacter(request.accountId);

    const townSquare = await findTownSquare(db);
    const dms = await listDmChannelsForAccount(db, request.accountId);
    const payload: ChatChannelsResponse = {
      // The Town Square keeps no member rows, so it has no stored read watermark and its
      // unread badge is a client-session concern rather than a server one.
      channels: [toChannelDto(townSquare), ...dms],
    };
    return reply.code(200).send(payload);
  });

  app.post('/api/v1/chat/dm', { onRequest: app.authenticate }, async (request, reply) => {
    const accountId = request.accountId;
    await requireCharacter(accountId);
    const { targetAccountId } = parseOrThrow(dmCreateSchema, request.body);

    if (targetAccountId === accountId) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'You cannot message yourself.', {
        fields: { targetAccountId: 'Pick another player.' },
      });
    }

    const target = await findActiveCharacterByAccount(db, targetAccountId);
    if (!target) throw new ApiError(404, 'NOT_FOUND', 'That player is not around.');

    if (await isBlockedEitherWay(db, accountId, targetAccountId)) {
      throw new ApiError(403, 'BLOCKED', 'You cannot message this player.');
    }

    /**
     * Checked before creating rather than after, so re-opening a conversation that already
     * exists is free: the limit is on starting conversations with new people, which is the
     * behaviour being defended against.
     */
    const existing = await findDmChannelByKey(db, dmChannelKey(accountId, targetAccountId));
    if (!existing) {
      const budget = limiters.chatDmCreate.check(accountId);
      if (!budget.allowed) {
        throw new ApiError(429, 'RATE_LIMITED', 'Too many new conversations. Try again later.', {
          retryAfterSeconds: budget.retryAfterSeconds,
        });
      }
    }

    const { channel, created } = await ensureDmChannel(db, accountId, targetAccountId);
    const mine = await findDmChannelDto(db, channel.id, accountId);
    if (!mine) throw new ApiError(500, 'INTERNAL_ERROR', 'Could not open that conversation.');

    if (created) {
      // Each side is told about the channel as *they* see it — the label a DM carries is
      // the other participant, so the two views are not the same object.
      const theirs = await findDmChannelDto(db, channel.id, targetAccountId);
      const views = new Map([[accountId, mine]]);
      if (theirs) views.set(targetAccountId, theirs);
      chat.announceChannel([...views.keys()], (viewer) => views.get(viewer)!);
    }

    const payload: ChatChannelResponse = { channel: mine };
    return reply.code(created ? 201 : 200).send(payload);
  });

  app.get('/api/v1/chat/channels/:id/messages', { onRequest: app.authenticate }, async (request, reply) => {
    await requireCharacter(request.accountId);
    const { id } = parseOrThrow(channelParamsSchema, request.params);
    const { before, limit } = parseOrThrow(messageHistoryQuerySchema, request.query);

    const channel = await chat.assertAccess(id, request.accountId);
    if (!channel) throw new ApiError(404, 'NOT_FOUND', 'No such conversation.');

    const page = await listMessages(db, {
      channelId: channel.id,
      viewerAccountId: request.accountId,
      before,
      limit,
    });
    const payload: ChatMessagesResponse = {
      // Oldest first, so the client can append a page to the top of the log as-is.
      messages: page.messages.map(toMessageDto).reverse(),
      hasMore: page.hasMore,
    };
    return reply.code(200).send(payload);
  });

  app.post('/api/v1/blocks', { onRequest: app.authenticate }, async (request, reply) => {
    const { blockedAccountId } = parseOrThrow(blockCreateSchema, request.body);
    if (blockedAccountId === request.accountId) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'You cannot block yourself.', {
        fields: { blockedAccountId: 'Pick another player.' },
      });
    }
    if (!(await findAccountById(db, blockedAccountId))) {
      throw new ApiError(404, 'NOT_FOUND', 'That player is not around.');
    }
    await insertBlock(db, request.accountId, blockedAccountId);
    return reply.code(204).send();
  });

  app.delete('/api/v1/blocks/:blockedAccountId', { onRequest: app.authenticate }, async (request, reply) => {
    const { blockedAccountId } = parseOrThrow(blockParamsSchema, request.params);
    await deleteBlock(db, request.accountId, blockedAccountId);
    return reply.code(204).send();
  });
}
