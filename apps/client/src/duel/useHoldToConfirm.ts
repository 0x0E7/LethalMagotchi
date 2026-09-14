import { useCallback, useEffect, useRef, useState } from 'react';

const HOLD_MS = 1_200;
const HOLD_TICK_MS = 40;

/**
 * One deliberate physical gesture instead of a stack of "are you sure?" modals. The
 * keyboard path is the same gesture — hold Enter or Space — so it is not a second, cheaper
 * way to agree to the same thing.
 *
 * Shared by duels and raids: nothing lethal is at stake in a raid, but "every coin you own"
 * still deserves a deliberate act rather than a stray tap.
 */
export function useHoldToConfirm(onConfirm: () => void, disabled: boolean) {
  const [progress, setProgress] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAt = useRef(0);
  const fired = useRef(false);

  const stop = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setProgress(0);
  }, []);

  useEffect(() => stop, [stop]);

  const start = useCallback(() => {
    if (disabled || timer.current) return;
    fired.current = false;
    startedAt.current = Date.now();
    timer.current = setInterval(() => {
      const held = Math.min(1, (Date.now() - startedAt.current) / HOLD_MS);
      setProgress(held);
      if (held < 1 || fired.current) return;
      fired.current = true;
      stop();
      onConfirm();
    }, HOLD_TICK_MS);
  }, [disabled, onConfirm, stop]);

  return {
    progress,
    handlers: {
      onPointerDown: start,
      onPointerUp: stop,
      onPointerLeave: stop,
      onKeyDown: (event: React.KeyboardEvent) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        start();
      },
      onKeyUp: (event: React.KeyboardEvent) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        stop();
      },
      onBlur: stop,
    },
  };
}
