import { useEffect, useRef } from 'react';
import { WEALTH_BAND_LABELS, isChickenBadgeActive, type WealthBand } from '@lethalmagotchi/shared';
import { useNow } from '../routes/pet/hooks.js';
import { useHoldToConfirm } from './useHoldToConfirm.js';

export interface StakesSide {
  nickname: string;
  /** Only ever the player's own figure. An opponent is described by band. */
  lethalCoins?: number;
  wealthBand?: WealthBand;
  isBeggar?: boolean;
  duelWins?: number;
  duelLosses?: number;
  chickenBadgeUntil?: string | null;
}

interface Props {
  heading: string;
  you: StakesSide;
  them: StakesSide;
  /** Null only before the invite exists, when the server has not fixed it yet. */
  stakeCoins: number | null;
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
  // A duel is played for the smaller of the two wallets, so an unfixed stake is still
  // bounded by the player's own — which is the half they are entitled to see.
  const stakeLabel = stakeCoins === null ? `At most ${you.lethalCoins ?? 0} LC` : `${stakeCoins} LC`;

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
            {them.isBeggar && <span className="beggar-badge">beggar</span>}
            {chicken && <span className="duel-chicken">chicken</span>}
          </span>
        </p>

        <dl className="duel-stakes-rows">
          <div className="duel-stakes-row">
            <dt>Your wallet at risk</dt>
            <dd>{stakeLabel}</dd>
          </div>
          <div className="duel-stakes-row">
            <dt>Theirs if you win</dt>
            <dd>{stakeLabel}</dd>
          </div>
          {them.wealthBand && (
            <div className="duel-stakes-row">
              <dt>How well off they are</dt>
              <dd>{WEALTH_BAND_LABELS[them.wealthBand]}</dd>
            </div>
          )}
          <div className="duel-stakes-row lethal">
            <dt>
              <span aria-hidden="true">🕊️</span> If {you.nickname} loses
            </dt>
            <dd>{you.nickname} dies</dd>
          </div>
        </dl>

        <p className="muted small">
          Best of three, rock paper scissors. The loser's pet is gone — the usual rebirth
          follows, and the winner takes {stakeLabel}. The stake is fixed the moment the
          challenge is sent, so nothing either of you does afterwards changes it.
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
