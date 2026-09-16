import { randomInt } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  DUEL_MIN_ACCOUNT_AGE_MS,
  isDeclineCooldownActive,
  isOldEnoughToDuel,
  type DuelCardsResponse,
  type RandomOpponentResponse,
} from '@lethalmagotchi/shared';
import type { ServerDeps } from '../deps.js';
import { ApiError } from '../errors.js';
import {
  findActiveCharacterByAccount,
  isEngaged,
  toDuelCardDto,
  type CharacterRow,
} from '../repos/characters.js';
import { isBlockedEitherWay } from '../repos/chat.js';
import { lastDeclinedAt } from '../repos/duels.js';
import { groupNamesForAccounts } from '../repos/groups.js';
import { parseOrThrow } from '../validate.js';

/** Enough for a screenful of Town Square authors, and bounded so it cannot be a scrape. */
const MAX_CARDS = 50;

/** How many shuffled candidates to check the per-pair rules against before giving up. */
const MAX_RANDOM_PROBES = 10;

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
  const { db, hub, limiters } = deps;

  app.get('/api/v1/duels/cards', { onRequest: app.authenticate }, async (request, reply) => {
    const viewer = await findActiveCharacterByAccount(db, request.accountId);
    if (!viewer) throw new ApiError(404, 'NO_CHARACTER', 'You do not have a character yet.');

    const { characterIds } = parseOrThrow(cardsQuerySchema, request.query);
    const result = await db.query<CharacterRow>(
      'SELECT * FROM characters WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL',
      [characterIds],
    );

    // One lookup for the whole page rather than a per-card join: the group badge rides this
    // card precisely so the Town Square needs no second fetch to render it.
    const groups = await groupNamesForAccounts(
      db,
      result.rows.map((row) => row.account_id).filter((id): id is string => id !== null),
    );

    const now = Date.now();
    const payload: DuelCardsResponse = {
      cards: result.rows.map((row) =>
        toDuelCardDto(
          row,
          now,
          row.account_id ? (groups.get(row.account_id) ?? null) : null,
          hub.isOnline(row.id),
        ),
      ),
    };
    return reply.code(200).send(payload);
  });

  /**
   * One opponent, picked at random from everyone this viewer could actually challenge right
   * now — for the player who wants a duel rather than a particular person.
   *
   * It deliberately answers with a card rather than issuing the invite itself: the Stakes
   * Card is the consent moment for a lethal match, and a "random duel" button that skipped
   * it would be the one path in the product that commits a life without showing the sentence
   * first.
   *
   * Every floor `duel:invite` enforces is applied here, including the two a card cannot
   * carry — a block in either direction, and the per-pair decline cooldown — so the offered
   * opponent is one the invite will accept. The remaining race (they log off, or start a
   * duel, in the seconds before the challenge is sent) is the same one the Town Square
   * button has always had, and the server refuses it the same way.
   */
  app.get('/api/v1/duels/random', { onRequest: app.authenticate }, async (request, reply) => {
    const flood = limiters.playerSearch.check(request.accountId);
    if (!flood.allowed) {
      throw new ApiError(429, 'RATE_LIMITED', 'Slow down a moment.', {
        retryAfterSeconds: flood.retryAfterSeconds,
      });
    }

    const viewer = await findActiveCharacterByAccount(db, request.accountId);
    if (!viewer) throw new ApiError(404, 'NO_CHARACTER', 'You do not have a character yet.');

    const now = Date.now();
    const empty: RandomOpponentResponse = { card: null };

    // Their own floors are checked too: a player who is too new or mid-engagement has no
    // opponent, rather than being shown one they cannot challenge.
    if (!isOldEnoughToDuel(viewer.created_at, now) || isEngaged(viewer)) {
      return reply.code(200).send(empty);
    }

    const online = hub.onlineCharacterIds().filter((id) => id !== viewer.id);
    if (online.length === 0) return reply.code(200).send(empty);

    const candidates = await db.query<CharacterRow>(
      `SELECT * FROM characters
        WHERE id = ANY($1::uuid[])
          AND deleted_at IS NULL
          AND account_id IS NOT NULL
          AND created_at <= $2
          AND seated_table_id IS NULL
          AND active_duel_id IS NULL
          AND active_raid_id IS NULL`,
      [online, new Date(now - DUEL_MIN_ACCOUNT_AGE_MS)],
    );

    /**
     * Shuffled, then filtered one at a time, rather than filtering the whole set first: the
     * two remaining checks are a query each, and on a busy server the first candidate almost
     * always passes. Bounded so a viewer who has blocked or been declined by everyone online
     * still costs a fixed number of queries.
     */
    for (const row of shuffle(candidates.rows).slice(0, MAX_RANDOM_PROBES)) {
      if (await isBlockedEitherWay(db, request.accountId, row.account_id as string)) continue;
      if (isDeclineCooldownActive(await lastDeclinedAt(db, viewer.id, row.id), now)) continue;

      const groups = await groupNamesForAccounts(db, [row.account_id as string]);
      const payload: RandomOpponentResponse = {
        card: toDuelCardDto(row, now, groups.get(row.account_id as string) ?? null, true),
      };
      return reply.code(200).send(payload);
    }

    return reply.code(200).send(empty);
  });
}

/** Fisher-Yates over `crypto.randomInt`. `Math.random` is banned project-wide. */
function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
