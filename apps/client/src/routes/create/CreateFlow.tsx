import { useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import type { CharacterCreateInput, OccupationId, PersonalityId, SpeciesId } from '@lethalmagotchi/shared';
import { ApiRequestError, api } from '../../api/client.js';
import { useReference } from '../../hooks/useReference.js';
import { useSession } from '../../session/SessionProvider.js';
import { DetailsStep } from './DetailsStep.js';
import { IdentityStep } from './IdentityStep.js';
import { ReviewModal, type ReviewRow } from './ReviewModal.js';
import { SpeciesStep } from './SpeciesStep.js';
import { clearDraft, loadDraft, saveDraft, type Draft } from './draft.js';

const STEPS = ['species', 'identity', 'details'] as const;
type Step = (typeof STEPS)[number];

const STEP_TITLES: Record<Step, string> = {
  species: 'Species',
  identity: 'Identity',
  details: 'Details',
};

const FIELD_STEP: Record<string, Step> = {
  speciesId: 'species',
  nickname: 'identity',
  bio: 'identity',
  originCountry: 'details',
  originCity: 'details',
  occupationId: 'details',
  personalityId: 'details',
};

export function CreateFlow() {
  const params = useParams();
  const navigate = useNavigate();
  const { setCharacter } = useSession();
  const { data: reference, error: referenceError } = useReference();

  const [draft, setDraft] = useState<Draft>(() => loadDraft());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [reviewOpen, setReviewOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const headingRef = useRef<HTMLDivElement>(null);

  const step = (params.step ?? 'species') as Step;
  const stepIndex = STEPS.indexOf(step);

  useEffect(() => {
    saveDraft(draft);
  }, [draft]);

  useEffect(() => {
    const heading = headingRef.current?.querySelector<HTMLElement>('#step-heading');
    heading?.focus();
  }, [step]);

  if (!STEPS.includes(step)) return <Navigate to="/create/species" replace />;

  function update(patch: Draft) {
    setDraft((current) => ({ ...current, ...patch }));
    setErrors((current) => {
      const next = { ...current };
      for (const key of Object.keys(patch)) delete next[key];
      return next;
    });
  }

  function goto(next: Step) {
    navigate(`/create/${next}`);
  }

  async function submit() {
    if (!draft.speciesId || !draft.nickname || !draft.originCountry || !draft.occupationId || !draft.personalityId) {
      return;
    }
    setSubmitting(true);
    setSubmitError(null);

    const payload: CharacterCreateInput = {
      speciesId: draft.speciesId as SpeciesId,
      nickname: draft.nickname,
      bio: draft.bio ?? '',
      originCountry: draft.originCountry,
      originCity: draft.originCity?.trim() ? draft.originCity : null,
      occupationId: draft.occupationId as OccupationId,
      personalityId: draft.personalityId as PersonalityId,
    };

    try {
      const { character } = await api.createCharacter(payload);
      clearDraft();
      setCharacter(character);
      navigate('/pet', { replace: true });
    } catch (error) {
      if (error instanceof ApiRequestError) {
        if (error.code === 'CHARACTER_EXISTS') {
          const me = await api.me().catch(() => null);
          if (me?.character) {
            clearDraft();
            setCharacter(me.character);
            navigate('/pet', { replace: true });
            return;
          }
        }
        const fieldEntries = Object.entries(error.fields);
        if (fieldEntries.length > 0) {
          setErrors(error.fields);
          const owningStep = FIELD_STEP[fieldEntries[0]![0]] ?? 'identity';
          setReviewOpen(false);
          goto(owningStep);
          return;
        }
        setSubmitError(error.message);
      } else {
        setSubmitError((error as Error).message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const species = reference?.species ?? [];
  const selectedSpecies = species.find((entry) => entry.id === draft.speciesId);
  const occupation = reference?.occupations.find((entry) => entry.id === draft.occupationId);
  const personality = reference?.personalities.find((entry) => entry.id === draft.personalityId);
  const country = reference?.countries.find((entry) => entry.code === draft.originCountry);

  const reviewRows: ReviewRow[] = [
    { label: 'Species', value: selectedSpecies?.displayName ?? '', step: 'species', locked: true },
    { label: 'Nickname', value: draft.nickname ?? '', step: 'identity' },
    { label: 'Bio', value: draft.bio ?? '', step: 'identity' },
    {
      label: 'From',
      value: [draft.originCity, country?.displayName].filter(Boolean).join(', '),
      step: 'details',
    },
    { label: 'Occupation', value: occupation?.displayName ?? '', step: 'details' },
    { label: 'Personality', value: personality?.displayName ?? '', step: 'details' },
  ];

  return (
    <div className="create-layout" ref={headingRef}>
      <header className="progress-rail">
        <span className="brand">LethalMagotchi</span>
        <ol>
          {STEPS.map((entry, index) => (
            <li key={entry} className={index === stepIndex ? 'current' : index < stepIndex ? 'done' : ''}>
              <span className="dot">{index + 1}</span>
              {STEP_TITLES[entry]}
            </li>
          ))}
        </ol>
      </header>

      <p className="sr-only" aria-live="polite">
        {`Step ${stepIndex + 1} of 3, ${STEP_TITLES[step]}`}
      </p>

      {referenceError && (
        <div className="banner error" role="alert">
          Could not load character options: {referenceError}
        </div>
      )}

      <main className="card create-card">
        {step === 'species' && (
          <SpeciesStep
            species={species}
            selected={draft.speciesId as SpeciesId | undefined}
            loading={!reference && !referenceError}
            onSelect={(id) => update({ speciesId: id })}
            onNext={() => goto('identity')}
          />
        )}

        {step === 'identity' && (
          <IdentityStep
            nickname={draft.nickname ?? ''}
            bio={draft.bio ?? ''}
            errors={errors}
            onChange={update}
            onBack={() => goto('species')}
            onNext={() => goto('details')}
          />
        )}

        {step === 'details' && (
          <DetailsStep
            countries={reference?.countries ?? []}
            occupations={reference?.occupations ?? []}
            personalities={reference?.personalities ?? []}
            originCountry={draft.originCountry ?? ''}
            originCity={draft.originCity ?? ''}
            occupationId={draft.occupationId ?? ''}
            personalityId={draft.personalityId ?? ''}
            errors={errors}
            onChange={update}
            onBack={() => goto('identity')}
            onReview={() => setReviewOpen(true)}
          />
        )}
      </main>

      {reviewOpen && (
        <ReviewModal
          nickname={draft.nickname ?? ''}
          rows={reviewRows}
          submitting={submitting}
          error={submitError}
          onEdit={(target) => {
            setReviewOpen(false);
            goto(target);
          }}
          onConfirm={() => void submit()}
          onClose={() => setReviewOpen(false)}
        />
      )}
    </div>
  );
}
