import { z } from 'zod';
import type { Card } from './cards.js';
import { MESSAGE_RAW_MAX, type ChatChannelDto, type ChatMessageDto, type ChatRejectCode } from './chat.js';
import {
  DUEL_THROWS,
  type DuelCardDto,
  type DuelErrorCode,
  type DuelInviteState,
  type DuelOutcome,
  type DuelPlayerView,
  type DuelSide,
  type DuelThrow,
} from './duel.js';
import {
  BETRAYAL_CHOICES,
  PARITY_CALLS,
  PARITY_THROW_MAX,
  PARITY_THROW_MIN,
  type BetrayalChoice,
  type ParityCall,
  type RaidErrorCode,
  type RaidMemberView,
  type RaidOutcome,
  type RaidTargetView,
  type WealthBand,
} from './raid.js';
import type { RebirthCause } from './rebirth.js';
import type { CharacterStats } from './stats.js';
import type { CharacterDto } from './types.js';
import type {
  BettingAction,
  LegalActionsView,
  PotPayout,
  SeatView,
  ShowdownReveal,
  Street,
  TableStanding,
  TournamentSummary,
} from './tournament.js';
import { BETTING_ACTIONS } from './tournament.js';

export const WS_PATH = '/ws';

/** Sockets that have not authenticated by this deadline are closed. */
export const WS_AUTH_TIMEOUT_MS = 5_000;

export const WS_ERROR_CODES = [
  'UNAUTHENTICATED',
  'BAD_MESSAGE',
  'NOT_SEATED',
  'NO_CHARACTER',
  'NOT_YOUR_TURN',
  'STALE_SEQ',
  'ILLEGAL_ACTION',
  'RATE_LIMITED',
] as const;
export type WsErrorCode = (typeof WS_ERROR_CODES)[number];

/** How many DM channels one socket may hold a live subscription to. */
export const MAX_SUBSCRIBED_CHANNELS = 200;

/* ------------------------------------------------------------------ *
 * Client -> server
 * ------------------------------------------------------------------ */

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().min(1).max(4096) }).strict(),
  z.object({ type: z.literal('ping') }).strict(),
  z
    .object({
      type: z.literal('tourney:act'),
      handId: z.string().uuid(),
      seq: z.number().int().min(0).max(10_000),
      action: z.enum(BETTING_ACTIONS),
      amount: z.number().int().min(0).max(1_000_000).optional(),
    })
    .strict(),
  z.object({ type: z.literal('tourney:resync') }).strict(),
  /**
   * The author is the socket's bound account, never anything in here — a payload cannot
   * name a sender, and `channelId` is checked against real membership before fan-out.
   */
  z
    .object({
      type: z.literal('chat:send'),
      clientMsgId: z.string().min(1).max(64),
      channelId: z.string().uuid(),
      body: z.string().max(MESSAGE_RAW_MAX),
    })
    .strict(),
  z
    .object({
      type: z.literal('chat:subscribe'),
      channelIds: z.array(z.string().uuid()).max(MAX_SUBSCRIBED_CHANNELS),
    })
    .strict(),
  z
    .object({
      type: z.literal('chat:unsubscribe'),
      channelIds: z.array(z.string().uuid()).max(MAX_SUBSCRIBED_CHANNELS),
    })
    .strict(),
  z
    .object({
      type: z.literal('chat:read'),
      channelId: z.string().uuid(),
      lastReadMessageId: z.string().uuid(),
    })
    .strict(),
  z.object({ type: z.literal('duel:invite'), targetCharacterId: z.string().uuid() }).strict(),
  z
    .object({ type: z.literal('duel:respond'), inviteId: z.string().uuid(), accept: z.boolean() })
    .strict(),
  z.object({ type: z.literal('duel:cancel'), inviteId: z.string().uuid() }).strict(),
  z
    .object({
      type: z.literal('duel:throw'),
      duelId: z.string().uuid(),
      round: z.number().int().min(1).max(100),
      replay: z.number().int().min(0).max(100),
      seq: z.number().int().min(0).max(10_000),
      throw: z.enum(DUEL_THROWS),
    })
    .strict(),
  /**
   * `duelId` is optional because a client that reloaded mid-match has no id to name: the
   * server answers with whatever duel the socket's character is actually in.
   */
  z.object({ type: z.literal('duel:resync'), duelId: z.string().uuid().optional() }).strict(),
  z.object({ type: z.literal('raid:create'), targetCharacterId: z.string().uuid() }).strict(),
  z
    .object({ type: z.literal('raid:invite'), raidId: z.string().uuid(), characterId: z.string().uuid() })
    .strict(),
  z.object({ type: z.literal('raid:respond'), raidId: z.string().uuid(), accept: z.boolean() }).strict(),
  /** The initiator fires it; nobody else can, and nobody's coins move before it. */
  z.object({ type: z.literal('raid:lock'), raidId: z.string().uuid() }).strict(),
  z
    .object({
      type: z.literal('raid:betray'),
      raidId: z.string().uuid(),
      seq: z.number().int().min(0).max(10_000),
      choice: z.enum(BETRAYAL_CHOICES),
    })
    .strict(),
  z
    .object({
      type: z.literal('raid:parity'),
      raidId: z.string().uuid(),
      seq: z.number().int().min(0).max(10_000),
      call: z.enum(PARITY_CALLS),
      throw: z.number().int().min(PARITY_THROW_MIN).max(PARITY_THROW_MAX),
    })
    .strict(),
  /**
   * `raidId` is optional for the same reason the duel's is: a client that reloaded has no id
   * to name, and the server answers with whatever raid the socket's character is in.
   */
  z.object({ type: z.literal('raid:resync'), raidId: z.string().uuid().optional() }).strict(),
  /**
   * Sent when the aftermath card has actually been shown. The report is the only notice a
   * bankrupted, offline target ever gets, so the server keeps offering it until this lands
   * rather than retiring it on a send that a dropped socket may have swallowed.
   */
  z.object({ type: z.literal('raid:aftermath_ack'), raidId: z.string().uuid() }).strict(),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

