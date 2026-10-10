// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { CheckoutSession, Listing } from '@checkout/shared';
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

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

function open(path: string, originClientId = session.originClientId) {
  window.history.pushState({}, '', path);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({ path: url, clientId: headers['X-Client-Id'], surface: headers['X-Surface'] });
      return url.startsWith('/api/listings/') ? json(listing) : json({ ...session, originClientId });
    }),
  );
  return render(<App />);
}

beforeEach(() => {
  requests = [];
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
    for (const r of requests) expect([r.path, r.clientId && r.surface]).toEqual([r.path, expect.any(String)]);
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
