import { createAdaptorServer } from '@hono/node-server';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { AnalyticsEvent, AnalyticsEventName, AnalyticsSink } from '../src/analytics';
import { createApp } from '../src/app';
import { ManualClock, OffsetClock } from '../src/clock';
import { createInMemoryDeps } from '../src/deps';
import { providerKey } from '../src/services/payment';
import { LISTING, MINUTE, TTL_MS, asClient, complete, listen, openEvents, setup, startSession } from './helpers';

type Harness = ReturnType<typeof setup>;

const named = <N extends AnalyticsEventName>(deps: Harness['deps'], name: N) =>
  deps.analytics.list().filter((e): e is Extract<AnalyticsEvent, { name: N }> => e.name === name);

const read = (api: Harness['api'], id: string, clientId: string, surface = 'web') =>
  asClient(api.get(`/api/sessions/${id}`), clientId, surface);

const pay = (api: Harness['api'], id: string, key: string, version: number, clientId: string, surface = 'web') =>
  asClient(complete(api, id, key, version), clientId, surface);

const ack = (api: Harness['api'], id: string, version: number, clientId: string, surface = 'web') =>
  asClient(api.post(`/api/sessions/${id}/acknowledge`), clientId, surface).send({ version });

/** Start a session as `laptop` (web). */
async function started(h: Harness) {
  const res = await startSession(h.api, LISTING, 'laptop', 'web');
  expect(res.status).toBe(201);
  return res.body as { id: string; version: number };
}

describe('session_created', () => {
  it('is recorded with the listing, the surface, the clock time and the creating client', async () => {
    const h = setup();
    h.clock.advance(5000);
    const { id } = await started(h);

    expect(h.deps.analytics.list()).toEqual([
      {
        name: 'session_created',
        sessionId: id,
        timestamp: h.clock.now().toISOString(),
        source: 'client',
        clientId: 'laptop',
        surface: 'web',
        props: { listingId: LISTING, surface: 'web' },
      },
    ]);
  });

  it('is not recorded when the create is refused', async () => {
    const h = setup();
    await h.api.post('/api/sessions').send({ listingId: LISTING }); // no client headers
    await startSession(h.api, 'no-such-listing');
    expect(h.deps.analytics.list()).toEqual([]);
  });
});

describe('session_resumed', () => {
  it('counts the first GET per client, with crossDevice and minutes since create', async () => {
    const h = setup();
    const { id } = await started(h);
    h.clock.advance(3 * MINUTE + 3000);

    await read(h.api, id, 'phone', 'mobile');

    expect(named(h.deps, 'session_resumed')).toEqual([
      expect.objectContaining({
        sessionId: id,
        source: 'client',
        clientId: 'phone',
        surface: 'mobile',
        props: { crossDevice: true, minutesSinceCreate: 3.1 },
      }),
    ]);
  });

  it('counts each client once per session, across GET and stream', async () => {
    const h = setup();
    const { id } = await started(h);

    await read(h.api, id, 'phone', 'mobile');
    await read(h.api, id, 'phone', 'mobile');
    const server = await listen(h.app);
    try {
      const stream = await openEvents(`${server.url}/api/sessions/${id}/events?clientId=phone&surface=mobile`);
      await stream.nextSession();
      stream.close();
      const second = await openEvents(`${server.url}/api/sessions/${id}/events?clientId=tablet&surface=web`);
      await second.nextSession();
      second.close();
    } finally {
      await server.close();
    }

    const resumed = named(h.deps, 'session_resumed');
    expect(resumed.map((e) => e.clientId)).toEqual(['phone', 'tablet']);
  });

  it('counts a stream connect as the first resume when it comes before any GET', async () => {
    const h = setup();
    const { id } = await started(h);
    const server = await listen(h.app);
    try {
      const stream = await openEvents(`${server.url}/api/sessions/${id}/events?clientId=phone&surface=mobile`);
      await stream.nextSession();
      stream.close();
    } finally {
      await server.close();
    }
    await read(h.api, id, 'phone', 'mobile');

    expect(named(h.deps, 'session_resumed')).toHaveLength(1);
  });

  it('marks the origin client as not cross-device', async () => {
    const h = setup();
    const { id } = await started(h);

    await read(h.api, id, 'laptop');

    expect(named(h.deps, 'session_resumed')[0]!.props.crossDevice).toBe(false);
  });

  it('skips prefetch reads and reads that name no client', async () => {
    const h = setup();
    const { id } = await started(h);

    await h.api.get(`/api/sessions/${id}`).set('X-Prefetch', '1');
    await asClient(h.api.get(`/api/sessions/${id}`), 'phone', 'mobile').set('X-Prefetch', '1');
    await h.api.get(`/api/sessions/${id}`);

    expect(named(h.deps, 'session_resumed')).toEqual([]);
    // The real visit after the prefetch still counts.
    await read(h.api, id, 'phone', 'mobile');
    expect(named(h.deps, 'session_resumed')).toHaveLength(1);
  });

  it('ignores an unknown session', async () => {
    const h = setup();
    await read(h.api, 'nope', 'phone', 'mobile');
    expect(h.deps.analytics.list()).toEqual([]);
  });
});

