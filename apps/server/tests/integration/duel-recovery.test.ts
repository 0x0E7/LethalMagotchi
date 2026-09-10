import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { STARTING_LETHAL_COINS, TOWN_SQUARE_CHANNEL_ID, type DuelThrow } from '@lethalmagotchi/shared';
import { ChatService } from '../../src/chat/service.js';
import type { Db, DbClient } from '../../src/db/pool.js';
import { DuelService } from '../../src/duel/service.js';
import { abortAbandonedDuels } from '../../src/repos/duels.js';
import { Hub } from '../../src/ws/hub.js';
import { RateLimiter } from '../../src/rate-limit.js';
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
 * throw exactly where QA's repro says it hurts — after the winner has been paid inside an
 * uncommitted transaction, on the last write before COMMIT.
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
 * A pool that lets the settlement transaction commit for real and then loses the reply, the
 * way a connection dropped between `COMMIT` and its acknowledgment does. Armed per
 * connection by the settlement's own last write, so no other transaction in the process can
 * be caught by it.
 *
 * `readBack` adds the second blip QA's repro needs: once the acknowledgment has been lost,
 * one nominated read of the committed state fails too — on a pool connection or on the pool
 * itself, since a failover poisons several at once.
 */
function poolLosingSettlementCommitAck(
  pool: Db,
  readBack: { match: RegExp; failures?: number } | null = null,
): { db: Db; lostAcks: () => number; readBackFailures: () => number } {
  let remaining = 1;
  let lost = 0;
  let readBackRemaining = readBack?.failures ?? 1;
  let readBackFailed = 0;
  const bind = (target: object, prop: string | symbol): unknown => {
    const value = Reflect.get(target, prop);
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
  };

  const failsReadBack = (text: unknown): boolean => {
    if (!readBack || lost === 0 || readBackRemaining <= 0) return false;
    if (typeof text !== 'string' || !readBack.match.test(text)) return false;
    readBackRemaining -= 1;
    readBackFailed += 1;
    return true;
  };

  const proxied = new Proxy(pool, {
    get(target, prop) {
      if (prop === 'query') {
        const query = (target.query as (t: unknown, v?: unknown[]) => Promise<unknown>).bind(target);
        return (text: unknown, values?: unknown[]) =>
          failsReadBack(text)
            ? Promise.reject(new Error('injected read-back failure'))
            : query(text, values);
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

  return { db: proxied, lostAcks: () => lost, readBackFailures: () => readBackFailed };
}

/** Polls rather than sleeps, so a slow box costs time instead of a spurious failure. */
async function waitUntil(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
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
  options: { db?: Db; log?: (message: string) => void; recoveryDelaysMs?: number[] } = {},
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
    // The settlement-recovery backoff is 1s/5s/30s in production; tests drive the same
    // ladder in milliseconds rather than waiting out half a minute of it.
    ...(options.recoveryDelaysMs ? { settlementRecoveryDelaysMs: options.recoveryDelaysMs } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  const { app } = await createTestApp({ hub, chat, duels, limiters });
  await app.listen({ port: 0, host: '127.0.0.1' });
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
  const account = await registerAccount(app, { username: uniqueUsername('duelfix') });
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
  deleted_at: Date | null;
}> {
  const result = await db.query<{
    lethal_coins: number;
    active_duel_id: string | null;
    rebirth_count: number;
    deleted_at: Date | null;
  }>(
    'SELECT lethal_coins, active_duel_id, rebirth_count, deleted_at FROM characters WHERE id = $1',
    [characterId],
  );
  return result.rows[0]!;
}

async function duelRow(duelId: string): Promise<{
  state: string;
  outcome: string | null;
  coins_transferred: number | null;
  winner_character_id: string | null;
}> {
  const result = await db.query<{
    state: string;
    outcome: string | null;
    coins_transferred: number | null;
    winner_character_id: string | null;
  }>('SELECT state, outcome, coins_transferred, winner_character_id FROM duels WHERE id = $1', [duelId]);
  return result.rows[0]!;
}

async function startDuel(
  challenger: TestClient,
  opponent: TestClient,
  targetCharacterId: string,
): Promise<{ duelId: string; inviteId: string; stakeCoins: number }> {
  challenger.send({ type: 'duel:invite', targetCharacterId });
  const invited = await opponent.next('duel:invited');
  opponent.send({ type: 'duel:respond', inviteId: invited.inviteId, accept: true });
  const start = await challenger.next('duel:start');
  await opponent.next('duel:start');
  return { duelId: start.duelId, inviteId: invited.inviteId, stakeCoins: start.stakeCoins };
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

/**
 * Regression, QA round 1 (bug 1). `retire()` and the `duel:end` fan-out used to sit after
 * the settlement transaction, so a settlement that threw skipped both: the duel stayed
 * `active`, both duelists stayed locked, and neither client was ever told the match ended —
 * a frozen arena with no route back to town until the next process restart.
 */
describe('a settlement that cannot commit', () => {
  it('still ends the duel for both clients, releases both locks and moves no coins', async () => {
    const pool = testPool();
    const booted = await boot({
      db: poolFailingOn(pool, /UPDATE duels SET coins_transferred/),
    });
    const clients: TestClient[] = [];
    try {
      const winner = await makePlayer(booted.app, 'Doomed', { coins: 120 });
      const loser = await makePlayer(booted.app, 'Unpaid', { coins: 40 });

      const a = await TestClient.connect(booted.baseUrl, winner.accessToken);
      const b = await TestClient.connect(booted.baseUrl, loser.accessToken);
      clients.push(a, b);

      const { duelId } = await startDuel(a, b, loser.characterId);
      await playRound(a, b, duelId, 'rock', 'scissors');
      await playRound(a, b, duelId, 'paper', 'rock');

      // Both clients are told, in the same request/response cycle — not eventually by a
      // boot sweep — and the outcome honestly says the match was aborted.
      const endA = await a.next('duel:end');
      const endB = await b.next('duel:end');
      for (const end of [endA, endB]) {
        expect(end.outcome).toBe('abort');
        expect(end.duelId).toBe(duelId);
        expect(end.winnerCharacterId).toBeNull();
        expect(end.coinsTransferred).toBe(0);
        expect(end.rebirth).toBeNull();
      }

      expect(await duelRow(duelId)).toMatchObject({
        state: 'aborted',
        outcome: 'abort',
        coins_transferred: 0,
        winner_character_id: null,
      });

      const winnerAfter = await characterRow(winner.characterId);
      const loserAfter = await characterRow(loser.characterId);
      // No payout, no death, no rebirth — and neither wallet is still locked to the duel.
      expect(winnerAfter).toMatchObject({ lethal_coins: 120, active_duel_id: null, rebirth_count: 0 });
      expect(loserAfter).toMatchObject({ lethal_coins: 40, active_duel_id: null, rebirth_count: 0 });

      // Released on both sides: either can be challenged again immediately.
      const freed = await booted.app.inject(
        authed(winner, { method: 'POST', url: '/api/v1/characters/me/actions/feed', payload: { itemId: 'kibble' } }),
      );
      expect(freed.statusCode).toBe(200);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('retries once, so a single transient failure still pays the winner', async () => {
    const pool = testPool();
    const booted = await boot({
      db: poolFailingOn(pool, /UPDATE duels SET coins_transferred/, 1),
    });
    const clients: TestClient[] = [];
    try {
      const winner = await makePlayer(booted.app, 'Patient', { coins: 120 });
      const loser = await makePlayer(booted.app, 'Blipped', { coins: 40 });

      const a = await TestClient.connect(booted.baseUrl, winner.accessToken);
      const b = await TestClient.connect(booted.baseUrl, loser.accessToken);
      clients.push(a, b);

      const { duelId } = await startDuel(a, b, loser.characterId);
      await playRound(a, b, duelId, 'rock', 'scissors');
      await playRound(a, b, duelId, 'paper', 'rock');

      const end = await a.next('duel:end');
      expect(end.outcome).toBe('death');
      expect(end.coinsTransferred).toBe(40);
      // Paid exactly once: the rolled-back attempt left nothing behind.
      expect((await characterRow(winner.characterId)).lethal_coins).toBe(160);
      expect((await characterRow(loser.characterId)).lethal_coins).toBe(STARTING_LETHAL_COINS);
      expect(await duelRow(duelId)).toMatchObject({ state: 'complete', coins_transferred: 40 });
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

/**
 * Regression, QA round 2 (new 1). `settleOnce` returns `null` when it loses the settlement
 * claim, and that was treated as "nothing to announce". The case it actually describes is a
 * settlement that committed and then lost its COMMIT acknowledgment: attempt 1 pays the
 * winner and kills the loser for real, attempt 2 loses the claim to that committed row, and
 * both clients were told nothing at all — a real death with no dialog, in a frozen arena
 * whose throws answer `STALE_SEQ` forever.
 */
describe('a settlement that commits but cannot say so', () => {
  it('announces the death from the persisted row, exactly once, to both clients', async () => {
    const pool = testPool();
    const flaky = poolLosingSettlementCommitAck(pool);
    const booted = await boot({ db: flaky.db });
    const clients: TestClient[] = [];
    try {
      const winner = await makePlayer(booted.app, 'Unheard', { coins: 120 });
      const loser = await makePlayer(booted.app, 'Silent', { coins: 40 });

      const a = await TestClient.connect(booted.baseUrl, winner.accessToken);
      const b = await TestClient.connect(booted.baseUrl, loser.accessToken);
      clients.push(a, b);

      const { duelId } = await startDuel(a, b, loser.characterId);
      await playRound(a, b, duelId, 'rock', 'scissors');
      await playRound(a, b, duelId, 'paper', 'rock');

      // Both clients hear about the death that really happened, not silence and not an abort.
      const endA = await a.next('duel:end');
      const endB = await b.next('duel:end');
      for (const end of [endA, endB]) {
        expect(end.duelId).toBe(duelId);
        expect(end.outcome).toBe('death');
        expect(end.winnerCharacterId).toBe(winner.characterId);
        expect(end.loserCharacterId).toBe(loser.characterId);
        expect(end.coinsTransferred).toBe(40);
        expect(end.rebirth).toEqual({ characterId: loser.characterId, rebirthIndex: 1 });
      }

      // The scenario under test really happened: one commit landed and its reply did not.
      expect(flaky.lostAcks()).toBe(1);

      const update = await a.next('character:update');
      expect(update.character.id).toBe(winner.characterId);
      expect(update.character.lethalCoins).toBe(160);

      const rebirth = await b.next('character:rebirth');
      expect(rebirth.character.id).toBe(loser.characterId);
      expect(rebirth.cause).toBe('duel_defeat');
      expect(rebirth.coinsBefore).toBe(40);
      expect(rebirth.rebirthIndex).toBe(1);
      expect(rebirth.character.lethalCoins).toBe(STARTING_LETHAL_COINS);

      // The Town Square hears about it too: the announcement row was written by the attempt
      // that committed, so it is looked up and broadcast rather than written a second time.
      const announcement = await a.next('chat:message', (message) =>
        message.message.body.includes('defeated'),
      );
      expect(announcement.channelId).toBe(TOWN_SQUARE_CHANNEL_ID);
      expect(announcement.message.body).toBe(`${winner.nickname} defeated ${loser.nickname} in a duel.`);
      const stored = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM chat_messages
         WHERE body = $1 AND created_at = (SELECT ended_at FROM duels WHERE id = $2)`,
        [`${winner.nickname} defeated ${loser.nickname} in a duel.`, duelId],
      );
      expect(stored.rows[0]!.count).toBe('1');

      // Money and death stay exactly-once: the losing retry paid nobody a second time.
      expect(await duelRow(duelId)).toMatchObject({
        state: 'complete',
        outcome: 'death',
        coins_transferred: 40,
        winner_character_id: winner.characterId,
      });
      expect(await characterRow(winner.characterId)).toMatchObject({
        lethal_coins: 160,
        active_duel_id: null,
        rebirth_count: 0,
      });
      expect(await characterRow(loser.characterId)).toMatchObject({
        lethal_coins: STARTING_LETHAL_COINS,
        active_duel_id: null,
        rebirth_count: 1,
      });

      // And the frames are not doubled by the retry that lost the claim.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(a.received('duel:end')).toHaveLength(1);
      expect(b.received('duel:end')).toHaveLength(1);
      expect(b.received('character:rebirth')).toHaveLength(1);
      expect(
        a.received('chat:message').filter((message) => message.message.body.includes('defeated')),
      ).toHaveLength(1);
      expect(
        a.received('character:update').filter((message) => message.character.id === winner.characterId),
      ).toHaveLength(1);

      // Released on both sides, so either can play again immediately.
      const freed = await booted.app.inject(
        authed(winner, {
          method: 'POST',
          url: '/api/v1/characters/me/actions/feed',
          payload: { itemId: 'kibble' },
        }),
      );
      expect(freed.statusCode).toBe(200);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

/**
 * Regression, QA round 3 (new 8). The read-back that fixed new 1 issued four un-transacted
 * pool reads with no retry — in exactly the situation where a connection has just failed
 * mid-COMMIT, and where a failover poisons several pool connections at once. Any one of them
 * throwing was collapsed to "nothing was committed", which announced an abort — "nobody was
 * hurt and no coins moved" — over a real death, a real payout and a real rebirth.
 */
describe('a settlement that commits, cannot say so, and then loses a read', () => {
  const variants = [
    { name: 'the duel row', match: /SELECT \* FROM duels WHERE id = \$1$/, announced: true },
    { name: 'a character row', match: /SELECT \* FROM characters WHERE id = \$1$/, announced: true },
    { name: 'the rebirth event', match: /FROM rebirth_events/, announced: true },
    // The Town Square line is cosmetic, and is the one read that is allowed to stay lost.
    { name: 'the town square line', match: /FROM chat_messages/, announced: false },
  ];

  for (const variant of variants) {
    it(`still announces the death when the read-back loses ${variant.name}`, async () => {
      const pool = testPool();
      const flaky = poolLosingSettlementCommitAck(pool, { match: variant.match });
      const booted = await boot({ db: flaky.db });
      const clients: TestClient[] = [];
      try {
        const winner = await makePlayer(booted.app, 'Reread', { coins: 120 });
        const loser = await makePlayer(booted.app, 'Doubly', { coins: 40 });

        const a = await TestClient.connect(booted.baseUrl, winner.accessToken);
        const b = await TestClient.connect(booted.baseUrl, loser.accessToken);
        clients.push(a, b);

        const { duelId } = await startDuel(a, b, loser.characterId);
        await playRound(a, b, duelId, 'rock', 'scissors');
        await playRound(a, b, duelId, 'paper', 'rock');

        const endA = await a.next('duel:end');
        const endB = await b.next('duel:end');
        for (const end of [endA, endB]) {
          expect(end.duelId).toBe(duelId);
          expect(end.outcome).toBe('death');
          expect(end.winnerCharacterId).toBe(winner.characterId);
          expect(end.loserCharacterId).toBe(loser.characterId);
          expect(end.coinsTransferred).toBe(40);
          expect(end.rebirth).toEqual({ characterId: loser.characterId, rebirthIndex: 1 });
        }

        // Both blips really happened: the lost acknowledgment and the lost read after it.
        expect(flaky.lostAcks()).toBe(1);
        expect(flaky.readBackFailures()).toBe(1);

        const update = await a.next('character:update');
        expect(update.character.id).toBe(winner.characterId);
        expect(update.character.lethalCoins).toBe(160);

        const rebirth = await b.next('character:rebirth');
        expect(rebirth.character.id).toBe(loser.characterId);
        expect(rebirth.cause).toBe('duel_defeat');
        expect(rebirth.coinsBefore).toBe(40);
        expect(rebirth.rebirthIndex).toBe(1);

        const killLine = `${winner.nickname} defeated ${loser.nickname} in a duel.`;
        await new Promise((resolve) => setTimeout(resolve, 100));
        const broadcast = a
          .received('chat:message')
          .filter((message) => message.message.body === killLine);
        // The chat lookup is the only read whose loss is allowed to cost anything, and all
        // it costs is the line itself — which is written either way.
        expect(broadcast).toHaveLength(variant.announced ? 1 : 0);
        const stored = await db.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM chat_messages
           WHERE body = $1 AND created_at = (SELECT ended_at FROM duels WHERE id = $2)`,
          [killLine, duelId],
        );
        expect(stored.rows[0]!.count).toBe('1');

        // Exactly once, and exactly what the database says.
        expect(a.received('duel:end')).toHaveLength(1);
        expect(b.received('duel:end')).toHaveLength(1);
        expect(b.received('character:rebirth')).toHaveLength(1);
        expect(
          a.received('character:update').filter((message) => message.character.id === winner.characterId),
        ).toHaveLength(1);

        expect(await duelRow(duelId)).toMatchObject({
          state: 'complete',
          outcome: 'death',
          coins_transferred: 40,
          winner_character_id: winner.characterId,
        });
        expect(await characterRow(winner.characterId)).toMatchObject({
          lethal_coins: 160,
          active_duel_id: null,
        });
        expect(await characterRow(loser.characterId)).toMatchObject({
          lethal_coins: STARTING_LETHAL_COINS,
          active_duel_id: null,
          rebirth_count: 1,
        });
      } finally {
        await closeAll(clients);
        await booted.close();
      }
    });
  }

  it('announces no abort at all while the read-back cannot complete, and never aborts over the death', async () => {
    const pool = testPool();
    const flaky = poolLosingSettlementCommitAck(pool, {
      match: /SELECT \* FROM duels WHERE id = \$1$/,
      failures: Number.POSITIVE_INFINITY,
    });
    const logged: string[] = [];
    const booted = await boot({
      db: flaky.db,
      log: (message) => logged.push(message),
      recoveryDelaysMs: [20, 40, 60],
    });
    const clients: TestClient[] = [];
    try {
      const winner = await makePlayer(booted.app, 'Unknowable', { coins: 120 });
      const loser = await makePlayer(booted.app, 'Unread', { coins: 40 });

      const a = await TestClient.connect(booted.baseUrl, winner.accessToken);
      const b = await TestClient.connect(booted.baseUrl, loser.accessToken);
      clients.push(a, b);

      const { duelId } = await startDuel(a, b, loser.characterId);
      await playRound(a, b, duelId, 'rock', 'scissors');
      await playRound(a, b, duelId, 'paper', 'rock');

      /**
       * Regression, QA round 4 (new 14, case 3). The whole recovery ladder runs and ends in
       * the last-resort abort — which is conditional on `state = 'active'`, so against a
       * duel that really did commit a death it claims nothing and does nothing.
       */
      await waitUntil(() =>
        logged.includes('duel settled elsewhere while unreadable; nothing to compensate'),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Nothing is asserted to either client, because nothing can be established. Silence
      // costs a reload; a false "nobody was hurt and no coins moved" contradicts the ledger.
      expect(logged).toContain('duel settlement outcome undetermined; retrying');
      // Retried before giving up, rather than collapsing on the first failure.
      expect(flaky.readBackFailures()).toBeGreaterThanOrEqual(2);

      expect(a.received('duel:end')).toHaveLength(0);
      expect(b.received('duel:end')).toHaveLength(0);

      // The death that did commit is untouched: no compensating abort ran over it.
      expect(await duelRow(duelId)).toMatchObject({
        state: 'complete',
        outcome: 'death',
        coins_transferred: 40,
        winner_character_id: winner.characterId,
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
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

/**
 * Regression, QA round 4 (new 14). The `'undetermined'` branch new 8 introduced left the
 * duel row `active` and both `active_duel_id` set, with no in-process path back: `retire()`
 * has dropped the runner, and the only sweep that clears them runs at boot. A settlement
 * that provably never committed — both attempts rolled back, both read-backs unanswerable —
 * locked two players out of every paid action, every tournament and their own delete button
 * until someone restarted the server.
 */
describe('a settlement that never committed and could never be read back', () => {
  it('walks the recovery backoff, then aborts and frees both duelists', async () => {
    const pool = testPool();
    // The settlement's last write and the read-back's only read, both poisoned for good:
    // four failures back to back, which is what a failover across the pool looks like.
    const poisoned = poolFailingOn(
      pool,
      /UPDATE duels SET coins_transferred|SELECT \* FROM duels WHERE id = \$1$/,
    );
    const logged: string[] = [];
    const booted = await boot({
      db: poisoned,
      log: (message) => logged.push(message),
      recoveryDelaysMs: [20, 40, 60],
    });
    const clients: TestClient[] = [];
    try {
      const winner = await makePlayer(booted.app, 'Freed', { coins: 120 });
      const loser = await makePlayer(booted.app, 'Alsofreed', { coins: 40 });

      const a = await TestClient.connect(booted.baseUrl, winner.accessToken);
      const b = await TestClient.connect(booted.baseUrl, loser.accessToken);
      clients.push(a, b);

      const { duelId } = await startDuel(a, b, loser.characterId);
      await playRound(a, b, duelId, 'rock', 'scissors');
      await playRound(a, b, duelId, 'paper', 'rock');

      // Nothing was claimed while the outcome was unknown; the abort arrives only once the
      // conditional claim has proved no settlement exists to contradict it.
      for (const end of [await a.next('duel:end'), await b.next('duel:end')]) {
        expect(end.duelId).toBe(duelId);
        expect(end.outcome).toBe('abort');
        expect(end.coinsTransferred).toBe(0);
        expect(end.rebirth).toBeNull();
      }
      expect(logged).toContain('duel settlement outcome undetermined; retrying');
      expect(logged).toContain('duel settlement never committed; aborted after recovery');

      // No coins moved and nobody died, because nothing ever committed.
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

      // Which is the part a player can feel: both are playable again, with no restart.
      for (const player of [winner, loser]) {
        const response = await booted.app.inject(
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
      await booted.close();
    }
  });

  it('announces the committed death instead when a later pass can finally read it', async () => {
    const pool = testPool();
    // Four read-back failures: the two the settlement itself spends, and the two the first
    // scheduled recovery pass spends. The second pass reads the committed row.
    const flaky = poolLosingSettlementCommitAck(pool, {
      match: /SELECT \* FROM duels WHERE id = \$1$/,
      failures: 4,
    });
    const booted = await boot({ db: flaky.db, recoveryDelaysMs: [20, 40, 60] });
    const clients: TestClient[] = [];
    try {
      const winner = await makePlayer(booted.app, 'Latetold', { coins: 120 });
      const loser = await makePlayer(booted.app, 'Latedead', { coins: 40 });

      const a = await TestClient.connect(booted.baseUrl, winner.accessToken);
      const b = await TestClient.connect(booted.baseUrl, loser.accessToken);
      clients.push(a, b);

      const { duelId } = await startDuel(a, b, loser.characterId);
      await playRound(a, b, duelId, 'rock', 'scissors');
      await playRound(a, b, duelId, 'paper', 'rock');

      for (const end of [await a.next('duel:end'), await b.next('duel:end')]) {
        expect(end.duelId).toBe(duelId);
        expect(end.outcome).toBe('death');
        expect(end.winnerCharacterId).toBe(winner.characterId);
        expect(end.loserCharacterId).toBe(loser.characterId);
        expect(end.coinsTransferred).toBe(40);
        expect(end.rebirth).toEqual({ characterId: loser.characterId, rebirthIndex: 1 });
      }

      // The scenario really happened: a lost acknowledgment, then four unanswerable reads.
      expect(flaky.lostAcks()).toBe(1);
      expect(flaky.readBackFailures()).toBe(4);

      const update = await a.next('character:update');
      expect(update.character.lethalCoins).toBe(160);
      const rebirth = await b.next('character:rebirth');
      expect(rebirth.cause).toBe('duel_defeat');
      expect(rebirth.coinsBefore).toBe(40);
      expect(rebirth.rebirthIndex).toBe(1);

      // Exactly once, and never an abort in the interim: silence, then the truth.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(a.received('duel:end')).toHaveLength(1);
      expect(b.received('duel:end')).toHaveLength(1);
      expect(b.received('character:rebirth')).toHaveLength(1);
      expect(
        a.received('character:update').filter((message) => message.character.id === winner.characterId),
      ).toHaveLength(1);
      expect(
        [...a.received('duel:end'), ...b.received('duel:end')].filter((end) => end.outcome === 'abort'),
      ).toHaveLength(0);

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
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

/**
 * Regression, QA round 2 (new 3b). When the settlement *and* its compensating abort both
 * fail, the `duel:end{abort}` still goes out — but the duel row stayed `active` with both
 * `active_duel_id` set, so two players who had just been told the match was over were
 * answered `409 CHARACTER_IN_DUEL` for every action, invite and delete until a restart.
 */
describe('a settlement whose compensating abort also fails', () => {
  it('still releases both engagement locks, so neither player is stuck until a restart', async () => {
    const pool = testPool();
    // Every write to `duels` fails: the settlement claim, its retry, and both attempts at
    // the abort that compensates for it.
    const booted = await boot({ db: poolFailingOn(pool, /UPDATE duels/) });
    const clients: TestClient[] = [];
    try {
      const winner = await makePlayer(booted.app, 'Stuck', { coins: 120 });
      const loser = await makePlayer(booted.app, 'Alsostuck', { coins: 40 });

      const a = await TestClient.connect(booted.baseUrl, winner.accessToken);
      const b = await TestClient.connect(booted.baseUrl, loser.accessToken);
      clients.push(a, b);

      const { duelId } = await startDuel(a, b, loser.characterId);
      await playRound(a, b, duelId, 'rock', 'scissors');
      await playRound(a, b, duelId, 'paper', 'rock');

      for (const end of [await a.next('duel:end'), await b.next('duel:end')]) {
        expect(end.outcome).toBe('abort');
        expect(end.duelId).toBe(duelId);
      }

      // The row could not be written, and honestly says so.
      expect(await duelRow(duelId)).toMatchObject({ state: 'active' });
      // The locks are the part a player can feel, and they are gone.
      expect((await characterRow(winner.characterId)).active_duel_id).toBeNull();
      expect((await characterRow(loser.characterId)).active_duel_id).toBeNull();
      // No coins moved and nobody died on a settlement that never committed.
      expect((await characterRow(winner.characterId)).lethal_coins).toBe(120);
      expect(await characterRow(loser.characterId)).toMatchObject({
        lethal_coins: 40,
        rebirth_count: 0,
      });

      for (const player of [winner, loser]) {
        const response = await booted.app.inject(
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
      await booted.close();
    }
  });
});

/**
 * Regression, QA round 2 (new 7). `start()` assigned `lockClient` before testing the
 * advisory lock, so a second concurrent call overwrote the field: the winning connection was
 * stranded holding the recovery lock and a pool slot for the life of the process, and
 * `stop()` had nothing left to unlock.
 */
describe('two concurrent starts', () => {
  it('is a no-op for the losers, and still releases the recovery lock on stop', async () => {
    const first = await boot();
    try {
      // Three, not two: with the guard removed a pair races to a stranded connection only
      // about four times in five, and a regression test that passes on the bug one run in
      // five is not one. A third caller makes the overwrite certain.
      await Promise.all([first.duels.start(), first.duels.start(), first.duels.start()]);
      await first.duels.stop();

      // The lock is genuinely free again: a fresh service takes it rather than skipping.
      const logged: string[] = [];
      const second = await boot({ log: (message) => logged.push(message) });
      try {
        await second.duels.start();
        expect(logged).not.toContain('duel recovery sweep skipped: lock held elsewhere');
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
    }
  });
});

/**
 * Regression, QA round 1 (info items). `DuelService.stopped` was written and never read, so
 * an accept in flight across a shutdown would still build a runner on a stopped service; and
 * `duel:resync` shared the general play budget despite costing several queries and a burst of
 * frames, unlike `tourney:resync`, which has its own tight bucket.
 */
describe('the shutdown flag and the resync budget', () => {
  it('releases an accept that lands after the service has stopped, rather than starting a runner', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const challenger = await makePlayer(booted.app, 'Late', { coins: 30 });
      const target = await makePlayer(booted.app, 'Later', { coins: 30 });
      const a = await TestClient.connect(booted.baseUrl, challenger.accessToken);
      const b = await TestClient.connect(booted.baseUrl, target.accessToken);
      clients.push(a, b);

      a.send({ type: 'duel:invite', targetCharacterId: target.characterId });
      const invited = await b.next('duel:invited');

      await booted.duels.stop();
      b.send({ type: 'duel:respond', inviteId: invited.inviteId, accept: true });

      const end = await b.next('duel:end');
      expect(end.outcome).toBe('abort');
      expect(await duelRow(end.duelId)).toMatchObject({ state: 'aborted', outcome: 'abort' });
      expect((await characterRow(challenger.characterId)).active_duel_id).toBeNull();
      expect((await characterRow(target.characterId)).active_duel_id).toBeNull();
      // Nothing was ever dealt: no round window was offered on a stopped service.
      expect(b.received('duel:round')).toHaveLength(0);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('charges duel:resync to its own tighter bucket, leaving the play budget alone', async () => {
    const limiters = relaxedLimiters();
    limiters.duelResync = new RateLimiter({ limit: 2, windowMs: 10_000 });
    const pool = testPool();
    const hub = new Hub();
    const chat = new ChatService({ db: pool, hub, limiters });
    const duels = new DuelService({ db: pool, hub, chat, limiters, revealMs: 20 });
    const { app } = await createTestApp({ hub, chat, duels, limiters });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const clients: TestClient[] = [];
    try {
      const player = await makePlayer(app, 'Resyncer', { coins: 30 });
      const other = await makePlayer(app, 'Bystander', { coins: 30 });
      const a = await TestClient.connect(baseUrl, player.accessToken);
      clients.push(a);

      // The connect itself spends nothing from this bucket; the frames do.
      a.send({ type: 'duel:resync' });
      a.send({ type: 'duel:resync' });
      a.send({ type: 'duel:resync' });
      const refused = await a.next('duel:error');
      expect(refused.code).toBe('RATE_LIMITED');

      // The play budget is untouched: an invite still goes through.
      const b = await TestClient.connect(baseUrl, other.accessToken);
      clients.push(b);
      a.send({ type: 'duel:invite', targetCharacterId: other.characterId });
      expect((await b.next('duel:invited')).from.characterId).toBe(player.characterId);
    } finally {
      await closeAll(clients);
      await duels.stop();
      await app.close();
    }
  });
});

/**
 * Regression, QA round 1 (bug 2). The boot sweep was global and unguarded, so a second
 * instance coming up — a rolling deploy, a second replica — aborted every live duel on the
 * first one, clearing the locks that keep a duelist from spending their stake and voiding a
 * real result that was still being played.
 */
describe('boot recovery across two instances', () => {
  it('lets only one instance sweep, and never voids a duel the other is still playing', async () => {
    const first = await boot();
    const clients: TestClient[] = [];
    let second: DuelService | null = null;
    try {
      // Instance A boots and takes the recovery lock.
      await first.duels.start();

      const winner = await makePlayer(first.app, 'Holder', { coins: 90 });
      const loser = await makePlayer(first.app, 'Played', { coins: 30 });
      const a = await TestClient.connect(first.baseUrl, winner.accessToken);
      const b = await TestClient.connect(first.baseUrl, loser.accessToken);
      clients.push(a, b);

      const { duelId } = await startDuel(a, b, loser.characterId);
      await playRound(a, b, duelId, 'rock', 'scissors');

      // Instance B boots mid-match against the same database.
      const hub = new Hub();
      const limiters = relaxedLimiters();
      second = new DuelService({
        db: testPool(),
        hub,
        chat: new ChatService({ db: testPool(), hub, limiters }),
        limiters,
      });
      await second.start();

      // A's live duel is untouched: still active, both locks still held.
      expect(await duelRow(duelId)).toMatchObject({ state: 'active', outcome: null });
      expect((await characterRow(winner.characterId)).active_duel_id).toBe(duelId);
      expect((await characterRow(loser.characterId)).active_duel_id).toBe(duelId);

      // And the real result still lands, with the real coins.
      await playRound(a, b, duelId, 'paper', 'rock');
      const end = await a.next('duel:end');
      expect(end.outcome).toBe('death');
      expect(end.winnerCharacterId).toBe(winner.characterId);
      expect(end.coinsTransferred).toBe(30);
      expect(await duelRow(duelId)).toMatchObject({
        state: 'complete',
        outcome: 'death',
        coins_transferred: 30,
        winner_character_id: winner.characterId,
      });
      expect((await characterRow(winner.characterId)).lethal_coins).toBe(120);
    } finally {
      await second?.stop();
      await closeAll(clients);
      await first.close();
    }
  });

  it('sweeps only duels that predate the sweeping process', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const challenger = await makePlayer(booted.app, 'Fresh', { coins: 40 });
      const target = await makePlayer(booted.app, 'Alive', { coins: 40 });
      const a = await TestClient.connect(booted.baseUrl, challenger.accessToken);
      const b = await TestClient.connect(booted.baseUrl, target.accessToken);
      clients.push(a, b);

      const { duelId } = await startDuel(a, b, target.characterId);

      // A boot instant from before this duel started: nothing here can be its leftover.
      const before = new Date(Date.now() - 60_000);
      expect(await abortAbandonedDuels(db, new Date(), before)).toBe(0);
      expect(await duelRow(duelId)).toMatchObject({ state: 'active' });
      expect((await characterRow(challenger.characterId)).active_duel_id).toBe(duelId);

      // A boot instant after it, which is what a genuine restart looks like.
      expect(await abortAbandonedDuels(db, new Date(), new Date(Date.now() + 1_000))).toBe(1);
      expect(await duelRow(duelId)).toMatchObject({ state: 'aborted', outcome: 'abort' });
      expect((await characterRow(challenger.characterId)).active_duel_id).toBeNull();
      expect((await characterRow(target.characterId)).active_duel_id).toBeNull();
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

/**
 * Regression, QA round 1 (bug 6). Nothing held a challenger to the stake their Stakes Card
 * advertised, so they could spend during the 60s window and the duel would be played for
 * less than the target consented to.
 */
describe('the advertised stake is binding', () => {
  it('holds the challenger to it while the invite is pending, and plays for that number', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const challenger = await makePlayer(booted.app, 'Bidder', { coins: 200 });
      const target = await makePlayer(booted.app, 'Decider', { coins: 500 });
      const a = await TestClient.connect(booted.baseUrl, challenger.accessToken);
      const b = await TestClient.connect(booted.baseUrl, target.accessToken);
      clients.push(a, b);

      a.send({ type: 'duel:invite', targetCharacterId: target.characterId });
      const invited = await b.next('duel:invited');
      expect(invited.stakeCoins).toBe(200);

      const spend = await booted.app.inject(
        authed(challenger, {
          method: 'POST',
          url: '/api/v1/characters/me/actions/feed',
          payload: { itemId: 'kibble' },
        }),
      );
      expect(spend.statusCode).toBe(409);
      expect(spend.json().error.code).toBe('DUEL_STAKE_RESERVED');
      expect((await characterRow(challenger.characterId)).lethal_coins).toBe(200);

      b.send({ type: 'duel:respond', inviteId: invited.inviteId, accept: true });
      const start = await b.next('duel:start');
      // Exactly the number on the card the target agreed to.
      expect(start.stakeCoins).toBe(200);

      await playRound(a, b, start.duelId, 'rock', 'scissors');
      await playRound(a, b, start.duelId, 'paper', 'rock');
      const end = await a.next('duel:end');
      expect(end.coinsTransferred).toBe(200);
      expect((await characterRow(challenger.characterId)).lethal_coins).toBe(400);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('releases the hold as soon as the challenge is withdrawn', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const challenger = await makePlayer(booted.app, 'Withdrawer', { coins: 20 });
      const target = await makePlayer(booted.app, 'Waiting', { coins: 20 });
      const a = await TestClient.connect(booted.baseUrl, challenger.accessToken);
      const b = await TestClient.connect(booted.baseUrl, target.accessToken);
      clients.push(a, b);

      a.send({ type: 'duel:invite', targetCharacterId: target.characterId });
      const invited = await b.next('duel:invited');

      const held = await booted.app.inject(
        authed(challenger, {
          method: 'POST',
          url: '/api/v1/characters/me/actions/feed',
          payload: { itemId: 'kibble' },
        }),
      );
      expect(held.statusCode).toBe(409);

      a.send({ type: 'duel:cancel', inviteId: invited.inviteId });
      await a.next('duel:invite_state', (message) => message.state === 'cancelled');

      const allowed = await booted.app.inject(
        authed(challenger, {
          method: 'POST',
          url: '/api/v1/characters/me/actions/feed',
          payload: { itemId: 'kibble' },
        }),
      );
      expect(allowed.statusCode).toBe(200);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

/**
 * Regression, QA round 1 (bug 7). A reconnecting challenger was sent a bare
 * `duel:invite_state{pending}` with nothing to identify it, so the client — whose `outgoing`
 * is always null right after a reload — dropped it and left the player unable to withdraw or
 * reissue until the 60s TTL lapsed.
 */
describe('reconnecting with a challenge still out', () => {
  it('resends enough of the invite to rebuild it, so it can be withdrawn immediately', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const challenger = await makePlayer(booted.app, 'Reloader', { coins: 75 });
      const target = await makePlayer(booted.app, 'Patient', { coins: 40 });
      const a = await TestClient.connect(booted.baseUrl, challenger.accessToken);
      const b = await TestClient.connect(booted.baseUrl, target.accessToken);
      clients.push(a, b);

      a.send({ type: 'duel:invite', targetCharacterId: target.characterId });
      const invited = await b.next('duel:invited');

      a.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const reloaded = await TestClient.connect(booted.baseUrl, challenger.accessToken);
      clients.push(reloaded);

      const resent = await reloaded.next(
        'duel:invite_state',
        (message) => message.inviteId === invited.inviteId,
      );
      expect(resent.state).toBe('pending');
      expect(resent.stakeCoins).toBe(40);
      expect(resent.expiresAt).toBeDefined();
      expect(resent.target?.characterId).toBe(target.characterId);
      expect(resent.target?.nickname).toBe(target.nickname);

      // Immediately actionable, rather than only after the TTL.
      reloaded.send({ type: 'duel:cancel', inviteId: invited.inviteId });
      const cancelled = await reloaded.next(
        'duel:invite_state',
        (message) => message.state === 'cancelled',
      );
      expect(cancelled.inviteId).toBe(invited.inviteId);

      // And re-inviting works straight away.
      reloaded.send({ type: 'duel:invite', targetCharacterId: target.characterId });
      const again = await b.next(
        'duel:invited',
        (message) => message.inviteId !== invited.inviteId,
      );
      expect(again.from.characterId).toBe(challenger.characterId);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

/**
 * Regression, QA round 1 (bug 8). The delete route read `active_duel_id` and then deleted in
 * a separate statement, so a self-delete could interleave with the accept transaction and
 * land despite the character being committed to a duel — a way for a losing player to dodge
 * the loss and deny the winner their stake.
 */
describe('deleting a character races a duel accept', () => {
  it('refuses the delete when the accept commits first, rather than landing mid-duel', async () => {
    const booted = await boot();
    try {
      const player = await makePlayer(booted.app, 'Escapee', { coins: 50 });

      // Stands in for the accept transaction: the character row is locked, and the duel
      // lock is written just before it commits.
      const holder = await db.connect();
      let deletion: Promise<LightMyRequestResponse>;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT * FROM characters WHERE id = $1 FOR UPDATE', [player.characterId]);

        deletion = booted.app.inject(authed(player, { method: 'DELETE', url: '/api/v1/characters/me' }));
        await new Promise((resolve) => setTimeout(resolve, 150));

        await holder.query('UPDATE characters SET active_duel_id = gen_random_uuid() WHERE id = $1', [
          player.characterId,
        ]);
        await holder.query('COMMIT');
      } finally {
        holder.release();
      }

      const response = await deletion;
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('CHARACTER_IN_DUEL');
      expect((await characterRow(player.characterId)).deleted_at).toBeNull();
    } finally {
      await booted.close();
    }
  });

  it('still deletes cleanly when no duel is in the way', async () => {
    const booted = await boot();
    try {
      const player = await makePlayer(booted.app, 'Quitter', { coins: 50 });
      const response = await booted.app.inject(
        authed(player, { method: 'DELETE', url: '/api/v1/characters/me' }),
      );
      expect(response.statusCode).toBe(204);
      expect((await characterRow(player.characterId)).deleted_at).not.toBeNull();
    } finally {
      await booted.close();
    }
  });
});
