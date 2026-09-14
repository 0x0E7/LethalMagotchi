import { useMemo, useState } from 'react';
import {
  PARITY_THROW_MAX,
  PARITY_THROW_MIN,
  WEALTH_BAND_LABELS,
  type CharacterDto,
  type ParityCall,
} from '@lethalmagotchi/shared';
import { useNow } from '../routes/pet/hooks.js';
import { useRaid } from './RaidProvider.js';
import type { RaidMatch } from './state.js';

const THROWS = Array.from(
  { length: PARITY_THROW_MAX - PARITY_THROW_MIN + 1 },
  (_, index) => PARITY_THROW_MIN + index,
);

/**
 * The raid itself, once the party is locked in: the reveal, the betrayal window, and however
 * many parity rounds the remainder needs. Copy stays strictly neutral through the betrayal —
 * both choices are legitimate play and the game does not editorialise about either.
 */
export function RaidArena({ match, character }: { match: RaidMatch; character: CharacterDto }) {
  const raid = useRaid();
  const nameOf = useMemo(() => {
    const names = new Map(match.members.map((member) => [member.characterId, member.nickname]));
    return (characterId: string): string =>
      characterId === character.id ? character.nickname : (names.get(characterId) ?? 'A raider');
  }, [match.members, character.id, character.nickname]);

  if (!raid) return null;

  return (
    <main className="screen raid-arena" aria-label="Raid">
      <header className="raid-arena-head">
        <h1>The raid on {match.target.nickname}</h1>
      </header>

      {match.result && (
        <section className="raid-totals" aria-label="The count">
          <p className="raid-total">
            <span className="raid-total-label">The party brought</span>
            <span className="raid-total-value">{match.result.raidPot} LC</span>
          </p>
          {/* Only ever a real number when the wallet it describes is now empty: a target who
              kept their coins keeps the figure too, and the party is told the band instead. */}
          <p className="raid-total">
            <span className="raid-total-label">{match.target.nickname} had</span>
            <span className="raid-total-value">
              {match.result.outcome === 'raiders_won'
                ? `${match.result.targetPot} LC`
                : WEALTH_BAND_LABELS[match.target.band]}
            </span>
          </p>
          <p className="raid-verdict" role="status">
            {match.result.outcome === 'raiders_won'
              ? `The raid takes ${match.result.potCoins} LC.`
              : match.result.outcome === 'target_won'
                ? `${match.target.nickname} held. Every raider is left with nothing.`
                : 'Dead level. Nothing moves, nobody is bankrupted.'}
          </p>
        </section>
      )}

      {match.betrayal && !match.end && <Betrayal match={match} nameOf={nameOf} />}
      {match.parity && !match.end && <Parity match={match} character={character} nameOf={nameOf} />}
      {match.end && <Ending match={match} nameOf={nameOf} />}

      {raid.note && (
        <p className="chat-note" role="alert">
          {raid.note}{' '}
          <button type="button" className="link" onClick={raid.dismissNote}>
            Dismiss
          </button>
        </p>
      )}
    </main>
  );
}

function Countdown({ deadlineAt }: { deadlineAt: number }) {
  const now = useNow(250);
  const secondsLeft = Math.max(0, Math.ceil((deadlineAt - now) / 1000));
  return (
    <p className="duel-countdown" role="timer">
      {secondsLeft}s
    </p>
  );
}

