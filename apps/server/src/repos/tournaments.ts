import type {
  Card,
  LoggedAction,
  Street,
  TableState,
  TournamentEntryDto,
  TournamentScope,
  TournamentState,
  TournamentSummary,
} from '@lethalmagotchi/shared';
import type { Db, DbClient } from '../db/pool.js';
import { uuidv7 } from '../uuid.js';

export interface TournamentRow {
  id: string;
  scope: TournamentScope;
  state: TournamentState;
  slot_key: string;
  scheduled_for: Date;
  registration_opens_at: Date;
  current_round: number;
  total_rounds: number;
  entrant_count: number;
  prize_pot_coins: number;
  shard_index: number;
  shard_count: number;
  winner_character_id: string | null;
  registration_closed_at: Date | null;
  updated_at: Date;
}

export interface TournamentEntryRow {
  tournament_id: string;
  character_id: string;
  hp_converted: string | number;
  current_stack: number;
  eliminated_in_round: number | null;
  final_rank: number | null;
}

export interface TournamentTableRow {
  id: string;
  tournament_id: string;
  round: number;
  state: TableState;
  hands_played: number;
  qualifier_character_id: string | null;
}

export interface TableSeatRow {
  table_id: string;
  seat_index: number;
  character_id: string;
  stack: number;
  starting_stack: number;
  hands_won: number;
  connected: boolean;
}

export function toTournamentSummary(row: TournamentRow): TournamentSummary {
  return {
    id: row.id,
    scope: row.scope,
    state: row.state,
    scheduledFor: row.scheduled_for.toISOString(),
    registrationOpensAt: row.registration_opens_at.toISOString(),
    currentRound: row.current_round,
    entrantCount: row.entrant_count,
    prizePotCoins: row.prize_pot_coins,
    shardIndex: row.shard_index,
    shardCount: row.shard_count,
    winnerCharacterId: row.winner_character_id,
  };
}

export function toEntryDto(row: TournamentEntryRow): TournamentEntryDto {
  return {
    tournamentId: row.tournament_id,
    characterId: row.character_id,
    hpConverted: Number(row.hp_converted),
    currentStack: row.current_stack,
    eliminatedInRound: row.eliminated_in_round,
    finalRank: row.final_rank,
  };
}

export async function insertScheduledTournament(
  db: Db | DbClient,
  input: {
    scope: TournamentScope;
    slotKey: string;
    scheduledFor: Date;
    registrationOpensAt: Date;
    shardIndex?: number;
    shardCount?: number;
  },
): Promise<TournamentRow | null> {
  const result = await db.query<TournamentRow>(
    `INSERT INTO tournaments (id, scope, state, slot_key, scheduled_for, registration_opens_at, shard_index, shard_count)
     VALUES ($1, $2, 'scheduled', $3, $4, $5, $6, $7)
     ON CONFLICT (scope, slot_key, shard_index) DO NOTHING
     RETURNING *`,
    [
      uuidv7(),
      input.scope,
      input.slotKey,
      input.scheduledFor,
      input.registrationOpensAt,
      input.shardIndex ?? 0,
      input.shardCount ?? 1,
    ],
  );
  return result.rows[0] ?? null;
}

/** The tournament a player should currently be told about: live first, otherwise upcoming. */
export async function findActiveTournament(db: Db, scope: TournamentScope = 'global'): Promise<TournamentRow | null> {
  const result = await db.query<TournamentRow>(
    `SELECT * FROM tournaments
     WHERE scope = $1 AND state IN ('scheduled', 'registration', 'running')
     ORDER BY CASE state WHEN 'running' THEN 0 WHEN 'registration' THEN 1 ELSE 2 END, scheduled_for
     LIMIT 1`,
    [scope],
  );
  return result.rows[0] ?? null;
}

export async function findTournamentsInState(
  db: Db,
  states: TournamentState[],
  scope: TournamentScope = 'global',
): Promise<TournamentRow[]> {
  const result = await db.query<TournamentRow>(
    'SELECT * FROM tournaments WHERE scope = $1 AND state = ANY($2) ORDER BY scheduled_for',
    [scope, states],
  );
  return result.rows;
}

