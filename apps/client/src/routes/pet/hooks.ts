import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  roundStats,
  simulateCharacter,
  type CharacterDto,
  type CharacterStats,
} from '@lethalmagotchi/shared';

/** Re-renders on an interval so cooldown rings and live decay stay current. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * Offline decay the player can watch happen, derived with the same `simulate()` the
 * server commits with — so the bars never disagree with the next authoritative read.
 */
export function useLiveStats(character: CharacterDto, now: number): CharacterStats {
  return useMemo(
    () =>
      roundStats(
        simulateCharacter({
          stats: character.stats,
          speciesId: character.speciesId,
          personalityId: character.personalityId,
          lastSimulatedAt: character.lastSimulatedAt,
          now,
        }),
      ),
    [character, now],
  );
}

const ANNOUNCE_THROTTLE_MS = 1500;
const ZERO_WIDTH_SPACE = '​';

interface DistinctAnnouncementState {
  lastText: string;
  repeated: boolean;
}

/**
 * A screen reader announces on a DOM text mutation, not on `announce()` being
 * called. If the exact same string is requested twice in a row, `message`
 * state never changes, so React bails on re-rendering and the second
 * announcement is silently dropped. A trailing zero-width space, toggled
 * each time the text repeats, forces a real mutation without changing what's
 * read aloud. Pulled out as a pure, ref-free function so the toggling logic
 * — including that it keeps alternating on a *third* identical announcement,
 * not just the second — can be unit-tested without rendering the hook.
 */
export function distinctAnnouncement(text: string, state: DistinctAnnouncementState): string {
  if (text !== state.lastText) {
    state.lastText = text;
    state.repeated = false;
    return text;
  }
  state.repeated = !state.repeated;
  return state.repeated ? `${text}${ZERO_WIDTH_SPACE}` : text;
}

export interface Announcer {
  message: string;
  announce: (text: string) => void;
}

/**
 * One polite region for the whole HUD, throttled so a burst of threshold crossings
 * can't flood a screen reader. The latest message always wins.
 */
export function useAnnouncer(): Announcer {
  const [message, setMessage] = useState('');
  const lastAt = useRef(0);
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const distinctState = useRef<DistinctAnnouncementState>({ lastText: '', repeated: false });

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const announce = useCallback((text: string) => {
    const now = Date.now();
    const wait = ANNOUNCE_THROTTLE_MS - (now - lastAt.current);
    if (wait <= 0) {
      lastAt.current = now;
      setMessage(distinctAnnouncement(text, distinctState.current));
      return;
    }
    pending.current = text;
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      lastAt.current = Date.now();
      if (pending.current !== null) setMessage(distinctAnnouncement(pending.current, distinctState.current));
      pending.current = null;
    }, wait);
  }, []);

  return { message, announce };
}