/* ------------------------------------------------------------------ *
 * Server -> client
 * ------------------------------------------------------------------ */

export interface BlindsView {
  small: number;
  big: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
}

export type ServerMessage =
  | { type: 'ready'; accountId: string; characterId: string | null }
  | { type: 'error'; code: WsErrorCode; message: string }
  | { type: 'character:update'; character: CharacterDto }
  | {
      type: 'character:rebirth';
      character: CharacterDto;
      statsBefore: CharacterStats;
      coinsBefore: number;
      rebirthIndex: number;
      /** What killed them — the rebirth card names the cause before it names the reset. */
      cause: RebirthCause;
    }
  | { type: 'tourney:announce'; tournament: TournamentSummary }
  | { type: 'tourney:entered'; tournamentId: string; hpConverted: number; stack: number }
  | { type: 'tourney:entry_failed'; tournamentId: string; code: 'REBORN' | 'CANCELLED' }
  | {
      type: 'tourney:seated';
      tournamentId: string;
      tableId: string;
      round: number;
      totalRounds: number;
      seatIndex: number;
      seats: SeatView[];
      handsPerTable: number;
    }
  | { type: 'tourney:bye'; tournamentId: string; round: number }
  | {
      type: 'tourney:hand_start';
      tableId: string;
      handId: string;
      handNumber: number;
      buttonSeat: number;
      blinds: BlindsView;
      potCoins: number;
      stacks: number[];
      suddenDeath: boolean;
    }
  /** Unicast to the seat that owns these cards. The only message carrying hole cards. */
  | { type: 'tourney:private'; handId: string; seatIndex: number; holeCards: Card[]; bestHand: string }
  | {
      type: 'tourney:turn';
      handId: string;
      seq: number;
      seatIndex: number;
      deadlineAt: string;
      legal: LegalActionsView;
    }
  | {
      type: 'tourney:action';
      handId: string;
      seq: number;
      seatIndex: number;
      action: BettingAction | 'timeout_fold' | 'timeout_check';
      amount: number;
      potCoins: number;
      stacks: number[];
      committed: number[];
      folded: boolean[];
      allIn: boolean[];
    }
  | { type: 'tourney:board'; handId: string; street: Street; cards: Card[]; potCoins: number }
  | {
      type: 'tourney:showdown';
      handId: string;
      reveals: ShowdownReveal[];
      payouts: PotPayout[];
      stacks: number[];
      summary: string;
    }
  | {
      type: 'tourney:table_result';
      tableId: string;
      qualifierCharacterId: string | null;
      standings: TableStanding[];
    }
  | { type: 'tourney:seat_state'; tableId: string; seats: SeatView[] }
  | { type: 'tourney:round_start'; tournamentId: string; round: number; totalRounds: number; remaining: number }
  | { type: 'tourney:eliminated'; tournamentId: string; round: number; coinsReturned: number }
  | {
      type: 'tourney:winner';
      tournamentId: string;
      characterId: string;
      nickname: string;
      prizeCoins: number;
      stackCoins: number;
    }
  | { type: 'tourney:cancelled'; tournamentId: string; reason: 'NOT_ENOUGH_ENTRANTS' | 'SERVER_RESTART' }
  | { type: 'tourney:rejected'; code: WsErrorCode; seq: number | null; message: string }
  /**
   * Only ever sent to a socket whose account the server has just resolved as a member of
   * `channelId` (or to every player, for the one channel whose membership is everyone).
   */
  | { type: 'chat:message'; channelId: string; message: ChatMessageDto }
  | { type: 'chat:ack'; clientMsgId: string; messageId: string }
  | { type: 'chat:rejected'; clientMsgId: string; code: ChatRejectCode; retryAfterMs?: number }
  | { type: 'chat:channel'; channel: ChatChannelDto }
  | { type: 'chat:unread'; channelId: string; unreadCount: number }
  /** Unicast to the challenged character. */
  | {
      type: 'duel:invited';
      inviteId: string;
      from: DuelPlayerView;
      expiresAt: string;
      stakeCoins: number;
    }
  | {
      type: 'duel:invite_state';
      inviteId: string;
      state: DuelInviteState;
      /**
       * Only on a reconnect, and only to the challenger: a client that reloaded has no local
       * record of the challenge it still has out, so the state alone would leave it unable to
       * withdraw or reissue until the invite's own TTL lapsed.
       */
      target?: DuelCardDto;
      expiresAt?: string;
      stakeCoins?: number;
    }
  | {
      type: 'duel:start';
      duelId: string;
      opponent: DuelPlayerView;
      stakeCoins: number;
      winsNeeded: number;
      /** Which half of `challengerWins`/`opponentWins` is yours. */
      youAre: DuelSide;
    }
  | { type: 'duel:round'; duelId: string; round: number; replay: number; seq: number; deadlineAt: string }
  /** The fact of the lock and nothing else — the throw itself stays server-side until the reveal. */
  | { type: 'duel:opponent_locked'; duelId: string }
  /** Composed per recipient: this is the first frame in which either throw leaves the server. */
  | {
      type: 'duel:round_result';
      duelId: string;
      round: number;
      replay: number;
      seq: number;
      yourThrow: DuelThrow;
      opponentThrow: DuelThrow;
      winner: 'you' | 'opponent' | 'draw';
      tiebreak: boolean;
      challengerWins: number;
      opponentWins: number;
    }
  | {
      type: 'duel:end';
      duelId: string;
      outcome: DuelOutcome;
      winnerCharacterId: string | null;
      loserCharacterId: string | null;
      coinsTransferred: number;
      rebirth: { characterId: string; rebirthIndex: number } | null;
    }
  | { type: 'duel:error'; code: DuelErrorCode; message: string }
  /** Unicast to an invited raider. The target is described by band, never by balance. */
  | {
      type: 'raid:invited';
      raidId: string;
      from: RaidMemberView;
      target: RaidTargetView;
      expiresAt: string;
    }
  | {
      type: 'raid:party';
      raidId: string;
      target: RaidTargetView;
      members: RaidMemberView[];
      /** The party's own pot, banded like everything else on a raid surface. */
      raidPotBand: WealthBand;
      initiatorCharacterId: string;
      state: 'assembling' | 'resolving';
      expiresAt: string | null;
    }
  | { type: 'raid:cancelled'; raidId: string; reason: 'EXPIRED' | 'PARTY_TOO_SMALL' | 'SERVER_RESTART' }
  /**
   * The first frame in which either total is a number rather than a band, and it is only
   * ever sent once the comparison is committed.
   */
  | {
      type: 'raid:result';
      raidId: string;
      outcome: RaidOutcome;
      raidPot: number;
      targetPot: number;
      /** What the betrayal phase is played for; 0 on a target win or a void. */
      potCoins: number;
    }
  | { type: 'raid:betrayal_window'; raidId: string; seq: number; deadlineAt: string; potCoins: number }
  /**
   * The fact of a lock and nothing else — the choice stays server-side until the reveal.
   * Both hidden-commit windows send it, so it names the one it belongs to: a lock landing
   * either side of a reveal beat would otherwise be attributed to whichever window the
   * client happened to have open.
   */
  | {
      type: 'raid:betrayal_locked';
      raidId: string;
      characterId: string;
      phase: 'betrayal' | 'parity';
      seq: number;
    }
  | {
      type: 'raid:betrayal_result';
      raidId: string;
      seq: number;
      choices: { characterId: string; choice: BetrayalChoice }[];
      awards: { characterId: string; coins: number }[];
      potDestroyed: boolean;
      remainder: number;
    }
  | {
      type: 'raid:parity_round';
      raidId: string;
      seq: number;
      round: number;
      deadlineAt: string;
      remainder: number;
      contenders: string[];
    }
  | {
      type: 'raid:parity_result';
      raidId: string;
      seq: number;
      round: number;
      calls: { characterId: string; call: ParityCall; throw: number }[];
      parity: ParityCall;
      winners: string[];
      awards: { characterId: string; coins: number }[];
      /** Set when the round cap decided it instead of the calls. */
      seededSplit: boolean;
    }
  | {
      type: 'raid:end';
      raidId: string;
      outcome: RaidOutcome;
      coinsReceived: number;
      bankrupted: string[];
      potDestroyed: boolean;
    }
  /** For the target, who was never there. Delivered on next connect if they were offline. */
  | {
      type: 'raid:aftermath';
      raidId: string;
      raiders: { characterId: string; nickname: string; speciesId: string }[];
      outcome: RaidOutcome;
      raidPot: number;
      targetPot: number;
      /** Negative when the target won and inherited the raiders' escrow. */
      coinsLost: number;
      nowBeggar: boolean;
      at: string;
    }
  | { type: 'raid:error'; code: RaidErrorCode; message: string };

export type ServerMessageType = ServerMessage['type'];
