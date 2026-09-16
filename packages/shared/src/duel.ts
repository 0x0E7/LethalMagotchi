import type { WealthBand } from './raid.js';

export const DUEL_THROWS = ['rock', 'paper', 'scissors'] as const;
export type DuelThrow = (typeof DUEL_THROWS)[number];

export const DUEL_THROW_LABELS: Record<DuelThrow, string> = {
  rock: 'Rock',
  paper: 'Paper',
  scissors: 'Scissors',
};

export const DUEL_THROW_GLYPHS: Record<DuelThrow, string> = {
  rock: '🪨',
  paper: '📄',
  scissors: '✂️',
};

/** First to two round-wins takes the match, so a final score is always 2-0 or 2-1. */
export const DUEL_WINS_NEEDED = 2;

/**
 * Consecutive drawn replays of one round before a seeded tiebreak decides it. A draw is a
 * 1-in-3 event, so this fires on a ~0.4% tail — it exists so a lock can never hang on it.
 */
export const DUEL_MAX_REPLAYS = 5;

export const DUEL_ROUND_MS = 5_000;
export const DUEL_REVEAL_MS = 1_500;
export const DUEL_INVITE_TTL_MS = 60_000;

const DAY_MS = 24 * 60 * 60_000;

/** Anti-griefing floor: both sides of a duel must be this old. */
export const DUEL_MIN_ACCOUNT_AGE_MS = DAY_MS;

/** Rolling, never a calendar day — timezones stay out of the data model. */
export const CHICKEN_BADGE_MS = DAY_MS;

/** How long a declined challenger is blocked from re-inviting that same target. */
export const DUEL_DECLINE_COOLDOWN_MS = DAY_MS;

export const DUEL_INVITE_STATES = ['pending', 'accepted', 'declined', 'expired', 'cancelled'] as const;
export type DuelInviteState = (typeof DUEL_INVITE_STATES)[number];

export const DUEL_STATES = ['active', 'complete', 'aborted'] as const;
export type DuelState = (typeof DUEL_STATES)[number];

export const DUEL_OUTCOMES = ['death', 'abort'] as const;
export type DuelOutcome = (typeof DUEL_OUTCOMES)[number];

export const DUEL_ERROR_CODES = [
  'NO_CHARACTER',
  'SELF',
  'NOT_FOUND',
  'TOO_NEW',
  'BUSY',
  'TARGET_BUSY',
  'TARGET_OFFLINE',
  'INVITE_PENDING',
  'COOLDOWN',
  'BLOCKED',
  'RATE_LIMITED',
  'EXPIRED',
  'STALE_SEQ',
] as const;
export type DuelErrorCode = (typeof DUEL_ERROR_CODES)[number];

export const DUEL_ERROR_MESSAGES: Record<DuelErrorCode, string> = {
  NO_CHARACTER: 'You need a character to duel.',
  SELF: 'You cannot duel yourself.',
  NOT_FOUND: 'That challenge is no longer around.',
  TOO_NEW: 'Duels open up once a pet is a day old.',
  BUSY: 'You are already committed to something else.',
  TARGET_BUSY: 'They are busy right now.',
  TARGET_OFFLINE: 'They are not around right now.',
  INVITE_PENDING: 'You already have a challenge out to them.',
  COOLDOWN: 'They turned you down recently. Try again tomorrow.',
  BLOCKED: 'You cannot challenge this player.',
  RATE_LIMITED: 'Slow down a moment.',
  EXPIRED: 'That challenge has already timed out.',
  STALE_SEQ: 'That throw was already locked in.',
};

export type DuelSide = 'challenger' | 'opponent';

/**
 * How one duelist is described to the other. Never carries anything private — and, since
 * raids are decided by a wallet comparison, never an exact balance either: a public number
 * would turn raid banding into decoration. The stake is server-snapshotted and travels on
 * its own frames.
 */
export interface DuelPlayerView {
  characterId: string;
  accountId: string | null;
  nickname: string;
  speciesId: string;
  wealthBand: WealthBand;
  isBeggar: boolean;
  duelWins: number;
  duelLosses: number;
}

/**
 * The public standing of a character, shown next to their name in the Town Square. Exact
 * balances deliberately do not appear here: a player's own figure comes from their session
 * character, and a duel stake comes from the server's snapshot of it.
 */
