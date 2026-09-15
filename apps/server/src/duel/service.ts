import { randomBytes } from 'node:crypto';
import {
  DUEL_INVITE_TTL_MS,
  DUEL_ERROR_MESSAGES,
  DUEL_REVEAL_MS,
  DUEL_ROUND_MS,
  TOWN_SQUARE_CHANNEL_ID,
  chickenBadgeUntil,
  duelStakeCoins,
  isBeggarWallet,
  isDeclineCooldownActive,
  isOldEnoughToDuel,
  roundStats,
  wealthBandOf,
  type ClientMessage,
  type DuelErrorCode,
  type DuelPlayerView,
  type ServerMessage,
} from '@lethalmagotchi/shared';
import type { ChatService } from '../chat/service.js';
import { DUEL_RECOVERY_LOCK_KEY } from '../db/advisory-locks.js';
import { withTransaction, type Db, type DbClient } from '../db/pool.js';
import type { Limiters } from '../deps.js';
import {
  creditCoins,
  findCharacterById,
  lockCharacterById,
  recordDuelResult,
  setActiveDuel,
  setChickenBadge,
  simulatedStats,
  toCharacterDto,
  toDuelCardDto,
  type CharacterRow,
} from '../repos/characters.js';
import { findSystemMessage, insertSystemMessage, isBlockedEitherWay } from '../repos/chat.js';
import { groupNamesForAccounts } from '../repos/groups.js';
import {
  abortAbandonedDuels,
  abortDuel,
  abortDuelIfActive,
  attachDuelToInvite,
  claimDuelSettlement,
  claimInviteExpiry,
  claimInviteResolution,
  findDuelById,
  insertDuel,
  insertInvite,
  lastDeclinedAt,
  listPendingInvitesFor,
  releaseDuelLocks,
  type DuelInviteRow,
} from '../repos/duels.js';
import { findDuelRebirthEvent, rebirthCharacter } from '../repos/rebirth.js';
import { systemClock, type Clock, type Timer } from '../tournament/clock.js';
import { uuidv7 } from '../uuid.js';
import type { Connection, Hub } from '../ws/hub.js';
import { DuelRunner, type DuelCompletion, type Duelist } from './runner.js';

export interface DuelServiceOptions {
  db: Db;
  hub: Hub;
  chat: ChatService;
  limiters: Limiters;
  clock?: Clock;
  roundMs?: number;
  revealMs?: number;
  inviteTtlMs?: number;
  /** The backoff the undetermined-settlement recovery walks; the last step is its floor. */
  settlementRecoveryDelaysMs?: number[];
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

const SETTLEMENT_RECOVERY_DELAYS_MS = [1_000, 5_000, 30_000];

/** Thrown inside the accept transaction to roll the invite claim back with it. */
class AcceptBlocked extends Error {
  readonly code: DuelErrorCode;

  constructor(code: DuelErrorCode) {
    super(code);
    this.code = code;
  }
}

export class DuelService {
  private readonly db: Db;
  private readonly hub: Hub;
  private readonly chat: ChatService;
  private readonly limiters: Limiters;
  private readonly clock: Clock;
  private readonly roundMs: number;
  private readonly revealMs: number;
  private readonly inviteTtlMs: number;
  private readonly recoveryDelaysMs: number[];
  private readonly log: (message: string, meta?: Record<string, unknown>) => void;

  private readonly runners = new Map<string, DuelRunner>();
  private readonly runnersByCharacter = new Map<string, DuelRunner>();
  private readonly inviteTimers = new Map<string, Timer>();
  /** At most one pending recovery pass per duel, so a chain of them cannot fan out. */
  private readonly recoveryTimers = new Map<string, Timer>();
  /** One chain per duel, so settlement can never interleave with itself or a shutdown. */
  private readonly chains = new Map<string, Promise<unknown>>();
  private stopped = false;
  private lockClient: DbClient | null = null;
  private starting: Promise<void> | null = null;

  constructor(options: DuelServiceOptions) {
    this.db = options.db;
    this.hub = options.hub;
    this.chat = options.chat;
    this.limiters = options.limiters;
    this.clock = options.clock ?? systemClock;
    this.roundMs = options.roundMs ?? DUEL_ROUND_MS;
    this.revealMs = options.revealMs ?? DUEL_REVEAL_MS;
    this.inviteTtlMs = options.inviteTtlMs ?? DUEL_INVITE_TTL_MS;
    this.recoveryDelaysMs = options.settlementRecoveryDelaysMs ?? SETTLEMENT_RECOVERY_DELAYS_MS;
    this.log = options.log ?? (() => {});
  }

