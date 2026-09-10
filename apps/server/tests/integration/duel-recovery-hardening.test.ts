import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { STARTING_LETHAL_COINS, type DuelThrow } from '@lethalmagotchi/shared';
import { ChatService } from '../../src/chat/service.js';
import type { Clock, Timer } from '../../src/tournament/clock.js';
import type { Db, DbClient } from '../../src/db/pool.js';
import { DuelService } from '../../src/duel/service.js';
import { abortDuelIfActive, claimDuelSettlement } from '../../src/repos/duels.js';
import { Hub } from '../../src/ws/hub.js';
import {
  authed,
  closeTestPool,
  createTestApp,
  registerAccount,
  relaxedLimiters,
  testPool,
  uniqueUsername,
  VALID_CHARACTER,
  type TestAccount,
} from '../helpers/app.js';
import { TestClient, closeAll } from '../helpers/ws.js';

interface Player extends TestAccount {
  characterId: string;
  nickname: string;
}

let db: Db;

beforeAll(() => {
  db = testPool();
});

afterAll(async () => {
  await closeTestPool();
});

/**
 * A pool whose transactions fail on one specific statement, so a settlement can be made to
 * throw exactly where QA's repro says it hurts.
 */
function poolFailingOn(pool: Db, match: RegExp, failures = Number.POSITIVE_INFINITY): Db {
  let remaining = failures;
  const bind = (target: object, prop: string | symbol): unknown => {
    const value = Reflect.get(target, prop);
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
  };

  return new Proxy(pool, {
    get(target, prop) {
      if (prop !== 'connect') return bind(target, prop);
      return async (): Promise<DbClient> => {
        const client = await target.connect();
        return new Proxy(client, {
          get(clientTarget, clientProp) {
            if (clientProp !== 'query') return bind(clientTarget, clientProp);
            return (text: unknown, values?: unknown[]) => {
              if (typeof text === 'string' && match.test(text) && remaining > 0) {
                remaining -= 1;
                return Promise.reject(new Error('injected settlement failure'));
              }
              return (clientTarget.query as (t: unknown, v?: unknown[]) => unknown)(text, values);
            };
          },
        }) as DbClient;
      };
    },
  }) as Db;
}

/**
 * The settlement commits for real and then loses the reply, the way a connection dropped
 * between `COMMIT` and its acknowledgment does — plus a nominated number of read-back
 * failures on top, since a failover poisons several pool connections at once.
 */
function poolLosingSettlementCommitAck(
  pool: Db,
  readBack: { match: RegExp; failures?: number } | null = null,
): Db {
  let remaining = 1;
  let lost = 0;
  let readBackRemaining = readBack?.failures ?? 1;
  const bind = (target: object, prop: string | symbol): unknown => {
    const value = Reflect.get(target, prop);
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
  };

  const failsReadBack = (text: unknown): boolean => {
    if (!readBack || lost === 0 || readBackRemaining <= 0) return false;
    if (typeof text !== 'string' || !readBack.match.test(text)) return false;
    readBackRemaining -= 1;
    return true;
  };

  return new Proxy(pool, {
    get(target, prop) {
      if (prop === 'query') {
        const query = (target.query as (t: unknown, v?: unknown[]) => Promise<unknown>).bind(target);
        return (text: unknown, values?: unknown[]) =>
          failsReadBack(text) ? Promise.reject(new Error('injected read-back failure')) : query(text, values);
      }
      if (prop !== 'connect') return bind(target, prop);
      return async (): Promise<DbClient> => {
        const client = await target.connect();
        let settling = false;
        return new Proxy(client, {
          get(clientTarget, clientProp) {
            if (clientProp !== 'query') return bind(clientTarget, clientProp);
            const query = (clientTarget.query as (t: unknown, v?: unknown[]) => Promise<unknown>).bind(
              clientTarget,
            );
            return async (text: unknown, values?: unknown[]) => {
              if (typeof text === 'string' && /UPDATE duels SET coins_transferred/.test(text)) {
                settling = true;
              }
              if (settling && text === 'COMMIT' && remaining > 0) {
                remaining -= 1;
                await query(text, values);
                lost += 1;
                throw new Error('lost COMMIT acknowledgment');
              }
              if (failsReadBack(text)) throw new Error('injected read-back failure');
              return query(text, values);
            };
          },
        }) as DbClient;
      };
    },
  }) as Db;
}

