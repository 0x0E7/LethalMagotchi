import type {
  ParityCall,
  RaidMemberState,
  RaidOutcome,
  RaidState,
} from '@lethalmagotchi/shared';
import { isUniqueViolation, withTransaction, type Db, type DbClient } from '../db/pool.js';

export interface RaidRow {
  id: string;
  initiator_character_id: string;
  target_character_id: string;
  state: RaidState;
  raider_pot_coins: number;
  target_pot_coins: number;
  outcome: RaidOutcome | null;
  pot_destroyed: boolean;
  parity_seed: string;
  created_at: Date;
  locked_at: Date | null;
  ended_at: Date | null;
  aftermath_acked_at: Date | null;
}

export interface RaidMemberRow {
  raid_id: string;
  character_id: string;
  state: RaidMemberState;
  is_initiator: boolean;
  pot_coins_at_lock: number | null;
  betrayed: boolean | null;
  betrayal_auto: boolean;
  coins_received: number | null;
  bankrupted_in_raid: boolean;
  invited_at: Date;
  responded_at: Date | null;
}

/** Every state a raid is still live in, and therefore still holds coins or locks for. */
export const LIVE_RAID_STATES: RaidState[] = ['assembling', 'resolving', 'betrayal', 'parity'];

/**
 * The subset a compensating cancel may claim: the two states in which no outcome has been
 * committed. `betrayal` and `parity` are deliberately excluded — reaching either *proves* a
 * settlement committed and drained the target, so refunding the raiders' escrow there would
 * pay the pot out twice. A raid stuck in those two is recovered by `abandonStaleRaids`,
 * which knows about the target's half of the pot.
 */
export const CANCELLABLE_RAID_STATES: RaidState[] = ['assembling', 'resolving'];

/* --------------------------------- raids -------------------------------- */

/**
 * Null means the partial unique index refused it: this target already has a live raid on
 * them. That is the anti-griefing answer, not an error — two parties assembling on the same
 * player resolve to exactly one raid here rather than to two settlements.
 */
