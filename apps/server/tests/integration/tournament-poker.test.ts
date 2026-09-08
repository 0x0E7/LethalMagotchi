import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  ENTRY_FEE_COINS,
  MISS_PENALTY_COINS,
  STARTING_LETHAL_COINS,
  STARTING_STATS,
  type BettingAction,
  type Card,
  type CharacterDto,
} from '@lethalmagotchi/shared';
import { DEFAULT_TOURNAMENT_CONFIG } from '../../src/config.js';
import type { Db } from '../../src/db/pool.js';
import { TournamentService } from '../../src/tournament/service.js';
import { Hub } from '../../src/ws/hub.js';
import {
  authed,
  closeTestPool,
  createTestApp,
  registerAccount,
  testPool,
  uniqueUsername,
  VALID_CHARACTER,
  type TestAccount,
} from '../helpers/app.js';
import { TestClient, closeAll } from '../helpers/ws.js';
import { insertScheduledTournament, listEntries, listSeats, updateTournamentState } from '../../src/repos/tournaments.js';

interface Player {
  account: TestAccount;
  character: CharacterDto;
  client?: TestClient;
}

const FAST = {
  ...DEFAULT_TOURNAMENT_CONFIG,
  enabled: true,
  mode: 'interval' as const,
  turnMs: 4_000,
  showdownMs: 20,
  roundBreakMs: 20,
  tickMs: 50,
};

let db: Db;

beforeAll(() => {
  db = testPool();
});

afterAll(async () => {
  await closeTestPool();
});

async function makePlayer(app: FastifyInstance, nickname: string): Promise<Player> {
  const account = await registerAccount(app, { username: uniqueUsername('poker') });
  const response = await app.inject(
    authed(account, {
      method: 'POST',
      url: '/api/v1/characters',
      payload: { ...VALID_CHARACTER, nickname },
    }),
  );
  if (response.statusCode !== 201) throw new Error(`character create failed: ${response.body}`);
  return { account, character: response.json().character };
}

async function setCharacter(
  characterId: string,
  patch: { coins?: number; hp?: number; optIn?: boolean },
): Promise<void> {
  if (patch.coins !== undefined) {
    await db.query('UPDATE characters SET lethal_coins = $2 WHERE id = $1', [characterId, patch.coins]);
  }
  if (patch.hp !== undefined) {
    await db.query(
      `UPDATE characters SET stats = $2, last_simulated_at = now() WHERE id = $1`,
      [characterId, JSON.stringify({ ...STARTING_STATS, hp: patch.hp })],
    );
  }
  if (patch.optIn !== undefined) {
    await db.query('UPDATE characters SET tournament_opt_in = $2 WHERE id = $1', [characterId, patch.optIn]);
  }
}

/**
 * Registration close charges *every* character in the database by design, and the
 * integration suite shares one. Clearing opt-in first means each test controls its own
 * entrant list exactly; everyone else just pays the miss penalty, as they would in
 * production.
 */
async function resetOptIns(): Promise<void> {
  await db.query('UPDATE characters SET tournament_opt_in = false, seated_table_id = NULL');
  await db.query('UPDATE characters SET lethal_coins = 50 WHERE lethal_coins < 5');
}

async function characterRow(characterId: string) {
  const result = await db.query<{
    lethal_coins: number;
    stats: { hp: number };
    rebirth_count: number;
    seated_table_id: string | null;
    tournament_wins: number;
  }>('SELECT lethal_coins, stats, rebirth_count, seated_table_id, tournament_wins FROM characters WHERE id = $1', [
    characterId,
  ]);
  return result.rows[0]!;
}

/**
 * A listening server (WebSocket needs a real socket — `inject` cannot upgrade), with a
 * tournament service wired to the same hub the WS route uses.
 */
async function boot(configOverrides: Partial<typeof FAST> = {}) {
  const hub = new Hub();
  const tournamentConfig = { ...FAST, ...configOverrides };
  const tournaments = new TournamentService({ db, hub, config: tournamentConfig });
  const { app } = await createTestApp({ config: { tournament: tournamentConfig }, hub, tournaments });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    app,
    hub,
    tournaments,
    url: `http://127.0.0.1:${port}`,
    async close() {
      await tournaments.stop();
      hub.closeAll();
      await app.close();
    },
  };
}

