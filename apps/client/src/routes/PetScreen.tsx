import { useLocation } from 'react-router-dom';
import type { CharacterDto } from '@lethalmagotchi/shared';
import { useReference } from '../hooks/useReference.js';
import { useSession } from '../session/SessionProvider.js';

export function PetScreen({ character }: { character: CharacterDto }) {
  const { account, logout } = useSession();
  const { data: reference } = useReference();
  const location = useLocation();
  const toast = (location.state as { toast?: string } | null)?.toast;

  const species = reference?.species.find((entry) => entry.id === character.speciesId);
  const occupation = reference?.occupations.find((entry) => entry.id === character.occupationId);
  const personality = reference?.personalities.find((entry) => entry.id === character.personalityId);
  const country = reference?.countries.find((entry) => entry.code === character.originCountry);

  const subtitle = [
    occupation?.displayName,
    [character.originCity, country?.displayName].filter(Boolean).join(', '),
  ]
    .filter(Boolean)
    .join(' from ');

  return (
    <div className="pet-layout">
      <header className="pet-header">
        <span className="brand">LethalMagotchi</span>
        <div className="pet-header-right">
          <span className="muted small">{account?.username}</span>
          <button type="button" className="ghost small" onClick={() => void logout()}>
            Log out
          </button>
        </div>
      </header>

      {toast && (
        <div className="banner" role="status">
          {toast}
        </div>
      )}

      <main className="card pet-card">
        <h1>You&apos;re all set.</h1>
        <p className="muted">
          {character.nickname} is settling in. The pet-care screen is still being designed — this is a
          placeholder for it.
        </p>

        <section className="pet-summary">
          <h2>{character.nickname}</h2>
          <p className="pet-subtitle">
            {species?.displayName ?? character.speciesId}
            {subtitle ? ` · ${subtitle}` : ''}
            {personality ? ` · ${personality.displayName}` : ''}
          </p>
          {character.bio && <p className="pet-bio">{character.bio}</p>}
        </section>

        <section className="stats">
          {(['hunger', 'hygiene', 'energy', 'mood'] as const).map((key) => (
            <div key={key} className="stat">
              <span className="stat-label">{key}</span>
              <span
                className="stat-bar"
                role="meter"
                aria-valuenow={character.stats[key]}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${key} ${character.stats[key]} of 100`}
              >
                <i style={{ width: `${character.stats[key]}%` }} />
              </span>
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}
