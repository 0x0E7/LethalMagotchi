import { useEffect, useRef, useState } from 'react';
import {
  RAID_MAX_RAIDERS,
  RAID_MIN_RAIDERS,
  WEALTH_BAND_LABELS,
  type CharacterDto,
} from '@lethalmagotchi/shared';
import { api } from '../api/client.js';
import { useHoldToConfirm } from '../duel/useHoldToConfirm.js';
import { useNow } from '../routes/pet/hooks.js';
import { PeoplePicker } from '../chat/PeoplePicker.js';
import { wealthBand } from './RaidFinder.js';
import { useRaid } from './RaidProvider.js';
import { aftermathCoinLine, aftermathHeadline } from './state.js';

/**
 * Where a raid interrupts the rest of the game: the party card for whoever is assembling
 * one, the invite for whoever has been asked to join, and the aftermath report for the
 * player who was robbed while they were not even here. The raid itself is a route, not an
 * overlay, because it takes over the screen for its whole length.
 */
export function RaidLayer({ character }: { character: CharacterDto }) {
  const raid = useRaid();
  if (!raid) return null;

  if (raid.aftermath) return <AftermathCard character={character} />;
  if (raid.incoming) return <InviteCard character={character} />;
  if (raid.party && raid.partyHidden) return <PartyChip character={character} />;
  if (raid.party) return <PartyCard character={character} />;
  if (raid.cancelled) return <CancelledCard />;
  return null;
}

/**
 * What is left of the party card while the initiator is out in the Town Square picking
 * people. The raid is still assembling behind it; this is only where it went.
 */
function PartyChip({ character }: { character: CharacterDto }) {
  const raid = useRaid()!;
  const party = raid.party!;
  const joined = party.members.filter((member) => member.state === 'joined').length;
  const claimed = party.members.filter(
    (member) => member.state === 'invited' || member.state === 'joined',
  ).length;

  return (
    <div className="raid-chip">
      <button type="button" className="ghost small" onClick={raid.showParty}>
        Raid on {party.target.nickname} — {joined} in
      </button>

      {/* Recruiting lives in the collapsed state, not on the party card.
          On the card it sat above the hold-to-confirm button and loaded asynchronously, so
          "Fire the raid" moved under the player's finger mid-hold — which is the last
          control in the game that should shift while being pressed.
          Before this, "Find raiders" only hid the card and left you to hope the person you
          wanted had just posted in the Town Square. */}
      {party.initiatorCharacterId === character.id && party.state === 'assembling' && (
        <section className="raid-recruit" aria-labelledby="raid-recruit-heading">
          <h3 id="raid-recruit-heading" className="group-heading">
            Bring someone along
          </h3>
          <PeoplePicker
            emptyLabel="Nobody else is here to bring."
            meta={wealthBand}
            actions={[
              {
                label: 'Invite',
                onPick: (card) => raid.invite(card.characterId),
                unavailable: (card) =>
                  card.characterId === party.target.characterId
                    ? 'The target'
                    : party.members.some((member) => member.characterId === card.characterId)
                      ? 'Already in'
                      : // Counted the way the server counts it: an outstanding invitation
                        // holds a seat, so offering a fourth would only earn a PARTY_FULL.
                        claimed >= RAID_MAX_RAIDERS
                        ? 'Party full'
                        : null,
              },
            ]}
          />
        </section>
      )}
    </div>
  );
}

function Dialog({
  labelledBy,
  children,
}: {
  labelledBy: string;
  children: React.ReactNode;
}) {
  return (
    <div className="modal-backdrop still duel-takeover" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
      <div className="card modal duel-stakes">{children}</div>
    </div>
  );
}