  /**
   * A duel's whole state lives in the runner's memory — the current window's locked throws
   * were never written — so a restarted process cannot resume one. Abandoning them here is
   * the only honest recovery: nobody dies for a deploy, and no coins move.
   *
   * Gated behind an advisory lock held for the process's lifetime, exactly as the tournament
   * scheduler gates its own boot work: without it a second instance coming up mid-match
   * would abort duels the first instance is still playing, and clear the very locks that
   * keep a duelist from spending their stake before it settles. The sweep is additionally
   * scoped to duels that predate this process, since nothing newer can be a leftover.
   */
  async start(): Promise<void> {
    if (this.stopped) return;
    /**
     * `lockClient` is a single field: a second caller reaching the connect below would
     * overwrite it and strand the first connection, holding its advisory lock and its pool
     * slot for the life of the process. Same guard, same reason, as `TournamentService`.
     */
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
      [DUEL_RECOVERY_LOCK_KEY],
    );
    if (!held.rows[0]?.locked) {
      // Another instance owns duel recovery. Play still works here; only the sweep is
      // single-writer, and the instance holding the lock is the one that may run it.
      this.lockClient.release();
      this.lockClient = null;
      this.log('duel recovery sweep skipped: lock held elsewhere');
      return;
    }

    const aborted = await abortAbandonedDuels(this.db, bootAt, bootAt);
    if (aborted > 0) this.log('abandoned duels aborted on boot', { count: aborted });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // A stop that lands mid-boot must not race the sweep to the same rows, or release a
    // lock client the start is still assigning.
    await this.starting?.catch(() => undefined);
    for (const timer of this.inviteTimers.values()) timer.cancel();
    this.inviteTimers.clear();
    for (const timer of this.recoveryTimers.values()) timer.cancel();
    this.recoveryTimers.clear();
    for (const runner of this.runners.values()) await runner.stop();
    this.runners.clear();
    this.runnersByCharacter.clear();
    await Promise.allSettled([...this.chains.values()]);
    if (this.lockClient) {
      await this.lockClient.query('SELECT pg_advisory_unlock($1)', [DUEL_RECOVERY_LOCK_KEY]);
      this.lockClient.release();
      this.lockClient = null;
    }
  }

  /* --------------------------- socket hooks --------------------------- */

  /** A reconnect is put straight back into whatever is live: the match, and any challenge. */
  onCharacterOnline(characterId: string): void {
    this.runnersByCharacter.get(characterId)?.resync(characterId);
    void this.sendPendingInvites(characterId).catch((error: unknown) =>
      this.log('duel invite resync failed', { characterId, error }),
    );
  }

  /**
   * Deliberately empty. A duel never pauses for a missing player: the round deadline keeps
   * running and their throws are picked at random, which — with no flee action — is a path
   * to their death. The consequence is documented in the design rather than softened here.
   */
  onCharacterOffline(_characterId: string): void {}

  /* ------------------------------ frames ------------------------------ */

  async handle(connection: Connection, message: ClientDuelMessage): Promise<void> {
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
      message.type === 'duel:invite'
        ? this.limiters.duelInvite.check(connection.accountId)
        : // A resync costs several queries and a burst of frames, so it gets the same tight
          // dedicated bucket `tourney:resync` has rather than sharing the play budget.
          message.type === 'duel:resync'
          ? this.limiters.duelResync.check(connection.accountId)
          : this.limiters.duelAction.check(connection.accountId);
    if (!budget.allowed) {
      this.error(connection, 'RATE_LIMITED');
      return;
    }

    switch (message.type) {
      case 'duel:invite':
        await this.invite(connection, characterId, message.targetCharacterId);
        return;
      case 'duel:respond':
        await this.respond(connection, characterId, message.inviteId, message.accept);
        return;
      case 'duel:cancel':
        await this.cancel(connection, characterId, message.inviteId);
        return;
      case 'duel:throw': {
        const runner = this.runnersByCharacter.get(characterId);
        if (!runner) {
          this.error(connection, 'NOT_FOUND');
          return;
        }
        runner.throw(characterId, message);
        return;
      }
      case 'duel:resync':
        this.runnersByCharacter.get(characterId)?.resync(characterId);
        await this.sendPendingInvites(characterId);
        return;
    }
  }

  /* ------------------------------ invites ----------------------------- */

