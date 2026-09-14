import type { CharacterDto } from './types.js';

const DAY_MS = 24 * 60 * 60_000;

/* ------------------------------------------------------------------ *
 * Wealth bands — a security boundary, not a display choice
 * ------------------------------------------------------------------ */

export const WEALTH_BANDS = ['broke', 'comfortable', 'wealthy'] as const;
export type WealthBand = (typeof WEALTH_BANDS)[number];

/**
 * Inclusive floors: `broke` 0-4, `comfortable` 5-24, `wealthy` 25+. A balance knob rather
 * than a design decision — characters start at 5 coins and shop items run 0-6, so these are
 * a starting point to be tuned against real wallet distributions.
 */
export const WEALTH_BAND_FLOORS = { comfortable: 5, wealthy: 25 } as const;

export function wealthBandOf(coins: number): WealthBand {
  if (coins >= WEALTH_BAND_FLOORS.wealthy) return 'wealthy';
  if (coins >= WEALTH_BAND_FLOORS.comfortable) return 'comfortable';
  return 'broke';
}

export const WEALTH_BAND_LABELS: Record<WealthBand, string> = {
  broke: 'Broke',
  comfortable: 'Comfortable',
  wealthy: 'Wealthy',
};

/**
 * A character *is* a beggar exactly while they hold nothing. Derived, never stored: the
 * badge appears at zero and lifts on the first coin, which is what makes a bankruptcy
 * rescuable exactly once — the state that qualifies you for a donation is destroyed by it.
 */
export function isBeggar(coins: number): boolean {
  return coins <= 0;
}

/**
 * The same state, read off a character rather than off a bare number. A raid stakes the
 * whole wallet, so a locked-in raider holds nothing for the length of the raid while their
 * coins sit in escrow; that is not the poverty the donation mechanic exists for. Counting it
 * as poverty would put a beggar badge on every raider in every ordinary raid, and would make
 * the one-rescue property farmable once per raid cycle.
 */
export function isBeggarWallet(coins: number, activeRaidId: string | null): boolean {
  return isBeggar(coins) && activeRaidId === null;
}

/**
 * The wealth floor. Robbing a pet that has nothing is griefing with no economic content,
 * and because a freshly bankrupted character sits at 0 this doubles as the beggar's shield
 * with no separate rule.
 */
export function isRaidableWealth(coins: number): boolean {
  return wealthBandOf(coins) !== 'broke';
}

/* ------------------------------------------------------------------ *
 * Timings and floors
 * ------------------------------------------------------------------ */

export const RAID_MIN_RAIDERS = 2;
export const RAID_MAX_RAIDERS = 3;

export const RAID_INVITE_TTL_MS = 60_000;
/** The initiator has the same 60s to lock in; an assembly nobody fires releases everyone. */
export const RAID_ASSEMBLY_TTL_MS = RAID_INVITE_TTL_MS;

export const RAID_BETRAYAL_MS = 12_000;
export const RAID_PARITY_MS = 10_000;
/** The beat between a reveal and the next window, so a result can actually be read. */
export const RAID_REVEAL_MS = 2_000;

/** Anti-griefing floor: every character a raid touches, raiders and target alike. */
export const RAID_MIN_ACCOUNT_AGE_MS = DAY_MS;
/** Rolling 24h from being raided, win or lose. */
export const RAID_TARGET_IMMUNITY_MS = DAY_MS;
/** Rolling 6h between raids initiated or joined. */
export const RAID_RAIDER_COOLDOWN_MS = 6 * 60 * 60_000;

/** How long settlement waits for a target who is mid-hand or mid-duel before voiding. */
export const RAID_BUSY_DEFER_MS = 10 * 60_000;
export const RAID_BUSY_POLL_MS = 15_000;

/**
 * Parity rounds before a seeded deterministic split ends it. The design's termination
 * argument ("each round divides the remainder or strictly reduces the winner count") holds
 * for every round except a unanimously correct one, which shrinks nothing — so the same
 * escape hatch `DUEL_MAX_REPLAYS` uses is kept here rather than trusting a live loop.
 */
export const RAID_PARITY_MAX_ROUNDS = 5;

export const PARITY_THROW_MIN = 0;
export const PARITY_THROW_MAX = 5;

/** One appeal per 3 hours per character. Only matters when nobody donates. */
export const DONATION_APPEAL_COOLDOWN_MS = 3 * 60 * 60_000;

