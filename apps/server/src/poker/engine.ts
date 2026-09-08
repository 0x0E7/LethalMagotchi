import {
  BIG_BLIND_COINS,
  SMALL_BLIND_COINS,
  type BettingAction,
  type Card,
  type LegalActionsView,
  type LoggedAction,
  type PotPayout,
  type ShowdownReveal,
  type Street,
} from '@lethalmagotchi/shared';
import { shuffledDeck } from './deck.js';
import { evaluate, winningIndexes } from './evaluate.js';

export interface EngineSeat {
  seatIndex: number;
  characterId: string;
  stack: number;
  holeCards: Card[];
  /** Chips in front of this seat on the current street. */
  committed: number;
  /** Chips this seat has put in across the whole hand — the side-pot input. */
  totalCommitted: number;
  folded: boolean;
  allIn: boolean;
  actedThisStreet: boolean;
}

export interface HandActionRecord {
  seq: number;
  seatIndex: number;
  street: Street;
  action: LoggedAction;
  amount: number;
}

export interface Pot {
  amount: number;
  eligible: number[];
}

export interface HandResult {
  reveals: ShowdownReveal[];
  payouts: PotPayout[];
  pots: Pot[];
  /** Seats that took down at least one pot — drives the per-table hands-won tiebreak. */
  winners: number[];
  uncontested: boolean;
}

export interface HandState {
  handNumber: number;
  deckSeed: string;
  deck: Card[];
  dealt: number;
  buttonSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  seats: EngineSeat[];
  board: Card[];
  street: Street;
  toActSeat: number | null;
  currentBet: number;
  lastRaiseSize: number;
  potCarry: number;
  seq: number;
  actions: HandActionRecord[];
  complete: boolean;
  result: HandResult | null;
}

export class IllegalActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalActionError';
  }
}

export function potOf(state: HandState): number {
  return state.potCarry + state.seats.reduce((sum, seat) => sum + seat.committed, 0);
}

export function stacksOf(state: HandState): number[] {
  return state.seats.map((seat) => seat.stack);
}

function cloneHand(state: HandState): HandState {
  return {
    ...state,
    deck: state.deck,
    seats: state.seats.map((seat) => ({ ...seat, holeCards: [...seat.holeCards] })),
    board: [...state.board],
    actions: [...state.actions],
  };
}

function canAct(seat: EngineSeat): boolean {
  return !seat.folded && !seat.allIn && seat.stack > 0;
}

function contenders(state: HandState): EngineSeat[] {
  return state.seats.filter((seat) => !seat.folded);
}

function nextActor(state: HandState, from: number): number | null {
  for (let step = 1; step <= state.seats.length; step += 1) {
    const index = (from + step) % state.seats.length;
    if (canAct(state.seats[index]!)) return index;
  }
  return null;
}

function commit(seat: EngineSeat, amount: number): number {
  const paid = Math.min(amount, seat.stack);
  seat.stack -= paid;
  seat.committed += paid;
  seat.totalCommitted += paid;
  if (seat.stack === 0) seat.allIn = true;
  return paid;
}

function draw(state: HandState, count: number): Card[] {
  const cards = state.deck.slice(state.dealt, state.dealt + count);
  state.dealt += count;
  return cards;
}

export interface StartHandInput {
  handNumber: number;
  deckSeed: string;
  buttonSeat: number;
  /**
   * Seat indexes are the *table's*, stable for the life of the table. A seat busted in an
   * earlier hand sits out rather than being removed, so every message keeps referring to
   * the same seat the player has been watching.
   */
  seats: { seatIndex: number; characterId: string; stack: number; sittingOut?: boolean }[];
}

