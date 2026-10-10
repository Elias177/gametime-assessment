import { useState } from 'react';
import { createSession } from './api';
import type { ResumeInitialState } from '@checkout/shared';
import type { ClientInfo } from './api';
import { CheckoutView } from './CheckoutView';
import { MobileCheckoutView } from './MobileCheckoutView';
import { navigate } from './navigate';
import { useCheckoutSession } from './useCheckoutSession';

/**
 * Wires one checkout session (via its own hook instance) to a view. Each pane is a separate client:
 * `client` identifies it to the server, and its surface picks the desktop or the phone layout.
 */
export function CheckoutPane({
  sessionId,
  client,
  initialState,
}: {
  sessionId: string;
  client: ClientInfo;
  /** The pre-rendered state this page started from (only `/resume` has one). */
  initialState?: ResumeInitialState;
}) {
  const { session, listing, loading, error, connection, paidHere, confirmed, acknowledge, complete } =
    useCheckoutSession(sessionId, { client, initialState });
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
      const res = await createSession(session.listingId, client);
      if (res.ok) navigate(`${window.location.pathname.startsWith('/resume/') ? '/resume' : '/checkout'}/${res.body.id}`);
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

  const actions = {
    session,
    listing,
    error,
    paidHere,
    connection,
    busy,
    confirmingPrice: !confirmed,
    onPay: run(complete),
    onAcceptPrice: run(acknowledge),
    onStartAgain: run(startAgain),
    onBackToStart: () => navigate('/'),
  };

  return (
    <>
      {client.surface === 'mobile' ? (
        <MobileCheckoutView {...actions} startedHere={session.originClientId === client.clientId} />
      ) : (
        <CheckoutView {...actions} resumeUrl={`${window.location.origin}/resume/${session.id}`} />
      )}
      {startError && (
        <p className="banner error" role="alert" data-testid="start-error">
          {startError}
        </p>
      )}
    </>
  );
}
