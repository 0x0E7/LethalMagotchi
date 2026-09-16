import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { createAccount, createCharacterOutOfBand, login, type Credentials } from './helpers.js';

/**
 * The way into a raid from the main screen.
 *
 * A raid has two halves and both had the same reachability gap: aiming it, and filling the
 * party. Each was only possible against someone who had just spoken in the Town Square, so
 * in practice a raid targeted whoever happened to be chatting. These tests hold both doors
 * open, and hold the wealth-banding line that makes the mode a risk rather than arithmetic.
 */

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://lethal:lethal@localhost:5432/lethalmagotchi_test';

function marker(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

async function withDb<T>(run: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    return await run(pool);
  } finally {
    await pool.end();
  }
}

/** Raids open at 24 hours old, same floor as duels, and a test cannot wait a day. */
function ageCharacters(nicknames: string[]): Promise<void> {
  return withDb(async (pool) => {
    await pool.query(
      `UPDATE characters SET created_at = now() - interval '48 hours' WHERE nickname = ANY($1::text[])`,
      [nicknames],
    );
  });
}

function setCoins(nickname: string, coins: number): Promise<void> {
  return withDb(async (pool) => {
    await pool.query('UPDATE characters SET lethal_coins = $2 WHERE nickname = $1', [nickname, coins]);
  });
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

async function enterGame(page: Page, nickname: string, credentials: Credentials): Promise<void> {
  await login(page, credentials);
  await expect(page.getByRole('heading', { name: nickname, level: 1 })).toBeVisible();
}

const openFinder = (page: Page) => page.getByRole('button', { name: 'Find a raid' }).click();

test('the main screen carries a raid button that aims at a player by name', async ({ browser, request }) => {
  const targetName = marker('Hoard');
  const raiderName = marker('Masked');
  const target = await openPlayer(browser, request, targetName);
  const raider = await openPlayer(browser, request, raiderName);
  await ageCharacters([targetName, raiderName]);
  await setCoins(targetName, 60);

  // The target never speaks, and never has to: a raid needs no consent from them at all.
  await enterGame(target.page, targetName, target.credentials);
  await enterGame(raider.page, raiderName, raider.credentials);

  await openFinder(raider.page);
  await expect(raider.page.getByRole('heading', { name: 'Find a raid' })).toBeVisible();
  await raider.page.getByLabel('Search players by name').fill(targetName);

  const row = raider.page.locator('.people-row').filter({ hasText: targetName });
  // A band, never a number. An exact balance would let a party fire only when the arithmetic
  // was already won, which is the whole risk the mode is built on.
  await expect(row).toContainText('Wealthy');
  await expect(row).not.toContainText('60');

  const raidButton = raider.page.getByRole('button', { name: `Raid ${targetName}` });
  await expect(raidButton).toBeEnabled();
  await raidButton.click();

  // The party card takes over, and the finder gets out of its way rather than stacking
  // underneath it — which is exactly what it did on the first attempt at this.
  await expect(raider.page.getByRole('heading', { name: `Raiding ${targetName}` })).toBeVisible({
    timeout: 10_000,
  });
  await expect(raider.page.getByRole('heading', { name: 'Find a raid' })).toBeHidden();

  await raider.page.close();
  await target.page.close();
});

test('a target who cannot be raided is greyed out, with the reason beside them', async ({
  browser,
  request,
}) => {
  const brokeName = marker('Pauper');
  const raiderName = marker('Prowler');
  const broke = await openPlayer(browser, request, brokeName);
  const raider = await openPlayer(browser, request, raiderName);
  await ageCharacters([brokeName, raiderName]);
  // Nothing to take: robbing an empty wallet is griefing with no economic content, and this
  // same floor is what stops a beggar being farmed through repeat bankruptcy.
  await setCoins(brokeName, 0);

  await enterGame(broke.page, brokeName, broke.credentials);
  await enterGame(raider.page, raiderName, raider.credentials);

  await openFinder(raider.page);
  await raider.page.getByLabel('Search players by name').fill(brokeName);

  const raidButton = raider.page.getByRole('button', { name: `Raid ${brokeName}` });
  await expect(raidButton).toBeVisible();
  await expect(raidButton).toBeDisabled();
  await expect(raider.page.locator('.people-row').filter({ hasText: brokeName })).toContainText(
    'Nothing to take',
  );

  await raider.page.close();
  await broke.page.close();
});

test('the party is filled from a searchable list, not from whoever happened to post', async ({
  browser,
  request,
}) => {
  const targetName = marker('Vault');
  const raiderName = marker('Chief');
  const friendName = marker('Second');
  const target = await openPlayer(browser, request, targetName);
  const raider = await openPlayer(browser, request, raiderName);
  const friend = await openPlayer(browser, request, friendName);
  await ageCharacters([targetName, raiderName, friendName]);
  await setCoins(targetName, 60);

  await enterGame(target.page, targetName, target.credentials);
  await enterGame(raider.page, raiderName, raider.credentials);
  await enterGame(friend.page, friendName, friend.credentials);

  await openFinder(raider.page);
  await raider.page.getByLabel('Search players by name').fill(targetName);
  await raider.page.getByRole('button', { name: `Raid ${targetName}` }).click();
  await expect(raider.page.getByRole('heading', { name: `Raiding ${targetName}` })).toBeVisible({
    timeout: 10_000,
  });

  /**
   * Filling the party had the same gap as aiming it. "Find raiders" used to only collapse
   * the card and leave you hoping the person you wanted had just posted in the Town Square;
   * it now opens a searchable list of everyone.
   *
   * The list lives in this collapsed state rather than on the party card itself, because on
   * the card it loaded asynchronously above "Fire the raid" and moved that button under the
   * player's finger mid-hold.
   */
  await raider.page.getByRole('button', { name: 'Find raiders' }).click();
  await expect(raider.page.getByRole('heading', { name: 'Bring someone along' })).toBeVisible();
  await raider.page.getByLabel('Search players by name').fill(friendName);
  const invite = raider.page.getByRole('button', { name: `Invite ${friendName}` });
  await expect(invite).toBeEnabled();
  await invite.click();

  // And the person being robbed is never offered as a recruit.
  await raider.page.getByLabel('Search players by name').fill(targetName);
  const targetRow = raider.page.locator('.people-row').filter({ hasText: targetName });
  await expect(targetRow).toContainText('The target');
  await expect(raider.page.getByRole('button', { name: `Invite ${targetName}` })).toBeDisabled();

  await raider.page.close();
  await friend.page.close();
  await target.page.close();
});
