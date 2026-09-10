import { describe, expect, it } from 'vitest';
import {
  CHICKEN_BADGE_MS,
  DUEL_MAX_REPLAYS,
  DUEL_MIN_ACCOUNT_AGE_MS,
  DUEL_THROWS,
  chickenBadgeUntil,
  declineCooldownEndsAt,
  duelStakeCoins,
  isChickenBadgeActive,
  isDeclineCooldownActive,
  isOldEnoughToDuel,
  matchWinner,
  resolveRound,
  throwBeats,
  type DuelScore,
  type DuelSide,
  type DuelThrow,
} from '../src/duel.js';

const START: DuelScore = { round: 1, replay: 0, challengerWins: 0, opponentWins: 0 };
const NEVER = (): DuelSide => {
  throw new Error('tiebreak must not be consulted');
};

describe('rock paper scissors', () => {
  it('resolves the three winning pairs and nothing else', () => {
    expect(throwBeats('rock', 'scissors')).toBe(true);
    expect(throwBeats('scissors', 'paper')).toBe(true);
    expect(throwBeats('paper', 'rock')).toBe(true);

    expect(throwBeats('scissors', 'rock')).toBe(false);
    expect(throwBeats('paper', 'scissors')).toBe(false);
    expect(throwBeats('rock', 'paper')).toBe(false);
    for (const throwing of DUEL_THROWS) expect(throwBeats(throwing, throwing)).toBe(false);
  });

  it('is a strict tournament: every pair has exactly one winner or is a draw', () => {
    for (const left of DUEL_THROWS) {
      for (const right of DUEL_THROWS) {
        const both = Number(throwBeats(left, right)) + Number(throwBeats(right, left));
        expect(both).toBe(left === right ? 0 : 1);
      }
    }
  });

  it('awards the round to whoever threw the winning hand', () => {
    expect(resolveRound(START, 'rock', 'scissors', NEVER).winner).toBe('challenger');
    expect(resolveRound(START, 'rock', 'paper', NEVER).winner).toBe('opponent');
  });
});

describe('best of three, first to two', () => {
  it('ends the match the instant a duelist reaches two round wins', () => {
    const oneNil = resolveRound(START, 'rock', 'scissors', NEVER);
    expect(oneNil.matchWinner).toBeNull();
    expect(oneNil.next).toEqual({ round: 2, replay: 0, challengerWins: 1, opponentWins: 0 });

    const twoNil = resolveRound(oneNil.next, 'rock', 'scissors', NEVER);
    expect(twoNil.matchWinner).toBe('challenger');
    expect(twoNil.next.challengerWins).toBe(2);
  });

  it('plays the third round of a 1-1 and stops at 2-1 without a dead fourth', () => {
    const one = resolveRound(START, 'rock', 'scissors', NEVER);
    const level = resolveRound(one.next, 'rock', 'paper', NEVER);
    expect(level.matchWinner).toBeNull();
    expect(level.next).toEqual({ round: 3, replay: 0, challengerWins: 1, opponentWins: 1 });

    const decider = resolveRound(level.next, 'rock', 'scissors', NEVER);
    expect(decider.matchWinner).toBe('challenger');
    expect(decider.next).toEqual({ round: 4, replay: 0, challengerWins: 2, opponentWins: 1 });
    // The score a finished duel can end on is only ever 2-0 or 2-1.
    expect(decider.next.challengerWins + decider.next.opponentWins).toBeLessThanOrEqual(3);
  });

  it('reads a finished score the same way from the score alone', () => {
    expect(matchWinner({ challengerWins: 2, opponentWins: 1 })).toBe('challenger');
    expect(matchWinner({ challengerWins: 1, opponentWins: 2 })).toBe('opponent');
    expect(matchWinner({ challengerWins: 1, opponentWins: 1 })).toBeNull();
  });
});

