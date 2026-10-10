// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { CheckoutSession, Listing } from '@checkout/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CheckoutView } from './CheckoutView';
import type { CheckoutViewProps } from './CheckoutView';

const listing: Listing = {
  id: 'l1',
  eventName: 'The Midnight Orchestra',
  venue: 'Harbor Hall, San Francisco',
  date: '2030-06-14T19:30:00-07:00',
  timeZone: 'America/Los_Angeles',
  section: 'Orchestra Left',
  row: 'F',
  seats: ['12', '13'],
};

const makeSession = (overrides: Partial<CheckoutSession> = {}): CheckoutSession => ({
  id: 's1',
  listingId: 'l1',
  status: 'active',
  priceSnapshot: 10000,
  currentPrice: 10000,
  holdExpiresAt: new Date(Date.now() + 9 * 60 * 1000).toISOString(),
  version: 1,
  changes: [],
  ...overrides,
});

function renderView(session: CheckoutSession, props: Partial<CheckoutViewProps> = {}) {
  const handlers = {
    onPay: vi.fn(),
    onAcceptPrice: vi.fn(),
    onStartAgain: vi.fn(),
    onBackToStart: vi.fn(),
  };
  render(
    <CheckoutView
      session={session}
      listing={listing}
      error={null}
      paidHere={false}
      connection="sse"
      busy={false}
      resumeUrl="https://example.test/resume/s1"
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

afterEach(cleanup);

describe('summary', () => {
  it('shows the event, venue, date, section, row and seats, the price, and the countdown', () => {
    renderView(makeSession());

    expect(screen.getByRole('heading', { name: 'The Midnight Orchestra' })).toBeTruthy();
    const summary = screen.getByTestId('listing').textContent!;
    expect(summary).toContain('Harbor Hall, San Francisco');
    // 19:30 in the venue's zone, whatever zone the viewer is in.
    expect(summary).toContain('Friday, June 14, 2030 at 7:30 PM');
    expect(summary).toContain('Section Orchestra Left, Row F, Seats 12, 13');
    expect(screen.getByTestId('price').textContent).toBe('$100.00');
    expect(screen.getByTestId('countdown').textContent).toMatch(/^Seats held for \d+:\d{2}$/);
  });

  it('shows the connection mode', () => {
    cleanup();
    renderView(makeSession(), { connection: 'polling' });
    expect(screen.getByTestId('connection').textContent).toContain('polling');
  });
});

describe('per-state UI', () => {
  it('active: Pay is enabled', () => {
    const { onPay } = renderView(makeSession());

    const pay = screen.getByTestId('pay') as HTMLButtonElement;
    expect(pay.disabled).toBe(false);
    fireEvent.click(pay);
    expect(onPay).toHaveBeenCalledOnce();
  });

  it('price_changed: shows old and new price, disables Pay, and Accept calls back', () => {
    const { onAcceptPrice, onPay } = renderView(
      makeSession({ status: 'price_changed', currentPrice: 12500, version: 2 }),
    );

    expect(screen.getByTestId('price-old').textContent).toBe('$100.00');
    expect(screen.getByTestId('price').textContent).toBe('$125.00');
    expect(screen.getByTestId('price-banner').textContent).toContain('from $100.00 to $125.00');
    expect((screen.getByTestId('pay') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Accept new price' }));
    expect(onAcceptPrice).toHaveBeenCalledOnce();
    expect(onPay).not.toHaveBeenCalled();
  });

  it('payment_pending: spinner, Pay locked', () => {
    renderView(makeSession({ status: 'payment_pending', version: 2 }));

    expect(screen.getByTestId('processing').textContent).toContain('Processing payment');
    expect((screen.getByTestId('pay') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('countdown')).toBeNull(); // the hold is pinned while paying
  });

  it('payment_pending: PAYMENT_IN_PROGRESS reads as another device paying', () => {
    renderView(makeSession({ status: 'payment_pending', version: 2 }), {
      error: { code: 'PAYMENT_IN_PROGRESS', message: 'a payment for this session is already in progress' },
    });

    expect(screen.getByTestId('error').textContent).toBe('A payment is already in progress on another device');
  });

  it('payment_failed: shows the reason and Try again calls onPay', () => {
    const { onPay } = renderView(makeSession({ status: 'payment_failed', version: 3 }), {
      error: { code: 'PAYMENT_FAILED', message: 'card_declined' },
    });

    expect(screen.getByTestId('payment-failed').textContent).toContain('card declined');
    expect(screen.queryByTestId('error')).toBeNull(); // not shown twice
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onPay).toHaveBeenCalledOnce();
  });

  it('payment_failed without a known reason still explains itself', () => {
    renderView(makeSession({ status: 'payment_failed', version: 3 }));

    expect(screen.getByTestId('payment-failed').textContent).toContain("Your payment didn't go through.");
  });

  it('expired: "Your hold ran out" and Start again calls back', () => {
    const { onStartAgain } = renderView(makeSession({ status: 'expired', version: 2 }));

    expect(screen.getByTestId('expired').textContent).toContain('Your hold ran out');
    fireEvent.click(screen.getByRole('button', { name: 'Start again' }));
    expect(onStartAgain).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('pay')).toBeNull();
    expect(screen.queryByTestId('continue-on-phone')).toBeNull();
  });

  it('unavailable: a dead end with a way back', () => {
    const { onBackToStart } = renderView(makeSession({ status: 'unavailable', version: 2 }));

    expect(screen.getByTestId('unavailable').textContent).toContain('These seats are no longer available');
    expect(screen.queryByTestId('pay')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Find other tickets' }));
    expect(onBackToStart).toHaveBeenCalledOnce();
  });

  it('completed here: order confirmation with the order id', () => {
    renderView(makeSession({ status: 'completed', version: 4, orderId: 'order-123' }), { paidHere: true });

    expect(screen.getByTestId('confirmation').textContent).toContain('Order confirmed');
    expect(screen.getByTestId('order-id').textContent).toBe('order-123');
  });

  it('completed elsewhere: says so instead of confirming', () => {
    renderView(makeSession({ status: 'completed', version: 4, orderId: 'order-123' }), { paidHere: false });

    expect(screen.getByTestId('completed-elsewhere').textContent).toContain('Completed on another device');
    expect(screen.queryByTestId('confirmation')).toBeNull();
  });

  it('hides a stale error once the session is finished', () => {
    renderView(makeSession({ status: 'completed', version: 4, orderId: 'o' }), {
      error: { code: 'PAYMENT_IN_PROGRESS', message: 'x' },
    });

    expect(screen.queryByTestId('error')).toBeNull();
  });

  it('describes a version conflict and a network error in plain words', () => {
    renderView(makeSession(), { error: { code: 'VERSION_CONFLICT', message: 'x' } });
    expect(screen.getByTestId('error').textContent).toContain('just changed');

    cleanup();
    renderView(makeSession(), { error: { code: 'NETWORK_ERROR', message: 'x' } });
    expect(screen.getByTestId('error').textContent).toContain("won't be charged twice");
  });

  it('disables actions while a request is in flight', () => {
    renderView(makeSession(), { busy: true });

    expect((screen.getByTestId('pay') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('continue on phone', () => {
  it('reveals the resume link and copies it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderView(makeSession());

    expect(screen.queryByTestId('phone-link')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Continue on phone' }));

    const field = within(screen.getByTestId('phone-link')).getByRole('textbox') as HTMLInputElement;
    expect(field.value).toBe('https://example.test/resume/s1');

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('https://example.test/resume/s1');
    expect(await screen.findByRole('button', { name: 'Copied!' })).toBeTruthy();
  });
});
