import { expect, test } from '@playwright/test';
import { createAccount, createCharacterOutOfBand, fillCreationSteps, login } from './helpers.js';

const DRAFT_KEY = 'lm.character-draft.v1';

test('a server 422 sends the player back to the step that owns the bad field', async ({ page, request }) => {
  const credentials = await createAccount(request);
  await login(page, credentials);

  // Moderation runs server-side only, so this passes every client-side check and
  // comes back as a 422 with a `bio` field error owned by the identity step.
  await fillCreationSteps(page, { nickname: 'Bubbles', bio: 'you are a faggot' });
  await page.getByRole('button', { name: 'Review' }).click();
  await page.getByRole('button', { name: /Start raising/ }).click();

  await expect(page).toHaveURL(/\/create\/identity$/);
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('textarea[name="bio"]')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('.field-error')).toBeVisible();

  // The player can correct it in place and finish without starting over.
  await page.locator('textarea[name="bio"]').fill('Professional rock collector.');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Review' }).click();
  await page.getByRole('button', { name: /Start raising/ }).click();

  await expect(page).toHaveURL(/\/pet$/);
  await expect(page.getByRole('heading', { name: 'Bubbles' })).toBeVisible();
});

test('a CHARACTER_EXISTS conflict on submit recovers to the pet screen instead of erroring', async ({
  page,
  request,
}) => {
  // This browser logs in with no character and walks the whole creation flow...
  const credentials = await createAccount(request);
  await login(page, credentials);
  await fillCreationSteps(page, { nickname: 'TooLate' });

  // ...while the same account creates its character elsewhere (second device, or
  // a resubmitted request). This browser's session still believes there is none.
  await createCharacterOutOfBand(request, credentials, 'Preexisting');

  await page.getByRole('button', { name: 'Review' }).click();
  await page.getByRole('button', { name: /Start raising/ }).click();

  // The 409 must be absorbed: re-fetch /me and show the character that does exist,
  // rather than stranding the player on a dead-end error.
  await expect(page).toHaveURL(/\/pet$/);
  await expect(page.getByRole('heading', { name: 'Preexisting' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'TooLate' })).toBeHidden();

  // The abandoned draft is cleared, so returning to creation does not resurrect it.
  expect(await page.evaluate((key) => window.localStorage.getItem(key), DRAFT_KEY)).toBeNull();
});

test('a saved draft is restored when the player comes back to creation', async ({ page, request }) => {
  const credentials = await createAccount(request);
  await login(page, credentials);
  await expect(page).toHaveURL(/\/create\/species$/);

  await page.getByRole('radio', { name: /Otter/ }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('input[name="nickname"]').fill('HalfFinished');

  await page.reload();

  await expect(page.locator('input[name="nickname"]')).toHaveValue('HalfFinished');
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('radio', { name: /Otter/ })).toHaveAttribute('aria-checked', 'true');
});

test('a corrupt draft in localStorage does not break character creation', async ({ page, request }) => {
  const credentials = await createAccount(request);
  await login(page, credentials);
  await expect(page).toHaveURL(/\/create\/species$/);

  await page.evaluate((key) => window.localStorage.setItem(key, '{"speciesId":"otter",'), DRAFT_KEY);
  await page.reload();

  await expect(page.getByRole('heading', { name: 'Pick a species' })).toBeVisible();
  await expect(page.getByRole('radio', { name: /Otter/ })).toHaveAttribute('aria-checked', 'false');

  // And the flow still completes from a clean slate.
  await fillCreationSteps(page, { nickname: 'Recovered' });
  await page.getByRole('button', { name: 'Review' }).click();
  await page.getByRole('button', { name: /Start raising/ }).click();
  await expect(page).toHaveURL(/\/pet$/);
});

test('the review modal traps focus and returns it to the opener on close', async ({ page, request }) => {
  const credentials = await createAccount(request);
  await login(page, credentials);
  await fillCreationSteps(page, { nickname: 'Bubbles' });

  const reviewButton = page.getByRole('button', { name: 'Review' });
  await reviewButton.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  // Focus moves into the dialog on open.
  await expect(dialog.locator(':focus')).toBeVisible();

  // Tabbing forward from the last control wraps to the first, never escaping.
  const focusables = dialog.locator('button:not([disabled]), [href], select, input');
  const count = await focusables.count();
  for (let index = 0; index < count + 2; index += 1) {
    await page.keyboard.press('Tab');
    await expect(dialog.locator(':focus')).toHaveCount(1);
  }

  await page.keyboard.press('Escape');

  await expect(dialog).toBeHidden();
  await expect(reviewButton).toBeFocused();
});
