import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { startAtPetScreen } from './helpers.js';

/**
 * NEW-4 empties the live region by nulling `lastIncoming`, but `useAnnouncer` keeps its own
 * throttled `message` state, which still holds the blocked author's words. The panel used to
 * render `lastIncoming ? announcement : ''` — so the next message from *anyone else*, if it
 * landed inside the 1500 ms announce throttle, made `lastIncoming` truthy again while
 * `announcement` was still the blocked author's line.
 */

function marker(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

async function openPlayer(browser: Browser, request: APIRequestContext, nickname: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await startAtPetScreen(page, request, nickname);
  await page.getByRole('button', { name: /^Chat/ }).click();
  return page;
}

/**
 * NEW-5's regression test. The region now renders an announcement only while it is still the
 * announcement for the message the panel currently holds, so the throttled copy of a blocked
 * author's line has nothing to attach itself to.
 */
test('LEAK: a blocked author is re-announced when the next message lands inside the throttle', async ({
  browser,
  request,
}) => {
  const aliceName = marker('Wisp');
  const carolName = marker('Bystander');
  const alice = await openPlayer(browser, request, aliceName);
  const carol = await openPlayer(browser, request, carolName);
  const bob = await openPlayer(browser, request, marker('Listener'));

  const region = bob.locator('.chat-dock [role="status"]');

  // Alice speaks in the Town Square so Bob can open a DM with her.
  const intro = marker('intro');
  await alice.getByLabel(/^Write a message to /).fill(intro);
  await alice.getByRole('button', { name: 'Send' }).click();
  await expect(bob.getByRole('log').getByText(intro)).toBeVisible();

  // Bob opens the DM and parks on the Block button.
  await bob.getByRole('log').getByRole('button', { name: `Message ${aliceName}` }).first().click();
  const blockButton = bob.getByRole('button', { name: 'Block', exact: true });
  await expect(blockButton).toBeVisible();

  // Carol pre-loads her message so sending it later costs one click, not a fill round trip.
  const bystander = marker('bystander-line');
  await carol.getByLabel(/^Write a message to /).fill(bystander);

  // Alice sends a DM. This is the line that ends up in Bob's live region.
  const secret = marker('secret');
  await alice.getByRole('tab', { name: /Direct/ }).click();
  await alice.getByLabel(/^Write a message to /).fill(secret);
  await alice.getByRole('button', { name: 'Send' }).click();
  await expect(region).toContainText(`${aliceName} says ${secret}`);

  // Bob blocks her immediately — the region empties, as NEW-4 intends.
  await blockButton.click();
  await expect(region).toHaveText('');

  // Carol now says something in the Town Square, inside the announce throttle window.
  await carol.getByRole('button', { name: 'Send' }).click();

  // Sample the region continuously: any frame showing Alice is the leak.
  const sightings: string[] = [];
  for (let i = 0; i < 40; i += 1) {
    sightings.push((await region.textContent()) ?? '');
    await bob.waitForTimeout(50);
  }
  const leaked = sightings.filter((text) => text.includes(aliceName));
  console.log('LEAK distinct region values:', JSON.stringify([...new Set(sightings)]));
  console.log('LEAK frames showing the blocked author:', leaked.length);

  expect(leaked, `live region re-exposed the blocked author: ${JSON.stringify([...new Set(leaked)])}`).toEqual([]);

  await alice.context().close();
  await carol.context().close();
  await bob.context().close();
});
