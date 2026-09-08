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
import type {
  BettingAction,
  BlindsView,
  Card,
  CharacterStats,
  LegalActionsView,
  PotPayout,
  SeatView,
  ServerMessage,
  ShowdownReveal,
  Street,
  TableStanding,
  TournamentEntryDto,
  TournamentStatusResponse,
  TournamentSummary,
} from '@lethalmagotchi/shared';
import { api } from '../api/client.js';
import { useSession } from '../session/SessionProvider.js';
import { useGameSocket, type SocketStatus } from '../ws/useGameSocket.js';

export interface HandView {
  handId: string;
  handNumber: number;
  buttonSeat: number;
  blinds: BlindsView;
  suddenDeath: boolean;
  board: Card[];
  street: Street;
  potCoins: number;
  stacks: number[];
  committed: number[];
  folded: boolean[];
  allIn: boolean[];
}

export interface TurnView {
  handId: string;
  seq: number;
  seatIndex: number;
  deadlineAt: number;
  legal: LegalActionsView;
}

export interface TableView {
  tournamentId: string;
  tableId: string;
  round: number;
  totalRounds: number;
  seatIndex: number;
  seats: SeatView[];
  handsPerTable: number;
  hand: HandView | null;
  holeCards: Card[];
  bestHand: string;
  turn: TurnView | null;
  showdown: { reveals: ShowdownReveal[]; payouts: PotPayout[]; summary: string } | null;
  pendingSeq: number | null;
  note: string | null;
}

export type Outcome =
  | { kind: 'bye'; round: number }
  | { kind: 'qualified'; standings: TableStanding[]; round: number; coinsDelta: number }
  | { kind: 'eliminated'; standings: TableStanding[]; round: number; coinsReturned: number }
  | { kind: 'winner'; nickname: string; prizeCoins: number; stackCoins: number; you: boolean }
  | { kind: 'cancelled'; reason: string };

export interface RebirthNotice {
  statsBefore: CharacterStats;
  coinsBefore: number;
  rebirthIndex: number;
}

interface State {
  tournament: TournamentSummary | null;
  entry: TournamentEntryDto | null;
  blackout: boolean;
  resumesAt: string | null;
  nextSlotAt: string | null;
  table: TableView | null;
  ladder: { round: number; totalRounds: number; remaining: number } | null;
  outcome: Outcome | null;
  rebirth: RebirthNotice | null;
  entryNotice: { hpConverted: number } | null;
}

const initialState: State = {
  tournament: null,
  entry: null,
  blackout: false,
  resumesAt: null,
  nextSlotAt: null,
  table: null,
  ladder: null,
  outcome: null,
  rebirth: null,
  entryNotice: null,
};

type Action =
  | { type: 'status'; status: TournamentStatusResponse }
  | { type: 'server'; message: ServerMessage; characterId: string | null }
  | { type: 'pending'; seq: number }
  | { type: 'dismissOutcome' }
  | { type: 'dismissRebirth' }
  | { type: 'dismissEntryNotice' };

function withTable(state: State, update: (table: TableView) => TableView): State {
  if (!state.table) return state;
  return { ...state, table: update(state.table) };
}

