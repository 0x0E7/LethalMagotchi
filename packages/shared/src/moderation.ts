const SUBSTRING_BLOCKED = ['nigger', 'nigga', 'faggot', 'kike', 'chink', 'tranny'];
const WORD_BLOCKED = ['retard', 'retards', 'spic', 'rape', 'rapist', 'childporn'];

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

export function containsBlockedTerm(value: string): boolean {
  const collapsed = fold(value);
  if (SUBSTRING_BLOCKED.some((term) => collapsed.includes(term))) return true;
  const words = value.split(/[^\p{L}\p{N}]+/u).map(fold);
  return words.some((word) => WORD_BLOCKED.includes(word));
}
