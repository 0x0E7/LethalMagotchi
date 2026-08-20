import { expect, test, type Page } from '@playwright/test';
import { startAtPetScreen } from './helpers.js';

const SEEN_CLIPS_KEY = 'lm.seen-clips.v1';
const ANIMATION_KEY = 'lm.settings.animations.v1';

const petFigure = (page: Page) => page.getByRole('img', { name: /is (idle|[a-z])/ });
const dockButton = (page: Page, action: string) => page.locator(`[data-action="${action}"]`);
const meter = (page: Page, name: string) => page.getByRole('meter', { name: new RegExp(`^${name},`) });

/** The seen-clips record is keyed by character id, which the screen never renders. */
async function characterIdFromStorage(page: Page): Promise<string> {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key) ?? '{}';
    return Object.keys(JSON.parse(raw) as Record<string, string[]>)[0] as string;
  }, SEEN_CLIPS_KEY);
}

test('firing actions moves the bar and the coin balance', async ({ page, request }) => {
  await startAtPetScreen(page, request);
  await page.selectOption('select[name="animationMode"]', 'off');

  await expect(meter(page, 'education')).toHaveAttribute('aria-valuenow', '10');
  await expect(page.getByLabel('5 LethalCoins')).toBeVisible();

  await dockButton(page, 'study').click();

  // Study's gain diminishes with education: 10 + 12 × (1 − 0.10) = 20.8, shown as 21.
  await expect(meter(page, 'education')).toHaveAttribute('aria-valuenow', '21');
  await expect(page.getByLabel('5 LethalCoins')).toBeVisible();

  await dockButton(page, 'feed').click();
  await page.getByRole('menuitem', { name: /Kibble/ }).click();

  await expect(page.getByLabel('4 LethalCoins')).toBeVisible();
  await expect(meter(page, 'hunger')).toHaveAttribute('aria-valuenow', '100');
});

test('a second action fired mid-clip queues rather than interrupting', async ({ page, request }) => {
  await startAtPetScreen(page, request);

  await dockButton(page, 'study').click();
  await expect(petFigure(page)).toHaveAttribute('aria-label', 'Bubbles is studying');

  await dockButton(page, 'shower').click();

  await expect(page.getByText('Shower is queued.')).toBeVisible();
  // The queued action must still be waiting, not already applied.
  await expect(petFigure(page)).toHaveAttribute('aria-label', 'Bubbles is studying');

  await expect(petFigure(page)).toHaveAttribute('aria-label', 'Bubbles is showering', { timeout: 10_000 });
  await expect(petFigure(page)).toHaveAttribute('aria-label', 'Bubbles is idle', { timeout: 10_000 });

  // Both actions landed: education grew and the shower burned its daily cooldown.
  await expect(meter(page, 'education')).toHaveAttribute('aria-valuenow', '21');
  await expect(dockButton(page, 'shower')).toContainText('Fresh');
});

test('a clip is skippable only after the player has already seen it once', async ({ page, request }) => {
  await startAtPetScreen(page, request);

  await dockButton(page, 'entertain').click();
  await page.getByRole('menuitem', { name: /Yard play/ }).click();

  // First view of an item always plays in full.
  await expect(petFigure(page)).toHaveAttribute('aria-label', 'Bubbles is playing');
  await page.waitForTimeout(1200);
  await expect(page.getByRole('button', { name: 'Tap to skip' })).toHaveCount(0);
  await expect(petFigure(page)).toHaveAttribute('aria-label', 'Bubbles is idle', { timeout: 10_000 });

  const characterId = await characterIdFromStorage(page);
  expect(characterId).toBeTruthy();
  await page.evaluate(
    ([key, id]) => {
      const map = JSON.parse(window.localStorage.getItem(key as string) ?? '{}') as Record<string, string[]>;
      map[id as string] = [...(map[id as string] ?? []), 'shower'];
      window.localStorage.setItem(key as string, JSON.stringify(map));
    },
    [SEEN_CLIPS_KEY, characterId],
  );

  await dockButton(page, 'shower').click();
  await expect(petFigure(page)).toHaveAttribute('aria-label', 'Bubbles is showering');

  const skip = page.getByRole('button', { name: 'Tap to skip' });
  await expect(skip).toBeVisible();
  await skip.click();

  // Skipping fast-forwards to the settle beat instead of running the full 6s clip.
  await expect(petFigure(page)).toHaveAttribute('aria-label', 'Bubbles is idle', { timeout: 3_000 });
  await expect(meter(page, 'clean')).toHaveAttribute('aria-valuenow', '100');
});

test('skipping before a slow server answers still commits the result', async ({ page, request }) => {
  // Regression: the skip fast-forward used to end the clip before the response
  // landed, and the late response was then discarded as "not the current clip" —
  // leaving the HUD showing pre-action coins and no cooldown, so the next tap was
  // rejected by the server for no visible reason.
  await startAtPetScreen(page, request);

  await dockButton(page, 'entertain').click();
  await page.getByRole('menuitem', { name: /Yard play/ }).click();
  await expect(petFigure(page)).toHaveAttribute('aria-label', 'Bubbles is idle', { timeout: 10_000 });

  const characterId = await characterIdFromStorage(page);
  await page.evaluate(
    ([key, id]) => {
      const map = JSON.parse(window.localStorage.getItem(key as string) ?? '{}') as Record<string, string[]>;
      map[id as string] = [...(map[id as string] ?? []), 'kibble'];
      window.localStorage.setItem(key as string, JSON.stringify(map));
    },
    [SEEN_CLIPS_KEY, characterId],
  );

  await page.route('**/api/v1/characters/me/actions/feed', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    await route.continue();
  });

  await dockButton(page, 'feed').click();
  await page.getByRole('menuitem', { name: /Kibble/ }).click();
  await page.getByRole('button', { name: 'Tap to skip' }).click();
  await expect(petFigure(page)).toHaveAttribute('aria-label', 'Bubbles is idle', { timeout: 3_000 });

  await expect(page.getByLabel('4 LethalCoins')).toBeVisible({ timeout: 10_000 });
  await expect(dockButton(page, 'feed')).toHaveClass(/cooling/);
});