export function startHand(input: StartHandInput): HandState {
  const seats: EngineSeat[] = input.seats.map((seat) => ({
    seatIndex: seat.seatIndex,
    characterId: seat.characterId,
    stack: seat.stack,
    holeCards: [],
    committed: 0,
    totalCommitted: 0,
    folded: Boolean(seat.sittingOut),
    allIn: false,
    actedThisStreet: false,
  }));

  const live = seats.filter((seat) => !seat.folded).map((seat) => seat.seatIndex);
  const nextLive = (from: number): number => {
    for (let step = 1; step <= seats.length; step += 1) {
      const index = (from + step) % seats.length;
      if (live.includes(index)) return index;
    }
    return from;
  };

  // Heads-up reverses the blinds: the button posts the small blind and acts first
  // preflop, then acts last on every later street. "Heads-up" counts live seats, so a
  // five-seat table with three players busted still plays real heads-up rules.
  const headsUp = live.length === 2;
  const smallBlindSeat = headsUp ? input.buttonSeat : nextLive(input.buttonSeat);
  const bigBlindSeat = nextLive(smallBlindSeat);

  const state: HandState = {
    handNumber: input.handNumber,
    deckSeed: input.deckSeed,
    deck: shuffledDeck(input.deckSeed),
    dealt: 0,
    buttonSeat: input.buttonSeat,
    smallBlindSeat,
    bigBlindSeat,
    seats,
    board: [],
    street: 'preflop',
    toActSeat: null,
    currentBet: 0,
    lastRaiseSize: BIG_BLIND_COINS,
    potCarry: 0,
    seq: 0,
    actions: [],
    complete: false,
    result: null,
  };

  for (const seat of seats) {
    if (!seat.folded) seat.holeCards = draw(state, 2);
  }

  commit(seats[smallBlindSeat]!, SMALL_BLIND_COINS);
  commit(seats[bigBlindSeat]!, BIG_BLIND_COINS);
  state.currentBet = Math.max(...seats.map((seat) => seat.committed));

  state.toActSeat = nextActor(state, bigBlindSeat);
  return settle(state);
}

export function legalActionsFor(state: HandState): LegalActionsView | null {
  if (state.complete || state.toActSeat === null) return null;
  const seat = state.seats[state.toActSeat]!;

  const toCall = Math.min(state.currentBet - seat.committed, seat.stack);
  const maxRaiseTo = seat.committed + seat.stack;
  const minRaiseTo = Math.min(
    state.currentBet === 0 ? BIG_BLIND_COINS : state.currentBet + state.lastRaiseSize,
    maxRaiseTo,
  );

  const actions: BettingAction[] = ['fold'];
  actions.push(toCall === 0 ? 'check' : 'call');

  /**
   * A seat that has already acted and is facing an all-in raise too small to reopen
   * betting may only call or fold — it does not get a fresh raise. `actedThisStreet`
   * carries that state because a *full* raise clears it for everyone still behind.
   */
  const cappedByIncompleteRaise = seat.actedThisStreet && seat.committed < state.currentBet;

  if (!cappedByIncompleteRaise && seat.stack > toCall) {
    const canOpen = state.currentBet === 0 ? maxRaiseTo >= BIG_BLIND_COINS : maxRaiseTo > state.currentBet;
    if (canOpen && maxRaiseTo >= minRaiseTo) actions.push(state.currentBet === 0 ? 'bet' : 'raise');
    actions.push('allin');
  }

  return { actions, toCall, minRaiseTo, maxRaiseTo };
}

function bettingClosed(state: HandState): boolean {
  const live = contenders(state);
  if (live.length <= 1) return true;

  const actors = live.filter((seat) => canAct(seat));
  if (actors.length === 0) return true;
  if (actors.length === 1 && actors[0]!.committed >= state.currentBet) return true;
  return actors.every((seat) => seat.actedThisStreet && seat.committed === state.currentBet);
}

const NEXT_STREET: Record<Street, Street> = {
  preflop: 'flop',
  flop: 'turn',
  turn: 'river',
  river: 'showdown',
  showdown: 'showdown',
};

function openStreet(state: HandState, street: Street): void {
  state.street = street;
  // One burn card per street, matching table convention and keeping the persisted
  // deck order auditable against a real deal.
  if (street === 'flop') {
    draw(state, 1);
    state.board.push(...draw(state, 3));
  } else if (street === 'turn' || street === 'river') {
    draw(state, 1);
    state.board.push(...draw(state, 1));
  }
  state.currentBet = 0;
  state.lastRaiseSize = BIG_BLIND_COINS;
  for (const seat of state.seats) {
    seat.committed = 0;
    seat.actedThisStreet = false;
  }
}

