/**
 * QA round-2 re-verification for raid mode. Written independently of the round-1 probe file
 * so a fix that was made to satisfy `raid-adversarial.test.ts` still has to satisfy a second,
 * separately-constructed reproduction of the same scenario.
 *
 * Every test here reproduces the *original failure* rather than asserting the shape of the
 * fix, and several deliberately push past it into the boundary the fix claims to hold.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ChatService } from '../../src/chat/service.js';
import type { Db, DbClient } from '../../src/db/pool.js';
import { RaidService } from '../../src/raid/service.js';
import type { Limiters } from '../../src/deps.js';
import { Hub } from '../../src/ws/hub.js';
import { abandonStaleRaids, cancelRaidIfLive } from '../../src/repos/raids.js';
import { withTransaction } from '../../src/db/pool.js';
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
  await db.query('UPDATE characters SET seated_table_id = NULL WHERE seated_table_id IS NOT NULL');
  await closeTestPool();
});

function bind(target: object, prop: string | symbol): unknown {
  const value = Reflect.get(target, prop);
  return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
}

/** A pool whose transactions reject one specific statement, N times (default: forever). */
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
                return Promise.reject(new Error('injected DB fault'));
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
 * A pool that lets a transaction really COMMIT and then loses the acknowledgment, once, on
 * the transaction that touched `trigger`. This is the fault the read-back path exists for.
 */
