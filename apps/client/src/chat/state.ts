import {
  MESSAGE_MAX,
  TOWN_SQUARE_CHANNEL_ID,
  type ChatChannelDto,
  type ChatMessageDto,
  type ChatRejectCode,
  type ServerMessage,
  type WsErrorCode,
} from '@lethalmagotchi/shared';

export interface Thread {
  channel: ChatChannelDto;
  /** Oldest first, so rendering is append-at-the-bottom like the DOM wants. */
  messages: ChatMessageDto[];
  loaded: boolean;
  loadingOlder: boolean;
  /** A page of history that was asked for and never arrived, so the button can offer a retry. */
  olderFailed: boolean;
  /**
   * The same for the first page. Without it a channel whose history never loaded is
   * indistinguishable from one nobody has ever posted in, which is a lie about a shared room.
   */
  loadFailed: boolean;
  hasMore: boolean;
  unread: number;
}

export interface State {
  order: string[];
  threads: Record<string, Thread>;
  activeChannelId: string;
  open: boolean;
  note: string | null;
  pending: number;
  blockedAuthors: string[];
  lastIncoming: { channelId: string; authorAccountId: string | null; authorName: string; body: string } | null;
}

export const initialState: State = {
  order: [],
  threads: {},
  activeChannelId: TOWN_SQUARE_CHANNEL_ID,
  open: false,
  note: null,
  pending: 0,
  blockedAuthors: [],
  lastIncoming: null,
};

export type Action =
  | { type: 'channels'; channels: ChatChannelDto[] }
  | { type: 'channel'; channel: ChatChannelDto }
  | { type: 'history'; channelId: string; messages: ChatMessageDto[]; hasMore: boolean; older: boolean }
  | { type: 'loadingOlder'; channelId: string }
  | { type: 'loadingHistory'; channelId: string }
  | { type: 'historyFailed'; channelId: string }
  | { type: 'historyDropped'; channelId: string }
  | { type: 'incoming'; channelId: string; message: ChatMessageDto; mine: boolean }
  | { type: 'unread'; channelId: string; unreadCount: number }
  | { type: 'select'; channelId: string }
  | { type: 'setOpen'; open: boolean }
  | { type: 'sending' }
  | { type: 'settled'; note: string | null }
  | { type: 'note'; note: string | null }
  | { type: 'purgeAuthor'; accountId: string }
  | { type: 'allowAuthor'; accountId: string }
  | { type: 'invalidate' };

