import { createHash, randomInt } from 'node:crypto';
import {
  DUEL_THROWS,
  DUEL_WINS_NEEDED,
  isBeggar,
  resolveRound,
  wealthBandOf,
  type DuelPlayerView,
  type DuelScore,
  type DuelSide,
  type DuelThrow,
  type ServerMessage,
} from '@lethalmagotchi/shared';
import type { Db } from '../db/pool.js';
import { insertDuelAction, updateDuelProgress } from '../repos/duels.js';
import type { Clock, Timer } from '../tournament/clock.js';
import type { Hub } from '../ws/hub.js';

export interface Duelist {
  characterId: string;
  accountId: string | null;
  nickname: string;
  speciesId: string;
  /** The wallet snapshot taken at duel start; never re-read while the match runs. */
  potCoins: number;
  duelWins: number;
  duelLosses: number;
}

export interface DuelCompletion {
  duelId: string;
  winner: DuelSide;
  winnerCharacterId: string;
  loserCharacterId: string;
  challengerWins: number;
  opponentWins: number;
}

export interface DuelRunnerOptions {
  duelId: string;
  challenger: Duelist;
  opponent: Duelist;
  stakeCoins: number;
  tiebreakSeed: string;
  db: Db;
  hub: Hub;
  clock: Clock;
  roundMs: number;
  /** The beat between a reveal and the next commit window, so a result can be read. */
  revealMs: number;
  log: (message: string, meta?: Record<string, unknown>) => void;
  onComplete: (completion: DuelCompletion) => void;
}

interface Locked {
  throw: DuelThrow;
  autoThrown: boolean;
}

/**
 * One live rock-paper-scissors match. Structurally the same shape as `TableRunner`: one
 * in-memory timer, every write serialised on a promise chain so two events can never
 * interleave writes for the same duel, and every deadline taken from an injected clock so a
 * test drives a 5-second window without sleeping for five seconds.
 *
 * The match never pauses for a disconnected duelist — the deadline is a server-side
 * absolute, and when it fires a missing throw is picked at random. Since losing a duel is
 * fatal, a duelist who drops mid-match really can die on those throws; that is the designed
 * consequence of there being no flee action.
 */
export class DuelRunner {
  readonly duelId: string;

  private readonly options: DuelRunnerOptions;
  private readonly bySide: Record<DuelSide, Duelist>;

  private score: DuelScore = { round: 1, replay: 0, challengerWins: 0, opponentWins: 0 };
  private seq = 0;
  private deadlineAt = 0;
  private locked = new Map<string, Locked>();
  /**
   * Flipped false by `closeWindow` and true by `openWindow`, which is what makes the reveal
   * beat a closed window rather than a gap: `score`/`seq` advance synchronously with the
   * close, but the next window only opens once the reveal has played out.
   */
  private windowOpen = false;
  private timer: Timer | null = null;
  private finished = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(options: DuelRunnerOptions) {
    this.options = options;
    this.duelId = options.duelId;
    this.bySide = { challenger: options.challenger, opponent: options.opponent };
  }

  get characterIds(): string[] {
    return [this.options.challenger.characterId, this.options.opponent.characterId];
  }

  start(): void {
    this.enqueue(async () => {
      for (const side of ['challenger', 'opponent'] as const) {
        this.options.hub.sendToCharacter(this.bySide[side].characterId, {
          type: 'duel:start',
          duelId: this.duelId,
          opponent: this.view(other(side)),
          stakeCoins: this.options.stakeCoins,
          winsNeeded: DUEL_WINS_NEEDED,
          youAre: side,
        });
      }
      this.openWindow();
    });
  }

  /** Everything a reconnecting duelist needs to rebuild the match, minus the live throws. */
  resync(characterId: string): void {
    const side = this.sideOf(characterId);
    if (side === null || this.finished) return;

    this.options.hub.sendToCharacter(characterId, {
      type: 'duel:start',
      duelId: this.duelId,
      opponent: this.view(other(side)),
      stakeCoins: this.options.stakeCoins,
      winsNeeded: DUEL_WINS_NEEDED,
      youAre: side,
    });
    // During the reveal beat there is no open window; `deadlineAt` belongs to the one that
    // just closed, so it is reported as already elapsed rather than as time to throw in.
    this.options.hub.sendToCharacter(characterId, {
      type: 'duel:round',
      duelId: this.duelId,
      round: this.score.round,
      replay: this.score.replay,
      seq: this.seq,
      deadlineAt: new Date(this.windowOpen ? this.deadlineAt : this.options.clock.now()).toISOString(),
    });
    // The fact of the opponent's lock is public; the throw is not, and is not sent here.
    if (this.locked.has(this.bySide[other(side)].characterId)) {
      this.options.hub.sendToCharacter(characterId, { type: 'duel:opponent_locked', duelId: this.duelId });
    }
  }

