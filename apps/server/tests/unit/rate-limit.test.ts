import { beforeEach, describe, expect, it } from 'vitest';
import { createLimiters } from '../../src/deps.js';
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

describe('RateLimiter — strike decay', () => {
  it('keeps escalating while the abuse continues', () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ limit: 1, windowMs: 1_000, strikeDecayMs: 60_000, now: clock.now });

    limiter.check('ip');
    expect(limiter.check('ip').retryAfterSeconds).toBe(1);
    clock.advance(1_000);
    limiter.check('ip');
    expect(limiter.check('ip').retryAfterSeconds).toBe(2);
  });

  it('forgives strikes only after the key has gone quiet', () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ limit: 1, windowMs: 1_000, strikeDecayMs: 60_000, now: clock.now });

    limiter.check('ip');
    expect(limiter.check('ip').retryAfterSeconds).toBe(1);

    clock.advance(60_000);
    limiter.check('ip');
    // Back to a first-offence block rather than the doubled one.
    expect(limiter.check('ip').retryAfterSeconds).toBe(1);
  });

  it('does not let a flooder idle out its own escalation by hammering through the block', () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ limit: 1, windowMs: 1_000, strikeDecayMs: 5_000, now: clock.now });

    limiter.check('ip');
    limiter.check('ip');
    // Eight seconds of steady hammering — well past the five-second decay, but never quiet.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      clock.advance(400);
      limiter.check('ip');
    }
    limiter.check('ip');
    expect(limiter.check('ip').retryAfterSeconds).toBeGreaterThan(1);
  });
});

/**
 * The sweep that keeps the map bounded used to delete any entry whose block had expired —
 * but an entry *is* its strike history, so on a busy server (the sweep only runs from a
 * thousand keys up) every patient attacker was handed a first-offence backoff forever.
 */
describe('RateLimiter — strike history vs. the cleanup sweep', () => {
  /** Flood, wait out exactly the block, repeat. Returns the backoff each round earned. */
  function backoffPerOffence(limiter: RateLimiter, clock: ReturnType<typeof fakeClock>, rounds: number): number[] {
    const seen: number[] = [];
    for (let round = 0; round < rounds; round += 1) {
      limiter.check('attacker');
      const blocked = limiter.check('attacker');
      seen.push(blocked.retryAfterSeconds);
      clock.advance(blocked.retryAfterSeconds * 1000);
    }
    return seen;
  }

  const escalating = (clock: ReturnType<typeof fakeClock>) =>
    new RateLimiter({
      limit: 1,
      windowMs: 10_000,
      maxBackoffMs: 15 * 60_000,
      strikeDecayMs: 10 * 60_000,
      now: clock.now,
    });

  it('escalates on a quiet server', () => {
    const clock = fakeClock();
    expect(backoffPerOffence(escalating(clock), clock, 5)).toEqual([10, 20, 40, 80, 160]);
  });

  it('escalates identically on a busy one, past the sweep threshold', () => {
    const clock = fakeClock();
    const limiter = escalating(clock);
    for (let key = 0; key < 1_200; key += 1) limiter.check(`legit-${key}`);

    expect(backoffPerOffence(limiter, clock, 5)).toEqual([10, 20, 40, 80, 160]);
  });

  it('still forgets the keys it is safe to forget', () => {
    const clock = fakeClock();
    const limiter = escalating(clock);
    for (let key = 0; key < 1_200; key += 1) limiter.check(`legit-${key}`);
    expect(limiter.size()).toBe(1_200);

    // Long past both the window and the strike decay, and none of them ever offended.
    clock.advance(11 * 60_000);
    limiter.check('anyone');

    expect(limiter.size()).toBe(1);
  });

  it('keeps a striked key through a sweep and drops it once its strikes have decayed', () => {
    const clock = fakeClock();
    const limiter = escalating(clock);
    limiter.check('attacker');
    limiter.check('attacker');
    for (let key = 0; key < 1_200; key += 1) limiter.check(`legit-${key}`);

    clock.advance(60_000);
    limiter.check('sweep-trigger');
    expect(limiter.size()).toBeGreaterThan(1);
    // Survived the sweep with its history intact: this is a second offence, not a first.
    limiter.check('attacker');
    expect(limiter.check('attacker').retryAfterSeconds).toBe(20);

    clock.advance(10 * 60_000);
    limiter.check('sweep-trigger');
    expect(limiter.check('attacker').allowed).toBe(true);
  });

  it('bounds the map even for a limiter whose strikes never decay', () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ limit: 1, windowMs: 1_000, maxEntries: 2_000, now: clock.now });
    for (let key = 0; key < 5_000; key += 1) {
      limiter.check(`abuser-${key}`);
      limiter.check(`abuser-${key}`);
      clock.advance(10);
    }
    clock.advance(60_000);
    limiter.check('sweep-trigger');

    expect(limiter.size()).toBeLessThanOrEqual(2_001);
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

  /**
   * Built from `createLimiters` rather than from a copy of its numbers: the bug here was a
   * missing option in the production configuration, which a test that restates the settings
   * cannot see.
   *
   * `chatBurst` is keyed by account, and nothing ever resets it the way a socket close resets
   * the connection-keyed buckets — so without a decay, one fast-typing episode is paid for
   * forever, at a longer mute each time.
   */
  it('forgives a chat burst once the account has gone quiet, and only then', () => {
    const clock = fakeClock();
    const { chatBurst } = createLimiters(clock.now);
    const spendTheAllowance = (): void => {
      for (let message = 0; message < 5; message += 1) chatBurst.check('account');
    };

    spendTheAllowance();
    expect(chatBurst.check('account').retryAfterSeconds).toBe(10);

    // Straight back into it: still the same episode, so the mute doubles.
    clock.advance(10_000);
    spendTheAllowance();
    expect(chatBurst.check('account').retryAfterSeconds).toBe(20);

    // An hour of ordinary silence, then another honest flurry: a first offence again.
    clock.advance(60 * 60_000);
    spendTheAllowance();
    expect(chatBurst.check('account').retryAfterSeconds).toBe(10);
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
