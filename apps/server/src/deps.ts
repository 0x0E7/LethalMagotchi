import type { Config } from './config.js';
import type { Db } from './db/pool.js';
import { RateLimiter } from './rate-limit.js';

export interface Limiters {
  register: RateLimiter;
  loginByIp: RateLimiter;
  loginByUsername: RateLimiter;
  usernameLookup: RateLimiter;
  characterChurn: RateLimiter;
}

export interface ServerDeps {
  config: Config;
  db: Db;
  dummyPasswordHash: string;
  limiters: Limiters;
}

export function createLimiters(): Limiters {
  return {
    register: new RateLimiter({ limit: 5, windowMs: 60 * 60_000 }),
    loginByIp: new RateLimiter({ limit: 10, windowMs: 15 * 60_000 }),
    loginByUsername: new RateLimiter({ limit: 5, windowMs: 15 * 60_000 }),
    usernameLookup: new RateLimiter({ limit: 60, windowMs: 60_000 }),
    characterChurn: new RateLimiter({ limit: 5, windowMs: 24 * 60 * 60_000 }),
  };
}
