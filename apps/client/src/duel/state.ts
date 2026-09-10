import {
  DUEL_ERROR_MESSAGES,
  type DuelCardDto,
  type DuelInviteState,
  type DuelOutcome,
  type DuelPlayerView,
  type DuelSide,
  type DuelThrow,
  type ServerMessage,
} from '@lethalmagotchi/shared';

export interface RoundLogEntry {
  round: number;
  replay: number;
  yourThrow: DuelThrow;
  opponentThrow: DuelThrow;
  winner: 'you' | 'opponent' | 'draw';
  tiebreak: boolean;
}

export interface MatchEnd {
  outcome: DuelOutcome;
  winnerCharacterId: string | null;
  loserCharacterId: string | null;
  coinsTransferred: number;
  youWon: boolean;
}

export interface MatchState {
  duelId: string;
  opponent: DuelPlayerView;
  stakeCoins: number;
  winsNeeded: number;
  youAre: DuelSide;
  round: number;
  replay: number;
  seq: number;
  deadlineAt: number;
  yourThrow: DuelThrow | null;
  /** The window a throw has been sent for but not yet confirmed, so it cannot be sent twice. */
  pendingSeq: number | null;
  opponentLocked: boolean;
  reveal: RoundLogEntry | null;
  log: RoundLogEntry[];
  yourWins: number;
  theirWins: number;
  end: MatchEnd | null;
}

/**
 * The loser's dialog quotes the stake that changed hands and nothing else. Their net loss is
 * their whole pre-duel wallet — rebirth resets coins to 5 regardless of what is left after
 * the stake — and the rebirth dialog that follows seconds later is the single source of truth
 * for that number. Quoting the stake as "lost" here contradicted it by orders of magnitude.
 */
export function defeatStakeLine(coinsTransferred: number, winnerName: string): string {
  const paid =
    coinsTransferred > 0
      ? `${coinsTransferred} LC of the stake goes to ${winnerName}.`
      : `There was nothing at stake to take.`;
  // Second person: this dialog is only ever shown to the loser, and "their" read as the
  // winner named in the sentence before it.
  return `${paid} Your coins and stats reset with the rebirth that follows.`;
}

/**
 * The winner's counterpart. A duel between two broke pets is played for nothing, and
 * "takes 0 LC" reads as a bug rather than as the empty purse it describes.
 */
export function victoryStakeLine(coinsTransferred: number, winnerName: string): string {
  return coinsTransferred > 0
    ? `${winnerName} is still standing, and takes ${coinsTransferred} LC.`
    : `${winnerName} is still standing.`;
}

export interface IncomingInvite {
  inviteId: string;
  from: DuelPlayerView;
  expiresAt: number;
  stakeCoins: number;
}

export interface OutgoingInvite {
  target: DuelCardDto;
  /** `composing` is the Stakes Card before anything has been sent. */
  phase: 'composing' | 'sending' | 'pending' | 'resolved';
  inviteId: string | null;
  state: DuelInviteState | null;
  expiresAt: number | null;
  /** The server's binding snapshot once the invite exists; before that the local estimate. */
  stakeCoins: number | null;
}

export interface State {
  match: MatchState | null;
  /** Head of the queue is what the takeover shows; more than one is rare but possible. */
  incoming: IncomingInvite[];
  outgoing: OutgoingInvite | null;
  cards: Record<string, DuelCardDto>;
  note: string | null;
}

export const initialState: State = {
  match: null,
  incoming: [],
  outgoing: null,
  cards: {},
  note: null,
};

export type Action =
  | { type: 'server'; message: ServerMessage; characterId: string | null; now: number }
  | { type: 'cards'; cards: DuelCardDto[] }
  | { type: 'openStakes'; target: DuelCardDto }
  | { type: 'sendingInvite' }
  | { type: 'closeStakes' }
  | { type: 'dismissIncoming'; inviteId: string }
  | { type: 'locking'; throw: DuelThrow; seq: number }
  | { type: 'dismissMatch' }
  | { type: 'note'; note: string | null };

function withMatch(state: State, duelId: string, update: (match: MatchState) => MatchState): State {
  if (!state.match || state.match.duelId !== duelId) return state;
  return { ...state, match: update(state.match) };
}

