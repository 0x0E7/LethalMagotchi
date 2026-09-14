/**
 * QA round-3 re-verification for raid mode, written independently of `raid-round2.test.ts`
 * so the round-3 fixes have to satisfy a second, separately-constructed reproduction of the
 * round-2 findings (NEW-A, NEW-B) rather than only the developer's own test.
 *
 * Every test reproduces the *original failure* and then pushes past it into the boundary the
 * fix claims to hold: for NEW-A, that a deferred raid goes on to settle correctly against the
 * wallet that comes home; for NEW-B, that the beggar state is hidden during a raid and real
 * again the moment the raid ends on a genuinely empty wallet.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ChatService } from '../../src/chat/service.js';
import type { Db, DbClient } from '../../src/db/pool.js';
import type { Limiters } from '../../src/deps.js';
import { RaidService } from '../../src/raid/service.js';
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
  close: () => Promise<void>;
}

let db: Db;

beforeAll(() => {
  db = testPool();
});

afterAll(async () => {
  await closeTestPool();
});

async function boot(
  options: {
    db?: Db;
    busyDeferMs?: number;
    busyPollMs?: number;
    settlementRecoveryDelaysMs?: number[];
  } = {},
): Promise<Booted> {
  const pool = options.db ?? testPool();
  const hub = new Hub();
  const limiters: Limiters = relaxedLimiters();
  const chat = new ChatService({ db: testPool(), hub, limiters });
  const clock = new ManualClock(Date.now());
  const raids = new RaidService({
    db: pool,
    hub,
    limiters,
    clock,
    revealMs: 50,
    betrayalMs: 5_000,
    parityMs: 5_000,
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
  const account = await registerAccount(app, { username: uniqueUsername('r3') });
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

async function activeRaidOf(characterId: string): Promise<string | null> {
  const result = await db.query<{ active_raid_id: string | null }>(
    'SELECT active_raid_id FROM characters WHERE id = $1',
    [characterId],
  );
  return result.rows[0]!.active_raid_id;
}

async function raidRow(raidId: string): Promise<{ state: string; outcome: string | null }> {
  const result = await db.query<{ state: string; outcome: string | null }>(
    'SELECT state, outcome FROM raids WHERE id = $1',
    [raidId],
  );
  return result.rows[0]!;
}

async function memberRow(
  raidId: string,
  characterId: string,
): Promise<{ coins_received: number | null; bankrupted_in_raid: boolean; pot_coins_at_lock: number | null }> {
  const result = await db.query<{
    coins_received: number | null;
    bankrupted_in_raid: boolean;
    pot_coins_at_lock: number | null;
  }>(
    'SELECT coins_received, bankrupted_in_raid, pot_coins_at_lock FROM raid_members WHERE raid_id = $1 AND character_id = $2',
    [raidId, characterId],
  );
  return result.rows[0]!;
}

async function totalCoins(ids: string[]): Promise<number> {
  const result = await db.query<{ total: string }>(
    'SELECT COALESCE(SUM(lethal_coins), 0)::text AS total FROM characters WHERE id = ANY($1::uuid[])',
    [ids],
  );
  return Number(result.rows[0]!.total);
}

/** Assembles a party without locking it in, returning the raid id. */
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
    await initiator.next(
      'raid:party',
      (message) => message.members.filter((member) => member.state === 'joined').length === index + 2,
    );
  }
  return party.raidId;
}

/* ==================================================================== *
 * NEW-A — a target escrowed as a raider elsewhere
 * ==================================================================== */

