import type { FastifyInstance } from 'fastify';
import {
  type RefreshResponse,
  type SessionResponse,
  type UsernameAvailabilityResponse,
  checkUsername,
  loginSchema,
  normalizeUsername,
  registerSchema,
  suggestUsernames,
  usernameAvailabilityQuerySchema,
} from '@lethalmagotchi/shared';
import { REFRESH_COOKIE_NAME } from '../config.js';
import type { ServerDeps } from '../deps.js';
import { ApiError, invalidCredentials } from '../errors.js';
import { isUniqueViolation } from '../db/pool.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import type { RateLimiter } from '../rate-limit.js';
import {
  clearRefreshCookie,
  issueRefreshToken,
  revokePresentedRefreshToken,
  rotateRefreshToken,
  setRefreshCookie,
} from '../auth/tokens.js';
import {
  findAccountByNormalizedUsername,
  findAccountById,
  insertAccount,
  toAccountDto,
  touchLastLogin,
} from '../repos/accounts.js';
import { findActiveCharacterByAccount, toCharacterDto } from '../repos/characters.js';
import { parseOrThrow } from '../validate.js';

export async function registerAuthRoutes(app: FastifyInstance, deps: ServerDeps): Promise<void> {
  const { config, db, limiters } = deps;

  const enforce = (limiter: RateLimiter, key: string) => {
    const decision = limiter.check(key);
    if (!decision.allowed) {
      throw new ApiError(429, 'RATE_LIMITED', 'Too many attempts. Try again shortly.', {
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }
  };

  const sessionPayload = async (accountId: string): Promise<SessionResponse> => {
    const account = await findAccountById(db, accountId);
    if (!account) throw new ApiError(401, 'UNAUTHORIZED', 'Account no longer exists.');
    const character = await findActiveCharacterByAccount(db, accountId);
    return {
      accessToken: app.jwt.sign({ sub: accountId }, { expiresIn: config.accessTokenTtlSeconds }),
      expiresInSeconds: config.accessTokenTtlSeconds,
      account: toAccountDto(account),
      character: character ? toCharacterDto(character) : null,
    };
  };

  app.post('/api/v1/auth/register', async (request, reply) => {
    enforce(limiters.register, request.ip);
    const body = parseOrThrow(registerSchema, request.body);
    const usernameNormalized = normalizeUsername(body.username);

    let account;
    try {
      account = await insertAccount(db, {
        username: body.username.normalize('NFKC').trim(),
        usernameNormalized,
        passwordHash: await hashPassword(body.password),
      });
    } catch (error) {
      if (isUniqueViolation(error, 'ux_accounts_username_normalized')) {
        throw new ApiError(409, 'USERNAME_TAKEN', 'That username is taken.', {
          fields: { username: 'That username is taken.' },
        });
      }
      throw error;
    }

    const refreshToken = await issueRefreshToken(db, config, account.id);
    setRefreshCookie(reply, config, refreshToken);
    return reply.code(201).send(await sessionPayload(account.id));
  });

  app.post('/api/v1/auth/login', async (request, reply) => {
    const body = parseOrThrow(loginSchema, request.body);
    const usernameNormalized = normalizeUsername(body.username);

    enforce(limiters.loginByIp, request.ip);
    enforce(limiters.loginByUsername, usernameNormalized);

    const account = await findAccountByNormalizedUsername(db, usernameNormalized);
    const passwordMatches = await verifyPassword(
      account?.password_hash ?? deps.dummyPasswordHash,
      body.password,
    );
    if (!account || !passwordMatches) throw invalidCredentials();

    await touchLastLogin(db, account.id);
    const refreshToken = await issueRefreshToken(db, config, account.id);
    setRefreshCookie(reply, config, refreshToken);
    return reply.code(200).send(await sessionPayload(account.id));
  });

  app.post('/api/v1/auth/refresh', async (request, reply) => {
    const presented = request.cookies[REFRESH_COOKIE_NAME];
    if (!presented) throw new ApiError(401, 'UNAUTHORIZED', 'No active session.');

    const result = await rotateRefreshToken(db, config, presented);
    if (result.status !== 'ok') {
      clearRefreshCookie(reply, config);
      throw new ApiError(401, 'UNAUTHORIZED', 'Session expired. Sign in again.');
    }

    setRefreshCookie(reply, config, result.token);
    const payload: RefreshResponse = {
      accessToken: app.jwt.sign({ sub: result.accountId }, { expiresIn: config.accessTokenTtlSeconds }),
      expiresInSeconds: config.accessTokenTtlSeconds,
    };
    return reply.code(200).send(payload);
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const presented = request.cookies[REFRESH_COOKIE_NAME];
    if (presented) await revokePresentedRefreshToken(db, presented);
    clearRefreshCookie(reply, config);
    return reply.code(204).send();
  });

  app.get('/api/v1/auth/username-available', async (request, reply) => {
    enforce(limiters.usernameLookup, request.ip);
    const query = parseOrThrow(usernameAvailabilityQuerySchema, request.query);
    const problem = checkUsername(query.username);
    if (problem) {
      const payload: UsernameAvailabilityResponse = {
        username: query.username,
        available: false,
        suggestions: [],
      };
      return reply.code(200).send(payload);
    }

    const normalized = normalizeUsername(query.username);
    const existing = await findAccountByNormalizedUsername(db, normalized);
    const payload: UsernameAvailabilityResponse = {
      username: query.username,
      available: existing === null,
      suggestions: existing === null ? [] : suggestUsernames(query.username),
    };
    return reply.code(200).send(payload);
  });
}
