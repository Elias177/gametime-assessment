import { randomUUID } from 'node:crypto';
import { transition } from '@checkout/shared';
import type { CheckoutSession, SessionEvent, TransitionError } from '@checkout/shared';
import type { AppDeps } from './deps';
import type { PaymentOutcome } from './services/payment';

export interface ApiResult {
  status: 200 | 201 | 202 | 400 | 402 | 404 | 409 | 500;
  body: object;
}

const apiError = (status: ApiResult['status'], code: string, message: string, session?: CheckoutSession): ApiResult => ({
  status,
  body: { error: { code, message }, ...(session && { session }) },
});

const transitionFailure = (error: TransitionError, session: CheckoutSession): ApiResult =>
  apiError(error.code === 'INVALID_PRICE' ? 500 : 409, error.code, error.message, session);

const conflict = (session: CheckoutSession): ApiResult =>
  apiError(409, 'VERSION_CONFLICT', 'session changed; re-read it and retry', session);

const TERMINAL = new Set<CheckoutSession['status']>(['completed', 'expired', 'unavailable']);

/** Orchestrates the stubbed services around the pure state machine. All time comes from `deps.clock`. */
export class CheckoutService {
  constructor(private readonly deps: AppDeps) {}

  create(listingId: unknown): ApiResult {
    if (typeof listingId !== 'string' || listingId === '') {
      return apiError(400, 'INVALID_REQUEST', 'listingId is required');
    }
    const price = this.deps.pricing.getPrice(listingId);
    if (price === undefined) return apiError(404, 'LISTING_NOT_FOUND', `unknown listing ${listingId}`);

    const id = randomUUID();
    const held = this.deps.inventory.hold(listingId, id, this.deps.holdTtlMs);
    if (!held.ok) {
      return held.reason === 'SOLD_OUT'
        ? apiError(409, 'SOLD_OUT', 'no inventory available for this listing')
        : apiError(404, 'LISTING_NOT_FOUND', `unknown listing ${listingId}`);
    }

    const session: CheckoutSession = {
      id,
      listingId,
      status: 'active',
      priceSnapshot: price,
      currentPrice: price,
      holdExpiresAt: held.hold.expiresAt.toISOString(),
      version: 1,
      changes: [],
    };
    this.deps.store.create(session);
    return { status: 201, body: session };
  }

  /** Resume: re-evaluates expiry, inventory and price before answering. */
  async get(id: string): Promise<ApiResult> {
    const stored = this.deps.store.get(id);
    if (!stored) return this.notFound(id);
    return { status: 200, body: await this.refresh(stored) };
  }

  async acknowledge(id: string, version: unknown): Promise<ApiResult> {
    if (typeof version !== 'number') return apiError(400, 'INVALID_REQUEST', 'version is required');
    const stored = this.deps.store.get(id);
    if (!stored) return this.notFound(id);

    // The buyer may only accept the price they were shown: if re-evaluation moved
    // the session on, their version is stale and they must look again.
    const session = await this.refresh(stored);
    if (session.version !== version) return conflict(session);

    const result = transition(session, { type: 'PRICE_ACKNOWLEDGED' }, this.deps.clock.now());
    if (!result.ok) return transitionFailure(result.error, session);
    if (!this.deps.store.save(result.session, session.version)) return conflict(this.latest(session));
    return { status: 200, body: result.session };
  }

  async complete(id: string, idempotencyKey: unknown): Promise<ApiResult> {
    if (typeof idempotencyKey !== 'string' || idempotencyKey === '') {
      return apiError(400, 'INVALID_REQUEST', 'idempotencyKey is required');
    }
    const stored = this.deps.store.get(id);
    if (!stored) return this.notFound(id);
    const session = await this.refresh(stored);

    if (session.idempotencyKey === idempotencyKey) {
      if (session.status === 'completed') return { status: 200, body: session };
      if (session.status === 'payment_pending') return { status: 202, body: session };
    }

    const started = transition(session, { type: 'PAYMENT_STARTED', idempotencyKey }, this.deps.clock.now());
    if (!started.ok) return transitionFailure(started.error, session);
    if (!this.deps.store.save(started.session, session.version)) return conflict(this.latest(session));

    const outcome = await this.deps.payment.charge({
      sessionId: id,
      amount: started.session.priceSnapshot,
      idempotencyKey,
    });
    const settled = this.applyPayment(started.session, outcome);

    if (outcome.status === 'failed') {
      return apiError(402, 'PAYMENT_FAILED', outcome.reason, settled);
    }
    return { status: settled.status === 'completed' ? 200 : 202, body: settled };
  }

  private notFound(id: string): ApiResult {
    return apiError(404, 'SESSION_NOT_FOUND', `no session ${id}`);
  }

  private latest(fallback: CheckoutSession): CheckoutSession {
    return this.deps.store.get(fallback.id) ?? fallback;
  }

  /** Feed the machine every external fact that may have changed since the session was last touched. */
  private async refresh(session: CheckoutSession): Promise<CheckoutSession> {
    if (TERMINAL.has(session.status)) return session;

    const { clock, inventory, pricing, payment } = this.deps;
    const now = clock.now();
    let current = session;
    const apply = (event: SessionEvent) => {
      const result = transition(current, event, now);
      if (result.ok) current = result.session;
    };

    if (session.status === 'payment_pending') {
      const outcome = session.idempotencyKey ? await payment.lookup(session.idempotencyKey) : { status: 'pending' as const };
      current = this.applyPayment(session, outcome);
    } else if (now.getTime() >= Date.parse(session.holdExpiresAt)) {
      apply({ type: 'HOLD_EXPIRED' });
    } else if (inventory.status(session.id) !== 'held') {
      apply({ type: 'INVENTORY_LOST' });
    } else {
      const price = pricing.getPrice(session.listingId);
      if (price !== undefined && price !== session.currentPrice) apply({ type: 'PRICE_CHANGED', newPrice: price });
    }

    if (current.version === session.version) return session;
    if (current.status === 'expired' || current.status === 'unavailable') inventory.release(session.id);
    return this.deps.store.save(current, session.version) ? current : this.latest(session);
  }

  /**
   * Move a payment_pending session to its payment outcome. For `succeeded` this
   * also consumes the held unit and mints the order id. Persists and returns the
   * stored session (which may be newer than `session` if another request won).
   */
  private applyPayment(session: CheckoutSession, outcome: PaymentOutcome): CheckoutSession {
    if (outcome.status === 'pending') return session;

    const event: SessionEvent =
      outcome.status === 'succeeded'
        ? { type: 'PAYMENT_SUCCEEDED', orderId: randomUUID() }
        : { type: 'PAYMENT_FAILED', reason: outcome.reason };
    const result = transition(session, event, this.deps.clock.now());
    if (!result.ok) return this.latest(session);

    if (!this.deps.store.save(result.session, session.version)) return this.latest(session);
    if (outcome.status === 'succeeded') this.deps.inventory.confirm(session.id);
    return result.session;
  }
}
