import { useState } from 'react';
import { createSession } from './api';
import { navigate } from './navigate';

export const DEMO_LISTING_ID = 'demo-listing';

export function StartScreen() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await createSession(DEMO_LISTING_ID);
      if (res.ok) navigate(`/checkout/${res.body.id}`);
      else setError(res.body?.error.code === 'SOLD_OUT' ? 'Sorry, these seats are sold out.' : 'Could not start checkout.');
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
    </section>
  );
}
