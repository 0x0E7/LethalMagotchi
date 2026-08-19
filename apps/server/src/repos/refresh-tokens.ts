import type { Db } from '../db/pool.js';
import { uuidv7 } from '../uuid.js';

export interface RefreshTokenRow {
  id: string;
  account_id: string;
  token_hash: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

export async function insertRefreshToken(
  db: Db,
  input: { accountId: string; tokenHash: string; expiresAt: Date },
): Promise<RefreshTokenRow> {
  const result = await db.query<RefreshTokenRow>(
    `INSERT INTO refresh_tokens (id, account_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [uuidv7(), input.accountId, input.tokenHash, input.expiresAt],
  );
  return result.rows[0]!;
}

export async function findRefreshTokenByHash(db: Db, tokenHash: string): Promise<RefreshTokenRow | null> {
  const result = await db.query<RefreshTokenRow>('SELECT * FROM refresh_tokens WHERE token_hash = $1', [
    tokenHash,
  ]);
  return result.rows[0] ?? null;
}

export async function revokeRefreshToken(db: Db, id: string): Promise<void> {
  await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]);
}

/**
 * Atomically revokes a still-active token and reports whether *this* call was
 * the one that did it. Used by rotation to detect a concurrent-rotation race
 * (e.g. two tabs refreshing at once) without a read-then-write gap.
 */
export async function revokeRefreshTokenIfActive(db: Db, id: string): Promise<boolean> {
  const result = await db.query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id',
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

