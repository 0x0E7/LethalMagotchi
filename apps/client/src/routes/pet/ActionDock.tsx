import { useEffect, useRef, useState } from 'react';
import {
  ACTION_ORDER,
  ACTION_SPECS,
  COOLDOWN_SPEC,
  cooldownRemainingMs,
  describeEffects,
  type ActionId,
  type ShopItem,
  type ShopItemId,
} from '@lethalmagotchi/shared';

export function formatDuration(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds >= 3600) return `${Math.ceil(seconds / 3600)}h`;
  if (seconds >= 60) return `${Math.ceil(seconds / 60)}m`;
  return `${seconds}s`;
}

function costLabel(cost: number): string {
  return cost === 0 ? 'Free' : `${cost} 🪙`;
}

interface TrayProps {
  actionId: 'feed' | 'entertain';
  items: ShopItem[];
  coins: number;
  onPick: (itemId: ShopItemId) => void;
  onClose: () => void;
  onUnaffordable: (item: ShopItem) => void;
}

function PickerTray({ actionId, items, coins, onPick, onClose, onUnaffordable }: TrayProps) {
  const trayRef = useRef<HTMLDivElement>(null);
  const affordable = items.filter((item) => item.cost <= coins);

  useEffect(() => {
    const buttons = trayRef.current?.querySelectorAll<HTMLButtonElement>('.tray-option');
    if (!buttons?.length) return;
    const cheapest = affordable.reduce<ShopItem | null>(
      (best, item) => (best === null || item.cost < best.cost ? item : best),
      null,
    );
    const index = cheapest ? items.findIndex((item) => item.id === cheapest.id) : 0;
    buttons[index]?.focus();
    // Intentionally once per tray opening: refocusing on every coin change would
    // yank focus mid-keyboard-navigation.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function onKeyDown(event: React.KeyboardEvent) {
    const buttons = Array.from(trayRef.current?.querySelectorAll<HTMLButtonElement>('.tray-option') ?? []);
    const index = buttons.findIndex((button) => button === document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
      buttons[(next + buttons.length) % buttons.length]?.focus();
    }
  }

  return (
    <div className="tray" role="menu" aria-label={`${ACTION_SPECS[actionId].displayName} options`} ref={trayRef} onKeyDown={onKeyDown}>
      {affordable.length === 0 && (
        <p className="tray-empty">
          Nothing here you can afford yet. Coins come back around — check the free options in the
          meantime.
        </p>
      )}
      {items.map((item) => {
        const canAfford = item.cost <= coins;
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={canAfford ? 'tray-option' : 'tray-option unaffordable'}
            // Deliberately not `aria-disabled`: an unaffordable option is still
            // interactive — activating it explains the shortfall — and claiming it is
            // disabled would tell assistive tech not to try the one control that does.
            // The shortfall is in the option's own text instead.
            onClick={() => (canAfford ? onPick(item.id) : onUnaffordable(item))}
          >
            <span className="tray-name">{item.displayName}</span>
            <span className="tray-effects">{describeEffects(item.effects)}</span>
            <span className="tray-cost">
              {canAfford ? costLabel(item.cost) : `${item.cost - coins} more coins`}
            </span>
          </button>
        );
      })}
    </div>
  );
}

interface Props {
  nickname: string;
  coins: number;
  shopItems: ShopItem[];
  actionCooldowns: Record<string, string>;
  now: number;
  busy: boolean;
  busyReason: string | null;
  note: string | null;
  onFire: (action: ActionId, itemId?: ShopItemId | null) => void;
  onNote: (note: string) => void;
}

export function ActionDock({
  nickname,
  coins,
  shopItems,
  actionCooldowns,
  now,
  busy,
  busyReason,
  note,
  onFire,
  onNote,
}: Props) {
  const [openTray, setOpenTray] = useState<'feed' | 'entertain' | null>(null);
  const dockRef = useRef<HTMLDivElement>(null);

  function closeTray() {
    const opener = openTray;
    setOpenTray(null);
    if (opener) {
      dockRef.current?.querySelector<HTMLButtonElement>(`[data-action="${opener}"]`)?.focus();
    }
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      const index = Number(event.key) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= ACTION_ORDER.length) return;
      dockRef.current?.querySelector<HTMLButtonElement>(`[data-action="${ACTION_ORDER[index]}"]`)?.click();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function activate(action: ActionId) {
    const remaining = cooldownRemainingMs(actionCooldowns, action, now);
    const spec = ACTION_SPECS[action];

    if (remaining > 0) {
      onNote(
        COOLDOWN_SPEC[action].kind === 'rolling'
          ? `${nickname} is still fresh from the last one. Ready again in ${formatDuration(remaining)}.`
          : `${nickname} just did that. Ready again in ${formatDuration(remaining)}.`,
      );
      return;
    }

    if (spec.shape === 'instant') {
      onFire(action);
      return;
    }
    setOpenTray((current) => (current === action ? null : (action as 'feed' | 'entertain')));
  }

  return (
    <div className="dock-wrap" ref={dockRef}>
      {note && <p className="dock-note">{note}</p>}
      {busyReason && <p className="dock-busy">{busyReason}</p>}

      <nav className="action-dock" aria-label="Actions" aria-busy={busy}>
        {ACTION_ORDER.map((action) => {
          const spec = ACTION_SPECS[action];
          const remaining = cooldownRemainingMs(actionCooldowns, action, now);
          const total = COOLDOWN_SPEC[action].seconds * 1000;
          const progress = remaining > 0 ? ((total - remaining) / total) * 100 : 100;
          const satisfied = remaining > 0 && COOLDOWN_SPEC[action].kind === 'rolling';
          const label = satisfied ? `Fresh · ${formatDuration(remaining)}` : spec.displayName;

          return (
            <div className="dock-slot" key={action}>
              <button
                type="button"
                data-action={action}
                className={[
                  'dock-button',
                  spec.shape,
                  remaining > 0 ? 'cooling' : '',
                  satisfied ? 'satisfied' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={{ ['--sweep' as string]: `${progress}%` }}
                aria-haspopup={spec.shape === 'picker' ? 'menu' : undefined}
                aria-expanded={spec.shape === 'picker' ? openTray === action : undefined}
                onClick={() => activate(action)}
              >
                <span className="dock-icon" aria-hidden="true">
                  {spec.icon}
                </span>
                <span className="dock-label">{label}</span>
                {spec.shape === 'picker' && (
                  <span className="dock-chevron" aria-hidden="true">
                    ⌃
                  </span>
                )}
              </button>

              {openTray === action && (
                <PickerTray
                  actionId={action as 'feed' | 'entertain'}
                  items={shopItems.filter((item) => item.actionId === action)}
                  coins={coins}
                  onPick={(itemId) => {
                    closeTray();
                    onFire(action, itemId);
                  }}
                  onClose={closeTray}
                  onUnaffordable={(item) =>
                    onNote(`${item.displayName} costs ${item.cost} coins — ${item.cost - coins} more needed.`)
                  }
                />
              )}
            </div>
          );
        })}
      </nav>
    </div>
  );
}
