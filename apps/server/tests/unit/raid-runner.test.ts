import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@lethalmagotchi/shared';
import { RaidRunner, seededRemainderSplit, type RaidSplit } from '../../src/raid/runner.js';
import type { Db } from '../../src/db/pool.js';
import type { Hub } from '../../src/ws/hub.js';
import { ManualClock, settle } from '../helpers/clock.js';

/** Every frame the runner emitted, per recipient, kept as raw text for the leak assertions. */
class RecordingHub {
  readonly sent: { characterId: string; frame: string }[] = [];

  sendToCharacter(characterId: string, message: ServerMessage): void {
    this.sent.push({ characterId, frame: JSON.stringify(message) });
  }

  sendToCharacters(characterIds: Iterable<string>, message: ServerMessage): void {
    for (const characterId of characterIds) this.sendToCharacter(characterId, message);
  }

  framesFor(characterId: string): string[] {
    return this.sent.filter((entry) => entry.characterId === characterId).map((entry) => entry.frame);
  }

  typesFor(characterId: string): string[] {
    return this.framesFor(characterId).map((frame) => JSON.parse(frame).type as string);
  }
}

const RAIDERS = [
  { characterId: 'aaa', nickname: 'Ash' },
  { characterId: 'bbb', nickname: 'Bo' },
  { characterId: 'ccc', nickname: 'Cy' },
];

