import type { CheckoutSession, PriceChange, SessionEvent, SessionEventType, SessionStatus } from './session';
import { isLegal } from './transition-table';

export type TransitionErrorCode =
  | 'ILLEGAL_TRANSITION'
  | 'HOLD_NOT_EXPIRED'
  | 'HOLD_ELAPSED'
  | 'INVALID_PRICE';

export interface TransitionError {
  code: TransitionErrorCode;
  message: string;
  /** Status the session was in when the event was rejected. */
  status: SessionStatus;
  event: SessionEventType;
}

export type TransitionResult =
  | { ok: true; session: CheckoutSession }
  | { ok: false; error: TransitionError };

/**
 * Pure state machine step. Never throws and never mutates `session`; the clock
 * is only ever read from `now`.
 */
export function transition(session: CheckoutSession, event: SessionEvent, now: Date): TransitionResult {
  const fail = (code: TransitionErrorCode, message: string): TransitionResult => ({
    ok: false,
    error: { code, message, status: session.status, event: event.type },
  });
  const advance = (patch: Partial<CheckoutSession>): TransitionResult => ({
    ok: true,
    session: { ...session, ...patch, version: session.version + 1 },
  });
  const holdElapsed = now.getTime() >= Date.parse(session.holdExpiresAt);

  if (!isLegal(session.status, event.type)) {
    return fail('ILLEGAL_TRANSITION', `${event.type} is not allowed while ${session.status}`);
  }

  switch (event.type) {
    case 'PRICE_CHANGED': {
      const price = event.newPrice;
      if (!Number.isInteger(price) || price < 0) {
        return fail('INVALID_PRICE', `newPrice must be a non-negative integer (cents), got ${price}`);
      }
      if (price === session.currentPrice) return { ok: true, session };

      const decreaseOrEqual = price <= session.priceSnapshot;
      const change: PriceChange = {
        from: session.currentPrice,
        to: price,
        at: now.toISOString(),
        outcome: decreaseOrEqual ? 'auto_applied' : 'needs_ack',
      };
      return advance({
        status: decreaseOrEqual ? 'active' : 'price_changed',
        currentPrice: price,
        priceSnapshot: decreaseOrEqual ? price : session.priceSnapshot,
        changes: [...session.changes, change],
      });
    }
    case 'PRICE_ACKNOWLEDGED':
      if (holdElapsed) return fail('HOLD_ELAPSED', 'hold has lapsed; expire the session instead');
      return advance({ status: 'active', priceSnapshot: session.currentPrice });
    case 'HOLD_EXPIRED':
      if (!holdElapsed) return fail('HOLD_NOT_EXPIRED', 'hold has not lapsed yet');
      return advance({ status: 'expired' });
    case 'INVENTORY_LOST':
      return advance({ status: 'unavailable' });
    case 'PAYMENT_STARTED':
      if (holdElapsed) return fail('HOLD_ELAPSED', 'hold has lapsed; expire the session instead');
      return advance({ status: 'payment_pending', idempotencyKey: event.idempotencyKey });
    case 'PAYMENT_SUCCEEDED':
      return advance({ status: 'completed', orderId: event.orderId });
    case 'PAYMENT_FAILED':
      return advance({ status: 'payment_failed' });
  }
}
