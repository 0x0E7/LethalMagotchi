import { describe, expect, it } from 'vitest';
import {
  DONATION_APPEAL_COOLDOWN_MS,
  RAID_RAIDER_COOLDOWN_MS,
  RAID_TARGET_IMMUNITY_MS,
  WEALTH_BAND_FLOORS,
  isBeggar,
  isBeggarWallet,
  isOldEnoughToRaid,
  isRaidImmune,
  isRaidableWealth,
  isRaiderCooldownActive,
  mergeAwards,
  raidImmunityUntil,
  resolveBetrayal,
  resolveParityRound,
  resolveRaidOutcome,
  wealthBandOf,
  type BetrayalChoice,
  type ParityEntry,
} from '../src/index.js';

const NOW = 1_800_000_000_000;

describe('wealth bands', () => {
  it('places every boundary on the documented side of the line', () => {
    expect(wealthBandOf(0)).toBe('broke');
    expect(wealthBandOf(4)).toBe('broke');
    expect(wealthBandOf(WEALTH_BAND_FLOORS.comfortable)).toBe('comfortable');
    expect(wealthBandOf(24)).toBe('comfortable');
    expect(wealthBandOf(WEALTH_BAND_FLOORS.wealthy)).toBe('wealthy');
    expect(wealthBandOf(1_000)).toBe('wealthy');
  });

  it('refuses a target below the broke floor, which is also the beggar shield', () => {
    expect(isRaidableWealth(0)).toBe(false);
    expect(isRaidableWealth(4)).toBe(false);
    expect(isRaidableWealth(5)).toBe(true);
  });
});

describe('the beggar state', () => {
  it('is exactly "holds nothing", with no timer anywhere in it', () => {
    expect(isBeggar(0)).toBe(true);
    expect(isBeggar(1)).toBe(false);
    expect(isBeggar(999)).toBe(false);
  });

  it('lifts on the first coin, which is what makes a bankruptcy rescuable once', () => {
    const bankrupt = 0;
    expect(isBeggar(bankrupt)).toBe(true);
    // The single smallest possible donation ends eligibility for every other donor.
    expect(isBeggar(bankrupt + 1)).toBe(false);
  });

  it('does not count a wallet that is only empty because a raid is holding it', () => {
    expect(isBeggarWallet(0, null)).toBe(true);
    expect(isBeggarWallet(0, 'a-live-raid')).toBe(false);
    // And the lock alone never makes one, either.
    expect(isBeggarWallet(500, 'a-live-raid')).toBe(false);
  });
});

describe('the wallet comparison', () => {
  it('needs a strict majority in either direction, and voids an exact tie', () => {
    expect(resolveRaidOutcome(10, 9)).toBe('raiders_won');
    expect(resolveRaidOutcome(9, 10)).toBe('target_won');
    expect(resolveRaidOutcome(10, 10)).toBe('void');
    expect(resolveRaidOutcome(0, 0)).toBe('void');
    expect(resolveRaidOutcome(1, 0)).toBe('raiders_won');
  });
});

describe('the anti-griefing floors', () => {
  it('holds the 24h account-age line for raiders and targets alike', () => {
    expect(isOldEnoughToRaid(new Date(NOW - 24 * 60 * 60_000), NOW)).toBe(true);
    expect(isOldEnoughToRaid(new Date(NOW - 24 * 60 * 60_000 + 1), NOW)).toBe(false);
  });

  it('makes the per-target immunity a rolling 24h, not a calendar day', () => {
    const until = raidImmunityUntil(NOW);
    expect(until.getTime()).toBe(NOW + RAID_TARGET_IMMUNITY_MS);
    expect(isRaidImmune(until, NOW + RAID_TARGET_IMMUNITY_MS - 1)).toBe(true);
    expect(isRaidImmune(until, NOW + RAID_TARGET_IMMUNITY_MS)).toBe(false);
    expect(isRaidImmune(null, NOW)).toBe(false);
  });

  it('makes the per-raider cooldown a rolling 6h', () => {
    expect(isRaiderCooldownActive(new Date(NOW - RAID_RAIDER_COOLDOWN_MS + 1), NOW)).toBe(true);
    expect(isRaiderCooldownActive(new Date(NOW - RAID_RAIDER_COOLDOWN_MS), NOW)).toBe(false);
    expect(isRaiderCooldownActive(null, NOW)).toBe(false);
  });
});

function betrayalOf(choices: BetrayalChoice[], pot: number) {
  return resolveBetrayal(
    choices.map((choice, index) => ({ characterId: `r${index}`, choice })),
    pot,
  );
}

function totalAwarded(awards: Record<string, number>): number {
  return Object.values(awards).reduce((sum, coins) => sum + coins, 0);
}

