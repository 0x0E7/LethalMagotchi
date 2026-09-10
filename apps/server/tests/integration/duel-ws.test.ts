import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ServerMessage } from '@lethalmagotchi/shared';
import { ChatService } from '../../src/chat/service.js';
import type { Db } from '../../src/db/pool.js';
import { DuelService } from '../../src/duel/service.js';
import type { Limiters } from '../../src/deps.js';
import { RateLimiter } from '../../src/rate-limit.js';
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
import { ManualClock, settle } from '../helpers/clock.js';
import { TestClient, closeAll } from '../helpers/ws.js';

interface Player extends TestAccount {
  characterId: string;
}

interface Booted {
  app: FastifyInstance;
  baseUrl: string;
  clock: ManualClock;
  close: () => Promise<void>;
}

let db: Db;

beforeAll(() => {
  db = testPool();
});

afterAll(async () => {
  await closeTestPool();
});

async function boot(options: { limiters?: Limiters; manualClock?: boolean } = {}): Promise<Booted> {
  const pool = testPool();
  const hub = new Hub();
  const limiters = options.limiters ?? relaxedLimiters();
  const chat = new ChatService({ db: pool, hub, limiters });
  // Started at the wall clock so the 24h account-age floor reads the same way it does in
  // production, then driven by hand from there.
  const clock = new ManualClock(Date.now());
  const duels = new DuelService({
    db: pool,
    hub,
    chat,
    limiters,
    ...(options.manualClock ? { clock } : {}),
    revealMs: options.manualClock ? 100 : 20,
  });
  const { app } = await createTestApp({ hub, chat, duels, limiters });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    app,
    clock,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await duels.stop();
      await app.close();
    },
  };
}

async function makePlayer(app: FastifyInstance, nickname: string): Promise<Player> {
  const account = await registerAccount(app, { username: uniqueUsername('dws') });
  const response = await app.inject(
    authed(account, { method: 'POST', url: '/api/v1/characters', payload: { ...VALID_CHARACTER, nickname } }),
  );
  expect(response.statusCode, response.body).toBe(201);
  const characterId = response.json().character.id as string;
  await db.query(`UPDATE characters SET created_at = now() - interval '48 hours' WHERE id = $1`, [
    characterId,
  ]);
  return { ...account, characterId };
}

async function startDuel(
  challenger: TestClient,
  opponent: TestClient,
  targetCharacterId: string,
): Promise<string> {
  challenger.send({ type: 'duel:invite', targetCharacterId });
  const invited = await opponent.next('duel:invited');
  opponent.send({ type: 'duel:respond', inviteId: invited.inviteId, accept: true });
  const start = await challenger.next('duel:start');
  await opponent.next('duel:start');
  return start.duelId;
}

function firstFrameContaining(client: TestClient, needle: string): ServerMessage | null {
  const index = client.frames.findIndex((frame) => frame.includes(needle));
  return index === -1 ? null : (client.messages[index] ?? null);
}

