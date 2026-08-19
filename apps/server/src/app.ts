import { existsSync } from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { ApiErrorBody } from '@lethalmagotchi/shared';
import type { ServerDeps } from './deps.js';
import { ApiError } from './errors.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCharacterRoutes } from './routes/characters.js';
import { registerReferenceRoutes } from './routes/reference.js';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    accountId: string;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string };
  }
}

export async function buildApp(deps: ServerDeps): Promise<FastifyInstance> {
  const { config, db } = deps;
  const app = Fastify({
    logger: config.nodeEnv === 'test' ? false : { level: config.nodeEnv === 'production' ? 'info' : 'debug' },
    trustProxy: config.nodeEnv === 'production',
  });

  await app.register(cors, { origin: config.clientOrigins, credentials: true });
  await app.register(cookie);
  await app.register(jwt, { secret: config.jwtSecret });

  app.decorateRequest('accountId', '');
  app.decorate('authenticate', async (request: FastifyRequest) => {
    try {
      const payload = await request.jwtVerify<{ sub: string }>();
      request.accountId = payload.sub;
    } catch {
      throw new ApiError(401, 'UNAUTHORIZED', 'Sign in to continue.');
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      const body: ApiErrorBody = {
        error: {
          code: error.code,
          message: error.message,
          ...(error.fields ? { fields: error.fields } : {}),
          ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
        },
      };
      if (error.retryAfterSeconds) reply.header('Retry-After', String(error.retryAfterSeconds));
      return reply.code(error.statusCode).send(body);
    }

    if ((error as { statusCode?: number }).statusCode === 400) {
      const body: ApiErrorBody = {
        error: { code: 'VALIDATION_FAILED', message: 'Malformed request.' },
      };
      return reply.code(400).send(body);
    }

    request.log.error({ err: error }, 'unhandled error');
    const body: ApiErrorBody = {
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' },
    };
    return reply.code(500).send(body);
  });

  const serveSpa = Boolean(config.clientDist) && existsSync(config.clientDist ?? '');

  if (!serveSpa) {
    app.setNotFoundHandler((request, reply) => {
      const body: ApiErrorBody = { error: { code: 'NOT_FOUND', message: 'Not found.' } };
      return reply.code(404).send(body);
    });
  }

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_request, reply) => {
    try {
      await db.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  await registerAuthRoutes(app, deps);
  await registerCharacterRoutes(app, deps);
  await registerReferenceRoutes(app, deps);

  if (serveSpa) {
    await app.register(fastifyStatic, { root: path.resolve(config.clientDist as string) });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.raw.method !== 'GET') {
        const body: ApiErrorBody = { error: { code: 'NOT_FOUND', message: 'Not found.' } };
        return reply.code(404).send(body);
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
