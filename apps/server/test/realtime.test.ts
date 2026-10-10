import type { CheckoutSession } from '@checkout/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemorySessionStore } from '../src/store';
import { providerKey } from '../src/services/payment';
import { LISTING, TTL_MS, complete, listen, openEvents, setup, waitFor } from './helpers';

const session = (overrides: Partial<CheckoutSession> = {}): CheckoutSession => ({
  id: 's1',
  listingId: LISTING,
  status: 'active',
  priceSnapshot: 10000,
  currentPrice: 10000,
  holdExpiresAt: '2030-01-01T00:10:00.000Z',
  version: 1,
  changes: [],
  ...overrides,
});

describe('SessionStore change notification', () => {
  it('emits a copy of the session on create and on every successful save', () => {
    const store = new InMemorySessionStore();
    const seen: CheckoutSession[] = [];
    store.subscribe('s1', (s) => seen.push(s));

    store.create(session());
    store.save(session({ version: 2, status: 'price_changed' }), 1);

    expect(seen.map((s) => [s.version, s.status])).toEqual([
      [1, 'active'],
      [2, 'price_changed'],
    ]);
    seen[0]!.status = 'completed'; // mutating a delivered copy must not touch the store
    expect(store.get('s1')?.status).toBe('price_changed');
  });

  it('does not emit when the compare-and-set loses', () => {
    const store = new InMemorySessionStore();
    store.create(session());
    const seen: CheckoutSession[] = [];
    store.subscribe('s1', (s) => seen.push(s));

    expect(store.save(session({ version: 3 }), 2)).toBe(false);
    expect(seen).toEqual([]);
  });

  it('only notifies subscribers of that session, and stops after unsubscribe', () => {
    const store = new InMemorySessionStore();
    const mine: number[] = [];
    const others: number[] = [];
    const unsubscribe = store.subscribe('s1', (s) => mine.push(s.version));
    store.subscribe('s2', (s) => others.push(s.version));

    store.create(session());
    unsubscribe();
    store.save(session({ version: 2 }), 1);

    expect(mine).toEqual([1]);
    expect(others).toEqual([]);
    expect(store.listenerCount('s1')).toBe(0);
  });

  it('a throwing subscriber does not fail the write or starve the others', () => {
    const store = new InMemorySessionStore();
    const seen: number[] = [];
    store.subscribe('s1', () => {
      throw new Error('boom');
    });
    store.subscribe('s1', (s) => seen.push(s.version));

    expect(() => store.create(session())).not.toThrow();
    expect(seen).toEqual([1]);
  });
});

describe('expiry scheduler', () => {
  it('expires a session at holdExpiresAt without any request', async () => {
    const { clock, deps, createSession } = setup();
    const { id } = await createSession();
    expect(clock.pendingTimerCount).toBe(1);

    clock.advance(TTL_MS - 1);
    expect(deps.store.get(id)?.status).toBe('active');

    clock.advance(1); // nobody GETs the session; the scheduler must do it
    const expired = await waitFor(() => deps.store.get(id)?.status === 'expired' && deps.store.get(id));
    expect(expired).toMatchObject({ status: 'expired', version: 2 });
    expect(deps.inventory.available(LISTING)).toBe(1);
  });

  it('cancels its timer and subscription once the session is finished', async () => {
    const { api, clock, deps, createSession } = setup();
    const { id, version } = await createSession();

    await complete(api, id, 'k', version);

    expect(clock.pendingTimerCount).toBe(0);
    expect(deps.store.listenerCount(id)).toBe(0);
  });

  it('does not schedule expiry while a payment is pending, and re-arms when it fails', async () => {
    const { api, clock, deps, createSession } = setup({ paymentBehavior: 'pending' });
    const { id, version } = await createSession();
    await complete(api, id, 'k', version);
    expect(clock.pendingTimerCount).toBe(0); // hold is pinned: nothing time-based can happen

    clock.advance(TTL_MS * 2);
    expect(deps.store.get(id)?.status).toBe('payment_pending');

    // The payment fails after the TTL has passed. A read applies the outcome and the change
    // re-arms the scheduler, which then expires the session without another request.
    deps.payment.settle(providerKey(id, 'k'), { status: 'failed', reason: 'card_declined' });
    const res = await api.get(`/api/sessions/${id}`);
    expect(res.body.status).toBe('payment_failed');
    expect(clock.pendingTimerCount).toBe(1);

    clock.advance(0);
    await waitFor(() => deps.store.get(id)?.status === 'expired');
    expect(clock.pendingTimerCount).toBe(0);
  });
});

