import type { Card } from './cards.js';
import type { CharacterStats } from './stats.js';

export const ENTRY_FEE_COINS = 3;
export const MISS_PENALTY_COINS = 1;
export const HP_PER_COIN = 10;
export const TABLE_SIZE = 5;
export const MIN_ENTRANTS = 2;
export const HANDS_PER_TABLE = 3;
export const MAX_QUALIFICATION_ROUNDS = 5;
export const MAX_ENTRANTS_PER_SHARD = TABLE_SIZE ** MAX_QUALIFICATION_ROUNDS;
export const HOUSE_PRIZE_PER_ENTRANT = 1;
export const CHAMPION_COSMETIC_ID = 'champion_crown';

/**
 * Seat stacks are real coins, not chips, and round-one stacks are exactly the 3-coin
 * entry fee. A conventional 1/2 structure would make the big blind two thirds of a
 * starting stack — every hand an effective all-in. Equal one-coin blinds keep the
 * standard positional order and the big blind's option to check while leaving a real
 * fold/call/raise decision at a three-coin stack.
 */
export const SMALL_BLIND_COINS = 1;
export const BIG_BLIND_COINS = 1;

export const TOURNAMENT_STATES = [
  'scheduled',
  'registration',
  'running',
  'complete',
  'cancelled',
] as const;
export type TournamentState = (typeof TOURNAMENT_STATES)[number];

export const TOURNAMENT_SCOPES = ['global', 'lan'] as const;
export type TournamentScope = (typeof TOURNAMENT_SCOPES)[number];

export const TABLE_STATES = ['pending', 'playing', 'complete'] as const;
export type TableState = (typeof TABLE_STATES)[number];

export const STREETS = ['preflop', 'flop', 'turn', 'river', 'showdown'] as const;
export type Street = (typeof STREETS)[number];

export const BETTING_ACTIONS = ['check', 'call', 'bet', 'raise', 'fold', 'allin'] as const;
export type BettingAction = (typeof BETTING_ACTIONS)[number];

export const LOGGED_ACTIONS = [...BETTING_ACTIONS, 'timeout_fold', 'timeout_check'] as const;
export type LoggedAction = (typeof LOGGED_ACTIONS)[number];

export interface TournamentSummary {
  id: string;
  scope: TournamentScope;
  state: TournamentState;
  scheduledFor: string;
  registrationOpensAt: string;
  currentRound: number;
  entrantCount: number;
  prizePotCoins: number;
  shardIndex: number;
  shardCount: number;
  winnerCharacterId: string | null;
}

export interface TournamentEntryDto {
  tournamentId: string;
  characterId: string;
  hpConverted: number;
  currentStack: number;
  eliminatedInRound: number | null;
  finalRank: number | null;
}

export interface SeatView {
  seatIndex: number;
  characterId: string;
  nickname: string;
  speciesId: string;
  stack: number;
  connected: boolean;
  folded: boolean;
  allIn: boolean;
  committed: number;
}

export interface LegalActionsView {
  actions: BettingAction[];
  toCall: number;
  minRaiseTo: number;
  maxRaiseTo: number;
}

export interface ShowdownReveal {
  seatIndex: number;
  cards: Card[];
  handName: string;
}

export interface PotPayout {
  seatIndex: number;
  amount: number;
}

export interface TableStanding {
  seatIndex: number;
  characterId: string;
  nickname: string;
  stack: number;
  handsWon: number;
}

/* ------------------------------------------------------------------ *
 * Entry / miss-penalty resolution
 * ------------------------------------------------------------------ */

export interface EntrySubject {
  stats: CharacterStats;
  lethalCoins: number;
}

export type EntryCharge = 'entry' | 'miss_penalty';

export type EntryOutcome =
  | {
      kind: 'paid';
      charge: EntryCharge;
      coinsAfter: number;
      hpAfter: number;
      hpConverted: number;
      /** Coins moved into escrow (the seat stack). Zero for a miss penalty — that coin is burned. */
      stake: number;
    }
  | { kind: 'rebirth'; charge: EntryCharge; hpNeeded: number };

