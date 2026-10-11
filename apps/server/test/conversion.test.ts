import { describe, expect, it } from 'vitest';
import { conversionByDevice } from '../src/analytics';
import type { AnalyticsEvent } from '../src/analytics';

const T0 = Date.parse('2030-01-01T00:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

const created = (sessionId: string, minute: number): AnalyticsEvent => ({
  name: 'session_created',
  sessionId,
  timestamp: at(minute),
  source: 'client',
  clientId: 'laptop',
  surface: 'web',
  props: { listingId: 'l', surface: 'web' },
});

const resumed = (sessionId: string, minute: number, crossDevice: boolean): AnalyticsEvent => ({
  name: 'session_resumed',
  sessionId,
  timestamp: at(minute),
  source: 'client',
  clientId: crossDevice ? 'phone' : 'laptop',
  surface: crossDevice ? 'mobile' : 'web',
  props: { crossDevice, minutesSinceCreate: 0 },
});

const completed = (sessionId: string, minute: number): AnalyticsEvent => ({
  name: 'completed',
  sessionId,
  timestamp: at(minute),
  source: 'client',
  props: { crossDevice: false, paidOnSurface: 'web' },
});

describe('conversionByDevice', () => {
  it('returns empty groups for no events', () => {
    const empty = { sessions: 0, completed: 0, conversionRate: null, medianMinutesToComplete: null };
    expect(conversionByDevice([])).toEqual({ crossDevice: empty, singleDevice: empty });
  });

  it('counts a session with no completion as a session and not as a conversion', () => {
    const result = conversionByDevice([created('a', 0), resumed('a', 1, true), created('b', 0)]);

    expect(result.crossDevice).toEqual({ sessions: 1, completed: 0, conversionRate: 0, medianMinutesToComplete: null });
    expect(result.singleDevice).toEqual({ sessions: 1, completed: 0, conversionRate: 0, medianMinutesToComplete: null });
  });

  it('splits sessions by whether a non-origin client resumed them', () => {
    const result = conversionByDevice([
      created('cross-1', 0),
      resumed('cross-1', 2, true),
      completed('cross-1', 5),
      created('cross-2', 0),
      resumed('cross-2', 2, true),
      created('single-1', 0),
      resumed('single-1', 1, false), // the origin coming back is not cross-device
      completed('single-1', 3),
      created('single-2', 0),
      created('single-3', 0),
      completed('single-3', 1),
      created('single-4', 0),
    ]);

    expect(result.crossDevice).toEqual({ sessions: 2, completed: 1, conversionRate: 0.5, medianMinutesToComplete: 5 });
    expect(result.singleDevice).toEqual({ sessions: 4, completed: 2, conversionRate: 0.5, medianMinutesToComplete: 2 });
  });

  it('counts a session as cross-device once any non-origin client resumed it, even after other resumes', () => {
    const result = conversionByDevice([
      created('a', 0),
      resumed('a', 1, false),
      resumed('a', 2, true),
      resumed('a', 3, false),
      completed('a', 4),
    ]);

    expect(result.crossDevice.sessions).toBe(1);
    expect(result.singleDevice.sessions).toBe(0);
  });

  it('takes the median completion time: the middle value, or the mean of the middle two', () => {
    const odd = conversionByDevice([
      created('a', 0), completed('a', 1),
      created('b', 0), completed('b', 9),
      created('c', 0), completed('c', 4),
    ]);
    expect(odd.singleDevice.medianMinutesToComplete).toBe(4);

    const even = conversionByDevice([
      created('a', 0), completed('a', 1),
      created('b', 0), completed('b', 9),
    ]);
    expect(even.singleDevice.medianMinutesToComplete).toBe(5);
  });

  it('measures from the session creation, not from the first event in the list, and ignores event order', () => {
    const result = conversionByDevice([completed('a', 12.5), resumed('a', 3, true), created('a', 2.5)]);

    expect(result.crossDevice.medianMinutesToComplete).toBe(10);
  });

  it('counts a session once even if it somehow has two completed events', () => {
    const result = conversionByDevice([created('a', 0), completed('a', 2), completed('a', 9)]);

    expect(result.singleDevice).toEqual({ sessions: 1, completed: 1, conversionRate: 1, medianMinutesToComplete: 2 });
  });

  it('ignores events of sessions it never saw created', () => {
    const result = conversionByDevice([resumed('ghost', 1, true), completed('ghost', 2)]);

    expect(result.crossDevice.sessions).toBe(0);
    expect(result.singleDevice.sessions).toBe(0);
  });
});
