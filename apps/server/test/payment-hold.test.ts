import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/clock';
import { InMemoryInventoryService } from '../src/services/inventory';
import { providerKey } from '../src/services/payment';
import { LISTING, TTL_MS, complete, setup } from './helpers';

describe('regression: hold stays in place while payment is pending', () => {
  it('keeps the unit reserved past the TTL, then lets A complete', async () => {
    const { api, clock, deps, createSession } = setup({ paymentBehavior: 'pending' });
    const a = await createSession();

    const pending = await complete(api, a.id, 'k', a.version);
    expect(pending.status).toBe(202);

    clock.advance(TTL_MS * 2);

    // Before the fix the lapsed hold stopped counting and B could take A's unit.
    const b = await api.post('/api/sessions').send({ listingId: LISTING });
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe('SOLD_OUT');

    deps.payment.settle(providerKey(a.id, 'k'), { status: 'succeeded' });
    const settled = await api.get(`/api/sessions/${a.id}`);
    expect(settled.body).toMatchObject({ status: 'completed' });
    expect(settled.body.orderId).toEqual(expect.any(String));

    // The unit was sold to A, so it stays gone.
    expect((await api.post('/api/sessions').send({ listingId: LISTING })).status).toBe(409);
    expect(deps.inventory.available(LISTING)).toBe(0);
  });
});

describe('payment failure', () => {
  it('unpins the hold: the buyer can retry until the TTL lapses', async () => {
    const { api, clock, deps, createSession } = setup({ paymentBehavior: 'pending' });
    const a = await createSession();
    await complete(api, a.id, 'k1', a.version);

    deps.payment.settle(providerKey(a.id, 'k1'), { status: 'failed', reason: 'card_declined' });
    const failed = await api.get(`/api/sessions/${a.id}`);
    expect(failed.body.status).toBe('payment_failed');

    // Still inside the original TTL: the unit is held for A's retry.
    expect((await api.post('/api/sessions').send({ listingId: LISTING })).status).toBe(409);

    deps.payment.setBehavior('succeed');
    clock.advance(1000);
    const retry = await complete(api, a.id, 'k2', failed.body.version);
    expect(retry.status).toBe(200);
  });

  it('frees the unit once the TTL has lapsed, and the failed session expires', async () => {
    const { api, clock, deps, createSession } = setup({ paymentBehavior: 'pending' });
    const a = await createSession();
    await complete(api, a.id, 'k1', a.version);

    clock.advance(TTL_MS * 2); // payment still pending: hold pinned, session not expired
    expect((await api.get(`/api/sessions/${a.id}`)).body.status).toBe('payment_pending');

    deps.payment.settle(providerKey(a.id, 'k1'), { status: 'failed', reason: 'card_declined' });
    const failed = await api.get(`/api/sessions/${a.id}`);
    expect(failed.body.status).toBe('payment_failed');

    // The pin is gone and the TTL is long past, so the unit is free again.
    const b = await api.post('/api/sessions').send({ listingId: LISTING });
    expect(b.status).toBe(201);

    // A's next read sees the lapsed hold.
    expect((await api.get(`/api/sessions/${a.id}`)).body.status).toBe('expired');
  });
});

describe('InMemoryInventoryService pinning', () => {
  const setupInventory = () => {
    const clock = new ManualClock();
    const inventory = new InMemoryInventoryService(clock, { L: 1 });
    inventory.hold('L', 'a', 1000);
    return { clock, inventory };
  };

  it('treats a pinned hold as live until confirm', () => {
    const { clock, inventory } = setupInventory();
    inventory.pin('a');
    clock.advance(5000);

    expect(inventory.status('a')).toBe('held');
    expect(inventory.available('L')).toBe(0);
    expect(inventory.hold('L', 'b', 1000)).toEqual({ ok: false, reason: 'SOLD_OUT' });

    inventory.confirm('a');
    expect(inventory.status('a')).toBe('lost');
    expect(inventory.available('L')).toBe(0); // sold, not free
  });

  it('release frees a pinned hold', () => {
    const { clock, inventory } = setupInventory();
    inventory.pin('a');
    clock.advance(5000);
    inventory.release('a');

    expect(inventory.available('L')).toBe(1);
  });

  it('unpin returns the hold to its TTL', () => {
    const { clock, inventory } = setupInventory();
    inventory.pin('a');
    clock.advance(5000);
    inventory.unpin('a');

    expect(inventory.status('a')).toBe('expired');
    expect(inventory.available('L')).toBe(1);
  });

  it('a hold lost to a revoke cannot be pinned back to life', () => {
    const { inventory } = setupInventory();
    inventory.revokeStock('L');
    inventory.pin('a');

    expect(inventory.status('a')).toBe('lost');
  });

  it('pinning an unknown owner is a no-op', () => {
    const { inventory } = setupInventory();
    inventory.pin('nobody');

    expect(inventory.status('nobody')).toBe('lost');
  });
});
