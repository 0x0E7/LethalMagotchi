import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { STARTING_LETHAL_COINS, TOWN_SQUARE_CHANNEL_ID, type DuelThrow } from '@lethalmagotchi/shared';
import { ChatService } from '../../src/chat/service.js';
import type { Db } from '../../src/db/pool.js';
import { DuelService } from '../../src/duel/service.js';
import type { Limiters } from '../../src/deps.js';
import { listEligibleCharacterIds } from '../../src/repos/tournaments.js';
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

interface Booted {
  app: FastifyInstance;
  baseUrl: string;
  duels: DuelService;
  close: () => Promise<void>;
}

let db: Db;

beforeAll(() => {
  db = testPool();
});

afterAll(async () => {
  await closeTestPool();
});

async function boot(options: { limiters?: Limiters; revealMs?: number } = {}): Promise<Booted> {
  const pool = testPool();
  const hub = new Hub();
  const limiters = options.limiters ?? relaxedLimiters();
  const chat = new ChatService({ db: pool, hub, limiters });
  // The window stays at its real 5s; only the between-rounds beat is shortened, since both
  // duelists in these tests lock immediately and the beat is pure waiting.
  const duels = new DuelService({ db: pool, hub, chat, limiters, revealMs: options.revealMs ?? 20 });
  const { app } = await createTestApp({ hub, chat, duels, limiters });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    app,
    duels,
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
  options: { ageHours?: number; coins?: number } = {},
): Promise<Player> {
  const account = await registerAccount(app, { username: uniqueUsername('duel') });
  const response = await app.inject(
    authed(account, { method: 'POST', url: '/api/v1/characters', payload: { ...VALID_CHARACTER, nickname } }),
  );
  expect(response.statusCode, response.body).toBe(201);
  const characterId = response.json().character.id as string;

  // Duels open at 24h, so every fixture is born two days ago unless a test wants otherwise.
  await db.query(`UPDATE characters SET created_at = now() - ($2 || ' hours')::interval WHERE id = $1`, [
    characterId,
    String(options.ageHours ?? 48),
  ]);
  if (options.coins !== undefined) {
    await db.query('UPDATE characters SET lethal_coins = $2 WHERE id = $1', [characterId, options.coins]);
  }
  return { ...account, characterId, nickname };
}

