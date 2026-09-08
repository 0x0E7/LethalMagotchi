import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Browser, type Page, type Route } from '@playwright/test';
import { startAtPetScreen } from './helpers.js';

/**
 * QA round-3 verification harness. History is served over HTTP, so the paging behaviour that
 * NEW-1/NEW-2/NEW-3 live in is reachable from the browser by controlling that one endpoint —
 * no 51 real messages and no real network flakiness required.
 */

const TOWN = '00000000-0000-7000-8000-000000000001';
const HISTORY_GLOB = `**/api/v1/chat/channels/${TOWN}/messages*`;

function marker(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

interface Line {
  id: string;
  ordinal: number;
  authorAccountId: string | null;
  authorName: string;
  body: string;
}

function line(ordinal: number, authorName: string, authorAccountId: string | null, body: string): Line {
  return { id: `00000000-0000-7000-8000-${String(ordinal).padStart(12, '0')}`, ordinal, authorAccountId, authorName, body };
}

function dto(entry: Line) {
  return {
    id: entry.id,
    channelId: TOWN,
    authorAccountId: entry.authorAccountId,
    authorCharacterId: null,
    authorName: entry.authorName,
    body: entry.body,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, entry.ordinal)).toISOString(),
    moderation: 'clean',
  };
}

async function fulfil(route: Route, messages: Line[], hasMore: boolean): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ messages: messages.map(dto), hasMore }),
  });
}

/**
 * The account id of whoever wrote `body`, read out of the browser's own authenticated history
 * fetch — the API is Bearer-authenticated, so an in-page `fetch` would not be signed in.
 */
async function accountIdOfAuthor(page: Page, body: string): Promise<string> {
  await page.reload();
  // History is only fetched when the panel opens, so the waiter is armed before the click.
  const waiting = page.waitForResponse(
    (response) => response.url().includes(`/chat/channels/${TOWN}/messages`) && response.status() === 200,
  );
  await page.getByRole('button', { name: /^Chat/ }).click();
  const json = await (await waiting).json();
  const found = (json.messages as Array<{ body: string; authorAccountId: string | null }>).find(
    (entry) => entry.body === body,
  );
  if (!found?.authorAccountId) throw new Error(`no author id for ${body}`);
  return found.authorAccountId;
}

/** Message bodies as the DOM actually renders them, top to bottom. */
async function renderedBodies(page: Page): Promise<string[]> {
  return page.locator('#chat-log .chat-message .chat-body').allTextContents();
}

function olderButton(page: Page) {
  return page.locator('li.chat-older button');
}

/** A promise a route handler can hold open until the test decides to let the response land. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function openPlayer(browser: Browser, request: APIRequestContext, nickname: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await startAtPetScreen(page, request, nickname);
  return page;
}

/* ------------------------------------------------------------------ NEW-1 */

