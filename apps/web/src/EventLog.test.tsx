// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsEventView, ConversionMetric } from './api';
import { EVENT_POLL_MS, EventLog, EventLogView, formatEventProps } from './EventLog';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const group = (sessions: number, completed: number, median: number | null = null) => ({
  sessions,
  completed,
  conversionRate: sessions === 0 ? null : completed / sessions,
  medianMinutesToComplete: median,
});

const metric = (cross = group(0, 0), single = group(0, 0)): ConversionMetric => ({
  crossDevice: cross,
  singleDevice: single,
});

const event = (name: string, props: Record<string, unknown>, who: Partial<AnalyticsEventView> = {}): AnalyticsEventView => ({
  name,
  sessionId: 's1',
  timestamp: '2030-01-01T00:00:00.000Z',
  source: 'client',
  clientId: 'c1',
  surface: 'web',
  props,
  ...who,
});

describe('EventLogView', () => {
  it('lists events newest first with name, surface and key props', () => {
    render(
      <EventLogView
        metric={metric()}
        events={[
          event('session_created', { listingId: 'demo-listing', surface: 'web' }),
          event('session_resumed', { crossDevice: true, minutesSinceCreate: 0.2 }, { surface: 'mobile' }),
          event('completed', { crossDevice: true, paidOnSurface: 'mobile' }, { surface: 'mobile' }),
        ]}
      />,
    );

    const rows = screen.getAllByTestId('event-row');
    expect(rows.map((r) => r.getAttribute('data-event'))).toEqual(['completed', 'session_resumed', 'session_created']);
    expect(rows[0]!.textContent).toContain('mobile');
    expect(rows[0]!.textContent).toContain('crossDevice: true, paidOnSurface: mobile');
    expect(rows[1]!.textContent).toContain('crossDevice: true, minutesSinceCreate: 0.2');
    expect(rows[2]!.textContent).toContain('web');
  });

  it('shows "system" for events with no client and formats prices as dollars', () => {
    render(
      <EventLogView
        metric={metric()}
        events={[event('price_change_shown', { from: 10000, to: 12500 }), event('hold_expired', { source: 'system' }, { source: 'system', clientId: undefined, surface: undefined })]}
      />,
    );

    const [expired, shown] = screen.getAllByTestId('event-row');
    expect(within(expired!).getByText('system', { selector: '.event-who' })).toBeTruthy();
    expect(shown!.textContent).toContain('from: $100.00, to: $125.00');
  });

  it('says so when there are no events', () => {
    render(<EventLogView metric={metric()} events={[]} />);

    expect(screen.getByTestId('event-empty').textContent).toBe('No events yet.');
    expect(screen.queryByTestId('event-row')).toBeNull();
  });

  it('shows the metric as two rows, above the events', () => {
    render(
      <EventLogView
        metric={metric(group(1, 1, 2.5), group(4, 1))}
        events={[event('session_created', { listingId: 'l' })]}
      />,
    );

    const cross = screen.getByTestId('metric-cross-device');
    const single = screen.getByTestId('metric-single-device');
    expect(cross.textContent).toContain('Cross-device');
    expect(cross.textContent).toContain('1 of 1 completed');
    expect(cross.textContent).toContain('rate 100%');
    expect(cross.textContent).toContain('median 2.5 min');
    expect(single.textContent).toContain('Single-device');
    expect(single.textContent).toContain('1 of 4 completed');
    expect(single.textContent).toContain('rate 25%');
    expect(single.textContent).toContain('median —');
    expect(screen.getByTestId('event-metric').compareDocumentPosition(screen.getByTestId('event-list'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('shows a dash instead of a rate when a group has no sessions', () => {
    render(<EventLogView metric={metric()} events={[]} />);

    expect(screen.getByTestId('metric-cross-device').textContent).toContain('0 of 0 completed');
    expect(screen.getByTestId('metric-cross-device').textContent).toContain('rate —');
  });
});

describe('formatEventProps', () => {
  it('prints keys and values in order', () => {
    expect(formatEventProps({ code: 'VERSION_CONFLICT' })).toBe('code: VERSION_CONFLICT');
    expect(formatEventProps({})).toBe('');
  });
});

describe('EventLog (polling)', () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  /** Resolve pending promises and let React commit. */
  const flush = () => act(async () => void (await Promise.resolve()));

  function stubFetch(devOn: boolean, bodies: Array<{ events: AnalyticsEventView[]; metric: ConversionMetric }>) {
    const paths: string[] = [];
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        paths.push(url);
        if (url === '/api/dev/status') {
          return devOn ? json({ enabled: true, paymentBehavior: 'succeed', clockOffsetMs: 0 }) : json({}, 404);
        }
        return json(bodies[Math.min(n++, bodies.length - 1)]);
      }),
    );
    return paths;
  }

  it('renders nothing and never asks for events when the dev status is off', async () => {
    vi.useFakeTimers();
    const paths = stubFetch(false, [{ events: [], metric: metric() }]);

    render(<EventLog />);
    await act(() => vi.advanceTimersByTimeAsync(EVENT_POLL_MS * 3));

    expect(screen.queryByTestId('event-log')).toBeNull();
    expect(paths).toEqual(['/api/dev/status']);
  });

  it('polls every 2 seconds and shows what the server sends', async () => {
    vi.useFakeTimers();
    const first = { events: [event('session_created', { listingId: 'l' })], metric: metric(group(0, 0), group(1, 0)) };
    const second = {
      events: [...first.events, event('session_resumed', { crossDevice: true, minutesSinceCreate: 1 }, { surface: 'mobile' })],
      metric: metric(group(1, 0), group(0, 0)),
    };
    const paths = stubFetch(true, [first, second]);

    render(<EventLog />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getAllByTestId('event-row')).toHaveLength(1);
    expect(paths.filter((p) => p === '/api/dev/events')).toHaveLength(1);

    await act(() => vi.advanceTimersByTimeAsync(EVENT_POLL_MS - 1));
    expect(paths.filter((p) => p === '/api/dev/events')).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(1));

    expect(paths.filter((p) => p === '/api/dev/events')).toHaveLength(2);
    expect(screen.getAllByTestId('event-row').map((r) => r.getAttribute('data-event'))).toEqual([
      'session_resumed',
      'session_created',
    ]);
    expect(screen.getByTestId('metric-cross-device').textContent).toContain('1 session');
  });

  it('stops polling when unmounted', async () => {
    vi.useFakeTimers();
    const paths = stubFetch(true, [{ events: [], metric: metric() }]);

    const { unmount } = render(<EventLog />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(EVENT_POLL_MS * 5));
    await flush();

    expect(paths.filter((p) => p === '/api/dev/events')).toHaveLength(1);
  });

  it('keeps the last list when a poll fails', async () => {
    vi.useFakeTimers();
    let fail = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/dev/status') return json({ enabled: true, paymentBehavior: 'succeed', clockOffsetMs: 0 });
        if (fail) throw new TypeError('offline');
        return json({ events: [event('session_created', { listingId: 'l' })], metric: metric() });
      }),
    );

    render(<EventLog />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    fail = true;
    await act(() => vi.advanceTimersByTimeAsync(EVENT_POLL_MS * 2));

    expect(screen.getAllByTestId('event-row')).toHaveLength(1);
  });
});
