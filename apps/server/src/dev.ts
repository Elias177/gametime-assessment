import { Hono } from 'hono';
import type { PaymentBehavior } from './services/payment';
import { providerKey } from './services/payment';
import { apiError } from './checkout-service';
import type { ApiResult, CheckoutService } from './checkout-service';
import type { OffsetClock } from './clock';
import type { InMemoryDeps } from './deps';
import type { ExpiryScheduler } from './scheduler';

export const PAYMENT_BEHAVIORS: readonly PaymentBehavior[] = ['succeed', 'fail', 'pending'];

export interface DevToolsOptions {
  deps: InMemoryDeps;
  clock: OffsetClock;
}

const invalid = (message: string) => apiError(400, 'INVALID_REQUEST', message);
const sessionNotFound = (id: string) => apiError(404, 'SESSION_NOT_FOUND', `no session ${id}`);
const listingNotFound = (id: string) => apiError(404, 'LISTING_NOT_FOUND', `unknown listing ${id}`);

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const body: unknown = await req.json().catch(() => undefined);
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

/**
 * Demo controls for forcing the situations that are hard to hit by hand: a lapsed hold, a price
 * move, a sell-out, a slow or failing payment. Only ever mounted when `DEV_TOOLS=1`. Everything
 * here changes the stubs, then re-evaluates live sessions so open streams see the effect.
 */
export function createDevRouter(
  { deps, clock }: DevToolsOptions,
  checkout: CheckoutService,
  scheduler: ExpiryScheduler,
) {
  const dev = new Hono();
  const send = (c: { json: (body: object, status: ApiResult['status']) => Response }, r: ApiResult) =>
    c.json(r.body, r.status);

  dev.get('/status', (c) =>
    c.json({ enabled: true, paymentBehavior: deps.payment.getBehavior(), clockOffsetMs: clock.offsetMs }),
  );

  // The scheduler's timers are real, so a clock jump never fires them: refresh every live
  // session ourselves after any change that depends on time.
  dev.post('/expire/:sessionId', async (c) => {
    const id = c.req.param('sessionId');
    const session = deps.store.get(id);
    if (!session) return send(c, sessionNotFound(id));

    const msUntilExpiry = Date.parse(session.holdExpiresAt) - clock.now().getTime();
    if (msUntilExpiry >= 0) clock.advance(msUntilExpiry + 1);
    await checkout.refreshLive();
    return c.json(deps.store.get(id) ?? session);
  });

  dev.post('/price', async (c) => {
    const { listingId, deltaCents } = await readJson(c.req.raw);
    if (typeof listingId !== 'string' || listingId === '') return send(c, invalid('listingId is required'));
    if (typeof deltaCents !== 'number' || !Number.isInteger(deltaCents)) {
      return send(c, invalid('deltaCents must be an integer'));
    }
    const current = deps.pricing.getPrice(listingId);
    if (current === undefined) return send(c, listingNotFound(listingId));

    const price = Math.max(0, current + deltaCents);
    deps.pricing.setPrice(listingId, price);
    await checkout.refreshLive(listingId);
    return c.json({ listingId, price });
  });

  dev.post('/sell-out', async (c) => {
    const { listingId } = await readJson(c.req.raw);
    if (typeof listingId !== 'string' || listingId === '') return send(c, invalid('listingId is required'));
    if (deps.pricing.getPrice(listingId) === undefined) return send(c, listingNotFound(listingId));

    deps.inventory.revokeStock(listingId);
    await checkout.refreshLive(listingId);
    return c.json({ listingId });
  });

  dev.post('/payment-behavior', async (c) => {
    const { behavior } = await readJson(c.req.raw);
    if (!PAYMENT_BEHAVIORS.includes(behavior as PaymentBehavior)) {
      return send(c, invalid(`behavior must be one of ${PAYMENT_BEHAVIORS.join(', ')}`));
    }
    deps.payment.setBehavior(behavior as PaymentBehavior);
    return c.json({ paymentBehavior: deps.payment.getBehavior() });
  });

  dev.post('/settle/:sessionId', async (c) => {
    const id = c.req.param('sessionId');
    const { outcome } = await readJson(c.req.raw);
    if (outcome !== 'succeeded' && outcome !== 'failed') {
      return send(c, invalid('outcome must be succeeded or failed'));
    }
    const session = deps.store.get(id);
    if (!session) return send(c, sessionNotFound(id));
    if (session.status !== 'payment_pending' || !session.idempotencyKey) {
      return send(c, apiError(409, 'NOT_PAYMENT_PENDING', `session is ${session.status}, not payment_pending`, session));
    }

    deps.payment.settle(
      providerKey(id, session.idempotencyKey),
      outcome === 'succeeded' ? { status: 'succeeded' } : { status: 'failed', reason: 'card_declined' },
    );
    return c.json((await checkout.refreshById(id)) ?? session);
  });

  dev.post('/reset', (c) => {
    scheduler.clear(); // first, so clearing the store can't wake it
    deps.store.clear();
    deps.inventory.reset();
    deps.pricing.reset();
    deps.payment.reset();
    clock.reset();
    return c.body(null, 204);
  });

  return dev;
}
