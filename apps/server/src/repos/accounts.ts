import type { AccountDto } from '@lethalmagotchi/shared';
import type { Db } from '../db/pool.js';
import { uuidv7 } from '../uuid.js';

export interface AccountRow {
  id: string;
  username: string;
  username_normalized: string;
  password_hash: string;
  created_at: Date;
  last_login_at: Date | null;
  owned_cosmetics: string[];
}

export function toAccountDto(row: AccountRow): AccountDto {
  return {
    id: row.id,
    username: row.username,
    createdAt: row.created_at.toISOString(),
    lastLoginAt: row.last_login_at ? row.last_login_at.toISOString() : null,
    ownedCosmetics: row.owned_cosmetics,
  };
}

export async function insertAccount(
  db: Db,
  input: { username: string; usernameNormalized: string; passwordHash: string },
): Promise<AccountRow> {
  const result = await db.query<AccountRow>(
    `INSERT INTO accounts (id, username, username_normalized, password_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [uuidv7(), input.username, input.usernameNormalized, input.passwordHash],
  );
  return result.rows[0]!;
}

export async function findAccountByNormalizedUsername(
  db: Db,
  usernameNormalized: string,
): Promise<AccountRow | null> {
  const result = await db.query<AccountRow>(
    'SELECT * FROM accounts WHERE username_normalized = $1',
    [usernameNormalized],
  );
  return result.rows[0] ?? null;
}

export async function findAccountById(db: Db, id: string): Promise<AccountRow | null> {
  const result = await db.query<AccountRow>('SELECT * FROM accounts WHERE id = $1', [id]);
  return result.rows[0] ?? null;
}

export async function touchLastLogin(db: Db, accountId: string): Promise<void> {
  await db.query('UPDATE accounts SET last_login_at = now() WHERE id = $1', [accountId]);
}