  private async invite(connection: Connection, characterId: string, targetId: string): Promise<void> {
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

    // The griefing floor applies in both directions: a day-old account can neither issue
    // nor receive a lethal challenge.
    if (!isOldEnoughToDuel(me.created_at, now) || !isOldEnoughToDuel(target.created_at, now)) {
      this.error(connection, 'TOO_NEW');
      return;
    }
    if (
      target.account_id &&
      (await isBlockedEitherWay(this.db, connection.accountId, target.account_id))
    ) {
      this.error(connection, 'BLOCKED');
      return;
    }
    if (me.seated_table_id || me.active_duel_id || me.active_raid_id) {
      this.error(connection, 'BUSY');
      return;
    }
    if (target.seated_table_id || target.active_duel_id || target.active_raid_id) {
      this.error(connection, 'TARGET_BUSY');
      return;
    }
    // A challenge has to be answered inside a minute, so it is only worth issuing to
    // someone who is actually at the keyboard.
    if (!this.hub.isOnline(targetId)) {
      this.error(connection, 'TARGET_OFFLINE');
      return;
    }
    if (isDeclineCooldownActive(await lastDeclinedAt(this.db, characterId, targetId), now)) {
      this.error(connection, 'COOLDOWN');
      return;
    }

    /**
     * Snapshotted here rather than re-derived at accept: this is the number the target is
     * shown and consents to, so it is also the number the challenger is held to. The spend
     * guard on paid actions reads it back for as long as the invite is pending.
     */
    const invite = await withTransaction(this.db, (client) =>
      insertInvite(client, {
        id: uuidv7(),
        fromCharacterId: characterId,
        toCharacterId: targetId,
        createdAt: new Date(now),
        expiresAt: new Date(now + this.inviteTtlMs),
        stakeCoins: duelStakeCoins(me.lethal_coins, target.lethal_coins),
      }),
    );
    if (!invite) {
      this.error(connection, 'INVITE_PENDING');
      return;
    }

    this.armInviteExpiry(invite);
    this.hub.sendToCharacter(targetId, {
      type: 'duel:invited',
      inviteId: invite.id,
      from: playerView(me),
      expiresAt: invite.expires_at.toISOString(),
      stakeCoins: invite.stake_coins,
    });
    this.hub.sendToCharacter(characterId, {
      type: 'duel:invite_state',
      inviteId: invite.id,
      state: 'pending',
      stakeCoins: invite.stake_coins,
      expiresAt: invite.expires_at.toISOString(),
    });
  }

  private armInviteExpiry(invite: DuelInviteRow): void {
    const delay = Math.max(0, invite.expires_at.getTime() - this.clock.now());
    this.inviteTimers.set(
      invite.id,
      this.clock.after(delay, () => {
        this.inviteTimers.delete(invite.id);
        void this.expireInvite(invite).catch((error: unknown) =>
          this.log('duel invite expiry failed', { inviteId: invite.id, error }),
        );
      }),
    );
  }

  private async expireInvite(invite: DuelInviteRow): Promise<void> {
    const claimed = await claimInviteExpiry(this.db, invite.id, new Date(this.clock.now()));
    if (!claimed) return;
    this.announceInviteState(claimed);
  }

  private async respond(
    connection: Connection,
    characterId: string,
    inviteId: string,
    accept: boolean,
  ): Promise<void> {
    const at = new Date(this.clock.now());

    let outcome:
      | { kind: 'declined'; invite: DuelInviteRow; decliner: CharacterRow | null }
      | { kind: 'accepted'; invite: DuelInviteRow; challenger: Duelist; opponent: Duelist; stakeCoins: number; duelId: string; tiebreakSeed: string }
      | null;

    try {
      outcome = await withTransaction(this.db, async (client) => {
        /**
         * The single state transition, claimed conditionally: two tabs answering at once,
         * an answer racing the 60s deadline, and a double-tapped Accept all resolve to one
         * winner here rather than to two duels.
         */
        const invite = await claimInviteResolution(client, {
          inviteId,
          state: accept ? 'accepted' : 'declined',
          resolvedAt: at,
          byCharacterId: characterId,
          side: 'to',
          notExpiredAt: at,
        });
        if (!invite) return null;

        if (!accept) {
          // The badge is rolling 24h from this moment, and the decline itself is what the
          // per-pair cooldown reads back.
          const decliner = await setChickenBadge(client, characterId, chickenBadgeUntil(at.getTime()));
          return { kind: 'declined' as const, invite, decliner };
        }

        const [first, second] = [invite.from_character_id, invite.to_character_id].sort();
        const rows = new Map<string, CharacterRow>();
        for (const id of [first!, second!]) {
          const row = await lockCharacterById(client, id);
          if (!row) throw new AcceptBlocked('NOT_FOUND');
          rows.set(id, row);
        }

        const challengerRow = rows.get(invite.from_character_id)!;
        const opponentRow = rows.get(invite.to_character_id)!;
        if (opponentRow.seated_table_id || opponentRow.active_duel_id || opponentRow.active_raid_id) {
          throw new AcceptBlocked('BUSY');
        }
        if (challengerRow.seated_table_id || challengerRow.active_duel_id || challengerRow.active_raid_id) {
          throw new AcceptBlocked('TARGET_BUSY');
        }
        // Both have to still be at the keyboard: a duel neither can be paused nor fled is
        // not something to start against an empty chair.
        if (!this.hub.isOnline(challengerRow.id)) throw new AcceptBlocked('TARGET_OFFLINE');

        const duelId = uuidv7();
        const tiebreakSeed = randomBytes(32).toString('hex');
        /**
         * The advertised stake is what both sides agreed to, and the spend guard has held
         * the challenger to it for the whole window. The live clamp stays on top of it so
         * the non-negative-balance invariant survives a target who spent their own coins
         * while deciding.
         */
        const stakeCoins = Math.min(
          invite.stake_coins,
          duelStakeCoins(challengerRow.lethal_coins, opponentRow.lethal_coins),
        );

        await insertDuel(client, {
          id: duelId,
          inviteId: invite.id,
          challengerId: challengerRow.id,
          opponentId: opponentRow.id,
          challengerPotCoins: challengerRow.lethal_coins,
          opponentPotCoins: opponentRow.lethal_coins,
          stakeCoins,
          tiebreakSeed,
          startedAt: at,
        });
        await setActiveDuel(client, challengerRow.id, duelId);
        await setActiveDuel(client, opponentRow.id, duelId);
        await attachDuelToInvite(client, invite.id, duelId);

        return {
          kind: 'accepted' as const,
          invite,
          challenger: duelistOf(challengerRow),
          opponent: duelistOf(opponentRow),
          stakeCoins,
          duelId,
          tiebreakSeed,
        };
      });
    } catch (error) {
      if (error instanceof AcceptBlocked) {
        this.error(connection, error.code);
        return;
      }
      throw error;
    }

    if (!outcome) {
      this.error(connection, 'EXPIRED');
      return;
    }

    this.inviteTimers.get(outcome.invite.id)?.cancel();
    this.inviteTimers.delete(outcome.invite.id);
    this.announceInviteState({ ...outcome.invite, state: outcome.kind === 'accepted' ? 'accepted' : 'declined' });

    if (outcome.kind === 'declined') {
      if (outcome.decliner) {
        this.hub.sendToCharacter(characterId, {
          type: 'character:update',
          character: toCharacterDto(outcome.decliner, this.clock.now()),
        });
      }
      return;
    }

    /**
     * A shutdown that lands between the accept transaction and the runner would leave a duel
     * `active` with both duelists locked and nothing driving it. Releasing it here is the
     * same compensating abort a failed settlement takes.
     */
    if (this.stopped) {
      await this.abortAndAnnounce(outcome.duelId, [
        outcome.challenger.characterId,
        outcome.opponent.characterId,
      ]);
      return;
    }

    this.startRunner(outcome);
  }

