import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ServerMessage, TableStanding } from '@lethalmagotchi/shared';
import type { Db } from '../../src/db/pool.js';
import { TableRunner, type RunnerSeat, type TableCompletion } from '../../src/tournament/table-runner.js';
import type { Hub } from '../../src/ws/hub.js';
import { ManualClock } from '../helpers/clock.js';

/** Everything the runner writes goes through one `query`; nothing here reads it back. */
function stubDb(): Db {
  return { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Db;
}

function stubHub(sent: ServerMessage[] = []): Hub {
  return {
    sendToCharacter: (_id: string, message: ServerMessage) => sent.push(message),
    sendToCharacters: (_ids: Iterable<string>, message: ServerMessage) => sent.push(message),
    isOnline: () => true,
  } as unknown as Hub;
}

function seat(index: number, overrides: Partial<RunnerSeat> = {}): RunnerSeat {
  return {
    seatIndex: index,
    characterId: `00000000-0000-4000-8000-00000000000${index}`,
    nickname: `Seat${index}`,
    speciesId: 'otter',
    stack: 0,
    handsWon: 0,
    connected: true,
    ...overrides,
  };
}

interface Harness {
  runner: TableRunner;
  completion: Promise<TableCompletion>;
  sent: ServerMessage[];
  clock: ManualClock;
}

function harness(
  seats: RunnerSeat[],
  options: { tableId?: string; handsPerTable?: number; maxSuddenDeathHands?: number } = {},
): Harness {
  const sent: ServerMessage[] = [];
  const clock = new ManualClock();
  let resolve!: (completion: TableCompletion) => void;
  const completion = new Promise<TableCompletion>((settle) => {
    resolve = settle;
  });

  const runner = new TableRunner({
    tableId: options.tableId ?? randomUUID(),
    tournamentId: randomUUID(),
    round: 1,
    totalRounds: 1,
    seats,
    db: stubDb(),
    hub: stubHub(sent),
    clock,
    turnMs: 1_000,
    showdownMs: 10,
    handsPerTable: options.handsPerTable ?? 3,
    maxSuddenDeathHands: options.maxSuddenDeathHands ?? 2,
    log: () => {},
    onComplete: resolve,
  });

  return { runner, completion, sent, clock };
}

/** The tiebreak the runner uses, recomputed independently rather than trusted. */
function expectedHashWinner(tableId: string, characterIds: string[]): string {
  return [...characterIds].sort((a, b) =>
    createHash('sha256')
      .update(`${tableId}:${a}`)
      .digest('hex')
      .localeCompare(createHash('sha256').update(`${tableId}:${b}`).digest('hex')),
  )[0]!;
}

describe('table qualification', () => {
  it('qualifies the biggest stack outright', async () => {
    const seats = [seat(0), seat(1, { stack: 7 }), seat(2)];
    const { runner, completion } = harness(seats);
    runner.start();

    const result = await completion;
    expect(result.qualifierCharacterId).toBe(seats[1]!.characterId);
    expect(result.standings[0]!.stack).toBe(7);
  });

  it('breaks a stack tie on hands won before it ever reaches the hash', async () => {
    const seats = [
      seat(0, { handsWon: 1 }),
      seat(1, { handsWon: 3 }),
      seat(2, { handsWon: 2 }),
    ];
    const { runner, completion } = harness(seats);
    runner.start();

    const result = await completion;
    expect(result.qualifierCharacterId).toBe(seats[1]!.characterId);
  });

  it('resolves a total tie with the seeded hash, matching an independent computation', async () => {
    const tableId = randomUUID();
    const seats = [seat(0), seat(1), seat(2), seat(3), seat(4)];
    const { runner, completion } = harness(seats, { tableId });
    runner.start();

    const result = await completion;
    expect(result.qualifierCharacterId).toBe(
      expectedHashWinner(tableId, seats.map((entry) => entry.characterId)),
    );
  });

  it('is stable: the same table breaks the same way every time', async () => {
    const tableId = randomUUID();
    const winners = new Set<string>();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { runner, completion } = harness([seat(0), seat(1), seat(2)], { tableId });
      runner.start();
      winners.add((await completion).qualifierCharacterId);
    }
    expect(winners.size).toBe(1);
  });

  it('always resolves to exactly one seated qualifier, and spreads across tables', async () => {
    const seats = [seat(0), seat(1), seat(2), seat(3), seat(4)];
    const ids = new Set(seats.map((entry) => entry.characterId));
    const winners = new Set<string>();

    for (let attempt = 0; attempt < 200; attempt += 1) {
      const { runner, completion } = harness(seats, { tableId: randomUUID() });
      runner.start();
      const result = await completion;
      expect(ids.has(result.qualifierCharacterId)).toBe(true);
      expect(result.standings).toHaveLength(5);
      winners.add(result.qualifierCharacterId);
    }

    // Seeded on the table id, so no seat is structurally favoured.
    expect(winners.size).toBe(5);
  });

  it('ranks standings by stack, then by hands won', async () => {
    const seats = [
      seat(0, { stack: 0, handsWon: 0 }),
      seat(1, { stack: 9, handsWon: 1 }),
      seat(2, { stack: 0, handsWon: 2 }),
    ];
    const { runner, completion } = harness(seats);
    runner.start();

    const result = await completion;
    const order = result.standings.map((standing: TableStanding) => standing.seatIndex);
    expect(order).toEqual([1, 2, 0]);
  });
});

describe('sudden death', () => {
  /**
   * Past the scheduled hand count only an unbroken tie buys more hands, and only a bounded
   * number of them — the bracket must never stall waiting for a tie to break itself.
   */
  it('never plays more than the scheduled hands plus the sudden-death cap', async () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const seats = [seat(0, { stack: 3 }), seat(1, { stack: 3 }), seat(2, { stack: 3 })];
      const { runner, completion, sent, clock } = harness(seats, {
        handsPerTable: 1,
        maxSuddenDeathHands: 2,
      });
      runner.start();

      let settled: TableCompletion | null = null;
      void completion.then((result) => {
        settled = result;
      });

      for (let step = 0; step < 60 && settled === null; step += 1) {
        await clock.advance(1_000, 0);
      }

      expect(settled).not.toBeNull();
      const handsDealt = sent.filter((message) => message.type === 'tourney:hand_start').length;
      expect(handsDealt).toBeGreaterThanOrEqual(1);
      expect(handsDealt).toBeLessThanOrEqual(1 + 2);
      await runner.stop();
    }
  }, 60_000);

  it('stops at the scheduled hand count when the lead is already clear', async () => {
    const seats = [seat(0, { stack: 1 }), seat(1, { stack: 8 }), seat(2, { stack: 6 })];
    const { runner, completion, sent, clock } = harness(seats, {
      handsPerTable: 1,
      maxSuddenDeathHands: 2,
    });
    runner.start();

    let settled: TableCompletion | null = null;
    void completion.then((result) => {
      settled = result;
    });
    for (let step = 0; step < 60 && settled === null; step += 1) {
      await clock.advance(1_000, 0);
    }

    expect(settled).not.toBeNull();
    const handsDealt = sent.filter((message) => message.type === 'tourney:hand_start').length;
    expect(handsDealt).toBe(1);
    await runner.stop();
  }, 30_000);
});
