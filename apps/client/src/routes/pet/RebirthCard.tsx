import type { CharacterDto, RebirthCause } from '@lethalmagotchi/shared';
import { useTournament } from '../../tournament/TournamentProvider.js';

/**
 * What killed them. The reset copy is identical either way — a rebirth is a rebirth — but
 * the first line has to name the real cause, or a duel death reads as a care failure.
 */
const CAUSE_HEADINGS: Record<RebirthCause, (nickname: string) => string> = {
  tournament_entry_hp_exhausted: (nickname) => `${nickname} ran out of HP.`,
  duel_defeat: (nickname) => `${nickname} lost the duel.`,
  // Names what actually happened rather than the polite version. Nobody did this to them.
  neglect: (nickname) => `${nickname} was not looked after.`,
};

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
        <h2>{CAUSE_HEADINGS[rebirth.cause](character.nickname)}</h2>
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
