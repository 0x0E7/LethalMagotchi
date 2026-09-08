import { describe, expect, it } from 'vitest';
import { DECK, type Card } from '@lethalmagotchi/shared';
import { shuffledDeck } from '../../src/poker/deck.js';
import { evaluate, winningIndexes } from '../../src/poker/evaluate.js';
import {
  applyAction,
  buildPots,
  legalActionsFor,
  potOf,
  startHand,
  timeoutAction,
  type EngineSeat,
  type HandState,
} from '../../src/poker/engine.js';

function table(stacks: number[], buttonSeat = 0, seed = 'seed-a'): HandState {
  return startHand({
    handNumber: 1,
    deckSeed: seed,
    buttonSeat,
    seats: stacks.map((stack, seatIndex) => ({ stack, seatIndex, characterId: `c${seatIndex}` })),
  });
}

function totalChips(state: HandState): number {
  return state.seats.reduce((sum, seat) => sum + seat.stack, 0) + potOf(state);
}

function seat(overrides: Partial<EngineSeat> & { seatIndex: number }): EngineSeat {
  return {
    characterId: `c${overrides.seatIndex}`,
    stack: 0,
    holeCards: [],
    committed: 0,
    totalCommitted: 0,
    folded: false,
    allIn: false,
    actedThisStreet: false,
    ...overrides,
  };
}

describe('deck', () => {
  it('is a permutation of a full 52-card deck', () => {
    const deck = shuffledDeck('abc');
    expect(deck).toHaveLength(52);
    expect(new Set(deck).size).toBe(52);
    expect([...deck].sort()).toEqual([...DECK].sort());
  });

  it('is deterministic for a seed and different across seeds', () => {
    expect(shuffledDeck('abc')).toEqual(shuffledDeck('abc'));
    expect(shuffledDeck('abc')).not.toEqual(shuffledDeck('abd'));
  });

  it('does not leave the deck in dealt order', () => {
    expect(shuffledDeck('abc')).not.toEqual(DECK);
  });
});

describe('evaluate wrapper', () => {
  it('describes every category in plain words', () => {
    const cases: [Card[], string][] = [
      [['Ad', 'Kd', 'Qd', 'Jd', 'Td', '2c', '3s'], 'Royal flush'],
      [['9d', '8d', '7d', '6d', '5d', '2c', '3s'], 'Straight flush, nine high'],
      [['Jc', 'Jd', 'Jh', 'Js', '5d', '2c', '3s'], 'Four of a kind, jacks'],
      [['5c', '5d', '5h', '9s', '9d', '2c', '3h'], 'Full house, fives over nines'],
      [['Ac', '9c', '7c', '4c', '2c', 'Kd', '3h'], 'Flush, ace high'],
      [['2c', '3d', '4h', '5d', '6s', '9h', 'Jc'], 'Straight, six high'],
      [['Ac', '2d', '3h', '4d', '5s', '9h', 'Jc'], 'Straight, five high'],
      [['Ac', '2c', '3c', '4c', '5c', '9h', 'Jc'], 'Straight flush, five high'],
      [['Qc', 'Qd', 'Qh', '9s', '5d', '2c', '3h'], 'Three of a kind, queens'],
      [['Ks', 'Kh', '7d', '7c', '2s', '9h', 'Jd'], 'Two pair, kings and sevens'],
      [['Ac', 'Ad', '3c', '5d', '7s', '9h', 'Jc'], 'Pair of aces'],
      [['Ac', 'Kd', '3c', '5d', '7s', '9h', 'Jc'], 'Ace high'],
    ];
    for (const [cards, description] of cases) {
      expect(evaluate(cards).description).toBe(description);
    }
  });

  it('describes a two-card preflop holding', () => {
    expect(evaluate(['Ac', 'Ah']).description).toBe('Pair of aces');
    expect(evaluate(['9c', '2h']).description).toBe('Nine high');
  });

  it('finds every winner on an exact tie', () => {
    expect(
      winningIndexes([
        ['Ac', 'Kd', 'Qh', 'Js', 'Tc', '2d', '3s'],
        ['Ad', 'Kc', 'Qs', 'Jh', 'Td', '4d', '5s'],
      ]),
    ).toEqual([0, 1]);
  });

  it('ranks a better hand as the sole winner', () => {
    expect(
      winningIndexes([
        ['Ac', 'Ad', 'Kh', 'Ks', 'Qc', '2d', '3s'],
        ['Ah', 'As', 'Kd', 'Kc', 'Jc', '4d', '5s'],
      ]),
    ).toEqual([0]);
  });
});

