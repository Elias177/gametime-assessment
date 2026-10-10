import type { CancelTimer, Timers } from './timers';

export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/**
 * Dev-tools clock: real time plus an offset that `advance` pushes forward and `reset` clears.
 * It does not move any timers, so after a jump callers must re-evaluate sessions themselves.
 */
export class OffsetClock implements Clock {
  private offset = 0;

  constructor(private readonly base: Clock = new SystemClock()) {}

  now(): Date {
    return new Date(this.base.now().getTime() + this.offset);
  }

  /** How far this clock is ahead of the wrapped one. */
  get offsetMs(): number {
    return this.offset;
  }

  advance(ms: number): void {
    this.offset += ms;
  }

  reset(): void {
    this.offset = 0;
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
