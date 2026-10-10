import { createAdaptorServer } from '@hono/node-server';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { ManualClock, OffsetClock } from '../src/clock';
import { createInMemoryDeps } from '../src/deps';
import { InMemorySessionStore } from '../src/store';
import { LISTING, MINUTE, TTL_MS, complete, listen, openEvents, startSession } from './helpers';

const OTHER = 'listing-2';

/** Dev tools on, over an OffsetClock whose base is manual so tests control "real" time. */
function setupDev() {
  const base = new ManualClock();
  const clock = new OffsetClock(base);
  const deps = createInMemoryDeps({
    clock,
    timers: base, // never advanced: like real timers that a clock jump can't fire
    stock: { [LISTING]: 3, [OTHER]: 3 },
    prices: { [LISTING]: 10000, [OTHER]: 5000 },
    holdTtlMs: TTL_MS,
    paymentBehavior: 'succeed',
  });
  const app = createApp(deps, { devTools: { deps, clock } });
  const api = request(createAdaptorServer({ fetch: app.fetch }));

  const create = async (listingId = LISTING) => {
    const res = await startSession(api, listingId);
    expect(res.status).toBe(201);
    return res.body as { id: string; version: number; holdExpiresAt: string };
  };
  // Straight from the store: a GET would re-evaluate the session itself and hide a missing refresh.
  const get = async (id: string) => deps.store.get(id);
  return { base, clock, deps, app, api, create, get };
}

const open: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

/** An open SSE stream on a session, closed after the test. */
async function stream(app: ReturnType<typeof setupDev>['app'], id: string) {
  const server = await listen(app);
  const events = await openEvents(`${server.url}/api/sessions/${id}/events`);
  open.push(async () => {
    events.close();
    await server.close();
  });
  return events;
}

describe('OffsetClock and store helpers', () => {
  it('adds an offset to the wrapped clock and resets it', () => {
    const base = new ManualClock();
    const clock = new OffsetClock(base);

    clock.advance(5000);
    clock.advance(1000);
    expect(clock.now().getTime() - base.now().getTime()).toBe(6000);
    expect(clock.offsetMs).toBe(6000);

    base.advance(1000); // real time still flows underneath
    expect(clock.now().getTime() - new Date('2030-01-01T00:00:00.000Z').getTime()).toBe(7000);

    clock.reset();
    expect(clock.now().getTime()).toBe(base.now().getTime());
  });

  it('lists copies of every stored session', () => {
    const store = new InMemorySessionStore();
    const s = (id: string) => ({
      id,
      listingId: LISTING,
      createdAt: 'x',
      originClientId: 'c',
      originSurface: 'web' as const,
      status: 'active' as const,
      priceSnapshot: 1,
      currentPrice: 1,
      holdExpiresAt: 'x',
      version: 1,
      changes: [],
    });
    store.create(s('a'));
    store.create(s('b'));

    const listed = store.list();
    expect(listed.map((x) => x.id)).toEqual(['a', 'b']);
    listed[0]!.status = 'completed'; // a copy: the store is untouched
    expect(store.get('a')!.status).toBe('active');
  });
});

describe('dev tools off', () => {
  it('does not mount /api/dev at all', async () => {
    const base = new ManualClock();
    const deps = createInMemoryDeps({ clock: base, timers: base, stock: { [LISTING]: 1 }, prices: { [LISTING]: 1 } });
    const api = request(createAdaptorServer({ fetch: createApp(deps).fetch }));

    expect((await api.get('/api/dev/status')).status).toBe(404);
    expect((await api.post('/api/dev/reset')).status).toBe(404);
    expect((await api.post('/api/dev/expire/anything')).status).toBe(404);
    expect((await api.post('/api/dev/price').send({ listingId: LISTING, deltaCents: 1 })).status).toBe(404);
    expect((await api.post('/api/dev/sell-out').send({ listingId: LISTING })).status).toBe(404);
    expect((await api.post('/api/dev/payment-behavior').send({ behavior: 'fail' })).status).toBe(404);
    expect((await api.post('/api/dev/settle/anything').send({ outcome: 'failed' })).status).toBe(404);
    expect((await api.get('/api/health')).status).toBe(200); // the rest of the app is unaffected
  });
});

