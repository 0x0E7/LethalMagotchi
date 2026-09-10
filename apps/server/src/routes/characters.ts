import type { FastifyInstance } from 'fastify';
import {
  type MeResponse,
  characterCreateSchema,
  characterPatchSchema,
  containsBlockedTerm,
} from '@lethalmagotchi/shared';
import type { ServerDeps } from '../deps.js';
import { ApiError } from '../errors.js';
import { isUniqueViolation, withTransaction } from '../db/pool.js';
import { findAccountById, toAccountDto } from '../repos/accounts.js';
import { leaveChatForAccount, rejoinChatForAccount } from '../repos/chat.js';
import {
  findActiveCharacterByAccount,
  insertCharacter,
  lockActiveCharacterByAccount,
  softDeleteCharacter,
  toCharacterDto,
  updateCharacter,
} from '../repos/characters.js';
import { parseOrThrow } from '../validate.js';
import { rebindAccountCharacter } from '../ws/rebind.js';

function assertModerated(fields: { nickname?: string; bio?: string; originCity?: string | null }): void {
  const rejected: Record<string, string> = {};
  if (fields.nickname && containsBlockedTerm(fields.nickname)) {
    rejected.nickname = 'That nickname is not allowed.';
  }
  if (fields.bio && containsBlockedTerm(fields.bio)) {
    rejected.bio = 'That bio is not allowed.';
  }
  if (fields.originCity && containsBlockedTerm(fields.originCity)) {
    rejected.originCity = 'That city is not allowed.';
  }
  if (Object.keys(rejected).length > 0) {
    throw new ApiError(422, 'BIO_REJECTED', 'Some text was rejected by moderation.', { fields: rejected });
  }
}

export async function registerCharacterRoutes(app: FastifyInstance, deps: ServerDeps): Promise<void> {
  const { db, limiters, hub, tournaments, duels } = deps;

  app.get('/api/v1/me', { onRequest: app.authenticate }, async (request, reply) => {
    const accountId = request.accountId;
    const account = await findAccountById(db, accountId);
    if (!account) throw new ApiError(401, 'UNAUTHORIZED', 'Account no longer exists.');
    const character = await findActiveCharacterByAccount(db, accountId);
    const payload: MeResponse = {
      account: toAccountDto(account),
      character: character ? toCharacterDto(character) : null,
    };
    return reply.code(200).send(payload);
  });

  app.post('/api/v1/characters', { onRequest: app.authenticate }, async (request, reply) => {
    const accountId = request.accountId;
    const input = parseOrThrow(characterCreateSchema, request.body);
    assertModerated(input);

    const churn = limiters.characterChurn.check(accountId);
    if (!churn.allowed) {
      throw new ApiError(429, 'CREATE_LIMIT_REACHED', 'Too many characters created today.', {
        retryAfterSeconds: churn.retryAfterSeconds,
      });
    }

    try {
      const created = await insertCharacter(db, accountId, input);
      // Back in the world: any DM this account left by deleting a previous character opens
      // again, so a rebuild does not silently orphan conversations the other side still has.
      await rejoinChatForAccount(db, accountId);
      rebindAccountCharacter({ hub, tournaments, duels }, accountId, created.id);
      return reply.code(201).send({ character: toCharacterDto(created) });
    } catch (error) {
      if (isUniqueViolation(error, 'ux_character_account')) {
        throw new ApiError(409, 'CHARACTER_EXISTS', 'You already have a character.');
      }
      throw error;
    }
  });

  app.patch('/api/v1/characters/me', { onRequest: app.authenticate }, async (request, reply) => {
    const patch = parseOrThrow(characterPatchSchema, request.body);
    assertModerated(patch);

    const updated = await updateCharacter(db, request.accountId, patch);
    if (!updated) throw new ApiError(404, 'NO_CHARACTER', 'You do not have a character yet.');
    return reply.code(200).send({ character: toCharacterDto(updated) });
  });

  app.delete('/api/v1/characters/me', { onRequest: app.authenticate }, async (request, reply) => {
    /**
     * The check and the delete are one transaction under the same row lock the duel accept
     * path takes. Read-then-write here would let a losing duelist race a self-delete against
     * the accept that commits them, dodging the loss and denying the winner their stake.
     */
    const deleted = await withTransaction(db, async (client) => {
      const existing = await lockActiveCharacterByAccount(client, request.accountId);
      if (!existing) return false;
      // Deleting out from under a live duel would leave the settlement with nobody to pay or
      // to kill. It lasts seconds; waiting it out is the whole cost.
      if (existing.active_duel_id) {
        throw new ApiError(409, 'CHARACTER_IN_DUEL', 'You are in a duel right now.');
      }
      return softDeleteCharacter(client, request.accountId);
    });
    if (!deleted) throw new ApiError(404, 'NO_CHARACTER', 'You do not have a character yet.');
    // Messages are never removed with the author. The membership goes soft-left instead, and
    // any DM that is now down to one live participant becomes read-only for whoever is left.
    await leaveChatForAccount(db, request.accountId);
    rebindAccountCharacter({ hub, tournaments, duels }, request.accountId, null);
    return reply.code(204).send();
  });
}
