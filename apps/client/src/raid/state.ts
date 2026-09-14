import {
  RAID_ERROR_MESSAGES,
  type BetrayalChoice,
  type ParityCall,
  type RaidMemberView,
  type RaidOutcome,
  type RaidTargetView,
  type ServerMessage,
  type WealthBand,
} from '@lethalmagotchi/shared';

export interface Party {
  raidId: string;
  target: RaidTargetView;
  members: RaidMemberView[];
  raidPotBand: WealthBand;
  initiatorCharacterId: string;
  state: 'assembling' | 'resolving';
  expiresAt: number | null;
  /** Set while a lock has been sent but the server has not answered it yet. */
  locking: boolean;
}

export interface IncomingRaidInvite {
  raidId: string;
  from: RaidMemberView;
  target: RaidTargetView;
  expiresAt: number;
}

export interface RaidResult {
  outcome: RaidOutcome;
  raidPot: number;
  targetPot: number;
  potCoins: number;
}

export interface BetrayalPhase {
  seq: number;
  deadlineAt: number;
  potCoins: number;
  yourChoice: BetrayalChoice | null;
  /** The window a choice has been sent for but not confirmed, so it cannot be sent twice. */
  pendingSeq: number | null;
  locked: string[];
  result: {
    choices: { characterId: string; choice: BetrayalChoice }[];
    awards: { characterId: string; coins: number }[];
    potDestroyed: boolean;
    remainder: number;
  } | null;
}

export interface ParityPhase {
  seq: number;
  round: number;
  deadlineAt: number;
  remainder: number;
  contenders: string[];
  yourCall: { call: ParityCall; throw: number } | null;
  pendingSeq: number | null;
  locked: string[];
  result: {
    calls: { characterId: string; call: ParityCall; throw: number }[];
    parity: ParityCall;
    winners: string[];
    awards: { characterId: string; coins: number }[];
    seededSplit: boolean;
  } | null;
}

export interface RaidEnd {
  outcome: RaidOutcome;
  coinsReceived: number;
  bankrupted: string[];
  potDestroyed: boolean;
  youWereBankrupted: boolean;
}

export interface Aftermath {
  raidId: string;
  raiders: { characterId: string; nickname: string; speciesId: string }[];
  outcome: RaidOutcome;
  raidPot: number;
  targetPot: number;
  coinsLost: number;
  nowBeggar: boolean;
  at: string;
}

export interface RaidMatch {
  raidId: string;
  target: RaidTargetView;
  members: RaidMemberView[];
  result: RaidResult | null;
  betrayal: BetrayalPhase | null;
  parity: ParityPhase | null;
  end: RaidEnd | null;
}

export interface State {
  party: Party | null;
  /**
   * The party card stands aside so the initiator can reach the Town Square rows they invite
   * people from. The raid itself is untouched by it — this is a view flag, not a state.
   */
  partyHidden: boolean;
  incoming: IncomingRaidInvite[];
  match: RaidMatch | null;
  aftermath: Aftermath | null;
  note: string | null;
  /** Set when the raid ended before it began, so the card can say which way it went. */
  cancelled: { raidId: string; reason: string } | null;
}

export const initialState: State = {
  party: null,
  partyHidden: false,
  incoming: [],
  match: null,
  aftermath: null,
  note: null,
  cancelled: null,
};

export type Action =
  | { type: 'server'; message: ServerMessage; characterId: string | null; now: number }
  | { type: 'creating' }
  | { type: 'hideParty' }
  | { type: 'showParty' }
  | { type: 'locking' }
  | { type: 'dismissIncoming'; raidId: string }
  | { type: 'choosing'; choice: BetrayalChoice; seq: number }
  | { type: 'calling'; call: ParityCall; throwValue: number; seq: number }
  | { type: 'dismissMatch' }
  | { type: 'dismissAftermath' }
  | { type: 'note'; note: string | null };

const CANCEL_COPY: Record<string, string> = {
  EXPIRED: 'Nobody locked the raid in before the window closed.',
  PARTY_TOO_SMALL: 'A raid needs at least two raiders.',
  SERVER_RESTART: 'The raid was called off. No coins moved.',
};

function withMatch(state: State, raidId: string, update: (match: RaidMatch) => RaidMatch): State {
  if (!state.match || state.match.raidId !== raidId) return state;
  return { ...state, match: update(state.match) };
}

