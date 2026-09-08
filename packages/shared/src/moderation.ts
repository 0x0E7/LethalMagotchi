const SUBSTRING_BLOCKED = ['nigger', 'nigga', 'faggot', 'kike', 'chink', 'tranny'];
const WORD_BLOCKED = ['retard', 'retards', 'spic', 'rape', 'rapist', 'childporn'];

/**
 * Coarse profanity: enough to mark a message for later review, nowhere near enough to
 * refuse to deliver it. Everything in `SUBSTRING_BLOCKED`/`WORD_BLOCKED` above is the
 * high-confidence tier and is rejected outright instead.
 */
const WORD_BORDERLINE = [
  'fuck',
  'fucking',
  'fucker',
  'shit',
  'bullshit',
  'bitch',
  'bastard',
  'asshole',
  'arsehole',
  'cunt',
  'dick',
  'prick',
  'whore',
  'slut',
  'wanker',
  'twat',
];

const LINKISH = /(https?:\/\/|www\.|\b[a-z0-9-]{2,}\.(com|net|org|io|gg|xyz|ru|tk|link|shop|club)\b)/i;
const CHARACTER_FLOOD = /(.)\1{9,}/u;
const SHOUT_MIN_LENGTH = 20;
const SHOUT_RATIO = 0.7;

const LEET_MAP: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
  '!': 'i',
};

function fold(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{Diacritic}/gu, '')
    .split('')
    .map((ch) => LEET_MAP[ch] ?? ch)
    .join('')
    .replace(/[^a-z]/g, '');
}

function foldedWords(value: string): string[] {
  return value.split(/[^\p{L}\p{N}]+/u).map(fold);
}

export function containsBlockedTerm(value: string): boolean {
  const collapsed = fold(value);
  if (SUBSTRING_BLOCKED.some((term) => collapsed.includes(term))) return true;
  return foldedWords(value).some((word) => WORD_BLOCKED.includes(word));
}

export function containsBorderlineTerm(value: string): boolean {
  return foldedWords(value).some((word) => WORD_BORDERLINE.includes(word));
}

function isShouting(value: string): boolean {
  if (value.length < SHOUT_MIN_LENGTH) return false;
  const letters = value.match(/\p{L}/gu) ?? [];
  if (letters.length < SHOUT_MIN_LENGTH) return false;
  const upper = letters.filter((letter) => letter === letter.toUpperCase() && letter !== letter.toLowerCase());
  return upper.length / letters.length >= SHOUT_RATIO;
}

/** `blocked` is never delivered or persisted; `flagged` is delivered and recorded. */
export type ModerationDisposition = 'clean' | 'flagged' | 'blocked';

export function classifyMessage(body: string): ModerationDisposition {
  if (containsBlockedTerm(body)) return 'blocked';
  if (containsBorderlineTerm(body)) return 'flagged';
  if (LINKISH.test(body)) return 'flagged';
  if (CHARACTER_FLOOD.test(body)) return 'flagged';
  if (isShouting(body)) return 'flagged';
  return 'clean';
}