describe('drawn rounds', () => {
  it('replays a draw without scoring or consuming the round', () => {
    const drawn = resolveRound(START, 'paper', 'paper', NEVER);
    expect(drawn.winner).toBe('draw');
    expect(drawn.tiebreak).toBe(false);
    expect(drawn.matchWinner).toBeNull();
    expect(drawn.next).toEqual({ round: 1, replay: 1, challengerWins: 0, opponentWins: 0 });
  });

  it('replays exactly five times before the seeded tiebreak decides the round', () => {
    let score = START;
    for (let replay = 0; replay < DUEL_MAX_REPLAYS; replay += 1) {
      const drawn = resolveRound(score, 'rock', 'rock', NEVER);
      expect(drawn.winner).toBe('draw');
      expect(drawn.next.replay).toBe(replay + 1);
      score = drawn.next;
    }

    expect(score.replay).toBe(DUEL_MAX_REPLAYS);
    const broken = resolveRound(score, 'rock', 'rock', () => 'opponent');
    expect(broken.winner).toBe('opponent');
    expect(broken.tiebreak).toBe(true);
    expect(broken.next).toEqual({ round: 2, replay: 0, challengerWins: 0, opponentWins: 1 });
  });

  it('never consults the tiebreak for a round that was actually won', () => {
    expect(() => resolveRound({ ...START, replay: DUEL_MAX_REPLAYS }, 'rock', 'scissors', NEVER)).not.toThrow();
  });
});

describe('the wealth cap', () => {
  it('is the smaller of the two pre-duel wallets, from either side', () => {
    expect(duelStakeCoins(1_240, 30)).toBe(30);
    expect(duelStakeCoins(30, 1_240)).toBe(30);
    expect(duelStakeCoins(80, 80)).toBe(80);
  });

  it('lets a broke challenger win nothing from anybody', () => {
    expect(duelStakeCoins(0, 5_000)).toBe(0);
    expect(duelStakeCoins(5_000, 0)).toBe(0);
  });

  it('never resolves to a negative transfer', () => {
    expect(duelStakeCoins(-10, 40)).toBe(0);
  });
});

describe('the griefing floors', () => {
  const now = Date.UTC(2026, 5, 1, 12, 0, 0);

  it('opens duels to a character exactly 24 hours old, and not a moment before', () => {
    expect(isOldEnoughToDuel(new Date(now - DUEL_MIN_ACCOUNT_AGE_MS).toISOString(), now)).toBe(true);
    expect(isOldEnoughToDuel(new Date(now - DUEL_MIN_ACCOUNT_AGE_MS + 1).toISOString(), now)).toBe(false);
    expect(isOldEnoughToDuel(new Date(now), now)).toBe(false);
  });

  it('rolls the chicken badge 24 hours from the decline, not to a local midnight', () => {
    const until = chickenBadgeUntil(now);
    expect(until.getTime()).toBe(now + CHICKEN_BADGE_MS);
    expect(isChickenBadgeActive(until, now)).toBe(true);
    expect(isChickenBadgeActive(until, now + CHICKEN_BADGE_MS - 1)).toBe(true);
    expect(isChickenBadgeActive(until, now + CHICKEN_BADGE_MS)).toBe(false);
    expect(isChickenBadgeActive(null, now)).toBe(false);
  });

  it('blocks a re-invite for 24 hours after a decline by that pair, then opens again', () => {
    const declinedAt = new Date(now);
    expect(isDeclineCooldownActive(declinedAt, now)).toBe(true);
    expect(isDeclineCooldownActive(declinedAt, now + CHICKEN_BADGE_MS - 1)).toBe(true);
    expect(isDeclineCooldownActive(declinedAt, now + CHICKEN_BADGE_MS)).toBe(false);
    expect(isDeclineCooldownActive(null, now)).toBe(false);
    expect(declineCooldownEndsAt(declinedAt).getTime()).toBe(now + CHICKEN_BADGE_MS);
  });
});

describe('throw vocabulary', () => {
  it('is exactly three actions — there is no flee', () => {
    expect(DUEL_THROWS).toEqual<readonly DuelThrow[]>(['rock', 'paper', 'scissors']);
  });
});
