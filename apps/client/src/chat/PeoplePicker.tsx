import { useEffect, useState } from 'react';
import { authorBadge, type DuelCardDto } from '@lethalmagotchi/shared';
import { api } from '../api/client.js';

/** Long enough that typing a name is one request, short enough to feel immediate. */
const SEARCH_DEBOUNCE_MS = 250;

export interface PickerAction {
  /** Verb on the button — "Message", "Duel", "Add". */
  label: string;
  onPick: (card: DuelCardDto) => void;
  /**
   * Why this action cannot be taken on this row, or null when it can.
   *
   * Returning a reason greys the button out and prints the reason beside it, rather than
   * removing either. That is deliberate: a silently absent button is indistinguishable from
   * a feature that does not exist, which is exactly how "there is no way to duel anyone"
   * happens.
   */
  unavailable?: (card: DuelCardDto) => string | null;
}

interface Props {
  actions: PickerAction[];
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
export function PeoplePicker({ actions }: Props) {
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
                <span className="people-actions">
                  {actions.map((action) => {
                    const why = action.unavailable?.(card) ?? null;
                    return (
                      <span key={action.label} className="people-action">
                        <button
                          type="button"
                          className="ghost small"
                          disabled={why !== null}
                          // The reason rides the label rather than only the text beside it,
                          // so a screen reader hears why the button is dead instead of just
                          // that it is.
                          aria-label={
                            why === null
                              ? `${action.label} ${card.nickname}`
                              : `${action.label} ${card.nickname} — unavailable: ${why}`
                          }
                          onClick={() => action.onPick(card)}
                        >
                          {action.label}
                        </button>
                        {why !== null && (
                          <span className="muted small people-why" aria-hidden="true">
                            {why}
                          </span>
                        )}
                      </span>
                    );
                  })}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
