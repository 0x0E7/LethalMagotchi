import { rebirthState, type CharacterStats, type RebirthCause } from '@lethalmagotchi/shared';
import type { Db, DbClient } from '../db/pool.js';
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
export interface RebirthInput {
  statsBefore: CharacterStats;
  cause: RebirthCause;
  tournamentId: string | null;
  duelId?: string | null;
  at: Date;
  /**
   * Claim the death conditionally: the write only lands if `rebirth_count` is still what the
   * caller read. Callers holding an ordered row lock don't need it, but the neglect reaper
   * races itself by design — a sweep can fire at the same instant as the owner's socket
   * binding — and a stale reader would otherwise commit a second rebirth after the first,
   * resetting an already-renewed wallet. `null` means somebody else got there.
   */
  expectRebirthCount?: number;
}

/**
 * The two shapes stated in the type rather than left to a comment: an unguarded rebirth is
 * unconditional and always returns an outcome, while a guarded one may lose its claim.
 */
export function rebirthCharacter(
  client: DbClient,
  row: CharacterRow,
  input: RebirthInput & { expectRebirthCount: number },
): Promise<RebirthOutcome | null>;
export function rebirthCharacter(
  client: DbClient,
  row: CharacterRow,
  input: RebirthInput & { expectRebirthCount?: undefined },
): Promise<RebirthOutcome>;
export async function rebirthCharacter(
  client: DbClient,
  row: CharacterRow,
  input: RebirthInput,
): Promise<RebirthOutcome | null> {
  const fresh = rebirthState();
  const rebirthIndex = row.rebirth_count + 1;
  const guarded = input.expectRebirthCount !== undefined;

  const updated = await client.query<CharacterRow>(
    `UPDATE characters
     SET stats = $2,
         lethal_coins = $3,
         action_cooldowns = '{}'::jsonb,
         last_simulated_at = $4,
         rebirth_count = $5,
         last_rebirth_at = $4,
         seated_table_id = NULL,
         active_duel_id = NULL,
         -- All three legs of the engagement lock, defensively: a renewed character holding
         -- a lock on a commitment its predecessor made is refused every action until the
         -- lock's own timeout clears it.
         active_raid_id = NULL,
         updated_at = now()
     WHERE id = $1${guarded ? ' AND rebirth_count = $6' : ''}
     RETURNING *`,
    guarded
      ? [row.id, JSON.stringify(fresh.stats), fresh.lethalCoins, input.at, rebirthIndex, input.expectRebirthCount]
      : [row.id, JSON.stringify(fresh.stats), fresh.lethalCoins, input.at, rebirthIndex],
  );

  // Lost the claim: another reaper has already renewed them, and there is nothing to record.
  if (updated.rows.length === 0) return null;

  await client.query(
    `INSERT INTO rebirth_events (id, character_id, occurred_at, rebirth_index, cause, tournament_id, duel_id, stats_before, coins_before)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      uuidv7(),
      row.id,
      input.at,
      rebirthIndex,
      input.cause,
      input.tournamentId,
      input.duelId ?? null,
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

/**
 * The rebirth a duel committed, for a settlement whose own COMMIT acknowledgment was lost:
 * the frames the loser must still be sent quote the pre-death snapshot, which only this row
 * still holds once the character has been reset.
 */
export async function findDuelRebirthEvent(
  db: Db | DbClient,
  duelId: string,
  characterId: string,
): Promise<{ statsBefore: CharacterStats; coinsBefore: number; rebirthIndex: number } | null> {
  const result = await db.query<{ stats_before: CharacterStats; coins_before: number; rebirth_index: number }>(
    `SELECT stats_before, coins_before, rebirth_index FROM rebirth_events
     WHERE duel_id = $1 AND character_id = $2
     ORDER BY rebirth_index DESC
     LIMIT 1`,
    [duelId, characterId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    statsBefore: row.stats_before,
    coinsBefore: row.coins_before,
    rebirthIndex: row.rebirth_index,
  };
}

export async function countRebirthEvents(client: DbClient, characterId: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM rebirth_events WHERE character_id = $1',
    [characterId],
  );
  return Number(result.rows[0]!.count);
}
