import { describe, expect, it } from 'vitest';
import {
  BASE_DECAY_RATES,
  PERSONALITY_IDS,
  SPECIES_BY_ID,
  SPECIES_IDS,
  type DecayRates,
} from '../src/reference.js';
import {
  DECAY_MULTIPLIER_MAX,
  DECAY_MULTIPLIER_MIN,
  HP_COMFORT_THRESHOLD,
  HP_CRITICAL_THRESHOLD,
  HP_DAMAGE_PER_HOUR,
  HP_REGEN_PER_HOUR,
  effectiveDecayRates,
  simulate,
  simulateCharacter,
} from '../src/simulation.js';
import { STARTING_STATS, clampStat, type CharacterStats } from '../src/stats.js';

const HOUR = 3_600_000;

/** A flat rate set keeps the arithmetic in each test checkable by hand. */
const FLAT: DecayRates = { hunger: 10, hygiene: 10, energy: 10, mood: 10 };
const NO_DECAY: DecayRates = { hunger: 0, hygiene: 0, energy: 0, mood: 0 };

function stats(overrides: Partial<CharacterStats> = {}): CharacterStats {
  return { ...STARTING_STATS, ...overrides };
}

describe('effectiveDecayRates', () => {
  it('leaves a stat the personality does not modify at the species rate', () => {
    // Goofball modifies energy and mood only, so hunger is pure species pace.
    const rates = effectiveDecayRates('otter', 'goofball');
    expect(rates.hunger).toBeCloseTo(SPECIES_BY_ID.otter.baseDecayRates.hunger, 10);
  });

  it('multiplies the species pace by the personality modifier', () => {
    // Goofball drains energy 1.1× faster than the species already does.
    const rates = effectiveDecayRates('otter', 'goofball');
    expect(rates.energy).toBeCloseTo(SPECIES_BY_ID.otter.baseDecayRates.energy * 1.1, 10);
  });

  it('clamps a combination that would exceed the ceiling', () => {
    // Raccoon hygiene 1.15 × feral hygiene 1.2 = 1.38, above the 1.3 cap.
    const rates = effectiveDecayRates('raccoon', 'feral');
    expect(rates.hygiene).toBeCloseTo(BASE_DECAY_RATES.hygiene * DECAY_MULTIPLIER_MAX, 10);
  });

  it('clamps a combination that would fall below the floor', () => {
    // Otter mood 0.85 × cool mood 0.85 = 0.7225, below the 0.75 floor.
    const rates = effectiveDecayRates('otter', 'cool');
    expect(rates.mood).toBeCloseTo(BASE_DECAY_RATES.mood * DECAY_MULTIPLIER_MIN, 10);
  });

  it('keeps every species/personality pairing inside the documented multiplier band', () => {
    for (const speciesId of SPECIES_IDS) {
      for (const personalityId of PERSONALITY_IDS) {
        const rates = effectiveDecayRates(speciesId, personalityId);
        for (const key of ['hunger', 'hygiene', 'energy', 'mood'] as const) {
          const multiplier = rates[key] / BASE_DECAY_RATES[key];
          expect(multiplier).toBeGreaterThanOrEqual(DECAY_MULTIPLIER_MIN - 1e-9);
          expect(multiplier).toBeLessThanOrEqual(DECAY_MULTIPLIER_MAX + 1e-9);
          expect(rates[key]).toBeGreaterThan(0);
        }
      }
    }
  });

  it('is pure — the same pairing always yields the same rates', () => {
    expect(effectiveDecayRates('bear', 'grump')).toEqual(effectiveDecayRates('bear', 'grump'));
  });
});

