import { describe, expect, it } from 'vitest';
import { BIO_MAX, BIO_MAX_NEWLINES, CITY_MAX, NICKNAME_MAX } from '../src/text.js';
import {
  characterCreateSchema,
  characterPatchSchema,
  loginSchema,
  registerSchema,
} from '../src/schemas.js';

const VALID_CHARACTER = {
  speciesId: 'otter',
  nickname: 'Bubbles',
  bio: 'Professional rock collector.',
  originCountry: 'NL',
  originCity: 'Utrecht',
  occupationId: 'chef',
  personalityId: 'goofball',
};

function issuePaths(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }): string[] {
  return (result.error?.issues ?? []).map((issue) => issue.path.join('.'));
}

describe('registerSchema', () => {
  it('accepts a valid username and password', () => {
    expect(registerSchema.safeParse({ username: 'otterfan', password: 'kelp-forest-99' }).success).toBe(true);
  });

  it('reports the username problem on the username path', () => {
    const result = registerSchema.safeParse({ username: 'ab', password: 'kelp-forest-99' });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('username');
  });

  it('reports the password problem on the password path, not the object root', () => {
    const result = registerSchema.safeParse({ username: 'otterfan', password: 'short' });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('password');
  });

  it('rejects a password containing the username, cross-field', () => {
    const result = registerSchema.safeParse({ username: 'otterfan', password: 'my-otterfan-pw' });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.message).toMatch(/cannot contain your username/i);
  });

  it('rejects an absurdly long username before running username rules', () => {
    expect(registerSchema.safeParse({ username: 'a'.repeat(500), password: 'kelp-forest-99' }).success).toBe(
      false,
    );
  });

  it('rejects a missing password outright', () => {
    expect(registerSchema.safeParse({ username: 'otterfan' }).success).toBe(false);
  });
});

describe('loginSchema', () => {
  it('accepts credentials that would fail registration rules', () => {
    // Login must not re-apply registration validation, or accounts created under
    // older rules become unreachable.
    expect(loginSchema.safeParse({ username: 'ADMIN', password: 'x' }).success).toBe(true);
  });

  it('rejects an empty username', () => {
    expect(loginSchema.safeParse({ username: '', password: 'kelp-forest-99' }).success).toBe(false);
  });

  it('rejects an empty password', () => {
    expect(loginSchema.safeParse({ username: 'otterfan', password: '' }).success).toBe(false);
  });
});

