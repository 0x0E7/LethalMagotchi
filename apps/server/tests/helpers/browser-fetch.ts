import type { FastifyInstance } from 'fastify';

export interface FetchHarness {
  /** Drop-in replacement for `globalThis.fetch`, backed by `app.inject()`. */
  fetch: typeof fetch;
  /** How many requests reached each path, so "how many refreshes happened" is observable. */
  calls: Map<string, number>;
  callsTo: (path: string) => number;
  cookies: Map<string, string>;
  setCookie: (name: string, value: string) => void;
}

/**
 * Lets the real browser API client (`apps/client/src/api/client.ts`) run against a
 * real Fastify instance in Node: it speaks relative URLs, `credentials: 'include'`
 * and Set-Cookie, none of which plain `fetch` supports outside a browser.
 *
 * Deliberately *not* a mock of the client — the module under test is unmodified,
 * so this exercises its real retry/refresh behaviour end to end.
 */
export function createFetchHarness(app: FastifyInstance): FetchHarness {
  const cookies = new Map<string, string>();
  const calls = new Map<string, number>();

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const path = url.split('?')[0]!;
    calls.set(path, (calls.get(path) ?? 0) + 1);

    const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
    if (cookies.size > 0) {
      headers.cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    }

    const injected = await app.inject({
      method: (init?.method ?? 'GET') as 'GET',
      url,
      headers,
      ...(init?.body === undefined || init?.body === null ? {} : { payload: init.body as string }),
    });

    for (const cookie of injected.cookies) {
      if (cookie.value === '') cookies.delete(cookie.name);
      else cookies.set(cookie.name, cookie.value as string);
    }

    const hasBody = injected.statusCode !== 204 && injected.statusCode !== 304;
    return new Response(hasBody ? injected.rawPayload : null, {
      status: injected.statusCode,
      headers: { 'content-type': (injected.headers['content-type'] as string) ?? 'application/json' },
    });
  };

  return {
    fetch: fetchImpl as typeof fetch,
    calls,
    callsTo: (path) => calls.get(path) ?? 0,
    cookies,
    setCookie: (name, value) => cookies.set(name, value),
  };
}
