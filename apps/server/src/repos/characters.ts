import {
  STARTING_STATS,
  normalizeStats,
  roundStats,
  simulateCharacter,
  type CharacterCreate,
  type CharacterDto,
  type CharacterPatch,
  type CharacterStats,
  type OccupationId,
  type PersonalityId,
  type SpeciesId,
} from '@lethalmagotchi/shared';
import type { Db, DbClient } from '../db/pool.js';
import { uuidv7 } from '../uuid.js';

export interface CharacterRow {
  id: string;
  account_id: string | null;
  species_id: SpeciesId;
  nickname: string;
  bio: string;
  origin_country: string;
  origin_city: string | null;
  occupation_id: OccupationId;
  personality_id: PersonalityId;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  stats: CharacterStats;
  last_simulated_at: Date;
  equipped_cosmetics: string[];
  lethal_coins: number;
  action_cooldowns: Record<string, string>;
}

export { STARTING_STATS };

export const STARTING_LETHAL_COINS = 5;

export function simulatedStats(row: CharacterRow, now: number): CharacterStats {
  return simulateCharacter({
    stats: normalizeStats(row.stats),
    speciesId: row.species_id,
    personalityId: row.personality_id,
    lastSimulatedAt: row.last_simulated_at,
    now,
  });
}

/**
 * Decay/HP are computed on read rather than persisted on read: `simulate()` composes
 * over time, so an unpersisted watermark yields the same numbers on the next read.
 * Only writes (actions) advance `last_simulated_at`.
 */
export function toCharacterDto(row: CharacterRow, now: number = Date.now()): CharacterDto {
  return {
    id: row.id,
    accountId: row.account_id,
    speciesId: row.species_id,
    nickname: row.nickname,
    bio: row.bio,
    originCountry: row.origin_country,
    originCity: row.origin_city,
    occupationId: row.occupation_id,
    personalityId: row.personality_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    stats: roundStats(simulatedStats(row, now)),
    lastSimulatedAt: new Date(Math.max(row.last_simulated_at.getTime(), now)).toISOString(),
    equippedCosmetics: row.equipped_cosmetics,
    lethalCoins: row.lethal_coins,
    actionCooldowns: row.action_cooldowns,
  };
}

export async function findActiveCharacterByAccount(db: Db, accountId: string): Promise<CharacterRow | null> {
  const result = await db.query<CharacterRow>(
    'SELECT * FROM characters WHERE account_id = $1 AND deleted_at IS NULL',
    [accountId],
  );
  return result.rows[0] ?? null;
}

export async function lockActiveCharacterByAccount(
  client: DbClient,
  accountId: string,
): Promise<CharacterRow | null> {
  const result = await client.query<CharacterRow>(
    'SELECT * FROM characters WHERE account_id = $1 AND deleted_at IS NULL FOR UPDATE',
    [accountId],
  );
  return result.rows[0] ?? null;
}

export async function insertCharacter(
  db: Db,
  accountId: string,
  input: CharacterCreate,
): Promise<CharacterRow> {
  const result = await db.query<CharacterRow>(
    `INSERT INTO characters (
       id, account_id, species_id, nickname, bio, origin_country, origin_city,
       occupation_id, personality_id, stats, lethal_coins
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      uuidv7(),
      accountId,
      input.speciesId,
      input.nickname,
      input.bio,
      input.originCountry,
      input.originCity,
      input.occupationId,
      input.personalityId,
      JSON.stringify(STARTING_STATS),
      STARTING_LETHAL_COINS,
    ],
  );
  return result.rows[0]!;
}

const PATCH_COLUMNS: Record<keyof CharacterPatch, string> = {
  nickname: 'nickname',
  bio: 'bio',
  originCountry: 'origin_country',
  originCity: 'origin_city',
  occupationId: 'occupation_id',
  personalityId: 'personality_id',
};

export async function updateCharacter(
  db: Db,
  accountId: string,
  patch: CharacterPatch,
): Promise<CharacterRow | null> {
  const assignments: string[] = [];
  const values: unknown[] = [accountId];

  for (const [key, column] of Object.entries(PATCH_COLUMNS) as [keyof CharacterPatch, string][]) {
    const value = patch[key];
    if (value === undefined) continue;
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  }
  if (assignments.length === 0) return findActiveCharacterByAccount(db, accountId);

  const result = await db.query<CharacterRow>(
    `UPDATE characters
     SET ${assignments.join(', ')}, updated_at = now()
     WHERE account_id = $1 AND deleted_at IS NULL
     RETURNING *`,
    values,
  );
  return result.rows[0] ?? null;
}

export async function commitCharacterState(
  client: DbClient,
  characterId: string,
  state: {
    stats: CharacterStats;
    lethalCoins: number;
    actionCooldowns: Record<string, string>;
    simulatedAt: Date;
  },
): Promise<CharacterRow> {
  const result = await client.query<CharacterRow>(
    `UPDATE characters
     SET stats = $2,
         lethal_coins = $3,
         action_cooldowns = $4,
         last_simulated_at = $5,
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [
      characterId,
      JSON.stringify(state.stats),
      state.lethalCoins,
      JSON.stringify(state.actionCooldowns),
      state.simulatedAt,
    ],
  );
  return result.rows[0]!;
}

export async function softDeleteCharacter(db: Db, accountId: string): Promise<boolean> {
  const result = await db.query(
    'UPDATE characters SET deleted_at = now(), updated_at = now() WHERE account_id = $1 AND deleted_at IS NULL',
    [accountId],
  );
  return (result.rowCount ?? 0) > 0;
}
