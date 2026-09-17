import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  type RefreshResponseV2,
  type SessionResponseV2,
  loginSchema,
  normalizeUsername,
  registerSchema,
} from '@lethalmagotchi/shared';
import type { ServerDeps } from '../deps.js';
import { ApiError } from '../errors.js';
import { performLogin, performLogout, performRefresh, performRegister, type SessionDeps } from '../auth/session.js';
import { parseOrThrow } from '../validate.js';
import type { RateLimiter } from '../rate-limit.js';

const refreshBodySchema = z.object({ refreshToken: z.string().min(1) }).strict();
const logoutBodySchema = z.object({ refreshToken: z.string().min(1) }).strict();

/**
 * The v2 (native mobile / WebGL-bridge) session transport — `v2-architecture.md` §14.3.
 *
 * The same handlers as `routes/auth.ts`, with the refresh token in the response body instead
 * of a `Set-Cookie`: there is no cookie jar on a native client, and §14.4 rules out ever
 * putting one on Unity WebGL either (WebGL never sees a refresh token at all — the page shell
 * owns the session there and hands Unity a bearer access token only, unchanged from §9).
 *
 * Additive only. Nothing here touches a v1 route, table, or cookie, and both versions share
 * the same accounts, the same `refresh_tokens` rows, and — deliberately — the same rate
 * limiters: a v2 client that failed five logins has spent the same budget a v1 browser would
 * have, not a fresh one. `tests/integration/auth-v2.test.ts` asserts that sharing directly.
 *
 * Username availability has no v2 duplicate: it touches no cookie and no token, so the v1
 * endpoint (`GET /api/v1/auth/username-available`) already serves both transports as-is.
 */
export async function registerAuthV2Routes(app: FastifyInstance, deps: ServerDeps): Promise<void> {
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

  app.post('/api/v2/auth/register', async (request, reply) => {
    enforce(limiters.register, request.ip);
    const body = parseOrThrow(registerSchema, request.body);
    const session = await performRegister(sessionDeps, body);
    const payload: SessionResponseV2 = session;
    return reply.code(201).send(payload);
  });

  app.post('/api/v2/auth/login', async (request, reply) => {
    const body = parseOrThrow(loginSchema, request.body);
    const usernameNormalized = normalizeUsername(body.username);

    enforce(limiters.loginByIp, request.ip);
    enforce(limiters.loginByUsername, usernameNormalized);

    const session = await performLogin(sessionDeps, body);
    const payload: SessionResponseV2 = session;
    return reply.code(200).send(payload);
  });

  app.post('/api/v2/auth/refresh', async (request, reply) => {
    const body = parseOrThrow(refreshBodySchema, request.body);
    const result = await performRefresh(sessionDeps, body.refreshToken);
    const payload: RefreshResponseV2 = result;
    return reply.code(200).send(payload);
  });

  app.post('/api/v2/auth/logout', async (request, reply) => {
    const body = parseOrThrow(logoutBodySchema, request.body);
    await performLogout({ db }, body.refreshToken);
    return reply.code(204).send();
  });
}
