import { createHash, randomInt } from 'node:crypto';
import {
  PARITY_CALLS,
  PARITY_THROW_MAX,
  PARITY_THROW_MIN,
  RAID_PARITY_MAX_ROUNDS,
  mergeAwards,
  resolveBetrayal,
  resolveParityRound,
  type BetrayalChoice,
  type ParityCall,
  type ServerMessage,
} from '@lethalmagotchi/shared';
import type { Db } from '../db/pool.js';
import { insertParityAction, recordBetrayal } from '../repos/raids.js';
import type { Clock, Timer } from '../tournament/clock.js';
import type { Hub } from '../ws/hub.js';

export interface RaidRaider {
  characterId: string;
  nickname: string;
}

export interface RaidSplit {
  awards: Record<string, number>;
  choices: { characterId: string; choice: BetrayalChoice }[];
  potDestroyed: boolean;
}

export interface RaidRunnerOptions {
  raidId: string;
  raiders: RaidRaider[];
  potCoins: number;
  paritySeed: string;
  db: Db;
  hub: Hub;
  clock: Clock;
  betrayalMs: number;
  parityMs: number;
  revealMs: number;
  log: (message: string, meta?: Record<string, unknown>) => void;
  onComplete: (split: RaidSplit) => void;
}

interface LockedCall {
  call: ParityCall;
  throw: number;
  auto: boolean;
}

/**
 * The hidden-information half of a raid: the betrayal commit window and however many parity
 * rounds the remainder needs. Structurally the same as `DuelRunner` — one in-memory timer,
 * every write serialised on a promise chain, every deadline from an injected clock, and a
 * `windowOpen` flag that flips atomically with the phase transition so a frame sent into the
 * reveal beat cannot be accepted and then discarded.
 *
 * It never pauses for a disconnected raider: an absent raider is recorded as Loyal (the
 * choice that can never take anything from anyone) and gets a random parity call, which is
 * the same odds they had.
 */
export class RaidRunner {
  readonly raidId: string;

  private readonly options: RaidRunnerOptions;
  private readonly raiderIds: string[];

  /**
   * `reveal` is the beat between a closed window and the next one. It is a phase of its own
   * rather than an early flip to `parity`, so `parityRound` can never be read before the
   * round it names is open — the same "the transition is atomic or it is a bug" rule the
   * duel runner's `windowOpen` follows.
   */
  private phase: 'betrayal' | 'reveal' | 'parity' | 'done' = 'betrayal';
  private seq = 0;
  private parityRound = 0;
  private deadlineAt = 0;
  private windowOpen = false;

  private betrayals = new Map<string, BetrayalChoice>();
  private calls = new Map<string, LockedCall>();
  private contenders: string[] = [];
  private remainder = 0;
  private awards: Record<string, number> = {};
  private choices: { characterId: string; choice: BetrayalChoice }[] = [];
  private potDestroyed = false;

  private timer: Timer | null = null;
  private stopped = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(options: RaidRunnerOptions) {
    this.options = options;
    this.raidId = options.raidId;
    this.raiderIds = options.raiders.map((raider) => raider.characterId);
  }

  get characterIds(): string[] {
    return [...this.raiderIds];
  }

  start(): void {
    this.enqueue(async () => this.openBetrayalWindow());
  }

  /**
   * Everything a reconnecting raider needs to rebuild the screen, minus the live choices.
   * Only ever sent for a window that is genuinely open: replaying a closed one would offer a
   * deadline already in the past and a control whose only possible answer is `STALE_SEQ`.
   * A reconnect landing in a reveal beat is told nothing and gets the next window's own
   * broadcast a beat later.
   */
  resync(characterId: string): void {
    if (!this.raiderIds.includes(characterId) || !this.windowOpen) return;
    const deadline = new Date(this.deadlineAt).toISOString();

    if (this.phase === 'betrayal') {
      this.options.hub.sendToCharacter(characterId, {
        type: 'raid:betrayal_window',
        raidId: this.raidId,
        seq: this.seq,
        deadlineAt: deadline,
        potCoins: this.options.potCoins,
      });
      // The fact of each lock is public; the choice is not, and is not sent here.
      this.replayLocks(characterId, [...this.betrayals.keys()], 'betrayal');
      return;
    }

    this.options.hub.sendToCharacter(characterId, {
      type: 'raid:parity_round',
      raidId: this.raidId,
      seq: this.seq,
      round: this.parityRound,
      deadlineAt: deadline,
      remainder: this.remainder,
      contenders: [...this.contenders],
    });
    this.replayLocks(characterId, [...this.calls.keys()], 'parity');
  }

  private replayLocks(characterId: string, locked: string[], phase: 'betrayal' | 'parity'): void {
    for (const lockedId of locked) {
      if (lockedId === characterId) continue;
      this.options.hub.sendToCharacter(characterId, {
        type: 'raid:betrayal_locked',
        raidId: this.raidId,
        characterId: lockedId,
        phase,
        seq: this.seq,
      });
    }
  }

