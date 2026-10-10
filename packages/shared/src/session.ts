export const SESSION_STATUSES = [
  'active',
  'price_changed',
  'payment_pending',
  'completed',
  'payment_failed',
  'expired',
  'unavailable',
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Statuses that can never change again. */
export const TERMINAL_STATUSES: readonly SessionStatus[] = ['completed', 'expired', 'unavailable'];

export function isTerminalStatus(status: SessionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** One entry in the price audit trail. Prices are integer cents. */
export interface PriceChange {
  from: number;
  to: number;
  /** ISO timestamp of when the change was applied. */
  at: string;
  /** `auto_applied` = decrease taken silently; `needs_ack` = increase awaiting acknowledgment. */
  outcome: 'auto_applied' | 'needs_ack';
}

export const SURFACES = ['web', 'mobile'] as const;

/** Which kind of client made a request. */
export type Surface = (typeof SURFACES)[number];

export function isSurface(value: unknown): value is Surface {
  return SURFACES.includes(value as Surface);
}

export interface CheckoutSession {
  id: string;
  listingId: string;
  /** ISO timestamp of when the session was created. */
  createdAt: string;
  /** The client (one per pane/device, from `X-Client-Id`) that started this checkout. */
  originClientId: string;
  /** The surface (`X-Surface`) that client was on. */
  originSurface: Surface;
  status: SessionStatus;
  /** Price (integer cents) the buyer has agreed to. */
  priceSnapshot: number;
  /** Latest price (integer cents) reported by the backend. */
  currentPrice: number;
  /** ISO timestamp when the inventory hold lapses. */
  holdExpiresAt: string;
  version: number;
  orderId?: string;
  idempotencyKey?: string;
  changes: PriceChange[];
}

export type SessionEvent =
  | { type: 'PRICE_CHANGED'; newPrice: number }
  | { type: 'PRICE_ACKNOWLEDGED' }
  | { type: 'HOLD_EXPIRED' }
  | { type: 'INVENTORY_LOST' }
  | { type: 'PAYMENT_STARTED'; idempotencyKey: string }
  | { type: 'PAYMENT_SUCCEEDED'; orderId: string }
  | { type: 'PAYMENT_FAILED'; reason?: string };

export type SessionEventType = SessionEvent['type'];

export const EVENT_TYPES = [
  'PRICE_CHANGED',
  'PRICE_ACKNOWLEDGED',
  'HOLD_EXPIRED',
  'INVENTORY_LOST',
  'PAYMENT_STARTED',
  'PAYMENT_SUCCEEDED',
  'PAYMENT_FAILED',
] as const satisfies readonly SessionEventType[];