function humanDuration(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.ceil(seconds / 60)} min`;
}

const REJECTION_NOTES: Record<ChatRejectCode, string> = {
  BLOCKED_CONTENT: 'That message was not allowed.',
  RATE_LIMITED: 'You are sending messages too quickly. Take a breath.',
  NOT_MEMBER: 'You are not part of that conversation.',
  TOO_LONG: `Messages are ${MESSAGE_MAX} characters or fewer.`,
  EMPTY: 'Say something first.',
  DUPLICATE: 'You just said that.',
  BLOCKED_BY_RECIPIENT: 'You cannot message this player.',
  ARCHIVED: 'This conversation is closed.',
};

/** The server already knows how long the mute lasts, so a player should never have to guess. */
export function rejectionNote(code: ChatRejectCode, retryAfterMs?: number): string {
  if (code === 'RATE_LIMITED' && retryAfterMs !== undefined && retryAfterMs > 0) {
    return `Take a breath — try again in ${humanDuration(retryAfterMs)}.`;
  }
  return REJECTION_NOTES[code];
}

/**
 * Socket-level errors that a chat action can actually have caused. The table codes
 * (`NOT_SEATED` and friends) belong to poker and travel over the same socket, so putting
 * them on screen here would blame chat for something it never did.
 */
const WS_ERROR_NOTES: Partial<Record<WsErrorCode, string>> = {
  NO_CHARACTER: 'Chat is not linked to your pet yet. Give it a moment and try again.',
  BAD_MESSAGE: 'That message could not be sent.',
  RATE_LIMITED: 'You are doing that too quickly. Take a breath.',
  UNAUTHENTICATED: 'Your session ended. Sign in again to keep chatting.',
};

export function wsErrorNote(code: WsErrorCode): string | null {
  return WS_ERROR_NOTES[code] ?? null;
}

/**
 * The pure half of the socket handler: everything that only changes chat state. Frames with
 * a side effect (refetching on `ready`, subscribing to a new channel) are handled by the
 * provider, which then feeds the frame through here too.
 */
export function actionForServerMessage(message: ServerMessage, myAccountId: string | null): Action | null {
  switch (message.type) {
    case 'chat:message':
      return {
        type: 'incoming',
        channelId: message.channelId,
        message: message.message,
        mine: message.message.authorAccountId === myAccountId,
      };
    case 'chat:channel':
      return { type: 'channel', channel: message.channel };
    case 'chat:unread':
      return { type: 'unread', channelId: message.channelId, unreadCount: message.unreadCount };
    case 'chat:ack':
      return { type: 'settled', note: null };
    case 'chat:rejected':
      return { type: 'settled', note: rejectionNote(message.code, message.retryAfterMs) };
    case 'error': {
      // Never dropped in silence: an error the player cannot see is a send that appears to
      // do nothing at all, which is exactly how a dead socket used to hide.
      const note = wsErrorNote(message.code);
      return note === null ? null : { type: 'settled', note };
    }
    default:
      return null;
  }
}

function blankThread(channel: ChatChannelDto): Thread {
  return {
    channel,
    messages: [],
    loaded: false,
    loadingOlder: false,
    olderFailed: false,
    loadFailed: false,
    hasMore: false,
    unread: channel.unreadCount,
  };
}

function withThread(state: State, channelId: string, update: (thread: Thread) => Thread): State {
  const thread = state.threads[channelId];
  if (!thread) return state;
  return { ...state, threads: { ...state.threads, [channelId]: update(thread) } };
}

function mapThreads(state: State, update: (thread: Thread) => Thread): State {
  const threads: Record<string, Thread> = {};
  for (const [channelId, thread] of Object.entries(state.threads)) threads[channelId] = update(thread);
  return { ...state, threads };
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'channels': {
      const threads: Record<string, Thread> = {};
      for (const channel of action.channels) {
        const existing = state.threads[channel.id];
        threads[channel.id] = existing ? { ...existing, channel, unread: channel.unreadCount } : blankThread(channel);
      }
      const order = action.channels.map((channel) => channel.id);
      return {
        ...state,
        order,
        threads,
        activeChannelId: threads[state.activeChannelId] ? state.activeChannelId : TOWN_SQUARE_CHANNEL_ID,
      };
    }

    case 'channel': {
      const existing = state.threads[action.channel.id];
      return {
        ...state,
        order: state.order.includes(action.channel.id) ? state.order : [...state.order, action.channel.id],
        threads: {
          ...state.threads,
          [action.channel.id]: existing
            ? { ...existing, channel: action.channel }
            : blankThread(action.channel),
        },
      };
    }

    case 'history': {
      const page = action.messages.filter((message) => !isBlocked(state, message.authorAccountId));
      return withThread(state, action.channelId, (thread) => ({
        ...thread,
        loaded: true,
        loadingOlder: false,
        olderFailed: false,
        loadFailed: false,
        hasMore: action.hasMore,
        messages: action.older ? prependOlder(page, thread.messages) : resetToNewest(page, thread.messages),
      }));
    }

    case 'loadingOlder':
      return withThread(state, action.channelId, (thread) => ({
        ...thread,
        loadingOlder: true,
        olderFailed: false,
      }));

    case 'loadingHistory':
      return withThread(state, action.channelId, (thread) => ({ ...thread, loadFailed: false }));

    /**
     * The request is over either way; only a failure has anything to offer a retry for, and it
     * belongs to whichever half of the log asked for it — the pagination button or the log
     * itself, which otherwise falls through to "nobody has said anything here".
     */
    case 'historyFailed':
      return withThread(state, action.channelId, (thread) => ({
        ...thread,
        loadingOlder: false,
        olderFailed: thread.loadingOlder,
        loadFailed: thread.loadingOlder ? thread.loadFailed : true,
      }));

    case 'historyDropped':
      return withThread(state, action.channelId, (thread) => ({ ...thread, loadingOlder: false }));

    case 'incoming': {
      const thread = state.threads[action.channelId];
      if (!thread) return state;
      if (isBlocked(state, action.message.authorAccountId)) return state;
      if (thread.messages.some((message) => message.id === action.message.id)) return state;
      const active = state.open && state.activeChannelId === action.channelId;
      return {
        ...state,
        lastIncoming: action.mine
          ? state.lastIncoming
          : {
              channelId: action.channelId,
              authorAccountId: action.message.authorAccountId,
              authorName: action.message.authorName,
              body: action.message.body,
            },
        threads: {
          ...state.threads,
          [action.channelId]: {
            ...thread,
            messages: [...thread.messages, action.message],
            unread: active || action.mine ? thread.unread : thread.unread + 1,
          },
        },
      };
    }

    case 'unread':
      // Returning the same state on an unchanged count keeps `threads` referentially stable,
      // so effects that watch it do not re-run on every read receipt round trip.
      return state.threads[action.channelId]?.unread === action.unreadCount
        ? state
        : withThread(state, action.channelId, (thread) => ({ ...thread, unread: action.unreadCount }));

    case 'select':
      return withThread({ ...state, activeChannelId: action.channelId, note: null }, action.channelId, (thread) => ({
        ...thread,
        unread: 0,
      }));

    case 'setOpen':
      return state.open === action.open
        ? state
        : withThread({ ...state, open: action.open }, state.activeChannelId, (thread) =>
            action.open ? { ...thread, unread: 0 } : thread,
          );

    case 'sending':
      return { ...state, pending: state.pending + 1, note: null };

    case 'settled':
      return { ...state, pending: Math.max(0, state.pending - 1), note: action.note };

    case 'note':
      return { ...state, note: action.note };

    /**
     * Blocking has to feel immediate and total: the server already filters this author out of
     * every future read, and this is the same filter applied to what is already on screen —
     * in every thread, not only the one being looked at. The author is remembered rather than
     * only swept, because a page of history or a live frame the server computed *before* the
     * block was written is still in flight and would otherwise put them back.
     */
    case 'purgeAuthor': {
      const purged = mapThreads(state, (thread) => {
        const messages = thread.messages.filter((message) => message.authorAccountId !== action.accountId);
        return messages.length === thread.messages.length ? thread : { ...thread, messages };
      });
      return {
        ...purged,
        blockedAuthors: state.blockedAuthors.includes(action.accountId)
          ? state.blockedAuthors
          : [...state.blockedAuthors, action.accountId],
        // The live region is part of "what is on screen" even though it is only read aloud.
        lastIncoming: state.lastIncoming?.authorAccountId === action.accountId ? null : state.lastIncoming,
      };
    }

    case 'allowAuthor':
      return state.blockedAuthors.includes(action.accountId)
        ? { ...state, blockedAuthors: state.blockedAuthors.filter((id) => id !== action.accountId) }
        : state;

    /** Marks every thread re-fetchable, for when what the server would return has changed. */
    case 'invalidate':
      return mapThreads(state, (thread) => (thread.loaded ? { ...thread, loaded: false } : thread));
  }
}

function isBlocked(state: State, accountId: string | null): boolean {
  return accountId !== null && state.blockedAuthors.includes(accountId);
}

/** The server's order: oldest first, ties broken by id, matching `created_at, id` on the query. */
function isBefore(a: ChatMessageDto, b: ChatMessageDto): boolean {
  return a.createdAt === b.createdAt ? a.id < b.id : a.createdAt < b.createdAt;
}

/**
 * A page fetched with a cursor is only ever older than what is already held, so anything in
 * it that is not is a response that lost a race with a refetch and has no place in the log.
 */
function prependOlder(page: ChatMessageDto[], existing: ChatMessageDto[]): ChatMessageDto[] {
  const oldest = existing[0];
  const known = new Set(existing.map((message) => message.id));
  const older = page.filter((message) => !known.has(message.id) && (!oldest || isBefore(message, oldest)));
  return older.length === 0 ? existing : [...older, ...existing];
}

/**
 * A cursor-less fetch answers with the newest page and is the authority on everything up to
 * it, so previously paginated older pages are dropped rather than merged: they were fetched
 * under rules that may since have changed, and appending them to a page that is newer than
 * they are is what put the log out of order. Only messages *newer* than the page survive —
 * live frames that arrived while the request was out, which the page could not have included.
 */
function resetToNewest(page: ChatMessageDto[], existing: ChatMessageDto[]): ChatMessageDto[] {
  const newest = page[page.length - 1];
  if (!newest) return existing;
  const known = new Set(page.map((message) => message.id));
  return [...page, ...existing.filter((message) => !known.has(message.id) && isBefore(newest, message))];
}
