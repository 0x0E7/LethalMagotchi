import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ACTION_ANIMATION_MS,
  clipIdFor,
  type ActionId,
  type ActionResponse,
  type ClipId,
  type ShopItemId,
} from '@lethalmagotchi/shared';
import { api } from '../../api/client.js';
import { hasSeenClip, markClipSeen } from './seen-clips.js';
import type { AnimationMode } from './settings.js';

export const SKIP_REVEAL_MS = 800;
export const SKIP_SETTLE_MS = 250;
export const STILL_POSE_MS = 1300;

export type PlaybackMode = 'clip' | 'still' | 'none';

export interface PendingAction {
  action: ActionId;
  itemId: ShopItemId | null;
}

export interface Playing extends PendingAction {
  clipId: ClipId;
  mode: PlaybackMode;
  startedAt: number;
  durationMs: number;
  settling: boolean;
}

export interface ActionMachine {
  playing: Playing | null;
  queued: PendingAction | null;
  skipOffered: boolean;
  fire: (action: ActionId, itemId?: ShopItemId | null) => void;
  skip: () => void;
}

export function playbackModeFor(mode: AnimationMode, reducedMotion: boolean): PlaybackMode {
  if (mode === 'off') return 'none';
  if (reducedMotion || mode === 'short') return 'still';
  return 'clip';
}

export function clipDuration(clipId: ClipId, mode: PlaybackMode): number {
  if (mode === 'none') return 0;
  if (mode === 'still') return STILL_POSE_MS;
  return ACTION_ANIMATION_MS[clipId];
}

interface Options {
  characterId: string;
  animationMode: AnimationMode;
  reducedMotion: boolean;
  onCommit: (response: ActionResponse) => void;
  onError: (error: unknown) => void;
}

/**
 * `idle -> playing(clipId) -> idle`, with a one-deep queue. The server call and the
 * stat commit both happen at fire time, never at clip end — the clip is presentation
 * over already-committed state, so a reload mid-clip loses nothing.
 */
export function useActionMachine(options: Options): ActionMachine {
  const [playing, setPlaying] = useState<Playing | null>(null);
  const [queued, setQueued] = useState<PendingAction | null>(null);
  const [skipOffered, setSkipOffered] = useState(false);

  const latest = useRef(options);
  latest.current = options;

  const playingRef = useRef<Playing | null>(null);
  const queuedRef = useRef<PendingAction | null>(null);
  const requestSeq = useRef(0);
  const settledSeq = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const endTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishers = useRef(new WeakMap<Playing, () => void>());

  const clearTimers = useCallback(() => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
    if (endTimer.current) clearTimeout(endTimer.current);
    endTimer.current = null;
  }, []);

  useEffect(() => () => clearTimers(), [clearTimers]);

  const run = useCallback(
    (pending: PendingAction): void => {
      const { characterId, animationMode, reducedMotion, onCommit, onError } = latest.current;
      const clipId = clipIdFor(pending.action, pending.itemId);
      const mode = playbackModeFor(animationMode, reducedMotion);
      const durationMs = clipDuration(clipId, mode);
      const startedAt = Date.now();
      const current: Playing = { ...pending, clipId, mode, startedAt, durationMs, settling: false };

      playingRef.current = current;
      setPlaying(current);
      setSkipOffered(false);

      const finish = () => {
        if (playingRef.current !== current) return;
        clearTimers();
        playingRef.current = null;
        setPlaying(null);
        setSkipOffered(false);
        const next = queuedRef.current;
        queuedRef.current = null;
        setQueued(null);
        if (next) run(next);
      };

      if (mode === 'clip' && hasSeenClip(characterId, clipId) && durationMs > SKIP_REVEAL_MS + SKIP_SETTLE_MS) {
        timers.current.push(
          setTimeout(() => {
            if (playingRef.current === current) setSkipOffered(true);
          }, SKIP_REVEAL_MS),
        );
      }

      /**
       * The commit is deliberately independent of whether this clip is still on
       * screen. A skipped (or queued-past) clip can end before a slow server
       * answers, and dropping that answer would leave the HUD showing pre-action
       * coins and no cooldown while the server had already applied both. The
       * sequence guard only suppresses a response that a *newer* one has overtaken.
       */
      const seq = (requestSeq.current += 1);
      const settle = (apply: () => void): boolean => {
        if (seq <= settledSeq.current) return false;
        settledSeq.current = seq;
        apply();
        return true;
      };

      void api
        .performAction(pending.action, pending.itemId)
        .then((response) => {
          settle(() => onCommit(response));
          markClipSeen(characterId, clipId);
          if (playingRef.current !== current) return;
          const remaining = Math.max(0, startedAt + current.durationMs - Date.now());
          if (remaining === 0) {
            finish();
            return;
          }
          endTimer.current = setTimeout(finish, remaining);
        })
        .catch((error: unknown) => {
          settle(() => onError(error));
          if (playingRef.current !== current) return;
          finish();
        });

      finishers.current.set(current, finish);
    },
    [clearTimers],
  );

  const fire = useCallback(
    (action: ActionId, itemId: ShopItemId | null = null) => {
      const pending = { action, itemId };
      if (playingRef.current) {
        queuedRef.current = pending;
        setQueued(pending);
        return;
      }
      run(pending);
    },
    [run],
  );

  const skip = useCallback(() => {
    const current = playingRef.current;
    if (!current || current.settling || current.mode !== 'clip') return;
    const finish = finishers.current.get(current);
    if (!finish) return;

    // Fast-forward, never a hard cut: the pet still visibly finishes its settle.
    if (endTimer.current) clearTimeout(endTimer.current);
    current.settling = true;
    current.durationMs = Date.now() - current.startedAt + SKIP_SETTLE_MS;
    setPlaying({ ...current });
    setSkipOffered(false);
    endTimer.current = setTimeout(finish, SKIP_SETTLE_MS);
  }, []);

  return { playing, queued, skipOffered, fire, skip };
}