function collectStreet(state: HandState): void {
  for (const seat of state.seats) {
    state.potCarry += seat.committed;
    seat.committed = 0;
  }
}

export function buildPots(seats: EngineSeat[]): Pot[] {
  const levels = [...new Set(seats.map((seat) => seat.totalCommitted).filter((value) => value > 0))].sort(
    (a, b) => a - b,
  );

  const pots: Pot[] = [];
  let previous = 0;
  for (const level of levels) {
    let amount = 0;
    for (const seat of seats) {
      amount += Math.min(seat.totalCommitted, level) - Math.min(seat.totalCommitted, previous);
    }
    const eligible = seats
      .filter((seat) => !seat.folded && seat.totalCommitted >= level)
      .map((seat) => seat.seatIndex);
    if (amount > 0) pots.push({ amount, eligible });
    previous = level;
  }

  // Consecutive layers with identical eligibility are one pot to a player; merging keeps
  // the showdown readable without changing any award.
  return pots.reduce<Pot[]>((merged, pot) => {
    const last = merged[merged.length - 1];
    if (last && last.eligible.length === pot.eligible.length && last.eligible.every((seat, index) => seat === pot.eligible[index])) {
      last.amount += pot.amount;
      return merged;
    }
    merged.push(pot);
    return merged;
  }, []);
}

/** Odd chips go to the first eligible winner left of the button — the standard rule. */
function awardOrder(state: HandState, seatIndexes: number[]): number[] {
  return [...seatIndexes].sort((a, b) => {
    const rank = (seat: number) => (seat - state.buttonSeat - 1 + state.seats.length * 2) % state.seats.length;
    return rank(a) - rank(b);
  });
}

function finish(state: HandState): HandState {
  // A hand can end mid-street (everyone folds), so sweep the street in before paying out.
  collectStreet(state);
  const live = contenders(state);
  const pots = buildPots(state.seats);
  const payouts = new Map<number, number>();
  const winners = new Set<number>();
  state.potCarry = 0;

  if (live.length === 1) {
    const winner = live[0]!;
    const total = pots.reduce((sum, pot) => sum + pot.amount, 0);
    winner.stack += total;
    payouts.set(winner.seatIndex, total);
    winners.add(winner.seatIndex);
    state.street = 'showdown';
    state.complete = true;
    state.toActSeat = null;
    state.result = {
      reveals: [],
      payouts: [{ seatIndex: winner.seatIndex, amount: total }],
      pots,
      winners: [winner.seatIndex],
      uncontested: true,
    };
    return state;
  }

  const evaluated = new Map<number, ReturnType<typeof evaluate>>();
  for (const seat of live) evaluated.set(seat.seatIndex, evaluate([...seat.holeCards, ...state.board]));

  for (const pot of pots) {
    const eligible = pot.eligible.filter((seatIndex) => !state.seats[seatIndex]!.folded);
    if (eligible.length === 0) continue;
    const relative = winningIndexes(
      eligible.map((seatIndex) => [...state.seats[seatIndex]!.holeCards, ...state.board]),
    );
    const potWinners = awardOrder(state, relative.map((index) => eligible[index]!));
    const share = Math.floor(pot.amount / potWinners.length);
    let remainder = pot.amount - share * potWinners.length;

    for (const seatIndex of potWinners) {
      const extra = remainder > 0 ? 1 : 0;
      remainder -= extra;
      const amount = share + extra;
      state.seats[seatIndex]!.stack += amount;
      payouts.set(seatIndex, (payouts.get(seatIndex) ?? 0) + amount);
      if (amount > 0) winners.add(seatIndex);
    }
  }

  state.street = 'showdown';
  state.complete = true;
  state.toActSeat = null;
  state.result = {
    reveals: live.map((seat) => ({
      seatIndex: seat.seatIndex,
      cards: [...seat.holeCards],
      handName: evaluated.get(seat.seatIndex)!.description,
    })),
    payouts: [...payouts.entries()].map(([seatIndex, amount]) => ({ seatIndex, amount })),
    pots,
    winners: [...winners],
    uncontested: false,
  };
  return state;
}

/**
 * Drives the hand forward as far as it can go without another player decision: closing
 * streets, dealing the board, running it out when nobody can act, and settling.
 */