test('turning animations off commits the action without a clip', async ({ page, request }) => {
  await startAtPetScreen(page, request);
  await page.selectOption('select[name="animationMode"]', 'off');

  await dockButton(page, 'rest').click();

  // No busy state to wait out: the pet is idle again as soon as the server answers.
  await expect(meter(page, 'energy')).toHaveAttribute('aria-valuenow', '100', { timeout: 3_000 });
  await expect(petFigure(page)).toHaveAttribute('aria-label', 'Bubbles is idle');
  await expect(page.getByRole('button', { name: 'Tap to skip' })).toHaveCount(0);
});

test.describe('reduced motion', () => {
  test('shows a short still pose instead of the full clip', async ({ page, request }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await startAtPetScreen(page, request);

    await dockButton(page, 'shower').click();
    await expect(petFigure(page)).toHaveAttribute('aria-label', 'Bubbles is showering');
    await expect(page.locator('.pet-stage.still')).toBeVisible();

    // The full shower clip runs 6s; the still pose must clear in well under that,
    // and must never offer a skip affordance since there is nothing to skip.
    await expect(page.getByRole('button', { name: 'Tap to skip' })).toHaveCount(0);
    await expect(petFigure(page)).toHaveAttribute('aria-label', 'Bubbles is idle', { timeout: 3_000 });
    await expect(meter(page, 'clean')).toHaveAttribute('aria-valuenow', '100');
  });
});

test('the live region coalesces a burst of announcements instead of flooding', async ({
  page,
  request,
}) => {
  await startAtPetScreen(page, request);
  await page.selectOption('select[name="animationMode"]', 'off');
  const live = page.locator('[aria-live="polite"]');

  await dockButton(page, 'study').click();
  await expect(live).toHaveText(/^Study\./);
  const firstAnnouncedAt = Date.now();

  await dockButton(page, 'rest').click();

  // The second result must still be announced — coalescing may delay the tail of a
  // burst, but silently dropping it would strand a screen-reader user on stale news.
  await expect(live).toHaveText(/^Rest\./, { timeout: 5_000 });
  // …and it must have waited out the throttle rather than interrupting the first.
  expect(Date.now() - firstAnnouncedAt).toBeGreaterThan(900);
});

test('the dock is fully operable from the keyboard', async ({ page, request }) => {
  await startAtPetScreen(page, request);

  // 3 = entertain, the third slot in the fixed dock order.
  await page.keyboard.press('3');
  const tray = page.getByRole('menu', { name: 'Entertain options' });
  await expect(tray).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Yard play/ })).toBeFocused();

  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: /Read a book/ })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('menuitem', { name: /Yard play/ })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(tray).toHaveCount(0);
  await expect(dockButton(page, 'entertain')).toBeFocused();

  // 2 = shower, an instant action that fires straight from the shortcut.
  await page.keyboard.press('2');
  await expect(petFigure(page)).toHaveAttribute('aria-label', 'Bubbles is showering');
});

test('an action on cooldown explains the wait instead of firing again', async ({ page, request }) => {
  await startAtPetScreen(page, request);
  await page.selectOption('select[name="animationMode"]', 'off');

  await dockButton(page, 'shower').click();
  await expect(dockButton(page, 'shower')).toContainText('Fresh', { timeout: 5_000 });

  await dockButton(page, 'shower').click();

  await expect(page.getByText(/still fresh from the last one/i)).toBeVisible();
  await expect(petFigure(page)).toHaveAttribute('aria-label', 'Bubbles is idle');
});

test('an unaffordable item says how short the player is instead of failing at the server', async ({
  page,
  request,
}) => {
  await startAtPetScreen(page, request);

  await dockButton(page, 'feed').click();
  const feast = page.getByRole('menuitem', { name: /Feast/ });

  await expect(feast).toContainText('1 more coins');
  await feast.click();

  await expect(page.getByText(/Feast costs 6 coins/)).toBeVisible();
  await expect(page.getByLabel('5 LethalCoins')).toBeVisible();
  await expect(petFigure(page)).toHaveAttribute('aria-label', 'Bubbles is idle');
});

test('a corrupt settings blob falls back to defaults rather than breaking the screen', async ({
  page,
  request,
}) => {
  await startAtPetScreen(page, request);

  await page.evaluate(
    ([seenKey, animationKey]) => {
      window.localStorage.setItem(seenKey as string, '{"018f": ["kibble"');
      window.localStorage.setItem(animationKey as string, 'cinematic');
    },
    [SEEN_CLIPS_KEY, ANIMATION_KEY],
  );
  await page.reload();

  await expect(page.getByRole('heading', { name: 'Bubbles' })).toBeVisible();
  await expect(page.locator('select[name="animationMode"]')).toHaveValue('full');

  // And the screen still works: an action fires and commits as normal.
  await dockButton(page, 'study').click();
  await expect(meter(page, 'education')).toHaveAttribute('aria-valuenow', '21', { timeout: 10_000 });
});
