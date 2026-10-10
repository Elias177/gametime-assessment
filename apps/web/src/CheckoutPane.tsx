import { useState } from 'react';
import { createSession } from './api';
import { CheckoutView } from './CheckoutView';
import { navigate } from './navigate';
import { useCheckoutSession } from './useCheckoutSession';

/** Wires one checkout session (via the hook) to the view. */
export function CheckoutPane({ sessionId }: { sessionId: string }) {
  const { session, listing, loading, error, connection, paidHere, acknowledge, complete } =
    useCheckoutSession(sessionId);
  const [busy, setBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const run = (action: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const startAgain = async () => {
    if (!session) return;
    setStartError(null);
    try {
      const res = await createSession(session.listingId);
      if (res.ok) navigate(`/checkout/${res.body.id}`);
      else setStartError(res.body?.error.code === 'SOLD_OUT' ? 'Those seats were just taken.' : 'Could not start a new checkout.');
    } catch {
      setStartError("Can't reach the server. Please try again.");
    }
  };

  if (loading) return <p className="muted" role="status">Loading your checkout…</p>;

  if (!session) {
    return (
      <section className="pane" data-testid="not-found">
        <h1>We couldn&apos;t find that checkout</h1>
        <p className="muted">{error?.code === 'SESSION_NOT_FOUND' ? 'The link may be wrong or out of date.' : error?.message}</p>
        <button type="button" className="primary" onClick={() => navigate('/')}>
          Start a new checkout
        </button>
      </section>
    );
  }

  return (
    <>
      <CheckoutView
        session={session}
        listing={listing}
        error={error}
        paidHere={paidHere}
        connection={connection}
        busy={busy}
        resumeUrl={`${window.location.origin}/resume/${session.id}`}
        onPay={run(complete)}
        onAcceptPrice={run(acknowledge)}
        onStartAgain={run(startAgain)}
        onBackToStart={() => navigate('/')}
      />
      {startError && (
        <p className="banner error" role="alert" data-testid="start-error">
          {startError}
        </p>
      )}
    </>
  );
}
