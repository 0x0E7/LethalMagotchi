import { STARTING_STATS, type CharacterStats } from './stats.js';

export const STARTING_LETHAL_COINS = 5;

export const REBIRTH_CAUSES = ['tournament_entry_hp_exhausted', 'duel_defeat'] as const;
export type RebirthCause = (typeof REBIRTH_CAUSES)[number];

export interface RebirthState {
  stats: CharacterStats;
  lethalCoins: number;
  actionCooldowns: Record<string, string>;
}

/**
 * The reset half of the preserved/reset split. Everything a rebirth *preserves* —
 * id, account, species, nickname, bio, origin, occupation, personality, createdAt,
 * cosmetics — is preserved by simply not being written here.
 */
export function rebirthState(): RebirthState {
  return { stats: { ...STARTING_STATS }, lethalCoins: STARTING_LETHAL_COINS, actionCooldowns: {} };
}

export interface RebirthEventDto {
  id: string;
  characterId: string;
  occurredAt: string;
  rebirthIndex: number;
  cause: RebirthCause;
  tournamentId: string | null;
  duelId: string | null;
  statsBefore: CharacterStats;
  coinsBefore: number;
}
