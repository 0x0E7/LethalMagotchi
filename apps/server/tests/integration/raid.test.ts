import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { RAID_TARGET_IMMUNITY_MS } from '@lethalmagotchi/shared';
import { ChatService } from '../../src/chat/service.js';
import type { Db } from '../../src/db/pool.js';
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
  close: () => Promise<void>;
}

let db: Db;

beforeAll(() => {
  db = testPool();
});

afterAll(async () => {
  await closeTestPool();
});

async function boot(options: { limiters?: Limiters; busyDeferMs?: number; busyPollMs?: number } = {}): Promise<Booted> {
  const pool = testPool();
  const hub = new Hub();
  const limiters = options.limiters ?? relaxedLimiters();
  const chat = new ChatService({ db: pool, hub, limiters });
  // Started at the wall clock so the 24h floors read the way they do in production, then
  // driven by hand from there.
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
  });
  const { app } = await createTestApp({ hub, chat, raids, limiters });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    app,
    clock,
    raids,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await raids.stop();
      await app.close();
    },
  };
}

/** The Town Square is long-lived and shared, so a fixture name has to be unique per run. */
const RUN = randomUUID().slice(0, 6);
let nicknameSeed = 0;

async function makePlayer(app: FastifyInstance, label: string, coins: number): Promise<Player> {
  nicknameSeed += 1;
  const nickname = `${label}${nicknameSeed}-${RUN}`;
  const account = await registerAccount(app, { username: uniqueUsername('rid') });
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

/** Assemble a party and fire it, returning the raid id the server created. */
async function assemble(
  clients: { initiator: TestClient; joiners: TestClient[] },
  targetCharacterId: string,
  joinerIds: string[],
): Promise<string> {
  clients.initiator.send({ type: 'raid:create', targetCharacterId });
  const party = await clients.initiator.next('raid:party');

  for (const [index, joinerId] of joinerIds.entries()) {
    clients.initiator.send({ type: 'raid:invite', raidId: party.raidId, characterId: joinerId });
    const invited = await clients.joiners[index]!.next('raid:invited');
    clients.joiners[index]!.send({ type: 'raid:respond', raidId: invited.raidId, accept: true });
    await clients.initiator.next('raid:party', (message) =>
      message.members.filter((member) => member.state === 'joined').length === index + 2,
    );
  }

  clients.initiator.send({ type: 'raid:lock', raidId: party.raidId });
  return party.raidId;
}

describe('the wallet comparison, end to end', () => {
  it('bankrupts the target when the party brings more, and holds the pot for the betrayal', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 20);
      const two = await makePlayer(booted.app, 'Bo', 20);
      const three = await makePlayer(booted.app, 'Cy', 20);
      const target = await makePlayer(booted.app, 'Tar', 30);
      const everyone = [one.characterId, two.characterId, three.characterId, target.characterId];
      const before = await totalCoins(everyone);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      const c = await TestClient.connect(booted.baseUrl, three.accessToken);
      clients.push(a, b, c);

      const raidId = await assemble({ initiator: a, joiners: [b, c] }, target.characterId, [
        two.characterId,
        three.characterId,
      ]);

      const result = await a.next('raid:result');
      expect(result.outcome).toBe('raiders_won');
      expect(result.raidPot).toBe(60);
      expect(result.targetPot).toBe(30);
      expect(result.potCoins).toBe(90);

      // The target is at exactly zero, and every raider's escrow has left their wallet.
      expect(await coinsOf(target.characterId)).toBe(0);
      for (const raider of [one, two, three]) expect(await coinsOf(raider.characterId)).toBe(0);
      // The pot is off the wallets and on the raid, which is the whole of the difference.
      expect(await totalCoins(everyone)).toBe(before - 90);

      const raid = await db.query<{ state: string; outcome: string; raider_pot_coins: number; target_pot_coins: number }>(
        'SELECT state, outcome, raider_pot_coins, target_pot_coins FROM raids WHERE id = $1',
        [raidId],
      );
      expect(raid.rows[0]).toEqual({
        state: 'betrayal',
        outcome: 'raiders_won',
        raider_pot_coins: 60,
        target_pot_coins: 30,
      });

      // Nothing about a death anywhere: a raid is strictly a coin-ledger operation.
      const rebirths = await db.query(
        'SELECT 1 FROM rebirth_events WHERE character_id = ANY($1::uuid[])',
        [everyone],
      );
      expect(rebirths.rowCount).toBe(0);
      const hp = await db.query<{ hp: number }>(
        `SELECT (stats->>'hp')::numeric AS hp FROM characters WHERE id = $1`,
        [target.characterId],
      );
      expect(Number(hp.rows[0]!.hp)).toBe(100);

      // Everyone loyal: 90 among 3 divides exactly, so there is no parity round.
      const window = await a.next('raid:betrayal_window');
      for (const client of [a, b, c]) {
        client.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      }
      await a.next('raid:end');
      await settle(150);

      for (const raider of [one, two, three]) expect(await coinsOf(raider.characterId)).toBe(30);
      // Money conservation: the same coins, in different pockets.
      expect(await totalCoins(everyone)).toBe(before);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('bankrupts every raider when the target brings more, with no betrayal phase at all', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 10);
      const two = await makePlayer(booted.app, 'Bo', 10);
      const target = await makePlayer(booted.app, 'Tar', 100);
      const everyone = [one.characterId, two.characterId, target.characterId];
      const before = await totalCoins(everyone);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      const raidId = await assemble({ initiator: a, joiners: [b] }, target.characterId, [two.characterId]);

      const result = await a.next('raid:result');
      expect(result.outcome).toBe('target_won');
      expect(result.raidPot).toBe(20);
      // Nothing was taken from a target who held, and their wallet is not the party's to
      // learn: the number on the wire is what moved, not what they have.
      expect(result.targetPot).toBe(0);
      expect(a.transcript()).not.toContain('"targetPot":100');

      const end = await a.next('raid:end');
      expect(end.bankrupted).toEqual(expect.arrayContaining([one.characterId, two.characterId]));
      await settle(150);

      expect(await coinsOf(target.characterId)).toBe(120);
      expect(await coinsOf(one.characterId)).toBe(0);
      expect(await coinsOf(two.characterId)).toBe(0);
      expect(await totalCoins(everyone)).toBe(before);

      const raid = await db.query<{ state: string; outcome: string; ended_at: Date | null }>(
        'SELECT state, outcome, ended_at FROM raids WHERE id = $1',
        [raidId],
      );
      expect(raid.rows[0]!.state).toBe('complete');
      expect(raid.rows[0]!.outcome).toBe('target_won');
      expect(raid.rows[0]!.ended_at).not.toBeNull();

      const members = await db.query<{ bankrupted_in_raid: boolean; coins_received: number; betrayed: boolean | null }>(
        'SELECT bankrupted_in_raid, coins_received, betrayed FROM raid_members WHERE raid_id = $1',
        [raidId],
      );
      expect(members.rows).toHaveLength(2);
      for (const row of members.rows) {
        expect(row).toEqual({ bankrupted_in_raid: true, coins_received: 0, betrayed: null });
      }
      // Every engagement lock is released, so both raiders can act again immediately.
      const locks = await db.query(
        'SELECT 1 FROM characters WHERE active_raid_id IS NOT NULL AND id = ANY($1::uuid[])',
        [everyone],
      );
      expect(locks.rowCount).toBe(0);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('voids an exact tie with nobody bankrupted and every escrow returned', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 15);
      const two = await makePlayer(booted.app, 'Bo', 15);
      const target = await makePlayer(booted.app, 'Tar', 30);
      const everyone = [one.characterId, two.characterId, target.characterId];
      const before = await totalCoins(everyone);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      const raidId = await assemble({ initiator: a, joiners: [b] }, target.characterId, [two.characterId]);

      const result = await a.next('raid:result');
      expect(result.outcome).toBe('void');
      await a.next('raid:end');
      await settle(150);

      // Every wallet is exactly where it started.
      expect(await coinsOf(one.characterId)).toBe(15);
      expect(await coinsOf(two.characterId)).toBe(15);
      expect(await coinsOf(target.characterId)).toBe(30);
      expect(await totalCoins(everyone)).toBe(before);

      const raid = await db.query<{ outcome: string; pot_destroyed: boolean }>(
        'SELECT outcome, pot_destroyed FROM raids WHERE id = $1',
        [raidId],
      );
      expect(raid.rows[0]).toEqual({ outcome: 'void', pot_destroyed: false });
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

describe('the betrayal branches, against real wallets', () => {
  async function playTo(
    booted: Booted,
    choices: ('loyal' | 'betray')[],
    coins: { raiders: number[]; target: number },
  ) {
    const raiders: Player[] = [];
    for (const [index, purse] of coins.raiders.entries()) {
      raiders.push(await makePlayer(booted.app, `R${index}`, purse));
    }
    const target = await makePlayer(booted.app, 'Tar', coins.target);
    const everyone = [...raiders.map((raider) => raider.characterId), target.characterId];
    const before = await totalCoins(everyone);

    const clients: TestClient[] = [];
    for (const raider of raiders) clients.push(await TestClient.connect(booted.baseUrl, raider.accessToken));

    const raidId = await assemble(
      { initiator: clients[0]!, joiners: clients.slice(1) },
      target.characterId,
      raiders.slice(1).map((raider) => raider.characterId),
    );
    await clients[0]!.next('raid:result');
    const window = await clients[0]!.next('raid:betrayal_window');
    for (const [index, client] of clients.entries()) {
      client.send({ type: 'raid:betray', raidId, seq: window.seq, choice: choices[index]! });
    }
    const end = await clients[0]!.next('raid:end');
    await settle(200);

    return { raiders, target, clients, raidId, before, everyone, end, potCoins: window.potCoins };
  }

  it('hands the whole pot to a lone betrayer', async () => {
    const booted = await boot();
    let opened: TestClient[] = [];
    try {
      const played = await playTo(booted, ['betray', 'loyal', 'loyal'], {
        raiders: [10, 10, 10],
        target: 20,
      });
      opened = played.clients;

      expect(await coinsOf(played.raiders[0]!.characterId)).toBe(50);
      expect(await coinsOf(played.raiders[1]!.characterId)).toBe(0);
      expect(await coinsOf(played.raiders[2]!.characterId)).toBe(0);
      expect(await totalCoins(played.everyone)).toBe(played.before);
    } finally {
      await closeAll(opened);
      await booted.close();
    }
  });

  it('hands everything to the single loyalist when two of three reach', async () => {
    const booted = await boot();
    let opened: TestClient[] = [];
    try {
      const played = await playTo(booted, ['betray', 'betray', 'loyal'], {
        raiders: [10, 10, 10],
        target: 20,
      });
      opened = played.clients;

      expect(await coinsOf(played.raiders[2]!.characterId)).toBe(50);
      expect(await coinsOf(played.raiders[0]!.characterId)).toBe(0);
      expect(await coinsOf(played.raiders[1]!.characterId)).toBe(0);
      expect(await totalCoins(played.everyone)).toBe(played.before);
    } finally {
      await closeAll(opened);
      await booted.close();
    }
  });

  it('destroys the pot when everyone reaches, and records the burn', async () => {
    const booted = await boot();
    let opened: TestClient[] = [];
    try {
      const played = await playTo(booted, ['betray', 'betray', 'betray'], {
        raiders: [10, 10, 10],
        target: 20,
      });
      opened = played.clients;

      expect(played.end.potDestroyed).toBe(true);
      for (const raider of played.raiders) expect(await coinsOf(raider.characterId)).toBe(0);
      expect(await coinsOf(played.target.characterId)).toBe(0);

      /**
       * The one sanctioned place coins leave the economy, and the only branch on which the
       * books are allowed not to balance: the shortfall is the pot, exactly.
       */
      expect(await totalCoins(played.everyone)).toBe(played.before - played.potCoins);
      expect(played.potCoins).toBe(50);

      const raid = await db.query<{ pot_destroyed: boolean; state: string }>(
        'SELECT pot_destroyed, state FROM raids WHERE id = $1',
        [played.raidId],
      );
      expect(raid.rows[0]).toEqual({ pot_destroyed: true, state: 'complete' });
    } finally {
      await closeAll(opened);
      await booted.close();
    }
  });

  it('plays the parity game for a pot that will not divide, and pays out all of it', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      // 3 x 4 = 12 beats 11, so the pot is 23 among three loyalists: 7 each with 2 over.
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

      const raidId = await assemble({ initiator: a, joiners: [b, c] }, target.characterId, [
        two.characterId,
        three.characterId,
      ]);
      const result = await a.next('raid:result');
      expect(result.potCoins).toBe(23);

      const window = await a.next('raid:betrayal_window');
      for (const client of [a, b, c]) {
        client.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      }
      const reveal = await a.next('raid:betrayal_result');
      expect(reveal.remainder).toBe(2);

      // The beat between the reveal and the next window runs on the injected clock.
      await booted.clock.advance(100, 150);
      const round = await a.next('raid:parity_round');
      expect(round.remainder).toBe(2);
      // Sum 1 is odd; two of the three call it, so the two spare coins go one each.
      a.send({ type: 'raid:parity', raidId, seq: round.seq, call: 'odds', throw: 1 });
      b.send({ type: 'raid:parity', raidId, seq: round.seq, call: 'odds', throw: 0 });
      c.send({ type: 'raid:parity', raidId, seq: round.seq, call: 'evens', throw: 0 });

      const parityResult = await a.next('raid:parity_result');
      expect(parityResult.parity).toBe('odds');
      expect(parityResult.winners).toEqual(expect.arrayContaining([one.characterId, two.characterId]));

      await a.next('raid:end');
      await settle(200);

      expect(await coinsOf(one.characterId)).toBe(8);
      expect(await coinsOf(two.characterId)).toBe(8);
      expect(await coinsOf(three.characterId)).toBe(7);
      expect(await coinsOf(target.characterId)).toBe(0);
      // Every coin accounted for: 23 out of the pot, none created and none destroyed.
      expect(await totalCoins(everyone)).toBe(before);

      const actions = await db.query<{ round: number }>(
        'SELECT round FROM raid_parity_actions WHERE raid_id = $1',
        [raidId],
      );
      expect(actions.rowCount).toBe(3);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

describe('the anti-griefing floors', () => {
  it('refuses a target who is too new, too poor, or still immune', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const raider = await makePlayer(booted.app, 'Ash', 50);
      const fresh = await makePlayer(booted.app, 'New', 50);
      const poor = await makePlayer(booted.app, 'Poor', 4);
      const immune = await makePlayer(booted.app, 'Safe', 50);
      await db.query(`UPDATE characters SET created_at = now() WHERE id = $1`, [fresh.characterId]);
      await db.query(`UPDATE characters SET raid_immunity_until = now() + interval '1 hour' WHERE id = $1`, [
        immune.characterId,
      ]);

      const a = await TestClient.connect(booted.baseUrl, raider.accessToken);
      clients.push(a);

      a.send({ type: 'raid:create', targetCharacterId: fresh.characterId });
      expect((await a.next('raid:error')).code).toBe('TOO_NEW');
      a.send({ type: 'raid:create', targetCharacterId: poor.characterId });
      expect((await a.next('raid:error')).code).toBe('TARGET_TOO_POOR');
      a.send({ type: 'raid:create', targetCharacterId: immune.characterId });
      expect((await a.next('raid:error')).code).toBe('TARGET_IMMUNE');
      a.send({ type: 'raid:create', targetCharacterId: raider.characterId });
      expect((await a.next('raid:error')).code).toBe('SELF');

      // Nothing was written on any of the four refusals.
      const raids = await db.query('SELECT 1 FROM raids WHERE initiator_character_id = $1', [
        raider.characterId,
      ]);
      expect(raids.rowCount).toBe(0);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('shields a freshly bankrupted target behind the same wealth floor, with no extra rule', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 20);
      const two = await makePlayer(booted.app, 'Bo', 20);
      const target = await makePlayer(booted.app, 'Tar', 10);
      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      const raidId = await assemble({ initiator: a, joiners: [b] }, target.characterId, [two.characterId]);
      await a.next('raid:result');
      const window = await a.next('raid:betrayal_window');
      for (const client of [a, b]) {
        client.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      }
      await a.next('raid:end');
      await settle(200);
      expect(await coinsOf(target.characterId)).toBe(0);

      // A second party, with no shared raiders and no cooldown between them, still cannot.
      const three = await makePlayer(booted.app, 'Dee', 40);
      const four = await makePlayer(booted.app, 'Eli', 40);
      const c = await TestClient.connect(booted.baseUrl, three.accessToken);
      clients.push(c, await TestClient.connect(booted.baseUrl, four.accessToken));

      c.send({ type: 'raid:create', targetCharacterId: target.characterId });
      const refusal = await c.next('raid:error');
      // Immunity fires first here; the wealth floor is the backstop behind it.
      expect(['TARGET_IMMUNE', 'TARGET_TOO_POOR']).toContain(refusal.code);

      await db.query('UPDATE characters SET raid_immunity_until = NULL WHERE id = $1', [target.characterId]);
      c.send({ type: 'raid:create', targetCharacterId: target.characterId });
      expect((await c.next('raid:error')).code).toBe('TARGET_TOO_POOR');
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('writes the per-target immunity and the per-raider cooldown in the settlement itself', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 5);
      const two = await makePlayer(booted.app, 'Bo', 5);
      const target = await makePlayer(booted.app, 'Tar', 10);
      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      await assemble({ initiator: a, joiners: [b] }, target.characterId, [two.characterId]);
      // A tie-free loss for the raiders, which still has to set both clocks.
      await a.next('raid:result');
      await a.next('raid:end');
      await settle(200);

      const immunity = await db.query<{ raid_immunity_until: Date | null }>(
        'SELECT raid_immunity_until FROM characters WHERE id = $1',
        [target.characterId],
      );
      const until = immunity.rows[0]!.raid_immunity_until;
      expect(until).not.toBeNull();
      expect(until!.getTime() - booted.clock.now()).toBeGreaterThan(RAID_TARGET_IMMUNITY_MS - 60_000);

      const cooldowns = await db.query<{ last_raid_at: Date | null }>(
        'SELECT last_raid_at FROM characters WHERE id = ANY($1::uuid[])',
        [[one.characterId, two.characterId]],
      );
      expect(cooldowns.rows.every((row) => row.last_raid_at !== null)).toBe(true);

      // And a raider on cooldown cannot start another one.
      const other = await makePlayer(booted.app, 'Other', 40);
      a.send({ type: 'raid:create', targetCharacterId: other.characterId });
      expect((await a.next('raid:error')).code).toBe('COOLDOWN');
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

describe('the engagement lock, both directions', () => {
  it('blocks a raider from poker, duels, shop purchases and self-deletion while committed', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 20);
      const two = await makePlayer(booted.app, 'Bo', 20);
      const target = await makePlayer(booted.app, 'Tar', 100);
      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      a.send({ type: 'raid:create', targetCharacterId: target.characterId });
      const party = await a.next('raid:party');
      // The lock lands at join, before any coin has moved, so a committed raider cannot
      // also spend the wallet they are about to stake.
      const locked = await db.query<{ active_raid_id: string | null }>(
        'SELECT active_raid_id FROM characters WHERE id = $1',
        [one.characterId],
      );
      expect(locked.rows[0]!.active_raid_id).toBe(party.raidId);

      const purchase = await booted.app.inject(
        authed(one, { method: 'POST', url: '/api/v1/characters/me/actions/feed', payload: {} }),
      );
      expect(purchase.statusCode).toBe(409);
      expect(purchase.json().error.code).toBe('CHARACTER_IN_RAID');

      const optIn = await booted.app.inject(
        authed(one, {
          method: 'POST',
          url: '/api/v1/characters/me/tournament-optin',
          payload: { optIn: true },
        }),
      );
      expect(optIn.statusCode).toBe(409);

      const deletion = await booted.app.inject(
        authed(one, { method: 'DELETE', url: '/api/v1/characters/me' }),
      );
      expect(deletion.statusCode).toBe(409);

      // And the duel system refuses them in both directions.
      a.send({ type: 'duel:invite', targetCharacterId: two.characterId });
      expect((await a.next('duel:error')).code).toBe('BUSY');
      b.send({ type: 'duel:invite', targetCharacterId: one.characterId });
      expect((await b.next('duel:error')).code).toBe('TARGET_BUSY');
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('refuses a raider who is already seated at a table, and leaves the target free', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 20);
      const seated = await makePlayer(booted.app, 'Sat', 20);
      const target = await makePlayer(booted.app, 'Tar', 100);
      await db.query('UPDATE characters SET seated_table_id = $2 WHERE id = $1', [
        seated.characterId,
        '00000000-0000-0000-0000-0000000000aa',
      ]);
      // The target being busy is deliberately not a refusal: requiring them idle would be a
      // consent gate through the back door.
      await db.query('UPDATE characters SET seated_table_id = $2 WHERE id = $1', [
        target.characterId,
        '00000000-0000-0000-0000-0000000000bb',
      ]);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, seated.accessToken);
      clients.push(a, b);

      a.send({ type: 'raid:create', targetCharacterId: target.characterId });
      const party = await a.next('raid:party');
      expect(party.target.characterId).toBe(target.characterId);

      a.send({ type: 'raid:invite', raidId: party.raidId, characterId: seated.characterId });
      expect((await a.next('raid:error')).code).toBe('BUSY');
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

describe('races', () => {
  it('lets exactly one of two parties assemble on the same target', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 20);
      const two = await makePlayer(booted.app, 'Bo', 20);
      const target = await makePlayer(booted.app, 'Tar', 30);
      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      a.send({ type: 'raid:create', targetCharacterId: target.characterId });
      b.send({ type: 'raid:create', targetCharacterId: target.characterId });
      await settle(400);

      const parties = [...a.received('raid:party'), ...b.received('raid:party')];
      const refusals = [...a.received('raid:error'), ...b.received('raid:error')];
      expect(parties).toHaveLength(1);
      expect(refusals).toHaveLength(1);
      expect(refusals[0]!.code).toBe('TARGET_IMMUNE');

      const raids = await db.query('SELECT 1 FROM raids WHERE target_character_id = $1', [
        target.characterId,
      ]);
      expect(raids.rowCount).toBe(1);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('settles a double-fired lock exactly once', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 20);
      const two = await makePlayer(booted.app, 'Bo', 20);
      const target = await makePlayer(booted.app, 'Tar', 30);
      const everyone = [one.characterId, two.characterId, target.characterId];
      const before = await totalCoins(everyone);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      a.send({ type: 'raid:create', targetCharacterId: target.characterId });
      const party = await a.next('raid:party');
      a.send({ type: 'raid:invite', raidId: party.raidId, characterId: two.characterId });
      const invited = await b.next('raid:invited');
      b.send({ type: 'raid:respond', raidId: invited.raidId, accept: true });
      await a.next('raid:party', (message) => message.members.filter((m) => m.state === 'joined').length === 2);

      a.send({ type: 'raid:lock', raidId: party.raidId });
      a.send({ type: 'raid:lock', raidId: party.raidId });
      await settle(500);

      // Exactly one comparison, and the escrow was taken exactly once.
      expect(a.received('raid:result')).toHaveLength(1);
      expect(a.received('raid:result')[0]!.raidPot).toBe(40);
      const raid = await db.query<{ raider_pot_coins: number }>(
        'SELECT raider_pot_coins FROM raids WHERE id = $1',
        [party.raidId],
      );
      expect(raid.rows[0]!.raider_pot_coins).toBe(40);

      const window = await a.next('raid:betrayal_window');
      for (const client of [a, b]) {
        client.send({ type: 'raid:betray', raidId: party.raidId, seq: window.seq, choice: 'loyal' });
      }
      await a.next('raid:end');
      await settle(200);
      expect(await totalCoins(everyone)).toBe(before);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

describe('the busy-target defer', () => {
  it('waits for a target mid-duel and then settles against their real wallet', async () => {
    const booted = await boot({ busyDeferMs: 600_000, busyPollMs: 10_000 });
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 20);
      const two = await makePlayer(booted.app, 'Bo', 20);
      const target = await makePlayer(booted.app, 'Tar', 30);
      await db.query('UPDATE characters SET active_duel_id = $2 WHERE id = $1', [
        target.characterId,
        '00000000-0000-0000-0000-0000000000cc',
      ]);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      await assemble({ initiator: a, joiners: [b] }, target.characterId, [two.characterId]);
      await settle(300);
      // Nothing has been compared: the escrow has left the raiders, so a mid-duel wallet
      // would be a number that misrepresents their wealth.
      expect(a.received('raid:result')).toHaveLength(0);
      expect(await coinsOf(one.characterId)).toBe(0);

      await db.query('UPDATE characters SET active_duel_id = NULL WHERE id = $1', [target.characterId]);
      await booted.clock.advance(10_000, 300);

      const result = await a.next('raid:result');
      expect(result.outcome).toBe('raiders_won');
      expect(result.targetPot).toBe(30);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('voids after ten minutes of a target who never comes free', async () => {
    const booted = await boot({ busyDeferMs: 600_000, busyPollMs: 60_000 });
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 20);
      const two = await makePlayer(booted.app, 'Bo', 20);
      const target = await makePlayer(booted.app, 'Tar', 30);
      const everyone = [one.characterId, two.characterId, target.characterId];
      const before = await totalCoins(everyone);
      await db.query('UPDATE characters SET seated_table_id = $2 WHERE id = $1', [
        target.characterId,
        '00000000-0000-0000-0000-0000000000dd',
      ]);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      await assemble({ initiator: a, joiners: [b] }, target.characterId, [two.characterId]);
      await settle(300);

      for (let minute = 0; minute < 11; minute += 1) await booted.clock.advance(60_000, 120);

      const result = await a.next('raid:result');
      expect(result.outcome).toBe('void');
      await settle(300);

      // The escrow is back where it came from and nobody was bankrupted.
      expect(await coinsOf(one.characterId)).toBe(20);
      expect(await coinsOf(two.characterId)).toBe(20);
      expect(await coinsOf(target.characterId)).toBe(30);
      expect(await totalCoins(everyone)).toBe(before);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

describe('boot recovery', () => {
  it('returns every escrow and releases every lock for a raid the last process abandoned', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 20);
      const two = await makePlayer(booted.app, 'Bo', 20);
      const target = await makePlayer(booted.app, 'Tar', 30);
      const everyone = [one.characterId, two.characterId, target.characterId];
      const before = await totalCoins(everyone);
      await db.query('UPDATE characters SET seated_table_id = $2 WHERE id = $1', [
        target.characterId,
        '00000000-0000-0000-0000-0000000000ee',
      ]);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      const raidId = await assemble({ initiator: a, joiners: [b] }, target.characterId, [two.characterId]);
      await settle(300);
      expect(await coinsOf(one.characterId)).toBe(0);

      // The process dies with the raid mid-flight, and a new one comes up behind it.
      await booted.raids.stop();
      await db.query(`UPDATE raids SET created_at = now() - interval '1 hour' WHERE id = $1`, [raidId]);

      const restarted = await boot();
      try {
        await restarted.raids.start();
        await settle(200);

        const raid = await db.query<{ state: string; outcome: string | null }>(
          'SELECT state, outcome FROM raids WHERE id = $1',
          [raidId],
        );
        expect(raid.rows[0]!.state).toBe('cancelled');
        expect(raid.rows[0]!.outcome).toBeNull();
        // Nobody is bankrupted by a deploy, and nobody stays locked to a raid that will
        // never settle.
        expect(await coinsOf(one.characterId)).toBe(20);
        expect(await coinsOf(two.characterId)).toBe(20);
        expect(await totalCoins(everyone)).toBe(before);
        const locks = await db.query(
          'SELECT 1 FROM characters WHERE active_raid_id = $1',
          [raidId],
        );
        expect(locks.rowCount).toBe(0);
      } finally {
        await restarted.close();
      }
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});