  throw(characterId: string, input: { duelId: string; round: number; replay: number; seq: number; throw: DuelThrow }): void {
    const side = this.sideOf(characterId);
    if (side === null) return;

    /**
     * The idempotency check, in poker's shape: `seq` is the counter as of the window the
     * player was offered, and it only advances when a window resolves. A double-click, a
     * replayed frame and a reconnect race therefore all fail here rather than throwing
     * twice — and a second throw inside the same window is a duplicate, not a change of
     * mind, because the first one is already committed.
     *
     * `windowOpen` is the half the round/replay/seq triple cannot express: between a close
     * and the next open, the score has already advanced to the round the caller is naming,
     * and without this flag a throw sent into the reveal beat would be accepted, announced
     * to the opponent as locked in, and then discarded when the window actually opened.
     */
    if (
      this.finished ||
      !this.windowOpen ||
      input.duelId !== this.duelId ||
      input.seq !== this.seq ||
      input.round !== this.score.round ||
      input.replay !== this.score.replay ||
      this.locked.has(characterId)
    ) {
      this.rejectAfterPendingWrites(characterId, 'STALE_SEQ');
      return;
    }

    this.locked.set(characterId, { throw: input.throw, autoThrown: false });
    this.options.hub.sendToCharacter(this.bySide[other(side)].characterId, {
      type: 'duel:opponent_locked',
      duelId: this.duelId,
    });

    if (this.locked.size === 2) this.closeWindow();
  }

  /** Resolves once every queued write has landed, so a shutdown cannot drop a throw. */
  async stop(): Promise<void> {
    this.finished = true;
    this.clearTimer();
    await this.chain;
  }

  /* ------------------------------------------------------------------ */

  private sideOf(characterId: string): DuelSide | null {
    if (characterId === this.options.challenger.characterId) return 'challenger';
    if (characterId === this.options.opponent.characterId) return 'opponent';
    return null;
  }

