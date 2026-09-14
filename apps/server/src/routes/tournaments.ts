import type { FastifyInstance } from 'fastify';
import {
  BLACKOUT_TZ,
  ENTRY_FEE_COINS,
  MISS_PENALTY_COINS,
  activeWindowOpensAfter,
  isBlackout,
  nextSlotAfter,
  tournamentOptInSchema,
  type TournamentOptInResponse,
  type TournamentStatusResponse,
} from '@lethalmagotchi/shared';
import type { ServerDeps } from '../deps.js';
import { ApiError } from '../errors.js';
import { findActiveCharacterByAccount, setTournamentOptIn, toCharacterDto } from '../repos/characters.js';
import { findEntry, toEntryDto, toTournamentSummary } from '../repos/tournaments.js';
import { parseOrThrow } from '../validate.js';

export async function registerTournamentRoutes(app: FastifyInstance, deps: ServerDeps): Promise<void> {
  const { db, tournaments } = deps;

  app.get('/api/v1/tournaments/current', { onRequest: app.authenticate }, async (request, reply) => {
    const now = new Date();
    const character = await findActiveCharacterByAccount(db, request.accountId);
    const tournament = await tournaments.currentTournament();
    const entry =
      tournament && character ? await findEntry(db, tournament.id, character.id) : null;

    const blackout = isBlackout(now);
    const payload: TournamentStatusResponse = {
      now: now.toISOString(),
      tournament: tournament ? toTournamentSummary(tournament) : null,
      entry: entry ? toEntryDto(entry) : null,
      character: character ? toCharacterDto(character, now.getTime()) : null,
      blackout,
      resumesAt: blackout ? activeWindowOpensAfter(now, BLACKOUT_TZ).toISOString() : null,
      nextSlotAt: (tournament?.scheduled_for ?? nextSlotAfter(now)).toISOString(),
      entryFeeCoins: ENTRY_FEE_COINS,
      missPenaltyCoins: MISS_PENALTY_COINS,
    };
    return reply.code(200).send(payload);
  });

  app.post('/api/v1/characters/me/tournament-optin', { onRequest: app.authenticate }, async (request, reply) => {
    const { optIn } = parseOrThrow(tournamentOptInSchema, request.body);

    const existing = await findActiveCharacterByAccount(db, request.accountId);
    if (!existing) throw new ApiError(404, 'NO_CHARACTER', 'You do not have a character yet.');
    if (existing.seated_table_id) {
      throw new ApiError(409, 'CHARACTER_SEATED', 'You are already at a table.');
    }
    if (existing.active_duel_id) {
      throw new ApiError(409, 'CHARACTER_IN_DUEL', 'You are in a duel right now.');
    }
    if (existing.active_raid_id) {
      throw new ApiError(409, 'CHARACTER_IN_RAID', 'You are in a raid right now.');
    }

    const updated = await setTournamentOptIn(db, request.accountId, optIn);
    if (!updated) throw new ApiError(404, 'NO_CHARACTER', 'You do not have a character yet.');

    const tournament = await tournaments.currentTournament();
    const payload: TournamentOptInResponse = {
      character: toCharacterDto(updated),
      tournament: tournament ? toTournamentSummary(tournament) : null,
    };
    return reply.code(200).send(payload);
  });
}
