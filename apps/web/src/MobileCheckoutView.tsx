import type { ReactNode } from 'react';
import type { CheckoutSession } from '@checkout/shared';
import {
  CompletedPanel,
  ConnectionIndicator,
  DealBanner,
  ListingSummary,
  PriceBlock,
  ProcessingPanel,
  alertFor,
  humanize,
} from './CheckoutView';
import type { CheckoutViewProps } from './CheckoutView';
import { formatCountdown, formatPrice } from './format';
import { StatusSwap, panelKeyFor } from './Transitions';
import { useCountdown } from './useCountdown';

export interface MobileCheckoutViewProps extends Omit<CheckoutViewProps, 'resumeUrl'> {
  /** This client created the session (its id matches `originClientId`), rather than opening a link. */
  startedHere: boolean;
}

/** States where the buyer has to decide something: shown in a bottom sheet over the page. */
const RECOVERY_STATUSES: ReadonlyArray<CheckoutSession['status']> = [
  'price_changed',
  'payment_failed',
  'expired',
  'unavailable',
];

/** Phone layout of the checkout: same states as the desktop view, recoveries in a sheet, Pay pinned at the bottom. */
export function MobileCheckoutView(props: MobileCheckoutViewProps) {
  const { session, listing, error, paidHere, connection, busy, startedHere, confirmingPrice = false } = props;
  const { status } = session;
  const remainingMs = useCountdown(session.holdExpiresAt);
  const showCountdown = status === 'active' || status === 'price_changed' || status === 'payment_failed';
  const alert = alertFor(error, status);
  const showPayBar = status === 'active' || status === 'price_changed' || status === 'payment_pending';

  return (
    <section className="mobile" data-testid="checkout-pane" data-status={status} data-surface="mobile">
      <header className="mobile-header">
        <span className="origin" data-testid="origin-label">
          {startedHere ? 'Started on this device' : 'Opened from link'}
        </span>
        <ConnectionIndicator connection={connection} />
      </header>

      <div className="mobile-body">
        <h1>{listing?.eventName ?? 'Your tickets'}</h1>
        {listing ? <ListingSummary listing={listing} /> : <p className="muted">Loading event details…</p>}
        <PriceBlock session={session} confirming={confirmingPrice} />

        {showCountdown && (
          <p className="muted" data-testid="countdown">
            {remainingMs > 0 ? `Seats held for ${formatCountdown(remainingMs)}` : 'Hold is running out…'}
          </p>
        )}

        <DealBanner session={session} />

        {alert && (
          <p className="banner error" role="alert" data-testid="error">
            {alert}
          </p>
        )}

        <StatusSwap panelKey={panelKeyFor(status)}>
          {status === 'payment_pending' && <ProcessingPanel />}
          {status === 'completed' && <CompletedPanel session={session} paidHere={paidHere} />}
        </StatusSwap>
      </div>

      {showPayBar && (
        <div className="pay-bar">
          <button
            type="button"
            className="primary"
            data-testid="pay"
            disabled={status !== 'active' || busy || confirmingPrice}
            onClick={props.onPay}
          >
            {status === 'payment_pending' || confirmingPrice
              ? 'Pay'
              : `Pay ${formatPrice(status === 'price_changed' ? session.currentPrice : session.priceSnapshot)}`}
          </button>
        </div>
      )}

      {RECOVERY_STATUSES.includes(status) && <RecoverySheet {...props} />}
    </section>
  );
}

/** The bottom sheet for the state that needs a decision. It is the only way forward, so it has no dismiss. */
function RecoverySheet({ session, error, busy, onAcceptPrice, onPay, onStartAgain, onBackToStart }: MobileCheckoutViewProps) {
  let testId: string;
  let title: string;
  let body: ReactNode = null;
  let action: ReactNode;

  switch (session.status) {
    case 'price_changed':
      testId = 'price-banner';
      title = 'The price changed';
      body = (
        <p>
          It went from <strong>{formatPrice(session.priceSnapshot)}</strong> to{' '}
          <strong>{formatPrice(session.currentPrice)}</strong>.
        </p>
      );
      action = (
        <button type="button" className="primary" data-testid="accept-price" autoFocus disabled={busy} onClick={onAcceptPrice}>
          Accept new price
        </button>
      );
      break;

    case 'payment_failed': {
      const reason = error?.code === 'PAYMENT_FAILED' ? humanize(error.message) : null;
      testId = 'payment-failed';
      title = `Your payment didn't go through${reason ? `: ${reason}` : '.'}`;
      action = (
        <button type="button" className="primary" data-testid="try-again" autoFocus disabled={busy} onClick={onPay}>
          Try again
        </button>
      );
      break;
    }

    case 'expired':
      testId = 'expired';
      title = 'Your hold ran out';
      action = (
        <button type="button" className="primary" data-testid="start-again" autoFocus disabled={busy} onClick={onStartAgain}>
          Start again
        </button>
      );
      break;

    default:
      testId = 'unavailable';
      title = 'These seats are no longer available';
      action = (
        <button type="button" className="primary" data-testid="back-to-start" autoFocus onClick={onBackToStart}>
          Find other tickets
        </button>
      );
  }

  return (
    <div className="sheet-layer" data-testid="sheet">
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} data-testid={testId}>
        <span className="sheet-grip" aria-hidden="true" />
        <h2>{title}</h2>
        {body}
        {action}
      </div>
    </div>
  );
}
