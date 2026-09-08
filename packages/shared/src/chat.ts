import { z } from 'zod';
import { sanitizeName } from './text.js';

export const MESSAGE_MAX = 500;
/** What the wire accepts before sanitizing; anything longer is a malformed frame. */
export const MESSAGE_RAW_MAX = 4_000;
export const HISTORY_PAGE_MAX = 50;

export const TOWN_SQUARE_KEY = 'global';
export const TOWN_SQUARE_NAME = 'Town Square';

/**
 * The Town Square is a singleton created by the migration, so its id is a constant rather
 * than something every caller has to look up. Nothing else in chat has a fixed id.
 */
export const TOWN_SQUARE_CHANNEL_ID = '00000000-0000-7000-8000-000000000001';

export type ChannelKind = 'global' | 'dm';
export type MessageModeration = 'clean' | 'flagged';

/**
 * Sorted so the two participants of a DM always derive the same key from either side —
 * with a unique index on it, that is what makes `POST /chat/dm` idempotent under
 * concurrency rather than merely usually-idempotent.
 */
export function dmChannelKey(accountA: string, accountB: string): string {
  const [low, high] = accountA < accountB ? [accountA, accountB] : [accountB, accountA];
  return `dm:${low}:${high}`;
}

/**
 * Chat bodies are single-line plain text with the same NFKC / control-character / collapsed
 * whitespace treatment character nicknames already get, so there is one sanitizer in the
 * product rather than two that can drift apart.
 */
export const sanitizeMessageBody = sanitizeName;

/** No `i`, `l` or `o`: a tag is read off a screen and compared by eye. */
const TAG_ALPHABET = '0123456789abcdefghjkmnpqrstuvwxyz';

export interface AuthorBadge {
  tag: string;
  hue: number;
}

/**
 * A short, stable marker derived from the author's account id and shown next to their
 * nickname in chat. Nicknames are not unique, so two players can wear the same one and a
 * reader cannot otherwise tell them apart — or tell which of them they blocked.
 *
 * Deliberately a *mitigation*, not an identity: it never has to be collision-free, only
 * consistent, and it touches nothing about how characters are named.
 */
export function authorBadge(accountId: string): AuthorBadge {
  let hash = 0x811c_9dc5;
  for (let index = 0; index < accountId.length; index += 1) {
    hash ^= accountId.charCodeAt(index);
    hash = Math.imul(hash, 0x0100_0193) >>> 0;
  }

  let remaining = hash;
  let tag = '';
  for (let position = 0; position < 4; position += 1) {
    tag += TAG_ALPHABET.charAt(remaining % TAG_ALPHABET.length);
    remaining = Math.floor(remaining / TAG_ALPHABET.length);
  }
  return { tag, hue: hash % 360 };
}

export interface ChatCounterpart {
  accountId: string;
  characterId: string | null;
  nickname: string;
}

export interface ChatChannelDto {
  id: string;
  kind: ChannelKind;
  name: string | null;
  createdAt: string;
  archivedAt: string | null;
  /** The other participant of a DM. Null for the Town Square. */
  counterpart: ChatCounterpart | null;
  blockedByMe: boolean;
  unreadCount: number;
  lastMessageAt: string | null;
}

export interface ChatMessageDto {
  id: string;
  channelId: string;
  authorAccountId: string | null;
  authorCharacterId: string | null;
  /** The author's nickname at send time, so a later rename never rewrites history. */
  authorName: string;
  body: string;
  createdAt: string;
  moderation: MessageModeration;
}

export interface ChatChannelsResponse {
  channels: ChatChannelDto[];
}

export interface ChatChannelResponse {
  channel: ChatChannelDto;
}

export interface ChatMessagesResponse {
  messages: ChatMessageDto[];
  hasMore: boolean;
}

export const CHAT_REJECT_CODES = [
  'BLOCKED_CONTENT',
  'RATE_LIMITED',
  'NOT_MEMBER',
  'TOO_LONG',
  'EMPTY',
  'DUPLICATE',
  'BLOCKED_BY_RECIPIENT',
  'ARCHIVED',
] as const;
export type ChatRejectCode = (typeof CHAT_REJECT_CODES)[number];

export const dmCreateSchema = z.object({ targetAccountId: z.string().uuid() }).strict();
export const blockCreateSchema = z.object({ blockedAccountId: z.string().uuid() }).strict();

export const messageHistoryQuerySchema = z
  .object({
    before: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(HISTORY_PAGE_MAX).default(HISTORY_PAGE_MAX),
  })
  .strict();

export type DmCreateInput = z.input<typeof dmCreateSchema>;
export type BlockCreateInput = z.input<typeof blockCreateSchema>;
export type MessageHistoryQuery = z.output<typeof messageHistoryQuerySchema>;
