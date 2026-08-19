import { describe, expect, it } from 'vitest';
import { countNewlines, isAllowedName, sanitizeBio, sanitizeName } from '../src/text.js';

describe('sanitizeName', () => {
  it('collapses runs of whitespace into single spaces', () => {
    expect(sanitizeName('Sir   Reginald    Whiskers')).toBe('Sir Reginald Whiskers');
  });

  it('trims leading and trailing whitespace', () => {
    expect(sanitizeName('  Bubbles  ')).toBe('Bubbles');
  });

  it('collapses tabs and newlines into spaces so a name stays one line', () => {
    expect(sanitizeName('Bub\tbles\nJr')).toBe('Bub bles Jr');
  });

  it('strips zero-width and other invisible formatting characters', () => {
    expect(sanitizeName('Bub\u200Bbles')).toBe('Bubbles');
  });

  it('NFKC-normalizes fullwidth input to its ASCII equivalent', () => {
    expect(sanitizeName('Ｂｕｂｂｌｅｓ')).toBe('Bubbles');
  });

  it('leaves accented letters intact', () => {
    expect(sanitizeName('Zoë')).toBe('Zoë');
  });

  it('returns an empty string for whitespace-only input', () => {
    expect(sanitizeName('   \t  ')).toBe('');
  });
});

describe('sanitizeBio', () => {
  it('normalizes CRLF to LF', () => {
    expect(sanitizeBio('one\r\ntwo')).toBe('one\ntwo');
  });

  it('normalizes a lone CR to LF', () => {
    expect(sanitizeBio('one\rtwo')).toBe('one\ntwo');
  });

  it('preserves intentional line breaks', () => {
    expect(sanitizeBio('one\ntwo\nthree')).toBe('one\ntwo\nthree');
  });

  it('collapses three or more blank lines into a single blank line', () => {
    expect(sanitizeBio('one\n\n\n\n\ntwo')).toBe('one\n\ntwo');
  });

  it('trims trailing whitespace on each line', () => {
    expect(sanitizeBio('one   \n   two')).toBe('one\ntwo');
  });

  it('strips control characters without eating newlines', () => {
    expect(sanitizeBio('one\ntwo​')).toBe('one\ntwo');
  });

  it('collapses horizontal whitespace runs but not vertical ones', () => {
    expect(sanitizeBio('a \t  b\n\nc')).toBe('a b\n\nc');
  });
});

describe('countNewlines', () => {
  it('counts zero for a single-line value', () => {
    expect(countNewlines('one line')).toBe(0);
  });

  it('counts every line break, including blank lines', () => {
    expect(countNewlines('a\nb\n\nc')).toBe(3);
  });
});

describe('isAllowedName', () => {
  it.each(["O'Malley", 'Jean-Luc', 'Agent 47', 'Zoë', '守り人'])('accepts %s', (value) => {
    expect(isAllowedName(value)).toBe(true);
  });

  it.each(['<script>', 'a@b', 'name!', 'semi;colon', ''])('rejects %s', (value) => {
    expect(isAllowedName(value)).toBe(false);
  });
});
