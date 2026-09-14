/**
 * QA round-1 probes for the raid reducer. The client half of raid mode shipped with no unit
 * coverage at all, including for the invite bug the developer already had to fix once.
 */
import { describe, expect, it } from 'vitest';
import type { RaidMemberView, RaidTargetView, ServerMessage } from '@lethalmagotchi/shared';
import { initialState, reducer, type State } from '../../src/raid/state.js';

const ME = '11111111-1111-4111-8111-111111111111';
const MATE = '22222222-2222-4222-8222-222222222222';
const BOSS = '33333333-3333-4333-8333-333333333333';
const RAID = '44444444-4444-4444-8444-444444444444';

const target: RaidTargetView = {
  characterId: '55555555-5555-4555-8555-555555555555',
  nickname: 'Mark',
  speciesId: 'otter',
  band: 'wealthy',
};

function member(characterId: string, state: RaidMemberView['state'], isInitiator = false): RaidMemberView {
  return { characterId, accountId: `${characterId}-acct`, nickname: characterId.slice(0, 4), speciesId: 'otter', state, isInitiator };
}

function apply(state: State, message: ServerMessage, characterId = ME, now = 1_000): State {
  return reducer(state, { type: 'server', message, characterId, now });
}

describe('an invitee', () => {
  it('keeps their own pending invite when the party frame arrives behind it', () => {
    let state = apply(initialState, {
      type: 'raid:invited',
      raidId: RAID,
      from: member(BOSS, 'joined', true),
      target,
      expiresAt: new Date(60_000).toISOString(),
    });
    expect(state.incoming).toHaveLength(1);

    state = apply(state, {
      type: 'raid:party',
      raidId: RAID,
      target,
      members: [member(BOSS, 'joined', true), member(ME, 'invited')],
      raidPotBand: 'comfortable',
      initiatorCharacterId: BOSS,
      state: 'assembling',
      expiresAt: new Date(60_000).toISOString(),
    });

    // The party card must not stand in for the invite: without this the invitee has no
    // Accept button at all.
    expect(state.incoming.map((invite) => invite.raidId)).toEqual([RAID]);
    expect(state.party?.raidId).toBe(RAID);
  });

  it('drops the invite once the party frame shows them joined', () => {
    let state = apply(initialState, {
      type: 'raid:invited',
      raidId: RAID,
      from: member(BOSS, 'joined', true),
      target,
      expiresAt: new Date(60_000).toISOString(),
    });
    state = apply(state, {
      type: 'raid:party',
      raidId: RAID,
      target,
      members: [member(BOSS, 'joined', true), member(ME, 'joined')],
      raidPotBand: 'comfortable',
      initiatorCharacterId: BOSS,
      state: 'assembling',
      expiresAt: new Date(60_000).toISOString(),
    });
    expect(state.incoming).toHaveLength(0);
  });
});

