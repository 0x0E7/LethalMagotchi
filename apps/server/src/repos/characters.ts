import {
  STARTING_LETHAL_COINS,
  STARTING_STATS,
  isBeggarWallet,
  isOldEnoughToDuel,
  isOldEnoughToRaid,
  isRaidImmune,
  isRaidableWealth,
  normalizeStats,
  roundStats,
  simulateCharacter,
  wealthBandOf,
  type CharacterCreate,
  type CharacterDto,
  type DuelCardDto,
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
  tournament_opt_in: boolean;
  tournament_wins: number;
  seated_table_id: string | null;
  active_duel_id: string | null;
  active_raid_id: string | null;
  duel_wins: number;
  duel_losses: number;
  chicken_badge_until: Date | null;
  raid_immunity_until: Date | null;
  last_raid_at: Date | null;
  last_donation_appeal_at: Date | null;
  rebirth_count: number;
  last_rebirth_at: Date | null;
}

/** The one predicate every "is this character free to commit" check goes through. */
export function isEngaged(row: CharacterRow): boolean {
  return Boolean(row.seated_table_id ?? row.active_duel_id ?? row.active_raid_id);
}

export { STARTING_STATS, STARTING_LETHAL_COINS };

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
    tournamentOptIn: row.tournament_opt_in,
    tournamentWins: row.tournament_wins,
    seatedTableId: row.seated_table_id,
    activeDuelId: row.active_duel_id,
    activeRaidId: row.active_raid_id,
    duelWins: row.duel_wins,
    duelLosses: row.duel_losses,
    chickenBadgeUntil: row.chicken_badge_until ? row.chicken_badge_until.toISOString() : null,
    raidImmunityUntil: row.raid_immunity_until ? row.raid_immunity_until.toISOString() : null,
    isBeggar: isBeggarWallet(row.lethal_coins, row.active_raid_id),
    rebirthCount: row.rebirth_count,
    lastRebirthAt: row.last_rebirth_at ? row.last_rebirth_at.toISOString() : null,
  };
}

/**
 * The public standing of a character: their wealth as a *band*, their beggar state, their
 * record, and their badges. The exact balance deliberately does not appear — raiders pick
 * targets off this card, and an exact number would make a raid a calculated certainty
 * rather than a risk.
 */