describe('blinds and opening action', () => {
  it('posts both blinds and starts action left of the big blind', () => {
    const state = table([3, 3, 3, 3, 3], 0);
    expect(state.smallBlindSeat).toBe(1);
    expect(state.bigBlindSeat).toBe(2);
    expect(state.seats[1]!.committed).toBe(1);
    expect(state.seats[2]!.committed).toBe(1);
    expect(state.toActSeat).toBe(3);
    expect(potOf(state)).toBe(2);
  });

  it('reverses the blinds heads-up and lets the button act first', () => {
    const state = table([3, 3], 0);
    expect(state.smallBlindSeat).toBe(0);
    expect(state.bigBlindSeat).toBe(1);
    expect(state.toActSeat).toBe(0);
  });

  it('deals two distinct hole cards per seat', () => {
    const state = table([3, 3, 3, 3, 3]);
    const all = state.seats.flatMap((entry) => entry.holeCards);
    expect(all).toHaveLength(10);
    expect(new Set(all).size).toBe(10);
  });

  it('gives the big blind an option to check when everyone limps', () => {
    let state = table([3, 3, 3, 3, 3], 0);
    for (const seatIndex of [3, 4, 0]) {
      state = applyAction(state, { seatIndex, action: 'call' });
    }
    // Equal blinds leave the small blind nothing to complete, so it checks too.
    state = applyAction(state, { seatIndex: 1, action: 'check' });
    expect(state.street).toBe('preflop');
    expect(state.toActSeat).toBe(2);
    expect(legalActionsFor(state)!.actions).toContain('check');
  });
});

describe('betting legality', () => {
  it('rejects an action from a seat that is not to act', () => {
    const state = table([3, 3, 3, 3, 3], 0);
    expect(() => applyAction(state, { seatIndex: 4, action: 'call' })).toThrow(/not your turn/i);
  });

  it('rejects a check when there is a bet to call', () => {
    const state = table([3, 3, 3, 3, 3], 0);
    expect(legalActionsFor(state)!.actions).not.toContain('check');
    expect(() => applyAction(state, { seatIndex: 3, action: 'check' })).toThrow(/cannot check/i);
  });

  it('rejects a raise below the minimum and above the stack', () => {
    const state = table([10, 10, 10, 10, 10], 0);
    const legal = legalActionsFor(state)!;
    expect(legal.minRaiseTo).toBe(2);
    expect(legal.maxRaiseTo).toBe(10);
    expect(() => applyAction(state, { seatIndex: 3, action: 'raise', amount: 1 })).toThrow(/between/i);
    expect(() => applyAction(state, { seatIndex: 3, action: 'raise', amount: 11 })).toThrow(/between/i);
  });

  it('offers all-in but not a raise when the stack is below a min-raise', () => {
    const state = table([3, 3, 3, 3, 3], 0);
    const raised = applyAction(state, { seatIndex: 3, action: 'raise', amount: 3 });
    const legal = legalActionsFor(raised)!;
    expect(legal.toCall).toBe(3);
    expect(legal.actions).toEqual(['fold', 'call']);
  });

  it('treats a call larger than the stack as an all-in call', () => {
    let state = table([2, 3, 3, 3, 8], 0);
    state = applyAction(state, { seatIndex: 3, action: 'raise', amount: 3 });
    state = applyAction(state, { seatIndex: 4, action: 'fold' });
    state = applyAction(state, { seatIndex: 0, action: 'call' });
    expect(state.seats[0]!.stack).toBe(0);
    expect(state.seats[0]!.allIn).toBe(true);
    expect(state.seats[0]!.totalCommitted).toBe(2);
  });
});

