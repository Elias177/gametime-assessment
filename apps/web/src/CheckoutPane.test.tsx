// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CheckoutSession, Listing } from '@checkout/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientInfo } from './api';
import { CheckoutPane } from './CheckoutPane';
import { createPaneControls } from './paneControls';

const listing: Listing = {
  id: 'l1',
  eventName: 'The Midnight Orchestra',
  venue: 'Harbor Hall',
  date: '2030-06-14T19:30:00-07:00',
  section: 'Orchestra Left',
  row: 'F',
  seats: ['12'],
};

const makeSession = (overrides: Partial<CheckoutSession> = {}): CheckoutSession => ({
  id: 's1',
  listingId: 'l1',
  createdAt: '2030-01-01T00:00:00.000Z',
  originClientId: 'pane-a',
  originSurface: 'web',
  status: 'active',
  priceSnapshot: 10000,
  currentPrice: 10000,
  holdExpiresAt: new Date(Date.now() + 9 * 60 * 1000).toISOString(),
  version: 1,
  changes: [],
  ...overrides,
});

const CLIENT: ClientInfo = { clientId: 'pane-a', surface: 'web' };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A server whose session is `current`; POST /complete and /acknowledge answer with `after`. */
function installServer(current: CheckoutSession, after: CheckoutSession) {
  const posts: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push(path);
        return json(after);
      }
      if (path.startsWith('/api/listings/')) return json(listing);
      return json(current);
    }),
  );
  return posts;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CheckoutPane and the pane registry', () => {
  it('reports its status to the registry, and keeps it current', async () => {
    installServer(makeSession(), makeSession());
    const controls = createPaneControls();

    render(<CheckoutPane sessionId="s1" client={CLIENT} controls={controls} paneName="desktop" />);

    await waitFor(() => expect(controls.statusOf('desktop')).toBe('active'));
  });

  it('hands the registry the Pay action its button uses, so a scenario really pays', async () => {
    const posts = installServer(makeSession(), makeSession({ status: 'completed', version: 2, orderId: 'o-1' }));
    const controls = createPaneControls();
    render(<CheckoutPane sessionId="s1" client={CLIENT} controls={controls} paneName="desktop" />);
    await waitFor(() => expect(controls.statusOf('desktop')).toBe('active'));

    await controls.perform('desktop', 'pay');

    expect(posts).toEqual(['/api/sessions/s1/complete']);
    await waitFor(() => expect(controls.statusOf('desktop')).toBe('completed'));
  });

  it('hands it the Accept action too, which acknowledges the price', async () => {
    const changed = makeSession({ status: 'price_changed', currentPrice: 11200, version: 2 });
    const posts = installServer(changed, makeSession({ priceSnapshot: 11200, currentPrice: 11200, version: 3 }));
    const controls = createPaneControls();
    render(<CheckoutPane sessionId="s1" client={CLIENT} controls={controls} paneName="phone" />);
    await waitFor(() => expect(controls.statusOf('phone')).toBe('price_changed'));

    await controls.perform('phone', 'accept-price');

    expect(posts).toEqual(['/api/sessions/s1/acknowledge']);
    await waitFor(() => expect(controls.statusOf('phone')).toBe('active'));
  });

  it('reports a Pay a person pressed on its button, once the request is done, as the same event', async () => {
    const posts = installServer(makeSession(), makeSession({ status: 'completed', version: 2, orderId: 'o-1' }));
    const controls = createPaneControls();
    const heard: Array<[string, string]> = [];
    controls.onAction((name, op) => heard.push([name, op]));
    const { findByTestId } = render(<CheckoutPane sessionId="s1" client={CLIENT} controls={controls} paneName="phone" />);

    (await findByTestId('pay')).click();

    await waitFor(() => expect(heard).toEqual([['phone', 'pay']]));
    expect(posts).toEqual(['/api/sessions/s1/complete']);
  });

  it('reports an Accept a person pressed, and a Pay done through the registry, the same way', async () => {
    const changed = makeSession({ status: 'price_changed', currentPrice: 11200, version: 2 });
    installServer(changed, makeSession({ priceSnapshot: 11200, currentPrice: 11200, version: 3 }));
    const controls = createPaneControls();
    const heard: Array<[string, string]> = [];
    controls.onAction((name, op) => heard.push([name, op]));
    const { findByTestId } = render(<CheckoutPane sessionId="s1" client={CLIENT} controls={controls} paneName="desktop" />);

    (await findByTestId('accept-price')).click();
    await waitFor(() => expect(heard).toEqual([['desktop', 'accept-price']]));

    await controls.perform('desktop', 'pay');
    expect(heard).toEqual([['desktop', 'accept-price'], ['desktop', 'pay']]);
  });

  it('reports nothing for what is not Pay or Accept, such as starting again', async () => {
    const expired = makeSession({ status: 'expired', version: 2 });
    installServer(expired, makeSession({ id: 's2' }));
    const controls = createPaneControls();
    const heard: string[] = [];
    controls.onAction((name, op) => heard.push(`${name}:${op}`));
    const { findByTestId } = render(<CheckoutPane sessionId="s1" client={CLIENT} controls={controls} paneName="desktop" />);

    (await findByTestId('start-again')).click();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(heard).toEqual([]);
  });

  it('leaves the registry when it goes: no status, and nothing to press', async () => {
    installServer(makeSession(), makeSession());
    const controls = createPaneControls();
    const { unmount } = render(<CheckoutPane sessionId="s1" client={CLIENT} controls={controls} paneName="desktop" />);
    await waitFor(() => expect(controls.statusOf('desktop')).toBe('active'));

    unmount();

    expect(controls.statusOf('desktop')).toBeUndefined();
    await expect(controls.perform('desktop', 'pay')).rejects.toThrow('The desktop pane is not on the page');
  });

  it('does nothing with the registry when it is not given one (the real /resume page)', async () => {
    installServer(makeSession(), makeSession());

    const { findByTestId } = render(<CheckoutPane sessionId="s1" client={CLIENT} />);

    expect(await findByTestId('checkout-pane')).toBeTruthy();
  });
});

describe('CheckoutPane "Find other tickets"', () => {
  afterEach(() => window.history.pushState({}, '', '/'));

  function installUnavailableServer(devTools: boolean) {
    const posts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init?: RequestInit) => {
        if (path === '/api/dev/status') {
          return devTools ? json({ enabled: true, paymentBehavior: 'succeed', clockOffsetMs: 0 }) : json({}, 404);
        }
        if (init?.method === 'POST') {
          posts.push(path);
          return new Response(null, { status: 204 });
        }
        if (path.startsWith('/api/listings/')) return json(listing);
        return json(makeSession({ status: 'unavailable', version: 2 }));
      }),
    );
    return posts;
  }

  it('resets the demo before going back to the start when dev tools are on', async () => {
    const posts = installUnavailableServer(true);
    window.history.pushState({}, '', '/checkout/s1');
    render(<CheckoutPane sessionId="s1" client={CLIENT} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Find other tickets' }));

    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(posts).toEqual(['/api/dev/reset']);
  });

  it('just goes back to the start against a normal server', async () => {
    const posts = installUnavailableServer(false);
    window.history.pushState({}, '', '/checkout/s1');
    render(<CheckoutPane sessionId="s1" client={CLIENT} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Find other tickets' }));

    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(posts).toEqual([]);
  });
});
