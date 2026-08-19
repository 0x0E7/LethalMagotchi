export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;

export const RESERVED_USERNAMES = new Set([
  'admin',
  'root',
  'system',
  'mod',
  'support',
  'lethalmagotchi',
]);

const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/;

export function normalizeUsername(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase();
}

export type UsernameProblem =
  | 'length'
  | 'charset'
  | 'edge_underscore'
  | 'reserved';

export function checkUsername(raw: string): UsernameProblem | null {
  const normalized = normalizeUsername(raw);
  if (normalized.length < USERNAME_MIN || normalized.length > USERNAME_MAX) return 'length';
  if (!USERNAME_PATTERN.test(normalized)) return 'charset';
  if (normalized.startsWith('_') || normalized.endsWith('_')) return 'edge_underscore';
  if (RESERVED_USERNAMES.has(normalized)) return 'reserved';
  return null;
}

export const USERNAME_PROBLEM_MESSAGES: Record<UsernameProblem, string> = {
  length: 'Username must be 3-20 characters.',
  charset: 'Use only lowercase letters, numbers and underscores.',
  edge_underscore: 'Username cannot start or end with an underscore.',
  reserved: 'That username is reserved.',
};

export function suggestUsernames(raw: string): string[] {
  const base = normalizeUsername(raw).replace(/^_+|_+$/g, '').slice(0, USERNAME_MAX - 4) || 'player';
  return [`${base}_1`, `${base}_dev`, `${base}${Math.floor(Math.random() * 90 + 10)}`];
}