export function isOldEnoughToRaid(createdAt: string | Date, now: number): boolean {
  const born = createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt);
  return now - born >= RAID_MIN_ACCOUNT_AGE_MS;
}

export function isRaidImmune(immuneUntil: string | Date | null, now: number): boolean {
  if (immuneUntil === null) return false;
  const ends = immuneUntil instanceof Date ? immuneUntil.getTime() : Date.parse(immuneUntil);
  return ends > now;
}

export function raidImmunityUntil(now: number): Date {
  return new Date(now + RAID_TARGET_IMMUNITY_MS);
}

export function isRaiderCooldownActive(lastRaidAt: string | Date | null, now: number): boolean {
  if (lastRaidAt === null) return false;
  const at = lastRaidAt instanceof Date ? lastRaidAt.getTime() : Date.parse(lastRaidAt);
  return now - at < RAID_RAIDER_COOLDOWN_MS;
}

/* ------------------------------------------------------------------ *
 * States, outcomes, errors
 * ------------------------------------------------------------------ */

export const RAID_STATES = [
  'assembling',
  'resolving',
  'betrayal',
  'parity',
  'complete',
  'cancelled',
] as const;
export type RaidState = (typeof RAID_STATES)[number];

export const RAID_OUTCOMES = ['raiders_won', 'target_won', 'void'] as const;
export type RaidOutcome = (typeof RAID_OUTCOMES)[number];

export const RAID_MEMBER_STATES = ['invited', 'joined', 'declined', 'expired'] as const;
export type RaidMemberState = (typeof RAID_MEMBER_STATES)[number];

export const BETRAYAL_CHOICES = ['loyal', 'betray'] as const;
export type BetrayalChoice = (typeof BETRAYAL_CHOICES)[number];

export const PARITY_CALLS = ['odds', 'evens'] as const;
export type ParityCall = (typeof PARITY_CALLS)[number];

export const RAID_ERROR_CODES = [
  'NO_CHARACTER',
  'SELF',
  'NOT_FOUND',
  'TOO_NEW',
  'BUSY',
  'TARGET_IMMUNE',
  'TARGET_TOO_POOR',
  'COOLDOWN',
  'BLOCKED',
  'RATE_LIMITED',
  'EXPIRED',
  'PARTY_FULL',
  'PARTY_TOO_SMALL',
  'NOT_INITIATOR',
  'ALREADY_INVITED',
  'STALE_SEQ',
] as const;
export type RaidErrorCode = (typeof RAID_ERROR_CODES)[number];

export const RAID_ERROR_MESSAGES: Record<RaidErrorCode, string> = {
  NO_CHARACTER: 'You need a character to raid.',
  SELF: 'You cannot raid yourself.',
  NOT_FOUND: 'That raid is no longer around.',
  TOO_NEW: 'Raids open up once a pet is a day old.',
  BUSY: 'You are already committed to something else.',
  TARGET_IMMUNE: 'They were raided recently. Leave them be for a day.',
  TARGET_TOO_POOR: 'They have too little to be worth robbing.',
  COOLDOWN: 'You have raided recently. Try again later.',
  BLOCKED: 'You cannot raid this player.',
  RATE_LIMITED: 'Slow down a moment.',
  EXPIRED: 'That raid has already moved on.',
  PARTY_FULL: 'The party is already full.',
  PARTY_TOO_SMALL: 'A raid needs at least two raiders.',
  NOT_INITIATOR: 'Only whoever started the raid can do that.',
  ALREADY_INVITED: 'They are already in this raid.',
  STALE_SEQ: 'That choice was already locked in.',
};

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */

/** How one raider is described to the others. Never carries an exact wallet. */
export interface RaidMemberView {
  characterId: string;
  accountId: string | null;
  nickname: string;
  speciesId: string;
  state: RaidMemberState;
  isInitiator: boolean;
}

export interface RaidTargetView {
  characterId: string;
  nickname: string;
  speciesId: string;
  band: WealthBand;
}

export interface DonationDto {
  id: string;
  fromCharacterId: string;
  toCharacterId: string;
  coins: number;
  at: string;
}

export interface DonationResponse {
  donation: DonationDto;
  /** The donor's own wallet after the debit; the recipient's is theirs to see. */
  character: CharacterDto;
}

