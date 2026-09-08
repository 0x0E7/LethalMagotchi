import { z } from 'zod';
import type { Card } from './cards.js';
import { MESSAGE_RAW_MAX, type ChatChannelDto, type ChatMessageDto, type ChatRejectCode } from './chat.js';
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
  | { type: 'chat:unread'; channelId: string; unreadCount: number };

export type ServerMessageType = ServerMessage['type'];