describe('GET /api/dev/status', () => {
  it('reports that dev tools are on, the payment behavior and the clock offset', async () => {
    const { api, clock } = setupDev();
    clock.advance(1500);

    const res = await api.get('/api/dev/status');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, paymentBehavior: 'succeed', clockOffsetMs: 1500 });
  });
});

describe('POST /api/dev/expire/:sessionId', () => {
  it('moves the clock just past the hold and expires the session without waiting for a timer', async () => {
    const { api, create, get, clock } = setupDev();
    const { id } = await create();

    const res = await api.post(`/api/dev/expire/${id}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, status: 'expired' });
    expect(clock.offsetMs).toBe(TTL_MS + 1); // just past holdExpiresAt, not further
    expect(await get(id)).toMatchObject({ status: 'expired' });
  });

  it('refreshes every live session, not only the target', async () => {
    const { api, create, get, base } = setupDev();
    const early = await create(); // hold ends at t+10m
    base.advance(5 * MINUTE);
    const late = await create(); // hold ends at t+15m

    await api.post(`/api/dev/expire/${late.id}`); // jumps past t+15m, so `early` has lapsed too

    expect(await get(late.id)).toMatchObject({ status: 'expired' });
    expect(await get(early.id)).toMatchObject({ status: 'expired' });
  });

  it('is harmless on a session whose hold already lapsed', async () => {
    const { api, create, clock } = setupDev();
    const { id } = await create();
    await api.post(`/api/dev/expire/${id}`);
    const offset = clock.offsetMs;

    const again = await api.post(`/api/dev/expire/${id}`);

    expect(again.status).toBe(200);
    expect(clock.offsetMs).toBe(offset);
  });

  it('404s for an unknown session', async () => {
    const { api } = setupDev();
    const res = await api.post('/api/dev/expire/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('reaches an open SSE stream', async () => {
    const { api, create, app } = setupDev();
    const { id } = await create();
    const events = await stream(app, id);
    expect(await events.nextSession()).toMatchObject({ status: 'active' });

    await api.post(`/api/dev/expire/${id}`);

    expect(await events.nextSession()).toMatchObject({ status: 'expired' });
  });
});

describe('POST /api/dev/price', () => {
  it('an increase moves live sessions on that listing to price_changed', async () => {
    const { api, create, get } = setupDev();
    const { id } = await create();

    const res = await api.post('/api/dev/price').send({ listingId: LISTING, deltaCents: 1200 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ listingId: LISTING, price: 11200 });
    expect(await get(id)).toMatchObject({ status: 'price_changed', priceSnapshot: 10000, currentPrice: 11200 });
  });

  it('a decrease is applied silently', async () => {
    const { api, create, get } = setupDev();
    const { id } = await create();

    await api.post('/api/dev/price').send({ listingId: LISTING, deltaCents: -500 });

    expect(await get(id)).toMatchObject({ status: 'active', currentPrice: 9500 });
  });

  it('never goes below zero', async () => {
    const { api } = setupDev();

    const res = await api.post('/api/dev/price').send({ listingId: LISTING, deltaCents: -99_999_999 });

    expect(res.status).toBe(200);
    expect(res.body.price).toBe(0);
  });

  it('leaves sessions on other listings alone', async () => {
    const { api, create, get } = setupDev();
    const other = await create(OTHER);

    await api.post('/api/dev/price').send({ listingId: LISTING, deltaCents: 1200 });

    expect(await get(other.id)).toMatchObject({ status: 'active', version: other.version });
  });

  it('validates the body and the listing', async () => {
    const { api } = setupDev();

    for (const body of [{}, { deltaCents: 1 }, { listingId: '', deltaCents: 1 }, { listingId: LISTING }, { listingId: LISTING, deltaCents: 1.5 }, { listingId: LISTING, deltaCents: '12' }]) {
      const res = await api.post('/api/dev/price').send(body);
      expect([JSON.stringify(body), res.status, res.body.error?.code]).toEqual([JSON.stringify(body), 400, 'INVALID_REQUEST']);
    }
    expect((await api.post('/api/dev/price').set('Content-Type', 'application/json').send('{oops')).status).toBe(400);

    const unknown = await api.post('/api/dev/price').send({ listingId: 'ghost', deltaCents: 1 });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('LISTING_NOT_FOUND');
  });

  it('reaches an open SSE stream', async () => {
    const { api, create, app } = setupDev();
    const { id } = await create();
    const events = await stream(app, id);
    await events.nextSession();

    await api.post('/api/dev/price').send({ listingId: LISTING, deltaCents: 1200 });

    expect(await events.nextSession()).toMatchObject({ status: 'price_changed', currentPrice: 11200 });
  });
});

describe('POST /api/dev/sell-out', () => {
  it('makes live sessions on that listing unavailable and blocks new ones', async () => {
    const { api, create, get } = setupDev();
    const { id } = await create();
    const other = await create(OTHER);

    const res = await api.post('/api/dev/sell-out').send({ listingId: LISTING });

    expect(res.status).toBe(200);
    expect(await get(id)).toMatchObject({ status: 'unavailable' });
    expect(await get(other.id)).toMatchObject({ status: 'active' });
    const fresh = await startSession(api, LISTING);
    expect(fresh.status).toBe(409);
    expect(fresh.body.error.code).toBe('SOLD_OUT');
  });

  it('validates the body and the listing', async () => {
    const { api } = setupDev();

    for (const body of [{}, { listingId: '' }, { listingId: 5 }]) {
      const res = await api.post('/api/dev/sell-out').send(body);
      expect([res.status, res.body.error?.code]).toEqual([400, 'INVALID_REQUEST']);
    }
    const unknown = await api.post('/api/dev/sell-out').send({ listingId: 'ghost' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('LISTING_NOT_FOUND');
  });

  it('reaches an open SSE stream', async () => {
    const { api, create, app } = setupDev();
    const { id } = await create();
    const events = await stream(app, id);
    await events.nextSession();

    await api.post('/api/dev/sell-out').send({ listingId: LISTING });

    expect(await events.nextSession()).toMatchObject({ status: 'unavailable' });
  });
});

describe('POST /api/dev/payment-behavior', () => {
  it('sets what the next charge does', async () => {
    const { api, create } = setupDev();
    const { id, version } = await create();

    const set = await api.post('/api/dev/payment-behavior').send({ behavior: 'pending' });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ paymentBehavior: 'pending' });
    expect((await api.get('/api/dev/status')).body.paymentBehavior).toBe('pending');

    const paid = await complete(api, id, 'k1', version);
    expect(paid.status).toBe(202);
    expect(paid.body.status).toBe('payment_pending');
  });

  it('a failing behavior declines the charge', async () => {
    const { api, create } = setupDev();
    const { id, version } = await create();
    await api.post('/api/dev/payment-behavior').send({ behavior: 'fail' });

    const paid = await complete(api, id, 'k1', version);

    expect(paid.status).toBe(402);
  });

  it('rejects anything else', async () => {
    const { api } = setupDev();

    for (const body of [{}, { behavior: 'explode' }, { behavior: 1 }]) {
      const res = await api.post('/api/dev/payment-behavior').send(body);
      expect([res.status, res.body.error?.code]).toEqual([400, 'INVALID_REQUEST']);
    }
    expect((await api.get('/api/dev/status')).body.paymentBehavior).toBe('succeed');
  });
});

describe('POST /api/dev/settle/:sessionId', () => {
  async function pending(ctx: ReturnType<typeof setupDev>) {
    await ctx.api.post('/api/dev/payment-behavior').send({ behavior: 'pending' });
    const { id, version } = await ctx.create();
    const res = await complete(ctx.api, id, 'k1', version);
    expect(res.body.status).toBe('payment_pending');
    return id;
  }

  it('settles a pending payment as succeeded', async () => {
    const ctx = setupDev();
    const id = await pending(ctx);

    const res = await ctx.api.post(`/api/dev/settle/${id}`).send({ outcome: 'succeeded' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, status: 'completed', orderId: expect.any(String) });
    expect(await ctx.get(id)).toMatchObject({ status: 'completed' });
  });

  it('settles a pending payment as failed', async () => {
    const ctx = setupDev();
    const id = await pending(ctx);

    const res = await ctx.api.post(`/api/dev/settle/${id}`).send({ outcome: 'failed' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, status: 'payment_failed' });
  });

  it('409s when the session is not payment_pending', async () => {
    const { api, create } = setupDev();
    const { id } = await create();

    const res = await api.post(`/api/dev/settle/${id}`).send({ outcome: 'succeeded' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_PAYMENT_PENDING');
    expect(res.body.session).toMatchObject({ id, status: 'active' });
  });

  it('validates the body and the session', async () => {
    const { api, create } = setupDev();
    const { id } = await create();

    for (const body of [{}, { outcome: 'maybe' }, { outcome: true }]) {
      const res = await api.post(`/api/dev/settle/${id}`).send(body);
      expect([res.status, res.body.error?.code]).toEqual([400, 'INVALID_REQUEST']);
    }
    const missing = await api.post('/api/dev/settle/nope').send({ outcome: 'failed' });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('reaches an open SSE stream', async () => {
    const ctx = setupDev();
    const id = await pending(ctx);
    const events = await stream(ctx.app, id);
    expect(await events.nextSession()).toMatchObject({ status: 'payment_pending' });

    await ctx.api.post(`/api/dev/settle/${id}`).send({ outcome: 'succeeded' });

    expect(await events.nextSession()).toMatchObject({ status: 'completed' });
  });
});

describe('POST /api/dev/reset', () => {
  it('puts everything back to the seed state', async () => {
    const { api, create, get, clock, base, deps } = setupDev();
    const { id } = await create();
    await api.post('/api/dev/payment-behavior').send({ behavior: 'fail' });
    await api.post('/api/dev/price').send({ listingId: LISTING, deltaCents: 700 });
    await api.post('/api/dev/sell-out').send({ listingId: LISTING });
    await api.post(`/api/dev/expire/${id}`);
    expect(clock.offsetMs).toBeGreaterThan(0);

    const res = await api.post('/api/dev/reset');

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect((await api.get(`/api/sessions/${id}`)).status).toBe(404); // sessions gone
    expect(deps.store.list()).toEqual([]);
    expect(clock.offsetMs).toBe(0);
    expect((await api.get('/api/dev/status')).body).toEqual({ enabled: true, paymentBehavior: 'succeed', clockOffsetMs: 0 });
    expect(base.pendingTimerCount).toBe(0); // scheduler tracking cancelled

    // Stock and price are back: a new checkout works at the seed price.
    const fresh = await startSession(api, LISTING);
    expect(fresh.status).toBe(201);
    expect(fresh.body).toMatchObject({ priceSnapshot: 10000, currentPrice: 10000 });
    expect(await get(fresh.body.id)).toMatchObject({ status: 'active' });
    expect(deps.payment.charges).toHaveLength(0);
  });

  it('forgets recorded payment outcomes, so a reused session id and key start clean', async () => {
    const { api, create, deps } = setupDev();
    const { id, version } = await create();
    await complete(api, id, 'k1', version);
    expect(deps.payment.charges).toHaveLength(1);

    await api.post('/api/dev/reset');

    expect(deps.payment.charges).toHaveLength(0);
    expect(await deps.payment.lookup(`${id}:k1`)).toEqual({ status: 'pending' });
  });

  it('stops the expiry scheduler from touching sessions that no longer exist', async () => {
    const { api, create, base } = setupDev();
    await create();
    expect(base.pendingTimerCount).toBe(1);

    await api.post('/api/dev/reset');
    base.advance(TTL_MS * 2); // would have fired the old session's timer

    expect(base.pendingTimerCount).toBe(0);
  });
});
