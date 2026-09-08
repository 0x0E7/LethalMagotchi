import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { WS_PATH } from '@lethalmagotchi/shared';
import { MAX_ANON_SOCKETS_PER_IP } from '../../src/ws/routes.js';
import { closeTestPool, createTestApp } from '../helpers/app.js';

afterAll(async () => {
  await closeTestPool();
});

/** Reports the `request.ip` the per-IP limiters would have keyed on. */
function recordIps(app: FastifyInstance): string[] {
  const seen: string[] = [];
  app.addHook('onRequest', async (request) => {
    seen.push(request.ip);
  });
  return seen;
}

const SPOOFED = '198.51.100.7';

describe('X-Forwarded-For is not believed unless a proxy is configured', () => {
  it('keys on the socket address in production, ignoring a spoofed header', async () => {
    const { app } = await createTestApp({ config: { nodeEnv: 'production' } });
    const seen = recordIps(app);
    try {
      await app.inject({ method: 'GET', url: '/healthz', headers: { 'x-forwarded-for': SPOOFED } });
      expect(seen).toEqual(['127.0.0.1']);
    } finally {
      await app.close();
    }
  });

  it('ignores a spoof that a real proxy hop has appended to', async () => {
    const { app } = await createTestApp({ config: { nodeEnv: 'production' } });
    const seen = recordIps(app);
    try {
      await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { 'x-forwarded-for': `${SPOOFED}, 10.0.0.7` },
      });
      expect(seen).toEqual(['127.0.0.1']);
    } finally {
      await app.close();
    }
  });

  it('with the proxy allowlisted, takes the hop the proxy appended, not the client value', async () => {
    const { app } = await createTestApp({ config: { trustProxy: ['127.0.0.1'] } });
    const seen = recordIps(app);
    try {
      await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { 'x-forwarded-for': `${SPOOFED}, 203.0.113.9` },
      });
      expect(seen).toEqual(['203.0.113.9']);
    } finally {
      await app.close();
    }
  });
});

describe('the websocket per-address cap survives header spoofing', () => {
  it('counts every socket against one address however the header varies', async () => {
    const { app, hub } = await createTestApp({ config: { nodeEnv: 'production' } });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const open: WebSocket[] = [];
    const openWith = (index: number): Promise<WebSocket> => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, {
        headers: { 'x-forwarded-for': `198.51.100.${index % 254}` },
      });
      return new Promise((resolve, reject) => {
        socket.once('open', () => resolve(socket));
        socket.once('error', reject);
      });
    };

    try {
      for (let index = 0; index < MAX_ANON_SOCKETS_PER_IP; index += 1) {
        open.push(await openWith(index));
      }
      // A distinct forged address per socket bought no extra budget at all.
      await expect(openWith(MAX_ANON_SOCKETS_PER_IP)).rejects.toThrow();
    } finally {
      for (const socket of open) socket.close();
      hub.closeAll();
      await app.close();
    }
  }, 30_000);
});
