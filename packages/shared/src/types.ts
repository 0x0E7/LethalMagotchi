import type { ActionId, ClipId, ShopItem, ShopItemId } from './actions.js';
import type { Country } from './countries.js';
import type {
  Occupation,
  OccupationId,
  Personality,
  PersonalityId,
  Species,
  SpeciesId,
} from './reference.js';
import type { CharacterStats } from './stats.js';
import type { TournamentEntryDto, TournamentSummary } from './tournament.js';

export interface AccountDto {
  id: string;
  username: string;
  createdAt: string;
  lastLoginAt: string | null;
  ownedCosmetics: string[];
}

export interface CharacterDto {
  id: string;
  accountId: string | null;
  speciesId: SpeciesId;
  nickname: string;
  bio: string;
  originCountry: string;
  originCity: string | null;
  occupationId: OccupationId;
  personalityId: PersonalityId;
  createdAt: string;
  updatedAt: string;
  stats: CharacterStats;
  lastSimulatedAt: string;
  equippedCosmetics: string[];
  lethalCoins: number;
  actionCooldowns: Record<string, string>;
  tournamentOptIn: boolean;
  tournamentWins: number;
  seatedTableId: string | null;
  activeDuelId: string | null;
  activeRaidId: string | null;
  duelWins: number;
  duelLosses: number;
  chickenBadgeUntil: string | null;
  raidImmunityUntil: string | null;
  /** Derived from `lethalCoins`, never stored — carried so the badge has one source. */
  isBeggar: boolean;
  rebirthCount: number;
  lastRebirthAt: string | null;
}

export interface ActionResultDto {
  action: ActionId;
  itemId: ShopItemId | null;
  clipId: ClipId;
  deltas: Partial<CharacterStats>;
  coinsSpent: number;
  cooldownEndsAt: string;
}

export interface ActionResponse {
  character: CharacterDto;
  result: ActionResultDto;
}

export interface SessionResponse {
  accessToken: string;
  expiresInSeconds: number;
  account: AccountDto;
  character: CharacterDto | null;
}

export interface MeResponse {
  account: AccountDto;
  character: CharacterDto | null;
}

export interface RefreshResponse {
  accessToken: string;
  expiresInSeconds: number;
}

export interface ReferenceResponse {
  version: string;
  species: Species[];
  personalities: Personality[];
  occupations: Occupation[];
  countries: Country[];
  shopItems: ShopItem[];
}

export interface UsernameAvailabilityResponse {
  username: string;
  available: boolean;
  suggestions: string[];
}

export interface TournamentStatusResponse {
  now: string;
  tournament: TournamentSummary | null;
  entry: TournamentEntryDto | null;
  /**
   * Carried here so the entry-risk warning is never computed from a wallet the client
   * last heard about over a socket that has since dropped: entry can end in a rebirth,
   * and the player has to be told which one they are about to take.
   */
  character: CharacterDto | null;
  blackout: boolean;
  /** Israel-local 10:00 when in blackout, so the chip can say when play resumes. */
  resumesAt: string | null;
  nextSlotAt: string;
  entryFeeCoins: number;
  missPenaltyCoins: number;
}

export interface TournamentOptInResponse {
  character: CharacterDto;
  tournament: TournamentSummary | null;
}

export const API_ERROR_CODES = [
  'VALIDATION_FAILED',
  'INVALID_CREDENTIALS',
  'USERNAME_TAKEN',
  'UNAUTHORIZED',
  'RATE_LIMITED',
  'CHARACTER_EXISTS',
  'NO_CHARACTER',
  'BIO_REJECTED',
  'CREATE_LIMIT_REACHED',
  'INSUFFICIENT_FUNDS',
  'ACTION_ON_COOLDOWN',
  'CHARACTER_SEATED',
  'CHARACTER_IN_DUEL',
  'CHARACTER_IN_RAID',
  /** Coins already promised to a pending duel invite cannot be spent while it is live. */
  'DUEL_STAKE_RESERVED',
  /** A donation may only reach a character who currently holds nothing. */
  'NOT_A_BEGGAR',
  'SELF_DONATION',
  'BLOCKED',
  /** One group at a time — the partial unique index refusing a second live membership. */
  'GROUP_MEMBERSHIP_EXISTS',
  'GROUP_NOT_MEMBER',
  'GROUP_NOT_LEADER',
  'GROUP_FULL',
  'GROUP_NAME_TAKEN',
  'GROUP_NAME_REJECTED',
  'GROUP_INVITE_PENDING',
  /** A kicked player, still inside the 24h block their old group put them under. */
  'GROUP_KICK_COOLDOWN',
  'NOT_FOUND',
  'INTERNAL_ERROR',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    fields?: Record<string, string>;
    retryAfterSeconds?: number;
  };
}
