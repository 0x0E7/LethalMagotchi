export const NICKNAME_MIN = 2;
export const NICKNAME_MAX = 24;
export const BIO_MAX = 280;
export const BIO_MAX_NEWLINES = 4;
export const CITY_MAX = 64;

const CONTROL_CHARS = /[\p{Cc}\p{Cf}]/gu;
// `\n` is itself a \p{Cc} control character, so the bio sanitizer must exempt it
// explicitly — otherwise every line break is stripped and the "at most N line
// breaks" rule below can never fire.
const CONTROL_CHARS_EXCEPT_NEWLINE = /(?!\n)[\p{Cc}\p{Cf}]/gu;
const NAME_ALLOWED = /^[\p{L}\p{N} '-]+$/u;

export function sanitizeName(raw: string): string {
  return raw
    .normalize('NFKC')
    // Whitespace controls (tab, newline, form feed) become a space so words stay
    // separated; everything else invisible is dropped outright.
    .replace(CONTROL_CHARS, (char) => (/\s/.test(char) ? ' ' : ''))
    .replace(/\s+/g, ' ')
    .trim();
}

export function sanitizeBio(raw: string): string {
  const withoutControls = raw
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(CONTROL_CHARS_EXCEPT_NEWLINE, '')
    .replace(/\n{3,}/g, '\n\n');
  return withoutControls
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

export function isAllowedName(value: string): boolean {
  return NAME_ALLOWED.test(value);
}

export function countNewlines(value: string): number {
  return (value.match(/\n/g) ?? []).length;
}