describe('price changes', () => {
  it('price_change_shown fires once per client and price, from GET and from an action reply', async () => {
    const h = setup();
    const { id, version } = await started(h);
    h.deps.pricing.setPrice(LISTING, 12500);

    await read(h.api, id, 'laptop');
    await read(h.api, id, 'laptop');
    await read(h.api, id, 'phone', 'mobile');
    // A stale complete is answered with the fresh session: the phone has already seen this price.
    await pay(h.api, id, 'k1', version, 'phone', 'mobile');

    const shown = named(h.deps, 'price_change_shown');
    expect(shown.map((e) => [e.clientId, e.props])).toEqual([
      ['laptop', { from: 10000, to: 12500 }],
      ['phone', { from: 10000, to: 12500 }],
    ]);

    // A further rise is a different price, so it is shown again.
    h.deps.pricing.setPrice(LISTING, 13000);
    await read(h.api, id, 'laptop');
    expect(named(h.deps, 'price_change_shown').at(-1)).toMatchObject({
      clientId: 'laptop',
      props: { from: 10000, to: 13000 },
    });
  });

  it('price_change_shown also fires when the reply to an action is the first sight of the price', async () => {
    const h = setup();
    const { id, version } = await started(h);
    h.deps.pricing.setPrice(LISTING, 12500);

    const stale = await pay(h.api, id, 'k1', version, 'phone', 'mobile');

    expect(stale.status).toBe(409);
    expect(named(h.deps, 'price_change_shown')).toHaveLength(1);
    expect(named(h.deps, 'price_change_shown')[0]).toMatchObject({ clientId: 'phone', surface: 'mobile' });
  });

  it('price_change_shown fires for a stream: initial state, and a change pushed later', async () => {
    const h = setup({ stock: { [LISTING]: 2 } });
    const { id } = await started(h);
    const server = await listen(h.app);
    try {
      const stream = await openEvents(`${server.url}/api/sessions/${id}/events?clientId=phone&surface=mobile`);
      expect((await stream.nextSession())!.status).toBe('active');
      expect(named(h.deps, 'price_change_shown')).toEqual([]);

      h.deps.pricing.setPrice(LISTING, 12500);
      await h.app.request(`/api/sessions/${id}`, { headers: { 'X-Client-Id': 'laptop', 'X-Surface': 'web' } });
      expect((await stream.nextSession())!.status).toBe('price_changed');
      stream.close();
    } finally {
      await server.close();
    }

    expect(named(h.deps, 'price_change_shown').map((e) => e.clientId).sort()).toEqual(['laptop', 'phone']);
  });

  it('is not shown for a prefetch read', async () => {
    const h = setup();
    const { id } = await started(h);
    h.deps.pricing.setPrice(LISTING, 12500);

    await asClient(h.api.get(`/api/sessions/${id}`), 'phone', 'mobile').set('X-Prefetch', '1');

    expect(named(h.deps, 'price_change_shown')).toEqual([]);
  });

  it('price_change_accepted records the accepted price once, and nothing for a stale or illegal acknowledge', async () => {
    const h = setup();
    const { id } = await started(h);
    h.deps.pricing.setPrice(LISTING, 12500);
    const seen = (await read(h.api, id, 'phone', 'mobile')).body as { version: number };

    expect((await ack(h.api, id, seen.version - 1, 'phone', 'mobile')).status).toBe(409);
    expect((await ack(h.api, id, seen.version, 'phone', 'mobile')).status).toBe(200);
    expect((await ack(h.api, id, seen.version + 1, 'phone', 'mobile')).status).toBe(409); // already active

    expect(named(h.deps, 'price_change_accepted')).toEqual([
      expect.objectContaining({ clientId: 'phone', surface: 'mobile', props: { from: 10000, to: 12500 } }),
    ]);
  });

  it('price_change_auto_applied records a decrease applied by a re-evaluation', async () => {
    const h = setup();
    const { id } = await started(h);
    h.deps.pricing.setPrice(LISTING, 9000);

    const res = await read(h.api, id, 'laptop');
    await read(h.api, id, 'laptop'); // nothing left to apply

    expect(res.body.status).toBe('active');
    expect(named(h.deps, 'price_change_auto_applied')).toEqual([
      expect.objectContaining({ source: 'client', clientId: 'laptop', props: { from: 10000, to: 9000 } }),
    ]);
    expect(named(h.deps, 'price_change_shown')).toEqual([]);
  });
});