describe('characterCreateSchema — nickname', () => {
  it('collapses internal whitespace before validating', () => {
    const result = characterCreateSchema.parse({ ...VALID_CHARACTER, nickname: 'Sir   Reginald' });
    expect(result.nickname).toBe('Sir Reginald');
  });

  it('trims surrounding whitespace', () => {
    expect(characterCreateSchema.parse({ ...VALID_CHARACTER, nickname: '  Bubbles  ' }).nickname).toBe(
      'Bubbles',
    );
  });

  it('rejects a nickname that is only whitespace', () => {
    const result = characterCreateSchema.safeParse({ ...VALID_CHARACTER, nickname: '     ' });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('nickname');
  });

  it('rejects a nickname that is too short after sanitization', () => {
    expect(characterCreateSchema.safeParse({ ...VALID_CHARACTER, nickname: ' a ' }).success).toBe(false);
  });

  it('applies the length limit to the sanitized value, not the raw one', () => {
    // 24 characters plus padding: legal once collapsed, illegal if measured raw.
    const raw = `  ${'a'.repeat(NICKNAME_MAX)}  `;
    expect(characterCreateSchema.parse({ ...VALID_CHARACTER, nickname: raw }).nickname).toHaveLength(
      NICKNAME_MAX,
    );
  });

  it('rejects a nickname one character over the limit', () => {
    const result = characterCreateSchema.safeParse({
      ...VALID_CHARACTER,
      nickname: 'a'.repeat(NICKNAME_MAX + 1),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a nickname with disallowed punctuation', () => {
    const result = characterCreateSchema.safeParse({ ...VALID_CHARACTER, nickname: '<script>x' });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('nickname');
  });

  it("accepts apostrophes, hyphens and accents", () => {
    expect(characterCreateSchema.parse({ ...VALID_CHARACTER, nickname: "Zoë O'Hare-Jr" }).nickname).toBe(
      "Zoë O'Hare-Jr",
    );
  });
});

describe('characterCreateSchema — bio', () => {
  it('defaults to an empty string when omitted', () => {
    const { bio: _omitted, ...withoutBio } = VALID_CHARACTER;
    expect(characterCreateSchema.parse(withoutBio).bio).toBe('');
  });

  it('strips zero-width formatting characters used to pad past filters', () => {
    expect(characterCreateSchema.parse({ ...VALID_CHARACTER, bio: 'cl\u200Bean' }).bio).toBe('clean');
  });

  it('strips control characters', () => {
    expect(characterCreateSchema.parse({ ...VALID_CHARACTER, bio: 'clean\u0007bio' }).bio).toBe('cleanbio');
  });

  it('allows exactly the maximum number of line breaks', () => {
    const bio = Array.from({ length: BIO_MAX_NEWLINES + 1 }, (_, i) => `line ${i}`).join('\n');
    expect(characterCreateSchema.safeParse({ ...VALID_CHARACTER, bio }).success).toBe(true);
  });

  it('rejects one line break over the limit', () => {
    const bio = Array.from({ length: BIO_MAX_NEWLINES + 2 }, (_, i) => `line ${i}`).join('\n');
    const result = characterCreateSchema.safeParse({ ...VALID_CHARACTER, bio });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('bio');
  });

  it('counts collapsed blank lines, so padding with blank lines does not trip the limit', () => {
    // sanitizeBio squashes 3+ consecutive newlines to 2 before the rule runs.
    expect(characterCreateSchema.safeParse({ ...VALID_CHARACTER, bio: 'a\n\n\n\n\n\n\n\nb' }).success).toBe(
      true,
    );
  });

  it('accepts a bio at exactly the character cap', () => {
    expect(characterCreateSchema.safeParse({ ...VALID_CHARACTER, bio: 'x'.repeat(BIO_MAX) }).success).toBe(
      true,
    );
  });

  it('rejects a bio one character over the cap', () => {
    const result = characterCreateSchema.safeParse({ ...VALID_CHARACTER, bio: 'x'.repeat(BIO_MAX + 1) });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('bio');
  });

  it('applies the cap after sanitization, so trailing whitespace does not push it over', () => {
    const bio = `${'x'.repeat(BIO_MAX)}      `;
    expect(characterCreateSchema.parse({ ...VALID_CHARACTER, bio }).bio).toHaveLength(BIO_MAX);
  });

  it('rejects input long enough to be a denial-of-service payload before sanitizing', () => {
    expect(characterCreateSchema.safeParse({ ...VALID_CHARACTER, bio: 'x'.repeat(50_000) }).success).toBe(
      false,
    );
  });

  it('does not moderate — that is a separate server-side check', () => {
    // Sanitization and moderation are deliberately different layers; the schema
    // must not silently accept-and-strip slurs, it should pass them through for
    // the moderation pass to reject with its own error code.
    expect(characterCreateSchema.parse({ ...VALID_CHARACTER, bio: 'faggot' }).bio).toBe('faggot');
  });
});

describe('characterCreateSchema — origin city', () => {
  it('defaults to null when omitted', () => {
    const { originCity: _omitted, ...withoutCity } = VALID_CHARACTER;
    expect(characterCreateSchema.parse(withoutCity).originCity).toBeNull();
  });

  it('converts an empty string to null', () => {
    expect(characterCreateSchema.parse({ ...VALID_CHARACTER, originCity: '' }).originCity).toBeNull();
  });

  it('converts a whitespace-only string to null', () => {
    expect(characterCreateSchema.parse({ ...VALID_CHARACTER, originCity: '   ' }).originCity).toBeNull();
  });

  it('accepts an explicit null', () => {
    expect(characterCreateSchema.parse({ ...VALID_CHARACTER, originCity: null }).originCity).toBeNull();
  });

  it('collapses whitespace in a real city name', () => {
    expect(
      characterCreateSchema.parse({ ...VALID_CHARACTER, originCity: '  New   York ' }).originCity,
    ).toBe('New York');
  });

  it('rejects a city one character over the limit', () => {
    const result = characterCreateSchema.safeParse({
      ...VALID_CHARACTER,
      originCity: 'a'.repeat(CITY_MAX + 1),
    });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('originCity');
  });

  it('rejects a city with disallowed characters', () => {
    expect(
      characterCreateSchema.safeParse({ ...VALID_CHARACTER, originCity: 'Utrecht<img>' }).success,
    ).toBe(false);
  });
});

describe('characterCreateSchema — origin country', () => {
  it('uppercases a lowercase country code', () => {
    expect(characterCreateSchema.parse({ ...VALID_CHARACTER, originCountry: 'nl' }).originCountry).toBe('NL');
  });

  it('trims surrounding whitespace before matching the allow-list', () => {
    expect(characterCreateSchema.parse({ ...VALID_CHARACTER, originCountry: ' nl ' }).originCountry).toBe(
      'NL',
    );
  });

  it('rejects a code that is not in the allow-list', () => {
    const result = characterCreateSchema.safeParse({ ...VALID_CHARACTER, originCountry: 'ZZ' });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('originCountry');
  });

  it('rejects a country name instead of a code', () => {
    expect(
      characterCreateSchema.safeParse({ ...VALID_CHARACTER, originCountry: 'Netherlands' }).success,
    ).toBe(false);
  });
});

describe('characterCreateSchema — reference ids', () => {
  it.each(['speciesId', 'occupationId', 'personalityId'] as const)(
    'rejects an unknown %s before it can reach a handler',
    (field) => {
      const result = characterCreateSchema.safeParse({ ...VALID_CHARACTER, [field]: 'dragon' });
      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain(field);
    },
  );

  it('reports every invalid field at once so the client can highlight them together', () => {
    const result = characterCreateSchema.safeParse({
      ...VALID_CHARACTER,
      speciesId: 'dragon',
      occupationId: 'wizard',
      nickname: 'x',
    });
    expect(issuePaths(result)).toEqual(expect.arrayContaining(['speciesId', 'occupationId', 'nickname']));
  });
});

describe('characterPatchSchema', () => {
  it('accepts a single-field patch', () => {
    expect(characterPatchSchema.parse({ nickname: 'Squeak' })).toEqual({ nickname: 'Squeak' });
  });

  it('applies the same sanitization as creation', () => {
    expect(characterPatchSchema.parse({ nickname: '  Sir   Reginald  ' }).nickname).toBe('Sir Reginald');
  });

  it('rejects an empty patch', () => {
    const result = characterPatchSchema.safeParse({});
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.message).toMatch(/nothing to update/i);
  });

  it('allows clearing the city with null', () => {
    expect(characterPatchSchema.parse({ originCity: null }).originCity).toBeNull();
  });

  it('does not permit patching immutable fields', () => {
    // speciesId is chosen once at creation; it must not appear in the parsed output
    // even if a client sends it.
    expect(characterPatchSchema.parse({ nickname: 'Squeak', speciesId: 'dog' })).not.toHaveProperty(
      'speciesId',
    );
  });

  it('does not permit patching stats', () => {
    expect(
      characterPatchSchema.parse({ nickname: 'Squeak', stats: { hunger: 100 } }),
    ).not.toHaveProperty('stats');
  });
});
