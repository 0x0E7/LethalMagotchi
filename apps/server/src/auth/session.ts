import { normalizeUsername, type AccountDto, type CharacterDto } from '@lethalmagotchi/shared';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { isUniqueViolation, type Db } from '../db/pool.js';
import { ApiError, invalidCredentials } from '../errors.js';
import {
  findActiveCharacterByAccount,
  toCharacterDto,
} from '../repos/characters.js';
import {
  findAccountByNormalizedUsername,
  findAccountById,
  insertAccount,
  toAccountDto,
  touchLastLogin,
} from '../repos/accounts.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { issueRefreshToken, revokePresentedRefreshToken, rotateRefreshToken } from './tokens.js';

/**
 * The transport-agnostic core of sign-in.
 *
 * v1 (web) and v2 (native mobile / WebGL bridge) differ only in where the refresh token ends
 * up — a `Set-Cookie` versus a response-body field (`v2-architecture.md` §14.3). Everything
 * above that line — password verification, account lookup, issuing the token, building the
 * session payload — is identical, so it lives here exactly once. The two route files
 * (`routes/auth.ts`, `routes/auth-v2.ts`) are thin: they enforce rate limits, read the token
 * from their own transport, and place it back wherever that transport expects it.
 *
 * `v1's behaviour must not move by one byte` is the actual constraint this file exists to
 * satisfy — see the "same handlers, still on v1" note on each function below, and the parity
 * assertions in `tests/integration/auth-v2.test.ts`.
 */
export interface SessionDeps {
  db: Db;
  config: Config;
  app: FastifyInstance;
  dummyPasswordHash: string;
}

/**
 * The full result of a sign-in. `refreshToken` is deliberately part of this type rather than
 * bolted on separately: it is easy to forget to strip it back out of a v1 response, and a
 * refresh token riding in a JSON body defeats the entire point of `httpOnly` — the moment it
 * is also readable by page JavaScript, an XSS can read it exactly as if the cookie flag were
 * never set. `routes/auth.ts` destructures it out explicitly; that destructuring is the
 * enforcement point, and it is annotated there for the same reason.
 */
export interface SessionResult {
  account: AccountDto;
  character: CharacterDto | null;
  accessToken: string;
  expiresInSeconds: number;
  refreshToken: string;
}

export interface RefreshResult {
  accessToken: string;
  expiresInSeconds: number;
  refreshToken: string;
}

async function buildSession(deps: SessionDeps, accountId: string, refreshToken: string): Promise<SessionResult> {
  const account = await findAccountById(deps.db, accountId);
  // Can only happen if the account was deleted in the instant between issuing the token
  // above and this read — same shape as every other "the row is gone by the time we look"
  // race in this codebase, handled the same way: a 401 rather than a crash.
  if (!account) throw new ApiError(401, 'UNAUTHORIZED', 'Account no longer exists.');
  const character = await findActiveCharacterByAccount(deps.db, accountId);
  return {
    account: toAccountDto(account),
    character: character ? toCharacterDto(character) : null,
    accessToken: deps.app.jwt.sign({ sub: accountId }, { expiresIn: deps.config.accessTokenTtlSeconds }),
    expiresInSeconds: deps.config.accessTokenTtlSeconds,
    refreshToken,
  };
}

/** Same handler as v1's register, minus the cookie write. Rate limiting stays in the caller. */
export async function performRegister(
  deps: SessionDeps,
  input: { username: string; password: string },
): Promise<SessionResult> {
  const usernameNormalized = normalizeUsername(input.username);

  let account;
  try {
    account = await insertAccount(deps.db, {
      username: input.username.normalize('NFKC').trim(),
      usernameNormalized,
      passwordHash: await hashPassword(input.password),
    });
  } catch (error) {
    if (isUniqueViolation(error, 'ux_accounts_username_normalized')) {
      throw new ApiError(409, 'USERNAME_TAKEN', 'That username is taken.', {
        fields: { username: 'That username is taken.' },
      });
    }
    throw error;
  }

  const refreshToken = await issueRefreshToken(deps.db, deps.config, account.id);
  return buildSession(deps, account.id, refreshToken);
}

/** Same handler as v1's login, minus the cookie write. Rate limiting stays in the caller. */
export async function performLogin(
  deps: SessionDeps,
  input: { username: string; password: string },
): Promise<SessionResult> {
  const usernameNormalized = normalizeUsername(input.username);
  const account = await findAccountByNormalizedUsername(deps.db, usernameNormalized);
  // Verified against the dummy hash even when no account exists, so a wrong password and an
  // unknown username cost the same wall-clock time and the same code path — v1's existing
  // anti-enumeration discipline, unchanged.
  const passwordMatches = await verifyPassword(account?.password_hash ?? deps.dummyPasswordHash, input.password);
  if (!account || !passwordMatches) throw invalidCredentials();

  await touchLastLogin(deps.db, account.id);
  const refreshToken = await issueRefreshToken(deps.db, deps.config, account.id);
  return buildSession(deps, account.id, refreshToken);
}

/**
 * Same rotation as v1's refresh, minus the cookie read/write. The caller supplies the
 * presented token from wherever its transport keeps it (cookie for v1, request body for v2)
 * and gets the successor back the same way.
 */
export async function performRefresh(deps: SessionDeps, presented: string): Promise<RefreshResult> {
  const result = await rotateRefreshToken(deps.db, deps.config, presented);
  if (result.status !== 'ok') {
    throw new ApiError(401, 'UNAUTHORIZED', 'Session expired. Sign in again.');
  }
  return {
    accessToken: deps.app.jwt.sign({ sub: result.accountId }, { expiresIn: deps.config.accessTokenTtlSeconds }),
    expiresInSeconds: deps.config.accessTokenTtlSeconds,
    refreshToken: result.token,
  };
}

/** Same revocation as v1's logout. Never throws on an absent/unknown token — logging out of
 *  nothing is still a successful logout, so a client with a stuck or already-dead session can
 *  always clear itself. */
export async function performLogout(deps: { db: Db }, presented: string | null): Promise<void> {
  if (presented) await revokePresentedRefreshToken(deps.db, presented);
}
