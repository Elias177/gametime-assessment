// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { CheckoutSession, Listing } from '@checkout/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobileCheckoutView } from './MobileCheckoutView';
import type { MobileCheckoutViewProps } from './MobileCheckoutView';

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
  createdAt: '2030-01-01T00:00:00.000Z',
  originClientId: 'client-a',
  originSurface: 'web',
  status: 'active',
  priceSnapshot: 10000,
  currentPrice: 10000,
  holdExpiresAt: new Date(Date.now() + 9 * 60 * 1000).toISOString(),
  version: 1,
  changes: [],
  ...overrides,
});

function renderView(session: CheckoutSession, props: Partial<MobileCheckoutViewProps> = {}) {
  const handlers = {
    onPay: vi.fn(),
    onAcceptPrice: vi.fn(),
    onStartAgain: vi.fn(),
    onBackToStart: vi.fn(),
  };
  render(
    <MobileCheckoutView
      session={session}
      listing={listing}
      error={null}
      paidHere={false}
      connection="sse"
      busy={false}
      startedHere={false}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

afterEach(cleanup);

describe('header', () => {
  it('says "Opened from link" when another client started the checkout', () => {
    renderView(makeSession(), { startedHere: false });
    expect(screen.getByTestId('origin-label').textContent).toBe('Opened from link');
  });

  it('says "Started on this device" when this client started it', () => {
    renderView(makeSession(), { startedHere: true });
    expect(screen.getByTestId('origin-label').textContent).toBe('Started on this device');
  });

  it('shows the same summary, price, countdown and connection as the desktop view', () => {
    renderView(makeSession());

    expect(screen.getByRole('heading', { name: 'The Midnight Orchestra' })).toBeTruthy();
    expect(screen.getByTestId('listing').textContent).toContain('Friday, June 14, 2030 at 7:30 PM');
    expect(screen.getByTestId('price').textContent).toBe('$100.00');
    expect(screen.getByTestId('countdown').textContent).toMatch(/^Seats held for \d+:\d{2}$/);
    expect(screen.getByTestId('connection').textContent).toContain('live');
    expect(screen.queryByTestId('continue-on-phone')).toBeNull(); // this already is the phone
  });
});

describe('sticky Pay button', () => {
  it('is in a bottom bar and calls onPay when the session is active', () => {
    const { onPay } = renderView(makeSession());

    const pay = screen.getByTestId('pay') as HTMLButtonElement;
    expect(pay.textContent).toBe('Pay $100.00');
    expect(pay.closest('.pay-bar')).toBeTruthy();
    expect(screen.queryByTestId('sheet')).toBeNull();
    fireEvent.click(pay);
    expect(onPay).toHaveBeenCalledOnce();
  });

  it('is locked while a request is in flight and while the payment is pending', () => {
    renderView(makeSession(), { busy: true });
    expect((screen.getByTestId('pay') as HTMLButtonElement).disabled).toBe(true);

    cleanup();
    renderView(makeSession({ status: 'payment_pending', version: 2 }));
    expect((screen.getByTestId('pay') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('processing').textContent).toContain('Processing payment');
    expect(screen.queryByTestId('sheet')).toBeNull();
  });

  it('is gone once the session is finished', () => {
    renderView(makeSession({ status: 'completed', version: 3, orderId: 'order-1' }));
    expect(screen.queryByTestId('pay')).toBeNull();
  });
});

describe('recovery states use a bottom sheet', () => {
  it('price_changed: old and new price, Accept new price, Pay locked', () => {
    const { onAcceptPrice, onPay } = renderView(
      makeSession({ status: 'price_changed', currentPrice: 12500, version: 2 }),
    );

    const sheet = screen.getByRole('dialog');
    expect(sheet.getAttribute('data-testid')).toBe('price-banner');
    expect(sheet.textContent).toContain('from $100.00 to $125.00');
    expect(screen.getByTestId('price-old').textContent).toBe('$100.00');
    expect(screen.getByTestId('price').textContent).toBe('$125.00');
    expect((screen.getByTestId('pay') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(sheet).getByRole('button', { name: 'Accept new price' }));
    expect(onAcceptPrice).toHaveBeenCalledOnce();
    expect(onPay).not.toHaveBeenCalled();
  });

  it('payment_failed: the reason and Try again', () => {
    const { onPay } = renderView(makeSession({ status: 'payment_failed', version: 3 }), {
      error: { code: 'PAYMENT_FAILED', message: 'card_declined' },
    });

    const sheet = screen.getByRole('dialog');
    expect(sheet.textContent).toContain("Your payment didn't go through: card declined");
    expect(screen.queryByTestId('error')).toBeNull(); // not shown twice
    expect(screen.queryByTestId('pay')).toBeNull(); // the sheet is the one way forward
    fireEvent.click(within(sheet).getByRole('button', { name: 'Try again' }));
    expect(onPay).toHaveBeenCalledOnce();
  });

  it('expired: "Your hold ran out" and Start again', () => {
    const { onStartAgain } = renderView(makeSession({ status: 'expired', version: 2 }));

    const sheet = screen.getByRole('dialog');
    expect(sheet.textContent).toContain('Your hold ran out');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Start again' }));
    expect(onStartAgain).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('pay')).toBeNull();
  });

  it('unavailable: a dead end with a way back', () => {
    const { onBackToStart } = renderView(makeSession({ status: 'unavailable', version: 2 }));

    const sheet = screen.getByRole('dialog');
    expect(sheet.textContent).toContain('These seats are no longer available');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Find other tickets' }));
    expect(onBackToStart).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('pay')).toBeNull();
  });

  it('payment_pending, completed and active are not sheets', () => {
    for (const status of ['active', 'payment_pending', 'completed'] as const) {
      renderView(makeSession({ status, version: 2, orderId: status === 'completed' ? 'o' : undefined }));
      expect(screen.queryByRole('dialog')).toBeNull();
      cleanup();
    }
  });
});

describe('other states', () => {
  it('completed here: confirmation with the order id', () => {
    renderView(makeSession({ status: 'completed', version: 4, orderId: 'order-123' }), { paidHere: true });

    expect(screen.getByTestId('confirmation').textContent).toContain('Order confirmed');
    expect(screen.getByTestId('order-id').textContent).toBe('order-123');
  });

  it('completed elsewhere: says so', () => {
    renderView(makeSession({ status: 'completed', version: 4, orderId: 'order-123' }), { paidHere: false });

    expect(screen.getByTestId('completed-elsewhere').textContent).toContain('Completed on another device');
  });

  it('PAYMENT_IN_PROGRESS reads as another device paying', () => {
    renderView(makeSession({ status: 'payment_pending', version: 2 }), {
      error: { code: 'PAYMENT_IN_PROGRESS', message: 'x' },
    });

    expect(screen.getByTestId('error').textContent).toBe('A payment is already in progress on another device');
  });
});
