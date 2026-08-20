import type { StatKey } from './reference.js';

export const STAT_IDS = ['hunger', 'hygiene', 'energy', 'mood', 'hp', 'education'] as const;

export type StatId = (typeof STAT_IDS)[number];

export type StatKind = 'decay' | 'growth' | 'derived';

export interface StatSpec {
  kind: StatKind;
  start: number;
}

export const STAT_SPEC: Record<StatId, StatSpec> = {
  hunger: { kind: 'decay', start: 100 },
  hygiene: { kind: 'decay', start: 100 },
  energy: { kind: 'decay', start: 100 },
  mood: { kind: 'decay', start: 100 },
  hp: { kind: 'derived', start: 100 },
  education: { kind: 'growth', start: 10 },
};

export type CharacterStats = Record<StatId, number>;

export const STAT_MIN = 0;
export const STAT_MAX = 100;

export function clampStat(value: number): number {
  if (Number.isNaN(value)) return STAT_MIN;
  return Math.min(STAT_MAX, Math.max(STAT_MIN, value));
}

function idsOfKind(kind: StatKind): StatId[] {
  return STAT_IDS.filter((id) => STAT_SPEC[id].kind === kind);
}

export const DECAY_STAT_KEYS = idsOfKind('decay') as StatKey[];
export const GROWTH_STAT_IDS = idsOfKind('growth');
export const DERIVED_STAT_IDS = idsOfKind('derived');

export const STARTING_STATS: CharacterStats = Object.fromEntries(
  STAT_IDS.map((id) => [id, STAT_SPEC[id].start]),
) as CharacterStats;

export function normalizeStats(input: Partial<Record<StatId, unknown>> | null | undefined): CharacterStats {
  const stats = {} as CharacterStats;
  for (const id of STAT_IDS) {
    const value = input?.[id];
    stats[id] = typeof value === 'number' && Number.isFinite(value) ? clampStat(value) : STAT_SPEC[id].start;
  }
  return stats;
}

/**
 * Stats stay fractional through simulation, but the wire/display value is quantized —
 * otherwise a read microseconds after a write reports 99.99999877 instead of 100.
 */
export function roundStats(stats: CharacterStats): CharacterStats {
  const rounded = {} as CharacterStats;
  for (const id of STAT_IDS) rounded[id] = Math.round(stats[id] * 100) / 100;
  return rounded;
}

export interface DisplayStats {
  hp: number;
  hunger: number;
  energy: number;
  moral: number;
  clean: number;
  education: number;
}

export function toDisplayStats(stats: CharacterStats): DisplayStats {
  return {
    hp: stats.hp,
    hunger: stats.hunger,
    energy: stats.energy,
    moral: stats.mood,
    clean: stats.hygiene,
    education: stats.education,
  };
}

export const STAT_DISPLAY_NAMES: Record<StatId, string> = {
  hp: 'HP',
  hunger: 'Hunger',
  energy: 'Energy',
  mood: 'Moral',
  hygiene: 'Clean',
  education: 'Education',
};