  private async cancel(connection: Connection, characterId: string, inviteId: string): Promise<void> {
    const claimed = await withTransaction(this.db, (client) =>
      claimInviteResolution(client, {
        inviteId,
        state: 'cancelled',
        resolvedAt: new Date(this.clock.now()),
        byCharacterId: characterId,
        side: 'from',
      }),
    );
    if (!claimed) {
      this.error(connection, 'NOT_FOUND');
      return;
    }
    this.inviteTimers.get(inviteId)?.cancel();
    this.inviteTimers.delete(inviteId);
    this.announceInviteState(claimed);
  }

  private announceInviteState(invite: DuelInviteRow): void {
    const message: ServerMessage = {
      type: 'duel:invite_state',
      inviteId: invite.id,
      state: invite.state,
    };
    this.hub.sendToCharacters([invite.from_character_id, invite.to_character_id], message);
  }

  private async sendPendingInvites(characterId: string): Promise<void> {
    const now = this.clock.now();
    const invites = await listPendingInvitesFor(this.db, characterId, new Date(now));
    for (const invite of invites) {
      if (invite.to_character_id !== characterId) {
        /**
         * A challenger who reloaded has no local record of the challenge they still have
         * out, so the bare state would leave them unable to withdraw or reissue until the
         * 60s TTL lapsed. The target's card is what lets the client rebuild the whole card.
         */
        const target = await findCharacterById(this.db, invite.to_character_id);
        const groups = target?.account_id
          ? await groupNamesForAccounts(this.db, [target.account_id])
          : null;
        this.hub.sendToCharacter(characterId, {
          type: 'duel:invite_state',
          inviteId: invite.id,
          state: 'pending',
          expiresAt: invite.expires_at.toISOString(),
          stakeCoins: invite.stake_coins,
          ...(target && !target.deleted_at
            ? {
                target: toDuelCardDto(
                  target,
                  now,
                  target.account_id ? (groups?.get(target.account_id) ?? null) : null,
                ),
              }
            : {}),
        });
        continue;
      }
      const from = await findCharacterById(this.db, invite.from_character_id);
      if (!from) continue;
      this.hub.sendToCharacter(characterId, {
        type: 'duel:invited',
        inviteId: invite.id,
        from: playerView(from),
        expiresAt: invite.expires_at.toISOString(),
        stakeCoins: invite.stake_coins,
      });
    }
  }

  /* ------------------------------ matches ----------------------------- */

  private startRunner(input: {
    duelId: string;
    challenger: Duelist;
    opponent: Duelist;
    stakeCoins: number;
    tiebreakSeed: string;
  }): void {
    const runner = new DuelRunner({
      duelId: input.duelId,
      challenger: input.challenger,
      opponent: input.opponent,
      stakeCoins: input.stakeCoins,
      tiebreakSeed: input.tiebreakSeed,
      db: this.db,
      hub: this.hub,
      clock: this.clock,
      roundMs: this.roundMs,
      revealMs: this.revealMs,
      log: this.log,
      onComplete: (completion) => {
        void this.serialize(completion.duelId, () => this.settle(completion)).catch((error: unknown) =>
          this.log('duel settlement failed', { duelId: completion.duelId, error }),
        );
      },
    });

    this.runners.set(input.duelId, runner);
    for (const id of runner.characterIds) this.runnersByCharacter.set(id, runner);
    runner.start();
  }

