import { createAdaptorServer } from '@hono/node-server';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { ManualClock } from '../src/clock';
import { createInMemoryDeps } from '../src/deps';
import type { InMemoryDepsOptions } from '../src/deps';

const LISTING = 'listing-1';
const TTL_MS = 10 * 60 * 1000;
const MINUTE = 60 * 1000;

function setup(options: InMemoryDepsOptions = {}) {
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

describe('happy path', () => {
  it('creates a session with a hold, resumes it unchanged, and completes it', async () => {
    const { api, clock, deps } = setup();

    const created = await api.post('/api/sessions').send({ listingId: LISTING });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      listingId: LISTING,
      status: 'active',
      priceSnapshot: 10000,
      currentPrice: 10000,
      version: 1,
      changes: [],
      holdExpiresAt: new Date(clock.now().getTime() + TTL_MS).toISOString(),
    });
    const id = created.body.id as string;

    clock.advance(2 * MINUTE);
    const resumed = await api.get(`/api/sessions/${id}`);
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ status: 'active', version: 1, changes: [] });

    const done = await api.post(`/api/sessions/${id}/complete`).send({ idempotencyKey: 'pay-1' });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'completed', idempotencyKey: 'pay-1' });
    expect(done.body.orderId).toEqual(expect.any(String));
    expect(deps.payment.charges).toEqual([{ sessionId: id, amount: 10000, idempotencyKey: 'pay-1' }]);

    const after = await api.get(`/api/sessions/${id}`);
    expect(after.body).toMatchObject({ status: 'completed', orderId: done.body.orderId });
  });

  it('replaying complete with the same idempotency key does not charge twice', async () => {
    const { api, deps, createSession } = setup();
    const { id } = await createSession();

    const first = await api.post(`/api/sessions/${id}/complete`).set('Idempotency-Key', 'k').send({});
    const second = await api.post(`/api/sessions/${id}/complete`).set('Idempotency-Key', 'k').send({});

    expect(second.status).toBe(200);
    expect(second.body.orderId).toBe(first.body.orderId);
    expect(deps.payment.charges).toHaveLength(1);
  });
});

describe('expiry on resume', () => {
  it('expires the session once the hold lapses and frees the unit', async () => {
    const { api, clock, createSession } = setup();
    const { id } = await createSession();

    clock.advance(TTL_MS);
    const resumed = await api.get(`/api/sessions/${id}`);
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ status: 'expired', version: 2 });

    const complete = await api.post(`/api/sessions/${id}/complete`).send({ idempotencyKey: 'k' });
    expect(complete.status).toBe(409);
    expect(complete.body).toMatchObject({
      error: { code: 'ILLEGAL_TRANSITION' },
      session: { status: 'expired' },
    });

    // The only unit is back on the shelf.
    const second = await api.post('/api/sessions').send({ listingId: LISTING });
    expect(second.status).toBe(201);
  });

  it('is still active one millisecond before the hold lapses', async () => {
    const { api, clock, createSession } = setup();
    const { id } = await createSession();

    clock.advance(TTL_MS - 1);
    expect((await api.get(`/api/sessions/${id}`)).body.status).toBe('active');
  });
});

describe('price change on resume', () => {
  it('requires acknowledgment of an increase before payment', async () => {
    const { api, deps, clock, createSession } = setup();
    const { id } = await createSession();

    deps.pricing.setPrice(LISTING, 12500);
    clock.advance(MINUTE);
    const resumed = await api.get(`/api/sessions/${id}`);
    expect(resumed.body).toMatchObject({
      status: 'price_changed',
      priceSnapshot: 10000,
      currentPrice: 12500,
      version: 2,
      changes: [{ from: 10000, to: 12500, outcome: 'needs_ack', at: clock.now().toISOString() }],
    });

    // Resuming again does not duplicate the change.
    const again = await api.get(`/api/sessions/${id}`);
    expect(again.body.changes).toHaveLength(1);
    expect(again.body.version).toBe(2);

    const early = await api.post(`/api/sessions/${id}/complete`).send({ idempotencyKey: 'k' });
    expect(early.status).toBe(409);
    expect(deps.payment.charges).toHaveLength(0);

    const ack = await api.post(`/api/sessions/${id}/acknowledge`).send({ version: 2 });
    expect(ack.status).toBe(200);
    expect(ack.body).toMatchObject({ status: 'active', priceSnapshot: 12500, currentPrice: 12500, version: 3 });

    const done = await api.post(`/api/sessions/${id}/complete`).send({ idempotencyKey: 'k' });
    expect(done.status).toBe(200);
    expect(deps.payment.charges[0]).toMatchObject({ amount: 12500 });
  });

  it('rejects an acknowledgment of a price the buyer has not seen', async () => {
    const { api, deps, createSession } = setup();
    const { id } = await createSession();

    deps.pricing.setPrice(LISTING, 12000);
    const seen = await api.get(`/api/sessions/${id}`);
    deps.pricing.setPrice(LISTING, 15000); // moves again before the buyer clicks

    const ack = await api.post(`/api/sessions/${id}/acknowledge`).send({ version: seen.body.version });
    expect(ack.status).toBe(409);
    expect(ack.body).toMatchObject({
      error: { code: 'VERSION_CONFLICT' },
      session: { status: 'price_changed', priceSnapshot: 10000, currentPrice: 15000 },
    });
  });

  it('auto-applies a decrease', async () => {
    const { api, deps, createSession } = setup();
    const { id } = await createSession();

    deps.pricing.setPrice(LISTING, 9000);
    const resumed = await api.get(`/api/sessions/${id}`);
    expect(resumed.body).toMatchObject({
      status: 'active',
      priceSnapshot: 9000,
      currentPrice: 9000,
      changes: [{ from: 10000, to: 9000, outcome: 'auto_applied' }],
    });
  });

  it('rejects acknowledging when there is nothing to acknowledge', async () => {
    const { api, createSession } = setup();
    const { id } = await createSession();

    const ack = await api.post(`/api/sessions/${id}/acknowledge`).send({ version: 1 });
    expect(ack.status).toBe(409);
    expect(ack.body.error.code).toBe('ILLEGAL_TRANSITION');
  });
});

