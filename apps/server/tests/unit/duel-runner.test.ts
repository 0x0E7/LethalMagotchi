import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DUEL_MAX_REPLAYS, type DuelThrow, type ServerMessage } from '@lethalmagotchi/shared';
import type { Db } from '../../src/db/pool.js';
import { DuelRunner, type DuelCompletion, type Duelist } from '../../src/duel/runner.js';
import type { Hub } from '../../src/ws/hub.js';
import { ManualClock, settle } from '../helpers/clock.js';

interface Sent {
  to: string;
  message: ServerMessage;
}

/** Everything the runner writes goes through one `query`; nothing here reads it back. */
function stubDb(writes: unknown[][] = []): Db {
  return {
    query: async (text: string, values: unknown[] = []) => {
      writes.push([text, ...values]);
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Db;
}

function stubHub(sent: Sent[]): Hub {
  return {
    sendToCharacter: (to: string, message: ServerMessage) => sent.push({ to, message }),
    sendToCharacters: (ids: Iterable<string>, message: ServerMessage) => {
      for (const to of ids) sent.push({ to, message });
    },
    isOnline: () => true,
  } as unknown as Hub;
}

const CHALLENGER = 'aaaaaaaa-0000-4000-8000-000000000001';
const OPPONENT = 'bbbbbbbb-0000-4000-8000-000000000002';

function duelist(characterId: string, nickname: string): Duelist {
  return {
    characterId,
    accountId: randomUUID(),
    nickname,
    speciesId: 'otter',
    potCoins: 100,
    duelWins: 0,
    duelLosses: 0,
  };
}

interface Harness {
  runner: DuelRunner;
  sent: Sent[];
  writes: unknown[][];
  clock: ManualClock;
  completion: Promise<DuelCompletion>;
  completed: () => DuelCompletion | null;
}

function harness(options: { tiebreakSeed?: string } = {}): Harness {
  const sent: Sent[] = [];
  const writes: unknown[][] = [];
  const clock = new ManualClock();
  let resolve!: (completion: DuelCompletion) => void;
  let done: DuelCompletion | null = null;
  const completion = new Promise<DuelCompletion>((settled) => {
    resolve = settled;
  });

  const runner = new DuelRunner({
    duelId: randomUUID(),
    challenger: duelist(CHALLENGER, 'Miso'),
    opponent: duelist(OPPONENT, 'Pepper'),
    stakeCoins: 100,
    tiebreakSeed: options.tiebreakSeed ?? 'seed-under-test',
    db: stubDb(writes),
    hub: stubHub(sent),
    clock,
    roundMs: 5_000,
    revealMs: 100,
    log: () => {},
    onComplete: (result) => {
      done = result;
      resolve(result);
    },
  });

  return { runner, sent, writes, clock, completion, completed: () => done };
}

function lastRound(sent: Sent[]): Extract<ServerMessage, { type: 'duel:round' }> {
  const rounds = sent.filter((entry) => entry.message.type === 'duel:round');
  return rounds[rounds.length - 1]!.message as Extract<ServerMessage, { type: 'duel:round' }>;
}

function results(sent: Sent[], to: string): Extract<ServerMessage, { type: 'duel:round_result' }>[] {
  return sent
    .filter((entry) => entry.to === to && entry.message.type === 'duel:round_result')
    .map((entry) => entry.message as Extract<ServerMessage, { type: 'duel:round_result' }>);
}

/** Both duelists lock inside the window, so nothing is ever auto-thrown here. */
async function playRound(
  harnessed: Harness,
  challengerThrow: DuelThrow,
  opponentThrow: DuelThrow,
): Promise<void> {
  const round = lastRound(harnessed.sent);
  const frame = { duelId: round.duelId, round: round.round, replay: round.replay, seq: round.seq };
  harnessed.runner.throw(CHALLENGER, { ...frame, throw: challengerThrow });
  harnessed.runner.throw(OPPONENT, { ...frame, throw: opponentThrow });
  await settle();
  // The between-rounds beat, so the next window is open when this resolves.
  await harnessed.clock.advance(100);
}

describe('a duel match', () => {
  it('opens with both duelists told the same stake and their own side', async () => {
    const test = harness();
    test.runner.start();
    await settle();

    const starts = test.sent.filter((entry) => entry.message.type === 'duel:start');
    expect(starts).toHaveLength(2);
    const challengerStart = starts.find((entry) => entry.to === CHALLENGER)!.message as Extract<
      ServerMessage,
      { type: 'duel:start' }
    >;
    expect(challengerStart.youAre).toBe('challenger');
    expect(challengerStart.opponent.nickname).toBe('Pepper');
    expect(challengerStart.stakeCoins).toBe(100);
    expect(challengerStart.winsNeeded).toBe(2);
  });

  it('ends 2-0 without playing a dead third round', async () => {
    const test = harness();
    test.runner.start();
    await settle();

    await playRound(test, 'rock', 'scissors');
    await playRound(test, 'paper', 'rock');

    const completion = await test.completion;
    expect(completion.winnerCharacterId).toBe(CHALLENGER);
    expect(completion.loserCharacterId).toBe(OPPONENT);
    expect(completion.challengerWins).toBe(2);
    expect(completion.opponentWins).toBe(0);
    expect(results(test.sent, CHALLENGER)).toHaveLength(2);
    // No third window was ever offered.
    expect(test.sent.filter((entry) => entry.message.type === 'duel:round' && entry.to === CHALLENGER)).toHaveLength(2);
  });

  it('plays the decider of a 1-1 and stops at 2-1', async () => {
    const test = harness();
    test.runner.start();
    await settle();

    await playRound(test, 'rock', 'scissors');
    await playRound(test, 'rock', 'paper');
    expect(test.completed()).toBeNull();
    await playRound(test, 'scissors', 'paper');

    const completion = await test.completion;
    expect([completion.challengerWins, completion.opponentWins]).toEqual([2, 1]);
  });

  it('replays a draw without scoring it, and says so in the result', async () => {
    const test = harness();
    test.runner.start();
    await settle();

    await playRound(test, 'rock', 'rock');
    const [drawn] = results(test.sent, CHALLENGER);
    expect(drawn!.winner).toBe('draw');
    expect(drawn!.challengerWins).toBe(0);
    expect(drawn!.opponentWins).toBe(0);

    // Same round, next replay — the draw did not consume one of the three.
    const next = lastRound(test.sent);
    expect(next.round).toBe(1);
    expect(next.replay).toBe(1);
  });

  it('breaks the sixth straight draw with the seeded tiebreak, deterministically', async () => {
    const play = async (seed: string) => {
      const test = harness({ tiebreakSeed: seed });
      test.runner.start();
      await settle();
      for (let index = 0; index <= DUEL_MAX_REPLAYS; index += 1) await playRound(test, 'rock', 'rock');
      return results(test.sent, CHALLENGER);
    };

    const first = await play('a-fixed-seed');
    expect(first).toHaveLength(DUEL_MAX_REPLAYS + 1);
    expect(first.slice(0, DUEL_MAX_REPLAYS).every((entry) => entry.winner === 'draw')).toBe(true);

    const decided = first[DUEL_MAX_REPLAYS]!;
    expect(decided.winner).not.toBe('draw');
    expect(decided.tiebreak).toBe(true);
    expect(decided.challengerWins + decided.opponentWins).toBe(1);

    // Same seed, same break — the persisted seed is what makes it replayable.
    const again = await play('a-fixed-seed');
    expect(again[DUEL_MAX_REPLAYS]!.winner).toBe(decided.winner);
  });
});

describe('the commit window', () => {
  it('tells the opponent only that a throw was locked, never what it was', async () => {
    const test = harness();
    test.runner.start();
    await settle();

    const round = lastRound(test.sent);
    test.runner.throw(CHALLENGER, { duelId: round.duelId, round: round.round, replay: round.replay, seq: round.seq, throw: 'scissors' });
    await settle();

    const toOpponent = test.sent.filter((entry) => entry.to === OPPONENT);
    expect(toOpponent.some((entry) => entry.message.type === 'duel:opponent_locked')).toBe(true);
    expect(JSON.stringify(toOpponent)).not.toContain('scissors');
  });

  it('auto-throws for whoever missed the deadline rather than forfeiting them', async () => {
    const test = harness();
    test.runner.start();
    await settle();

    const round = lastRound(test.sent);
    test.runner.throw(CHALLENGER, { duelId: round.duelId, round: round.round, replay: round.replay, seq: round.seq, throw: 'rock' });
    await settle();
    expect(results(test.sent, CHALLENGER)).toHaveLength(0);

    await test.clock.advance(5_000);

    const [resolved] = results(test.sent, CHALLENGER);
    expect(resolved).toBeDefined();
    expect(resolved!.yourThrow).toBe('rock');
    expect(['rock', 'paper', 'scissors']).toContain(resolved!.opponentThrow);
    // The missing throw is written to the audit log flagged as the server's pick.
    const auto = test.writes.filter((write) => String(write[0]).includes('INSERT INTO duel_actions'));
    expect(auto).toHaveLength(2);
    expect(auto.some((write) => write.includes(true))).toBe(true);
  });

  it('rejects a second throw in the same window as a duplicate, and logs one throw', async () => {
    const test = harness();
    test.runner.start();
    await settle();

    const round = lastRound(test.sent);
    const frame = { duelId: round.duelId, round: round.round, replay: round.replay, seq: round.seq };
    test.runner.throw(CHALLENGER, { ...frame, throw: 'rock' });
    test.runner.throw(CHALLENGER, { ...frame, throw: 'paper' });
    test.runner.throw(OPPONENT, { ...frame, throw: 'scissors' });
    await settle();

    const rejections = test.sent.filter(
      (entry) => entry.to === CHALLENGER && entry.message.type === 'duel:error',
    );
    expect(rejections).toHaveLength(1);
    const [resolved] = results(test.sent, CHALLENGER);
    expect(resolved!.yourThrow).toBe('rock');
  });

  it('rejects a stale seq from the window before', async () => {
    const test = harness();
    test.runner.start();
    await settle();

    const first = lastRound(test.sent);
    await playRound(test, 'rock', 'scissors');

    test.runner.throw(OPPONENT, {
      duelId: first.duelId,
      round: first.round,
      replay: first.replay,
      seq: first.seq,
      throw: 'paper',
    });
    await settle();

    const rejections = test.sent.filter(
      (entry) => entry.to === OPPONENT && entry.message.type === 'duel:error',
    );
    expect(rejections).toHaveLength(1);
    expect((rejections[0]!.message as { code: string }).code).toBe('STALE_SEQ');
  });

  /**
   * Regression, QA round 1 (bug 4). `closeWindow` advances `score`/`seq` synchronously but
   * `openWindow` only runs after the reveal beat, so a throw sent into that gap used to pass
   * every guard: it was stored, the opponent was told "locked in", and then `openWindow`
   * silently dropped it and the round resolved on a random auto-throw instead.
   */
  it('rejects a throw sent during the reveal beat instead of accepting and discarding it', async () => {
    const test = harness();
    test.runner.start();
    await settle();

    const first = lastRound(test.sent);
    const frame = { duelId: first.duelId, round: first.round, replay: first.replay, seq: first.seq };
    test.runner.throw(CHALLENGER, { ...frame, throw: 'rock' });
    test.runner.throw(OPPONENT, { ...frame, throw: 'scissors' });
    await settle();

    // Round 1 has resolved; round 2's window has not opened yet.
    const mark = test.sent.length;
    test.runner.throw(CHALLENGER, {
      duelId: first.duelId,
      round: 2,
      replay: 0,
      seq: first.seq + 1,
      throw: 'rock',
    });
    await settle();

    const duringBeat = test.sent.slice(mark);
    const refusal = duringBeat.find(
      (entry) => entry.to === CHALLENGER && entry.message.type === 'duel:error',
    );
    expect(refusal).toBeDefined();
    expect((refusal!.message as { code: string }).code).toBe('STALE_SEQ');
    // And the opponent was never told a throw had been locked in for a window that was not open.
    expect(duringBeat.some((entry) => entry.message.type === 'duel:opponent_locked')).toBe(false);

    await test.clock.advance(100);
    await playRound(test, 'paper', 'rock');

    const [, second] = results(test.sent, CHALLENGER);
    // The round resolved on the throw sent into the real window, not on a substitute.
    expect(second!.yourThrow).toBe('paper');
    const writes = test.writes.filter(
      (write) => String(write[0]).includes('INSERT INTO duel_actions') && write.includes(2),
    );
    expect(writes.every((write) => !write.includes(true))).toBe(true);
  });

  it('does not resolve a round early when both duelists pre-commit into the reveal beat', async () => {
    const test = harness();
    test.runner.start();
    await settle();

    const first = lastRound(test.sent);
    const frame = { duelId: first.duelId, round: first.round, replay: first.replay, seq: first.seq };
    test.runner.throw(CHALLENGER, { ...frame, throw: 'rock' });
    test.runner.throw(OPPONENT, { ...frame, throw: 'scissors' });
    await settle();

    const next = { duelId: first.duelId, round: 2, replay: 0, seq: first.seq + 1 };
    test.runner.throw(CHALLENGER, { ...next, throw: 'rock' });
    test.runner.throw(OPPONENT, { ...next, throw: 'paper' });
    await settle();

    // Two throws in the gap used to fill `locked` and fire `closeWindow` early, resolving a
    // round whose window had never opened and cancelling the pending reveal timer.
    expect(results(test.sent, CHALLENGER)).toHaveLength(1);

    await test.clock.advance(100);
    const opened = lastRound(test.sent);
    expect({ round: opened.round, replay: opened.replay, seq: opened.seq }).toEqual({
      round: 2,
      replay: 0,
      seq: first.seq + 1,
    });
  });

  it('resyncs a reconnecting duelist without leaking the opponent live throw', async () => {
    const test = harness();
    test.runner.start();
    await settle();

    const round = lastRound(test.sent);
    test.runner.throw(OPPONENT, { duelId: round.duelId, round: round.round, replay: round.replay, seq: round.seq, throw: 'paper' });
    await settle();

    const before = test.sent.length;
    test.runner.resync(CHALLENGER);
    const resynced = test.sent.slice(before);

    expect(resynced.map((entry) => entry.message.type)).toEqual([
      'duel:start',
      'duel:round',
      'duel:opponent_locked',
    ]);
    expect(JSON.stringify(resynced)).not.toContain('paper');
  });
});
