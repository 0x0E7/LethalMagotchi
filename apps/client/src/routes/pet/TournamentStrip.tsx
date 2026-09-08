import { useEffect, useRef, useState } from 'react';
import {
  ENTRY_FEE_COINS,
  HP_PER_COIN,
  MISS_PENALTY_COINS,
  entryRiskFor,
  resolveEntryCharge,
  type CharacterDto,
  type EntryRisk,
} from '@lethalmagotchi/shared';
import { useTournament } from '../../tournament/TournamentProvider.js';

const HOLD_TO_CONFIRM_MS = 800;

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'now';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 900) {
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }
  const hours = Math.floor(seconds / 3600);
  if (hours >= 1) return `in ${hours}h`;
  return `in ${Math.ceil(seconds / 60)}m`;
}

function localTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** The 800ms hold that stands between a player and a decision that can cost HP. */
function HoldButton({ label, onConfirm }: { label: string; onConfirm: () => void }) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = (): void => {
    setHolding(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const start = (): void => {
    setHolding(true);
    timer.current = setTimeout(() => {
      stop();
      onConfirm();
    }, HOLD_TO_CONFIRM_MS);
  };

  useEffect(() => () => stop(), []);

  return (
    <button
      type="button"
      className={holding ? 'hold-confirm holding' : 'hold-confirm'}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      // Keyboard users get a plain activation rather than a hold they cannot perform.
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onConfirm();
        }
      }}
    >
      {label}
      <span className="hold-fill" aria-hidden="true" />
    </button>
  );
}

function ConfirmJoin({
  character,
  risk,
  onCancel,
  onConfirm,
}: {
  character: CharacterDto;
  risk: EntryRisk;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const outcome = resolveEntryCharge({ stats: character.stats, lethalCoins: character.lethalCoins }, 'entry');
  const hpAfter = outcome.kind === 'paid' ? outcome.hpAfter : 0;
  const hpConverted = outcome.kind === 'paid' ? outcome.hpConverted : outcome.hpNeeded;

  if (risk === 'affordable') {
    return (
      <div className="join-popover" role="dialog" aria-label="Join the tournament">
        <p>
          Entry is {ENTRY_FEE_COINS} coins. You have {character.lethalCoins}.
        </p>
        <div className="join-actions">
          <button type="button" className="ghost small" onClick={onCancel}>
            Not this time
          </button>
          <button type="button" className="primary" onClick={onConfirm}>
            Join · {ENTRY_FEE_COINS} coins
          </button>
        </div>
      </div>
    );
  }

  const lethal = risk === 'lethal';

  return (
    <div className="modal-backdrop still" role="dialog" aria-modal="true" aria-label="Confirm tournament entry">
      <div className={lethal ? 'card modal confirm-entry lethal' : 'card modal confirm-entry'}>
        <h2>{lethal ? `This would end ${character.nickname}'s run` : 'This will cost HP'}</h2>

        <p>
          Entry is {ENTRY_FEE_COINS} coins and {character.nickname} has {character.lethalCoins}. The
          shortfall converts at {HP_PER_COIN}% HP per coin.
        </p>

        <p className="hp-arithmetic">
          <span className="hp-before">{Math.round(character.stats.hp)}% HP</span>
          <span aria-hidden="true"> → </span>
          <span className={lethal ? 'hp-after gone' : 'hp-after'}>{lethal ? '0% HP' : `${Math.round(hpAfter)}% HP`}</span>
          <span className="muted small"> ({Math.round(hpConverted)}% converted)</span>
        </p>

        {lethal && (
          <p className="lethal-copy">
            There isn&apos;t enough HP to cover it. {character.nickname} would be reborn instead of
            seated — stats and coins back to the start, everything else about them unchanged. They
            would not play this tournament.
          </p>
        )}

        <div className="join-actions stacked">
          <button type="button" className="primary" onClick={onCancel}>
            Not this time
          </button>
          <HoldButton
            label={lethal ? `Hold to risk ${character.nickname}` : `Hold to spend ${Math.round(hpConverted)}% HP`}
            onConfirm={onConfirm}
          />
        </div>
      </div>
    </div>
  );
}

export function TournamentStrip({ character }: { character: CharacterDto }) {
  const { tournament, entry, blackout, resumesAt, nextSlotAt, setOptIn, socketStatus } = useTournament();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const risk = entryRiskFor({ stats: character.stats, lethalCoins: character.lethalCoins });
  const startsAt = tournament?.scheduledFor ?? nextSlotAt;
  const untilStart = startsAt ? Date.parse(startsAt) - now : 0;
  const joined = character.tournamentOptIn;

  const join = async (optIn: boolean): Promise<void> => {
    setBusy(true);
    try {
      await setOptIn(optIn);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  const live = tournament?.state === 'registration' || tournament?.state === 'running';

  // A real scheduled tournament always outranks the blackout label. The two only ever
  // disagree when the server is running a non-default schedule, and in that case the
  // tournament the server actually has is the truth.
  if (blackout && !live) {
    return (
      <div className="tourney-chip quiet" aria-label="Tournaments are closed">
        <span aria-hidden="true">🃏</span>
        <span>Tournaments resume {resumesAt ? localTime(resumesAt) : 'in the morning'}</span>
      </div>
    );
  }

  const running = tournament?.state === 'running';
  const nearby = untilStart <= 5 * 60_000;

  return (
    <div className="tourney-slot">
      <div className={nearby ? 'tourney-chip live' : 'tourney-chip'}>
        <span aria-hidden="true">🃏</span>
        <span>
          {running ? 'Tournament in play' : `Tournament ${formatCountdown(untilStart)}`}
        </span>
        {joined && !running && <span className="chip joined">Entered</span>}
        {socketStatus !== 'open' && <span className="chip offline">Reconnecting…</span>}
      </div>

      {!running && nearby && (
        <div className="join-strip">
          <p className="join-copy">
            {joined
              ? `${character.nickname} is entered. ${ENTRY_FEE_COINS} coins come out when it starts.`
              : `Sitting out costs ${MISS_PENALTY_COINS} coin.`}
          </p>

          <div className="join-actions">
            {joined ? (
              <button type="button" className="ghost small" disabled={busy} onClick={() => void join(false)}>
                Sit this one out
              </button>
            ) : (
              <button
                type="button"
                className={risk === 'lethal' ? 'primary danger' : 'primary'}
                disabled={busy}
                onClick={() => setConfirming(true)}
              >
                Join · {ENTRY_FEE_COINS} coins
              </button>
            )}
          </div>

          {confirming && (
            <ConfirmJoin
              character={character}
              risk={risk}
              onCancel={() => setConfirming(false)}
              onConfirm={() => void join(true)}
            />
          )}
        </div>
      )}

      {entry && running && (
        <p className="join-copy small muted">
          Your stack: {entry.currentStack} coins
          {entry.hpConverted > 0 ? ` · ${Math.round(entry.hpConverted)}% HP converted to enter` : ''}
        </p>
      )}
    </div>
  );
}
