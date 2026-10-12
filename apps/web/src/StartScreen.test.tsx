// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StartScreen } from './StartScreen';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

const soldOut = () => json(409, { error: { code: 'SOLD_OUT', message: 'sold out' } });

function stubServer({ devTools }: { devTools: boolean }) {
  let sold = true;
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url === '/api/dev/status') {
        return devTools ? json(200, { enabled: true, paymentBehavior: 'succeed', clockOffsetMs: 0 }) : json(404);
      }
      if (url === '/api/dev/reset') {
        sold = false;
        return json(204);
      }
      if (url === '/api/sessions') return sold ? soldOut() : json(201, { id: 'abc' });
      return json(404);
    }),
  );
  return calls;
}

describe('StartScreen when sold out', () => {
  it('offers a reset with dev tools on, and starting works again afterwards', async () => {
    stubServer({ devTools: true });
    render(<StartScreen />);

    fireEvent.click(screen.getByTestId('start-checkout'));
    await screen.findByTestId('start-error');
    fireEvent.click(await screen.findByTestId('start-reset'));
    await waitFor(() => expect(screen.queryByTestId('start-error')).toBeNull());

    fireEvent.click(screen.getByTestId('start-checkout'));
    await waitFor(() => expect(window.location.pathname).toBe('/checkout/abc'));
  });

  it('shows no reset against a normal server', async () => {
    const calls = stubServer({ devTools: false });
    render(<StartScreen />);

    fireEvent.click(screen.getByTestId('start-checkout'));
    await screen.findByTestId('start-error');

    expect(screen.queryByTestId('start-reset')).toBeNull();
    expect(calls).not.toContain('/api/dev/reset');
  });
});
