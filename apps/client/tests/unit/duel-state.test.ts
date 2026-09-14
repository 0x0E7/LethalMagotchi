import { describe, expect, it } from 'vitest';
import type { DuelCardDto, DuelPlayerView, ServerMessage } from '@lethalmagotchi/shared';
import {
  defeatStakeLine,
  initialState,
  reducer,
  victoryStakeLine,
  type State,
} from '../../src/duel/state.js';

const ME = 'me-character';
const THEM = 'them-character';

const opponent: DuelPlayerView = {
  characterId: THEM,
  accountId: 'them-account',
  nickname: 'Pepper',
  speciesId: 'fox',
  wealthBand: 'wealthy',
  isBeggar: false,
  duelWins: 3,
  duelLosses: 1,
};

const card: DuelCardDto = {
  characterId: THEM,
  accountId: 'them-account',
  nickname: 'Pepper',
  speciesId: 'fox',
  wealthBand: 'wealthy',
  isBeggar: false,
  duelWins: 3,
  duelLosses: 1,
  chickenBadgeUntil: null,
  duelEligible: true,
  raidEligible: true,
};

/** A fixed "now", so a frame's deadline is in the past or the future by construction. */
const NOW = 1_800_000_000_000;

function apply(state: State, ...messages: ServerMessage[]): State {
  return messages.reduce(
    (current, message) => reducer(current, { type: 'server', message, characterId: ME, now: NOW }),
    state,
  );
}

const started: ServerMessage = {
  type: 'duel:start',
  duelId: 'duel-1',
  opponent,
  stakeCoins: 40,
  winsNeeded: 2,
  youAre: 'opponent',
};

const round = (seq: number, round: number, replay = 0): ServerMessage => ({
  type: 'duel:round',
  duelId: 'duel-1',
  round,
  replay,
  seq,
  deadlineAt: new Date(NOW + 5_000).toISOString(),
});

describe('the match view', () => {
  it('maps the scoreline onto the player own side', () => {
    // This client is the opponent, so `opponentWins` is theirs and `challengerWins` is not.
    const state = apply(initialState, started, round(0, 1), {
      type: 'duel:round_result',
      duelId: 'duel-1',
      round: 1,
      replay: 0,
      seq: 0,
      yourThrow: 'rock',
      opponentThrow: 'scissors',
      winner: 'you',
      tiebreak: false,
      challengerWins: 0,
      opponentWins: 1,
    });

    expect(state.match?.yourWins).toBe(1);
    expect(state.match?.theirWins).toBe(0);
    expect(state.match?.log).toHaveLength(1);
    expect(state.match?.reveal?.winner).toBe('you');
  });

  it('keeps replayed draws in the log so a 2-1 never looks like a 2-0', () => {
    let state = apply(initialState, started, round(0, 1));
    state = apply(state, {
      type: 'duel:round_result',
      duelId: 'duel-1',
      round: 1,
      replay: 0,
      seq: 0,
      yourThrow: 'rock',
      opponentThrow: 'rock',
      winner: 'draw',
      tiebreak: false,
      challengerWins: 0,
      opponentWins: 0,
    });
    state = apply(state, round(1, 1, 1));

    expect(state.match?.log).toHaveLength(1);
    expect(state.match?.replay).toBe(1);
    // A new window clears the previous reveal and the lock.
    expect(state.match?.reveal).toBeNull();
    expect(state.match?.yourThrow).toBeNull();
  });

  it('locks a throw once and refuses to double-send it', () => {
    const state = reducer(apply(initialState, started, round(0, 1)), {
      type: 'locking',
      throw: 'paper',
      seq: 0,
    });
    expect(state.match?.yourThrow).toBe('paper');
    expect(state.match?.pendingSeq).toBe(0);
  });

  it('rolls a rejected throw back, but leaves an accepted one alone', () => {
    const locked = reducer(apply(initialState, started, round(0, 1)), {
      type: 'locking',
      throw: 'paper',
      seq: 0,
    });
    const rejected = apply(locked, { type: 'duel:error', code: 'STALE_SEQ', message: 'no' });
    expect(rejected.match?.yourThrow).toBeNull();
    expect(rejected.match?.pendingSeq).toBeNull();

    const confirmed = apply(locked, {
      type: 'duel:round_result',
      duelId: 'duel-1',
      round: 1,
      replay: 0,
      seq: 0,
      yourThrow: 'paper',
      opponentThrow: 'rock',
      winner: 'you',
      tiebreak: false,
      challengerWins: 0,
      opponentWins: 1,
    });
    const unrelated = apply(confirmed, { type: 'duel:error', code: 'RATE_LIMITED', message: 'slow' });
    expect(unrelated.match?.yourThrow).toBe('paper');
  });

  it('knows which side of the ending it is on', () => {
    const state = apply(initialState, started, {
      type: 'duel:end',
      duelId: 'duel-1',
      outcome: 'death',
      winnerCharacterId: THEM,
      loserCharacterId: ME,
      coinsTransferred: 40,
      rebirth: { characterId: ME, rebirthIndex: 1 },
    });

    expect(state.match?.end?.youWon).toBe(false);
    expect(state.match?.end?.coinsTransferred).toBe(40);
  });

  /**
   * Regression, QA round 2 (new 5). A resync during the reveal beat replays the round with
   * the deadline of the window that just closed. Clearing the reveal and re-opening the
   * throws for it offered a window the server had not started: the click came back
   * `STALE_SEQ`, shown as "that throw was already locked in", which was not what happened.
   */
  it('does not re-open the throws for a round whose deadline has already passed', () => {
    const revealed = apply(initialState, started, round(0, 1), {
      type: 'duel:round_result',
      duelId: 'duel-1',
      round: 1,
      replay: 0,
      seq: 0,
      yourThrow: 'rock',
      opponentThrow: 'scissors',
      winner: 'you',
      tiebreak: false,
      challengerWins: 0,
      opponentWins: 1,
    });

    const resynced = apply(revealed, {
      type: 'duel:round',
      duelId: 'duel-1',
      round: 2,
      replay: 0,
      seq: 1,
      deadlineAt: new Date(NOW).toISOString(),
    });

    // The reveal stays up and the throw stays locked, so the buttons stay disabled.
    expect(resynced.match?.reveal).not.toBeNull();
    expect(resynced.match?.yourThrow).toBe('rock');
    expect(resynced.match?.seq).toBe(0);

    // The live frame for the next window is the one that actually transitions.
    const opened = apply(resynced, round(1, 2));
    expect(opened.match?.reveal).toBeNull();
    expect(opened.match?.yourThrow).toBeNull();
    expect(opened.match?.seq).toBe(1);
  });

  it('ignores frames addressed to a duel it is not in', () => {
    const state = apply(initialState, started, {
      type: 'duel:opponent_locked',
      duelId: 'some-other-duel',
    });
    expect(state.match?.opponentLocked).toBe(false);
  });
});