export async function findTournamentById(db: Db | DbClient, id: string): Promise<TournamentRow | null> {
  const result = await db.query<TournamentRow>('SELECT * FROM tournaments WHERE id = $1', [id]);
  return result.rows[0] ?? null;
}

/**
 * Claims the right to run the registration-close charge loop for this tournament. The
 * claim is persistent, so a process that crashes mid-loop cannot re-run it after a
 * restart and charge the whole population twice.
 */
export async function claimRegistrationClose(db: Db, tournamentId: string): Promise<TournamentRow | null> {
  const result = await db.query<TournamentRow>(
    `UPDATE tournaments SET registration_closed_at = now(), updated_at = now()
     WHERE id = $1 AND registration_closed_at IS NULL AND state IN ('scheduled', 'registration')
     RETURNING *`,
    [tournamentId],
  );
  return result.rows[0] ?? null;
}

/**
 * Tournaments whose close was claimed but which never reached `running`, plus any
 * pre-play tournament that somehow already carries entries. Entries are only ever written
 * by the charge loop, so a `scheduled` row holding them is escrow nobody will settle —
 * an inconsistent state that must not survive a restart.
 */
export async function listAbandonedCloses(db: Db): Promise<TournamentRow[]> {
  const result = await db.query<TournamentRow>(
    `SELECT * FROM tournaments t
     WHERE t.state IN ('scheduled', 'registration')
       AND (
         t.registration_closed_at IS NOT NULL
         OR EXISTS (SELECT 1 FROM tournament_entries e WHERE e.tournament_id = t.id)
       )
     ORDER BY t.scheduled_for`,
  );
  return result.rows;
}

/**
 * Claims the right to advance past `round`. Two tables of the same round finishing at
 * the same moment both reach here; exactly one gets a row back and starts the next
 * round, so a round can never be started twice.
 */
export async function claimRoundAdvance(
  db: Db,
  tournamentId: string,
  round: number,
): Promise<TournamentRow | null> {
  const result = await db.query<TournamentRow>(
    `UPDATE tournaments SET current_round = $2 + 1, updated_at = now()
     WHERE id = $1 AND state = 'running' AND current_round = $2
     RETURNING *`,
    [tournamentId, round],
  );
  return result.rows[0] ?? null;
}

