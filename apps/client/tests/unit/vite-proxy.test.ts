import { describe, expect, it } from 'vitest';
import { WS_PATH } from '@lethalmagotchi/shared';
import viteConfig from '../../vite.config.js';

/**
 * The dev server has to forward the socket, not just `/api`.
 *
 * Without a `/ws` entry the browser asks its own origin for the socket, the dev server has
 * nothing to hand back, and every real-time feature — chat, duels, raids, tournaments,
 * group sync — is dead in `npm run dev` while the built app works perfectly. Nothing else
 * in the suite can catch that: the end-to-end server serves the built client itself, so
 * there both live on one origin and no proxy is involved.
 *
 * This is deliberately a test about configuration rather than behaviour, because the bug
 * was configuration.
 */
describe('the dev server proxy', () => {
  const proxy = (viteConfig as { server?: { proxy?: Record<string, unknown> } }).server?.proxy ?? {};

  it('forwards the API', () => {
    expect(proxy['/api']).toBeDefined();
  });

  it('forwards the socket path the client actually connects to', () => {
    // Keyed off the shared constant, so moving the path moves the assertion with it.
    expect(Object.keys(proxy)).toContain(WS_PATH);
  });

  it('upgrades that socket rather than answering it as a request', () => {
    const entry = proxy[WS_PATH] as { ws?: boolean; target?: string } | undefined;
    expect(entry?.ws, '`ws: true` is what makes this an upgrade rather than a 404').toBe(true);
    expect(entry?.target).toMatch(/^wss?:\/\//);
  });
});