export interface AppealResponse {
  postedAt: string;
}

export function donationAppealBody(nickname: string): string {
  return `${nickname} is begging for coins.`;
}

/* ------------------------------------------------------------------ *
 * Rules — the whole of a raid's arithmetic, as pure functions
 * ------------------------------------------------------------------ */

/**
 * Both stated conditions are strict, so an exact tie fires neither and the raid simply does
 * not happen. Voiding is the only resolution that does not invent a winner the rule never
 * named.
 */
export function resolveRaidOutcome(raidPotCoins: number, targetPotCoins: number): RaidOutcome {
  if (raidPotCoins > targetPotCoins) return 'raiders_won';
  if (targetPotCoins > raidPotCoins) return 'target_won';
  return 'void';
}

export interface BetrayalEntry {
  characterId: string;
  choice: BetrayalChoice;
}

export interface Distribution {
  /** Every raider named in the input, so a zero award is stated rather than implied. */
  awards: Record<string, number>;
  /** Coins that did not divide, played for by `contenders` in the parity game. */
  remainder: number;
  contenders: string[];
  potDestroyed: boolean;
}

/**
 * Betrayal resolves by count, never by order. One betrayer takes everything; two or more but
 * not all hand the pot to whoever stayed loyal; everybody betraying destroys it — the one
 * sanctioned place coins leave the economy without arriving anywhere.
 */
export function resolveBetrayal(entries: BetrayalEntry[], potCoins: number): Distribution {
  const awards: Record<string, number> = {};
  for (const entry of entries) awards[entry.characterId] = 0;

  const betrayers = entries.filter((entry) => entry.choice === 'betray');
  if (entries.length > 0 && betrayers.length === entries.length) {
    return { awards, remainder: 0, contenders: [], potDestroyed: true };
  }

  const winners =
    betrayers.length === 0
      ? entries
      : betrayers.length === 1
        ? betrayers
        : entries.filter((entry) => entry.choice === 'loyal');

  return { ...shareOut(awards, winners.map((entry) => entry.characterId), potCoins), potDestroyed: false };
}

export interface ParityEntry {
  characterId: string;
  call: ParityCall;
  throw: number;
}

export interface ParityResolution {
  parity: ParityCall;
  winners: string[];
  awards: Record<string, number>;
  remainder: number;
  contenders: string[];
  /** True when nobody called it: the same players play the same remainder again. */
  replay: boolean;
}

/**
 * The parity game, one round. Everyone who called the sum's parity correctly is a winner and
 * the remainder splits among them; whatever still does not divide is played for again by the
 * winners alone.
 */
export function resolveParityRound(entries: ParityEntry[], remainderCoins: number): ParityResolution {
  const sum = entries.reduce((total, entry) => total + entry.throw, 0);
  const parity: ParityCall = sum % 2 === 1 ? 'odds' : 'evens';
  const winners = entries.filter((entry) => entry.call === parity).map((entry) => entry.characterId);

  const awards: Record<string, number> = {};
  for (const entry of entries) awards[entry.characterId] = 0;

  if (winners.length === 0) {
    return {
      parity,
      winners,
      awards,
      remainder: remainderCoins,
      contenders: entries.map((entry) => entry.characterId),
      replay: true,
    };
  }

  const shared = shareOut(awards, winners, remainderCoins);
  return { parity, winners, awards: shared.awards, remainder: shared.remainder, contenders: shared.contenders, replay: false };
}

function shareOut(
  awards: Record<string, number>,
  winners: string[],
  coins: number,
): { awards: Record<string, number>; remainder: number; contenders: string[] } {
  if (winners.length === 0) return { awards, remainder: coins, contenders: [] };
  const share = Math.floor(coins / winners.length);
  const remainder = coins - share * winners.length;
  const next = { ...awards };
  for (const winner of winners) next[winner] = (next[winner] ?? 0) + share;
  return { awards: next, remainder, contenders: remainder > 0 ? winners : [] };
}

/** Merges a later round's awards into the running total without losing a zero entry. */
export function mergeAwards(
  base: Record<string, number>,
  addition: Record<string, number>,
): Record<string, number> {
  const merged = { ...base };
  for (const [characterId, coins] of Object.entries(addition)) {
    merged[characterId] = (merged[characterId] ?? 0) + coins;
  }
  return merged;
}
