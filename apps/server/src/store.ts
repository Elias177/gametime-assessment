import type { CheckoutSession } from '@checkout/shared';

export type SessionListener = (session: CheckoutSession) => void;

export interface SessionStore {
  create(session: CheckoutSession): void;
  get(id: string): CheckoutSession | undefined;
  /**
   * Compare-and-set on `version`: writes `next` only if the stored session is
   * still at `expectedVersion`. Returns false when someone else got there first.
   */
  save(next: CheckoutSession, expectedVersion: number): boolean;
  /**
   * Call `listener` with a copy of the session after every successful `create` or `save` of
   * session `id`. Returns the unsubscribe function. Implementations may be backed by anything
   * (pub/sub, change streams) as long as they keep this contract.
   */
  subscribe(id: string, listener: SessionListener): () => void;
  /** Every stored session (copies), in creation order. Used by dev tools to find sessions. */
  list(): CheckoutSession[];
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, CheckoutSession>();
  private readonly listeners = new Map<string, Set<SessionListener>>();

  create(session: CheckoutSession): void {
    this.sessions.set(session.id, structuredClone(session));
    this.emit(session);
  }

  get(id: string): CheckoutSession | undefined {
    const stored = this.sessions.get(id);
    return stored && structuredClone(stored);
  }

  save(next: CheckoutSession, expectedVersion: number): boolean {
    const stored = this.sessions.get(next.id);
    if (!stored || stored.version !== expectedVersion) return false;
    this.sessions.set(next.id, structuredClone(next));
    this.emit(next);
    return true;
  }

  subscribe(id: string, listener: SessionListener): () => void {
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, (set = new Set()));
    const subscribed = set;
    subscribed.add(listener);
    return () => {
      subscribed.delete(listener);
      if (subscribed.size === 0 && this.listeners.get(id) === subscribed) this.listeners.delete(id);
    };
  }

  list(): CheckoutSession[] {
    return [...this.sessions.values()].map((session) => structuredClone(session));
  }

  /** Forget every session (dev reset). Subscriptions stay, so a stream can still see a recreated id. */
  clear(): void {
    this.sessions.clear();
  }

  /** Open subscriptions for a session; lets tests check that disconnects clean up. */
  listenerCount(id: string): number {
    return this.listeners.get(id)?.size ?? 0;
  }

  private emit(session: CheckoutSession): void {
    for (const listener of [...(this.listeners.get(session.id) ?? [])]) {
      try {
        listener(structuredClone(session));
      } catch {
        // A broken subscriber must not fail the write that triggered it.
      }
    }
  }
}
