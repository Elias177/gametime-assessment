// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientInfo } from './api';
import { ChaosPanel, ChaosPanelView, describeChaos, useChaos } from './ChaosPanel';
import type { ChaosPanelViewProps, ChaosResult } from './ChaosPanel';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.pushState({}, '', '/');
});

function renderView(props: Partial<ChaosPanelViewProps> = {}) {
  const onAction = vi.fn();
  render(<ChaosPanelView paymentBehavior="succeed" result={null} busy={false} paymentPending orderPlaced={false} onAction={onAction} {...props} />);
  return onAction;
}

describe('ChaosPanelView', () => {
  it('once the order is placed, slides the other groups away and keeps New Checkout', () => {
    renderView({ orderPlaced: true });
    const breakers = screen.getByTestId('chaos-breakers');
    expect(breakers.getAttribute('data-open')).toBe('false');
    expect(breakers.hasAttribute('inert')).toBe(true);
    expect(breakers.getAttribute('aria-hidden')).toBe('true');
    expect((screen.getByTestId('chaos-reset') as HTMLButtonElement).closest('fieldset')!.disabled).toBe(false);
  });

  it('shows the groups to break the session while the order is not placed', () => {
    renderView({ orderPlaced: false });
    const breakers = screen.getByTestId('chaos-breakers');
    expect(breakers.getAttribute('data-open')).toBe('true');
    expect(breakers.hasAttribute('inert')).toBe(false);
  });

  it('offers the settle buttons only while a payment is pending', () => {
    renderView({ paymentPending: false });
    const settle = screen.getByTestId('chaos-settle');
    expect(settle.getAttribute('data-open')).toBe('false');
    expect(settle.hasAttribute('inert')).toBe(true);
    expect(settle.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Succeed' })).toBeNull();
  });

  it('opens the settle buttons when a payment is pending', () => {
    renderView({ paymentPending: true });
    const settle = screen.getByTestId('chaos-settle');
    expect(settle.getAttribute('data-open')).toBe('true');
    expect(settle.hasAttribute('inert')).toBe(false);
    expect(screen.getByRole('button', { name: 'Succeed' })).toBeTruthy();
  });

  it.each([
    ['chaos-expire', { type: 'expire' }],
    ['chaos-price-up', { type: 'price', deltaCents: 1200 }],
    ['chaos-price-down', { type: 'price', deltaCents: -500 }],
    ['chaos-sell-out', { type: 'sell-out' }],
    ['chaos-behavior-succeed', { type: 'behavior', behavior: 'succeed' }],
    ['chaos-behavior-fail', { type: 'behavior', behavior: 'fail' }],
    ['chaos-behavior-pending', { type: 'behavior', behavior: 'pending' }],
    ['chaos-settle-succeeded', { type: 'settle', outcome: 'succeeded' }],
    ['chaos-settle-failed', { type: 'settle', outcome: 'failed' }],
    ['chaos-reset', { type: 'reset' }],
  ])('%s asks for %j', (testId, action) => {
    const onAction = renderView();

    fireEvent.click(screen.getByTestId(testId));

    expect(onAction).toHaveBeenCalledExactlyOnceWith(action);
  });

  it('labels the buttons as specified', () => {
    renderView();

    for (const name of ['Expire hold', 'Price +$12', 'Price -$5', 'Sell out', 'succeed', 'fail', 'pending', 'Succeed', 'Fail', 'New Checkout']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
  });

  it('shows which payment behavior is active', () => {
    renderView({ paymentBehavior: 'pending' });

    expect(screen.queryByTestId('chaos-behavior')).toBeNull(); // the status line lives under the drawer title
    expect(screen.getByTestId('chaos-behavior-pending').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('chaos-behavior-succeed').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('chaos-behavior-fail').getAttribute('aria-pressed')).toBe('false');
  });

  it('shows a success result as a status and an error as an alert', () => {
    renderView({ result: { ok: true, text: 'Hold expired' } });
    expect(screen.getByRole('status').textContent).toBe('Hold expired');

    cleanup();
    renderView({ result: { ok: false, text: 'NOT_PAYMENT_PENDING: session is active' } });
    expect(screen.getByRole('alert').textContent).toBe('NOT_PAYMENT_PENDING: session is active');
  });

  it('shows no result area when there is nothing to report', () => {
    renderView();
    expect(screen.queryByTestId('chaos-result')).toBeNull();
  });

  it('disables every action while one is in flight', () => {
    renderView({ busy: true });

    const buttons = screen.getAllByRole('button').filter((b) => b.dataset.testid !== 'chaos-toggle');
    expect(buttons.length).toBeGreaterThanOrEqual(10);
    for (const button of buttons) expect(button.matches(':disabled')).toBe(true); // via the disabled fieldset
  });

  it('groups the actions under their headings, with the reset marked as destructive', () => {
    renderView();

    const legends = screen.getAllByRole('group').map((g) => g.querySelector('legend')?.textContent);
    expect(legends).toEqual(['Break the session', 'Next payment', 'Settle pending', 'Demo']);
    expect(screen.getByTestId('chaos-reset').className).toContain('danger');
  });

  it('puts the result after every action button, so it never pushes them down', () => {
    renderView({ result: { ok: true, text: 'Sold out' } });

    const result = screen.getByTestId('chaos-result');
    for (const button of screen.getAllByRole('button')) {
      expect(button.compareDocumentPosition(result) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });
});

const CLIENT: ClientInfo = { clientId: 'pane-1', surface: 'web' };
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Call {
  path: string;
  method: string;
  body?: Record<string, unknown>;
}

/** Fake server: dev status, the session (for its listing) and an overridable dev action reply. */
function installServer(options: { dev?: boolean; action?: (call: Call) => Response; create?: (call: Call) => Response } = {}) {
  const calls: Call[] = [];
  let behavior = 'succeed';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      const call: Call = {
        path,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      };
      calls.push(call);
      if (path === '/api/dev/status') {
        return options.dev === false
          ? json(404, {})
          : json(200, { enabled: true, paymentBehavior: behavior, clockOffsetMs: 0 });
      }
      if (path === '/api/sessions/s1') return json(200, { id: 's1', listingId: 'l1' });
      if (path === '/api/sessions' && call.method === 'POST') {
        return options.create ? options.create(call) : json(201, { id: 's2', listingId: call.body?.listingId });
      }
      if (path.startsWith('/api/dev/')) {
        if (path === '/api/dev/payment-behavior') behavior = call.body!.behavior as string;
        return options.action ? options.action(call) : json(200, {});
      }
      return json(404, {});
    }),
  );
  return calls;
}

const devCalls = (calls: Call[]) => calls.filter((c) => c.method === 'POST');

/** The panel wired to the hook, the way the drawer does it. */
function ConnectedChaos() {
  return <ChaosPanel chaos={useChaos('s1', CLIENT)} paymentPending orderPlaced={false} />;
}

describe('useChaos', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/checkout/s1');
  });

  it('reports the next-payment behavior and keeps it current after changing it', async () => {
    installServer();
    const { result } = renderHook(() => useChaos('s1', CLIENT));
    expect(result.current.behavior).toBeUndefined();

    await waitFor(() => expect(result.current.behavior).toBe('succeed'));
    await act(async () => {
      await result.current.perform({ type: 'behavior', behavior: 'fail' });
    });

    expect(result.current.behavior).toBe('fail');
  });

  it('records the latest accepted action with a count that goes up, even for a repeat', async () => {
    installServer();
    const { result } = renderHook(() => useChaos('s1', CLIENT));
    await waitFor(() => expect(result.current.behavior).toBe('succeed'));
    expect(result.current.performed).toBeNull();

    await act(async () => void (await result.current.perform({ type: 'expire' })));
    expect(result.current.performed).toEqual({ action: { type: 'expire' }, seq: 1 });

    await act(async () => void (await result.current.perform({ type: 'expire' })));
    await act(async () => void (await result.current.perform({ type: 'behavior', behavior: 'fail' })));
    expect(result.current.performed).toEqual({ action: { type: 'behavior', behavior: 'fail' }, seq: 3 });
  });

  it('records nothing for an action the server refused or could not be reached for', async () => {
    installServer({ action: () => json(409, { error: { code: 'NOT_PAYMENT_PENDING', message: 'no' } }) });
    const { result } = renderHook(() => useChaos('s1', CLIENT));
    await waitFor(() => expect(result.current.behavior).toBe('succeed'));

    await act(async () => void (await result.current.perform({ type: 'settle', outcome: 'succeeded' })));

    expect(result.current.performed).toBeNull();
  });

  describe('newCheckout', () => {
    it("creates a session on this session's listing as this tab's client, and moves to it", async () => {
      const calls = installServer();
      const { result } = renderHook(() => useChaos('s1', CLIENT));
      await waitFor(() => expect(calls.some((c) => c.path === '/api/sessions/s1')).toBe(true));
      await waitFor(() => expect(result.current.behavior).toBe('succeed'));
      await new Promise((resolve) => setTimeout(resolve, 20)); // let the listing id arrive

      let outcome: ChaosResult | undefined;
      await act(async () => {
        outcome = await result.current.newCheckout();
      });

      expect(outcome).toEqual({ ok: true, text: 'New checkout started' });
      const created = calls.find((c) => c.path === '/api/sessions' && c.method === 'POST');
      expect(created?.body).toEqual({ listingId: 'l1' });
      expect(window.location.pathname).toBe('/checkout/s2');
    });

    it('does not reset anything: no dev action is sent, and nothing but the session is touched', async () => {
      const calls = installServer();
      const { result } = renderHook(() => useChaos('s1', CLIENT));
      await waitFor(() => expect(result.current.behavior).toBe('succeed'));

      await act(async () => void (await result.current.newCheckout()));

      expect(devCalls(calls).map((c) => c.path)).toEqual(['/api/sessions']);
      expect(result.current.performed).toBeNull(); // it is not a chaos action
      expect(result.current.result).toBeNull();
    });

    it('is busy while it works, and not afterwards', async () => {
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => (finish = resolve));
      const calls = installServer();
      const original = globalThis.fetch;
      vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
        if (path === '/api/sessions' && init?.method === 'POST') await gate;
        return original(path, init);
      });
      const { result } = renderHook(() => useChaos('s1', CLIENT));
      await waitFor(() => expect(result.current.behavior).toBe('succeed'));

      let pending!: Promise<ChaosResult>;
      act(() => {
        pending = result.current.newCheckout();
      });
      await waitFor(() => expect(result.current.busy).toBe(true));

      await act(async () => {
        finish();
        await pending;
      });
      expect(result.current.busy).toBe(false);
      expect(calls.length).toBeGreaterThan(0);
    });

    it('says the seats are sold out, with the way back, and stays on the current checkout', async () => {
      installServer({ create: () => json(409, { error: { code: 'SOLD_OUT', message: 'none left' } }) });
      const { result } = renderHook(() => useChaos('s1', CLIENT));
      await waitFor(() => expect(result.current.behavior).toBe('succeed'));

      let outcome: ChaosResult | undefined;
      await act(async () => {
        outcome = await result.current.newCheckout();
      });

      expect(outcome).toEqual({
        ok: false,
        text: 'The seats are sold out. Use New Checkout in the Actions tab to get them back.',
      });
      expect(window.location.pathname).toBe('/checkout/s1');
    });

    it('reports any other refusal, and an unreachable server, without moving', async () => {
      installServer({ create: () => json(500, { error: { code: 'BOOM', message: 'no' } }) });
      const { result } = renderHook(() => useChaos('s1', CLIENT));
      await waitFor(() => expect(result.current.behavior).toBe('succeed'));
      let outcome: ChaosResult | undefined;
      await act(async () => {
        outcome = await result.current.newCheckout();
      });
      expect(outcome).toEqual({ ok: false, text: 'Could not start a new checkout' });

      cleanup();
      installServer({ create: () => Promise.reject(new TypeError('offline')) as unknown as Response });
      const offline = renderHook(() => useChaos('s1', CLIENT));
      await waitFor(() => expect(offline.result.current.behavior).toBe('succeed'));
      await act(async () => {
        outcome = await offline.result.current.newCheckout();
      });
      expect(outcome).toEqual({ ok: false, text: "Can't reach the server" });
      expect(window.location.pathname).toBe('/checkout/s1');
    });
  });

  it('has no behavior, and asks for nothing else, when dev tools are off', async () => {
    const calls = installServer({ dev: false });
    const { result } = renderHook(() => useChaos('s1', CLIENT));

    await waitFor(() => expect(calls.some((c) => c.path === '/api/dev/status')).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.behavior).toBeUndefined();
    expect(calls.map((c) => c.path)).toEqual(['/api/dev/status']);
  });

  it('resolves perform with how it went: ok on success, the error when refused, unreachable on a network error', async () => {
    installServer();
    const { result } = renderHook(() => useChaos('s1', CLIENT));
    await waitFor(() => expect(result.current.behavior).toBe('succeed'));

    let outcome: ChaosResult | undefined;
    await act(async () => {
      outcome = await result.current.perform({ type: 'expire' });
    });
    expect(outcome).toEqual({ ok: true, text: 'Hold expired' });
    expect(result.current.result).toEqual(outcome);

    cleanup();
    installServer({ action: () => json(409, { error: { code: 'NOT_PAYMENT_PENDING', message: 'session is active' } }) });
    const refused = renderHook(() => useChaos('s1', CLIENT));
    await waitFor(() => expect(refused.result.current.behavior).toBe('succeed'));
    await act(async () => {
      outcome = await refused.result.current.perform({ type: 'settle', outcome: 'succeeded' });
    });
    expect(outcome).toEqual({ ok: false, text: 'NOT_PAYMENT_PENDING: session is active' });

    cleanup();
    installServer({ action: () => Promise.reject(new TypeError('offline')) as unknown as Response });
    const offline = renderHook(() => useChaos('s1', CLIENT));
    await waitFor(() => expect(offline.result.current.behavior).toBe('succeed'));
    await act(async () => {
      outcome = await offline.result.current.perform({ type: 'expire' });
    });
    expect(outcome).toEqual({ ok: false, text: "Can't reach the server" });
  });

});

