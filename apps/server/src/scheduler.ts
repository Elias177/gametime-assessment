import { isTerminalStatus } from '@checkout/shared';
import type { CheckoutSession } from '@checkout/shared';
import type { Clock } from './clock';
import type { SessionStore } from './store';
import type { CancelTimer, Timers } from './timers';

interface Tracked {
  unsubscribe: () => void;
  cancelTimer?: CancelTimer;
}

/**
 * Session state only changes when `refresh()` runs, so nothing would notice a lapsed hold on a
 * session nobody is polling. This calls `refreshById` at each tracked session's `holdExpiresAt`,
 * re-arms whenever the session changes, and drops the session once it is finished.
 */
export class ExpiryScheduler {
  private readonly tracked = new Map<string, Tracked>();

  constructor(
    private readonly deps: { store: SessionStore; clock: Clock; timers: Timers },
    private readonly refreshById: (id: string) => Promise<CheckoutSession | undefined>,
  ) {}

  /** Sessions currently being watched. */
  get size(): number {
    return this.tracked.size;
  }

  track(session: CheckoutSession): void {
    if (this.tracked.has(session.id) || isTerminalStatus(session.status)) return;
    const unsubscribe = this.deps.store.subscribe(session.id, (changed) => this.onChange(changed));
    this.tracked.set(session.id, { unsubscribe });
    this.arm(session);
  }

  /** Stop watching everything and cancel every timer (dev reset). */
  clear(): void {
    for (const id of [...this.tracked.keys()]) this.untrack(id);
  }

  private onChange(session: CheckoutSession): void {
    if (isTerminalStatus(session.status)) this.untrack(session.id);
    else this.arm(session);
  }

  private untrack(id: string): void {
    const entry = this.tracked.get(id);
    if (!entry) return;
    entry.cancelTimer?.();
    entry.unsubscribe();
    this.tracked.delete(id);
  }

  private arm(session: CheckoutSession, minDelayMs = 0): void {
    const entry = this.tracked.get(session.id);
    if (!entry) return;
    entry.cancelTimer?.();
    entry.cancelTimer = undefined;

    // A pending payment pins the hold, so nothing time-based can happen until it settles
    // (which saves the session and re-arms us).
    if (session.status === 'payment_pending') return;

    const delay = Math.max(minDelayMs, Date.parse(session.holdExpiresAt) - this.deps.clock.now().getTime());
    entry.cancelTimer = this.deps.timers.set(() => void this.fire(session.id), delay);
  }

  private async fire(id: string): Promise<void> {
    const entry = this.tracked.get(id);
    if (!entry) return;
    entry.cancelTimer = undefined;

    const latest = await this.refreshById(id).catch(() => undefined);
    // A change re-arms us through the store. If nothing changed (timer fired a hair early, or a
    // clamped long delay), arm again ourselves; the 1ms floor prevents a hot loop.
    const current = this.tracked.get(id);
    if (latest && current && !current.cancelTimer && !isTerminalStatus(latest.status)) this.arm(latest, 1);
  }
}
