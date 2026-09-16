import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { type DuelCardsResponse } from '@lethalmagotchi/shared';
import type { ServerDeps } from '../deps.js';
import { ApiError } from '../errors.js';
import { findActiveCharacterByAccount, toDuelCardDto, type CharacterRow } from '../repos/characters.js';
import { groupNamesForAccounts } from '../repos/groups.js';
import { parseOrThrow } from '../validate.js';

/** A screenful. Bounded so the directory cannot be walked wholesale in one call. */
const MAX_RESULTS = 50;

const directoryQuerySchema = z
  .object({
    q: z.string().trim().max(64).optional(),
  })
  .strict();

/**
 * The people directory.
 *
 * Until now the only way to reach another player was to catch them posting in the Town
 * Square: `/duels/cards` answers "tell me about these ids", which is a lookup, not a way to
 * *find* anyone. That left direct messages and group invitations both unusable against
 * someone who happened to be quiet, which is the shape of several reported bugs rather than
 * one.
 *
 * With no query this answers "who is here right now", read from the live socket hub. With a
 * query it searches nicknames instead, so a specific person can be found whether or not they
 * are online or talking.
 *
 * The payload is the same `DuelCardDto` the Town Square already renders — a card that was
 * vetted to carry only what is public (band, not balance; record; badges; group name). This
 * endpoint deliberately adds no new field, so it opens no new surface: it changes *which*
 * cards you can ask for, never *what* a card says.
 */
export async function registerPlayerRoutes(app: FastifyInstance, deps: ServerDeps): Promise<void> {
  const { db, hub, limiters } = deps;

  app.get('/api/v1/players', { onRequest: app.authenticate }, async (request, reply) => {
    const flood = limiters.playerSearch.check(request.accountId);
    if (!flood.allowed) {
      throw new ApiError(429, 'RATE_LIMITED', 'Slow down a moment.', {
        retryAfterSeconds: flood.retryAfterSeconds,
      });
    }

    const viewer = await findActiveCharacterByAccount(db, request.accountId);
    if (!viewer) throw new ApiError(404, 'NO_CHARACTER', 'You do not have a character yet.');

    const { q } = parseOrThrow(directoryQuerySchema, request.query);
    const term = q ?? '';

    // Two different questions, one shape of answer. Both exclude the viewer: a directory
    // whose first entry is yourself is a directory you have to look past every time.
    const rows = term.length > 0 ? await searchByNickname(db, term, viewer.id) : await online(db, hub, viewer.id);

    const groups = await groupNamesForAccounts(
      db,
      rows.map((row) => row.account_id).filter((id): id is string => id !== null),
    );

    const now = Date.now();
    const payload: DuelCardsResponse = {
      cards: rows.map((row) =>
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
}

async function online(db: ServerDeps['db'], hub: ServerDeps['hub'], viewerId: string): Promise<CharacterRow[]> {
  const ids = hub.onlineCharacterIds().filter((id) => id !== viewerId);
  if (ids.length === 0) return [];
  const result = await db.query<CharacterRow>(
    `SELECT * FROM characters
      WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
      ORDER BY nickname ASC
      LIMIT $2`,
    [ids.slice(0, MAX_RESULTS), MAX_RESULTS],
  );
  return result.rows;
}

/**
 * Case-insensitive contains, not a prefix: players look for the fragment they remember, and
 * nicknames are not unique anyway — the card's identity tag and group name are what tell two
 * "Bubbles" apart, which is exactly what they were added for.
 */
async function searchByNickname(
  db: ServerDeps['db'],
  term: string,
  viewerId: string,
): Promise<CharacterRow[]> {
  // `%` and `_` are wildcards to LIKE, so an unescaped term lets a search for "%" match the
  // entire directory — the one thing the bound above is meant to prevent. Escaped here
  // rather than stripped, so searching for a literal underscore still finds it.
  const escaped = term.replace(/([\\%_])/g, '\\$1');
  const result = await db.query<CharacterRow>(
    `SELECT * FROM characters
      WHERE deleted_at IS NULL
        AND id <> $1
        AND nickname ILIKE '%' || $2 || '%' ESCAPE '\\'
      ORDER BY nickname ASC
      LIMIT $3`,
    [viewerId, escaped, MAX_RESULTS],
  );
  return result.rows;
}
