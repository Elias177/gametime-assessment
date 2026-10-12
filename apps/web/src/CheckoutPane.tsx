import { useEffect, useRef, useState } from 'react';
import { createSession, devAction, devToolsOn } from './api';
import type { PaneControls, PaneHandle, PaneName, PaneOp } from './paneControls';
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
  onRemoteUpdate,
  controls,
  paneName,
}: {
  sessionId: string;
  client: ClientInfo;
  /** The pre-rendered state this page started from (only `/resume` has one). */
  initialState?: ResumeInitialState;
  /** This pane was just updated by something other than itself (the other device, or the server). */
  onRemoteUpdate?: () => void;
  /**
   * The split demo's registry: this pane tells it its status and hands it the same Pay and Accept
   * actions its buttons use, so the dev drawer's scenarios can press them. Needs `paneName` too.
   */
  controls?: PaneControls;
  paneName?: PaneName;
}) {
  const { session, listing, loading, error, connection, paidHere, confirmed, acknowledge, complete } =
    useCheckoutSession(sessionId, { client, initialState, onRemoteUpdate });
  const [busy, setBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  /**
   * An action of this pane. With an `op`, the registry hears of it once its request is done, however
   * it was started (a click on the button, or a scenario), so a scenario can tell that a person did
   * a step themselves.
   */
  const run = (action: () => Promise<void>, op?: PaneOp) => async () => {
    setBusy(true);
    try {
      await action();
      if (op && controls && paneName) controls.reportAction(paneName, op);
    } finally {
      setBusy(false);
    }
  };

  // What the registry calls is always this render's actions, so it never presses a stale one.
  const handle = useRef<PaneHandle>();
  handle.current = { pay: run(complete, 'pay'), acceptPrice: run(acknowledge, 'accept-price') };

  useEffect(() => {
    if (!controls || !paneName) return;
    controls.register(paneName, {
      pay: () => handle.current!.pay(),
      acceptPrice: () => handle.current!.acceptPrice(),
    });
    return () => {
      controls.register(paneName, undefined);
      controls.reportStatus(paneName, undefined);
    };
  }, [controls, paneName]);

  const status = session?.status;
  useEffect(() => {
    if (controls && paneName) controls.reportStatus(paneName, status);
  }, [controls, paneName, status]);

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

  // With dev tools on, leaving a dead end also resets the demo, so the start screen isn't sold out.
  const backToStart = async () => {
    try {
      if (await devToolsOn()) await devAction('reset');
    } catch {
      // Going back to the start matters more than the reset.
    }
    navigate('/');
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
    onPay: run(complete, 'pay'),
    onAcceptPrice: run(acknowledge, 'accept-price'),
    onStartAgain: run(startAgain),
    onBackToStart: backToStart,
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