describe('simulate — decay stats', () => {
  it('does nothing for a zero elapsed window', () => {
    expect(simulate(stats(), FLAT, 0)).toEqual(STARTING_STATS);
  });

  it('does nothing for a negative window, so a clock that jumped backwards cannot heal or harm', () => {
    expect(simulate(stats({ hunger: 40 }), FLAT, -5 * HOUR)).toEqual(stats({ hunger: 40 }));
  });

  it('decays linearly at the given rate', () => {
    const next = simulate(stats(), FLAT, 3 * HOUR);
    expect(next.hunger).toBeCloseTo(70, 10);
    expect(next.mood).toBeCloseTo(70, 10);
  });

  it('decays sub-hour windows proportionally rather than in whole-hour steps', () => {
    expect(simulate(stats(), FLAT, HOUR / 4).hunger).toBeCloseTo(97.5, 10);
  });

  it('floors a decay stat at zero instead of going negative', () => {
    expect(simulate(stats(), FLAT, 50 * HOUR).hunger).toBe(0);
  });

  it('never advances education, which only the study action moves', () => {
    expect(simulate(stats({ education: 42 }), FLAT, 100 * HOUR).education).toBe(42);
  });

  it('returns a fresh object rather than mutating the caller’s stats', () => {
    const before = stats();
    const after = simulate(before, FLAT, HOUR);
    expect(before.hunger).toBe(100);
    expect(after).not.toBe(before);
  });
});

describe('simulate — HP regen', () => {
  it('regenerates while every HP input stays above the comfort threshold', () => {
    const next = simulate(stats({ hp: 50 }), FLAT, 2 * HOUR);
    expect(next.hp).toBeCloseTo(50 + HP_REGEN_PER_HOUR * 2, 10);
  });

  it('stops regenerating once the first HP input drops below comfort', () => {
    // Flat rate 10/h: the inputs reach 60 after 4h, so only 4 of the 6 hours regenerate.
    const next = simulate(stats({ hp: 50 }), FLAT, 6 * HOUR);
    expect(next.hp).toBeCloseTo(50 + HP_REGEN_PER_HOUR * 4, 10);
  });

  it('ignores mood when deciding whether the pet is comfortable', () => {
    // Mood is deliberately outside the HP model: a miserable but fed, rested and
    // clean pet still heals.
    const next = simulate(stats({ hp: 50, mood: 0 }), FLAT, 2 * HOUR);
    expect(next.hp).toBeCloseTo(54, 10);
  });

  it('caps regen at full health', () => {
    expect(simulate(stats({ hp: 99 }), NO_DECAY, 100 * HOUR).hp).toBe(100);
  });

  it('regenerates indefinitely when nothing decays', () => {
    expect(simulate(stats({ hp: 10 }), NO_DECAY, 5 * HOUR).hp).toBeCloseTo(20, 10);
  });
});

describe('simulate — HP damage', () => {
  it('takes no damage while every HP input is above the critical threshold', () => {
    // Flat rate 10/h reaches 20 after exactly 8h, so the whole window is damage-free
    // and only the first 4h (down to comfort at 60) regenerate.
    expect(simulate(stats({ hp: 80 }), FLAT, 8 * HOUR).hp).toBeCloseTo(80 + HP_REGEN_PER_HOUR * 4, 10);
  });

  it('charges each critical stat its own hourly weight', () => {
    // Start every HP input at the critical threshold so the whole window is critical.
    const critical = stats({
      hp: 100,
      hunger: HP_CRITICAL_THRESHOLD,
      energy: HP_CRITICAL_THRESHOLD,
      hygiene: HP_CRITICAL_THRESHOLD,
    });
    const perHour = HP_DAMAGE_PER_HOUR.hunger + HP_DAMAGE_PER_HOUR.energy + HP_DAMAGE_PER_HOUR.hygiene;

    expect(simulate(critical, FLAT, 2 * HOUR).hp).toBeCloseTo(100 - perHour * 2, 10);
  });

  it('keeps charging for a stat already pinned at zero', () => {
    const starved = stats({ hp: 100, hunger: 0, energy: 100, hygiene: 100 });
    expect(simulate(starved, FLAT, HOUR).hp).toBeCloseTo(100 - HP_DAMAGE_PER_HOUR.hunger, 10);
  });

  it('never lets mood alone cause damage', () => {
    const miserable = stats({ hp: 100, mood: 0 });
    expect(simulate(miserable, NO_DECAY, 100 * HOUR).hp).toBe(100);
  });

  it('floors HP at zero after prolonged neglect', () => {
    expect(simulate(stats(), FLAT, 30 * 24 * HOUR).hp).toBe(0);
  });

  it('leaves a zero-HP pet at zero rather than going negative', () => {
    const dead = stats({ hp: 0, hunger: 0, energy: 0, hygiene: 0, mood: 0 });
    expect(simulate(dead, FLAT, 100 * HOUR).hp).toBe(0);
  });
});

