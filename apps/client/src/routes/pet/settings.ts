import { useCallback, useEffect, useState } from 'react';

export const ANIMATION_MODES = ['full', 'short', 'off'] as const;

export type AnimationMode = (typeof ANIMATION_MODES)[number];

export const ANIMATION_MODE_LABELS: Record<AnimationMode, string> = {
  full: 'Full',
  short: 'Short',
  off: 'Off',
};

const STORAGE_KEY = 'lm.settings.animations.v1';

function isAnimationMode(value: unknown): value is AnimationMode {
  return typeof value === 'string' && (ANIMATION_MODES as readonly string[]).includes(value);
}

export function loadAnimationMode(): AnimationMode {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isAnimationMode(raw) ? raw : 'full';
  } catch {
    return 'full';
  }
}

export function saveAnimationMode(mode: AnimationMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // See seen-clips.ts.
  }
}

export function useAnimationMode(): [AnimationMode, (mode: AnimationMode) => void] {
  const [mode, setMode] = useState<AnimationMode>(loadAnimationMode);
  const update = useCallback((next: AnimationMode) => {
    setMode(next);
    saveAnimationMode(next);
  }, []);
  return [mode, update];
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  );

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