  betray(characterId: string, input: { raidId: string; seq: number; choice: BetrayalChoice }): void {
    if (
      this.stopped ||
      this.phase !== 'betrayal' ||
      !this.windowOpen ||
      input.raidId !== this.raidId ||
      input.seq !== this.seq ||
      !this.raiderIds.includes(characterId) ||
      this.betrayals.has(characterId)
    ) {
      this.rejectAfterPendingWrites(characterId);
      return;
    }

    this.betrayals.set(characterId, input.choice);
    this.announceLock(characterId, 'betrayal');

    if (this.betrayals.size === this.raiderIds.length) this.closeBetrayalWindow();
  }

  parity(
    characterId: string,
    input: { raidId: string; seq: number; call: ParityCall; throw: number },
  ): void {
    if (
      this.stopped ||
      this.phase !== 'parity' ||
      !this.windowOpen ||
      input.raidId !== this.raidId ||
      input.seq !== this.seq ||
      !this.contenders.includes(characterId) ||
      this.calls.has(characterId)
    ) {
      this.rejectAfterPendingWrites(characterId);
      return;
    }

    this.calls.set(characterId, { call: input.call, throw: input.throw, auto: false });
    this.announceLock(characterId, 'parity');

    if (this.calls.size === this.contenders.length) this.closeParityWindow();
  }

  private announceLock(characterId: string, phase: 'betrayal' | 'parity'): void {
    for (const raiderId of this.raiderIds) {
      if (raiderId === characterId) continue;
      this.options.hub.sendToCharacter(raiderId, {
        type: 'raid:betrayal_locked',
        raidId: this.raidId,
        characterId,
        phase,
        seq: this.seq,
      });
    }
  }

