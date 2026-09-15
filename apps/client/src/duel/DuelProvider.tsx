import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import type { DuelCardDto, DuelThrow, ServerMessage } from '@lethalmagotchi/shared';
import { api } from '../api/client.js';
import { useSession } from '../session/SessionProvider.js';
import { useSocket } from '../ws/SocketProvider.js';
import { initialState, reducer, type IncomingInvite, type MatchState, type OutgoingInvite } from './state.js';

export type { MatchState, RoundLogEntry } from './state.js';

interface DuelValue {
  match: MatchState | null;
  incoming: IncomingInvite | null;
  outgoing: OutgoingInvite | null;
  note: string | null;
  cards: Record<string, DuelCardDto>;
  ensureCards: (characterIds: string[]) => void;
  /** Re-reads cards whose contents a change outside duels has just invalidated. */
  refetchCards: (characterIds: string[]) => void;
  openStakes: (target: DuelCardDto) => void;
  closeStakes: () => void;
  sendInvite: () => void;
  cancelInvite: () => void;
  respond: (inviteId: string, accept: boolean) => void;
  throwHand: (choice: DuelThrow) => void;
  dismissMatch: () => void;
  dismissNote: () => void;
}

const DuelContext = createContext<DuelValue | null>(null);

export function DuelProvider({ children }: { children: ReactNode }) {
  const { status: sessionStatus, character } = useSession();
  const socket = useSocket();
  const [state, dispatch] = useReducer(reducer, initialState);
  const enabled = sessionStatus === 'authenticated' && character !== null;

  const stateRef = useRef(state);
  stateRef.current = state;
  const characterId = character?.id ?? null;
  const characterIdRef = useRef(characterId);
  characterIdRef.current = characterId;

  /** Ids already asked for, so a re-render of the Town Square is not a burst of requests. */
  const requested = useRef(new Set<string>());

  const fetchCards = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    const response = await api.duelCards(ids).catch(() => null);
    if (!response) {
      for (const id of ids) requested.current.delete(id);
      return;
    }
    dispatch({ type: 'cards', cards: response.cards });
  }, []);

  const ensureCards = useCallback(
    (characterIds: string[]) => {
      const missing = characterIds.filter((id) => id && !requested.current.has(id));
      if (missing.length === 0) return;
      for (const id of missing) requested.current.add(id);
      void fetchCards(missing);
    },
    [fetchCards],
  );

  /**
   * The card carries a player's group as well as their duel standing, and a group changes
   * without any duel frame to notice it by — so the one client that knows a roster just moved
   * says so here rather than waiting for a reload.
   */
  const refetchCards = useCallback(
    (characterIds: string[]) => {
      const ids = [...new Set(characterIds.filter(Boolean))];
      if (ids.length === 0) return;
      void fetchCards(ids).then(() => {
        for (const id of ids) requested.current.add(id);
      });
    },
    [fetchCards],
  );

  const onMessage = useCallback(
    (message: ServerMessage) => {
      if (message.type === 'ready') {
        // The socket may have missed frames: ask the server what is actually live rather
        // than trusting whatever the last connection left on screen.
        socket.send({ type: 'duel:resync' });
        return;
      }
      if (!message.type.startsWith('duel:')) return;
      dispatch({ type: 'server', message, characterId: characterIdRef.current, now: Date.now() });

      /**
       * Two events change what a duel card says: a settled duel moves coins and both
       * records, and a decline puts a chicken badge on the decliner. Cards are cached per
       * character, so both have to invalidate rather than wait for a reload.
       */
      const stale =
        message.type === 'duel:end'
          ? [stateRef.current.match?.opponent.characterId, characterIdRef.current]
          : message.type === 'duel:invite_state' && message.state === 'declined'
            ? [stateRef.current.outgoing?.target.characterId, characterIdRef.current]
            : [];
      const ids = stale.filter((id): id is string => typeof id === 'string');
      if (ids.length > 0) {
        for (const id of ids) requested.current.delete(id);
        void fetchCards(ids).then(() => {
          for (const id of ids) requested.current.add(id);
        });
      }
    },
    [fetchCards, socket],
  );

  useEffect(() => socket.subscribe(onMessage), [socket, onMessage]);

  const openStakes = useCallback((target: DuelCardDto) => dispatch({ type: 'openStakes', target }), []);
  const closeStakes = useCallback(() => dispatch({ type: 'closeStakes' }), []);

  const sendInvite = useCallback(() => {
    const outgoing = stateRef.current.outgoing;
    if (!outgoing || outgoing.phase !== 'composing') return;
    dispatch({ type: 'sendingInvite' });
    socket.send({ type: 'duel:invite', targetCharacterId: outgoing.target.characterId });
  }, [socket]);

  const cancelInvite = useCallback(() => {
    const outgoing = stateRef.current.outgoing;
    if (outgoing?.inviteId) socket.send({ type: 'duel:cancel', inviteId: outgoing.inviteId });
    dispatch({ type: 'closeStakes' });
  }, [socket]);

  const respond = useCallback(
    (inviteId: string, accept: boolean) => {
      socket.send({ type: 'duel:respond', inviteId, accept });
      dispatch({ type: 'dismissIncoming', inviteId });
    },
    [socket],
  );

  const throwHand = useCallback(
    (choice: DuelThrow) => {
      const match = stateRef.current.match;
      if (!match || match.end || match.yourThrow !== null || match.pendingSeq === match.seq) return;
      dispatch({ type: 'locking', throw: choice, seq: match.seq });
      socket.send({
        type: 'duel:throw',
        duelId: match.duelId,
        round: match.round,
        replay: match.replay,
        seq: match.seq,
        throw: choice,
      });
    },
    [socket],
  );

  const value = useMemo<DuelValue>(
    () => ({
      match: state.match,
      incoming: state.incoming[0] ?? null,
      outgoing: state.outgoing,
      note: state.note,
      cards: state.cards,
      ensureCards,
      refetchCards,
      openStakes,
      closeStakes,
      sendInvite,
      cancelInvite,
      respond,
      throwHand,
      dismissMatch: () => dispatch({ type: 'dismissMatch' }),
      dismissNote: () => dispatch({ type: 'note', note: null }),
    }),
    [
      state,
      ensureCards,
      refetchCards,
      openStakes,
      closeStakes,
      sendInvite,
      cancelInvite,
      respond,
      throwHand,
    ],
  );

  if (!enabled) return <>{children}</>;
  return <DuelContext.Provider value={value}>{children}</DuelContext.Provider>;
}

/** Null until the player has a character — there is nothing to duel with before that. */
export function useDuel(): DuelValue | null {
  return useContext(DuelContext);
}
