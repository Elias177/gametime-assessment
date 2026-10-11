import { randomUUID } from 'node:crypto';
import { isTerminalStatus, transition } from '@checkout/shared';
import type { CheckoutSession, SessionEvent, Surface, TransitionError } from '@checkout/shared';
import { safeTrack } from './analytics';
import type { AnalyticsEvent, AnalyticsEventName, AnalyticsEventProps, EventSource } from './analytics';
import type { AppDeps } from './deps';
import { providerKey } from './services/payment';
import type { PaymentOutcome } from './services/payment';

export interface ApiResult {
  status: 200 | 201 | 202 | 400 | 402 | 404 | 409 | 500;
  body: object;
}

export const apiError = (status: ApiResult['status'], code: string, message: string, session?: CheckoutSession): ApiResult => ({
  status,
  body: { error: { code, message }, ...(session && { session }) },
});

const transitionFailure = (error: TransitionError, session: CheckoutSession): ApiResult =>
  apiError(error.code === 'INVALID_PRICE' ? 500 : 409, error.code, error.message, session);

const conflict = (session: CheckoutSession): ApiResult =>
  apiError(409, 'VERSION_CONFLICT', 'session changed; re-read it and retry', session);

/** Who made a request, from `X-Client-Id` / `X-Surface` (SSE: query params). Absent when the caller sent nothing usable. */
export interface ClientContext {
  clientId?: string;
  surface?: Surface;
  /**
   * True for the page pre-render's `X-Prefetch: 1` read of a session. It is the server asking on a
   * fan's behalf, not a client, so analytics should not count it as a visit. Only `GET /api/sessions/:id`
   * accepts it.
   */
  prefetch?: true;
}

export type RequestAction = 'create' | 'get' | 'stream' | 'acknowledge' | 'complete';

export interface ServiceHooks {
  onCreated?: (session: CheckoutSession) => void;
  /** Every API request with its client. The service itself uses it to count `session_resumed`. */
  onRequest?: (request: { action: RequestAction; sessionId?: string; client: ClientContext }) => void;
}

/** What analytics needs to remember about a session between requests. */
interface SessionTracking {
  /** Clients that have already counted as resuming (GET or stream). */
  resumedBy: Set<string>;
  /** Some client other than the origin has resumed the session. */
  crossDevice: boolean;
  /** Price changes already shown, per client (`clientId|from|to`). */
  shown: Set<string>;
  /** The client whose request started the latest payment. */
  payer?: ClientContext;
}

/** A client caused this only if it identified itself; a prefetch is the server reading for a fan. */
const actingClient = (cause: ClientContext | undefined): ClientContext | undefined =>
  cause?.clientId !== undefined && !cause.prefetch ? cause : undefined;

const sourceOf = (cause: ClientContext | undefined): EventSource => (actingClient(cause) ? 'client' : 'system');

const sessionIn = (body: object): CheckoutSession | undefined => {
  const candidate: unknown = 'session' in body ? body.session : body;
  return typeof candidate === 'object' && candidate !== null && 'status' in candidate && 'priceSnapshot' in candidate
    ? (candidate as CheckoutSession)
    : undefined;
};

/** Orchestrates the stubbed services around the pure state machine. All time comes from `deps.clock`. */
export class CheckoutService {
  private readonly tracking = new Map<string, SessionTracking>();

  constructor(
    private readonly deps: AppDeps,
    private readonly hooks: ServiceHooks = {},
  ) {}

