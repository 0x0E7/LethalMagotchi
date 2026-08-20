import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasSeenClip, markClipSeen } from '../../src/routes/pet/seen-clips.js';

const STORAGE_KEY = 'lm.seen-clips.v1';
const OTTER = '018f4a2c-0000-7000-8000-000000000001';
const CROW = '018f4a2c-0000-7000-8000-000000000002';

/** Same hand-rolled Storage stand-in the draft tests use — see draft.test.ts. */
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

describe('hasSeenClip', () => {
  it('reports an unseen clip for a brand-new player', () => {
    installStorage(fakeStorage());
    expect(hasSeenClip(OTTER, 'kibble')).toBe(false);
  });

  it('reports a clip the character has already watched', () => {
    installStorage(fakeStorage({ [STORAGE_KEY]: JSON.stringify({ [OTTER]: ['kibble'] }) }));
    expect(hasSeenClip(OTTER, 'kibble')).toBe(true);
  });

  it('keeps the record per character, so a new pet plays every clip in full again', () => {
    installStorage(fakeStorage({ [STORAGE_KEY]: JSON.stringify({ [OTTER]: ['kibble'] }) }));
    expect(hasSeenClip(CROW, 'kibble')).toBe(false);
  });

  it('does not confuse one clip for another under the same character', () => {
    installStorage(fakeStorage({ [STORAGE_KEY]: JSON.stringify({ [OTTER]: ['kibble'] }) }));
    expect(hasSeenClip(OTTER, 'feast')).toBe(false);
  });

  it('falls back to "unseen" on a corrupt JSON blob', () => {
    installStorage(fakeStorage({ [STORAGE_KEY]: '{"018f":["kibble"' }));
    expect(hasSeenClip(OTTER, 'kibble')).toBe(false);
  });

  it('falls back to "unseen" when the blob is the wrong shape entirely', () => {
    installStorage(fakeStorage({ [STORAGE_KEY]: JSON.stringify(['kibble', 'feast']) }));
    expect(hasSeenClip(OTTER, 'kibble')).toBe(false);
  });

  it('ignores a non-array entry for one character without losing the others', () => {
    installStorage(
      fakeStorage({ [STORAGE_KEY]: JSON.stringify({ [OTTER]: 'kibble', [CROW]: ['feast'] }) }),
    );
    expect(hasSeenClip(OTTER, 'kibble')).toBe(false);
    expect(hasSeenClip(CROW, 'feast')).toBe(true);
  });

  it('ignores non-string entries inside an otherwise valid list', () => {
    installStorage(fakeStorage({ [STORAGE_KEY]: JSON.stringify({ [OTTER]: [7, null, 'feast'] }) }));
    expect(hasSeenClip(OTTER, 'feast')).toBe(true);
  });

  it('survives storage being unavailable entirely (private browsing)', () => {
    installStorage({
      getItem: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    expect(hasSeenClip(OTTER, 'kibble')).toBe(false);
  });
});

describe('markClipSeen', () => {
  it('records a clip so the skip affordance appears on the second view', () => {
    installStorage(fakeStorage());
    markClipSeen(OTTER, 'kibble');
    expect(hasSeenClip(OTTER, 'kibble')).toBe(true);
  });

  it('keeps earlier clips when a new one is recorded', () => {
    installStorage(fakeStorage());
    markClipSeen(OTTER, 'kibble');
    markClipSeen(OTTER, 'shower');
    expect(hasSeenClip(OTTER, 'kibble')).toBe(true);
    expect(hasSeenClip(OTTER, 'shower')).toBe(true);
  });

  it('does not duplicate an already-recorded clip', () => {
    const storage = fakeStorage();
    installStorage(storage);
    markClipSeen(OTTER, 'kibble');
    markClipSeen(OTTER, 'kibble');
    expect(JSON.parse(storage.raw.get(STORAGE_KEY) as string)[OTTER]).toEqual(['kibble']);
  });

  it('keeps other characters’ records intact', () => {
    const storage = fakeStorage({ [STORAGE_KEY]: JSON.stringify({ [CROW]: ['feast'] }) });
    installStorage(storage);
    markClipSeen(OTTER, 'kibble');
    expect(hasSeenClip(CROW, 'feast')).toBe(true);
  });

  it('overwrites a corrupt blob with a valid one instead of failing forever', () => {
    const storage = fakeStorage({ [STORAGE_KEY]: 'not json at all' });
    installStorage(storage);
    markClipSeen(OTTER, 'kibble');
    expect(hasSeenClip(OTTER, 'kibble')).toBe(true);
  });

  it('does not throw when the quota is exceeded — re-seeing a clip is harmless', () => {
    installStorage({
      getItem: () => null,
      setItem: () => {
        throw new DOMException('Quota exceeded.', 'QuotaExceededError');
      },
    });
    expect(() => markClipSeen(OTTER, 'kibble')).not.toThrow();
  });
});
