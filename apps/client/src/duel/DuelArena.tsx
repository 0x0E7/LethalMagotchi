import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DUEL_ROUND_MS,
  DUEL_THROWS,
  DUEL_THROW_GLYPHS,
  DUEL_THROW_LABELS,
  type CharacterDto,
  type DuelThrow,
} from '@lethalmagotchi/shared';
import { useChat } from '../chat/ChatProvider.js';
import { useAnnouncer, useNow } from '../routes/pet/hooks.js';
import { speciesArt } from '../species-art.js';
import { useDuel, type MatchState, type RoundLogEntry } from './DuelProvider.js';
import { defeatStakeLine, victoryStakeLine } from './state.js';

/** Digits appear only at the very end; before that the ring is the clock. */
const DIGITS_VISIBLE_MS = 2_000;

function Pips({ label, filled, total }: { label: string; filled: number; total: number }) {
  return (
    <span className="duel-pips" role="img" aria-label={`${label}: ${filled} of ${total} rounds won`}>
      {Array.from({ length: total }).map((_, index) => (
        <span key={index} className={index < filled ? 'duel-pip on' : 'duel-pip'} aria-hidden="true" />
      ))}
    </span>
  );
}

function describeRound(entry: RoundLogEntry, opponentName: string): string {
  const throws = `You threw ${DUEL_THROW_LABELS[entry.yourThrow]}, ${opponentName} threw ${
    DUEL_THROW_LABELS[entry.opponentThrow]
  }.`;
  if (entry.winner === 'draw') return `${throws} A draw — the round replays.`;
  const who = entry.winner === 'you' ? 'You take the round' : `${opponentName} takes the round`;
  return `${throws} ${who}${entry.tiebreak ? ', on the tiebreak' : ''}.`;
}

function RoundLog({ log, opponentName }: { log: RoundLogEntry[]; opponentName: string }) {
  return (
    <ol className="duel-log" aria-label="Round log">
      {log.length === 0 && <li className="muted small">No rounds played yet.</li>}
      {log.map((entry) => (
        <li key={`${entry.round}-${entry.replay}`} className={`duel-log-row ${entry.winner}`}>
          <span className="duel-log-round">
            {/* Replays are listed too, so a 2-1 never looks like a 2-0. */}
            R{entry.round}
            {entry.replay > 0 ? `.${entry.replay}` : ''}
          </span>
          <span className="duel-log-throws">
            <span aria-hidden="true">{DUEL_THROW_GLYPHS[entry.yourThrow]}</span>
            <span className="sr-only">You threw {DUEL_THROW_LABELS[entry.yourThrow]}, </span>
            <span aria-hidden="true"> vs </span>
            <span aria-hidden="true">{DUEL_THROW_GLYPHS[entry.opponentThrow]}</span>
            <span className="sr-only">
              {opponentName} threw {DUEL_THROW_LABELS[entry.opponentThrow]}.
            </span>
          </span>
          <span className="duel-log-winner">
            {entry.winner === 'draw' ? 'Draw' : entry.winner === 'you' ? 'You' : opponentName}
            {entry.tiebreak ? ' (tiebreak)' : ''}
          </span>
        </li>
      ))}
    </ol>
  );
}

