import { describe, expect, it } from 'vitest';
import { PASSWORD_MAX, PASSWORD_MIN, checkPassword, passwordStrength } from '../src/password.js';

describe('checkPassword', () => {
  it('accepts a long passphrase with no composition rules', () => {
    expect(checkPassword('correct horse battery staple')).toBeNull();
  });

  it('rejects a password one character below the minimum', () => {
    expect(checkPassword('a'.repeat(PASSWORD_MIN - 1))).toBe('length');
  });

  it('accepts a password exactly at the minimum', () => {
    const atMinimum = 'kelp-fores';
    expect(atMinimum).toHaveLength(PASSWORD_MIN);
    expect(checkPassword(atMinimum)).toBeNull();
  });

  it('accepts a password exactly at the maximum', () => {
    expect(checkPassword('b'.repeat(PASSWORD_MAX))).toBeNull();
  });

  it('rejects a password one character above the maximum', () => {
    expect(checkPassword('b'.repeat(PASSWORD_MAX + 1))).toBe('length');
  });

  it('rejects a known common password', () => {
    expect(checkPassword('password123')).toBe('common');
  });

  it('rejects a common password regardless of casing', () => {
    expect(checkPassword('PassWord123')).toBe('common');
  });

  it('rejects a password containing the username', () => {
    expect(checkPassword('otterfan-supersecret', 'otterfan')).toBe('contains_username');
  });

  it('rejects a password containing the username in different casing', () => {
    expect(checkPassword('xxOTTERFANxx-secret', 'OtterFan')).toBe('contains_username');
  });

  it('does not treat a very short username as a substring to ban', () => {
    // A 2-char username would false-positive on almost anything, so the rule
    // only applies from 3 characters up.
    expect(checkPassword('abcdefghijkl', 'ab')).toBeNull();
  });

  it('allows a password that merely shares a prefix with the username', () => {
    expect(checkPassword('otterly-ridiculous', 'otterfan')).toBeNull();
  });

  it('checks length before commonality', () => {
    expect(checkPassword('password')).toBe('length');
  });
});

describe('passwordStrength', () => {
  it('scores anything below the minimum length as 0', () => {
    expect(passwordStrength('short')).toBe(0);
  });

  it('scores a bare minimum-length password as weak', () => {
    expect(passwordStrength('abcdefghij')).toBe(1);
  });

  it('rewards length and character-class variety', () => {
    expect(passwordStrength('Tr0ub4dor&Explosions')).toBe(4);
  });

  it('never scores a known common password above weak, however long', () => {
    expect(passwordStrength('qwerty123456')).toBe(1);
  });

  it('is clamped to a maximum of 4', () => {
    expect(passwordStrength('Xy9!'.repeat(20))).toBe(4);
  });
});
