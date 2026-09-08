import type { CharacterDto } from '@lethalmagotchi/shared';
import { useTournament } from '../../tournament/TournamentProvider.js';

/**
 * Placeholder for the phoenix sequence.
 *
 * The designed version is a ~6.4s 2.5D cinematic (slump, hold, ignite, ash bloom,
 * rebirth, settle) needing hand-authored flame frames and an ember emitter — real art
 * that does not exist yet. This is the same call the project already makes for species
 * art and pet action clips: ship the honest, calm placeholder now, keep the mechanic
 * fully real underneath. Tone stays sober-then-warm, and the words carry the whole
 * beat: what changed, what survived.
 */
export function RebirthCard({ character }: { character: CharacterDto }) {
  const { rebirth, dismissRebirth } = useTournament();
  if (!rebirth) return null;

  return (
    <div className="modal-backdrop still" role="dialog" aria-modal="true" aria-label={`${character.nickname} was reborn`}>
      <div className="card modal rebirth-card">
        <p className="rebirth-mark" aria-hidden="true">
          🕊️
        </p>
        <h2>{character.nickname} ran out of HP.</h2>
        <p>
          Their stats and coins have reset — everything else about them is exactly the same. Same
          name, same story, same {character.speciesId}.
        </p>
        <p className="muted small">
          {rebirth.rebirthIndex === 1 ? 'First rebirth' : `Rebirth number ${rebirth.rebirthIndex}`} ·
          HP back to 100 · {rebirth.coinsBefore} coins became 5
        </p>
        <button type="button" className="primary" onClick={dismissRebirth}>
          Got it
        </button>
      </div>
    </div>
  );
}
