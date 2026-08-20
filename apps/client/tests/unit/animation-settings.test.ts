import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTION_ANIMATION_MS } from '@lethalmagotchi/shared';
import { ANIMATION_MODES, loadAnimationMode, saveAnimationMode } from '../../src/routes/pet/settings.js';
import {
  STILL_POSE_MS,
  clipDuration,
  playbackModeFor,
} from '../../src/routes/pet/useActionMachine.js';

const STORAGE_KEY = 'lm.settings.animations.v1';

/** Same hand-rolled Storage stand-in the draft tests use — see draft.test.ts. */
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => map.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      map.set(key, value);
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

describe('loadAnimationMode', () => {
  it('defaults to full animations for a player who never chose', () => {
    installStorage(fakeStorage());
    expect(loadAnimationMode()).toBe('full');
  });

  it('restores each of the offered modes', () => {
    for (const mode of ANIMATION_MODES) {
      installStorage(fakeStorage({ [STORAGE_KEY]: mode }));
      expect(loadAnimationMode()).toBe(mode);
    }
  });

  it('falls back to full on a value that is not a mode', () => {
    installStorage(fakeStorage({ [STORAGE_KEY]: 'cinematic' }));
    expect(loadAnimationMode()).toBe('full');
  });

  it('falls back to full on a corrupt JSON blob left by an older build', () => {
    installStorage(fakeStorage({ [STORAGE_KEY]: '{"mode":"off"' }));
    expect(loadAnimationMode()).toBe('full');
  });

  it('survives storage being unavailable entirely (private browsing)', () => {
    installStorage({
      getItem: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    expect(loadAnimationMode()).toBe('full');
  });
});

describe('saveAnimationMode', () => {
  it('round-trips the chosen mode', () => {
    installStorage(fakeStorage());
    saveAnimationMode('off');
    expect(loadAnimationMode()).toBe('off');
  });

  it('does not throw when the quota is exceeded — the preference is a convenience', () => {
    installStorage({
      setItem: () => {
        throw new DOMException('Quota exceeded.', 'QuotaExceededError');
      },
    });
    expect(() => saveAnimationMode('short')).not.toThrow();
  });
});

describe('playbackModeFor', () => {
  it('plays the full clip when the player asked for full and has no motion preference', () => {
    expect(playbackModeFor('full', false)).toBe('clip');
  });

  it('shows a still pose in short mode', () => {
    // "Short" is deliberately the same still-pose path as reduced motion: the design
    // left it undefined, and half-length clips would need a second set of authored beats.
    expect(playbackModeFor('short', false)).toBe('still');
  });

  it('shows nothing at all in off mode', () => {
    expect(playbackModeFor('off', false)).toBe('none');
  });

  it('downgrades a full clip to a still pose for a reduced-motion player', () => {
    expect(playbackModeFor('full', true)).toBe('still');
  });

  it('lets an explicit "off" win over reduced motion, since off is the stricter ask', () => {
    expect(playbackModeFor('off', true)).toBe('none');
  });
});

describe('clipDuration', () => {
  it('uses the authored per-item duration for a full clip', () => {
    expect(clipDuration('feast', 'clip')).toBe(ACTION_ANIMATION_MS.feast);
    expect(clipDuration('kibble', 'clip')).toBe(ACTION_ANIMATION_MS.kibble);
  });

  it('holds every still pose for the same short beat, whatever the item', () => {
    expect(clipDuration('feast', 'still')).toBe(STILL_POSE_MS);
    expect(clipDuration('kibble', 'still')).toBe(STILL_POSE_MS);
  });

  it('takes no time at all when animations are off, so the dock frees up immediately', () => {
    expect(clipDuration('night_out', 'none')).toBe(0);
  });

  it('keeps the still pose well under the shortest real clip', () => {
    expect(STILL_POSE_MS).toBeLessThan(Math.min(...Object.values(ACTION_ANIMATION_MS)));
  });
});