async function coinsOf(characterId: string): Promise<number> {
  const result = await db.query<{ lethal_coins: number }>(
    'SELECT lethal_coins FROM characters WHERE id = $1',
    [characterId],
  );
  return result.rows[0]!.lethal_coins;
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

/** Both sides lock inside the window, so nothing here is ever auto-thrown. */
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

describe('a duel from invite to grave', () => {
  it('kills the loser, pays the winner the capped stake and tells the town', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const winner = await makePlayer(booted.app, 'Miso', { coins: 120 });
      const loser = await makePlayer(booted.app, 'Pepper', { coins: 40 });
      const bystander = await makePlayer(booted.app, 'Onlooker');

      const a = await TestClient.connect(booted.baseUrl, winner.accessToken);
      const b = await TestClient.connect(booted.baseUrl, loser.accessToken);
      const c = await TestClient.connect(booted.baseUrl, bystander.accessToken);
      clients.push(a, b, c);

      const { duelId, inviteId } = await startDuel(a, b, loser.characterId);

      // Both wallets are locked to the duel for its whole length.
      const locked = await db.query<{ active_duel_id: string | null }>(
        'SELECT active_duel_id FROM characters WHERE id = ANY($1::uuid[])',
        [[winner.characterId, loser.characterId]],
      );
      expect(locked.rows.every((row) => row.active_duel_id === duelId)).toBe(true);

      await playRound(a, b, duelId, 'rock', 'scissors');
      await playRound(a, b, duelId, 'paper', 'rock');

      const end = await a.next('duel:end');
      await b.next('duel:end');
      expect(end.outcome).toBe('death');
      expect(end.winnerCharacterId).toBe(winner.characterId);
      expect(end.loserCharacterId).toBe(loser.characterId);
      // min(120, 40) — never the loser's whole wallet, and never more than the winner risked.
      expect(end.coinsTransferred).toBe(40);
      expect(end.rebirth).toEqual({ characterId: loser.characterId, rebirthIndex: 1 });

      expect(await coinsOf(winner.characterId)).toBe(160);
      // The loser takes the ordinary rebirth reset, which is what a death means here.
      expect(await coinsOf(loser.characterId)).toBe(STARTING_LETHAL_COINS);

      const rebirth = await b.next('character:rebirth');
      expect(rebirth.cause).toBe('duel_defeat');
      expect(rebirth.coinsBefore).toBe(40);
      expect(rebirth.character.stats.hp).toBe(100);

      const duel = await db.query<{
        state: string;
        outcome: string;
        stake_coins: number;
        coins_transferred: number;
        challenger_wins: number;
        opponent_wins: number;
      }>('SELECT * FROM duels WHERE id = $1', [duelId]);
      expect(duel.rows[0]).toMatchObject({
        state: 'complete',
        outcome: 'death',
        stake_coins: 40,
        coins_transferred: 40,
        challenger_wins: 2,
        opponent_wins: 0,
      });

      const invite = await db.query<{ state: string; duel_id: string }>(
        'SELECT state, duel_id FROM duel_invites WHERE id = $1',
        [inviteId],
      );
      expect(invite.rows[0]).toMatchObject({ state: 'accepted', duel_id: duelId });

      // Every throw of the match is in the append-only log, both sides, both rounds.
      const actions = await db.query('SELECT * FROM duel_actions WHERE duel_id = $1', [duelId]);
      expect(actions.rowCount).toBe(4);

      const record = await db.query<{ id: string; duel_wins: number; duel_losses: number; active_duel_id: string | null }>(
        'SELECT id, duel_wins, duel_losses, active_duel_id FROM characters WHERE id = ANY($1::uuid[])',
        [[winner.characterId, loser.characterId]],
      );
      const byId = new Map(record.rows.map((row) => [row.id, row]));
      expect(byId.get(winner.characterId)).toMatchObject({ duel_wins: 1, duel_losses: 0, active_duel_id: null });
      expect(byId.get(loser.characterId)).toMatchObject({ duel_wins: 0, duel_losses: 1, active_duel_id: null });

      const event = await db.query<{ cause: string; duel_id: string; coins_before: number }>(
        'SELECT cause, duel_id, coins_before FROM rebirth_events WHERE character_id = $1',
        [loser.characterId],
      );
      expect(event.rows[0]).toMatchObject({ cause: 'duel_defeat', duel_id: duelId, coins_before: 40 });

      // The death is announced in the Town Square, authored by nobody.
      const announcement = await c.next('chat:message', (message) =>
        message.message.body.includes('defeated'),
      );
      expect(announcement.channelId).toBe(TOWN_SQUARE_CHANNEL_ID);
      expect(announcement.message.authorAccountId).toBeNull();
      expect(announcement.message.body).toBe('Miso defeated Pepper in a duel.');

      const stored = await db.query<{ author_account_id: string | null; author_character_id: string | null }>(
        'SELECT author_account_id, author_character_id FROM chat_messages WHERE id = $1',
        [announcement.message.id],
      );
      expect(stored.rows[0]).toEqual({ author_account_id: null, author_character_id: null });
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('pays nothing when the challenger has nothing to risk', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const broke = await makePlayer(booted.app, 'Skint', { coins: 0 });
      const rich = await makePlayer(booted.app, 'Loaded', { coins: 5_000 });

      const a = await TestClient.connect(booted.baseUrl, broke.accessToken);
      const b = await TestClient.connect(booted.baseUrl, rich.accessToken);
      clients.push(a, b);

      const { duelId, stakeCoins } = await startDuel(a, b, rich.characterId);
      expect(stakeCoins).toBe(0);

      await playRound(a, b, duelId, 'rock', 'scissors');
      await playRound(a, b, duelId, 'rock', 'scissors');

      const end = await a.next('duel:end');
      expect(end.coinsTransferred).toBe(0);
      expect(await coinsOf(broke.characterId)).toBe(0);
      // A wealthy loser still dies, and still keeps only what the reset leaves them.
      expect(await coinsOf(rich.characterId)).toBe(STARTING_LETHAL_COINS);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

describe('one invite, one duel', () => {
  it('yields exactly one duel when the same invite is accepted twice at once', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const challenger = await makePlayer(booted.app, 'Miso');
      const target = await makePlayer(booted.app, 'Pepper');

      const a = await TestClient.connect(booted.baseUrl, challenger.accessToken);
      const b1 = await TestClient.connect(booted.baseUrl, target.accessToken);
      const b2 = await TestClient.connect(booted.baseUrl, target.accessToken);
      clients.push(a, b1, b2);

      a.send({ type: 'duel:invite', targetCharacterId: target.characterId });
      const invited = await b1.next('duel:invited');

      // Two tabs answering the same challenge in the same tick.
      b1.send({ type: 'duel:respond', inviteId: invited.inviteId, accept: true });
      b2.send({ type: 'duel:respond', inviteId: invited.inviteId, accept: true });
      await a.next('duel:start');
      await new Promise((resolve) => setTimeout(resolve, 300));

      const duels = await db.query('SELECT id FROM duels WHERE invite_id = $1', [invited.inviteId]);
      expect(duels.rowCount).toBe(1);
      // Whichever tab lost the claim is answered as a challenge that has already moved on.
      const refusals = [...b1.received('duel:error'), ...b2.received('duel:error')];
      expect(refusals.map((message) => message.code)).toEqual(['EXPIRED']);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('refuses a second live challenge to the same target', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const challenger = await makePlayer(booted.app, 'Miso');
      const target = await makePlayer(booted.app, 'Pepper');
      const a = await TestClient.connect(booted.baseUrl, challenger.accessToken);
      const b = await TestClient.connect(booted.baseUrl, target.accessToken);
      clients.push(a, b);

      a.send({ type: 'duel:invite', targetCharacterId: target.characterId });
      await b.next('duel:invited');
      a.send({ type: 'duel:invite', targetCharacterId: target.characterId });

      const refused = await a.next('duel:error');
      expect(refused.code).toBe('INVITE_PENDING');
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

describe('the engagement lock, both ways', () => {
  it('blocks spending, tournament entry and character deletion for the length of a duel', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const challenger = await makePlayer(booted.app, 'Miso', { coins: 50 });
      const target = await makePlayer(booted.app, 'Pepper', { coins: 50 });
      const a = await TestClient.connect(booted.baseUrl, challenger.accessToken);
      const b = await TestClient.connect(booted.baseUrl, target.accessToken);
      clients.push(a, b);

      const { duelId } = await startDuel(a, b, target.characterId);

      const spend = await booted.app.inject(
        authed(challenger, { method: 'POST', url: '/api/v1/characters/me/actions/feed', payload: {} }),
      );
      expect(spend.statusCode).toBe(409);
      expect(spend.json().error.code).toBe('CHARACTER_IN_DUEL');

      const optIn = await booted.app.inject(
        authed(challenger, {
          method: 'POST',
          url: '/api/v1/characters/me/tournament-optin',
          payload: { optIn: true },
        }),
      );
      expect(optIn.statusCode).toBe(409);

      const deletion = await booted.app.inject(
        authed(challenger, { method: 'DELETE', url: '/api/v1/characters/me' }),
      );
      expect(deletion.statusCode).toBe(409);

      // The tournament's own entrant sweep skips a character who is mid-duel, so the entry
      // charge can never rebirth someone in the middle of a fight.
      const eligible = await listEligibleCharacterIds(db);
      const ids = new Set(eligible.map((row) => row.id));
      expect(ids.has(challenger.characterId)).toBe(false);
      expect(ids.has(target.characterId)).toBe(false);

      await playRound(a, b, duelId, 'rock', 'scissors');
      await playRound(a, b, duelId, 'rock', 'scissors');
      await a.next('duel:end');

      // And it lifts the moment the duel settles.
      const afterwards = await listEligibleCharacterIds(db);
      expect(afterwards.some((row) => row.id === challenger.characterId)).toBe(true);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('refuses a duel to and from a character sitting at a poker table', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const seated = await makePlayer(booted.app, 'Seated');
      const free = await makePlayer(booted.app, 'Free');
      await db.query('UPDATE characters SET seated_table_id = gen_random_uuid() WHERE id = $1', [
        seated.characterId,
      ]);

      const a = await TestClient.connect(booted.baseUrl, seated.accessToken);
      const b = await TestClient.connect(booted.baseUrl, free.accessToken);
      clients.push(a, b);

      a.send({ type: 'duel:invite', targetCharacterId: free.characterId });
      expect((await a.next('duel:error')).code).toBe('BUSY');

      b.send({ type: 'duel:invite', targetCharacterId: seated.characterId });
      expect((await b.next('duel:error')).code).toBe('TARGET_BUSY');
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});

describe('the anti-griefing floors', () => {
  it('keeps a character under a day old out of duels in both directions', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const fresh = await makePlayer(booted.app, 'Newborn', { ageHours: 2 });
      const veteran = await makePlayer(booted.app, 'Veteran');

      const a = await TestClient.connect(booted.baseUrl, fresh.accessToken);
      const b = await TestClient.connect(booted.baseUrl, veteran.accessToken);
      clients.push(a, b);

      a.send({ type: 'duel:invite', targetCharacterId: veteran.characterId });
      expect((await a.next('duel:error')).code).toBe('TOO_NEW');

      b.send({ type: 'duel:invite', targetCharacterId: fresh.characterId });
      expect((await b.next('duel:error')).code).toBe('TOO_NEW');
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('badges a decline for a rolling day and blocks that challenger for the same day', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const challenger = await makePlayer(booted.app, 'Pushy');
      const target = await makePlayer(booted.app, 'Careful');
      const a = await TestClient.connect(booted.baseUrl, challenger.accessToken);
      const b = await TestClient.connect(booted.baseUrl, target.accessToken);
      clients.push(a, b);

      a.send({ type: 'duel:invite', targetCharacterId: target.characterId });
      const invited = await b.next('duel:invited');
      b.send({ type: 'duel:respond', inviteId: invited.inviteId, accept: false });

      const state = await a.next('duel:invite_state', (message) => message.inviteId === invited.inviteId && message.state === 'declined');
      expect(state.state).toBe('declined');

      const badge = await db.query<{ chicken_badge_until: Date | null }>(
        'SELECT chicken_badge_until FROM characters WHERE id = $1',
        [target.characterId],
      );
      const until = badge.rows[0]!.chicken_badge_until!;
      const hoursOut = (until.getTime() - Date.now()) / 3_600_000;
      // Rolling 24h from the decline, not a local-day boundary.
      expect(hoursOut).toBeGreaterThan(23.9);
      expect(hoursOut).toBeLessThan(24.1);

      const card = await booted.app.inject(
        authed(challenger, { method: 'GET', url: `/api/v1/duels/cards?characterIds=${target.characterId}` }),
      );
      expect(card.json().cards[0].chickenBadgeUntil).toBe(until.toISOString());

      a.send({ type: 'duel:invite', targetCharacterId: target.characterId });
      expect((await a.next('duel:error')).code).toBe('COOLDOWN');

      // The cooldown is per pair and per direction: the decliner may still challenge back.
      b.send({ type: 'duel:invite', targetCharacterId: challenger.characterId });
      expect((await a.next('duel:invited')).from.characterId).toBe(target.characterId);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });

  it('lets the same pair duel again once the cooldown has passed', async () => {
    const booted = await boot();
    const clients: TestClient[] = [];
    try {
      const challenger = await makePlayer(booted.app, 'Patient');
      const target = await makePlayer(booted.app, 'Careful');
      const a = await TestClient.connect(booted.baseUrl, challenger.accessToken);
      const b = await TestClient.connect(booted.baseUrl, target.accessToken);
      clients.push(a, b);

      a.send({ type: 'duel:invite', targetCharacterId: target.characterId });
      const invited = await b.next('duel:invited');
      b.send({ type: 'duel:respond', inviteId: invited.inviteId, accept: false });
      await a.next('duel:invite_state', (message) => message.state === 'declined');

      await db.query(
        `UPDATE duel_invites SET resolved_at = now() - interval '25 hours' WHERE id = $1`,
        [invited.inviteId],
      );

      a.send({ type: 'duel:invite', targetCharacterId: target.characterId });
      const second = await b.next('duel:invited', (message) => message.inviteId !== invited.inviteId);
      expect(second.from.characterId).toBe(challenger.characterId);
    } finally {
      await closeAll(clients);
      await booted.close();
    }
  });
});
