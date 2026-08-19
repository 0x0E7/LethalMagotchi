import { describe, expect, it } from 'vitest';
import { containsBlockedTerm } from '../src/moderation.js';

/**
 * The wordlist has two tiers with deliberately different strictness:
 *
 *  - substring-blocked slurs are matched against the *folded* string (casing,
 *    diacritics, leetspeak and every non-letter removed), so padding them out
 *    does not get them through;
 *  - word-blocked terms are matched per word, so innocuous words that merely
 *    contain them ("grape", "therapist", "spice") are not false positives.
 *
 * Both tiers are exercised here, in both directions.
 */
describe('containsBlockedTerm — clean content passes', () => {
  it.each([
    'Professional rock collector. Naps in the sun.',
    'Grew up on a grape farm outside Reims.',
    'My therapist says I should socialise more.',
    'I run a spice rack empire.',
    'Assistant to the regional manager.',
    'Классный кот',
    '',
    '   ',
    'Cool cool cool cool.',
  ])('allows %j', (value) => {
    expect(containsBlockedTerm(value)).toBe(false);
  });
});

describe('containsBlockedTerm — substring tier resists evasion', () => {
  it('blocks the plain term', () => {
    expect(containsBlockedTerm('you are a faggot')).toBe(true);
  });

  it('blocks it regardless of casing', () => {
    expect(containsBlockedTerm('FAGGOT')).toBe(true);
  });

  it('blocks it when padded with spaces between letters', () => {
    expect(containsBlockedTerm('f a g g o t')).toBe(true);
  });

  it('blocks it when padded with punctuation between letters', () => {
    expect(containsBlockedTerm('f.a.g.g.o.t')).toBe(true);
  });

  it('blocks leetspeak substitutions', () => {
    expect(containsBlockedTerm('f4gg0t')).toBe(true);
  });

  it('blocks symbol-for-letter substitutions', () => {
    expect(containsBlockedTerm('f@gg0t')).toBe(true);
  });

  it('blocks diacritic-decorated spellings', () => {
    expect(containsBlockedTerm('fággöt')).toBe(true);
  });

  it('blocks it when embedded inside a longer word', () => {
    expect(containsBlockedTerm('superfaggotry')).toBe(true);
  });

  it('blocks it when split across a line break', () => {
    expect(containsBlockedTerm('fagg\not')).toBe(true);
  });
});

describe('containsBlockedTerm — word tier', () => {
  it('blocks the standalone word', () => {
    expect(containsBlockedTerm('what a retard')).toBe(true);
  });

  it('blocks the plural listed in the wordlist', () => {
    expect(containsBlockedTerm('retards everywhere')).toBe(true);
  });

  it('blocks a leetspeak spelling of a standalone word', () => {
    expect(containsBlockedTerm('what a r3t4rd')).toBe(true);
  });

  it('blocks the word when it is punctuation-delimited rather than space-delimited', () => {
    expect(containsBlockedTerm('ugh,retard.')).toBe(true);
  });

  it('does not block an unrelated word that contains it as a substring', () => {
    expect(containsBlockedTerm('the flame retardant curtains')).toBe(false);
  });
});