export interface DuelCardDto {
  characterId: string;
  accountId: string | null;
  nickname: string;
  speciesId: string;
  wealthBand: WealthBand;
  isBeggar: boolean;
  duelWins: number;
  duelLosses: number;
  chickenBadgeUntil: string | null;
  /** The group this player belongs to, rendered in the same identity slot as the badges. */
  groupName: string | null;
  /** Server's own read of the 24h account-age floor, so the UI never offers an invite that must fail. */
  duelEligible: boolean;
  /** The same read for raids: age floor, engagement lock, immunity and the wealth floor. */
  raidEligible: boolean;
}

export interface DuelCardsResponse {
  cards: DuelCardDto[];
}

/* ------------------------------------------------------------------ *
 * Rules
 * ------------------------------------------------------------------ */

const BEATS: Record<DuelThrow, DuelThrow> = {
  rock: 'scissors',
  paper: 'rock',
  scissors: 'paper',
};

export function throwBeats(attacker: DuelThrow, defender: DuelThrow): boolean {
  return BEATS[attacker] === defender;
}

export interface DuelScore {
  round: number;
  replay: number;
  challengerWins: number;
  opponentWins: number;
}

export type RoundWinner = DuelSide | 'draw';

export interface RoundResolution {
  /** `draw` only ever means "replayed": a capped draw is resolved to a side by tiebreak. */
  winner: RoundWinner;
  tiebreak: boolean;
  next: DuelScore;
  matchWinner: DuelSide | null;
}

export function matchWinner(score: Pick<DuelScore, 'challengerWins' | 'opponentWins'>): DuelSide | null {
  if (score.challengerWins >= DUEL_WINS_NEEDED) return 'challenger';
  if (score.opponentWins >= DUEL_WINS_NEEDED) return 'opponent';
  return null;
}

/**
 * The whole match state machine, as one pure step: who took the round, whether the draw
 * cap had to break it, what the next window is, and whether the match is over. The runner
 * only drives timers and I/O around this.
 */
export function resolveRound(
  score: DuelScore,
  challengerThrow: DuelThrow,
  opponentThrow: DuelThrow,
  breakTie: () => DuelSide,
): RoundResolution {
  if (challengerThrow === opponentThrow) {
    if (score.replay < DUEL_MAX_REPLAYS) {
      return {
        winner: 'draw',
        tiebreak: false,
        next: { ...score, replay: score.replay + 1 },
        matchWinner: null,
      };
    }
    return award(score, breakTie(), true);
  }
  return award(score, throwBeats(challengerThrow, opponentThrow) ? 'challenger' : 'opponent', false);
}

function award(score: DuelScore, winner: DuelSide, tiebreak: boolean): RoundResolution {
  const next: DuelScore = {
    round: score.round + 1,
    replay: 0,
    challengerWins: score.challengerWins + (winner === 'challenger' ? 1 : 0),
    opponentWins: score.opponentWins + (winner === 'opponent' ? 1 : 0),
  };
  return { winner, tiebreak, next, matchWinner: matchWinner(next) };
}

/**
 * The wealth-asymmetry fix: the winner takes the smaller of the two pre-duel wallets, so a
 * broke challenger can never win more than the nothing they risked.
 */
export function duelStakeCoins(challengerCoins: number, opponentCoins: number): number {
  return Math.max(0, Math.min(challengerCoins, opponentCoins));
}

export function isOldEnoughToDuel(createdAt: string | Date, now: number): boolean {
  const born = createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt);
  return now - born >= DUEL_MIN_ACCOUNT_AGE_MS;
}

export function chickenBadgeUntil(now: number): Date {
  return new Date(now + CHICKEN_BADGE_MS);
}

export function isChickenBadgeActive(until: string | Date | null, now: number): boolean {
  if (until === null) return false;
  const ends = until instanceof Date ? until.getTime() : Date.parse(until);
  return ends > now;
}

/** True while the challenger is still inside the 24h block from that target's decline. */
export function isDeclineCooldownActive(lastDeclinedAt: string | Date | null, now: number): boolean {
  if (lastDeclinedAt === null) return false;
  const at = lastDeclinedAt instanceof Date ? lastDeclinedAt.getTime() : Date.parse(lastDeclinedAt);
  return now - at < DUEL_DECLINE_COOLDOWN_MS;
}

export function declineCooldownEndsAt(lastDeclinedAt: string | Date): Date {
  const at = lastDeclinedAt instanceof Date ? lastDeclinedAt.getTime() : Date.parse(lastDeclinedAt);
  return new Date(at + DUEL_DECLINE_COOLDOWN_MS);
}