function Betrayal({ match, nameOf }: { match: RaidMatch; nameOf: (id: string) => string }) {
  const raid = useRaid()!;
  const betrayal = match.betrayal!;
  const locked = betrayal.yourChoice !== null;

  if (betrayal.result) {
    return (
      <section className="raid-phase" aria-label="The split">
        <h2>{betrayal.result.potDestroyed ? 'Nobody takes anything.' : 'The split'}</h2>
        <ul className="raid-choices">
          {betrayal.result.choices.map((entry) => (
            <li key={entry.characterId}>
              <span className="raid-party-name">{nameOf(entry.characterId)}</span>
              <span className={entry.choice === 'betray' ? 'raid-choice betray' : 'raid-choice loyal'}>
                {entry.choice === 'betray' ? 'took it all' : 'split it'}
              </span>
            </li>
          ))}
        </ul>
        {betrayal.result.potDestroyed ? (
          <p className="raid-burn">Everyone reached. The coins are gone.</p>
        ) : (
          <ul className="raid-awards">
            {betrayal.result.awards.map((award) => (
              <li key={award.characterId}>
                {nameOf(award.characterId)}: {award.coins} LC
              </li>
            ))}
          </ul>
        )}
        {betrayal.result.remainder > 0 && (
          <p className="muted small">
            {betrayal.result.remainder} LC would not divide. Playing for the remainder.
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="raid-phase" aria-label="Split or take it all">
      <h2>{betrayal.potCoins} LC is on the table.</h2>
      <Countdown deadlineAt={betrayal.deadlineAt} />
      <div className="raid-buttons">
        <button
          type="button"
          className="primary"
          disabled={locked}
          aria-pressed={betrayal.yourChoice === 'loyal'}
          onClick={() => raid.choose('loyal')}
        >
          Split
        </button>
        <button
          type="button"
          className="ghost"
          disabled={locked}
          aria-pressed={betrayal.yourChoice === 'betray'}
          onClick={() => raid.choose('betray')}
        >
          Take it all
        </button>
      </div>
      {/* The fact of a lock, and nothing else: no choice is shown before the reveal. */}
      <p className="muted small" role="status">
        {locked ? 'Locked in. ' : 'Choose before the timer runs out. '}
        {betrayal.locked.length > 0 &&
          `${betrayal.locked.map(nameOf).join(', ')} ${betrayal.locked.length === 1 ? 'has' : 'have'} chosen.`}
      </p>
    </section>
  );
}

function Parity({
  match,
  character,
  nameOf,
}: {
  match: RaidMatch;
  character: CharacterDto;
  nameOf: (id: string) => string;
}) {
  const raid = useRaid()!;
  const parity = match.parity!;
  const [call, setCall] = useState<ParityCall>('odds');
  const [throwValue, setThrowValue] = useState(0);
  const eligible = parity.contenders.includes(character.id);
  const locked = parity.yourCall !== null;

  if (parity.result) {
    return (
      <section className="raid-phase" aria-label="The remainder">
        <h2>{parity.result.parity === 'odds' ? 'Odds' : 'Evens'}.</h2>
        <ul className="raid-choices">
          {parity.result.calls.map((entry) => (
            <li key={entry.characterId}>
              <span className="raid-party-name">{nameOf(entry.characterId)}</span>
              <span className="raid-choice">
                called {entry.call}, threw {entry.throw}
              </span>
            </li>
          ))}
        </ul>
        {parity.result.seededSplit && (
          <p className="muted small">
            The remainder would not settle, so it was split by the raid's own seed.
          </p>
        )}
        <ul className="raid-awards">
          {parity.result.awards
            .filter((award) => award.coins > 0)
            .map((award) => (
              <li key={award.characterId}>
                {nameOf(award.characterId)}: +{award.coins} LC
              </li>
            ))}
        </ul>
      </section>
    );
  }

  if (!eligible) {
    return (
      <section className="raid-phase" aria-label="The remainder">
        <h2>{parity.remainder} LC is still to be settled.</h2>
        <p className="muted small">You are not in this one. Round {parity.round}.</p>
        <Countdown deadlineAt={parity.deadlineAt} />
      </section>
    );
  }

  return (
    <section className="raid-phase" aria-label="Call the remainder">
      <h2>
        {parity.remainder} LC would not divide. Round {parity.round}.
      </h2>
      <Countdown deadlineAt={parity.deadlineAt} />

      <fieldset className="raid-call" disabled={locked}>
        <legend>Your call</legend>
        <div className="segmented">
          {(['odds', 'evens'] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={call === option ? 'segment active' : 'segment'}
              aria-pressed={call === option}
              onClick={() => setCall(option)}
            >
              {option === 'odds' ? 'Odds' : 'Evens'}
            </button>
          ))}
        </div>

        <label htmlFor="raid-throw">Your number</label>
        <div className="segmented" id="raid-throw">
          {THROWS.map((value) => (
            <button
              key={value}
              type="button"
              className={throwValue === value ? 'segment active' : 'segment'}
              aria-pressed={throwValue === value}
              onClick={() => setThrowValue(value)}
            >
              {value}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="raid-buttons">
        <button type="button" className="primary" disabled={locked} onClick={() => raid.call(call, throwValue)}>
          Throw
        </button>
      </div>
      <p className="muted small" role="status">
        {locked ? 'Locked in. ' : 'Everyone throws at once. '}
        {parity.locked.length > 0 &&
          `${parity.locked.map(nameOf).join(', ')} ${parity.locked.length === 1 ? 'has' : 'have'} thrown.`}
      </p>
    </section>
  );
}

function Ending({ match, nameOf }: { match: RaidMatch; nameOf: (id: string) => string }) {
  const raid = useRaid()!;
  const end = match.end!;

  return (
    <section className="raid-phase" role="dialog" aria-label="The raid is over" aria-modal="false">
      <h2>
        {end.potDestroyed
          ? 'The coins are gone.'
          : end.coinsReceived > 0
            ? `You take ${end.coinsReceived} LC.`
            : end.youWereBankrupted
              ? 'You are left with nothing.'
              : 'You walk away empty-handed.'}
      </h2>

      {end.youWereBankrupted && (
        <p className="raid-reassurance">
          Your pet is unharmed — a raid only ever takes coins. You can ask the Town Square for
          help from the pet screen.
        </p>
      )}
      {end.bankrupted.length > 0 && !end.youWereBankrupted && (
        <p className="muted small">
          Nothing for {end.bankrupted.map(nameOf).join(', ')}.
        </p>
      )}

      <div className="raid-buttons">
        <button type="button" className="primary" onClick={raid.dismissMatch}>
          Return to town
        </button>
      </div>
    </section>
  );
}
