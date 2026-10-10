export interface ChargeRequest {
  sessionId: string;
  /** Integer cents. */
  amount: number;
  /**
   * Provider-level dedupe key: the provider must treat a repeated key as the same charge and
   * return the original outcome instead of charging again. Build it with `providerKey`.
   */
  idempotencyKey: string;
}

/**
 * Key sent to the provider for one payment attempt. Client keys are only unique per session
 * (two sessions may both send "pay-1"), so the session id is part of what the provider dedupes on.
 */
export function providerKey(sessionId: string, clientKey: string): string {
  return `${sessionId}:${clientKey}`;
}

export type PaymentOutcome =
  | { status: 'succeeded' }
  | { status: 'failed'; reason: string }
  | { status: 'pending' };

export interface PaymentService {
  /** Idempotent per `idempotencyKey`: a repeated key returns the recorded outcome. */
  charge(request: ChargeRequest): Promise<PaymentOutcome>;
  /** Current outcome of an earlier charge; used to settle `pending` payments. */
  lookup(idempotencyKey: string): Promise<PaymentOutcome>;
}

export type PaymentBehavior = 'succeed' | 'fail' | 'pending';

export class InMemoryPaymentService implements PaymentService {
  private readonly outcomes = new Map<string, PaymentOutcome>();
  /** Every distinct charge that reached the provider, for assertions in tests. */
  readonly charges: ChargeRequest[] = [];

  constructor(private behavior: PaymentBehavior = 'succeed') {}

  setBehavior(behavior: PaymentBehavior): void {
    this.behavior = behavior;
  }

  /** Resolve a pending charge, as a provider webhook or poll would. */
  settle(idempotencyKey: string, outcome: PaymentOutcome): void {
    this.outcomes.set(idempotencyKey, outcome);
  }

  async charge(request: ChargeRequest): Promise<PaymentOutcome> {
    const existing = this.outcomes.get(request.idempotencyKey);
    if (existing) return existing;

    this.charges.push(request);
    const outcome: PaymentOutcome =
      this.behavior === 'succeed'
        ? { status: 'succeeded' }
        : this.behavior === 'fail'
          ? { status: 'failed', reason: 'card_declined' }
          : { status: 'pending' };
    this.outcomes.set(request.idempotencyKey, outcome);
    return outcome;
  }

  async lookup(idempotencyKey: string): Promise<PaymentOutcome> {
    return this.outcomes.get(idempotencyKey) ?? { status: 'pending' };
  }
}
