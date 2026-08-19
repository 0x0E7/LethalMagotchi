import { useEffect, useRef, useState } from 'react';
import type { Species, SpeciesId } from '@lethalmagotchi/shared';

const SPECIES_EMOJI: Record<string, string> = {
  dog: '🐕',
  cat: '🐈',
  horse: '🐎',
  cow: '🐄',
  lion: '🦁',
  fox: '🦊',
  wolf: '🐺',
  rabbit: '🐇',
  otter: '🦦',
  raccoon: '🦝',
  bear: '🐻',
  deer: '🦌',
  goat: '🐐',
  pig: '🐖',
  frog: '🐸',
  crow: '🐦‍⬛',
};

export function paceHints(species: Species): string[] {
  const { hunger, hygiene, energy, mood } = species.baseDecayRates;
  const hints: string[] = [];
  hints.push(hunger >= 4.4 ? 'Needs feeding often' : hunger <= 3.7 ? 'Rarely hungry' : 'Eats on schedule');
  hints.push(hygiene >= 3.4 ? 'Gets messy fast' : hygiene <= 2.7 ? 'Stays tidy' : 'Tidy enough');
  hints.push(energy <= 3.1 ? 'Sleeps a lot' : energy >= 3.8 ? 'Burns energy quickly' : 'Steady energy');
  hints.push(mood >= 3.4 ? 'Wants attention' : mood <= 2.8 ? 'Content alone' : 'Easygoing');
  return hints;
}

interface Props {
  species: Species[];
  selected: SpeciesId | undefined;
  onSelect: (id: SpeciesId) => void;
  onNext: () => void;
  loading: boolean;
}

export function SpeciesStep({ species, selected, onSelect, onNext, loading }: Props) {
  const [focusIndex, setFocusIndex] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selected) return;
    const index = species.findIndex((entry) => entry.id === selected);
    if (index >= 0) setFocusIndex(index);
  }, [selected, species]);

  const columns = 4;

  function moveFocus(next: number) {
    if (next < 0 || next >= species.length) return;
    setFocusIndex(next);
    const cards = gridRef.current?.querySelectorAll<HTMLButtonElement>('.species-card');
    cards?.[next]?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent) {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        moveFocus(focusIndex + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        moveFocus(focusIndex - 1);
        break;
      case 'ArrowDown':
        event.preventDefault();
        moveFocus(focusIndex + columns);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveFocus(focusIndex - columns);
        break;
      case 'Home':
        event.preventDefault();
        moveFocus(0);
        break;
      case 'End':
        event.preventDefault();
        moveFocus(species.length - 1);
        break;
      default:
        break;
    }
  }

  const detail = species.find((entry) => entry.id === selected) ?? null;

  return (
    <section className="step">
      <h2 tabIndex={-1} id="step-heading">
        Pick a species
      </h2>
      <p className="muted">Species is for life. Everything else you can change later.</p>

      {loading ? (
        <div className="species-grid" aria-hidden="true">
          {Array.from({ length: 16 }).map((_, index) => (
            <div key={index} className="species-card skeleton" />
          ))}
        </div>
      ) : (
        <div
          className="species-grid"
          role="radiogroup"
          aria-label="Species"
          ref={gridRef}
          onKeyDown={onKeyDown}
        >
          {species.map((entry, index) => {
            const isSelected = entry.id === selected;
            return (
              <button
                key={entry.id}
                type="button"
                role="radio"
                aria-checked={isSelected}
                tabIndex={index === focusIndex ? 0 : -1}
                className={isSelected ? 'species-card selected' : 'species-card'}
                onClick={() => {
                  setFocusIndex(index);
                  onSelect(entry.id);
                }}
                onFocus={() => setFocusIndex(index)}
              >
                <span className="species-art" aria-hidden="true">
                  {SPECIES_EMOJI[entry.id] ?? '❔'}
                </span>
                <span className="species-name">{entry.displayName}</span>
                <span className="species-flavor">{entry.flavor}</span>
                {isSelected && (
                  <span className="check-badge" aria-hidden="true">
                    ✓
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {detail && (
        <div className="detail-strip" aria-live="polite">
          <span className="detail-art" aria-hidden="true">
            {SPECIES_EMOJI[detail.id] ?? '❔'}
          </span>
          <div>
            <h3>{detail.displayName}</h3>
            <p className="muted">{detail.flavor}</p>
            <ul className="pace-hints">
              {paceHints(detail).map((hint) => (
                <li key={hint}>{hint}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <footer className="step-actions">
        <button type="button" className="primary" disabled={!selected} onClick={onNext}>
          Continue
        </button>
      </footer>
    </section>
  );
}
