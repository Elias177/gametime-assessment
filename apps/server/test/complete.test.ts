import { describe, expect, it } from 'vitest';
import { CheckoutService } from '../src/checkout-service';
import { providerKey } from '../src/services/payment';
import { LISTING, complete, setup } from './helpers';

// See the comment above CheckoutService.complete for why the idempotency key and the
// session version are both required.

describe('POST /complete request validation', () => {
  it('requires the Idempotency-Key header', async () => {
    const { api, createSession } = setup();
    const { id } = await createSession();

    const missing = await api.post(`/api/sessions/${id}/complete`).send({ version: 1 });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('INVALID_REQUEST');

    const empty = await api.post(`/api/sessions/${id}/complete`).set('Idempotency-Key', '').send({ version: 1 });
    expect(empty.status).toBe(400);

    // The old body-field spelling is no longer accepted.
    const inBody = await api.post(`/api/sessions/${id}/complete`).send({ version: 1, idempotencyKey: 'k' });
    expect(inBody.status).toBe(400);
  });

  it.each([undefined, '1', 1.5, null])('requires an integer version (got %s)', async (version) => {
    const { api, deps, createSession } = setup();
    const { id } = await createSession();

    const res = await api.post(`/api/sessions/${id}/complete`).set('Idempotency-Key', 'k').send({ version });
    expect(res.status).toBe(400);
    expect(deps.payment.charges).toHaveLength(0);
  });
});

describe('same key -> same order', () => {
  it('returns the original order on replay, even though the replay carries a now-stale version', async () => {
    const { api, deps, createSession } = setup();
    const { id } = await createSession();

    const first = await complete(api, id, 'k', 1);
    const replay = await complete(api, id, 'k', 1); // session is at a later version by now

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body.orderId).toBe(first.body.orderId);
    expect(replay.body).not.toHaveProperty('completedElsewhere');
    expect(deps.payment.charges).toHaveLength(1);
  });

  it('answers a replay of a pending payment with 202 and does not charge again', async () => {
    const { api, deps, createSession } = setup({ paymentBehavior: 'pending' });
    const { id } = await createSession();

    expect((await complete(api, id, 'k', 1)).status).toBe(202);
    expect((await complete(api, id, 'k', 1)).status).toBe(202);
    expect(deps.payment.charges).toHaveLength(1);
  });
});

describe('provider-level dedupe', () => {
  it('scopes the key sent to the provider to the session, so two sessions can reuse a client key', async () => {
    const { api, deps, createSession } = setup({ stock: { [LISTING]: 2 } });
    const a = await createSession();
    const b = await createSession();

    const first = await complete(api, a.id, 'same-key', 1);
    const second = await complete(api, b.id, 'same-key', 1);

    expect(second.status).toBe(200);
    expect(second.body.orderId).not.toBe(first.body.orderId);
    // Without scoping the provider would treat B's charge as a replay of A's and never charge it.
    expect(deps.payment.charges).toEqual([
      { sessionId: a.id, amount: 10000, idempotencyKey: providerKey(a.id, 'same-key') },
      { sessionId: b.id, amount: 10000, idempotencyKey: providerKey(b.id, 'same-key') },
    ]);
  });

  it('sends the same provider key when the same request is retried', async () => {
    const { api, deps, createSession } = setup({ paymentBehavior: 'pending' });
    const { id } = await createSession();

    await complete(api, id, 'k', 1);
    await complete(api, id, 'k', 1);

    expect(deps.payment.charges.map((c) => c.idempotencyKey)).toEqual([providerKey(id, 'k')]);
  });
});

describe('same key after a failed payment', () => {
  it('returns the original failure without touching the session or charging again', async () => {
    const { api, deps, createSession } = setup({ paymentBehavior: 'fail' });
    const { id } = await createSession();
    const failed = await complete(api, id, 'k1', 1);
    expect(failed.status).toBe(402);

    // Even if the provider would now succeed, the same key must not be re-run.
    deps.payment.setBehavior('succeed');
    for (const version of [1, failed.body.session.version]) {
      const replay = await complete(api, id, 'k1', version);
      expect(replay.status).toBe(402);
      expect(replay.body).toEqual(failed.body);
    }
    expect(deps.payment.charges).toHaveLength(1);
    expect((await api.get(`/api/sessions/${id}`)).body.version).toBe(failed.body.session.version);

    // A new key is a new attempt.
    const retry = await complete(api, id, 'k2', failed.body.session.version);
    expect(retry.status).toBe(200);
    expect(deps.payment.charges).toHaveLength(2);
  });
});

