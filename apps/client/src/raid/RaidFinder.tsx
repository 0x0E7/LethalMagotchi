import { useEffect, useRef } from 'react';
import { RAID_MAX_RAIDERS, RAID_MIN_RAIDERS, WEALTH_BAND_LABELS, type DuelCardDto } from '@lethalmagotchi/shared';
import { PeoplePicker } from '../chat/PeoplePicker.js';
import { useRaid } from './RaidProvider.js';

/** Plain-language versions of the server's own read of why a target is off limits. */
const BLOCKED_COPY: Record<NonNullable<DuelCardDto['raidBlockedReason']>, string> = {
  too_new: 'Too new',
  immune: 'Raided recently',
  too_poor: 'Nothing to take',
};

export function raidUnavailable(card: DuelCardDto): string | null {
  if (card.raidEligible) return null;
  return card.raidBlockedReason ? BLOCKED_COPY[card.raidBlockedReason] : 'Unavailable';
}

/** A band, never a balance. Shared by the finder and the party card's recruiting list. */
export function wealthBand(card: DuelCardDto) {
  return (
    <span className="people-band" title="Roughly how well off they are">
      {WEALTH_BAND_LABELS[card.wealthBand]}
    </span>
  );
}

/**
 * Finding a raid from the main screen.
 *
 * Two jobs, because a raid has two halves and both had the same reachability gap: picking a
 * target, and then filling the party. Both used to be possible only against someone who had
 * just spoken in the Town Square — so a raid was, in practice, whoever happened to be
 * chatting. This is the front door for each, and which one it shows depends on whether a
 * party is already forming.
 *
 * Wealth shows as a band and never as a number, which is a security boundary rather than a
 * presentation choice: exact balances would let a party fire only when the arithmetic was
 * already won, and a raid nobody can lose is not a raid.
 */
/**
 * Aiming a raid from the main screen.
 *
 * Target picking only. Filling the party is the party card's job — it is already a
 * full-screen surface with the roster and the stakes on it, and a second modal stacked over
 * it was exactly that: a dialog the player could see and could not click through.
 *
 * Wealth shows as a band and never as a number, which is a security boundary rather than a
 * presentation choice: exact balances would let a party fire only when the arithmetic was
 * already won, and a raid nobody can lose is not a raid.
 */
export function RaidFinder({ onClose }: { onClose: () => void }) {
  const raid = useRaid();
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  if (!raid) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="raid-finder-heading">
      <div className="card modal raid-finder">
        <h2 id="raid-finder-heading">Find a raid</h2>
        <p className="muted small">
          Pick who to rob, then bring {RAID_MIN_RAIDERS - 1} or {RAID_MAX_RAIDERS - 1} others.
          Whichever side holds fewer coins loses every one of them.
        </p>
        {/* No random target, deliberately: picking a stranger to rob at one tap is a
            different act from picking a stranger to spar with, and a raid needs no consent
            from the person on the other end of it. */}
        <PeoplePicker
          meta={wealthBand}
          actions={[
            {
              label: 'Raid',
              onPick: (card) => {
                raid.createRaid(card);
                // The party card takes over from here, so the finder gets out of its way.
                onClose();
              },
              unavailable: raidUnavailable,
            },
          ]}
        />

        {raid.note && (
          <p className="chat-note" role="alert">
            {raid.note}{' '}
            <button type="button" className="link" onClick={raid.dismissNote}>
              Dismiss
            </button>
          </p>
        )}

        <div className="duel-stakes-actions">
          <button type="button" className="ghost" ref={closeRef} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
