import { describe, expect, it } from 'vitest';
import {
  TOWN_SQUARE_CHANNEL_ID,
  type ChatChannelDto,
  type ChatMessageDto,
  type ServerMessage,
} from '@lethalmagotchi/shared';
import {
  actionForServerMessage,
  initialState,
  reducer,
  rejectionNote,
  type Action,
  type State,
  type Thread,
} from '../../src/chat/state.js';

const ALICE = '018f3a00-0000-7000-8000-00000000a11c';
const BOB = '018f3a00-0000-7000-8000-00000000b0b0';

function channel(id: string, overrides: Partial<ChatChannelDto> = {}): ChatChannelDto {
  return {
    id,
    kind: id === TOWN_SQUARE_CHANNEL_ID ? 'global' : 'dm',
    name: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    archivedAt: null,
    counterpart: null,
    blockedByMe: false,
    unreadCount: 0,
    lastMessageAt: null,
    ...overrides,
  };
}

function message(id: string, authorAccountId: string, channelId: string): ChatMessageDto {
  return {
    id,
    channelId,
    authorAccountId,
    authorCharacterId: null,
    authorName: 'Bubbles',
    body: `body ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    moderation: 'clean',
  };
}

/** A state with one Town Square thread and one DM, each holding a line from both players. */
function populated(): State {
  const dmId = '018f3a00-0000-7000-8000-0000000000dd';
  let state = reducer(initialState, {
    type: 'channels',
    channels: [channel(TOWN_SQUARE_CHANNEL_ID), channel(dmId)],
  });
  for (const channelId of [TOWN_SQUARE_CHANNEL_ID, dmId]) {
    state = reducer(state, {
      type: 'history',
      channelId,
      messages: [message(`${channelId}-a`, ALICE, channelId), message(`${channelId}-b`, BOB, channelId)],
      hasMore: false,
      older: false,
    });
  }
  return state;
}

describe('server frames the chat panel has to react to', () => {
  it('surfaces a socket error rather than dropping it, and settles the send it belongs to', () => {
    const frame: ServerMessage = { type: 'error', code: 'NO_CHARACTER', message: 'You do not have a character.' };
    const action = actionForServerMessage(frame, ALICE);
    expect(action).not.toBeNull();

    const sending = reducer(initialState, { type: 'sending' });
    expect(sending.pending).toBe(1);

    const settled = reducer(sending, action!);
    expect(settled.pending).toBe(0);
    expect(settled.note).toBeTruthy();
  });

  it('has something to say about every socket error chat can cause', () => {
    for (const code of ['NO_CHARACTER', 'BAD_MESSAGE', 'RATE_LIMITED', 'UNAUTHENTICATED'] as const) {
      const action = actionForServerMessage({ type: 'error', code, message: 'x' }, ALICE);
      expect(action, code).toMatchObject({ type: 'settled' });
    }
  });

  it('stays quiet about the table errors that share the socket', () => {
    for (const code of ['NOT_SEATED', 'NOT_YOUR_TURN', 'STALE_SEQ', 'ILLEGAL_ACTION'] as const) {
      expect(actionForServerMessage({ type: 'error', code, message: 'x' }, ALICE), code).toBeNull();
    }
  });

  it('tells the player how long a mute lasts instead of leaving them guessing', () => {
    const action = actionForServerMessage(
      { type: 'chat:rejected', clientMsgId: 'c1', code: 'RATE_LIMITED', retryAfterMs: 12_000 },
      ALICE,
    );
    expect(action).toMatchObject({ type: 'settled' });
    expect((action as { note: string }).note).toContain('12s');

    // Without a duration on the frame there is nothing to promise, so the copy stays general.
    expect(rejectionNote('RATE_LIMITED')).not.toContain('undefined');
  });

  it('marks a message as mine only when the author is this account', () => {
    const frame: ServerMessage = {
      type: 'chat:message',
      channelId: TOWN_SQUARE_CHANNEL_ID,
      message: message('m1', BOB, TOWN_SQUARE_CHANNEL_ID),
    };
    expect(actionForServerMessage(frame, ALICE)).toMatchObject({ mine: false });
    expect(actionForServerMessage(frame, BOB)).toMatchObject({ mine: true });
  });
});

describe('blocking clears the screen, not just the next fetch', () => {
  it('drops every message from the blocked author, in every thread', () => {
    const state = populated();
    const dmId = state.order[1]!;
    expect(state.threads[TOWN_SQUARE_CHANNEL_ID]!.messages).toHaveLength(2);

    const purged = reducer(state, { type: 'purgeAuthor', accountId: BOB });

    for (const channelId of [TOWN_SQUARE_CHANNEL_ID, dmId]) {
      const bodies = purged.threads[channelId]!.messages.map((entry) => entry.authorAccountId);
      expect(bodies).toEqual([ALICE]);
    }
  });

  it('leaves threads re-fetchable so an unblock can put the messages back', () => {
    const state = populated();
    expect(Object.values(state.threads).every((thread) => thread.loaded)).toBe(true);

    const invalidated = reducer(state, { type: 'invalidate' });
    expect(Object.values(invalidated.threads).every((thread) => thread.loaded)).toBe(false);
    // The messages stay on screen until the refetch lands: no blank flash in between.
    expect(invalidated.threads[TOWN_SQUARE_CHANNEL_ID]!.messages).toHaveLength(2);
  });

  it('takes the blocked author out of the live region too, and leaves anyone else in it', () => {
    const incoming = (author: string): Action => ({
      type: 'incoming',
      channelId: TOWN_SQUARE_CHANNEL_ID,
      message: message('live', author, TOWN_SQUARE_CHANNEL_ID),
      mine: false,
    });

    const fromBob = reducer(populated(), incoming(BOB));
    expect(fromBob.lastIncoming).toMatchObject({ authorAccountId: BOB });
    expect(reducer(fromBob, { type: 'purgeAuthor', accountId: BOB }).lastIncoming).toBeNull();

    // Blocking Bob says nothing about what Alice last said.
    const fromAlice = reducer(populated(), incoming(ALICE));
    expect(reducer(fromAlice, { type: 'purgeAuthor', accountId: BOB }).lastIncoming).toMatchObject({
      authorAccountId: ALICE,
    });
  });

  it('ignores a live frame from a blocked author that the server sent before the block landed', () => {
    const blocked = reducer(populated(), { type: 'purgeAuthor', accountId: BOB });
    const after = reducer(blocked, {
      type: 'incoming',
      channelId: TOWN_SQUARE_CHANNEL_ID,
      message: message('in-flight', BOB, TOWN_SQUARE_CHANNEL_ID),
      mine: false,
    });

    expect(after.threads[TOWN_SQUARE_CHANNEL_ID]!.messages.map((entry) => entry.id)).not.toContain('in-flight');
    expect(after.lastIncoming).toBeNull();
  });

  it('lets an unblocked author back in', () => {
    let state = reducer(populated(), { type: 'purgeAuthor', accountId: BOB });
    state = reducer(state, { type: 'allowAuthor', accountId: BOB });
    state = reducer(state, {
      type: 'history',
      channelId: TOWN_SQUARE_CHANNEL_ID,
      messages: [message('back-1', ALICE, TOWN_SQUARE_CHANNEL_ID), message('back-2', BOB, TOWN_SQUARE_CHANNEL_ID)],
      hasMore: false,
      older: false,
    });

    expect(state.threads[TOWN_SQUARE_CHANNEL_ID]!.messages.map((entry) => entry.authorAccountId)).toEqual([
      ALICE,
      BOB,
    ]);
  });
});

/** Ids sort the same way as timestamps here, matching the server's `created_at, id` order. */
function at(ordinal: number, authorAccountId = ALICE): ChatMessageDto {
  return {
    ...message(`m${String(ordinal).padStart(2, '0')}`, authorAccountId, TOWN_SQUARE_CHANNEL_ID),
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ordinal)).toISOString(),
  };
}

function town(state: State): Thread {
  return state.threads[TOWN_SQUARE_CHANNEL_ID]!;
}

function ids(state: State): string[] {
  return town(state).messages.map((entry) => entry.id);
}

/** The newest page on screen, then an earlier page pulled in on top of it. */
function paginated(): State {
  let state = reducer(initialState, { type: 'channels', channels: [channel(TOWN_SQUARE_CHANNEL_ID)] });
  state = reducer(state, {
    type: 'history',
    channelId: TOWN_SQUARE_CHANNEL_ID,
    messages: [at(8), at(9), at(10)],
    hasMore: true,
    older: false,
  });
  state = reducer(state, { type: 'loadingOlder', channelId: TOWN_SQUARE_CHANNEL_ID });
  return reducer(state, {
    type: 'history',
    channelId: TOWN_SQUARE_CHANNEL_ID,
    messages: [at(1), at(2), at(3)],
    hasMore: true,
    older: true,
  });
}

describe('a history page never lands out of order, whatever else happened while it was in flight', () => {
  it('starts from a thread that is in order', () => {
    expect(ids(paginated())).toEqual(['m01', 'm02', 'm03', 'm08', 'm09', 'm10']);
  });

  it('drops the pages below a refetched newest page instead of hanging them off the bottom', () => {
    let state = paginated();
    // What a block does: purge, mark every thread stale, refetch the open one with no cursor.
    state = reducer(state, { type: 'invalidate' });
    state = reducer(state, {
      type: 'history',
      channelId: TOWN_SQUARE_CHANNEL_ID,
      messages: [at(8), at(9), at(10)],
      hasMore: true,
      older: false,
    });

    expect(ids(state)).toEqual(['m08', 'm09', 'm10']);
    const times = town(state).messages.map((entry) => entry.createdAt);
    expect(times).toEqual([...times].sort());
    // The earlier pages are gone, so the way back to them has to still be offered.
    expect(town(state).hasMore).toBe(true);
  });

  it('keeps a live message that arrived while the refetch was out, still at the bottom', () => {
    let state = paginated();
    state = reducer(state, {
      type: 'incoming',
      channelId: TOWN_SQUARE_CHANNEL_ID,
      message: at(11),
      mine: false,
    });
    state = reducer(state, { type: 'invalidate' });
    state = reducer(state, {
      type: 'history',
      channelId: TOWN_SQUARE_CHANNEL_ID,
      messages: [at(8), at(9), at(10)],
      hasMore: true,
      older: false,
    });

    expect(ids(state)).toEqual(['m08', 'm09', 'm10', 'm11']);
  });

  it('does not put a just-blocked author back when their page was already in flight', () => {
    let state = reducer(initialState, { type: 'channels', channels: [channel(TOWN_SQUARE_CHANNEL_ID)] });
    state = reducer(state, {
      type: 'history',
      channelId: TOWN_SQUARE_CHANNEL_ID,
      messages: [at(10, ALICE), at(11, BOB)],
      hasMore: true,
      older: false,
    });
    state = reducer(state, { type: 'loadingOlder', channelId: TOWN_SQUARE_CHANNEL_ID });

    // The block lands while the earlier page is still out.
    state = reducer(state, { type: 'purgeAuthor', accountId: BOB });
    state = reducer(state, { type: 'invalidate' });
    expect(town(state).messages.map((entry) => entry.authorAccountId)).toEqual([ALICE]);

    // The page the server computed before the block existed arrives.
    state = reducer(state, {
      type: 'history',
      channelId: TOWN_SQUARE_CHANNEL_ID,
      messages: [at(1, BOB), at(2, ALICE)],
      hasMore: true,
      older: true,
    });

    expect(town(state).messages.map((entry) => entry.authorAccountId)).not.toContain(BOB);
    expect(ids(state)).toEqual(['m02', 'm10']);
  });

  it('refuses an older page that is not actually older than what is on screen', () => {
    let state = paginated();
    // A page fetched against a cursor that a refetch has since replaced: everything in it is
    // already newer than the top of the log, so prepending it would run the clock backwards.
    state = reducer(state, {
      type: 'history',
      channelId: TOWN_SQUARE_CHANNEL_ID,
      messages: [at(4), at(5)],
      hasMore: true,
      older: true,
    });

    expect(ids(state)).toEqual(['m01', 'm02', 'm03', 'm08', 'm09', 'm10']);
  });

  it('never duplicates a message that both pages happen to carry', () => {
    let state = paginated();
    state = reducer(state, {
      type: 'history',
      channelId: TOWN_SQUARE_CHANNEL_ID,
      messages: [at(0), at(1)],
      hasMore: false,
      older: true,
    });

    expect(ids(state)).toEqual(['m00', 'm01', 'm02', 'm03', 'm08', 'm09', 'm10']);
  });
});

describe('a page of history that never arrives leaves the button usable', () => {
  it('stops loading and offers a retry when the request fails', () => {
    let state = paginated();
    state = reducer(state, { type: 'loadingOlder', channelId: TOWN_SQUARE_CHANNEL_ID });
    expect(town(state).loadingOlder).toBe(true);

    state = reducer(state, { type: 'historyFailed', channelId: TOWN_SQUARE_CHANNEL_ID });
    expect(town(state).loadingOlder).toBe(false);
    expect(town(state).olderFailed).toBe(true);

    // And the retry looks like any other attempt, not like a thread stuck in a failed state.
    state = reducer(state, { type: 'loadingOlder', channelId: TOWN_SQUARE_CHANNEL_ID });
    expect(town(state).olderFailed).toBe(false);

    state = reducer(state, {
      type: 'history',
      channelId: TOWN_SQUARE_CHANNEL_ID,
      messages: [at(0)],
      hasMore: false,
      older: true,
    });
    expect(town(state).loadingOlder).toBe(false);
    expect(town(state).olderFailed).toBe(false);
    expect(ids(state)).toEqual(['m00', 'm01', 'm02', 'm03', 'm08', 'm09', 'm10']);
  });

  it('stops loading without crying failure when the response was merely superseded', () => {
    let state = reducer(paginated(), { type: 'loadingOlder', channelId: TOWN_SQUARE_CHANNEL_ID });
    state = reducer(state, { type: 'historyDropped', channelId: TOWN_SQUARE_CHANNEL_ID });

    expect(town(state).loadingOlder).toBe(false);
    expect(town(state).olderFailed).toBe(false);
  });

  it('does not blame a failed first load on the pagination button', () => {
    const state = reducer(paginated(), { type: 'historyFailed', channelId: TOWN_SQUARE_CHANNEL_ID });
    expect(town(state).olderFailed).toBe(false);
  });
});

describe('a first page of history that never arrives is not an empty channel', () => {
  const fresh = (): State => reducer(initialState, { type: 'channels', channels: [channel(TOWN_SQUARE_CHANNEL_ID)] });

  it('marks the load failed rather than leaving the thread looking loaded-and-empty', () => {
    const state = reducer(fresh(), { type: 'historyFailed', channelId: TOWN_SQUARE_CHANNEL_ID });

    expect(town(state).loadFailed).toBe(true);
    expect(town(state).olderFailed).toBe(false);
    // `loaded` staying false is what makes re-opening the channel try again on its own.
    expect(town(state).loaded).toBe(false);
    expect(town(state).messages).toEqual([]);
  });

  it('clears the failure while the retry is out, and again when it lands', () => {
    let state = reducer(fresh(), { type: 'historyFailed', channelId: TOWN_SQUARE_CHANNEL_ID });
    state = reducer(state, { type: 'loadingHistory', channelId: TOWN_SQUARE_CHANNEL_ID });
    expect(town(state).loadFailed).toBe(false);

    state = reducer(state, {
      type: 'history',
      channelId: TOWN_SQUARE_CHANNEL_ID,
      messages: [at(1)],
      hasMore: false,
      older: false,
    });
    expect(town(state).loadFailed).toBe(false);
    expect(town(state).loaded).toBe(true);
    expect(ids(state)).toEqual(['m01']);
  });

  it('fails again when the retry fails again, so the state never lies once', () => {
    let state = reducer(fresh(), { type: 'historyFailed', channelId: TOWN_SQUARE_CHANNEL_ID });
    state = reducer(state, { type: 'loadingHistory', channelId: TOWN_SQUARE_CHANNEL_ID });
    state = reducer(state, { type: 'historyFailed', channelId: TOWN_SQUARE_CHANNEL_ID });

    expect(town(state).loadFailed).toBe(true);
  });

  it('leaves a genuinely empty channel unmarked', () => {
    const state = reducer(fresh(), {
      type: 'history',
      channelId: TOWN_SQUARE_CHANNEL_ID,
      messages: [],
      hasMore: false,
      older: false,
    });

    expect(town(state).loadFailed).toBe(false);
    expect(town(state).loaded).toBe(true);
  });

  it('does not blame the first page for a failed pagination request', () => {
    let state = reducer(paginated(), { type: 'loadingOlder', channelId: TOWN_SQUARE_CHANNEL_ID });
    state = reducer(state, { type: 'historyFailed', channelId: TOWN_SQUARE_CHANNEL_ID });

    expect(state.threads[TOWN_SQUARE_CHANNEL_ID]!.olderFailed).toBe(true);
    expect(state.threads[TOWN_SQUARE_CHANNEL_ID]!.loadFailed).toBe(false);
  });

  it('says nothing about a request that was merely superseded', () => {
    const state = reducer(fresh(), { type: 'historyDropped', channelId: TOWN_SQUARE_CHANNEL_ID });
    expect(town(state).loadFailed).toBe(false);
  });
});