describe('invites', () => {
  it('queues incoming challenges and clears one when it resolves', () => {
    const invited: ServerMessage = {
      type: 'duel:invited',
      inviteId: 'invite-1',
      from: opponent,
      expiresAt: new Date(1_800_000_060_000).toISOString(),
      stakeCoins: 40,
    };
    let state = apply(initialState, invited);
    expect(state.incoming).toHaveLength(1);

    state = apply(state, { type: 'duel:invite_state', inviteId: 'invite-1', state: 'expired' });
    expect(state.incoming).toHaveLength(0);
  });

  it('follows an outgoing challenge from composing to pending to resolved', () => {
    let state = reducer(initialState, { type: 'openStakes', target: card });
    expect(state.outgoing?.phase).toBe('composing');

    state = reducer(state, { type: 'sendingInvite' });
    expect(state.outgoing?.phase).toBe('sending');

    state = apply(state, { type: 'duel:invite_state', inviteId: 'invite-1', state: 'pending' });
    expect(state.outgoing).toMatchObject({ phase: 'pending', inviteId: 'invite-1' });

    state = apply(state, { type: 'duel:invite_state', inviteId: 'invite-1', state: 'declined' });
    expect(state.outgoing).toMatchObject({ phase: 'resolved', state: 'declined' });
  });

  it('reopens the stakes card when the server refuses the invite', () => {
    let state = reducer(initialState, { type: 'openStakes', target: card });
    state = reducer(state, { type: 'sendingInvite' });
    state = apply(state, { type: 'duel:error', code: 'COOLDOWN', message: 'x' });

    expect(state.outgoing?.phase).toBe('composing');
    expect(state.note).toContain('turned you down');
  });

  /**
   * Regression, QA round 1 (bug 7). After a reload the client has no local record of the
   * challenge it still has out, so a bare pending state was dropped and the player could
   * neither withdraw nor reissue until the invite's own 60s TTL lapsed.
   */
  it('rebuilds an outgoing challenge from a reconnect it has no local record of', () => {
    const state = apply(initialState, {
      type: 'duel:invite_state',
      inviteId: 'invite-9',
      state: 'pending',
      target: card,
      expiresAt: new Date(1_800_000_060_000).toISOString(),
      stakeCoins: 40,
    });

    expect(state.outgoing).toMatchObject({
      phase: 'pending',
      inviteId: 'invite-9',
      state: 'pending',
      stakeCoins: 40,
      expiresAt: 1_800_000_060_000,
    });
    expect(state.outgoing?.target.characterId).toBe(THEM);
  });

  it('ignores a bare pending state it cannot attribute to any challenge', () => {
    const state = apply(initialState, {
      type: 'duel:invite_state',
      inviteId: 'invite-9',
      state: 'pending',
    });
    expect(state.outgoing).toBeNull();
  });

  it('drops both the invite cards once the match itself starts', () => {
    let state = reducer(initialState, { type: 'openStakes', target: card });
    state = apply(state, started);
    expect(state.outgoing).toBeNull();
    expect(state.incoming).toHaveLength(0);
    expect(state.match?.duelId).toBe('duel-1');
  });
});