describe('the betrayal table', () => {
  it('splits evenly when nobody reaches, at n = 2 and n = 3', () => {
    const pair = betrayalOf(['loyal', 'loyal'], 10);
    expect(pair.awards).toEqual({ r0: 5, r1: 5 });
    expect(pair.remainder).toBe(0);

    const trio = betrayalOf(['loyal', 'loyal', 'loyal'], 9);
    expect(trio.awards).toEqual({ r0: 3, r1: 3, r2: 3 });
    expect(trio.potDestroyed).toBe(false);
  });

  it('hands the whole pot to a lone betrayer, at n = 2 and n = 3', () => {
    expect(betrayalOf(['betray', 'loyal'], 10).awards).toEqual({ r0: 10, r1: 0 });
    expect(betrayalOf(['loyal', 'betray', 'loyal'], 9).awards).toEqual({ r0: 0, r1: 9, r2: 0 });
  });

  it('hands everything to the loyalists when more than one but not all reach', () => {
    const split = betrayalOf(['betray', 'betray', 'loyal'], 9);
    expect(split.awards).toEqual({ r0: 0, r1: 0, r2: 9 });
    expect(split.potDestroyed).toBe(false);
  });

  it('destroys the pot when everyone reaches — the one sanctioned burn', () => {
    for (const size of [2, 3]) {
      const all = betrayalOf(Array.from({ length: size }, () => 'betray' as const), 12);
      expect(all.potDestroyed).toBe(true);
      expect(totalAwarded(all.awards)).toBe(0);
      expect(all.remainder).toBe(0);
      expect(all.contenders).toEqual([]);
    }
  });

  it('never awards more than the pot, and sends the rest to the parity game', () => {
    const trio = betrayalOf(['loyal', 'loyal', 'loyal'], 5);
    expect(totalAwarded(trio.awards)).toBe(3);
    expect(trio.remainder).toBe(2);
    expect(trio.contenders).toEqual(['r0', 'r1', 'r2']);
    expect(totalAwarded(trio.awards) + trio.remainder).toBe(5);
  });

  it('plays the remainder only among the raiders who are owed something', () => {
    // Two betrayers, one loyalist: the loyalist takes it all, so there is no remainder.
    const one = betrayalOf(['betray', 'betray', 'loyal'], 5);
    expect(one.remainder).toBe(0);

    // Two loyalists out of three, with an odd pot: only those two play for the odd coin.
    const two = betrayalOf(['betray', 'betray', 'loyal', 'loyal'], 5);
    expect(two.contenders).toEqual(['r2', 'r3']);
    expect(two.remainder).toBe(1);
  });
});

function parity(entries: [string, 'odds' | 'evens', number][], remainder: number) {
  return resolveParityRound(
    entries.map(([characterId, call, value]): ParityEntry => ({ characterId, call, throw: value })),
    remainder,
  );
}

describe('the parity game', () => {
  it('decides on the parity of the summed throws', () => {
    const odd = parity([['a', 'odds', 1], ['b', 'evens', 2]], 1);
    expect(odd.parity).toBe('odds');
    expect(odd.winners).toEqual(['a']);
    expect(odd.awards).toEqual({ a: 1, b: 0 });

    const even = parity([['a', 'odds', 2], ['b', 'evens', 2]], 1);
    expect(even.parity).toBe('evens');
    expect(even.winners).toEqual(['b']);
  });

  it('re-runs a round nobody called, with the same players and the same remainder', () => {
    const nobody = parity([['a', 'evens', 1], ['b', 'evens', 0]], 2);
    expect(nobody.parity).toBe('odds');
    expect(nobody.replay).toBe(true);
    expect(nobody.winners).toEqual([]);
    expect(nobody.remainder).toBe(2);
    expect(nobody.contenders).toEqual(['a', 'b']);
    expect(totalAwarded(nobody.awards)).toBe(0);
  });

  it('distributes the whole remainder when it divides among the winners', () => {
    const both = parity([['a', 'odds', 1], ['b', 'odds', 0], ['c', 'evens', 0]], 2);
    expect(both.winners).toEqual(['a', 'b']);
    expect(both.awards).toEqual({ a: 1, b: 1, c: 0 });
    expect(both.remainder).toBe(0);
    expect(both.contenders).toEqual([]);
  });

  it('plays on among the winners alone when the remainder still will not divide', () => {
    const round = parity([['a', 'odds', 1], ['b', 'odds', 0], ['c', 'evens', 0]], 3);
    expect(totalAwarded(round.awards)).toBe(2);
    expect(round.remainder).toBe(1);
    expect(round.contenders).toEqual(['a', 'b']);
  });

  it('terminates: a remainder is always smaller than the field it is played among', () => {
    // The structural property the recursion rests on, asserted rather than assumed.
    for (let winners = 1; winners <= 3; winners += 1) {
      for (let coins = 0; coins <= 12; coins += 1) {
        const entries = Array.from(
          { length: winners },
          (_, index): [string, 'odds', number] => [`w${index}`, 'odds', index === 0 ? 1 : 0],
        );
        const round = parity(entries, coins);
        expect(round.remainder).toBeLessThan(winners === 1 ? 1 : winners + 1);
        expect(totalAwarded(round.awards) + round.remainder).toBe(coins);
      }
    }
  });

  it('conserves every coin across a whole betrayal-then-parity sequence', () => {
    const pot = 5;
    const betrayal = betrayalOf(['loyal', 'loyal', 'loyal'], pot);
    const first = parity(
      betrayal.contenders.map((id, index): [string, 'odds' | 'evens', number] => [
        id,
        index === 2 ? 'evens' : 'odds',
        index === 0 ? 1 : 0,
      ]),
      betrayal.remainder,
    );
    const running = mergeAwards(betrayal.awards, first.awards);
    expect(totalAwarded(running) + first.remainder).toBe(pot);
  });
});

describe('the appeal cooldown', () => {
  it('is three hours, and is the only thing that matters when nobody donates', () => {
    expect(DONATION_APPEAL_COOLDOWN_MS).toBe(3 * 60 * 60_000);
  });
});
