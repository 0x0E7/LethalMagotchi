import { describe, expect, it } from 'vitest';
import { RESERVED_USERNAMES, checkUsername, normalizeUsername, suggestUsernames } from '../src/username.js';

describe('normalizeUsername', () => {
  it('lowercases so casing variants collapse to one identity', () => {
    expect(normalizeUsername('Alice')).toBe('alice');
    expect(normalizeUsername('ALICE')).toBe('alice');
  });

  it('NFKC-folds fullwidth characters onto their ASCII form', () => {
    expect(normalizeUsername('ａｌｉｃｅ')).toBe('alice');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeUsername('  alice  ')).toBe('alice');
  });

  it('produces the same key for every spelling that should collide', () => {
    const variants = ['alice', 'Alice', 'ALICE', ' Alice ', 'ａｌｉｃｅ', 'Ａｌｉｃｅ'];
    expect(new Set(variants.map(normalizeUsername)).size).toBe(1);
  });
});

describe('checkUsername', () => {
  it('accepts a plain lowercase username', () => {
    expect(checkUsername('otterfan')).toBeNull();
  });

  it('accepts digits and inner underscores', () => {
    expect(checkUsername('otter_fan_99')).toBeNull();
  });

  it('accepts a username that only becomes valid after normalization', () => {
    expect(checkUsername('OtterFan')).toBeNull();
  });

  it('rejects usernames shorter than 3 characters', () => {
    expect(checkUsername('ab')).toBe('length');
  });

  it('rejects usernames longer than 20 characters', () => {
    expect(checkUsername('a'.repeat(21))).toBe('length');
  });

  it('rejects non-ASCII letters that survive normalization (homoglyph defence)', () => {
    expect(checkUsername('аlice')).toBe('charset');
  });

  it('rejects punctuation and spaces', () => {
    expect(checkUsername('otter fan')).toBe('charset');
    expect(checkUsername('otter-fan')).toBe('charset');
    expect(checkUsername('otter.fan')).toBe('charset');
  });

  it('rejects a leading underscore', () => {
    expect(checkUsername('_otter')).toBe('edge_underscore');
  });

  it('rejects a trailing underscore', () => {
    expect(checkUsername('otter_')).toBe('edge_underscore');
  });

  it.each([...RESERVED_USERNAMES])('rejects the reserved name %s', (name) => {
    expect(checkUsername(name)).toBe('reserved');
  });

  it('rejects a reserved name spelled with different casing', () => {
    expect(checkUsername('AdMiN')).toBe('reserved');
  });

  it('reports length before charset for an empty string', () => {
    expect(checkUsername('')).toBe('length');
  });
});

describe('suggestUsernames', () => {
  it('returns three suggestions that are themselves valid usernames', () => {
    const suggestions = suggestUsernames('otterfan');
    expect(suggestions).toHaveLength(3);
    for (const suggestion of suggestions) expect(checkUsername(suggestion)).toBeNull();
  });

  it('strips edge underscores so suggestions do not inherit an invalid shape', () => {
    for (const suggestion of suggestUsernames('_otter_')) {
      expect(checkUsername(suggestion)).toBeNull();
    }
  });

  it('falls back to a usable base when the input normalizes to nothing', () => {
    for (const suggestion of suggestUsernames('___')) {
      expect(checkUsername(suggestion)).toBeNull();
    }
  });

  it('keeps suggestions within the 20-character limit for a long input', () => {
    for (const suggestion of suggestUsernames('a'.repeat(40))) {
      expect(suggestion.length).toBeLessThanOrEqual(20);
    }
  });
});
