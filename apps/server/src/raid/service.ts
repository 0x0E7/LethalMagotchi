import { randomBytes } from 'node:crypto';
import {
  RAID_ASSEMBLY_TTL_MS,
  RAID_BETRAYAL_MS,
  RAID_BUSY_DEFER_MS,
  RAID_BUSY_POLL_MS,
  RAID_ERROR_MESSAGES,
  RAID_INVITE_TTL_MS,
  RAID_MAX_RAIDERS,
  RAID_MIN_RAIDERS,
  RAID_PARITY_MS,
  RAID_REVEAL_MS,
  isBeggarWallet,
  isOldEnoughToRaid,
  isRaidImmune,
  isRaidableWealth,
  isRaiderCooldownActive,
  raidImmunityUntil,
  resolveRaidOutcome,
  wealthBandOf,
  type ClientMessage,
  type RaidErrorCode,
  type RaidMemberView,
  type RaidOutcome,
  type RaidTargetView,
  type ServerMessage,
} from '@lethalmagotchi/shared';
import { RAID_RECOVERY_LOCK_KEY } from '../db/advisory-locks.js';
import { withTransaction, type Db, type DbClient } from '../db/pool.js';
import type { Limiters } from '../deps.js';
import {
  creditCoins,
  drainCoins,
  findCharacterById,
  isEngaged,
  lockCharacterById,
  recordRaidParticipation,
  setActiveRaid,
  toCharacterDto,
  type CharacterRow,
} from '../repos/characters.js';
import { isBlockedEitherWay } from '../repos/chat.js';
import {
  abandonStaleRaids,
  cancelRaidIfLive,
  claimMemberResponse,
  claimRaidSettlement,
  completeRaid,
  expireOutstandingInvites,
  findLiveRaidFor,
  findRaidById,
  insertRaid,
  insertRaidMember,
  listRaidMembers,
  listUnackedAftermaths,
  lockRaid,
  markAftermathAcked,
  recordEscrow,
  recordMemberOutcome,
  releaseRaidLocks,
  type RaidMemberRow,
  type RaidRow,
} from '../repos/raids.js';
import { systemClock, type Clock, type Timer } from '../tournament/clock.js';
import { uuidv7 } from '../uuid.js';
import type { Connection, Hub } from '../ws/hub.js';
import { RaidRunner, type RaidSplit } from './runner.js';

export interface RaidServiceOptions {
  db: Db;
  hub: Hub;
  limiters: Limiters;
  clock?: Clock;
  betrayalMs?: number;
  parityMs?: number;
  revealMs?: number;
  assemblyTtlMs?: number;
  busyDeferMs?: number;
  busyPollMs?: number;
  /** The backoff the undetermined-settlement recovery walks; the last step is its floor. */
  settlementRecoveryDelaysMs?: number[];
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

const SETTLEMENT_RECOVERY_DELAYS_MS = [1_000, 5_000, 30_000];

/** Thrown inside a transaction to roll its claim back with it. */
class RaidBlocked extends Error {
  readonly code: RaidErrorCode;

  constructor(code: RaidErrorCode) {
    super(code);
    this.code = code;
  }
}

/** A payout that is known to have committed, with the awards that actually landed. */
interface Paid {
  awards: Record<string, number>;
  potDestroyed: boolean;
}

interface Settled {
  raidId: string;
  outcome: RaidOutcome;
  raidPot: number;
  targetPot: number;
  /** What the betrayal phase is played for. Zero unless the raiders won. */
  potCoins: number;
  raiders: { characterId: string; nickname: string; speciesId: string }[];
  targetCharacterId: string;
  target: CharacterRow | null;
  bankrupted: string[];
  /** Carried from the raid row so the capped parity round never has to go back for it. */
  paritySeed: string;
  endedAt: Date | null;
}

export type ClientRaidMessage = Extract<ClientMessage, { type: `raid:${string}` }>;

export class RaidService {
  private readonly db: Db;
  private readonly hub: Hub;
  private readonly limiters: Limiters;
  private readonly clock: Clock;
  private readonly betrayalMs: number;
  private readonly parityMs: number;
  private readonly revealMs: number;
  private readonly assemblyTtlMs: number;
  private readonly busyDeferMs: number;
  private readonly busyPollMs: number;
  private readonly recoveryDelaysMs: number[];
  private readonly log: (message: string, meta?: Record<string, unknown>) => void;

  private readonly runners = new Map<string, RaidRunner>();
  private readonly runnersByCharacter = new Map<string, RaidRunner>();
  private readonly assemblyTimers = new Map<string, Timer>();
  private readonly deferTimers = new Map<string, Timer>();
  private readonly recoveryTimers = new Map<string, Timer>();
  /** One chain per raid, so settlement can never interleave with itself or a shutdown. */
  private readonly chains = new Map<string, Promise<unknown>>();
  private stopped = false;
  private lockClient: DbClient | null = null;
  private starting: Promise<void> | null = null;

  constructor(options: RaidServiceOptions) {
    this.db = options.db;
    this.hub = options.hub;
    this.limiters = options.limiters;
    this.clock = options.clock ?? systemClock;
    this.betrayalMs = options.betrayalMs ?? RAID_BETRAYAL_MS;
    this.parityMs = options.parityMs ?? RAID_PARITY_MS;
    this.revealMs = options.revealMs ?? RAID_REVEAL_MS;
    this.assemblyTtlMs = options.assemblyTtlMs ?? RAID_ASSEMBLY_TTL_MS;
    this.busyDeferMs = options.busyDeferMs ?? RAID_BUSY_DEFER_MS;
    this.busyPollMs = options.busyPollMs ?? RAID_BUSY_POLL_MS;
    this.recoveryDelaysMs = options.settlementRecoveryDelaysMs ?? SETTLEMENT_RECOVERY_DELAYS_MS;
    this.log = options.log ?? (() => {});
  }