test('NEW-1: a block after paginating leaves the Town Square in chronological order', async ({ browser, request }) => {
  const aliceName = marker('Alice');
  const alice = await openPlayer(browser, request, aliceName);
  const bob = await openPlayer(browser, request, marker('Bob'));

  // Alice speaks once for real before the endpoint is taken over, so the harness can use the
  // account id the server actually assigned her.
  const realHello = marker('real-hello');
  await alice.getByRole('button', { name: /^Chat/ }).click();
  await alice.getByLabel(/^Write a message to /).fill(realHello);
  await alice.getByRole('button', { name: 'Send' }).click();

  await bob.getByRole('button', { name: /^Chat/ }).click();
  await expect(bob.getByRole('log').getByText(realHello)).toBeVisible();

  const aliceId = await accountIdOfAuthor(bob, realHello);

  // Bob's Town Square is now served by the harness: two pages of a single long log.
  const log = [
    line(1, aliceName, aliceId, 'old-1'),
    line(2, 'Carol', null, 'old-2'),
    line(3, aliceName, aliceId, 'old-3'),
    line(8, 'Carol', null, 'new-8'),
    line(9, aliceName, aliceId, 'new-9'),
    line(10, 'Carol', null, 'new-10'),
  ];
  const newest = log.slice(3);
  const older = log.slice(0, 3);

  await bob.route(HISTORY_GLOB, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has('before')) await fulfil(route, older, false);
    else await fulfil(route, newest, true);
  });

  // Reload so the harness serves the first page too.
  await bob.reload();
  await bob.getByRole('button', { name: /^Chat/ }).click();
  await expect(bob.getByRole('log').getByText('new-10')).toBeVisible();

  expect(await renderedBodies(bob)).toEqual(['new-8', 'new-9', 'new-10']);

  // Paginate back: the earlier page must land on top, not underneath.
  await olderButton(bob).click();
  await expect(bob.getByRole('log').getByText('old-1')).toBeVisible();
  expect(await renderedBodies(bob)).toEqual(['old-1', 'old-2', 'old-3', 'new-8', 'new-9', 'new-10']);
  await expect(olderButton(bob)).toBeHidden();

  // Open the DM with Alice and block her. This is the exact NEW-1 repro.
  await bob.getByRole('log').getByRole('button', { name: `Message ${aliceName}` }).first().click();
  await bob.getByRole('button', { name: 'Block', exact: true }).click();
  await expect(bob.getByRole('button', { name: 'Unblock', exact: true })).toBeVisible();

  await bob.getByRole('tab', { name: /Town Square/ }).click();
  await expect(bob.getByRole('log').getByText('new-10')).toBeVisible();
  // The cursor-less refetch is async. `hasMore` was false after paginating to the end, so the
  // button reappearing is proof the fresh newest page has actually landed and been applied.
  await expect(olderButton(bob)).toBeVisible();

  const after = await renderedBodies(bob);
  console.log('NEW-1 after block, Town Square renders:', JSON.stringify(after));

  // Chronological: no page has jumped backwards under a newer one.
  const ordinals = after.map((body) => Number(body.split('-')[1]));
  expect(ordinals).toEqual([...ordinals].sort((a, b) => a - b));

  // Blocked author is gone from the visible log.
  expect(after).not.toContain('new-9');
  expect(after).not.toContain('old-1');

  // The developer's stated tradeoff: collapse to the newest page, with a way back offered.
  expect(after).toEqual(['new-8', 'new-10']);
  await expect(olderButton(bob)).toBeVisible();
  await expect(olderButton(bob)).toHaveText('Load earlier messages');

  // And the way back actually works, still in order.
  await olderButton(bob).click();
  await expect(bob.getByRole('log').getByText('old-2')).toBeVisible();
  const reloaded = await renderedBodies(bob);
  console.log('NEW-1 after re-paginating:', JSON.stringify(reloaded));
  expect(reloaded).toEqual(['old-2', 'new-8', 'new-10']);

  await alice.context().close();
  await bob.context().close();
});

/* ------------------------------------------------------------------ NEW-2 */

test('NEW-2: a failed page of history shows a retry state and the retry works', async ({ browser, request }) => {
  const page = await openPlayer(browser, request, marker('Wedge'));

  const newest = [line(8, 'Carol', null, 'new-8'), line(9, 'Carol', null, 'new-9')];
  const older = [line(1, 'Carol', null, 'old-1'), line(2, 'Carol', null, 'old-2')];

  let olderAttempts = 0;
  await page.route(HISTORY_GLOB, async (route) => {
    const url = new URL(route.request().url());
    if (!url.searchParams.has('before')) return fulfil(route, newest, true);
    olderAttempts += 1;
    if (olderAttempts === 1) return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    return fulfil(route, older, false);
  });

  await page.reload();
  await page.getByRole('button', { name: /^Chat/ }).click();
  await expect(page.getByRole('log').getByText('new-9')).toBeVisible();

  const button = olderButton(page);
  await expect(button).toHaveText('Load earlier messages');
  await expect(button).toBeEnabled();

  await button.click();

  // Not wedged: re-enabled, and visibly distinct from idle.
  await expect(button).toBeEnabled();
  await expect(button).toHaveAttribute('aria-busy', 'false');
  const failedLabel = await button.textContent();
  console.log('NEW-2 failed-state label:', JSON.stringify(failedLabel));
  expect(failedLabel).toBe('Could not load earlier messages. Try again');

  // A disabled/idle-looking button would be the old wedge; this one retries for real.
  await button.click();
  await expect(page.getByRole('log').getByText('old-1')).toBeVisible();
  expect(await renderedBodies(page)).toEqual(['old-1', 'old-2', 'new-8', 'new-9']);
  expect(olderAttempts).toBe(2);

  await page.context().close();
});

/* ------------------------------------------------------------------ NEW-3 */