function settle(state: HandState): HandState {
  for (;;) {
    if (contenders(state).length <= 1) return finish(state);

    if (!bettingClosed(state)) {
      if (state.toActSeat === null || !canAct(state.seats[state.toActSeat]!)) {
        state.toActSeat = nextActor(state, state.toActSeat ?? state.buttonSeat);
        if (state.toActSeat === null) return finish(state);
      }
      return state;
    }

    collectStreet(state);
    if (state.street === 'river') return finish(state);

    openStreet(state, NEXT_STREET[state.street]);
    const actorCount = contenders(state).filter((seat) => canAct(seat)).length;
    if (actorCount <= 1) {
      // Everyone left is all-in: run the remaining board out, then show down.
      state.toActSeat = null;
      continue;
    }
    state.toActSeat = nextActor(state, state.buttonSeat);
    if (state.toActSeat === null) continue;
    return state;
  }
}

export interface ActionInput {
  seatIndex: number;
  action: BettingAction;
  amount?: number;
  /** Timeouts are logged distinctly from the same move made by a player. */
  timeout?: boolean;
}

export function applyAction(state: HandState, input: ActionInput): HandState {
  if (state.complete) throw new IllegalActionError('This hand is already finished.');
  if (state.toActSeat !== input.seatIndex) throw new IllegalActionError('It is not your turn.');

  const next = cloneHand(state);
  const seat = next.seats[input.seatIndex]!;
  const legal = legalActionsFor(next)!;
  if (!legal.actions.includes(input.action)) {
    throw new IllegalActionError(`You cannot ${input.action} right now.`);
  }

  let logged: LoggedAction = input.action;
  let amount = 0;
  const betBefore = next.currentBet;
  const raiseSizeBefore = next.lastRaiseSize;

  switch (input.action) {
    case 'fold':
      seat.folded = true;
      logged = input.timeout ? 'timeout_fold' : 'fold';
      break;

    case 'check':
      logged = input.timeout ? 'timeout_check' : 'check';
      break;

    case 'call':
      amount = commit(seat, legal.toCall);
      break;

    case 'bet':
    case 'raise': {
      const raiseTo = input.amount ?? 0;
      if (raiseTo < legal.minRaiseTo || raiseTo > legal.maxRaiseTo) {
        throw new IllegalActionError(
          `Raise must be between ${legal.minRaiseTo} and ${legal.maxRaiseTo} coins.`,
        );
      }
      amount = commit(seat, raiseTo - seat.committed);
      next.lastRaiseSize = Math.max(next.lastRaiseSize, seat.committed - next.currentBet);
      next.currentBet = Math.max(next.currentBet, seat.committed);
      break;
    }

    case 'allin': {
      amount = commit(seat, seat.stack);
      if (seat.committed > betBefore) {
        if (seat.committed - betBefore >= raiseSizeBefore) next.lastRaiseSize = seat.committed - betBefore;
        next.currentBet = seat.committed;
      }
      break;
    }
  }

  /**
   * An all-in that raises by less than a full raise does not reopen betting — players
   * who already acted owe the difference but do not get a fresh raise. Comparing the
   * increment against the raise size *before* this action is what encodes that.
   */
  const reopened =
    (input.action === 'bet' || input.action === 'raise' || input.action === 'allin') &&
    seat.committed > betBefore &&
    seat.committed - betBefore >= raiseSizeBefore;

  if (reopened) {
    for (const other of next.seats) {
      if (other.seatIndex !== seat.seatIndex && other.committed < next.currentBet) {
        other.actedThisStreet = false;
      }
    }
  }

  seat.actedThisStreet = true;
  next.seq += 1;
  next.actions.push({
    seq: next.seq,
    seatIndex: seat.seatIndex,
    street: next.street,
    action: logged,
    amount,
  });

  next.toActSeat = nextActor(next, seat.seatIndex);
  return settle(next);
}

/** The move a seat makes when its deadline expires: check if free, otherwise fold. */
export function timeoutAction(state: HandState): ActionInput {
  const legal = legalActionsFor(state)!;
  return {
    seatIndex: state.toActSeat!,
    action: legal.toCall === 0 ? 'check' : 'fold',
    timeout: true,
  };
}
