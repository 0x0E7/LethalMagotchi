import { useEffect, useRef } from 'react';

export interface ReviewRow {
  label: string;
  value: string;
  step: 'species' | 'identity' | 'details';
  locked?: boolean;
}

interface Props {
  nickname: string;
  rows: ReviewRow[];
  submitting: boolean;
  error: string | null;
  onEdit: (step: 'species' | 'identity' | 'details') => void;
  onConfirm: () => void;
  onClose: () => void;
}

export function ReviewModal({ nickname, rows, submitting, error, onEdit, onConfirm, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusables = dialogRef.current?.querySelectorAll<HTMLElement>('button, [href], select, input');
    focusables?.[0]?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], select, input',
      );
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-title"
        ref={dialogRef}
      >
        <h2 id="review-title">Meet {nickname || 'your pet'}</h2>

        <dl className="review-rows">
          {rows.map((row) => (
            <div key={row.label} className="review-row">
              <dt>{row.label}</dt>
              <dd>
                <button type="button" className="link" onClick={() => onEdit(row.step)}>
                  {row.value || '—'}
                </button>
                {row.locked && <span className="chip">Chosen at creation</span>}
              </dd>
            </div>
          ))}
        </dl>

        {error && (
          <div className="banner error" role="alert">
            {error}
          </div>
        )}

        <div className="step-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Change something
          </button>
          <button type="button" className="primary" onClick={onConfirm} disabled={submitting}>
            {submitting && <span className="spinner" aria-hidden="true" />}
            Start raising {nickname || 'them'}
          </button>
        </div>
      </div>
    </div>
  );
}