describe('NEW-A: the target’s own raid lock', () => {
  it('defers, then settles against the wallet that comes home rather than the escrowed zero', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      // X holds 500 and is about to become a raider in a raid of their own.
      const x = await makePlayer(booted.app, 'A1x', 500);
      const ally = await makePlayer(booted.app, 'A1al', 6);
      const victim = await makePlayer(booted.app, 'A1v', 30);
      const raiderOne = await makePlayer(booted.app, 'A1r1', 12);
      const raiderTwo = await makePlayer(booted.app, 'A1r2', 8);
      const everyone = [x, ally, victim, raiderOne, raiderTwo].map((player) => player.characterId);
      const before = await totalCoins(everyone);

      const cx = await TestClient.connect(booted.baseUrl, x.accessToken);
      const ca = await TestClient.connect(booted.baseUrl, ally.accessToken);
      const c1 = await TestClient.connect(booted.baseUrl, raiderOne.accessToken);
      const c2 = await TestClient.connect(booted.baseUrl, raiderTwo.accessToken);
      clients.push(cx, ca, c1, c2);

      // A poor party of two (20 coins between them) forms up on X, who visibly holds 500.
      const attack = await assemble(c1, [c2], x.characterId, [raiderTwo.characterId]);

      // X locks a raid of their own first, escrowing the whole 500.
      const own = await assemble(cx, [ca], victim.characterId, [ally.characterId]);
      cx.send({ type: 'raid:lock', raidId: own });
      await cx.next('raid:result');
      expect(await coinsOf(x.characterId), 'X’s 500 are in escrow, not spent').toBe(0);
      expect(await activeRaidOf(x.characterId), 'X holds the raider leg of the engagement lock').toBe(own);

      c1.send({ type: 'raid:lock', raidId: attack });
      await settle(400);

      expect(
        c1.received('raid:result'),
        'a target staked in a raid of their own must not be compared against an escrowed zero',
      ).toHaveLength(0);
      expect((await raidRow(attack)).state, 'the attacking raid waits in `resolving`').toBe('resolving');
      expect(await coinsOf(raiderOne.characterId), 'the attackers’ escrow is untouched while deferred').toBe(0);

      // X's raid runs betrayal -> payout, their share lands, the lock clears, and the poll fires.
      await booted.clock.advance(60_000, 250);

      const result = await c1.next('raid:result');
      await settle(400);

      // X + ally took 506 of escrow and the victim's 30; both stayed loyal, so 536 split evenly.
      expect(await activeRaidOf(x.characterId), 'X’s own raid released the lock').toBeNull();
      expect(
        result.outcome,
        '20 coins must not beat a target whose real wallet is 268 just because it was in escrow',
      ).toBe('target_won');
      expect((await raidRow(attack)).outcome).toBe('target_won');
      expect(await coinsOf(x.characterId), 'X keeps their payout and takes the attackers’ 20').toBe(288);
      expect(await coinsOf(raiderOne.characterId)).toBe(0);
      expect(await coinsOf(raiderTwo.characterId)).toBe(0);
      expect(
        (await memberRow(attack, raiderOne.characterId)).bankrupted_in_raid,
        'the attackers, not the target, are the ones bankrupted',
      ).toBe(true);
      expect(await totalCoins(everyone), 'no coin was created or destroyed').toBe(before);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('does not defer for a target who is merely invited to another raid and holds no lock', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const x = await makePlayer(booted.app, 'A2x', 40);
      const stranger = await makePlayer(booted.app, 'A2s', 50);
      const bystander = await makePlayer(booted.app, 'A2b', 50);
      const raiderOne = await makePlayer(booted.app, 'A2r1', 60);
      const raiderTwo = await makePlayer(booted.app, 'A2r2', 60);

      const cx = await TestClient.connect(booted.baseUrl, x.accessToken);
      const cs = await TestClient.connect(booted.baseUrl, stranger.accessToken);
      const c1 = await TestClient.connect(booted.baseUrl, raiderOne.accessToken);
      const c2 = await TestClient.connect(booted.baseUrl, raiderTwo.accessToken);
      clients.push(cx, cs, c1, c2);

      // X is pulled into somebody else's party as an invitee and never answers: an invite is
      // not a commitment, so X takes no engagement lock and their wallet still means what it says.
      cs.send({ type: 'raid:create', targetCharacterId: bystander.characterId });
      const other = await cs.next('raid:party');
      cs.send({ type: 'raid:invite', raidId: other.raidId, characterId: x.characterId });
      await cx.next('raid:invited');
      expect(await activeRaidOf(x.characterId), 'an unanswered invite takes no lock').toBeNull();

      const attack = await assemble(c1, [c2], x.characterId, [raiderTwo.characterId]);
      c1.send({ type: 'raid:lock', raidId: attack });

      // No clock advance at all: an undeferred settlement lands on its own.
      const result = await c1.next('raid:result');
      expect(result.outcome, '120 against 40 is a raiders’ win, settled immediately').toBe('raiders_won');
      expect(await coinsOf(x.characterId), 'the target was drained by a raid that never deferred').toBe(0);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('voids at the ten-minute ceiling when the target’s own raid never resolves', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const x = await makePlayer(booted.app, 'A3x', 500);
      const filler = await makePlayer(booted.app, 'A3f', 40);
      const raiderOne = await makePlayer(booted.app, 'A3r1', 12);
      const raiderTwo = await makePlayer(booted.app, 'A3r2', 8);
      const everyone = [x, filler, raiderOne, raiderTwo].map((player) => player.characterId);
      const before = await totalCoins(everyone);

      const c1 = await TestClient.connect(booted.baseUrl, raiderOne.accessToken);
      const c2 = await TestClient.connect(booted.baseUrl, raiderTwo.accessToken);
      clients.push(c1, c2);

      /**
       * A raid of X's own that is wedged in the betrayal phase with no runner behind it —
       * the shape a raid is left in when the process that was playing it died between the
       * settlement and the boot sweep. X holds the raider lock and nothing will ever clear it.
       */
      const stuckRaidId = randomUUID();
      await db.query(
        `INSERT INTO raids (id, initiator_character_id, target_character_id, state, raider_pot_coins, parity_seed, created_at, locked_at)
         VALUES ($1, $2, $3, 'betrayal', 500, 'stuck-seed', now(), now())`,
        [stuckRaidId, x.characterId, filler.characterId],
      );
      await db.query('UPDATE characters SET active_raid_id = $2 WHERE id = $1', [x.characterId, stuckRaidId]);

      const attack = await assemble(c1, [c2], x.characterId, [raiderTwo.characterId]);
      c1.send({ type: 'raid:lock', raidId: attack });
      await settle(400);
      expect(c1.received('raid:result'), 'nothing is settled while the target stays locked').toHaveLength(0);

      // Halfway to the ceiling: still deferring, still silent, still nobody's coins moved.
      await booted.clock.advance(300_000, 60);
      expect(c1.received('raid:result'), 'the defer is a wait, not a decision').toHaveLength(0);
      expect(await coinsOf(x.characterId), 'and the target’s wallet is never touched by a defer').toBe(500);

      // Past the ten-minute ceiling.
      await booted.clock.advance(400_000, 60);
      const result = await c1.next('raid:result');
      await settle(400);

      expect(result.outcome, 'a target who never comes free voids the raid').toBe('void');
      expect((await raidRow(attack)).outcome).toBe('void');
      expect(await coinsOf(x.characterId), 'the target keeps every coin').toBe(500);
      expect(await coinsOf(raiderOne.characterId), 'and every escrow goes home').toBe(12);
      expect(await coinsOf(raiderTwo.characterId)).toBe(8);
      expect((await memberRow(attack, raiderOne.characterId)).bankrupted_in_raid).toBe(false);
      expect(await activeRaidOf(raiderOne.characterId), 'the attackers’ locks are released').toBeNull();
      expect(await totalCoins(everyone), 'no coin was created or destroyed').toBe(before);

      await db.query('UPDATE characters SET active_raid_id = NULL WHERE id = $1', [x.characterId]);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('never settles against a target who takes the raid lock between the check and the row lock', async () => {
    const base = testPool();
    // The lock-in transaction lists the members first; the settlement transaction is the
    // second in-transaction reader, and that is the one to race.
    let seen = 0;
    let victimId = '';
    /**
     * The window the row-locked re-check exists for: the advisory read said the target was
     * free, and they lock into a raid of their own before the settlement transaction reaches
     * their row. Injected on the settlement's first statement, so the lock really is taken
     * before any character row is locked.
     */
    const racing = new Proxy(base, {
      get(target, prop) {
        if (prop !== 'connect') {
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        }
        return async (): Promise<DbClient> => {
          const client = await target.connect();
          return new Proxy(client, {
            get(clientTarget, clientProp) {
              if (clientProp !== 'query') {
                const value = Reflect.get(clientTarget, clientProp);
                return typeof value === 'function'
                  ? (value as (...args: unknown[]) => unknown).bind(clientTarget)
                  : value;
              }
              const query = (clientTarget.query as (t: unknown, v?: unknown[]) => Promise<unknown>).bind(
                clientTarget,
              );
              return async (text: unknown, values?: unknown[]) => {
                if (typeof text === 'string' && text.includes('FROM raid_members WHERE raid_id')) {
                  seen += 1;
                }
                if (seen === 2 && typeof text === 'string' && text.includes('FROM raid_members WHERE raid_id')) {
                  await base.query(
                    `UPDATE characters SET active_raid_id = (SELECT id FROM raids WHERE target_character_id = $1 LIMIT 1) WHERE id = $1`,
                    [victimId],
                  );
                }
                return query(text, values);
              };
            },
          }) as DbClient;
        };
      },
    }) as Db;

    const booted = await boot({ db: racing, settlementRecoveryDelaysMs: [50, 50, 50] });
    const clients: TestClient[] = [];
    try {
      const x = await makePlayer(booted.app, 'A4x', 400);
      const raiderOne = await makePlayer(booted.app, 'A4r1', 12);
      const raiderTwo = await makePlayer(booted.app, 'A4r2', 8);
      victimId = x.characterId;
      const everyone = [x, raiderOne, raiderTwo].map((player) => player.characterId);
      const before = await totalCoins(everyone);

      const c1 = await TestClient.connect(booted.baseUrl, raiderOne.accessToken);
      const c2 = await TestClient.connect(booted.baseUrl, raiderTwo.accessToken);
      clients.push(c1, c2);

      const attack = await assemble(c1, [c2], x.characterId, [raiderTwo.characterId]);
      c1.send({ type: 'raid:lock', raidId: attack });
      await settle(600);

      expect(
        c1.received('raid:result'),
        'a target who took the lock inside the transaction must not be settled against',
      ).toHaveLength(0);
      expect(await coinsOf(x.characterId), 'and their wallet is untouched').toBe(400);

      // The target comes free; the deferred settlement then makes a real comparison.
      await db.query('UPDATE characters SET active_raid_id = NULL WHERE id = $1', [x.characterId]);
      await booted.clock.advance(60_000, 120);
      await settle(400);

      const row = await raidRow(attack);
      expect(['target_won', 'void', 'cancelled'], `unexpected resolution ${row.state}/${row.outcome}`).toContain(
        row.outcome ?? row.state,
      );
      expect(row.outcome, 'a 20-coin party never beats a 400-coin wallet').not.toBe('raiders_won');
      expect(await coinsOf(x.characterId), 'the target was never drained').toBeGreaterThanOrEqual(400);
      expect(await totalCoins(everyone), 'no coin was created or destroyed').toBe(before);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

/* ==================================================================== *
 * NEW-B — an escrowed raider is not a beggar
 * ==================================================================== */

describe('NEW-B: escrow is not poverty', () => {
  it('hides the beggar state while the wallet is staked, on every surface that reports it', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const raider = await makePlayer(booted.app, 'B1r', 300);
      const mate = await makePlayer(booted.app, 'B1m', 40);
      const victim = await makePlayer(booted.app, 'B1v', 30);
      const donor = await makePlayer(booted.app, 'B1d', 50);

      const cr = await TestClient.connect(booted.baseUrl, raider.accessToken);
      const cm = await TestClient.connect(booted.baseUrl, mate.accessToken);
      clients.push(cr, cm);

      const own = await assemble(cr, [cm], victim.characterId, [mate.characterId]);
      cr.send({ type: 'raid:lock', raidId: own });
      await cr.next('raid:result');
      await cr.next('raid:betrayal_window');
      expect(await coinsOf(raider.characterId), 'a raid stakes the whole wallet').toBe(0);

      const appeal = await booted.app.inject(authed(raider, { method: 'POST', url: '/api/v1/appeals' }));
      expect(appeal.statusCode, 'an escrowed raider may not beg').toBe(409);
      expect(appeal.json().error.code).toBe('NOT_A_BEGGAR');
      expect(appeal.json().error.message, 'and is told why, specifically').toMatch(/raid/i);

      const donation = await booted.app.inject(
        authed(donor, {
          method: 'POST',
          url: '/api/v1/donations',
          payload: { toCharacterId: raider.characterId, coins: 5 },
        }),
      );
      expect(donation.statusCode, 'and may not be farmed for donations').toBe(409);
      expect(donation.json().error.message).toMatch(/raid/i);
      expect(await coinsOf(raider.characterId), 'the refused donation moved nothing').toBe(0);
      expect(await coinsOf(donor.characterId), 'and cost the donor nothing').toBe(50);

      const me = await booted.app.inject(authed(raider, { method: 'GET', url: '/api/v1/me' }));
      expect(me.json().character, 'the raider’s own view').toMatchObject({ lethalCoins: 0, isBeggar: false });

      const cards = await booted.app.inject(
        authed(donor, { method: 'GET', url: `/api/v1/duels/cards?characterIds=${raider.characterId}` }),
      );
      expect(cards.json().cards[0], 'the card every other player sees them through').toMatchObject({
        characterId: raider.characterId,
        isBeggar: false,
      });
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('becomes a real beggar the moment the raid ends on a genuinely empty wallet', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      // A party poorer than the target: they lose the lot, and are genuinely broke after.
      const raider = await makePlayer(booted.app, 'B2r', 6);
      const mate = await makePlayer(booted.app, 'B2m', 5);
      const target = await makePlayer(booted.app, 'B2t', 400);
      const donor = await makePlayer(booted.app, 'B2d', 50);

      const cr = await TestClient.connect(booted.baseUrl, raider.accessToken);
      const cm = await TestClient.connect(booted.baseUrl, mate.accessToken);
      clients.push(cr, cm);

      const own = await assemble(cr, [cm], target.characterId, [mate.characterId]);
      cr.send({ type: 'raid:lock', raidId: own });
      const result = await cr.next('raid:result');
      expect(result.outcome, '11 coins against 400').toBe('target_won');
      await settle(300);

      expect(await coinsOf(raider.characterId), 'the escrow is gone for real').toBe(0);
      expect(await activeRaidOf(raider.characterId), 'and the lock is released').toBeNull();

      const me = await booted.app.inject(authed(raider, { method: 'GET', url: '/api/v1/me' }));
      expect(me.json().character, 'a lost raid leaves a real beggar').toMatchObject({
        lethalCoins: 0,
        isBeggar: true,
      });

      const cards = await booted.app.inject(
        authed(donor, { method: 'GET', url: `/api/v1/duels/cards?characterIds=${raider.characterId}` }),
      );
      expect(cards.json().cards[0]).toMatchObject({ characterId: raider.characterId, isBeggar: true });

      const appeal = await booted.app.inject(authed(raider, { method: 'POST', url: '/api/v1/appeals' }));
      expect(appeal.statusCode, 'they may ask the Town Square again').toBe(201);

      const donation = await booted.app.inject(
        authed(donor, {
          method: 'POST',
          url: '/api/v1/donations',
          payload: { toCharacterId: raider.characterId, coins: 5 },
        }),
      );
      expect(donation.statusCode, 'and may actually be rescued').toBe(201);
      expect(await coinsOf(raider.characterId)).toBe(5);

      // The one-rescue property still holds: the first coin ends the beggar state.
      const second = await booted.app.inject(
        authed(donor, {
          method: 'POST',
          url: '/api/v1/donations',
          payload: { toCharacterId: raider.characterId, coins: 5 },
        }),
      );
      expect(second.statusCode, 'a rescued character may not be rescued twice').toBe(409);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('still refuses a donation from a sender whose own wallet is staked in a raid', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const raider = await makePlayer(booted.app, 'B3r', 300);
      const mate = await makePlayer(booted.app, 'B3m', 40);
      const victim = await makePlayer(booted.app, 'B3v', 30);
      const beggar = await makePlayer(booted.app, 'B3b', 0);

      const cr = await TestClient.connect(booted.baseUrl, raider.accessToken);
      const cm = await TestClient.connect(booted.baseUrl, mate.accessToken);
      clients.push(cr, cm);

      const own = await assemble(cr, [cm], victim.characterId, [mate.characterId]);
      cr.send({ type: 'raid:lock', raidId: own });
      await cr.next('raid:result');

      const donation = await booted.app.inject(
        authed(raider, {
          method: 'POST',
          url: '/api/v1/donations',
          payload: { toCharacterId: beggar.characterId, coins: 1 },
        }),
      );
      expect(donation.statusCode, 'escrowed coins cannot also be given away').toBe(402);
      expect(await coinsOf(beggar.characterId), 'and nothing reached the beggar').toBe(0);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('keeps the raid lock and the duel lock mutually exclusive', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const raider = await makePlayer(booted.app, 'B4r', 300);
      const mate = await makePlayer(booted.app, 'B4m', 40);
      const victim = await makePlayer(booted.app, 'B4v', 30);
      const challenger = await makePlayer(booted.app, 'B4c', 100);

      const cr = await TestClient.connect(booted.baseUrl, raider.accessToken);
      const cm = await TestClient.connect(booted.baseUrl, mate.accessToken);
      const cc = await TestClient.connect(booted.baseUrl, challenger.accessToken);
      clients.push(cr, cm, cc);

      // The challenge is issued first, while the future raider is still free.
      cc.send({ type: 'duel:invite', targetCharacterId: raider.characterId });
      const invited = await cr.next('duel:invited');

      const own = await assemble(cr, [cm], victim.characterId, [mate.characterId]);
      cr.send({ type: 'raid:lock', raidId: own });
      await cr.next('raid:result');
      expect(await coinsOf(raider.characterId)).toBe(0);

      // Accepting now would put one wallet behind two commitments.
      cr.send({ type: 'duel:respond', inviteId: invited.inviteId, accept: true });
      const refusal = await cr.next('duel:error');
      expect(refusal.code, 'a raid-locked character cannot also be duel-locked').toBe('BUSY');

      const row = await db.query<{ active_duel_id: string | null; active_raid_id: string | null }>(
        'SELECT active_duel_id, active_raid_id FROM characters WHERE id = $1',
        [raider.characterId],
      );
      expect(row.rows[0]!.active_duel_id).toBeNull();
      expect(row.rows[0]!.active_raid_id).toBe(own);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

/* ==================================================================== *
 * Probes: surfaces the NEW-B predicate did not reach
 * ==================================================================== */

describe('NEW-B follow-up: other surfaces that read a wallet as poverty', () => {
  it('does not show an escrowed raider as a beggar in a replayed duel invite', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const challenger = await makePlayer(booted.app, 'C1c', 300);
      const mate = await makePlayer(booted.app, 'C1m', 40);
      const victim = await makePlayer(booted.app, 'C1v', 30);
      const opponent = await makePlayer(booted.app, 'C1o', 100);

      const cc = await TestClient.connect(booted.baseUrl, challenger.accessToken);
      const cm = await TestClient.connect(booted.baseUrl, mate.accessToken);
      const co = await TestClient.connect(booted.baseUrl, opponent.accessToken);
      clients.push(cc, cm, co);

      // A duel invite goes out while the challenger is still rich, and stays pending.
      cc.send({ type: 'duel:invite', targetCharacterId: opponent.characterId });
      const first = await co.next('duel:invited');
      expect(first.from.isBeggar, 'a 300-coin challenger is nobody’s beggar').toBe(false);

      // The challenger then locks a raid, staking the whole 300.
      const own = await assemble(cc, [cm], victim.characterId, [mate.characterId]);
      cc.send({ type: 'raid:lock', raidId: own });
      await cc.next('raid:result');
      expect(await coinsOf(challenger.characterId)).toBe(0);

      // The opponent reconnects; the pending invite is replayed from live rows.
      co.close();
      const rejoined = await TestClient.connect(booted.baseUrl, opponent.accessToken);
      clients.push(rejoined);
      const replayed = await rejoined.next('duel:invited');

      expect(
        replayed.from.isBeggar,
        'an escrowed raider must not wear a beggar badge on a replayed duel invite either',
      ).toBe(false);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('does not tell a raid target they are destitute when their zero is another raid’s escrow', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const target = await makePlayer(booted.app, 'C2t', 40);
      const raiderOne = await makePlayer(booted.app, 'C2r1', 6);
      const raiderTwo = await makePlayer(booted.app, 'C2r2', 5);
      const mate = await makePlayer(booted.app, 'C2m', 40);
      const otherVictim = await makePlayer(booted.app, 'C2v', 30);

      const ct = await TestClient.connect(booted.baseUrl, target.accessToken);
      const c1 = await TestClient.connect(booted.baseUrl, raiderOne.accessToken);
      const c2 = await TestClient.connect(booted.baseUrl, raiderTwo.accessToken);
      const cm = await TestClient.connect(booted.baseUrl, mate.accessToken);
      clients.push(ct, c1, c2, cm);

      // A raid on the target that they win: they keep their 40 and gain the escrow.
      const attack = await assemble(c1, [c2], target.characterId, [raiderTwo.characterId]);
      c1.send({ type: 'raid:lock', raidId: attack });
      const result = await c1.next('raid:result');
      expect(result.outcome).toBe('target_won');
      // Delivered but never acknowledged, so it is re-offered on every later connect.
      await ct.next('raid:aftermath');

      // Later, the target joins a raid of their own and stakes the whole wallet.
      ct.close();
      const rejoined = await TestClient.connect(booted.baseUrl, target.accessToken);
      clients.push(rejoined);
      const own = await assemble(rejoined, [cm], otherVictim.characterId, [mate.characterId]);
      rejoined.send({ type: 'raid:lock', raidId: own });
      await rejoined.next('raid:result');
      expect(await coinsOf(target.characterId), 'their zero is escrow, not poverty').toBe(0);

      // The unacknowledged aftermath is re-offered on the next connect.
      rejoined.close();
      const third = await TestClient.connect(booted.baseUrl, target.accessToken);
      clients.push(third);
      const replayed = await third.next('raid:aftermath');

      expect(
        replayed.nowBeggar,
        'a re-offered aftermath must not call an escrowed wallet destitute',
      ).toBe(false);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});
