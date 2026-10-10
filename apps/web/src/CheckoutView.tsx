import { useState } from 'react';
import type { CheckoutSession, Listing } from '@checkout/shared';
import type { ApiError } from './api';
import { formatCountdown, formatEventDate, formatPrice } from './format';
import { useCountdown } from './useCountdown';
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

      <PriceBlock session={session} />

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

      {alert && (
        <p className="banner error" role="alert" data-testid="error">
          {alert}
        </p>
      )}

      <StatusPanel {...props} />

      {!finished && <PhoneLink url={props.resumeUrl} />}
    </section>
  );
}

function StatusPanel({ session, error, paidHere, busy, onPay, onStartAgain, onBackToStart }: CheckoutViewProps) {
  switch (session.status) {
    case 'active':
    case 'price_changed':
      return (
        <button
          type="button"
          className="primary"
          data-testid="pay"
          disabled={session.status === 'price_changed' || busy}
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

export function PriceBlock({ session }: { session: CheckoutSession }) {
  return (
    <div className="price" aria-label="Price">
      {session.status === 'price_changed' ? (
        <>
          <s className="price-old" data-testid="price-old">
            {formatPrice(session.priceSnapshot)}
          </s>{' '}
          <strong className="price-new" data-testid="price">
            {formatPrice(session.currentPrice)}
          </strong>
        </>
      ) : (
        <strong data-testid="price">{formatPrice(session.priceSnapshot)}</strong>
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

/** The order confirmation when this client paid, or the "someone else paid" notice. */
export function CompletedPanel({ session, paidHere }: { session: CheckoutSession; paidHere: boolean }) {
  return paidHere ? (
    <div className="banner ok" role="status" data-testid="confirmation">
      <p>
        <strong>Order confirmed</strong>
      </p>
      <p>
        Order number: <code data-testid="order-id">{session.orderId}</code>
      </p>
    </div>
  ) : (
    <div className="banner ok" role="status" data-testid="completed-elsewhere">
      <p>
        <strong>Completed on another device</strong>
      </p>
      {session.orderId && (
        <p>
          Order number: <code data-testid="order-id">{session.orderId}</code>
        </p>
      )}
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
        Section {listing.section}, Row {listing.row}, {listing.seats.length === 1 ? 'Seat' : 'Seats'}{' '}
        {listing.seats.join(', ')}
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
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked; the link is selectable in the field.
    }
  };

  return (
    <div className="phone">
      <button type="button" className="link" data-testid="continue-on-phone" onClick={() => setOpen((v) => !v)}>
        Continue on phone
      </button>
      {open && (
        <div className="phone-link" data-testid="phone-link">
          <input readOnly value={url} aria-label="Link to continue on your phone" onFocus={(e) => e.currentTarget.select()} />
          <button type="button" data-testid="copy-link" onClick={() => void copy()}>
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      )}
    </div>
  );
}