function InviteCard({ character }: { character: CharacterDto }) {
  const raid = useRaid()!;
  const invite = raid.incoming!;
  const now = useNow(500);
  const declineRef = useRef<HTMLButtonElement | null>(null);
  const hold = useHoldToConfirm(() => raid.respond(invite.raidId, true), false);

  useEffect(() => {
    declineRef.current?.focus();
  }, []);

  const secondsLeft = Math.max(0, Math.ceil((invite.expiresAt - now) / 1000));

  return (
    <Dialog labelledBy="raid-invite-heading">
      <h2 id="raid-invite-heading">
        {invite.from.nickname} wants to raid {invite.target.nickname}.
      </h2>

      <dl className="duel-stakes-rows">
        <div className="duel-stakes-row">
          <dt>Their wealth</dt>
          <dd>{WEALTH_BAND_LABELS[invite.target.band]}</dd>
        </div>
        <div className="duel-stakes-row lethal">
          <dt>Your wallet at risk</dt>
          <dd>All {character.lethalCoins} LC</dd>
        </div>
      </dl>

      <p className="muted small">
        A raid is decided by arithmetic, not play: if the party's coins beat theirs, you split
        what you take. If they beat the party, <strong>every coin you own is theirs</strong> and
        you are left begging. Nobody is hurt either way — a raid never touches HP.
      </p>

      <p className="duel-countdown" role="timer">
        {secondsLeft}s to answer
      </p>

      {raid.note && (
        <p className="chat-note" role="alert">
          {raid.note}
        </p>
      )}

      <div className="duel-stakes-actions">
        {/* Declining is free and carries no badge: that badge is for refusing a fair 1v1. */}
        <button type="button" className="primary" ref={declineRef} onClick={() => raid.respond(invite.raidId, false)}>
          Decline
        </button>
        <button
          type="button"
          className="ghost duel-hold"
          style={{ ['--hold-progress' as string]: `${Math.round(hold.progress * 100)}%` }}
          {...hold.handlers}
        >
          Join the raid
          <span className="duel-hold-hint"> — hold</span>
        </button>
      </div>
    </Dialog>
  );
}

function PartyCard({ character }: { character: CharacterDto }) {
  const raid = useRaid()!;
  const party = raid.party!;
  const now = useNow(500);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const hold = useHoldToConfirm(raid.lockIn, party.locking);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const joined = party.members.filter((member) => member.state === 'joined');
  const youAreInitiator = party.initiatorCharacterId === character.id;
  const secondsLeft = party.expiresAt ? Math.max(0, Math.ceil((party.expiresAt - now) / 1000)) : null;
  const readyToFire = joined.length >= RAID_MIN_RAIDERS;

  return (
    <Dialog labelledBy="raid-party-heading">
      <h2 id="raid-party-heading">Raiding {party.target.nickname}</h2>

      <dl className="duel-stakes-rows">
        <div className="duel-stakes-row">
          <dt>Their wealth</dt>
          <dd>{WEALTH_BAND_LABELS[party.target.band]}</dd>
        </div>
        <div className="duel-stakes-row">
          <dt>The party's pot</dt>
          <dd>{WEALTH_BAND_LABELS[party.raidPotBand]}</dd>
        </div>
        <div className="duel-stakes-row lethal">
          <dt>Your wallet at risk</dt>
          <dd>All {character.lethalCoins} LC</dd>
        </div>
      </dl>

      <ul className="raid-party" aria-label="Raiding party">
        {party.members.map((member) => (
          <li key={member.characterId} className={`raid-party-member ${member.state}`}>
            <span className="raid-party-name">{member.nickname}</span>
            <span className="muted small">
              {member.isInitiator ? 'leading' : member.state === 'joined' ? 'in' : member.state}
            </span>
          </li>
        ))}
      </ul>

      <p className="muted small">
        {joined.length} of {RAID_MAX_RAIDERS} raiders in. A raid needs {RAID_MIN_RAIDERS}.
        Wallets are read and held the moment it is locked in.
      </p>
      {youAreInitiator && party.state === 'assembling' && (
        <p className="muted small">Use “Find raiders” below to bring people in.</p>
      )}

      {secondsLeft !== null && (
        <p className="duel-countdown" role="timer">
          {secondsLeft}s before the party breaks up
        </p>
      )}

      {party.state === 'resolving' && <p className="muted small">Counting both pots…</p>}

      {raid.note && (
        <p className="chat-note" role="alert">
          {raid.note}
        </p>
      )}

      <div className="duel-stakes-actions">
        <button type="button" className="primary" ref={closeRef} onClick={raid.dismissMatch}>
          Leave it
        </button>
        {youAreInitiator && party.state === 'assembling' && (
          <button type="button" className="ghost" onClick={raid.hideParty}>
            Find raiders
          </button>
        )}
        {youAreInitiator && party.state === 'assembling' && readyToFire && (
          <button
            type="button"
            className="ghost duel-hold"
            disabled={party.locking}
            aria-busy={party.locking}
            style={{ ['--hold-progress' as string]: `${Math.round(hold.progress * 100)}%` }}
            {...hold.handlers}
          >
            Fire the raid
            <span className="duel-hold-hint"> — hold</span>
          </button>
        )}
      </div>
    </Dialog>
  );
}

