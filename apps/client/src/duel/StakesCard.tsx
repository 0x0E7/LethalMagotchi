import { useCallback, useEffect, useRef, useState } from 'react';
import { isChickenBadgeActive } from '@lethalmagotchi/shared';
import { useNow } from '../routes/pet/hooks.js';

const HOLD_MS = 1_200;
const HOLD_TICK_MS = 40;

/**
 * One deliberate physical gesture instead of a stack of "are you sure?" modals. The
 * keyboard path is the same gesture — hold Enter or Space — so it is not a second, cheaper
 * way to agree to the same thing.
 */
function useHoldToConfirm(onConfirm: () => void, disabled: boolean) {
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

export interface StakesSide {
  nickname: string;
  lethalCoins: number;
  duelWins?: number;
  duelLosses?: number;
  chickenBadgeUntil?: string | null;
}

interface Props {
  heading: string;
  you: StakesSide;
  them: StakesSide;
  stakeCoins: number;
  /** Present on an invite: the 60s window, shown plainly and never as a dare. */
  expiresAt?: number | null;
  /** Omitted once there is nothing left to agree to — a challenge already out, or resolved. */
  confirmLabel?: string | null;
  confirmBusy?: boolean;
  onConfirm: () => void;
  declineLabel: string;
  onDecline: () => void;
  note?: string | null;
  status?: string | null;
}

/**
 * The same card both players read. The inviter sees it before the invite is even sent —
 * nobody asks somebody else to read this sentence without having read it themselves.
 */
export function StakesCard({
  heading,
  you,
  them,
  stakeCoins,
  expiresAt,
  confirmLabel,
  confirmBusy = false,
  onConfirm,
  declineLabel,
  onDecline,
  note,
  status,
}: Props) {
  const now = useNow(500);
  const declineRef = useRef<HTMLButtonElement | null>(null);
  const hold = useHoldToConfirm(onConfirm, confirmBusy);

  useEffect(() => {
    declineRef.current?.focus();
  }, []);

  const secondsLeft = expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : null;
  const chicken = isChickenBadgeActive(them.chickenBadgeUntil ?? null, now);

  return (
    <div className="modal-backdrop still duel-takeover" role="dialog" aria-modal="true" aria-labelledby="duel-stakes-heading">
      <div className="card modal duel-stakes">
        <h2 id="duel-stakes-heading">{heading}</h2>

        <p className="duel-faceoff">
          <span className="duel-faceoff-name">{you.nickname}</span>
          <span className="duel-faceoff-versus" aria-hidden="true">
            vs
          </span>
          <span className="duel-faceoff-name">
            {them.nickname}
            {typeof them.duelWins === 'number' && typeof them.duelLosses === 'number' && (
              <span className="duel-record"> ({them.duelWins}W · {them.duelLosses}L)</span>
            )}
            {chicken && <span className="duel-chicken">chicken</span>}
          </span>
        </p>

        <dl className="duel-stakes-rows">
          <div className="duel-stakes-row">
            <dt>Your wallet at risk</dt>
            <dd>{stakeCoins} LC</dd>
          </div>
          <div className="duel-stakes-row">
            <dt>Theirs if you win</dt>
            <dd>{stakeCoins} LC</dd>
          </div>
          <div className="duel-stakes-row lethal">
            <dt>
              <span aria-hidden="true">🕊️</span> If {you.nickname} loses
            </dt>
            <dd>{you.nickname} dies</dd>
          </div>
        </dl>

        <p className="muted small">
          Best of three, rock paper scissors. The loser's pet is gone — the usual rebirth
          follows, and the winner takes {stakeCoins} LC. Wallets are read now, so nothing you
          both do afterwards changes the stake.
        </p>

        {secondsLeft !== null && (
          <p className="duel-countdown" role="timer">
            {secondsLeft}s to answer
          </p>
        )}

        {note && (
          <p className="chat-note" role="alert">
            {note}
          </p>
        )}
        {status && <p className="muted small">{status}</p>}

        <div className="duel-stakes-actions">
          {/* Decline is the prominent, focus-defaulted choice. Accepting takes a hold. */}
          <button type="button" className="primary" ref={declineRef} onClick={onDecline}>
            {declineLabel}
          </button>
          {confirmLabel && (
            <button
              type="button"
              className="ghost duel-hold"
              disabled={confirmBusy}
              style={{ ['--hold-progress' as string]: `${Math.round(hold.progress * 100)}%` }}
              {...hold.handlers}
            >
              {confirmLabel}
              <span className="duel-hold-hint"> — hold</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
