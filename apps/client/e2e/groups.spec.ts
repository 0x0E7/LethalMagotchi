import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { axeViolations, createAccount, createCharacterOutOfBand, login, type Credentials } from './helpers.js';

/**
 * Three real browsers on one server. A group is founded, filled from the Town Square, talked
 * in, handed over by its leader walking away, and closed to someone who is removed —
 * everything over the same wire production uses.
 */
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://lethal:lethal@localhost:5432/lethalmagotchi_test';

/** The Town Square is long-lived and shared, so every fixture name has to be unique. */
function marker(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

/**
 * Groups open at 24 hours of account age and a test cannot wait a day. This is the one thing
 * the spec reaches into the database for; everything else goes through the product.
 */
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

async function openGroups(page: Page): Promise<void> {
  await page.getByRole('tab', { name: /^Groups/ }).click();
}

test('a group is founded, filled, talked in, and handed over when its leader leaves', async ({
  browser,
  request,
}) => {
  test.setTimeout(90_000);

  const leaderName = marker('Otter');
  const elderName = marker('Badger');
  const youngName = marker('Vole');
  const leader = await openPlayer(browser, request, leaderName);
  const elder = await openPlayer(browser, request, elderName);
  const young = await openPlayer(browser, request, youngName);
  await ageAccounts([leaderName, elderName, youngName]);

  await enterTownSquare(leader.page, leaderName, leader.credentials);
  await enterTownSquare(elder.page, elderName, elder.credentials);
  await enterTownSquare(young.page, youngName, young.credentials);

  // Founding one is a name and a button.
  const groupName = marker('Otter Society');
  await openGroups(leader.page);
  // The empty state — an invitation list and a create form — is its own tree to scan.
  expect(await axeViolations(leader.page)).toEqual([]);
  await leader.page.getByLabel('Group name').fill(groupName);
  await leader.page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(leader.page.getByRole('heading', { name: groupName })).toBeVisible();
  await expect(leader.page.getByText('1 of 30 members')).toBeVisible();

  // The Town Square is where you meet someone to invite — there is no player directory.
  const hello = marker('group-hello');
  await elder.page.getByRole('tab', { name: /Town Square/ }).click();
  await say(elder.page, hello);
  await expect(leader.page.getByRole('tab', { name: /Town Square/ })).toBeVisible();
  await leader.page.getByRole('tab', { name: /Town Square/ }).click();
  await expect(leader.page.getByRole('log').getByText(hello)).toBeVisible();

  await leader.page.getByRole('button', { name: `Invite ${elderName} to your group` }).first().click();
  await expect(leader.page.getByText('Invitation sent.')).toBeVisible();

  // The invitation is waiting in the other player's Groups segment.
  await openGroups(elder.page);
  await expect(elder.page.getByText(groupName)).toBeVisible();
  await elder.page.getByRole('button', { name: 'Accept' }).click();
  await expect(elder.page.getByRole('heading', { name: groupName })).toBeVisible();
  await expect(elder.page.getByText('2 of 30 members')).toBeVisible();

  // A third member, so there is somebody to promote and somebody to outrank.
  const wave = marker('group-wave');
  await young.page.getByRole('tab', { name: /Town Square/ }).click();
  await say(young.page, wave);
  await leader.page.getByRole('tab', { name: /Town Square/ }).click();
  await expect(leader.page.getByRole('log').getByText(wave)).toBeVisible();
  await leader.page.getByRole('button', { name: `Invite ${youngName} to your group` }).first().click();
  await openGroups(young.page);
  await young.page.getByRole('button', { name: 'Accept' }).click();
  await expect(young.page.getByRole('heading', { name: groupName })).toBeVisible();

  /**
   * The group name rides the identity slot beside a nickname in the Town Square, on the same
   * card the panel already fetches. That card is cached per author for the session, so a
   * reload is what proves the server is the one serving the badge.
   */
  await elder.page.reload();
  await elder.page.getByRole('button', { name: /^Chat/ }).click();
  await expect(
    elder.page.getByRole('log').locator('.chat-message', { hasText: wave }).getByText(groupName),
  ).toBeVisible();

  // The roster, with the leader's controls on it, is a third tree.
  await openGroups(leader.page);
  await expect(leader.page.getByRole('list', { name: `${groupName} members` })).toBeVisible();
  expect(await axeViolations(leader.page)).toEqual([]);

  // The channel itself: live, and only inside the group.
  await openGroups(elder.page);
  await elder.page.getByRole('button', { name: 'Open chat' }).click();
  const inside = marker('inside-the-group');
  await say(elder.page, inside);

  await openGroups(leader.page);
  await leader.page.getByRole('button', { name: 'Open chat' }).click();
  await expect(leader.page.getByRole('log').getByText(inside)).toBeVisible();
  // The line never reaches the Town Square.
  await leader.page.getByRole('tab', { name: /Town Square/ }).click();
  await expect(leader.page.getByRole('log').getByText(inside)).toBeHidden();

  expect(await axeViolations(leader.page)).toEqual([]);

  // The leader walks. Leadership moves with no handoff step and no gap.
  await openGroups(leader.page);
  await leader.page.getByRole('button', { name: 'Leave group' }).click();
  await expect(leader.page.getByText('The longest-standing member takes over.')).toBeVisible();
  await leader.page.getByRole('button', { name: 'Leave group', exact: true }).last().click();
  await expect(leader.page.getByRole('heading', { name: 'Start a group' })).toBeVisible();

  await openGroups(elder.page);
  await elder.page.getByRole('tab', { name: /^Groups/ }).click();
  await expect(elder.page.getByRole('heading', { name: groupName })).toBeVisible();
  // The elder joined first, so the elder leads — and can now remove people.
  await expect(
    elder.page.getByRole('listitem').filter({ hasText: elderName }).getByText('leader'),
  ).toBeVisible();
  await expect(elder.page.getByRole('button', { name: `Remove ${youngName}` })).toBeVisible();

  // The promotion was announced in the room itself.
  await elder.page.getByRole('button', { name: 'Open chat' }).click();
  await expect(elder.page.getByRole('log').getByText(`${elderName} is now the leader.`)).toBeVisible();

  await leader.page.context().close();
  await elder.page.context().close();
  await young.page.context().close();
});

test('a removed player loses the room, and cannot be invited straight back', async ({ browser, request }) => {
  test.setTimeout(90_000);

  const leaderName = marker('Heron');
  const rowdyName = marker('Magpie');
  const leader = await openPlayer(browser, request, leaderName);
  const rowdy = await openPlayer(browser, request, rowdyName);
  await ageAccounts([leaderName, rowdyName]);

  await enterTownSquare(leader.page, leaderName, leader.credentials);
  await enterTownSquare(rowdy.page, rowdyName, rowdy.credentials);

  const groupName = marker('Heron House');
  await openGroups(leader.page);
  await leader.page.getByLabel('Group name').fill(groupName);
  await leader.page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(leader.page.getByRole('heading', { name: groupName })).toBeVisible();

  const hello = marker('kick-hello');
  await say(rowdy.page, hello);
  await leader.page.getByRole('tab', { name: /Town Square/ }).click();
  await expect(leader.page.getByRole('log').getByText(hello)).toBeVisible();
  await leader.page.getByRole('button', { name: `Invite ${rowdyName} to your group` }).first().click();

  await openGroups(rowdy.page);
  await rowdy.page.getByRole('button', { name: 'Accept' }).click();
  await expect(rowdy.page.getByRole('heading', { name: groupName })).toBeVisible();

  await openGroups(leader.page);
  await leader.page.getByRole('button', { name: `Remove ${rowdyName}` }).click();
  await expect(leader.page.getByText('1 of 30 members')).toBeVisible();

  // The removed player is out: no group on their screen, and the room is gone with it.
  await openGroups(rowdy.page);
  await rowdy.page.getByRole('tab', { name: /^Groups/ }).click();
  await expect(rowdy.page.getByRole('heading', { name: 'Start a group' })).toBeVisible();

  // And the door stays shut for the day.
  await leader.page.getByRole('tab', { name: /Town Square/ }).click();
  await leader.page.getByRole('button', { name: `Invite ${rowdyName} to your group` }).first().click();
  await expect(leader.page.getByText('This group removed them recently.')).toBeVisible();
  await openGroups(rowdy.page);
  await expect(rowdy.page.getByRole('button', { name: 'Accept' })).toBeHidden();

  await leader.page.context().close();
  await rowdy.page.context().close();
});
