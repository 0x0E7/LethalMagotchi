import { expect, test } from '@playwright/test';
import { createAccount, login } from './helpers.js';

/**
 * These run against the same single-origin setup the production container uses
 * (API + built SPA behind one Fastify instance), so they cover the deployment
 * shape that used to crash at boot when CLIENT_DIST was set.
 */
test('a deep client route is served by the SPA fallback on a cold load', async ({ page }) => {
  const response = await page.goto('/create/details');

  expect(response?.status()).toBe(200);
  expect(response?.headers()['content-type']).toContain('text/html');
  // Not signed in, so the app redirects to the auth screen rather than 404ing.
  await expect(page.getByRole('tab', { name: 'Log in' })).toBeVisible();
});

test('an unknown API path returns JSON, never the SPA shell', async ({ request }) => {
  const response = await request.get('/api/v1/definitely-not-a-route');

  expect(response.status()).toBe(404);
  expect(response.headers()['content-type']).toContain('application/json');
  expect((await response.json()).error.code).toBe('NOT_FOUND');
});

test('an authenticated player reloading a deep route keeps their place', async ({ page, request }) => {
  const credentials = await createAccount(request);
  await login(page, credentials);
  await expect(page).toHaveURL(/\/create\/species$/);

  await page.getByRole('radio', { name: /Otter/ }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/create\/identity$/);

  await page.reload();

  await expect(page).toHaveURL(/\/create\/identity$/);
  await expect(page.getByRole('heading', { name: 'Who are they?' })).toBeVisible();
});