function EndCard({ match, character }: { match: MatchState; character: CharacterDto }) {
  const duel = useDuel();
  const chat = useChat();
  const navigate = useNavigate();
  const end = match.end!;

  const leave = () => {
    duel?.dismissMatch();
    navigate('/pet', { replace: true });
  };

  const message = () => {
    if (match.opponent.accountId && chat) {
      chat.setOpen(true);
      void chat.startDm(match.opponent.accountId);
    }
    leave();
  };

  if (end.outcome === 'abort') {
    return (
      <div className="modal-backdrop still" role="dialog" aria-modal="true" aria-label="Duel called off">
        <div className="card modal duel-end">
          <h2>The duel was called off.</h2>
          <p>Nobody was hurt and no coins moved.</p>
          <button type="button" className="primary" onClick={leave}>
            Return to town
          </button>
        </div>
      </div>
    );
  }

  const decider = match.log[match.log.length - 1];

  return (
    <div
      className="modal-backdrop still"
      role="dialog"
      aria-modal="true"
      aria-label={end.youWon ? 'You won the duel' : 'You lost the duel'}
    >
      <div className={end.youWon ? 'card modal duel-end' : 'card modal duel-end lost'}>
        {/* The losing reveal stays on screen: the player has to see what beat them before
            anything else happens. */}
        {decider && (
          <p className="duel-decider">
            <span aria-hidden="true">{DUEL_THROW_GLYPHS[decider.yourThrow]}</span>
            <span aria-hidden="true"> vs </span>
            <span aria-hidden="true">{DUEL_THROW_GLYPHS[decider.opponentThrow]}</span>
            <span className="sr-only">{describeRound(decider, match.opponent.nickname)}</span>
          </p>
        )}

        {end.youWon ? (
          <>
            <h2>{match.opponent.nickname} fell.</h2>
            <p>{victoryStakeLine(end.coinsTransferred, character.nickname)}</p>
            <div className="duel-end-actions">
              <button type="button" className="primary" onClick={leave}>
                Return to town
              </button>
              {match.opponent.accountId && (
                <button type="button" className="ghost" onClick={message}>
                  Send a message
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <h2>
              {character.nickname} was defeated by {match.opponent.nickname}.
            </h2>
            <p>{defeatStakeLine(end.coinsTransferred, match.opponent.nickname)}</p>
            <button type="button" className="primary" onClick={leave}>
              Return to town
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function DuelArena({ match, character }: { match: MatchState; character: CharacterDto }) {
  const duel = useDuel();
  const now = useNow(100);
  const { message: announcement, announce } = useAnnouncer();

  const remainingMs = match.deadlineAt > 0 ? Math.max(0, match.deadlineAt - now) : 0;
  const fraction = Math.max(0, Math.min(1, remainingMs / DUEL_ROUND_MS));
  const locked = match.yourThrow !== null;
  const over = match.end !== null;

  const announcedRound = useRef<string | null>(null);
  useEffect(() => {
    const reveal = match.reveal;
    if (!reveal) return;
    const key = `${reveal.round}-${reveal.replay}`;
    if (announcedRound.current === key) return;
    announcedRound.current = key;
    announce(describeRound(reveal, match.opponent.nickname));
  }, [match.reveal, match.opponent.nickname, announce]);

  useEffect(() => {
    if (locked || over || !duel) return;
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      const index = ['1', '2', '3'].indexOf(event.key);
      if (index === -1) return;
      duel!.throwHand(DUEL_THROWS[index] as DuelThrow);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [duel, locked, over]);

  return (
    <main className="duel-layout">
      <header className="duel-topbar">
        <div>
          <h1>
            Duel · {character.nickname} vs {match.opponent.nickname}
          </h1>
          <p className="muted small">
            Best of {match.winsNeeded * 2 - 1} · round {match.round}
            {match.replay > 0 ? ` · replay ${match.replay}` : ''}
          </p>
        </div>
        <span className="coin-chip" aria-label={`${match.stakeCoins} LethalCoins at stake`}>
          <span aria-hidden="true">🪙</span> {match.stakeCoins}
        </span>
      </header>

      <section className="duel-arena" aria-label="Arena">
        <div className="duel-fighter">
          <span className="duel-avatar" role="img" aria-label={`${character.nickname}, a ${character.speciesId}`}>
            {speciesArt(character.speciesId)}
          </span>
          <span className="duel-fighter-name">{character.nickname}</span>
        </div>

        <div className="duel-score">
          <Pips label={character.nickname} filled={match.yourWins} total={match.winsNeeded} />
          <span className="duel-score-versus" aria-hidden="true">
            vs
          </span>
          <Pips label={match.opponent.nickname} filled={match.theirWins} total={match.winsNeeded} />
        </div>

        <div className="duel-fighter">
          <span
            className="duel-avatar"
            role="img"
            aria-label={`${match.opponent.nickname}, a ${match.opponent.speciesId}`}
          >
            {speciesArt(match.opponent.speciesId)}
          </span>
          <span className="duel-fighter-name">{match.opponent.nickname}</span>
        </div>
      </section>

      <section className="duel-reveal" aria-label="This round">
        <div className="duel-hand">
          <span className="duel-hand-label">You</span>
          <span className="duel-hand-face">
            {match.reveal ? (
              <>
                <span aria-hidden="true">{DUEL_THROW_GLYPHS[match.reveal.yourThrow]}</span>
                <span className="sr-only">{DUEL_THROW_LABELS[match.reveal.yourThrow]}</span>
              </>
            ) : locked ? (
              <span aria-label="Your throw is locked in">🤛</span>
            ) : (
              <span aria-hidden="true">…</span>
            )}
          </span>
        </div>

        <div className="duel-timer" aria-hidden="true">
          <span className="duel-ring" style={{ ['--ring' as string]: `${Math.round(fraction * 100)}%` }} />
          {remainingMs <= DIGITS_VISIBLE_MS && !over && (
            <span className="duel-digits">{Math.ceil(remainingMs / 1000)}</span>
          )}
        </div>

        <div className="duel-hand">
          <span className="duel-hand-label">{match.opponent.nickname}</span>
          <span className="duel-hand-face">
            {match.reveal ? (
              <>
                <span aria-hidden="true">{DUEL_THROW_GLYPHS[match.reveal.opponentThrow]}</span>
                <span className="sr-only">{DUEL_THROW_LABELS[match.reveal.opponentThrow]}</span>
              </>
            ) : match.opponentLocked ? (
              <span aria-label={`${match.opponent.nickname} has locked in`}>🤜</span>
            ) : (
              <span aria-hidden="true">…</span>
            )}
          </span>
        </div>
      </section>

      <p className="duel-status" role="status">
        {over
          ? 'The duel is over.'
          : match.reveal
            ? describeRound(match.reveal, match.opponent.nickname)
            : locked
              ? `Locked in. Waiting on ${match.opponent.nickname}…`
              : 'Choose your throw.'}
      </p>

      <footer className="duel-dock">
        {duel?.note && (
          <p className="dock-note" role="alert">
            {duel.note}{' '}
            <button type="button" className="link" onClick={duel.dismissNote}>
              Dismiss
            </button>
          </p>
        )}

        <div className="duel-throws" role="group" aria-label="Your throw">
          {DUEL_THROWS.map((choice, index) => (
            <button
              key={choice}
              type="button"
              className={match.yourThrow === choice ? 'duel-throw chosen' : 'duel-throw'}
              aria-keyshortcuts={String(index + 1)}
              aria-pressed={match.yourThrow === choice}
              disabled={locked || over}
              onClick={() => duel?.throwHand(choice)}
            >
              <span className="duel-throw-glyph" aria-hidden="true">
                {DUEL_THROW_GLYPHS[choice]}
              </span>
              {DUEL_THROW_LABELS[choice]}
            </button>
          ))}
        </div>
        <p className="duel-shortcuts">
          <kbd>1</kbd> rock · <kbd>2</kbd> paper · <kbd>3</kbd> scissors
        </p>
      </footer>

      <aside className="duel-side" aria-label="Rounds so far">
        <RoundLog log={match.log} opponentName={match.opponent.nickname} />
      </aside>

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      {over && <EndCard match={match} character={character} />}
    </main>
  );
}
