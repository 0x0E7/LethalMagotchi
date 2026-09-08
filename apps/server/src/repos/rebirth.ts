import { rebirthState, type CharacterStats, type RebirthCause } from '@lethalmagotchi/shared';
import type { DbClient } from '../db/pool.js';
import { uuidv7 } from '../uuid.js';
import type { CharacterRow } from './characters.js';

export interface RebirthOutcome {
  character: CharacterRow;
  statsBefore: CharacterStats;
  coinsBefore: number;
  rebirthIndex: number;
}

/**
 * Rebirth is not deletion: the same row, the same id, the same nickname and history.
 * Stats, coins and cooldowns reset; identity, cosmetics and the tournament win counter
 * survive. Runs inside the caller's transaction so the charge that killed the character
 * and the renewal that follows it commit or roll back together.
 */
export async function rebirthCharacter(
  client: DbClient,
  row: CharacterRow,
  input: { statsBefore: CharacterStats; cause: RebirthCause; tournamentId: string | null; at: Date },
): Promise<RebirthOutcome> {
  const fresh = rebirthState();
  const rebirthIndex = row.rebirth_count + 1;

  const updated = await client.query<CharacterRow>(
    `UPDATE characters
     SET stats = $2,
         lethal_coins = $3,
         action_cooldowns = '{}'::jsonb,
         last_simulated_at = $4,
         rebirth_count = $5,
         last_rebirth_at = $4,
         seated_table_id = NULL,
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [row.id, JSON.stringify(fresh.stats), fresh.lethalCoins, input.at, rebirthIndex],
  );

  await client.query(
    `INSERT INTO rebirth_events (id, character_id, occurred_at, rebirth_index, cause, tournament_id, stats_before, coins_before)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      uuidv7(),
      row.id,
      input.at,
      rebirthIndex,
      input.cause,
      input.tournamentId,
      JSON.stringify(input.statsBefore),
      row.lethal_coins,
    ],
  );

  return {
    character: updated.rows[0]!,
    statsBefore: input.statsBefore,
    coinsBefore: row.lethal_coins,
    rebirthIndex,
  };
}

export async function countRebirthEvents(client: DbClient, characterId: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM rebirth_events WHERE character_id = $1',
    [characterId],
  );
  return Number(result.rows[0]!.count);
}
