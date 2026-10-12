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

describe('confirming the price', () => {
  it('labels the price and locks Pay while the price is unconfirmed', () => {
    renderView(makeSession(), { confirmingPrice: true });

    expect(screen.getByTestId('confirming-price').textContent).toBe('Confirming price…');
    expect((screen.getByTestId('pay') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows neither once confirmed', () => {
    renderView(makeSession());

    expect(screen.queryByTestId('confirming-price')).toBeNull();
    expect((screen.getByTestId('pay') as HTMLButtonElement).disabled).toBe(false);
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

  it('price drop: frames it as a deal, with the old price crossed out and Pay still enabled', () => {
    const { onPay } = renderView(
      makeSession({
        priceSnapshot: 8000,
        currentPrice: 8000,
        version: 2,
        changes: [{ from: 10000, to: 8000, at: '2026-01-01T00:00:00.000Z', outcome: 'auto_applied' }],
      }),
    );

    expect(screen.getByTestId('deal-old-price').tagName).toBe('S');
    expect(screen.getByTestId('deal-old-price').textContent).toBe('$100.00');
    expect(screen.getByTestId('price').textContent).toBe('$80.00');
    expect(screen.getByTestId('deal-banner').textContent).toContain('Price drop!');
    expect(screen.getByTestId('deal-savings').textContent).toBe('$20.00');
    expect(screen.queryByTestId('accept-price')).toBeNull();

    const pay = screen.getByTestId('pay') as HTMLButtonElement;
    expect(pay.disabled).toBe(false);
    expect(pay.textContent).toBe('Pay $80.00');
    fireEvent.click(pay);
    expect(onPay).toHaveBeenCalledOnce();
  });

  it('a drop from an increase the buyer never accepted crosses out the increased price', () => {
    renderView(
      makeSession({
        priceSnapshot: 9000,
        currentPrice: 9000,
        changes: [
          { from: 10000, to: 12000, at: '2026-01-01T00:00:00.000Z', outcome: 'needs_ack' },
          { from: 12000, to: 9000, at: '2026-01-01T00:01:00.000Z', outcome: 'auto_applied' },
        ],
      }),
    );

    expect(screen.getByTestId('deal-old-price').textContent).toBe('$120.00');
    expect(screen.getByTestId('deal-savings').textContent).toBe('$30.00');
  });

  it('shows no deal without a price drop', () => {
    renderView(makeSession());
    expect(screen.queryByTestId('deal-banner')).toBeNull();
    expect(screen.queryByTestId('deal-old-price')).toBeNull();
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

  it('the receipt has a heading, the order number and the total, in both completed variants', () => {
    renderView(makeSession({ status: 'completed', version: 4, orderId: 'order-123', priceSnapshot: 11200 }), { paidHere: true });
    expect(screen.getByRole('heading', { name: 'Order confirmed' })).toBeTruthy();
    expect(screen.getByTestId('receipt-total').textContent).toBe('$112.00');
    expect(screen.getByTestId('order-id').tagName).toBe('CODE');

    cleanup();
    renderView(makeSession({ status: 'completed', version: 4, orderId: 'order-123', priceSnapshot: 11200 }), { paidHere: false });
    expect(screen.getByRole('heading', { name: 'Completed on another device' })).toBeTruthy();
    expect(screen.getByTestId('receipt-total').textContent).toBe('$112.00');
    expect(screen.getByTestId('order-id').textContent).toBe('order-123');
  });

  it('copies the order number from the receipt', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderView(makeSession({ status: 'completed', version: 4, orderId: 'order-123' }), { paidHere: true });

    fireEvent.click(screen.getByTestId('copy-order'));

    expect(writeText).toHaveBeenCalledExactlyOnceWith('order-123');
    expect(await screen.findByRole('button', { name: 'Copied!' })).toBeTruthy();
    expect((await screen.findAllByRole('status')).some((el) => el.textContent === 'Order number copied')).toBe(true);
  });

  it('leaves out the order number row, and its copy button, when there is no order id', () => {
    renderView(makeSession({ status: 'completed', version: 4 }), { paidHere: false });

    expect(screen.queryByTestId('order-id')).toBeNull();
    expect(screen.queryByTestId('copy-order')).toBeNull();
    expect(screen.getByTestId('receipt-total')).toBeTruthy();
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

    expect(screen.getByTestId('phone-link').getAttribute('data-open')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Continue on phone' }));
    expect(screen.getByTestId('phone-link').getAttribute('data-open')).toBe('true');

    const field = within(screen.getByTestId('phone-link')).getByRole('textbox') as HTMLInputElement;
    expect(field.value).toBe('https://example.test/resume/s1');

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('https://example.test/resume/s1');
    expect(await screen.findByRole('button', { name: 'Copied!' })).toBeTruthy();
  });

  it('keeps the section mounted but closed and inert so it can animate, and reports its state on the button', () => {
    renderView(makeSession());
    const section = screen.getByTestId('phone-link');
    const toggle = screen.getByRole('button', { name: 'Continue on phone' });

    expect(section.hasAttribute('inert')).toBe(true);
    expect(section.getAttribute('aria-hidden')).toBe('true');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);
    expect(section.hasAttribute('inert')).toBe(false);
    expect(section.getAttribute('aria-hidden')).toBe('false');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(toggle);
    expect(section.getAttribute('data-open')).toBe('false');
    expect(section.hasAttribute('inert')).toBe(true);
  });

  it('shows a QR code of the resume link', () => {
    renderView(makeSession());

    const qr = screen.getByTestId('phone-qr');
    expect(qr.getAttribute('role')).toBe('img');
    expect(qr.getAttribute('data-value')).toBe('https://example.test/resume/s1');
    expect(qr.querySelector('path')?.getAttribute('d')).toMatch(/^M/);
  });

  it.each(['http://localhost:5173/resume/s1', 'http://127.0.0.1:5173/resume/s1', 'http://[::1]:5173/resume/s1', 'http://demo.localhost/resume/s1'])(
    'shows no QR code, only the link, when the page is on %s',
    (resumeUrl) => {
      renderView(makeSession(), { resumeUrl });
      fireEvent.click(screen.getByRole('button', { name: 'Continue on phone' }));

      expect(screen.queryByTestId('phone-qr')).toBeNull();
      expect((within(screen.getByTestId('phone-link')).getByRole('textbox') as HTMLInputElement).value).toBe(resumeUrl);
    },
  );

  it('still shows the QR code on a LAN address', () => {
    renderView(makeSession(), { resumeUrl: 'http://192.168.1.20:5173/resume/s1' });
    expect(screen.getByTestId('phone-qr')).toBeTruthy();
  });
});
