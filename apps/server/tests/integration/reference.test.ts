import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { COUNTRIES, OCCUPATION_IDS, PERSONALITY_IDS, SPECIES_IDS } from '@lethalmagotchi/shared';
import { closeTestPool, createTestApp } from '../helpers/app.js';

let app: FastifyInstance;

beforeAll(async () => {
  ({ app } = await createTestApp());
});

afterAll(async () => {
  await app.close();
  await closeTestPool();
});

describe('GET /api/v1/reference', () => {
  it('is readable without authentication, since character creation needs it first', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/reference' });
    expect(response.statusCode).toBe(200);
  });

  it('serves every species id the shared allow-list declares', async () => {
    const { species } = (await app.inject({ method: 'GET', url: '/api/v1/reference' })).json();
    expect(species.map((entry: { id: string }) => entry.id).sort()).toEqual([...SPECIES_IDS].sort());
  });

  it('serves every personality and occupation id the shared allow-list declares', async () => {
    const payload = (await app.inject({ method: 'GET', url: '/api/v1/reference' })).json();
    expect(payload.personalities.map((entry: { id: string }) => entry.id).sort()).toEqual(
      [...PERSONALITY_IDS].sort(),
    );
    expect(payload.occupations.map((entry: { id: string }) => entry.id).sort()).toEqual(
      [...OCCUPATION_IDS].sort(),
    );
  });

  it('serves the full country allow-list the schema validates against', async () => {
    const { countries } = (await app.inject({ method: 'GET', url: '/api/v1/reference' })).json();
    expect(countries).toHaveLength(COUNTRIES.length);
  });

  it('includes the decay rates the species picker renders pace hints from', async () => {
    const { species } = (await app.inject({ method: 'GET', url: '/api/v1/reference' })).json();
    for (const entry of species) {
      expect(entry.baseDecayRates).toMatchObject({
        hunger: expect.any(Number),
        hygiene: expect.any(Number),
        energy: expect.any(Number),
        mood: expect.any(Number),
      });
    }
  });

  it('is ETagged and cacheable', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/reference' });
    expect(response.headers.etag).toBeTruthy();
    expect(response.headers['cache-control']).toContain('max-age');
  });

  it('answers 304 with an empty body when the client already has the current version', async () => {
    const first = await app.inject({ method: 'GET', url: '/api/v1/reference' });
    const second = await app.inject({
      method: 'GET',
      url: '/api/v1/reference',
      headers: { 'if-none-match': first.headers.etag as string },
    });

    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
  });

  it('answers 200 with the payload when the client has a stale ETag', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/reference',
      headers: { 'if-none-match': '"an-old-etag"' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().species.length).toBeGreaterThan(0);
  });

  it('returns a stable ETag across requests so caches actually hit', async () => {
    const first = await app.inject({ method: 'GET', url: '/api/v1/reference' });
    const second = await app.inject({ method: 'GET', url: '/api/v1/reference' });
    expect(first.headers.etag).toBe(second.headers.etag);
  });
});
