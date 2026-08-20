import { CLIP_SPECS, type CharacterDto } from '@lethalmagotchi/shared';
import { speciesArt } from '../../species-art.js';
import type { Playing } from './useActionMachine.js';

interface Props {
  character: CharacterDto;
  playing: Playing | null;
  skipOffered: boolean;
  onSkip: () => void;
}

/**
 * Placeholder staging: the cutout rig and per-species atlases do not exist yet, so a
 * clip is an emoji prop plus a CSS motion whose duration is the real per-item duration
 * from the catalog. The state machine and timing are the shipping ones; only the art
 * is a stand-in.
 */
export function PetStage({ character, playing, skipOffered, onSkip }: Props) {
  const clip = playing ? CLIP_SPECS[playing.clipId] : null;
  const activity = clip ? `${character.nickname} is ${clip.busyVerb}` : `${character.nickname} is idle`;

  const stageClass = [
    'pet-stage',
    playing ? `playing clip-${playing.clipId}` : 'idle',
    playing?.mode === 'still' ? 'still' : '',
    playing?.settling ? 'settling' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={stageClass}
      style={playing ? { ['--clip-duration' as string]: `${playing.durationMs}ms` } : undefined}
      onClick={skipOffered ? onSkip : undefined}
    >
      <div className="pet-figure" role="img" aria-label={activity}>
        <span className="pet-art" aria-hidden="true">
          {speciesArt(character.speciesId)}
        </span>
        {clip && (
          <span className="pet-prop" aria-hidden="true">
            {clip.icon}
          </span>
        )}
      </div>

      {skipOffered && (
        <button type="button" className="skip-pill" onClick={onSkip}>
          Tap to skip
        </button>
      )}
    </div>
  );
}
