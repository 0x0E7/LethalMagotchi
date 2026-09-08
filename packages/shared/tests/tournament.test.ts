import { describe, expect, it } from 'vitest';
import {
  ENTRY_FEE_COINS,
  HP_PER_COIN,
  MAX_ENTRANTS_PER_SHARD,
  MAX_QUALIFICATION_ROUNDS,
  MISS_PENALTY_COINS,
  TABLE_SIZE,
  entryRiskFor,
  planRound,
  resolveEntryCharge,
  roundsNeededFor,
  shardCountFor,
  shardEntrants,
} from '../src/tournament.js';
import { STARTING_STATS, type CharacterStats } from '../src/stats.js';

function subject(hp: number, lethalCoins: number): { stats: CharacterStats; lethalCoins: number } {
  return { stats: { ...STARTING_STATS, hp }, lethalCoins };
}

describe('entry charge', () => {
  it('debits coins outright when the character can afford the entry', () => {
    expect(resolveEntryCharge(subject(100, 5), 'entry')).toEqual({
      kind: 'paid',
      charge: 'entry',
      coinsAfter: 2,
      hpAfter: 100,
      hpConverted: 0,
      stake: ENTRY_FEE_COINS,
    });
  });

  it('converts 10% HP per missing coin', () => {
    expect(resolveEntryCharge(subject(100, 1), 'entry')).toEqual({
      kind: 'paid',
      charge: 'entry',
      coinsAfter: 0,
      hpAfter: 80,
      hpConverted: 20,
      stake: ENTRY_FEE_COINS,
    });
  });

  it('rebirths rather than entering when conversion would exhaust HP', () => {
    expect(resolveEntryCharge(subject(20, 1), 'entry')).toEqual({
      kind: 'rebirth',
      charge: 'entry',
      hpNeeded: 20,
    });
  });

  it('treats exactly-zero remaining HP as lethal and a hair above zero as survivable', () => {
    expect(resolveEntryCharge(subject(20, 1), 'entry').kind).toBe('rebirth');
    expect(resolveEntryCharge(subject(20.001, 1), 'entry').kind).toBe('paid');
  });

  it('walks the identical path for the one-coin miss penalty', () => {
    expect(resolveEntryCharge(subject(100, 0), 'miss_penalty')).toEqual({
      kind: 'paid',
      charge: 'miss_penalty',
      coinsAfter: 0,
      hpAfter: 100 - HP_PER_COIN * MISS_PENALTY_COINS,
      hpConverted: 10,
      stake: 0,
    });
    expect(resolveEntryCharge(subject(10, 0), 'miss_penalty').kind).toBe('rebirth');
  });

  it('burns the miss penalty rather than escrowing it', () => {
    const outcome = resolveEntryCharge(subject(100, 5), 'miss_penalty');
    expect(outcome).toMatchObject({ kind: 'paid', coinsAfter: 4, stake: 0 });
  });

  it('never converts HP when coins already cover the charge', () => {
    for (const coins of [3, 4, 99]) {
      expect(resolveEntryCharge(subject(5, coins), 'entry')).toMatchObject({ hpConverted: 0, kind: 'paid' });
    }
  });
});

describe('entry risk tiering', () => {
  it('grades the three confirmation weights', () => {
    expect(entryRiskFor(subject(100, 5))).toBe('affordable');
    expect(entryRiskFor(subject(100, 0))).toBe('hp_conversion');
    expect(entryRiskFor(subject(25, 0))).toBe('lethal');
  });
});

