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
