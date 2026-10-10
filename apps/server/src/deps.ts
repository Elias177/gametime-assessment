import { SystemClock } from './clock';
import type { Clock } from './clock';
import { InMemoryInventoryService } from './services/inventory';
import type { InventoryService } from './services/inventory';
import { InMemoryPaymentService } from './services/payment';
import type { PaymentBehavior, PaymentService } from './services/payment';
import { InMemoryPricingService } from './services/pricing';
import type { PricingService } from './services/pricing';
import { InMemorySessionStore } from './store';
import type { SessionStore } from './store';

export interface AppDeps {
  clock: Clock;
  store: SessionStore;
  inventory: InventoryService;
  pricing: PricingService;
  payment: PaymentService;
  /** How long a session's inventory hold lasts. */
  holdTtlMs: number;
}

export interface InMemoryDeps extends AppDeps {
  store: InMemorySessionStore;
  inventory: InMemoryInventoryService;
  pricing: InMemoryPricingService;
  payment: InMemoryPaymentService;
}

export interface InMemoryDepsOptions {
  clock?: Clock;
  /** Units in stock per listing id. */
  stock?: Record<string, number>;
  /** Price in integer cents per listing id. */
  prices?: Record<string, number>;
  paymentBehavior?: PaymentBehavior;
  holdTtlMs?: number;
}

export const DEFAULT_HOLD_TTL_MS = 10 * 60 * 1000;

/** Concrete in-memory services, returned with their test/demo controls still exposed. */
export function createInMemoryDeps(options: InMemoryDepsOptions = {}): InMemoryDeps {
  const clock = options.clock ?? new SystemClock();
  return {
    clock,
    store: new InMemorySessionStore(),
    inventory: new InMemoryInventoryService(clock, options.stock),
    pricing: new InMemoryPricingService(options.prices),
    payment: new InMemoryPaymentService(options.paymentBehavior),
    holdTtlMs: options.holdTtlMs ?? DEFAULT_HOLD_TTL_MS,
  };
}