/**
 * Regression, QA round 1 (bug 5). The defeat dialog rendered `{coinsTransferred} LC lost`,
 * which is the *stake* — while the loser's actual loss is their whole pre-duel wallet,
 * because rebirth resets coins to 5 regardless of what the stake left behind. A loser with
 * 5,000 coins and a 40-coin stake saw "40 LC lost" seconds before "5000 coins became 5".
 *
 * The mechanic is correct as built and is not what changed here: only the dialog's claim.
 */
describe('what a losing duelist is told about their coins', () => {
  /** Exactly the copy `RebirthCard` renders, so the two claims can be compared directly. */
  const rebirthLine = (coinsBefore: number): string => `${coinsBefore} coins became 5`;

  const numbersIn = (text: string): number[] =>
    [...text.matchAll(/\d+/g)].map((match) => Number(match[0]));

  it('never quotes a coin total that the rebirth dialog then contradicts', () => {
    const cases = [
      { wallet: 5_000, stake: 40 },
      { wallet: 40, stake: 40 },
      { wallet: 120, stake: 0 },
      { wallet: 5, stake: 5 },
    ];

    for (const { wallet, stake } of cases) {
      const defeat = defeatStakeLine(stake, 'Miso');
      const rebirth = rebirthLine(wallet);

      // The only number the defeat dialog may state is the stake that changed hands.
      expect(numbersIn(defeat).every((value) => value === stake)).toBe(true);
      // Specifically: it never claims the player's net loss, which is wallet - 5.
      expect(numbersIn(defeat)).not.toContain(wallet - 5);
      // And it points at the rebirth as the source of truth for the balance.
      expect(defeat).toMatch(/rebirth/i);
      expect(numbersIn(rebirth)).toContain(wallet);
    }
  });

  it('says who the stake went to, and says nothing about a stake that was zero', () => {
    expect(defeatStakeLine(40, 'Miso')).toContain('40 LC of the stake goes to Miso.');
    expect(defeatStakeLine(0, 'Miso')).not.toMatch(/\d/);
  });

  /**
   * Regression, QA round 2 (new 4). "Their coins and stats reset" read as referring to the
   * winner named immediately before it, i.e. as if the winner were the one being reset — and
   * the zero-stake variant had no antecedent at all. The dialog is only ever shown to the
   * loser, so their own outcome is stated in the second person.
   */
  it('says whose coins reset in the second person, never the winner in the third', () => {
    for (const stake of [40, 0]) {
      const line = defeatStakeLine(stake, 'Miso');
      expect(line).toContain('Your coins and stats reset with the rebirth that follows.');
      expect(line).not.toMatch(/Their coins/);
    }
  });

  /**
   * Regression, QA round 3 (new 13). The loser's dialog had a zero-stake variant and the
   * winner's did not, so a duel between two empty purses congratulated the survivor on
   * taking "0 LC" — a number no player should ever be shown.
   */
  it('congratulates the winner without quoting a stake that was zero', () => {
    expect(victoryStakeLine(40, 'Nori')).toBe('Nori is still standing, and takes 40 LC.');
    expect(victoryStakeLine(0, 'Nori')).toBe('Nori is still standing.');
    expect(victoryStakeLine(0, 'Nori')).not.toMatch(/\d/);
    expect(victoryStakeLine(0, 'Nori')).not.toMatch(/LC/);
  });
});
