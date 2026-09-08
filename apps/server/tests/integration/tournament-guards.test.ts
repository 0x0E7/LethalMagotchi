import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { WS_AUTH_TIMEOUT_MS, WS_PATH } from '@lethalmagotchi/shared';
import { DEFAULT_TOURNAMENT_CONFIG } from '../../src/config.js';
import type { Db } from '../../src/db/pool.js';
import type { Limiters } from '../../src/deps.js';
import { RateLimiter } from '../../src/rate-limit.js';
import { insertScheduledTournament } from '../../src/repos/tournaments.js';
import { TournamentService } from '../../src/tournament/service.js';
import { Hub } from '../../src/ws/hub.js';
import { MAX_ANON_SOCKETS_PER_IP, MAX_SOCKETS_PER_ACCOUNT } from '../../src/ws/routes.js';
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
import { ManualClock } from '../helpers/clock.js';

let db: Db;

beforeAll(() => {
  db = testPool();
});

afterAll(async () => {
  await closeTestPool();
});

async function makeCharacter(app: FastifyInstance, account: TestAccount, nickname: string) {
  const response = await app.inject(
    authed(account, { method: 'POST', url: '/api/v1/characters', payload: { ...VALID_CHARACTER, nickname } }),
  );
  if (response.statusCode !== 201) throw new Error(`character create failed: ${response.body}`);
  return response.json().character as { id: string };
}

