import { createHash } from 'node:crypto';
import {
  HANDS_PER_TABLE,
  BIG_BLIND_COINS,
  SMALL_BLIND_COINS,
  type BettingAction,
  type SeatView,
  type ServerMessage,
  type TableStanding,
} from '@lethalmagotchi/shared';
import type { Db } from '../db/pool.js';
import { newDeckSeed } from '../poker/deck.js';
import {
  IllegalActionError,
  applyAction,
  legalActionsFor,
  potOf,
  startHand,
  timeoutAction,
  type HandState,
} from '../poker/engine.js';
import { evaluate } from '../poker/evaluate.js';
import { insertHand, insertHandAction, persistSeatStacks, updateHand } from '../repos/tournaments.js';
import type { Hub } from '../ws/hub.js';
import type { Clock, Timer } from './clock.js';

export interface RunnerSeat {
  seatIndex: number;
  characterId: string;
  nickname: string;
  speciesId: string;
  stack: number;
  handsWon: number;
  connected: boolean;
}

export interface TableCompletion {
  tableId: string;
  tournamentId: string;
  round: number;
  qualifierCharacterId: string;
  standings: TableStanding[];
  seats: RunnerSeat[];
}

export interface TableOptions {
  tableId: string;
  tournamentId: string;
  round: number;
  totalRounds: number;
  seats: RunnerSeat[];
  db: Db;
  hub: Hub;
  clock: Clock;
  turnMs: number;
  showdownMs: number;
  handsPerTable?: number;
  maxSuddenDeathHands?: number;
  log: (message: string, meta?: Record<string, unknown>) => void;
  onComplete: (completion: TableCompletion) => void;
}

const MAX_SUDDEN_DEATH_HANDS = 2;

export class TableRunner {
  readonly tableId: string;
  readonly tournamentId: string;
  readonly round: number;

  private readonly options: TableOptions;
  private readonly handsPerTable: number;
  private readonly maxSuddenDeath: number;
  private readonly seats: RunnerSeat[];

  private hand: HandState | null = null;
  private handId: string | null = null;
  private handsPlayed = 0;
  private suddenDeathHands = 0;
  private timer: Timer | null = null;
  private finished = false;
  /** Serialises DB work so two events can never interleave writes for one table. */
  private chain: Promise<void> = Promise.resolve();

  constructor(options: TableOptions) {
    this.options = options;
    this.tableId = options.tableId;
    this.tournamentId = options.tournamentId;
    this.round = options.round;
    this.seats = options.seats;
    this.handsPerTable = options.handsPerTable ?? HANDS_PER_TABLE;
    this.maxSuddenDeath = options.maxSuddenDeathHands ?? MAX_SUDDEN_DEATH_HANDS;
  }

  get characterIds(): string[] {
    return this.seats.map((seat) => seat.characterId);
  }

  seatOf(characterId: string): RunnerSeat | undefined {
    return this.seats.find((seat) => seat.characterId === characterId);
  }

  start(): void {
    this.enqueue(async () => {
      this.sendSeated();
      await this.beginHand();
    });
  }

  setConnected(characterId: string, connected: boolean): void {
    const seat = this.seatOf(characterId);
    if (!seat || seat.connected === connected) return;
    seat.connected = connected;
    this.broadcast({ type: 'tourney:seat_state', tableId: this.tableId, seats: this.seatViews() });
  }

  /** Everything a reconnecting player needs to rebuild the table, including their cards. */
  resync(characterId: string): void {
    const seat = this.seatOf(characterId);
    if (!seat) return;

    this.options.hub.sendToCharacter(characterId, {
      type: 'tourney:seated',
      tournamentId: this.tournamentId,
      tableId: this.tableId,
      round: this.round,
      totalRounds: this.options.totalRounds,
      seatIndex: seat.seatIndex,
      seats: this.seatViews(),
      handsPerTable: this.handsPerTable,
    });

    const hand = this.hand;
    if (!hand || !this.handId || hand.complete) return;

    this.options.hub.sendToCharacter(characterId, {
      type: 'tourney:hand_start',
      tableId: this.tableId,
      handId: this.handId,
      handNumber: hand.handNumber,
      buttonSeat: hand.buttonSeat,
      blinds: {
        small: SMALL_BLIND_COINS,
        big: BIG_BLIND_COINS,
        smallBlindSeat: hand.smallBlindSeat,
        bigBlindSeat: hand.bigBlindSeat,
      },
      potCoins: potOf(hand),
      stacks: hand.seats.map((entry) => entry.stack),
      suddenDeath: hand.handNumber > this.handsPerTable,
    });

    if (hand.board.length > 0) {
      this.options.hub.sendToCharacter(characterId, {
        type: 'tourney:board',
        handId: this.handId,
        street: hand.street,
        cards: [...hand.board],
        potCoins: potOf(hand),
      });
    }

    this.sendPrivate(seat.seatIndex);
    if (hand.toActSeat !== null) this.sendTurn();
  }

