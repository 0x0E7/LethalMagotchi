import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const PASSWORD = 'correct-horse-battery-9';

export interface Credentials {
  username: string;
  password: string;
}

export function uniqueUsername(prefix = 'e2e'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/** Creates an account out of band so a test can start from "logged out but registered". */
export async function createAccount(request: APIRequestContext): Promise<Credentials> {
  const credentials = { username: uniqueUsername(), password: PASSWORD };
  const response = await request.post('/api/v1/auth/register', { data: credentials });
  expect(response.status(), await response.text()).toBe(201);
  return credentials;
}

/**
 * Creates the account's character over the API, simulating a second device that
 * got there first. The browser under test keeps whatever session state it had.
 */
export async function createCharacterOutOfBand(
  request: APIRequestContext,
  credentials: Credentials,
  nickname: string,
): Promise<void> {
  const session = await request.post('/api/v1/auth/login', { data: credentials });
  expect(session.status(), await session.text()).toBe(200);
  const { accessToken } = await session.json();

  const created = await request.post('/api/v1/characters', {
    headers: { authorization: `Bearer ${accessToken}` },
    data: {
      speciesId: 'fox',
      nickname,
      bio: 'Made before this browser got here.',
      originCountry: 'NL',
      originCity: 'Utrecht',
      occupationId: 'chef',
      personalityId: 'goofball',
    },
  });
  expect(created.status(), await created.text()).toBe(201);
}

export async function login(page: Page, credentials: Credentials): Promise<void> {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Log in' }).click();
  await page.locator('input[name="username"]').fill(credentials.username);
  await page.locator('input[name="password"]').fill(credentials.password);
  await page.getByRole('button', { name: 'Log in' }).click();
}

export async function registerViaUi(page: Page): Promise<Credentials> {
  const credentials = { username: uniqueUsername(), password: PASSWORD };
  await page.goto('/');
  await page.getByRole('tab', { name: 'Register' }).click();
  await page.locator('input[name="username"]').fill(credentials.username);
  await page.locator('input[name="password"]').fill(credentials.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  return credentials;
}

/** Walks the three creation steps, stopping just before the review modal opens. */
export async function fillCreationSteps(
  page: Page,
  overrides: { nickname?: string; bio?: string } = {},
): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Pick a species' })).toBeVisible();
  await page.getByRole('radio', { name: /Otter/ }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Who are they?' })).toBeVisible();
  await page.locator('input[name="nickname"]').fill(overrides.nickname ?? 'Bubbles');
  if (overrides.bio !== undefined) await page.locator('textarea[name="bio"]').fill(overrides.bio);
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'A few details' })).toBeVisible();
  await page.locator('select[name="originCountry"]').selectOption('NL');
  await page.locator('select[name="occupationId"]').selectOption('chef');
  await page.locator('select[name="personalityId"]').selectOption('goofball');
}
