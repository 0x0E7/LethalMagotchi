import {
  BASE_DECAY_RATES,
  PERSONALITIES_BY_ID,
  SPECIES_BY_ID,
  type DecayRates,
  type PersonalityId,
  type SpeciesId,
} from './reference.js';
import { DECAY_STAT_KEYS, clampStat, type CharacterStats } from './stats.js';

export const HP_CRITICAL_THRESHOLD = 20;
export const HP_COMFORT_THRESHOLD = 60;
export const HP_REGEN_PER_HOUR = 2;

export const HP_DAMAGE_PER_HOUR: Record<'hunger' | 'energy' | 'hygiene', number> = {
  hunger: 6,
  energy: 3,
  hygiene: 2,
};

export const HP_INPUT_KEYS = ['hunger', 'energy', 'hygiene'] as const;

export const DECAY_MULTIPLIER_MIN = 0.75;
export const DECAY_MULTIPLIER_MAX = 1.3;

const MS_PER_HOUR = 3_600_000;

export function effectiveDecayRates(speciesId: SpeciesId, personalityId: PersonalityId): DecayRates {
  const species = SPECIES_BY_ID[speciesId];
  const personality = PERSONALITIES_BY_ID[personalityId];
  const rates = {} as DecayRates;

  for (const key of DECAY_STAT_KEYS) {
    const combined = (species.baseDecayRates[key] / BASE_DECAY_RATES[key]) * (personality.decayModifiers[key] ?? 1);
    const clamped = Math.min(DECAY_MULTIPLIER_MAX, Math.max(DECAY_MULTIPLIER_MIN, combined));
    rates[key] = BASE_DECAY_RATES[key] * clamped;
  }

  return rates;
}

function hoursUntilBelow(start: number, threshold: number, ratePerHour: number): number {
  if (ratePerHour <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, (start - threshold) / ratePerHour);
}

/**
 * Advances every stat from `stats` (as of the caller's watermark) to `elapsedMs` later.
 *
 * Regen is clamped before damage is subtracted rather than in the single
 * `clamp(hp - damage + regen)` the design sketches. Any stat must pass through the
 * comfort threshold before it reaches the critical one, so the safe window always
 * precedes the damaging one; clamping in that order is what makes simulating
 * t0→t2 in one call equal simulating t0→t1→t2 in two. Without it, a pet read once
 * after a long absence would take less damage than one read hourly, because a
 * single pass could bank regen above 100 and spend it on damage.
 */
export function simulate(stats: CharacterStats, rates: DecayRates, elapsedMs: number): CharacterStats {
  const next: CharacterStats = { ...stats };
  if (elapsedMs <= 0) return next;

  const hours = elapsedMs / MS_PER_HOUR;

  let damage = 0;
  let safeHours = hours;
  for (const key of HP_INPUT_KEYS) {
    const rate = rates[key];
    const criticalHours = Math.max(0, hours - hoursUntilBelow(stats[key], HP_CRITICAL_THRESHOLD, rate));
    damage += HP_DAMAGE_PER_HOUR[key] * criticalHours;
    safeHours = Math.min(safeHours, hoursUntilBelow(stats[key], HP_COMFORT_THRESHOLD, rate));
  }

  for (const key of DECAY_STAT_KEYS) {
    next[key] = clampStat(stats[key] - rates[key] * hours);
  }

  const regen = HP_REGEN_PER_HOUR * Math.max(0, Math.min(safeHours, hours));
  next.hp = clampStat(clampStat(stats.hp + regen) - damage);
  return next;
}

export function simulateCharacter(input: {
  stats: CharacterStats;
  speciesId: SpeciesId;
  personalityId: PersonalityId;
  lastSimulatedAt: string | number | Date;
  now: number;
}): CharacterStats {
  const from = new Date(input.lastSimulatedAt).getTime();
  const elapsed = Number.isFinite(from) ? input.now - from : 0;
  return simulate(input.stats, effectiveDecayRates(input.speciesId, input.personalityId), elapsed);
}