async function makeTournament(scheduledFor = new Date(Date.now() + 60_000)) {
  const row = await insertScheduledTournament(db, {
    scope: 'global',
    slotKey: `test:${crypto.randomUUID()}`,
    scheduledFor,
    registrationOpensAt: new Date(scheduledFor.getTime() - 60_000),
  });
  return row!;
}

/**
 * Plays every hand of every round without the test knowing seat numbers up front — it
 * tracks its own seat from each `tourney:seated` and answers only its own turns. This is
 * what makes a multi-round tournament resolve in seconds instead of waiting out a turn
 * timeout on every single decision.
 */
function startAutoPlayer(client: TestClient, choose: (legal: BettingAction[]) => BettingAction): void {
  let mySeat = -1;

  const followSeat = (): void => {
    void client
      .next('tourney:seated', () => true, 120_000)
      .then((seated) => {
        mySeat = seated.seatIndex;
        followSeat();
      })
      .catch(() => undefined);
  };

  const followTurn = (): void => {
    void client
      .next('tourney:turn', () => true, 120_000)
      .then((turn) => {
        if (turn.seatIndex === mySeat) {
          const action = choose(turn.legal.actions);
          client.send({
            type: 'tourney:act',
            handId: turn.handId,
            seq: turn.seq,
            action,
            ...(action === 'bet' || action === 'raise' ? { amount: turn.legal.minRaiseTo } : {}),
          });
        }
        followTurn();
      })
      .catch(() => undefined);
  };

  followSeat();
  followTurn();
}

/** Plays every turn it is offered with the given policy until the table resolves. */
function autoPlay(client: TestClient, seatIndex: number, choose: (legal: BettingAction[]) => BettingAction): void {
  client.send({ type: 'tourney:resync' });
  const onTurn = (): void => {
    void client
      .next('tourney:turn', (message) => message.seatIndex === seatIndex, 30_000)
      .then((turn) => {
        const action = choose(turn.legal.actions);
        client.send({
          type: 'tourney:act',
          handId: turn.handId,
          seq: turn.seq,
          action,
          ...(action === 'bet' || action === 'raise' ? { amount: turn.legal.minRaiseTo } : {}),
        });
        onTurn();
      })
      .catch(() => undefined);
  };
  onTurn();
}

