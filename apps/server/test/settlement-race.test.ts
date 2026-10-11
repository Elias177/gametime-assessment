import type { CheckoutSession } from '@checkout/shared';
import { describe, expect, it, vi } from 'vitest';
import { CheckoutService } from '../src/checkout-service';
import type { AppDeps } from '../src/deps';
import { ManualClock } from '../src/clock';
import { createInMemoryDeps } from '../src/deps';
import { providerKey } from '../src/services/payment';
import type { PaymentOutcome, PaymentService } from '../src/services/payment';
import type { SessionListener, SessionStore } from '../src/store';
import { LISTING, TTL_MS } from './helpers';

/** Records every save and whether the compare-and-set accepted it. */
class RecordingStore implements SessionStore {
  readonly saves: { version: number; accepted: boolean }[] = [];
  constructor(private readonly inner: SessionStore) {}
  create(session: CheckoutSession) {
    this.inner.create(session);
  }
  get(id: string) {
    return this.inner.get(id);
  }
  save(next: CheckoutSession, expectedVersion: number) {
    const accepted = this.inner.save(next, expectedVersion);
    this.saves.push({ version: next.version, accepted });
    return accepted;
  }
  subscribe(id: string, listener: SessionListener) {
    return this.inner.subscribe(id, listener);
  }
  list() {
    return this.inner.list();
  }
}

/**
 * Holds every `lookup` until `parties` callers are inside it. Both settlers have then already read
 * the payment_pending session and neither has saved, which is the window the guard in
 * `applyPayment` exists for.
 */
class BarrierPayment implements PaymentService {
  private waiting: (() => void)[] = [];
  private parties = 0;
  constructor(private readonly inner: PaymentService) {}

  arm(parties: number) {
    this.parties = parties;
  }
  charge(request: Parameters<PaymentService['charge']>[0]) {
    return this.inner.charge(request);
  }
  async lookup(key: string): Promise<PaymentOutcome> {
    const outcome = await this.inner.lookup(key);
    if (this.parties === 0) return outcome;
    await new Promise<void>((resolve) => {
      this.waiting.push(resolve);
      if (this.waiting.length === this.parties) {
        const release = this.waiting;
        this.waiting = [];
        release.forEach((r) => r());
      }
    });
    return outcome;
  }
}

async function pendingSession() {
  const clock = new ManualClock();
  const base = createInMemoryDeps({
    clock,
    timers: clock,
    stock: { [LISTING]: 1 },
    prices: { [LISTING]: 10000 },
    holdTtlMs: TTL_MS,
    paymentBehavior: 'pending',
  });
  const store = new RecordingStore(base.store);
  const payment = new BarrierPayment(base.payment);
  const deps: AppDeps = { ...base, store, payment };
  const service = new CheckoutService(deps);

  const created = service.create(LISTING, { clientId: 'laptop', surface: 'web' });
  const session = created.body as CheckoutSession;
  const pending = await service.complete(session.id, 'key-1', session.version, { clientId: 'laptop', surface: 'web' });
  expect(pending.status).toBe(202);
  return { base, store, payment, service, id: session.id };
}

describe('settling one pending payment twice at the same moment', () => {
  const scenarios = [
    {
      name: 'a GET refresh and a dev settle',
      run: (service: CheckoutService, id: string) =>
        Promise.all([service.get(id, { clientId: 'phone', surface: 'mobile' }), service.refreshById(id)]),
    },
    {
      name: 'two refreshes',
      run: (service: CheckoutService, id: string) => Promise.all([service.refreshById(id), service.refreshById(id)]),
    },
  ];

  it.each(scenarios)('$name: one save wins, one sale, one order', async ({ run }) => {
    const { base, store, payment, service, id } = await pendingSession();
    const confirm = vi.spyOn(base.inventory, 'confirm');
    base.payment.settle(providerKey(id, 'key-1'), { status: 'succeeded' });
    const savesBefore = store.saves.length;
    payment.arm(2);

    await run(service, id);

    // Exactly one save moved the session off payment_pending.
    const accepted = store.saves.slice(savesBefore).filter((s) => s.accepted);
    expect(accepted).toHaveLength(1);

    const final = base.store.get(id)!;
    expect(final.status).toBe('completed');
    expect(final.orderId).toEqual(expect.any(String));
    const orderIds = new Set(base.store.list().map((s) => s.orderId));
    expect(orderIds.size).toBe(1);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(base.analytics.list().filter((e) => e.name === 'completed')).toHaveLength(1);
    expect(base.payment.charges).toHaveLength(1);
  });
});
