import type { Listing } from '@checkout/shared';
import { SystemClock } from './clock';
import type { Clock } from './clock';
import { InMemoryInventoryService } from './services/inventory';
import type { InventoryService } from './services/inventory';
import { InMemoryListingCatalog } from './services/listings';
import type { ListingCatalog } from './services/listings';
import { InMemoryPaymentService } from './services/payment';
import type { PaymentBehavior, PaymentService } from './services/payment';
import { InMemoryPricingService } from './services/pricing';
import type { PricingService } from './services/pricing';
import { InMemorySessionStore } from './store';
import type { SessionStore } from './store';
import { SystemTimers } from './timers';
import type { Timers } from './timers';

export interface AppDeps {
  clock: Clock;
  timers: Timers;
  store: SessionStore;
  inventory: InventoryService;
  pricing: PricingService;
  payment: PaymentService;
  listings: ListingCatalog;
  /** How long a session's inventory hold lasts. */
  holdTtlMs: number;
  /** Interval between SSE heartbeat comments. */
  heartbeatMs: number;
}

export interface InMemoryDeps extends AppDeps {
  store: InMemorySessionStore;
  inventory: InMemoryInventoryService;
  pricing: InMemoryPricingService;
  payment: InMemoryPaymentService;
  listings: InMemoryListingCatalog;
}

export interface InMemoryDepsOptions {
  clock?: Clock;
  /** Defaults to real timers; pass a `ManualClock` to drive scheduled work from tests. */
  timers?: Timers;
  /** Units in stock per listing id. */
  stock?: Record<string, number>;
  /** Price in integer cents per listing id. */
  prices?: Record<string, number>;
  listings?: Listing[];
  paymentBehavior?: PaymentBehavior;
  holdTtlMs?: number;
  heartbeatMs?: number;
}

export const DEFAULT_HOLD_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_HEARTBEAT_MS = 15_000;

/** Concrete in-memory services, returned with their test/demo controls still exposed. */
export function createInMemoryDeps(options: InMemoryDepsOptions = {}): InMemoryDeps {
  const clock = options.clock ?? new SystemClock();
  return {
    clock,
    timers: options.timers ?? new SystemTimers(),
    store: new InMemorySessionStore(),
    inventory: new InMemoryInventoryService(clock, options.stock),
    pricing: new InMemoryPricingService(options.prices),
    payment: new InMemoryPaymentService(options.paymentBehavior),
    listings: new InMemoryListingCatalog(options.listings),
    holdTtlMs: options.holdTtlMs ?? DEFAULT_HOLD_TTL_MS,
    heartbeatMs: options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
  };
}