describe('simulate — composability', () => {
  const rates = effectiveDecayRates('otter', 'goofball');

  function chained(from: CharacterStats, steps: number[]): CharacterStats {
    return steps.reduce((current, hours) => simulate(current, rates, hours * HOUR), from);
  }

  it('gives the same result for one long pass as for many even passes', () => {
    const once = simulate(stats(), rates, 30 * HOUR);
    const stepwise = chained(stats(), Array.from({ length: 30 }, () => 1));

    for (const key of Object.keys(once) as (keyof CharacterStats)[]) {
      expect(stepwise[key]).toBeCloseTo(once[key], 9);
    }
  });

  it('gives the same result for irregular read cadences', () => {
    const once = simulate(stats(), rates, 30 * HOUR);
    const stepwise = chained(stats(), [0.3, 7.2, 0.01, 11.49, 4, 7]);

    for (const key of Object.keys(once) as (keyof CharacterStats)[]) {
      expect(stepwise[key]).toBeCloseTo(once[key], 9);
    }
  });

  it('does not bank regen above full health and spend it on later damage', () => {
    // This is the reason regen is clamped *before* damage is subtracted rather than
    // in one `clamp(hp - damage + regen)` pass. A pet read once after 30 hours must
    // not end up healthier than one read hourly over the same 30 hours.
    const naiveSingleClamp = (from: CharacterStats, elapsedMs: number): number => {
      const hours = elapsedMs / HOUR;
      const hoursUntilBelow = (start: number, threshold: number, rate: number) =>
        rate <= 0 ? Number.POSITIVE_INFINITY : Math.max(0, (start - threshold) / rate);
      let damage = 0;
      let safeHours = hours;
      for (const key of ['hunger', 'energy', 'hygiene'] as const) {
        damage += HP_DAMAGE_PER_HOUR[key] * Math.max(0, hours - hoursUntilBelow(from[key], HP_CRITICAL_THRESHOLD, rates[key]));
        safeHours = Math.min(safeHours, hoursUntilBelow(from[key], HP_COMFORT_THRESHOLD, rates[key]));
      }
      return clampStat(from.hp - damage + HP_REGEN_PER_HOUR * Math.max(0, Math.min(safeHours, hours)));
    };

    const hourly = chained(stats(), Array.from({ length: 30 }, () => 1)).hp;

    expect(simulate(stats(), rates, 30 * HOUR).hp).toBeCloseTo(hourly, 9);
    // Guard the counterfactual too, so this test fails loudly if the ordering is
    // ever "simplified" back into a single clamp.
    expect(naiveSingleClamp(stats(), 30 * HOUR)).toBeGreaterThan(hourly + 1);
  });

  it('reaches the same floor whether neglect is observed in one read or many', () => {
    const once = simulate(stats(), rates, 30 * 24 * HOUR);
    const stepwise = chained(stats(), Array.from({ length: 30 }, () => 24));
    expect(once).toEqual(stepwise);
  });
});

describe('simulateCharacter', () => {
  const now = Date.parse('2026-08-18T12:00:00.000Z');

  it('advances from the stored watermark to now', () => {
    const result = simulateCharacter({
      stats: stats(),
      speciesId: 'otter',
      personalityId: 'goofball',
      lastSimulatedAt: new Date(now - 4 * HOUR).toISOString(),
      now,
    });

    expect(result.hunger).toBeCloseTo(100 - effectiveDecayRates('otter', 'goofball').hunger * 4, 9);
  });

  it('accepts the watermark as a Date, an ISO string or epoch millis alike', () => {
    const common = { stats: stats(), speciesId: 'otter', personalityId: 'goofball', now } as const;
    const from = now - 6 * HOUR;

    const asDate = simulateCharacter({ ...common, lastSimulatedAt: new Date(from) });
    const asIso = simulateCharacter({ ...common, lastSimulatedAt: new Date(from).toISOString() });
    const asMillis = simulateCharacter({ ...common, lastSimulatedAt: from });

    expect(asIso).toEqual(asDate);
    expect(asMillis).toEqual(asDate);
  });

  it('treats an unparseable watermark as "no time has passed" rather than decaying wildly', () => {
    const result = simulateCharacter({
      stats: stats(),
      speciesId: 'otter',
      personalityId: 'goofball',
      lastSimulatedAt: 'not-a-timestamp',
      now,
    });

    expect(result).toEqual(STARTING_STATS);
  });
});
