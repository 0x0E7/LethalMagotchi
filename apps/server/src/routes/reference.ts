import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ReferenceResponse } from '@lethalmagotchi/shared';
import type { ServerDeps } from '../deps.js';
import { loadReference } from '../repos/reference.js';

export async function registerReferenceRoutes(app: FastifyInstance, deps: ServerDeps): Promise<void> {
  let cached: { payload: ReferenceResponse; etag: string } | null = null;

  app.get('/api/v1/reference', async (request, reply) => {
    if (!cached) {
      const payload = await loadReference(deps.db);
      const etag = `"${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32)}"`;
      cached = { payload, etag };
    }

    reply.header('ETag', cached.etag);
    reply.header('Cache-Control', 'public, max-age=300');
    if (request.headers['if-none-match'] === cached.etag) return reply.code(304).send();
    return reply.code(200).send(cached.payload);
  });
}
