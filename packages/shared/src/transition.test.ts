import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, SESSION_STATUSES } from './session';
import type { CheckoutSession, SessionEvent, SessionEventType, SessionStatus } from './session';
import { transition } from './transition';
import { TRANSITIONS, transitionTableMarkdown } from './transition-table';

const HOLD = '2030-01-01T00:10:00.000Z';
const BEFORE = new Date('2030-01-01T00:05:00.000Z');
const AFTER = new Date('2030-01-01T00:10:00.000Z'); // boundary: hold lapses at holdExpiresAt

function makeSession(status: SessionStatus, overrides: Partial<CheckoutSession> = {}): CheckoutSession {
  return {
    id: 's1',
    listingId: 'l1',
    status,
    priceSnapshot: 10000,
    currentPrice: status === 'price_changed' ? 12000 : 10000,
    holdExpiresAt: HOLD,
    version: 1,
    changes: [],
    ...overrides,
  };
}

const EVENTS: Record<SessionEventType, SessionEvent> = {
  PRICE_CHANGED: { type: 'PRICE_CHANGED', newPrice: 13000 },
  PRICE_ACKNOWLEDGED: { type: 'PRICE_ACKNOWLEDGED' },
  HOLD_EXPIRED: { type: 'HOLD_EXPIRED' },
  INVENTORY_LOST: { type: 'INVENTORY_LOST' },
  PAYMENT_STARTED: { type: 'PAYMENT_STARTED', idempotencyKey: 'key-1' },
  PAYMENT_SUCCEEDED: { type: 'PAYMENT_SUCCEEDED', orderId: 'order-1' },
  PAYMENT_FAILED: { type: 'PAYMENT_FAILED', reason: 'card_declined' },
};

/** Clock that makes the event valid: only HOLD_EXPIRED needs the hold to have lapsed. */
const nowFor = (type: SessionEventType) => (type === 'HOLD_EXPIRED' ? AFTER : BEFORE);

function ok(session: CheckoutSession, event: SessionEvent, now = BEFORE): CheckoutSession {
  const result = transition(session, event, now);
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.session;
}

describe('every status x event combination', () => {
  for (const status of SESSION_STATUSES) {
    for (const type of EVENT_TYPES) {
      const targets = TRANSITIONS[status][type];

      if (targets.length === 0) {
        it(`${status} + ${type} is illegal`, () => {
          const session = makeSession(status);
          const result = transition(session, EVENTS[type], nowFor(type));

          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toMatchObject({ code: 'ILLEGAL_TRANSITION', status, event: type });
          }
        });
      } else {
        it(`${status} + ${type} is legal -> ${targets.join(' / ')}`, () => {
          const session = makeSession(status);
          const result = transition(session, EVENTS[type], nowFor(type));

          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(targets).toContain(result.session.status);
            expect(result.session.version).toBe(session.version + 1);
          }
        });
      }
    }
  }
});

describe('price changes', () => {
  it('auto-applies a decrease and stays active', () => {
    const next = ok(makeSession('active'), { type: 'PRICE_CHANGED', newPrice: 9000 });

    expect(next).toMatchObject({ status: 'active', priceSnapshot: 9000, currentPrice: 9000 });
    expect(next.changes).toEqual([
      { from: 10000, to: 9000, at: BEFORE.toISOString(), outcome: 'auto_applied' },
    ]);
  });

  it('moves to price_changed on an increase and keeps the agreed snapshot', () => {
    const next = ok(makeSession('active'), { type: 'PRICE_CHANGED', newPrice: 11000 });

    expect(next).toMatchObject({ status: 'price_changed', priceSnapshot: 10000, currentPrice: 11000 });
    expect(next.changes).toEqual([
      { from: 10000, to: 11000, at: BEFORE.toISOString(), outcome: 'needs_ack' },
    ]);
  });

  it('acknowledgment accepts the current price and returns to active', () => {
    const next = ok(makeSession('price_changed'), { type: 'PRICE_ACKNOWLEDGED' });

    expect(next).toMatchObject({ status: 'active', priceSnapshot: 12000, currentPrice: 12000 });
  });

  it('a further increase while price_changed stays price_changed and keeps the snapshot', () => {
    const next = ok(makeSession('price_changed'), { type: 'PRICE_CHANGED', newPrice: 15000 });

    expect(next).toMatchObject({ status: 'price_changed', priceSnapshot: 10000, currentPrice: 15000 });
  });

  it('a partial drop that is still above the snapshot still needs acknowledgment', () => {
    const next = ok(makeSession('price_changed'), { type: 'PRICE_CHANGED', newPrice: 11000 });

    expect(next).toMatchObject({ status: 'price_changed', priceSnapshot: 10000, currentPrice: 11000 });
  });

  it('a drop back to or below the snapshot while price_changed auto-applies and returns to active', () => {
    const atSnapshot = ok(makeSession('price_changed'), { type: 'PRICE_CHANGED', newPrice: 10000 });
    expect(atSnapshot).toMatchObject({ status: 'active', priceSnapshot: 10000, currentPrice: 10000 });
    expect(atSnapshot.changes[0]?.outcome).toBe('auto_applied');

    const below = ok(makeSession('price_changed'), { type: 'PRICE_CHANGED', newPrice: 8000 });
    expect(below).toMatchObject({ status: 'active', priceSnapshot: 8000, currentPrice: 8000 });
  });

  it('re-prices a payment_failed session so a retry never charges a stale price', () => {
    const failed = makeSession('payment_failed');

    expect(ok(failed, { type: 'PRICE_CHANGED', newPrice: 9000 })).toMatchObject({
      status: 'active',
      priceSnapshot: 9000,
    });
    expect(ok(failed, { type: 'PRICE_CHANGED', newPrice: 11000 })).toMatchObject({
      status: 'price_changed',
      priceSnapshot: 10000,
      currentPrice: 11000,
    });
  });

  it('an unchanged price is a no-op with no version bump or change entry', () => {
    const session = makeSession('active');
    const next = ok(session, { type: 'PRICE_CHANGED', newPrice: 10000 });

    expect(next).toEqual(session);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid price %s', (newPrice) => {
    const result = transition(makeSession('active'), { type: 'PRICE_CHANGED', newPrice }, BEFORE);

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_PRICE' } });
  });
});

