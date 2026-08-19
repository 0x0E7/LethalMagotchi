import type { CharacterCreateInput } from '@lethalmagotchi/shared';

const STORAGE_KEY = 'lm.character-draft.v1';

export type Draft = Partial<CharacterCreateInput>;

export function loadDraft(): Draft {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Draft) : {};
  } catch {
    return {};
  }
}

export function saveDraft(draft: Draft): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Storage can be unavailable (private mode / quota); the draft is a convenience, not a requirement.
  }
}

export function clearDraft(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // See saveDraft.
  }
}
