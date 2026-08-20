import { describe, expect, it } from 'vitest';
import {
  DECAY_STAT_KEYS,
  DERIVED_STAT_IDS,
  GROWTH_STAT_IDS,
  STARTING_STATS,
  STAT_DISPLAY_NAMES,
  STAT_IDS,
  STAT_MAX,
  STAT_MIN,
  clampStat,
  normalizeStats,
  roundStats,
  toDisplayStats,
  type CharacterStats,
} from '../src/stats.js';

function stats(overrides: Partial<CharacterStats> = {}): CharacterStats {
  return { ...STARTING_STATS, ...overrides };
}

describe('stat spec', () => {
  it('starts a fresh pet at full bars with a little education', () => {
    expect(STARTING_STATS).toEqual({
      hunger: 100,
      hygiene: 100,
      energy: 100,
      mood: 100,
      hp: 100,
      education: 10,
    });
  });

  it('sorts every stat into exactly one kind', () => {
    const sorted = [...DECAY_STAT_KEYS, ...GROWTH_STAT_IDS, ...DERIVED_STAT_IDS].sort();
    expect(sorted).toEqual([...STAT_IDS].sort());
  });

  it('keeps the decay keys to the four the species/personality rate tables define', () => {
    expect([...DECAY_STAT_KEYS].sort()).toEqual(['energy', 'hunger', 'hygiene', 'mood']);
  });

  it('names every stat for the screen reader', () => {
    for (const id of STAT_IDS) expect(STAT_DISPLAY_NAMES[id]).toBeTruthy();
  });
});

describe('clampStat', () => {
  it('passes an in-range value through untouched', () => {
    expect(clampStat(42.5)).toBe(42.5);
  });

  it('clamps to the documented bounds', () => {
    expect(clampStat(140)).toBe(STAT_MAX);
    expect(clampStat(-40)).toBe(STAT_MIN);
  });

  it('treats NaN as empty rather than propagating it into stored stats', () => {
    expect(clampStat(Number.NaN)).toBe(STAT_MIN);
  });

  it('clamps infinities to the bounds', () => {
    expect(clampStat(Number.POSITIVE_INFINITY)).toBe(STAT_MAX);
    expect(clampStat(Number.NEGATIVE_INFINITY)).toBe(STAT_MIN);
  });
});

describe('normalizeStats', () => {
  it('accepts a well-formed stat block unchanged', () => {
    expect(normalizeStats(stats({ hunger: 12.5 }))).toEqual(stats({ hunger: 12.5 }));
  });

  it('fills a missing stat with its documented start value', () => {
    // A row written before the economy migration has no hp/education key.
    expect(normalizeStats({ hunger: 40, hygiene: 40, energy: 40, mood: 40 })).toEqual(
      stats({ hunger: 40, hygiene: 40, energy: 40, mood: 40 }),
    );
  });

  it('replaces a non-numeric stored value rather than trusting it', () => {
    expect(normalizeStats({ hunger: 'lots' }).hunger).toBe(100);
    expect(normalizeStats({ hunger: null }).hunger).toBe(100);
  });

  it('clamps an out-of-range stored value', () => {
    expect(normalizeStats({ hunger: 900, mood: -5 })).toMatchObject({ hunger: 100, mood: 0 });
  });

  it('returns the full starting block for null or undefined input', () => {
    expect(normalizeStats(null)).toEqual(STARTING_STATS);
    expect(normalizeStats(undefined)).toEqual(STARTING_STATS);
  });

  it('drops keys that are not stats at all', () => {
    expect(Object.keys(normalizeStats({ hunger: 50, wealth: 99 } as never)).sort()).toEqual(
      [...STAT_IDS].sort(),
    );
  });
});

describe('roundStats', () => {
  it('quantizes to two decimals at the wire boundary', () => {
    expect(roundStats(stats({ hunger: 99.999_998_77, energy: 42.005 }))).toMatchObject({
      hunger: 100,
      energy: 42.01,
    });
  });

  it('leaves an already-round value alone', () => {
    expect(roundStats(STARTING_STATS)).toEqual(STARTING_STATS);
  });

  it('does not mutate its input, which stays full precision internally', () => {
    const input = stats({ hunger: 33.333_333 });
    roundStats(input);
    expect(input.hunger).toBe(33.333_333);
  });
});

describe('toDisplayStats', () => {
  it('renames hygiene and mood to the player-facing bars without changing values', () => {
    const display = toDisplayStats(stats({ hygiene: 33, mood: 44 }));
    expect(display.clean).toBe(33);
    expect(display.moral).toBe(44);
  });

  it('exposes hunger, energy, hp and education directly', () => {
    const display = toDisplayStats(stats({ hunger: 1, energy: 2, hp: 3, education: 4 }));
    expect(display).toMatchObject({ hunger: 1, energy: 2, hp: 3, education: 4 });
  });
});