  /**
   * A raid's live window lives in the runner's memory, so a restarted process cannot resume
   * one. Abandoning them is the only honest recovery: every escrow goes back to the wallet
   * it came from and every lock is released, so nobody is bankrupted by a deploy.
   *
   * Gated behind an advisory lock held for the process's lifetime and scoped to raids that
   * predate this process, exactly as the duel sweep is: without both, a second instance
   * coming up mid-raid would refund escrows the first instance is still playing for.
   */
  async start(): Promise<void> {
    if (this.stopped) return;
    this.starting ??= this.startOnce().finally(() => {
      this.starting = null;
    });
    await this.starting;
  }

  private async startOnce(): Promise<void> {
    const bootAt = new Date(this.clock.now());
    this.lockClient = await this.db.connect();
    const held = await this.lockClient.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [RAID_RECOVERY_LOCK_KEY],
    );
    if (!held.rows[0]?.locked) {
      this.lockClient.release();
      this.lockClient = null;
      this.log('raid recovery sweep skipped: lock held elsewhere');
      return;
    }

    const abandoned = await abandonStaleRaids(this.db, bootAt, bootAt);
    if (abandoned.length > 0) this.log('abandoned raids cancelled on boot', { count: abandoned.length });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.starting?.catch(() => undefined);
    for (const timer of [...this.assemblyTimers.values(), ...this.deferTimers.values(), ...this.recoveryTimers.values()]) {
      timer.cancel();
    }
    this.assemblyTimers.clear();
    this.deferTimers.clear();
    this.recoveryTimers.clear();
    for (const runner of this.runners.values()) await runner.stop();
    this.runners.clear();
    this.runnersByCharacter.clear();
    await Promise.allSettled([...this.chains.values()]);
    if (this.lockClient) {
      await this.lockClient.query('SELECT pg_advisory_unlock($1)', [RAID_RECOVERY_LOCK_KEY]);
      this.lockClient.release();
      this.lockClient = null;
    }
  }

  /* --------------------------- socket hooks --------------------------- */

  onCharacterOnline(characterId: string): void {
    this.runnersByCharacter.get(characterId)?.resync(characterId);
    void this.resyncState(characterId).catch((error: unknown) =>
      this.log('raid resync failed', { characterId, error }),
    );
  }

  /**
   * Deliberately empty. A raid never pauses for a missing raider: the betrayal deadline
   * keeps running and an absent raider is recorded Loyal, which is the same consequence a
   * duel's auto-throw has, minus the lethality.
   */
  onCharacterOffline(_characterId: string): void {}

  /* ------------------------------ frames ------------------------------ */

  async handle(connection: Connection, message: ClientRaidMessage): Promise<void> {
    const characterId = connection.characterId;
    if (!characterId) {
      this.error(connection, 'NO_CHARACTER');
      return;
    }

    /**
     * Charged before the frame's content is looked at, in the order chat settled on: a
     * garbage or impossible frame must cost the same budget as a real one, or it buys a
     * free attempt.
     */
    const budget =
      message.type === 'raid:create'
        ? this.limiters.raidCreate.check(connection.accountId)
        : message.type === 'raid:resync'
          ? this.limiters.raidResync.check(connection.accountId)
          : this.limiters.raidAction.check(connection.accountId);
    if (!budget.allowed) {
      this.error(connection, 'RATE_LIMITED');
      return;
    }

    switch (message.type) {
      case 'raid:create':
        await this.create(connection, characterId, message.targetCharacterId);
        return;
      case 'raid:invite':
        await this.invite(connection, characterId, message.raidId, message.characterId);
        return;
      case 'raid:respond':
        await this.respond(connection, characterId, message.raidId, message.accept);
        return;
      case 'raid:lock':
        await this.lock(connection, characterId, message.raidId);
        return;
      case 'raid:betray': {
        const runner = this.runnersByCharacter.get(characterId);
        if (!runner) {
          this.error(connection, 'NOT_FOUND');
          return;
        }
        runner.betray(characterId, message);
        return;
      }
      case 'raid:parity': {
        const runner = this.runnersByCharacter.get(characterId);
        if (!runner) {
          this.error(connection, 'NOT_FOUND');
          return;
        }
        runner.parity(characterId, message);
        return;
      }
      case 'raid:resync':
        this.runnersByCharacter.get(characterId)?.resync(characterId);
        await this.resyncState(characterId);
        return;
      case 'raid:aftermath_ack':
        await this.ackAftermath(characterId, message.raidId);
        return;
    }
  }

  /* ----------------------------- assembling ---------------------------- */

  private async create(connection: Connection, characterId: string, targetId: string): Promise<void> {
    if (targetId === characterId) {
      this.error(connection, 'SELF');
      return;
    }

    const now = this.clock.now();
    const me = await findCharacterById(this.db, characterId);
    if (!me || me.deleted_at) {
      this.error(connection, 'NO_CHARACTER');
      return;
    }
    const target = await findCharacterById(this.db, targetId);
    if (!target || target.deleted_at || !target.account_id) {
      this.error(connection, 'NOT_FOUND');
      return;
    }

    const refusal = this.raiderRefusal(me, now) ?? this.targetRefusal(target, now);
    if (refusal) {
      this.error(connection, refusal);
      return;
    }
    if (await isBlockedEitherWay(this.db, connection.accountId, target.account_id)) {
      this.error(connection, 'BLOCKED');
      return;
    }

    let raid: RaidRow | null;
    try {
      raid = await withTransaction(this.db, async (client) => {
        /**
         * Re-checked under the row lock rather than trusted from the read above, exactly as
         * `respond` does it: the engagement lock is written here, so a second `raid:create`
         * in the same tick and a table seating landing in the same window both have to
         * queue behind this row and find the leg already taken.
         */
        const row = await lockCharacterById(client, characterId);
        if (!row) throw new RaidBlocked('NO_CHARACTER');
        const blocked = this.raiderRefusal(row, now);
        if (blocked) throw new RaidBlocked(blocked);

        const inserted = await insertRaid(client, {
          id: uuidv7(),
          initiatorCharacterId: characterId,
          targetCharacterId: targetId,
          // Persisted for audit/replay: the capped parity round's split derives from it.
          paritySeed: randomBytes(32).toString('hex'),
          createdAt: new Date(now),
        });
        if (!inserted) return null;
        await insertRaidMember(client, {
          raidId: inserted.id,
          characterId,
          state: 'joined',
          isInitiator: true,
          at: new Date(now),
        });
        // The engagement lock lands at join, not at lock-in: a raider who has committed to a
        // party must not also be able to sit down at a table or accept a duel while it forms.
        await setActiveRaid(client, characterId, inserted.id);
        return inserted;
      });
    } catch (error) {
      if (error instanceof RaidBlocked) {
        this.error(connection, error.code);
        return;
      }
      throw error;
    }

    if (!raid) {
      this.error(connection, 'TARGET_IMMUNE');
      return;
    }

    this.armAssemblyExpiry(raid, now);
    await this.announceParty(raid.id);
  }

