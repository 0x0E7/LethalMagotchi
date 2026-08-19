import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDraft, loadDraft, saveDraft } from '../../src/routes/create/draft.js';

const STORAGE_KEY = 'lm.character-draft.v1';

/**
 * Minimal Storage stand-in. Character-creation draft persistence is the only
 * browser API this module touches, so a hand-rolled fake keeps these tests in the
 * fast node project instead of pulling in a DOM environment.
 */
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => map.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      map.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      map.delete(key);
    }),
    raw: map,
  };
}

function installStorage(storage: unknown): void {
  (globalThis as { window?: unknown }).window = { localStorage: storage };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('loadDraft', () => {
  it('returns an empty draft when nothing has been saved', () => {
    installStorage(fakeStorage());
    expect(loadDraft()).toEqual({});
  });

  it('restores a previously saved partial draft', () => {
    installStorage(fakeStorage({ [STORAGE_KEY]: JSON.stringify({ speciesId: 'otter', nickname: 'Bubbles' }) }));
    expect(loadDraft()).toEqual({ speciesId: 'otter', nickname: 'Bubbles' });
  });

  it('swallows a corrupt JSON blob instead of crashing character creation', () => {
    installStorage(fakeStorage({ [STORAGE_KEY]: '{"speciesId":"otter",' }));
    expect(loadDraft()).toEqual({});
  });

  it('swallows a non-JSON blob', () => {
    installStorage(fakeStorage({ [STORAGE_KEY]: 'not json at all' }));
    expect(loadDraft()).toEqual({});
  });

  it('returns an empty draft when the stored value is an empty string', () => {
    installStorage(fakeStorage({ [STORAGE_KEY]: '' }));
    expect(loadDraft()).toEqual({});
  });

  it('survives storage being unavailable entirely (private browsing)', () => {
    installStorage({
      getItem: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    expect(loadDraft()).toEqual({});
  });
});

describe('saveDraft', () => {
  it('round-trips a draft through storage', () => {
    installStorage(fakeStorage());
    saveDraft({ speciesId: 'fox', nickname: 'Rusty' });
    expect(loadDraft()).toEqual({ speciesId: 'fox', nickname: 'Rusty' });
  });

  it('does not throw when the quota is exceeded — the draft is a convenience', () => {
    installStorage({
      setItem: () => {
        throw new DOMException('Quota exceeded.', 'QuotaExceededError');
      },
    });
    expect(() => saveDraft({ nickname: 'Rusty' })).not.toThrow();
  });
});

describe('clearDraft', () => {
  it('removes a saved draft so a new character does not inherit it', () => {
    const storage = fakeStorage();
    installStorage(storage);
    saveDraft({ nickname: 'Rusty' });

    clearDraft();

    expect(storage.raw.has(STORAGE_KEY)).toBe(false);
    expect(loadDraft()).toEqual({});
  });

  it('does not throw when storage is unavailable', () => {
    installStorage({
      removeItem: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    expect(() => clearDraft()).not.toThrow();
  });
});

describe('draft key', () => {
  beforeEach(() => installStorage(fakeStorage()));

  it('is versioned so a schema change cannot resurrect an incompatible draft', () => {
    expect(STORAGE_KEY).toMatch(/\.v\d+$/);
  });
});
