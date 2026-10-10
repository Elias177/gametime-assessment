import { createAdaptorServer } from '@hono/node-server';
import request from 'supertest';
import { expect } from 'vitest';
import { createApp } from '../src/app';
import { ManualClock } from '../src/clock';
import { createInMemoryDeps } from '../src/deps';
import type { InMemoryDepsOptions } from '../src/deps';

export const LISTING = 'listing-1';
export const TTL_MS = 10 * 60 * 1000;
export const MINUTE = 60 * 1000;

export type Api = ReturnType<typeof request>;

export function setup(options: InMemoryDepsOptions = {}) {
  const clock = new ManualClock();
  const deps = createInMemoryDeps({
    clock,
    stock: { [LISTING]: 1 },
    prices: { [LISTING]: 10000 },
    holdTtlMs: TTL_MS,
    ...options,
  });
  const api = request(createAdaptorServer({ fetch: createApp(deps).fetch }));

  const createSession = async () => {
    const res = await api.post('/api/sessions').send({ listingId: LISTING });
    expect(res.status).toBe(201);
    return res.body as { id: string; version: number };
  };
  return { clock, deps, api, createSession };
}

/** POST /complete with the required `Idempotency-Key` header and client `version`. */
export function complete(api: Api, id: string, key: string, version: number) {
  return api.post(`/api/sessions/${id}/complete`).set('Idempotency-Key', key).send({ version });
}
