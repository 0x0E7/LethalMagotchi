import type { ChatService } from './chat/service.js';
import type { Config } from './config.js';
import type { DuelService } from './duel/service.js';
import type { RaidService } from './raid/service.js';
import type { Db } from './db/pool.js';
import { RateLimiter, type RateLimiterOptions } from './rate-limit.js';
import type { TournamentService } from './tournament/service.js';
import type { Hub } from './ws/hub.js';

export interface Limiters {
  register: RateLimiter;
  loginByIp: RateLimiter;
  loginByUsername: RateLimiter;
  usernameLookup: RateLimiter;
  playerSearch: RateLimiter;
  characterChurn: RateLimiter;
  actions: RateLimiter;
  wsMessages: RateLimiter;
  wsSource: RateLimiter;
  wsResync: RateLimiter;
  chatBurst: RateLimiter;
  chatSustained: RateLimiter;
  chatDmCreate: RateLimiter;
  duelInvite: RateLimiter;
  duelAction: RateLimiter;
  duelResync: RateLimiter;
  raidCreate: RateLimiter;
  raidAction: RateLimiter;
  raidResync: RateLimiter;
  donation: RateLimiter;
  groupCreate: RateLimiter;
  groupInvite: RateLimiter;
}

export interface ServerDeps {
  config: Config;
  db: Db;
  dummyPasswordHash: string;
  limiters: Limiters;
  hub: Hub;
  tournaments: TournamentService;
  chat: ChatService;
  duels: DuelService;
  raids: RaidService;
}

/** `now` is injectable so a test can assert the *production* numbers, not a copy of them. */
export function createLimiters(now?: () => number): Limiters {
  const limiter = (options: Omit<RateLimiterOptions, 'now'>): RateLimiter =>
    new RateLimiter({ ...options, ...(now ? { now } : {}) });

  return {
    register: limiter({ limit: 5, windowMs: 60 * 60_000 }),
    loginByIp: limiter({ limit: 10, windowMs: 15 * 60_000 }),
    loginByUsername: limiter({ limit: 5, windowMs: 15 * 60_000 }),
    usernameLookup: limiter({ limit: 60, windowMs: 60_000 }),
    // Someone typing a name into the people search issues a request per keystroke-ish; this
    // is comfortable for that and still bounds how fast the directory can be walked.
    playerSearch: limiter({ limit: 30, windowMs: 60_000 }),
    characterChurn: limiter({ limit: 5, windowMs: 24 * 60 * 60_000 }),
    actions: limiter({ limit: 60, windowMs: 60_000 }),
    // Per socket: a turn needs one message, and no honest client sends more than a handful
    // a second. `tourney:resync` gets its own tighter bucket because one of them costs a
    // hand evaluation and four or five outbound frames.
    wsMessages: limiter({ limit: 120, windowMs: 10_000, maxBackoffMs: 60_000 }),
    // Per account, or per address while anonymous: every socket of one source shares this
    // budget, so opening more sockets or reconnecting buys no extra throughput. Its
    // escalation is what a reconnect must not clear, hence the strike decay instead.
    wsSource: limiter({
      limit: 300,
      windowMs: 10_000,
      maxBackoffMs: 15 * 60_000,
      strikeDecayMs: 10 * 60_000,
    }),
    wsResync: limiter({ limit: 10, windowMs: 10_000, maxBackoffMs: 60_000 }),
    // Per account, both charged on every send: the burst bucket is what a human typing fast
    // brushes against, the sustained one is what a script runs into and cannot wait out by
    // spacing its messages just over ten seconds apart.
    //
    // Both decay their strikes. This one is keyed by account and nothing ever resets it the
    // way a socket close resets the connection-keyed buckets, so without a decay a player
    // who types fast once an hour would carry that first strike for the process lifetime and
    // pay a longer mute every time.
    chatBurst: limiter({
      limit: 5,
      windowMs: 10_000,
      maxBackoffMs: 60_000,
      strikeDecayMs: 10 * 60_000,
    }),
    chatSustained: limiter({
      limit: 30,
      windowMs: 60_000,
      maxBackoffMs: 15 * 60_000,
      strikeDecayMs: 10 * 60_000,
    }),
    // Opening conversations is the mass-harassment primitive, not sending into ones that
    // already exist — so only newly created DM channels are charged here.
    chatDmCreate: limiter({ limit: 3, windowMs: 60 * 60_000 }),
    // Issuing a lethal challenge is the harassment primitive here, and an honest player
    // needs very few: a challenge takes a minute to answer and the match itself is over in
    // seconds. Targeted repetition is already bounded by the 24h per-pair decline cooldown,
    // so this bucket only has to stop untargeted spraying.
    duelInvite: limiter({
      limit: 6,
      windowMs: 10 * 60_000,
      maxBackoffMs: 60 * 60_000,
      strikeDecayMs: 30 * 60_000,
    }),
    // Everything else a duel sends: throws, answers, cancels, resyncs. A best-of-3 needs a
    // handful of frames, so this is generous for play and tight against a throw flood —
    // and it is charged before the frame's content is even looked at.
    duelAction: limiter({
      limit: 30,
      windowMs: 10_000,
      maxBackoffMs: 60_000,
      strikeDecayMs: 10 * 60_000,
    }),
    // Its own tighter bucket, for the same reason `tourney:resync` has one: a resync costs
    // several queries and a burst of frames, so it must not be affordable at play rates.
    duelResync: limiter({
      limit: 10,
      windowMs: 10_000,
      maxBackoffMs: 60_000,
      strikeDecayMs: 10 * 60_000,
    }),
    // Starting a raid is the harassment primitive here, and it is a heavier one than a duel
    // invite: the target cannot decline. Targeted repetition is already bounded by the 24h
    // per-target immunity and the 6h per-raider cooldown, so this only has to stop spraying.
    raidCreate: limiter({
      limit: 4,
      windowMs: 10 * 60_000,
      maxBackoffMs: 60 * 60_000,
      strikeDecayMs: 30 * 60_000,
    }),
    // Everything else a raid sends: invites, answers, the lock, betrayals, parity calls.
    raidAction: limiter({
      limit: 30,
      windowMs: 10_000,
      maxBackoffMs: 60_000,
      strikeDecayMs: 10 * 60_000,
    }),
    raidResync: limiter({
      limit: 10,
      windowMs: 10_000,
      maxBackoffMs: 60_000,
      strikeDecayMs: 10 * 60_000,
    }),
    // A donation moves real coins, and a rescued beggar stops being eligible immediately, so
    // an honest donor needs very few of these.
    donation: limiter({ limit: 10, windowMs: 60 * 60_000, maxBackoffMs: 60 * 60_000 }),
    // The 24h create cooldown is the real bound on founding groups — this is only here so a
    // script cannot burn through names faster than a person could type them.
    groupCreate: limiter({ limit: 3, windowMs: 60 * 60_000 }),
    // Any member may invite, so this is the one spam surface groups add: an invitation is a
    // notification a stranger can put in front of you, and it sits there for a week.
    groupInvite: limiter({
      limit: 20,
      windowMs: 60 * 60_000,
      maxBackoffMs: 60 * 60_000,
      strikeDecayMs: 30 * 60_000,
    }),
  };
}
