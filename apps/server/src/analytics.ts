import type { Surface } from '@checkout/shared';

/**
 * Server-side analytics. Events are emitted by `CheckoutService` at the point a state change is
 * saved (a lost compare-and-set emits nothing), never from the UI, so a client cannot fake an
 * event and one change cannot be counted twice.
 */

/** Payload per event name. Prices are integer cents. */
export interface AnalyticsEventProps {
  session_created: { listingId: string; surface: Surface };
  /** The first GET or stream connect per client per session. */
  session_resumed: { crossDevice: boolean; minutesSinceCreate: number };
  /** The first time a given client receives the session in `price_changed` for a given price. */
  price_change_shown: { from: number; to: number };
  price_change_accepted: { from: number; to: number };
  /** A price decrease applied silently by a re-evaluation. */
  price_change_auto_applied: { from: number; to: number };
  hold_expired: { source: EventSource };
  inventory_lost: { source: EventSource };
  completion_conflict: { code: 'VERSION_CONFLICT' | 'PAYMENT_IN_PROGRESS' | 'COMPLETED_ELSEWHERE' };
  payment_failed: { reason?: string };
  /** `crossDevice`: some client other than the origin resumed the session before it completed. */
  completed: { crossDevice: boolean; paidOnSurface: Surface | null };
}

export type AnalyticsEventName = keyof AnalyticsEventProps;

/** `client` when a client's request caused it, `system` for the scheduler and dev actions. */
export type EventSource = 'client' | 'system';

interface EventBase {
  sessionId: string;
  /** ISO time from the injected clock. */
  timestamp: string;
  source: EventSource;
  /** Present when `source` is `client`. */
  clientId?: string;
  surface?: Surface;
}

export type AnalyticsEvent = {
  [N in AnalyticsEventName]: EventBase & { name: N; props: AnalyticsEventProps[N] };
}[AnalyticsEventName];

/** Where events go. Swap the in-memory sink for a real provider by implementing this. */
export interface AnalyticsSink {
  track(event: AnalyticsEvent): void;
}

export class InMemoryAnalyticsSink implements AnalyticsSink {
  private events: AnalyticsEvent[] = [];

  track(event: AnalyticsEvent): void {
    this.events.push(structuredClone(event));
  }

  /** Every event so far, oldest first (copies). */
  list(): AnalyticsEvent[] {
    return structuredClone(this.events);
  }

  clear(): void {
    this.events = [];
  }
}

/** Call a sink without ever letting it break a request: a throw or a rejected promise is dropped. */
export function safeTrack(sink: AnalyticsSink, event: AnalyticsEvent): void {
  try {
    const result: unknown = sink.track(event);
    if (result instanceof Promise) result.catch(() => undefined);
  } catch {
    // Analytics must never fail checkout.
  }
}

export interface DeviceGroupStats {
  sessions: number;
  completed: number;
  /** completed / sessions (0..1), or null when there are no sessions. */
  conversionRate: number | null;
  /** Median minutes from create to complete over completed sessions, or null when none completed. */
  medianMinutesToComplete: number | null;
}

export interface ConversionByDevice {
  crossDevice: DeviceGroupStats;
  singleDevice: DeviceGroupStats;
}

const MS_PER_MINUTE = 60_000;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function summarize(group: Array<{ completed: boolean; minutes?: number }>): DeviceGroupStats {
  const completed = group.filter((s) => s.completed);
  return {
    sessions: group.length,
    completed: completed.length,
    conversionRate: group.length === 0 ? null : completed.length / group.length,
    medianMinutesToComplete: median(completed.flatMap((s) => (s.minutes === undefined ? [] : [s.minutes]))),
  };
}

/**
 * Conversion for sessions that moved between devices versus those that did not. Pure: a session
 * exists once it has a `session_created` event, counts as cross-device once any non-origin
 * client resumed it, and as completed once it has a `completed` event.
 */
export function conversionByDevice(events: readonly AnalyticsEvent[]): ConversionByDevice {
  const sessions = new Map<string, { createdAt: number; crossDevice: boolean; completedAt?: number }>();
  for (const event of events) {
    if (event.name === 'session_created') {
      sessions.set(event.sessionId, { createdAt: Date.parse(event.timestamp), crossDevice: false });
    }
  }
  for (const event of events) {
    const session = sessions.get(event.sessionId);
    if (!session) continue;
    if (event.name === 'session_resumed' && event.props.crossDevice) session.crossDevice = true;
    if (event.name === 'completed' && session.completedAt === undefined) session.completedAt = Date.parse(event.timestamp);
  }

  const cross: Array<{ completed: boolean; minutes?: number }> = [];
  const single: Array<{ completed: boolean; minutes?: number }> = [];
  for (const s of sessions.values()) {
    const row =
      s.completedAt === undefined
        ? { completed: false }
        : { completed: true, minutes: (s.completedAt - s.createdAt) / MS_PER_MINUTE };
    (s.crossDevice ? cross : single).push(row);
  }
  return { crossDevice: summarize(cross), singleDevice: summarize(single) };
}