describe('hold_expired and inventory_lost', () => {
  it('hold_expired has source "client" when a client read caused it', async () => {
    const never = new ManualClock(); // timers that the clock jump cannot fire, like real ones
    const h = setup({ timers: never });
    const { id } = await started(h);
    h.clock.advance(TTL_MS + 1);

    const res = await read(h.api, id, 'phone', 'mobile');
    await read(h.api, id, 'phone', 'mobile');

    expect(res.body.status).toBe('expired');
    expect(named(h.deps, 'hold_expired')).toEqual([
      expect.objectContaining({
        sessionId: id,
        source: 'client',
        clientId: 'phone',
        surface: 'mobile',
        props: { source: 'client' },
      }),
    ]);
  });

  it('hold_expired has source "system" when the scheduler caused it', async () => {
    const h = setup(); // the app's scheduler runs on the manual clock
    const { id } = await started(h);

    h.clock.advance(TTL_MS + 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const expired = named(h.deps, 'hold_expired');
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ sessionId: id, source: 'system', props: { source: 'system' } });
    expect(expired[0]!.clientId).toBeUndefined();
    expect(expired[0]!.surface).toBeUndefined();
  });

  it('hold_expired is "system" for a read that names no client or is a prefetch', async () => {
    const never = new ManualClock();
    const h = setup({ timers: never });
    const { id } = await started(h);
    h.clock.advance(TTL_MS + 1);

    await asClient(h.api.get(`/api/sessions/${id}`), 'phone', 'mobile').set('X-Prefetch', '1');

    expect(named(h.deps, 'hold_expired')).toEqual([expect.objectContaining({ source: 'system' })]);
  });

  it('inventory_lost records the source, client or system', async () => {
    const never = new ManualClock();
    const h = setup({ timers: never, stock: { [LISTING]: 2 } });
    const a = await started(h);
    const b = (await startSession(h.api, LISTING, 'laptop', 'web')).body as { id: string };
    h.deps.inventory.revokeStock(LISTING);

    await read(h.api, a.id, 'phone', 'mobile');
    await h.api.get(`/api/sessions/${b.id}`); // no client

    const lost = named(h.deps, 'inventory_lost');
    expect(lost.map((e) => [e.sessionId, e.source, e.props.source])).toEqual([
      [a.id, 'client', 'client'],
      [b.id, 'system', 'system'],
    ]);
  });
});

