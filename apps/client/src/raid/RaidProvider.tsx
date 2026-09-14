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
import type { BetrayalChoice, DuelCardDto, ParityCall, ServerMessage } from '@lethalmagotchi/shared';
import { useSession } from '../session/SessionProvider.js';
import { useSocket } from '../ws/SocketProvider.js';
import {
  initialState,
  reducer,
  type Aftermath,
  type IncomingRaidInvite,
  type Party,
  type RaidMatch,
} from './state.js';

export type { RaidMatch } from './state.js';

interface RaidValue {
  party: Party | null;
  partyHidden: boolean;
  incoming: IncomingRaidInvite | null;
  match: RaidMatch | null;
  aftermath: Aftermath | null;
  note: string | null;
  cancelled: { raidId: string; reason: string } | null;
  createRaid: (target: DuelCardDto) => void;
  invite: (characterId: string) => void;
  respond: (raidId: string, accept: boolean) => void;
  lockIn: () => void;
  hideParty: () => void;
  showParty: () => void;
  choose: (choice: BetrayalChoice) => void;
  call: (call: ParityCall, throwValue: number) => void;
  dismissMatch: () => void;
  /** Called once the report is on screen: until it lands, the server keeps re-offering it. */
  acknowledgeAftermath: (raidId: string) => void;
  dismissAftermath: () => void;
  dismissNote: () => void;
}

const RaidContext = createContext<RaidValue | null>(null);

export function RaidProvider({ children }: { children: ReactNode }) {
  const { status: sessionStatus, character } = useSession();
  const socket = useSocket();
  const [state, dispatch] = useReducer(reducer, initialState);
  const enabled = sessionStatus === 'authenticated' && character !== null;

  const stateRef = useRef(state);
  stateRef.current = state;
  const characterId = character?.id ?? null;
  const characterIdRef = useRef(characterId);
  characterIdRef.current = characterId;

  const onMessage = useCallback(
    (message: ServerMessage) => {
      if (message.type === 'ready') {
        // The socket may have missed frames — including the whole of a raid that happened
        // while this player was away — so it asks rather than trusting what is on screen.
        socket.send({ type: 'raid:resync' });
        return;
      }
      if (!message.type.startsWith('raid:')) return;
      // Every wallet a raid moves is announced with the `character:update` frame the session
      // already listens for, so nothing here has to re-fetch the player's own balance.
      dispatch({ type: 'server', message, characterId: characterIdRef.current, now: Date.now() });
    },
    [socket],
  );

  useEffect(() => socket.subscribe(onMessage), [socket, onMessage]);

  const createRaid = useCallback(
    (target: DuelCardDto) => {
      dispatch({ type: 'creating' });
      socket.send({ type: 'raid:create', targetCharacterId: target.characterId });
    },
    [socket],
  );

  const invite = useCallback(
    (invitedId: string) => {
      const party = stateRef.current.party;
      if (!party) return;
      socket.send({ type: 'raid:invite', raidId: party.raidId, characterId: invitedId });
    },
    [socket],
  );

  const respond = useCallback(
    (raidId: string, accept: boolean) => {
      socket.send({ type: 'raid:respond', raidId, accept });
      dispatch({ type: 'dismissIncoming', raidId });
    },
    [socket],
  );

  const lockIn = useCallback(() => {
    const party = stateRef.current.party;
    if (!party || party.state !== 'assembling' || party.locking) return;
    dispatch({ type: 'locking' });
    socket.send({ type: 'raid:lock', raidId: party.raidId });
  }, [socket]);

  const choose = useCallback(
    (choice: BetrayalChoice) => {
      const betrayal = stateRef.current.match?.betrayal;
      const raidId = stateRef.current.match?.raidId;
      if (!betrayal || !raidId || betrayal.result || betrayal.yourChoice !== null) return;
      if (betrayal.pendingSeq === betrayal.seq) return;
      dispatch({ type: 'choosing', choice, seq: betrayal.seq });
      socket.send({ type: 'raid:betray', raidId, seq: betrayal.seq, choice });
    },
    [socket],
  );

  const call = useCallback(
    (parityCall: ParityCall, throwValue: number) => {
      const parity = stateRef.current.match?.parity;
      const raidId = stateRef.current.match?.raidId;
      if (!parity || !raidId || parity.result || parity.yourCall !== null) return;
      if (parity.pendingSeq === parity.seq) return;
      dispatch({ type: 'calling', call: parityCall, throwValue, seq: parity.seq });
      socket.send({ type: 'raid:parity', raidId, seq: parity.seq, call: parityCall, throw: throwValue });
    },
    [socket],
  );

  const acknowledgeAftermath = useCallback(
    (raidId: string) => {
      socket.send({ type: 'raid:aftermath_ack', raidId });
    },
    [socket],
  );

  const value = useMemo<RaidValue>(
    () => ({
      party: state.party,
      partyHidden: state.partyHidden,
      incoming: state.incoming[0] ?? null,
      match: state.match,
      aftermath: state.aftermath,
      note: state.note,
      cancelled: state.cancelled,
      createRaid,
      invite,
      respond,
      lockIn,
      hideParty: () => dispatch({ type: 'hideParty' }),
      showParty: () => dispatch({ type: 'showParty' }),
      choose,
      call,
      dismissMatch: () => dispatch({ type: 'dismissMatch' }),
      acknowledgeAftermath,
      dismissAftermath: () => dispatch({ type: 'dismissAftermath' }),
      dismissNote: () => dispatch({ type: 'note', note: null }),
    }),
    [state, createRaid, invite, respond, lockIn, choose, call, acknowledgeAftermath],
  );

  if (!enabled) return <>{children}</>;
  return <RaidContext.Provider value={value}>{children}</RaidContext.Provider>;
}

/** Null until the player has a character — there is nothing to raid with before that. */
export function useRaid(): RaidValue | null {
  return useContext(RaidContext);
}
