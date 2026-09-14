/**
 * QA round-1 adversarial probes for raid mode. These are deliberately hostile: several of
 * them are expected to FAIL against the current implementation and exist as the repro
 * evidence for the round-1 bug report.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ChatService } from '../../src/chat/service.js';
import type { Db, DbClient } from '../../src/db/pool.js';
import { RaidService } from '../../src/raid/service.js';
import type { Limiters } from '../../src/deps.js';
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
  nickname: string;
}

interface Booted {
  app: FastifyInstance;
  baseUrl: string;
  clock: ManualClock;
  raids: RaidService;
  hub: Hub;
  logs: string[];
  close: () => Promise<void>;
}

let db: Db;

beforeAll(() => {
  db = testPool();
});

afterAll(async () => {
  await closeTestPool();
});

function bind(target: object, prop: string | symbol): unknown {
  const value = Reflect.get(target, prop);
  return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
}

/**
 * A pool that really commits the settlement transaction and then throws instead of
 * returning the acknowledgment, plus optional read-back failures on top.
 */
function poolLosingSettlementCommitAck(
  pool: Db,
  trigger: RegExp,
  readBack: { match: RegExp; failures?: number } | null = null,
): Db {
  let remaining = 1;
  let lost = 0;
  let readBackRemaining = readBack?.failures ?? 1;

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
              if (typeof text === 'string' && trigger.test(text)) settling = true;
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

/** A pool whose transactions reject one specific statement, N times. */
function poolFailingOn(pool: Db, match: RegExp, failures = Number.POSITIVE_INFINITY): Db {
  let remaining = failures;
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
                return Promise.reject(new Error('injected failure'));
              }
              return (clientTarget.query as (t: unknown, v?: unknown[]) => unknown)(text, values);
            };
          },
        }) as DbClient;
      };
    },
  }) as Db;
}

async function boot(
  options: {
    db?: Db;
    limiters?: Limiters;
    busyDeferMs?: number;
    busyPollMs?: number;
    settlementRecoveryDelaysMs?: number[];
  } = {},
): Promise<Booted> {
  const pool = options.db ?? testPool();
  const hub = new Hub();
  const limiters = options.limiters ?? relaxedLimiters();
  const chat = new ChatService({ db: testPool(), hub, limiters });
  const clock = new ManualClock(Date.now());
  const logs: string[] = [];
  const raids = new RaidService({
    db: pool,
    hub,
    limiters,
    clock,
    revealMs: 50,
    betrayalMs: 5_000,
    parityMs: 5_000,
    log: (message) => logs.push(message),
    ...(options.busyDeferMs === undefined ? {} : { busyDeferMs: options.busyDeferMs }),
    ...(options.busyPollMs === undefined ? {} : { busyPollMs: options.busyPollMs }),
    ...(options.settlementRecoveryDelaysMs === undefined
      ? {}
      : { settlementRecoveryDelaysMs: options.settlementRecoveryDelaysMs }),
  });
  const { app } = await createTestApp({ hub, chat, raids, limiters });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    app,
    clock,
    raids,
    hub,
    logs,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await raids.stop();
      await app.close();
    },
  };
}

const RUN = randomUUID().slice(0, 6);
let nicknameSeed = 0;

async function makePlayer(app: FastifyInstance, label: string, coins: number): Promise<Player> {
  nicknameSeed += 1;
  const nickname = `${label}${nicknameSeed}-${RUN}`;
  const account = await registerAccount(app, { username: uniqueUsername('adv') });
  const response = await app.inject(
    authed(account, { method: 'POST', url: '/api/v1/characters', payload: { ...VALID_CHARACTER, nickname } }),
  );
  expect(response.statusCode, response.body).toBe(201);
  const characterId = response.json().character.id as string;
  await db.query(
    `UPDATE characters SET created_at = now() - interval '48 hours', lethal_coins = $2 WHERE id = $1`,
    [characterId, coins],
  );
  return { ...account, characterId, nickname };
}

async function coinsOf(characterId: string): Promise<number> {
  const result = await db.query<{ lethal_coins: number }>(
    'SELECT lethal_coins FROM characters WHERE id = $1',
    [characterId],
  );
  return result.rows[0]!.lethal_coins;
}

async function totalCoins(characterIds: string[]): Promise<number> {
  const result = await db.query<{ total: string }>(
    'SELECT COALESCE(SUM(lethal_coins), 0)::text AS total FROM characters WHERE id = ANY($1::uuid[])',
    [characterIds],
  );
  return Number(result.rows[0]!.total);
}

async function raidRow(raidId: string): Promise<{
  state: string;
  outcome: string | null;
  raider_pot_coins: number;
  target_pot_coins: number;
  pot_destroyed: boolean;
}> {
  const result = await db.query<{
    state: string;
    outcome: string | null;
    raider_pot_coins: number;
    target_pot_coins: number;
    pot_destroyed: boolean;
  }>(
    'SELECT state, outcome, raider_pot_coins, target_pot_coins, pot_destroyed FROM raids WHERE id = $1',
    [raidId],
  );
  return result.rows[0]!;
}

async function assemble(
  initiator: TestClient,
  joiners: TestClient[],
  targetCharacterId: string,
  joinerIds: string[],
): Promise<string> {
  initiator.send({ type: 'raid:create', targetCharacterId });
  const party = await initiator.next('raid:party');
  for (const [index, joinerId] of joinerIds.entries()) {
    initiator.send({ type: 'raid:invite', raidId: party.raidId, characterId: joinerId });
    const invited = await joiners[index]!.next('raid:invited');
    joiners[index]!.send({ type: 'raid:respond', raidId: invited.raidId, accept: true });
    await initiator.next('raid:party', (m) => m.members.filter((x) => x.state === 'joined').length === index + 2);
  }
  initiator.send({ type: 'raid:lock', raidId: party.raidId });
  return party.raidId;
}

