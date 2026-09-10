import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { type DuelCardsResponse } from '@lethalmagotchi/shared';
import type { ServerDeps } from '../deps.js';
import { ApiError } from '../errors.js';
import { findActiveCharacterByAccount, toDuelCardDto, type CharacterRow } from '../repos/characters.js';
import { parseOrThrow } from '../validate.js';

/** Enough for a screenful of Town Square authors, and bounded so it cannot be a scrape. */
const MAX_CARDS = 50;

const cardsQuerySchema = z
  .object({
    characterIds: z
      .string()
      .transform((value) => value.split(',').map((entry) => entry.trim()).filter(Boolean))
      .pipe(z.array(z.string().uuid()).min(1).max(MAX_CARDS)),
  })
  .strict();

/**
 * The public duel standing of other players: their wallet (which is what a challenger is
 * risking, so it cannot be hidden), their record, and their chicken badge. Everything here
 * is already visible or inferable in play; nothing private is added by asking for it.
 */
export async function registerDuelRoutes(app: FastifyInstance, deps: ServerDeps): Promise<void> {
  const { db } = deps;

  app.get('/api/v1/duels/cards', { onRequest: app.authenticate }, async (request, reply) => {
    const viewer = await findActiveCharacterByAccount(db, request.accountId);
    if (!viewer) throw new ApiError(404, 'NO_CHARACTER', 'You do not have a character yet.');

    const { characterIds } = parseOrThrow(cardsQuerySchema, request.query);
    const result = await db.query<CharacterRow>(
      'SELECT * FROM characters WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL',
      [characterIds],
    );

    const now = Date.now();
    const payload: DuelCardsResponse = { cards: result.rows.map((row) => toDuelCardDto(row, now)) };
    return reply.code(200).send(payload);
  });
}
