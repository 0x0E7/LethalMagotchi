import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { axeViolations, createAccount, createCharacterOutOfBand, login, type Credentials } from './helpers.js';

/**
 * Three real browsers, one server, one robbery. Everything crosses the wire the way it does
 * in production: the party, the lock-in, the comparison, the betrayal window and the payout.
 */
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://lethal:lethal@localhost:5432/lethalmagotchi_test';

/** The Town Square is long-lived and shared, so every fixture name has to be unique. */
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

/**
 * Raids open at 24 hours old and are decided by wallet arithmetic, so both have to be set up
 * out of band. This is the one thing the spec reaches into the database for.
 */
async function prepare(entries: { nickname: string; coins: number }[]): Promise<void> {
  await withDb(async (pool) => {
    for (const entry of entries) {
      await pool.query(
        `UPDATE characters
         SET created_at = now() - interval '48 hours',
             lethal_coins = $2,
             raid_immunity_until = NULL,
             last_raid_at = NULL
         WHERE nickname = $1`,
        [entry.nickname, entry.coins],
      );
    }
  });
}

async function coinsOf(nickname: string): Promise<number> {
  return withDb(async (pool) => {
    const result = await pool.query<{ lethal_coins: number }>(
      'SELECT lethal_coins FROM characters WHERE nickname = $1',
      [nickname],
    );
    return result.rows[0]!.lethal_coins;
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

/** The one deliberate gesture: press and hold, rather than a bare click. */
async function holdToConfirm(page: Page, name: RegExp): Promise<void> {
  const button = page.getByRole('button', { name });
  await button.hover();
  await page.mouse.down();
  await page.waitForTimeout(1_600);
  await page.mouse.up();
}

test('a raiding party robs a fourth player, splits the pot, and leaves a beggar', async ({ browser, request }) => {
  test.setTimeout(120_000);

  const names = {
    lead: marker('Ash'),
    second: marker('Bo'),
    third: marker('Cy'),
    victim: marker('Tam'),
  };
  const lead = await openPlayer(browser, request, names.lead);
  const second = await openPlayer(browser, request, names.second);
  const third = await openPlayer(browser, request, names.third);
  const victim = await openPlayer(browser, request, names.victim);

  // 3 x 20 = 60 against 30: the party wins, and the pot of 90 divides evenly by three.
  await prepare([
    { nickname: names.lead, coins: 20 },
    { nickname: names.second, coins: 20 },
    { nickname: names.third, coins: 20 },
    { nickname: names.victim, coins: 30 },
  ]);

  await enterTownSquare(lead.page, names.lead, lead.credentials);
  await enterTownSquare(second.page, names.second, second.credentials);
  await enterTownSquare(third.page, names.third, third.credentials);

  await enterTownSquare(victim.page, names.victim, victim.credentials);

  // The Town Square is where you meet the people you raid, and the people you raid with:
  // there is no player directory, so everyone has to have spoken.
  for (const speaker of [victim, second, third]) {
    const line = marker('raid-hello');
    await say(speaker.page, line);
    await expect(lead.page.getByRole('log').getByText(line)).toBeVisible();
  }

  await lead.page.getByRole('button', { name: `Raid ${names.victim}` }).first().click();

  const party = lead.page.getByRole('dialog');
  await expect(party).toContainText(`Raiding ${names.victim}`);
  // A raider only ever learns a band, never a balance.
  await expect(party).toContainText('Wealthy');
  await expect(party).not.toContainText('30 LC');
  expect(await axeViolations(lead.page)).toEqual([]);

  await expect(party).toContainText('1 of 3 raiders in');
  await withDb(async (pool) => {
    const raid = await pool.query<{ id: string }>(
      `SELECT r.id FROM raids r JOIN characters c ON c.id = r.initiator_character_id
       WHERE c.nickname = $1 AND r.state = 'assembling'`,
      [names.lead],
    );
    expect(raid.rowCount).toBe(1);
  });

  // The party card stands aside so the initiator can reach the rows they invite from, and
  // the same affordance that started the raid is now how it is filled.
  await party.getByRole('button', { name: 'Find raiders' }).click();
  await lead.page.getByRole('button', { name: `Invite ${names.second}` }).first().click();

  const invite = second.page.getByRole('dialog');
  await expect(invite).toContainText(`wants to raid ${names.victim}`);
  await expect(invite).toContainText('All 20 LC');
  await expect(invite).toContainText('never touches HP');
  // Declining is the focused default here too, and it is free: no badge for refusing to
  // gang up on somebody.
  await expect(invite.getByRole('button', { name: 'Decline' })).toBeFocused();
  expect(await axeViolations(second.page)).toEqual([]);
  await holdToConfirm(second.page, /Join the raid/);

  await lead.page.getByRole('button', { name: `Invite ${names.third}` }).first().click();
  await holdToConfirm(third.page, /Join the raid/);

  // Back to the party, which now has all three.
  await lead.page.getByRole('button', { name: /^Raid on / }).click();
  await expect(lead.page.getByRole('dialog')).toContainText('3 of 3 raiders in');
  await holdToConfirm(lead.page, /Fire the raid/);

  // The reveal: both totals, in full, for the first time anywhere.
  await expect(lead.page).toHaveURL(/\/raid$/);
  await expect(lead.page.getByText('60 LC')).toBeVisible();
  await expect(lead.page.getByText('30 LC')).toBeVisible();
  await expect(lead.page.getByText('The raid takes 90 LC.')).toBeVisible();
  expect(await axeViolations(lead.page)).toEqual([]);

  // The betrayal screen names both choices neutrally and shows no hint of the other's.
  const split = lead.page.getByRole('button', { name: 'Split' });
  await expect(split).toBeVisible();
  await expect(lead.page.getByRole('button', { name: 'Take it all' })).toBeVisible();
  await expect(lead.page.locator('body')).not.toContainText('took it all');

  await split.click();
  await second.page.getByRole('button', { name: 'Split' }).click();
  await third.page.getByRole('button', { name: 'Split' }).click();

  // 90 among three loyalists divides exactly, so there is no parity round to play.
  await expect(lead.page.getByText('You take 30 LC.')).toBeVisible({ timeout: 20_000 });
  await lead.page.getByRole('button', { name: 'Return to town' }).click();
  await expect(lead.page).toHaveURL(/\/pet$/);

  expect(await coinsOf(names.lead)).toBe(30);
  expect(await coinsOf(names.second)).toBe(30);
  expect(await coinsOf(names.third)).toBe(30);
  expect(await coinsOf(names.victim)).toBe(0);
  await expect(lead.page.getByLabel('30 LethalCoins')).toBeVisible();

  // The victim, who was present but never asked, gets the report — and it leads with the
  // reassurance rather than with the loss.
  const aftermath = victim.page.getByRole('dialog');
  await expect(aftermath).toContainText(`${names.victim} was robbed`);
  await expect(aftermath).toContainText('alive and well');
  await expect(aftermath).toContainText('HP, stats and cooldowns are exactly where you left them');
  await expect(aftermath).toContainText('30 LC taken');
  expect(await axeViolations(victim.page)).toEqual([]);

  // No rebirth anywhere: a raid is a coin-ledger operation and nothing else.
  await withDb(async (pool) => {
    const rebirths = await pool.query(
      `SELECT 1 FROM rebirth_events e JOIN characters c ON c.id = e.character_id WHERE c.nickname = $1`,
      [names.victim],
    );
    expect(rebirths.rowCount).toBe(0);
    const hp = await pool.query<{ hp: string }>(
      `SELECT stats->>'hp' AS hp FROM characters WHERE nickname = $1`,
      [names.victim],
    );
    expect(Number(hp.rows[0]!.hp)).toBe(100);
  });

  // And the way back is on their own screen, beside their own badge.
  await aftermath.getByRole('button', { name: 'Got it' }).click();
  await expect(victim.page.getByRole('button', { name: 'Ask for donations' })).toBeVisible();
});

test('a bankrupted player appeals and one donation ends their begging', async ({ browser, request }) => {
  test.setTimeout(90_000);

  const beggarName = marker('Nub');
  const donorName = marker('Gen');
  const beggar = await openPlayer(browser, request, beggarName);
  const donor = await openPlayer(browser, request, donorName);
  await prepare([
    { nickname: beggarName, coins: 0 },
    { nickname: donorName, coins: 25 },
  ]);

  await enterTownSquare(beggar.page, beggarName, beggar.credentials);
  await enterTownSquare(donor.page, donorName, donor.credentials);

  // The badge is derived from the wallet, so it is simply there at zero.
  await expect(beggar.page.locator('.beggar-strip .beggar-badge')).toBeVisible();

  await beggar.page.getByRole('button', { name: 'Ask for donations' }).click();
  await expect(donor.page.getByRole('log')).toContainText(`${beggarName} is begging for coins.`);

  // The donor needs to see them in the Square to reach the affordance.
  const hello = marker('beg-hello');
  await say(beggar.page, hello);
  await expect(donor.page.getByRole('log').getByText(hello)).toBeVisible();

  await donor.page.getByRole('button', { name: `Donate to ${beggarName}` }).first().click();
  const dialog = donor.page.getByRole('dialog');
  // The one thing that is easy to get wrong is said plainly.
  await expect(dialog).toContainText('This ends their begging.');
  expect(await axeViolations(donor.page)).toEqual([]);

  await dialog.getByLabel('How many LethalCoins').fill('4');
  await dialog.getByRole('button', { name: /Send 4 LC/ }).click();
  await expect(dialog).toContainText('is not begging any more');
  await dialog.getByRole('button', { name: 'Close' }).click();

  expect(await coinsOf(beggarName)).toBe(4);
  expect(await coinsOf(donorName)).toBe(21);

  // The badge lifts on the first coin, with no timer and nothing to expire.
  await expect(beggar.page.getByLabel('4 LethalCoins')).toBeVisible();
  await expect(beggar.page.locator('.beggar-strip')).toHaveCount(0);
  await expect(beggar.page.getByRole('button', { name: 'Ask for donations' })).toHaveCount(0);
});

test('the donate affordance is absent, not disabled, for anyone who is not a beggar', async ({
  browser,
  request,
}) => {
  test.setTimeout(90_000);

  const solventName = marker('Sol');
  const watcherName = marker('Wat');
  const solvent = await openPlayer(browser, request, solventName);
  const watcher = await openPlayer(browser, request, watcherName);
  await prepare([
    { nickname: solventName, coins: 6 },
    { nickname: watcherName, coins: 20 },
  ]);

  await enterTownSquare(solvent.page, solventName, solvent.credentials);
  await enterTownSquare(watcher.page, watcherName, watcher.credentials);

  const hello = marker('solvent-hello');
  await say(solvent.page, hello);
  await expect(watcher.page.getByRole('log').getByText(hello)).toBeVisible();

  // Absent entirely, matching the absent-not-greyed rule the admin panel established.
  await expect(watcher.page.getByRole('button', { name: `Donate to ${solventName}` })).toHaveCount(0);
  await expect(watcher.page.getByRole('button', { name: `Raid ${solventName}` })).toHaveCount(1);

  // And it appears the moment they actually hold nothing.
  await withDb((pool) =>
    pool.query('UPDATE characters SET lethal_coins = 0 WHERE nickname = $1', [solventName]),
  );
  await watcher.page.reload();
  await watcher.page.getByRole('button', { name: /^Chat/ }).click();
  await expect(watcher.page.getByRole('button', { name: `Donate to ${solventName}` }).first()).toBeVisible();
  // A player with nothing is also below the raid floor, so that affordance goes.
  await expect(watcher.page.getByRole('button', { name: `Raid ${solventName}` })).toHaveCount(0);
});

/**
 * The client-visible half of "escrow is not poverty": while a raid holds a raider's whole
 * wallet, every other player's Town Square must show them as an ordinary player — no badge,
 * no donate affordance — and the player the raid actually emptied must show as a beggar the
 * moment it ends.
 */
test('an escrowed raider is not a beggar in the Town Square, but the player they emptied is', async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);

  const names = {
    lead: marker('Rik'),
    second: marker('Sal'),
    victim: marker('Vik'),
    watcher: marker('Wen'),
  };
  const lead = await openPlayer(browser, request, names.lead);
  const second = await openPlayer(browser, request, names.second);
  const victim = await openPlayer(browser, request, names.victim);
  const watcher = await openPlayer(browser, request, names.watcher);

  // 20 + 20 against 30: the party wins, and the pot of 70 divides evenly by two.
  await prepare([
    { nickname: names.lead, coins: 20 },
    { nickname: names.second, coins: 20 },
    { nickname: names.victim, coins: 30 },
    { nickname: names.watcher, coins: 20 },
  ]);

  await enterTownSquare(lead.page, names.lead, lead.credentials);
  await enterTownSquare(second.page, names.second, second.credentials);
  await enterTownSquare(victim.page, names.victim, victim.credentials);
  await enterTownSquare(watcher.page, names.watcher, watcher.credentials);

  const leadLine = marker('escrow-hello');
  const victimLine = marker('victim-hello');
  await say(lead.page, leadLine);
  await say(victim.page, victimLine);
  await say(second.page, marker('second-hello'));
  await expect(watcher.page.getByRole('log').getByText(leadLine)).toBeVisible();
  await expect(watcher.page.getByRole('log').getByText(victimLine)).toBeVisible();
  await expect(lead.page.getByRole('log').getByText(victimLine)).toBeVisible();

  await lead.page.getByRole('button', { name: `Raid ${names.victim}` }).first().click();
  await lead.page.getByRole('dialog').getByRole('button', { name: 'Find raiders' }).click();
  await lead.page.getByRole('button', { name: `Invite ${names.second}` }).first().click();
  await holdToConfirm(second.page, /Join the raid/);
  await lead.page.getByRole('button', { name: /^Raid on / }).click();
  await expect(lead.page.getByRole('dialog')).toContainText('2 of 3 raiders in');
  await holdToConfirm(lead.page, /Fire the raid/);
  await expect(lead.page).toHaveURL(/\/raid$/);

  // Both raiders' wallets are now in escrow, and the victim's has been taken.
  expect(await coinsOf(names.lead)).toBe(0);
  expect(await coinsOf(names.victim)).toBe(0);

  await watcher.page.reload();
  await watcher.page.getByRole('button', { name: /^Chat/ }).click();
  const raiderRow = watcher.page.locator('li.chat-message', { hasText: leadLine });
  // The card is loaded — the standing is there — so an absent badge means absent, not missing.
  await expect(raiderRow.locator('.chat-duel-record')).toBeVisible();
  await expect(raiderRow.locator('.beggar-badge')).toHaveCount(0);
  await expect(watcher.page.getByRole('button', { name: `Donate to ${names.lead}` })).toHaveCount(0);

  // The player the raid actually emptied is a beggar on the same screen, at the same moment.
  const victimRow = watcher.page.locator('li.chat-message', { hasText: victimLine });
  await expect(victimRow.locator('.beggar-badge')).toBeVisible();
  await expect(watcher.page.getByRole('button', { name: `Donate to ${names.victim}` }).first()).toBeVisible();

  // And once the pot is paid out the raiders are solvent again, with nothing left staked.
  await lead.page.getByRole('button', { name: 'Split' }).click();
  await second.page.getByRole('button', { name: 'Split' }).click();
  await expect(lead.page.getByText('You take 35 LC.')).toBeVisible({ timeout: 20_000 });
  expect(await coinsOf(names.lead)).toBe(35);
});