describe('payment events', () => {
  it('payment_failed records the reason and who paid', async () => {
    const h = setup({ paymentBehavior: 'fail' });
    const { id, version } = await started(h);

    const res = await pay(h.api, id, 'k1', version, 'phone', 'mobile');

    expect(res.status).toBe(402);
    expect(named(h.deps, 'payment_failed')).toEqual([
      expect.objectContaining({ sessionId: id, clientId: 'phone', surface: 'mobile', props: { reason: 'card_declined' } }),
    ]);
    expect(named(h.deps, 'completed')).toEqual([]);
  });

  it('payment_failed from a pending payment settled by the system has source "system"', async () => {
    const h = setup({ paymentBehavior: 'pending' });
    const { id, version } = await started(h);
    await pay(h.api, id, 'k1', version, 'phone', 'mobile');

    h.deps.payment.settle(providerKey(id, 'k1'), { status: 'failed', reason: 'card_declined' });
    await h.app.request(`/api/sessions/${id}`); // no client

    expect(named(h.deps, 'payment_failed')).toEqual([expect.objectContaining({ source: 'system' })]);
  });

  it('completed.crossDevice is false when only the origin client was involved', async () => {
    const h = setup();
    const { id, version } = await started(h);
    await read(h.api, id, 'laptop');

    const res = await pay(h.api, id, 'k1', version, 'laptop');
    await pay(h.api, id, 'k1', version, 'laptop'); // replay

    expect(res.status).toBe(200);
    expect(named(h.deps, 'completed')).toEqual([
      expect.objectContaining({
        sessionId: id,
        clientId: 'laptop',
        surface: 'web',
        props: { crossDevice: false, paidOnSurface: 'web' },
      }),
    ]);
  });

  it('completed.crossDevice is true when another client resumed the session first, wherever it paid', async () => {
    const h = setup();
    const { id, version } = await started(h);
    await read(h.api, id, 'phone', 'mobile');

    await pay(h.api, id, 'k1', version, 'laptop');

    expect(named(h.deps, 'completed')[0]!.props).toEqual({ crossDevice: true, paidOnSurface: 'web' });
  });

  it('completed.crossDevice is true for a purchase made on the phone that resumed', async () => {
    const h = setup();
    const { id, version } = await started(h);
    await read(h.api, id, 'phone', 'mobile');

    await pay(h.api, id, 'k1', version, 'phone', 'mobile');

    expect(named(h.deps, 'completed')[0]).toMatchObject({
      clientId: 'phone',
      surface: 'mobile',
      props: { crossDevice: true, paidOnSurface: 'mobile' },
    });
  });

  it('completed.crossDevice stays false when a client only prefetched the session', async () => {
    const h = setup();
    const { id, version } = await started(h);
    await h.api.get(`/api/sessions/${id}`).set('X-Prefetch', '1');

    await pay(h.api, id, 'k1', version, 'laptop');

    expect(named(h.deps, 'completed')[0]!.props.crossDevice).toBe(false);
  });

  it('records one completed for two racing payments', async () => {
    const h = setup();
    const { id, version } = await started(h);

    await Promise.all([
      pay(h.api, id, 'k1', version, 'laptop'),
      pay(h.api, id, 'k2', version, 'phone', 'mobile'),
    ]);

    expect(named(h.deps, 'completed')).toHaveLength(1);
    expect(named(h.deps, 'completion_conflict').length).toBeLessThanOrEqual(1);
  });

  it('a pending payment settled later records completed with the surface that paid', async () => {
    const h = setup({ paymentBehavior: 'pending' });
    const { id, version } = await started(h);
    await read(h.api, id, 'phone', 'mobile');
    await pay(h.api, id, 'k1', version, 'phone', 'mobile');
    expect(named(h.deps, 'completed')).toEqual([]);

    h.deps.payment.settle(providerKey(id, 'k1'), { status: 'succeeded' });
    await h.app.request(`/api/sessions/${id}`);

    expect(named(h.deps, 'completed')).toEqual([
      expect.objectContaining({ source: 'system', props: { crossDevice: true, paidOnSurface: 'mobile' } }),
    ]);
  });
});

describe('completion_conflict', () => {
  it('records VERSION_CONFLICT for a stale version', async () => {
    const h = setup();
    const { id, version } = await started(h);
    h.deps.pricing.setPrice(LISTING, 9000); // a read moves the session on
    await read(h.api, id, 'laptop');

    const res = await pay(h.api, id, 'k1', version, 'phone', 'mobile');

    expect(res.body.error.code).toBe('VERSION_CONFLICT');
    expect(named(h.deps, 'completion_conflict')).toEqual([
      expect.objectContaining({ clientId: 'phone', surface: 'mobile', props: { code: 'VERSION_CONFLICT' } }),
    ]);
  });

  it('records PAYMENT_IN_PROGRESS for a different key while a payment is pending', async () => {
    const h = setup({ paymentBehavior: 'pending' });
    const { id, version } = await started(h);
    await pay(h.api, id, 'k1', version, 'laptop');

    const res = await pay(h.api, id, 'k2', version + 1, 'phone', 'mobile');

    expect(res.body.error.code).toBe('PAYMENT_IN_PROGRESS');
    expect(named(h.deps, 'completion_conflict')).toEqual([
      expect.objectContaining({ clientId: 'phone', props: { code: 'PAYMENT_IN_PROGRESS' } }),
    ]);
  });

  it('records COMPLETED_ELSEWHERE when the sale was made under another key, but not for a replay', async () => {
    const h = setup();
    const { id, version } = await started(h);
    await pay(h.api, id, 'k1', version, 'laptop');
    await pay(h.api, id, 'k1', version, 'laptop'); // replay of the winner: not a conflict
    expect(named(h.deps, 'completion_conflict')).toEqual([]);

    const res = await pay(h.api, id, 'k2', version, 'phone', 'mobile');

    expect(res.body.completedElsewhere).toBe(true);
    expect(named(h.deps, 'completion_conflict')).toEqual([
      expect.objectContaining({ clientId: 'phone', props: { code: 'COMPLETED_ELSEWHERE' } }),
    ]);
  });

  it('does not count conflicts from other routes', async () => {
    const h = setup();
    const { id } = await started(h);
    await ack(h.api, id, 99, 'phone', 'mobile'); // VERSION_CONFLICT on /acknowledge
    expect(named(h.deps, 'completion_conflict')).toEqual([]);
  });
});

