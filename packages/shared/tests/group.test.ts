import { describe, expect, it } from 'vitest';
import {
  GROUP_CREATE_COOLDOWN_MS,
  GROUP_INVITE_TTL_MS,
  GROUP_KICK_COOLDOWN_MS,
  GROUP_MAX_MEMBERS,
  GROUP_NAME_MAX,
  GROUP_NAME_MIN,
  cooldownEndsAt,
  groupChannelKey,
  groupCreateSchema,
  isCreateCooldownActive,
  isKickCooldownActive,
  isOldEnoughForGroup,
  normalizeGroupName,
} from '../src/group.js';
import { normalizeUsername } from '../src/username.js';

const DAY_MS = 24 * 60 * 60_000;

describe('group name normalization', () => {
  it('folds case, NFKC forms and whitespace to one key', () => {
    expect(normalizeGroupName('Otter Society')).toBe('otter society');
    expect(normalizeGroupName('OTTER SOCIETY')).toBe('otter society');
    expect(normalizeGroupName('  Otter   Society  ')).toBe('otter society');
    // Fullwidth latin folds under NFKC, which is what makes a homoglyph name a duplicate.
    expect(normalizeGroupName('Ｏｔｔｅｒ Society')).toBe('otter society');
  });

  it('uses the same fold the rest of the product does', () => {
    for (const raw of ['Bubbles', 'ＢＵＢＢＬＥＳ', 'bubbles']) {
      expect(normalizeGroupName(raw)).toBe(normalizeUsername(raw));
    }
  });

  it('is idempotent, so a stored key never re-folds to something else', () => {
    const once = normalizeGroupName('  Ｔｈｅ  Otters ');
    expect(normalizeGroupName(once)).toBe(once);
  });

  it('strips invisibles rather than letting them make two names distinct', () => {
    expect(normalizeGroupName('Otter​Society')).toBe('ottersociety');
    expect(normalizeGroupName('Otter\tSociety')).toBe('otter society');
  });
});

describe('the create schema', () => {
  const parse = (name: string) => groupCreateSchema.safeParse({ name });

  it('accepts a plain name and sanitizes it', () => {
    const result = parse('  The   Otters ');
    expect(result.success).toBe(true);
    expect(result.success && result.data.name).toBe('The Otters');
  });

  it('holds the length bounds after sanitizing', () => {
    expect(parse('x'.repeat(GROUP_NAME_MIN - 1)).success).toBe(false);
    expect(parse('x'.repeat(GROUP_NAME_MIN)).success).toBe(true);
    expect(parse('x'.repeat(GROUP_NAME_MAX)).success).toBe(true);
    expect(parse('x'.repeat(GROUP_NAME_MAX + 1)).success).toBe(false);
  });

  it('refuses markup, punctuation soup and an empty name', () => {
    for (const name of ['<script>', 'drop;table', '', '   ', '@@@@']) {
      expect(parse(name).success, name).toBe(false);
    }
  });

  it('allows the same characters a nickname allows', () => {
    for (const name of ["O'Malley's Crew", 'Otter-Society', 'Team 42']) {
      expect(parse(name).success, name).toBe(true);
    }
  });
});

describe('the channel key', () => {
  it('is derived from the group id, which is what makes creation idempotent', () => {
    expect(groupChannelKey('018f-abc')).toBe('group:018f-abc');
  });
});

describe('the age floor and the cooldowns', () => {
  const now = Date.UTC(2026, 0, 10, 12, 0, 0);

  it('opens groups at exactly a day of account age', () => {
    expect(isOldEnoughForGroup(new Date(now - DAY_MS + 1), now)).toBe(false);
    expect(isOldEnoughForGroup(new Date(now - DAY_MS), now)).toBe(true);
    expect(isOldEnoughForGroup(new Date(now - 30 * DAY_MS).toISOString(), now)).toBe(true);
  });

  it('holds a kicked player for a day, to the millisecond', () => {
    expect(isKickCooldownActive(null, now)).toBe(false);
    expect(isKickCooldownActive(new Date(now - 1), now)).toBe(true);
    expect(isKickCooldownActive(new Date(now - GROUP_KICK_COOLDOWN_MS + 1), now)).toBe(true);
    expect(isKickCooldownActive(new Date(now - GROUP_KICK_COOLDOWN_MS), now)).toBe(false);
    expect(isKickCooldownActive(new Date(now - GROUP_KICK_COOLDOWN_MS - 1).toISOString(), now)).toBe(false);
  });

  it('holds a departed player to the same shape of window before founding one', () => {
    expect(isCreateCooldownActive(null, now)).toBe(false);
    expect(isCreateCooldownActive(new Date(now - GROUP_CREATE_COOLDOWN_MS + 1), now)).toBe(true);
    expect(isCreateCooldownActive(new Date(now - GROUP_CREATE_COOLDOWN_MS), now)).toBe(false);
  });

  it('reports when a window ends, so a refusal can say so', () => {
    const at = new Date(now - 6 * 60 * 60_000);
    expect(cooldownEndsAt(at, GROUP_KICK_COOLDOWN_MS).getTime()).toBe(at.getTime() + DAY_MS);
    expect(cooldownEndsAt(at.toISOString(), GROUP_CREATE_COOLDOWN_MS).getTime()).toBe(at.getTime() + DAY_MS);
  });
});

describe('the tunable constants', () => {
  it('are the shipped numbers, read from one place', () => {
    expect(GROUP_MAX_MEMBERS).toBe(30);
    expect(GROUP_INVITE_TTL_MS).toBe(7 * DAY_MS);
    expect(GROUP_KICK_COOLDOWN_MS).toBe(DAY_MS);
    expect(GROUP_CREATE_COOLDOWN_MS).toBe(DAY_MS);
  });
});