/** One charge per character per tournament, whichever way that charge resolves. */
export async function claimCharge(
  client: DbClient,
  tournamentId: string,
  characterId: string,
  charge: 'entry' | 'miss_penalty',
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO tournament_charges (tournament_id, character_id, charge)
     VALUES ($1, $2, $3)
     ON CONFLICT (tournament_id, character_id) DO NOTHING`,
    [tournamentId, characterId, charge],
  );
  return result.rowCount === 1;
}

export async function updateTournamentState(
  client: DbClient | Db,
  tournamentId: string,
  patch: {
    state?: TournamentState;
    currentRound?: number;
    totalRounds?: number;
    entrantCount?: number;
    prizePotCoins?: number;
    winnerCharacterId?: string | null;
  },
): Promise<TournamentRow> {
  const columns: Record<string, unknown> = {
    state: patch.state,
    current_round: patch.currentRound,
    total_rounds: patch.totalRounds,
    entrant_count: patch.entrantCount,
    prize_pot_coins: patch.prizePotCoins,
    winner_character_id: patch.winnerCharacterId,
  };
  const assignments: string[] = [];
  const values: unknown[] = [tournamentId];
  for (const [column, value] of Object.entries(columns)) {
    if (value === undefined) continue;
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  }

  const result = await client.query<TournamentRow>(
    `UPDATE tournaments SET ${[...assignments, 'updated_at = now()'].join(', ')} WHERE id = $1 RETURNING *`,
    values,
  );
  return result.rows[0]!;
}

export async function insertEntry(
  client: DbClient,
  input: { tournamentId: string; characterId: string; hpConverted: number; stack: number },
): Promise<void> {
  await client.query(
    `INSERT INTO tournament_entries (tournament_id, character_id, hp_converted, current_stack)
     VALUES ($1, $2, $3, $4)`,
    [input.tournamentId, input.characterId, input.hpConverted, input.stack],
  );
}

export async function listEntries(db: Db, tournamentId: string): Promise<TournamentEntryRow[]> {
  const result = await db.query<TournamentEntryRow>(
    'SELECT * FROM tournament_entries WHERE tournament_id = $1 ORDER BY character_id',
    [tournamentId],
  );
  return result.rows;
}

export async function listLiveEntries(db: Db, tournamentId: string): Promise<TournamentEntryRow[]> {
  const result = await db.query<TournamentEntryRow>(
    `SELECT * FROM tournament_entries
     WHERE tournament_id = $1 AND eliminated_in_round IS NULL
     ORDER BY character_id`,
    [tournamentId],
  );
  return result.rows;
}

export async function findEntry(
  db: Db,
  tournamentId: string,
  characterId: string,
): Promise<TournamentEntryRow | null> {
  const result = await db.query<TournamentEntryRow>(
    'SELECT * FROM tournament_entries WHERE tournament_id = $1 AND character_id = $2',
    [tournamentId, characterId],
  );
  return result.rows[0] ?? null;
}

export async function updateEntry(
  client: DbClient | Db,
  tournamentId: string,
  characterId: string,
  patch: { currentStack?: number; eliminatedInRound?: number | null; finalRank?: number | null },
): Promise<void> {
  const columns: Record<string, unknown> = {
    current_stack: patch.currentStack,
    eliminated_in_round: patch.eliminatedInRound,
    final_rank: patch.finalRank,
  };
  const assignments: string[] = [];
  const values: unknown[] = [tournamentId, characterId];
  for (const [column, value] of Object.entries(columns)) {
    if (value === undefined) continue;
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  }
  if (assignments.length === 0) return;

  await client.query(
    `UPDATE tournament_entries SET ${assignments.join(', ')} WHERE tournament_id = $1 AND character_id = $2`,
    values,
  );
}

export async function insertTable(
  client: DbClient,
  input: { tournamentId: string; round: number; seats: { characterId: string; stack: number }[] },
): Promise<TournamentTableRow> {
  const table = await client.query<TournamentTableRow>(
    `INSERT INTO tournament_tables (id, tournament_id, round, state)
     VALUES ($1, $2, $3, 'pending') RETURNING *`,
    [uuidv7(), input.tournamentId, input.round],
  );
  const row = table.rows[0]!;

  for (const [seatIndex, seat] of input.seats.entries()) {
    await client.query(
      `INSERT INTO table_seats (table_id, seat_index, character_id, stack, starting_stack)
       VALUES ($1, $2, $3, $4, $4)`,
      [row.id, seatIndex, seat.characterId, seat.stack],
    );
  }
  return row;
}

export async function listTables(db: Db, tournamentId: string, round: number): Promise<TournamentTableRow[]> {
  const result = await db.query<TournamentTableRow>(
    'SELECT * FROM tournament_tables WHERE tournament_id = $1 AND round = $2 ORDER BY created_at',
    [tournamentId, round],
  );
  return result.rows;
}

/**
 * Whether any hand was ever dealt in this tournament. `hands_played` does not count hands
 * dealt despite its name — `completeTable` writes the winning-most player's hands *won* —
 * and it is written nowhere else, so it is non-zero exactly when that table played at least
 * one hand. The sum is therefore only meaningful as a zero/non-zero test, which is all this
 * is used for: zero across every table means the bracket collapsed without a card turning.
 */
export async function tournamentHandsPlayed(db: Db | DbClient, tournamentId: string): Promise<number> {
  const result = await db.query<{ hands: number }>(
    'SELECT COALESCE(SUM(hands_played), 0)::int AS hands FROM tournament_tables WHERE tournament_id = $1',
    [tournamentId],
  );
  return result.rows[0]?.hands ?? 0;
}

export async function listSeats(db: Db, tableId: string): Promise<TableSeatRow[]> {
  const result = await db.query<TableSeatRow>(
    'SELECT * FROM table_seats WHERE table_id = $1 ORDER BY seat_index',
    [tableId],
  );
  return result.rows;
}

export async function updateTable(
  client: DbClient | Db,
  tableId: string,
  patch: { state?: TableState; handsPlayed?: number; qualifierCharacterId?: string | null },
): Promise<void> {
  const columns: Record<string, unknown> = {
    state: patch.state,
    hands_played: patch.handsPlayed,
    qualifier_character_id: patch.qualifierCharacterId,
  };
  const assignments: string[] = [];
  const values: unknown[] = [tableId];
  for (const [column, value] of Object.entries(columns)) {
    if (value === undefined) continue;
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  }
  if (patch.state === 'complete') assignments.push('completed_at = now()');
  if (assignments.length === 0) return;

  await client.query(`UPDATE tournament_tables SET ${assignments.join(', ')} WHERE id = $1`, values);
}

export async function persistSeatStacks(
  client: DbClient | Db,
  tableId: string,
  seats: { seatIndex: number; stack: number; handsWon: number }[],
): Promise<void> {
  for (const seat of seats) {
    await client.query(
      'UPDATE table_seats SET stack = $3, hands_won = $4 WHERE table_id = $1 AND seat_index = $2',
      [tableId, seat.seatIndex, seat.stack, seat.handsWon],
    );
  }
}

export async function setSeatConnected(
  db: Db,
  tableId: string,
  characterId: string,
  connected: boolean,
): Promise<void> {
  await db.query('UPDATE table_seats SET connected = $3 WHERE table_id = $1 AND character_id = $2', [
    tableId,
    characterId,
    connected,
  ]);
}

export async function insertHand(
  db: Db,
  input: { tableId: string; handNumber: number; deckSeed: string; buttonSeat: number },
): Promise<string> {
  const id = uuidv7();
  await db.query(
    `INSERT INTO hands (id, table_id, hand_number, deck_seed, button_seat)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, input.tableId, input.handNumber, input.deckSeed, input.buttonSeat],
  );
  return id;
}

