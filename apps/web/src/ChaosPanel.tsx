import { useCallback, useEffect, useRef, useState } from 'react';
import { createSession, devAction, getDevStatus, getSession } from './api';
import type { ClientInfo, PaymentBehavior } from './api';
import { navigate } from './navigate';
import { DEMO_LISTING_ID } from './StartScreen';

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
  /** A payment is pending, so there is something to settle. The settle buttons only show then. */
  paymentPending: boolean;
  /** The order is placed, so nothing is left to break: those groups slide away, leaving New Checkout. */
  orderPlaced: boolean;
  onAction: (action: ChaosAction) => void;
}

const BEHAVIORS: readonly PaymentBehavior[] = ['succeed', 'fail', 'pending'];

export function ChaosPanelView({ paymentBehavior, result, busy, paymentPending, orderPlaced, onAction }: ChaosPanelViewProps) {
  return (
    <section className="chaos" data-testid="chaos-panel" aria-label="Chaos panel">
      <div className="chaos-body">
        {/* Always mounted so it can animate out; inert (not focusable, not clickable) once the order is placed. */}
        <div
          className="chaos-settle"
          data-testid="chaos-breakers"
          data-open={!orderPlaced}
          aria-hidden={orderPlaced}
          {...(orderPlaced ? { inert: '' } : {})}
        >
          <div className="chaos-settle-inner chaos-group">
            <fieldset disabled={busy}>
              <legend>Break the session</legend>
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
                  data-behavior={behavior}
                  aria-pressed={paymentBehavior === behavior}
                  className={paymentBehavior === behavior ? 'active' : undefined}
                  onClick={() => onAction({ type: 'behavior', behavior })}
                >
                  {behavior}
                </button>
              ))}
            </fieldset>
          </div>
        </div>

        {/* Always mounted so it can animate out; inert (not focusable, not clickable) while closed. */}
        <div
          className="chaos-settle"
          data-testid="chaos-settle"
          data-open={paymentPending}
          aria-hidden={!paymentPending}
          {...(paymentPending ? {} : { inert: '' })}
        >
          <div className="chaos-settle-inner">
            <fieldset disabled={busy}>
              <legend>Settle pending</legend>
              <button type="button" data-testid="chaos-settle-succeeded" onClick={() => onAction({ type: 'settle', outcome: 'succeeded' })}>
                Succeed
              </button>
              <button type="button" data-testid="chaos-settle-failed" onClick={() => onAction({ type: 'settle', outcome: 'failed' })}>
                Fail
              </button>
            </fieldset>
          </div>
        </div>

        <fieldset disabled={busy}>
          <legend>Demo</legend>
          <button type="button" className="danger" data-testid="chaos-reset" onClick={() => onAction({ type: 'reset' })}>
            New Checkout
          </button>
        </fieldset>
      </div>

      {/* After the buttons and pinned to the bottom of the drawer, so it never pushes them around. */}
      {result && (
        <p
          className={`banner chaos-result ${result.ok ? 'ok' : 'error'}`}
          role={result.ok ? 'status' : 'alert'}
          data-testid="chaos-result"
        >
          {result.text}
        </p>
      )}
    </section>
  );
}

const money = (cents: number) => `${cents < 0 ? '-' : '+'}$${Math.abs(cents / 100)}`;

/** A chaos action in words, for the action log. */
export function describeChaos(action: ChaosAction): string {
  switch (action.type) {
    case 'expire':
      return 'expired the seat hold';
    case 'price':
      return `${action.deltaCents < 0 ? 'lowered' : 'raised'} the price by $${Math.abs(action.deltaCents / 100)}`;
    case 'sell-out':
      return 'sold out the seats';
    case 'behavior':
      return `set the next payment to ${action.behavior === 'pending' ? 'stay pending' : action.behavior}`;
    case 'settle':
      return `made the pending payment ${action.outcome === 'succeeded' ? 'succeed' : 'fail'}`;
    case 'reset':
      return 'reset the demo';
  }
}

const RESULT_MS = 4000;

/** The chaos actions for one session, shared by everything in the drawer that can fire them. */
export interface Chaos {
  /** What the next payment will do, or undefined while dev tools are off or unreachable. */
  behavior: PaymentBehavior | undefined;
  /** An action is in flight. */
  busy: boolean;
  /** Outcome of the latest action, shown briefly. */
  result: ChaosResult | null;
  /** Run one action; resolves with how it went (and also sets `result`). */
  perform: (action: ChaosAction) => Promise<ChaosResult>;
  /**
   * Start a new checkout (a new session on the same listing, as the start screen does) and move
   * both panes to it, without resetting the server or the page (the drawer stays where it is).
   * Resolves with how it went; it fails, for instance, if the seats are sold out.
   */
  newCheckout: () => Promise<ChaosResult>;
  /**
   * The latest action the server accepted, from any button or scenario, with a count that goes up
   * each time (so doing the same action again is a new event). Null until one has been done.
   */
  performed: { action: ChaosAction; seq: number } | null;
}

/**
 * Chaos for the demo, aimed at one session. `behavior` stays undefined unless the server says dev
 * tools are on, and nothing else is requested until then, so it can never act against a normal
 * server. Each action changes the server; both panes then update through their own live streams,
 * not through anything here.
 */
export function useChaos(sessionId: string, client: ClientInfo): Chaos {
  const [behavior, setBehavior] = useState<PaymentBehavior>();
  const [listingId, setListingId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ChaosResult | null>(null);
  const [performed, setPerformed] = useState<Chaos['performed']>(null);
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
    return next;
  };

  const perform = async (action: ChaosAction): Promise<ChaosResult> => {
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
        return show({ ok: false, text: res.body ? `${res.body.error.code}: ${res.body.error.message}` : `HTTP ${res.status}` });
      }
      const ok = show({ ok: true, text: done });
      setPerformed((p) => ({ action, seq: (p?.seq ?? 0) + 1 }));
      if (action.type === 'reset') navigate('/');
      else await refreshStatus();
      return ok;
    } catch {
      return show({ ok: false, text: "Can't reach the server" });
    } finally {
      setBusy(false);
    }
  };

  const newCheckout = async (): Promise<ChaosResult> => {
    setBusy(true);
    try {
      const res = await createSession(listingId ?? DEMO_LISTING_ID, client);
      if (res.ok) {
        navigate(`/checkout/${res.body.id}`);
        return { ok: true, text: 'New checkout started' };
      }
      if (res.body?.error.code === 'SOLD_OUT') {
        return { ok: false, text: 'The seats are sold out. Use New Checkout in the Actions tab to get them back.' };
      }
      return { ok: false, text: 'Could not start a new checkout' };
    } catch {
      return { ok: false, text: "Can't reach the server" };
    } finally {
      setBusy(false);
    }
  };

  return { behavior, busy, result, perform, newCheckout, performed };
}

/** The chaos buttons. Renders nothing unless dev tools are on. */
export function ChaosPanel({ chaos, paymentPending, orderPlaced }: { chaos: Chaos; paymentPending: boolean; orderPlaced: boolean }) {
  if (!chaos.behavior) return null;
  return (
    <ChaosPanelView
      paymentBehavior={chaos.behavior}
      result={chaos.result}
      busy={chaos.busy}
      paymentPending={paymentPending}
      orderPlaced={orderPlaced}
      onAction={(a) => void chaos.perform(a)}
    />
  );
}
