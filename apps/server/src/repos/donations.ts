import type { DonationDto } from '@lethalmagotchi/shared';
import type { Db, DbClient } from '../db/pool.js';

export interface DonationRow {
  id: string;
  from_character_id: string;
  to_character_id: string;
  coins: number;
  at: Date;
}

export function toDonationDto(row: DonationRow): DonationDto {
  return {
    id: row.id,
    fromCharacterId: row.from_character_id,
    toCharacterId: row.to_character_id,
    coins: row.coins,
    at: row.at.toISOString(),
  };
}

/**
 * The append-only record, written inside the transaction that moves the coins — a donation
 * is its own settlement step, so the row and the two wallet writes commit together or not
 * at all.
 */
export async function insertDonation(
  client: DbClient,
  input: { id: string; fromCharacterId: string; toCharacterId: string; coins: number; at: Date },
): Promise<DonationRow> {
  const result = await client.query<DonationRow>(
    `INSERT INTO donations (id, from_character_id, to_character_id, coins, at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [input.id, input.fromCharacterId, input.toCharacterId, input.coins, input.at],
  );
  return result.rows[0]!;
}

export async function listDonationsTo(db: Db, characterId: string): Promise<DonationRow[]> {
  const result = await db.query<DonationRow>(
    'SELECT * FROM donations WHERE to_character_id = $1 ORDER BY at DESC',
    [characterId],
  );
  return result.rows;
}