describe('bracket planning', () => {
  const ids = (count: number) => Array.from({ length: count }, (_, index) => `e${index}`);

  it('handles every remainder shape', () => {
    expect(planRound(ids(0))).toEqual({ tables: [], byes: [] });
    expect(planRound(ids(1))).toEqual({ tables: [], byes: ['e0'] });
    expect(planRound(ids(2)).tables).toHaveLength(1);
    expect(planRound(ids(2)).tables[0]).toHaveLength(2);
    expect(planRound(ids(4)).tables[0]).toHaveLength(4);
    expect(planRound(ids(5)).tables[0]).toHaveLength(5);
    expect(planRound(ids(6))).toMatchObject({ byes: ['e5'] });
    expect(planRound(ids(6)).tables).toHaveLength(1);
    expect(planRound(ids(9)).tables.map((table) => table.length)).toEqual([5, 4]);
    expect(planRound(ids(10)).tables.map((table) => table.length)).toEqual([5, 5]);
    expect(planRound(ids(11))).toMatchObject({ byes: ['e10'] });
    expect(planRound(ids(11)).tables.map((table) => table.length)).toEqual([5, 5]);
  });

  it('places every entrant in exactly one table or bye', () => {
    for (const count of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 23, 124, 3125, 3126]) {
      const plan = planRound(ids(count));
      const placed = [...plan.tables.flat(), ...plan.byes];
      expect(placed).toHaveLength(count);
      expect(new Set(placed).size).toBe(count);
    }
  });

  it('never seats more than five at a table', () => {
    for (const count of [2, 7, 13, 99, 3126]) {
      for (const table of planRound(ids(count)).tables) expect(table.length).toBeLessThanOrEqual(5);
    }
  });

  it('never produces more than one bye', () => {
    for (let count = 0; count <= 60; count += 1) {
      expect(planRound(ids(count)).byes.length).toBeLessThanOrEqual(1);
    }
  });
});

describe('sharding', () => {
  it('stays a single bracket at or below the five-round ceiling', () => {
    expect(shardCountFor(0)).toBe(1);
    expect(shardCountFor(5)).toBe(1);
    expect(shardCountFor(MAX_ENTRANTS_PER_SHARD)).toBe(1);
  });

  it('splits above the ceiling', () => {
    expect(MAX_ENTRANTS_PER_SHARD).toBe(3125);
    expect(shardCountFor(3126)).toBe(2);
    expect(shardCountFor(6250)).toBe(2);
    expect(shardCountFor(6251)).toBe(3);
  });

  it('distributes entrants across shards without loss or duplication', () => {
    const entrants = Array.from({ length: 6251 }, (_, index) => `e${index}`);
    const shards = shardEntrants(entrants, shardCountFor(entrants.length));
    expect(shards).toHaveLength(3);
    expect(shards.flat()).toHaveLength(6251);
    expect(new Set(shards.flat()).size).toBe(6251);
    for (const shard of shards) expect(shard.length).toBeLessThanOrEqual(MAX_ENTRANTS_PER_SHARD);
  });
});

describe('round depth', () => {
  it('never exceeds the five-round cap', () => {
    expect(roundsNeededFor(1)).toBe(0);
    expect(roundsNeededFor(2)).toBe(1);
    expect(roundsNeededFor(5)).toBe(1);
    expect(roundsNeededFor(6)).toBe(2);
    expect(roundsNeededFor(25)).toBe(2);
    expect(roundsNeededFor(26)).toBe(3);
    expect(roundsNeededFor(3125)).toBe(5);
    expect(roundsNeededFor(100_000)).toBe(5);
  });

  it('does not invent a round at an exact power of the table size', () => {
    expect(roundsNeededFor(125)).toBe(3);
    expect(roundsNeededFor(124)).toBe(3);
    expect(roundsNeededFor(126)).toBe(4);
    expect(roundsNeededFor(625)).toBe(4);
    expect(roundsNeededFor(626)).toBe(5);
  });

  it('always seats the entrant pool within its own round count', () => {
    for (let entrants = 2; entrants <= 3200; entrants += 1) {
      const rounds = roundsNeededFor(entrants);
      if (rounds === MAX_QUALIFICATION_ROUNDS) continue;
      expect(TABLE_SIZE ** rounds).toBeGreaterThanOrEqual(entrants);
      expect(TABLE_SIZE ** (rounds - 1)).toBeLessThan(entrants);
    }
  });
});