describe('a seated character cannot spend its escrowed coins', () => {
  it('rejects a shop action while seated and allows it again once the seat is released', async () => {
    const { app } = await createTestApp();
    try {
      const account = await registerAccount(app, { username: uniqueUsername('seated') });
      const character = await makeCharacter(app, account, 'Escrowed');
      await db.query('UPDATE characters SET lethal_coins = 20 WHERE id = $1', [character.id]);

      const tournament = await insertScheduledTournament(db, {
        scope: 'global',
        slotKey: `guard:${crypto.randomUUID()}`,
        scheduledFor: new Date(Date.now() + 60_000),
        registrationOpensAt: new Date(),
      });
      const table = await db.query<{ id: string }>(
        `INSERT INTO tournament_tables (id, tournament_id, round, state)
         VALUES ($1, $2, 1, 'playing') RETURNING id`,
        [crypto.randomUUID(), tournament!.id],
      );
      await db.query('UPDATE characters SET seated_table_id = $2 WHERE id = $1', [
        character.id,
        table.rows[0]!.id,
      ]);

      const blocked = await app.inject(
        authed(account, { method: 'POST', url: '/api/v1/characters/me/actions/feed', payload: { itemId: 'kibble' } }),
      );
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().error.code).toBe('CHARACTER_SEATED');

      const before = await db.query<{ lethal_coins: number }>(
        'SELECT lethal_coins FROM characters WHERE id = $1',
        [character.id],
      );
      expect(before.rows[0]!.lethal_coins).toBe(20);

      await db.query('UPDATE characters SET seated_table_id = NULL WHERE id = $1', [character.id]);
      const allowed = await app.inject(
        authed(account, { method: 'POST', url: '/api/v1/characters/me/actions/feed', payload: { itemId: 'kibble' } }),
      );
      expect(allowed.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

/**
 * A socket with no protocol manners at all: it never authenticates unless told to and it
 * keeps every raw frame it is sent, so a test can assert on what the server *did not*
 * reply as well as on what it did.
 */
class RawSocket {
  readonly frames: string[] = [];
  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (raw: Buffer) => {
      this.frames.push(raw.toString());
    });
  }

  static open(port: number): Promise<RawSocket> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
    return new Promise((resolve, reject) => {
      socket.once('open', () => resolve(new RawSocket(socket)));
      socket.once('error', reject);
    });
  }

  send(text: string): void {
    this.socket.send(text);
  }

  types(): string[] {
    return this.frames.map((frame) => JSON.parse(frame).type as string);
  }

  codes(): string[] {
    return this.frames.map((frame) => JSON.parse(frame).code as string);
  }

  onClose(listener: () => void): void {
    this.socket.once('close', listener);
  }

  close(): void {
    this.socket.close();
  }
}

const quiet = (ms = 250): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function listening(limiters: Limiters) {
  const hub = new Hub();
  const tournaments = new TournamentService({
    db,
    hub,
    config: { ...DEFAULT_TOURNAMENT_CONFIG, enabled: false },
    clock: new ManualClock(),
  });
  const { app } = await createTestApp({ hub, tournaments, limiters });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    app,
    port,
    async close() {
      hub.closeAll();
      await app.close();
    },
  };
}

describe('websocket flood guard covers every path in', () => {
  /**
   * The measured attack: an unauthenticated socket firing garbage got one error frame back
   * per garbage frame, unthrottled, because the limiter used to sit below the parse.
   */
  it('throttles and then drops malformed frames instead of answering them', async () => {
    const server = await listening({
      ...relaxedLimiters(),
      wsMessages: new RateLimiter({ limit: 5, windowMs: 10_000 }),
    });
    try {
      const socket = await RawSocket.open(server.port);
      for (let index = 0; index < 200; index += 1) socket.send('}{ not json at all');
      await quiet();

      expect(socket.types().filter((type) => type === 'error')).toHaveLength(5);
      // One courtesy refusal, then silence: a garbage frame must not buy an error frame.
      expect(socket.types().filter((type) => type === 'tourney:rejected')).toHaveLength(1);
      socket.close();
    } finally {
      await server.close();
    }
  });

  it('spends the same budget on ping as on a real move', async () => {
    const server = await listening({
      ...relaxedLimiters(),
      wsMessages: new RateLimiter({ limit: 5, windowMs: 10_000 }),
    });
    const clients: TestClient[] = [];
    try {
      const account = await registerAccount(server.app, { username: uniqueUsername('pinger') });
      await makeCharacter(server.app, account, 'Pinger');
      const client = await TestClient.connect(`http://127.0.0.1:${server.port}`, account.accessToken);
      clients.push(client);

      const rejected = client.next('tourney:rejected', (message) => message.code === 'RATE_LIMITED', 5_000);
      for (let index = 0; index < 50; index += 1) client.send({ type: 'ping' });

      expect((await rejected).code).toBe('RATE_LIMITED');
    } finally {
      await closeAll(clients);
      await server.close();
    }
  });

  it('shares one budget across every socket of the same source', async () => {
    const server = await listening({
      ...relaxedLimiters(),
      wsSource: new RateLimiter({ limit: 8, windowMs: 10_000 }),
    });
    const clients: TestClient[] = [];
    try {
      const account = await registerAccount(server.app, { username: uniqueUsername('multi') });
      await makeCharacter(server.app, account, 'Multi');
      const first = await TestClient.connect(`http://127.0.0.1:${server.port}`, account.accessToken);
      const second = await TestClient.connect(`http://127.0.0.1:${server.port}`, account.accessToken);
      clients.push(first, second);

      for (let index = 0; index < 6; index += 1) first.send({ type: 'ping' });
      const rejected = second.next('tourney:rejected', (message) => message.code === 'RATE_LIMITED', 5_000);
      for (let index = 0; index < 6; index += 1) second.send({ type: 'ping' });

      // A second socket buys no extra throughput: the first one already spent the budget.
      expect((await rejected).code).toBe('RATE_LIMITED');
    } finally {
      await closeAll(clients);
      await server.close();
    }
  });

  it('does not hand a reconnecting flooder a fresh allowance', async () => {
    const server = await listening({
      ...relaxedLimiters(),
      wsSource: new RateLimiter({ limit: 3, windowMs: 10_000 }),
    });
    try {
      const flooder = await RawSocket.open(server.port);
      for (let index = 0; index < 40; index += 1) flooder.send('garbage');
      await quiet();
      expect(flooder.types()).toContain('tourney:rejected');
      flooder.close();
      await quiet(100);

      const reconnected = await RawSocket.open(server.port);
      reconnected.send('garbage');
      await quiet();

      // Still blocked: the escalation lives on the source, not on the socket that earned it.
      expect(reconnected.types()).not.toContain('error');
      expect(reconnected.codes()).toEqual(['RATE_LIMITED']);
      reconnected.close();
    } finally {
      await server.close();
    }
  });

  it('refuses to open more than the per-address anonymous socket cap', async () => {
    const server = await listening(relaxedLimiters());
    const open: RawSocket[] = [];
    try {
      for (let index = 0; index < MAX_ANON_SOCKETS_PER_IP; index += 1) {
        open.push(await RawSocket.open(server.port));
      }
      await expect(RawSocket.open(server.port)).rejects.toThrow();

      // A slot freed by a disconnect is handed back.
      open.pop()!.close();
      await quiet(100);
      open.push(await RawSocket.open(server.port));
    } finally {
      for (const socket of open) socket.close();
      await server.close();
    }
  }, 30_000);
});

/**
 * Carrier NAT, campus and office networks put thousands of unrelated players behind one
 * public address. None of the per-address defences may turn one anonymous flooder into a
 * lockout of everybody else sharing it.
 */
describe('a shared public address is not held hostage by one anonymous flooder', () => {
  it('lets a co-NATed player authenticate through a poisoned address bucket', async () => {
    const server = await listening({
      ...relaxedLimiters(),
      wsSource: new RateLimiter({ limit: 3, windowMs: 10_000, maxBackoffMs: 15 * 60_000 }),
    });
    const clients: TestClient[] = [];
    try {
      const account = await registerAccount(server.app, { username: uniqueUsername('conat') });
      await makeCharacter(server.app, account, 'Conat');

      const flooder = await RawSocket.open(server.port);
      for (let index = 0; index < 200; index += 1) flooder.send('garbage');
      await quiet();
      expect(flooder.codes()).toContain('RATE_LIMITED');

      // Same address, valid token, while the flooder is still connected and still
      // hammering the shared `ip:` bucket.
      for (let index = 0; index < 200; index += 1) flooder.send('garbage');
      const player = await TestClient.connect(`http://127.0.0.1:${server.port}`, account.accessToken);
      clients.push(player);
      expect(player.received('ready')).toHaveLength(1);

      // And once past the handshake it is on its own account budget, not the address's.
      player.send({ type: 'ping' });
      await quiet();
      expect(player.received('tourney:rejected')).toHaveLength(0);
      flooder.close();
    } finally {
      await closeAll(clients);
      await server.close();
    }
  });

  it('does not let anonymous sockets consume the budget of authenticated ones', async () => {
    const server = await listening(relaxedLimiters());
    const hogged: RawSocket[] = [];
    const clients: TestClient[] = [];
    try {
      const account = await registerAccount(server.app, { username: uniqueUsername('hogged') });
      await makeCharacter(server.app, account, 'Hogged');

      for (let index = 0; index < MAX_ANON_SOCKETS_PER_IP; index += 1) {
        hogged.push(await RawSocket.open(server.port));
      }
      await expect(RawSocket.open(server.port)).rejects.toThrow();

      // One authenticated socket frees the anonymous slot it borrowed, so a queue of
      // honest players behind this address keeps flowing however many anonymous sockets
      // are parked on it.
      hogged.pop()!.close();
      await quiet(100);
      for (let index = 0; index < 3; index += 1) {
        clients.push(await TestClient.connect(`http://127.0.0.1:${server.port}`, account.accessToken));
      }
    } finally {
      for (const socket of hogged) socket.close();
      await closeAll(clients);
      await server.close();
    }
  }, 30_000);

  it('recycles parked anonymous sockets faster once an address leans on the cap', async () => {
    const server = await listening(relaxedLimiters());
    const parked: RawSocket[] = [];
    try {
      for (let index = 0; index <= MAX_ANON_SOCKETS_PER_IP / 2; index += 1) {
        parked.push(await RawSocket.open(server.port));
      }
      const opened = Date.now();
      const squatter = await RawSocket.open(server.port);
      const closed = await new Promise<number>((resolve) => {
        squatter.onClose(() => resolve(Date.now() - opened));
      });

      expect(closed).toBeLessThan(WS_AUTH_TIMEOUT_MS);
    } finally {
      for (const socket of parked) socket.close();
      await server.close();
    }
  }, 30_000);

  it('still bounds how many sockets one account may hold', async () => {
    const server = await listening(relaxedLimiters());
    const clients: TestClient[] = [];
    try {
      const account = await registerAccount(server.app, { username: uniqueUsername('greedy') });
      await makeCharacter(server.app, account, 'Greedy');

      for (let index = 0; index < MAX_SOCKETS_PER_ACCOUNT; index += 1) {
        clients.push(await TestClient.connect(`http://127.0.0.1:${server.port}`, account.accessToken));
      }
      const overflow = await RawSocket.open(server.port);
      overflow.send(JSON.stringify({ type: 'auth', token: account.accessToken }));
      await quiet(300);

      expect(overflow.types()).toEqual(['error']);
      expect(overflow.codes()).toEqual(['RATE_LIMITED']);
    } finally {
      await closeAll(clients);
      await server.close();
    }
  }, 30_000);
});

describe('websocket flood guard', () => {
  it('rejects a resync flood rather than amplifying it', async () => {
    const hub = new Hub();
    const limiters = {
      ...relaxedLimiters(),
      wsResync: new RateLimiter({ limit: 3, windowMs: 10_000 }),
    };
    const tournaments = new TournamentService({
      db,
      hub,
      config: { ...DEFAULT_TOURNAMENT_CONFIG, enabled: false },
      clock: new ManualClock(),
    });
    const { app } = await createTestApp({ hub, tournaments, limiters });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const clients: TestClient[] = [];
    try {
      const account = await registerAccount(app, { username: uniqueUsername('flood') });
      await makeCharacter(app, account, 'Flooder');
      const client = await TestClient.connect(`http://127.0.0.1:${port}`, account.accessToken);
      clients.push(client);

      const rejected = client.next('tourney:rejected', (message) => message.code === 'RATE_LIMITED');
      for (let index = 0; index < 20; index += 1) client.send({ type: 'tourney:resync' });

      expect((await rejected).code).toBe('RATE_LIMITED');
    } finally {
      await closeAll(clients);
      hub.closeAll();
      await app.close();
    }
  });

  it('lets an honest player act at a normal pace', async () => {
    const hub = new Hub();
    const tournaments = new TournamentService({
      db,
      hub,
      config: { ...DEFAULT_TOURNAMENT_CONFIG, enabled: false },
      clock: new ManualClock(),
    });
    const { app } = await createTestApp({ hub, tournaments, limiters: relaxedLimiters() });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const clients: TestClient[] = [];
    try {
      const account = await registerAccount(app, { username: uniqueUsername('polite') });
      await makeCharacter(app, account, 'Polite');
      const client = await TestClient.connect(`http://127.0.0.1:${port}`, account.accessToken);
      clients.push(client);

      // Not seated, so the honest answer is NOT_SEATED — never a rate-limit rejection.
      const error = client.next('error');
      client.send({
        type: 'tourney:act',
        handId: crypto.randomUUID(),
        seq: 0,
        action: 'check',
      });
      expect((await error).code).toBe('NOT_SEATED');
      expect(client.received('tourney:rejected')).toHaveLength(0);
    } finally {
      await closeAll(clients);
      hub.closeAll();
      await app.close();
    }
  });
});

describe('tournament status carries the character', () => {
  /**
   * The entry-risk warning is computed from HP and coins, and a player whose socket has
   * dropped only ever sees this poll — so a stale wallet here is a wrong warning before an
   * irreversible, pet-killing choice.
   */
  it('returns the caller\'s current character alongside the tournament', async () => {
    const { app } = await createTestApp();
    try {
      const account = await registerAccount(app, { username: uniqueUsername('status') });
      const character = await makeCharacter(app, account, 'Statusy');
      await db.query('UPDATE characters SET lethal_coins = 17 WHERE id = $1', [character.id]);

      const response = await app.inject(
        authed(account, { method: 'GET', url: '/api/v1/tournaments/current' }),
      );
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.character.id).toBe(character.id);
      expect(body.character.lethalCoins).toBe(17);
    } finally {
      await app.close();
    }
  });

  it('returns a null character when the account has none', async () => {
    const { app } = await createTestApp();
    try {
      const account = await registerAccount(app, { username: uniqueUsername('nochar') });
      const response = await app.inject(
        authed(account, { method: 'GET', url: '/api/v1/tournaments/current' }),
      );
      expect(response.json().character).toBeNull();
    } finally {
      await app.close();
    }
  });
});