/* ------------------------------------------------------------------ *
 * P1 — boot sweep money conservation, per live state
 * ------------------------------------------------------------------ */

describe('P1: boot sweep conserves money in every live state', () => {
  it('mid-betrayal: the target’s drained wallet must not be destroyed by a restart', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 20);
      const two = await makePlayer(booted.app, 'Bo', 20);
      const target = await makePlayer(booted.app, 'Tar', 10);
      const everyone = [one.characterId, two.characterId, target.characterId];
      const before = await totalCoins(everyone);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      await a.next('raid:result');
      await a.next('raid:betrayal_window');

      // 40 > 10, so the target is drained into the pot and the betrayal window is live.
      expect(await coinsOf(target.characterId)).toBe(0);
      expect((await raidRow(raidId)).state).toBe('betrayal');

      // The process dies mid-betrayal-window, a new one comes up behind it.
      await booted.raids.stop();
      await db.query(`UPDATE raids SET created_at = now() - interval '1 hour' WHERE id = $1`, [raidId]);

      const restarted = await boot();
      try {
        await restarted.raids.start();
        await settle(300);

        expect((await raidRow(raidId)).state).toBe('cancelled');
        // The escrow the raiders put in comes back...
        expect(await coinsOf(one.characterId)).toBe(20);
        expect(await coinsOf(two.characterId)).toBe(20);
        // ...and so must the 10 coins taken from the target, one way or another.
        expect(await totalCoins(everyone)).toBe(before);
      } finally {
        await restarted.close();
      }
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('mid-parity: a restart after a partial betrayal payout still conserves money', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 4);
      const two = await makePlayer(booted.app, 'Bo', 4);
      const three = await makePlayer(booted.app, 'Cy', 4);
      const target = await makePlayer(booted.app, 'Tar', 11);
      const everyone = [one.characterId, two.characterId, three.characterId, target.characterId];
      const before = await totalCoins(everyone);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      const c = await TestClient.connect(booted.baseUrl, three.accessToken);
      clients.push(a, b, c);

      const raidId = await assemble(a, [b, c], target.characterId, [two.characterId, three.characterId]);
      await a.next('raid:result');
      const window = await a.next('raid:betrayal_window');
      // 12 + 11 = 23, all loyal, 23/3 leaves a remainder of 2 → the parity game opens.
      for (const client of [a, b, c]) client.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      await a.next('raid:betrayal_result');
      await booted.clock.advance(100, 150);
      await a.next('raid:parity_round');
      expect((await raidRow(raidId)).state).toBe('betrayal');

      await booted.raids.stop();
      await db.query(`UPDATE raids SET created_at = now() - interval '1 hour' WHERE id = $1`, [raidId]);

      const restarted = await boot();
      try {
        await restarted.raids.start();
        await settle(300);
        expect(await totalCoins(everyone)).toBe(before);
      } finally {
        await restarted.close();
      }
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('a second instance cannot double-process the sweep while the first holds the lock', async () => {
    const first = await boot();
    const second = await boot();
    try {
      await first.raids.start();
      await second.raids.start();
      expect(second.logs).toContain('raid recovery sweep skipped: lock held elsewhere');
    } finally {
      await second.close();
      await first.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * P1 — exactly-once settlement under a lost COMMIT ack
 * ------------------------------------------------------------------ */

describe('P1: settlement recovery', () => {
  it('recovers a lost COMMIT ack and announces the true outcome exactly once', async () => {
    const base = testPool();
    const booted = await boot({
      db: poolLosingSettlementCommitAck(base, /UPDATE raids\s+SET state = \$2/),
    });
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 20);
      const two = await makePlayer(booted.app, 'Bo', 20);
      // 40 + 8 = 48, which divides by two: no parity tail to drive the clock through.
      const target = await makePlayer(booted.app, 'Tar', 8);
      const everyone = [one.characterId, two.characterId, target.characterId];
      const before = await totalCoins(everyone);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      const result = await a.next('raid:result');
      await settle(400);

      expect(result.outcome).toBe('raiders_won');
      expect(a.received('raid:result')).toHaveLength(1);
      expect(b.received('raid:result')).toHaveLength(1);

      const window = await a.next('raid:betrayal_window');
      for (const client of [a, b]) client.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      await a.next('raid:end');
      await settle(300);
      expect(await totalCoins(everyone)).toBe(before);
      expect(a.received('raid:end')).toHaveLength(1);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('never announces awards it could not pay, and pays them once recovery lands', async () => {
    const base = testPool();
    // `completeRaid` is the payout claim; failing it twice is a payout that never lands on
    // the first pass, and is exactly what the recovery ladder exists for.
    const booted = await boot({
      db: poolFailingOn(base, /UPDATE raids SET state = 'complete'/, 2),
      settlementRecoveryDelaysMs: [1_000, 5_000, 30_000],
    });
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 20);
      const two = await makePlayer(booted.app, 'Bo', 20);
      const target = await makePlayer(booted.app, 'Tar', 8);
      const everyone = [one.characterId, two.characterId, target.characterId];
      const before = await totalCoins(everyone);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      await a.next('raid:result');
      const window = await a.next('raid:betrayal_window');
      for (const client of [a, b]) client.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      await a.next('raid:betrayal_result');
      await settle(400);

      // Nothing was paid, so nothing may be claimed: no end frame, and the raid keeps both
      // its state and every engagement lock until the pot actually moves.
      expect(a.received('raid:end'), 'no raid:end for a payout that never committed').toHaveLength(0);
      expect(await coinsOf(one.characterId)).toBe(0);
      expect((await raidRow(raidId)).state).toBe('betrayal');
      const held = await db.query('SELECT 1 FROM characters WHERE active_raid_id = $1', [raidId]);
      expect(held.rowCount, 'locks are held while the payout is unconfirmed').toBe(2);

      // The ladder's first step, which is the attempt that gets through.
      await booted.clock.advance(1_100, 200);
      await settle(300);

      const end = await a.next('raid:end');
      expect(a.received('raid:end'), 'announced exactly once').toHaveLength(1);
      expect(end.coinsReceived).toBe(await coinsOf(one.characterId));
      expect(end.coinsReceived).toBe(24);
      expect((await raidRow(raidId)).state).toBe('complete');
      expect(await totalCoins(everyone)).toBe(before);
      const after = await db.query('SELECT 1 FROM characters WHERE active_raid_id = $1', [raidId]);
      expect(after.rowCount, 'the payout releases the locks it held').toBe(0);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('hands an unpayable pot to the boot sweep with every coin still accounted for', async () => {
    const base = testPool();
    // A payout that never lands at all: the process dies still owing the pot.
    const booted = await boot({ db: poolFailingOn(base, /UPDATE raids SET state = 'complete'/) });
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 20);
      const two = await makePlayer(booted.app, 'Bo', 20);
      const target = await makePlayer(booted.app, 'Tar', 8);
      const everyone = [one.characterId, two.characterId, target.characterId];
      const before = await totalCoins(everyone);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      await a.next('raid:result');
      const window = await a.next('raid:betrayal_window');
      for (const client of [a, b]) client.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      await settle(400);
      expect(a.received('raid:end')).toHaveLength(0);

      await booted.raids.stop();
      await db.query(`UPDATE raids SET created_at = now() - interval '1 hour' WHERE id = $1`, [raidId]);

      const restarted = await boot();
      try {
        await restarted.raids.start();
        await settle(300);
        expect(await totalCoins(everyone), 'the sweep returns the whole pot').toBe(before);
        expect(await coinsOf(target.characterId)).toBe(8);
      } finally {
        await restarted.close();
      }
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * P4 — the engagement lock
 * ------------------------------------------------------------------ */

describe('P4: the engagement lock at JOIN time', () => {
  it('refuses a second raid created in the same breath as the first', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const raider = await makePlayer(booted.app, 'Ash', 20);
      const targetOne = await makePlayer(booted.app, 'T1', 30);
      const targetTwo = await makePlayer(booted.app, 'T2', 30);

      const a = await TestClient.connect(booted.baseUrl, raider.accessToken);
      clients.push(a);

      // Two creates in one tick — no await between them.
      a.send({ type: 'raid:create', targetCharacterId: targetOne.characterId });
      a.send({ type: 'raid:create', targetCharacterId: targetTwo.characterId });
      await settle(500);

      const live = await db.query<{ id: string }>(
        `SELECT r.id FROM raids r JOIN raid_members m ON m.raid_id = r.id
         WHERE m.character_id = $1 AND r.state IN ('assembling','resolving','betrayal','parity')`,
        [raider.characterId],
      );
      expect(
        live.rowCount,
        'one character must never be a live member of two raids at once',
      ).toBe(1);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('refuses a raid created in the same breath as sitting down at a table', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const raider = await makePlayer(booted.app, 'Ash', 20);
      const target = await makePlayer(booted.app, 'Tar', 30);
      const a = await TestClient.connect(booted.baseUrl, raider.accessToken);
      clients.push(a);

      // The table claim lands between `create`'s unlocked pre-check and its write.
      a.send({ type: 'raid:create', targetCharacterId: target.characterId });
      await db.query('UPDATE characters SET seated_table_id = $2 WHERE id = $1', [
        raider.characterId,
        '00000000-0000-0000-0000-0000000000ef',
      ]);
      await settle(400);

      const row = await db.query<{ active_raid_id: string | null; seated_table_id: string | null }>(
        'SELECT active_raid_id, seated_table_id FROM characters WHERE id = $1',
        [raider.characterId],
      );
      const both = row.rows[0]!.active_raid_id !== null && row.rows[0]!.seated_table_id !== null;
      expect(both, 'a character must never hold two legs of the engagement lock at once').toBe(false);
    } finally {
      await db.query('UPDATE characters SET seated_table_id = NULL WHERE seated_table_id IS NOT NULL');
      await closeAll(clients);
      await booted.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * P4 — immunity on every outcome, including the cancel paths
 * ------------------------------------------------------------------ */

describe('P4: per-target immunity', () => {
  it('is written on a void, so a tied party cannot immediately re-queue', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 10);
      const two = await makePlayer(booted.app, 'Bo', 10);
      const target = await makePlayer(booted.app, 'Tar', 20);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      const result = await a.next('raid:result');
      expect(result.outcome).toBe('void');
      expect(raidId).toBeTruthy();
      await settle(200);

      const row = await db.query<{ raid_immunity_until: Date | null }>(
        'SELECT raid_immunity_until FROM characters WHERE id = $1',
        [target.characterId],
      );
      expect(row.rows[0]!.raid_immunity_until).not.toBeNull();
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('is written when the target stayed busy for the full defer and the raid voided', async () => {
    const booted = await boot({ busyDeferMs: 1_000, busyPollMs: 500 });
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 10);
      const two = await makePlayer(booted.app, 'Bo', 10);
      const target = await makePlayer(booted.app, 'Tar', 30);
      await db.query('UPDATE characters SET seated_table_id = $2 WHERE id = $1', [
        target.characterId,
        '00000000-0000-0000-0000-0000000000ea',
      ]);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      await assemble(a, [b], target.characterId, [two.characterId]);
      await settle(200);
      await booted.clock.advance(2_000, 200);
      const result = await a.next('raid:result');
      expect(result.outcome).toBe('void');

      const row = await db.query<{ raid_immunity_until: Date | null }>(
        'SELECT raid_immunity_until FROM characters WHERE id = $1',
        [target.characterId],
      );
      expect(row.rows[0]!.raid_immunity_until).not.toBeNull();
    } finally {
      await db.query('UPDATE characters SET seated_table_id = NULL WHERE seated_table_id IS NOT NULL');
      await closeAll(clients);
      await booted.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * P2 — leak variants
 * ------------------------------------------------------------------ */

describe('P2: hidden information, extra variants', () => {
  it('does not report the target’s exact live balance when the target wins', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const targetCoins = 9_413;
      const one = await makePlayer(booted.app, 'Ash', 6);
      const two = await makePlayer(booted.app, 'Bo', 6);
      const target = await makePlayer(booted.app, 'Tar', targetCoins);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      await assemble(a, [b], target.characterId, [two.characterId]);
      const result = await a.next('raid:result');
      expect(result.outcome).toBe('target_won');
      await settle(200);

      // The target keeps this wallet. The raiders must not walk away knowing it exactly.
      expect(result.targetPot).not.toBe(targetCoins);
      expect(a.transcript()).not.toContain(String(targetCoins));
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('reports the same numbers on the read-back path as on the direct path', async () => {
    const base = testPool();
    const booted = await boot({
      db: poolLosingSettlementCommitAck(base, /UPDATE raids\s+SET state = \$2/),
    });
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 6);
      const two = await makePlayer(booted.app, 'Bo', 6);
      const target = await makePlayer(booted.app, 'Tar', 41);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      await assemble(a, [b], target.characterId, [two.characterId]);
      const result = await a.next('raid:result');
      expect(result.outcome).toBe('target_won');
      // Direct path reports 41 here; the read-back path reports the persisted 0.
      expect(result.targetPot).toBe(0);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('never carries another raider’s choice into a resync mid-betrayal-window', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 20);
      const two = await makePlayer(booted.app, 'Bo', 20);
      const target = await makePlayer(booted.app, 'Tar', 9);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      await a.next('raid:result');
      const window = await a.next('raid:betrayal_window');
      a.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'betray' });
      await b.next('raid:betrayal_locked');

      // A forged resync mid-window, from the raider who has not chosen yet.
      b.send({ type: 'raid:resync', raidId });
      await settle(300);
      expect(b.transcript()).not.toContain('"choice"');
      expect(b.transcript()).not.toContain('betray"');
      expect(b.received('raid:betrayal_result')).toHaveLength(0);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

describe('P2: every surface reports the same target figure', () => {
  it('reports the same thing live, on read-back and in the aftermath, on a target win', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const targetCoins = 7_331;
      const one = await makePlayer(booted.app, 'Ash', 6);
      const two = await makePlayer(booted.app, 'Bo', 6);
      const target = await makePlayer(booted.app, 'Tar', targetCoins);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      const t = await TestClient.connect(booted.baseUrl, target.accessToken);
      clients.push(a, b, t);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      const result = await a.next('raid:result');
      expect(result.outcome).toBe('target_won');
      const aftermath = await t.next('raid:aftermath');
      await settle(200);

      // The live announcement, the persisted row and the target's own report agree, and
      // none of the three is the wallet the target kept.
      const row = await raidRow(raidId);
      expect(result.targetPot).toBe(0);
      expect(row.target_pot_coins).toBe(0);
      expect(aftermath.targetPot).toBe(0);
      for (const client of [a, b]) {
        expect(client.transcript()).not.toContain(String(targetCoins));
      }
      expect(await coinsOf(target.characterId)).toBe(targetCoins + 12);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('reports the same thing on a void, where the target also keeps their wallet', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const targetCoins = 40;
      const one = await makePlayer(booted.app, 'Ash', 20);
      const two = await makePlayer(booted.app, 'Bo', 20);
      const target = await makePlayer(booted.app, 'Tar', targetCoins);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      const t = await TestClient.connect(booted.baseUrl, target.accessToken);
      clients.push(a, b, t);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      const result = await a.next('raid:result');
      expect(result.outcome).toBe('void');
      const aftermath = await t.next('raid:aftermath');
      await settle(200);

      const row = await raidRow(raidId);
      expect(result.targetPot).toBe(0);
      expect(row.target_pot_coins).toBe(0);
      expect(aftermath.targetPot).toBe(0);
      expect(await coinsOf(target.characterId)).toBe(targetCoins);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * P1 — the compensating cancel, scoped to the states that can take one
 * ------------------------------------------------------------------ */

describe('P1: cancellation eligibility', () => {
  it('cannot cancel a raid that has already committed an outcome', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 20);
      const two = await makePlayer(booted.app, 'Bo', 20);
      // 40 + 8 = 48, which divides by two: no parity tail to drive the clock through.
      const target = await makePlayer(booted.app, 'Tar', 8);
      const everyone = [one.characterId, two.characterId, target.characterId];
      const before = await totalCoins(everyone);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      await a.next('raid:result');
      const window = await a.next('raid:betrayal_window');
      expect((await raidRow(raidId)).state).toBe('betrayal');

      const { cancelRaidIfLive } = await import('../../src/repos/raids.js');
      const { withTransaction } = await import('../../src/db/pool.js');
      const claimed = await withTransaction(testPool(), (client) =>
        cancelRaidIfLive(client, raidId, new Date()),
      );
      expect(claimed, 'a committed settlement is not cancellable: refunding would pay twice').toBeNull();
      expect((await raidRow(raidId)).state).toBe('betrayal');

      // And the raid still finishes normally, with every coin accounted for.
      for (const client of [a, b]) client.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      await a.next('raid:end');
      await settle(300);
      expect(await totalCoins(everyone)).toBe(before);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('still cancels a raid nobody locked in', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 20);
      const target = await makePlayer(booted.app, 'Tar', 9);
      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      clients.push(a);

      a.send({ type: 'raid:create', targetCharacterId: target.characterId });
      const party = await a.next('raid:party');

      const { cancelRaidIfLive } = await import('../../src/repos/raids.js');
      const { withTransaction } = await import('../../src/db/pool.js');
      const claimed = await withTransaction(testPool(), (client) =>
        cancelRaidIfLive(client, party.raidId, new Date()),
      );
      expect(claimed?.state).toBe('cancelled');
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * P3 — rebirth with active_raid_id set
 * ------------------------------------------------------------------ */

describe('P3: rebirth while a raid lock is held', () => {
  it('clears the raid lock if a rebirth ever happens with active_raid_id set', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 20);
      const two = await makePlayer(booted.app, 'Bo', 20);
      const target = await makePlayer(booted.app, 'Tar', 9);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      await a.next('raid:result');
      await a.next('raid:betrayal_window');

      // Simulate any rebirth trigger landing on a raider mid-raid.
      const { rebirthCharacter } = await import('../../src/repos/rebirth.js');
      const { withTransaction } = await import('../../src/db/pool.js');
      const { lockCharacterById, simulatedStats } = await import('../../src/repos/characters.js');
      await withTransaction(testPool(), async (client) => {
        const row = await lockCharacterById(client, one.characterId);
        await rebirthCharacter(client, row!, {
          statsBefore: simulatedStats(row!, Date.now()),
          cause: 'tournament_entry_hp_exhausted',
          tournamentId: null,
          at: new Date(),
        });
      });

      const after = await db.query<{ active_raid_id: string | null }>(
        'SELECT active_raid_id FROM characters WHERE id = $1',
        [one.characterId],
      );
      expect(
        after.rows[0]!.active_raid_id,
        'a rebirth must not leave the character pointing at a raid whose escrow it just wiped',
      ).toBeNull();
      expect(raidId).toBeTruthy();
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * P1 — the undetermined branch
 * ------------------------------------------------------------------ */

describe('P1: an undetermined settlement', () => {
  it('holds the locks, announces nothing, then resolves exactly once on the ladder', async () => {
    const base = testPool();
    // The settlement commits for real, the ack is lost, and both read-back attempts fail.
    const booted = await boot({
      db: poolLosingSettlementCommitAck(base, /UPDATE raids\s+SET state = \$2/, {
        match: /SELECT \* FROM raids WHERE id = \$1/,
        failures: 2,
      }),
      settlementRecoveryDelaysMs: [1_000, 5_000, 30_000],
    });
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 20);
      const two = await makePlayer(booted.app, 'Bo', 20);
      const target = await makePlayer(booted.app, 'Tar', 8);
      const everyone = [one.characterId, two.characterId, target.characterId];
      const before = await totalCoins(everyone);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      await settle(500);

      // Undetermined: nothing may be claimed about the money yet.
      expect(a.received('raid:result')).toHaveLength(0);
      expect(a.received('raid:cancelled')).toHaveLength(0);
      const stillLocked = await db.query(
        'SELECT 1 FROM characters WHERE active_raid_id = $1',
        [raidId],
      );
      expect(stillLocked.rowCount, 'locks must be held while the outcome is unknown').toBe(2);

      // Walk the backoff by hand.
      await booted.clock.advance(1_100, 200);
      await settle(300);
      const result = await a.next('raid:result');
      expect(result.outcome).toBe('raiders_won');
      expect(a.received('raid:result')).toHaveLength(1);

      const window = await a.next('raid:betrayal_window');
      for (const client of [a, b]) client.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      await a.next('raid:end');
      await settle(300);
      expect(await totalCoins(everyone)).toBe(before);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * P4 — two parties on one target
 * ------------------------------------------------------------------ */

describe('P4: two parties locking on the same target', () => {
  it('settles exactly one, and writes the immunity whichever transaction wins', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const target = await makePlayer(booted.app, 'Tar', 30);
      const p1a = await makePlayer(booted.app, 'A1', 20);
      const p1b = await makePlayer(booted.app, 'A2', 20);
      const p2a = await makePlayer(booted.app, 'B1', 20);
      const p2b = await makePlayer(booted.app, 'B2', 20);
      const everyone = [target, p1a, p1b, p2a, p2b].map((p) => p.characterId);
      const before = await totalCoins(everyone);

      const sockets = await Promise.all(
        [p1a, p1b, p2a, p2b].map((p) => TestClient.connect(booted.baseUrl, p.accessToken)),
      );
      clients.push(...sockets);
      const [a1, a2, b1, b2] = sockets as [TestClient, TestClient, TestClient, TestClient];

      // Both initiators fire `raid:create` at the same target in the same tick.
      a1.send({ type: 'raid:create', targetCharacterId: target.characterId });
      b1.send({ type: 'raid:create', targetCharacterId: target.characterId });
      await settle(400);

      const live = await db.query<{ id: string }>(
        `SELECT id FROM raids WHERE target_character_id = $1
           AND state IN ('assembling','resolving','betrayal','parity')`,
        [target.characterId],
      );
      expect(live.rowCount, 'the partial unique index must allow exactly one live raid').toBe(1);

      // Fire whichever one got through.
      const raidId = live.rows[0]!.id;
      const initiator = (await db.query<{ initiator_character_id: string }>(
        'SELECT initiator_character_id FROM raids WHERE id = $1',
        [raidId],
      )).rows[0]!.initiator_character_id;
      const isFirst = initiator === p1a.characterId;
      const lead = isFirst ? a1 : b1;
      const mate = isFirst ? a2 : b2;
      const mateId = isFirst ? p1b.characterId : p2b.characterId;

      lead.send({ type: 'raid:invite', raidId, characterId: mateId });
      const invited = await mate.next('raid:invited');
      mate.send({ type: 'raid:respond', raidId: invited.raidId, accept: true });
      await lead.next('raid:party', (m) => m.members.filter((x) => x.state === 'joined').length === 2);
      lead.send({ type: 'raid:lock', raidId });
      await lead.next('raid:result');
      // 40 vs 30 → raiders won; play the betrayal out so the pot lands in wallets again.
      const window = await lead.next('raid:betrayal_window');
      for (const client of [lead, mate]) {
        client.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      }
      await lead.next('raid:end');
      await settle(300);

      const immunity = await db.query<{ raid_immunity_until: Date | null }>(
        'SELECT raid_immunity_until FROM characters WHERE id = $1',
        [target.characterId],
      );
      expect(immunity.rows[0]!.raid_immunity_until).not.toBeNull();

      // The losing party's initiator must not be left holding a stale engagement lock.
      const loser = isFirst ? b1 : a1;
      const loserId = isFirst ? p2a.characterId : p1a.characterId;
      loser.send({ type: 'raid:create', targetCharacterId: target.characterId });
      const err = await loser.next('raid:error');
      expect(err.code).toBe('TARGET_IMMUNE');
      expect(loserId).toBeTruthy();
      expect(await totalCoins(everyone)).toBe(before);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * P4 — the wealth floor as the beggar shield
 * ------------------------------------------------------------------ */

describe('P4: the wealth floor', () => {
  it('refuses a raid on a freshly bankrupted target even with their immunity cleared', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 20);
      const two = await makePlayer(booted.app, 'Bo', 20);
      const target = await makePlayer(booted.app, 'Tar', 8);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      await a.next('raid:result');
      const window = await a.next('raid:betrayal_window');
      for (const client of [a, b]) client.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      await a.next('raid:end');
      await settle(200);
      expect(await coinsOf(target.characterId)).toBe(0);

      // Strip both the immunity and the raiders' cooldown: only the wealth floor is left.
      await db.query('UPDATE characters SET raid_immunity_until = NULL WHERE id = $1', [target.characterId]);
      await db.query('UPDATE characters SET last_raid_at = NULL WHERE id = ANY($1::uuid[])', [
        [one.characterId, two.characterId],
      ]);
      await db.query('UPDATE characters SET lethal_coins = 20 WHERE id = ANY($1::uuid[])', [
        [one.characterId, two.characterId],
      ]);

      a.send({ type: 'raid:create', targetCharacterId: target.characterId });
      const err = await a.next('raid:error');
      expect(err.code).toBe('TARGET_TOO_POOR');

      // And a single donated coin does not open the door either — 1 is still `broke`.
      await db.query('UPDATE characters SET lethal_coins = 1 WHERE id = $1', [target.characterId]);
      a.send({ type: 'raid:create', targetCharacterId: target.characterId });
      const second = await a.next('raid:error');
      expect(second.code).toBe('TARGET_TOO_POOR');
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * P6 — aftermath delivery
 * ------------------------------------------------------------------ */

describe('P6: aftermath delivery to a target who was never there', () => {
  it('reaches a target who was offline at settlement on their next connect', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 20);
      const two = await makePlayer(booted.app, 'Bo', 20);
      const target = await makePlayer(booted.app, 'Tar', 8);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      await a.next('raid:result');
      await settle(200);

      const t = await TestClient.connect(booted.baseUrl, target.accessToken);
      clients.push(t);
      const aftermath = await t.next('raid:aftermath');
      expect(aftermath.raidId).toBe(raidId);
      expect(aftermath.outcome).toBe('raiders_won');
      expect(aftermath.coinsLost).toBe(8);
      expect(aftermath.nowBeggar).toBe(true);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('survives a socket that drops mid-delivery, until the client says it was shown', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 20);
      const two = await makePlayer(booted.app, 'Bo', 20);
      const target = await makePlayer(booted.app, 'Tar', 8);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      await a.next('raid:result');
      await settle(200);

      // The delivery goes out and the socket dies before the player could read it.
      const first = await TestClient.connect(booted.baseUrl, target.accessToken);
      clients.push(first);
      await first.next('raid:aftermath');
      first.close();
      await settle(100);

      // Hours later, well past any time box the old delivery used.
      await db.query(`UPDATE raids SET ended_at = now() - interval '6 hours' WHERE id = $1`, [raidId]);
      const again = await TestClient.connect(booted.baseUrl, target.accessToken);
      clients.push(again);
      const repeat = await again.next('raid:aftermath');
      expect(repeat.raidId, 'the only report of a bankruptcy is still owed').toBe(raidId);

      // Acknowledged from the card that actually rendered it, and only then retired.
      again.send({ type: 'raid:aftermath_ack', raidId });
      await settle(200);
      const third = await TestClient.connect(booted.baseUrl, target.accessToken);
      clients.push(third);
      await settle(400);
      expect(third.received('raid:aftermath'), 'and not shown forever once seen').toHaveLength(0);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('refuses an ack for a raid the sender was not the target of', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 20);
      const two = await makePlayer(booted.app, 'Bo', 20);
      const target = await makePlayer(booted.app, 'Tar', 8);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      await a.next('raid:result');
      await settle(200);

      // A raider acking the victim's report would silence it for them.
      a.send({ type: 'raid:aftermath_ack', raidId });
      await settle(200);

      const t = await TestClient.connect(booted.baseUrl, target.accessToken);
      clients.push(t);
      const aftermath = await t.next('raid:aftermath');
      expect(aftermath.raidId).toBe(raidId);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * P5 — the parity cap, against a real pot
 * ------------------------------------------------------------------ */

describe('P5: the parity game terminates', () => {
  it('ends a real stalemate at round five and distributes the remainder exactly', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 4);
      const two = await makePlayer(booted.app, 'Bo', 4);
      const three = await makePlayer(booted.app, 'Cy', 4);
      const target = await makePlayer(booted.app, 'Tar', 11);
      const everyone = [one.characterId, two.characterId, three.characterId, target.characterId];
      const before = await totalCoins(everyone);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      const c = await TestClient.connect(booted.baseUrl, three.accessToken);
      clients.push(a, b, c);

      const raidId = await assemble(a, [b, c], target.characterId, [two.characterId, three.characterId]);
      await a.next('raid:result');
      const window = await a.next('raid:betrayal_window');
      // 12 + 11 = 23 among three: 7 each, remainder 2 → the parity game runs.
      for (const client of [a, b, c]) client.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      const betrayal = await a.next('raid:betrayal_result');
      expect(betrayal.remainder).toBe(2);

      // Everyone calls correctly every round: the round that shrinks nothing, forever.
      const rounds: number[] = [];
      for (let guard = 0; guard < 8; guard += 1) {
        await booted.clock.advance(100, 150);
        const round = await a.next('raid:parity_round', (m) => !rounds.includes(m.round));
        rounds.push(round.round);
        // Three throws of 0 sum to 0, which is even; everyone calls evens and everyone wins.
        for (const client of [a, b, c]) {
          client.send({ type: 'raid:parity', raidId, seq: round.seq, call: 'evens', throw: 0 });
        }
        const outcome = await a.next('raid:parity_result', (m) => m.round === round.round);
        if (outcome.seededSplit) {
          expect(outcome.round, 'the cap must fire at exactly RAID_PARITY_MAX_ROUNDS').toBe(5);
          break;
        }
        expect(outcome.round).toBeLessThan(5);
      }
      expect(rounds).toEqual([1, 2, 3, 4, 5]);

      await a.next('raid:end');
      await settle(300);
      expect(await totalCoins(everyone)).toBe(before);
      const row = await raidRow(raidId);
      expect(row.state).toBe('complete');
      expect(row.pot_destroyed).toBe(false);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('destroys exactly the pot and nothing more when every raider betrays', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 20);
      const two = await makePlayer(booted.app, 'Bo', 20);
      const target = await makePlayer(booted.app, 'Tar', 9);
      const everyone = [one.characterId, two.characterId, target.characterId];
      const before = await totalCoins(everyone);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      const result = await a.next('raid:result');
      const window = await a.next('raid:betrayal_window');
      for (const client of [a, b]) client.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'betray' });
      const end = await a.next('raid:end');
      await settle(300);

      expect(end.potDestroyed).toBe(true);
      // The one sanctioned burn: the shortfall is exactly the pot.
      expect(before - (await totalCoins(everyone))).toBe(result.potCoins);
      expect(result.potCoins).toBe(49);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * P8 — the reused lock frame
 * ------------------------------------------------------------------ */

describe('P8: raid:betrayal_locked doing double duty', () => {
  it('names the window each lock was made in', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 4);
      const two = await makePlayer(booted.app, 'Bo', 4);
      const three = await makePlayer(booted.app, 'Cy', 4);
      const target = await makePlayer(booted.app, 'Tar', 11);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      const c = await TestClient.connect(booted.baseUrl, three.accessToken);
      clients.push(a, b, c);

      const raidId = await assemble(a, [b, c], target.characterId, [two.characterId, three.characterId]);
      await a.next('raid:result');
      const window = await a.next('raid:betrayal_window');
      for (const client of [a, b, c]) client.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      await a.next('raid:betrayal_result');

      await booted.clock.advance(100, 150);
      const round = await a.next('raid:parity_round');
      b.send({ type: 'raid:parity', raidId, seq: round.seq, call: 'odds', throw: 3 });
      await a.next('raid:betrayal_locked', (m) => m.phase === 'parity');
      await settle(200);

      const locks = a.received('raid:betrayal_locked');
      for (const lock of locks) {
        expect(Object.keys(lock).sort()).toEqual(['characterId', 'phase', 'raidId', 'seq', 'type']);
      }
      // Each one names the window it was actually made in, so nothing has to be inferred.
      expect(locks.filter((lock) => lock.phase === 'betrayal').every((lock) => lock.seq === window.seq)).toBe(
        true,
      );
      expect(locks.filter((lock) => lock.phase === 'parity').every((lock) => lock.seq === round.seq)).toBe(
        true,
      );
      expect(locks.some((lock) => lock.phase === 'betrayal')).toBe(true);
      expect(locks.some((lock) => lock.phase === 'parity')).toBe(true);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('resends parity locks to a raider who resyncs mid-parity-window', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 4);
      const two = await makePlayer(booted.app, 'Bo', 4);
      const three = await makePlayer(booted.app, 'Cy', 4);
      const target = await makePlayer(booted.app, 'Tar', 11);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      const c = await TestClient.connect(booted.baseUrl, three.accessToken);
      clients.push(a, b, c);

      const raidId = await assemble(a, [b, c], target.characterId, [two.characterId, three.characterId]);
      await a.next('raid:result');
      const window = await a.next('raid:betrayal_window');
      for (const client of [a, b, c]) client.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      await a.next('raid:betrayal_result');

      await booted.clock.advance(100, 150);
      const round = await a.next('raid:parity_round');
      b.send({ type: 'raid:parity', raidId, seq: round.seq, call: 'odds', throw: 3 });
      c.send({ type: 'raid:parity', raidId, seq: round.seq, call: 'odds', throw: 3 });
      await settle(200);

      const beforeResync = a.received('raid:betrayal_locked').length;
      a.send({ type: 'raid:resync', raidId });
      await settle(300);

      const replayed = a.received('raid:betrayal_locked').slice(beforeResync);
      expect(replayed.map((lock) => lock.characterId).sort()).toEqual(
        [two.characterId, three.characterId].sort(),
      );
      expect(replayed.every((lock) => lock.phase === 'parity' && lock.seq === round.seq)).toBe(true);
      // The fact of each call, and never the call itself.
      expect(a.transcript()).not.toContain('"throw"');
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * P6 — donation one-rescue under real concurrency
 * ------------------------------------------------------------------ */

describe('P6: the one-rescue property under load', () => {
  it('commits exactly one of five simultaneous donations to the same beggar', async () => {
    const booted = await boot();
    try {
      const beggar = await makePlayer(booted.app, 'Beg', 0);
      const donors = await Promise.all(
        [1, 2, 3, 4, 5].map((n) => makePlayer(booted.app, `D${n}`, 10)),
      );
      const everyone = [beggar.characterId, ...donors.map((d) => d.characterId)];
      const before = await totalCoins(everyone);

      const responses = await Promise.all(
        donors.map((donor) =>
          booted.app.inject(
            authed(donor, {
              method: 'POST',
              url: '/api/v1/donations',
              payload: { toCharacterId: beggar.characterId, coins: 3 },
            }),
          ),
        ),
      );
      const created = responses.filter((r) => r.statusCode === 201);
      const refused = responses.filter((r) => r.statusCode === 409);
      expect(created, 'exactly one rescue may commit').toHaveLength(1);
      expect(refused).toHaveLength(4);
      expect(await coinsOf(beggar.characterId)).toBe(3);
      expect(await totalCoins(everyone)).toBe(before);
    } finally {
      await booted.close();
    }
  });

  it('refuses a donation to a character who is a raid target mid-settlement', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 20);
      const two = await makePlayer(booted.app, 'Bo', 20);
      const target = await makePlayer(booted.app, 'Tar', 8);
      const donor = await makePlayer(booted.app, 'Don', 10);
      const everyone = [one.characterId, two.characterId, target.characterId, donor.characterId];
      const before = await totalCoins(everyone);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      await a.next('raid:result');
      await settle(200);
      // The target is bankrupt and the pot is still in the betrayal phase.
      expect(await coinsOf(target.characterId)).toBe(0);

      const rescue = await booted.app.inject(
        authed(donor, {
          method: 'POST',
          url: '/api/v1/donations',
          payload: { toCharacterId: target.characterId, coins: 5 },
        }),
      );
      expect(rescue.statusCode).toBe(201);

      const window = await a.next('raid:betrayal_window');
      for (const client of [a, b]) client.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      await a.next('raid:end');
      await settle(300);
      // The rescue and the raid payout must not collide: every coin still accounted for.
      expect(await totalCoins(everyone)).toBe(before);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * P3 — the consequence of the unlocked create write
 * ------------------------------------------------------------------ */

describe('P3: a raid lock alongside a duel lock', () => {
  it('does not survive a rebirth on the character that holds both', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const raider = await makePlayer(booted.app, 'Ash', 20);
      const target = await makePlayer(booted.app, 'Tar', 30);
      const a = await TestClient.connect(booted.baseUrl, raider.accessToken);
      clients.push(a);

      // The duel lock lands inside `create`'s unlocked window, exactly as an accepted
      // duel invite does when it commits between the pre-check read and the write.
      a.send({ type: 'raid:create', targetCharacterId: target.characterId });
      await db.query('UPDATE characters SET active_duel_id = $2 WHERE id = $1', [
        raider.characterId,
        '00000000-0000-0000-0000-0000000000d1',
      ]);
      await settle(400);

      const both = await db.query<{ active_raid_id: string | null; active_duel_id: string | null }>(
        'SELECT active_raid_id, active_duel_id FROM characters WHERE id = $1',
        [raider.characterId],
      );
      const raidLock = both.rows[0]!.active_raid_id;
      const duelLock = both.rows[0]!.active_duel_id;
      expect(
        raidLock !== null && duelLock !== null,
        'create must not be able to add a raid lock to a character a duel already claimed',
      ).toBe(false);
    } finally {
      await db.query('UPDATE characters SET active_duel_id = NULL WHERE active_duel_id IS NOT NULL');
      await closeAll(clients);
      await booted.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * P4 — the raider-side floors
 * ------------------------------------------------------------------ */

describe('P4: the raider-side floors', () => {
  it('refuses a raider under the 24h account-age floor, as initiator and as invitee', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const veteran = await makePlayer(booted.app, 'Vet', 20);
      const rookie = await makePlayer(booted.app, 'Rook', 20);
      const target = await makePlayer(booted.app, 'Tar', 30);
      await db.query(`UPDATE characters SET created_at = now() - interval '2 hours' WHERE id = $1`, [
        rookie.characterId,
      ]);

      const v = await TestClient.connect(booted.baseUrl, veteran.accessToken);
      const r = await TestClient.connect(booted.baseUrl, rookie.accessToken);
      clients.push(v, r);

      r.send({ type: 'raid:create', targetCharacterId: target.characterId });
      expect((await r.next('raid:error')).code).toBe('TOO_NEW');

      v.send({ type: 'raid:create', targetCharacterId: target.characterId });
      const party = await v.next('raid:party');
      v.send({ type: 'raid:invite', raidId: party.raidId, characterId: rookie.characterId });
      expect((await v.next('raid:error')).code).toBe('TOO_NEW');
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('holds the 6h per-raider cooldown for a raider who only joined, never initiated', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const lead = await makePlayer(booted.app, 'Ash', 20);
      const mate = await makePlayer(booted.app, 'Bo', 20);
      const first = await makePlayer(booted.app, 'T1', 8);
      const second = await makePlayer(booted.app, 'T2', 30);

      const a = await TestClient.connect(booted.baseUrl, lead.accessToken);
      const b = await TestClient.connect(booted.baseUrl, mate.accessToken);
      clients.push(a, b);

      const raidId = await assemble(a, [b], first.characterId, [mate.characterId]);
      await a.next('raid:result');
      const window = await a.next('raid:betrayal_window');
      for (const client of [a, b]) client.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      await a.next('raid:end');
      await settle(300);

      // The joiner, who never initiated anything, is on cooldown too.
      b.send({ type: 'raid:create', targetCharacterId: second.characterId });
      expect((await b.next('raid:error')).code).toBe('COOLDOWN');

      // And cannot be invited into somebody else's party either.
      a.send({ type: 'raid:create', targetCharacterId: second.characterId });
      const err = await a.next('raid:error');
      expect(err.code).toBe('COOLDOWN');
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});
