// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import type { CheckoutSession } from '@checkout/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CheckoutView } from './CheckoutView';
import type { CheckoutViewProps } from './CheckoutView';
import { MobileCheckoutView } from './MobileCheckoutView';
import { FlashOnChange, StatusSwap, panelKeyFor } from './Transitions';

afterEach(cleanup);

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

const viewProps = (session: CheckoutSession): CheckoutViewProps => ({
  session,
  error: null,
  paidHere: false,
  connection: 'sse',
  busy: false,
  resumeUrl: 'http://localhost/resume/s1',
  onPay: vi.fn(),
  onAcceptPrice: vi.fn(),
  onStartAgain: vi.fn(),
  onBackToStart: vi.fn(),
});

describe('panelKeyFor', () => {
  it('shares one key between active and price_changed, so the Pay button is kept', () => {
    expect(panelKeyFor('active')).toBe(panelKeyFor('price_changed'));
  });

  it('gives every other status its own key', () => {
    const others = ['payment_pending', 'completed', 'payment_failed', 'expired', 'unavailable'] as const;
    const keys = new Set([panelKeyFor('active'), ...others.map(panelKeyFor)]);
    expect(keys.size).toBe(others.length + 1);
  });
});

describe('StatusSwap', () => {
  it('does not animate the panel it first renders', () => {
    render(<StatusSwap panelKey="completed">done</StatusSwap>);

    expect(screen.getByTestId('status-swap').className).not.toContain('swap-in');
  });

  it('replaces the panel and fades in the new one when the key changes', () => {
    const { rerender } = render(<StatusSwap panelKey="pay">pay</StatusSwap>);
    const before = screen.getByTestId('status-swap');

    rerender(<StatusSwap panelKey="expired">expired</StatusSwap>);

    const after = screen.getByTestId('status-swap');
    expect(after).not.toBe(before);
    expect(after.className).toContain('swap-in');
    expect(after.textContent).toBe('expired');
  });

  it('keeps the same element, and does not start an animation, while the key is unchanged', () => {
    const { rerender } = render(<StatusSwap panelKey="pay">a</StatusSwap>);
    const before = screen.getByTestId('status-swap');

    rerender(<StatusSwap panelKey="pay">b</StatusSwap>);

    expect(screen.getByTestId('status-swap')).toBe(before);
    expect(before.className).not.toContain('swap-in');
    expect(before.textContent).toBe('b');
  });
});

describe('FlashOnChange', () => {
  it('does not flash when it first appears', () => {
    render(<FlashOnChange value={10000}>$100</FlashOnChange>);

    expect(screen.getByTestId('flash').classList.contains('flash')).toBe(false);
  });

  it('flashes, on a new element, when the value changes', () => {
    const { rerender } = render(<FlashOnChange value={10000}>$100</FlashOnChange>);
    const before = screen.getByTestId('flash');

    rerender(<FlashOnChange value={11200}>$112</FlashOnChange>);

    const after = screen.getByTestId('flash');
    expect(after).not.toBe(before);
    expect(after.classList.contains('flash')).toBe(true);
  });

  it('leaves the element alone when the value is the same', () => {
    const { rerender } = render(<FlashOnChange value={10000}>$100</FlashOnChange>);
    rerender(<FlashOnChange value={11200}>$112</FlashOnChange>);
    const flashed = screen.getByTestId('flash');

    rerender(<FlashOnChange value={11200}>$112</FlashOnChange>);

    expect(screen.getByTestId('flash')).toBe(flashed);
  });
});

describe('CheckoutView transitions', () => {
  it('flashes the price when it goes up under a shown price, across the two layouts', () => {
    const { rerender } = render(<CheckoutView {...viewProps(makeSession())} />);
    expect(screen.getByTestId('flash').classList.contains('flash')).toBe(false);

    rerender(<CheckoutView {...viewProps(makeSession({ status: 'price_changed', currentPrice: 11200, version: 2 }))} />);

    expect(screen.getByTestId('flash').classList.contains('flash')).toBe(true);
    expect(screen.getByTestId('price').textContent).toBe('$112.00');
  });

  it('flashes when a price drop is applied silently', () => {
    const { rerender } = render(<CheckoutView {...viewProps(makeSession())} />);

    rerender(<CheckoutView {...viewProps(makeSession({ priceSnapshot: 9500, currentPrice: 9500, version: 2 }))} />);

    expect(screen.getByTestId('flash').classList.contains('flash')).toBe(true);
  });

  it('does not flash on a page that loads already in price_changed', () => {
    render(<CheckoutView {...viewProps(makeSession({ status: 'price_changed', currentPrice: 11200, version: 2 }))} />);

    expect(screen.getByTestId('flash').classList.contains('flash')).toBe(false);
  });

  it('does not flash when the new price is accepted (the shown number is the same)', () => {
    const changed = makeSession({ status: 'price_changed', currentPrice: 11200, version: 2 });
    const { rerender } = render(<CheckoutView {...viewProps(changed)} />);
    const before = screen.getByTestId('flash');

    rerender(<CheckoutView {...viewProps(makeSession({ priceSnapshot: 11200, currentPrice: 11200, version: 3 }))} />);

    expect(screen.getByTestId('flash')).toBe(before);
  });

  it('keeps the same Pay button, with its focus, when the price changes under it', () => {
    const { rerender } = render(<CheckoutView {...viewProps(makeSession())} />);
    const pay = screen.getByTestId('pay');
    pay.focus();

    rerender(<CheckoutView {...viewProps(makeSession({ status: 'price_changed', currentPrice: 11200, version: 2 }))} />);

    expect(screen.getByTestId('pay')).toBe(pay);
    expect(document.activeElement).toBe(pay);
  });

  it('fades the new panel in when the status changes, but not the one it loaded with', () => {
    const { rerender } = render(<CheckoutView {...viewProps(makeSession())} />);
    expect(screen.getByTestId('status-swap').className).not.toContain('swap-in');

    rerender(<CheckoutView {...viewProps(makeSession({ status: 'expired', version: 2 }))} />);

    expect(screen.getByTestId('status-swap').className).toContain('swap-in');
    expect(screen.getByTestId('expired')).toBeTruthy();
  });
});

describe('MobileCheckoutView transitions', () => {
  const mobile = (session: CheckoutSession) => <MobileCheckoutView {...viewProps(session)} startedHere={false} />;

  it('adds no content in the active state (the wrapper is empty, which the CSS hides)', () => {
    render(mobile(makeSession()));

    expect(screen.getByTestId('status-swap').childNodes).toHaveLength(0);
  });

  it('fades the order panel in when the session completes', () => {
    const { rerender } = render(mobile(makeSession()));

    rerender(mobile(makeSession({ status: 'completed', version: 2, orderId: 'ord-1' })));

    expect(screen.getByTestId('status-swap').className).toContain('swap-in');
    expect(screen.getByTestId('completed-elsewhere')).toBeTruthy();
  });
});
