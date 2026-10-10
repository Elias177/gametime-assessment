// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientInfo } from './api';
import { ChaosPanel, ChaosPanelView } from './ChaosPanel';
import type { ChaosPanelViewProps } from './ChaosPanel';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.pushState({}, '', '/');
});

function renderView(props: Partial<ChaosPanelViewProps> = {}) {
  const onAction = vi.fn();
  render(<ChaosPanelView paymentBehavior="succeed" result={null} busy={false} onAction={onAction} {...props} />);
  return onAction;
}

describe('ChaosPanelView', () => {
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

    for (const name of ['Expire hold', 'Price +$12', 'Price -$5', 'Sell out', 'succeed', 'fail', 'pending', 'Succeed', 'Fail', 'Reset demo']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
  });

  it('shows which payment behavior is active', () => {
    renderView({ paymentBehavior: 'pending' });

    expect(screen.getByTestId('chaos-behavior').textContent).toBe('Next payment: pending');
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

  it('collapses and expands, keeping the active behavior and the result visible', () => {
    renderView({ result: { ok: true, text: 'Sold out' } });

    fireEvent.click(screen.getByTestId('chaos-toggle'));
    expect(screen.queryByTestId('chaos-expire')).toBeNull();
    expect(screen.getByTestId('chaos-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('chaos-behavior').textContent).toContain('succeed');
    expect(screen.getByTestId('chaos-result').textContent).toBe('Sold out');

    fireEvent.click(screen.getByTestId('chaos-toggle'));
    expect(screen.getByTestId('chaos-expire')).toBeTruthy();
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
function installServer(options: { dev?: boolean; action?: (call: Call) => Response } = {}) {
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

describe('ChaosPanel', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/checkout/s1');
  });

  it('renders nothing unless the server reports dev tools', async () => {
    const calls = installServer({ dev: false });
    render(<ChaosPanel sessionId="s1" client={CLIENT} />);

    await waitFor(() => expect(calls.some((c) => c.path === '/api/dev/status')).toBe(true));
    expect(screen.queryByTestId('chaos-panel')).toBeNull();
    expect(calls.map((c) => c.path)).toEqual(['/api/dev/status']); // and asks for nothing else
  });

  it('renders nothing if the status request fails outright', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    render(<ChaosPanel sessionId="s1" client={CLIENT} />);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId('chaos-panel')).toBeNull();
  });

  it('sends each action to its endpoint, aimed at the current session and its listing', async () => {
    const calls = installServer();
    render(<ChaosPanel sessionId="s1" client={CLIENT} />);
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
    render(<ChaosPanel sessionId="s1" client={CLIENT} />);
    await screen.findByTestId('chaos-panel');

    fireEvent.click(screen.getByTestId('chaos-behavior-pending'));

    await waitFor(() => expect(screen.getByTestId('chaos-behavior').textContent).toBe('Next payment: pending'));
    expect(screen.getByTestId('chaos-result').textContent).toBe('Next payment will pending');
  });

  it("shows the server's error for a refused action", async () => {
    installServer({
      action: () => json(409, { error: { code: 'NOT_PAYMENT_PENDING', message: 'session is active, not payment_pending' } }),
    });
    render(<ChaosPanel sessionId="s1" client={CLIENT} />);
    await screen.findByTestId('chaos-panel');

    fireEvent.click(screen.getByTestId('chaos-settle-succeeded'));

    const result = await screen.findByTestId('chaos-result');
    expect(result.textContent).toBe('NOT_PAYMENT_PENDING: session is active, not payment_pending');
    expect(result.className).toContain('error');
  });

  it('says so when the server cannot be reached', async () => {
    installServer({ action: () => Promise.reject(new TypeError('offline')) as unknown as Response });
    render(<ChaosPanel sessionId="s1" client={CLIENT} />);
    await screen.findByTestId('chaos-panel');

    fireEvent.click(screen.getByTestId('chaos-expire'));

    expect((await screen.findByTestId('chaos-result')).textContent).toBe("Can't reach the server");
  });

  it('shows a result only briefly', async () => {
    installServer();
    render(<ChaosPanel sessionId="s1" client={CLIENT} />);
    await screen.findByTestId('chaos-panel');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    fireEvent.click(screen.getByTestId('chaos-sell-out'));
    await vi.waitFor(() => expect(screen.getByTestId('chaos-result').textContent).toBe('Sold out'));

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByTestId('chaos-result')).toBeNull();
  });

  it('Reset demo goes back to the start screen', async () => {
    const calls = installServer();
    render(<ChaosPanel sessionId="s1" client={CLIENT} />);
    await screen.findByTestId('chaos-panel');
    expect(window.location.pathname).toBe('/checkout/s1');

    fireEvent.click(screen.getByTestId('chaos-reset'));

    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(devCalls(calls).map((c) => c.path)).toEqual(['/api/dev/reset']);
  });

  it('does not navigate away when the reset fails', async () => {
    installServer({ action: () => json(500, { error: { code: 'BOOM', message: 'no' } }) });
    render(<ChaosPanel sessionId="s1" client={CLIENT} />);
    await screen.findByTestId('chaos-panel');

    fireEvent.click(screen.getByTestId('chaos-reset'));

    expect((await screen.findByTestId('chaos-result')).textContent).toBe('BOOM: no');
    expect(window.location.pathname).toBe('/checkout/s1');
  });
});