describe('a throw is private until the reveal', () => {
  it('never puts the opponent throw in any frame before duel:round_result', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const challenger = await makePlayer(booted.app, 'Miso');
      const opponent = await makePlayer(booted.app, 'Pepper');
      const a = await TestClient.connect(booted.baseUrl, challenger.accessToken);
      const b = await TestClient.connect(booted.baseUrl, opponent.accessToken);
      clients.push(a, b);

      const duelId = await startDuel(a, b, opponent.characterId);
      const round = await a.next('duel:round');

      a.send({
        type: 'duel:throw',
        duelId,
        round: round.round,
        replay: round.replay,
        seq: round.seq,
        throw: 'scissors',
      });
      await b.next('duel:opponent_locked');
      // Long enough for a leaky implementation to have leaked.
      await settle(250);

      // Nothing the opponent has received so far even contains the word.
      expect(b.transcript()).not.toContain('scissors');
      expect(b.received('duel:round_result')).toHaveLength(0);

      const roundForB = await b.next('duel:round');
      b.send({
        type: 'duel:throw',
        duelId,
        round: roundForB.round,
        replay: roundForB.replay,
        seq: roundForB.seq,
        throw: 'paper',
      });

      await b.next('duel:round_result');
      await a.next('duel:round_result');

      // The very first frame in which each side can see the other's throw is the reveal.
      expect(firstFrameContaining(b, 'scissors')?.type).toBe('duel:round_result');
      expect(firstFrameContaining(a, 'paper')?.type).toBe('duel:round_result');
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

describe('throw idempotency', () => {
  it('refuses a duplicate seq and records exactly one throw for the window', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const challenger = await makePlayer(booted.app, 'Miso');
      const opponent = await makePlayer(booted.app, 'Pepper');
      const a = await TestClient.connect(booted.baseUrl, challenger.accessToken);
      const b = await TestClient.connect(booted.baseUrl, opponent.accessToken);
      clients.push(a, b);

      const duelId = await startDuel(a, b, opponent.characterId);
      const round = await a.next('duel:round');
      const frame = { type: 'duel:throw' as const, duelId, round: round.round, replay: round.replay, seq: round.seq };

      a.send({ ...frame, throw: 'rock' });
      a.send({ ...frame, throw: 'paper' });
      // A stale seq from a window that has not even opened yet is refused too.
      a.send({ ...frame, seq: round.seq + 5, throw: 'scissors' });

      const rejected = await a.next('duel:error');
      expect(rejected.code).toBe('STALE_SEQ');
      await settle(200);
      expect(a.received('duel:error')).toHaveLength(2);

      const stored = await db.query<{ throw: string }>(
        'SELECT throw FROM duel_actions WHERE duel_id = $1 AND character_id = $2',
        [duelId, challenger.characterId],
      );
      expect(stored.rowCount).toBe(0);

      const roundForB = await b.next('duel:round');
      b.send({
        type: 'duel:throw',
        duelId,
        round: roundForB.round,
        replay: roundForB.replay,
        seq: roundForB.seq,
        throw: 'scissors',
      });
      const result = await a.next('duel:round_result');
      // The first throw is the one that counted; the double-click changed nothing.
      expect(result.yourThrow).toBe('rock');

      const after = await db.query<{ throw: string; auto_thrown: boolean }>(
        'SELECT throw, auto_thrown FROM duel_actions WHERE duel_id = $1 AND character_id = $2',
        [duelId, challenger.characterId],
      );
      expect(after.rows).toEqual([{ throw: 'rock', auto_thrown: false }]);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

describe('deadlines, driven by the clock rather than by waiting', () => {
  it('auto-throws for a duelist who lets the window run out', async () => {
    const booted = await boot({ manualClock: true });
    const clients: TestClient[] = [];
    try {
      const challenger = await makePlayer(booted.app, 'Miso');
      const opponent = await makePlayer(booted.app, 'Pepper');
      const a = await TestClient.connect(booted.baseUrl, challenger.accessToken);
      const b = await TestClient.connect(booted.baseUrl, opponent.accessToken);
      clients.push(a, b);

      const duelId = await startDuel(a, b, opponent.characterId);
      const round = await a.next('duel:round');
      a.send({
        type: 'duel:throw',
        duelId,
        round: round.round,
        replay: round.replay,
        seq: round.seq,
        throw: 'rock',
      });
      await b.next('duel:opponent_locked');
      expect(a.received('duel:round_result')).toHaveLength(0);

      await booted.clock.advance(5_000, 150);

      const result = await a.next('duel:round_result');
      expect(result.yourThrow).toBe('rock');
      expect(['rock', 'paper', 'scissors']).toContain(result.opponentThrow);

      const stored = await db.query<{ auto_thrown: boolean }>(
        'SELECT auto_thrown FROM duel_actions WHERE duel_id = $1 AND character_id = $2',
        [duelId, opponent.characterId],
      );
      // A missed window is a random throw, never a forfeit.
      expect(stored.rows[0]).toEqual({ auto_thrown: true });
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('expires an unanswered challenge after 60 seconds and tells both sides', async () => {
    const booted = await boot({ manualClock: true });
    const clients: TestClient[] = [];
    try {
      const challenger = await makePlayer(booted.app, 'Miso');
      const opponent = await makePlayer(booted.app, 'Pepper');
      const a = await TestClient.connect(booted.baseUrl, challenger.accessToken);
      const b = await TestClient.connect(booted.baseUrl, opponent.accessToken);
      clients.push(a, b);

      a.send({ type: 'duel:invite', targetCharacterId: opponent.characterId });
      const invited = await b.next('duel:invited');

      await booted.clock.advance(60_000, 150);

      const expired = await b.next('duel:invite_state', (message) => message.state === 'expired');
      expect(expired.inviteId).toBe(invited.inviteId);
      await a.next('duel:invite_state', (message) => message.state === 'expired');

      const stored = await db.query<{ state: string }>('SELECT state FROM duel_invites WHERE id = $1', [
        invited.inviteId,
      ]);
      expect(stored.rows[0]!.state).toBe('expired');
      // An expired challenge cannot be answered late.
      b.send({ type: 'duel:respond', inviteId: invited.inviteId, accept: true });
      expect((await b.next('duel:error')).code).toBe('EXPIRED');
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('keeps playing a duelist who has disconnected, and buries them if they lose', async () => {
    const booted = await boot({ manualClock: true });
    const clients: TestClient[] = [];
    try {
      const present = await makePlayer(booted.app, 'Present');
      const absent = await makePlayer(booted.app, 'Absent');
      const a = await TestClient.connect(booted.baseUrl, present.accessToken);
      const b = await TestClient.connect(booted.baseUrl, absent.accessToken);
      clients.push(a);

      const duelId = await startDuel(a, b, absent.characterId);

      // The other duelist walks away mid-match. The match does not wait for them.
      b.close();
      await settle(100);

      for (let window = 0; window < 12; window += 1) {
        if (a.received('duel:end').length > 0) break;
        const round = await a.next('duel:round');
        a.send({
          type: 'duel:throw',
          duelId,
          round: round.round,
          replay: round.replay,
          seq: round.seq,
          throw: 'rock',
        });
        await booted.clock.advance(5_100, 150);
      }

      const end = await a.next('duel:end');
      expect(end.outcome).toBe('death');
      expect(end.winnerCharacterId).not.toBeNull();
      expect(end.rebirth?.characterId).toBe(end.loserCharacterId);

      // Every throw the absent duelist "made" was the server's, and they still counted.
      const theirs = await db.query<{ auto_thrown: boolean }>(
        'SELECT auto_thrown FROM duel_actions WHERE duel_id = $1 AND character_id = $2',
        [duelId, absent.characterId],
      );
      expect(theirs.rowCount).toBeGreaterThan(0);
      expect(theirs.rows.every((row) => row.auto_thrown)).toBe(true);

      // The loser is dead either way — including when it is the player who was not there.
      const rebirth = await db.query<{ cause: string }>(
        'SELECT cause FROM rebirth_events WHERE character_id = $1',
        [end.loserCharacterId],
      );
      expect(rebirth.rows[0]!.cause).toBe('duel_defeat');
      const duel = await db.query<{ state: string }>('SELECT state FROM duels WHERE id = $1', [duelId]);
      expect(duel.rows[0]!.state).toBe('complete');
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

describe('duel rate limits', () => {
  function productionDuelLimits(): Limiters {
    return {
      ...relaxedLimiters(),
      duelInvite: new RateLimiter({ limit: 6, windowMs: 10 * 60_000, maxBackoffMs: 60 * 60_000 }),
      duelAction: new RateLimiter({ limit: 30, windowMs: 10_000, maxBackoffMs: 60_000 }),
    };
  }

  it('charges an invite that never had a chance, so garbage buys no free attempts', async () => {
    const booted = await boot({ limiters: productionDuelLimits() });
    const clients: TestClient[] = [];
    try {
      const spammer = await makePlayer(booted.app, 'Spammer');
      const a = await TestClient.connect(booted.baseUrl, spammer.accessToken);
      clients.push(a);

      for (let attempt = 0; attempt < 7; attempt += 1) {
        a.send({ type: 'duel:invite', targetCharacterId: randomUUID() });
      }
      await settle(400);

      const codes = a.received('duel:error').map((message) => message.code);
      /**
       * Six frames spent the budget even though every one of them named nobody real, and
       * the seventh had nothing left to spend. The refusal arrives ahead of the six
       * NOT_FOUNDs because it needs no database lookup to answer, so this counts rather
       * than sequences them.
       */
      expect(codes.filter((code) => code === 'NOT_FOUND')).toHaveLength(6);
      expect(codes.filter((code) => code === 'RATE_LIMITED')).toHaveLength(1);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('throttles a throw flood on the same budget as real play', async () => {
    const booted = await boot({ limiters: productionDuelLimits() });
    const clients: TestClient[] = [];
    try {
      const flooder = await makePlayer(booted.app, 'Flooder');
      const a = await TestClient.connect(booted.baseUrl, flooder.accessToken);
      clients.push(a);

      for (let attempt = 0; attempt < 32; attempt += 1) {
        a.send({ type: 'duel:throw', duelId: randomUUID(), round: 1, replay: 0, seq: 0, throw: 'rock' });
      }
      await settle(500);

      const codes = a.received('duel:error').map((message) => message.code);
      expect(codes.filter((code) => code === 'NOT_FOUND')).toHaveLength(30);
      expect(codes.filter((code) => code === 'RATE_LIMITED').length).toBeGreaterThan(0);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});