export async function updateHand(
  db: Db,
  handId: string,
  patch: {
    board: Card[];
    street: Street;
    potCoins: number;
    toActSeat: number | null;
    actionDeadlineAt: Date | null;
    completed?: boolean;
  },
): Promise<void> {
  await db.query(
    `UPDATE hands
     SET board = $2, street = $3, pot_coins = $4, to_act_seat = $5, action_deadline_at = $6,
         completed_at = CASE WHEN $7 THEN now() ELSE completed_at END
     WHERE id = $1`,
    [
      handId,
      patch.board,
      patch.street,
      patch.potCoins,
      patch.toActSeat,
      patch.actionDeadlineAt,
      patch.completed ?? false,
    ],
  );
}

export async function insertHandAction(
  db: Db,
  input: {
    handId: string;
    seq: number;
    seatIndex: number;
    street: Street;
    action: LoggedAction;
    amount: number;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO hand_actions (hand_id, seq, seat_index, street, action, amount)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (hand_id, seq) DO NOTHING`,
    [input.handId, input.seq, input.seatIndex, input.street, input.action, input.amount],
  );
}

export interface CharacterBadge {
  id: string;
  nickname: string;
  species_id: string;
  account_id: string | null;
}

export async function listCharacterBadges(db: Db, characterIds: string[]): Promise<CharacterBadge[]> {
  if (characterIds.length === 0) return [];
  const result = await db.query<CharacterBadge>(
    'SELECT id, nickname, species_id, account_id FROM characters WHERE id = ANY($1)',
    [characterIds],
  );
  return result.rows;
}

/** Every character eligible for a registration-close charge: alive and account-owned. */
export async function listEligibleCharacterIds(
  db: Db,
): Promise<{ id: string; tournament_opt_in: boolean }[]> {
  const result = await db.query<{ id: string; tournament_opt_in: boolean }>(
    `SELECT id, tournament_opt_in FROM characters
     WHERE deleted_at IS NULL AND account_id IS NOT NULL AND seated_table_id IS NULL
       AND active_duel_id IS NULL AND active_raid_id IS NULL
     ORDER BY id`,
  );
  return result.rows;
}