function poolLosingCommitAck(pool: Db, trigger: RegExp): Db {
  let remaining = 1;
  return new Proxy(pool, {
    get(target, prop) {
      if (prop !== 'connect') return bind(target, prop);
      return async (): Promise<DbClient> => {
        const client = await target.connect();
        let armed = false;
        return new Proxy(client, {
          get(clientTarget, clientProp) {
            if (clientProp !== 'query') return bind(clientTarget, clientProp);
            const query = (clientTarget.query as (t: unknown, v?: unknown[]) => Promise<unknown>).bind(
              clientTarget,
            );
            return async (text: unknown, values?: unknown[]) => {
              if (typeof text === 'string' && trigger.test(text)) armed = true;
              if (armed && text === 'COMMIT' && remaining > 0) {
                remaining -= 1;
                await query(text, values);
                throw new Error('lost COMMIT acknowledgment');
              }
              return query(text, values);
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
let seed = 0;

async function makePlayer(app: FastifyInstance, label: string, coins: number): Promise<Player> {
  seed += 1;
  const nickname = `${label}${seed}-${RUN}`;
  const account = await registerAccount(app, { username: uniqueUsername('r2') });
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

async function totalCoins(ids: string[]): Promise<number> {
  const result = await db.query<{ total: string }>(
    'SELECT COALESCE(SUM(lethal_coins), 0)::text AS total FROM characters WHERE id = ANY($1::uuid[])',
    [ids],
  );
  return Number(result.rows[0]!.total);
}

interface RaidSnapshot {
  state: string;
  outcome: string | null;
  raider_pot_coins: number;
  target_pot_coins: number;
  pot_destroyed: boolean;
  aftermath_acked_at: Date | null;
}

async function raidRow(raidId: string): Promise<RaidSnapshot> {
  const result = await db.query<RaidSnapshot>(
    `SELECT state, outcome, raider_pot_coins, target_pot_coins, pot_destroyed, aftermath_acked_at
     FROM raids WHERE id = $1`,
    [raidId],
  );
  return result.rows[0]!;
}

async function activeRaidOf(characterId: string): Promise<string | null> {
  const result = await db.query<{ active_raid_id: string | null }>(
    'SELECT active_raid_id FROM characters WHERE id = $1',
    [characterId],
  );
  return result.rows[0]!.active_raid_id;
}

async function backdate(raidId: string): Promise<void> {
  await db.query(`UPDATE raids SET created_at = now() - interval '2 hours' WHERE id = $1`, [raidId]);
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

/* ==================================================================== *
 * BLOCKER-1 — the boot sweep and the target's drained wallet
 * ==================================================================== */

describe('BLOCKER-1: boot sweep conserves the whole pot', () => {
  it('mid-betrayal: a kill + restart returns the target’s drained wallet and every escrow', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'B1a', 20);
      const two = await makePlayer(booted.app, 'B1b', 20);
      const target = await makePlayer(booted.app, 'B1t', 10);
      const everyone = [one.characterId, two.characterId, target.characterId];
      const before = await totalCoins(everyone);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      const result = await a.next('raid:result');
      expect(result.outcome).toBe('raiders_won');
      await a.next('raid:betrayal_window');

      expect(await coinsOf(target.characterId), 'target drained into the pot').toBe(0);
      expect((await raidRow(raidId)).state).toBe('betrayal');

      await booted.raids.stop();
      await backdate(raidId);

      const restarted = await boot();
      try {
        await restarted.raids.start();
        await settle(400);

        const row = await raidRow(raidId);
        expect(row.state).toBe('cancelled');
        expect(row.outcome, 'an unwound raid must not claim a robbery happened').toBeNull();
        expect(row.target_pot_coins).toBe(0);
        expect(row.pot_destroyed).toBe(false);

        expect(await coinsOf(one.characterId)).toBe(20);
        expect(await coinsOf(two.characterId)).toBe(20);
        expect(await coinsOf(target.characterId), 'the target’s 10 coins must come back').toBe(10);
        expect(await totalCoins(everyone)).toBe(before);
        expect(await activeRaidOf(one.characterId)).toBeNull();
        expect(await activeRaidOf(two.characterId)).toBeNull();
      } finally {
        await restarted.close();
      }
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('mid-parity: the same conservation holds once the parity game is open', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'B1pa', 4);
      const two = await makePlayer(booted.app, 'B1pb', 4);
      const three = await makePlayer(booted.app, 'B1pc', 4);
      const target = await makePlayer(booted.app, 'B1pt', 11);
      const everyone = [one.characterId, two.characterId, three.characterId, target.characterId];
      const before = await totalCoins(everyone);

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
      await a.next('raid:parity_round');

      expect(await coinsOf(target.characterId)).toBe(0);
      expect((await raidRow(raidId)).state).toBe('betrayal');

      await booted.raids.stop();
      await backdate(raidId);

      const restarted = await boot();
      try {
        await restarted.raids.start();
        await settle(400);

        const row = await raidRow(raidId);
        expect(row.state).toBe('cancelled');
        expect(row.outcome).toBeNull();
        expect(await coinsOf(one.characterId)).toBe(4);
        expect(await coinsOf(two.characterId)).toBe(4);
        expect(await coinsOf(three.characterId)).toBe(4);
        expect(await coinsOf(target.characterId)).toBe(11);
        expect(await totalCoins(everyone)).toBe(before);
      } finally {
        await restarted.close();
      }
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('a DB fault mid-sweep rolls the whole sweep back — no half-refunded wallets', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'B1fa', 20);
      const two = await makePlayer(booted.app, 'B1fb', 20);
      const target = await makePlayer(booted.app, 'B1ft', 10);
      const everyone = [one.characterId, two.characterId, target.characterId];
      const before = await totalCoins(everyone);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      await a.next('raid:result');
      await a.next('raid:betrayal_window');
      expect((await raidRow(raidId)).state).toBe('betrayal');

      await booted.raids.stop();
      await backdate(raidId);

      /**
       * The fault lands on the *target's* refund, which is the last money statement in the
       * sweep: the raiders have already been credited inside the transaction by then. If the
       * sweep were not genuinely one transaction, the raiders would keep that credit while
       * the target's coins stayed destroyed and the row stayed cancelled.
       */
      const faulty = poolFailingOn(db, /c\.lethal_coins \+ r\.target_pot_coins/, 1);
      await expect(abandonStaleRaids(faulty, new Date(), new Date())).rejects.toThrow(/injected DB fault/);

      const afterFault = await raidRow(raidId);
      expect(afterFault.state, 'the cancel must roll back with the refunds').toBe('betrayal');
      expect(afterFault.outcome).toBe('raiders_won');
      expect(await coinsOf(one.characterId), 'no raider may keep a half-committed refund').toBe(0);
      expect(await coinsOf(two.characterId)).toBe(0);
      expect(await coinsOf(target.characterId)).toBe(0);

      // And the next sweep, with the fault gone, still conserves everything exactly once.
      await abandonStaleRaids(db, new Date(), new Date());
      expect((await raidRow(raidId)).state).toBe('cancelled');
      expect(await coinsOf(one.characterId)).toBe(20);
      expect(await coinsOf(two.characterId)).toBe(20);
      expect(await coinsOf(target.characterId)).toBe(10);
      expect(await totalCoins(everyone)).toBe(before);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('sweeps a raid parked in `resolving` behind the busy-target defer without moving the target’s wallet', async () => {
    const booted = await boot({ busyDeferMs: 600_000, busyPollMs: 30_000 });
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'B1ra', 20);
      const two = await makePlayer(booted.app, 'B1rb', 20);
      const target = await makePlayer(booted.app, 'B1rt', 30);
      const everyone = [one.characterId, two.characterId, target.characterId];
      const before = await totalCoins(everyone);
      await db.query('UPDATE characters SET seated_table_id = $2 WHERE id = $1', [
        target.characterId,
        '00000000-0000-0000-0000-0000000000b1',
      ]);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      await settle(400);
      const parked = await raidRow(raidId);
      expect(parked.state, 'the raid waits on the busy target').toBe('resolving');
      expect(parked.outcome).toBeNull();
      expect(await coinsOf(one.characterId), 'escrow is already taken in `resolving`').toBe(0);

      await booted.raids.stop();
      await backdate(raidId);

      const restarted = await boot();
      try {
        await restarted.raids.start();
        await settle(400);
        const row = await raidRow(raidId);
        expect(row.state).toBe('cancelled');
        expect(row.outcome).toBeNull();
        expect(await coinsOf(one.characterId)).toBe(20);
        expect(await coinsOf(two.characterId)).toBe(20);
        expect(await coinsOf(target.characterId), 'a deferred raid never touched the target').toBe(30);
        expect(await totalCoins(everyone)).toBe(before);
      } finally {
        await restarted.close();
      }
    } finally {
      await db.query('UPDATE characters SET seated_table_id = NULL WHERE seated_table_id IS NOT NULL');
      await closeAll(clients);
      await booted.close();
    }
  });

  it('never re-pays a raid that already distributed its pot', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'B1ca', 20);
      const two = await makePlayer(booted.app, 'B1cb', 20);
      const target = await makePlayer(booted.app, 'B1ct', 8);
      const everyone = [one.characterId, two.characterId, target.characterId];
      const before = await totalCoins(everyone);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      // 40 + 8 = 48, split two ways with no remainder: the raid ends without a parity tail.
      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      await a.next('raid:result');
      const window = await a.next('raid:betrayal_window');
      for (const client of [a, b]) client.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      await a.next('raid:end');
      await settle(200);

      expect((await raidRow(raidId)).state).toBe('complete');
      const paidTotals = await totalCoins(everyone);
      expect(paidTotals).toBe(before);
      const paidOne = await coinsOf(one.characterId);
      const paidTwo = await coinsOf(two.characterId);

      // Backdate and sweep twice: a `complete` raid must be invisible to recovery.
      await backdate(raidId);
      await abandonStaleRaids(db, new Date(), new Date());
      await abandonStaleRaids(db, new Date(), new Date());

      expect((await raidRow(raidId)).state, 'a paid raid must not be re-opened').toBe('complete');
      expect(await coinsOf(one.characterId)).toBe(paidOne);
      expect(await coinsOf(two.characterId)).toBe(paidTwo);
      expect(await coinsOf(target.characterId)).toBe(0);
      expect(await totalCoins(everyone)).toBe(before);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('is idempotent across two consecutive sweeps of the same betrayal-stage raid', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'B1ia', 20);
      const two = await makePlayer(booted.app, 'B1ib', 20);
      const target = await makePlayer(booted.app, 'B1it', 10);
      const everyone = [one.characterId, two.characterId, target.characterId];
      const before = await totalCoins(everyone);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      await a.next('raid:result');
      await a.next('raid:betrayal_window');
      await booted.raids.stop();
      await backdate(raidId);

      await abandonStaleRaids(db, new Date(), new Date());
      await abandonStaleRaids(db, new Date(), new Date());

      expect(await totalCoins(everyone), 'a second sweep must credit nobody twice').toBe(before);
      expect(await coinsOf(target.characterId)).toBe(10);
      expect(await coinsOf(one.characterId)).toBe(20);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

/* ==================================================================== *
 * BLOCKER-2 — a payout is never announced before it commits
 * ==================================================================== */

describe('BLOCKER-2: payout announces only what committed', () => {
  it('announces nothing, holds every lock and pays nobody while the payout cannot commit', async () => {
    const base = testPool();
    const booted = await boot({
      db: poolFailingOn(base, /SET state = 'complete'/, 2),
      settlementRecoveryDelaysMs: [1_000, 5_000, 30_000],
    });
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'B2a', 20);
      const two = await makePlayer(booted.app, 'B2b', 20);
      const target = await makePlayer(booted.app, 'B2t', 8);
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

      // Both payout attempts were refused, and the read-back said `betrayal`.
      expect(a.received('raid:end'), 'no raider may be told they were paid').toHaveLength(0);
      expect(b.received('raid:end')).toHaveLength(0);
      expect((await raidRow(raidId)).state).toBe('betrayal');
      expect(await coinsOf(one.characterId), 'the pot is still sitting in the row').toBe(0);
      expect(await coinsOf(two.characterId)).toBe(0);
      expect(await activeRaidOf(one.characterId), 'locks stay held until the pot lands').toBe(raidId);
      expect(await activeRaidOf(two.characterId)).toBe(raidId);

      // The recovery pass lands, and the payout it announces is the one that committed.
      await booted.clock.advance(1_100, 300);
      const end = await a.next('raid:end');
      await settle(300);

      expect(a.received('raid:end'), 'exactly one end frame per raider').toHaveLength(1);
      expect(b.received('raid:end')).toHaveLength(1);
      expect(end.outcome).toBe('raiders_won');
      expect(end.coinsReceived).toBe(24);
      expect(await coinsOf(one.characterId)).toBe(24);
      expect(await coinsOf(two.characterId)).toBe(24);
      expect(await totalCoins(everyone)).toBe(before);
      expect((await raidRow(raidId)).state).toBe('complete');
      expect(await activeRaidOf(one.characterId)).toBeNull();
      expect(await activeRaidOf(two.characterId)).toBeNull();
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('hands a permanently unpayable pot to the boot sweep with every coin accounted for', async () => {
    const base = testPool();
    const booted = await boot({
      db: poolFailingOn(base, /SET state = 'complete'/),
      settlementRecoveryDelaysMs: [500, 500, 500],
    });
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'B2ia', 20);
      const two = await makePlayer(booted.app, 'B2ib', 20);
      const target = await makePlayer(booted.app, 'B2it', 8);
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
      await settle(300);
      for (let round = 0; round < 4; round += 1) await booted.clock.advance(600, 200);

      expect(a.received('raid:end'), 'silence, for as long as it takes').toHaveLength(0);
      expect((await raidRow(raidId)).state).toBe('betrayal');

      await booted.raids.stop();
      await backdate(raidId);

      const restarted = await boot();
      try {
        await restarted.raids.start();
        await settle(400);
        const row = await raidRow(raidId);
        expect(row.state).toBe('cancelled');
        expect(row.outcome).toBeNull();
        expect(await coinsOf(one.characterId)).toBe(20);
        expect(await coinsOf(two.characterId)).toBe(20);
        expect(await coinsOf(target.characterId)).toBe(8);
        expect(await totalCoins(everyone)).toBe(before);
      } finally {
        await restarted.close();
      }
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('cannot double-credit a payout whose COMMIT landed but whose acknowledgment was lost', async () => {
    const base = testPool();
    const booted = await boot({ db: poolLosingCommitAck(base, /SET state = 'complete'/) });
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'B2ca', 20);
      const two = await makePlayer(booted.app, 'B2cb', 20);
      const target = await makePlayer(booted.app, 'B2ct', 8);
      const everyone = [one.characterId, two.characterId, target.characterId];
      const before = await totalCoins(everyone);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      await a.next('raid:result');
      const window = await a.next('raid:betrayal_window');
      for (const client of [a, b]) client.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      const end = await a.next('raid:end');
      await settle(400);

      expect(a.received('raid:end')).toHaveLength(1);
      expect(b.received('raid:end')).toHaveLength(1);
      expect(end.coinsReceived, 'the read-back reports the awards that landed').toBe(24);
      expect(await coinsOf(one.characterId), 'credited exactly once').toBe(24);
      expect(await coinsOf(two.characterId)).toBe(24);
      expect(await totalCoins(everyone)).toBe(before);
      expect((await raidRow(raidId)).state).toBe('complete');
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('never lets a second payout attempt re-run the credit after the first claimed the row', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'B2ra', 20);
      const two = await makePlayer(booted.app, 'B2rb', 20);
      const target = await makePlayer(booted.app, 'B2rt', 8);
      const everyone = [one.characterId, two.characterId, target.characterId];
      const before = await totalCoins(everyone);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      await a.next('raid:result');
      const window = await a.next('raid:betrayal_window');
      for (const client of [a, b]) client.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      await a.next('raid:end');
      await settle(300);

      const paid = await totalCoins(everyone);
      expect(paid).toBe(before);

      /**
       * `completeRaid`'s claim is the mutual exclusion. Re-running it directly is the
       * cheapest proof that a duplicated payout attempt can never move a second coin.
       */
      const reclaimed = await withTransaction(db, (client) =>
        client.query(
          `UPDATE raids SET state = 'complete' WHERE id = $1 AND state IN ('betrayal','parity') RETURNING id`,
          [raidId],
        ),
      );
      expect(reclaimed.rowCount, 'the claim is not re-winnable').toBe(0);
      expect(await totalCoins(everyone)).toBe(before);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

/* ==================================================================== *
 * BLOCKER-3 — one engagement lock, claimed under a row lock
 * ==================================================================== */

describe('BLOCKER-3: create() takes the row lock before it commits', () => {
  it('resolves two raid:create frames fired in one tick to exactly one raid', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const raider = await makePlayer(booted.app, 'B3a', 20);
      const targetOne = await makePlayer(booted.app, 'B3t1', 30);
      const targetTwo = await makePlayer(booted.app, 'B3t2', 30);

      const a = await TestClient.connect(booted.baseUrl, raider.accessToken);
      clients.push(a);

      a.send({ type: 'raid:create', targetCharacterId: targetOne.characterId });
      a.send({ type: 'raid:create', targetCharacterId: targetTwo.characterId });
      await settle(600);

      const live = await db.query<{ id: string }>(
        `SELECT r.id FROM raids r JOIN raid_members m ON m.raid_id = r.id
         WHERE m.character_id = $1 AND r.state IN ('assembling','resolving','betrayal','parity')`,
        [raider.characterId],
      );
      expect(live.rowCount, 'one character, one live raid').toBe(1);
      expect(a.received('raid:party')).toHaveLength(1);
      expect(a.received('raid:error').map((frame) => frame.code)).toContain('BUSY');
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('loses the race to a seating claim that holds the character row, rather than overwriting it', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    const seater = await db.connect();
    let open = true;
    try {
      const raider = await makePlayer(booted.app, 'B3sa', 20);
      const target = await makePlayer(booted.app, 'B3st', 30);
      const a = await TestClient.connect(booted.baseUrl, raider.accessToken);
      clients.push(a);

      /**
       * A real contending writer, not a write slipped in between two awaits: the seating
       * transaction holds the raider's row, so `create`'s own `lockCharacterById` has to
       * block on it and then re-read what the seating wrote.
       */
      await seater.query('BEGIN');
      await seater.query('SELECT id FROM characters WHERE id = $1 FOR UPDATE', [raider.characterId]);
      await seater.query('UPDATE characters SET seated_table_id = $2 WHERE id = $1', [
        raider.characterId,
        '00000000-0000-0000-0000-0000000000b3',
      ]);

      a.send({ type: 'raid:create', targetCharacterId: target.characterId });
      await settle(300);
      await seater.query('COMMIT');
      open = false;
      await settle(600);

      const row = await db.query<{ active_raid_id: string | null; seated_table_id: string | null }>(
        'SELECT active_raid_id, seated_table_id FROM characters WHERE id = $1',
        [raider.characterId],
      );
      const both = row.rows[0]!.active_raid_id !== null && row.rows[0]!.seated_table_id !== null;
      expect(both, 'never two legs of the engagement lock at once').toBe(false);
    } finally {
      if (open) await seater.query('ROLLBACK').catch(() => undefined);
      seater.release();
      await db.query('UPDATE characters SET seated_table_id = NULL WHERE seated_table_id IS NOT NULL');
      await closeAll(clients);
      await booted.close();
    }
  });

  it('refuses a duel invite to a character already holding a raid lock', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const raider = await makePlayer(booted.app, 'B3da', 20);
      const other = await makePlayer(booted.app, 'B3db', 20);
      const target = await makePlayer(booted.app, 'B3dt', 30);

      const a = await TestClient.connect(booted.baseUrl, raider.accessToken);
      const c = await TestClient.connect(booted.baseUrl, other.accessToken);
      clients.push(a, c);

      a.send({ type: 'raid:create', targetCharacterId: target.characterId });
      await a.next('raid:party');
      expect(await activeRaidOf(raider.characterId)).not.toBeNull();

      c.send({ type: 'duel:invite', targetCharacterId: raider.characterId });
      const refusal = await c.next('duel:error');
      expect(refusal.code, 'a raid-locked character is not duellable').toBeTruthy();
      const row = await db.query<{ active_duel_id: string | null }>(
        'SELECT active_duel_id FROM characters WHERE id = $1',
        [raider.characterId],
      );
      expect(row.rows[0]!.active_duel_id).toBeNull();
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

/* ==================================================================== *
 * HIGH-4 — rebirth clears the raid leg of the engagement lock
 * ==================================================================== */

describe('HIGH-4: rebirth clears active_raid_id', () => {
  it('leaves no raid lock behind on a renewed character', async () => {
    const booted = await boot();
    try {
      const player = await makePlayer(booted.app, 'H4a', 20);
      const stale = randomUUID();
      await db.query(
        `UPDATE characters SET active_raid_id = $2, seated_table_id = $3, active_duel_id = $4 WHERE id = $1`,
        [player.characterId, stale, randomUUID(), randomUUID()],
      );

      const { rebirthCharacter } = await import('../../src/repos/rebirth.js');
      const { findCharacterById } = await import('../../src/repos/characters.js');
      const row = (await findCharacterById(db, player.characterId))!;
      await withTransaction(db, (client) =>
        rebirthCharacter(client, row, {
          statsBefore: row.stats,
          cause: 'duel_defeat',
          tournamentId: null,
          at: new Date(),
        }),
      );

      const after = (await findCharacterById(db, player.characterId))!;
      expect(after.active_raid_id, 'the raid leg must be cleared with the other two').toBeNull();
      expect(after.seated_table_id).toBeNull();
      expect(after.active_duel_id).toBeNull();
    } finally {
      await booted.close();
    }
  });

  it('still refuses a tournament entry while the raid lock is genuinely held', async () => {
    const booted = await boot();
    try {
      const player = await makePlayer(booted.app, 'H4b', 20);
      await db.query('UPDATE characters SET active_raid_id = $2 WHERE id = $1', [
        player.characterId,
        randomUUID(),
      ]);
      const response = await booted.app.inject(
        authed(player, {
          method: 'POST',
          url: '/api/v1/characters/me/tournament-optin',
          payload: { optIn: true },
        }),
      );
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error.code).toBe('CHARACTER_IN_RAID');

      // ...and so does an action that would spend from the escrowed wallet.
      const action = await booted.app.inject(
        authed(player, { method: 'POST', url: '/api/v1/characters/me/actions/feed' }),
      );
      expect(action.statusCode).toBe(409);
    } finally {
      await db.query('UPDATE characters SET active_raid_id = NULL WHERE active_raid_id IS NOT NULL');
      await booted.close();
    }
  });
});

/* ==================================================================== *
 * MEDIUM-5 — the target's live balance never reaches a raider's wire
 * ==================================================================== */

/**
 * Asserted against the *raw frame text* rather than against parsed fields, so a number
 * that reappears in a newly added field fails loudly instead of passing unnoticed.
 */
function assertNoBalanceLeak(clients: TestClient[], secret: number): void {
  for (const client of clients) {
    expect(
      client.transcript(),
      `the target's exact balance (${secret}) must never appear on a raider's wire`,
    ).not.toContain(String(secret));
  }
}

describe('MEDIUM-5: the wealth band, not the number', () => {
  it('never puts the target’s balance on a raider’s wire when the target wins', async () => {
    const secret = 7_919;
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'M5wa', 10);
      const two = await makePlayer(booted.app, 'M5wb', 10);
      const target = await makePlayer(booted.app, 'M5wt', secret);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      const result = await a.next('raid:result');
      await settle(300);

      expect(result.outcome).toBe('target_won');
      expect(result.targetPot, 'nothing was taken, so nothing is reported taken').toBe(0);
      expect(result.potCoins).toBe(0);
      expect((await raidRow(raidId)).target_pot_coins).toBe(0);
      assertNoBalanceLeak([a, b], secret);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('never puts the target’s balance on a raider’s wire on a void', async () => {
    const secret = 6_131;
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'M5va', 10);
      const two = await makePlayer(booted.app, 'M5vb', 10);
      const target = await makePlayer(booted.app, 'M5vt', secret);
      // Force the tie at settlement time, after the band was already shown at invite.
      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      a.send({ type: 'raid:create', targetCharacterId: target.characterId });
      const party = await a.next('raid:party');
      a.send({ type: 'raid:invite', raidId: party.raidId, characterId: two.characterId });
      const invited = await b.next('raid:invited');
      b.send({ type: 'raid:respond', raidId: invited.raidId, accept: true });
      await a.next('raid:party', (m) => m.members.filter((x) => x.state === 'joined').length === 2);
      await db.query('UPDATE characters SET lethal_coins = 20 WHERE id = $1', [target.characterId]);
      a.send({ type: 'raid:lock', raidId: party.raidId });

      const result = await a.next('raid:result');
      await settle(300);
      expect(result.outcome).toBe('void');
      expect(result.targetPot).toBe(0);
      assertNoBalanceLeak([a, b], secret);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('does report the real figure on a raiders’ win, where it is no longer private', async () => {
    const taken = 11;
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'M5ra', 20);
      const two = await makePlayer(booted.app, 'M5rb', 20);
      const target = await makePlayer(booted.app, 'M5rt', taken);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      const result = await a.next('raid:result');
      expect(result.outcome).toBe('raiders_won');
      expect(result.targetPot, 'what was actually taken is public').toBe(taken);
      expect(result.potCoins).toBe(40 + taken);
      expect((await raidRow(raidId)).target_pot_coins).toBe(taken);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('agrees between the live announce, the persisted row and the target’s own aftermath', async () => {
    const secret = 5_443;
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'M5aa', 10);
      const two = await makePlayer(booted.app, 'M5ab', 10);
      const target = await makePlayer(booted.app, 'M5at', secret);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      const t = await TestClient.connect(booted.baseUrl, target.accessToken);
      clients.push(a, b, t);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      const result = await a.next('raid:result');
      const aftermath = await t.next('raid:aftermath');
      await settle(300);

      expect(result.outcome).toBe('target_won');
      expect(aftermath.raidId).toBe(raidId);
      expect(aftermath.targetPot, 'the persisted figure, which is zero here').toBe(0);
      expect(aftermath.coinsLost).toBe(-20);
      expect(result.targetPot).toBe((await raidRow(raidId)).target_pot_coins);
      assertNoBalanceLeak([a, b], secret);
      // The target may of course see their own wallet.
      expect(t.transcript()).toContain(String(secret + 20));
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

/* ==================================================================== *
 * MEDIUM-6 — cancel eligibility
 * ==================================================================== */

describe('MEDIUM-6: only a pre-outcome raid may be cancelled', () => {
  it('refuses to cancel a raid that has reached the betrayal window', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'M6ba', 20);
      const two = await makePlayer(booted.app, 'M6bb', 20);
      const target = await makePlayer(booted.app, 'M6bt', 8);
      const everyone = [one.characterId, two.characterId, target.characterId];
      const before = await totalCoins(everyone);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      await a.next('raid:result');
      const window = await a.next('raid:betrayal_window');
      expect((await raidRow(raidId)).state).toBe('betrayal');

      const claimed = await withTransaction(db, (client) =>
        cancelRaidIfLive(client, raidId, new Date()),
      );
      expect(claimed, 'a settled raid is not cancellable').toBeNull();
      expect((await raidRow(raidId)).state).toBe('betrayal');
      expect(await totalCoins(everyone)).toBe(before - 8 - 40 + 0 + 48 - 48 + 0 + 0);

      // Left alone, it still finishes normally and conserves every coin.
      for (const client of [a, b]) client.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      await a.next('raid:end');
      await settle(300);
      expect((await raidRow(raidId)).state).toBe('complete');
      expect(await totalCoins(everyone)).toBe(before);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('refuses to cancel a raid in the parity game', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'M6pa', 4);
      const two = await makePlayer(booted.app, 'M6pb', 4);
      const three = await makePlayer(booted.app, 'M6pc', 4);
      const target = await makePlayer(booted.app, 'M6pt', 11);

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
      await a.next('raid:parity_round');

      const claimed = await withTransaction(db, (client) =>
        cancelRaidIfLive(client, raidId, new Date()),
      );
      expect(claimed).toBeNull();
      expect((await raidRow(raidId)).state).toBe('betrayal');
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('still cancels an assembly nobody locked in, refunding nothing because nothing was staked', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'M6aa', 20);
      const target = await makePlayer(booted.app, 'M6at', 30);
      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      clients.push(a);

      a.send({ type: 'raid:create', targetCharacterId: target.characterId });
      const party = await a.next('raid:party');
      expect((await raidRow(party.raidId)).state).toBe('assembling');

      const claimed = await withTransaction(db, (client) =>
        cancelRaidIfLive(client, party.raidId, new Date()),
      );
      expect(claimed, 'an assembling raid is still cancellable').not.toBeNull();
      expect((await raidRow(party.raidId)).state).toBe('cancelled');
      expect(await coinsOf(one.characterId), 'nothing was ever escrowed').toBe(20);
    } finally {
      await db.query('UPDATE characters SET active_raid_id = NULL WHERE active_raid_id IS NOT NULL');
      await closeAll(clients);
      await booted.close();
    }
  });
});

/* ==================================================================== *
 * LOW-7 — no recovery timer survives a finished raid
 * ==================================================================== */

describe('LOW-7: retired raids leave no armed timer', () => {
  it('does not re-announce a raid whose payout recovered, however far the clock runs on', async () => {
    const base = testPool();
    const booted = await boot({
      db: poolFailingOn(base, /SET state = 'complete'/, 2),
      settlementRecoveryDelaysMs: [1_000, 5_000, 30_000],
    });
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'L7a', 20);
      const two = await makePlayer(booted.app, 'L7b', 20);
      const target = await makePlayer(booted.app, 'L7t', 8);
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
      await settle(300);
      await booted.clock.advance(1_100, 300);
      await a.next('raid:end');
      await settle(300);

      expect(booted.clock.pending, 'a retired raid arms nothing').toBe(0);
      // An hour of wall clock: a surviving recovery timer would re-enter and announce again.
      await booted.clock.advance(3_600_000, 200);
      expect(a.received('raid:end')).toHaveLength(1);
      expect(b.received('raid:end')).toHaveLength(1);
      expect(await totalCoins(everyone)).toBe(before);
      expect(await coinsOf(one.characterId)).toBe(24);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('arms nothing after a plain, fully successful raid either', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'L7pa', 20);
      const two = await makePlayer(booted.app, 'L7pb', 20);
      const target = await makePlayer(booted.app, 'L7pt', 8);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      await a.next('raid:result');
      const window = await a.next('raid:betrayal_window');
      for (const client of [a, b]) client.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      await a.next('raid:end');
      await settle(300);
      expect(booted.clock.pending).toBe(0);
      await booted.clock.advance(3_600_000, 150);
      expect(a.received('raid:end')).toHaveLength(1);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

/* ==================================================================== *
 * LOW-8 / LOW-9 — lock frames carry their real phase; reveal is silent
 * ==================================================================== */

describe('LOW-8: a lock frame names the window it was made in', () => {
  it('attributes betrayal locks and parity locks to their own phases, without leaking the choice', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'L8a', 4);
      const two = await makePlayer(booted.app, 'L8b', 4);
      const three = await makePlayer(booted.app, 'L8c', 4);
      const target = await makePlayer(booted.app, 'L8t', 11);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      const c = await TestClient.connect(booted.baseUrl, three.accessToken);
      clients.push(a, b, c);

      const raidId = await assemble(a, [b, c], target.characterId, [two.characterId, three.characterId]);
      await a.next('raid:result');
      const window = await a.next('raid:betrayal_window');

      a.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      const betrayalLock = await b.next('raid:betrayal_locked');
      expect(betrayalLock.phase).toBe('betrayal');
      expect(betrayalLock.seq).toBe(window.seq);
      expect(betrayalLock.characterId).toBe(one.characterId);
      expect(
        JSON.stringify(betrayalLock),
        'the fact of a lock, never the choice',
      ).not.toMatch(/loyal|"choice"/);

      // All loyal, so 12 + 11 = 23 over three leaves a remainder and the parity game opens.
      for (const client of [b, c]) client.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      await a.next('raid:betrayal_result');
      await booted.clock.advance(100, 150);
      const round = await a.next('raid:parity_round');
      expect(round.round).toBe(1);

      const contender = round.contenders[0]!;
      const speaker = [a, b, c][[one, two, three].findIndex((p) => p.characterId === contender)]!;
      const listener = [a, b, c].find((client) => client !== speaker)!;
      speaker.send({ type: 'raid:parity', raidId, seq: round.seq, call: 'odds', throw: 3 });

      const parityLock = await listener.next('raid:betrayal_locked', (m) => m.phase === 'parity');
      expect(parityLock.phase).toBe('parity');
      expect(parityLock.seq).toBe(round.seq);
      expect(parityLock.characterId).toBe(contender);
      expect(JSON.stringify(parityLock), 'no call and no throw').not.toMatch(/odds|evens|throw/);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('replays the locks of an open parity window to a raider who reconnects into it', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'L8ra', 4);
      const two = await makePlayer(booted.app, 'L8rb', 4);
      const three = await makePlayer(booted.app, 'L8rc', 4);
      const target = await makePlayer(booted.app, 'L8rt', 11);

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

      // A throws; C then drops and comes back, and must be shown that A is already locked.
      a.send({ type: 'raid:parity', raidId, seq: round.seq, call: 'evens', throw: 2 });
      await b.next('raid:betrayal_locked', (m) => m.phase === 'parity');

      c.close();
      await settle(150);
      const back = await TestClient.connect(booted.baseUrl, three.accessToken);
      clients.push(back);
      await settle(300);

      const replayedRound = back.received('raid:parity_round');
      expect(replayedRound, 'the open window is replayed, not a stale one').toHaveLength(1);
      expect(replayedRound[0]!.round).toBe(round.round);
      const replayedLocks = back.received('raid:betrayal_locked');
      expect(replayedLocks.map((frame) => frame.characterId)).toContain(one.characterId);
      expect(replayedLocks.every((frame) => frame.phase === 'parity')).toBe(true);
      expect(back.transcript(), 'no call or throw leaks through the replay').not.toMatch(/"call"/);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

describe('LOW-9: the reveal beat says nothing', () => {
  it('tells a raider who resyncs between two windows nothing at all', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'L9a', 4);
      const two = await makePlayer(booted.app, 'L9b', 4);
      const three = await makePlayer(booted.app, 'L9c', 4);
      const target = await makePlayer(booted.app, 'L9t', 11);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      const c = await TestClient.connect(booted.baseUrl, three.accessToken);
      clients.push(a, b, c);

      const raidId = await assemble(a, [b, c], target.characterId, [two.characterId, three.characterId]);
      await a.next('raid:result');
      const window = await a.next('raid:betrayal_window');
      for (const client of [a, b, c]) client.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      await a.next('raid:betrayal_result');

      // The reveal beat: the betrayal window is closed and no parity window is open yet.
      const roundsBefore = a.received('raid:parity_round').length;
      const windowsBefore = a.received('raid:betrayal_window').length;
      a.send({ type: 'raid:resync' });
      await settle(300);

      expect(
        a.received('raid:parity_round'),
        'a resync in the reveal beat must not invent a round',
      ).toHaveLength(roundsBefore);
      expect(a.received('raid:betrayal_window')).toHaveLength(windowsBefore);
      expect(
        a.received('raid:parity_round').some((frame) => frame.round === 0),
        'no round: 0 frame may ever be sent',
      ).toBe(false);

      // And the next real window arrives on its own, exactly once.
      await booted.clock.advance(100, 200);
      const round = await a.next('raid:parity_round');
      expect(round.round).toBe(1);
      expect(a.received('raid:parity_round')).toHaveLength(roundsBefore + 1);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

/* ==================================================================== *
 * LOW-10 — the appeal cooldown is a row, not a process
 * ==================================================================== */

async function appealCount(nickname: string): Promise<number> {
  const result = await db.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM chat_messages WHERE body = $1',
    [`${nickname} is begging for coins.`],
  );
  return Number(result.rows[0]!.count);
}

describe('LOW-10: the donation appeal cooldown survives the process', () => {
  it('still refuses a second appeal after the serving instance is replaced', async () => {
    const first = await boot();
    const second = await boot();
    try {
      const beggar = await makePlayer(first.app, 'L10a', 0);

      const one = await first.app.inject(authed(beggar, { method: 'POST', url: '/api/v1/appeals' }));
      expect(one.statusCode, one.body).toBe(201);
      expect(await appealCount(beggar.nickname)).toBe(1);

      const row = await db.query<{ last_donation_appeal_at: Date | null }>(
        'SELECT last_donation_appeal_at FROM characters WHERE id = $1',
        [beggar.characterId],
      );
      expect(row.rows[0]!.last_donation_appeal_at, 'the floor is written to the row').not.toBeNull();

      // A different app object with its own limiter set: the old in-process window is gone.
      const again = await second.app.inject(authed(beggar, { method: 'POST', url: '/api/v1/appeals' }));
      expect(again.statusCode, 'a deploy must not hand out a fresh appeal').toBe(429);
      expect(await appealCount(beggar.nickname)).toBe(1);
    } finally {
      await second.close();
      await first.close();
    }
  });

  it('lets exactly one of two racing instances post the appeal', async () => {
    const first = await boot();
    const second = await boot();
    try {
      const beggar = await makePlayer(first.app, 'L10r', 0);

      const [a, b] = await Promise.all([
        first.app.inject(authed(beggar, { method: 'POST', url: '/api/v1/appeals' })),
        second.app.inject(authed(beggar, { method: 'POST', url: '/api/v1/appeals' })),
      ]);

      const codes = [a.statusCode, b.statusCode].sort();
      expect(codes, 'one poster, one refusal').toEqual([201, 429]);
      expect(await appealCount(beggar.nickname), 'one line in the Town Square').toBe(1);
    } finally {
      await second.close();
      await first.close();
    }
  });

  it('holds the 3h window, and opens again on the far side of it', async () => {
    const booted = await boot();
    try {
      const beggar = await makePlayer(booted.app, 'L10w', 0);

      await db.query(
        `UPDATE characters SET last_donation_appeal_at = now() - interval '2 hours 59 minutes' WHERE id = $1`,
        [beggar.characterId],
      );
      const early = await booted.app.inject(authed(beggar, { method: 'POST', url: '/api/v1/appeals' }));
      expect(early.statusCode, 'still inside the 3h floor').toBe(429);
      expect(await appealCount(beggar.nickname)).toBe(0);

      await db.query(
        `UPDATE characters SET last_donation_appeal_at = now() - interval '3 hours 1 minute' WHERE id = $1`,
        [beggar.characterId],
      );
      const late = await booted.app.inject(authed(beggar, { method: 'POST', url: '/api/v1/appeals' }));
      expect(late.statusCode, late.body).toBe(201);
      expect(await appealCount(beggar.nickname)).toBe(1);
    } finally {
      await booted.close();
    }
  });

  it('refuses an appeal from somebody who is not a beggar, without spending the window', async () => {
    const booted = await boot();
    try {
      const rich = await makePlayer(booted.app, 'L10n', 12);
      const refused = await booted.app.inject(authed(rich, { method: 'POST', url: '/api/v1/appeals' }));
      expect(refused.statusCode).toBe(409);

      await db.query('UPDATE characters SET lethal_coins = 0 WHERE id = $1', [rich.characterId]);
      const allowed = await booted.app.inject(authed(rich, { method: 'POST', url: '/api/v1/appeals' }));
      expect(allowed.statusCode, allowed.body).toBe(201);
    } finally {
      await booted.close();
    }
  });
});

/* ==================================================================== *
 * LOW-11 — the aftermath is sticky until the client says it was shown
 * ==================================================================== */

describe('LOW-11: aftermath delivery is acknowledged, not assumed', () => {
  it('still reaches a target who dropped mid-delivery, arbitrarily far in the future', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'L11a', 20);
      const two = await makePlayer(booted.app, 'L11b', 20);
      const target = await makePlayer(booted.app, 'L11t', 9);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      const t = await TestClient.connect(booted.baseUrl, target.accessToken);
      clients.push(a, b, t);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      await a.next('raid:result');
      const first = await t.next('raid:aftermath');
      expect(first.raidId).toBe(raidId);

      // The socket drops before the client ever displayed it: no ack was sent.
      t.close();
      await settle(150);
      expect((await raidRow(raidId)).aftermath_acked_at, 'a send is not an acknowledgment').toBeNull();

      // Thirty days later.
      await db.query(
        `UPDATE raids SET created_at = created_at - interval '30 days', ended_at = ended_at - interval '30 days'
         WHERE id = $1`,
        [raidId],
      );
      const back = await TestClient.connect(booted.baseUrl, target.accessToken);
      clients.push(back);
      const redelivered = await back.next('raid:aftermath');
      expect(redelivered.raidId, 'the report waits however long it has to').toBe(raidId);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('refuses an ack forged by a raider for somebody else’s aftermath', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'L11fa', 20);
      const two = await makePlayer(booted.app, 'L11fb', 20);
      const target = await makePlayer(booted.app, 'L11ft', 9);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      const t = await TestClient.connect(booted.baseUrl, target.accessToken);
      clients.push(a, b, t);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      await a.next('raid:result');
      await t.next('raid:aftermath');

      // A raider tries to burn the victim's one notification.
      a.send({ type: 'raid:aftermath_ack', raidId });
      await settle(300);
      expect(
        (await raidRow(raidId)).aftermath_acked_at,
        'only the target may acknowledge their own aftermath',
      ).toBeNull();

      t.close();
      await settle(150);
      const back = await TestClient.connect(booted.baseUrl, target.accessToken);
      clients.push(back);
      const redelivered = await back.next('raid:aftermath');
      expect(redelivered.raidId).toBe(raidId);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('stops re-showing the report once the target acknowledges it', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'L11ka', 20);
      const two = await makePlayer(booted.app, 'L11kb', 20);
      const target = await makePlayer(booted.app, 'L11kt', 9);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      const t = await TestClient.connect(booted.baseUrl, target.accessToken);
      clients.push(a, b, t);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      await a.next('raid:result');
      await t.next('raid:aftermath');

      t.send({ type: 'raid:aftermath_ack', raidId });
      await settle(300);
      expect((await raidRow(raidId)).aftermath_acked_at).not.toBeNull();

      t.close();
      await settle(150);
      const back = await TestClient.connect(booted.baseUrl, target.accessToken);
      clients.push(back);
      await settle(400);
      back.send({ type: 'raid:resync' });
      await settle(400);
      expect(
        back.received('raid:aftermath'),
        'sticky until seen, not sticky forever',
      ).toHaveLength(0);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

/* ==================================================================== *
 * Round-1 confirmed-solid set — re-verified, not assumed
 * ==================================================================== */

describe('round-1 regression set is still intact', () => {
  it('keeps every betrayal choice off the wire until the reveal frame', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'R1ha', 4);
      const two = await makePlayer(booted.app, 'R1hb', 4);
      const three = await makePlayer(booted.app, 'R1hc', 4);
      const target = await makePlayer(booted.app, 'R1ht', 11);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      const c = await TestClient.connect(booted.baseUrl, three.accessToken);
      clients.push(a, b, c);

      const raidId = await assemble(a, [b, c], target.characterId, [two.characterId, three.characterId]);
      await a.next('raid:result');
      const window = await a.next('raid:betrayal_window');

      a.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'betray' });
      b.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      await c.next('raid:betrayal_locked', (m) => m.characterId === two.characterId);
      await settle(200);

      // C has not answered yet, so the window is still open and nothing may be revealed.
      expect(c.received('raid:betrayal_result'), 'the window is still open').toHaveLength(0);
      expect(
        c.transcript(),
        'no choice may reach a raider who has not yet committed their own',
      ).not.toMatch(/"choice"|"betray"|"loyal"/);
      // A resync mid-window must not open the envelope either.
      c.send({ type: 'raid:resync' });
      await settle(300);
      expect(c.transcript()).not.toMatch(/"choice"|"betray"|"loyal"/);

      c.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      const reveal = await c.next('raid:betrayal_result');
      expect(reveal.choices).toHaveLength(3);
      expect(c.transcript(), 'and only then').toMatch(/"choice"/);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('terminates a genuine parity stalemate at the five-round cap with a seeded split', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'R1pa', 4);
      const two = await makePlayer(booted.app, 'R1pb', 4);
      const three = await makePlayer(booted.app, 'R1pc', 4);
      const target = await makePlayer(booted.app, 'R1pt', 11);
      const everyone = [one.characterId, two.characterId, three.characterId, target.characterId];
      const before = await totalCoins(everyone);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      const c = await TestClient.connect(booted.baseUrl, three.accessToken);
      clients.push(a, b, c);

      const raidId = await assemble(a, [b, c], target.characterId, [two.characterId, three.characterId]);
      await a.next('raid:result');
      const window = await a.next('raid:betrayal_window');
      for (const client of [a, b, c]) client.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      await a.next('raid:betrayal_result');

      /**
       * The one case the termination argument does not cover: everybody calls correctly
       * every round, so the remainder divides among all three, shrinks nobody, and repeats.
       */
      let round = 0;
      for (let step = 0; step < 6; step += 1) {
        await booted.clock.advance(100, 200);
        const frame = a.received('raid:parity_round').at(-1);
        if (!frame || frame.round === round) break;
        round = frame.round;
        for (const client of [a, b, c]) {
          client.send({ type: 'raid:parity', raidId, seq: frame.seq, call: 'evens', throw: 2 });
        }
        await a.next('raid:parity_result', (m) => m.round === round);
      }

      const results = a.received('raid:parity_result');
      expect(results.at(-1)!.round, 'the cap ends it at five').toBe(5);
      expect(results.at(-1)!.seededSplit, 'and ends it with the seeded split').toBe(true);
      expect(results.filter((frame) => frame.seededSplit)).toHaveLength(1);

      await a.next('raid:end');
      await settle(300);
      expect((await raidRow(raidId)).state).toBe('complete');
      expect(await totalCoins(everyone), 'the whole pot lands, to the coin').toBe(before);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('commits exactly one of five donations racing to rescue the same beggar', async () => {
    const booted = await boot();
    try {
      const beggar = await makePlayer(booted.app, 'R1db', 0);
      const givers = [];
      for (let index = 0; index < 5; index += 1) {
        givers.push(await makePlayer(booted.app, `R1dg${index}`, 6));
      }
      const everyone = [beggar.characterId, ...givers.map((giver) => giver.characterId)];
      const before = await totalCoins(everyone);

      const responses = await Promise.all(
        givers.map((giver) =>
          booted.app.inject(
            authed(giver, {
              method: 'POST',
              url: '/api/v1/donations',
              payload: { toCharacterId: beggar.characterId, coins: 3 },
            }),
          ),
        ),
      );

      const created = responses.filter((response) => response.statusCode === 201);
      expect(created, 'a bankruptcy is rescuable exactly once').toHaveLength(1);
      for (const response of responses.filter((r) => r.statusCode !== 201)) {
        expect(response.json().error.code).toBe('NOT_A_BEGGAR');
      }
      expect(await coinsOf(beggar.characterId)).toBe(3);
      expect(await totalCoins(everyone), 'a donation moves coins, it does not mint them').toBe(before);

      const rows = await db.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM donations WHERE to_character_id = $1',
        [beggar.characterId],
      );
      expect(Number(rows.rows[0]!.count)).toBe(1);
    } finally {
      await booted.close();
    }
  });

  it('still bands every wallet on the duel cards surface', async () => {
    const booted = await boot();
    try {
      const secret = 8_837;
      const viewer = await makePlayer(booted.app, 'R1ca', 12);
      const rich = await makePlayer(booted.app, 'R1cb', secret);

      const response = await booted.app.inject(
        authed(viewer, { method: 'GET', url: `/api/v1/duels/cards?characterIds=${rich.characterId}` }),
      );
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body, 'no exact balance on the public card').not.toContain(String(secret));

      const card = response.json().cards.find((entry: { characterId: string }) => entry.characterId === rich.characterId);
      expect(card, 'the rich player is listed').toBeTruthy();
      expect(card.wealthBand).toBe('wealthy');
      expect(Object.keys(card)).not.toContain('lethalCoins');
    } finally {
      await booted.close();
    }
  });
});

/* ==================================================================== *
 * NEW round-2 findings
 *
 * These two are EXPECTED TO FAIL against the current implementation. They are the repro
 * evidence for the round-2 bug report and should go green with the fix, not be relaxed.
 * ==================================================================== */

describe('NEW-A: a wallet escrowed in another raid is not a wealth reading', () => {
  it('does not settle a raid against a target whose coins are staked in a raid of their own', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      /**
       * X is rich, and is simultaneously the target of one raid and a raider in another.
       * Being a target does not take the engagement lock (by design — that would be a
       * consent gate), so this needs no collusion at all: it is what happens whenever two
       * raids overlap on one player.
       */
      const x = await makePlayer(booted.app, 'NAx', 500);
      const ally = await makePlayer(booted.app, 'NAal', 5);
      const otherVictim = await makePlayer(booted.app, 'NAov', 30);
      const raiderOne = await makePlayer(booted.app, 'NAr1', 10);
      const raiderTwo = await makePlayer(booted.app, 'NAr2', 10);

      const cx = await TestClient.connect(booted.baseUrl, x.accessToken);
      const ca = await TestClient.connect(booted.baseUrl, ally.accessToken);
      const c1 = await TestClient.connect(booted.baseUrl, raiderOne.accessToken);
      const c2 = await TestClient.connect(booted.baseUrl, raiderTwo.accessToken);
      clients.push(cx, ca, c1, c2);

      // A party of two (20 coins between them) opens on X, who visibly holds 500.
      c1.send({ type: 'raid:create', targetCharacterId: x.characterId });
      const party = await c1.next('raid:party');
      c1.send({ type: 'raid:invite', raidId: party.raidId, characterId: raiderTwo.characterId });
      const invited = await c2.next('raid:invited');
      c2.send({ type: 'raid:respond', raidId: invited.raidId, accept: true });
      await c1.next('raid:party', (m) => m.members.filter((y) => y.state === 'joined').length === 2);

      // X locks in a raid of their own during the assembly window, escrowing all 500.
      await assemble(cx, [ca], otherVictim.characterId, [ally.characterId]);
      await cx.next('raid:result');
      expect(await coinsOf(x.characterId), 'X’s 500 are in escrow, not spent').toBe(0);

      c1.send({ type: 'raid:lock', raidId: party.raidId });
      await settle(400);

      /**
       * Nothing has been compared yet: X is staked in a raid of their own, which is the same
       * misrepresentative wallet the seated/duelling defer exists for.
       */
      expect(
        c1.received('raid:result'),
        'a target whose coins are staked in their own raid must not be settled against',
      ).toHaveLength(0);

      // X's raid runs to payout, their coins come home, and the deferred raid polls again.
      for (let tick = 0; tick < 8; tick += 1) await booted.clock.advance(15_000, 200);

      const result = await c1.next('raid:result');
      await settle(400);

      /**
       * 20 against 500 is a target win — the raiders lose their escrow to X. Before the fix
       * the settlement compared 20 against the escrowed 0 and inverted the outcome.
       */
      expect(
        result.outcome,
        '20 coins must not beat a 500-coin target just because the 500 are in escrow',
      ).not.toBe('raiders_won');
      // And it is a real comparison against X's returned wallet, not a void.
      expect(result.outcome).toBe('target_won');
      const row = await raidRow(party.raidId);
      expect(row.outcome).not.toBe('raiders_won');

      const member = await db.query<{ bankrupted_in_raid: boolean }>(
        'SELECT bankrupted_in_raid FROM raid_members WHERE raid_id = $1 AND character_id = $2',
        [party.raidId, x.characterId],
      );
      expect(
        member.rows[0]?.bankrupted_in_raid ?? false,
        'X must not be recorded bankrupt while holding 500 coins',
      ).toBe(false);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

describe('NEW-B: an escrowed raider is not a beggar', () => {
  it('refuses an appeal and a donation from a raider whose wallet is staked in a live raid', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const rich = await makePlayer(booted.app, 'NBr', 500);
      const mate = await makePlayer(booted.app, 'NBm', 5);
      const victim = await makePlayer(booted.app, 'NBv', 30);
      const donor = await makePlayer(booted.app, 'NBd', 50);

      const cr = await TestClient.connect(booted.baseUrl, rich.accessToken);
      const cm = await TestClient.connect(booted.baseUrl, mate.accessToken);
      clients.push(cr, cm);

      await assemble(cr, [cm], victim.characterId, [mate.characterId]);
      await cr.next('raid:result');
      await cr.next('raid:betrayal_window');
      expect(await coinsOf(rich.characterId), 'a raid stakes the whole wallet').toBe(0);

      // The wallet reads zero, but 500 coins are coming back the moment the pot lands.
      const appeal = await booted.app.inject(authed(rich, { method: 'POST', url: '/api/v1/appeals' }));
      expect(
        appeal.statusCode,
        'a raider mid-raid is not destitute, and must not beg in the Town Square',
      ).not.toBe(201);

      const donation = await booted.app.inject(
        authed(donor, {
          method: 'POST',
          url: '/api/v1/donations',
          payload: { toCharacterId: rich.characterId, coins: 5 },
        }),
      );
      expect(
        donation.statusCode,
        'the one-rescue property must not be farmable by escrowing a wallet',
      ).not.toBe(201);
      expect(await coinsOf(rich.characterId), 'and no coin landed on the escrowed wallet').toBe(0);

      /**
       * The two surfaces the badge is derived from: the raider's own character, and the card
       * every other player sees them through. Neither may call an escrowed wallet a beggar.
       */
      const me = await booted.app.inject(authed(rich, { method: 'GET', url: '/api/v1/me' }));
      expect(me.json().character).toMatchObject({ lethalCoins: 0, isBeggar: false });

      const cards = await booted.app.inject(
        authed(donor, { method: 'GET', url: `/api/v1/duels/cards?characterIds=${rich.characterId}` }),
      );
      expect(cards.json().cards[0]).toMatchObject({ characterId: rich.characterId, isBeggar: false });
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});
