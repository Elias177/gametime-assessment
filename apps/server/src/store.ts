import type { CheckoutSession } from '@checkout/shared';

export interface SessionStore {
  create(session: CheckoutSession): void;
  get(id: string): CheckoutSession | undefined;
  /**
   * Compare-and-set on `version`: writes `next` only if the stored session is
   * still at `expectedVersion`. Returns false when someone else got there first.
   */
  save(next: CheckoutSession, expectedVersion: number): boolean;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, CheckoutSession>();

  create(session: CheckoutSession): void {
    this.sessions.set(session.id, structuredClone(session));
  }

  get(id: string): CheckoutSession | undefined {
    const stored = this.sessions.get(id);
    return stored && structuredClone(stored);
  }

  save(next: CheckoutSession, expectedVersion: number): boolean {
    const stored = this.sessions.get(next.id);
    if (!stored || stored.version !== expectedVersion) return false;
    this.sessions.set(next.id, structuredClone(next));
    return true;
  }
}
