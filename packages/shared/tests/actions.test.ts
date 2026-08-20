import { describe, expect, it } from 'vitest';
import {
  ACTION_ANIMATION_MS,
  ACTION_IDS,
  ACTION_ORDER,
  ACTION_SPECS,
  CLIP_SPECS,
  COOLDOWN_SPEC,
  SHOP_ITEMS,
  SHOP_ITEMS_BY_ID,
  SHOP_ITEM_IDS,
  STUDY_BASE_GAIN,
  clipIdFor,
  cooldownRemainingMs,
  describeEffects,
  resolveAction,
  shopItemsFor,
  studyGain,
  type ActionId,
  type ActionRequest,
  type ActionSubject,
  type ActionSuccess,
  type ShopItemId,
} from '../src/actions.js';
import { STARTING_STATS, type CharacterStats } from '../src/stats.js';

const NOW = Date.parse('2026-08-18T12:00:00.000Z');

function subject(overrides: Partial<ActionSubject> = {}): ActionSubject {
  return {
    stats: { ...STARTING_STATS },
    lethalCoins: 10,
    actionCooldowns: {},
    ...overrides,
  };
}

function withStats(stats: Partial<CharacterStats>, overrides: Partial<ActionSubject> = {}): ActionSubject {
  return subject({ stats: { ...STARTING_STATS, ...stats }, ...overrides });
}