  /** Resolves once every queued write has landed, so a shutdown cannot drop a choice. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimer();
    await this.chain;
  }

  /* ------------------------------------------------------------------ */

  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain
      .then(work)
      .catch((error: unknown) => this.options.log('raid step failed', { raidId: this.raidId, error }));
  }

  private clearTimer(): void {
    this.timer?.cancel();
    this.timer = null;
  }

  /**
   * A duplicate's rejection is queued behind the write for the choice that won, so a client
   * can never learn the outcome of a choice before it has been recorded.
   */
  private rejectAfterPendingWrites(characterId: string): void {
    this.enqueue(async () => {
      this.options.hub.sendToCharacter(characterId, {
        type: 'raid:error',
        code: 'STALE_SEQ',
        message: 'That choice was already locked in.',
      } satisfies ServerMessage);
    });
  }

  private openBetrayalWindow(): void {
    if (this.stopped) return;
    this.betrayals = new Map();
    this.windowOpen = true;
    this.deadlineAt = this.options.clock.now() + this.options.betrayalMs;

    this.options.hub.sendToCharacters(this.raiderIds, {
      type: 'raid:betrayal_window',
      raidId: this.raidId,
      seq: this.seq,
      deadlineAt: new Date(this.deadlineAt).toISOString(),
      potCoins: this.options.potCoins,
    });

    this.clearTimer();
    this.timer = this.options.clock.after(this.options.betrayalMs, () => this.closeBetrayalWindow());
  }

  /** The one place the betrayal window resolves, from either trigger. */
  private closeBetrayalWindow(): void {
    if (this.stopped || this.phase !== 'betrayal' || !this.windowOpen) return;
    this.windowOpen = false;
    this.phase = 'reveal';
    this.clearTimer();
    const window = this.seq;

    /**
     * An absent raider is Loyal, not random: loyalty is the only default that can never take
     * coins from somebody who was there, so walking away is never a play.
     */
    const entries = this.raiderIds.map((characterId) => ({
      characterId,
      choice: this.betrayals.get(characterId) ?? ('loyal' as BetrayalChoice),
      auto: !this.betrayals.has(characterId),
    }));
    this.betrayals = new Map();

    const split = resolveBetrayal(
      entries.map(({ characterId, choice }) => ({ characterId, choice })),
      this.options.potCoins,
    );
    this.awards = split.awards;
    this.potDestroyed = split.potDestroyed;
    this.choices = entries.map(({ characterId, choice }) => ({ characterId, choice }));
    this.remainder = split.remainder;
    this.contenders = split.contenders;
    this.seq += 1;

    this.enqueue(async () => {
      for (const entry of entries) {
        await recordBetrayal(this.options.db, {
          raidId: this.raidId,
          characterId: entry.characterId,
          betrayed: entry.choice === 'betray',
          auto: entry.auto,
        });
      }

      /**
       * The first frame in which any choice leaves the server. There is no code path that
       * puts a choice in a message sent before this point.
       */
      this.options.hub.sendToCharacters(this.raiderIds, {
        type: 'raid:betrayal_result',
        raidId: this.raidId,
        seq: window,
        choices: this.choices,
        awards: toAwardList(this.awards),
        potDestroyed: this.potDestroyed,
        remainder: this.remainder,
      });

      if (this.remainder === 0 || this.contenders.length === 0) {
        this.finish();
        return;
      }

      this.timer = this.options.clock.after(this.options.revealMs, () => {
        this.enqueue(async () => this.openParityWindow());
      });
    });
  }

  /** The round number, the phase and the open window all become true together, or not yet. */
  private openParityWindow(): void {
    if (this.stopped) return;
    this.parityRound += 1;
    this.calls = new Map();
    this.phase = 'parity';
    this.windowOpen = true;
    this.deadlineAt = this.options.clock.now() + this.options.parityMs;

    this.options.hub.sendToCharacters(this.raiderIds, {
      type: 'raid:parity_round',
      raidId: this.raidId,
      seq: this.seq,
      round: this.parityRound,
      deadlineAt: new Date(this.deadlineAt).toISOString(),
      remainder: this.remainder,
      contenders: [...this.contenders],
    });

    this.clearTimer();
    this.timer = this.options.clock.after(this.options.parityMs, () => this.closeParityWindow());
  }

  private closeParityWindow(): void {
    if (this.stopped || this.phase !== 'parity' || !this.windowOpen) return;
    this.windowOpen = false;
    this.phase = 'reveal';
    this.clearTimer();
    const window = this.seq;
    const round = this.parityRound;

    const entries = this.contenders.map((characterId) => {
      const locked = this.calls.get(characterId) ?? autoCall();
      return { characterId, ...locked };
    });
    this.calls = new Map();
    this.seq += 1;

    /**
     * The cap, and why it exists: the design's termination argument holds for every round
     * except a unanimously correct one, which divides nothing and shrinks nobody. Rather
     * than let a live pot ride on that tail, the remainder is split by the persisted seed —
     * the same escape hatch a drawn duel round takes.
     */
    const capped = round >= RAID_PARITY_MAX_ROUNDS;
    const resolution = resolveParityRound(
      entries.map(({ characterId, call, throw: value }) => ({ characterId, call, throw: value })),
      this.remainder,
    );
    const seeded = capped
      ? seededRemainderSplit(this.options.paritySeed, round, this.contenders, this.remainder)
      : null;

    const roundAwards = seeded ?? resolution.awards;
    this.awards = mergeAwards(this.awards, roundAwards);
    const nextRemainder = seeded ? 0 : resolution.remainder;
    const nextContenders = seeded ? [] : resolution.replay ? [...this.contenders] : resolution.contenders;

    this.enqueue(async () => {
      for (const entry of entries) {
        await insertParityAction(this.options.db, {
          raidId: this.raidId,
          round,
          seq: window,
          characterId: entry.characterId,
          call: entry.call,
          throw: entry.throw,
          auto: entry.auto,
          at: new Date(this.options.clock.now()),
        });
      }

      this.options.hub.sendToCharacters(this.raiderIds, {
        type: 'raid:parity_result',
        raidId: this.raidId,
        seq: window,
        round,
        calls: entries.map(({ characterId, call, throw: value }) => ({ characterId, call, throw: value })),
        parity: resolution.parity,
        winners: seeded ? Object.keys(seeded).filter((id) => (seeded[id] ?? 0) > 0) : resolution.winners,
        awards: toAwardList(roundAwards),
        seededSplit: seeded !== null,
      });

      this.remainder = nextRemainder;
      this.contenders = nextContenders;

      if (this.remainder === 0 || this.contenders.length === 0) {
        this.finish();
        return;
      }

      this.timer = this.options.clock.after(this.options.revealMs, () => {
        this.enqueue(async () => this.openParityWindow());
      });
    });
  }

  private finish(): void {
    if (this.phase === 'done') return;
    this.phase = 'done';
    this.clearTimer();
    this.options.onComplete({
      awards: this.awards,
      choices: this.choices,
      potDestroyed: this.potDestroyed,
    });
  }
}

function autoCall(): LockedCall {
  return {
    call: PARITY_CALLS[randomInt(0, PARITY_CALLS.length)]!,
    throw: randomInt(PARITY_THROW_MIN, PARITY_THROW_MAX + 1),
    auto: true,
  };
}

function toAwardList(awards: Record<string, number>): { characterId: string; coins: number }[] {
  return Object.entries(awards).map(([characterId, coins]) => ({ characterId, coins }));
}

/**
 * The capped round's decision: a deterministic order derived from the raid's persisted seed,
 * handing one coin each to the first `remainder` contenders. Replayable next to the
 * append-only call log, exactly like a duel's seeded tiebreak.
 */
export function seededRemainderSplit(
  seed: string,
  round: number,
  contenders: string[],
  remainder: number,
): Record<string, number> {
  const ordered = [...contenders].sort((left, right) => {
    const a = createHash('sha256').update(`${seed}:${round}:${left}`).digest('hex');
    const b = createHash('sha256').update(`${seed}:${round}:${right}`).digest('hex');
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const awards: Record<string, number> = {};
  for (const characterId of contenders) awards[characterId] = 0;
  for (let index = 0; index < remainder && index < ordered.length; index += 1) {
    awards[ordered[index]!] = (awards[ordered[index]!] ?? 0) + 1;
  }
  return awards;
}
