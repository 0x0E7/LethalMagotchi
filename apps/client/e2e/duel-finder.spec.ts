import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { createAccount, createCharacterOutOfBand, login, type Credentials } from './helpers.js';

/**
 * The way into a duel from the main screen.
 *
 * Every earlier path to a challenge ran through a Town Square message, so a player who was
 * not reading chat had no way to find the feature at all — which is how "there is no button
 * or option to invite someone for a duel" became a fair description of a shipped system.
 * These tests hold the front door open: the button exists on the pet screen, it finds a
 * named player, it finds an unnamed one, and it says why when someone cannot fight.
 */

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://lethal:lethal@localhost:5432/lethalmagotchi_test';

function marker(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

/** Duels open at 24 hours old, and a test cannot wait a day. */
async function ageCharacters(nicknames: string[]): Promise<void> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    await pool.query(
      `UPDATE characters SET created_at = now() - interval '48 hours' WHERE nickname = ANY($1::text[])`,
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

async function enterGame(page: Page, nickname: string, credentials: Credentials): Promise<void> {
  await login(page, credentials);
  await expect(page.getByRole('heading', { name: nickname })).toBeVisible();
}

const openFinder = (page: Page) => page.getByRole('button', { name: 'Find a duel' }).click();

test('the main screen carries a duel button that finds a player by name', async ({ browser, request }) => {
  const targetName = marker('Quarry');
  const challengerName = marker('Hunter');
  const target = await openPlayer(browser, request, targetName);
  const challenger = await openPlayer(browser, request, challengerName);
  await ageCharacters([targetName, challengerName]);

  // The target never says a word. Before the finder existed that made them unchallengeable.
  await enterGame(target.page, targetName, target.credentials);
  await enterGame(challenger.page, challengerName, challenger.credentials);

  await openFinder(challenger.page);
  await expect(challenger.page.getByRole('heading', { name: 'Find a duel' })).toBeVisible();

  await challenger.page.getByLabel('Search players by name').fill(targetName);
  const duelButton = challenger.page.getByRole('button', { name: `Duel ${targetName}` });
  await expect(duelButton).toBeEnabled();
  await duelButton.click();

  // It opens the real Stakes Card — the same consent moment the Town Square button opens,
  // not a directory-only shortcut that skips it.
  const stakes = challenger.page.getByRole('dialog');
  await expect(stakes).toContainText(`Challenge ${targetName} to a duel?`);
  // The challenger's own card names the challenger's death, not the target's — the
  // symmetric confirmation, so nobody issues a lethal duel without reading the sentence
  // they are asking someone else to read.
  await expect(stakes).toContainText(`${challengerName} dies`);

  // And the finder is gone, rather than stacked behind the card.
  await expect(challenger.page.getByRole('heading', { name: 'Find a duel' })).toBeHidden();

  await challenger.page.close();
  await target.page.close();
});

test('a random opponent is offered without naming anyone first', async ({ browser, request }) => {
  const challengerName = marker('Roamer');
  const challenger = await openPlayer(browser, request, challengerName);
  await ageCharacters([challengerName]);
  await enterGame(challenger.page, challengerName, challenger.credentials);

  await openFinder(challenger.page);
  await challenger.page.getByRole('button', { name: 'Random opponent' }).click();

  /**
   * The suite shares a long-lived database and other specs keep sockets open, so who is
   * online here is genuinely unpredictable. Both answers are correct — a Stakes Card naming
   * *somebody*, or a plain statement that nobody is free — and asserting on either alone
   * would be asserting on the rest of the suite's timing.
   */
  const stakes = challenger.page.getByRole('dialog').filter({ hasText: 'to a duel?' });
  const nobody = challenger.page.getByText('Nobody is free to duel right now');
  await expect(stakes.or(nobody).first()).toBeVisible({ timeout: 10_000 });

  // What must never happen either way: a duel committed without the stakes being shown.
  await expect(challenger.page.getByText('Waiting for')).toBeHidden();

  await challenger.page.close();
});

test('a player who cannot fight is greyed out, with the reason beside them', async ({ browser, request }) => {
  const freshName = marker('Sprout');
  const challengerName = marker('Waiting');
  const fresh = await openPlayer(browser, request, freshName);
  const challenger = await openPlayer(browser, request, challengerName);
  // Only the challenger is aged. The other is seconds old, which is the commonest reason a
  // duel is refused and the one that used to look like the feature being missing.
  await ageCharacters([challengerName]);

  await enterGame(fresh.page, freshName, fresh.credentials);
  await enterGame(challenger.page, challengerName, challenger.credentials);

  await openFinder(challenger.page);
  await challenger.page.getByLabel('Search players by name').fill(freshName);

  const duelButton = challenger.page.getByRole('button', { name: `Duel ${freshName}` });
  await expect(duelButton).toBeVisible();
  await expect(duelButton).toBeDisabled();
  // Greyed out *and* explained: a dead button with no reason is barely better than no button.
  await expect(challenger.page.locator('.people-row').filter({ hasText: freshName })).toContainText('Too new');

  await challenger.page.close();
  await fresh.page.close();
});

test('someone who has gone offline reads as away, not as available', async ({ browser, request }) => {
  const awayName = marker('Ghost');
  const challengerName = marker('Caller');
  const away = await openPlayer(browser, request, awayName);
  const challenger = await openPlayer(browser, request, challengerName);
  await ageCharacters([awayName, challengerName]);

  // They log in, then leave. An invite expires in a minute, so the server refuses a
  // challenge to an empty chair — the card has to say so rather than offering it anyway.
  await enterGame(away.page, awayName, away.credentials);
  await away.page.close();

  await enterGame(challenger.page, challengerName, challenger.credentials);
  await openFinder(challenger.page);
  await challenger.page.getByLabel('Search players by name').fill(awayName);

  const row = challenger.page.locator('.people-row').filter({ hasText: awayName });
  await expect(row).toContainText('Away', { timeout: 10_000 });
  await expect(challenger.page.getByRole('button', { name: `Duel ${awayName}` })).toBeDisabled();

  await challenger.page.close();
});