describe('tournament entry and the miss penalty', () => {
  it('debits three coins, escrows them, and leaves HP untouched when affordable', async () => {
    const server = await boot();
    await resetOptIns();
    try {
      const player = await makePlayer(server.app, 'Solvent');
      await setCharacter(player.character.id, { coins: 5, hp: 100, optIn: true });
      const other = await makePlayer(server.app, 'AlsoIn');
      await setCharacter(other.character.id, { coins: 5, hp: 100, optIn: true });

      const tournament = await makeTournament();
      await updateTournamentState(db, tournament.id, { state: 'registration' });
      await server.tournaments.closeRegistration({ ...tournament, state: 'registration' });

      const after = await characterRow(player.character.id);
      expect(after.lethal_coins).toBe(5 - ENTRY_FEE_COINS);
      expect(after.stats.hp).toBe(100);

      const entries = await listEntries(db, tournament.id);
      const mine = entries.find((entry) => entry.character_id === player.character.id);
      expect(mine?.current_stack).toBe(ENTRY_FEE_COINS);
      expect(Number(mine?.hp_converted)).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('converts 10% HP per missing coin when the wallet is short', async () => {
    const server = await boot();
    await resetOptIns();
    try {
      const player = await makePlayer(server.app, 'Broke');
      await setCharacter(player.character.id, { coins: 1, hp: 100, optIn: true });
      const other = await makePlayer(server.app, 'Rich');
      await setCharacter(other.character.id, { coins: 9, hp: 100, optIn: true });

      const tournament = await makeTournament();
      await server.tournaments.closeRegistration({ ...tournament, state: 'registration' });

      const after = await characterRow(player.character.id);
      expect(after.lethal_coins).toBe(0);
      expect(after.stats.hp).toBe(80);

      const entries = await listEntries(db, tournament.id);
      expect(Number(entries.find((entry) => entry.character_id === player.character.id)?.hp_converted)).toBe(20);
    } finally {
      await server.close();
    }
  });

  it('reborns rather than entering when the conversion would exhaust HP', async () => {
    const server = await boot();
    await resetOptIns();
    try {
      const doomed = await makePlayer(server.app, 'Doomed');
      await setCharacter(doomed.character.id, { coins: 1, hp: 19, optIn: true });
      const survivor = await makePlayer(server.app, 'Survivor');
      await setCharacter(survivor.character.id, { coins: 9, hp: 100, optIn: true });
      const third = await makePlayer(server.app, 'Third');
      await setCharacter(third.character.id, { coins: 9, hp: 100, optIn: true });

      const client = await TestClient.connect(server.url, doomed.account.accessToken);
      const rebirth = client.next('character:rebirth');

      const tournament = await makeTournament();
      await server.tournaments.closeRegistration({ ...tournament, state: 'registration' });

      const event = await rebirth;
      expect(event.statsBefore.hp).toBe(19);
      expect(event.coinsBefore).toBe(1);
      expect(event.rebirthIndex).toBe(1);
      expect(event.character.lethalCoins).toBe(STARTING_LETHAL_COINS);
      expect(event.character.stats.hp).toBe(100);
      expect(event.character.nickname).toBe('Doomed');

      const after = await characterRow(doomed.character.id);
      expect(after.rebirth_count).toBe(1);
      expect(after.lethal_coins).toBe(STARTING_LETHAL_COINS);
      expect(after.stats.hp).toBe(100);

      const events = await db.query(
        'SELECT cause, coins_before, stats_before FROM rebirth_events WHERE character_id = $1',
        [doomed.character.id],
      );
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0]).toMatchObject({ cause: 'tournament_entry_hp_exhausted', coins_before: 1 });

      const entries = await listEntries(db, tournament.id);
      expect(entries.some((entry) => entry.character_id === doomed.character.id)).toBe(false);

      await closeAll([client]);
    } finally {
      await server.close();
    }
  });

  it('charges the one-coin miss penalty to a character that did not opt in', async () => {
    const server = await boot();
    await resetOptIns();
    try {
      const skipper = await makePlayer(server.app, 'Skipper');
      await setCharacter(skipper.character.id, { coins: 4, hp: 100, optIn: false });
      const a = await makePlayer(server.app, 'EntrantA');
      await setCharacter(a.character.id, { coins: 9, hp: 100, optIn: true });
      const b = await makePlayer(server.app, 'EntrantB');
      await setCharacter(b.character.id, { coins: 9, hp: 100, optIn: true });

      const tournament = await makeTournament();
      await server.tournaments.closeRegistration({ ...tournament, state: 'registration' });

      const after = await characterRow(skipper.character.id);
      expect(after.lethal_coins).toBe(4 - MISS_PENALTY_COINS);

      const entries = await listEntries(db, tournament.id);
      expect(entries.some((entry) => entry.character_id === skipper.character.id)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('takes a non-participant down the same rebirth path when it cannot pay the penalty', async () => {
    const server = await boot();
    await resetOptIns();
    try {
      const broke = await makePlayer(server.app, 'BrokeSkipper');
      await setCharacter(broke.character.id, { coins: 0, hp: 9, optIn: false });
      const a = await makePlayer(server.app, 'EntrantC');
      await setCharacter(a.character.id, { coins: 9, hp: 100, optIn: true });
      const b = await makePlayer(server.app, 'EntrantD');
      await setCharacter(b.character.id, { coins: 9, hp: 100, optIn: true });

      const tournament = await makeTournament();
      await server.tournaments.closeRegistration({ ...tournament, state: 'registration' });

      const after = await characterRow(broke.character.id);
      expect(after.rebirth_count).toBe(1);
      expect(after.lethal_coins).toBe(STARTING_LETHAL_COINS);
    } finally {
      await server.close();
    }
  });

  it('cancels and refunds when fewer than two characters enter', async () => {
    const server = await boot();
    await resetOptIns();
    try {
      // Everyone else in the shared database is opted out by default, so a lone
      // opted-in character is the only entrant.
      const lonely = await makePlayer(server.app, 'Lonely');
      await setCharacter(lonely.character.id, { coins: 9, hp: 100, optIn: true });

      const tournament = await makeTournament();
      await server.tournaments.closeRegistration({ ...tournament, state: 'registration' });

      const state = await db.query<{ state: string }>('SELECT state FROM tournaments WHERE id = $1', [
        tournament.id,
      ]);
      expect(state.rows[0]!.state).toBe('cancelled');

      const after = await characterRow(lonely.character.id);
      // Charged 3, refunded 3.
      expect(after.lethal_coins).toBe(9);
      expect(after.seated_table_id).toBeNull();
    } finally {
      await server.close();
    }
  });
});

describe('a live five-seat table', () => {
  it('plays to a table result with real sockets, never leaking a hole card', async () => {
    const server = await boot();
    await resetOptIns();
    const clients: TestClient[] = [];
    try {
      const players: Player[] = [];
      for (const nickname of ['Miso', 'Pepper', 'Juniper', 'Waffles', 'Clover']) {
        const player = await makePlayer(server.app, nickname);
        await setCharacter(player.character.id, { coins: 9, hp: 100, optIn: true });
        players.push(player);
      }

      for (const player of players) {
        const client = await TestClient.connect(server.url, player.account.accessToken);
        clients.push(client);
        player.client = client;
      }

      const seated = players.map((player) => player.client!.next('tourney:seated'));
      const tournament = await makeTournament();
      await server.tournaments.closeRegistration({ ...tournament, state: 'registration' });
      const seats = await Promise.all(seated);

      expect(new Set(seats.map((seat) => seat.tableId)).size).toBe(1);
      expect(seats[0]!.seats).toHaveLength(5);
      expect(new Set(seats.map((seat) => seat.seatIndex)).size).toBe(5);

      const results = players.map((player) => player.client!.next('tourney:table_result', () => true, 60_000));
      players.forEach((player, index) => {
        // A spread of styles so the hand actually reaches a board and a showdown.
        const style = index % 3;
        autoPlay(player.client!, seats[index]!.seatIndex, (legal) => {
          if (style === 0 && legal.includes('check')) return 'check';
          if (style === 0) return 'call';
          if (style === 1) return legal.includes('check') ? 'check' : 'call';
          return legal.includes('check') ? 'check' : 'call';
        });
      });

      const tableResults = await Promise.all(results);
      const qualifier = tableResults[0]!.qualifierCharacterId;
      expect(qualifier).toBeTruthy();
      for (const result of tableResults) expect(result.qualifierCharacterId).toBe(qualifier);

      // Escrow conservation: five 3-coin entries stay five 3-coin entries.
      expect(tableResults[0]!.standings.reduce((sum, standing) => sum + standing.stack, 0)).toBe(15);

      // Every player saw a showdown, and their own cards.
      for (const player of players) {
        expect(player.client!.received('tourney:private').length).toBeGreaterThan(0);
        expect(player.client!.received('tourney:showdown').length).toBeGreaterThan(0);
      }

      /**
       * The security assertion: for each pair of players, no card another player was
       * privately dealt appears anywhere in this socket's raw transcript up to the first
       * showdown. Serialising and searching is what makes a newly-added leaky field fail
       * here rather than pass unnoticed.
       */
      const firstHandId = players[0]!.client!.received('tourney:hand_start')[0]!.handId;
      const handCardsOf = (player: Player): Card[] => [
        ...new Set(
          player
            .client!.received('tourney:private')
            .filter((message) => message.handId === firstHandId)
            .flatMap((message) => message.holeCards),
        ),
      ];

      for (const [index, player] of players.entries()) {
        // Everything this socket received before any showdown revealed anything.
        const showdownAt = player.client!.frames.findIndex((frame) => frame.includes('"tourney:showdown"'));
        const transcript = player.client!.frames.slice(0, showdownAt).join('\n');

        const ownCards = handCardsOf(player);
        const board = new Set(
          player
            .client!.received('tourney:board')
            .filter((message) => message.handId === firstHandId)
            .flatMap((message) => message.cards),
        );

        for (const [otherIndex, other] of players.entries()) {
          if (otherIndex === index) continue;
          for (const card of handCardsOf(other)) {
            if (ownCards.includes(card) || board.has(card)) continue;
            expect(transcript).not.toContain(`"${card}"`);
          }
        }

        // Never vacuous: the owner does receive exactly their own two cards.
        expect(ownCards).toHaveLength(2);
        for (const card of ownCards) expect(transcript).toContain(`"${card}"`);
      }
    } finally {
      await closeAll(clients);
      await server.close();
    }
  }, 90_000);

  it('rejects a replayed seq so a double-click can never act twice', async () => {
    // A generous deadline on purpose: if the turn expired between being offered and the
    // duplicate click landing, the timeout auto-action would advance `seq` and this test
    // would be measuring the timeout path instead of the replay path.
    const server = await boot({ turnMs: 30_000 });
    await resetOptIns();
    const clients: TestClient[] = [];
    try {
      const players: Player[] = [];
      for (const nickname of ['Dup1', 'Dup2', 'Dup3']) {
        const player = await makePlayer(server.app, nickname);
        await setCharacter(player.character.id, { coins: 9, hp: 100, optIn: true });
        players.push(player);
      }
      for (const player of players) {
        const client = await TestClient.connect(server.url, player.account.accessToken);
        clients.push(client);
        player.client = client;
      }

      const seated = players.map((player) => player.client!.next('tourney:seated'));
      const tournament = await makeTournament();
      await server.tournaments.closeRegistration({ ...tournament, state: 'registration' });
      const seats = await Promise.all(seated);

      const turn = await Promise.race(players.map((player) => player.client!.next('tourney:turn')));
      const actor = players.find((player, index) => seats[index]!.seatIndex === turn.seatIndex)!;
      const rejected = actor.client!.next('tourney:rejected');

      const action = turn.legal.actions.includes('check') ? 'check' : 'call';
      actor.client!.send({ type: 'tourney:act', handId: turn.handId, seq: turn.seq, action });
      actor.client!.send({ type: 'tourney:act', handId: turn.handId, seq: turn.seq, action });

      const rejection = await rejected;
      expect(rejection.code).toBe('STALE_SEQ');
      expect(rejection.seq).toBe(turn.seq);

      const applied = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM hand_actions
         WHERE hand_id = $1 AND seat_index = $2 AND seq = $3`,
        [turn.handId, turn.seatIndex, turn.seq + 1],
      );
      expect(Number(applied.rows[0]!.count)).toBe(1);
    } finally {
      await closeAll(clients);
      await server.close();
    }
  }, 60_000);

  it('does not stall when a seated player disconnects mid-hand', async () => {
    const server = await boot({ turnMs: 700 });
    await resetOptIns();
    const clients: TestClient[] = [];
    try {
      const players: Player[] = [];
      for (const nickname of ['Ghost', 'Stayer1', 'Stayer2'] as const) {
        const player = await makePlayer(server.app, nickname);
        await setCharacter(player.character.id, { coins: 9, hp: 100, optIn: true });
        players.push(player);
      }
      for (const player of players) {
        const client = await TestClient.connect(server.url, player.account.accessToken);
        clients.push(client);
        player.client = client;
      }

      const seated = players.map((player) => player.client!.next('tourney:seated'));
      const tournament = await makeTournament();
      await server.tournaments.closeRegistration({ ...tournament, state: 'registration' });
      const seats = await Promise.all(seated);

      // The first player walks away entirely; the table must resolve without it. The
      // other two keep playing normally, so only the absent seat ever hits a deadline.
      players[0]!.client!.close();
      const watcher = await TestClient.connect(server.url, players[1]!.account.accessToken);
      clients.push(watcher);
      for (const [index, player] of players.entries()) {
        if (index === 0) continue;
        autoPlay(player.client!, seats[index]!.seatIndex, (legal) =>
          legal.includes('check') ? 'check' : 'call',
        );
      }

      const result = await watcher.next('tourney:table_result', () => true, 60_000);
      expect(result.standings).toHaveLength(3);
      expect(result.standings.reduce((sum, standing) => sum + standing.stack, 0)).toBe(9);

      const timeouts = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM hand_actions ha
         JOIN hands h ON h.id = ha.hand_id
         WHERE h.table_id = $1 AND ha.action LIKE 'timeout_%' AND ha.seat_index = $2`,
        [result.tableId, seats[0]!.seatIndex],
      );
      expect(Number(timeouts.rows[0]!.count)).toBeGreaterThan(0);
    } finally {
      await closeAll(clients);
      await server.close();
    }
  }, 90_000);

  it('resyncs a reconnecting player back into the same seat with their own cards', async () => {
    const server = await boot({ turnMs: 10_000 });
    await resetOptIns();
    const clients: TestClient[] = [];
    try {
      const players: Player[] = [];
      for (const nickname of ['Rejoin', 'Waiter1', 'Waiter2']) {
        const player = await makePlayer(server.app, nickname);
        await setCharacter(player.character.id, { coins: 9, hp: 100, optIn: true });
        players.push(player);
      }
      for (const player of players) {
        const client = await TestClient.connect(server.url, player.account.accessToken);
        clients.push(client);
        player.client = client;
      }

      const seated = players.map((player) => player.client!.next('tourney:seated'));
      const tournament = await makeTournament();
      await server.tournaments.closeRegistration({ ...tournament, state: 'registration' });
      const seats = await Promise.all(seated);
      const original = await players[0]!.client!.next('tourney:private');

      players[0]!.client!.close();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const rejoined = await TestClient.connect(server.url, players[0]!.account.accessToken);
      clients.push(rejoined);

      const seat = await rejoined.next('tourney:seated');
      expect(seat.seatIndex).toBe(seats[0]!.seatIndex);
      expect(seat.tableId).toBe(seats[0]!.tableId);

      const restored = await rejoined.next('tourney:private');
      expect(restored.holeCards).toEqual(original.holeCards);
      expect(restored.bestHand).toBeTruthy();
    } finally {
      await closeAll(clients);
      await server.close();
    }
  }, 60_000);
});

describe('escrow and settlement', () => {
  it('returns every escrowed coin plus the house prize across a full tournament', async () => {
    const server = await boot({ turnMs: 900 });
    await resetOptIns();
    const clients: TestClient[] = [];
    try {
      const players: Player[] = [];
      for (const nickname of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6']) {
        const player = await makePlayer(server.app, nickname);
        await setCharacter(player.character.id, { coins: 9, hp: 100, optIn: true });
        players.push(player);
      }
      const watcher = await TestClient.connect(server.url, players[0]!.account.accessToken);
      clients.push(watcher);

      for (const player of players) {
        const client = await TestClient.connect(server.url, player.account.accessToken);
        clients.push(client);
        player.client = client;
        startAutoPlayer(client, (legal) => (legal.includes('check') ? 'check' : 'call'));
      }

      const tournament = await makeTournament();
      await server.tournaments.closeRegistration({ ...tournament, state: 'registration' });

      // Watched on a second socket for the same account: the auto-player consumes its
      // own client's messages, so the assertion needs an independent transcript.
      const winner = await watcher.next('tourney:winner', () => true, 150_000);
      expect(winner.prizeCoins).toBe(6);

      // Let the settlement transaction land before reading wallets.
      await new Promise((resolve) => setTimeout(resolve, 300));

      let total = 0;
      for (const player of players) {
        const row = await characterRow(player.character.id);
        total += row.lethal_coins;
        expect(row.seated_table_id).toBeNull();
      }

      // Six wallets started at 9, each paid 3 into escrow; every coin comes back, plus
      // the house-funded prize of one coin per entrant.
      expect(total).toBe(6 * 9 + 6);

      const champion = await characterRow(winner.characterId);
      expect(champion.tournament_wins).toBe(1);

      const cosmetics = await db.query<{ owned_cosmetics: string[] }>(
        `SELECT a.owned_cosmetics FROM accounts a
         JOIN characters c ON c.account_id = a.id WHERE c.id = $1`,
        [winner.characterId],
      );
      expect(cosmetics.rows[0]!.owned_cosmetics).toContain('champion_crown');
    } finally {
      await closeAll(clients);
      await server.close();
    }
  }, 180_000);

  it('resolves unequal all-in stacks without creating or destroying coins', async () => {
    const server = await boot({ turnMs: 700 });
    await resetOptIns();
    const clients: TestClient[] = [];
    try {
      const players: Player[] = [];
      for (const nickname of ['Short', 'Mid', 'Big']) {
        const player = await makePlayer(server.app, nickname);
        await setCharacter(player.character.id, { coins: 20, hp: 100, optIn: false });
        players.push(player);
      }
      for (const player of players) {
        const client = await TestClient.connect(server.url, player.account.accessToken);
        clients.push(client);
        player.client = client;
      }

      const tournament = await makeTournament();
      await updateTournamentState(db, tournament.id, { state: 'running', prizePotCoins: 0, totalRounds: 1 });

      // Seeded escrow directly so the side-pot layers are unequal by construction.
      const stacks = [2, 6, 12];
      for (const [index, player] of players.entries()) {
        await db.query(
          `INSERT INTO tournament_entries (tournament_id, character_id, current_stack) VALUES ($1, $2, $3)`,
          [tournament.id, player.character.id, stacks[index]],
        );
      }

      const seated = players.map((player) => player.client!.next('tourney:seated'));
      await server.tournaments.startRound(
        { ...tournament, state: 'running', total_rounds: 1 },
        1,
        players.map((player) => player.character.id),
      );
      const seats = await Promise.all(seated);
      expect(seats[0]!.seats.map((seat) => seat.stack).sort((a, b) => a - b)).toEqual([2, 6, 12]);

      players.forEach((player, index) => {
        autoPlay(player.client!, seats[index]!.seatIndex, (legal) =>
          legal.includes('allin') ? 'allin' : legal.includes('call') ? 'call' : 'check',
        );
      });

      const result = await players[0]!.client!.next('tourney:table_result', () => true, 90_000);
      expect(result.standings.reduce((sum, standing) => sum + standing.stack, 0)).toBe(20);

      const seatRows = await listSeats(db, result.tableId);
      expect(seatRows.reduce((sum, seat) => sum + seat.stack, 0)).toBe(20);
    } finally {
      await closeAll(clients);
      await server.close();
    }
  }, 120_000);
});

describe('websocket authentication', () => {
  it('refuses messages before auth and closes an unauthenticated socket', async () => {
    const server = await boot();
    await resetOptIns();
    try {
      const { WebSocket } = await import('ws');
      const socket = new WebSocket(`${server.url.replace('http', 'ws')}/ws`);
      await new Promise<void>((resolve) => socket.once('open', () => resolve()));

      const first = await new Promise<string>((resolve) => {
        socket.once('message', (raw: Buffer) => resolve(raw.toString()));
        socket.send(JSON.stringify({ type: 'tourney:resync' }));
      });
      expect(JSON.parse(first)).toMatchObject({ type: 'error', code: 'UNAUTHENTICATED' });
      socket.close();
    } finally {
      await server.close();
    }
  });

  it('rejects a bad token', async () => {
    const server = await boot();
    await resetOptIns();
    try {
      const { WebSocket } = await import('ws');
      const socket = new WebSocket(`${server.url.replace('http', 'ws')}/ws`);
      await new Promise<void>((resolve) => socket.once('open', () => resolve()));

      const first = await new Promise<string>((resolve) => {
        socket.once('message', (raw: Buffer) => resolve(raw.toString()));
        socket.send(JSON.stringify({ type: 'auth', token: 'not-a-jwt' }));
      });
      expect(JSON.parse(first)).toMatchObject({ type: 'error', code: 'UNAUTHENTICATED' });
    } finally {
      await server.close();
    }
  });

  it('rejects an unknown message shape', async () => {
    const server = await boot();
    await resetOptIns();
    try {
      const account = await registerAccount(server.app, { username: uniqueUsername('wsbad') });
      const client = await TestClient.connect(server.url, account.accessToken);
      const error = client.next('error');
      client.send({ type: 'tourney:act', handId: 'nope', seq: 0, action: 'check' } as never);
      expect((await error).code).toBe('BAD_MESSAGE');
      await closeAll([client]);
    } finally {
      await server.close();
    }
  });
});
