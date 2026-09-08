import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from '@playwright/test';
import { axeViolations, fillCreationSteps, registerViaUi, startAtPetScreen } from './helpers.js';

/**
 * Two real browsers on one server: everything crosses the wire the way it does in
 * production — HTTP for the channel list and history, the socket for the live tail.
 *
 * Accounts are made through the test-level request context rather than the browser
 * context's own: the latter shares a cookie jar with the page, so the out-of-band login
 * would hand the browser a session and it would never see the login screen at all.
 */
async function openPlayer(browser: Browser, request: APIRequestContext, nickname: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const sent: string[] = [];
  sentFrames.set(page, sent);
  page.on('websocket', (socket) => {
    socket.on('framesent', (frame) => sent.push(String(frame.payload)));
  });
  await startAtPetScreen(page, request, nickname);
  await page.getByRole('button', { name: /^Chat/ }).click();
  await expect(page.getByRole('tab', { name: /Town Square/ })).toBeVisible();
  return page;
}

/** Outbound socket frames per page, so a spec can assert on chatter the UI should not make. */
const sentFrames = new WeakMap<Page, string[]>();

function framesOfType(page: Page, type: string): string[] {
  return (sentFrames.get(page) ?? []).filter((frame) => frame.includes(`"type":"${type}"`));
}

async function say(page: Page, text: string): Promise<void> {
  await page.getByLabel(/^Write a message to /).fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
}

/**
 * Scoped to the message log on purpose. The panel also carries a polite live region that
 * repeats the newest message for screen readers, and an unscoped text match would find that
 * copy instead of the rendered one.
 */
function inLog(page: Page, text: string): Locator {
  return page.getByRole('log').getByText(text);
}

function liveRegion(page: Page): Locator {
  return page.locator('.chat-dock [role="status"]');
}

const TOWN_SQUARE = '00000000-0000-7000-8000-000000000001';

/** The Town Square is one shared, long-lived channel, so every marker has to be unique. */
function marker(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

test('two players trade a live direct message, then a block closes it off', async ({ browser, request }) => {
  // Nicknames are unique per run too: the Town Square keeps everything anyone ever said,
  // so a fixed name would match characters left behind by earlier runs.
  const aliceName = marker('Miso');
  const alice = await openPlayer(browser, request, aliceName);
  const bob = await openPlayer(browser, request, marker('Pepper'));

  const townHello = marker('town-hello');
  const privateWord = marker('private-word');
  const privateReply = marker('private-reply');
  const dmAfterBlock = marker('dm-after-block');
  const globalAfterBlock = marker('global-after-block');
  const reunion = marker('reunion');

  // The Town Square is the meeting place: Alice speaks, Bob sees it live.
  await say(alice, townHello);
  await expect(inLog(bob, townHello)).toBeVisible();

  // The incoming message is announced politely rather than on every keystroke.
  await expect(liveRegion(bob)).toContainText(`${aliceName} says ${townHello}`);

  // "Message this player" is the entry point into a DM — no player directory needed.
  await bob.getByRole('log').getByRole('button', { name: `Message ${aliceName}` }).first().click();
  await expect(bob.getByRole('button', { name: 'Block', exact: true })).toBeVisible();

  await say(bob, privateWord);

  // Alice is told about the new conversation and gets the message live.
  await alice.getByRole('tab', { name: /Direct/ }).click();
  await expect(inLog(alice, privateWord)).toBeVisible();

  await say(alice, privateReply);
  await expect(inLog(bob, privateReply)).toBeVisible();

  // The DM never lands in the Town Square.
  await bob.getByRole('tab', { name: /Town Square/ }).click();
  await expect(inLog(bob, privateWord)).toBeHidden();

  // Bob blocks Miso. The composer closes and further messages do not arrive.
  await bob.getByRole('tab', { name: /Direct/ }).click();
  await bob.getByRole('button', { name: 'Block', exact: true }).click();
  await expect(bob.getByRole('button', { name: 'Unblock', exact: true })).toBeVisible();
  await expect(bob.getByPlaceholder('You blocked this player.')).toBeDisabled();

  /**
   * Blocking has to take effect on what is already on the screen, not only on the next
   * fetch: a player who has just blocked a stranger should not have to reload the page to
   * stop seeing them. This assertion is the one that fails if the block is merely
   * server-side — everything below it passes either way.
   */
  await bob.getByRole('tab', { name: /Town Square/ }).click();
  await expect(inLog(bob, townHello)).toBeHidden();

  // Off the screen includes out of the live region: a blocked player is not still being read
  // aloud to whoever blocked them.
  await expect(liveRegion(bob)).not.toContainText(`${aliceName} says`);

  await bob.getByRole('tab', { name: /Direct/ }).click();
  await say(alice, dmAfterBlock);
  await expect(alice.getByText('You cannot message this player.')).toBeVisible();
  await expect(inLog(bob, dmAfterBlock)).toBeHidden();

  // The Town Square goes quiet too, live and on a fresh history fetch.
  await alice.getByRole('tab', { name: /Town Square/ }).click();
  await say(alice, globalAfterBlock);
  await bob.getByRole('tab', { name: /Town Square/ }).click();
  await expect(inLog(bob, globalAfterBlock)).toBeHidden();

  await bob.reload();
  await bob.getByRole('button', { name: /^Chat/ }).click();
  await expect(bob.getByRole('tab', { name: /Town Square/ })).toBeVisible();
  await expect(inLog(bob, globalAfterBlock)).toBeHidden();
  await expect(inLog(bob, townHello)).toBeHidden();

  // Unblocking puts it all back.
  await bob.getByRole('tab', { name: /Direct/ }).click();
  await bob.getByRole('button', { name: 'Unblock', exact: true }).click();
  await expect(bob.getByRole('button', { name: 'Block', exact: true })).toBeVisible();

  await alice.getByRole('tab', { name: /Direct/ }).click();
  await say(alice, reunion);
  await expect(inLog(bob, reunion)).toBeVisible();

  // And unblocking is just as immediate: the Town Square fills back in with no reload.
  await bob.getByRole('tab', { name: /Town Square/ }).click();
  await expect(inLog(bob, townHello)).toBeVisible();

  /**
   * A read receipt is answered with an unread count, which is itself a state change — so
   * "mark the open conversation read" is one edit away from feeding its own trigger and
   * looping until the server rate-limits the socket. One receipt per message read is the
   * ceiling; a handful over this whole exchange is the honest number.
   */
  expect(framesOfType(bob, 'chat:read').length).toBeLessThan(10);
  expect(framesOfType(alice, 'chat:read').length).toBeLessThan(10);

  await alice.context().close();
  await bob.context().close();
});

/**
 * The one path every real player takes exactly once, and the one the other specs skip by
 * making the character out of band before the browser ever logs in: the socket authenticates
 * during registration, when there is no character to bind to yet. It has to pick the binding
 * up when the character is made, without a reload nobody would think to do.
 */
test('a player who just registered can chat straight away, with no reload', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const nickname = marker('Newborn');

  await registerViaUi(page);
  await fillCreationSteps(page, { nickname });
  await page.getByRole('button', { name: 'Review' }).click();
  await page.getByRole('button', { name: /Start raising/ }).click();
  await expect(page).toHaveURL(/\/pet$/);

  await page.getByRole('button', { name: /^Chat/ }).click();
  const firstWords = marker('first-words');
  await say(page, firstWords);

  await expect(inLog(page, firstWords)).toBeVisible();
  // Nothing left hanging: the send settled rather than sitting in limbo forever.
  await expect(page.getByText('Sending…')).toBeHidden();

  await context.close();
});

