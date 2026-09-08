import { describe, expect, it, vi } from 'vitest';
import { DuplicateGuard } from '../../src/chat/duplicate-guard.js';
import { MODERATION_FAIL_OPEN, screenMessage } from '../../src/chat/moderation.js';

const CHANNEL = 'channel-1';
const ACCOUNT = 'account-1';

describe('screenMessage', () => {
  it('passes clean text through', async () => {
    await expect(screenMessage('good morning everyone')).resolves.toBe('clean');
  });

  it('blocks high-confidence violations', async () => {
    await expect(screenMessage('you faggot')).resolves.toBe('blocked');
  });

  it('flags borderline content and still delivers it', async () => {
    await expect(screenMessage('that was bullshit')).resolves.toBe('flagged');
  });

  it('fails open to flagged when the classifier throws', async () => {
    const classify = () => {
      throw new Error('provider exploded');
    };
    await expect(screenMessage('hello', { classify })).resolves.toBe(MODERATION_FAIL_OPEN);
  });

  it('fails open to flagged when the classifier rejects', async () => {
    const classify = () => Promise.reject(new Error('provider unavailable'));
    await expect(screenMessage('hello', { classify })).resolves.toBe(MODERATION_FAIL_OPEN);
  });

  /**
   * The one that matters most: a provider that never answers must not hold a send open, and
   * must not silently be recorded as "looked at and fine".
   */
  it('fails open to flagged when the classifier exceeds the deadline', async () => {
    const classify = () => new Promise<'clean'>(() => {});
    const started = Date.now();
    await expect(screenMessage('hello', { classify, timeoutMs: 20 })).resolves.toBe(MODERATION_FAIL_OPEN);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('reports the failure to the caller so a hiccup is observable', async () => {
    const onFailure = vi.fn();
    await screenMessage('hello', { classify: () => Promise.reject(new Error('nope')), onFailure });
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it('does not fail open when the classifier answers inside the deadline', async () => {
    const classify = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 'clean' as const;
    };
    await expect(screenMessage('hello', { classify, timeoutMs: 200 })).resolves.toBe('clean');
  });
});

describe('DuplicateGuard', () => {
  it('allows the first send and rejects an immediate repeat', () => {
    const guard = new DuplicateGuard();
    expect(guard.isRepeat(ACCOUNT, CHANNEL, 'hello')).toBe(false);
    expect(guard.isRepeat(ACCOUNT, CHANNEL, 'hello')).toBe(true);
  });

  it('allows a repeat that is not consecutive', () => {
    const guard = new DuplicateGuard();
    guard.isRepeat(ACCOUNT, CHANNEL, 'hello');
    guard.isRepeat(ACCOUNT, CHANNEL, 'world');
    expect(guard.isRepeat(ACCOUNT, CHANNEL, 'hello')).toBe(false);
  });

  it('allows the same body once the window has passed', () => {
    let now = 0;
    const guard = new DuplicateGuard({ windowMs: 1_000, now: () => now });
    expect(guard.isRepeat(ACCOUNT, CHANNEL, 'hello')).toBe(false);
    now = 1_001;
    expect(guard.isRepeat(ACCOUNT, CHANNEL, 'hello')).toBe(false);
  });

  it('scopes to the account and channel', () => {
    const guard = new DuplicateGuard();
    guard.isRepeat(ACCOUNT, CHANNEL, 'hello');
    expect(guard.isRepeat('account-2', CHANNEL, 'hello')).toBe(false);
    expect(guard.isRepeat(ACCOUNT, 'channel-2', 'hello')).toBe(false);
  });

  it('stays bounded under a flood of distinct keys', () => {
    const guard = new DuplicateGuard({ maxEntries: 50 });
    for (let index = 0; index < 5_000; index += 1) guard.isRepeat(`account-${index}`, CHANNEL, 'hello');
    expect(guard.size()).toBeLessThanOrEqual(50);
  });

  it('keeps the most recent key when evicting', () => {
    const guard = new DuplicateGuard({ maxEntries: 2 });
    guard.isRepeat('a', CHANNEL, 'x');
    guard.isRepeat('b', CHANNEL, 'x');
    guard.isRepeat('c', CHANNEL, 'x');
    expect(guard.isRepeat('c', CHANNEL, 'x')).toBe(true);
    expect(guard.isRepeat('a', CHANNEL, 'x')).toBe(false);
  });
});
