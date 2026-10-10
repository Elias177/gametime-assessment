import { useCallback, useEffect, useRef, useState } from 'react';
import { isTerminalStatus } from '@checkout/shared';
import type { CheckoutSession, Listing } from '@checkout/shared';
import { acknowledgeSession, completeSession, eventsUrl, getListing, getSession } from './api';
import type { ApiError, ApiResult, ClientInfo } from './api';

export type Connection = 'connecting' | 'sse' | 'polling';

export interface UseCheckoutSessionOptions {
  /** This pane's identity, sent with every request. Keep it stable for the life of the pane. */
  client: ClientInfo;
  /** Makes idempotency keys; injectable so tests get predictable ones. */
  newKey?: () => string;
  /** Polling interval used when the SSE stream is unavailable. */
  pollMs?: number;
}

const NETWORK_ERROR: ApiError = { code: 'NETWORK_ERROR', message: 'could not reach the server' };

/**
 * Client view of one checkout session. The server owns the state; this hook only mirrors it:
 * first fetch, then the SSE stream (falling back to polling if it fails), plus a refetch when
 * the window regains focus.
 */
export function useCheckoutSession(id: string, options: UseCheckoutSessionOptions) {
  const [session, setSession] = useState<CheckoutSession>();
  const [listing, setListing] = useState<Listing>();
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');

  const sessionRef = useRef<CheckoutSession>();
  const idRef = useRef(id);
  /** The idempotency key of the payment attempt in progress, if one has started. */
  const attemptKeyRef = useRef<string>();
  const optionsRef = useRef(options);
  optionsRef.current = options;

  /**
   * Accept a session unless it is older than the one already shown (SSE and fetches can race).
   * A strictly newer version also clears the shown error: it described a state that has since
   * moved on (e.g. a VERSION_CONFLICT or PAYMENT_IN_PROGRESS reply).
   */
  const applySession = useCallback((next: CheckoutSession) => {
    const current = sessionRef.current;
    if (current && next.version < current.version) return;
    if (current && next.version > current.version) setError(null);
    sessionRef.current = next;
    setSession(next);
  }, []);

  const fetchSession = useCallback(async () => {
    try {
      const res = await getSession(id, optionsRef.current.client);
      if (idRef.current !== id) return;
      if (res.ok) applySession(res.body);
      else if (!sessionRef.current) setError(res.body?.error ?? NETWORK_ERROR);
    } catch {
      // Keep showing what we have; the stream/poll/focus refetch will try again.
      if (idRef.current === id && !sessionRef.current) setError(NETWORK_ERROR);
    }
  }, [id, applySession]);

  // First fetch (and reset when the id changes).
  useEffect(() => {
    idRef.current = id;
    sessionRef.current = undefined;
    attemptKeyRef.current = undefined;
    setSession(undefined);
    setListing(undefined);
    setError(null);
    setLoaded(false);
    setLoading(true);
    setConnection('connecting');

    let cancelled = false;
    void fetchSession().then(() => {
      if (cancelled) return;
      setLoading(false);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [id, fetchSession]);

  // The listing never changes for a session, so fetch it once the session names it.
  const listingId = session?.listingId;
  useEffect(() => {
    if (!listingId) return;
    let cancelled = false;
    getListing(listingId, optionsRef.current.client)
      .then((res) => {
        if (!cancelled && res.ok) setListing(res.body);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [listingId]);

  // Live updates: SSE, or polling if SSE can't be established or drops.
  const terminal = session ? isTerminalStatus(session.status) : false;
  const notFound = error?.code === 'SESSION_NOT_FOUND';
  useEffect(() => {
    if (!loaded || terminal || notFound) return;

    let source: EventSource | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    const startPolling = () => {
      if (pollTimer) return;
      setConnection('polling');
      pollTimer = setInterval(() => void fetchSession(), optionsRef.current.pollMs ?? 5000);
    };

    if (typeof EventSource === 'undefined') {
      startPolling();
    } else {
      source = new EventSource(eventsUrl(id, optionsRef.current.client));
      source.addEventListener('session', (event) => {
        setConnection('sse');
        applySession(JSON.parse((event as MessageEvent<string>).data) as CheckoutSession);
      });
      source.onerror = () => {
        source?.close();
        source = undefined;
        // The server closes the stream itself after a final status; that is not a failure.
        const current = sessionRef.current;
        if (!current || !isTerminalStatus(current.status)) startPolling();
      };
    }

    return () => {
      source?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [id, loaded, terminal, notFound, fetchSession, applySession]);

  // Coming back to the tab/device: the state may have moved while we were away.
  useEffect(() => {
    const onFocus = () => {
      const current = sessionRef.current;
      if (!current || !isTerminalStatus(current.status)) void fetchSession();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [fetchSession]);

  /** Show what an action returned: the new session on success, the server's fresh one on a refusal. */
  const settle = useCallback(
    (res: ApiResult<CheckoutSession>) => {
      if (res.ok) {
        applySession(res.body);
        setError(null);
      } else {
        if (res.body?.session) applySession(res.body.session);
        setError(res.body?.error ?? { code: `HTTP_${res.status}`, message: 'request failed' });
      }
    },
    [applySession],
  );

  const acknowledge = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    try {
      settle(await acknowledgeSession(id, current.version, optionsRef.current.client));
    } catch {
      setError(NETWORK_ERROR);
    }
  }, [id, settle]);

  /**
   * One idempotency key per payment attempt. The key survives anything that leaves the attempt's
   * outcome unknown or unchanged (network error, 409, 202), so a retry is a replay, never a second
   * charge. Only a definitive 402 PAYMENT_FAILED ends the attempt; the next click is a new one.
   * The `version` always comes from the freshest session, so a 409 only updates the version.
   */
  const complete = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    const key = (attemptKeyRef.current ??= (optionsRef.current.newKey ?? (() => crypto.randomUUID()))());
    try {
      const res = await completeSession(id, key, current.version, optionsRef.current.client);
      if (!res.ok && res.status === 402 && res.body?.error.code === 'PAYMENT_FAILED') {
        attemptKeyRef.current = undefined;
      }
      settle(res);
    } catch {
      setError(NETWORK_ERROR);
    }
  }, [id, settle]);

  // The order is ours only if the payment attempt that produced it used this client's own key.
  // (The key lives in memory, so after a page reload we no longer claim a past payment.)
  const paidHere =
    session?.status === 'completed' &&
    attemptKeyRef.current !== undefined &&
    session.idempotencyKey === attemptKeyRef.current;

  return { session, listing, loading, error, connection, paidHere, acknowledge, complete };
}
