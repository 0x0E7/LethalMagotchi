import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ChatService } from '../../src/chat/service.js';
import type { Db } from '../../src/db/pool.js';
import { RaidService } from '../../src/raid/service.js';
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
  nickname: string;
}

let db: Db;
let seed = 0;

/** The Town Square is long-lived and shared, so a fixture name has to be unique per run. */
const RUN = randomUUID().slice(0, 6);

beforeAll(() => {
  db = testPool();
});

afterAll(async () => {
  await closeTestPool();
});

async function boot(options: { limiters?: Limiters } = {}) {
  const pool = testPool();
  const hub = new Hub();
  const limiters = options.limiters ?? relaxedLimiters();
  const chat = new ChatService({ db: pool, hub, limiters });
  const clock = new ManualClock(Date.now());
  const raids = new RaidService({
    db: pool,
    hub,
    limiters,
    clock,
    revealMs: 50,
    betrayalMs: 5_000,
    parityMs: 5_000,
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

async function makePlayer(app: FastifyInstance, label: string, coins: number): Promise<Player> {
  seed += 1;
  const nickname = `${label}${seed}-${RUN}`;
  const account = await registerAccount(app, { username: uniqueUsername('rws') });
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
  initiator.send({ type: 'raid:lock', raidId: party.raidId });
  return party.raidId;
}

/**
 * The leak sweep, in the shape poker's hole-card test and the duel's throw test established:
 * the assertions run against the *raw serialized text* of every frame a socket received, so
 * a newly added leaky field fails loudly rather than slipping past a field-name check.
 */
describe('hidden information, as a security boundary', () => {
  it('never puts the target\'s exact balance in a raider\'s transcript before settlement', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      // A balance nothing else in the fixture can coincidentally produce.
      const targetCoins = 8_317;
      const one = await makePlayer(booted.app, 'Ash', 11);
      const two = await makePlayer(booted.app, 'Bo', 13);
      const target = await makePlayer(booted.app, 'Tar', targetCoins);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      a.send({ type: 'raid:create', targetCharacterId: target.characterId });
      const party = await a.next('raid:party');
      a.send({ type: 'raid:invite', raidId: party.raidId, characterId: two.characterId });
      const invited = await b.next('raid:invited');
      b.send({ type: 'raid:respond', raidId: invited.raidId, accept: true });
      await settle(200);

      // The band is the whole of what a raider learns while choosing whether to fire.
      expect(party.target.band).toBe('wealthy');
      for (const client of [a, b]) {
        expect(client.transcript()).not.toContain(String(targetCoins));
        expect(client.transcript()).not.toContain('"lethalCoins":8317');
      }
      // The invite carries a band and no number of any kind for the target.
      expect(JSON.stringify(invited.target)).not.toContain(String(targetCoins));

      // The party's own pot is banded too, so no raider can subtract their way to another's.
      expect(party.raidPotBand).toBe('comfortable');
      const partyFrames = a.frames.filter((frame) => frame.includes('"raid:party"'));
      expect(partyFrames.length).toBeGreaterThan(0);
      for (const frame of partyFrames) {
        // No coin field of any kind, rather than a search for one particular total: a
        // number can hide in a uuid, but a field name cannot hide from this.
        expect(frame).not.toMatch(/"[a-zA-Z]*[Cc]oins"\s*:/);
      }

      a.send({ type: 'raid:lock', raidId: party.raidId });
      const result = await a.next('raid:result');
      await settle(200);
      // The target held, so they keep that wallet — and the party never learns it. The
      // result reports what was actually taken, which is nothing.
      expect(result.outcome).toBe('target_won');
      expect(result.targetPot).toBe(0);
      for (const client of [a, b]) {
        expect(client.transcript()).not.toContain(String(targetCoins));
      }
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('never puts a betrayal choice or a parity call in any frame before its reveal', async () => {
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

      // All loyal, so 23 among three leaves a remainder and the parity game actually runs.
      a.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      b.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      await c.next('raid:betrayal_locked');
      // Long enough for a leaky implementation to have leaked.
      await settle(300);

      for (const client of [a, b, c]) {
        expect(client.transcript()).not.toContain('"choice"');
        expect(client.received('raid:betrayal_result')).toHaveLength(0);
      }

      c.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      for (const client of [a, b, c]) await client.next('raid:betrayal_result');
      // The reveal is the first frame anywhere in which a choice appears.
      for (const client of [a, b, c]) {
        const index = client.frames.findIndex((frame) => frame.includes('"choice"'));
        expect(index).toBeGreaterThanOrEqual(0);
        expect(JSON.parse(client.frames[index]!).type).toBe('raid:betrayal_result');
      }

      await booted.clock.advance(100, 150);
      const round = await a.next('raid:parity_round');
      a.send({ type: 'raid:parity', raidId, seq: round.seq, call: 'odds', throw: 5 });
      await settle(300);

      // Same rule for the parity round: the fact of a throw is public, the throw is not.
      for (const client of [b, c]) {
        const afterLock = client.frames.filter((frame) => !frame.includes('raid:parity_round'));
        expect(afterLock.join('\n')).not.toContain('"call"');
        expect(afterLock.join('\n')).not.toContain('"throw"');
      }
      expect(b.received('raid:betrayal_locked').length).toBeGreaterThan(0);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

describe('seq discipline', () => {
  it('refuses a duplicate and a stale seq, and keeps the choice that landed first', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 20);
      const two = await makePlayer(booted.app, 'Bo', 20);
      const target = await makePlayer(booted.app, 'Tar', 30);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      await a.next('raid:result');
      const window = await a.next('raid:betrayal_window');

      a.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      a.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'betray' });
      a.send({ type: 'raid:betray', raidId, seq: window.seq + 7, choice: 'betray' });

      const rejected = await a.next('raid:error');
      expect(rejected.code).toBe('STALE_SEQ');
      await settle(250);
      expect(a.received('raid:error')).toHaveLength(2);

      b.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      const reveal = await a.next('raid:betrayal_result');
      const mine = reveal.choices.find((entry) => entry.characterId === one.characterId);
      // The first choice is the one that counted; the double-click changed nothing.
      expect(mine?.choice).toBe('loyal');

      const stored = await db.query<{ betrayed: boolean; betrayal_auto: boolean }>(
        'SELECT betrayed, betrayal_auto FROM raid_members WHERE raid_id = $1 AND character_id = $2',
        [raidId, one.characterId],
      );
      expect(stored.rows[0]).toEqual({ betrayed: false, betrayal_auto: false });
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

describe('deadlines, driven by the clock rather than by waiting', () => {
  it('records an absent raider as loyal when the betrayal window runs out', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 20);
      const two = await makePlayer(booted.app, 'Bo', 20);
      const target = await makePlayer(booted.app, 'Tar', 30);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      await a.next('raid:result');
      const window = await a.next('raid:betrayal_window');
      a.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'betray' });
      await b.next('raid:betrayal_locked');

      // The other raider walks away. The window does not wait for them.
      b.close();
      await settle(100);
      await booted.clock.advance(5_000, 200);

      const reveal = await a.next('raid:betrayal_result');
      const theirs = reveal.choices.find((entry) => entry.characterId === two.characterId);
      expect(theirs?.choice).toBe('loyal');

      const stored = await db.query<{ betrayed: boolean; betrayal_auto: boolean }>(
        'SELECT betrayed, betrayal_auto FROM raid_members WHERE raid_id = $1 AND character_id = $2',
        [raidId, two.characterId],
      );
      // A missed window is loyalty, never a forfeit and never a coin flip.
      expect(stored.rows[0]).toEqual({ betrayed: false, betrayal_auto: true });

      await a.next('raid:end');
      await settle(200);
      const paid = await db.query<{ lethal_coins: number }>(
        'SELECT lethal_coins FROM characters WHERE id = $1',
        [one.characterId],
      );
      expect(paid.rows[0]!.lethal_coins).toBe(70);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('breaks up a party nobody fired, and gives every raider their freedom back', async () => {
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
      const party = await a.next('raid:party');
      a.send({ type: 'raid:invite', raidId: party.raidId, characterId: two.characterId });
      const invited = await b.next('raid:invited');
      b.send({ type: 'raid:respond', raidId: invited.raidId, accept: true });
      await settle(150);

      await booted.clock.advance(60_000, 250);

      const cancelled = await a.next('raid:cancelled');
      expect(cancelled.reason).toBe('EXPIRED');
      await b.next('raid:cancelled');

      const raid = await db.query<{ state: string }>('SELECT state FROM raids WHERE id = $1', [party.raidId]);
      expect(raid.rows[0]!.state).toBe('cancelled');
      const locks = await db.query('SELECT 1 FROM characters WHERE active_raid_id = $1', [party.raidId]);
      expect(locks.rowCount).toBe(0);
      // Nothing was ever escrowed, so no wallet moved.
      const wallets = await db.query<{ lethal_coins: number }>(
        'SELECT lethal_coins FROM characters WHERE id = ANY($1::uuid[]) ORDER BY lethal_coins',
        [[one.characterId, two.characterId, target.characterId]],
      );
      expect(wallets.rows.map((row) => row.lethal_coins)).toEqual([20, 20, 30]);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

describe('the aftermath, for a target who was never there', () => {
  it('is delivered on their next connect, and leads with what actually happened', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const one = await makePlayer(booted.app, 'Ash', 20);
      const two = await makePlayer(booted.app, 'Bo', 20);
      const target = await makePlayer(booted.app, 'Tar', 30);

      const a = await TestClient.connect(booted.baseUrl, one.accessToken);
      const b = await TestClient.connect(booted.baseUrl, two.accessToken);
      clients.push(a, b);

      // The target is not connected at all while this happens to them.
      const raidId = await assemble(a, [b], target.characterId, [two.characterId]);
      await a.next('raid:result');
      const window = await a.next('raid:betrayal_window');
      for (const client of [a, b]) {
        client.send({ type: 'raid:betray', raidId, seq: window.seq, choice: 'loyal' });
      }
      await a.next('raid:end');
      await settle(250);

      const victim = await TestClient.connect(booted.baseUrl, target.accessToken);
      clients.push(victim);
      const aftermath = await victim.next('raid:aftermath');

      expect(aftermath.outcome).toBe('raiders_won');
      expect(aftermath.raidPot).toBe(40);
      expect(aftermath.targetPot).toBe(30);
      expect(aftermath.coinsLost).toBe(30);
      expect(aftermath.nowBeggar).toBe(true);
      expect(aftermath.raiders.map((raider) => raider.characterId).sort()).toEqual(
        [one.characterId, two.characterId].sort(),
      );
      // No raid frame carries a rebirth, a death or an HP figure, because no branch has one.
      expect(victim.transcript()).not.toContain('rebirth');
      expect(victim.transcript()).not.toContain('"hp"');

      // Nothing is marked on the send: until the client says it showed the report, the row
      // still owes it.
      await settle(100);
      const acked = await db.query<{ aftermath_acked_at: Date | null }>(
        'SELECT aftermath_acked_at FROM raids WHERE id = $1',
        [raidId],
      );
      expect(acked.rows[0]!.aftermath_acked_at).toBeNull();

      // A reload still gets it: the one report they are owed must not be lost to a refresh.
      const again = await TestClient.connect(booted.baseUrl, target.accessToken);
      clients.push(again);
      const repeat = await again.next('raid:aftermath');
      expect(repeat.raidId).toBe(raidId);

      // And once the card has been shown, it is retired.
      again.send({ type: 'raid:aftermath_ack', raidId });
      await settle(150);
      const afterAck = await db.query<{ aftermath_acked_at: Date | null }>(
        'SELECT aftermath_acked_at FROM raids WHERE id = $1',
        [raidId],
      );
      expect(afterAck.rows[0]!.aftermath_acked_at).not.toBeNull();
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

describe('raid rate limits', () => {
  function productionRaidLimits(): Limiters {
    return {
      ...relaxedLimiters(),
      raidCreate: new RateLimiter({ limit: 4, windowMs: 10 * 60_000, maxBackoffMs: 60 * 60_000 }),
      raidAction: new RateLimiter({ limit: 30, windowMs: 10_000, maxBackoffMs: 60_000 }),
    };
  }

  it('charges a create that never had a chance, so garbage buys no free attempts', async () => {
    const booted = await boot({ limiters: productionRaidLimits() });
    const clients: TestClient[] = [];
    try {
      const spammer = await makePlayer(booted.app, 'Spam', 50);
      const a = await TestClient.connect(booted.baseUrl, spammer.accessToken);
      clients.push(a);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        a.send({ type: 'raid:create', targetCharacterId: randomUUID() });
      }
      await settle(400);

      const codes = a.received('raid:error').map((message) => message.code);
      // Four frames spent the budget even though every one named nobody real.
      expect(codes.filter((code) => code === 'NOT_FOUND')).toHaveLength(4);
      expect(codes.filter((code) => code === 'RATE_LIMITED')).toHaveLength(1);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('throttles a betrayal flood on the same budget as real play', async () => {
    const booted = await boot({ limiters: productionRaidLimits() });
    const clients: TestClient[] = [];
    try {
      const flooder = await makePlayer(booted.app, 'Flood', 50);
      const a = await TestClient.connect(booted.baseUrl, flooder.accessToken);
      clients.push(a);

      for (let attempt = 0; attempt < 34; attempt += 1) {
        a.send({ type: 'raid:betray', raidId: randomUUID(), seq: 0, choice: 'betray' });
      }
      await settle(500);

      const codes = a.received('raid:error').map((message) => message.code);
      expect(codes.filter((code) => code === 'NOT_FOUND')).toHaveLength(30);
      expect(codes.filter((code) => code === 'RATE_LIMITED').length).toBeGreaterThan(0);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});
