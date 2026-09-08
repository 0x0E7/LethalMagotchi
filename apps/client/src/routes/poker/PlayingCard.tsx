import {
  RANK_GLYPH,
  SUIT_GLYPH,
  SUIT_IS_RED,
  cardAria,
  rankOf,
  suitOf,
  type Card,
} from '@lethalmagotchi/shared';

type Size = 'sm' | 'md' | 'lg';

/**
 * Cards are deliberately conventional — real rank/suit glyphs, real red and black.
 * Hand legibility is a functional requirement; house style enters only at the frame.
 */
export function PlayingCard({ card, size = 'md' }: { card: Card; size?: Size }) {
  const rank = rankOf(card);
  const suit = suitOf(card);

  return (
    <span
      className={`pcard ${size} ${SUIT_IS_RED[suit] ? 'red' : 'black'}`}
      role="img"
      aria-label={cardAria(card)}
    >
      <span className="pcard-rank" aria-hidden="true">
        {RANK_GLYPH[rank]}
      </span>
      <span className="pcard-suit" aria-hidden="true">
        {SUIT_GLYPH[suit]}
      </span>
    </span>
  );
}

export function CardBack({ size = 'md', label = 'Face-down card' }: { size?: Size; label?: string }) {
  return <span className={`pcard back ${size}`} role="img" aria-label={label} />;
}

export function CardSlot({ size = 'md' }: { size?: Size }) {
  return <span className={`pcard slot ${size}`} aria-hidden="true" />;
}
