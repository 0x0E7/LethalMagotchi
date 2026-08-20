import { toDisplayStats, type CharacterStats, type DisplayStats } from '@lethalmagotchi/shared';

export const HUD_GROUPS: { label: string; keys: (keyof DisplayStats)[] }[] = [
  { label: 'Vitals', keys: ['hp', 'hunger', 'energy'] },
  { label: 'Care', keys: ['moral', 'clean'] },
];

const BAR_LABELS: Record<keyof DisplayStats, string> = {
  hp: 'HP',
  hunger: 'Hunger',
  energy: 'Energy',
  moral: 'Moral',
  clean: 'Clean',
  education: 'Education',
};

/**
 * Accessible names stay lowercase to match the accessible-name convention the rest of
 * the suite already queries stat meters by.
 */
const SPOKEN_LABELS: Record<keyof DisplayStats, string> = {
  hp: 'hp',
  hunger: 'hunger',
  energy: 'energy',
  moral: 'moral',
  clean: 'clean',
  education: 'education',
};

export type Urgency = 'ok' | 'caution' | 'critical';

export function urgencyOf(value: number): Urgency {
  if (value < 25) return 'critical';
  if (value < 60) return 'caution';
  return 'ok';
}

const URGENCY_WORDS: Record<Urgency, string> = {
  ok: '',
  caution: ', needs attention',
  critical: ', critical',
};

const URGENCY_GLYPHS: Record<Urgency, string> = { ok: '', caution: '!', critical: '⚠' };

function StatBar({ id, value }: { id: keyof DisplayStats; value: number }) {
  const rounded = Math.round(value);
  const urgency = urgencyOf(rounded);

  return (
    <div className={`stat stat-${urgency}`}>
      <span className="stat-label">
        {BAR_LABELS[id]}
        {urgency !== 'ok' && (
          <span className="stat-glyph" aria-hidden="true">
            {URGENCY_GLYPHS[urgency]}
          </span>
        )}
      </span>
      <span
        className="stat-bar"
        role="meter"
        aria-valuenow={rounded}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${SPOKEN_LABELS[id]}, ${rounded} percent${URGENCY_WORDS[urgency]}`}
      >
        <i style={{ width: `${rounded}%` }} />
      </span>
      <span className="stat-value" aria-hidden="true">
        {rounded}
      </span>
    </div>
  );
}

const EDUCATION_NOTCHES = 10;

function EducationMeter({ value }: { value: number }) {
  const rounded = Math.round(value);
  const filled = Math.round((rounded / 100) * EDUCATION_NOTCHES);

  return (
    <div className="stat education">
      <span className="stat-label">{BAR_LABELS.education}</span>
      <span
        className="notches"
        role="meter"
        aria-valuenow={rounded}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`education, ${rounded} percent`}
      >
        {Array.from({ length: EDUCATION_NOTCHES }).map((_, index) => (
          <i key={index} className={index < filled ? 'notch on' : 'notch'} />
        ))}
      </span>
      <span className="stat-value" aria-hidden="true">
        {rounded}
      </span>
    </div>
  );
}

interface Props {
  stats: CharacterStats;
  announcement: string;
}

export function Hud({ stats, announcement }: Props) {
  const display = toDisplayStats(stats);

  return (
    <section className="hud" aria-label="Pet status">
      <div className="hud-live sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

      {HUD_GROUPS.map((group) => (
        <div className="hud-group" key={group.label}>
          <h2 className="hud-group-label">{group.label}</h2>
          {group.keys.map((key) => (
            <StatBar key={key} id={key} value={display[key]} />
          ))}
          {group.label === 'Care' && <EducationMeter value={display.education} />}
        </div>
      ))}
    </section>
  );
}
