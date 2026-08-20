import { STAT_DISPLAY_NAMES, clampStat, type CharacterStats, type StatId } from './stats.js';

export const ACTION_IDS = ['feed', 'shower', 'entertain', 'study', 'rest'] as const;

export type ActionId = (typeof ACTION_IDS)[number];

export const SHOP_ITEM_IDS = [
  'kibble',
  'hearty_meal',
  'feast',
  'yard_play',
  'read_a_book',
  'watch_a_movie',
  'night_out',
] as const;

export type ShopItemId = (typeof SHOP_ITEM_IDS)[number];

export type PickerActionId = Extract<ActionId, 'feed' | 'entertain'>;

export interface StatEffect {
  stat: StatId;
  op: 'add' | 'set';
  value: number;
}

export interface ShopItem {
  id: ShopItemId;
  actionId: PickerActionId;
  displayName: string;
  cost: number;
  effects: StatEffect[];
}

const add = (stat: StatId, value: number): StatEffect => ({ stat, op: 'add', value });
const set = (stat: StatId, value: number): StatEffect => ({ stat, op: 'set', value });

export const SHOP_ITEMS: ShopItem[] = [
  { id: 'kibble', actionId: 'feed', displayName: 'Kibble', cost: 1, effects: [add('hunger', 10)] },
  { id: 'hearty_meal', actionId: 'feed', displayName: 'Hearty meal', cost: 3, effects: [add('hunger', 30)] },
  {
    id: 'feast',
    actionId: 'feed',
    displayName: 'Feast',
    cost: 6,
    effects: [add('hunger', 65), add('mood', 5)],
  },
  {
    id: 'yard_play',
    actionId: 'entertain',
    displayName: 'Yard play',
    cost: 0,
    effects: [add('mood', 8), add('energy', -5)],
  },
  {
    id: 'read_a_book',
    actionId: 'entertain',
    displayName: 'Read a book',
    cost: 1,
    effects: [add('mood', 15), add('education', 2)],
  },
  {
    id: 'watch_a_movie',
    actionId: 'entertain',
    displayName: 'Watch a movie',
    cost: 2,
    effects: [add('mood', 30), add('energy', -5)],
  },
  {
    id: 'night_out',
    actionId: 'entertain',
    displayName: 'Night out',
    cost: 4,
    effects: [add('mood', 55), add('energy', -20), add('hunger', -15)],
  },
];

export const SHOP_ITEMS_BY_ID: Record<ShopItemId, ShopItem> = Object.fromEntries(
  SHOP_ITEMS.map((item) => [item.id, item]),
) as Record<ShopItemId, ShopItem>;

export function shopItemsFor(actionId: PickerActionId): ShopItem[] {
  return SHOP_ITEMS.filter((item) => item.actionId === actionId);
}

export const SHOWER_EFFECTS: StatEffect[] = [set('hygiene', 100)];
export const REST_EFFECTS: StatEffect[] = [add('energy', 30), add('hunger', -5)];
export const STUDY_SIDE_EFFECTS: StatEffect[] = [add('energy', -8), add('mood', -3)];
export const STUDY_BASE_GAIN = 12;

/** Diminishing returns near the cap, so `study` can never be spammed to 100. */
export function studyGain(education: number): number {
  return Math.max(0, STUDY_BASE_GAIN * (1 - clampStat(education) / 100));
}

export type CooldownKind = 'short' | 'rolling';

export interface CooldownSpec {
  kind: CooldownKind;
  seconds: number;
}

export const COOLDOWN_SPEC: Record<ActionId, CooldownSpec> = {
  feed: { kind: 'short', seconds: 60 },
  entertain: { kind: 'short', seconds: 120 },
  study: { kind: 'short', seconds: 900 },
  rest: { kind: 'short', seconds: 1800 },
  shower: { kind: 'rolling', seconds: 24 * 60 * 60 },
};

export interface ActionSpec {
  id: ActionId;
  displayName: string;
  shape: 'instant' | 'picker';
  icon: string;
}

export const ACTION_SPECS: Record<ActionId, ActionSpec> = {
  feed: { id: 'feed', displayName: 'Feed', shape: 'picker', icon: '🍽️' },
  shower: { id: 'shower', displayName: 'Shower', shape: 'instant', icon: '🚿' },
  entertain: { id: 'entertain', displayName: 'Entertain', shape: 'picker', icon: '🎈' },
  study: { id: 'study', displayName: 'Study', shape: 'instant', icon: '📚' },
  rest: { id: 'rest', displayName: 'Rest', shape: 'instant', icon: '🛏️' },
};

/** Dock order is fixed so keyboard/tab order and the 1-5 shortcuts stay stable. */
export const ACTION_ORDER: ActionId[] = ['feed', 'shower', 'entertain', 'study', 'rest'];

export const ACTION_ANIMATION_MS = {
  kibble: 2400,
  hearty_meal: 4500,
  feast: 8500,
  yard_play: 3500,
  read_a_book: 5000,
  watch_a_movie: 7500,
  night_out: 9500,
  shower: 6000,
  study: 5500,
  rest: 6500,
} as const;

export type ClipId = keyof typeof ACTION_ANIMATION_MS;

export interface ClipSpec {
  id: ClipId;
  icon: string;
  /** Completes "<Nickname> is ___" while the clip plays. */
  busyVerb: string;
}