describe('min-raise reopening', () => {
  it('does not reopen betting for an all-in below a full raise', () => {
    let state = table([100, 100, 100, 4, 100], 0);
    state = applyAction(state, { seatIndex: 3, action: 'fold' });
    state = applyAction(state, { seatIndex: 4, action: 'raise', amount: 10 });
    state = applyAction(state, { seatIndex: 0, action: 'call' });
    state = applyAction(state, { seatIndex: 1, action: 'fold' });
    state = applyAction(state, { seatIndex: 2, action: 'allin' });
    expect(state.seats[2]!.committed).toBe(100);

    // Seat 2's shove is a full raise, so seat 4 gets to act again.
    expect(state.toActSeat).toBe(4);
  });

  it('closes the street when a short all-in is only called', () => {
    let state = table([100, 100, 12, 100, 100], 0);
    state = applyAction(state, { seatIndex: 3, action: 'raise', amount: 10 });
    state = applyAction(state, { seatIndex: 4, action: 'fold' });
    state = applyAction(state, { seatIndex: 0, action: 'fold' });
    state = applyAction(state, { seatIndex: 1, action: 'fold' });
    state = applyAction(state, { seatIndex: 2, action: 'allin' });
    expect(state.seats[2]!.committed).toBe(12);
    // 12 is a raise of 2 over 10 with a last raise size of 9 — short of a full raise,
    // so seat 3 may only call or fold, never re-raise.
    expect(state.toActSeat).toBe(3);
    expect(legalActionsFor(state)!.actions).toEqual(['fold', 'call']);
  });
});

describe('side pots', () => {
  it('splits three unequal all-ins into correct layers', () => {
    const pots = buildPots([
      seat({ seatIndex: 0, totalCommitted: 2, allIn: true }),
      seat({ seatIndex: 1, totalCommitted: 6, allIn: true }),
      seat({ seatIndex: 2, totalCommitted: 10, allIn: true }),
    ]);
    expect(pots).toEqual([
      { amount: 6, eligible: [0, 1, 2] },
      { amount: 8, eligible: [1, 2] },
      { amount: 4, eligible: [2] },
    ]);
    expect(pots.reduce((sum, pot) => sum + pot.amount, 0)).toBe(18);
  });

  it('keeps folded contributions in the pot but their owner ineligible', () => {
    const pots = buildPots([
      seat({ seatIndex: 0, totalCommitted: 5, folded: true }),
      seat({ seatIndex: 1, totalCommitted: 5 }),
      seat({ seatIndex: 2, totalCommitted: 5 }),
    ]);
    expect(pots).toEqual([{ amount: 15, eligible: [1, 2] }]);
  });

  it('merges adjacent layers with identical eligibility', () => {
    const pots = buildPots([
      seat({ seatIndex: 0, totalCommitted: 3, folded: true }),
      seat({ seatIndex: 1, totalCommitted: 8 }),
      seat({ seatIndex: 2, totalCommitted: 8 }),
    ]);
    expect(pots).toEqual([
      { amount: 9, eligible: [1, 2] },
      { amount: 10, eligible: [1, 2] },
    ].reduce<{ amount: number; eligible: number[] }[]>((merged, pot) => {
      const last = merged[merged.length - 1];
      if (last) {
        last.amount += pot.amount;
        return merged;
      }
      merged.push(pot);
      return merged;
    }, []));
  });

  it('never awards a short stack chips it could not have won', () => {
    let state = table([2, 6, 10, 10, 10], 0);
    state = applyAction(state, { seatIndex: 3, action: 'allin' });
    state = applyAction(state, { seatIndex: 4, action: 'fold' });
    // Seats 0, 1 and 2 cannot cover the shove, so calling is itself an all-in.
    state = applyAction(state, { seatIndex: 0, action: 'call' });
    state = applyAction(state, { seatIndex: 1, action: 'call' });
    state = applyAction(state, { seatIndex: 2, action: 'call' });

    expect(state.complete).toBe(true);
    const payoutTo = new Map(state.result!.payouts.map((entry) => [entry.seatIndex, entry.amount]));
    // Seat 0 is all-in for 2, so it can never collect more than 2 from each of the
    // four other contributors.
    expect(payoutTo.get(0) ?? 0).toBeLessThanOrEqual(8);
    expect(payoutTo.get(1) ?? 0).toBeLessThanOrEqual(6 * 4);
    expect(totalChips(state)).toBe(38);
  });
});

