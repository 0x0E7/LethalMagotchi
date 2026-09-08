export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;
export const SUITS = ['c', 'd', 'h', 's'] as const;

export type Rank = (typeof RANKS)[number];
export type Suit = (typeof SUITS)[number];
export type Card = `${Rank}${Suit}`;

export const DECK: Card[] = SUITS.flatMap((suit) => RANKS.map((rank) => `${rank}${suit}` as Card));

export function isCard(value: unknown): value is Card {
  return typeof value === 'string' && value.length === 2 && DECK.includes(value as Card);
}

export function rankOf(card: Card): Rank {
  return card[0] as Rank;
}

export function suitOf(card: Card): Suit {
  return card[1] as Suit;
}

/** Rendering uses genre-standard glyphs, deliberately not house style — legibility wins. */
export const RANK_GLYPH: Record<Rank, string> = {
  '2': '2',
  '3': '3',
  '4': '4',
  '5': '5',
  '6': '6',
  '7': '7',
  '8': '8',
  '9': '9',
  T: '10',
  J: 'J',
  Q: 'Q',
  K: 'K',
  A: 'A',
};

export const SUIT_GLYPH: Record<Suit, string> = { c: '♣', d: '♦', h: '♥', s: '♠' };
export const SUIT_NAME: Record<Suit, string> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
export const SUIT_IS_RED: Record<Suit, boolean> = { c: false, d: true, h: true, s: false };

export const RANK_NAME: Record<Rank, string> = {
  '2': 'two',
  '3': 'three',
  '4': 'four',
  '5': 'five',
  '6': 'six',
  '7': 'seven',
  '8': 'eight',
  '9': 'nine',
  T: 'ten',
  J: 'jack',
  Q: 'queen',
  K: 'king',
  A: 'ace',
};

export const RANK_PLURAL: Record<Rank, string> = {
  '2': 'twos',
  '3': 'threes',
  '4': 'fours',
  '5': 'fives',
  '6': 'sixes',
  '7': 'sevens',
  '8': 'eights',
  '9': 'nines',
  T: 'tens',
  J: 'jacks',
  Q: 'queens',
  K: 'kings',
  A: 'aces',
};

export function cardLabel(card: Card): string {
  return `${RANK_GLYPH[rankOf(card)]}${SUIT_GLYPH[suitOf(card)]}`;
}

export function cardAria(card: Card): string {
  return `${RANK_NAME[rankOf(card)]} of ${SUIT_NAME[suitOf(card)]}`;
}

export function cardsAria(cards: Card[]): string {
  return cards.map(cardAria).join(', ');
}
