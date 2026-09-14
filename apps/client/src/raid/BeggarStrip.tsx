import { useState } from 'react';
import { isBeggarWallet, type CharacterDto } from '@lethalmagotchi/shared';
import { ApiRequestError, api } from '../api/client.js';

/**
 * The beggar's own surface: the badge and the ask, shown only while they actually hold
 * nothing. Derived from the wallet on every render, so it appears at zero and vanishes on
 * the first coin with nothing to expire and nothing to sweep — and never during a raid,
 * where the zero is the raid's own escrow rather than poverty.
 */
export function BeggarStrip({ character }: { character: CharacterDto }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  if (!isBeggarWallet(character.lethalCoins, character.activeRaidId)) return null;

  const ask = (): void => {
    setState('sending');
    setError(null);
    void api
      .postAppeal()
      .then(() => setState('sent'))
      .catch((thrown: unknown) => {
        setState('idle');
        setError(thrown instanceof ApiRequestError ? thrown.message : 'Could not reach the server.');
      });
  };

  return (
    <div className="beggar-strip">
      <span className="beggar-badge">beggar</span>
      <button
        type="button"
        className="ghost small"
        disabled={state !== 'idle'}
        aria-busy={state === 'sending'}
        onClick={ask}
      >
        {state === 'sent' ? 'Asked in the Town Square' : 'Ask for donations'}
      </button>
      {error && (
        <span className="chat-note" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