describe('a failing sink', () => {
  it('never fails a request, whether it throws or rejects', async () => {
    for (const track of [
      () => {
        throw new Error('sink down');
      },
      () => Promise.reject(new Error('sink down')),
    ]) {
      const h = setup();
      (h.deps as { analytics: AnalyticsSink }).analytics = { track };
      const created = await startSession(h.api, LISTING, 'laptop', 'web');
      expect(created.status).toBe(201);
      const id = created.body.id as string;

      expect((await read(h.api, id, 'phone', 'mobile')).status).toBe(200);
      h.deps.pricing.setPrice(LISTING, 12500);
      expect((await read(h.api, id, 'phone', 'mobile')).status).toBe(200);
      const done = await pay(h.api, id, 'k1', 1, 'phone', 'mobile');
      expect(done.status).toBe(409); // stale: the price change moved the version, not the sink
      const fresh = (await read(h.api, id, 'phone', 'mobile')).body as { version: number };
      expect((await ack(h.api, id, fresh.version, 'phone', 'mobile')).status).toBe(200);
      const ok = await pay(h.api, id, 'k2', fresh.version + 1, 'phone', 'mobile');
      expect(ok.status).toBe(200);
      expect(ok.body.status).toBe('completed');
    }
  });
});

describe('dev endpoints', () => {
  function setupDev() {
    const base = new ManualClock();
    const clock = new OffsetClock(base);
    const deps = createInMemoryDeps({
      clock,
      timers: base,
      stock: { [LISTING]: 3 },
      prices: { [LISTING]: 10000 },
      holdTtlMs: TTL_MS,
    });
    const app = createApp(deps, { devTools: { deps, clock } });
    return { deps, app, api: request(createAdaptorServer({ fetch: app.fetch })) };
  }
  const open: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (open.length) await open.pop()!();
  });

  it('GET /api/dev/events returns the events and the metric', async () => {
    const { api } = setupDev();
    const created = await startSession(api, LISTING, 'laptop', 'web');
    const id = created.body.id as string;
    await read(api, id, 'phone', 'mobile');
    await pay(api, id, 'k1', 1, 'phone', 'mobile');

    const res = await api.get('/api/dev/events');

    expect(res.status).toBe(200);
    expect(res.body.events.map((e: AnalyticsEvent) => e.name)).toEqual(['session_created', 'session_resumed', 'completed']);
    expect(res.body.metric.crossDevice).toMatchObject({ sessions: 1, completed: 1, conversionRate: 1 });
    expect(res.body.metric.singleDevice).toMatchObject({ sessions: 0, completed: 0, conversionRate: null });
  });

  it('is a plain 404 when dev tools are off', async () => {
    const h = setup();
    expect((await h.api.get('/api/dev/events')).status).toBe(404);
  });

  it('dev expire is a system event, and reset clears the events and what the service remembered', async () => {
    const { api, deps } = setupDev();
    const id = (await startSession(api, LISTING, 'laptop', 'web')).body.id as string;
    await api.post(`/api/dev/expire/${id}`);
    expect(deps.analytics.list().find((e) => e.name === 'hold_expired')).toMatchObject({ source: 'system' });

    expect((await api.post('/api/dev/reset')).status).toBe(204);
    expect(deps.analytics.list()).toEqual([]);
    expect((await api.get('/api/dev/events')).body).toMatchObject({ events: [] });
  });
});