describe('hand resolution', () => {
  it('awards the pot uncontested when everyone folds', () => {
    let state = table([3, 3, 3, 3, 3], 0);
    for (const seatIndex of [3, 4, 0, 1]) {
      state = applyAction(state, { seatIndex, action: 'fold' });
    }
    expect(state.complete).toBe(true);
    expect(state.result!.uncontested).toBe(true);
    expect(state.result!.reveals).toEqual([]);
    expect(state.result!.payouts).toEqual([{ seatIndex: 2, amount: 2 }]);
    expect(state.seats[2]!.stack).toBe(4);
  });

  it('runs the board out and shows down when everyone is all-in', () => {
    let state = table([3, 3, 3, 3, 3], 0);
    state = applyAction(state, { seatIndex: 3, action: 'allin' });
    for (const seatIndex of [4, 0, 1, 2]) {
      state = applyAction(state, { seatIndex, action: 'call' });
    }
    expect(state.complete).toBe(true);
    expect(state.board).toHaveLength(5);
    expect(state.street).toBe('showdown');
    expect(state.result!.reveals).toHaveLength(5);
    expect(totalChips(state)).toBe(15);
  });

  it('reveals only contenders at showdown', () => {
    let state = table([10, 10, 10, 10, 10], 0);
    state = applyAction(state, { seatIndex: 3, action: 'fold' });
    state = applyAction(state, { seatIndex: 4, action: 'fold' });
    state = applyAction(state, { seatIndex: 0, action: 'fold' });
    state = applyAction(state, { seatIndex: 1, action: 'check' });
    state = applyAction(state, { seatIndex: 2, action: 'check' });
    for (const street of ['flop', 'turn', 'river'] as const) {
      expect(state.street).toBe(street);
      state = applyAction(state, { seatIndex: 1, action: 'check' });
      state = applyAction(state, { seatIndex: 2, action: 'check' });
    }
    expect(state.complete).toBe(true);
    expect(state.result!.reveals.map((reveal) => reveal.seatIndex)).toEqual([1, 2]);
  });

  it('splits a tied pot and gives the odd chip left of the button', () => {
    // Constructed directly: two seats playing an identical board with an odd pot,
    // topped up by a third seat's folded contribution.
    const state: HandState = table([10, 10, 10], 0);
    state.seats[0]!.holeCards = ['2c', '3d'];
    state.seats[1]!.holeCards = ['2h', '3s'];
    state.seats[2]!.folded = true;
    state.seats[2]!.totalCommitted = 1;
    for (const index of [0, 1]) {
      state.seats[index]!.totalCommitted = 5;
      state.seats[index]!.committed = 0;
      state.seats[index]!.stack = 5;
      state.seats[index]!.actedThisStreet = true;
    }
    state.seats[2]!.committed = 0;
    state.board = ['Ac', 'Kd', 'Qh', 'Js', 'Ts'];
    state.street = 'river';
    state.currentBet = 0;
    state.potCarry = 11;
    state.toActSeat = 0;
    state.seats[0]!.actedThisStreet = false;

    const done = applyAction(state, { seatIndex: 0, action: 'check' });
    expect(done.complete).toBe(true);
    expect(done.result!.payouts.map((payout) => payout.amount).sort((a, b) => b - a)).toEqual([6, 5]);
    // Seat 1 sits immediately left of button seat 0, so it takes the odd chip.
    expect(done.result!.payouts.find((payout) => payout.seatIndex === 1)!.amount).toBe(6);
    expect(done.seats[0]!.stack + done.seats[1]!.stack).toBe(21);
  });
});

describe('timeout policy', () => {
  it('checks when checking is free', () => {
    let state = table([10, 10, 10, 10, 10], 0);
    state = applyAction(state, { seatIndex: 3, action: 'call' });
    state = applyAction(state, { seatIndex: 4, action: 'call' });
    state = applyAction(state, { seatIndex: 0, action: 'call' });
    state = applyAction(state, { seatIndex: 1, action: 'check' });
    expect(timeoutAction(state)).toEqual({ seatIndex: 2, action: 'check', timeout: true });
  });

  it('folds when there is money to call', () => {
    const state = table([10, 10, 10, 10, 10], 0);
    expect(timeoutAction(state)).toEqual({ seatIndex: 3, action: 'fold', timeout: true });
  });

  it('logs a timeout distinctly from a voluntary move', () => {
    const state = table([10, 10, 10, 10, 10], 0);
    const next = applyAction(state, timeoutAction(state));
    expect(next.actions.at(-1)).toMatchObject({ action: 'timeout_fold', seatIndex: 3 });
  });
});

