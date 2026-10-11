import { useEffect, useState } from 'react';
import { getDevEvents, getDevStatus } from './api';
import type { AnalyticsEventView, ConversionMetric, DeviceGroupStats, DevEvents } from './api';
import { formatPrice } from './format';

export const EVENT_POLL_MS = 2000;
const MAX_ROWS = 100;

const PRICE_KEYS = new Set(['from', 'to']);

/** `crossDevice: true, minutesSinceCreate: 3.1`, with prices as dollars. */
export function formatEventProps(props: Record<string, unknown>): string {
  return Object.entries(props)
    .map(([key, value]) => `${key}: ${PRICE_KEYS.has(key) && typeof value === 'number' ? formatPrice(value) : String(value)}`)
    .join(', ');
}

const formatRate = (rate: number | null) => (rate === null ? '—' : `${Math.round(rate * 100)}%`);
const formatMedian = (minutes: number | null) => (minutes === null ? '—' : `${Number(minutes.toFixed(1))} min`);

function MetricRow({ label, testId, stats }: { label: string; testId: string; stats: DeviceGroupStats }) {
  return (
    <p className="event-metric-row" data-testid={testId}>
      <strong>{label}</strong>
      <span>
        {stats.sessions} {stats.sessions === 1 ? 'session' : 'sessions'}
      </span>
      <span>
        {stats.completed} of {stats.sessions} completed
      </span>
      <span>rate {formatRate(stats.conversionRate)}</span>
      <span>median {formatMedian(stats.medianMinutesToComplete)}</span>
    </p>
  );
}

export interface EventLogViewProps {
  events: readonly AnalyticsEventView[];
  metric: ConversionMetric;
}

/** The two conversion rows, then the events, newest first. */
export function EventLogView({ events, metric }: EventLogViewProps) {
  const newestFirst = events.slice(-MAX_ROWS).reverse();
  return (
    <section className="event-log" data-testid="event-log" aria-label="Analytics events">
      <h2 className="event-log-title">Analytics</h2>
      <div data-testid="event-metric">
        <MetricRow label="Cross-device" testId="metric-cross-device" stats={metric.crossDevice} />
        <MetricRow label="Single-device" testId="metric-single-device" stats={metric.singleDevice} />
      </div>
      {newestFirst.length === 0 ? (
        <p className="muted" data-testid="event-empty">
          No events yet.
        </p>
      ) : (
        <ol className="event-list" data-testid="event-list">
          {newestFirst.map((event, index) => (
            <li key={`${events.length - index}`} data-testid="event-row" data-event={event.name}>
              <span className="event-name">{event.name}</span>
              <span className="event-who muted">{event.source === 'system' ? 'system' : (event.surface ?? 'client')}</span>
              <span className="event-props">{formatEventProps(event.props)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const isDevEvents = (body: unknown): body is DevEvents =>
  typeof body === 'object' &&
  body !== null &&
  Array.isArray((body as DevEvents).events) &&
  typeof (body as DevEvents).metric === 'object';

/**
 * Server-side analytics for the demo, polled every 2 seconds. Renders nothing unless the server
 * says dev tools are on, so it never shows (or asks for events) against a normal server.
 */
export function EventLog() {
  const [data, setData] = useState<DevEvents>();

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const res = await getDevEvents();
        if (!cancelled && res.ok && isDevEvents(res.body)) setData(res.body);
      } catch {
        // Offline: keep the last list and try again.
      }
      if (!cancelled) timer = setTimeout(() => void poll(), EVENT_POLL_MS);
    };

    getDevStatus()
      .then((res) => {
        if (!cancelled && res.ok && res.body?.enabled) void poll();
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  return data ? <EventLogView events={data.events} metric={data.metric} /> : null;
}
