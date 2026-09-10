import type { DuelInviteState, DuelOutcome, DuelState, DuelThrow } from '@lethalmagotchi/shared';
import { isUniqueViolation, type Db, type DbClient } from '../db/pool.js';

export interface DuelInviteRow {
  id: string;
  from_character_id: string;
  to_character_id: string;
  state: DuelInviteState;
  created_at: Date;
  expires_at: Date;
  resolved_at: Date | null;
  duel_id: string | null;
  /** What the target was shown, and what the challenger is held to for the whole window. */
  stake_coins: number;
}

export interface DuelRow {
  id: string;
  invite_id: string;
  challenger_id: string;
  opponent_id: string;
  state: DuelState;
  round: number;
  replays_this_round: number;
  challenger_wins: number;
  opponent_wins: number;
  challenger_pot_coins: number;
  opponent_pot_coins: number;
  stake_coins: number;
  tiebreak_seed: string;
  outcome: DuelOutcome | null;
  winner_character_id: string | null;
  loser_character_id: string | null;
  coins_transferred: number | null;
  started_at: Date;
  ended_at: Date | null;
}

/* -------------------------------- invites ------------------------------- */

/**
 * Null means the partial unique index refused it: this challenger already has a live
 * invite out to this target. That is a real answer, not an error.
 */
