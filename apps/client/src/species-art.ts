import type { SpeciesId } from '@lethalmagotchi/shared';

/** Placeholder art until the species atlases land — see visual-design. */
export const SPECIES_EMOJI: Record<SpeciesId, string> = {
  dog: '🐕',
  cat: '🐈',
  horse: '🐎',
  cow: '🐄',
  lion: '🦁',
  fox: '🦊',
  wolf: '🐺',
  rabbit: '🐇',
  otter: '🦦',
  raccoon: '🦝',
  bear: '🐻',
  deer: '🦌',
  goat: '🐐',
  pig: '🐖',
  frog: '🐸',
  crow: '🐦‍⬛',
};

export function speciesArt(id: string): string {
  return SPECIES_EMOJI[id as SpeciesId] ?? '❔';
}