export async function insertRaid(
  client: DbClient,
  input: {
    id: string;
    initiatorCharacterId: string;
    targetCharacterId: string;
    paritySeed: string;
    createdAt: Date;
  },
): Promise<RaidRow | null> {
  try {
    const result = await client.query<RaidRow>(
      `INSERT INTO raids (id, initiator_character_id, target_character_id, parity_seed, created_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.id, input.initiatorCharacterId, input.targetCharacterId, input.paritySeed, input.createdAt],
    );
    return result.rows[0]!;
  } catch (error) {
    if (isUniqueViolation(error, 'ux_raids_live_target')) return null;
    throw error;
  }
}

export async function findRaidById(db: Db | DbClient, raidId: string): Promise<RaidRow | null> {
  const result = await db.query<RaidRow>('SELECT * FROM raids WHERE id = $1', [raidId]);
  return result.rows[0] ?? null;
}

export async function lockRaidById(client: DbClient, raidId: string): Promise<RaidRow | null> {
  const result = await client.query<RaidRow>('SELECT * FROM raids WHERE id = $1 FOR UPDATE', [raidId]);
  return result.rows[0] ?? null;
}

/**
 * The single state transition, claimed conditionally. The transition *is* the mutual
 * exclusion: a retried settlement, a deferred settlement whose target came free, and a
 * concurrent cancel cannot each move the same coins.
 */
export async function claimRaidState(
  client: DbClient,
  raidId: string,
  input: { from: RaidState[]; to: RaidState },
): Promise<RaidRow | null> {
  const result = await client.query<RaidRow>(
    `UPDATE raids SET state = $3 WHERE id = $1 AND state = ANY($2::text[]) RETURNING *`,
    [raidId, input.from, input.to],
  );
  return result.rows[0] ?? null;
}

/** The settlement claim: the comparison's verdict and the escrow figures, written once. */
export async function claimRaidSettlement(
  client: DbClient,
  raidId: string,
  input: {
    outcome: RaidOutcome;
    raiderPotCoins: number;
    targetPotCoins: number;
    /** `betrayal` when the raiders won and the pot is still to be split; else `complete`. */
    nextState: RaidState;
    endedAt: Date | null;
  },
): Promise<RaidRow | null> {
  const result = await client.query<RaidRow>(
    `UPDATE raids
     SET state = $2,
         outcome = $3,
         raider_pot_coins = $4,
         target_pot_coins = $5,
         ended_at = $6
     WHERE id = $1 AND state = 'resolving'
     RETURNING *`,
    [raidId, input.nextState, input.outcome, input.raiderPotCoins, input.targetPotCoins, input.endedAt],
  );
  return result.rows[0] ?? null;
}

export async function lockRaid(
  client: DbClient,
  raidId: string,
  input: { raiderPotCoins: number; lockedAt: Date },
): Promise<RaidRow | null> {
  const result = await client.query<RaidRow>(
    `UPDATE raids SET state = 'resolving', raider_pot_coins = $2, locked_at = $3
     WHERE id = $1 AND state = 'assembling'
     RETURNING *`,
    [raidId, input.raiderPotCoins, input.lockedAt],
  );
  return result.rows[0] ?? null;
}

export async function completeRaid(
  client: DbClient,
  raidId: string,
  input: { potDestroyed: boolean; endedAt: Date },
): Promise<RaidRow | null> {
  const result = await client.query<RaidRow>(
    `UPDATE raids SET state = 'complete', pot_destroyed = $2, ended_at = $3
     WHERE id = $1 AND state IN ('betrayal', 'parity')
     RETURNING *`,
    [raidId, input.potDestroyed, input.endedAt],
  );
  return result.rows[0] ?? null;
}

/**
 * The compensating transition for a raid that never got off the ground, or whose settlement
 * could not be committed. Conditional on the raid still being pre-outcome: winning the claim
 * is the proof that no settlement committed, so there is no payout for the cancel to
 * contradict.
 */
export async function cancelRaidIfLive(
  client: DbClient,
  raidId: string,
  at: Date,
): Promise<RaidRow | null> {
  const result = await client.query<RaidRow>(
    `UPDATE raids SET state = 'cancelled', ended_at = $2
     WHERE id = $1 AND state = ANY($3::text[])
     RETURNING *`,
    [raidId, at, CANCELLABLE_RAID_STATES],
  );
  return result.rows[0] ?? null;
}

/**
 * Boot recovery, mirroring the duel sweep. A raid's live window lives in the runner's
 * memory, so a restarted process cannot resume one: it is cancelled, the *whole* pot is
 * returned to the wallets it came from, and every lock is released. Nobody is bankrupted by
 * a deploy.
 *
 * The whole pot, not just the raiders' escrow: a raid abandoned in `betrayal` or `parity`
 * has already committed a `raiders_won` settlement and drained the target into the pot,
 * while nobody has been paid a coin of it yet — `completeRaid` is one transaction, so a
 * payout either landed (state `complete`, never swept) or did not happen at all. Refunding
 * only `raid_members.pot_coins_at_lock` there would destroy the target's half. The outcome
 * is cleared with it: no coins moved, so the row must not claim one did, and the target must
 * not be shown an aftermath for a robbery that was handed back.
 *
 * All of it in one transaction, so a crash part-way through cannot leave a wallet emptied by
 * a raid that has already released the character who could notice.
 *
 * `createdBefore` is this process's boot instant — nothing newer can be a leftover — and the
 * caller holds an advisory lock on top of that, so a second instance cannot sweep a raid the
 * first one is still running.
 */
export async function abandonStaleRaids(db: Db, at: Date, createdBefore: Date): Promise<string[]> {
  return withTransaction(db, async (client) => {
    const cancelled = await client.query<{ id: string }>(
      `UPDATE raids SET state = 'cancelled', ended_at = $1
       WHERE state = ANY($3::text[]) AND created_at < $2
       RETURNING id`,
      [at, createdBefore, LIVE_RAID_STATES],
    );
    const raidIds = cancelled.rows.map((row) => row.id);
    if (raidIds.length === 0) return raidIds;

    await client.query(
      `UPDATE characters c
       SET lethal_coins = c.lethal_coins + m.pot_coins_at_lock, updated_at = now()
       FROM raid_members m
       WHERE m.raid_id = ANY($1::uuid[])
         AND m.character_id = c.id
         AND m.state = 'joined'
         AND m.pot_coins_at_lock IS NOT NULL
         AND m.coins_received IS NULL`,
      [raidIds],
    );
    await client.query(
      `UPDATE raid_members SET coins_received = pot_coins_at_lock
       WHERE raid_id = ANY($1::uuid[]) AND state = 'joined' AND pot_coins_at_lock IS NOT NULL
         AND coins_received IS NULL`,
      [raidIds],
    );
    await client.query(
      `UPDATE characters c
       SET lethal_coins = c.lethal_coins + r.target_pot_coins, updated_at = now()
       FROM raids r
       WHERE r.id = ANY($1::uuid[])
         AND r.target_character_id = c.id
         AND r.outcome = 'raiders_won'
         AND r.target_pot_coins > 0`,
      [raidIds],
    );
    await client.query(
      `UPDATE raids SET outcome = NULL, target_pot_coins = 0, pot_destroyed = false
       WHERE id = ANY($1::uuid[])`,
      [raidIds],
    );
    await client.query(
      `UPDATE characters SET active_raid_id = NULL, updated_at = now()
       WHERE active_raid_id = ANY($1::uuid[])`,
      [raidIds],
    );
    return raidIds;
  });
}

/**
 * The engagement locks on their own, for the case where the cancel transaction itself cannot
 * be written. A stale raid row is invisible to players; a stale `active_raid_id` refuses
 * every action, invite and purchase they attempt until the next restart.
 */
export async function releaseRaidLocks(db: Db | DbClient, raidId: string): Promise<void> {
  await db.query(
    'UPDATE characters SET active_raid_id = NULL, updated_at = now() WHERE active_raid_id = $1',
    [raidId],
  );
}

export async function findLiveRaidFor(db: Db | DbClient, characterId: string): Promise<RaidRow | null> {
  const result = await db.query<RaidRow>(
    `SELECT r.* FROM raids r
     JOIN raid_members m ON m.raid_id = r.id
     WHERE m.character_id = $1 AND m.state IN ('invited', 'joined') AND r.state = ANY($2::text[])
     ORDER BY r.created_at DESC
     LIMIT 1`,
    [characterId, LIVE_RAID_STATES],
  );
  return result.rows[0] ?? null;
}

/**
 * Raids this character was the target of whose aftermath they have not acknowledged yet.
 * Gated on `outcome`, not on `state`: the comparison is what happened to the target, and
 * they should not have to wait out a betrayal phase they are not part of to hear about it.
 *
 * Sticky until acknowledged, never time-boxed: this report is the only notification a
 * bankrupted offline victim ever gets, so a socket that drops mid-delivery must cost them a
 * reconnect, not the report.
 */
export async function listUnackedAftermaths(
  db: Db | DbClient,
  characterId: string,
): Promise<RaidRow[]> {
  const result = await db.query<RaidRow>(
    `SELECT * FROM raids
     WHERE target_character_id = $1
       AND outcome IS NOT NULL
       AND aftermath_acked_at IS NULL
     ORDER BY created_at`,
    [characterId],
  );
  return result.rows;
}

/** Written on the client's acknowledgment, never on the send. */
export async function markAftermathAcked(
  db: Db | DbClient,
  input: { raidId: string; characterId: string; at: Date },
): Promise<void> {
  await db.query(
    `UPDATE raids SET aftermath_acked_at = COALESCE(aftermath_acked_at, $3)
     WHERE id = $1 AND target_character_id = $2`,
    [input.raidId, input.characterId, input.at],
  );
}

/* ------------------------------- members -------------------------------- */

export async function insertRaidMember(
  client: DbClient,
  input: { raidId: string; characterId: string; state: RaidMemberState; isInitiator: boolean; at: Date },
): Promise<RaidMemberRow | null> {
  const result = await client.query<RaidMemberRow>(
    `INSERT INTO raid_members (raid_id, character_id, state, is_initiator, invited_at, responded_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (raid_id, character_id) DO NOTHING
     RETURNING *`,
    [
      input.raidId,
      input.characterId,
      input.state,
      input.isInitiator,
      input.at,
      input.state === 'joined' ? input.at : null,
    ],
  );
  return result.rows[0] ?? null;
}

export async function listRaidMembers(db: Db | DbClient, raidId: string): Promise<RaidMemberRow[]> {
  const result = await db.query<RaidMemberRow>(
    'SELECT * FROM raid_members WHERE raid_id = $1 ORDER BY is_initiator DESC, invited_at, character_id',
    [raidId],
  );
  return result.rows;
}

/**
 * The invitee's single transition, claimed conditionally, so a double-tapped Join and an
 * answer racing the 60s deadline resolve to one winner.
 */
export async function claimMemberResponse(
  client: DbClient,
  input: { raidId: string; characterId: string; state: 'joined' | 'declined' | 'expired'; at: Date },
): Promise<RaidMemberRow | null> {
  const result = await client.query<RaidMemberRow>(
    `UPDATE raid_members SET state = $3, responded_at = $4
     WHERE raid_id = $1 AND character_id = $2 AND state = 'invited'
     RETURNING *`,
    [input.raidId, input.characterId, input.state, input.at],
  );
  return result.rows[0] ?? null;
}

export async function expireOutstandingInvites(client: DbClient, raidId: string, at: Date): Promise<void> {
  await client.query(
    `UPDATE raid_members SET state = 'expired', responded_at = $2
     WHERE raid_id = $1 AND state = 'invited'`,
    [raidId, at],
  );
}

export async function recordEscrow(
  client: DbClient,
  input: { raidId: string; characterId: string; coins: number },
): Promise<void> {
  await client.query(
    'UPDATE raid_members SET pot_coins_at_lock = $3 WHERE raid_id = $1 AND character_id = $2',
    [input.raidId, input.characterId, input.coins],
  );
}

export async function recordMemberOutcome(
  client: DbClient,
  input: { raidId: string; characterId: string; coinsReceived: number; bankrupted: boolean },
): Promise<void> {
  await client.query(
    `UPDATE raid_members SET coins_received = $3, bankrupted_in_raid = $4
     WHERE raid_id = $1 AND character_id = $2`,
    [input.raidId, input.characterId, input.coinsReceived, input.bankrupted],
  );
}

export async function recordBetrayal(
  db: Db | DbClient,
  input: { raidId: string; characterId: string; betrayed: boolean; auto: boolean },
): Promise<void> {
  await db.query(
    `UPDATE raid_members SET betrayed = $3, betrayal_auto = $4
     WHERE raid_id = $1 AND character_id = $2`,
    [input.raidId, input.characterId, input.betrayed, input.auto],
  );
}

export async function insertParityAction(
  db: Db | DbClient,
  input: {
    raidId: string;
    round: number;
    seq: number;
    characterId: string;
    call: ParityCall;
    throw: number;
    auto: boolean;
    at: Date;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO raid_parity_actions (raid_id, round, seq, character_id, call, throw, auto_called, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (raid_id, round, character_id) DO NOTHING`,
    [
      input.raidId,
      input.round,
      input.seq,
      input.characterId,
      input.call,
      input.throw,
      input.auto,
      input.at,
    ],
  );
}

export async function listParityActions(
  db: Db,
  raidId: string,
): Promise<{ round: number; character_id: string; call: ParityCall; throw: number; auto_called: boolean }[]> {
  const result = await db.query<{
    round: number;
    character_id: string;
    call: ParityCall;
    throw: number;
    auto_called: boolean;
  }>(
    `SELECT round, character_id, call, throw, auto_called FROM raid_parity_actions
     WHERE raid_id = $1 ORDER BY round, character_id`,
    [raidId],
  );
  return result.rows;
}
