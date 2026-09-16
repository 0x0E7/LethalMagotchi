import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  MESSAGE_MAX,
  TOWN_SQUARE_CHANNEL_ID,
  sanitizeMessageBody,
  type ChatChannelDto,
  type ServerMessage,
} from '@lethalmagotchi/shared';
import { api } from '../api/client.js';
import { useSession } from '../session/SessionProvider.js';
import { useSocket } from '../ws/SocketProvider.js';
import { HistoryRequests } from './requests.js';
import { actionForServerMessage, initialState, reducer, type State, type Thread } from './state.js';

export type { Thread } from './state.js';

/**
 * How long a send may sit unacknowledged before the composer stops claiming it is still
 * working. Generous enough to cover a slow round trip or a reconnect flush, short enough
 * that a player is not left staring at "Sending…" wondering whether to retype.
 */
const SEND_ACK_TIMEOUT_MS = 10_000;

interface ChatValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  channels: ChatChannelDto[];
  threads: Record<string, Thread>;
  activeChannelId: string;
  activeThread: Thread | null;
  totalUnread: number;
  note: string | null;
  sending: boolean;
  lastIncoming: State['lastIncoming'];
  select: (channelId: string) => void;
  send: (body: string) => void;
  loadOlder: (channelId: string) => Promise<void>;
  retryHistory: (channelId: string) => Promise<void>;
  startDm: (targetAccountId: string) => Promise<void>;
  setBlocked: (targetAccountId: string, blocked: boolean) => Promise<void>;
  /** For changes made outside chat that add or remove a channel — joining or leaving a group. */
  refreshChannels: () => Promise<void>;
  dismissNote: () => void;
}