function reduceServer(
  state: State,
  message: ServerMessage,
  characterId: string | null,
  now: number,
): State {
  switch (message.type) {
    case 'raid:invited':
      return {
        ...state,
        incoming: [
          ...state.incoming.filter((invite) => invite.raidId !== message.raidId),
          {
            raidId: message.raidId,
            from: message.from,
            target: message.target,
            expiresAt: Date.parse(message.expiresAt),
          },
        ],
      };

    case 'raid:party': {
      const party: Party = {
        raidId: message.raidId,
        target: message.target,
        members: message.members,
        raidPotBand: message.raidPotBand,
        initiatorCharacterId: message.initiatorCharacterId,
        state: message.state,
        expiresAt: message.expiresAt ? Date.parse(message.expiresAt) : null,
        locking: message.state === 'resolving',
      };
      /**
       * An invitee is a member from the moment they are asked, and the party frame reaches
       * them so they can watch it fill while they decide. It must not stand in for the
       * invite itself: dropping their pending invite here would leave them unable to answer
       * the thing they were asked.
       */
      const stillDeciding =
        message.members.find((member) => member.characterId === characterId)?.state === 'invited';
      return {
        ...state,
        party,
        // Once it is firing there is nothing left to assemble, so the card comes back.
        partyHidden: message.state === 'resolving' ? false : state.partyHidden,
        cancelled: null,
        incoming: stillDeciding
          ? state.incoming
          : state.incoming.filter((invite) => invite.raidId !== message.raidId),
        match:
          message.state === 'resolving' && !state.match
            ? {
                raidId: message.raidId,
                target: message.target,
                members: message.members,
                result: null,
                betrayal: null,
                parity: null,
                end: null,
              }
            : state.match,
      };
    }

    case 'raid:cancelled':
      return {
        ...state,
        party: null,
        partyHidden: false,
        match: null,
        incoming: state.incoming.filter((invite) => invite.raidId !== message.raidId),
        cancelled: { raidId: message.raidId, reason: CANCEL_COPY[message.reason] ?? CANCEL_COPY.SERVER_RESTART! },
      };

    case 'raid:result': {
      const result: RaidResult = {
        outcome: message.outcome,
        raidPot: message.raidPot,
        targetPot: message.targetPot,
        potCoins: message.potCoins,
      };
      const base: RaidMatch = state.match?.raidId === message.raidId
        ? state.match
        : {
            raidId: message.raidId,
            target: state.party?.target ?? { characterId: '', nickname: '', speciesId: '', band: 'broke' },
            members: state.party?.members ?? [],
            result: null,
            betrayal: null,
            parity: null,
            end: null,
          };
      return { ...state, party: null, partyHidden: false, match: { ...base, result } };
    }

    case 'raid:betrayal_window':
      return withMatch(state, message.raidId, (match) => ({
        ...match,
        betrayal: {
          seq: message.seq,
          deadlineAt: Date.parse(message.deadlineAt),
          potCoins: message.potCoins,
          yourChoice: null,
          pendingSeq: null,
          locked: [],
          result: null,
        },
      }));

    case 'raid:betrayal_locked':
      return withMatch(state, message.raidId, (match) => {
        const add = (ids: string[]): string[] =>
          ids.includes(message.characterId) ? ids : [...ids, message.characterId];
        // The frame names its own window, so a lock arriving either side of a reveal beat
        // is attributed to the window it was actually made in, never to the one on screen.
        if (message.phase === 'parity') {
          return match.parity && match.parity.seq === message.seq
            ? { ...match, parity: { ...match.parity, locked: add(match.parity.locked) } }
            : match;
        }
        return match.betrayal && match.betrayal.seq === message.seq
          ? { ...match, betrayal: { ...match.betrayal, locked: add(match.betrayal.locked) } }
          : match;
      });

    case 'raid:betrayal_result':
      return withMatch(state, message.raidId, (match) => ({
        ...match,
        betrayal: match.betrayal
          ? {
              ...match.betrayal,
              pendingSeq: null,
              result: {
                choices: message.choices,
                awards: message.awards,
                potDestroyed: message.potDestroyed,
                remainder: message.remainder,
              },
            }
          : match.betrayal,
      }));

    case 'raid:parity_round': {
      const deadlineAt = Date.parse(message.deadlineAt);
      /**
       * A resync landing in the reveal beat replays the round with a deadline already past.
       * Re-enabling the calls for it would offer a window nobody can call into: the click
       * comes back `STALE_SEQ`, which is not what happened.
       */
      if (deadlineAt <= now && state.match?.parity?.round === message.round) return state;
      return withMatch(state, message.raidId, (match) => ({
        ...match,
        parity: {
          seq: message.seq,
          round: message.round,
          deadlineAt,
          remainder: message.remainder,
          contenders: message.contenders,
          yourCall: null,
          pendingSeq: null,
          locked: [],
          result: null,
        },
      }));
    }

    case 'raid:parity_result':
      return withMatch(state, message.raidId, (match) => ({
        ...match,
        parity: match.parity
          ? {
              ...match.parity,
              pendingSeq: null,
              result: {
                calls: message.calls,
                parity: message.parity,
                winners: message.winners,
                awards: message.awards,
                seededSplit: message.seededSplit,
              },
            }
          : match.parity,
      }));

    case 'raid:end':
      return withMatch(state, message.raidId, (match) => ({
        ...match,
        end: {
          outcome: message.outcome,
          coinsReceived: message.coinsReceived,
          bankrupted: message.bankrupted,
          potDestroyed: message.potDestroyed,
          youWereBankrupted: characterId !== null && message.bankrupted.includes(characterId),
        },
      }));

    case 'raid:aftermath':
      return {
        ...state,
        aftermath: {
          raidId: message.raidId,
          raiders: message.raiders,
          outcome: message.outcome,
          raidPot: message.raidPot,
          targetPot: message.targetPot,
          coinsLost: message.coinsLost,
          nowBeggar: message.nowBeggar,
          at: message.at,
        },
      };

    case 'raid:error':
      return {
        ...state,
        note: RAID_ERROR_MESSAGES[message.code] ?? message.message,
        party: state.party ? { ...state.party, locking: false } : state.party,
        // Only a choice actually in flight is rolled back: an unrelated error must not
        // un-lock one the server has already accepted.
        match: state.match
          ? {
              ...state.match,
              betrayal:
                state.match.betrayal && state.match.betrayal.pendingSeq !== null
                  ? { ...state.match.betrayal, pendingSeq: null, yourChoice: null }
                  : state.match.betrayal,
              parity:
                state.match.parity && state.match.parity.pendingSeq !== null
                  ? { ...state.match.parity, pendingSeq: null, yourCall: null }
                  : state.match.parity,
            }
          : state.match,
      };

    default:
      return state;
  }
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'server':
      return reduceServer(state, action.message, action.characterId, action.now);

    case 'creating':
      return { ...state, note: null, cancelled: null, partyHidden: false };

    case 'hideParty':
      return { ...state, partyHidden: true };

    case 'showParty':
      return { ...state, partyHidden: false };

    case 'locking':
      return state.party ? { ...state, party: { ...state.party, locking: true } } : state;

    case 'dismissIncoming':
      return { ...state, incoming: state.incoming.filter((invite) => invite.raidId !== action.raidId) };

    case 'choosing':
      return state.match?.betrayal
        ? {
            ...state,
            match: {
              ...state.match,
              betrayal: { ...state.match.betrayal, yourChoice: action.choice, pendingSeq: action.seq },
            },
          }
        : state;

    case 'calling':
      return state.match?.parity
        ? {
            ...state,
            match: {
              ...state.match,
              parity: {
                ...state.match.parity,
                yourCall: { call: action.call, throw: action.throwValue },
                pendingSeq: action.seq,
              },
            },
          }
        : state;

    case 'dismissMatch':
      return { ...state, match: null, party: null, partyHidden: false, cancelled: null };

    case 'dismissAftermath':
      return { ...state, aftermath: null };

    case 'note':
      return { ...state, note: action.note };
  }
}

/** The aftermath's lead line. The scariest reading is the wrong one, so it is closed first. */
export function aftermathHeadline(aftermath: Aftermath, nickname: string): string {
  if (aftermath.outcome === 'raiders_won') {
    return `${nickname} was robbed — and is completely unharmed.`;
  }
  if (aftermath.outcome === 'target_won') return `${nickname} saw off a raid, and kept the spoils.`;
  return `A raid on ${nickname} came to nothing.`;
}

export function aftermathCoinLine(aftermath: Aftermath): string {
  if (aftermath.outcome === 'raiders_won') {
    return `${aftermath.coinsLost} LC taken. HP, stats and cooldowns are untouched.`;
  }
  if (aftermath.outcome === 'target_won') {
    return `${Math.abs(aftermath.coinsLost)} LC inherited from the raiders, who are left with nothing.`;
  }
  return 'The two pots were exactly equal, so nothing moved at all.';
}
