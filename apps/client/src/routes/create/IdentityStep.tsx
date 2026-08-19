import { BIO_MAX, NICKNAME_MAX, NICKNAME_MIN } from '@lethalmagotchi/shared';

interface Props {
  nickname: string;
  bio: string;
  errors: Record<string, string>;
  onChange: (patch: { nickname?: string; bio?: string }) => void;
  onBack: () => void;
  onNext: () => void;
}

export function IdentityStep({ nickname, bio, errors, onChange, onBack, onNext }: Props) {
  const nicknameOk = nickname.trim().length >= NICKNAME_MIN && nickname.trim().length <= NICKNAME_MAX;

  return (
    <section className="step">
      <h2 tabIndex={-1} id="step-heading">
        Who are they?
      </h2>
      <p className="muted">A name and a couple of lines. You can change both later.</p>

      <label className="field">
        <span className="field-label">Nickname</span>
        <input
          name="nickname"
          value={nickname}
          maxLength={NICKNAME_MAX}
          onChange={(event) => onChange({ nickname: event.target.value })}
          aria-invalid={Boolean(errors.nickname)}
        />
        <span className="field-hint">
          {nickname.trim().length}/{NICKNAME_MAX}
        </span>
        {errors.nickname && <span className="field-error">{errors.nickname}</span>}
      </label>

      <label className="field">
        <span className="field-label">Bio</span>
        <textarea
          name="bio"
          value={bio}
          rows={4}
          maxLength={BIO_MAX}
          onChange={(event) => onChange({ bio: event.target.value })}
          aria-invalid={Boolean(errors.bio)}
        />
        <span className={bio.length >= 260 ? 'field-hint warn' : 'field-hint'}>
          {bio.length}/{BIO_MAX}
        </span>
        {errors.bio && <span className="field-error">{errors.bio}</span>}
      </label>

      <footer className="step-actions">
        <button type="button" className="ghost" onClick={onBack}>
          Back
        </button>
        <button type="button" className="primary" disabled={!nicknameOk} onClick={onNext}>
          Continue
        </button>
      </footer>
    </section>
  );
}
