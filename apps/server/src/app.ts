import { Hono } from 'hono';
import type { HealthResponse } from '@checkout/shared';
import { CheckoutService } from './checkout-service';
import type { ApiResult } from './checkout-service';
import { createInMemoryDeps } from './deps';
import type { AppDeps } from './deps';

export function createApp(deps: AppDeps = createInMemoryDeps()) {
  const app = new Hono();
  const checkout = new CheckoutService(deps);

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

  app.post('/api/sessions', async (c) => {
    const body = await readJson(c.req.raw);
    return respond(c, checkout.create(body.listingId));
  });

  app.get('/api/sessions/:id', async (c) => respond(c, await checkout.get(c.req.param('id'))));

  app.post('/api/sessions/:id/acknowledge', async (c) => {
    const body = await readJson(c.req.raw);
    return respond(c, await checkout.acknowledge(c.req.param('id'), body.version));
  });

  app.post('/api/sessions/:id/complete', async (c) => {
    const body = await readJson(c.req.raw);
    const key = c.req.header('Idempotency-Key') ?? body.idempotencyKey;
    return respond(c, await checkout.complete(c.req.param('id'), key));
  });

  return app;
}