/** Narrows to the success shape so tests read as assertions, not type guards. */
function succeed(input: ActionSubject, request: ActionRequest, nowMs = NOW): ActionSuccess {
  const outcome = resolveAction(input, request, nowMs);
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.reason}`);
  return outcome;
}

function usedAgo(action: ActionId, secondsAgo: number): Record<string, string> {
  return { [action]: new Date(NOW - secondsAgo * 1000).toISOString() };
}

describe('shop catalog', () => {
  it('exposes exactly the item ids the schema allow-list validates against', () => {
    expect(SHOP_ITEMS.map((item) => item.id).sort()).toEqual([...SHOP_ITEM_IDS].sort());
  });

  it('files every item under a picker action', () => {
    for (const item of SHOP_ITEMS) {
      expect(ACTION_SPECS[item.actionId].shape).toBe('picker');
    }
  });

  it('offers at least one free option per picker action so a broke player is never stuck', () => {
    expect(shopItemsFor('entertain').some((item) => item.cost === 0)).toBe(true);
  });

  it('never prices an item negatively', () => {
    for (const item of SHOP_ITEMS) expect(item.cost).toBeGreaterThanOrEqual(0);
  });

  it('keeps the dock order aligned with the action list the 1-5 shortcuts index into', () => {
    expect([...ACTION_ORDER].sort()).toEqual([...ACTION_IDS].sort());
    expect(ACTION_ORDER).toHaveLength(ACTION_IDS.length);
  });

  it('describes effects with signed stat deltas and set-values in words', () => {
    expect(describeEffects(SHOP_ITEMS_BY_ID.night_out.effects)).toBe('+55 Moral · −20 Energy · −15 Hunger');
    expect(describeEffects([{ stat: 'hygiene', op: 'set', value: 100 }])).toBe('Clean to 100');
  });
});

describe('animation catalog', () => {
  it('pins each clip to the duration the design table specifies', () => {
    expect(ACTION_ANIMATION_MS).toEqual({
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
    });
  });

  it('keeps every clip inside the ~10 second product ceiling', () => {
    for (const duration of Object.values(ACTION_ANIMATION_MS)) {
      expect(duration).toBeGreaterThan(0);
      expect(duration).toBeLessThanOrEqual(10_000);
    }
  });

  it('varies durations, so a snack does not read like a feast', () => {
    expect(ACTION_ANIMATION_MS.kibble).toBeLessThan(ACTION_ANIMATION_MS.feast);
    expect(new Set(Object.values(ACTION_ANIMATION_MS)).size).toBeGreaterThan(5);
  });

  it('has a clip spec, and therefore a busy verb, for every clip duration', () => {
    expect(Object.keys(CLIP_SPECS).sort()).toEqual(Object.keys(ACTION_ANIMATION_MS).sort());
    for (const spec of Object.values(CLIP_SPECS)) expect(spec.busyVerb.length).toBeGreaterThan(0);
  });

  it('maps picker actions to their item clip and instant actions to their own', () => {
    expect(clipIdFor('feed', 'feast')).toBe('feast');
    expect(clipIdFor('shower', null)).toBe('shower');
  });
});

describe('studyGain', () => {
  it('gives the full base gain to a pet that knows nothing', () => {
    expect(studyGain(0)).toBeCloseTo(STUDY_BASE_GAIN, 10);
  });

  it('diminishes as education approaches the cap', () => {
    expect(studyGain(50)).toBeCloseTo(STUDY_BASE_GAIN * 0.5, 10);
    expect(studyGain(90)).toBeLessThan(studyGain(50));
  });

  it('gives nothing at the cap, so study can never push education past 100', () => {
    expect(studyGain(100)).toBe(0);
  });

  it('never returns a negative gain for an out-of-range value', () => {
    expect(studyGain(150)).toBe(0);
    expect(studyGain(-20)).toBeCloseTo(STUDY_BASE_GAIN, 10);
  });
});

describe('cooldownRemainingMs', () => {
  it('reports zero for an action never used', () => {
    expect(cooldownRemainingMs({}, 'feed', NOW)).toBe(0);
  });

  it('counts down from the last use', () => {
    expect(cooldownRemainingMs(usedAgo('feed', 20), 'feed', NOW)).toBe(40_000);
  });

  it('reports zero the instant the window closes', () => {
    expect(cooldownRemainingMs(usedAgo('feed', COOLDOWN_SPEC.feed.seconds), 'feed', NOW)).toBe(0);
  });

  it('never reports a negative remainder for a long-expired cooldown', () => {
    expect(cooldownRemainingMs(usedAgo('shower', 7 * 24 * 3600), 'shower', NOW)).toBe(0);
  });

  it('ignores an unparseable stored timestamp rather than locking the action forever', () => {
    expect(cooldownRemainingMs({ feed: 'yesterday-ish' }, 'feed', NOW)).toBe(0);
  });
});

describe('resolveAction — item validation', () => {
  it('rejects a picker action fired without an item', () => {
    expect(resolveAction(subject(), { action: 'feed' }, NOW)).toEqual({ ok: false, reason: 'INVALID_ITEM' });
  });

  it('rejects an item that belongs to a different action', () => {
    expect(resolveAction(subject(), { action: 'feed', itemId: 'yard_play' }, NOW)).toEqual({
      ok: false,
      reason: 'INVALID_ITEM',
    });
  });

  it('rejects an item attached to an instant action', () => {
    expect(resolveAction(subject(), { action: 'shower', itemId: 'kibble' }, NOW)).toEqual({
      ok: false,
      reason: 'INVALID_ITEM',
    });
  });

  it('rejects an id that is not in the catalog at all', () => {
    const outcome = resolveAction(subject(), { action: 'feed', itemId: 'golden_steak' as ShopItemId }, NOW);
    expect(outcome).toEqual({ ok: false, reason: 'INVALID_ITEM' });
  });

  it('treats a null item on an instant action as "no item", not as invalid', () => {
    expect(succeed(subject(), { action: 'rest', itemId: null }).ok).toBe(true);
  });

  it('reports an invalid item before spending a cooldown or coins', () => {
    // Validation order matters: a mis-sent item must never burn the cooldown.
    const outcome = resolveAction(
      withStats({}, { lethalCoins: 0, actionCooldowns: usedAgo('feed', 1) }),
      { action: 'feed', itemId: 'yard_play' },
      NOW,
    );
    expect(outcome).toEqual({ ok: false, reason: 'INVALID_ITEM' });
  });
});

describe('resolveAction — cooldowns', () => {
  it('blocks a short-cooldown action still inside its window', () => {
    const outcome = resolveAction(
      subject({ actionCooldowns: usedAgo('entertain', 30) }),
      { action: 'entertain', itemId: 'yard_play' },
      NOW,
    );

    expect(outcome).toEqual({
      ok: false,
      reason: 'ON_COOLDOWN',
      kind: 'short',
      retryAfterSeconds: COOLDOWN_SPEC.entertain.seconds - 30,
    });
  });

  it('reports the shower as a rolling cooldown so the UI can word it as "already done today"', () => {
    const outcome = resolveAction(
      subject({ actionCooldowns: usedAgo('shower', 3600) }),
      { action: 'shower' },
      NOW,
    );

    expect(outcome).toMatchObject({ ok: false, reason: 'ON_COOLDOWN', kind: 'rolling' });
  });

  it('rounds a partial second up, so the client never advertises "0s" while still blocked', () => {
    const outcome = resolveAction(
      subject({ actionCooldowns: { feed: new Date(NOW - 59_500).toISOString() } }),
      { action: 'feed', itemId: 'kibble' },
      NOW,
    );

    expect(outcome).toMatchObject({ reason: 'ON_COOLDOWN', retryAfterSeconds: 1 });
  });

  it('allows the action the moment the window closes', () => {
    const at = usedAgo('feed', COOLDOWN_SPEC.feed.seconds);
    expect(succeed(subject({ actionCooldowns: at }), { action: 'feed', itemId: 'kibble' }).ok).toBe(true);
  });

  it('keeps cooldowns per action, so feeding does not block a shower', () => {
    const outcome = succeed(subject({ actionCooldowns: usedAgo('feed', 1) }), { action: 'shower' });
    expect(outcome.actionCooldowns.feed).toBe(usedAgo('feed', 1).feed);
    expect(outcome.actionCooldowns.shower).toBe(new Date(NOW).toISOString());
  });

  it('reports the cooldown before the price, so a broke player is told the real blocker first', () => {
    const outcome = resolveAction(
      subject({ lethalCoins: 0, actionCooldowns: usedAgo('feed', 1) }),
      { action: 'feed', itemId: 'feast' },
      NOW,
    );
    expect(outcome).toMatchObject({ reason: 'ON_COOLDOWN' });
  });

  it('stamps the cooldown end at exactly the spec duration from now', () => {
    const outcome = succeed(subject(), { action: 'study' });
    expect(Date.parse(outcome.cooldownEndsAt) - NOW).toBe(COOLDOWN_SPEC.study.seconds * 1000);
  });
});

describe('resolveAction — pricing', () => {
  it('charges the catalog price and leaves the rest of the wallet alone', () => {
    const outcome = succeed(subject({ lethalCoins: 10 }), { action: 'feed', itemId: 'hearty_meal' });
    expect(outcome.coinsSpent).toBe(SHOP_ITEMS_BY_ID.hearty_meal.cost);
    expect(outcome.lethalCoins).toBe(10 - SHOP_ITEMS_BY_ID.hearty_meal.cost);
  });

  it('allows a purchase that spends the wallet down to exactly zero', () => {
    const outcome = succeed(subject({ lethalCoins: 6 }), { action: 'feed', itemId: 'feast' });
    expect(outcome.lethalCoins).toBe(0);
  });

  it('refuses a purchase one coin short and says how many are missing', () => {
    expect(resolveAction(subject({ lethalCoins: 5 }), { action: 'feed', itemId: 'feast' }, NOW)).toEqual({
      ok: false,
      reason: 'INSUFFICIENT_FUNDS',
      cost: 6,
      missingCoins: 1,
    });
  });

  it('lets a broke player still take the free entertain option', () => {
    const outcome = succeed(subject({ lethalCoins: 0 }), { action: 'entertain', itemId: 'yard_play' });
    expect(outcome.coinsSpent).toBe(0);
    expect(outcome.lethalCoins).toBe(0);
  });

  it('never charges for an instant action', () => {
    for (const action of ['shower', 'study', 'rest'] as const) {
      expect(succeed(subject({ lethalCoins: 0 }), { action }).coinsSpent).toBe(0);
    }
  });

  it('charges in full even when the stat gain is wasted on an already-full bar', () => {
    // Overfeeding is the player's mistake to make; silently discounting it would
    // make the wallet disagree with the price the tray advertised.
    const outcome = succeed(withStats({ hunger: 100 }), { action: 'feed', itemId: 'feast' });
    expect(outcome.coinsSpent).toBe(6);
    expect(outcome.deltas.hunger).toBe(0);
  });
});

describe('resolveAction — effects', () => {
  it('applies a feed item to hunger only', () => {
    const outcome = succeed(withStats({ hunger: 40 }), { action: 'feed', itemId: 'hearty_meal' });
    expect(outcome.stats.hunger).toBe(70);
    expect(outcome.deltas).toEqual({ hunger: 30 });
  });

  it('applies every effect of a multi-effect item', () => {
    const outcome = succeed(withStats({ mood: 10, energy: 50, hunger: 50 }), {
      action: 'entertain',
      itemId: 'night_out',
    });

    expect(outcome.stats).toMatchObject({ mood: 65, energy: 30, hunger: 35 });
    expect(outcome.deltas).toEqual({ mood: 55, energy: -20, hunger: -15 });
  });

  it('sets hygiene outright on a shower rather than adding to it', () => {
    const outcome = succeed(withStats({ hygiene: 3 }), { action: 'shower' });
    expect(outcome.stats.hygiene).toBe(100);
    expect(outcome.deltas).toEqual({ hygiene: 97 });
  });

  it('trades a little hunger for energy on rest', () => {
    const outcome = succeed(withStats({ energy: 40, hunger: 40 }), { action: 'rest' });
    expect(outcome.stats).toMatchObject({ energy: 70, hunger: 35 });
  });

  it('grows education by the diminishing study gain and charges the study side effects', () => {
    const outcome = succeed(withStats({ education: 10 }), { action: 'study' });
    expect(outcome.stats.education).toBeCloseTo(10 + studyGain(10), 10);
    expect(outcome.stats.energy).toBe(92);
    expect(outcome.stats.mood).toBe(97);
  });

  it('clamps a gain at the ceiling and reports the delta that actually landed', () => {
    const outcome = succeed(withStats({ hunger: 95 }), { action: 'feed', itemId: 'hearty_meal' });
    expect(outcome.stats.hunger).toBe(100);
    expect(outcome.deltas.hunger).toBe(5);
  });

  it('clamps a cost at the floor and reports the delta that actually landed', () => {
    const outcome = succeed(withStats({ energy: 10, mood: 50, hunger: 50 }), {
      action: 'entertain',
      itemId: 'night_out',
    });
    expect(outcome.stats.energy).toBe(0);
    expect(outcome.deltas.energy).toBe(-10);
  });

  it('rounds deltas to two decimals so the "+N" chip never shows float noise', () => {
    const outcome = succeed(withStats({ education: 37 }), { action: 'study' });
    expect(outcome.deltas.education).toBe(7.56);
  });

  it('still applies the study side effects at the education cap, where the gain is zero', () => {
    // Studying with nothing left to learn is a wasted action, not a rejected one.
    const outcome = succeed(withStats({ education: 100 }), { action: 'study' });
    expect(outcome.stats.education).toBe(100);
    expect(outcome.deltas.education).toBe(0);
    expect(outcome.deltas.energy).toBe(-8);
  });

  it('never touches a stat no effect names', () => {
    const outcome = succeed(withStats({ hp: 42, hygiene: 55 }), { action: 'feed', itemId: 'kibble' });
    expect(outcome.stats.hp).toBe(42);
    expect(outcome.stats.hygiene).toBe(55);
  });

  it('cannot raise HP — only the simulation heals', () => {
    for (const request of [
      { action: 'feed', itemId: 'feast' },
      { action: 'shower' },
      { action: 'rest' },
      { action: 'study' },
      { action: 'entertain', itemId: 'night_out' },
    ] as ActionRequest[]) {
      expect(succeed(withStats({ hp: 0 }), request).stats.hp).toBe(0);
    }
  });
});

describe('resolveAction — purity', () => {
  it('leaves the caller’s subject untouched', () => {
    const input = withStats({ hunger: 40 }, { lethalCoins: 6, actionCooldowns: {} });
    const snapshot = structuredClone(input);

    succeed(input, { action: 'feed', itemId: 'feast' });

    expect(input).toEqual(snapshot);
  });

  it('returns the same outcome for the same inputs, with no hidden clock read', () => {
    const input = withStats({ hunger: 20 });
    expect(succeed(input, { action: 'feed', itemId: 'kibble' })).toEqual(
      succeed(input, { action: 'feed', itemId: 'kibble' }),
    );
  });

  it('names the clip the client should play for every action and item', () => {
    expect(succeed(subject(), { action: 'entertain', itemId: 'watch_a_movie' }).clipId).toBe('watch_a_movie');
    expect(succeed(subject(), { action: 'rest' }).clipId).toBe('rest');
  });
});
