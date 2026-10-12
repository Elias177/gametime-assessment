import { useState } from 'react';
import type { CheckoutSession, Listing } from '@checkout/shared';
import type { ApiError } from './api';
import { formatSeats } from '@checkout/shared';
import { formatCountdown, formatEventDate, formatPrice } from './format';
import { useCountdown } from './useCountdown';
import { CopyButton } from './CopyButton';
import { QrCode, isLoopbackUrl } from './QrCode';
import { FlashOnChange, StatusSwap, panelKeyFor } from './Transitions';
import type { Connection } from './useCheckoutSession';

export interface CheckoutViewProps {
  session: CheckoutSession;
  listing?: Listing;
  error: ApiError | null;
  /** True when this client's own payment attempt produced the completed order. */
  paidHere: boolean;
  connection: Connection;
  /** A request from this client is in flight. */
  busy: boolean;
  /** Link to continue this checkout on another device. */
  resumeUrl: string;
  /** The price shown came from a pre-rendered page and has not been confirmed by the server yet. */
  confirmingPrice?: boolean;
  onPay: () => void;
  onAcceptPrice: () => void;
  onStartAgain: () => void;
  onBackToStart: () => void;
}

/** User-facing wording for an action error, or null when the UI already says it another way. */
export function describeError(error: ApiError): string {
  switch (error.code) {
    case 'PAYMENT_IN_PROGRESS':
      return 'A payment is already in progress on another device';
    case 'VERSION_CONFLICT':
      return 'This checkout just changed, so we refreshed it. Please review and try again.';
    case 'NETWORK_ERROR':
      return "Can't reach the server. It's safe to try again: you won't be charged twice.";
    case 'SOLD_OUT':
      return 'Those seats were just taken.';
    default:
      return error.message;
  }
}

export const humanize = (reason: string) => reason.replace(/_/g, ' ');

/**
 * The price drop the buyer is now looking at, or null. A decrease is applied silently (the status
 * stays `active`), so the deal is the latest change when it was auto-applied and the buyer has
 * not moved on to another status.
 */
export function dealFor(session: CheckoutSession): { from: number; to: number } | null {
  if (session.status !== 'active') return null;
  const last = session.changes[session.changes.length - 1];
  if (!last || last.outcome !== 'auto_applied' || last.to !== session.priceSnapshot || last.from <= last.to) return null;
  return { from: last.from, to: last.to };
}

/** The "good news" counterpart to the price-increase banner: nothing to accept, the new price is already in effect. */
export function DealBanner({ session }: { session: CheckoutSession }) {
  const deal = dealFor(session);
  if (!deal) return null;
  return (
    <div className="banner ok deal" role="status" data-testid="deal-banner">
      <p>
        <strong>Price drop!</strong> You save <strong data-testid="deal-savings">{formatPrice(deal.from - deal.to)}</strong>.
        Now <strong>{formatPrice(deal.to)}</strong>, down from <s>{formatPrice(deal.from)}</s>.
      </p>
    </div>
  );
}

/**
 * The action error worth showing as an alert, or null. A failed payment is explained by its own
 * panel, and a stale error on a finished session is noise.
 */
export function alertFor(error: ApiError | null, status: CheckoutSession['status']): string | null {
  const finished = status === 'completed' || status === 'expired' || status === 'unavailable';
  if (!error || finished || (error.code === 'PAYMENT_FAILED' && status === 'payment_failed')) return null;
  return describeError(error);
}

