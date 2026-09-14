import { useEffect, useRef, useState } from 'react';
import type { DuelCardDto } from '@lethalmagotchi/shared';
import { ApiRequestError, api } from '../api/client.js';
import { useSession } from '../session/SessionProvider.js';

/**
 * The amount picker, and the one sentence that is easy to get wrong: the first coin received
 * lifts the beggar state, so a donation of any size is the whole rescue. A donor who expects
 * to be one of several small gifts has misunderstood what they are about to do.
 */
export function DonateDialog({ card, onClose }: { card: DuelCardDto; onClose: () => void }) {
  const { character, setCharacter } = useSession();
  const [coins, setCoins] = useState(1);
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const available = character?.lethalCoins ?? 0;
  const canSend = state === 'idle' && coins >= 1 && coins <= available;

  const send = (): void => {
    setState('sending');
    setError(null);
    void api
      .donate(card.characterId, coins)
      .then((response) => {
        setCharacter(response.character);
        setState('sent');
      })
      .catch((thrown: unknown) => {
        setState('idle');
        setError(
          thrown instanceof ApiRequestError ? thrown.message : 'Could not reach the server. Try again.',
        );
      });
  };

  return (
    <div className="modal-backdrop still" role="dialog" aria-modal="true" aria-labelledby="donate-heading">
      <div className="card modal">
        <h2 id="donate-heading">Give {card.nickname} some coins?</h2>

        {state === 'sent' ? (
          <p role="status">
            {coins} LC sent. {card.nickname} is not begging any more.
          </p>
        ) : (
          <>
            <p className="muted small">
              <strong>This ends their begging.</strong> The first coin they receive lifts the
              state, so nobody else can give to them after you until they are broke again.
            </p>

            <label htmlFor="donate-coins">How many LethalCoins</label>
            <input
              id="donate-coins"
              name="donateCoins"
              type="number"
              min={1}
              max={Math.max(1, available)}
              value={coins}
              onChange={(event) => setCoins(Math.max(1, Math.floor(Number(event.target.value) || 1)))}
            />
            <p className="muted small">You have {available} LC.</p>

            {error && (
              <p className="chat-note" role="alert">
                {error}
              </p>
            )}
          </>
        )}

        <div className="duel-stakes-actions">
          <button type="button" className="primary" ref={closeRef} onClick={onClose}>
            {state === 'sent' ? 'Close' : 'Not now'}
          </button>
          {state !== 'sent' && (
            <button
              type="button"
              className="ghost"
              disabled={!canSend}
              aria-busy={state === 'sending'}
              onClick={send}
            >
              Send {coins} LC
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
