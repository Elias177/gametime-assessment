import type { CancelTimer, Timers } from './timers';

export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

interface PendingTimer {
  at: number;
  fn: () => void;
}

/** Test clock: time only moves when told to, and `advance` fires any timers that fall due. */
export class ManualClock implements Clock, Timers {
  private current: Date;
  private pending: PendingTimer[] = [];

  constructor(start: Date | string = '2030-01-01T00:00:00.000Z') {
    this.current = new Date(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  /** Timers not yet fired or cancelled. */
  get pendingTimerCount(): number {
    return this.pending.length;
  }

  set(fn: () => void, delayMs: number): CancelTimer {
    const timer: PendingTimer = { at: this.current.getTime() + Math.max(0, delayMs), fn };
    this.pending.push(timer);
    return () => {
      this.pending = this.pending.filter((t) => t !== timer);
    };
  }

  /** Move time forward, firing due timers in order. `advance(0)` fires zero-delay timers. */
  advance(ms: number): void {
    const target = this.current.getTime() + ms;
    for (;;) {
      const due = this.pending.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.pending = this.pending.filter((t) => t !== due);
      this.current = new Date(Math.max(this.current.getTime(), due.at));
      due.fn();
    }
    this.current = new Date(target);
  }
}