function reduceServer(state: State, message: ServerMessage, characterId: string | null): State {
  switch (message.type) {
    case 'tourney:announce':
      return { ...state, tournament: message.tournament };

    case 'tourney:entered':
      return { ...state, entryNotice: { hpConverted: message.hpConverted } };

    case 'tourney:entry_failed':
      return { ...state, entry: null };

    case 'tourney:seated':
      return {
        ...state,
        outcome: null,
        ladder: { round: message.round, totalRounds: message.totalRounds, remaining: 0 },
        table: {
          tournamentId: message.tournamentId,
          tableId: message.tableId,
          round: message.round,
          totalRounds: message.totalRounds,
          seatIndex: message.seatIndex,
          seats: message.seats,
          handsPerTable: message.handsPerTable,
          hand: state.table?.tableId === message.tableId ? state.table.hand : null,
          holeCards: state.table?.tableId === message.tableId ? state.table.holeCards : [],
          bestHand: state.table?.tableId === message.tableId ? state.table.bestHand : '',
          turn: state.table?.tableId === message.tableId ? state.table.turn : null,
          showdown: null,
          pendingSeq: null,
          note: null,
        },
      };

    case 'tourney:bye':
      return { ...state, outcome: { kind: 'bye', round: message.round } };

    case 'tourney:seat_state':
      return withTable(state, (table) => ({ ...table, seats: message.seats }));

    case 'tourney:hand_start':
      return withTable(state, (table) => ({
        ...table,
        showdown: null,
        turn: null,
        pendingSeq: null,
        note: null,
        holeCards: [],
        bestHand: '',
        seats: table.seats.map((seat, index) => ({
          ...seat,
          stack: message.stacks[index] ?? seat.stack,
          folded: false,
          allIn: false,
          committed: 0,
        })),
        hand: {
          handId: message.handId,
          handNumber: message.handNumber,
          buttonSeat: message.buttonSeat,
          blinds: message.blinds,
          suddenDeath: message.suddenDeath,
          board: [],
          street: 'preflop',
          potCoins: message.potCoins,
          stacks: message.stacks,
          committed: message.stacks.map(() => 0),
          folded: message.stacks.map(() => false),
          allIn: message.stacks.map(() => false),
        },
      }));

    case 'tourney:private':
      return withTable(state, (table) => ({
        ...table,
        holeCards: message.holeCards,
        bestHand: message.bestHand,
      }));

    case 'tourney:turn':
      return withTable(state, (table) => ({
        ...table,
        pendingSeq: null,
        note: null,
        turn: {
          handId: message.handId,
          seq: message.seq,
          seatIndex: message.seatIndex,
          deadlineAt: Date.parse(message.deadlineAt),
          legal: message.legal,
        },
      }));

    case 'tourney:action':
      return withTable(state, (table) => ({
        ...table,
        turn: null,
        seats: table.seats.map((seat, index) => ({
          ...seat,
          stack: message.stacks[index] ?? seat.stack,
          committed: message.committed[index] ?? 0,
          folded: message.folded[index] ?? false,
          allIn: message.allIn[index] ?? false,
        })),
        hand: table.hand
          ? {
              ...table.hand,
              potCoins: message.potCoins,
              stacks: message.stacks,
              committed: message.committed,
              folded: message.folded,
              allIn: message.allIn,
            }
          : null,
      }));

    case 'tourney:board':
      return withTable(state, (table) => ({
        ...table,
        hand: table.hand
          ? { ...table.hand, board: message.cards, street: message.street, potCoins: message.potCoins }
          : null,
      }));

    case 'tourney:showdown':
      return withTable(state, (table) => ({
        ...table,
        turn: null,
        showdown: { reveals: message.reveals, payouts: message.payouts, summary: message.summary },
        seats: table.seats.map((seat, index) => ({ ...seat, stack: message.stacks[index] ?? seat.stack, committed: 0 })),
        hand: table.hand ? { ...table.hand, stacks: message.stacks, potCoins: 0 } : null,
      }));

    case 'tourney:table_result': {
      const qualified = message.qualifierCharacterId === characterId;
      const mine = message.standings.find((standing) => standing.characterId === characterId);
      return {
        ...state,
        table: null,
        outcome: qualified
          ? {
              kind: 'qualified',
              standings: message.standings,
              round: state.table?.round ?? 1,
              coinsDelta: mine?.stack ?? 0,
            }
          : {
              kind: 'eliminated',
              standings: message.standings,
              round: state.table?.round ?? 1,
              coinsReturned: mine?.stack ?? 0,
            },
      };
    }

    case 'tourney:round_start':
      return {
        ...state,
        ladder: { round: message.round, totalRounds: message.totalRounds, remaining: message.remaining },
      };

    case 'tourney:eliminated':
      return state.outcome?.kind === 'eliminated'
        ? { ...state, outcome: { ...state.outcome, coinsReturned: message.coinsReturned } }
        : state;

    case 'tourney:winner':
      return {
        ...state,
        table: null,
        outcome: {
          kind: 'winner',
          nickname: message.nickname,
          prizeCoins: message.prizeCoins,
          stackCoins: message.stackCoins,
          you: message.characterId === characterId,
        },
      };

    case 'tourney:cancelled':
      return { ...state, table: null, outcome: { kind: 'cancelled', reason: message.reason } };

    case 'tourney:rejected':
      return withTable(state, (table) => ({ ...table, pendingSeq: null, note: message.message }));

    case 'character:rebirth':
      return {
        ...state,
        table: null,
        rebirth: {
          statsBefore: message.statsBefore,
          coinsBefore: message.coinsBefore,
          rebirthIndex: message.rebirthIndex,
        },
      };

    default:
      return state;
  }
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'status':
      return {
        ...state,
        tournament: action.status.tournament,
        entry: action.status.entry,
        blackout: action.status.blackout,
        resumesAt: action.status.resumesAt,
        nextSlotAt: action.status.nextSlotAt,
      };
    case 'server':
      return reduceServer(state, action.message, action.characterId);
    case 'pending':
      return withTable(state, (table) => ({ ...table, pendingSeq: action.seq }));
    case 'dismissOutcome':
      return { ...state, outcome: null };
    case 'dismissRebirth':
      return { ...state, rebirth: null };
    case 'dismissEntryNotice':
      return { ...state, entryNotice: null };
  }
}