const ChatContext = createContext<ChatValue | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const { status: sessionStatus, character } = useSession();
  const socket = useSocket();
  const [state, dispatch] = useReducer(reducer, initialState);
  const enabled = sessionStatus === 'authenticated' && character !== null;

  const stateRef = useRef(state);
  /** Sends still waiting on a `chat:ack` or `chat:rejected`, so a timeout knows its own. */
  const outstanding = useRef(new Set<string>());
  stateRef.current = state;
  const accountId = character?.accountId ?? null;

  const loadChannels = useCallback(async () => {
    if (!enabled) return;
    const response = await api.chatChannels().catch(() => null);
    if (!response) return;
    dispatch({ type: 'channels', channels: response.channels });
    // Everything with member rows — DMs and the group channel. The Town Square is implicit.
    const subscribable = response.channels
      .filter((channel) => channel.kind !== 'global')
      .map((channel) => channel.id);
    if (subscribable.length > 0) socket.send({ type: 'chat:subscribe', channelIds: subscribable });
  }, [enabled, socket]);

  useEffect(() => {
    void loadChannels();
  }, [loadChannels]);

  const onMessage = useCallback(
    (message: ServerMessage) => {
      // `ready` arrives on connect *and* whenever the server re-binds this socket to a
      // character — a first creation, or a rebuild. Either way the socket may have missed
      // live frames, so the channel list, which carries the authoritative unread counts, is
      // refetched rather than patched.
      if (message.type === 'ready') {
        void loadChannels();
        return;
      }
      if (message.type === 'chat:channel') {
        socket.send({ type: 'chat:subscribe', channelIds: [message.channel.id] });
      }
      // The server has answered for this one, so its timeout must not fire later and
      // report a failure for a message that actually landed.
      if (message.type === 'chat:ack' || message.type === 'chat:rejected') {
        outstanding.current.delete(message.clientMsgId);
      }
      const action = actionForServerMessage(message, accountId);
      if (action) dispatch(action);
    },
    [accountId, loadChannels, socket],
  );

  useEffect(() => socket.subscribe(onMessage), [socket, onMessage]);

  const [historyRequests] = useState(() => new HistoryRequests());

  const loadHistory = useCallback(
    async (channelId: string, before?: string) => {
      const token = historyRequests.issue(channelId);
      const response = await api.chatMessages(channelId, before).catch(() => null);
      if (!historyRequests.isCurrent(channelId, token)) {
        dispatch({ type: 'historyDropped', channelId });
        return;
      }
      if (!response) {
        dispatch({ type: 'historyFailed', channelId });
        return;
      }
      dispatch({
        type: 'history',
        channelId,
        messages: response.messages,
        hasMore: response.hasMore,
        older: before !== undefined,
      });
    },
    [historyRequests],
  );

  /**
   * Read receipts are only meaningful for DMs; the Town Square keeps no watermark.
   *
   * Sending one is answered with `chat:unread`, which is itself a state change — so without
   * remembering what has already been acknowledged, "mark the open conversation read" feeds
   * its own trigger and the socket loops until the server rate-limits it.
   */
  const acknowledged = useRef(new Map<string, string>());
  const markRead = useCallback(
    (channelId: string) => {
      if (channelId === TOWN_SQUARE_CHANNEL_ID) return;
      const thread = stateRef.current.threads[channelId];
      const last = thread?.messages[thread.messages.length - 1];
      if (!last || acknowledged.current.get(channelId) === last.id) return;
      acknowledged.current.set(channelId, last.id);
      socket.send({ type: 'chat:read', channelId, lastReadMessageId: last.id });
    },
    [socket],
  );

  const select = useCallback(
    (channelId: string) => {
      dispatch({ type: 'select', channelId });
      const thread = stateRef.current.threads[channelId];
      if (!thread?.loaded) void loadHistory(channelId).then(() => markRead(channelId));
      else markRead(channelId);
    },
    [loadHistory, markRead],
  );

  const setOpen = useCallback(
    (open: boolean) => {
      dispatch({ type: 'setOpen', open });
      if (!open) return;
      const channelId = stateRef.current.activeChannelId;
      if (!stateRef.current.threads[channelId]?.loaded) {
        void loadHistory(channelId).then(() => markRead(channelId));
      } else markRead(channelId);
    },
    [loadHistory, markRead],
  );

  // A message arriving into the conversation you are looking at is read on arrival.
  useEffect(() => {
    if (!state.open) return;
    const thread = state.threads[state.activeChannelId];
    if (thread && thread.messages.length > 0) markRead(state.activeChannelId);
  }, [state.open, state.activeChannelId, state.threads, markRead]);

  const send = useCallback(
    (raw: string) => {
      const body = sanitizeMessageBody(raw);
      if (body.length === 0 || body.length > MESSAGE_MAX) return;
      const clientMsgId = crypto.randomUUID();
      outstanding.current.add(clientMsgId);
      dispatch({ type: 'sending' });
      socket.send({
        type: 'chat:send',
        clientMsgId,
        channelId: stateRef.current.activeChannelId,
        body,
      });
      // Belt and braces for "Sending…" that never clears. The socket queue means a send
      // survives a closed connection, but nothing can promise the *server* answers — so a
      // send that goes unacknowledged settles itself and says so, rather than leaving the
      // composer claiming work that is not happening.
      //
      // Keyed on this message rather than on the pending count: with a second send already
      // in flight, a count-based check would let this timer settle *that* one and report a
      // failure for a message that is perfectly fine.
      window.setTimeout(() => {
        if (!outstanding.current.delete(clientMsgId)) return;
        dispatch({ type: 'settled', note: 'That message has not gone through yet. Check your connection.' });
      }, SEND_ACK_TIMEOUT_MS);
    },
    [socket],
  );

  const loadOlder = useCallback(
    async (channelId: string) => {
      const thread = stateRef.current.threads[channelId];
      // A request that failed leaves `loadingOlder` false, so the retry is just another go.
      if (!thread || !thread.hasMore || thread.loadingOlder) return;
      const oldest = thread.messages[0];
      if (!oldest) return;
      dispatch({ type: 'loadingOlder', channelId });
      await loadHistory(channelId, oldest.id);
    },
    [loadHistory],
  );

  const retryHistory = useCallback(
    async (channelId: string) => {
      dispatch({ type: 'loadingHistory', channelId });
      await loadHistory(channelId);
      markRead(channelId);
    },
    [loadHistory, markRead],
  );

  const startDm = useCallback(
    async (targetAccountId: string) => {
      try {
        const { channel } = await api.openDm(targetAccountId);
        dispatch({ type: 'channel', channel });
        socket.send({ type: 'chat:subscribe', channelIds: [channel.id] });
        select(channel.id);
      } catch (error) {
        dispatch({ type: 'note', note: describeError(error) });
      }
    },
    [select, socket],
  );

  const setBlocked = useCallback(
    async (targetAccountId: string, blocked: boolean) => {
      try {
        if (blocked) await api.blockPlayer(targetAccountId);
        else await api.unblockPlayer(targetAccountId);
      } catch (error) {
        dispatch({ type: 'note', note: describeError(error) });
        return;
      }
      /**
       * A block changes what the server would serve for *every* channel at once, so nothing
       * already on screen survives on trust. The blocked author leaves immediately — waiting
       * for a round trip to stop showing someone you just blocked is the wrong order — every
       * thread is marked re-fetchable so re-opening one shows the new truth, and every
       * history request already in flight is disowned: it was answered against the old rules.
       */
      if (blocked) dispatch({ type: 'purgeAuthor', accountId: targetAccountId });
      else dispatch({ type: 'allowAuthor', accountId: targetAccountId });
      dispatch({ type: 'invalidate' });
      historyRequests.invalidateAll();
      await loadChannels();
      await loadHistory(stateRef.current.activeChannelId);
    },
    [historyRequests, loadChannels, loadHistory],
  );

  const channels = useMemo(
    () => state.order.map((id) => state.threads[id]?.channel).filter((channel): channel is ChatChannelDto => Boolean(channel)),
    [state.order, state.threads],
  );

  const totalUnread = useMemo(
    () => Object.values(state.threads).reduce((sum, thread) => sum + thread.unread, 0),
    [state.threads],
  );

  const value = useMemo<ChatValue>(
    () => ({
      open: state.open,
      setOpen,
      channels,
      threads: state.threads,
      activeChannelId: state.activeChannelId,
      activeThread: state.threads[state.activeChannelId] ?? null,
      totalUnread,
      note: state.note,
      sending: state.pending > 0,
      lastIncoming: state.lastIncoming,
      select,
      send,
      loadOlder,
      retryHistory,
      startDm,
      setBlocked,
      refreshChannels: loadChannels,
      dismissNote: () => dispatch({ type: 'note', note: null }),
    }),
    [
      state,
      channels,
      totalUnread,
      setOpen,
      select,
      send,
      loadOlder,
      retryHistory,
      startDm,
      setBlocked,
      loadChannels,
    ],
  );

  if (!enabled) return <>{children}</>;
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

/** Null until the player has a character — chat does not exist before that. */
export function useChat(): ChatValue | null {
  return useContext(ChatContext);
}