function CancelledCard() {
  const raid = useRaid()!;
  return (
    <Dialog labelledBy="raid-cancelled-heading">
      <h2 id="raid-cancelled-heading">The raid did not happen</h2>
      <p>{raid.cancelled?.reason}</p>
      <div className="duel-stakes-actions">
        <button type="button" className="primary" onClick={raid.dismissMatch}>
          Back to town
        </button>
      </div>
    </Dialog>
  );
}

/**
 * The whole experience for someone who was never there, so it leads with the reassurance:
 * the scariest reading of "you were raided" is the wrong one, and they need to learn in the
 * same glance that their pet is alive and only the coins are gone.
 */
function AftermathCard({ character }: { character: CharacterDto }) {
  const raid = useRaid()!;
  const aftermath = raid.aftermath!;
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const { acknowledgeAftermath } = raid;

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // Acknowledged on display, not on receipt: the server holds the report until this lands,
  // so a socket that dropped mid-delivery costs a reconnect rather than the only notice the
  // player gets that their wallet is gone.
  useEffect(() => {
    acknowledgeAftermath(aftermath.raidId);
  }, [acknowledgeAftermath, aftermath.raidId]);

  return (
    <Dialog labelledBy="raid-aftermath-heading">
      <h2 id="raid-aftermath-heading">{aftermathHeadline(aftermath, character.nickname)}</h2>

      <p className="raid-reassurance">
        {character.nickname} is alive and well. A raid takes coins and nothing else — HP, stats
        and cooldowns are exactly where you left them.
      </p>

      <p>{aftermathCoinLine(aftermath)}</p>

      <dl className="duel-stakes-rows">
        <div className="duel-stakes-row">
          <dt>The raiders brought</dt>
          <dd>{aftermath.raidPot} LC</dd>
        </div>
        {/* Only the raid that emptied the wallet has a figure to report: on every other
            outcome nothing was taken, so there is no "had" to state. */}
        {aftermath.outcome === 'raiders_won' && (
          <div className="duel-stakes-row">
            <dt>They took</dt>
            <dd>{aftermath.targetPot} LC</dd>
          </div>
        )}
      </dl>

      <p className="muted small">
        Raided by {aftermath.raiders.map((raider) => raider.nickname).join(', ')}.
      </p>

      <div className="duel-stakes-actions">
        <button type="button" className="primary" ref={closeRef} onClick={raid.dismissAftermath}>
          Got it
        </button>
        {aftermath.nowBeggar && <AppealButton />}
      </div>
    </Dialog>
  );
}

/** The way back, offered in the same card as the loss rather than on a later screen. */
function AppealButton() {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');

  const post = (): void => {
    setState('sending');
    void api
      .postAppeal()
      .then(() => setState('sent'))
      .catch(() => setState('failed'));
  };

  return (
    <button
      type="button"
      className="ghost"
      disabled={state === 'sending' || state === 'sent'}
      aria-busy={state === 'sending'}
      onClick={post}
    >
      {state === 'sent'
        ? 'Asked in the Town Square'
        : state === 'failed'
          ? 'Could not ask — try again'
          : 'Ask for donations'}
    </button>
  );
}