export function chargeCoinsFor(charge: EntryCharge): number {
  return charge === 'entry' ? ENTRY_FEE_COINS : MISS_PENALTY_COINS;
}

/**
 * One insufficient-funds rule for the whole tournament system: cover the shortfall by
 * converting HP at 10% per coin, and if that conversion would exhaust HP the character
 * is reborn instead of charged. Deliberately identical for a voluntary entry and for
 * the miss penalty a non-participant pays.
 */
export function resolveEntryCharge(subject: EntrySubject, charge: EntryCharge): EntryOutcome {
  const cost = chargeCoinsFor(charge);
  const deficit = Math.max(0, cost - subject.lethalCoins);
  const hpNeeded = deficit * HP_PER_COIN;

  if (hpNeeded > 0 && subject.stats.hp - hpNeeded <= 0) {
    return { kind: 'rebirth', charge, hpNeeded };
  }

  return {
    kind: 'paid',
    charge,
    coinsAfter: subject.lethalCoins + deficit - cost,
    hpAfter: subject.stats.hp - hpNeeded,
    hpConverted: hpNeeded,
    stake: charge === 'entry' ? cost : 0,
  };
}

export type EntryRisk = 'affordable' | 'hp_conversion' | 'lethal';

/** Drives the three confirmation weights in the join UI. */
export function entryRiskFor(subject: EntrySubject): EntryRisk {
  const outcome = resolveEntryCharge(subject, 'entry');
  if (outcome.kind === 'rebirth') return 'lethal';
  return outcome.hpConverted > 0 ? 'hp_conversion' : 'affordable';
}

/* ------------------------------------------------------------------ *
 * Bracket formation
 * ------------------------------------------------------------------ */

export interface RoundPlan {
  tables: string[][];
  byes: string[];
}

/**
 * Tables of five over an ordered entrant list. One leftover advances on a bye (the only
 * true special case); two to four play short-handed under the same rules.
 */
export function planRound(entrantIds: string[], tableSize = TABLE_SIZE): RoundPlan {
  if (entrantIds.length <= 1) return { tables: [], byes: [...entrantIds] };

  const tables: string[][] = [];
  let index = 0;
  while (entrantIds.length - index >= tableSize) {
    tables.push(entrantIds.slice(index, index + tableSize));
    index += tableSize;
  }

  const remainder = entrantIds.slice(index);
  if (remainder.length === 1) {
    // A single leftover cannot play anyone; a bye advances it with zero coins risked.
    return { tables, byes: remainder };
  }
  if (remainder.length > 1) tables.push(remainder);
  return { tables, byes: [] };
}

export function shardCountFor(entrantCount: number): number {
  return entrantCount > MAX_ENTRANTS_PER_SHARD
    ? Math.ceil(entrantCount / MAX_ENTRANTS_PER_SHARD)
    : 1;
}

/** Split an ordered pool into `shardCount` roughly-equal independent tournaments. */
export function shardEntrants(entrantIds: string[], shardCount: number): string[][] {
  const shards: string[][] = Array.from({ length: shardCount }, () => []);
  entrantIds.forEach((id, index) => {
    shards[index % shardCount]!.push(id);
  });
  return shards;
}

/**
 * Counted rather than computed with logarithms: `Math.log(125) / Math.log(5)` is
 * 3.0000000000000004, so a ceil-of-log version claims a phantom fourth round at every
 * exact power of the table size.
 */
export function roundsNeededFor(entrantCount: number): number {
  if (entrantCount <= 1) return 0;
  let rounds = 0;
  let capacity = 1;
  while (capacity < entrantCount && rounds < MAX_QUALIFICATION_ROUNDS) {
    capacity *= TABLE_SIZE;
    rounds += 1;
  }
  return rounds;
}
