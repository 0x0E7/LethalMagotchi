import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeTestPool, createTestApp } from '../helpers/app.js';

/**
 * Regression coverage for the boot crash where `buildApp` registered
 * `setNotFoundHandler` twice — once unconditionally and once inside the
 * `clientDist` branch — so Fastify threw `FST_ERR_NOT_FOUND_HANDLER_ALREADY_SET`
 * at startup whenever CLIENT_DIST was set. That is exactly the configuration the
 * production container runs, so the app booted in dev and dev-compose and died in
 * production only.
 */
const INDEX_HTML = '<!doctype html><html><body><div id="root"></div></body></html>';

let clientDist: string;

beforeAll(() => {
  clientDist = mkdtempSync(path.join(tmpdir(), 'lm-client-dist-'));
  writeFileSync(path.join(clientDist, 'index.html'), INDEX_HTML);
  writeFileSync(path.join(clientDist, 'app.js'), 'console.log("bundle");');
});

afterAll(async () => {
  rmSync(clientDist, { recursive: true, force: true });
  await closeTestPool();
});

describe('buildApp with a client bundle to serve', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // If this throws, the production container cannot start at all.
    ({ app } = await createTestApp({ config: { clientDist } }));
  });

  afterAll(async () => {
    await app.close();
  });

  it('boots without throwing', async () => {
    expect(app).toBeDefined();
    await expect(app.ready()).resolves.toBeDefined();
  });

  it('answers the health check', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('reports readiness once the database answers', async () => {
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);
  });

  it('serves the SPA at the root', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.body).toContain('id="root"');
  });

  it('serves static assets from the bundle', async () => {
    const response = await app.inject({ method: 'GET', url: '/app.js' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('bundle');
  });

  it.each(['/pet', '/create/species', '/create/details', '/some/unknown/client/route'])(
    'falls back to the SPA for the client-side route %s',
    async (url) => {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/html/);
      expect(response.body).toContain('id="root"');
    },
  );

  it('returns a JSON 404 for an unknown API route, never the SPA', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/unknown' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('returns a JSON 404 for an unknown non-GET route, never the SPA', async () => {
    const response = await app.inject({ method: 'POST', url: '/definitely-not-a-route' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('still routes real API endpoints rather than swallowing them into the SPA', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/reference' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/json/);
  });

  it('still returns API errors as JSON with the SPA fallback installed', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
  });
});

describe('buildApp with no client bundle (API-only deployment)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('boots without throwing', async () => {
    await expect(app.ready()).resolves.toBeDefined();
  });

  it('returns a JSON 404 at the root instead of an HTML page', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('returns a JSON 404 for an unknown client-looking route', async () => {
    const response = await app.inject({ method: 'GET', url: '/create/species' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('still serves the API', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
  });
});

describe('buildApp with a CLIENT_DIST pointing at a missing directory', () => {
  it('boots and degrades to API-only rather than crashing', async () => {
    const { app } = await createTestApp({
      config: { clientDist: path.join(tmpdir(), 'lm-client-dist-that-does-not-exist') },
    });
    try {
      await expect(app.ready()).resolves.toBeDefined();
      const response = await app.inject({ method: 'GET', url: '/' });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('NOT_FOUND');
    } finally {
      await app.close();
    }
  });
});

describe('CORS', () => {
  it('allows the configured client origin', async () => {
    const { app } = await createTestApp({ config: { clientOrigins: ['https://play.example.com'] } });
    try {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/api/v1/auth/login',
        headers: {
          origin: 'https://play.example.com',
          'access-control-request-method': 'POST',
        },
      });
      expect(response.headers['access-control-allow-origin']).toBe('https://play.example.com');
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    } finally {
      await app.close();
    }
  });

  it('does not echo an unknown origin back, and never uses a wildcard with credentials', async () => {
    const { app } = await createTestApp({ config: { clientOrigins: ['https://play.example.com'] } });
    try {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/api/v1/auth/login',
        headers: {
          origin: 'https://evil.example.com',
          'access-control-request-method': 'POST',
        },
      });
      expect(response.headers['access-control-allow-origin']).not.toBe('https://evil.example.com');
      expect(response.headers['access-control-allow-origin']).not.toBe('*');
    } finally {
      await app.close();
    }
  });
});