interface TournamentValue extends State {
  socketStatus: SocketStatus;
  act: (action: BettingAction, amount?: number) => void;
  setOptIn: (optIn: boolean) => Promise<void>;
  refresh: () => Promise<void>;
  dismissOutcome: () => void;
  dismissRebirth: () => void;
  dismissEntryNotice: () => void;
}

const TournamentContext = createContext<TournamentValue | null>(null);

const STATUS_POLL_MS = 30_000;

export function TournamentProvider({ children }: { children: ReactNode }) {
  const { status: sessionStatus, character, setCharacter } = useSession();
  const [state, dispatch] = useReducer(reducer, initialState);
  const characterId = character?.id ?? null;
  const characterIdRef = useRef(characterId);
  characterIdRef.current = characterId;

  const onMessage = useCallback(
    (message: ServerMessage) => {
      if (message.type === 'character:update' || message.type === 'character:rebirth') {
        setCharacter(message.character);
      }
      dispatch({ type: 'server', message, characterId: characterIdRef.current });
    },
    [setCharacter],
  );

  const socket = useGameSocket({ enabled: sessionStatus === 'authenticated', onMessage });

  const refresh = useCallback(async () => {
    if (sessionStatus !== 'authenticated') return;
    const status = await api.tournamentStatus().catch(() => null);
    if (!status) return;
    dispatch({ type: 'status', status });
    // Entry can end in a rebirth, and the warning the player is shown before choosing is
    // derived from HP and coins. This poll is the only refresh a player with a dropped
    // socket gets, so it has to carry the wallet too.
    if (status.character) setCharacter(status.character);
  }, [sessionStatus, setCharacter]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const act = useCallback(
    (action: BettingAction, amount?: number) => {
      const table = state.table;
      const turn = table?.turn;
      if (!table || !turn || turn.seatIndex !== table.seatIndex || table.pendingSeq === turn.seq) return;
      dispatch({ type: 'pending', seq: turn.seq });
      socket.send({
        type: 'tourney:act',
        handId: turn.handId,
        seq: turn.seq,
        action,
        ...(amount === undefined ? {} : { amount }),
      });
    },
    [socket, state.table],
  );

  const setOptIn = useCallback(
    async (optIn: boolean) => {
      const response = await api.setTournamentOptIn(optIn);
      setCharacter(response.character);
      await refresh();
    },
    [refresh, setCharacter],
  );

  const value = useMemo<TournamentValue>(
    () => ({
      ...state,
      socketStatus: socket.status,
      act,
      setOptIn,
      refresh,
      dismissOutcome: () => dispatch({ type: 'dismissOutcome' }),
      dismissRebirth: () => dispatch({ type: 'dismissRebirth' }),
      dismissEntryNotice: () => dispatch({ type: 'dismissEntryNotice' }),
    }),
    [state, socket.status, act, setOptIn, refresh],
  );

  return <TournamentContext.Provider value={value}>{children}</TournamentContext.Provider>;
}

export function useTournament(): TournamentValue {
  const value = useContext(TournamentContext);
  if (!value) throw new Error('useTournament must be used inside TournamentProvider');
  return value;
}