  create(listingId: unknown, client: ClientContext): ApiResult {
    if (typeof listingId !== 'string' || listingId === '') {
      return apiError(400, 'INVALID_REQUEST', 'listingId is required');
    }
    // The origin is stored on the session, so unlike other calls a create must say who it is.
    if (client.clientId === undefined) return apiError(400, 'INVALID_REQUEST', 'X-Client-Id header is required');
    if (client.surface === undefined) return apiError(400, 'INVALID_REQUEST', 'X-Surface header must be web or mobile');
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
      createdAt: this.deps.clock.now().toISOString(),
      originClientId: client.clientId,
      originSurface: client.surface,
      status: 'active',
      priceSnapshot: price,
      currentPrice: price,
      holdExpiresAt: held.hold.expiresAt.toISOString(),
      version: 1,
      changes: [],
    };
    this.deps.store.create(session);
    this.hooks.onCreated?.(session);
    this.hooks.onRequest?.({ action: 'create', sessionId: id, client });
    this.emit('session_created', id, { listingId, surface: client.surface }, client);
    return { status: 201, body: session };
  }

  /** Re-evaluate a session and persist any change (which notifies store subscribers). */
  async refreshById(id: string, cause?: ClientContext): Promise<CheckoutSession | undefined> {
    const stored = this.deps.store.get(id);
    return stored && this.refresh(stored, cause);
  }

  /** Forget what analytics remembered about sessions (dev reset, which also empties the store). */
  resetTracking(): void {
    this.tracking.clear();
  }

  /**
   * Re-evaluate every session that can still change, optionally only those on one listing, and
   * persist (and so announce) whatever changed. Used after something moved outside the request
   * path, such as a clock jump, when the scheduler's real timers can't be trusted.
   */
  async refreshLive(listingId?: string): Promise<void> {
    const live = this.deps.store
      .list()
      .filter((s) => !isTerminalStatus(s.status) && (listingId === undefined || s.listingId === listingId));
    await Promise.all(live.map((s) => this.refreshById(s.id)));
  }

  /** A client opens the live stream: the current state, re-evaluated. */
  async open(id: string, client: ClientContext): Promise<CheckoutSession | undefined> {
    this.request({ action: 'stream', sessionId: id, client });
    return this.refreshById(id, client);
  }

  /** The client was just handed this session (a stream frame): note a price change it has not seen yet. */
  noteDelivered(session: CheckoutSession, client: ClientContext): void {
    const who = actingClient(client);
    if (!who || session.status !== 'price_changed') return;
    const shown = this.trackingFor(session.id).shown;
    const key = `${who.clientId}|${session.priceSnapshot}|${session.currentPrice}`;
    if (shown.has(key)) return;
    shown.add(key);
    this.emit('price_change_shown', session.id, { from: session.priceSnapshot, to: session.currentPrice }, who);
  }

  /** Resume: re-evaluates expiry, inventory and price before answering. */
  async get(id: string, client: ClientContext): Promise<ApiResult> {
    this.request({ action: 'get', sessionId: id, client });
    const stored = this.deps.store.get(id);
    if (!stored) return this.notFound(id);
    const session = await this.refresh(stored, client);
    this.noteDelivered(session, client);
    return { status: 200, body: session };
  }

  async acknowledge(id: string, version: unknown, client: ClientContext): Promise<ApiResult> {
    this.request({ action: 'acknowledge', sessionId: id, client });
    const result = await this.acknowledgeInner(id, version, client);
    this.noteReply(result, client);
    return result;
  }

  private async acknowledgeInner(id: string, version: unknown, client: ClientContext): Promise<ApiResult> {
    if (typeof version !== 'number') return apiError(400, 'INVALID_REQUEST', 'version is required');
    const stored = this.deps.store.get(id);
    if (!stored) return this.notFound(id);

    // The buyer may only accept the price they were shown: if re-evaluation moved
    // the session on, their version is stale and they must look again.
    const session = await this.refresh(stored, client);
    if (session.version !== version) return conflict(session);

    const result = transition(session, { type: 'PRICE_ACKNOWLEDGED' }, this.deps.clock.now());
    if (!result.ok) return transitionFailure(result.error, session);
    if (!this.deps.store.save(result.session, session.version)) return conflict(this.latest(session));
    this.emit('price_change_accepted', id, { from: session.priceSnapshot, to: session.currentPrice }, client);
    return { status: 200, body: result.session };
  }

  /**
   * Why `/complete` needs BOTH an idempotency key and a session version:
   *
   * - The idempotency key means "this is the same request again" (timeout retry,
   *   double click). Version alone cannot serve that: once the first attempt
   *   succeeds the session has moved on, so the retry's version is stale and
   *   would be rejected instead of being handed its order back.
   *
   * - The version means "this request was made from an out-of-date view" (the
   *   buyer's phone and laptop, each with its own key). The key cannot catch
   *   that: two different keys look like two legitimate payments. Checking the
   *   version against our local copy is not enough either, because both
   *   requests can read version N before either one saves (time-of-check vs
   *   time-of-use). The real guard is the store's compare-and-set on `save`,
   *   which lets exactly one of them move the session off version N; the
   *   explicit check just rejects obviously stale clients early, with the fresh
   *   session attached.
   *
   * Result: same key -> same order; different key racing -> one wins, the other
   * is told the sale already happened (or to re-read), and the card is charged once.
   */
  async complete(id: string, idempotencyKey: unknown, version: unknown, client: ClientContext): Promise<ApiResult> {
    this.request({ action: 'complete', sessionId: id, client });
    const result = await this.completeInner(id, idempotencyKey, version, client);
    this.noteReply(result, client);
    this.noteCompletionConflict(id, result, client);
    return result;
  }

  private async completeInner(
    id: string,
    idempotencyKey: unknown,
    version: unknown,
    client: ClientContext,
  ): Promise<ApiResult> {
    if (typeof idempotencyKey !== 'string' || idempotencyKey === '') {
      return apiError(400, 'INVALID_REQUEST', 'Idempotency-Key header is required');
    }
    if (!Number.isInteger(version)) return apiError(400, 'INVALID_REQUEST', 'version must be an integer');
    const stored = this.deps.store.get(id);
    if (!stored) return this.notFound(id);
    const session = await this.refresh(stored, client);

    // Before the version check: a retry after success carries a stale version by definition.
    const existing = await this.existingOutcome(session, idempotencyKey);
    if (existing) return existing;

    if (session.version !== version) return conflict(session);

    const started = transition(session, { type: 'PAYMENT_STARTED', idempotencyKey }, this.deps.clock.now());
    if (!started.ok) return transitionFailure(started.error, session);
    if (!this.deps.store.save(started.session, session.version)) {
      // Lost the race. If the winner is the same request (or already finished the sale), answer from that.
      const latest = this.latest(session);
      return (await this.existingOutcome(latest, idempotencyKey)) ?? conflict(latest);
    }
    // The hold must outlive its TTL while the charge is in flight, or the unit could be resold mid-payment.
    this.deps.inventory.pin(id);
    this.trackingFor(id).payer = client;

    const outcome = await this.deps.payment.charge({
      sessionId: id,
      amount: started.session.priceSnapshot,
      idempotencyKey: providerKey(id, idempotencyKey),
    });
    const settled = this.applyPayment(started.session, outcome, client);

    if (outcome.status === 'failed') {
      return apiError(402, 'PAYMENT_FAILED', outcome.reason, settled);
    }
    return { status: settled.status === 'completed' ? 200 : 202, body: settled };
  }

  /**
   * Answer for a `/complete` that the session's current state already decides, if any: a replay of
   * this key (including one whose payment failed), a sale made under another key, or another
   * key's payment still in flight.
   */
  private async existingOutcome(session: CheckoutSession, idempotencyKey: string): Promise<ApiResult | undefined> {
    if (session.idempotencyKey === idempotencyKey) {
      if (session.status === 'completed') return { status: 200, body: session };
      if (session.status === 'payment_pending') return { status: 202, body: session };
      if (session.status === 'payment_failed') {
        // Replay the recorded failure as-is: no state change, no new charge. Retrying needs a new key.
        const recorded = await this.deps.payment.lookup(providerKey(session.id, idempotencyKey));
        if (recorded.status === 'failed') return apiError(402, 'PAYMENT_FAILED', recorded.reason, session);
      }
    }
    if (session.status === 'completed') return { status: 200, body: { ...session, completedElsewhere: true } };
    if (session.status === 'payment_pending') {
      return apiError(409, 'PAYMENT_IN_PROGRESS', 'a payment for this session is already in progress', session);
    }
    return undefined;
  }

  /** Every request goes through here: the outside hook, and the one analytics event that is about visits. */
  private request(request: Parameters<NonNullable<ServiceHooks['onRequest']>>[0]): void {
    this.hooks.onRequest?.(request);
    const { action, sessionId, client } = request;
    if ((action === 'get' || action === 'stream') && sessionId !== undefined) this.noteResume(sessionId, client);
  }

  /** `session_resumed`: the first GET or stream per client per session. Prefetch reads are not visits. */
  private noteResume(sessionId: string, client: ClientContext): void {
    const who = actingClient(client);
    const session = this.deps.store.get(sessionId);
    if (!who?.clientId || !session) return;
    const tracking = this.trackingFor(sessionId);
    if (tracking.resumedBy.has(who.clientId)) return;
    tracking.resumedBy.add(who.clientId);

    const crossDevice = who.clientId !== session.originClientId;
    if (crossDevice) tracking.crossDevice = true;
    const elapsedMs = this.deps.clock.now().getTime() - Date.parse(session.createdAt);
    this.emit('session_resumed', sessionId, { crossDevice, minutesSinceCreate: Math.round(elapsedMs / 6000) / 10 }, who);
  }

  /** Replies to actions carry a session too (a conflict attaches the fresh one). */
  private noteReply(result: ApiResult, client: ClientContext): void {
    const session = sessionIn(result.body);
    if (session) this.noteDelivered(session, client);
  }

  private noteCompletionConflict(id: string, result: ApiResult, client: ClientContext): void {
    const code = (result.body as { error?: { code?: string } }).error?.code;
    if (code === 'VERSION_CONFLICT' || code === 'PAYMENT_IN_PROGRESS') {
      this.emit('completion_conflict', id, { code }, client);
    } else if ((result.body as { completedElsewhere?: boolean }).completedElsewhere) {
      this.emit('completion_conflict', id, { code: 'COMPLETED_ELSEWHERE' }, client);
    }
  }

  private trackingFor(sessionId: string): SessionTracking {
    let tracking = this.tracking.get(sessionId);
    if (!tracking) {
      tracking = { resumedBy: new Set(), crossDevice: false, shown: new Set() };
      this.tracking.set(sessionId, tracking);
    }
    return tracking;
  }

  /** Build an event stamped with the injected clock and hand it to the sink, which can never fail the caller. */
  private emit<N extends AnalyticsEventName>(
    name: N,
    sessionId: string,
    props: AnalyticsEventProps[N],
    cause?: ClientContext,
  ): void {
    const client = actingClient(cause);
    const event = {
      name,
      sessionId,
      timestamp: this.deps.clock.now().toISOString(),
      source: client ? 'client' : 'system',
      ...(client && { clientId: client.clientId, ...(client.surface && { surface: client.surface }) }),
      props,
    } as AnalyticsEvent;
    safeTrack(this.deps.analytics, event);
  }

  private notFound(id: string): ApiResult {
    return apiError(404, 'SESSION_NOT_FOUND', `no session ${id}`);
  }

  private latest(fallback: CheckoutSession): CheckoutSession {
    return this.deps.store.get(fallback.id) ?? fallback;
  }

  /** Feed the machine every external fact that may have changed since the session was last touched. */
  private async refresh(session: CheckoutSession, cause?: ClientContext): Promise<CheckoutSession> {
    if (isTerminalStatus(session.status)) return session;

    const { clock, inventory, pricing, payment } = this.deps;
    const now = clock.now();
    let current = session;
    const apply = (event: SessionEvent) => {
      const result = transition(current, event, now);
      if (result.ok) current = result.session;
    };

    if (session.status === 'payment_pending') {
      const outcome = session.idempotencyKey ? await payment.lookup(providerKey(session.id, session.idempotencyKey)) : { status: 'pending' as const };
      current = this.applyPayment(session, outcome, cause);
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
    if (!this.deps.store.save(current, session.version)) return this.latest(session);
    this.emitRefreshed(session, current, cause);
    return current;
  }

  /** Analytics for a re-evaluation that was just saved. Runs only for the request that won the save. */
  private emitRefreshed(before: CheckoutSession, after: CheckoutSession, cause: ClientContext | undefined): void {
    if (after.status === 'expired') this.emit('hold_expired', after.id, { source: sourceOf(cause) }, cause);
    else if (after.status === 'unavailable') this.emit('inventory_lost', after.id, { source: sourceOf(cause) }, cause);
    else if (after.changes.length > before.changes.length) {
      const change = after.changes[after.changes.length - 1]!;
      if (change.outcome === 'auto_applied') {
        this.emit('price_change_auto_applied', after.id, { from: change.from, to: change.to }, cause);
      }
    }
  }

  /**
   * Move a payment_pending session to its payment outcome. For `succeeded` this
   * also consumes the held unit and mints the order id. Persists and returns the
   * stored session (which may be newer than `session` if another request won).
   */
  private applyPayment(session: CheckoutSession, outcome: PaymentOutcome, cause?: ClientContext): CheckoutSession {
    if (outcome.status === 'pending') return session;

    const event: SessionEvent =
      outcome.status === 'succeeded'
        ? { type: 'PAYMENT_SUCCEEDED', orderId: randomUUID() }
        : { type: 'PAYMENT_FAILED', reason: outcome.reason };
    const result = transition(session, event, this.deps.clock.now());
    if (!result.ok) return this.latest(session);

    if (!this.deps.store.save(result.session, session.version)) return this.latest(session);
    if (outcome.status === 'succeeded') this.deps.inventory.confirm(session.id);
    // On failure the hold goes back to its normal TTL: the buyer can retry until it lapses.
    else this.deps.inventory.unpin(session.id);

    if (outcome.status === 'succeeded') {
      const tracking = this.trackingFor(session.id);
      const paidOnSurface = tracking.payer?.surface ?? cause?.surface ?? null;
      this.emit('completed', session.id, { crossDevice: tracking.crossDevice, paidOnSurface }, cause);
    } else {
      this.emit('payment_failed', session.id, { reason: outcome.reason }, cause);
    }
    return result.session;
  }
}