describe('the reused raid:betrayal_locked frame', () => {
  function midMatch(): State {
    let state = apply(initialState, {
      type: 'raid:party',
      raidId: RAID,
      target,
      members: [member(ME, 'joined', true), member(MATE, 'joined')],
      raidPotBand: 'wealthy',
      initiatorCharacterId: ME,
      state: 'resolving',
      expiresAt: null,
    });
    state = apply(state, {
      type: 'raid:result',
      raidId: RAID,
      outcome: 'raiders_won',
      raidPot: 40,
      targetPot: 9,
      potCoins: 49,
    });
    state = apply(state, {
      type: 'raid:betrayal_window',
      raidId: RAID,
      seq: 0,
      deadlineAt: new Date(20_000).toISOString(),
      potCoins: 49,
    });
    return state;
  }

  it('counts as a betrayal lock while the betrayal window is the live one', () => {
    const state = apply(midMatch(), {
      type: 'raid:betrayal_locked',
      raidId: RAID,
      characterId: MATE,
      phase: 'betrayal',
      seq: 0,
    });
    expect(state.match?.betrayal?.locked).toEqual([MATE]);
    expect(state.match?.parity).toBeNull();
  });

  it('counts as a parity lock once the parity round is the live one', () => {
    let state = midMatch();
    state = apply(state, {
      type: 'raid:betrayal_result',
      raidId: RAID,
      seq: 0,
      choices: [
        { characterId: ME, choice: 'loyal' },
        { characterId: MATE, choice: 'loyal' },
      ],
      awards: [
        { characterId: ME, coins: 24 },
        { characterId: MATE, coins: 24 },
      ],
      potDestroyed: false,
      remainder: 1,
    });
    state = apply(state, {
      type: 'raid:parity_round',
      raidId: RAID,
      seq: 1,
      round: 1,
      deadlineAt: new Date(40_000).toISOString(),
      remainder: 1,
      contenders: [ME, MATE],
    });
    state = apply(state, {
      type: 'raid:betrayal_locked',
      raidId: RAID,
      characterId: MATE,
      phase: 'parity',
      seq: 1,
    });

    expect(state.match?.parity?.locked).toEqual([MATE]);
    // And it must not also be counted against the betrayal window it does not belong to.
    expect(state.match?.betrayal?.locked).toEqual([]);
  });

  it('does not bleed a parity lock back into the betrayal list after the parity reveal', () => {
    let state = midMatch();
    state = apply(state, {
      type: 'raid:betrayal_result',
      raidId: RAID,
      seq: 0,
      choices: [
        { characterId: ME, choice: 'loyal' },
        { characterId: MATE, choice: 'loyal' },
      ],
      awards: [
        { characterId: ME, coins: 24 },
        { characterId: MATE, coins: 24 },
      ],
      potDestroyed: false,
      remainder: 1,
    });
    state = apply(state, {
      type: 'raid:parity_round',
      raidId: RAID,
      seq: 1,
      round: 1,
      deadlineAt: new Date(40_000).toISOString(),
      remainder: 1,
      contenders: [ME, MATE],
    });
    state = apply(state, {
      type: 'raid:parity_result',
      raidId: RAID,
      seq: 1,
      round: 1,
      calls: [
        { characterId: ME, call: 'odds', throw: 1 },
        { characterId: MATE, call: 'odds', throw: 2 },
      ],
      parity: 'odds',
      winners: [ME, MATE],
      awards: [
        { characterId: ME, coins: 0 },
        { characterId: MATE, coins: 0 },
      ],
      seededSplit: false,
    });
    // A lock frame arriving after the reveal — a replayed or reordered frame. It names the
    // parity window it was made in, so it cannot land on the betrayal list.
    state = apply(state, {
      type: 'raid:betrayal_locked',
      raidId: RAID,
      characterId: MATE,
      phase: 'parity',
      seq: 1,
    });

    expect(
      state.match?.betrayal?.locked,
      'a parity-phase lock must never be attributed to the betrayal window',
    ).toEqual([]);
  });
});

describe('the resync that lands in the reveal beat', () => {
  /**
   * The round-zero frame this used to receive is fixed at the source: `RaidRunner` only
   * flips to the parity phase together with the round it names, and sends nothing at all
   * for a window that is not open. What is left for the reducer is the replay of a round
   * already on screen whose deadline has since passed.
   */
  it('leaves a live round alone when a stale replay of it arrives', () => {
    let state = apply(initialState, {
      type: 'raid:party',
      raidId: RAID,
      target,
      members: [member(ME, 'joined', true), member(MATE, 'joined')],
      raidPotBand: 'wealthy',
      initiatorCharacterId: ME,
      state: 'resolving',
      expiresAt: null,
    });
    state = apply(state, {
      type: 'raid:result',
      raidId: RAID,
      outcome: 'raiders_won',
      raidPot: 40,
      targetPot: 9,
      potCoins: 49,
    });
    state = apply(
      state,
      {
        type: 'raid:parity_round',
        raidId: RAID,
        seq: 1,
        round: 1,
        deadlineAt: new Date(40_000).toISOString(),
        remainder: 1,
        contenders: [ME, MATE],
      },
      ME,
      1_000,
    );
    state = reducer(state, { type: 'calling', call: 'odds', throwValue: 3, seq: 1 });

    // The same round replayed with a deadline already gone: re-opening it would offer a
    // control whose only possible answer is STALE_SEQ.
    const after = apply(
      state,
      {
        type: 'raid:parity_round',
        raidId: RAID,
        seq: 1,
        round: 1,
        deadlineAt: new Date(40_000).toISOString(),
        remainder: 1,
        contenders: [ME, MATE],
      },
      ME,
      41_000,
    );

    expect(after.match?.parity?.yourCall, 'a stale replay must not clear a call').not.toBeNull();
  });
});
