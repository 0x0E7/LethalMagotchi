import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { startAtPetScreen } from './helpers.js';

/**
 * The reported chat bugs, each pinned by the thing a player actually sees.
 *
 * Three of them were one root cause wearing three faces: there was no way to *find* a
 * player, so direct messages and group invitations were both unusable against anyone who
 * was not currently talking in the Town Square.
 */

function marker(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

async function openPlayer(browser: Browser, request: APIRequestContext, nickname: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await startAtPetScreen(page, request, nickname);
  await page.getByRole('button', { name: /^Chat/ }).click();
  await expect(page.getByRole('tab', { name: /Town Square/ })).toBeVisible();
  return page;
}

const composer = (page: Page) => page.getByLabel(/^Write a message to /);

test('the composer wraps and grows instead of hiding what is being typed', async ({ browser, request }) => {
  const page = await openPlayer(browser, request, marker('Scribe'));

  // The bug: a single-line <input> cannot wrap, so a long message scrolled sideways out of
  // view while it was still being written.
  await expect(composer(page)).toHaveJSProperty('tagName', 'TEXTAREA');

  const startHeight = await composer(page).evaluate((box) => box.clientHeight);
  await composer(page).fill(
    'A message long enough to need more than one line in a dock this wide, which is exactly the case that used to disappear off the side of the box while it was being typed.',
  );
  const grownHeight = await composer(page).evaluate((box) => box.clientHeight);
  expect(grownHeight).toBeGreaterThan(startHeight);

  // Grown, but not without limit: past the cap it scrolls rather than eating the panel.
  const panelHeight = await page.locator('.chat-panel').evaluate((panel) => panel.clientHeight);
  expect(grownHeight).toBeLessThan(panelHeight / 2);

  // And every character of it is reachable, which is the actual complaint.
  const scrollsSideways = await composer(page).evaluate((box) => box.scrollWidth > box.clientWidth + 1);
  expect(scrollsSideways).toBe(false);

  await page.close();
});

test('Enter sends, and the message does not sit on "Sending…"', async ({ browser, request }) => {
  const page = await openPlayer(browser, request, marker('Typist'));
  const text = marker('sent-with-enter');

  await composer(page).fill(text);
  await composer(page).press('Enter');

  // The send lands...
  await expect(page.getByRole('log').getByText(text)).toBeVisible();
  // ...the composer clears, and nothing is left claiming to still be working.
  await expect(composer(page)).toHaveValue('');
  await expect(page.locator('.chat-pending')).toHaveCount(0);

  await page.close();
});

test('a quiet player can be found by name and sent a direct message', async ({ browser, request }) => {
  // Neither of these two ever posts in the Town Square. Before the directory existed that
  // made them unreachable: the only way to open a DM was to click a name on a message.
  const quietName = marker('Hermit');
  const quiet = await openPlayer(browser, request, quietName);
  const pigeon = await openPlayer(browser, request, marker('Pigeon'));

  await pigeon.getByRole('tab', { name: /Direct/ }).click();
  await pigeon.getByLabel('Search players by name').fill(quietName);

  await pigeon.getByRole('button', { name: `Message ${quietName}` }).click();

  // The DM opens as a real thread, addressed to them.
  await expect(pigeon.getByLabel(new RegExp(`Write a message to ${quietName}`))).toBeVisible();

  const hello = marker('found-you');
  await pigeon.getByLabel(new RegExp(`Write a message to ${quietName}`)).fill(hello);
  await pigeon.getByRole('button', { name: 'Send' }).click();

  // And it arrives at the other end, live. Scoped to the log: the panel also carries a
  // polite live region repeating the newest message, which an unscoped match would find.
  await quiet.getByRole('tab', { name: /Direct/ }).click();
  await expect(quiet.getByRole('log').getByText(hello)).toBeVisible({ timeout: 10_000 });

  await pigeon.close();
  await quiet.close();
});

test('the search says so plainly when there is nobody by that name', async ({ browser, request }) => {
  const page = await openPlayer(browser, request, marker('Looker'));

  await page.getByRole('tab', { name: /Direct/ }).click();
  await page.getByLabel('Search players by name').fill(marker('nobody-called-this'));

  await expect(page.getByText('Nobody by that name.')).toBeVisible();

  await page.close();
});

test('a group is created in a legible field, then filled from the directory', async ({ browser, request }) => {
  const chiefName = marker('Chief');
  const newbieName = marker('Newbie');
  const chief = await openPlayer(browser, request, chiefName);
  const newbie = await openPlayer(browser, request, newbieName);

  // No aging, deliberately: both accounts were created seconds ago. Founding a group and
  // being added to one are immediate now, and a fresh account proving it is the point.
  await chief.getByRole('tab', { name: /Groups/ }).click();

  // The name field had been sharing one line with the Create button, leaving a stub too
  // narrow to read a group name back from. It gets its own full-width line now.
  const nameField = chief.getByLabel('Group name');
  const fieldWidth = await nameField.evaluate((input) => input.clientWidth);
  const formWidth = await chief.locator('.group-create').evaluate((form) => form.clientWidth);
  expect(fieldWidth).toBeGreaterThan(formWidth * 0.8);

  const name = marker('Otters');
  await nameField.fill(name);
  await chief.getByRole('button', { name: 'Create' }).click();
  await expect(chief.getByRole('heading', { name })).toBeVisible();

  // The second reported gap: there was no way to add anyone who was not already talking.
  await chief.getByLabel('Search players by name').fill(newbieName);
  await chief.getByRole('button', { name: `Add ${newbieName}` }).click();

  // The invitation reaches them, and they can take it.
  await newbie.getByRole('tab', { name: /Groups/ }).click();
  await expect(newbie.getByText(name)).toBeVisible({ timeout: 10_000 });
  await newbie.getByRole('button', { name: 'Accept' }).click();
  await expect(newbie.getByRole('heading', { name })).toBeVisible();

  await chief.close();
  await newbie.close();
});

/**
 * The panel is a floating dock on a desktop and a sheet on a phone. What must hold at every
 * size is simpler than either: nothing may overflow the viewport sideways, and the composer
 * has to stay reachable.
 */
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'small phone', width: 320, height: 568 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'laptop', width: 1280, height: 800 },
  { name: 'wide monitor', width: 1920, height: 1080 },
  { name: 'short landscape', width: 844, height: 390 },
];

for (const viewport of VIEWPORTS) {
  test(`the chat panel fits a ${viewport.name} without overflowing`, async ({ browser, request }) => {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
    const page = await context.newPage();
    await startAtPetScreen(page, request, marker('Responsive'));
    await page.getByRole('button', { name: /^Chat/ }).click();
    await expect(page.getByRole('tab', { name: /Town Square/ })).toBeVisible();

    // The page itself never scrolls sideways.
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflows, `horizontal overflow at ${viewport.width}px`).toBe(false);

    // The panel stays inside the viewport on every edge.
    const panel = await page.locator('.chat-panel').boundingBox();
    expect(panel).not.toBeNull();
    expect(panel!.x).toBeGreaterThanOrEqual(0);
    expect(panel!.y).toBeGreaterThanOrEqual(0);
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(panel!.y + panel!.height).toBeLessThanOrEqual(viewport.height + 1);

    // And the thing you came to use is on screen and usable.
    const box = await composer(page).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(120);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);

    await composer(page).fill('still reachable');
    await expect(composer(page)).toHaveValue('still reachable');

    await context.close();
  });
}