test('history is served over HTTP and survives a reload', async ({ browser, request }) => {
  const alice = await openPlayer(browser, request, marker('Juniper'));
  const said = marker('persisted');

  await say(alice, said);
  await expect(inLog(alice, said)).toBeVisible();

  await alice.reload();
  await alice.getByRole('button', { name: /^Chat/ }).click();
  await expect(inLog(alice, said)).toBeVisible();

  await alice.context().close();
});

/**
 * NEW-6: the Town Square is never actually empty, so "Nothing here yet" in front of a player
 * whose history request failed is the client inventing a fact about a shared room.
 */
test('a first page of history that never arrives says so instead of looking like an empty channel', async ({
  browser,
  request,
}) => {
  const alice = await openPlayer(browser, request, marker('Signal'));
  const said = marker('was-here');
  await say(alice, said);
  await expect(inLog(alice, said)).toBeVisible();

  // The *initial* load, not a pagination request: no cursor on it.
  let failed = false;
  await alice.route(`**/api/v1/chat/channels/${TOWN_SQUARE}/messages*`, async (route) => {
    if (failed || new URL(route.request().url()).searchParams.has('before')) return route.continue();
    failed = true;
    return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
  });

  await alice.reload();
  await alice.getByRole('button', { name: /^Chat/ }).click();

  const failure = alice.locator('#chat-log [role="alert"]');
  await expect(failure).toBeVisible();
  await expect(failure).toContainText('Could not load messages.');
  await expect(alice.getByRole('log')).not.toContainText('Nothing here yet.');
  await expect(inLog(alice, said)).toBeHidden();
  expect(await axeViolations(alice)).toEqual([]);

  // The retry is the way out, and it leaves no trace of the failure behind.
  await failure.getByRole('button', { name: 'Try again' }).click();
  await expect(inLog(alice, said)).toBeVisible();
  await expect(failure).toBeHidden();

  await alice.context().close();
});

test('the chat panel is keyboard operable and labelled', async ({ browser, request }) => {
  const alice = await openPlayer(browser, request, marker('Waffles'));

  const toggle = alice.getByRole('button', { name: /^Chat/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(alice.getByRole('region', { name: 'Chat' })).toBeVisible();
  await expect(alice.getByRole('log')).toBeVisible();
  await expect(alice.getByRole('tab', { name: /Town Square/ })).toHaveAttribute('aria-selected', 'true');

  await alice.getByRole('tab', { name: /Direct/ }).focus();
  await alice.keyboard.press('Enter');
  await expect(alice.getByRole('tab', { name: /Direct/ })).toHaveAttribute('aria-selected', 'true');

  await toggle.focus();
  await alice.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(alice.getByRole('region', { name: 'Chat' })).toBeHidden();

  await alice.context().close();
});

test('the chat panel holds the pet screen to the same accessibility bar', async ({ browser, request }) => {
  const alice = await openPlayer(browser, request, marker('Clover'));

  await say(alice, marker('axe-scan'));
  expect(await axeViolations(alice)).toEqual([]);

  // The conversation list and the DM view are separate trees; a scan of one says nothing
  // about the other.
  await alice.getByRole('tab', { name: /Direct/ }).click();
  await expect(alice.getByRole('list', { name: 'Conversations' })).toBeVisible();
  expect(await axeViolations(alice)).toEqual([]);

  await alice.context().close();
});