  private view(side: DuelSide): DuelPlayerView {
    const duelist = this.bySide[side];
    return {
      characterId: duelist.characterId,
      accountId: duelist.accountId,
      nickname: duelist.nickname,
      speciesId: duelist.speciesId,
      // Banded, like every other public view of a wallet: the stake is the only exact
      // figure a duel puts on the wire, and it travels on its own field.
      wealthBand: wealthBandOf(duelist.potCoins),
      isBeggar: isBeggar(duelist.potCoins),
      duelWins: duelist.duelWins,
      duelLosses: duelist.duelLosses,
    };
  }

  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain
      .then(work)
      .catch((error: unknown) => this.options.log('duel step failed', { duelId: this.duelId, error }));
  }

  private clearTimer(): void {
    this.timer?.cancel();
    this.timer = null;
  }

  private reject(characterId: string, code: 'STALE_SEQ'): void {
    this.options.hub.sendToCharacter(characterId, {
      type: 'duel:error',
      code,
      message: 'That throw was already locked in.',
    } satisfies ServerMessage);
  }

  /**
   * A duplicate's rejection is queued behind the write for the throw that won, so a client
   * can never learn the outcome of a throw before `duel_actions` has it.
   */
  private rejectAfterPendingWrites(characterId: string, code: 'STALE_SEQ'): void {
    this.enqueue(async () => {
      this.reject(characterId, code);
    });
  }

  private openWindow(): void {
    if (this.finished) return;
    this.locked = new Map();
    this.windowOpen = true;
    this.deadlineAt = this.options.clock.now() + this.options.roundMs;

    this.options.hub.sendToCharacters(this.characterIds, {
      type: 'duel:round',
      duelId: this.duelId,
      round: this.score.round,
      replay: this.score.replay,
      seq: this.seq,
      deadlineAt: new Date(this.deadlineAt).toISOString(),
    });

    this.clearTimer();
    this.timer = this.options.clock.after(this.options.roundMs, () => this.closeWindow());
  }

  /**
   * The one place a window resolves, from either trigger. Guarded by clearing the timer and
   * by the `finished` and `windowOpen` flags, so the deadline firing while both throws land
   * cannot double-run, and a window that is not open cannot be closed at all.
   */
  private closeWindow(): void {
    if (this.finished || !this.windowOpen) return;
    this.windowOpen = false;
    this.clearTimer();
    const window = { round: this.score.round, replay: this.score.replay, seq: this.seq };
    // Auto-throws are picked here, at resolution: a duelist who never locked gets the same
    // ~1-in-3 odds they had, rather than a forfeit that a network blip could make lethal.
    const throws: Record<DuelSide, Locked> = {
      challenger: this.locked.get(this.options.challenger.characterId) ?? autoThrow(),
      opponent: this.locked.get(this.options.opponent.characterId) ?? autoThrow(),
    };
    this.locked = new Map();

    const resolution = resolveRound(this.score, throws.challenger.throw, throws.opponent.throw, () =>
      this.breakTie(window.round, window.replay),
    );
    this.score = resolution.next;
    this.seq += 1;

    this.enqueue(async () => {
      for (const side of ['challenger', 'opponent'] as const) {
        await insertDuelAction(this.options.db, {
          duelId: this.duelId,
          round: window.round,
          replay: window.replay,
          seq: window.seq,
          characterId: this.bySide[side].characterId,
          throw: throws[side].throw,
          autoThrown: throws[side].autoThrown,
          at: new Date(this.options.clock.now()),
        });
      }
      await updateDuelProgress(this.options.db, this.duelId, {
        round: resolution.next.round,
        replaysThisRound: resolution.next.replay,
        challengerWins: resolution.next.challengerWins,
        opponentWins: resolution.next.opponentWins,
      });

      /**
       * Composed per recipient rather than broadcast: this is the frame in which the throws
       * become public, and each duelist is told which of the two is theirs. There is no code
       * path that puts an opponent's throw in a message sent before this point.
       */
      for (const side of ['challenger', 'opponent'] as const) {
        this.options.hub.sendToCharacter(this.bySide[side].characterId, {
          type: 'duel:round_result',
          duelId: this.duelId,
          round: window.round,
          replay: window.replay,
          seq: window.seq,
          yourThrow: throws[side].throw,
          opponentThrow: throws[other(side)].throw,
          winner: resolution.winner === 'draw' ? 'draw' : resolution.winner === side ? 'you' : 'opponent',
          tiebreak: resolution.tiebreak,
          challengerWins: resolution.next.challengerWins,
          opponentWins: resolution.next.opponentWins,
        });
      }

      if (resolution.matchWinner) {
        this.complete(resolution.matchWinner);
        return;
      }

      this.timer = this.options.clock.after(this.options.revealMs, () => {
        this.enqueue(async () => this.openWindow());
      });
    });
  }

  /**
   * Seeded and deterministic, from the 32 random bytes persisted with the duel — the same
   * rigor as the poker deck seed, and replayable next to the append-only throw log.
   */
  private breakTie(round: number, replay: number): DuelSide {
    const digest = createHash('sha256').update(`${this.options.tiebreakSeed}:${round}:${replay}`).digest();
    return digest[0]! % 2 === 0 ? 'challenger' : 'opponent';
  }

  private complete(winner: DuelSide): void {
    if (this.finished) return;
    this.finished = true;
    this.clearTimer();
    this.options.onComplete({
      duelId: this.duelId,
      winner,
      winnerCharacterId: this.bySide[winner].characterId,
      loserCharacterId: this.bySide[other(winner)].characterId,
      challengerWins: this.score.challengerWins,
      opponentWins: this.score.opponentWins,
    });
  }
}

function other(side: DuelSide): DuelSide {
  return side === 'challenger' ? 'opponent' : 'challenger';
}

function autoThrow(): Locked {
  return { throw: DUEL_THROWS[randomInt(0, DUEL_THROWS.length)]!, autoThrown: true };
}
