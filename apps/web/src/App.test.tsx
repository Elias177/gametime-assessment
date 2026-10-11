// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { CheckoutSession, Listing, ResumeInitialState } from '@checkout/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const listing: Listing = {
  id: 'l1',
  eventName: 'The Midnight Orchestra',
  venue: 'Harbor Hall',
  date: '2030-06-14T19:30:00-07:00',
  section: 'Orchestra Left',
  row: 'F',
  seats: ['12'],
};

const session: CheckoutSession = {
  id: 's1',
  listingId: 'l1',
  createdAt: '2030-01-01T00:00:00.000Z',
  originClientId: 'origin-client',
  originSurface: 'web',
  status: 'active',
  priceSnapshot: 10000,
  currentPrice: 10000,
  holdExpiresAt: new Date(Date.now() + 9 * 60 * 1000).toISOString(),
  version: 1,
  changes: [],
};

class FakeEventSource {
  static urls: string[] = [];
  onerror: (() => void) | null = null;
  constructor(url: string) {
    FakeEventSource.urls.push(url);
  }
  addEventListener() {}
  close() {}
}

let requests: Array<{ path: string; clientId?: string; surface?: string }> = [];
/** Hold the live GET /api/sessions/:id, to look at the page before the server has answered. */
let sessionGate: Promise<void> | undefined;
let sessionOverrides: Partial<CheckoutSession> = {};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

function open(
  path: string,
  originClientId = session.originClientId,
  devTools = false,
  initialState?: ResumeInitialState,
) {
  window.history.pushState({}, '', path);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({ path: url, clientId: headers['X-Client-Id'], surface: headers['X-Surface'] });
      if (url === '/api/dev/status') {
        return devTools
          ? json({ enabled: true, paymentBehavior: 'succeed', clockOffsetMs: 0 })
          : new Response('{}', { status: 404 });
      }
      if (url === '/api/dev/events') {
        const empty = { sessions: 0, completed: 0, conversionRate: null, medianMinutesToComplete: null };
        return json({ events: [], metric: { crossDevice: empty, singleDevice: empty } });
      }
      if (url.startsWith('/api/listings/')) return json(listing);
      await sessionGate;
      return json({ ...session, originClientId, ...sessionOverrides });
    }),
  );
  return render(<App initialState={initialState} />);
}

