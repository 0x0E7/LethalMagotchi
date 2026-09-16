import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, test, type Page } from '@playwright/test';
import { createAccount, createCharacterOutOfBand, login, type Credentials } from './helpers.js';

/**
 * A pet that reaches 0 HP dies.
 *
 * It always reached zero correctly — nothing ever acted on it, so the pet sat at zero
 * indefinitely and the game quietly had no death by neglect at all. This walks the whole
 * path through a real browser and a real socket: the starved pet, the announcement that
 * finds the player, and the renewed character underneath it.
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

/** Everything at zero and a fortnight of silence. A test cannot wait out real neglect. */
function starve(nickname: string): Promise<void> {
  return withDb(async (pool) => {
    await pool.query(
      `UPDATE characters
         SET stats = '{"hunger":0,"hygiene":0,"energy":0,"mood":0,"hp":0,"education":10}'::jsonb,
             last_simulated_at = now() - interval '14 days'
       WHERE nickname = $1`,
      [nickname],
    );
  });
}

function rowOf(nickname: string) {
  return withDb(async (pool) => {
    const result = await pool.query<{
      hp: number;
      lethal_coins: number;
      rebirth_count: number;
      deleted_at: Date | null;
    }>(
      `SELECT (stats->>'hp')::float AS hp, lethal_coins, rebirth_count, deleted_at
         FROM characters WHERE nickname = $1`,
      [nickname],
    );
    return result.rows[0]!;
  });
}

/**
 * Pinned to the top bar's <h1>. The rebirth card's own <h2> also carries the nickname, and
 * the death can land before this assertion runs — an unlevelled match then resolves to two
 * headings and fails on strict mode rather than on anything being wrong.
 */
async function openGame(page: Page, nickname: string, credentials: Credentials): Promise<void> {
  await login(page, credentials);
  await expect(page.getByRole('heading', { name: nickname, level: 1 })).toBeVisible();
}

test('a starved pet dies, is announced, and comes back renewed', async ({ page, request }) => {
  const nickname = marker('Forgotten');
  const credentials = await createAccount(request);
  await createCharacterOutOfBand(request, credentials, nickname);

  await withDb((pool) =>
    pool.query('UPDATE characters SET lethal_coins = 42 WHERE nickname = $1', [nickname]).then(() => {}),
  );
  await starve(nickname);

  // Logging in binds a socket, and binding a socket is when a pet that died while nobody
  // was watching is reaped.
  await openGame(page, nickname, credentials);

  // The death has to reach the player. A death nobody is told about is the bug again.
  const card = page.getByRole('dialog', { name: new RegExp(`${nickname} was reborn`) });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText('was not looked after');
  await expect(card).toContainText('42 coins became 5');

  const row = await rowOf(nickname);
  expect(row.hp).toBe(100);
  expect(row.lethal_coins).toBe(5);
  expect(row.rebirth_count).toBe(1);
  // Renewed, not deleted — same character, same name, same story.
  expect(row.deleted_at).toBeNull();

  await card.getByRole('button', { name: 'Got it' }).click();
  await expect(card).toBeHidden();

  // And they are playable again on the other side of it.
  await expect(page.getByRole('heading', { name: nickname, level: 1 })).toBeVisible();
});

test('a cared-for pet is never touched by the reaper', async ({ page, request }) => {
  const nickname = marker('Thriving');
  const credentials = await createAccount(request);
  await createCharacterOutOfBand(request, credentials, nickname);

  await openGame(page, nickname, credentials);

  // The sweep runs every second in E2E, so a few of them have gone by. Paired with the test
  // above so neither can pass vacuously: if the reaper were killing everyone, that test
  // would still be green and this one would not.
  await page.waitForTimeout(3_000);

  const row = await rowOf(nickname);
  expect(row.rebirth_count).toBe(0);
  await expect(page.getByRole('dialog', { name: /was reborn/ })).toBeHidden();
});
