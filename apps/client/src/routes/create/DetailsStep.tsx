import {
  CITY_MAX,
  type Country,
  type Occupation,
  type OccupationId,
  type Personality,
  type PersonalityId,
} from '@lethalmagotchi/shared';

interface Props {
  countries: Country[];
  occupations: Occupation[];
  personalities: Personality[];
  originCountry: string;
  originCity: string;
  occupationId: string;
  personalityId: string;
  errors: Record<string, string>;
  onChange: (patch: {
    originCountry?: string;
    originCity?: string;
    occupationId?: OccupationId;
    personalityId?: PersonalityId;
  }) => void;
  onBack: () => void;
  onReview: () => void;
}

export function DetailsStep({
  countries,
  occupations,
  personalities,
  originCountry,
  originCity,
  occupationId,
  personalityId,
  errors,
  onChange,
  onBack,
  onReview,
}: Props) {
  const complete = Boolean(originCountry && occupationId && personalityId);

  return (
    <section className="step">
      <h2 tabIndex={-1} id="step-heading">
        A few details
      </h2>
      <p className="muted">Flavor for now — all of it is editable later.</p>

      <div className="grid-2">
        <label className="field">
          <span className="field-label">Country of origin</span>
          <select
            name="originCountry"
            value={originCountry}
            onChange={(event) => onChange({ originCountry: event.target.value })}
            aria-invalid={Boolean(errors.originCountry)}
          >
            <option value="">Choose a country</option>
            {countries.map((country) => (
              <option key={country.code} value={country.code}>
                {country.displayName}
              </option>
            ))}
          </select>
          {errors.originCountry && <span className="field-error">{errors.originCountry}</span>}
        </label>

        <label className="field">
          <span className="field-label">Home city (optional)</span>
          <input
            name="originCity"
            value={originCity}
            maxLength={CITY_MAX}
            onChange={(event) => onChange({ originCity: event.target.value })}
            aria-invalid={Boolean(errors.originCity)}
          />
          {errors.originCity && <span className="field-error">{errors.originCity}</span>}
        </label>

        <label className="field">
          <span className="field-label">Occupation</span>
          <select
            name="occupationId"
            value={occupationId}
            onChange={(event) => onChange({ occupationId: event.target.value as OccupationId })}
            aria-invalid={Boolean(errors.occupationId)}
          >
            <option value="">Choose an occupation</option>
            {occupations.map((occupation) => (
              <option key={occupation.id} value={occupation.id}>
                {occupation.displayName}
              </option>
            ))}
          </select>
          {errors.occupationId && <span className="field-error">{errors.occupationId}</span>}
        </label>

        <label className="field">
          <span className="field-label">Personality</span>
          <select
            name="personalityId"
            value={personalityId}
            onChange={(event) => onChange({ personalityId: event.target.value as PersonalityId })}
            aria-invalid={Boolean(errors.personalityId)}
          >
            <option value="">Choose a personality</option>
            {personalities.map((personality) => (
              <option key={personality.id} value={personality.id}>
                {personality.displayName}
              </option>
            ))}
          </select>
          {errors.personalityId && <span className="field-error">{errors.personalityId}</span>}
        </label>
      </div>

      <footer className="step-actions">
        <button type="button" className="ghost" onClick={onBack}>
          Back
        </button>
        <button type="button" className="primary" disabled={!complete} onClick={onReview}>
          Review
        </button>
      </footer>
    </section>
  );
}
