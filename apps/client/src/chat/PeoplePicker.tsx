import { useEffect, useState } from 'react';
import { authorBadge, type DuelCardDto } from '@lethalmagotchi/shared';
import { api } from '../api/client.js';

/** Long enough that typing a name is one request, short enough to feel immediate. */
const SEARCH_DEBOUNCE_MS = 250;

interface Props {
  /** Verb on each row's button — "Message", "Add", and so on. */
  actionLabel: string;
  onPick: (card: DuelCardDto) => void;
  /** Rows that should render without an action, e.g. people already in the group. */
  isPicked?: (card: DuelCardDto) => boolean;
  pickedLabel?: string;
}

/**
 * Find a player and do something with them.
 *
 * Both starting a direct message and inviting someone to a group used to require catching
 * that person posting in the Town Square, because the only card lookup took ids you already
 * had. One searchable list serves both, so neither has to grow its own half-directory.
 *
 * Empty search means "who is online now", which is the useful default: the people worth
 * messaging are usually the ones here. Typing searches every player by nickname instead.
 */
export function PeoplePicker({ actionLabel, onPick, isPicked, pickedLabel = 'Added' }: Props) {
  const [term, setTerm] = useState('');
  const [cards, setCards] = useState<DuelCardDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void api
        .players(term.trim())
        .then((response) => {
          if (cancelled) return;
          setCards(response.cards);
          setFailed(false);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [term]);

  return (
    <div className="people-picker">
      <label className="sr-only" htmlFor="people-search">
        Search players by name
      </label>
      <input
        id="people-search"
        className="people-search"
        type="search"
        value={term}
        maxLength={64}
        autoComplete="off"
        placeholder="Search for someone…"
        onChange={(event) => setTerm(event.target.value)}
      />

      {failed ? (
        <p className="muted small">Could not load players. Try again.</p>
      ) : loading && cards.length === 0 ? (
        <p className="muted small">Looking…</p>
      ) : cards.length === 0 ? (
        <p className="muted small">
          {term.trim().length > 0 ? 'Nobody by that name.' : 'Nobody else is here right now.'}
        </p>
      ) : (
        <ul className="people-list" aria-label="Players">
          {cards.map((card) => {
            const badge = authorBadge(card.accountId ?? card.characterId);
            const picked = isPicked?.(card) ?? false;
            return (
              <li key={card.characterId} className="people-row">
                <span className="people-name">
                  {card.nickname}
                  {/* Nicknames are not unique, so the identity tag is what tells two of
                      them apart — the same one the Town Square shows. */}
                  <span className="identity-tag" style={{ color: `hsl(${badge.hue} 60% 40%)` }}>
                    <span className="sr-only">identity tag </span>#{badge.tag}
                  </span>
                  {card.groupName && <span className="people-group">{card.groupName}</span>}
                </span>
                {picked ? (
                  <span className="muted small">{pickedLabel}</span>
                ) : (
                  <button
                    type="button"
                    className="ghost small"
                    aria-label={`${actionLabel} ${card.nickname}`}
                    onClick={() => onPick(card)}
                  >
                    {actionLabel}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
