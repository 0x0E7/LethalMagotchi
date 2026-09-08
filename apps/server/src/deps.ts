import type { Config } from './config.js';
import type { Db } from './db/pool.js';
import { RateLimiter } from './rate-limit.js';
import type { TournamentService } from './tournament/service.js';
import type { Hub } from './ws/hub.js';

export interface Limiters {
  register: RateLimiter;
  loginByIp: RateLimiter;
  loginByUsername: RateLimiter;
  usernameLookup: RateLimiter;
  characterChurn: RateLimiter;
  actions: RateLimiter;
  wsMessages: RateLimiter;
  wsSource: RateLimiter;
  wsResync: RateLimiter;
}

export interface ServerDeps {
  config: Config;
  db: Db;
  dummyPasswordHash: string;
  limiters: Limiters;
  hub: Hub;
  tournaments: TournamentService;
}

export function createLimiters(): Limiters {
  return {
    register: new RateLimiter({ limit: 5, windowMs: 60 * 60_000 }),
    loginByIp: new RateLimiter({ limit: 10, windowMs: 15 * 60_000 }),
    loginByUsername: new RateLimiter({ limit: 5, windowMs: 15 * 60_000 }),
    usernameLookup: new RateLimiter({ limit: 60, windowMs: 60_000 }),
    characterChurn: new RateLimiter({ limit: 5, windowMs: 24 * 60 * 60_000 }),
    actions: new RateLimiter({ limit: 60, windowMs: 60_000 }),
    // Per socket: a turn needs one message, and no honest client sends more than a handful
    // a second. `tourney:resync` gets its own tighter bucket because one of them costs a
    // hand evaluation and four or five outbound frames.
    wsMessages: new RateLimiter({ limit: 120, windowMs: 10_000, maxBackoffMs: 60_000 }),
    // Per account, or per address while anonymous: every socket of one source shares this
    // budget, so opening more sockets or reconnecting buys no extra throughput. Its
    // escalation is what a reconnect must not clear, hence the strike decay instead.
    wsSource: new RateLimiter({
      limit: 300,
      windowMs: 10_000,
      maxBackoffMs: 15 * 60_000,
      strikeDecayMs: 10 * 60_000,
    }),
    wsResync: new RateLimiter({ limit: 10, windowMs: 10_000, maxBackoffMs: 60_000 }),
  };
}