describe('GET /api/sessions/:id/events (SSE)', () => {
  const closers: Array<() => unknown> = [];
  afterEach(async () => {
    while (closers.length) await closers.pop()!();
  });

  async function connect(options: Parameters<typeof setup>[0] = {}) {
    const ctx = setup(options);
    const server = await listen(ctx.app);
    closers.push(server.close);
    const open = async (id: string) => {
      const events = await openEvents(`${server.url}/api/sessions/${id}/events`);
      closers.push(events.close);
      return events;
    };
    return { ...ctx, open };
  }

  it('sends the current state first, with SSE headers', async () => {
    const { open, createSession } = await connect();
    const { id } = await createSession();

    const events = await open(id);

    expect(events.status).toBe(200);
    expect(events.headers.get('content-type')).toContain('text/event-stream');
    expect(await events.nextSession()).toMatchObject({ id, status: 'active', version: 1 });
  });

  it('streams a change made by another request', async () => {
    const { api, open, createSession } = await connect({ paymentBehavior: 'pending' });
    const { id, version } = await createSession();
    const events = await open(id);
    await events.nextSession();

    await complete(api, id, 'k', version);

    expect(await events.nextSession()).toMatchObject({ status: 'payment_pending', version: 2 });
  });

  it('delivers a scheduler-driven expiry to a subscriber with no request in between', async () => {
    const { clock, deps, open, createSession } = await connect();
    const { id } = await createSession();
    const events = await open(id);
    expect(await events.nextSession()).toMatchObject({ status: 'active' });

    clock.advance(TTL_MS);

    expect(await events.nextSession()).toMatchObject({ id, status: 'expired', version: 2 });
    expect(deps.store.get(id)?.status).toBe('expired');
    // A final status ends the stream.
    expect(await events.next()).toBeNull();
    await waitFor(() => deps.store.listenerCount(id) === 0);
  });

  it('sends heartbeat comments while idle', async () => {
    const { open, createSession } = await connect({ heartbeatMs: 20 });
    const { id } = await createSession();
    const events = await open(id);
    await events.nextSession();

    const frame = await events.next();
    expect(frame).toEqual({ comment: 'heartbeat' });
  });

  it('cleans up its store subscription when the client disconnects', async () => {
    const { deps, open, createSession } = await connect();
    const { id } = await createSession();
    // The scheduler holds one subscription of its own.
    const baseline = deps.store.listenerCount(id);

    const events = await open(id);
    await events.nextSession();
    expect(deps.store.listenerCount(id)).toBe(baseline + 1);

    events.close();
    await waitFor(() => deps.store.listenerCount(id) === baseline);
  });

  it('opens on a finished session with its final state, then closes', async () => {
    const { api, open, createSession } = await connect();
    const { id, version } = await createSession();
    await complete(api, id, 'k', version);

    const events = await open(id);

    expect(await events.nextSession()).toMatchObject({ status: 'completed' });
    expect(await events.next()).toBeNull();
  });

  it('404s for an unknown session', async () => {
    const { api } = await connect();

    const res = await api.get('/api/sessions/nope/events');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
  });
});

describe('GET /api/listings/:id', () => {
  const listing = {
    id: LISTING,
    eventName: 'The Midnight Orchestra',
    venue: 'Harbor Hall',
    date: '2030-06-14T19:30:00-07:00',
    section: 'Orchestra Left',
    row: 'F',
    seats: ['12', '13'],
  };

  it('returns the catalog entry', async () => {
    const { api } = setup({ listings: [listing] });

    const res = await api.get(`/api/listings/${LISTING}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(listing);
  });

  it('404s for an unknown listing', async () => {
    const { api } = setup({ listings: [listing] });

    expect((await api.get('/api/listings/ghost')).status).toBe(404);
  });
});
