import { createHash, randomBytes } from 'node:crypto';
import { DECK, type Card } from '@lethalmagotchi/shared';

export function newDeckSeed(): string {
  return randomBytes(32).toString('hex');
}

/**
 * A counter-mode SHA-256 stream keyed by the deck seed.
 *
 * The design calls for both `crypto.randomInt` and a persisted `deckSeed` "for audit
 * replay". Those two are in tension — a `crypto.randomInt` shuffle is not reproducible
 * from any stored value, so the seed would prove nothing. Deriving the shuffle from
 * 32 cryptographically random bytes keeps the unpredictability that matters (a player
 * cannot guess the deck) *and* makes the persisted seed genuinely replayable next to
 * the append-only hand log.
 */
function* randomStream(seed: string): Generator<number> {
  let counter = 0;
  for (;;) {
    const block = createHash('sha256').update(`${seed}:${counter}`).digest();
    counter += 1;
    for (let offset = 0; offset + 4 <= block.length; offset += 4) {
      yield block.readUInt32BE(offset);
    }
  }
}

/** Rejection sampling, matching `crypto.randomInt`'s uniformity guarantee. */
function boundedInt(stream: Generator<number>, maxExclusive: number): number {
  const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
  for (;;) {
    const value = stream.next().value;
    if (value < limit) return value % maxExclusive;
  }
}

export function shuffledDeck(seed: string): Card[] {
  const cards = [...DECK];
  const stream = randomStream(seed);
  for (let index = cards.length - 1; index > 0; index -= 1) {
    const swap = boundedInt(stream, index + 1);
    const held = cards[index]!;
    cards[index] = cards[swap]!;
    cards[swap] = held;
  }
  return cards;
}