interface Captured {
  delayMs: number;
  run: () => void;
  cancelled: boolean;
  fired: boolean;
}

/**
 * The real clock for everything a duel needs to actually play, with the settlement-recovery
 * ladder's own delays intercepted instead of scheduled. That is what lets a recovery pass be
 * fired *by hand* at a chosen instant — after `stop()`, or not at all — rather than raced
 * against with a `setTimeout` and a hope.
 */
function capturingClock(recoveryDelays: number[]): { clock: Clock; captured: Captured[] } {
  const wanted = new Set(recoveryDelays);
  const captured: Captured[] = [];
  return {
    captured,
    clock: {
      now: () => Date.now(),
      after: (ms, run) => {
        if (!wanted.has(ms)) {
          const handle = setTimeout(run, ms);
          handle.unref?.();
          return { cancel: () => clearTimeout(handle) };
        }
        const entry: Captured = {
          delayMs: ms,
          cancelled: false,
          fired: false,
          run: () => {
            if (entry.cancelled) return;
            entry.fired = true;
            run();
          },
        };
        captured.push(entry);
        const timer: Timer = {
          cancel: () => {
            entry.cancelled = true;
          },
        };
        return timer;
      },
    },
  };
}

async function waitUntil(condition: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Booted {
  app: FastifyInstance;
  baseUrl: string;
  duels: DuelService;
  hub: Hub;
  close: () => Promise<void>;
}

async function boot(
  options: {
    db?: Db;
    log?: (message: string) => void;
    recoveryDelaysMs?: number[];
    clock?: Clock;
    start?: boolean;
  } = {},
): Promise<Booted> {
  const pool = testPool();
  const hub = new Hub();
  const limiters = relaxedLimiters();
  const chat = new ChatService({ db: pool, hub, limiters });
  const duels = new DuelService({
    db: options.db ?? pool,
    hub,
    chat,
    limiters,
    revealMs: 20,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.recoveryDelaysMs ? { settlementRecoveryDelaysMs: options.recoveryDelaysMs } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  const { app } = await createTestApp({ hub, chat, duels, limiters });
  await app.listen({ port: 0, host: '127.0.0.1' });
  if (options.start) await duels.start();
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    app,
    duels,
    hub,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await duels.stop();
      await app.close();
    },
  };
}

async function makePlayer(
  app: FastifyInstance,
  nickname: string,
  options: { coins?: number } = {},
): Promise<Player> {
  const account = await registerAccount(app, { username: uniqueUsername('dh') });
  const response = await app.inject(
    authed(account, { method: 'POST', url: '/api/v1/characters', payload: { ...VALID_CHARACTER, nickname } }),
  );
  expect(response.statusCode, response.body).toBe(201);
  const characterId = response.json().character.id as string;
  await db.query(`UPDATE characters SET created_at = now() - interval '48 hours' WHERE id = $1`, [
    characterId,
  ]);
  if (options.coins !== undefined) {
    await db.query('UPDATE characters SET lethal_coins = $2 WHERE id = $1', [characterId, options.coins]);
  }
  return { ...account, characterId, nickname };
}

async function characterRow(characterId: string): Promise<{
  lethal_coins: number;
  active_duel_id: string | null;
  rebirth_count: number;
}> {
  const result = await db.query<{
    lethal_coins: number;
    active_duel_id: string | null;
    rebirth_count: number;
  }>('SELECT lethal_coins, active_duel_id, rebirth_count FROM characters WHERE id = $1', [characterId]);
  return result.rows[0]!;
}

async function duelRow(duelId: string): Promise<{
  state: string;
  outcome: string | null;
  coins_transferred: number | null;
}> {
  const result = await db.query<{ state: string; outcome: string | null; coins_transferred: number | null }>(
    'SELECT state, outcome, coins_transferred FROM duels WHERE id = $1',
    [duelId],
  );
  return result.rows[0]!;
}

async function startDuel(
  challenger: TestClient,
  opponent: TestClient,
  targetCharacterId: string,
): Promise<{ duelId: string }> {
  challenger.send({ type: 'duel:invite', targetCharacterId });
  const invited = await opponent.next('duel:invited');
  opponent.send({ type: 'duel:respond', inviteId: invited.inviteId, accept: true });
  const start = await challenger.next('duel:start');
  await opponent.next('duel:start');
  return { duelId: start.duelId };
}

async function playRound(
  challenger: TestClient,
  opponent: TestClient,
  duelId: string,
  challengerThrow: DuelThrow,
  opponentThrow: DuelThrow,
): Promise<void> {
  const forChallenger = await challenger.next('duel:round', (message) => message.duelId === duelId);
  const forOpponent = await opponent.next('duel:round', (message) => message.duelId === duelId);
  challenger.send({
    type: 'duel:throw',
    duelId,
    round: forChallenger.round,
    replay: forChallenger.replay,
    seq: forChallenger.seq,
    throw: challengerThrow,
  });
  opponent.send({
    type: 'duel:throw',
    duelId,
    round: forOpponent.round,
    replay: forOpponent.replay,
    seq: forOpponent.seq,
    throw: opponentThrow,
  });
  await challenger.next('duel:round_result', (message) => message.seq === forChallenger.seq);
  await opponent.next('duel:round_result', (message) => message.seq === forOpponent.seq);
}

/** The private recovery-timer map, read for what it is: a leak surface on a long-lived server. */
function recoveryTimerCount(duels: DuelService): number {
  return (duels as unknown as { recoveryTimers: Map<string, unknown> }).recoveryTimers.size;
}

/** The other per-duel map a long-lived server accumulates in: the serialization chains. */
function chainCount(duels: DuelService): number {
  return (duels as unknown as { chains: Map<string, unknown> }).chains.size;
}

const RECOVERY_LADDER = [101, 202, 303];

/**
 * QA round 5, new 14 hardening. The recovery ladder is the only thing standing between an
 * unreadable settlement and two players locked out of the game, so it is attacked directly:
 * shut down under it, restarted out from under it, and denied even the fallback write.
 */
describe('the settlement recovery machinery under shutdown', () => {
  it('cancels a pending recovery pass on stop, and a pass fired anyway is a no-op', async () => {
    const pool = testPool();
    // Exactly the four failures the settlement itself spends — two attempts, then two
    // read-backs — so the database is *healthy again* by the time the post-stop pass fires.
    // A pass that ignored the shutdown would settle a real death into a stopped service.
    const poisoned = poolFailingOn(
      pool,
      /UPDATE duels SET coins_transferred|SELECT \* FROM duels WHERE id = \$1$/,
      4,
    );
    const { clock, captured } = capturingClock(RECOVERY_LADDER);
    const logged: string[] = [];
    const booted = await boot({
      db: poisoned,
      clock,
      log: (message) => logged.push(message),
      recoveryDelaysMs: RECOVERY_LADDER,
    });
    const clients: TestClient[] = [];
    const rejections: unknown[] = [];
    const onRejection = (error: unknown): void => {
      rejections.push(error);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const winner = await makePlayer(booted.app, 'Stopwin', { coins: 120 });
      const loser = await makePlayer(booted.app, 'Stoplose', { coins: 40 });

      const a = await TestClient.connect(booted.baseUrl, winner.accessToken);
      const b = await TestClient.connect(booted.baseUrl, loser.accessToken);
      clients.push(a, b);

      const { duelId } = await startDuel(a, b, loser.characterId);
      await playRound(a, b, duelId, 'rock', 'scissors');
      await playRound(a, b, duelId, 'paper', 'rock');

      // The settlement gave up and handed the duel to the ladder: one pass armed, not fired.
      await waitUntil(() => captured.length === 1);
      expect(logged).toContain('duel settlement outcome undetermined; retrying');
      expect(recoveryTimerCount(booted.duels)).toBe(1);

      await booted.duels.stop();

      // Cancelled, and dropped from the map, so a stopped service holds no duel state.
      expect(captured[0]!.cancelled).toBe(true);
      expect(recoveryTimerCount(booted.duels)).toBe(0);

      // A timer that had already been handed to the event loop when stop ran fires anyway.
      // It must not build a runner, touch the duel, or reject into the process.
      captured[0]!.cancelled = false;
      captured[0]!.run();
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(rejections).toEqual([]);
      expect(a.received('duel:end')).toHaveLength(0);
      expect(b.received('duel:end')).toHaveLength(0);
      // Left exactly as the shutdown found it, for the next boot's sweep to settle.
      expect(await duelRow(duelId)).toMatchObject({ state: 'active' });
      expect(captured).toHaveLength(1);
    } finally {
      process.off('unhandledRejection', onRejection);
      await closeAll(clients);
      await booted.app.close();
    }
  });

  it('lets the next boot sweep free a duel whose recovery timer died with the process', async () => {
    const pool = testPool();
    const poisoned = poolFailingOn(
      pool,
      /UPDATE duels SET coins_transferred|SELECT \* FROM duels WHERE id = \$1$/,
    );
    const { clock, captured } = capturingClock(RECOVERY_LADDER);
    const first = await boot({ db: poisoned, clock, recoveryDelaysMs: RECOVERY_LADDER });
    const clients: TestClient[] = [];
    let second: Booted | null = null;
    try {
      const winner = await makePlayer(first.app, 'Rebootwin', { coins: 120 });
      const loser = await makePlayer(first.app, 'Rebootlose', { coins: 40 });

      const a = await TestClient.connect(first.baseUrl, winner.accessToken);
      const b = await TestClient.connect(first.baseUrl, loser.accessToken);
      clients.push(a, b);

      const { duelId } = await startDuel(a, b, loser.characterId);
      await playRound(a, b, duelId, 'rock', 'scissors');
      await playRound(a, b, duelId, 'paper', 'rock');
      await waitUntil(() => captured.length === 1);

      // The process dies with the pass still pending: locks held, duel still active.
      await first.close();
      expect(await duelRow(duelId)).toMatchObject({ state: 'active' });
      expect((await characterRow(winner.characterId)).active_duel_id).toBe(duelId);

      // The restart is the backstop the ladder is not: the sweep finds it and frees both.
      second = await boot({ start: true });
      expect(await duelRow(duelId)).toMatchObject({ state: 'aborted', outcome: 'abort' });
      expect(await characterRow(winner.characterId)).toMatchObject({
        lethal_coins: 120,
        active_duel_id: null,
        rebirth_count: 0,
      });
      expect(await characterRow(loser.characterId)).toMatchObject({
        lethal_coins: 40,
        active_duel_id: null,
        rebirth_count: 0,
      });

      for (const player of [winner, loser]) {
        const response = await second.app.inject(
          authed(player, {
            method: 'POST',
            url: '/api/v1/characters/me/actions/feed',
            payload: { itemId: 'kibble' },
          }),
        );
        expect(response.statusCode, response.body).toBe(200);
      }
    } finally {
      await closeAll(clients);
      if (second) await second.close();
    }
  });

  it('never lets a boot sweep touch a duel that committed a death', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    let second: Booted | null = null;
    try {
      const winner = await makePlayer(booted.app, 'Sweepsafe', { coins: 120 });
      const loser = await makePlayer(booted.app, 'Sweepdead', { coins: 40 });

      const a = await TestClient.connect(booted.baseUrl, winner.accessToken);
      const b = await TestClient.connect(booted.baseUrl, loser.accessToken);
      clients.push(a, b);

      const { duelId } = await startDuel(a, b, loser.characterId);
      await playRound(a, b, duelId, 'rock', 'scissors');
      await playRound(a, b, duelId, 'paper', 'rock');
      await a.next('duel:end');
      await b.next('duel:end');
      await booted.close();

      second = await boot({ start: true });
      // A settled death is `complete`, so the sweep's `state = 'active'` predicate misses it.
      expect(await duelRow(duelId)).toMatchObject({
        state: 'complete',
        outcome: 'death',
        coins_transferred: 40,
      });
      expect(await characterRow(winner.characterId)).toMatchObject({ lethal_coins: 160 });
      expect(await characterRow(loser.characterId)).toMatchObject({
        lethal_coins: STARTING_LETHAL_COINS,
        rebirth_count: 1,
      });
    } finally {
      await closeAll(clients);
      if (second) await second.close();
    }
  });
});

