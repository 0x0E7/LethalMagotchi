import type { FastifyInstance } from 'fastify';
import {
  actionParamsSchema,
  actionRequestSchema,
  resolveAction,
  type ActionFailure,
  type ActionResponse,
} from '@lethalmagotchi/shared';
import type { ServerDeps } from '../deps.js';
import { ApiError } from '../errors.js';
import { withTransaction } from '../db/pool.js';
import {
  commitCharacterState,
  lockActiveCharacterByAccount,
  simulatedStats,
  toCharacterDto,
} from '../repos/characters.js';
import { parseOrThrow } from '../validate.js';

function toApiError(failure: ActionFailure): ApiError {
  switch (failure.reason) {
    case 'INVALID_ITEM':
      return new ApiError(422, 'VALIDATION_FAILED', 'That item does not belong to this action.', {
        fields: { itemId: 'Pick an item from this action.' },
      });
    case 'ON_COOLDOWN':
      return new ApiError(
        429,
        'ACTION_ON_COOLDOWN',
        failure.kind === 'rolling' ? 'Already done today.' : 'Give them a moment.',
        { retryAfterSeconds: failure.retryAfterSeconds },
      );
    case 'INSUFFICIENT_FUNDS':
      return new ApiError(
        402,
        'INSUFFICIENT_FUNDS',
        `That costs ${failure.cost} LethalCoins — ${failure.missingCoins} more needed.`,
      );
  }
}

export async function registerActionRoutes(app: FastifyInstance, deps: ServerDeps): Promise<void> {
  const { db, limiters } = deps;

  app.post('/api/v1/characters/me/actions/:action', { onRequest: app.authenticate }, async (request, reply) => {
    const { action } = parseOrThrow(actionParamsSchema, request.params);
    const { itemId } = parseOrThrow(actionRequestSchema, request.body);

    const flood = limiters.actions.check(request.accountId);
    if (!flood.allowed) {
      throw new ApiError(429, 'RATE_LIMITED', 'Slow down a moment.', {
        retryAfterSeconds: flood.retryAfterSeconds,
      });
    }

    const payload = await withTransaction(db, async (client) => {
      const row = await lockActiveCharacterByAccount(client, request.accountId);
      if (!row) throw new ApiError(404, 'NO_CHARACTER', 'You do not have a character yet.');

      const now = Date.now();
      const outcome = resolveAction(
        {
          stats: simulatedStats(row, now),
          lethalCoins: row.lethal_coins,
          actionCooldowns: row.action_cooldowns,
        },
        { action, itemId },
        now,
      );
      if (!outcome.ok) throw toApiError(outcome);

      const updated = await commitCharacterState(client, row.id, {
        stats: outcome.stats,
        lethalCoins: outcome.lethalCoins,
        actionCooldowns: outcome.actionCooldowns,
        simulatedAt: new Date(now),
      });

      const body: ActionResponse = {
        character: toCharacterDto(updated, now),
        result: {
          action: outcome.action,
          itemId: outcome.itemId,
          clipId: outcome.clipId,
          deltas: outcome.deltas,
          coinsSpent: outcome.coinsSpent,
          cooldownEndsAt: outcome.cooldownEndsAt,
        },
      };
      return body;
    });

    return reply.code(200).send(payload);
  });
}