  private serialize<T>(duelId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(duelId) ?? Promise.resolve();
    const result = previous.then(work);
    const tail: Promise<void> = result
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (this.chains.get(duelId) === tail) this.chains.delete(duelId);
      });
    this.chains.set(duelId, tail);
    return result;
  }

  /**
   * The whole settlement, including the part that cannot be allowed to fail silently: both
   * duelists are released and told the match ended, on every outcome this call can
   * establish. Only a settlement that provably moved nothing takes the compensating abort —
   * the same transition the boot sweep performs, scoped to this duel and fired immediately
   * rather than at the next restart, which on a healthy long-lived server never comes. An
   * outcome that cannot be established at all is the one case that ends in neither here,
   * because every frame available to send would be a claim about money that may be false —
   * it is handed to the recovery backoff below, which keeps asking until it can.
   */
  private async settle(completion: DuelCompletion): Promise<void> {
    try {
      const settled = await this.resolveSettlement(completion);
      /**
       * The read-back could not complete, so this duel's outcome is unknown — it may well
       * have committed a death and a payout. Asserting an abort here would tell both
       * clients nothing happened while the money says otherwise, so nothing is asserted
       * yet: the row and both engagement locks are left exactly as they are, and the
       * question is asked again on a backoff until the database can answer it.
       */
      if (settled === 'undetermined') {
        this.log('duel settlement outcome undetermined; retrying', {
          duelId: completion.duelId,
          winnerCharacterId: completion.winnerCharacterId,
          loserCharacterId: completion.loserCharacterId,
        });
        this.scheduleSettlementRecovery(completion, 0);
        return;
      }
      if (!settled) {
        await this.abortAndAnnounce(completion.duelId, [
          completion.winnerCharacterId,
          completion.loserCharacterId,
        ]);
        return;
      }
      /**
       * Past this point the payout and the death are committed, so the fan-out is
       * deliberately outside the compensating-abort path: an abort fired because a socket
       * write threw would tell both clients the duel was void while the money says
       * otherwise. There is nothing to compensate — only something to log.
       */
      try {
        this.announceSettlement(completion, settled);
      } catch (error) {
        this.log('duel settlement announce failed', { duelId: completion.duelId, error });
      }
    } finally {
      this.retire(completion.duelId);
    }
  }

  /**
   * The undetermined outcome, asked again rather than left to a restart that on a healthy
   * server never comes. Each pass re-runs the same resolution the settlement did, so a
   * database that has come back either shows the committed death — announced late, but
   * announced — or conclusively shows that nothing was committed, which takes the
   * compensating abort and frees both duelists.
   *
   * Silence toward the clients is kept until then: nothing is claimed that cannot be
   * confirmed. The backoff walks `recoveryDelaysMs` and then stays at its last step, which
   * is what makes an outage longer than the ramp still end in recovery rather than in two
   * players locked out of the game.
   */
  private scheduleSettlementRecovery(completion: DuelCompletion, attempt: number): void {
    if (this.stopped) return;
    const delay = this.recoveryDelaysMs[Math.min(attempt, this.recoveryDelaysMs.length - 1)]!;
    const timer = this.clock.after(delay, () => {
      this.recoveryTimers.delete(completion.duelId);
      void this.serialize(completion.duelId, () => this.recoverSettlement(completion, attempt)).catch(
        (error: unknown) =>
          this.log('duel settlement recovery failed', { duelId: completion.duelId, error }),
      );
    });
    this.recoveryTimers.set(completion.duelId, timer);
  }

  private async recoverSettlement(completion: DuelCompletion, attempt: number): Promise<void> {
    if (this.stopped) return;

    const settled = await this.resolveSettlement(completion);
    if (settled === 'undetermined') {
      // Once the ramp is spent the outcome stops being waited for and starts being decided —
      // conditionally, and only for as long as that decision cannot be written at all.
      const lastPass = attempt >= this.recoveryDelaysMs.length - 1;
      if (lastPass && (await this.abortIfUnsettled(completion))) return;
      this.scheduleSettlementRecovery(completion, attempt + 1);
      return;
    }
    if (!settled) {
      await this.abortAndAnnounce(completion.duelId, [
        completion.winnerCharacterId,
        completion.loserCharacterId,
      ]);
      return;
    }
    try {
      this.announceSettlement(completion, settled);
    } catch (error) {
      this.log('duel settlement announce failed', { duelId: completion.duelId, error });
    }
  }

  /**
   * The end of the line, for a duel nothing could ever be read about. The abort is
   * conditional on the row still being `active` and the locks are released only if it
   * claims it: winning that claim is the proof that no settlement committed, in this process
   * or any other, so there is no payout for the abort to contradict. Losing it means one
   * did — the row is already `complete` or `aborted`, whoever wrote it released the locks
   * with it, and this call is a no-op by construction.
   *
   * True means the question is answered and no further pass is needed; false means the write
   * itself could not be made, and the caller keeps trying.
   */
  private async abortIfUnsettled(completion: DuelCompletion): Promise<boolean> {
    const at = new Date(this.clock.now());
    let claimed: Awaited<ReturnType<typeof abortDuelIfActive>> | undefined;
    for (let attempt = 0; attempt < 2 && claimed === undefined; attempt += 1) {
      try {
        claimed = await withTransaction(this.db, (client) =>
          abortDuelIfActive(client, completion.duelId, at),
        );
      } catch (error) {
        this.log('duel settlement fallback abort attempt failed', {
          duelId: completion.duelId,
          attempt: attempt + 1,
          error,
        });
      }
    }
    if (claimed === undefined) return false;

    if (!claimed) {
      // Settled by someone else while it was unreadable here. Their write is authoritative,
      // including the frames it sent, so nothing is announced over it.
      this.log('duel settled elsewhere while unreadable; nothing to compensate', {
        duelId: completion.duelId,
      });
      return true;
    }

    this.log('duel settlement never committed; aborted after recovery', { duelId: completion.duelId });
    this.announceAbort(completion.duelId, [completion.winnerCharacterId, completion.loserCharacterId]);
    return true;
  }

  /**
   * What this duel ended as, from the attempt if it can say and from the database if it
   * cannot. `null` means, and only means, that the read-back conclusively determined
   * nothing was committed anywhere; `'undetermined'` means it could not tell.
   */
  private async resolveSettlement(completion: DuelCompletion): Promise<Settled | null | 'undetermined'> {
    try {
      const settled = await this.attemptSettlement(completion);
      if (settled) return settled;
    } catch (error) {
      this.log('duel settlement failed; reading the duel back', { duelId: completion.duelId, error });
    }
    return this.readBackSettlement(completion);
  }

  /**
   * The read-back, on the same 2-attempt retry the settlement itself uses and for the same
   * reason: it is entered precisely because a connection just failed mid-COMMIT, and a
   * Postgres failover poisons several pool connections at once, so the next blip is
   * correlated with the one that got us here. A read that transiently fails has determined
   * nothing, and must not be collapsed into "nothing happened".
   */
  private async readBackSettlement(completion: DuelCompletion): Promise<Settled | null | 'undetermined'> {
    let read: ReadBack | null = null;
    for (let attempt = 0; attempt < 2 && !read; attempt += 1) {
      try {
        read = await withTransaction(this.db, (client) => this.persistedSettlement(client, completion));
      } catch (error) {
        this.log('duel settlement read-back attempt failed', {
          duelId: completion.duelId,
          attempt: attempt + 1,
          error,
        });
      }
    }
    if (!read) return 'undetermined';
    if (!read.settled || read.settled.kind === 'abort') return read.settled;
    return { ...read.settled, announcement: await this.persistedAnnouncement(read.settled, read.endedAt) };
  }

  /**
   * The settlement as the database has it, for the case where this call could not tell it
   * had one. An attempt whose COMMIT acknowledgment is lost on the wire has already paid the
   * winner and killed the loser; the retry then loses the claim to that committed row and
   * reports nothing. Announcing from the row is what stops the worst outcome in the game —
   * a real death, correct to the coin, that neither client is ever told about.
   *
   * It also covers the genuinely concurrent settler, whose committed row is just as binding.
   */
  private async persistedSettlement(client: DbClient, completion: DuelCompletion): Promise<ReadBack> {
    const duel = await findDuelById(client, completion.duelId);
    if (!duel || duel.state === 'active') return { settled: null, endedAt: null };
    if (duel.outcome !== 'death' || !duel.winner_character_id || !duel.loser_character_id) {
      return { settled: { kind: 'abort', duelId: duel.id }, endedAt: duel.ended_at };
    }

    const winner = await findCharacterById(client, duel.winner_character_id);
    const loser = await findCharacterById(client, duel.loser_character_id);
    const rebirth = await findDuelRebirthEvent(client, duel.id, duel.loser_character_id);
    // A committed death whose own rows cannot be found is not "nothing happened" either.
    if (!winner || !loser || !rebirth) {
      throw new Error(`duel ${duel.id} reads as a death whose payout rows are missing`);
    }

    return {
      settled: {
        kind: 'death',
        duelId: duel.id,
        coinsTransferred: duel.coins_transferred ?? 0,
        winner,
        loser,
        statsBefore: rebirth.statsBefore,
        coinsBefore: rebirth.coinsBefore,
        rebirthIndex: rebirth.rebirthIndex,
        announcement: null,
      },
      endedAt: duel.ended_at,
    };
  }

  /**
   * The Town Square line the settling attempt already wrote, looked up rather than inserted
   * again. Deliberately outside the read-back's transaction and its own failure domain: the
   * kill line is cosmetic, and a chat lookup that cannot be answered must never be able to
   * downgrade a committed death to an abort.
   */
  private async persistedAnnouncement(
    settled: Extract<Settled, { kind: 'death' }>,
    endedAt: Date | null,
  ): Promise<Awaited<ReturnType<typeof insertSystemMessage>> | null> {
    if (!endedAt) return null;
    try {
      return await findSystemMessage(this.db, {
        channelId: TOWN_SQUARE_CHANNEL_ID,
        body: duelAnnouncementBody(settled.winner.nickname, settled.loser.nickname),
        at: endedAt,
      });
    } catch (error) {
      this.log('duel announcement lookup failed; skipping the town square line', {
        duelId: settled.duelId,
        error,
      });
      return null;
    }
  }

  /**
   * Retried once before the compensating abort: a settlement transaction rolls back whole,
   * and `claimDuelSettlement` refuses a duel that is no longer `active`, so a second attempt
   * can neither pay twice nor kill twice. A transient connection blip should not cost a real
   * 2-0 its payout.
   */
  private async attemptSettlement(completion: DuelCompletion): Promise<Settled | null> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.settleOnce(completion);
      } catch (error) {
        lastError = error;
        this.log('duel settlement attempt failed', {
          duelId: completion.duelId,
          attempt: attempt + 1,
          error,
        });
      }
    }
    throw lastError;
  }

  /**
   * Death and settlement, one transaction, character rows locked in id order so two duels
   * ending at once cannot deadlock on a shared participant. The winner is paid the
   * pre-duel-snapshot stake first, then the loser takes the ordinary rebirth reset — the
   * same one a tournament HP death takes, with a different cause.
   */
  private async settleOnce(completion: DuelCompletion): Promise<Settled | null> {
    const at = new Date(this.clock.now());

    return withTransaction(this.db, async (client) => {
      const ordered = [completion.winnerCharacterId, completion.loserCharacterId].sort();
      const rows = new Map<string, CharacterRow>();
      for (const id of ordered) {
        const row = await lockCharacterById(client, id);
        if (row) rows.set(id, row);
      }
      const winnerRow = rows.get(completion.winnerCharacterId);
      const loserRow = rows.get(completion.loserCharacterId);

      const duel = await claimDuelSettlement(client, completion.duelId, {
        outcome: winnerRow && loserRow ? 'death' : 'abort',
        winnerCharacterId: winnerRow && loserRow ? completion.winnerCharacterId : null,
        loserCharacterId: winnerRow && loserRow ? completion.loserCharacterId : null,
        coinsTransferred: 0,
        challengerWins: completion.challengerWins,
        opponentWins: completion.opponentWins,
        endedAt: at,
      });
      // Lost the claim: another settlement attempt already paid this duel out.
      if (!duel) return null;

      if (!winnerRow || !loserRow) {
        for (const id of ordered) await setActiveDuel(client, id, null);
        return { kind: 'abort' as const, duelId: duel.id };
      }

      /**
       * Capped at the loser's live balance as well as at the smaller pre-duel wallet. With
       * spending locked out for the length of a duel the two are the same number; the clamp
       * is what keeps the non-negative-balance constraint an invariant rather than a hope.
       */
      const coinsTransferred = Math.min(duel.stake_coins, loserRow.lethal_coins);
      const paidWinner = await creditCoins(client, winnerRow.id, coinsTransferred);

      const reborn = await rebirthCharacter(client, loserRow, {
        statsBefore: roundStats(simulatedStats(loserRow, at.getTime())),
        cause: 'duel_defeat',
        tournamentId: null,
        duelId: duel.id,
        at,
      });

      await recordDuelResult(client, {
        winnerCharacterId: winnerRow.id,
        loserCharacterId: loserRow.id,
      });
      await setActiveDuel(client, winnerRow.id, null);
      await client.query(
        'UPDATE duels SET coins_transferred = $2 WHERE id = $1',
        [duel.id, coinsTransferred],
      );

      const announcement = await insertSystemMessage(client, {
        channelId: TOWN_SQUARE_CHANNEL_ID,
        body: duelAnnouncementBody(winnerRow.nickname, loserRow.nickname),
        at,
      });

      return {
        kind: 'death' as const,
        duelId: duel.id,
        coinsTransferred,
        winner: paidWinner,
        loser: reborn.character,
        statsBefore: reborn.statsBefore,
        coinsBefore: reborn.coinsBefore,
        rebirthIndex: reborn.rebirthIndex,
        announcement,
      };
    });

  }

  private announceSettlement(completion: DuelCompletion, settled: Settled): void {
    const at = new Date(this.clock.now());

    if (settled.kind === 'abort') {
      this.hub.sendToCharacters([completion.winnerCharacterId, completion.loserCharacterId], {
        type: 'duel:end',
        duelId: settled.duelId,
        outcome: 'abort',
        winnerCharacterId: null,
        loserCharacterId: null,
        coinsTransferred: 0,
        rebirth: null,
      });
      return;
    }

    // Every identity here comes off the settlement itself, which in the read-back case is
    // the persisted row: having declared that row authoritative, it is what gets quoted.
    const winnerId = settled.winner.id;
    const loserId = settled.loser.id;

    this.hub.sendToCharacters([winnerId, loserId], {
      type: 'duel:end',
      duelId: settled.duelId,
      outcome: 'death',
      winnerCharacterId: winnerId,
      loserCharacterId: loserId,
      coinsTransferred: settled.coinsTransferred,
      rebirth: { characterId: loserId, rebirthIndex: settled.rebirthIndex },
    });

    this.hub.sendToCharacter(winnerId, {
      type: 'character:update',
      character: toCharacterDto(settled.winner, at.getTime()),
    });
    this.hub.sendToCharacter(loserId, {
      type: 'character:rebirth',
      character: toCharacterDto(settled.loser, at.getTime()),
      statsBefore: settled.statsBefore,
      coinsBefore: settled.coinsBefore,
      rebirthIndex: settled.rebirthIndex,
      cause: 'duel_defeat',
    });

    if (settled.announcement) this.chat.broadcastSystemMessage(TOWN_SQUARE_CHANNEL_ID, settled.announcement);
  }

  /**
   * Release both duelists and say so. The `duel:end` goes out even if the compensating
   * write itself fails: a client with no end frame has no way back to town, throw buttons
   * that answer `STALE_SEQ` forever, and no resync that can rescue it.
   *
   * Retried on the same 2-attempt pattern the settlement uses, and if it still cannot be
   * written the engagement locks are released on their own. A stale duel row costs nobody
   * anything; a stale `active_duel_id` on a player who has just been told the duel is over
   * refuses their every action until a restart, which is the one outcome with no recovery.
   */
  private async abortAndAnnounce(duelId: string, characterIds: string[]): Promise<void> {
    let aborted = false;
    for (let attempt = 0; attempt < 2 && !aborted; attempt += 1) {
      try {
        await withTransaction(this.db, (client) => abortDuel(client, duelId, new Date(this.clock.now())));
        aborted = true;
      } catch (error) {
        this.log('duel abort attempt failed', { duelId, attempt: attempt + 1, error });
      }
    }
    if (!aborted) {
      await releaseDuelLocks(this.db, duelId).catch((error: unknown) =>
        this.log('duel lock release failed', { duelId, error }),
      );
    }
    this.announceAbort(duelId, characterIds);
  }

  private announceAbort(duelId: string, characterIds: string[]): void {
    this.hub.sendToCharacters(characterIds, {
      type: 'duel:end',
      duelId,
      outcome: 'abort',
      winnerCharacterId: null,
      loserCharacterId: null,
      coinsTransferred: 0,
      rebirth: null,
    });
  }

  private retire(duelId: string): void {
    const runner = this.runners.get(duelId);
    if (!runner) return;
    this.runners.delete(duelId);
    for (const id of runner.characterIds) {
      if (this.runnersByCharacter.get(id) === runner) this.runnersByCharacter.delete(id);
    }
  }

  private error(connection: Connection, code: DuelErrorCode): void {
    connection.socket.send(
      JSON.stringify({
        type: 'duel:error',
        code,
        message: DUEL_ERROR_MESSAGES[code],
      } satisfies ServerMessage),
    );
  }
}

