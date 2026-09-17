import type { FastifyInstance } from 'fastify';
import {
  type RefreshResponse,
  type SessionResponse,
  type UsernameAvailabilityResponse,
  checkUsername,
  normalizeUsername,
  registerSchema,
  loginSchema,
  suggestUsernames,
  usernameAvailabilityQuerySchema,
} from '@lethalmagotchi/shared';
import { REFRESH_COOKIE_NAME } from '../config.js';
import type { ServerDeps } from '../deps.js';
import { ApiError } from '../errors.js';
import { performLogin, performLogout, performRefresh, performRegister, type SessionDeps } from '../auth/session.js';
import { clearRefreshCookie, setRefreshCookie } from '../auth/tokens.js';
import { findAccountByNormalizedUsername } from '../repos/accounts.js';
import { parseOrThrow } from '../validate.js';
import type { RateLimiter } from '../rate-limit.js';

/**
 * v1's session transport: the refresh token lives in an `httpOnly` cookie and never appears
 * in a response body. `routes/auth-v2.ts` is the same handlers with the token moved into the
 * body instead — see `v2-architecture.md` §14.3. The core logic lives in `auth/session.ts`;
 * this file is deliberately thin.
 */
export async function registerAuthRoutes(app: FastifyInstance, deps: ServerDeps): Promise<void> {
  const { config, db, limiters } = deps;
  const sessionDeps: SessionDeps = { db, config, app, dummyPasswordHash: deps.dummyPasswordHash };

  const enforce = (limiter: RateLimiter, key: string) => {
    const decision = limiter.check(key);
    if (!decision.allowed) {
      throw new ApiError(429, 'RATE_LIMITED', 'Too many attempts. Try again shortly.', {
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }
  };

  /**
   * The enforcement point for the rule stated on `SessionResult` in `auth/session.ts`: the
   * refresh token rides the cookie only. `refreshToken` is destructured out and discarded
   * here, never spread into the body — an `httpOnly` cookie whose value also sits in
   * page-readable JSON is not protected by `httpOnly` at all.
   */
  const toV1Session = ({ refreshToken: _refreshToken, ...rest }: Awaited<ReturnType<typeof performRegister>>): SessionResponse =>
    rest;

  app.post('/api/v1/auth/register', async (request, reply) => {
    enforce(limiters.register, request.ip);
    const body = parseOrThrow(registerSchema, request.body);
    const session = await performRegister(sessionDeps, body);
    setRefreshCookie(reply, config, session.refreshToken);
    return reply.code(201).send(toV1Session(session));
  });

  app.post('/api/v1/auth/login', async (request, reply) => {
    const body = parseOrThrow(loginSchema, request.body);
    const usernameNormalized = normalizeUsername(body.username);

    enforce(limiters.loginByIp, request.ip);
    enforce(limiters.loginByUsername, usernameNormalized);

    const session = await performLogin(sessionDeps, body);
    setRefreshCookie(reply, config, session.refreshToken);
    return reply.code(200).send(toV1Session(session));
  });

  app.post('/api/v1/auth/refresh', async (request, reply) => {
    const presented = request.cookies[REFRESH_COOKIE_NAME];
    if (!presented) throw new ApiError(401, 'UNAUTHORIZED', 'No active session.');

    let result;
    try {
      result = await performRefresh(sessionDeps, presented);
    } catch (error) {
      clearRefreshCookie(reply, config);
      throw error;
    }

    setRefreshCookie(reply, config, result.refreshToken);
    const payload: RefreshResponse = {
      accessToken: result.accessToken,
      expiresInSeconds: result.expiresInSeconds,
    };
    return reply.code(200).send(payload);
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const presented = request.cookies[REFRESH_COOKIE_NAME];
    await performLogout({ db }, presented ?? null);
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
