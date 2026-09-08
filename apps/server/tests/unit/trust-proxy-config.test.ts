import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const BASE_ENV = {
  DATABASE_URL: 'postgresql://lethal:lethal@localhost:5432/lethalmagotchi',
  JWT_SECRET: 'test-only-secret-at-least-16-chars',
};

describe('TRUST_PROXY', () => {
  it('does not trust forwarded headers in production unless told to', () => {
    expect(loadConfig({ ...BASE_ENV, NODE_ENV: 'production' }).trustProxy).toBe(false);
  });

  it('refuses `true`, which would trust a client-supplied X-Forwarded-For', () => {
    expect(() => loadConfig({ ...BASE_ENV, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
  });

  it('refuses a bare hop count, which this Fastify reads as "trust nothing"', () => {
    expect(() => loadConfig({ ...BASE_ENV, TRUST_PROXY: '1' })).toThrow(/hop count/);
  });

  it('refuses an entry that is not an address, CIDR or preset', () => {
    expect(() => loadConfig({ ...BASE_ENV, TRUST_PROXY: 'my-proxy.internal' })).toThrow(/not an address/);
  });

  it('reads an allowlist as a list of addresses', () => {
    expect(loadConfig({ ...BASE_ENV, TRUST_PROXY: '10.0.0.0/8, 172.16.0.1' }).trustProxy).toEqual([
      '10.0.0.0/8',
      '172.16.0.1',
    ]);
  });

  it('treats an explicit `false` and an empty value alike', () => {
    expect(loadConfig({ ...BASE_ENV, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ ...BASE_ENV, TRUST_PROXY: '' }).trustProxy).toBe(false);
  });
});