describe('ChaosPanel', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/checkout/s1');
  });

  it('renders nothing unless the server reports dev tools', async () => {
    const calls = installServer({ dev: false });
    render(<ConnectedChaos />);

    await waitFor(() => expect(calls.some((c) => c.path === '/api/dev/status')).toBe(true));
    expect(screen.queryByTestId('chaos-panel')).toBeNull();
    expect(calls.map((c) => c.path)).toEqual(['/api/dev/status']); // and asks for nothing else
  });

  it('renders nothing if the status request fails outright', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    render(<ConnectedChaos />);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId('chaos-panel')).toBeNull();
  });

  it('sends each action to its endpoint, aimed at the current session and its listing', async () => {
    const calls = installServer();
    render(<ConnectedChaos />);
    await screen.findByTestId('chaos-panel');
    await waitFor(() => expect(calls.some((c) => c.path === '/api/sessions/s1')).toBe(true));

    const click = async (testId: string) => {
      fireEvent.click(screen.getByTestId(testId));
      await waitFor(() => expect((screen.getByTestId('chaos-expire') as HTMLButtonElement).disabled).toBe(false));
    };
    await click('chaos-expire');
    await click('chaos-price-up');
    await click('chaos-price-down');
    await click('chaos-sell-out');
    await click('chaos-behavior-fail');
    await click('chaos-settle-succeeded');
    await click('chaos-settle-failed');

    expect(devCalls(calls).map((c) => [c.path, c.body])).toEqual([
      ['/api/dev/expire/s1', {}],
      ['/api/dev/price', { listingId: 'l1', deltaCents: 1200 }],
      ['/api/dev/price', { listingId: 'l1', deltaCents: -500 }],
      ['/api/dev/sell-out', { listingId: 'l1' }],
      ['/api/dev/payment-behavior', { behavior: 'fail' }],
      ['/api/dev/settle/s1', { outcome: 'succeeded' }],
      ['/api/dev/settle/s1', { outcome: 'failed' }],
    ]);
  });

  it('shows the active behavior after changing it', async () => {
    installServer();
    render(<ConnectedChaos />);
    await screen.findByTestId('chaos-panel');

    fireEvent.click(screen.getByTestId('chaos-behavior-pending'));

    await waitFor(() => expect(screen.getByTestId('chaos-behavior-pending').getAttribute('aria-pressed')).toBe('true'));
    expect(screen.getByTestId('chaos-result').textContent).toBe('Next payment will pending');
  });

  it("shows the server's error for a refused action", async () => {
    installServer({
      action: () => json(409, { error: { code: 'NOT_PAYMENT_PENDING', message: 'session is active, not payment_pending' } }),
    });
    render(<ConnectedChaos />);
    await screen.findByTestId('chaos-panel');

    fireEvent.click(screen.getByTestId('chaos-settle-succeeded'));

    const result = await screen.findByTestId('chaos-result');
    expect(result.textContent).toBe('NOT_PAYMENT_PENDING: session is active, not payment_pending');
    expect(result.className).toContain('error');
  });

  it('says so when the server cannot be reached', async () => {
    installServer({ action: () => Promise.reject(new TypeError('offline')) as unknown as Response });
    render(<ConnectedChaos />);
    await screen.findByTestId('chaos-panel');

    fireEvent.click(screen.getByTestId('chaos-expire'));

    expect((await screen.findByTestId('chaos-result')).textContent).toBe("Can't reach the server");
  });

  it('shows a result only briefly', async () => {
    installServer();
    render(<ConnectedChaos />);
    await screen.findByTestId('chaos-panel');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    fireEvent.click(screen.getByTestId('chaos-sell-out'));
    await vi.waitFor(() => expect(screen.getByTestId('chaos-result').textContent).toBe('Sold out'));

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByTestId('chaos-result')).toBeNull();
  });

  it('New Checkout goes back to the start screen', async () => {
    const calls = installServer();
    render(<ConnectedChaos />);
    await screen.findByTestId('chaos-panel');
    expect(window.location.pathname).toBe('/checkout/s1');

    fireEvent.click(screen.getByTestId('chaos-reset'));

    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(devCalls(calls).map((c) => c.path)).toEqual(['/api/dev/reset']);
  });

  it('does not navigate away when the reset fails', async () => {
    installServer({ action: () => json(500, { error: { code: 'BOOM', message: 'no' } }) });
    render(<ConnectedChaos />);
    await screen.findByTestId('chaos-panel');

    fireEvent.click(screen.getByTestId('chaos-reset'));

    expect((await screen.findByTestId('chaos-result')).textContent).toBe('BOOM: no');
    expect(window.location.pathname).toBe('/checkout/s1');
  });
});

describe('describeChaos', () => {
  it('puts each action in words', () => {
    expect(describeChaos({ type: 'expire' })).toBe('expired the seat hold');
    expect(describeChaos({ type: 'price', deltaCents: 1200 })).toBe('raised the price by $12');
    expect(describeChaos({ type: 'price', deltaCents: -500 })).toBe('lowered the price by $5');
    expect(describeChaos({ type: 'sell-out' })).toBe('sold out the seats');
    expect(describeChaos({ type: 'behavior', behavior: 'pending' })).toBe('set the next payment to stay pending');
    expect(describeChaos({ type: 'behavior', behavior: 'succeed' })).toBe('set the next payment to succeed');
    expect(describeChaos({ type: 'settle', outcome: 'succeeded' })).toBe('made the pending payment succeed');
    expect(describeChaos({ type: 'settle', outcome: 'failed' })).toBe('made the pending payment fail');
    expect(describeChaos({ type: 'reset' })).toBe('reset the demo');
  });
});
