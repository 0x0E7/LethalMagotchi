import { beforeEach, describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/rate-limit.js';

/** Drives the limiter's injectable clock so backoff/expiry need no real sleeping. */
function fakeClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('RateLimiter — window accounting', () => {
  let clock: ReturnType<typeof fakeClock>;
  let limiter: RateLimiter;

  beforeEach(() => {
    clock = fakeClock();
    limiter = new RateLimiter({ limit: 3, windowMs: 60_000, now: clock.now });
  });

  it('allows exactly `limit` attempts inside one window', () => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(limiter.check('ip')).toEqual({ allowed: true, retryAfterSeconds: 0 });
    }
  });

  it('blocks the attempt after the limit is reached', () => {
    for (let attempt = 0; attempt < 3; attempt += 1) limiter.check('ip');
    expect(limiter.check('ip').allowed).toBe(false);
  });

  it('reports a retry-after that a client can actually wait on', () => {
    for (let attempt = 0; attempt < 3; attempt += 1) limiter.check('ip');
    expect(limiter.check('ip').retryAfterSeconds).toBeGreaterThan(0);
  });

  it('keys separately, so one caller cannot lock another out', () => {
    for (let attempt = 0; attempt < 3; attempt += 1) limiter.check('ip-a');
    expect(limiter.check('ip-a').allowed).toBe(false);
    expect(limiter.check('ip-b').allowed).toBe(true);
  });

  it('starts a fresh window once the old one has fully elapsed', () => {
    for (let attempt = 0; attempt < 3; attempt += 1) limiter.check('ip');
    clock.advance(60_000);
    expect(limiter.check('ip').allowed).toBe(true);
  });

  it('does not reset the window early', () => {
    for (let attempt = 0; attempt < 3; attempt += 1) limiter.check('ip');
    clock.advance(59_999);
    expect(limiter.check('ip').allowed).toBe(false);
  });
});

describe('RateLimiter — exponential backoff', () => {
  it('doubles the block duration on each successive strike', () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ limit: 1, windowMs: 1_000, now: clock.now });

    limiter.check('ip'); // consumes the single allowance
    const first = limiter.check('ip');
    expect(first.retryAfterSeconds).toBe(1);

    clock.advance(1_000); // wait out the block, but stay inside a fresh strike streak
    limiter.check('ip');
    const second = limiter.check('ip');
    expect(second.retryAfterSeconds).toBe(2);

    clock.advance(2_000);
    limiter.check('ip');
    const third = limiter.check('ip');
    expect(third.retryAfterSeconds).toBe(4);
  });

  it('caps backoff at maxBackoffMs rather than growing without bound', () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ limit: 1, windowMs: 1_000, maxBackoffMs: 5_000, now: clock.now });

    for (let round = 0; round < 12; round += 1) {
      limiter.check('ip');
      const blocked = limiter.check('ip');
      expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(5);
      clock.advance(blocked.retryAfterSeconds * 1000);
    }
  });

  it('never locks a key out permanently — the block always expires', () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ limit: 1, windowMs: 1_000, maxBackoffMs: 5_000, now: clock.now });

    for (let round = 0; round < 20; round += 1) {
      limiter.check('victim');
      limiter.check('victim');
    }
    clock.advance(5_001);
    expect(limiter.check('victim').allowed).toBe(true);
  });

  it('counts down the retry-after as the block elapses', () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ limit: 1, windowMs: 10_000, now: clock.now });

    limiter.check('ip');
    expect(limiter.check('ip').retryAfterSeconds).toBe(10);
    clock.advance(4_000);
    expect(limiter.check('ip').retryAfterSeconds).toBe(6);
  });
});

describe('RateLimiter — reset', () => {
  it('clears a single key without touching the others', () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000, now: clock.now });
    limiter.check('a');
    limiter.check('b');

    limiter.reset('a');

    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('b').allowed).toBe(false);
  });

  it('clears every key when called with no argument', () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000, now: clock.now });
    limiter.check('a');
    limiter.check('b');

    limiter.reset();

    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('b').allowed).toBe(true);
  });
});

describe('RateLimiter — production limits from deps.ts', () => {
  it('permits 5 registrations per hour per IP and blocks the 6th', () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ limit: 5, windowMs: 60 * 60_000, now: clock.now });
    for (let attempt = 0; attempt < 5; attempt += 1) expect(limiter.check('1.2.3.4').allowed).toBe(true);
    expect(limiter.check('1.2.3.4').allowed).toBe(false);
  });

  it('permits 5 create/delete cycles per account per day and blocks the 6th', () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ limit: 5, windowMs: 24 * 60 * 60_000, now: clock.now });
    for (let attempt = 0; attempt < 5; attempt += 1) expect(limiter.check('account').allowed).toBe(true);
    expect(limiter.check('account').allowed).toBe(false);

    clock.advance(24 * 60 * 60_000);
    expect(limiter.check('account').allowed).toBe(true);
  });
});
