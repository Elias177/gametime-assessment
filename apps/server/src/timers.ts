export type CancelTimer = () => void;

/** One-shot timers, behind an interface so tests can drive time with `ManualClock`. */
export interface Timers {
  set(fn: () => void, delayMs: number): CancelTimer;
}

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export class SystemTimers implements Timers {
  set(fn: () => void, delayMs: number): CancelTimer {
    // Longer delays overflow setTimeout; the scheduler re-arms if it fires before the real deadline.
    const handle = setTimeout(fn, Math.min(Math.max(0, delayMs), MAX_TIMEOUT_MS));
    handle.unref();
    return () => clearTimeout(handle);
  }
}
