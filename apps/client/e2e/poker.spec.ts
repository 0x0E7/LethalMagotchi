import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import pg from 'pg';
import { axeViolations } from './helpers.js';

/**
 * The shipping poker UI, driven by five real browsers through a real tournament: the
 * scheduler closes registration, seats everyone, and the five contexts bet their way to a
 * showdown and a table result entirely by clicking. This is the promoted, permanent form
 * of `scripts/verify-poker.mjs`.
 *
 * It runs its own server on its own port rather than the suite's shared one, because the
 * scheduler charges *every* character in the database on every close — which would move
 * coins under the pet-action specs.
 */
const PORT = Number(process.env.E2E_POKER_PORT ?? 8098);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'correct-horse-battery-9';
const NICKNAMES = ['Miso', 'Pepper', 'Juniper', 'Waffles', 'Clover'];
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://lethal:lethal@localhost:5432/lethalmagotchi_test';

interface Player {
  username: string;
  password: string;
  nickname: string;
}

let server: ChildProcess;

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/healthz`);
      if (response.ok) return;
    } catch {
      /* still booting */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('poker e2e server never became healthy');
}

async function api(path: string, options: { method?: string; token?: string; body?: unknown } = {}) {
  const response = await fetch(`${BASE}/api/v1${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} -> ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function createPlayer(nickname: string): Promise<Player> {
  const credentials = {
    username: `poker_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    password: PASSWORD,
  };
  const session = await api('/auth/register', { method: 'POST', body: credentials });
  await api('/characters', {
    method: 'POST',
    token: session.accessToken,
    body: {
      speciesId: 'otter',
      nickname,
      bio: 'Here for the cards.',
      originCountry: 'NL',
      originCity: 'Utrecht',
      occupationId: 'chef',
      personalityId: 'goofball',
    },
  });
  await api('/characters/me/tournament-optin', {
    method: 'POST',
    token: session.accessToken,
    body: { optIn: true },
  });
  return { ...credentials, nickname };
}

async function login(page: Page, player: Player): Promise<void> {
  await page.goto(BASE);
  await page.getByRole('tab', { name: 'Log in' }).click();
  await page.locator('input[name="username"]').fill(player.username);
  await page.locator('input[name="password"]').fill(player.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL(/\/pet$/, { timeout: 20_000 });
}

/** Clicks whichever move is offered, preferring the cheapest legal one. */
async function playTurn(page: Page): Promise<void> {
  for (const name of [/^Check$/, /^Call/, /^All in/, /^Fold$/]) {
    const button = page.getByRole('button', { name });
    if (await button.count()) {
      await button
        .first()
        .click({ timeout: 3_000 })
        .catch(() => undefined);
      return;
    }
  }
}

test.beforeAll(async () => {
  const before = new pg.Client({ connectionString: DATABASE_URL });
  await before.connect();
  try {
    /**
     * A previous run that was killed mid-tournament leaves rows in `running`, and the
     * scheduler refuses to schedule anything while one exists. Clearing them here means
     * this spec never inherits another run's wedge.
     */
    await before.query(
      `UPDATE tournaments SET state = 'cancelled'
       WHERE state IN ('scheduled', 'registration', 'running')`,
    );
    /**
     * Registration close charges *every* living character by design, and this database
     * accumulates a couple of hundred abandoned ones per suite run — so without retiring
     * them the close gets slower on every run until it outlives the seating deadline.
     * Every spec makes its own accounts, so nothing downstream reads these.
     */
    await before.query('UPDATE characters SET deleted_at = now() WHERE deleted_at IS NULL');
    await before.query('UPDATE characters SET tournament_opt_in = false, seated_table_id = NULL');
  } finally {
    await before.end();
  }

  server = spawn('npx', ['tsx', 'apps/server/tests/e2e-server.ts'], {
    env: {
      ...process.env,
      E2E_PORT: String(PORT),
      E2E_TOURNAMENTS: 'on',
      E2E_TOURNAMENT_INTERVAL_MS: '45000',
      E2E_TOURNAMENT_LEAD_MS: '25000',
      E2E_TOURNAMENT_TURN_MS: '8000',
      E2E_TOURNAMENT_SHOWDOWN_MS: '1500',
      E2E_TOURNAMENT_ROUND_BREAK_MS: '3000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForHealth();
});

test.afterAll(() => {
  server?.kill('SIGTERM');
});

async function seatFiveBrowsers(browser: Browser): Promise<Page[]> {
  const players: Player[] = [];
  for (const nickname of NICKNAMES) players.push(await createPlayer(nickname));

  const pages: Page[] = [];
  for (const player of players) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, player);
    pages.push(page);
  }

  await Promise.all(pages.map((page) => page.waitForURL(/\/poker$/, { timeout: 120_000 })));
  return pages;
}

/**
 * One seating, both jobs. Seating five browsers costs a whole scheduler cycle, so the
 * accessibility scan runs against the same live table rather than paying for a second
 * tournament — and a second tournament would in any case queue behind the first, which is
 * still `running` while these browsers are at it.
 */
test('five players are seated, play to a showdown, and the table is accessible', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const pages = await seatFiveBrowsers(browser);
  const first = pages[0]!;

  await first.locator('.pcard.lg').first().waitFor({ timeout: 20_000 });
  await expect(first.locator('.seat')).toHaveCount(5);
  await expect(first.locator('.pcard.lg')).toHaveCount(2);
  await expect(first.locator('.best-hand')).toHaveText(/^You have /);
  // No other player's hole cards are in this page's DOM before a showdown.
  await expect(first.locator('.pcard.back')).toHaveCount(8);

  // Scanned on whichever player is to act, so the betting controls are in the tree.
  await assertAccessible(await pageToAct(pages));

  const deadline = Date.now() + 180_000;
  let sawShowdown = false;
  let sawOutcome = false;
  while (Date.now() < deadline && !sawOutcome) {
    for (const page of pages) {
      if (page.url().endsWith('/poker')) {
        await playTurn(page);
        if (await page.locator('.showdown-caption').count()) sawShowdown = true;
      }
      if (await page.locator('.outcome-card').count()) sawOutcome = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  expect(sawShowdown, 'a showdown was captioned in plain language').toBe(true);
  expect(sawOutcome, 'a table result was rendered').toBe(true);

  for (const page of pages) await page.context().close();
});

async function pageToAct(pages: Page[]): Promise<Page> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const page of pages) {
      if (await page.locator('.bet-bar').count()) return page;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('no player was offered a turn');
}

async function assertAccessible(page: Page): Promise<void> {
  expect(await axeViolations(page)).toEqual([]);

  // The specific defects this spec exists to keep fixed.
  await expect(page.locator('main.poker-layout')).toHaveCount(1);
  await expect(page.locator('.board')).toHaveAttribute('role', 'group');
  await expect(page.locator('.bet-shortcuts')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Fold$/ })).toHaveAttribute('aria-keyshortcuts', 'f');

  const raise = page.getByRole('button', { name: /^(Raise|Bet)$/ });
  if (await raise.count()) {
    await raise.first().click();
    const tray = page.locator('.bet-tray');
    await expect(tray).toHaveAttribute('aria-modal', 'true');

    // The tray's own controls — the Bet/Raise-to confirm button above all — are in the
    // tree only while it is open, so the closed-state scan above can never see them.
    await expect(page.locator('.bet-button.confirm')).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(tray).toHaveCount(0);
  }
}