  act(characterId: string, input: { handId: string; seq: number; action: BettingAction; amount?: number }): void {
    const seat = this.seatOf(characterId);
    if (!seat) return;
    const hand = this.hand;

    if (!hand || hand.complete || this.handId !== input.handId) {
      this.rejectAfterPendingWrites(characterId, 'STALE_SEQ', input.seq, 'That hand has already moved on.');
      return;
    }
    /**
     * The idempotency mechanism: `seq` is the hand's action counter as of the turn the
     * player was offered. Applying an action advances it, so a double-click, a replay
     * and a reconnect race all fail this check instead of acting twice. It is tested
     * *before* turn ownership deliberately — after a double-click the turn has already
     * moved on, and "that move was already taken" is the truthful reason, not "it is
     * not your turn".
     */
    if (hand.seq !== input.seq) {
      this.rejectAfterPendingWrites(characterId, 'STALE_SEQ', input.seq, 'That move was already taken.');
      return;
    }
    if (hand.toActSeat !== seat.seatIndex) {
      this.rejectAfterPendingWrites(characterId, 'NOT_YOUR_TURN', input.seq, 'It is not your turn.');
      return;
    }

    this.applyAndAdvance(seat.seatIndex, { action: input.action, ...(input.amount === undefined ? {} : { amount: input.amount }) });
  }

  /** Resolves once every queued write has landed, so a shutdown cannot drop an action. */
  async stop(): Promise<void> {
    this.finished = true;
    this.clearTimer();
    await this.chain;
  }

