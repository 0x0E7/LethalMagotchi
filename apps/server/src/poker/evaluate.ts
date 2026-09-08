import pokersolver from 'pokersolver';
import { RANK_NAME, RANK_PLURAL, RANKS, isCard, rankOf, type Card, type Rank } from '@lethalmagotchi/shared';

/**
 * `pokersolver` is CommonJS, and Node's ESM loader cannot statically detect its named
 * exports — `import { Hand }` resolves under a bundler but throws at runtime on a real
 * `node dist/index.js`. Destructuring the default export is the interop that works in
 * both places.
 */
const { Hand } = pokersolver;

export interface EvaluatedHand {
  /** pokersolver's category rank (1 = high card … 9 = straight flush). */
  category: number;
  /** Category name as pokersolver reports it, e.g. "Two Pair". */
  name: string;
  /** Plain-language, e.g. "Two pair, kings and sevens". */
  description: string;
  cards: Card[];
}

const RANK_INDEX: Record<Rank, number> = Object.fromEntries(
  RANKS.map((rank, index) => [rank, index]),
) as Record<Rank, number>;

/**
 * pokersolver renders a ten as "10", and rewrites the ace of a five-high straight as a
 * low "1" — both need mapping back to this codebase's two-character card codes.
 */
function toCard(value: string): Card {
  let normalized = value;
  if (value.startsWith('10')) normalized = `T${value.slice(2)}`;
  else if (value.startsWith('1')) normalized = `A${value.slice(1)}`;
  if (!isCard(normalized)) throw new Error(`pokersolver returned an unknown card: ${value}`);
  return normalized;
}

const WHEEL_RANKS = new Set<Rank>(['A', '2', '3', '4', '5']);

/** The ace plays low in a five-high straight, so the high card is the five, not the ace. */
function straightHigh(cards: Card[]): Rank {
  const ranks = new Set(cards.map(rankOf));
  if (ranks.size === WHEEL_RANKS.size && [...ranks].every((rank) => WHEEL_RANKS.has(rank))) return '5';
  return highRank(cards);
}

function rankGroups(cards: Card[]): Rank[] {
  const counts = new Map<Rank, number>();
  for (const card of cards) {
    const rank = rankOf(card);
    counts.set(rank, (counts.get(rank) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || RANK_INDEX[b[0]] - RANK_INDEX[a[0]])
    .map(([rank]) => rank);
}

function highRank(cards: Card[]): Rank {
  return cards.reduce((best, card) =>
    RANK_INDEX[rankOf(card)] > RANK_INDEX[best] ? rankOf(card) : best,
  rankOf(cards[0]!));
}

/**
 * Plain words, not poker shorthand — the single biggest onboarding win available at the
 * table for players who do not already know hand rankings. Built from the five selected
 * cards rather than pokersolver's own `descr` ("Two Pair, K's & 7's"), which is written
 * for people who already speak poker.
 */
function describe(name: string, cards: Card[]): string {
  const groups = rankGroups(cards);
  const top = groups[0]!;
  const second = groups[1];

  switch (name) {
    case 'Straight Flush': {
      const high = straightHigh(cards);
      return high === 'A' ? 'Royal flush' : `Straight flush, ${RANK_NAME[high]} high`;
    }
    case 'Four of a Kind':
      return `Four of a kind, ${RANK_PLURAL[top]}`;
    case 'Full House':
      return `Full house, ${RANK_PLURAL[top]} over ${RANK_PLURAL[second!]}`;
    case 'Flush':
      return `Flush, ${RANK_NAME[highRank(cards)]} high`;
    case 'Straight':
      return `Straight, ${RANK_NAME[straightHigh(cards)]} high`;
    case 'Three of a Kind':
      return `Three of a kind, ${RANK_PLURAL[top]}`;
    case 'Two Pair':
      return `Two pair, ${RANK_PLURAL[top]} and ${RANK_PLURAL[second!]}`;
    case 'Pair':
      return `Pair of ${RANK_PLURAL[top]}`;
    default:
      return `${RANK_NAME[highRank(cards)].replace(/^./, (c) => c.toUpperCase())} high`;
  }
}

export function evaluate(cards: Card[]): EvaluatedHand {
  const solved = Hand.solve(cards);
  const selected = solved.cards.map((card) => toCard(card.toString()));
  return {
    category: solved.rank,
    name: solved.name,
    description: describe(solved.name, selected),
    cards: selected,
  };
}

/**
 * Winners among a set of contenders, by index. pokersolver owns the comparison — the
 * one thing we deliberately do not reimplement — including exact ties, which is what
 * makes split pots correct.
 */
export function winningIndexes(hands: Card[][]): number[] {
  const solved = hands.map((cards) => Hand.solve(cards));
  const winners = new Set(Hand.winners(solved));
  return solved.flatMap((hand, index) => (winners.has(hand) ? [index] : []));
}