/** What the read-back found: the duel row's own verdict, and the instant it ended at. */
interface ReadBack {
  settled: Settled | null;
  endedAt: Date | null;
}

type Settled =
  | { kind: 'abort'; duelId: string }
  | {
      kind: 'death';
      duelId: string;
      coinsTransferred: number;
      winner: CharacterRow;
      loser: CharacterRow;
      statsBefore: ReturnType<typeof roundStats>;
      coinsBefore: number;
      rebirthIndex: number;
      /** Null only on the read-back path, where the written line may not be findable again. */
      announcement: Awaited<ReturnType<typeof insertSystemMessage>> | null;
    };

/** One definition, because the read-back path has to find the row this text produced. */
function duelAnnouncementBody(winnerNickname: string, loserNickname: string): string {
  return `${winnerNickname} defeated ${loserNickname} in a duel.`;
}

/** Exactly the duel half of the wire schema, so the two can never drift apart. */
export type ClientDuelMessage = Extract<ClientMessage, { type: `duel:${string}` }>;

function playerView(row: CharacterRow): DuelPlayerView {
  return {
    characterId: row.id,
    accountId: row.account_id,
    nickname: row.nickname,
    speciesId: row.species_id,
    wealthBand: wealthBandOf(row.lethal_coins),
    isBeggar: isBeggarWallet(row.lethal_coins, row.active_raid_id),
    duelWins: row.duel_wins,
    duelLosses: row.duel_losses,
  };
}

function duelistOf(row: CharacterRow): Duelist {
  return {
    characterId: row.id,
    accountId: row.account_id,
    nickname: row.nickname,
    speciesId: row.species_id,
    potCoins: row.lethal_coins,
    duelWins: row.duel_wins,
    duelLosses: row.duel_losses,
  };
}
