export const SPECIES_IDS = [
  'dog',
  'cat',
  'horse',
  'cow',
  'lion',
  'fox',
  'wolf',
  'rabbit',
  'otter',
  'raccoon',
  'bear',
  'deer',
  'goat',
  'pig',
  'frog',
  'crow',
] as const;

export const PERSONALITY_IDS = [
  'nerd',
  'criminal',
  'cool',
  'sweetheart',
  'grump',
  'goofball',
  'jock',
  'artist',
  'schemer',
  'daydreamer',
  'workaholic',
  'feral',
] as const;

export const OCCUPATION_IDS = [
  'student',
  'chef',
  'mechanic',
  'doctor',
  'farmer',
  'musician',
  'detective',
  'janitor',
  'programmer',
  'barista',
  'sailor',
  'miner',
  'teacher',
  'courier',
  'bartender',
  'unemployed',
] as const;

export type SpeciesId = (typeof SPECIES_IDS)[number];
export type PersonalityId = (typeof PERSONALITY_IDS)[number];
export type OccupationId = (typeof OCCUPATION_IDS)[number];

export type StatKey = 'hunger' | 'hygiene' | 'energy' | 'mood';

export interface DecayRates {
  hunger: number;
  hygiene: number;
  energy: number;
  mood: number;
}

export interface Species {
  id: SpeciesId;
  displayName: string;
  flavor: string;
  baseDecayRates: DecayRates;
}

export interface Personality {
  id: PersonalityId;
  displayName: string;
  decayModifiers: Partial<Record<StatKey, number>>;
}

export interface Occupation {
  id: OccupationId;
  displayName: string;
}

const BASE: DecayRates = { hunger: 4, hygiene: 3, energy: 3.5, mood: 3 };

function rates(hunger: number, hygiene: number, energy: number, mood: number): DecayRates {
  return {
    hunger: round(BASE.hunger * hunger),
    hygiene: round(BASE.hygiene * hygiene),
    energy: round(BASE.energy * energy),
    mood: round(BASE.mood * mood),
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export const SPECIES: Species[] = [
  { id: 'dog', displayName: 'Dog', flavor: 'Relentlessly delighted to see you.', baseDecayRates: rates(1.1, 1.05, 0.95, 0.9) },
  { id: 'cat', displayName: 'Cat', flavor: 'Affection strictly on their terms.', baseDecayRates: rates(0.95, 0.85, 1.1, 1.05) },
  { id: 'horse', displayName: 'Horse', flavor: 'Big appetite, bigger opinions.', baseDecayRates: rates(1.15, 1.0, 0.9, 1.0) },
  { id: 'cow', displayName: 'Cow', flavor: 'Unhurried by absolutely everything.', baseDecayRates: rates(1.15, 1.1, 0.85, 0.9) },
  { id: 'lion', displayName: 'Lion', flavor: 'Naps like it is a full-time job.', baseDecayRates: rates(1.1, 0.9, 1.15, 0.95) },
  { id: 'fox', displayName: 'Fox', flavor: 'Clever, and knows it.', baseDecayRates: rates(1.0, 0.95, 1.05, 1.05) },
  { id: 'wolf', displayName: 'Wolf', flavor: 'Happiest with company nearby.', baseDecayRates: rates(1.05, 1.0, 1.0, 1.1) },
  { id: 'rabbit', displayName: 'Rabbit', flavor: 'Anxious, springy, snack-driven.', baseDecayRates: rates(1.15, 0.95, 1.1, 1.1) },
  { id: 'otter', displayName: 'Otter', flavor: 'Will turn anything into a game.', baseDecayRates: rates(1.1, 0.85, 1.05, 0.85) },
  { id: 'raccoon', displayName: 'Raccoon', flavor: 'Sticky-fingered and unashamed.', baseDecayRates: rates(1.15, 1.15, 1.0, 0.9) },
  { id: 'bear', displayName: 'Bear', flavor: 'Sleeps a lot. Eats more.', baseDecayRates: rates(1.15, 1.05, 0.85, 0.9) },
  { id: 'deer', displayName: 'Deer', flavor: 'Startles at the smallest thing.', baseDecayRates: rates(0.95, 0.9, 1.0, 1.15) },
  { id: 'goat', displayName: 'Goat', flavor: 'Eats what it should not.', baseDecayRates: rates(1.15, 1.15, 0.95, 0.9) },
  { id: 'pig', displayName: 'Pig', flavor: 'Smarter than the mud suggests.', baseDecayRates: rates(1.15, 1.15, 0.9, 0.9) },
  { id: 'frog', displayName: 'Frog', flavor: 'Damp, cheerful, faintly smug.', baseDecayRates: rates(0.9, 0.85, 1.05, 1.0) },
  { id: 'crow', displayName: 'Crow', flavor: 'Collects shiny things and grudges.', baseDecayRates: rates(0.9, 0.95, 1.1, 1.15) },
];

export const PERSONALITIES: Personality[] = [
  { id: 'nerd', displayName: 'Nerd', decayModifiers: { energy: 1.1, mood: 0.9 } },
  { id: 'criminal', displayName: 'Criminal', decayModifiers: { hygiene: 1.15, mood: 0.95 } },
  { id: 'cool', displayName: 'Cool', decayModifiers: { mood: 0.85 } },
  { id: 'sweetheart', displayName: 'Sweetheart', decayModifiers: { mood: 1.1, hygiene: 0.9 } },
  { id: 'grump', displayName: 'Grump', decayModifiers: { mood: 1.15 } },
  { id: 'goofball', displayName: 'Goofball', decayModifiers: { energy: 1.1, mood: 0.85 } },
  { id: 'jock', displayName: 'Jock', decayModifiers: { hunger: 1.15, energy: 1.1 } },
  { id: 'artist', displayName: 'Artist', decayModifiers: { hygiene: 1.1, mood: 0.9 } },
  { id: 'schemer', displayName: 'Schemer', decayModifiers: { energy: 1.05, mood: 0.95 } },
  { id: 'daydreamer', displayName: 'Daydreamer', decayModifiers: { hunger: 0.9, energy: 0.9 } },
  { id: 'workaholic', displayName: 'Workaholic', decayModifiers: { energy: 1.15, mood: 1.05 } },
  { id: 'feral', displayName: 'Feral', decayModifiers: { hygiene: 1.2, hunger: 1.1 } },
];

export const OCCUPATIONS: Occupation[] = [
  { id: 'student', displayName: 'Student' },
  { id: 'chef', displayName: 'Chef' },
  { id: 'mechanic', displayName: 'Mechanic' },
  { id: 'doctor', displayName: 'Doctor' },
  { id: 'farmer', displayName: 'Farmer' },
  { id: 'musician', displayName: 'Musician' },
  { id: 'detective', displayName: 'Detective' },
  { id: 'janitor', displayName: 'Janitor' },
  { id: 'programmer', displayName: 'Programmer' },
  { id: 'barista', displayName: 'Barista' },
  { id: 'sailor', displayName: 'Sailor' },
  { id: 'miner', displayName: 'Miner' },
  { id: 'teacher', displayName: 'Teacher' },
  { id: 'courier', displayName: 'Courier' },
  { id: 'bartender', displayName: 'Bartender' },
  { id: 'unemployed', displayName: 'Unemployed' },
];

export const REFERENCE_VERSION = '1';
