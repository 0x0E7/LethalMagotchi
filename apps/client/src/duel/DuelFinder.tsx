import { useEffect, useRef, useState } from 'react';
import type { DuelCardDto } from '@lethalmagotchi/shared';
import { api } from '../api/client.js';
import { PeoplePicker } from '../chat/PeoplePicker.js';
import { useDuel } from './DuelProvider.js';

/** Plain-language versions of the server's own read of why a challenge would be refused. */
const BLOCKED_COPY: Record<NonNullable<DuelCardDto['duelBlockedReason']>, string> = {
  too_new: 'Too new',
  offline: 'Away',
  busy: 'Busy',
};

export function duelUnavailable(card: DuelCardDto): string | null {
  if (card.duelEligible) return null;
  return card.duelBlockedReason ? BLOCKED_COPY[card.duelBlockedReason] : 'Unavailable';
}

/**
 * Finding someone to duel, from the main screen rather than from a chat panel.
 *
 * Until now a challenge could only be issued to someone who had just spoken in the Town
 * Square, which is why "there is no option to invite someone for a duel" was a fair reading
 * of the game — the feature was real but reachable only by luck. This is the front door: a
 * name to search for, or nobody in particular.
 *
 * Picking an opponent opens the Stakes Card rather than sending anything. A duel is lethal,
 * and the confirmation is the consent moment; a finder that skipped it would be the one path
 * in the product that stakes a life on a single tap.
 */
export function DuelFinder({ onClose }: { onClose: () => void }) {
  const duel = useDuel();
  const [rolling, setRolling] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  if (!duel) return null;

  const challenge = (card: DuelCardDto): void => {
    duel.openStakes(card);
    onClose();
  };

  const rollRandom = (): void => {
    setRolling(true);
    setNote(null);
    void api
      .randomOpponent()
      .then((response) => {
        if (response.card) {
          challenge(response.card);
          return;
        }
        // An ordinary answer on a quiet server, not a failure — said plainly so it does not
        // read as the button being broken.
        setNote('Nobody is free to duel right now. Try again in a minute, or search by name.');
      })
      .catch(() => setNote('Could not reach the server. Try again.'))
      .finally(() => setRolling(false));
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="duel-finder-heading">
      <div className="card modal duel-finder">
        <h2 id="duel-finder-heading">Find a duel</h2>

        <section className="duel-finder-random">
          <button type="button" className="primary" disabled={rolling} aria-busy={rolling} onClick={rollRandom}>
            {rolling ? 'Looking for someone…' : 'Random opponent'}
          </button>
          <p className="muted small">
            Anyone who is here and able to fight. You still see the stakes before anything is sent.
          </p>
        </section>

        {note && (
          <p className="chat-note" role="status">
            {note}
          </p>
        )}

        <section className="duel-finder-search" aria-labelledby="duel-finder-search-heading">
          <h3 id="duel-finder-search-heading" className="group-heading">
            Or pick someone
          </h3>
          <PeoplePicker
            actions={[{ label: 'Duel', onPick: challenge, unavailable: duelUnavailable }]}
          />
        </section>

        <div className="duel-stakes-actions">
          <button type="button" className="ghost" ref={closeRef} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