export function toDuelCardDto(row: CharacterRow, now: number = Date.now()): DuelCardDto {
  return {
    characterId: row.id,
    accountId: row.account_id,
    nickname: row.nickname,
    speciesId: row.species_id,
    wealthBand: wealthBandOf(row.lethal_coins),
    isBeggar: isBeggarWallet(row.lethal_coins, row.active_raid_id),
    duelWins: row.duel_wins,
    duelLosses: row.duel_losses,
    chickenBadgeUntil: row.chicken_badge_until ? row.chicken_badge_until.toISOString() : null,
    duelEligible: isOldEnoughToDuel(row.created_at, now) && !isEngaged(row),
    /**
     * The target's own floors, so the UI never offers a raid that must fail. The engagement
     * lock is deliberately *not* part of it: a target does not have to be idle to be raided.
     */
    raidEligible:
      isOldEnoughToRaid(row.created_at, now) &&
      isRaidableWealth(row.lethal_coins) &&
      !isRaidImmune(row.raid_immunity_until, now),
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

export async function lockCharacterById(client: DbClient, characterId: string): Promise<CharacterRow | null> {
  const result = await client.query<CharacterRow>(
    'SELECT * FROM characters WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
    [characterId],
  );
  return result.rows[0] ?? null;
}

export async function findCharacterById(db: Db | DbClient, characterId: string): Promise<CharacterRow | null> {
  const result = await db.query<CharacterRow>('SELECT * FROM characters WHERE id = $1', [characterId]);
  return result.rows[0] ?? null;
}

export async function setTournamentOptIn(
  db: Db,
  accountId: string,
  optIn: boolean,
): Promise<CharacterRow | null> {
  const result = await db.query<CharacterRow>(
    `UPDATE characters SET tournament_opt_in = $2, updated_at = now()
     WHERE account_id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [accountId, optIn],
  );
  return result.rows[0] ?? null;
}

export async function setSeatedTable(
  client: DbClient,
  characterId: string,
  tableId: string | null,
): Promise<void> {
  await client.query('UPDATE characters SET seated_table_id = $2, updated_at = now() WHERE id = $1', [
    characterId,
    tableId,
  ]);
}

/**
 * The duel half of the engagement lock. Set under the same row lock that snapshots the
 * wallets, cleared in the settlement transaction — never anywhere else.
 */
export async function setActiveDuel(
  client: DbClient,
  characterId: string,
  duelId: string | null,
): Promise<void> {
  await client.query('UPDATE characters SET active_duel_id = $2, updated_at = now() WHERE id = $1', [
    characterId,
    duelId,
  ]);
}

export async function recordDuelResult(
  client: DbClient,
  input: { winnerCharacterId: string; loserCharacterId: string },
): Promise<void> {
  await client.query(
    `UPDATE characters
     SET duel_wins = duel_wins + (CASE WHEN id = $1 THEN 1 ELSE 0 END),
         duel_losses = duel_losses + (CASE WHEN id = $2 THEN 1 ELSE 0 END),
         updated_at = now()
     WHERE id = ANY(ARRAY[$1, $2]::uuid[])`,
    [input.winnerCharacterId, input.loserCharacterId],
  );
}

export async function setChickenBadge(
  client: DbClient,
  characterId: string,
  until: Date,
): Promise<CharacterRow | null> {
  const result = await client.query<CharacterRow>(
    'UPDATE characters SET chicken_badge_until = $2, updated_at = now() WHERE id = $1 RETURNING *',
    [characterId, until],
  );
  return result.rows[0] ?? null;
}

/**
 * The appeal's 3h floor, claimed rather than checked: the condition is part of the write, so
 * two appeals racing each other resolve to one poster. Null means the floor refused it, and
 * the row it returns carries the timestamp the refusal can be quoted from.
 */
export async function claimDonationAppeal(
  client: DbClient,
  characterId: string,
  input: { at: Date; notBefore: Date },
): Promise<CharacterRow | null> {
  const result = await client.query<CharacterRow>(
    `UPDATE characters SET last_donation_appeal_at = $2, updated_at = now()
     WHERE id = $1 AND (last_donation_appeal_at IS NULL OR last_donation_appeal_at <= $3)
     RETURNING *`,
    [characterId, input.at, input.notBefore],
  );
  return result.rows[0] ?? null;
}

/**
 * The raid half of the engagement lock. Set when a raider joins — so a committed raider
 * cannot also sit down at a table, accept a duel or spend in the shop — and cleared in the
 * settlement transaction or the compensating cancel, never anywhere else.
 */
export async function setActiveRaid(
  client: DbClient,
  characterId: string,
  raidId: string | null,
): Promise<void> {
  await client.query('UPDATE characters SET active_raid_id = $2, updated_at = now() WHERE id = $1', [
    characterId,
    raidId,
  ]);
}

/**
 * The escrow move, and the bankruptcy move: a raid stakes whole wallets, so both are the
 * same write. Returns the coins that were taken, read back from the row rather than from an
 * earlier read, so nothing can be escrowed twice or taken from a wallet that moved.
 */
export async function drainCoins(
  client: DbClient,
  characterId: string,
): Promise<{ taken: number; character: CharacterRow }> {
  // The CTE reads the pre-update snapshot, so the amount taken is the row's own number
  // rather than one the caller carried in from an earlier read.
  const result = await client.query<CharacterRow & { taken: number }>(
    `WITH before AS (SELECT lethal_coins FROM characters WHERE id = $1)
     UPDATE characters SET lethal_coins = 0, updated_at = now()
     WHERE id = $1
     RETURNING *, (SELECT lethal_coins FROM before) AS taken`,
    [characterId],
  );
  const row = result.rows[0]!;
  return { taken: row.taken, character: row };
}

/** The target's rolling immunity and the raiders' rolling cooldown, written together. */
export async function recordRaidParticipation(
  client: DbClient,
  input: { targetCharacterId: string; raiderCharacterIds: string[]; immuneUntil: Date; at: Date },
): Promise<void> {
  await client.query(
    'UPDATE characters SET raid_immunity_until = $2, updated_at = now() WHERE id = $1',
    [input.targetCharacterId, input.immuneUntil],
  );
  await client.query(
    'UPDATE characters SET last_raid_at = $2, updated_at = now() WHERE id = ANY($1::uuid[])',
    [input.raiderCharacterIds, input.at],
  );
}

export async function creditCoins(
  client: DbClient,
  characterId: string,
  coins: number,
): Promise<CharacterRow> {
  const result = await client.query<CharacterRow>(
    `UPDATE characters SET lethal_coins = lethal_coins + $2, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [characterId, coins],
  );
  return result.rows[0]!;
}

export async function recordTournamentWin(client: DbClient, characterId: string): Promise<void> {
  await client.query(
    'UPDATE characters SET tournament_wins = tournament_wins + 1, updated_at = now() WHERE id = $1',
    [characterId],
  );
}

export async function softDeleteCharacter(db: Db | DbClient, accountId: string): Promise<boolean> {
  const result = await db.query(
    'UPDATE characters SET deleted_at = now(), updated_at = now() WHERE account_id = $1 AND deleted_at IS NULL',
    [accountId],
  );
  return (result.rowCount ?? 0) > 0;
}
