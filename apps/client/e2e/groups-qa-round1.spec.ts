import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { createAccount, createCharacterOutOfBand, login, type Credentials } from './helpers.js';

/**
 * QA round 1 probes. These document behaviour the developer's own `groups.spec.ts` does not
 * exercise, because it always clicks into the Groups segment (which refreshes) before
 * looking — so it never asks what an online player is *told* without being prompted.
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

async function openGroups(page: Page): Promise<void> {
  await page.getByRole('tab', { name: /^Groups/ }).click();
}

/**
 * Round-1 finding G-1, now the regression test for its fix. `GroupProvider` fetched
 * `/groups/me` once on mount and nothing refreshed it afterwards, so the Groups segment's
 * invitation badge was computed from page-load state: the one affordance that would tell a
 * recipient to look was the one thing that could not know. The server now pushes
 * `group:sync` to the invited account, which the provider re-reads on.
 */
test('QA-1: an invitation reaches a player who is already online, unprompted', async ({
  browser,
  request,
}) => {
  test.setTimeout(90_000);

  const leaderName = marker('Host');
  const guestName = marker('Guest');
  const leader = await openPlayer(browser, request, leaderName);
  const guest = await openPlayer(browser, request, guestName);
  await ageAccounts([leaderName, guestName]);

  await enterTownSquare(leader.page, leaderName, leader.credentials);
  await enterTownSquare(guest.page, guestName, guest.credentials);

  const groupName = marker('Signal');
  await openGroups(leader.page);
  await leader.page.getByLabel('Group name').fill(groupName);
  await leader.page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(leader.page.getByRole('heading', { name: groupName })).toBeVisible();

  // The guest speaks so the leader has somebody to invite from the Square.
  const hello = marker('hello');
  await guest.page.getByRole('tab', { name: /Town Square/ }).click();
  await say(guest.page, hello);
  await leader.page.getByRole('tab', { name: /Town Square/ }).click();
  await expect(leader.page.getByRole('log').getByText(hello)).toBeVisible();
  await leader.page.getByRole('button', { name: `Invite ${guestName} to your group` }).first().click();
  await expect(leader.page.getByText('Invitation sent.')).toBeVisible();

  // The guest's tab strip is the only place an invitation could announce itself, and it has
  // to do so without the guest touching anything.
  const groupsTab = guest.page.getByRole('tab', { name: /^Groups/ });
  await expect(groupsTab).toBeVisible();
  await expect(groupsTab.getByLabel('1 invitations')).toBeVisible();

  const badgeBeforeLooking = await groupsTab.textContent();
  // eslint-disable-next-line no-console
  console.log('QA-1 Groups tab label while an invitation is waiting:', JSON.stringify(badgeBeforeLooking));
  expect(badgeBeforeLooking?.trim()).toBe('Groups1');

  // And clicking in shows the invitation the badge was counting.
  await openGroups(guest.page);
  await expect(guest.page.getByText(groupName)).toBeVisible();

  await leader.page.context().close();
  await guest.page.context().close();
});

/**
 * Round-5 judgement call 4, taken to the screen: a kicked player's open thread should be
 * eventually-consistent, not broken — refused with a sentence, and with a way back out.
 */
test('QA-2: a kicked player sitting in the room gets a readable refusal, not a dead end', async ({
  browser,
  request,
}) => {
  test.setTimeout(90_000);

  const leaderName = marker('Warden');
  const memberName = marker('Ejected');
  const leader = await openPlayer(browser, request, leaderName);
  const member = await openPlayer(browser, request, memberName);
  await ageAccounts([leaderName, memberName]);

  await enterTownSquare(leader.page, leaderName, leader.credentials);
  await enterTownSquare(member.page, memberName, member.credentials);

  const groupName = marker('Stale Thread');
  await openGroups(leader.page);
  await leader.page.getByLabel('Group name').fill(groupName);
  await leader.page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(leader.page.getByRole('heading', { name: groupName })).toBeVisible();

  const hello = marker('hi-there');
  await member.page.getByRole('tab', { name: /Town Square/ }).click();
  await say(member.page, hello);
  await leader.page.getByRole('tab', { name: /Town Square/ }).click();
  await expect(leader.page.getByRole('log').getByText(hello)).toBeVisible();
  await leader.page.getByRole('button', { name: `Invite ${memberName} to your group` }).first().click();

  await openGroups(member.page);
  await member.page.getByRole('button', { name: 'Accept' }).click();
  await expect(member.page.getByRole('heading', { name: groupName })).toBeVisible();

  // The member is sitting inside the room when the removal lands.
  await member.page.getByRole('button', { name: 'Open chat' }).click();
  const said = marker('still-here');
  await say(member.page, said);
  await expect(member.page.getByRole('log').getByText(said)).toBeVisible();

  await openGroups(leader.page);
  await leader.page.getByRole('button', { name: `Remove ${memberName}` }).click();
  await expect(leader.page.getByText('1 of 30 members')).toBeVisible();

  // No push: the thread on the member's screen is unchanged until they try to use it.
  await member.page.waitForTimeout(2_000);
  const refused = marker('let-me-back');
  await say(member.page, refused);

  // The refusal has to be a sentence, not a silent failure or a stuck spinner.
  await expect(member.page.getByText('You are not part of that conversation.')).toBeVisible();
  // eslint-disable-next-line no-console
  console.log('QA-2 refusal shown to the kicked player: "You are not part of that conversation."');

  // And there is a way out of the stale view, back into a correct one.
  await openGroups(member.page);
  await expect(member.page.getByRole('heading', { name: 'Start a group' })).toBeVisible();

  await leader.page.context().close();
  await member.page.context().close();
});