  private async invite(
    connection: Connection,
    characterId: string,
    raidId: string,
    inviteeId: string,
  ): Promise<void> {
    if (inviteeId === characterId) {
      this.error(connection, 'SELF');
      return;
    }
    const now = this.clock.now();
    const raid = await findRaidById(this.db, raidId);
    if (!raid || raid.state !== 'assembling') {
      this.error(connection, 'NOT_FOUND');
      return;
    }
    if (raid.initiator_character_id !== characterId) {
      this.error(connection, 'NOT_INITIATOR');
      return;
    }
    if (inviteeId === raid.target_character_id) {
      this.error(connection, 'SELF');
      return;
    }

    const members = await listRaidMembers(this.db, raidId);
    if (members.some((member) => member.character_id === inviteeId)) {
      this.error(connection, 'ALREADY_INVITED');
      return;
    }
    if (members.filter((member) => member.state === 'invited' || member.state === 'joined').length >= RAID_MAX_RAIDERS) {
      this.error(connection, 'PARTY_FULL');
      return;
    }

    const invitee = await findCharacterById(this.db, inviteeId);
    if (!invitee || invitee.deleted_at || !invitee.account_id) {
      this.error(connection, 'NOT_FOUND');
      return;
    }
    const refusal = this.raiderRefusal(invitee, now);
    if (refusal) {
      this.error(connection, refusal === 'BUSY' ? 'BUSY' : refusal);
      return;
    }
    if (await isBlockedEitherWay(this.db, connection.accountId, invitee.account_id)) {
      this.error(connection, 'BLOCKED');
      return;
    }

    const member = await withTransaction(this.db, (client) =>
      insertRaidMember(client, {
        raidId,
        characterId: inviteeId,
        state: 'invited',
        isInitiator: false,
        at: new Date(now),
      }),
    );
    if (!member) {
      this.error(connection, 'ALREADY_INVITED');
      return;
    }

    const initiator = await findCharacterById(this.db, raid.initiator_character_id);
    const target = await findCharacterById(this.db, raid.target_character_id);
    if (initiator && target) {
      this.hub.sendToCharacter(inviteeId, {
        type: 'raid:invited',
        raidId,
        from: memberView(initiator, { state: 'joined', isInitiator: true }),
        target: targetView(target),
        expiresAt: new Date(raid.created_at.getTime() + this.assemblyTtlMs).toISOString(),
      });
    }
    await this.announceParty(raidId);
  }

  private async respond(
    connection: Connection,
    characterId: string,
    raidId: string,
    accept: boolean,
  ): Promise<void> {
    const now = this.clock.now();
    let claimed: RaidMemberRow | null;
    try {
      claimed = await withTransaction(this.db, async (client) => {
        const raid = await findRaidById(client, raidId);
        if (!raid || raid.state !== 'assembling') throw new RaidBlocked('EXPIRED');

        const member = await claimMemberResponse(client, {
          raidId,
          characterId,
          state: accept ? 'joined' : 'declined',
          at: new Date(now),
        });
        if (!member) return null;
        if (!accept) return member;

        /**
         * Re-checked under the row lock rather than trusted from the invite: a raider who
         * sat down at a table or accepted a duel during the window is no longer free to
         * commit their wallet to this.
         */
        const row = await lockCharacterById(client, characterId);
        if (!row) throw new RaidBlocked('NO_CHARACTER');
        const refusal = this.raiderRefusal(row, now);
        if (refusal) throw new RaidBlocked(refusal);

        await setActiveRaid(client, characterId, raidId);
        return member;
      });
    } catch (error) {
      if (error instanceof RaidBlocked) {
        this.error(connection, error.code);
        return;
      }
      throw error;
    }

    if (!claimed) {
      this.error(connection, 'EXPIRED');
      return;
    }
    await this.announceParty(raidId);
  }

  /* ------------------------------ lock-in ------------------------------ */