describe('sold out', () => {
  it('refuses to create a session when nothing is in stock', async () => {
    const { api } = setup({ stock: { [LISTING]: 0 } });

    const res = await api.post('/api/sessions').send({ listingId: LISTING });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SOLD_OUT');
  });

  it('only holds one unit at a time', async () => {
    const { api, createSession } = setup();
    await createSession();

    const second = await api.post('/api/sessions').send({ listingId: LISTING });
    expect(second.status).toBe(409);
  });

  it('marks a session unavailable on resume when the inventory is lost', async () => {
    const { api, deps, createSession } = setup();
    const { id } = await createSession();

    deps.inventory.revokeStock(LISTING);
    const resumed = await api.get(`/api/sessions/${id}`);
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ status: 'unavailable', version: 2 });

    const complete = await api.post(`/api/sessions/${id}/complete`).send({ idempotencyKey: 'k' });
    expect(complete.status).toBe(409);
    expect(deps.payment.charges).toHaveLength(0);
  });
});

describe('payment outcomes', () => {
  it('returns 402 on failure and lets the buyer retry with a new key', async () => {
    const { api, deps, createSession } = setup({ paymentBehavior: 'fail' });
    const { id } = await createSession();

    const failed = await api.post(`/api/sessions/${id}/complete`).send({ idempotencyKey: 'k1' });
    expect(failed.status).toBe(402);
    expect(failed.body).toMatchObject({
      error: { code: 'PAYMENT_FAILED', message: 'card_declined' },
      session: { status: 'payment_failed' },
    });

    deps.payment.setBehavior('succeed');
    const retry = await api.post(`/api/sessions/${id}/complete`).send({ idempotencyKey: 'k2' });
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('completed');
  });

  it('re-prices a failed session on retry instead of charging a stale price', async () => {
    const { api, deps, createSession } = setup({ paymentBehavior: 'fail' });
    const { id } = await createSession();
    await api.post(`/api/sessions/${id}/complete`).send({ idempotencyKey: 'k1' });

    deps.payment.setBehavior('succeed');
    deps.pricing.setPrice(LISTING, 11000);
    const retry = await api.post(`/api/sessions/${id}/complete`).send({ idempotencyKey: 'k2' });

    expect(retry.status).toBe(409);
    expect(retry.body.session).toMatchObject({ status: 'price_changed', currentPrice: 11000 });
    expect(deps.payment.charges).toHaveLength(1);
  });

  it('returns 202 while pending and settles on a later resume', async () => {
    const { api, deps, createSession } = setup({ paymentBehavior: 'pending' });
    const { id } = await createSession();

    const pending = await api.post(`/api/sessions/${id}/complete`).send({ idempotencyKey: 'k' });
    expect(pending.status).toBe(202);
    expect(pending.body.status).toBe('payment_pending');

    expect((await api.get(`/api/sessions/${id}`)).body.status).toBe('payment_pending');

    deps.payment.settle('k', { status: 'succeeded' });
    const settled = await api.get(`/api/sessions/${id}`);
    expect(settled.body).toMatchObject({ status: 'completed' });
    expect(settled.body.orderId).toEqual(expect.any(String));
  });

  it('does not let a lapsed hold expire a session while payment is in flight', async () => {
    const { api, clock, createSession } = setup({ paymentBehavior: 'pending' });
    const { id } = await createSession();
    await api.post(`/api/sessions/${id}/complete`).send({ idempotencyKey: 'k' });

    clock.advance(TTL_MS * 2);
    expect((await api.get(`/api/sessions/${id}`)).body.status).toBe('payment_pending');
  });
});

describe('request validation', () => {
  it('404s for unknown sessions and listings', async () => {
    const { api } = setup();

    expect((await api.get('/api/sessions/nope')).status).toBe(404);
    expect((await api.post('/api/sessions/nope/complete').send({ idempotencyKey: 'k' })).status).toBe(404);
    expect((await api.post('/api/sessions').send({ listingId: 'ghost' })).status).toBe(404);
  });

  it('400s on missing fields and malformed JSON', async () => {
    const { api, createSession } = setup();
    const { id } = await createSession();

    expect((await api.post('/api/sessions').send({})).status).toBe(400);
    expect((await api.post('/api/sessions').set('Content-Type', 'application/json').send('{oops')).status).toBe(400);
    expect((await api.post(`/api/sessions/${id}/complete`).send({})).status).toBe(400);
    expect((await api.post(`/api/sessions/${id}/acknowledge`).send({})).status).toBe(400);
  });
});
