import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { axeViolations, createAccount, createCharacterOutOfBand, login, type Credentials } from './helpers.js';

/**
 * Two real browsers, one server, one duel to the death. Everything crosses the wire the way
 * it does in production: the invite, the commit windows, the reveal and the settlement.
 */
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://lethal:lethal@localhost:5432/lethalmagotchi_test';

/** The Town Square is long-lived and shared, so every fixture name has to be unique. */
function marker(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

/**
 * Duels open at 24 hours old, and a test cannot wait a day. This is the one thing the spec
 * reaches into the database for; everything else goes through the product.
 */
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

async function coinsOf(nickname: string): Promise<number> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    const result = await pool.query<{ lethal_coins: number }>(
      'SELECT lethal_coins FROM characters WHERE nickname = $1',
      [nickname],
    );
    return result.rows[0]!.lethal_coins;
  } finally {
    await pool.end();
  }
}

async function setCoins(nickname: string, coins: number): Promise<void> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    await pool.query('UPDATE characters SET lethal_coins = $2 WHERE nickname = $1', [nickname, coins]);
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

/** The Stakes Card's one deliberate gesture: press and hold, rather than a bare click. */
async function holdToConfirm(page: Page, name: RegExp): Promise<void> {
  const button = page.getByRole('button', { name });
  await button.hover();
  await page.mouse.down();
  await page.waitForTimeout(1_600);
  await page.mouse.up();
}

async function throwHand(page: Page, choice: 'Rock' | 'Paper' | 'Scissors'): Promise<void> {
  const button = page.getByRole('button', { name: choice, exact: false }).first();
  await expect(button).toBeEnabled({ timeout: 15_000 });
  await button.click();
}

test('two players duel to a real death, and the loser is reborn', async ({ browser, request }) => {
  test.setTimeout(90_000);

  const winnerName = marker('Miso');
  const loserName = marker('Pepper');
  const winner = await openPlayer(browser, request, winnerName);
  const loser = await openPlayer(browser, request, loserName);
  await ageCharacters([winnerName, loserName]);
  await setCoins(winnerName, 120);
  await setCoins(loserName, 40);

  await enterTownSquare(winner.page, winnerName, winner.credentials);
  await enterTownSquare(loser.page, loserName, loser.credentials);

  // The Town Square is where you meet someone to challenge — there is no player directory.
  const hello = marker('duel-hello');
  await say(winner.page, hello);
  await expect(loser.page.getByRole('log').getByText(hello)).toBeVisible();

  await loser.page.getByRole('button', { name: `Duel ${winnerName}` }).first().click();

  // Both sides read the same three rows before anything is committed.
  await expect(loser.page.getByRole('dialog')).toContainText(`If ${loserName} loses`);
  await expect(loser.page.getByRole('dialog')).toContainText(`${loserName} dies`);
  await holdToConfirm(loser.page, /Send the challenge/);
  await expect(loser.page.getByText(`Waiting for ${winnerName} to answer…`)).toBeVisible();

  const invite = winner.page.getByRole('dialog');
  await expect(invite).toContainText(`${loserName} has challenged ${winnerName} to a duel.`);
  // Decline is the focused default; accepting is the deliberate one.
  await expect(invite.getByRole('button', { name: 'Decline' })).toBeFocused();
  expect(await axeViolations(winner.page)).toEqual([]);
  await holdToConfirm(winner.page, /Accept the duel/);

  await expect(winner.page).toHaveURL(/\/duel$/);
  await expect(loser.page).toHaveURL(/\/duel$/);
  // No HP bars anywhere: HP is not an input to a duel.
  await expect(winner.page.locator('.hp-bar')).toHaveCount(0);
  expect(await axeViolations(winner.page)).toEqual([]);

  // Rock beats scissors, twice: a deterministic 2-0.
  for (let round = 0; round < 2; round += 1) {
    await Promise.all([throwHand(winner.page, 'Rock'), throwHand(loser.page, 'Scissors')]);
    // The log gains a row per resolved round — replays included, which is what stops a 2-1
    // from ever looking like a 2-0.
    await expect(winner.page.locator('.duel-log-row')).toHaveCount(round + 1, { timeout: 15_000 });
  }

  // The loser is told what beat them and what the stake cost them, before anything about a
  // rebirth. The only coin figure here is the stake that changed hands: their actual balance
  // is decided by the rebirth reset, and the rebirth dialog is the one place that is quoted.
  const defeat = loser.page.getByRole('dialog', { name: 'You lost the duel' });
  await expect(defeat).toContainText(`${loserName} was defeated by ${winnerName}`);
  await expect(defeat).toContainText(`40 LC of the stake goes to ${winnerName}.`);
  await expect(defeat).toContainText('reset with the rebirth');
  await expect(defeat).not.toContainText('LC lost');

  const victory = winner.page.getByRole('dialog', { name: 'You won the duel' });
  await expect(victory).toContainText(`${loserName} fell.`);
  await expect(victory).toContainText('takes 40 LC');

  await defeat.getByRole('button', { name: 'Return to town' }).click();

  // Only now does the rebirth take over, and it names the real cause.
  const rebirth = loser.page.getByRole('dialog', { name: `${loserName} was reborn` });
  await expect(rebirth).toContainText(`${loserName} lost the duel.`);
  // The two dialogs a losing player sees, seconds apart, agree: the stake is the 40 that
  // moved, and the balance claim is made once, here.
  await expect(rebirth).toContainText('40 coins became 5');
  await rebirth.getByRole('button', { name: 'Got it' }).click();

  await victory.getByRole('button', { name: 'Return to town' }).click();
  await expect(winner.page).toHaveURL(/\/pet$/);

  // The wallet moved by exactly the smaller of the two, and the loser took the usual reset.
  expect(await coinsOf(winnerName)).toBe(160);
  expect(await coinsOf(loserName)).toBe(5);
  await expect(winner.page.getByLabel('160 LethalCoins')).toBeVisible();

  // And the town heard about it.
  await expect(winner.page.getByRole('log')).toContainText(
    `${winnerName} defeated ${loserName} in a duel.`,
  );
});