export async function insertInvite(
  client: DbClient,
  input: {
    id: string;
    fromCharacterId: string;
    toCharacterId: string;
    createdAt: Date;
    expiresAt: Date;
    stakeCoins: number;
  },
): Promise<DuelInviteRow | null> {
  try {
    const result = await client.query<DuelInviteRow>(
      `INSERT INTO duel_invites (id, from_character_id, to_character_id, created_at, expires_at, stake_coins)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.id,
        input.fromCharacterId,
        input.toCharacterId,
        input.createdAt,
        input.expiresAt,
        input.stakeCoins,
      ],
    );
    return result.rows[0]!;
  } catch (error) {
    if (isUniqueViolation(error, 'ux_duel_invites_pending_pair')) return null;
    throw error;
  }
}

export async function findInviteById(db: Db | DbClient, inviteId: string): Promise<DuelInviteRow | null> {
  const result = await db.query<DuelInviteRow>('SELECT * FROM duel_invites WHERE id = $1', [inviteId]);
  return result.rows[0] ?? null;
}

/**
 * The invite's single state transition, as a conditional claim. Exactly one caller can win
 * it — a double-tapped Accept, an Accept racing the 60s expiry, and two tabs answering at
 * once all resolve to one winner and one loser, with no read-then-write in between.
 *
 * `expiresBefore` is the service clock rather than SQL `now()` so tests that drive a manual
 * clock see the same deadline the runner does.
 */
export async function claimInviteResolution(
  client: DbClient,
  input: {
    inviteId: string;
    state: Exclude<DuelInviteState, 'pending'>;
    resolvedAt: Date;
    /** The character allowed to make this transition — the responder, or the canceller. */
    byCharacterId: string;
    side: 'to' | 'from';
    /** Only for a player-driven transition: an invite already past its deadline cannot be answered. */
    notExpiredAt?: Date;
  },
): Promise<DuelInviteRow | null> {
  const column = input.side === 'to' ? 'to_character_id' : 'from_character_id';
  const result = await client.query<DuelInviteRow>(
    `UPDATE duel_invites
     SET state = $2, resolved_at = $3
     WHERE id = $1
       AND state = 'pending'
       AND ${column} = $4
       AND ($5::timestamptz IS NULL OR expires_at > $5)
     RETURNING *`,
    [input.inviteId, input.state, input.resolvedAt, input.byCharacterId, input.notExpiredAt ?? null],
  );
  return result.rows[0] ?? null;
}

/** The timer-driven half: no actor, and no deadline check — the deadline is why it runs. */
export async function claimInviteExpiry(
  db: Db | DbClient,
  inviteId: string,
  at: Date,
): Promise<DuelInviteRow | null> {
  const result = await db.query<DuelInviteRow>(
    `UPDATE duel_invites SET state = 'expired', resolved_at = $2
     WHERE id = $1 AND state = 'pending'
     RETURNING *`,
    [inviteId, at],
  );
  return result.rows[0] ?? null;
}

export async function attachDuelToInvite(
  client: DbClient,
  inviteId: string,
  duelId: string,
): Promise<void> {
  await client.query('UPDATE duel_invites SET duel_id = $2 WHERE id = $1', [inviteId, duelId]);
}

/**
 * What a challenger's live invites have already promised. Spending below this would make
 * the Stakes Card the target consented to a number that was never on the table.
 */
export async function reservedInviteStake(
  db: Db | DbClient,
  characterId: string,
  now: Date,
): Promise<number> {
  const result = await db.query<{ reserved: number }>(
    `SELECT COALESCE(MAX(stake_coins), 0)::int AS reserved FROM duel_invites
     WHERE from_character_id = $1 AND state = 'pending' AND expires_at > $2`,
    [characterId, now],
  );
  return result.rows[0]?.reserved ?? 0;
}

/** The per-pair decline cooldown, read straight off invite history. */
export async function lastDeclinedAt(
  db: Db | DbClient,
  fromCharacterId: string,
  toCharacterId: string,
): Promise<Date | null> {
  const result = await db.query<{ resolved_at: Date | null }>(
    `SELECT resolved_at FROM duel_invites
     WHERE from_character_id = $1 AND to_character_id = $2 AND state = 'declined'
     ORDER BY resolved_at DESC NULLS LAST
     LIMIT 1`,
    [fromCharacterId, toCharacterId],
  );
  return result.rows[0]?.resolved_at ?? null;
}

export async function listPendingInvitesFor(
  db: Db,
  characterId: string,
  now: Date,
): Promise<DuelInviteRow[]> {
  const result = await db.query<DuelInviteRow>(
    `SELECT * FROM duel_invites
     WHERE state = 'pending' AND expires_at > $2 AND (to_character_id = $1 OR from_character_id = $1)
     ORDER BY created_at`,
    [characterId, now],
  );
  return result.rows;
}

/* --------------------------------- duels -------------------------------- */

export async function insertDuel(
  client: DbClient,
  input: {
    id: string;
    inviteId: string;
    challengerId: string;
    opponentId: string;
    challengerPotCoins: number;
    opponentPotCoins: number;
    stakeCoins: number;
    tiebreakSeed: string;
    startedAt: Date;
  },
): Promise<DuelRow> {
  const result = await client.query<DuelRow>(
    `INSERT INTO duels (
       id, invite_id, challenger_id, opponent_id, challenger_pot_coins, opponent_pot_coins,
       stake_coins, tiebreak_seed, started_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      input.id,
      input.inviteId,
      input.challengerId,
      input.opponentId,
      input.challengerPotCoins,
      input.opponentPotCoins,
      input.stakeCoins,
      input.tiebreakSeed,
      input.startedAt,
    ],
  );
  return result.rows[0]!;
}

export async function findDuelById(db: Db | DbClient, duelId: string): Promise<DuelRow | null> {
  const result = await db.query<DuelRow>('SELECT * FROM duels WHERE id = $1', [duelId]);
  return result.rows[0] ?? null;
}

export async function updateDuelProgress(
  db: Db | DbClient,
  duelId: string,
  input: { round: number; replaysThisRound: number; challengerWins: number; opponentWins: number },
): Promise<void> {
  await db.query(
    `UPDATE duels
     SET round = $2, replays_this_round = $3, challenger_wins = $4, opponent_wins = $5
     WHERE id = $1 AND state = 'active'`,
    [duelId, input.round, input.replaysThisRound, input.challengerWins, input.opponentWins],
  );
}

/**
 * The settlement claim, in the shape poker's registration close and round advance already
 * use: the state transition *is* the mutual exclusion, so a retry, a second timer and a
 * concurrent shutdown cannot each pay the winner.
 */
export async function claimDuelSettlement(
  client: DbClient,
  duelId: string,
  input: {
    outcome: DuelOutcome;
    winnerCharacterId: string | null;
    loserCharacterId: string | null;
    coinsTransferred: number;
    challengerWins: number;
    opponentWins: number;
    endedAt: Date;
  },
): Promise<DuelRow | null> {
  const result = await client.query<DuelRow>(
    `UPDATE duels
     SET state = $2,
         outcome = $3,
         winner_character_id = $4,
         loser_character_id = $5,
         coins_transferred = $6,
         challenger_wins = $7,
         opponent_wins = $8,
         ended_at = $9
     WHERE id = $1 AND state = 'active'
     RETURNING *`,
    [
      duelId,
      input.outcome === 'death' ? 'complete' : 'aborted',
      input.outcome,
      input.winnerCharacterId,
      input.loserCharacterId,
      input.coinsTransferred,
      input.challengerWins,
      input.opponentWins,
      input.endedAt,
    ],
  );
  return result.rows[0] ?? null;
}

export async function insertDuelAction(
  db: Db | DbClient,
  input: {
    duelId: string;
    round: number;
    replay: number;
    seq: number;
    characterId: string;
    throw: DuelThrow;
    autoThrown: boolean;
    at: Date;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO duel_actions (duel_id, round, replay, seq, character_id, throw, auto_thrown, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (duel_id, round, replay, character_id) DO NOTHING`,
    [
      input.duelId,
      input.round,
      input.replay,
      input.seq,
      input.characterId,
      input.throw,
      input.autoThrown,
      input.at,
    ],
  );
}

export async function listDuelActions(db: Db, duelId: string): Promise<
  { round: number; replay: number; seq: number; character_id: string; throw: DuelThrow; auto_thrown: boolean }[]
> {
  const result = await db.query<{
    round: number;
    replay: number;
    seq: number;
    character_id: string;
    throw: DuelThrow;
    auto_thrown: boolean;
  }>(
    `SELECT round, replay, seq, character_id, throw, auto_thrown FROM duel_actions
     WHERE duel_id = $1 ORDER BY round, replay, character_id`,
    [duelId],
  );
  return result.rows;
}

export async function listActiveDuels(db: Db): Promise<DuelRow[]> {
  const result = await db.query<DuelRow>("SELECT * FROM duels WHERE state = 'active' ORDER BY started_at");
  return result.rows;
}

/**
 * Boot recovery, mirroring the tournament's stale-seat sweep. A duel whose in-memory runner
 * died with the process cannot be resumed — its round timers and locked throws were never
 * persisted — so it is abandoned without a death and without coins moving. Nobody dies for
 * a server restart.
 *
 * `startedBefore` is this process's boot instant: nothing created after it can be a
 * leftover, and the locks are cleared only for the duels this sweep actually aborted rather
 * than for every character in the table. The caller holds an advisory lock on top of that,
 * which is what stops a second instance from sweeping a duel the first one is still playing.
 */
export async function abortAbandonedDuels(db: Db, at: Date, startedBefore: Date): Promise<number> {
  const aborted = await db.query<{ id: string }>(
    `UPDATE duels SET state = 'aborted', outcome = 'abort', coins_transferred = 0, ended_at = $1
     WHERE state = 'active' AND started_at < $2
     RETURNING id`,
    [at, startedBefore],
  );
  const duelIds = aborted.rows.map((row) => row.id);
  if (duelIds.length > 0) {
    await db.query(
      `UPDATE characters SET active_duel_id = NULL, updated_at = now()
       WHERE active_duel_id = ANY($1::uuid[])`,
      [duelIds],
    );
  }
  await db.query(
    `UPDATE duel_invites SET state = 'expired', resolved_at = $1
     WHERE state = 'pending' AND created_at < $2`,
    [at, startedBefore],
  );
  return duelIds.length;
}

/**
 * The compensating transition for a settlement that could not be committed: exactly what the
 * boot sweep does, scoped to one duel and run immediately, so neither duelist is left locked
 * to a match that will never pay out. No death, no rebirth, no coins moved.
 */
export async function abortDuel(client: DbClient, duelId: string, at: Date): Promise<DuelRow | null> {
  const duel = await claimDuelAbort(client, duelId, at);
  await releaseDuelLocks(client, duelId);
  return duel;
}

/**
 * The same transition for the case where the settlement's outcome could never be read back:
 * winning the claim is the proof that no settlement committed, so the locks are released
 * only then. Freeing the loser's wallet while a settler is still in flight would let them
 * spend below the stake and shortchange the winner through the payout clamp.
 */
export async function abortDuelIfActive(
  client: DbClient,
  duelId: string,
  at: Date,
): Promise<DuelRow | null> {
  const duel = await claimDuelAbort(client, duelId, at);
  if (duel) await releaseDuelLocks(client, duelId);
  return duel;
}

async function claimDuelAbort(client: DbClient, duelId: string, at: Date): Promise<DuelRow | null> {
  const result = await client.query<DuelRow>(
    `UPDATE duels
     SET state = 'aborted', outcome = 'abort', coins_transferred = 0, ended_at = $2
     WHERE id = $1 AND state = 'active'
     RETURNING *`,
    [duelId, at],
  );
  return result.rows[0] ?? null;
}

/**
 * The engagement locks on their own, for the case where the abort transaction itself cannot
 * be written. A stale duel row is invisible to players; a stale `active_duel_id` refuses
 * every action, invite and delete they attempt until the next restart, so releasing it is
 * worth attempting even when nothing else can be.
 */
export async function releaseDuelLocks(db: Db | DbClient, duelId: string): Promise<void> {
  await db.query(
    `UPDATE characters SET active_duel_id = NULL, updated_at = now() WHERE active_duel_id = $1`,
    [duelId],
  );
}