function build(options: { potCoins: number; raiders?: typeof RAIDERS }) {
  const hub = new RecordingHub();
  const clock = new ManualClock(1_800_000_000_000);
  const queries: unknown[][] = [];
  const db = {
    query: async (text: string, values?: unknown[]) => {
      queries.push([text, values]);
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Db;

  let completion: RaidSplit | null = null;
  const runner = new RaidRunner({
    raidId: 'raid-1',
    raiders: options.raiders ?? RAIDERS,
    potCoins: options.potCoins,
    paritySeed: 'seed-for-the-capped-round',
    db,
    hub: hub as unknown as Hub,
    clock,
    betrayalMs: 10_000,
    parityMs: 8_000,
    revealMs: 500,
    log: () => {},
    onComplete: (split) => {
      completion = split;
    },
  });

  return { runner, hub, clock, queries, result: () => completion };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the betrayal window', () => {
  it('never puts a choice in any frame before the simultaneous reveal', async () => {
    const { runner, hub, clock } = build({ potCoins: 9 });
    runner.start();
    await settle(0);

    const window = JSON.parse(hub.framesFor('aaa')[0]!);
    runner.betray('aaa', { raidId: 'raid-1', seq: window.seq, choice: 'betray' });
    runner.betray('bbb', { raidId: 'raid-1', seq: window.seq, choice: 'loyal' });
    await settle(10);

    // Two of three have locked. Nothing anyone has received says which way either went.
    for (const raider of ['aaa', 'bbb', 'ccc']) {
      const before = hub.framesFor(raider).join('\n');
      expect(before).not.toContain('"choice"');
      expect(before).not.toContain('betrayal_result');
    }
    // The fact of the lock is public, and is all that is.
    expect(hub.typesFor('ccc')).toContain('raid:betrayal_locked');

    runner.betray('ccc', { raidId: 'raid-1', seq: window.seq, choice: 'loyal' });
    await clock.advance(0);
    await settle(20);

    const reveal = hub
      .framesFor('ccc')
      .find((frame) => JSON.parse(frame).type === 'raid:betrayal_result');
    expect(reveal).toBeDefined();
    // The reveal is the first frame in which the word appears at all.
    const firstWithChoice = hub.framesFor('ccc').findIndex((frame) => frame.includes('"choice"'));
    expect(JSON.parse(hub.framesFor('ccc')[firstWithChoice]!).type).toBe('raid:betrayal_result');
  });

  it('refuses a stale or duplicate seq and keeps the first choice', async () => {
    const { runner, hub, clock } = build({ potCoins: 6 });
    runner.start();
    await settle(0);
    const { seq } = JSON.parse(hub.framesFor('aaa')[0]!);

    runner.betray('aaa', { raidId: 'raid-1', seq, choice: 'loyal' });
    runner.betray('aaa', { raidId: 'raid-1', seq, choice: 'betray' });
    runner.betray('aaa', { raidId: 'raid-1', seq: seq + 3, choice: 'betray' });
    await settle(10);

    const errors = hub
      .framesFor('aaa')
      .map((frame) => JSON.parse(frame))
      .filter((message) => message.type === 'raid:error');
    expect(errors).toHaveLength(2);
    expect(errors.every((message) => message.code === 'STALE_SEQ')).toBe(true);

    await clock.advance(10_000);
    await settle(20);
    const reveal = hub
      .framesFor('aaa')
      .map((frame) => JSON.parse(frame))
      .find((message) => message.type === 'raid:betrayal_result');
    expect(reveal.choices.find((entry: { characterId: string }) => entry.characterId === 'aaa').choice).toBe(
      'loyal',
    );
  });

  it('records an absent raider as loyal rather than picking for them', async () => {
    const { runner, hub, clock, result } = build({ potCoins: 6 });
    runner.start();
    await settle(0);
    const { seq } = JSON.parse(hub.framesFor('aaa')[0]!);
    runner.betray('aaa', { raidId: 'raid-1', seq, choice: 'betray' });

    // Nobody else answers. The deadline is a server-side absolute and does not wait.
    await clock.advance(10_000);
    await settle(20);

    expect(result()).not.toBeNull();
    // A lone betrayer among two no-shows takes it all: loyalty is never a play for an absentee.
    expect(result()!.awards).toEqual({ aaa: 6, bbb: 0, ccc: 0 });
    expect(result()!.choices.filter((entry) => entry.choice === 'loyal')).toHaveLength(2);
  });

  it('completes immediately when the pot divides, without a parity round', async () => {
    const { runner, hub, clock, result } = build({ potCoins: 9 });
    runner.start();
    await settle(0);
    const { seq } = JSON.parse(hub.framesFor('aaa')[0]!);
    for (const id of ['aaa', 'bbb', 'ccc']) {
      runner.betray(id, { raidId: 'raid-1', seq, choice: 'loyal' });
    }
    await clock.advance(0);
    await settle(20);

    expect(result()!.awards).toEqual({ aaa: 3, bbb: 3, ccc: 3 });
    expect(hub.typesFor('aaa')).not.toContain('raid:parity_round');
  });
});

describe('the parity game', () => {
  it('opens a round for the remainder alone, and pays the base share first', async () => {
    const { runner, hub, clock } = build({ potCoins: 5 });
    runner.start();
    await settle(0);
    const { seq } = JSON.parse(hub.framesFor('aaa')[0]!);
    for (const id of ['aaa', 'bbb', 'ccc']) {
      runner.betray(id, { raidId: 'raid-1', seq, choice: 'loyal' });
    }
    await clock.advance(0);
    await settle(20);

    const reveal = hub
      .framesFor('aaa')
      .map((frame) => JSON.parse(frame))
      .find((message) => message.type === 'raid:betrayal_result');
    // 5 among 3: one each, and two coins left to play for.
    expect(reveal.awards).toEqual(
      expect.arrayContaining([{ characterId: 'aaa', coins: 1 }, { characterId: 'bbb', coins: 1 }]),
    );
    expect(reveal.remainder).toBe(2);

    await clock.advance(500);
    await settle(20);
    const round = hub
      .framesFor('aaa')
      .map((frame) => JSON.parse(frame))
      .find((message) => message.type === 'raid:parity_round');
    expect(round.remainder).toBe(2);
    expect(round.contenders).toEqual(['aaa', 'bbb', 'ccc']);
  });

  it('never leaks a call before its reveal', async () => {
    const { runner, hub, clock } = build({ potCoins: 5 });
    runner.start();
    await settle(0);
    const betrayalSeq = JSON.parse(hub.framesFor('aaa')[0]!).seq;
    for (const id of ['aaa', 'bbb', 'ccc']) {
      runner.betray(id, { raidId: 'raid-1', seq: betrayalSeq, choice: 'loyal' });
    }
    // The reveal timer is armed only once the betrayal's queued writes have landed.
    await clock.advance(0);
    await settle(20);
    await clock.advance(500);
    await settle(20);

    const round = hub
      .framesFor('aaa')
      .map((frame) => JSON.parse(frame))
      .find((message) => message.type === 'raid:parity_round');

    runner.parity('aaa', { raidId: 'raid-1', seq: round.seq, call: 'odds', throw: 3 });
    runner.parity('bbb', { raidId: 'raid-1', seq: round.seq, call: 'evens', throw: 2 });
    await settle(10);

    for (const raider of ['aaa', 'bbb', 'ccc']) {
      const seen = hub
        .framesFor(raider)
        .filter((frame) => JSON.parse(frame).type !== 'raid:parity_result')
        .join('\n');
      expect(seen).not.toContain('"call"');
      expect(seen).not.toContain('"throw"');
    }
  });

  it('distributes the whole remainder and conserves the pot exactly', async () => {
    const { runner, hub, clock, result } = build({ potCoins: 5 });
    runner.start();
    await settle(0);
    const betrayalSeq = JSON.parse(hub.framesFor('aaa')[0]!).seq;
    for (const id of ['aaa', 'bbb', 'ccc']) {
      runner.betray(id, { raidId: 'raid-1', seq: betrayalSeq, choice: 'loyal' });
    }
    // The reveal timer is armed only once the betrayal's queued writes have landed.
    await clock.advance(0);
    await settle(20);
    await clock.advance(500);
    await settle(20);
    const round = hub
      .framesFor('aaa')
      .map((frame) => JSON.parse(frame))
      .find((message) => message.type === 'raid:parity_round');

    // Sum 1 is odd; two call odds, so the two remaining coins go one each.
    runner.parity('aaa', { raidId: 'raid-1', seq: round.seq, call: 'odds', throw: 1 });
    runner.parity('bbb', { raidId: 'raid-1', seq: round.seq, call: 'odds', throw: 0 });
    runner.parity('ccc', { raidId: 'raid-1', seq: round.seq, call: 'evens', throw: 0 });
    await clock.advance(0);
    await settle(20);

    expect(result()).not.toBeNull();
    const total = Object.values(result()!.awards).reduce((sum, coins) => sum + coins, 0);
    expect(total).toBe(5);
    expect(result()!.awards).toEqual({ aaa: 2, bbb: 2, ccc: 1 });
  });

  it('re-runs a round nobody called, then settles it', async () => {
    const { runner, hub, clock, result } = build({ potCoins: 5 });
    runner.start();
    await settle(0);
    const betrayalSeq = JSON.parse(hub.framesFor('aaa')[0]!).seq;
    for (const id of ['aaa', 'bbb', 'ccc']) {
      runner.betray(id, { raidId: 'raid-1', seq: betrayalSeq, choice: 'loyal' });
    }
    // The reveal timer is armed only once the betrayal's queued writes have landed.
    await clock.advance(0);
    await settle(20);
    await clock.advance(500);
    await settle(20);

    const first = hub
      .framesFor('aaa')
      .map((frame) => JSON.parse(frame))
      .find((message) => message.type === 'raid:parity_round');
    // Sum 2 is even; all three call odds, so nobody is right and the round re-runs.
    for (const id of ['aaa', 'bbb', 'ccc']) {
      runner.parity(id, { raidId: 'raid-1', seq: first.seq, call: 'odds', throw: id === 'aaa' ? 2 : 0 });
    }
    await clock.advance(0);
    await settle(20);
    await clock.advance(500);
    await settle(20);

    const rounds = hub
      .framesFor('aaa')
      .map((frame) => JSON.parse(frame))
      .filter((message) => message.type === 'raid:parity_round');
    expect(rounds).toHaveLength(2);
    expect(rounds[1].round).toBe(2);
    expect(rounds[1].remainder).toBe(2);
    expect(rounds[1].contenders).toEqual(['aaa', 'bbb', 'ccc']);
    expect(result()).toBeNull();
  });

  it('ends a stalemate with the seeded split rather than looping on it', async () => {
    const { runner, hub, clock, result } = build({ potCoins: 5 });
    runner.start();
    await settle(0);
    const betrayalSeq = JSON.parse(hub.framesFor('aaa')[0]!).seq;
    for (const id of ['aaa', 'bbb', 'ccc']) {
      runner.betray(id, { raidId: 'raid-1', seq: betrayalSeq, choice: 'loyal' });
    }
    await clock.advance(0);
    await settle(20);

    // Every round is unanimously correct, which divides nothing and eliminates nobody —
    // the one shape the design's termination argument does not cover.
    for (let round = 0; round < 8 && result() === null; round += 1) {
      await clock.advance(500);
      await settle(20);
      const open = hub
        .framesFor('aaa')
        .map((frame) => JSON.parse(frame))
        .filter((message) => message.type === 'raid:parity_round')
        .at(-1);
      if (!open) break;
      for (const id of ['aaa', 'bbb', 'ccc']) {
        runner.parity(id, { raidId: 'raid-1', seq: open.seq, call: 'odds', throw: id === 'aaa' ? 1 : 0 });
      }
      await clock.advance(0);
      await settle(20);
    }

    expect(result()).not.toBeNull();
    const total = Object.values(result()!.awards).reduce((sum, coins) => sum + coins, 0);
    expect(total).toBe(5);
    const seeded = hub
      .framesFor('aaa')
      .map((frame) => JSON.parse(frame))
      .filter((message) => message.type === 'raid:parity_result' && message.seededSplit);
    expect(seeded).toHaveLength(1);
  });
});

describe('the lock frame and the resync', () => {
  /** Drives a 3-raider raid to an open parity round with one call already locked in. */
  async function toOpenParityRound(build0: ReturnType<typeof build>) {
    const { runner, hub, clock } = build0;
    runner.start();
    await settle(0);
    const betrayalSeq = JSON.parse(hub.framesFor('aaa')[0]!).seq;
    for (const id of ['aaa', 'bbb', 'ccc']) {
      runner.betray(id, { raidId: 'raid-1', seq: betrayalSeq, choice: 'loyal' });
    }
    await clock.advance(0);
    await settle(20);
    await clock.advance(500);
    await settle(20);
    return hub
      .framesFor('aaa')
      .map((frame) => JSON.parse(frame))
      .filter((message) => message.type === 'raid:parity_round')
      .at(-1);
  }

  it('names the window a lock was made in, in both phases', async () => {
    const harness = build({ potCoins: 5 });
    const { runner, hub } = harness;
    runner.start();
    await settle(0);
    const betrayalSeq = JSON.parse(hub.framesFor('aaa')[0]!).seq;
    runner.betray('bbb', { raidId: 'raid-1', seq: betrayalSeq, choice: 'loyal' });
    await settle(10);

    const betrayalLock = hub
      .framesFor('aaa')
      .map((frame) => JSON.parse(frame))
      .find((message) => message.type === 'raid:betrayal_locked');
    expect(betrayalLock.phase).toBe('betrayal');
    expect(betrayalLock.seq).toBe(betrayalSeq);

    for (const id of ['aaa', 'ccc']) {
      runner.betray(id, { raidId: 'raid-1', seq: betrayalSeq, choice: 'loyal' });
    }
    await harness.clock.advance(0);
    await settle(20);
    await harness.clock.advance(500);
    await settle(20);
    const round = hub
      .framesFor('aaa')
      .map((frame) => JSON.parse(frame))
      .filter((message) => message.type === 'raid:parity_round')
      .at(-1);
    runner.parity('bbb', { raidId: 'raid-1', seq: round.seq, call: 'odds', throw: 1 });
    await settle(10);

    const parityLock = hub
      .framesFor('aaa')
      .map((frame) => JSON.parse(frame))
      .filter((message) => message.type === 'raid:betrayal_locked')
      .at(-1);
    expect(parityLock.phase).toBe('parity');
    expect(parityLock.seq).toBe(round.seq);
  });

  it('replays parity locks to a reconnecting raider, as it does betrayal locks', async () => {
    const harness = build({ potCoins: 5 });
    const round = await toOpenParityRound(harness);
    harness.runner.parity('bbb', { raidId: 'raid-1', seq: round.seq, call: 'odds', throw: 1 });
    await settle(10);

    const before = harness.hub.framesFor('ccc').length;
    harness.runner.resync('ccc');
    await settle(10);

    const replayed = harness.hub
      .framesFor('ccc')
      .slice(before)
      .map((frame) => JSON.parse(frame));
    expect(replayed.some((message) => message.type === 'raid:parity_round')).toBe(true);
    const locks = replayed.filter((message) => message.type === 'raid:betrayal_locked');
    expect(locks.map((message) => message.characterId)).toEqual(['bbb']);
    expect(locks.every((message) => message.phase === 'parity')).toBe(true);
    // The fact of the call, never the call itself.
    expect(harness.hub.framesFor('ccc').slice(before).join('\n')).not.toContain('"call"');
  });

  it('says nothing at all for a resync landing in the reveal beat', async () => {
    const { runner, hub, clock } = build({ potCoins: 5 });
    runner.start();
    await settle(0);
    const betrayalSeq = JSON.parse(hub.framesFor('aaa')[0]!).seq;
    for (const id of ['aaa', 'bbb', 'ccc']) {
      runner.betray(id, { raidId: 'raid-1', seq: betrayalSeq, choice: 'loyal' });
    }
    await clock.advance(0);
    await settle(20);

    // Between the betrayal reveal and round 1 opening: no window is open, and round 1 is
    // not a round yet.
    const before = hub.framesFor('aaa').length;
    runner.resync('aaa');
    await settle(10);
    expect(hub.framesFor('aaa').slice(before)).toEqual([]);

    await clock.advance(500);
    await settle(20);
    const rounds = hub
      .framesFor('aaa')
      .map((frame) => JSON.parse(frame))
      .filter((message) => message.type === 'raid:parity_round');
    expect(rounds.map((message) => message.round), 'round 0 is not a round').toEqual([1]);
  });
});

describe('the seeded split', () => {
  it('hands out one coin each, deterministically, and never more than the remainder', () => {
    const first = seededRemainderSplit('seed', 5, ['aaa', 'bbb', 'ccc'], 2);
    const again = seededRemainderSplit('seed', 5, ['ccc', 'aaa', 'bbb'], 2);
    expect(first).toEqual(again);
    expect(Object.values(first).reduce((sum, coins) => sum + coins, 0)).toBe(2);
    expect(Object.values(first).every((coins) => coins <= 1)).toBe(true);

    const other = seededRemainderSplit('different-seed', 5, ['aaa', 'bbb', 'ccc'], 1);
    expect(Object.values(other).reduce((sum, coins) => sum + coins, 0)).toBe(1);
  });
});
