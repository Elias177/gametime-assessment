import { useCallback, useEffect, useRef, useState } from 'react';
import { devAction, getDevStatus, getSession } from './api';
import type { ClientInfo, PaymentBehavior } from './api';
import { navigate } from './navigate';

export type ChaosAction =
  | { type: 'expire' }
  | { type: 'price'; deltaCents: number }
  | { type: 'sell-out' }
  | { type: 'behavior'; behavior: PaymentBehavior }
  | { type: 'settle'; outcome: 'succeeded' | 'failed' }
  | { type: 'reset' };

export interface ChaosResult {
  ok: boolean;
  text: string;
}

export interface ChaosPanelViewProps {
  /** What the next payment will do, as the server reports it. */
  paymentBehavior: PaymentBehavior;
  /** Outcome of the latest action, shown briefly. */
  result: ChaosResult | null;
  /** An action is in flight. */
  busy: boolean;
  onAction: (action: ChaosAction) => void;
}

const BEHAVIORS: readonly PaymentBehavior[] = ['succeed', 'fail', 'pending'];

export function ChaosPanelView({ paymentBehavior, result, busy, onAction }: ChaosPanelViewProps) {
  const [open, setOpen] = useState(true);

  return (
    <section className="chaos" data-testid="chaos-panel" aria-label="Chaos panel">
      <header className="chaos-header">
        <button
          type="button"
          className="link"
          data-testid="chaos-toggle"
          aria-expanded={open}
          aria-controls="chaos-body"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Hide' : 'Show'} chaos panel
        </button>
        <span className="muted" data-testid="chaos-behavior">
          Next payment: {paymentBehavior}
        </span>
      </header>

      {result && (
        <p
          className={`banner ${result.ok ? 'ok' : 'error'}`}
          role={result.ok ? 'status' : 'alert'}
          data-testid="chaos-result"
        >
          {result.text}
        </p>
      )}

      {open && (
        <div className="chaos-body" id="chaos-body">
          <fieldset disabled={busy}>
            <legend>Session</legend>
            <button type="button" data-testid="chaos-expire" onClick={() => onAction({ type: 'expire' })}>
              Expire hold
            </button>
            <button type="button" data-testid="chaos-price-up" onClick={() => onAction({ type: 'price', deltaCents: 1200 })}>
              Price +$12
            </button>
            <button type="button" data-testid="chaos-price-down" onClick={() => onAction({ type: 'price', deltaCents: -500 })}>
              Price -$5
            </button>
            <button type="button" data-testid="chaos-sell-out" onClick={() => onAction({ type: 'sell-out' })}>
              Sell out
            </button>
          </fieldset>

          <fieldset disabled={busy}>
            <legend>Next payment</legend>
            {BEHAVIORS.map((behavior) => (
              <button
                key={behavior}
                type="button"
                data-testid={`chaos-behavior-${behavior}`}
                aria-pressed={paymentBehavior === behavior}
                className={paymentBehavior === behavior ? 'active' : undefined}
                onClick={() => onAction({ type: 'behavior', behavior })}
              >
                {behavior}
              </button>
            ))}
          </fieldset>

          <fieldset disabled={busy}>
            <legend>Settle pending</legend>
            <button type="button" data-testid="chaos-settle-succeeded" onClick={() => onAction({ type: 'settle', outcome: 'succeeded' })}>
              Succeed
            </button>
            <button type="button" data-testid="chaos-settle-failed" onClick={() => onAction({ type: 'settle', outcome: 'failed' })}>
              Fail
            </button>
          </fieldset>

          <fieldset disabled={busy}>
            <legend>Demo</legend>
            <button type="button" data-testid="chaos-reset" onClick={() => onAction({ type: 'reset' })}>
              Reset demo
            </button>
          </fieldset>
        </div>
      )}
    </section>
  );
}

const money = (cents: number) => `${cents < 0 ? '-' : '+'}$${Math.abs(cents / 100)}`;

const RESULT_MS = 4000;

/**
 * Chaos panel for the demo, aimed at one session. Renders nothing unless the server says dev tools
 * are on, so it can never show up against a normal server. Each action changes the server; both
 * panes then update through their own live streams, not through anything here.
 */
export function ChaosPanel({ sessionId, client }: { sessionId: string; client: ClientInfo }) {
  const [behavior, setBehavior] = useState<PaymentBehavior>();
  const [listingId, setListingId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ChaosResult | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout>>();

  const refreshStatus = useCallback(async () => {
    try {
      const res = await getDevStatus();
      setBehavior(res.ok && res.body?.enabled ? res.body.paymentBehavior : undefined);
    } catch {
      setBehavior(undefined);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  // Price and sell-out act on a listing; learn which one this session is for (only once we know
  // the panel will show, so a normal server never sees this request).
  const enabled = behavior !== undefined;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    getSession(sessionId, client)
      .then((res) => {
        if (!cancelled && res.ok) setListingId(res.body.listingId);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // `client` is fixed for the life of the pane.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, enabled]);

  useEffect(() => () => clearTimeout(clearTimer.current), []);

  const show = (next: ChaosResult) => {
    setResult(next);
    clearTimeout(clearTimer.current);
    clearTimer.current = setTimeout(() => setResult(null), RESULT_MS);
  };

  const perform = async (action: ChaosAction) => {
    const needsListing = action.type === 'price' || action.type === 'sell-out';
    if (needsListing && !listingId) return show({ ok: false, text: 'Still loading the session' });

    const [path, body, done] = ((): [string, object, string] => {
      switch (action.type) {
        case 'expire':
          return [`expire/${sessionId}`, {}, 'Hold expired'];
        case 'price':
          return ['price', { listingId, deltaCents: action.deltaCents }, `Price ${money(action.deltaCents)}`];
        case 'sell-out':
          return ['sell-out', { listingId }, 'Sold out'];
        case 'behavior':
          return ['payment-behavior', { behavior: action.behavior }, `Next payment will ${action.behavior}`];
        case 'settle':
          return [`settle/${sessionId}`, { outcome: action.outcome }, `Pending payment ${action.outcome}`];
        case 'reset':
          return ['reset', {}, 'Demo reset'];
      }
    })();

    setBusy(true);
    try {
      const res = await devAction(path, body);
      if (!res.ok) {
        show({ ok: false, text: res.body ? `${res.body.error.code}: ${res.body.error.message}` : `HTTP ${res.status}` });
        return;
      }
      show({ ok: true, text: done });
      if (action.type === 'reset') navigate('/');
      else await refreshStatus();
    } catch {
      show({ ok: false, text: "Can't reach the server" });
    } finally {
      setBusy(false);
    }
  };

  if (!behavior) return null;
  return <ChaosPanelView paymentBehavior={behavior} result={result} busy={busy} onAction={(a) => void perform(a)} />;
}