test('declining marks the decliner and closes that pairing for the day', async ({ browser, request }) => {
  test.setTimeout(90_000);

  const challengerName = marker('Pushy');
  const targetName = marker('Careful');
  const challenger = await openPlayer(browser, request, challengerName);
  const target = await openPlayer(browser, request, targetName);
  await ageCharacters([challengerName, targetName]);

  await enterTownSquare(challenger.page, challengerName, challenger.credentials);
  await enterTownSquare(target.page, targetName, target.credentials);

  const hello = marker('decline-hello');
  await say(target.page, hello);
  await expect(challenger.page.getByRole('log').getByText(hello)).toBeVisible();

  await challenger.page.getByRole('button', { name: `Duel ${targetName}` }).first().click();
  await holdToConfirm(challenger.page, /Send the challenge/);

  const invite = target.page.getByRole('dialog');
  await expect(invite).toContainText(`${challengerName} has challenged`);
  await invite.getByRole('button', { name: 'Decline' }).click();

  // Framed as a fact, never as cowardice.
  const outgoing = challenger.page.getByRole('dialog');
  await expect(outgoing).toContainText(`${targetName} turned the challenge down.`);
  await outgoing.getByRole('button', { name: 'Close' }).click();

  // The badge is public, next to the name, for a rolling day.
  await expect(challenger.page.getByRole('log').getByTitle('Turned down a duel in the last day').first()).toBeVisible();

  // And that pairing is closed until it lapses.
  await challenger.page.getByRole('button', { name: `Duel ${targetName}` }).first().click();
  await holdToConfirm(challenger.page, /Send the challenge/);
  await expect(challenger.page.getByRole('alert')).toContainText('turned you down recently');
});