describe('hold expiry guards', () => {
  it('HOLD_EXPIRED before the hold lapses is rejected', () => {
    const result = transition(makeSession('active'), EVENTS.HOLD_EXPIRED, BEFORE);

    expect(result).toMatchObject({ ok: false, error: { code: 'HOLD_NOT_EXPIRED', status: 'active' } });
  });

  it('HOLD_EXPIRED at exactly holdExpiresAt expires the session', () => {
    expect(ok(makeSession('active'), EVENTS.HOLD_EXPIRED, AFTER).status).toBe('expired');
  });

  it('PAYMENT_STARTED after the hold lapses is rejected', () => {
    for (const status of ['active', 'payment_failed'] as const) {
      const result = transition(makeSession(status), EVENTS.PAYMENT_STARTED, AFTER);
      expect(result).toMatchObject({ ok: false, error: { code: 'HOLD_ELAPSED', status } });
    }
  });

  it('PRICE_ACKNOWLEDGED after the hold lapses is rejected', () => {
    const result = transition(makeSession('price_changed'), EVENTS.PRICE_ACKNOWLEDGED, AFTER);

    expect(result).toMatchObject({ ok: false, error: { code: 'HOLD_ELAPSED' } });
  });

  it('price_changed can still expire', () => {
    expect(ok(makeSession('price_changed'), EVENTS.HOLD_EXPIRED, AFTER).status).toBe('expired');
  });
});

describe('payment flow', () => {
  it('PAYMENT_STARTED stores the idempotency key', () => {
    const next = ok(makeSession('active'), EVENTS.PAYMENT_STARTED);

    expect(next).toMatchObject({ status: 'payment_pending', idempotencyKey: 'key-1' });
  });

  it('PAYMENT_SUCCEEDED completes the session and records the order', () => {
    const next = ok(makeSession('payment_pending', { idempotencyKey: 'key-1' }), EVENTS.PAYMENT_SUCCEEDED);

    expect(next).toMatchObject({ status: 'completed', orderId: 'order-1', idempotencyKey: 'key-1' });
  });

  it('can retry payment after a failure with a new idempotency key', () => {
    const failed = ok(makeSession('payment_pending', { idempotencyKey: 'key-1' }), EVENTS.PAYMENT_FAILED);
    expect(failed.status).toBe('payment_failed');

    const retry = ok(failed, { type: 'PAYMENT_STARTED', idempotencyKey: 'key-2' });
    expect(retry).toMatchObject({ status: 'payment_pending', idempotencyKey: 'key-2' });
  });
});

describe('invariants', () => {
  it('increments version by one on each change', () => {
    const a = ok(makeSession('active'), EVENTS.PAYMENT_STARTED);
    const b = ok(a, EVENTS.PAYMENT_SUCCEEDED);

    expect([a.version, b.version]).toEqual([2, 3]);
  });

  it('leaves the input session untouched, on success and on error', () => {
    const session = makeSession('active');
    const snapshot = structuredClone(session);

    transition(session, { type: 'PRICE_CHANGED', newPrice: 11000 }, BEFORE);
    transition(session, EVENTS.PRICE_ACKNOWLEDGED, BEFORE);

    expect(session).toEqual(snapshot);
  });

  it('returns errors instead of throwing, even for unknown input', () => {
    const bogus = { type: 'NOPE' } as unknown as SessionEvent;

    expect(() => transition(makeSession('active'), bogus, BEFORE)).not.toThrow();
    expect(transition(makeSession('active'), bogus, BEFORE).ok).toBe(false);
  });
});

describe('transitionTableMarkdown', () => {
  const lines = transitionTableMarkdown().split('\n');

  it('has a header, a divider and one row per status', () => {
    expect(lines).toHaveLength(2 + SESSION_STATUSES.length);
    expect(lines[0]).toBe(`| Status \\ Event | ${EVENT_TYPES.join(' | ')} |`);
  });

  it('renders a cell for every status x event pair', () => {
    SESSION_STATUSES.forEach((status, row) => {
      const cells = lines[row + 2]!.split('|').slice(1, -1).map((c) => c.trim());
      expect(cells[0]).toBe(status);
      EVENT_TYPES.forEach((type, col) => {
        const targets = TRANSITIONS[status][type];
        expect(cells[col + 1]).toBe(targets.length === 0 ? '—' : targets.join(' / '));
      });
    });
  });
});