  private async lock(connection: Connection, characterId: string, raidId: string): Promise<void> {
    const now = this.clock.now();
    let locked: RaidRow | null;
    try {
      locked = await withTransaction(this.db, async (client) => {
        const raid = await findRaidById(client, raidId);
        if (!raid || raid.state !== 'assembling') throw new RaidBlocked('EXPIRED');
        if (raid.initiator_character_id !== characterId) throw new RaidBlocked('NOT_INITIATOR');

        const members = await listRaidMembers(client, raidId);
        const joined = members.filter((member) => member.state === 'joined');
        if (joined.length < RAID_MIN_RAIDERS) throw new RaidBlocked('PARTY_TOO_SMALL');

        /**
         * Ordered by character id, like every multi-character write here: a raid touches up
         * to four rows, so a fixed order is what stops two raids sharing a raider from
         * deadlocking on each other.
         */
        const ordered = joined.map((member) => member.character_id).sort();
        let raiderPot = 0;
        for (const raiderId of ordered) {
          const row = await lockCharacterById(client, raiderId);
          if (!row) throw new RaidBlocked('NOT_FOUND');
          if (row.active_raid_id !== raidId) throw new RaidBlocked('BUSY');
          if (row.seated_table_id ?? row.active_duel_id) throw new RaidBlocked('BUSY');

          // The escrow: a raid stakes the *whole* wallet, so a raider cannot spend a coin
          // they have already committed.
          const drained = await drainCoins(client, raiderId);
          raiderPot += drained.taken;
          await recordEscrow(client, { raidId, characterId: raiderId, coins: drained.taken });
        }

        await expireOutstandingInvites(client, raidId, new Date(now));
        return lockRaid(client, raidId, { raiderPotCoins: raiderPot, lockedAt: new Date(now) });
      });
    } catch (error) {
      if (error instanceof RaidBlocked) {
        this.error(connection, error.code);
        return;
      }
      throw error;
    }

    if (!locked) {
      this.error(connection, 'EXPIRED');
      return;
    }

    this.assemblyTimers.get(raidId)?.cancel();
    this.assemblyTimers.delete(raidId);
    await this.announceParty(raidId);
    for (const raiderId of await this.joinedIds(raidId)) {
      const row = await findCharacterById(this.db, raiderId);
      if (row) this.hub.sendToCharacter(raiderId, { type: 'character:update', character: toCharacterDto(row, now) });
    }

    if (this.stopped) {
      await this.cancelAndAnnounce(raidId, 'SERVER_RESTART');
      return;
    }
    this.scheduleSettlement(locked, 0);
  }

  private armAssemblyExpiry(raid: RaidRow, now: number): void {
    const delay = Math.max(0, raid.created_at.getTime() + this.assemblyTtlMs - now);
    this.assemblyTimers.set(
      raid.id,
      this.clock.after(delay, () => {
        this.assemblyTimers.delete(raid.id);
        void this.serialize(raid.id, async () => {
          const current = await findRaidById(this.db, raid.id);
          // An assembly that never fired releases everyone: nobody's coins have moved yet,
          // so there is nothing to compensate beyond the engagement locks.
          if (current?.state === 'assembling') await this.cancelAndAnnounce(raid.id, 'EXPIRED');
        }).catch((error: unknown) => this.log('raid assembly expiry failed', { raidId: raid.id, error }));
      }),
    );
  }

  /* ---------------------------- settlement ----------------------------- */

  private scheduleSettlement(raid: RaidRow, attempt: number): void {
    if (this.stopped) return;
    void this.serialize(raid.id, () => this.settle(raid, attempt)).catch((error: unknown) =>
      this.log('raid settlement failed', { raidId: raid.id, error }),
    );
  }

  /**
   * The whole settlement. Only an outcome that provably moved nothing takes the compensating
   * cancel; an outcome that cannot be established at all is handed to the recovery backoff,
   * because every frame available to send would be a claim about money that may be false.
   */
  private async settle(raid: RaidRow, attempt: number): Promise<void> {
    const deferred = await this.deferIfTargetBusy(raid);
    if (deferred) return;

    const settled = await this.resolveSettlement(raid);
    if (settled === 'undetermined') {
      this.log('raid settlement outcome undetermined; retrying', { raidId: raid.id });
      this.scheduleSettlementRecovery(raid, attempt);
      return;
    }
    if (!settled) {
      // The claim was conclusively never made, so nothing moved and nobody is committed.
      if (attempt >= this.recoveryDelaysMs.length - 1) {
        await this.cancelAndAnnounce(raid.id, 'SERVER_RESTART');
        return;
      }
      this.scheduleSettlementRecovery(raid, attempt);
      return;
    }

    try {
      this.announceSettlement(settled);
    } catch (error) {
      this.log('raid settlement announce failed', { raidId: raid.id, error });
    }
    await this.deliverAftermath(settled.targetCharacterId);

    if (settled.outcome !== 'raiders_won') {
      this.retire(raid.id);
      return;
    }
    this.startRunner(settled);
  }

  private scheduleSettlementRecovery(raid: RaidRow, attempt: number): void {
    if (this.stopped) return;
    const delay = this.recoveryDelaysMs[Math.min(attempt, this.recoveryDelaysMs.length - 1)]!;
    const timer = this.clock.after(delay, () => {
      this.recoveryTimers.delete(raid.id);
      this.scheduleSettlement(raid, attempt + 1);
    });
    // One recovery timer per raid: settlement and payout share this map, so whichever
    // schedules last owns the slot and the other must not be left running unreferenced.
    this.recoveryTimers.get(raid.id)?.cancel();
    this.recoveryTimers.set(raid.id, timer);
  }

  /**
   * The escrow has already left the raiders' wallets, so comparing `targetPot` against a
   * wallet that is mid-hand, mid-duel or staked in a raid of the target's own would compare
   * it against a number that materially misrepresents their wealth — a raid stakes the whole
   * wallet, so a target who is a raider elsewhere reads as holding nothing. This is a
   * data-integrity gate, not a consent gate: it waits for them to finish, and after ten
   * minutes the raid voids with nobody bankrupted. Being *targeted* by another raid does not
   * take the lock and so does not defer, which is the existing design.
   */
  private async deferIfTargetBusy(raid: RaidRow): Promise<boolean> {
    const target = await findCharacterById(this.db, raid.target_character_id);
    if (!target || !(target.seated_table_id ?? target.active_duel_id ?? target.active_raid_id)) {
      return false;
    }

    const lockedAt = raid.locked_at?.getTime() ?? this.clock.now();
    if (this.clock.now() - lockedAt >= this.busyDeferMs) {
      this.log('raid target stayed busy; voiding', { raidId: raid.id });
      // Called directly, not through `serialize`: this already runs inside this raid's
      // chain, and re-entering it would wait on the task that is making the call.
      await this.voidForBusyTarget(raid);
      return true;
    }

    const timer = this.clock.after(this.busyPollMs, () => {
      this.deferTimers.delete(raid.id);
      this.scheduleSettlement(raid, 0);
    });
    this.deferTimers.set(raid.id, timer);
    return true;
  }

