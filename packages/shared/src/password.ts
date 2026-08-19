export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

const COMMON_PASSWORDS = new Set([
  '123456789',
  '1234567890',
  '12345678901',
  '123456789012',
  'password',
  'password1',
  'password12',
  'password123',
  'password1234',
  'passw0rd123',
  'qwertyuiop',
  'qwerty12345',
  'qwerty123456',
  '1q2w3e4r5t',
  'iloveyou123',
  'letmein123',
  'welcome123',
  'admin12345',
  'administrator',
  'monkey12345',
  'football123',
  'baseball123',
  'sunshine123',
  'princess123',
  'trustno1234',
  'dragon12345',
  'superman123',
  'batman12345',
  'starwars123',
  'whatever123',
  'abc123456789',
  'zaq12wsxcde3',
  'asdfghjkl123',
  'qazwsxedcrfv',
  '0987654321',
  '1111111111',
  '0000000000',
  'aaaaaaaaaa',
  'lethalmagotchi',
  'tamagotchi',
  'changeme123',
  'secret12345',
  'test1234567',
  'pokemon123',
  'minecraft123',
]);

export type PasswordProblem = 'length' | 'common' | 'contains_username';

export function checkPassword(password: string, username?: string): PasswordProblem | null {
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) return 'length';
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return 'common';
  const normalizedUsername = username?.trim().toLowerCase();
  if (normalizedUsername && normalizedUsername.length >= 3 && password.toLowerCase().includes(normalizedUsername)) {
    return 'contains_username';
  }
  return null;
}

export const PASSWORD_PROBLEM_MESSAGES: Record<PasswordProblem, string> = {
  length: `Password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters.`,
  common: 'That password is too common — pick something less guessable.',
  contains_username: 'Password cannot contain your username.',
};

export type PasswordStrength = 0 | 1 | 2 | 3 | 4;

export const PASSWORD_STRENGTH_LABELS: Record<PasswordStrength, string> = {
  0: 'Too short',
  1: 'Weak',
  2: 'Okay',
  3: 'Strong enough',
  4: 'Very strong',
};

export function passwordStrength(password: string): PasswordStrength {
  if (password.length < PASSWORD_MIN) return 0;
  let score = 1;
  if (password.length >= 14) score += 1;
  if (password.length >= 20) score += 1;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(password)).length;
  if (classes >= 3) score += 1;
  if (COMMON_PASSWORDS.has(password.toLowerCase())) score = 1;
  return Math.min(score, 4) as PasswordStrength;
}