  /* ------------------------------------------------------------------ */

  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain
      .then(work)
      .catch((error: unknown) => this.options.log('table step failed', { tableId: this.tableId, error }));
  }

  private clearTimer(): void {
    this.timer?.cancel();
    this.timer = null;
  }

  private broadcast(message: ServerMessage): void {
    this.options.hub.sendToCharacters(this.characterIds, message);
  }

  private seatViews(): SeatView[] {
    const hand = this.hand;
    return this.seats.map((seat) => {
      const engineSeat = hand?.seats[seat.seatIndex];
      return {
        seatIndex: seat.seatIndex,
        characterId: seat.characterId,
        nickname: seat.nickname,
        speciesId: seat.speciesId,
        stack: engineSeat ? engineSeat.stack : seat.stack,
        connected: seat.connected,
        folded: engineSeat?.folded ?? false,
        allIn: engineSeat?.allIn ?? false,
        committed: engineSeat?.committed ?? 0,
      };
    });
  }

  private sendSeated(): void {
    for (const seat of this.seats) {
      this.options.hub.sendToCharacter(seat.characterId, {
        type: 'tourney:seated',
        tournamentId: this.tournamentId,
        tableId: this.tableId,
        round: this.round,
        totalRounds: this.options.totalRounds,
        seatIndex: seat.seatIndex,
        seats: this.seatViews(),
        handsPerTable: this.handsPerTable,
      });
    }
  }

  /**
   * Hole cards leave the server exactly here, addressed to one character. There is no
   * code path that puts them in a message sent to more than one recipient before
   * showdown.
   */
  private sendPrivate(seatIndex: number): void {
    const hand = this.hand;
    if (!hand || !this.handId) return;
    const engineSeat = hand.seats[seatIndex];
    const seat = this.seats[seatIndex];
    if (!engineSeat || !seat || engineSeat.holeCards.length === 0) return;
    // Addressing is positional, so non-contiguous seat indices would mail one player's
    // hole cards to another. Fail loudly instead.
    if (seat.seatIndex !== seatIndex) {
      throw new Error(`seat ${seatIndex} of table ${this.tableId} is out of position`);
    }

    this.options.hub.sendToCharacter(seat.characterId, {
      type: 'tourney:private',
      handId: this.handId,
      seatIndex,
      holeCards: [...engineSeat.holeCards],
      bestHand: evaluate([...engineSeat.holeCards, ...hand.board]).description,
    });
  }

  private sendAllPrivate(): void {
    for (const seat of this.seats) {
      const engineSeat = this.hand?.seats[seat.seatIndex];
      if (engineSeat && !engineSeat.folded) this.sendPrivate(seat.seatIndex);
    }
  }

  private reject(characterId: string, code: 'STALE_SEQ' | 'NOT_YOUR_TURN' | 'ILLEGAL_ACTION', seq: number, message: string): void {
    this.options.hub.sendToCharacter(characterId, { type: 'tourney:rejected', code, seq, message });
  }

  /**
   * A double-click's rejection is queued behind the write for the click that won, so a
   * client can never learn the outcome of an action before the audit log has it.
   */
  private rejectAfterPendingWrites(
    characterId: string,
    code: 'STALE_SEQ' | 'NOT_YOUR_TURN',
    seq: number,
    message: string,
  ): void {
    this.enqueue(async () => {
      this.reject(characterId, code, seq, message);
    });
  }

  private liveSeatCount(): number {
    return this.seats.filter((seat) => seat.stack > 0).length;
  }

  private async beginHand(): Promise<void> {
    if (this.finished) return;

    if (this.liveSeatCount() < 2) {
      await this.completeTable();
      return;
    }

    const handNumber = this.handsPlayed + 1;
    const deckSeed = newDeckSeed();
    // The button walks the seats that still have chips, so it is never parked on a
    // busted seat and the blinds always land on someone who can post them.
    const withChips = this.seats.filter((seat) => seat.stack > 0);
    const buttonSeat = withChips[(handNumber - 1) % withChips.length]!.seatIndex;

    const hand = startHand({
      handNumber,
      deckSeed,
      buttonSeat,
      seats: this.seats.map((seat) => ({
        seatIndex: seat.seatIndex,
        characterId: seat.characterId,
        stack: seat.stack,
        sittingOut: seat.stack <= 0,
      })),
    });

    this.hand = hand;
    this.handId = await insertHand(this.options.db, {
      tableId: this.tableId,
      handNumber,
      deckSeed,
      buttonSeat,
    });

    this.broadcast({
      type: 'tourney:hand_start',
      tableId: this.tableId,
      handId: this.handId,
      handNumber,
      buttonSeat,
      blinds: {
        small: SMALL_BLIND_COINS,
        big: BIG_BLIND_COINS,
        smallBlindSeat: hand.smallBlindSeat,
        bigBlindSeat: hand.bigBlindSeat,
      },
      potCoins: potOf(hand),
      stacks: hand.seats.map((seat) => seat.stack),
      suddenDeath: handNumber > this.handsPerTable,
    });

    this.sendAllPrivate();
    await this.afterStateChange(null);
  }

  private applyAndAdvance(seatIndex: number, input: { action: BettingAction; amount?: number }): void {
    const hand = this.hand;
    if (!hand) return;

    let next: HandState;
    try {
      next = applyAction(hand, { seatIndex, ...input });
    } catch (error) {
      if (error instanceof IllegalActionError) {
        this.reject(this.seats[seatIndex]!.characterId, 'ILLEGAL_ACTION', hand.seq, error.message);
        return;
      }
      throw error;
    }

    this.clearTimer();
    this.hand = next;
    const record = next.actions.at(-1)!;
    const boardBefore = hand.board.length;
    const handId = this.handId!;

    this.enqueue(async () => {
      /**
       * The audit log is written before anyone is told the action happened, so a client
       * can never observe an action that `hand_actions` does not already contain — and a
       * crash in this window loses the frame, not the record.
       */
      await insertHandAction(this.options.db, {
        handId,
        seq: record.seq,
        seatIndex,
        street: record.street,
        action: record.action,
        amount: record.amount,
      });

      this.broadcast({
        type: 'tourney:action',
        handId,
        seq: record.seq,
        seatIndex,
        action: record.action,
        amount: record.amount,
        potCoins: potOf(next),
        stacks: next.seats.map((seat) => seat.stack),
        committed: next.seats.map((seat) => seat.committed),
        folded: next.seats.map((seat) => seat.folded),
        allIn: next.seats.map((seat) => seat.allIn),
      });

      await this.afterStateChange(boardBefore);
    });
  }

  private async afterStateChange(boardBefore: number | null): Promise<void> {
    const hand = this.hand;
    if (!hand || !this.handId) return;

    if (boardBefore !== null && hand.board.length > boardBefore) {
      this.broadcast({
        type: 'tourney:board',
        handId: this.handId,
        street: hand.street,
        cards: [...hand.board],
        potCoins: potOf(hand),
      });
      this.sendAllPrivate();
    }

    if (hand.complete) {
      await this.finishHand();
      return;
    }

    const deadlineAt = new Date(this.options.clock.now() + this.options.turnMs);
    await updateHand(this.options.db, this.handId, {
      board: [...hand.board],
      street: hand.street,
      potCoins: potOf(hand),
      toActSeat: hand.toActSeat,
      actionDeadlineAt: deadlineAt,
    });

    this.sendTurn(deadlineAt);
    this.armDeadline();
  }

  private sendTurn(deadlineAt?: Date): void {
    const hand = this.hand;
    if (!hand || hand.toActSeat === null || !this.handId) return;
    const legal = legalActionsFor(hand);
    if (!legal) return;

    this.broadcast({
      type: 'tourney:turn',
      handId: this.handId,
      seq: hand.seq,
      seatIndex: hand.toActSeat,
      deadlineAt: (deadlineAt ?? new Date(this.options.clock.now() + this.options.turnMs)).toISOString(),
      legal,
    });
  }

  /**
   * A disconnected seat is not waited on any differently: the deadline is the same
   * server-side absolute, and when it expires the seat auto-checks or folds. The table
   * therefore never pauses for anybody, connected or not.
   */
  private armDeadline(): void {
    this.clearTimer();
    this.timer = this.options.clock.after(this.options.turnMs, () => {
      const hand = this.hand;
      if (!hand || hand.complete || hand.toActSeat === null) return;
      this.applyAndAdvance(hand.toActSeat, timeoutAction(hand));
    });
  }

  private async finishHand(): Promise<void> {
    const hand = this.hand;
    if (!hand?.result || !this.handId) return;

    for (const seat of this.seats) {
      seat.stack = hand.seats[seat.seatIndex]!.stack;
    }
    for (const seatIndex of hand.result.winners) {
      const seat = this.seats[seatIndex];
      if (seat) seat.handsWon += 1;
    }

    this.handsPlayed += 1;
    if (hand.handNumber > this.handsPerTable) this.suddenDeathHands += 1;

    this.broadcast({
      type: 'tourney:showdown',
      handId: this.handId,
      reveals: hand.result.reveals,
      payouts: hand.result.payouts,
      stacks: hand.seats.map((seat) => seat.stack),
      summary: this.summarise(hand),
    });

    await updateHand(this.options.db, this.handId, {
      board: [...hand.board],
      street: 'showdown',
      potCoins: hand.result.pots.reduce((sum, pot) => sum + pot.amount, 0),
      toActSeat: null,
      actionDeadlineAt: null,
      completed: true,
    });
    await persistSeatStacks(this.options.db, this.tableId, this.seats);

    if (this.shouldContinue()) {
      this.timer = this.options.clock.after(this.options.showdownMs, () => {
        this.enqueue(() => this.beginHand());
      });
      return;
    }

    this.timer = this.options.clock.after(this.options.showdownMs, () => {
      this.enqueue(() => this.completeTable());
    });
  }

  private shouldContinue(): boolean {
    if (this.liveSeatCount() < 2) return false;
    if (this.handsPlayed < this.handsPerTable) return true;
    // Past the three-hand mark only an unbroken tie buys more hands, and only a
    // bounded number of them — the bracket must never stall on a tie.
    return this.tiedLeaders().length > 1 && this.suddenDeathHands < this.maxSuddenDeath;
  }

  private tiedLeaders(): RunnerSeat[] {
    const best = Math.max(...this.seats.map((seat) => seat.stack));
    const leaders = this.seats.filter((seat) => seat.stack === best);
    if (leaders.length === 1) return leaders;
    const mostWins = Math.max(...leaders.map((seat) => seat.handsWon));
    return leaders.filter((seat) => seat.handsWon === mostWins);
  }

  private summarise(hand: HandState): string {
    const result = hand.result!;
    const parts = result.payouts
      .filter((payout) => payout.amount > 0)
      .map((payout) => {
        const seat = this.seats[payout.seatIndex]!;
        const reveal = result.reveals.find((entry) => entry.seatIndex === payout.seatIndex);
        const coins = payout.amount === 1 ? '1 coin' : `${payout.amount} coins`;
        return reveal
          ? `${seat.nickname} wins ${coins} with ${reveal.handName.toLowerCase()}`
          : `${seat.nickname} wins ${coins}`;
      });
    return parts.length > 0 ? `${parts.join('. ')}.` : 'Split pot.';
  }

  private async completeTable(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.clearTimer();

    const leaders = this.tiedLeaders();
    const qualifier =
      leaders.length === 1
        ? leaders[0]!
        : // Seeded, deterministic and stable: the same table always breaks the same way.
          [...leaders].sort((a, b) =>
            createHash('sha256')
              .update(`${this.tableId}:${a.characterId}`)
              .digest('hex')
              .localeCompare(createHash('sha256').update(`${this.tableId}:${b.characterId}`).digest('hex')),
          )[0]!;

    const standings: TableStanding[] = [...this.seats]
      .sort((a, b) => b.stack - a.stack || b.handsWon - a.handsWon)
      .map((seat) => ({
        seatIndex: seat.seatIndex,
        characterId: seat.characterId,
        nickname: seat.nickname,
        stack: seat.stack,
        handsWon: seat.handsWon,
      }));

    this.broadcast({
      type: 'tourney:table_result',
      tableId: this.tableId,
      qualifierCharacterId: qualifier.characterId,
      standings,
    });

    this.options.onComplete({
      tableId: this.tableId,
      tournamentId: this.tournamentId,
      round: this.round,
      qualifierCharacterId: qualifier.characterId,
      standings,
      seats: this.seats,
    });
  }
}
