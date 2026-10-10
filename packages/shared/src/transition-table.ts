import { EVENT_TYPES, SESSION_STATUSES } from './session';
import type { SessionEventType, SessionStatus } from './session';

/**
 * Which statuses each (status, event) pair may lead to. An empty list means the
 * pair is illegal. PRICE_CHANGED has two targets because the outcome depends on
 * whether the price went up or down.
 */
export const TRANSITIONS: Record<SessionStatus, Record<SessionEventType, readonly SessionStatus[]>> = {
  active: {
    PRICE_CHANGED: ['active', 'price_changed'],
    PRICE_ACKNOWLEDGED: [],
    HOLD_EXPIRED: ['expired'],
    INVENTORY_LOST: ['unavailable'],
    PAYMENT_STARTED: ['payment_pending'],
    PAYMENT_SUCCEEDED: [],
    PAYMENT_FAILED: [],
  },
  price_changed: {
    PRICE_CHANGED: ['active', 'price_changed'],
    PRICE_ACKNOWLEDGED: ['active'],
    HOLD_EXPIRED: ['expired'],
    INVENTORY_LOST: ['unavailable'],
    PAYMENT_STARTED: [],
    PAYMENT_SUCCEEDED: [],
    PAYMENT_FAILED: [],
  },
  payment_pending: {
    PRICE_CHANGED: [],
    PRICE_ACKNOWLEDGED: [],
    HOLD_EXPIRED: [],
    INVENTORY_LOST: [],
    PAYMENT_STARTED: [],
    PAYMENT_SUCCEEDED: ['completed'],
    PAYMENT_FAILED: ['payment_failed'],
  },
  payment_failed: {
    PRICE_CHANGED: ['active', 'price_changed'],
    PRICE_ACKNOWLEDGED: [],
    HOLD_EXPIRED: ['expired'],
    INVENTORY_LOST: ['unavailable'],
    PAYMENT_STARTED: ['payment_pending'],
    PAYMENT_SUCCEEDED: [],
    PAYMENT_FAILED: [],
  },
  completed: noEvents(),
  expired: noEvents(),
  unavailable: noEvents(),
};

function noEvents(): Record<SessionEventType, readonly SessionStatus[]> {
  return {
    PRICE_CHANGED: [],
    PRICE_ACKNOWLEDGED: [],
    HOLD_EXPIRED: [],
    INVENTORY_LOST: [],
    PAYMENT_STARTED: [],
    PAYMENT_SUCCEEDED: [],
    PAYMENT_FAILED: [],
  };
}

export function isLegal(status: SessionStatus, event: SessionEventType): boolean {
  // Optional chaining keeps unknown statuses/events from untrusted input on the error path.
  return (TRANSITIONS[status]?.[event]?.length ?? 0) > 0;
}

/** Markdown grid of the transition table (rows = current status, columns = event), ready for a README. */
export function transitionTableMarkdown(): string {
  const header = `| Status \\ Event | ${EVENT_TYPES.join(' | ')} |`;
  const divider = `| --- |${EVENT_TYPES.map(() => ' --- |').join('')}`;
  const rows = SESSION_STATUSES.map((status) => {
    const cells = EVENT_TYPES.map((event) => {
      const targets = TRANSITIONS[status][event];
      return targets.length === 0 ? '—' : targets.join(' / ');
    });
    return `| ${status} | ${cells.join(' | ')} |`;
  });
  return [header, divider, ...rows].join('\n');
}
