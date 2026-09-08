import { useEffect, useRef, useState } from 'react';
import type { BettingAction, LegalActionsView } from '@lethalmagotchi/shared';

interface Props {
  legal: LegalActionsView;
  stack: number;
  potCoins: number;
  pending: boolean;
  onAct: (action: BettingAction, amount?: number) => void;
}

function label(action: BettingAction, legal: LegalActionsView, stack: number): string {
  switch (action) {
    case 'fold':
      return 'Fold';
    case 'check':
      return 'Check';
    case 'call':
      // A call that costs the whole stack is an all-in, and saying so is the difference
      // between an informed decision and a surprise.
      return legal.toCall >= stack ? `All in · ${legal.toCall}` : `Call ${legal.toCall}`;
    case 'bet':
      return 'Bet';
    case 'raise':
      return 'Raise';
    case 'allin':
      return `All in · ${legal.maxRaiseTo}`;
  }
}

/**
 * Reuses the action dock's geometry from the main screen so muscle memory transfers:
 * same button shape, same order, raise opening a tray rather than a modal.
 */
export function BettingBar({ legal, stack, potCoins, pending, onAct }: Props) {
  const raiseAction = legal.actions.includes('raise') ? 'raise' : legal.actions.includes('bet') ? 'bet' : null;
  const [trayOpen, setTrayOpen] = useState(false);
  const [amount, setAmount] = useState(legal.minRaiseTo);
  const trayRef = useRef<HTMLDivElement>(null);
  const raiseButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setAmount(legal.minRaiseTo);
    setTrayOpen(false);
  }, [legal.minRaiseTo, legal.maxRaiseTo]);

  // Same trap as the character-creation review modal: focus in, Escape out, Tab wraps.
  useEffect(() => {
    if (!trayOpen) return;
    trayRef.current?.querySelector('input')?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setTrayOpen(false);
        raiseButtonRef.current?.focus();
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = trayRef.current?.querySelectorAll<HTMLElement>(
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
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [trayOpen]);

  const presets = [
    { label: 'Min', value: legal.minRaiseTo },
    { label: '½ pot', value: Math.round(potCoins / 2) },
    { label: 'Pot', value: potCoins },
    { label: 'All in', value: legal.maxRaiseTo },
  ]
    .map((preset) => ({ ...preset, value: Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, preset.value)) }))
    .filter((preset, index, all) => all.findIndex((other) => other.value === preset.value) === index);

  return (
    <div className="bet-bar" role="group" aria-label="Your move">
      {legal.actions.includes('fold') && (
        <button
          type="button"
          className="bet-button fold"
          aria-keyshortcuts="f"
          disabled={pending}
          onClick={() => onAct('fold')}
        >
          Fold
        </button>
      )}

      {(['check', 'call'] as const)
        .filter((action) => legal.actions.includes(action))
        .map((action) => (
          <button
            key={action}
            type="button"
            className="bet-button primary-move"
            aria-keyshortcuts="c"
            disabled={pending}
            onClick={() => onAct(action)}
          >
            {label(action, legal, stack)}
          </button>
        ))}

      {raiseAction && (
        <div className="bet-slot">
          <button
            type="button"
            className="bet-button raise"
            aria-haspopup="dialog"
            aria-expanded={trayOpen}
            ref={raiseButtonRef}
            disabled={pending}
            onClick={() => setTrayOpen((open) => !open)}
          >
            {raiseAction === 'bet' ? 'Bet' : 'Raise'}
            <span className="bet-chevron" aria-hidden="true">
              ⌃
            </span>
          </button>

          {trayOpen && (
            <div
              className="bet-tray"
              role="dialog"
              aria-modal="true"
              aria-label="Choose an amount"
              ref={trayRef}
            >
              <div className="bet-presets">
                {presets.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    className={amount === preset.value ? 'bet-preset on' : 'bet-preset'}
                    onClick={() => setAmount(preset.value)}
                  >
                    {preset.label}
                    <span className="bet-preset-value">{preset.value}</span>
                  </button>
                ))}
              </div>

              <label className="bet-amount">
                <span className="sr-only">Total to put in, in coins</span>
                <input
                  type="range"
                  min={legal.minRaiseTo}
                  max={legal.maxRaiseTo}
                  step={1}
                  value={amount}
                  onChange={(event) => setAmount(Number(event.target.value))}
                />
                <output aria-live="off">{amount} coins</output>
              </label>

              <button
                type="button"
                className="bet-button confirm"
                disabled={pending}
                onClick={() => {
                  setTrayOpen(false);
                  onAct(raiseAction, amount);
                }}
              >
                {raiseAction === 'bet' ? 'Bet' : 'Raise to'} {amount}
              </button>
            </div>
          )}
        </div>
      )}

      {!raiseAction && legal.actions.includes('allin') && (
        <button type="button" className="bet-button raise" disabled={pending} onClick={() => onAct('allin')}>
          {label('allin', legal, stack)}
        </button>
      )}

      {/* Hidden where there is no keyboard to press, shown where the shortcuts work. */}
      <p className="bet-shortcuts">
        <kbd>F</kbd> fold · <kbd>C</kbd> check or call
      </p>
    </div>
  );
}