describe('already completed under a different key', () => {
  it('returns 200 with the existing order and completedElsewhere: true', async () => {
    const { api, deps, createSession } = setup();
    const { id } = await createSession();

    const first = await complete(api, id, 'phone', 1);
    const other = await complete(api, id, 'laptop', 1);

    expect(other.status).toBe(200);
    expect(other.body).toMatchObject({
      status: 'completed',
      orderId: first.body.orderId,
      completedElsewhere: true,
    });
    expect(deps.payment.charges).toHaveLength(1);
  });
});

describe('different key while a payment is in progress', () => {
  it('is rejected with 409 PAYMENT_IN_PROGRESS, whether or not its version is current', async () => {
    const { api, deps, createSession } = setup({ paymentBehavior: 'pending' });
    const { id } = await createSession();
    const pending = await complete(api, id, 'phone', 1);
    expect(pending.status).toBe(202);

    for (const version of [1, pending.body.version]) {
      const other = await complete(api, id, 'laptop', version);
      expect(other.status).toBe(409);
      expect(other.body).toMatchObject({
        error: { code: 'PAYMENT_IN_PROGRESS' },
        session: { status: 'payment_pending', idempotencyKey: 'phone' },
      });
    }
    expect(deps.payment.charges).toHaveLength(1);

    // The original request is unaffected and still resolves normally.
    deps.payment.settle(providerKey(id, 'phone'), { status: 'succeeded' });
    const replay = await complete(api, id, 'phone', 1);
    expect(replay.status).toBe(200);
    expect(replay.body.status).toBe('completed');
  });
});

describe('stale version', () => {
  it('returns 409 with the fresh session and does not charge', async () => {
    const { api, deps, createSession } = setup();
    const { id, version } = await createSession();

    // The price rises after the buyer loaded the page; the next read bumps the version.
    deps.pricing.setPrice(LISTING, 12000);
    const res = await complete(api, id, 'k', version);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: { code: 'VERSION_CONFLICT' },
      session: { status: 'price_changed', currentPrice: 12000, version: version + 1 },
    });
    expect(deps.payment.charges).toHaveLength(0);
  });
});

describe('concurrent completes with different keys', () => {
  it('produces exactly one order (HTTP)', async () => {
    const { api, deps, createSession } = setup();
    const { id, version } = await createSession();

    const [a, b] = await Promise.all([complete(api, id, 'phone', version), complete(api, id, 'laptop', version)]);

    // Arrival order over HTTP is not deterministic, so assert the outcome, not who won.
    const orderIds = new Set([a, b].map((r) => r.body.orderId ?? r.body.session?.orderId).filter(Boolean));
    expect(orderIds.size).toBe(1);
    expect(deps.payment.charges).toHaveLength(1);

    const winners = [a, b].filter((r) => r.status === 200 && !r.body.completedElsewhere);
    expect(winners).toHaveLength(1);
    for (const loser of [a, b].filter((r) => !winners.includes(r))) {
      const completedElsewhere = loser.status === 200 && loser.body.completedElsewhere === true;
      const rejected =
        loser.status === 409 && ['VERSION_CONFLICT', 'PAYMENT_IN_PROGRESS'].includes(loser.body.error.code);
      expect(completedElsewhere || rejected).toBe(true);
    }

    const final = await api.get(`/api/sessions/${id}`);
    expect(final.body).toMatchObject({ status: 'completed', orderId: [...orderIds][0] });

    // The single unit was consumed once: nothing left to sell.
    const another = await api.post('/api/sessions').send({ listingId: LISTING });
    expect(another.status).toBe(409);
    expect(another.body.error.code).toBe('SOLD_OUT');
  });

  it('is stopped by the store compare-and-set, not only by the version check', async () => {
    const { deps } = setup();
    const service = new CheckoutService(deps);
    const created = service.create(LISTING).body as { id: string; version: number };

    let failedSaves = 0;
    const save = deps.store.save.bind(deps.store);
    deps.store.save = (next, expectedVersion) => {
      const saved = save(next, expectedVersion);
      if (!saved) failedSaves += 1;
      return saved;
    };

    // Both calls read version 1 and pass the explicit version check before either saves
    // (they interleave at `await refresh`), so only the compare-and-set can reject the loser.
    const results = await Promise.all([
      service.complete(created.id, 'phone', created.version),
      service.complete(created.id, 'laptop', created.version),
    ]);

    expect(failedSaves).toBe(1);
    expect(deps.payment.charges).toHaveLength(1);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    // The loser re-reads and finds the winner's payment still in flight.
    expect(results.find((r) => r.status === 409)?.body).toMatchObject({ error: { code: 'PAYMENT_IN_PROGRESS' } });
  });
});
