import type {
  CharacterCreate,
  CharacterDto,
  CharacterPatch,
  CharacterStats,
  OccupationId,
  PersonalityId,
  SpeciesId,
} from '@lethalmagotchi/shared';
import type { Db } from '../db/pool.js';
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
}

export const STARTING_STATS: CharacterStats = { hunger: 80, hygiene: 80, energy: 80, mood: 80 };

export function toCharacterDto(row: CharacterRow): CharacterDto {
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
    stats: row.stats,
    lastSimulatedAt: row.last_simulated_at.toISOString(),
    equippedCosmetics: row.equipped_cosmetics,
  };
}

export async function findActiveCharacterByAccount(db: Db, accountId: string): Promise<CharacterRow | null> {
  const result = await db.query<CharacterRow>(
    'SELECT * FROM characters WHERE account_id = $1 AND deleted_at IS NULL',
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
       occupation_id, personality_id, stats
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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

export async function softDeleteCharacter(db: Db, accountId: string): Promise<boolean> {
  const result = await db.query(
    'UPDATE characters SET deleted_at = now(), updated_at = now() WHERE account_id = $1 AND deleted_at IS NULL',
    [accountId],
  );
  return (result.rowCount ?? 0) > 0;
}