function reduceServer(
  state: State,
  message: ServerMessage,
  characterId: string | null,
  now: number,
): State {
  switch (message.type) {
    case 'duel:invited':
      return {
        ...state,
        incoming: [
          ...state.incoming.filter((invite) => invite.inviteId !== message.inviteId),
          {
            inviteId: message.inviteId,
            from: message.from,
            expiresAt: Date.parse(message.expiresAt),
            stakeCoins: message.stakeCoins,
          },
        ],
      };

    case 'duel:invite_state': {
      const incoming = state.incoming.filter(
        (invite) => invite.inviteId !== message.inviteId || message.state === 'pending',
      );
      /**
       * A reload leaves `outgoing` null while the challenge is still live on the server, so
       * a pending state that arrives with the target's card rebuilds the card rather than
       * being dropped — otherwise the challenger can neither withdraw nor reissue until the
       * invite's own TTL lapses.
       */
      if (!state.outgoing && message.state === 'pending' && message.target) {
        return {
          ...state,
          incoming,
          outgoing: {
            target: message.target,
            phase: 'pending',
            inviteId: message.inviteId,
            state: 'pending',
            expiresAt: message.expiresAt ? Date.parse(message.expiresAt) : null,
            stakeCoins: message.stakeCoins ?? null,
          },
        };
      }
      const outgoing =
        state.outgoing && (state.outgoing.inviteId === message.inviteId || state.outgoing.inviteId === null)
          ? {
              ...state.outgoing,
              inviteId: message.inviteId,
              state: message.state,
              phase: message.state === 'pending' ? ('pending' as const) : ('resolved' as const),
              expiresAt: message.expiresAt ? Date.parse(message.expiresAt) : state.outgoing.expiresAt,
              stakeCoins: message.stakeCoins ?? state.outgoing.stakeCoins,
            }
          : state.outgoing;
      // An accepted invite is replaced by the match itself, so its card gets out of the way.
      return { ...state, incoming, outgoing: message.state === 'accepted' ? null : outgoing };
    }

    case 'duel:start':
      return {
        ...state,
        outgoing: null,
        incoming: [],
        note: null,
        match: {
          duelId: message.duelId,
          opponent: message.opponent,
          stakeCoins: message.stakeCoins,
          winsNeeded: message.winsNeeded,
          youAre: message.youAre,
          round: 1,
          replay: 0,
          seq: 0,
          deadlineAt: 0,
          yourThrow: null,
          pendingSeq: null,
          opponentLocked: false,
          reveal: null,
          log: [],
          yourWins: 0,
          theirWins: 0,
          end: null,
        },
      };

    case 'duel:round': {
      /**
       * A resync that lands during the reveal beat replays the round with the deadline of
       * the window that just closed, which is already in the past. Clearing the reveal and
       * re-enabling the throws for it would offer a window nobody can throw into: the click
       * comes back `STALE_SEQ`, rendered as "that throw was already locked in", which is not
       * what happened. The live frame for the next window does the transition.
       */
      const deadlineAt = Date.parse(message.deadlineAt);
      if (deadlineAt <= now) return state;
      return withMatch(state, message.duelId, (match) => ({
        ...match,
        round: message.round,
        replay: message.replay,
        seq: message.seq,
        deadlineAt,
        yourThrow: null,
        pendingSeq: null,
        opponentLocked: false,
        reveal: null,
      }));
    }

    case 'duel:opponent_locked':
      return withMatch(state, message.duelId, (match) => ({ ...match, opponentLocked: true }));

    case 'duel:round_result':
      return withMatch(state, message.duelId, (match) => {
        const entry: RoundLogEntry = {
          round: message.round,
          replay: message.replay,
          yourThrow: message.yourThrow,
          opponentThrow: message.opponentThrow,
          winner: message.winner,
          tiebreak: message.tiebreak,
        };
        const mine = match.youAre === 'challenger' ? message.challengerWins : message.opponentWins;
        const theirs = match.youAre === 'challenger' ? message.opponentWins : message.challengerWins;
        return {
          ...match,
          yourThrow: message.yourThrow,
          pendingSeq: null,
          reveal: entry,
          log: [...match.log, entry],
          yourWins: mine,
          theirWins: theirs,
        };
      });

    case 'duel:end':
      return withMatch(state, message.duelId, (match) => ({
        ...match,
        end: {
          outcome: message.outcome,
          winnerCharacterId: message.winnerCharacterId,
          loserCharacterId: message.loserCharacterId,
          coinsTransferred: message.coinsTransferred,
          youWon: characterId !== null && message.winnerCharacterId === characterId,
        },
      }));

    case 'duel:error':
      return {
        ...state,
        note: DUEL_ERROR_MESSAGES[message.code] ?? message.message,
        // Only a throw that was actually in flight is rolled back: an unrelated error must
        // not un-lock a throw the server has already accepted.
        match:
          state.match && state.match.pendingSeq !== null
            ? { ...state.match, pendingSeq: null, yourThrow: null }
            : state.match,
        outgoing:
          state.outgoing && state.outgoing.phase !== 'pending'
            ? { ...state.outgoing, phase: 'composing' }
            : state.outgoing,
      };

    default:
      return state;
  }
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'server':
      return reduceServer(state, action.message, action.characterId, action.now);

    case 'cards': {
      const cards = { ...state.cards };
      for (const card of action.cards) cards[card.characterId] = card;
      const outgoing =
        state.outgoing && cards[state.outgoing.target.characterId]
          ? { ...state.outgoing, target: cards[state.outgoing.target.characterId]! }
          : state.outgoing;
      return { ...state, cards, outgoing };
    }

    case 'openStakes':
      return {
        ...state,
        note: null,
        outgoing: {
          target: action.target,
          phase: 'composing',
          inviteId: null,
          state: null,
          expiresAt: null,
          stakeCoins: null,
        },
      };

    case 'sendingInvite':
      return state.outgoing ? { ...state, outgoing: { ...state.outgoing, phase: 'sending' } } : state;

    case 'closeStakes':
      return { ...state, outgoing: null };

    case 'dismissIncoming':
      return { ...state, incoming: state.incoming.filter((invite) => invite.inviteId !== action.inviteId) };

    case 'locking':
      return state.match
        ? { ...state, match: { ...state.match, yourThrow: action.throw, pendingSeq: action.seq } }
        : state;

    case 'dismissMatch':
      return { ...state, match: null };

    case 'note':
      return { ...state, note: action.note };
  }
}
