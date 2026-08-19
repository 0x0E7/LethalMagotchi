import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import type { Config } from '../config.js';
import { REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH } from '../config.js';
import type { Db } from '../db/pool.js';
import {
  findRefreshTokenByHash,
  insertRefreshToken,
  revokeRefreshToken,
  revokeRefreshTokenIfActive,
} from '../repos/refresh-tokens.js';

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function issueRefreshToken(db: Db, config: Config, accountId: string): Promise<string> {
  const token = generateRefreshToken();
  const expiresAt = new Date(Date.now() + config.refreshTokenTtlSeconds * 1000);
  await insertRefreshToken(db, { accountId, tokenHash: hashRefreshToken(token), expiresAt });
  return token;
}

export type RotationResult = { status: 'ok'; accountId: string; token: string } | { status: 'invalid' };

// Product decision (2026-08-19): atomic rotation, accept deterministic
// 2nd-tab logout — see apps/server/tests/integration/auth.test.ts for the
// full history. A single atomic claim is the *only* thing that decides the
// outcome: the caller that flips `revoked_at` from null to now() gets to
// issue a successor; every other presentation of this token just fails.
//
// Earlier drafts tried to additionally distinguish "a delayed replay of an
// already-dead token" (real theft, worth a family-wide revocation alarm)
// from "a same-instant race for a still-live token" (e.g. two tabs
// restoring a session at once, worth only a quiet 401 for the loser) by
// checking whether `revoked_at` was already set at read time. That doesn't
// work: in practice a "concurrent" pair of requests rarely interleaves
// mid-transaction — one typically finishes its whole read-revoke-issue
// sequence before the other's read even runs — so the second request's read
// sees an already-revoked row indistinguishably from a genuine delayed
// replay, and the family-nuke fires on ordinary concurrent use, destroying
// the winner's brand-new token along with it. Reliably telling the two
// apart needs a time-based grace window, which was explicitly not the
// chosen tradeoff. So: no cascading family revocation on reuse. A
// stolen-but-already-rotated token can never succeed regardless — rotation
// alone still fully denies it — it just no longer triggers an extra alarm
// response, and legitimate concurrent use is never punished for it.
export async function rotateRefreshToken(db: Db, config: Config, presented: string): Promise<RotationResult> {
  const row = await findRefreshTokenByHash(db, hashRefreshToken(presented));
  if (!row) return { status: 'invalid' };
  if (row.expires_at.getTime() <= Date.now()) {
    await revokeRefreshToken(db, row.id);
    return { status: 'invalid' };
  }

  const wonRace = await revokeRefreshTokenIfActive(db, row.id);
  if (!wonRace) return { status: 'invalid' };

  const token = await issueRefreshToken(db, config, row.account_id);
  return { status: 'ok', accountId: row.account_id, token };
}

export async function revokePresentedRefreshToken(db: Db, presented: string): Promise<void> {
  const row = await findRefreshTokenByHash(db, hashRefreshToken(presented));
  if (row) await revokeRefreshToken(db, row.id);
}

export function setRefreshCookie(reply: FastifyReply, config: Config, token: string): void {
  reply.setCookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    maxAge: config.refreshTokenTtlSeconds,
  });
}

export function clearRefreshCookie(reply: FastifyReply, config: Config): void {
  reply.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
  });
}