  private async voidForBusyTarget(raid: RaidRow): Promise<void> {
    const settled = await this.resolveSettlement(raid, { forceVoid: true });
    if (!settled || settled === 'undetermined') {
      await this.cancelAndAnnounce(raid.id, 'SERVER_RESTART');
      return;
    }
    this.announceSettlement(settled);
    await this.deliverAftermath(settled.targetCharacterId);
    this.retire(raid.id);
  }

  /**
   * What this raid settled as, from the attempt if it can say and from the database if it
   * cannot. `null` means, and only means, that the read-back conclusively determined nothing
   * was committed; `'undetermined'` means it could not tell.
   */
  private async resolveSettlement(
    raid: RaidRow,
    options: { forceVoid?: boolean } = {},
  ): Promise<Settled | null | 'undetermined'> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const settled = await this.settleOnce(raid, options);
        if (settled) return settled;
        break;
      } catch (error) {
        this.log('raid settlement attempt failed', { raidId: raid.id, attempt: attempt + 1, error });
      }
    }
    return this.readBackSettlement(raid);
  }

  /**
   * The settlement as the database has it, for the case where this call could not tell it had
   * one. An attempt whose COMMIT acknowledgment is lost has already moved the coins; the
   * retry then loses the claim to that committed row and reports nothing. Reading it back is
   * what stops a real bankruptcy that nobody is ever told about.
   */
  private async readBackSettlement(raid: RaidRow): Promise<Settled | null | 'undetermined'> {
    let read: Settled | null | undefined;
    for (let attempt = 0; attempt < 2 && read === undefined; attempt += 1) {
      try {
        read = await this.persistedSettlement(raid.id);
      } catch (error) {
        this.log('raid settlement read-back attempt failed', {
          raidId: raid.id,
          attempt: attempt + 1,
          error,
        });
      }
    }
    return read === undefined ? 'undetermined' : read;
  }

  private async persistedSettlement(raidId: string): Promise<Settled | null> {
    const raid = await findRaidById(this.db, raidId);
    if (!raid || raid.outcome === null) return null;
    const members = await listRaidMembers(this.db, raidId);
    const joined = members.filter((member) => member.state === 'joined');
    const raiders = await this.raiderViews(joined.map((member) => member.character_id));
    const target = await findCharacterById(this.db, raid.target_character_id);

    return {
      raidId,
      outcome: raid.outcome,
      raidPot: raid.raider_pot_coins,
      targetPot: raid.target_pot_coins,
      potCoins: raid.outcome === 'raiders_won' ? raid.raider_pot_coins + raid.target_pot_coins : 0,
      raiders,
      targetCharacterId: raid.target_character_id,
      target,
      bankrupted:
        raid.outcome === 'raiders_won'
          ? [raid.target_character_id]
          : raid.outcome === 'target_won'
            ? joined.map((member) => member.character_id)
            : [],
      paritySeed: raid.parity_seed,
      endedAt: raid.ended_at,
    };
  }

  /**
   * The comparison and every coin it moves, one transaction, character rows locked in id
   * order. Strictly a coin-ledger operation: no HP is read or written, no stats are touched
   * and no rebirth is ever recorded, on any branch.
   */
  private async settleOnce(raid: RaidRow, options: { forceVoid?: boolean }): Promise<Settled | null> {
    const at = new Date(this.clock.now());

    return withTransaction(this.db, async (client) => {
      const members = await listRaidMembers(client, raid.id);
      const joined = members.filter((member) => member.state === 'joined');
      const raiderIds = joined.map((member) => member.character_id);

      const ordered = [...raiderIds, raid.target_character_id].sort();
      const rows = new Map<string, CharacterRow>();
      for (const id of ordered) {
        const row = await lockCharacterById(client, id);
        if (row) rows.set(id, row);
      }
      const targetRow = rows.get(raid.target_character_id) ?? null;

      /**
       * Re-checked under the lock: the pre-transaction read is advisory only, and a target
       * who sat down, was challenged, or locked into a raid of their own between the two must
       * not be settled against.
       */
      if (
        !options.forceVoid &&
        targetRow &&
        (targetRow.seated_table_id ?? targetRow.active_duel_id ?? targetRow.active_raid_id)
      ) {
        return null;
      }

      const raiderPot = raid.raider_pot_coins;
      /**
       * The target's wallet, read under lock at settlement — never the band the raiders were
       * shown at invite time, and never a value carried in from an earlier read. There is no
       * lazy coin accrual in this product, so this row is the whole truth about their wealth.
       */
      const targetPot = targetRow?.lethal_coins ?? 0;
      const outcome: RaidOutcome =
        options.forceVoid || !targetRow ? 'void' : resolveRaidOutcome(raiderPot, targetPot);

      const claimed = await claimRaidSettlement(client, raid.id, {
        outcome,
        raiderPotCoins: raiderPot,
        targetPotCoins: outcome === 'raiders_won' ? targetPot : 0,
        nextState: outcome === 'raiders_won' ? 'betrayal' : 'complete',
        endedAt: outcome === 'raiders_won' ? null : at,
      });
      // Lost the claim: another attempt already settled this raid.
      if (!claimed) return null;

      let potCoins = 0;
      let bankrupted: string[] = [];

      if (outcome === 'raiders_won') {
        const drained = await drainCoins(client, raid.target_character_id);
        potCoins = raiderPot + drained.taken;
        bankrupted = [raid.target_character_id];
        rows.set(raid.target_character_id, drained.character);
      } else if (outcome === 'target_won') {
        const paid = await creditCoins(client, raid.target_character_id, raiderPot);
        rows.set(raid.target_character_id, paid);
        bankrupted = raiderIds;
        for (const member of joined) {
          await recordMemberOutcome(client, {
            raidId: raid.id,
            characterId: member.character_id,
            coinsReceived: 0,
            bankrupted: true,
          });
          await setActiveRaid(client, member.character_id, null);
        }
      } else {
        for (const member of joined) {
          const refund = member.pot_coins_at_lock ?? 0;
          if (refund > 0) await creditCoins(client, member.character_id, refund);
          await recordMemberOutcome(client, {
            raidId: raid.id,
            characterId: member.character_id,
            coinsReceived: refund,
            bankrupted: false,
          });
          await setActiveRaid(client, member.character_id, null);
        }
      }

      /**
       * The per-target immunity and the per-raider cooldown are the target's only protection,
       * so they are written in the same transaction as the outcome — including on a void,
       * where a party that fired and missed must not simply queue up again.
       */
      await recordRaidParticipation(client, {
        targetCharacterId: raid.target_character_id,
        raiderCharacterIds: raiderIds,
        immuneUntil: raidImmunityUntil(at.getTime()),
        at,
      });

      return {
        raidId: raid.id,
        outcome,
        raidPot: raiderPot,
        /**
         * What was actually taken from the target, which is what the persisted row and the
         * aftermath both report — never their live balance. On anything but a raiders' win
         * they keep that wallet, and putting its exact figure on a raider's wire would hand
         * the party the one number the wealth bands exist to withhold.
         */
        targetPot: outcome === 'raiders_won' ? targetPot : 0,
        potCoins,
        raiders: joined.map((member) => {
          const row = rows.get(member.character_id);
          return {
            characterId: member.character_id,
            nickname: row?.nickname ?? '',
            speciesId: row?.species_id ?? '',
          };
        }),
        targetCharacterId: raid.target_character_id,
        target: rows.get(raid.target_character_id) ?? null,
        bankrupted,
        paritySeed: raid.parity_seed,
        endedAt: outcome === 'raiders_won' ? null : at,
      } satisfies Settled;
    });
  }

  private announceSettlement(settled: Settled): void {
    const now = this.clock.now();
    const raiderIds = settled.raiders.map((raider) => raider.characterId);

    this.hub.sendToCharacters(raiderIds, {
      type: 'raid:result',
      raidId: settled.raidId,
      outcome: settled.outcome,
      raidPot: settled.raidPot,
      targetPot: settled.targetPot,
      potCoins: settled.potCoins,
    });

    if (settled.outcome !== 'raiders_won') {
      this.hub.sendToCharacters(raiderIds, {
        type: 'raid:end',
        raidId: settled.raidId,
        outcome: settled.outcome,
        coinsReceived: 0,
        bankrupted: settled.bankrupted,
        potDestroyed: false,
      });
      for (const raiderId of raiderIds) void this.sendCharacterUpdate(raiderId, now);
    }
    if (settled.target) {
      this.hub.sendToCharacter(settled.targetCharacterId, {
        type: 'character:update',
        character: toCharacterDto(settled.target, now),
      });
    }
  }

  /* ---------------------------- betrayal ------------------------------- */

  private startRunner(settled: Settled): void {
    const runner = new RaidRunner({
      raidId: settled.raidId,
      raiders: settled.raiders.map((raider) => ({
        characterId: raider.characterId,
        nickname: raider.nickname,
      })),
      potCoins: settled.potCoins,
      paritySeed: settled.paritySeed,
      db: this.db,
      hub: this.hub,
      clock: this.clock,
      betrayalMs: this.betrayalMs,
      parityMs: this.parityMs,
      revealMs: this.revealMs,
      log: this.log,
      onComplete: (split) => {
        void this.serialize(settled.raidId, () => this.payOut(settled, split, 0)).catch((error: unknown) =>
          this.log('raid payout failed', { raidId: settled.raidId, error }),
        );
      },
    });

    this.runners.set(settled.raidId, runner);
    for (const id of runner.characterIds) this.runnersByCharacter.set(id, runner);
    runner.start();
  }

  /**
   * The other half of the money, on the same terms as the settlement above: nothing is
   * announced and no lock is released until the distribution is known to have committed. A
   * payout that cannot be confirmed leaves the raid exactly as it is — still `betrayal` or
   * `parity`, still holding every engagement lock — and is asked again on the recovery
   * backoff, because telling raiders they were paid a pot that is still sitting in the row
   * is the one claim about money the server can never take back.
   */
  private async payOut(settled: Settled, split: RaidSplit, attempt: number): Promise<void> {
    const paid = await this.resolvePayout(settled, split);
    if (!paid) {
      this.log('raid payout unconfirmed; retrying', { raidId: settled.raidId });
      this.schedulePayoutRecovery(settled, split, attempt);
      return;
    }

    const now = this.clock.now();
    const bankrupted = Object.entries(paid.awards)
      .filter(([, value]) => value === 0)
      .map(([characterId]) => characterId);
    for (const raider of settled.raiders) {
      this.hub.sendToCharacter(raider.characterId, {
        type: 'raid:end',
        raidId: settled.raidId,
        outcome: 'raiders_won',
        coinsReceived: paid.awards[raider.characterId] ?? 0,
        bankrupted,
        potDestroyed: paid.potDestroyed,
      });
      void this.sendCharacterUpdate(raider.characterId, now);
    }
    this.retire(settled.raidId);
  }

  /**
   * What this pot was actually distributed as, from the attempt if it can say and from the
   * database if it cannot. `null` covers both "conclusively not paid yet" and "could not
   * tell", which take the same course here: unlike a settlement there is no compensating
   * cancel available — the target has already been drained, so the pot has to be paid rather
   * than unwound — and both answers mean the same thing to a client, which is silence.
   */
  private async resolvePayout(settled: Settled, split: RaidSplit): Promise<Paid | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const paid = await this.commitPayout(settled, split);
        if (paid) return paid;
        // Lost the claim: another attempt already paid this pot out. Read what it paid.
        break;
      } catch (error) {
        this.log('raid payout attempt failed', { raidId: settled.raidId, attempt: attempt + 1, error });
      }
    }
    return this.readBackPayout(settled);
  }

  private async commitPayout(settled: Settled, split: RaidSplit): Promise<Paid | null> {
    const at = new Date(this.clock.now());
    return withTransaction(this.db, async (client) => {
      const claimed = await completeRaid(client, settled.raidId, {
        potDestroyed: split.potDestroyed,
        endedAt: at,
      });
      if (!claimed) return null;

      const ordered = Object.keys(split.awards).sort();
      for (const characterId of ordered) {
        const coins = split.awards[characterId] ?? 0;
        await lockCharacterById(client, characterId);
        if (coins > 0) await creditCoins(client, characterId, coins);
        await recordMemberOutcome(client, {
          raidId: settled.raidId,
          characterId,
          coinsReceived: coins,
          bankrupted: coins === 0,
        });
        await setActiveRaid(client, characterId, null);
      }
      return { awards: split.awards, potDestroyed: split.potDestroyed };
    });
  }

  /**
   * The distribution as the database has it, for the case where this call could not tell it
   * had one. An attempt whose COMMIT acknowledgment is lost has already credited the
   * wallets; the retry then loses the claim to that committed row and reports nothing.
   * Reading the persisted awards back is what makes the announcement true rather than
   * merely intended.
   */
  private async readBackPayout(settled: Settled): Promise<Paid | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const raid = await findRaidById(this.db, settled.raidId);
        if (!raid || raid.state !== 'complete') return null;
        const members = await listRaidMembers(this.db, settled.raidId);
        const awards: Record<string, number> = {};
        for (const member of members) {
          if (member.state !== 'joined') continue;
          awards[member.character_id] = member.coins_received ?? 0;
        }
        return { awards, potDestroyed: raid.pot_destroyed };
      } catch (error) {
        this.log('raid payout read-back attempt failed', {
          raidId: settled.raidId,
          attempt: attempt + 1,
          error,
        });
      }
    }
    return null;
  }

  /**
   * The same ramp the undetermined settlement walks, and for the same reason: it ends at its
   * last step rather than giving up, so an outage longer than the ramp still ends in a paid
   * pot rather than in a party locked out of the game. A process that dies before it lands
   * hands the raid to the boot sweep, which returns the whole pot — the raiders' escrow and
   * the target's half both.
   */
  private schedulePayoutRecovery(settled: Settled, split: RaidSplit, attempt: number): void {
    if (this.stopped) return;
    const delay = this.recoveryDelaysMs[Math.min(attempt, this.recoveryDelaysMs.length - 1)]!;
    const timer = this.clock.after(delay, () => {
      this.recoveryTimers.delete(settled.raidId);
      void this.serialize(settled.raidId, () => this.payOut(settled, split, attempt + 1)).catch(
        (error: unknown) => this.log('raid payout recovery failed', { raidId: settled.raidId, error }),
      );
    });
    this.recoveryTimers.get(settled.raidId)?.cancel();
    this.recoveryTimers.set(settled.raidId, timer);
  }

  /* ---------------------------- aftermath ------------------------------ */

  /**
   * The whole experience for someone who was never there. Delivered on the next connect if
   * they were offline, and re-offered on every connect until the client acknowledges having
   * shown it: a socket that drops mid-send must not burn the one report they get.
   */
  private async deliverAftermath(characterId: string): Promise<void> {
    if (!this.hub.isOnline(characterId)) return;
    const pending = await listUnackedAftermaths(this.db, characterId);

    for (const raid of pending) {
      if (raid.outcome === null) continue;
      const members = await listRaidMembers(this.db, raid.id);
      const raiders = await this.raiderViews(
        members.filter((member) => member.state === 'joined').map((member) => member.character_id),
      );
      const coinsLost =
        raid.outcome === 'raiders_won'
          ? raid.target_pot_coins
          : raid.outcome === 'target_won'
            ? -raid.raider_pot_coins
            : 0;
      const target = await findCharacterById(this.db, characterId);

      this.hub.sendToCharacter(characterId, {
        type: 'raid:aftermath',
        raidId: raid.id,
        raiders,
        outcome: raid.outcome,
        raidPot: raid.raider_pot_coins,
        targetPot: raid.target_pot_coins,
        coinsLost,
        nowBeggar: isBeggarWallet(target?.lethal_coins ?? 0, target?.active_raid_id ?? null),
        at: (raid.ended_at ?? raid.created_at).toISOString(),
      });
    }
  }

  private async ackAftermath(characterId: string, raidId: string): Promise<void> {
    await markAftermathAcked(this.db, { raidId, characterId, at: new Date(this.clock.now()) });
  }

  private async resyncState(characterId: string): Promise<void> {
    const raid = await findLiveRaidFor(this.db, characterId);
    if (raid) await this.announceParty(raid.id, [characterId]);
    await this.deliverAftermath(characterId);
  }

  /* ----------------------------- plumbing ------------------------------ */

  private async announceParty(raidId: string, only?: string[]): Promise<void> {
    const raid = await findRaidById(this.db, raidId);
    if (!raid || (raid.state !== 'assembling' && raid.state !== 'resolving')) return;
    const members = await listRaidMembers(this.db, raidId);
    const target = await findCharacterById(this.db, raid.target_character_id);
    if (!target) return;

    const views: RaidMemberView[] = [];
    let pot = 0;
    for (const member of members) {
      const row = await findCharacterById(this.db, member.character_id);
      if (!row) continue;
      views.push(memberView(row, { state: member.state, isInitiator: member.is_initiator }));
      if (member.state === 'joined') pot += member.pot_coins_at_lock ?? row.lethal_coins;
    }

    const message: ServerMessage = {
      type: 'raid:party',
      raidId,
      target: targetView(target),
      members: views,
      // The party's own pot is banded too: a raider learning the exact total would learn
      // every other raider's exact wallet by subtraction.
      raidPotBand: wealthBandOf(pot),
      initiatorCharacterId: raid.initiator_character_id,
      state: raid.state,
      expiresAt:
        raid.state === 'assembling'
          ? new Date(raid.created_at.getTime() + this.assemblyTtlMs).toISOString()
          : null,
    };
    this.hub.sendToCharacters(
      only ?? members.filter((member) => member.state !== 'declined').map((member) => member.character_id),
      message,
    );
  }

  private async cancelAndAnnounce(
    raidId: string,
    reason: 'EXPIRED' | 'PARTY_TOO_SMALL' | 'SERVER_RESTART',
  ): Promise<void> {
    const members = await listRaidMembers(this.db, raidId).catch(() => [] as RaidMemberRow[]);
    let cancelled = false;
    for (let attempt = 0; attempt < 2 && !cancelled; attempt += 1) {
      try {
        await withTransaction(this.db, async (client) => {
          const claimed = await cancelRaidIfLive(client, raidId, new Date(this.clock.now()));
          if (!claimed) return;
          // Escrow first, locks second: a wallet emptied by a raid that never happened is
          // the one outcome with no recovery.
          for (const member of members) {
            if (member.state !== 'joined' || member.coins_received !== null) continue;
            const refund = member.pot_coins_at_lock ?? 0;
            if (refund > 0) await creditCoins(client, member.character_id, refund);
            await recordMemberOutcome(client, {
              raidId,
              characterId: member.character_id,
              coinsReceived: refund,
              bankrupted: false,
            });
          }
          await releaseRaidLocks(client, raidId);
        });
        cancelled = true;
      } catch (error) {
        this.log('raid cancel attempt failed', { raidId, attempt: attempt + 1, error });
      }
    }
    if (!cancelled) {
      await releaseRaidLocks(this.db, raidId).catch((error: unknown) =>
        this.log('raid lock release failed', { raidId, error }),
      );
    }

    const ids = members.map((member) => member.character_id);
    this.hub.sendToCharacters(ids, { type: 'raid:cancelled', raidId, reason });
    for (const id of ids) void this.sendCharacterUpdate(id, this.clock.now());
    this.retire(raidId);
  }

  private async sendCharacterUpdate(characterId: string, now: number): Promise<void> {
    const row = await findCharacterById(this.db, characterId).catch(() => null);
    if (row) {
      this.hub.sendToCharacter(characterId, { type: 'character:update', character: toCharacterDto(row, now) });
    }
  }

  private async raiderViews(
    characterIds: string[],
  ): Promise<{ characterId: string; nickname: string; speciesId: string }[]> {
    const views: { characterId: string; nickname: string; speciesId: string }[] = [];
    for (const characterId of characterIds) {
      const row = await findCharacterById(this.db, characterId);
      if (row) views.push({ characterId, nickname: row.nickname, speciesId: row.species_id });
    }
    return views;
  }

  private async joinedIds(raidId: string): Promise<string[]> {
    const members = await listRaidMembers(this.db, raidId);
    return members.filter((member) => member.state === 'joined').map((member) => member.character_id);
  }

  /** Every floor a would-be raider has to clear, in one place so both entry points agree. */
  private raiderRefusal(row: CharacterRow, now: number): RaidErrorCode | null {
    if (!isOldEnoughToRaid(row.created_at, now)) return 'TOO_NEW';
    if (isEngaged(row)) return 'BUSY';
    if (isRaiderCooldownActive(row.last_raid_at, now)) return 'COOLDOWN';
    return null;
  }

  /**
   * The target's floors. Deliberately without the engagement check: requiring them to be
   * idle would reintroduce a consent-shaped gate through the back door.
   */
  private targetRefusal(row: CharacterRow, now: number): RaidErrorCode | null {
    if (!isOldEnoughToRaid(row.created_at, now)) return 'TOO_NEW';
    if (isRaidImmune(row.raid_immunity_until, now)) return 'TARGET_IMMUNE';
    if (!isRaidableWealth(row.lethal_coins)) return 'TARGET_TOO_POOR';
    return null;
  }

  private serialize<T>(raidId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(raidId) ?? Promise.resolve();
    const result = previous.then(work);
    const tail: Promise<void> = result
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (this.chains.get(raidId) === tail) this.chains.delete(raidId);
      });
    this.chains.set(raidId, tail);
    return result;
  }

  private retire(raidId: string): void {
    this.assemblyTimers.get(raidId)?.cancel();
    this.assemblyTimers.delete(raidId);
    this.deferTimers.get(raidId)?.cancel();
    this.deferTimers.delete(raidId);
    // A surviving recovery timer would re-enter a finished raid and announce it twice.
    this.recoveryTimers.get(raidId)?.cancel();
    this.recoveryTimers.delete(raidId);
    const runner = this.runners.get(raidId);
    if (!runner) return;
    this.runners.delete(raidId);
    for (const id of runner.characterIds) {
      if (this.runnersByCharacter.get(id) === runner) this.runnersByCharacter.delete(id);
    }
  }

  private error(connection: Connection, code: RaidErrorCode): void {
    connection.socket.send(
      JSON.stringify({
        type: 'raid:error',
        code,
        message: RAID_ERROR_MESSAGES[code],
      } satisfies ServerMessage),
    );
  }
}

function memberView(
  row: CharacterRow,
  extras: { state: RaidMemberView['state']; isInitiator: boolean },
): RaidMemberView {
  return {
    characterId: row.id,
    accountId: row.account_id,
    nickname: row.nickname,
    speciesId: row.species_id,
    state: extras.state,
    isInitiator: extras.isInitiator,
  };
}

function targetView(row: CharacterRow): RaidTargetView {
  return {
    characterId: row.id,
    nickname: row.nickname,
    speciesId: row.species_id,
    // Banded, always: this is the whole of what a raider is allowed to learn about a wallet
    // they are about to bet everything against.
    band: wealthBandOf(row.lethal_coins),
  };
}