export function CheckoutView(props: CheckoutViewProps) {
  const { session, listing, error, connection, busy } = props;
  const { status } = session;
  const remainingMs = useCountdown(session.holdExpiresAt);
  const showCountdown = status === 'active' || status === 'price_changed' || status === 'payment_failed';
  const finished = status === 'completed' || status === 'expired' || status === 'unavailable';
  const priceChanged = status === 'price_changed';

  const alert = alertFor(error, status);

  return (
    <section className="pane" data-testid="checkout-pane" data-status={status}>
      <header className="pane-header">
        <h1>{listing?.eventName ?? 'Your tickets'}</h1>
        <ConnectionIndicator connection={connection} />
      </header>

      {listing ? <ListingSummary listing={listing} /> : <p className="muted">Loading event details…</p>}

      <PriceBlock session={session} confirming={props.confirmingPrice} />

      {showCountdown && (
        <p className="muted" data-testid="countdown">
          {remainingMs > 0 ? `Seats held for ${formatCountdown(remainingMs)}` : 'Hold is running out…'}
        </p>
      )}

      {priceChanged && (
        <div className="banner warn" role="status" data-testid="price-banner">
          <p>
            The price changed from <strong>{formatPrice(session.priceSnapshot)}</strong> to{' '}
            <strong>{formatPrice(session.currentPrice)}</strong>.
          </p>
          <button type="button" data-testid="accept-price" disabled={busy} onClick={props.onAcceptPrice}>
            Accept new price
          </button>
        </div>
      )}

      <DealBanner session={session} />

      {alert && (
        <p className="banner error" role="alert" data-testid="error">
          {alert}
        </p>
      )}

      <StatusSwap panelKey={panelKeyFor(status)}>
        <StatusPanel {...props} />
      </StatusSwap>

      {!finished && <PhoneLink url={props.resumeUrl} />}
    </section>
  );
}

function StatusPanel({ session, error, paidHere, busy, confirmingPrice, onPay, onStartAgain, onBackToStart }: CheckoutViewProps) {
  switch (session.status) {
    case 'active':
    case 'price_changed':
      return (
        <button
          type="button"
          className="primary"
          data-testid="pay"
          disabled={session.status === 'price_changed' || busy || confirmingPrice}
          onClick={onPay}
        >
          Pay {formatPrice(session.status === 'price_changed' ? session.currentPrice : session.priceSnapshot)}
        </button>
      );

    case 'payment_pending':
      return (
        <>
          <ProcessingPanel />
          <button type="button" className="primary" data-testid="pay" disabled>
            Pay
          </button>
        </>
      );

    case 'payment_failed': {
      const reason = error?.code === 'PAYMENT_FAILED' ? humanize(error.message) : null;
      return (
        <div className="banner error" role="alert" data-testid="payment-failed">
          <p>Your payment didn&apos;t go through{reason ? `: ${reason}` : '.'}</p>
          <button type="button" className="primary" data-testid="try-again" disabled={busy} onClick={onPay}>
            Try again
          </button>
        </div>
      );
    }

    case 'expired':
      return (
        <div className="banner" data-testid="expired">
          <p>
            <strong>Your hold ran out</strong>
          </p>
          <button type="button" className="primary" data-testid="start-again" disabled={busy} onClick={onStartAgain}>
            Start again
          </button>
        </div>
      );

    case 'unavailable':
      return (
        <div className="banner error" data-testid="unavailable">
          <p>
            <strong>These seats are no longer available</strong>
          </p>
          <button type="button" className="primary" data-testid="back-to-start" onClick={onBackToStart}>
            Find other tickets
          </button>
        </div>
      );

    case 'completed':
      return <CompletedPanel session={session} paidHere={paidHere} />;
  }
}

/**
 * The price. While `confirming`, it is only the last-seen number from the pre-rendered page, so it
 * is labelled as such (on the same line, so nothing moves when the label goes).
 */
export function PriceBlock({ session, confirming = false }: { session: CheckoutSession; confirming?: boolean }) {
  // One wrapper around all layouts, so the flash sees the change from one to the other.
  const shown = session.status === 'price_changed' ? session.currentPrice : session.priceSnapshot;
  const deal = dealFor(session);
  return (
    <div className="price" aria-label="Price">
      <FlashOnChange value={shown}>
        {session.status === 'price_changed' ? (
          <>
            <s className="price-old" data-testid="price-old">
              {formatPrice(session.priceSnapshot)}
            </s>{' '}
            <strong className="price-new" data-testid="price">
              {formatPrice(session.currentPrice)}
            </strong>
          </>
        ) : deal ? (
          <>
            <s className="price-old" data-testid="deal-old-price">
              {formatPrice(deal.from)}
            </s>{' '}
            <strong className="price-deal" data-testid="price">
              {formatPrice(deal.to)}
            </strong>
          </>
        ) : (
          <strong data-testid="price">{formatPrice(session.priceSnapshot)}</strong>
        )}
      </FlashOnChange>
      {confirming && (
        <>
          {' '}
          <span className="confirming" data-testid="confirming-price">
            Confirming price…
          </span>
        </>
      )}
    </div>
  );
}

