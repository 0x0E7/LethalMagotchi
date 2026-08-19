import { expect, test } from '@playwright/test';
import {
  PASSWORD,
  createAccount,
  fillCreationSteps,
  login,
  registerViaUi,
  uniqueUsername,
} from './helpers.js';

test('a new player registers, creates a character and lands on the pet screen', async ({ page }) => {
  await registerViaUi(page);

  await expect(page).toHaveURL(/\/create\/species$/);
  await fillCreationSteps(page, { nickname: 'Bubbles', bio: 'Professional rock collector.' });

  await page.getByRole('button', { name: 'Review' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Meet Bubbles' })).toBeVisible();

  await page.getByRole('button', { name: /Start raising Bubbles/ }).click();

  await expect(page).toHaveURL(/\/pet$/);
  await expect(page.getByRole('heading', { name: 'Bubbles' })).toBeVisible();
  await expect(page.getByRole('meter', { name: /hunger/ })).toBeVisible();
  await expect(page.getByText('Professional rock collector.')).toBeVisible();
});

test('an existing player logs in, and a wrong password is rejected without leaking the username', async ({
  page,
  request,
}) => {
  const credentials = await createAccount(request);

  await login(page, { username: credentials.username, password: 'definitely-wrong-pw' });
  await expect(page.getByRole('alert')).toContainText('Invalid username or password.');

  // The same message must appear for a username that does not exist at all.
  await login(page, { username: uniqueUsername('ghost'), password: PASSWORD });
  await expect(page.getByRole('alert')).toContainText('Invalid username or password.');

  await login(page, credentials);
  await expect(page).toHaveURL(/\/create\/species$/);
});

test('a logged-in player without a character is routed into creation, and can log back out', async ({
  page,
  request,
}) => {
  const credentials = await createAccount(request);
  await login(page, credentials);

  await expect(page).toHaveURL(/\/create\/species$/);
  await fillCreationSteps(page);
  await page.getByRole('button', { name: 'Review' }).click();
  await page.getByRole('button', { name: /Start raising/ }).click();
  await expect(page).toHaveURL(/\/pet$/);

  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('tab', { name: 'Log in' })).toBeVisible();
});

test('a reloaded session comes back with the character already loaded', async ({ page, request }) => {
  const credentials = await createAccount(request);
  await login(page, credentials);
  await fillCreationSteps(page, { nickname: 'Reloaded' });
  await page.getByRole('button', { name: 'Review' }).click();
  await page.getByRole('button', { name: /Start raising/ }).click();
  await expect(page).toHaveURL(/\/pet$/);

  // A full reload exercises both the SPA fallback on a deep route and the
  // refresh-cookie session restore.
  await page.reload();

  await expect(page).toHaveURL(/\/pet$/);
  await expect(page.getByRole('heading', { name: 'Reloaded' })).toBeVisible();
});