test('NEW-3: an in-flight older page cannot re-insert an author blocked while it was out', async ({
  browser,
  request,
}) => {
  const aliceName = marker('Ghost');
  const alice = await openPlayer(browser, request, aliceName);
  const bob = await openPlayer(browser, request, marker('Sentinel'));

  const hello = marker('ghost-hello');
  await alice.getByRole('button', { name: /^Chat/ }).click();
  await alice.getByLabel(/^Write a message to /).fill(hello);
  await alice.getByRole('button', { name: 'Send' }).click();

  await bob.getByRole('button', { name: /^Chat/ }).click();
  await expect(bob.getByRole('log').getByText(hello)).toBeVisible();

  const aliceId = await accountIdOfAuthor(bob, hello);

  // The DM has to exist before the Town Square endpoint is taken over, because that is where
  // the Block button lives. (The panel is already open from reading the account id.)
  await bob.getByRole('log').getByRole('button', { name: `Message ${aliceName}` }).first().click();
  await expect(bob.getByRole('button', { name: 'Block', exact: true })).toBeVisible();

  const newest = [line(8, 'Carol', null, 'new-8'), line(9, 'Carol', null, 'new-9')];
  // The earlier page the server computed *before* the block was written: full of Alice.
  const older = [line(1, aliceName, aliceId, 'ghost-old-1'), line(2, 'Carol', null, 'old-2')];

  const held = deferred();
  const seen = deferred();

  await bob.route(HISTORY_GLOB, async (route) => {
    const url = new URL(route.request().url());
    if (!url.searchParams.has('before')) return fulfil(route, newest, true);
    seen.resolve();
    await held.promise;
    return fulfil(route, older, false);
  });

  await bob.reload();
  await bob.getByRole('button', { name: /^Chat/ }).click();
  await expect(bob.getByRole('log').getByText('new-9')).toBeVisible();

  // Start the earlier-page request and hold it open.
  await olderButton(bob).click();
  await seen.promise;
  await expect(olderButton(bob)).toBeDisabled();
  await expect(olderButton(bob)).toHaveAttribute('aria-busy', 'true');

  // Block Alice from the real UI while that earlier page is still in flight, then let it land.
  await bob.getByRole('tab', { name: /Direct/ }).click();
  await bob.getByRole('button', { name: 'Block', exact: true }).click();
  await expect(bob.getByRole('button', { name: 'Unblock', exact: true })).toBeVisible();
  held.resolve();

  await bob.getByRole('tab', { name: /Town Square/ }).click();
  await expect(bob.getByRole('log').getByText('new-9')).toBeVisible();
  await bob.waitForTimeout(750);

  const bodies = await renderedBodies(bob);
  console.log('NEW-3 Town Square after stale page landed:', JSON.stringify(bodies));
  expect(bodies).not.toContain('ghost-old-1');
  expect(bodies.some((body) => body.startsWith('ghost-hello'))).toBe(false);

  await alice.context().close();
  await bob.context().close();
});

/* ------------------------------------------------------------------ NEW-4 */

test('NEW-4: the live region is emptied in the DOM when its author is blocked', async ({ browser, request }) => {
  const aliceName = marker('Loud');
  const alice = await openPlayer(browser, request, aliceName);
  const bob = await openPlayer(browser, request, marker('Quiet'));

  await alice.getByRole('button', { name: /^Chat/ }).click();
  await bob.getByRole('button', { name: /^Chat/ }).click();

  const shout = marker('shout');
  await alice.getByLabel(/^Write a message to /).fill(shout);
  await alice.getByRole('button', { name: 'Send' }).click();

  const region = bob.locator('.chat-dock [role="status"]');
  await expect(region).toContainText(`${aliceName} says ${shout}`);
  console.log('NEW-4 live region before block:', JSON.stringify(await region.textContent()));

  await bob.getByRole('log').getByRole('button', { name: `Message ${aliceName}` }).first().click();
  await bob.getByRole('button', { name: 'Block', exact: true }).click();
  await expect(bob.getByRole('button', { name: 'Unblock', exact: true })).toBeVisible();

  // Accessibility-only: assert the node is genuinely empty in the DOM, not merely invisible.
  await expect(region).toHaveText('');
  const raw = await region.evaluate((node) => ({
    textContent: node.textContent,
    innerHTML: node.innerHTML,
    role: node.getAttribute('role'),
    live: node.getAttribute('aria-live'),
  }));
  console.log('NEW-4 live region after block:', JSON.stringify(raw));
  expect(raw.textContent).toBe('');
  expect(raw.innerHTML).toBe('');
  expect(raw.role).toBe('status');
  expect(raw.live).toBe('polite');

  await alice.context().close();
  await bob.context().close();
});
