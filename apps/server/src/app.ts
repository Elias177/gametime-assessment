import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { isTerminalStatus } from '@checkout/shared';
import type { CheckoutSession, HealthResponse } from '@checkout/shared';
import { CheckoutService } from './checkout-service';
import type { ApiResult } from './checkout-service';
import { createInMemoryDeps } from './deps';
import type { AppDeps } from './deps';
import { ExpiryScheduler } from './scheduler';

export function createApp(deps: AppDeps = createInMemoryDeps()) {
  const app = new Hono();
  // The service's onCreated hook needs the scheduler, and the scheduler needs the service.
  let scheduler: ExpiryScheduler;
  const checkout = new CheckoutService(deps, { onCreated: (session) => scheduler.track(session) });
  scheduler = new ExpiryScheduler(deps, (id) => checkout.refreshById(id));

  app.get('/api/health', (c) => {
    const body: HealthResponse = { status: 'ok', time: deps.clock.now().toISOString() };
    return c.json(body);
  });

  const readJson = async (req: Request): Promise<Record<string, unknown>> => {
    const body: unknown = await req.json().catch(() => undefined);
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  };

  const respond = (c: { json: (body: object, status: ApiResult['status']) => Response }, { status, body }: ApiResult) =>
    c.json(body, status);

  app.get('/api/listings/:id', (c) => {
    const listing = deps.listings.get(c.req.param('id'));
    if (!listing) return c.json({ error: { code: 'LISTING_NOT_FOUND', message: 'unknown listing' } }, 404);
    return c.json(listing);
  });

  app.post('/api/sessions', async (c) => {
    const body = await readJson(c.req.raw);
    return respond(c, checkout.create(body.listingId));
  });

  app.get('/api/sessions/:id', async (c) => respond(c, await checkout.get(c.req.param('id'))));

  /**
   * Server-sent events: the current (re-evaluated) session first, then every change to it,
   * with a heartbeat comment so idle connections and proxies stay open. The stream ends when
   * the client goes away or the session reaches a final status.
   */
  app.get('/api/sessions/:id/events', async (c) => {
    const id = c.req.param('id');
    const initial = await checkout.refreshById(id);
    if (!initial) return c.json({ error: { code: 'SESSION_NOT_FOUND', message: `no session ${id}` } }, 404);

    return streamSSE(c, async (stream) => {
      let lastVersion = -1;
      let write: Promise<unknown> = Promise.resolve();
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => (finish = resolve));

      // Writes are chained so events go out in order; failures (client already gone) are ignored.
      const enqueue = (task: () => Promise<unknown>) => {
        write = write.then(task).catch(() => undefined);
      };
      const send = (session: CheckoutSession) => {
        if (session.version <= lastVersion) return; // already sent (initial state vs. early change)
        lastVersion = session.version;
        enqueue(() => stream.writeSSE({ event: 'session', id: String(session.version), data: JSON.stringify(session) }));
        if (isTerminalStatus(session.status)) enqueue(async () => finish());
      };

      // Subscribe before sending the initial state so a change in between is not lost.
      const unsubscribe = deps.store.subscribe(id, send);
      stream.onAbort(() => {
        unsubscribe();
        finish();
      });
      send(initial);

      try {
        for (;;) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const heartbeat = new Promise<'beat'>((resolve) => {
            timer = setTimeout(() => resolve('beat'), deps.heartbeatMs);
          });
          const outcome = await Promise.race([heartbeat, finished.then(() => 'done' as const)]);
          clearTimeout(timer);
          if (outcome === 'done') break;
          enqueue(() => stream.write(': heartbeat\n\n'));
        }
        await write;
      } finally {
        unsubscribe();
      }
    });
  });

  app.post('/api/sessions/:id/acknowledge', async (c) => {
    const body = await readJson(c.req.raw);
    return respond(c, await checkout.acknowledge(c.req.param('id'), body.version));
  });

  app.post('/api/sessions/:id/complete', async (c) => {
    const body = await readJson(c.req.raw);
    return respond(c, await checkout.complete(c.req.param('id'), c.req.header('Idempotency-Key'), body.version));
  });

  return app;
}