beforeEach(() => {
  requests = [];
  sessionGate = undefined;
  sessionOverrides = {};
  FakeEventSource.urls = [];
  sessionStorage.clear();
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('/checkout/:id split-screen demo', () => {
  it('shows a desktop pane and a phone-frame pane for the same session', async () => {
    open('/checkout/s1');

    const desktop = await screen.findByTestId('desktop-pane');
    const phone = screen.getByTestId('phone-pane');
    await within(desktop).findByTestId('continue-on-phone'); // the desktop layout
    await within(phone).findByTestId('origin-label'); // the phone layout
    expect(within(phone).queryByTestId('continue-on-phone')).toBeNull();
    expect(within(desktop).queryByTestId('origin-label')).toBeNull();
  });

  it('gives each pane its own client id and surface on every request, SSE included', async () => {
    open('/checkout/s1');
    await screen.findByTestId('phone-pane');
    await waitFor(() => expect(FakeEventSource.urls).toHaveLength(2));

    const sessionFetches = requests.filter((r) => r.path === '/api/sessions/s1');
    expect(sessionFetches).toHaveLength(2);
    const web = sessionFetches.find((r) => r.surface === 'web')!;
    const mobile = sessionFetches.find((r) => r.surface === 'mobile')!;
    expect(web.clientId).toBeTruthy();
    expect(mobile.clientId).toBeTruthy();
    expect(web.clientId).not.toBe(mobile.clientId);

    // Every request from a pane carries that pane's identity, and nothing is anonymous.
    for (const r of requests.filter((r) => !r.path.startsWith('/api/dev/'))) expect([r.path, r.clientId && r.surface]).toEqual([r.path, expect.any(String)]);
    expect(FakeEventSource.urls.sort()).toEqual(
      [
        `/api/sessions/s1/events?clientId=${web.clientId}&surface=web`,
        `/api/sessions/s1/events?clientId=${mobile.clientId}&surface=mobile`,
      ].sort(),
    );
  });

  it('reads "Opened from link" on the phone even in the tab that started the checkout', async () => {
    // The desktop (this tab) started it; the simulated phone is a different client.
    sessionStorage.setItem('checkout.clientId', 'origin-client');
    open('/checkout/s1');

    const phone = await screen.findByTestId('phone-pane');
    expect((await within(phone).findByTestId('origin-label')).textContent).toBe('Opened from link');
  });
});

describe('chaos panel placement', () => {
  it('shows under the split demo when the server has dev tools on', async () => {
    open('/checkout/s1', session.originClientId, true);

    expect(await screen.findByTestId('chaos-panel')).toBeTruthy();
    expect(screen.getByTestId('chaos-behavior').textContent).toBe('Next payment: succeed');
  });

  it('is absent when the server has dev tools off', async () => {
    open('/checkout/s1');
    await screen.findByTestId('phone-pane');
    await waitFor(() => expect(requests.some((r) => r.path === '/api/dev/status')).toBe(true));

    expect(screen.queryByTestId('chaos-panel')).toBeNull();
  });

  it('is not on /resume, which does not even ask for it', async () => {
    open('/resume/s1', session.originClientId, true);
    await screen.findByTestId('origin-label');

    expect(screen.queryByTestId('chaos-panel')).toBeNull();
    expect(requests.some((r) => r.path.startsWith('/api/dev/'))).toBe(false);
  });
});

describe('event log placement', () => {
  it('shows under the chaos panel when the server has dev tools on', async () => {
    open('/checkout/s1', session.originClientId, true);

    const log = await screen.findByTestId('event-log');
    const chaos = screen.getByTestId('chaos-panel');
    expect(chaos.compareDocumentPosition(log) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(requests.some((r) => r.path === '/api/dev/events')).toBe(true);
  });

  it('is absent, and never asks for events, when the server has dev tools off', async () => {
    open('/checkout/s1');
    await screen.findByTestId('phone-pane');
    await waitFor(() => expect(requests.some((r) => r.path === '/api/dev/status')).toBe(true));

    expect(screen.queryByTestId('event-log')).toBeNull();
    expect(requests.some((r) => r.path === '/api/dev/events')).toBe(false);
  });

  it('is not on /resume', async () => {
    open('/resume/s1', session.originClientId, true);
    await screen.findByTestId('origin-label');

    expect(screen.queryByTestId('event-log')).toBeNull();
    expect(requests.some((r) => r.path.startsWith('/api/dev/'))).toBe(false);
  });
});

describe('/resume/:id starting from a pre-rendered page', () => {
  const prerendered: ResumeInitialState = { session, listing };

  it('shows the real mobile view at once, with the price labelled, and no loading state', async () => {
    let release!: () => void;
    sessionGate = new Promise<void>((resolve) => (release = resolve));
    open('/resume/s1', session.originClientId, false, prerendered);

    // Synchronously after the first render: nothing waits for the network.
    expect(screen.queryByText('Loading your checkout…')).toBeNull();
    expect(screen.getByTestId('origin-label').textContent).toBe('Opened from link');
    expect(screen.getByRole('heading', { name: 'The Midnight Orchestra' })).toBeTruthy();
    expect(screen.getByTestId('price').textContent).toBe('$100.00');
    expect(screen.getByTestId('confirming-price').textContent).toBe('Confirming price…');
    expect((screen.getByTestId('pay') as HTMLButtonElement).disabled).toBe(true);

    release();
    await waitFor(() => expect(screen.queryByTestId('confirming-price')).toBeNull());
    expect((screen.getByTestId('pay') as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not fetch the listing, but does fetch the session and open the stream', async () => {
    open('/resume/s1', session.originClientId, false, prerendered);

    await waitFor(() => expect(FakeEventSource.urls).toHaveLength(1));
    expect(requests.filter((r) => r.path === '/api/sessions/s1')).toHaveLength(1);
    expect(requests.some((r) => r.path.startsWith('/api/listings/'))).toBe(false);
  });

  it('hands over to the normal UI when the live session differs', async () => {
    let release!: () => void;
    sessionGate = new Promise<void>((resolve) => (release = resolve));
    sessionOverrides = { status: 'price_changed', currentPrice: 11200, version: 2 };
    open('/resume/s1', session.originClientId, false, prerendered);
    expect(screen.queryByRole('dialog')).toBeNull(); // the pre-rendered state was just "active"

    release();

    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByTestId('price-banner').textContent).toContain('from $100.00 to $112.00');
    expect(screen.queryByTestId('confirming-price')).toBeNull();
  });

  it('shows the dead end when the live session has since expired', async () => {
    sessionOverrides = { status: 'expired', version: 2 };
    open('/resume/s1', session.originClientId, false, prerendered);

    expect((await screen.findByTestId('expired')).textContent).toContain('Your hold ran out');
    expect(screen.queryByTestId('confirming-price')).toBeNull();
  });

  it('is only for /resume: the split demo ignores it and loads normally', async () => {
    sessionGate = new Promise(() => undefined);
    open('/checkout/s1', session.originClientId, false, prerendered);

    expect((await screen.findAllByText('Loading your checkout…')).length).toBe(2); // both panes, as before
    expect(screen.queryByTestId('confirming-price')).toBeNull();
  });

  it('ignores a pre-rendered state for another session', async () => {
    sessionGate = new Promise(() => undefined);
    open('/resume/s1', session.originClientId, false, { session: { ...session, id: 'other' }, listing });

    expect(await screen.findByText('Loading your checkout…')).toBeTruthy();
  });
});

describe('/resume/:id on a second device', () => {
  it('renders only the mobile view', async () => {
    open('/resume/s1');

    expect(await screen.findByTestId('origin-label')).toBeTruthy();
    expect(screen.getAllByTestId('checkout-pane')).toHaveLength(1);
    expect(screen.queryByTestId('desktop-pane')).toBeNull();
    expect(screen.queryByTestId('phone-pane')).toBeNull();
    expect(screen.queryByTestId('continue-on-phone')).toBeNull();
    expect(new Set(requests.map((r) => r.surface))).toEqual(new Set(['mobile']));
  });

  it('says "Opened from link" for a device that did not start the checkout', async () => {
    open('/resume/s1');

    expect((await screen.findByTestId('origin-label')).textContent).toBe('Opened from link');
  });

  it('says "Started on this device" when this device\'s id is the session\'s origin', async () => {
    sessionStorage.setItem('checkout.clientId', 'origin-client');
    open('/resume/s1');

    expect((await screen.findByTestId('origin-label')).textContent).toBe('Started on this device');
  });

  it('keeps the same client id when it re-renders', async () => {
    const { rerender } = open('/resume/s1');
    await screen.findByTestId('origin-label');
    rerender(<App />);

    expect(new Set(requests.map((r) => r.clientId)).size).toBe(1);
  });
});