describe('the settlement recovery machinery when even the fallback abort cannot be written', () => {
  it('re-arms at the ladder floor, one timer at a time, without fanning out or leaking', async () => {
    const pool = testPool();
    // Nothing about this duel can be written or read: the settlement, the read-back and the
    // conditional abort all fail, forever. The ladder has nothing left but to keep asking.
    const poisoned = poolFailingOn(
      pool,
      /UPDATE duels SET coins_transferred|SELECT \* FROM duels WHERE id = \$1$|UPDATE duels\s+SET state = 'aborted'/,
    );
    const { clock, captured } = capturingClock(RECOVERY_LADDER);
    const logged: string[] = [];
    const booted = await boot({
      db: poisoned,
      clock,
      log: (message) => logged.push(message),
      recoveryDelaysMs: RECOVERY_LADDER,
    });
    const clients: TestClient[] = [];
    try {
      const winner = await makePlayer(booted.app, 'Floorwin', { coins: 120 });
      const loser = await makePlayer(booted.app, 'Floorlose', { coins: 40 });

      const a = await TestClient.connect(booted.baseUrl, winner.accessToken);
      const b = await TestClient.connect(booted.baseUrl, loser.accessToken);
      clients.push(a, b);

      const { duelId } = await startDuel(a, b, loser.characterId);
      await playRound(a, b, duelId, 'rock', 'scissors');
      await playRound(a, b, duelId, 'paper', 'rock');
      await waitUntil(() => captured.length === 1);

      // Walk six passes by hand. Each one must arm exactly one successor, never two.
      for (let pass = 0; pass < 6; pass += 1) {
        expect(recoveryTimerCount(booted.duels)).toBe(1);
        captured[pass]!.run();
        await waitUntil(() => captured.length === pass + 2);
      }

      // Linear, not exponential: one pass in, one pass out.
      expect(captured).toHaveLength(7);
      expect(recoveryTimerCount(booted.duels)).toBe(1);
      // Seven passes through `serialize` leave no chains behind either — the two per-duel
      // maps are what a server blipping all week would otherwise accumulate in.
      expect(chainCount(booted.duels)).toBe(0);
      // The ladder is walked once and then held at its last step forever.
      expect(captured.map((entry) => entry.delayMs)).toEqual([101, 202, 303, 303, 303, 303, 303]);
      // It really is the un-writable fallback keeping this alive, not a silent success.
      expect(logged).toContain('duel settlement fallback abort attempt failed');
      // Still nothing claimed to either client while nothing can be established.
      expect(a.received('duel:end')).toHaveLength(0);
      expect(b.received('duel:end')).toHaveLength(0);

      // And the moment the database comes back, the pending pass ends it for real.
      const healthy = await boot({ start: true });
      try {
        expect(await duelRow(duelId)).toMatchObject({ state: 'aborted', outcome: 'abort' });
        expect(await characterRow(winner.characterId)).toMatchObject({
          lethal_coins: 120,
          active_duel_id: null,
          rebirth_count: 0,
        });
        expect(await characterRow(loser.characterId)).toMatchObject({
          lethal_coins: 40,
          active_duel_id: null,
          rebirth_count: 0,
        });
      } finally {
        await healthy.close();
      }
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('leaves no recovery timer behind once a pass finally settles the duel', async () => {
    const pool = testPool();
    const poisoned = poolFailingOn(
      pool,
      /UPDATE duels SET coins_transferred|SELECT \* FROM duels WHERE id = \$1$/,
      4,
    );
    const { clock, captured } = capturingClock(RECOVERY_LADDER);
    const booted = await boot({ db: poisoned, clock, recoveryDelaysMs: RECOVERY_LADDER });
    const clients: TestClient[] = [];
    try {
      const winner = await makePlayer(booted.app, 'Clearwin', { coins: 120 });
      const loser = await makePlayer(booted.app, 'Clearlose', { coins: 40 });

      const a = await TestClient.connect(booted.baseUrl, winner.accessToken);
      const b = await TestClient.connect(booted.baseUrl, loser.accessToken);
      clients.push(a, b);

      const { duelId } = await startDuel(a, b, loser.characterId);
      await playRound(a, b, duelId, 'rock', 'scissors');
      await playRound(a, b, duelId, 'paper', 'rock');

      await waitUntil(() => captured.length === 1);
      expect(recoveryTimerCount(booted.duels)).toBe(1);

      captured[0]!.run();
      await a.next('duel:end');
      await b.next('duel:end');
      await new Promise((resolve) => setTimeout(resolve, 100));

      // The map is the leak surface: one entry per duel, removed the moment it fires.
      expect(recoveryTimerCount(booted.duels)).toBe(0);
      expect(chainCount(booted.duels)).toBe(0);
      expect(captured).toHaveLength(1);
      expect(await duelRow(duelId)).toMatchObject({ state: 'complete', outcome: 'death' });
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

describe('a recovery pass that lands after the loser has reconnected', () => {
  it('sends the rebirth and the payout to the sockets the players are actually on now', async () => {
    const pool = testPool();
    // The death commits; only the acknowledgment and the first read-backs are lost.
    const poisoned = poolLosingSettlementCommitAck(pool, {
      match: /SELECT \* FROM duels WHERE id = \$1$/,
      failures: 2,
    });
    const { clock, captured } = capturingClock(RECOVERY_LADDER);
    const booted = await boot({ db: poisoned, clock, recoveryDelaysMs: RECOVERY_LADDER });
    const clients: TestClient[] = [];
    try {
      const winner = await makePlayer(booted.app, 'Backwin', { coins: 120 });
      const loser = await makePlayer(booted.app, 'Backlose', { coins: 40 });

      const a = await TestClient.connect(booted.baseUrl, winner.accessToken);
      const b = await TestClient.connect(booted.baseUrl, loser.accessToken);
      clients.push(a, b);

      const { duelId } = await startDuel(a, b, loser.characterId);
      await playRound(a, b, duelId, 'rock', 'scissors');
      await playRound(a, b, duelId, 'paper', 'rock');
      await waitUntil(() => captured.length === 1);

      // Both players give up on the frozen screen and reload before the pass lands.
      a.close();
      b.close();
      await new Promise((resolve) => setTimeout(resolve, 60));
      const a2 = await TestClient.connect(booted.baseUrl, winner.accessToken);
      const b2 = await TestClient.connect(booted.baseUrl, loser.accessToken);
      clients.push(a2, b2);

      captured[0]!.run();

      const winnerEnd = await a2.next('duel:end');
      expect(winnerEnd.outcome).toBe('death');
      const loserEnd = await b2.next('duel:end');
      expect(loserEnd.outcome).toBe('death');
      // The HUD and the pet screen reconcile off these two, on the new sockets.
      expect((await a2.next('character:update')).character.lethalCoins).toBe(160);
      const rebirth = await b2.next('character:rebirth');
      expect(rebirth.cause).toBe('duel_defeat');
      expect(rebirth.rebirthIndex).toBe(1);
      expect(rebirth.character.lethalCoins).toBe(STARTING_LETHAL_COINS);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

/**
 * QA round 5, new 14 hardening. The whole safety of the last-resort abort rests on one
 * predicate — `WHERE id = $1 AND state = 'active'` — and the row lock behind it. These two
 * assert that in terms of state rather than of a log line, so a mutation that drops the
 * predicate fails on the money instead of on a message.
 */
describe('the conditional claim behind the last-resort abort', () => {
  it('claims nothing and releases nothing against a settlement committing concurrently', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const winner = await makePlayer(booted.app, 'Raced', { coins: 120 });
      const loser = await makePlayer(booted.app, 'Racer', { coins: 40 });

      const a = await TestClient.connect(booted.baseUrl, winner.accessToken);
      const b = await TestClient.connect(booted.baseUrl, loser.accessToken);
      clients.push(a, b);

      // A real duel, stopped one round short so nothing settles it out from under the race.
      const { duelId } = await startDuel(a, b, loser.characterId);
      await playRound(a, b, duelId, 'rock', 'scissors');
      await booted.duels.stop();

      const settler = await db.connect();
      const aborter = await db.connect();
      try {
        // The concurrent settler: a death, claimed and held open mid-transaction.
        await settler.query('BEGIN');
        const claimed = await claimDuelSettlement(settler, duelId, {
          outcome: 'death',
          winnerCharacterId: winner.characterId,
          loserCharacterId: loser.characterId,
          coinsTransferred: 40,
          challengerWins: 1,
          opponentWins: 0,
          endedAt: new Date(),
        });
        expect(claimed).not.toBeNull();

        // The fallback abort, entered while that settlement is still in flight. It must
        // block on the settler's row lock rather than read a stale `active`.
        await aborter.query('BEGIN');
        let resolved: unknown = 'pending';
        const race = abortDuelIfActive(aborter, duelId, new Date()).then((row) => {
          resolved = row;
          return row;
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(resolved).toBe('pending');

        await settler.query('COMMIT');
        expect(await race).toBeNull();
        await aborter.query('COMMIT');
      } finally {
        settler.release();
        aborter.release();
      }

      // The death stands: not rewritten to `aborted`, not zeroed, not announced over.
      expect(await duelRow(duelId)).toMatchObject({
        state: 'complete',
        outcome: 'death',
        coins_transferred: 40,
      });
      // And the losing claim released no locks — freeing the loser's wallet mid-settlement
      // is what would let them spend below the stake and shortchange the winner.
      expect((await characterRow(winner.characterId)).active_duel_id).toBe(duelId);
      expect((await characterRow(loser.characterId)).active_duel_id).toBe(duelId);
      expect(
        [...a.received('duel:end'), ...b.received('duel:end')].filter((end) => end.outcome === 'abort'),
      ).toHaveLength(0);
    } finally {
      await closeAll(clients);
      await booted.app.close();
    }
  });

  it('leaves a committed death intact when the whole ladder and the fallback run over it', async () => {
    const pool = testPool();
    // The death commits; every read of it fails forever, so the ladder is walked to its end
    // and the fallback abort is the only thing left — against a row that is already
    // `complete`. It must claim nothing.
    const poisoned = poolLosingSettlementCommitAck(pool, {
      match: /SELECT \* FROM duels WHERE id = \$1$/,
      failures: Number.POSITIVE_INFINITY,
    });
    const { clock, captured } = capturingClock(RECOVERY_LADDER);
    const booted = await boot({ db: poisoned, clock, recoveryDelaysMs: RECOVERY_LADDER });
    const clients: TestClient[] = [];
    try {
      const winner = await makePlayer(booted.app, 'Ladderwin', { coins: 120 });
      const loser = await makePlayer(booted.app, 'Ladderdead', { coins: 40 });

      const a = await TestClient.connect(booted.baseUrl, winner.accessToken);
      const b = await TestClient.connect(booted.baseUrl, loser.accessToken);
      clients.push(a, b);

      const { duelId } = await startDuel(a, b, loser.characterId);
      await playRound(a, b, duelId, 'rock', 'scissors');
      await playRound(a, b, duelId, 'paper', 'rock');

      // Walk the whole ladder by hand, into and past the fallback.
      await waitUntil(() => captured.length === 1);
      for (let pass = 0; pass < 3; pass += 1) {
        captured[pass]!.run();
        await new Promise((resolve) => setTimeout(resolve, 120));
      }

      // The death, exactly as it committed. A fallback that claimed this row would have
      // rewritten it to `aborted` with `coins_transferred = 0`.
      expect(await duelRow(duelId)).toMatchObject({
        state: 'complete',
        outcome: 'death',
        coins_transferred: 40,
      });
      expect(await characterRow(winner.characterId)).toMatchObject({
        lethal_coins: 160,
        active_duel_id: null,
      });
      expect(await characterRow(loser.characterId)).toMatchObject({
        lethal_coins: STARTING_LETHAL_COINS,
        rebirth_count: 1,
        active_duel_id: null,
      });
      // And nothing false was ever said: no abort frame reached either socket.
      expect(
        [...a.received('duel:end'), ...b.received('duel:end')].filter((end) => end.outcome === 'abort'),
      ).toHaveLength(0);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});
