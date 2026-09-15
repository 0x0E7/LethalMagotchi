import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { createAccount, createCharacterOutOfBand, login, type Credentials } from './helpers.js';

/**
 * QA round 2. Round 1's G-1 fix has two halves: the live `group:sync` push, which
 * `groups-qa-round1.spec.ts` already covers, and the `ready`-triggered re-read that is
 * supposed to catch a push sent while the recipient's socket was down. Nothing covered the
 * second half, which is the half that only a real disconnect can exercise.
 */
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://lethal:lethal@localhost:5432/lethalmagotchi_test';

function marker(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

async function ageAccounts(nicknames: string[]): Promise<void> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    await pool.query(
      `UPDATE accounts SET created_at = now() - interval '48 hours'
       WHERE id IN (SELECT account_id FROM characters WHERE nickname = ANY($1::text[]))`,
      [nicknames],
    );
  } finally {
    await pool.end();
  }
}

async function openPlayer(
  browser: Browser,
  request: APIRequestContext,
  nickname: string,
): Promise<{ page: Page; credentials: Credentials }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const credentials = await createAccount(request);
  await createCharacterOutOfBand(request, credentials, nickname);
  return { page, credentials };
}

async function enterTownSquare(page: Page, nickname: string, credentials: Credentials): Promise<void> {
  await login(page, credentials);
  await expect(page.getByRole('heading', { name: nickname })).toBeVisible();
  await page.getByRole('button', { name: /^Chat/ }).click();
  await expect(page.getByRole('tab', { name: /Town Square/ })).toBeVisible();
}

async function say(page: Page, text: string): Promise<void> {
  await page.getByLabel(/^Write a message to /).fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
}

/**
 * Round-1 finding G-1, second half. `group:sync` is fire-and-forget: an invitation issued
 * while the recipient's socket is down reaches nothing and is never resent. The badge has
 * to appear anyway once the socket comes back, off the reconnect's own `ready` frame, with
 * the page never reloaded and the Groups tab never clicked.
 */
test('QA-3: an invitation sent while the recipient was disconnected appears on reconnect', async ({
  browser,
  request,
}) => {
  test.setTimeout(90_000);

  const leaderName = marker('Sender');
  const guestName = marker('Dropout');
  const leader = await openPlayer(browser, request, leaderName);
  const guest = await openPlayer(browser, request, guestName);
  await ageAccounts([leaderName, guestName]);

  await enterTownSquare(leader.page, leaderName, leader.credentials);
  await enterTownSquare(guest.page, guestName, guest.credentials);

  // The guest speaks first, so the leader can invite them from the Square later — and so
  // the guest's socket is demonstrably alive before it is cut.
  const hello = marker('present');
  await guest.page.getByRole('tab', { name: /Town Square/ }).click();
  await say(guest.page, hello);
  await expect(guest.page.getByRole('log').getByText(hello)).toBeVisible();

  const groupName = marker('Reconnect');
  await leader.page.getByRole('tab', { name: /^Groups/ }).click();
  await leader.page.getByLabel('Group name').fill(groupName);
  await leader.page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(leader.page.getByRole('heading', { name: groupName })).toBeVisible();
  await leader.page.getByRole('tab', { name: /Town Square/ }).click();
  await expect(leader.page.getByRole('log').getByText(hello)).toBeVisible();

  // Cut the guest's connection. The push now has nowhere to land.
  await guest.page.context().setOffline(true);
  await guest.page.waitForTimeout(1_000);

  await leader.page.getByRole('button', { name: `Invite ${guestName} to your group` }).first().click();
  await expect(leader.page.getByText('Invitation sent.')).toBeVisible();

  // Still nothing on the guest's screen: they were not there to be told.
  await expect(guest.page.getByRole('tab', { name: /^Groups/ })).toHaveText('Groups');

  // Back online. The reconnect's `ready` is the only signal there is.
  await guest.page.context().setOffline(false);

  const groupsTab = guest.page.getByRole('tab', { name: /^Groups/ });
  await expect(groupsTab.getByLabel('1 invitations')).toBeVisible({ timeout: 20_000 });
  // eslint-disable-next-line no-console
  console.log('QA-3 Groups tab label after reconnect:', JSON.stringify(await groupsTab.textContent()));

  // And it is the real invitation, not a phantom badge.
  await groupsTab.click();
  await expect(guest.page.getByText(groupName)).toBeVisible();
  await guest.page.getByRole('button', { name: 'Accept' }).click();
  await expect(guest.page.getByRole('heading', { name: groupName })).toBeVisible();

  await leader.page.context().close();
  await guest.page.context().close();
});
