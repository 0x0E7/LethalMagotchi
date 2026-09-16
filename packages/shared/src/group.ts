import { z } from 'zod';
import { isAllowedName, sanitizeName } from './text.js';
import { normalizeUsername } from './username.js';

const DAY_MS = 24 * 60 * 60_000;

/**
 * A tunable ceiling like the raid wealth bands, not a design decision: it exists so a
 * "group" stays a group, and it is expected to move once there is population data.
 */
export const GROUP_MAX_MEMBERS = 30;

export const GROUP_NAME_MIN = 3;
export const GROUP_NAME_MAX = 24;

/** Long enough that an invite survives a week away from the game. */
export const GROUP_INVITE_TTL_MS = 7 * DAY_MS;

/**
 * How long a kicked player is un-invitable *by the group that kicked them*.
 *
 * The one time gate groups still have. The account-age floor and the post-leave create
 * cooldown were both removed — founding and joining are immediate — but this one is not
 * about pacing a player, it is what stops a group kicking someone and pulling them
 * straight back as a way to lean on them.
 */
export const GROUP_KICK_COOLDOWN_MS = DAY_MS;

export const GROUP_INVITE_STATES = ['pending', 'accepted', 'declined', 'expired', 'cancelled'] as const;
export type GroupInviteState = (typeof GROUP_INVITE_STATES)[number];

export type GroupRole = 'leader' | 'member';

/**
 * The same NFKC-fold-and-lowercase convention usernames and nicknames already use, composed
 * out of the two shipped helpers rather than restated: `sanitizeName` collapses the
 * whitespace and strips the invisibles, `normalizeUsername` folds and lowercases.
 */
export function normalizeGroupName(raw: string): string {
  return normalizeUsername(sanitizeName(raw));
}

/**
 * Sorted-pair keys make DM creation idempotent under concurrency; a group's own id does the
 * same job here, so `ux_chat_channels_key` is what stops a second channel for one group.
 */
export function groupChannelKey(groupId: string): string {
  return `group:${groupId}`;
}

/** True while the group that removed this player still cannot invite them back. */
export function isKickCooldownActive(removedAt: string | Date | null, now: number): boolean {
  if (removedAt === null) return false;
  const at = removedAt instanceof Date ? removedAt.getTime() : Date.parse(removedAt);
  return now - at < GROUP_KICK_COOLDOWN_MS;
}

export function cooldownEndsAt(at: string | Date, windowMs: number): Date {
  const from = at instanceof Date ? at.getTime() : Date.parse(at);
  return new Date(from + windowMs);
}

/**
 * A roster entry. Membership is account-scoped so it survives the delete-and-recreate
 * species change, but the face of it is still the character — which may be absent for a
 * player who is between pets.
 */
export interface GroupMemberDto {
  accountId: string;
  characterId: string | null;
  nickname: string | null;
  role: GroupRole;
  joinedAt: string;
}

/** The public face of a group: who it is and who is in it. Visible to anyone. */
export interface GroupDto {
  id: string;
  name: string;
  /**
   * Null only in the instant between a leader's account disappearing — which sets this to
   * NULL rather than taking the group with it — and the next read promoting the
   * longest-standing member into it.
   */
  leaderAccountId: string | null;
  createdAt: string;
  memberCount: number;
  members: GroupMemberDto[];
}

/** The member's own view, which additionally carries the channel they can talk in. */
export interface MyGroupDto extends GroupDto {
  channelId: string;
  role: GroupRole;
}

export interface GroupInviteDto {
  id: string;
  groupId: string;
  groupName: string;
  fromAccountId: string;
  fromNickname: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface GroupResponse {
  group: GroupDto;
}

export interface MyGroupResponse {
  group: MyGroupDto | null;
  invites: GroupInviteDto[];
}

const groupNameSchema = z
  .string()
  .max(200)
  .transform(sanitizeName)
  .superRefine((value, ctx) => {
    if (value.length < GROUP_NAME_MIN || value.length > GROUP_NAME_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Group name must be ${GROUP_NAME_MIN}-${GROUP_NAME_MAX} characters.`,
      });
      return;
    }
    if (!isAllowedName(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Group name can use letters, numbers, spaces, ' and - only.",
      });
    }
  });

export const groupCreateSchema = z.object({ name: groupNameSchema }).strict();
export const groupInviteSchema = z.object({ toAccountId: z.string().uuid() }).strict();
export const groupInviteRespondSchema = z.object({ accept: z.boolean() }).strict();

export type GroupCreateInput = z.input<typeof groupCreateSchema>;
export type GroupCreate = z.output<typeof groupCreateSchema>;
export type GroupInviteInput = z.input<typeof groupInviteSchema>;
export type GroupInviteRespondInput = z.input<typeof groupInviteRespondSchema>;