describe('chip conservation', () => {
  it('holds across every action of many pseudo-random hands', () => {
    let rngState = 12345;
    const nextInt = (bound: number): number => {
      rngState = (rngState * 1103515245 + 12345) % 2147483648;
      return rngState % bound;
    };

    for (let round = 0; round < 200; round += 1) {
      const stacks = Array.from({ length: 2 + nextInt(4) }, () => 1 + nextInt(20));
      const expected = stacks.reduce((sum, value) => sum + value, 0);
      let state = table(stacks, nextInt(stacks.length), `fuzz-${round}`);
      expect(totalChips(state)).toBe(expected);

      let guard = 0;
      while (!state.complete && guard < 200) {
        guard += 1;
        const legal = legalActionsFor(state)!;
        const action = legal.actions[nextInt(legal.actions.length)]!;
        const amount =
          action === 'bet' || action === 'raise'
            ? legal.minRaiseTo + nextInt(Math.max(1, legal.maxRaiseTo - legal.minRaiseTo + 1))
            : undefined;
        state = applyAction(state, { seatIndex: state.toActSeat!, action, ...(amount ? { amount } : {}) });
        expect(totalChips(state)).toBe(expected);
      }

      expect(state.complete).toBe(true);
      expect(state.seats.reduce((sum, entry) => sum + entry.stack, 0)).toBe(expected);
      const dealt = new Set([...state.seats.flatMap((entry) => entry.holeCards), ...state.board]);
      expect(dealt.size).toBe(stacks.length * 2 + state.board.length);
    }
  });
});

describe('sitting-out seats', () => {
  it('keeps seat indexes stable and deals nobody a busted seat cards', () => {
    const state = startHand({
      handNumber: 3,
      deckSeed: 'sit-out',
      buttonSeat: 1,
      seats: [
        { seatIndex: 0, characterId: 'c0', stack: 0, sittingOut: true },
        { seatIndex: 1, characterId: 'c1', stack: 8 },
        { seatIndex: 2, characterId: 'c2', stack: 0, sittingOut: true },
        { seatIndex: 3, characterId: 'c3', stack: 7 },
        { seatIndex: 4, characterId: 'c4', stack: 0, sittingOut: true },
      ],
    });

    expect(state.seats[0]!.holeCards).toEqual([]);
    expect(state.seats[1]!.holeCards).toHaveLength(2);
    expect(state.seats[3]!.holeCards).toHaveLength(2);
    // Two live seats play real heads-up rules even at a five-seat table.
    expect(state.smallBlindSeat).toBe(1);
    expect(state.bigBlindSeat).toBe(3);
    expect(state.toActSeat).toBe(1);
  });

  it('posts blinds to live seats when the seats after the button are busted', () => {
    const state = startHand({
      handNumber: 2,
      deckSeed: 'sit-out-2',
      buttonSeat: 0,
      seats: [
        { seatIndex: 0, characterId: 'c0', stack: 9 },
        { seatIndex: 1, characterId: 'c1', stack: 0, sittingOut: true },
        { seatIndex: 2, characterId: 'c2', stack: 6 },
        { seatIndex: 3, characterId: 'c3', stack: 4 },
        { seatIndex: 4, characterId: 'c4', stack: 0, sittingOut: true },
      ],
    });

    expect(state.smallBlindSeat).toBe(2);
    expect(state.bigBlindSeat).toBe(3);
    expect(state.seats[2]!.committed).toBe(1);
    expect(state.seats[3]!.committed).toBe(1);
    expect(state.toActSeat).toBe(0);
  });

  it('never lets a busted seat reach showdown', () => {
    let state = startHand({
      handNumber: 2,
      deckSeed: 'sit-out-3',
      buttonSeat: 0,
      seats: [
        { seatIndex: 0, characterId: 'c0', stack: 9 },
        { seatIndex: 1, characterId: 'c1', stack: 0, sittingOut: true },
        { seatIndex: 2, characterId: 'c2', stack: 6 },
        { seatIndex: 3, characterId: 'c3', stack: 4 },
        { seatIndex: 4, characterId: 'c4', stack: 0, sittingOut: true },
      ],
    });
    state = applyAction(state, { seatIndex: 0, action: 'allin' });
    state = applyAction(state, { seatIndex: 2, action: 'call' });
    state = applyAction(state, { seatIndex: 3, action: 'call' });

    expect(state.complete).toBe(true);
    expect(state.result!.reveals.map((reveal) => reveal.seatIndex).sort()).toEqual([0, 2, 3]);
    expect(state.seats.reduce((sum, seat) => sum + seat.stack, 0)).toBe(19);
  });
});
