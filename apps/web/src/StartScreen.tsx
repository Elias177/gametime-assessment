import { useState } from 'react';
import { createSession, devAction, devToolsOn } from './api';
import { tabClient } from './clientId';
import { navigate } from './navigate';

export const DEMO_LISTING_ID = 'demo-listing';

export function StartScreen() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Sold out with dev tools on: the checkout page (and its chaos drawer) is out of reach from
  // here, so this is the way back out of a sell-out.
  const [canReset, setCanReset] = useState(false);

  const start = async () => {
    setBusy(true);
    setError(null);
    setCanReset(false);
    try {
      const res = await createSession(DEMO_LISTING_ID, tabClient('web'));
      if (res.ok) navigate(`/checkout/${res.body.id}`);
      else if (res.body?.error.code === 'SOLD_OUT') {
        setError('Sorry, these seats are sold out.');
        setCanReset(await devToolsOn());
      } else setError('Could not start checkout.');
    } catch {
      setError("Can't reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      const res = await devAction('reset');
      if (res.ok) {
        setError(null);
        setCanReset(false);
      } else setError('Could not reset the demo.');
    } catch {
      setError("Can't reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="pane" data-testid="start-screen">
      <h1>Checkout</h1>
      <p className="muted">Start a checkout here, then pick it up on your phone if you like.</p>
      <button type="button" className="primary" data-testid="start-checkout" disabled={busy} onClick={() => void start()}>
        Start checkout
      </button>
      {error && (
        <p className="banner error" role="alert" data-testid="start-error">
          {error}
        </p>
      )}
      {canReset && (
        <button type="button" className="danger" data-testid="start-reset" disabled={busy} onClick={() => void reset()}>
          New Checkout
        </button>
      )}
    </section>
  );
}