export function ProcessingPanel() {
  return (
    <p className="processing" role="status" data-testid="processing">
      <span className="spinner" aria-hidden="true" /> Processing payment…
    </p>
  );
}

/**
 * The receipt: the order confirmation when this client paid, or the "someone else paid" notice. Both
 * show the order number (copyable, in a monospace face so it reads unambiguously) and the total.
 */
export function CompletedPanel({ session, paidHere }: { session: CheckoutSession; paidHere: boolean }) {
  return (
    <div
      className="receipt"
      role="status"
      data-testid={paidHere ? 'confirmation' : 'completed-elsewhere'}
    >
      <h2 className="receipt-title">{paidHere ? 'Order confirmed' : 'Completed on another device'}</h2>
      <dl className="receipt-details">
        {session.orderId && (
          <>
            <dt>Order number</dt>
            <dd className="receipt-order">
              <code data-testid="order-id">{session.orderId}</code>
              <CopyButton text={session.orderId} testId="copy-order" label="Copy" announce="Order number copied" />
            </dd>
          </>
        )}
        <dt>Total</dt>
        <dd data-testid="receipt-total">{formatPrice(session.priceSnapshot)}</dd>
      </dl>
    </div>
  );
}

export function ListingSummary({ listing }: { listing: Listing }) {
  return (
    <dl className="listing" data-testid="listing">
      <dt>Venue</dt>
      <dd>{listing.venue}</dd>
      <dt>Date</dt>
      <dd>{formatEventDate(listing.date, listing.timeZone)}</dd>
      <dt>Seats</dt>
      <dd>
        {formatSeats(listing)}
      </dd>
    </dl>
  );
}

export function ConnectionIndicator({ connection }: { connection: Connection }) {
  const label = connection === 'sse' ? 'live' : connection === 'polling' ? 'polling' : 'connecting';
  return (
    <span className={`connection ${label}`} data-testid="connection" title="How this page receives updates">
      <span className="dot" aria-hidden="true" /> {label}
    </span>
  );
}

function PhoneLink({ url }: { url: string }) {
  const [open, setOpen] = useState(false);
  // A phone cannot reach this page's own address when it is localhost, so a QR of it would be a dead end.
  const showQr = !isLoopbackUrl(url);

  return (
    <div className="phone">
      <button
        type="button"
        className="link"
        data-testid="continue-on-phone"
        aria-expanded={open}
        aria-controls="phone-reveal"
        onClick={() => setOpen((v) => !v)}
      >
        Continue on phone
      </button>
      {/* Always mounted so it can animate in and out; inert (not focusable, hidden from assistive tech) while closed. */}
      <div
        id="phone-reveal"
        className="phone-reveal"
        data-testid="phone-link"
        data-open={open}
        aria-hidden={!open}
        {...(open ? {} : { inert: '' })}
      >
        <div className="phone-reveal-inner">
          <div className="phone-open">
            {showQr && <QrCode text={url} label="QR code: scan with your phone to continue this checkout" />}
            <div className="phone-share">
              <p className="muted">{showQr ? 'Scan with your phone, or copy the link.' : 'Copy the link and open it on your phone.'}</p>
              <div className="phone-link">
                <input readOnly value={url} aria-label="Link to continue on your phone" onFocus={(e) => e.currentTarget.select()} />
                <div className="phone-link-actions">
                  <CopyButton text={url} testId="copy-link" announce="Link copied" />
                  <a className="button" href={url} target="_blank" rel="noopener noreferrer" data-testid="open-link">
                    Open in new tab
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