export const CLIP_SPECS: Record<ClipId, ClipSpec> = {
  kibble: { id: 'kibble', icon: '🥣', busyVerb: 'eating' },
  hearty_meal: { id: 'hearty_meal', icon: '🍲', busyVerb: 'eating' },
  feast: { id: 'feast', icon: '🍖', busyVerb: 'feasting' },
  yard_play: { id: 'yard_play', icon: '⚽', busyVerb: 'playing' },
  read_a_book: { id: 'read_a_book', icon: '📖', busyVerb: 'reading' },
  watch_a_movie: { id: 'watch_a_movie', icon: '📺', busyVerb: 'watching a movie' },
  night_out: { id: 'night_out', icon: '🌃', busyVerb: 'out on the town' },
  shower: { id: 'shower', icon: '🚿', busyVerb: 'showering' },
  study: { id: 'study', icon: '✏️', busyVerb: 'studying' },
  rest: { id: 'rest', icon: '💤', busyVerb: 'resting' },
};

export function clipIdFor(action: ActionId, itemId: ShopItemId | null): ClipId {
  return itemId ?? (action as ClipId);
}

export function describeEffects(effects: StatEffect[]): string {
  return effects
    .map((effect) => {
      const name = STAT_DISPLAY_NAMES[effect.stat];
      if (effect.op === 'set') return `${name} to ${effect.value}`;
      return `${effect.value >= 0 ? '+' : '−'}${Math.abs(effect.value)} ${name}`;
    })
    .join(' · ');
}

export interface ActionSubject {
  stats: CharacterStats;
  lethalCoins: number;
  actionCooldowns: Record<string, string>;
}

export interface ActionRequest {
  action: ActionId;
  itemId?: ShopItemId | null;
}

export type ActionFailure =
  | { ok: false; reason: 'INVALID_ITEM' }
  | { ok: false; reason: 'ON_COOLDOWN'; kind: CooldownKind; retryAfterSeconds: number }
  | { ok: false; reason: 'INSUFFICIENT_FUNDS'; cost: number; missingCoins: number };

export interface ActionSuccess {
  ok: true;
  action: ActionId;
  itemId: ShopItemId | null;
  clipId: ClipId;
  stats: CharacterStats;
  lethalCoins: number;
  actionCooldowns: Record<string, string>;
  deltas: Partial<CharacterStats>;
  coinsSpent: number;
  cooldownEndsAt: string;
}

export type ActionOutcome = ActionSuccess | ActionFailure;

export function cooldownRemainingMs(
  actionCooldowns: Record<string, string>,
  action: ActionId,
  nowMs: number,
): number {
  const lastUsedAt = actionCooldowns[action];
  if (!lastUsedAt) return 0;
  const usedAt = Date.parse(lastUsedAt);
  if (!Number.isFinite(usedAt)) return 0;
  return Math.max(0, usedAt + COOLDOWN_SPEC[action].seconds * 1000 - nowMs);
}

function effectsFor(action: ActionId, itemId: ShopItemId | null, stats: CharacterStats): StatEffect[] | null {
  if (action === 'feed' || action === 'entertain') {
    if (!itemId) return null;
    const item = SHOP_ITEMS_BY_ID[itemId];
    if (!item || item.actionId !== action) return null;
    return item.effects;
  }
  if (itemId) return null;
  if (action === 'shower') return SHOWER_EFFECTS;
  if (action === 'rest') return REST_EFFECTS;
  return [add('education', studyGain(stats.education)), ...STUDY_SIDE_EFFECTS];
}

function costFor(action: ActionId, itemId: ShopItemId | null): number {
  if (action !== 'feed' && action !== 'entertain') return 0;
  return itemId ? (SHOP_ITEMS_BY_ID[itemId]?.cost ?? 0) : 0;
}

/**
 * Pure action resolution shared by the server (authoritative commit) and the client
 * (affordability/cooldown affordances). Callers pass stats already simulated to `nowMs`.
 */
export function resolveAction(
  subject: ActionSubject,
  request: ActionRequest,
  nowMs: number,
): ActionOutcome {
  const { action } = request;
  const itemId = request.itemId ?? null;

  const effects = effectsFor(action, itemId, subject.stats);
  if (!effects) return { ok: false, reason: 'INVALID_ITEM' };

  const remaining = cooldownRemainingMs(subject.actionCooldowns, action, nowMs);
  if (remaining > 0) {
    return {
      ok: false,
      reason: 'ON_COOLDOWN',
      kind: COOLDOWN_SPEC[action].kind,
      retryAfterSeconds: Math.ceil(remaining / 1000),
    };
  }

  const cost = costFor(action, itemId);
  if (cost > subject.lethalCoins) {
    return { ok: false, reason: 'INSUFFICIENT_FUNDS', cost, missingCoins: cost - subject.lethalCoins };
  }

  const stats: CharacterStats = { ...subject.stats };
  const deltas: Partial<CharacterStats> = {};
  for (const effect of effects) {
    const before = stats[effect.stat];
    stats[effect.stat] = clampStat(effect.op === 'set' ? effect.value : before + effect.value);
    deltas[effect.stat] = (deltas[effect.stat] ?? 0) + (stats[effect.stat] - before);
  }
  for (const stat of Object.keys(deltas) as StatId[]) {
    deltas[stat] = Math.round((deltas[stat] as number) * 100) / 100;
  }

  return {
    ok: true,
    action,
    itemId,
    clipId: clipIdFor(action, itemId),
    stats,
    lethalCoins: subject.lethalCoins - cost,
    actionCooldowns: { ...subject.actionCooldowns, [action]: new Date(nowMs).toISOString() },
    deltas,
    coinsSpent: cost,
    cooldownEndsAt: new Date(nowMs + COOLDOWN_SPEC[action].seconds * 1000).toISOString(),
  };
}
