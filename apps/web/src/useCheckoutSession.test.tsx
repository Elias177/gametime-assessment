// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { CheckoutSession, Listing, ResumeInitialState } from '@checkout/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientInfo } from './api';
import { useCheckoutSession } from './useCheckoutSession';

const listing: Listing = {
  id: 'l1',
  eventName: 'The Midnight Orchestra',
  venue: 'Harbor Hall',
  date: '2030-06-14T19:30:00-07:00',
  section: 'Orchestra Left',
  row: 'F',
  seats: ['12', '13'],
};

const makeSession = (overrides: Partial<CheckoutSession> = {}): CheckoutSession => ({
  id: 's1',
  listingId: 'l1',
  createdAt: '2030-01-01T00:00:00.000Z',
  originClientId: 'client-a',
  originSurface: 'web',
  status: 'active',
  priceSnapshot: 10000,
  currentPrice: 10000,
  holdExpiresAt: '2030-01-01T00:10:00.000Z',
  version: 1,
  changes: [],
  ...overrides,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data: unknown) {
    for (const l of this.listeners.get(type) ?? []) l(new MessageEvent(type, { data: JSON.stringify(data) }));
  }

  fail() {
    this.onerror?.();
  }
}

interface Recorded {
  method: string;
  path: string;
  key?: string;
  clientId?: string;
  surface?: string;
  body?: { version?: number };
}

/** Programmable fake server: `complete` decides what POST /complete answers. */
function installFakeServer(initial: CheckoutSession) {
  const state = {
    session: initial,
    requests: [] as Recorded[],
    complete: (): Response | Promise<Response> => json(200, initial),
    /** Hold GET /api/sessions/:id until this resolves, to test what shows before the live answer. */
    gate: undefined as Promise<void> | undefined,
    /** Overrides the GET /api/sessions/:id answer (default: `state.session` as 200). */
    sessionReply: undefined as (() => Response) | undefined,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      state.requests.push({
        method: init?.method ?? 'GET',
        path,
        key: headers['Idempotency-Key'],
        clientId: headers['X-Client-Id'],
        surface: headers['X-Surface'],
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      if (path.endsWith('/complete')) return state.complete();
      if (path.startsWith('/api/listings/')) return json(200, listing);
      if (path.startsWith('/api/sessions/')) {
        await state.gate;
        return state.sessionReply ? state.sessionReply() : json(200, state.session);
      }
      return json(404, { error: { code: 'NOT_FOUND', message: path } });
    }),
  );
  return state;
}

const completes = (state: ReturnType<typeof installFakeServer>) =>
  state.requests.filter((r) => r.path.endsWith('/complete'));
const sessionFetches = (state: ReturnType<typeof installFakeServer>) =>
  state.requests.filter((r) => r.method === 'GET' && r.path === '/api/sessions/s1');

const CLIENT: ClientInfo = { clientId: 'pane-1', surface: 'web' };

async function mount(
  options: { pollMs?: number; client?: ClientInfo; initialState?: ResumeInitialState; onRemoteUpdate?: () => void } = {},
) {
  let n = 0;
  const hook = renderHook(() =>
    useCheckoutSession('s1', { client: CLIENT, newKey: () => `key-${++n}`, ...options }),
  );
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('client identity', () => {
  it('sends X-Client-Id and X-Surface on every API call and in the SSE URL', async () => {
    const state = installFakeServer(makeSession({ status: 'price_changed', currentPrice: 12000, version: 2 }));
    const client: ClientInfo = { clientId: 'phone-pane', surface: 'mobile' };
    const { result } = await mount({ client });
    await waitFor(() => expect(result.current.listing).toEqual(listing));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    await act(async () => {
      await result.current.acknowledge();
    });
    await act(async () => {
      await result.current.complete();
    });

    // listing fetch, session fetch, acknowledge and complete: all identified.
    expect(state.requests.map((r) => r.path)).toEqual(
      expect.arrayContaining(['/api/sessions/s1', '/api/listings/l1', '/api/sessions/s1/acknowledge', '/api/sessions/s1/complete']),
    );
    for (const request of state.requests) {
      expect([request.path, request.clientId, request.surface]).toEqual([request.path, 'phone-pane', 'mobile']);
    }
    expect(FakeEventSource.instances[0]!.url).toBe('/api/sessions/s1/events?clientId=phone-pane&surface=mobile');
  });

  it('keeps the same client id for the whole life of the pane, across re-renders', async () => {
    const state = installFakeServer(makeSession());
    const { result, rerender } = await mount();

    rerender();
    await act(async () => {
      await result.current.complete();
    });

    expect(new Set(state.requests.map((r) => r.clientId))).toEqual(new Set(['pane-1']));
  });
});

describe('loading and live updates', () => {
  it('fetches the session and its listing, then subscribes to SSE', async () => {
    installFakeServer(makeSession());
    const { result } = await mount();

    expect(result.current.session).toMatchObject({ id: 's1', status: 'active' });
    await waitFor(() => expect(result.current.listing).toEqual(listing));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(FakeEventSource.instances[0]!.url).toBe('/api/sessions/s1/events?clientId=pane-1&surface=web');
  });

  it('applies sessions pushed over SSE, ignores older ones, and closes the stream when finished', async () => {
    installFakeServer(makeSession());
    const { result } = await mount();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;

    act(() => source.emit('session', makeSession({ status: 'price_changed', currentPrice: 12000, version: 2 })));
    expect(result.current.session).toMatchObject({ status: 'price_changed', version: 2 });
    expect(result.current.connection).toBe('sse');

    act(() => source.emit('session', makeSession({ version: 1 }))); // stale
    expect(result.current.session?.version).toBe(2);

    act(() => source.emit('session', makeSession({ status: 'expired', version: 3 })));
    expect(result.current.session?.status).toBe('expired');
    await waitFor(() => expect(source.closed).toBe(true));
  });

  it('falls back to polling when the SSE stream fails', async () => {
    const server = installFakeServer(makeSession());
    const { result } = await mount({ pollMs: 20 });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const before = sessionFetches(server).length;

    server.session = makeSession({ status: 'price_changed', currentPrice: 12000, version: 2 });
    act(() => FakeEventSource.instances[0]!.fail());

    await waitFor(() => expect(result.current.session?.version).toBe(2));
    expect(result.current.connection).toBe('polling');
    expect(sessionFetches(server).length).toBeGreaterThan(before);
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
  });

  it('does not treat the server closing the stream after a final status as a failure', async () => {
    const server = installFakeServer(makeSession());
    const { result } = await mount({ pollMs: 20 });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;
    const before = sessionFetches(server).length;

    act(() => {
      source.emit('session', makeSession({ status: 'completed', version: 3, orderId: 'o1' }));
      source.fail(); // the close that follows the final event
    });
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(result.current.connection).toBe('sse');
    expect(sessionFetches(server).length).toBe(before);
  });

  it('refetches when the window regains focus', async () => {
    const server = installFakeServer(makeSession());
    const { result } = await mount();
    const before = sessionFetches(server).length;

    server.session = makeSession({ status: 'expired', version: 2 });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(result.current.session?.status).toBe('expired'));
    expect(sessionFetches(server).length).toBe(before + 1);
  });

  it('reports a missing session as an error and does not open a stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(404, { error: { code: 'SESSION_NOT_FOUND', message: 'no session s1' } })),
    );
    const { result } = await mount();

    expect(result.current.session).toBeUndefined();
    expect(result.current.error).toEqual({ code: 'SESSION_NOT_FOUND', message: 'no session s1' });
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});

describe('idempotency key per payment attempt', () => {
  it('reuses the key across 409s and takes only the new version', async () => {
    const server = installFakeServer(makeSession());
    const { result } = await mount();

    server.complete = () =>
      json(409, {
        error: { code: 'VERSION_CONFLICT', message: 'session changed' },
        session: makeSession({ version: 5 }),
      });
    await act(() => result.current.complete());
    expect(result.current.session?.version).toBe(5);
    expect(result.current.error?.code).toBe('VERSION_CONFLICT');

    await act(() => result.current.complete());

    const [first, second] = completes(server);
    expect(first).toMatchObject({ key: 'key-1', body: { version: 1 } });
    expect(second).toMatchObject({ key: 'key-1', body: { version: 5 } });
  });

  it('reuses the key after PAYMENT_IN_PROGRESS', async () => {
    const server = installFakeServer(makeSession());
    const { result } = await mount();

    server.complete = () =>
      json(409, {
        error: { code: 'PAYMENT_IN_PROGRESS', message: 'in progress' },
        session: makeSession({ status: 'payment_pending', version: 2 }),
      });
    await act(() => result.current.complete());
    await act(() => result.current.complete());

    expect(completes(server).map((r) => r.key)).toEqual(['key-1', 'key-1']);
  });

  it('reuses the key and the version after a network error', async () => {
    const server = installFakeServer(makeSession());
    const { result } = await mount();

    server.complete = () => Promise.reject(new TypeError('Failed to fetch'));
    await act(() => result.current.complete());
    expect(result.current.error?.code).toBe('NETWORK_ERROR');

    server.complete = () => json(200, makeSession({ status: 'completed', version: 3, orderId: 'o1' }));
    await act(() => result.current.complete());

    const [first, second] = completes(server);
    expect(first).toMatchObject({ key: 'key-1', body: { version: 1 } });
    expect(second).toMatchObject({ key: 'key-1', body: { version: 1 } });
    expect(result.current.session).toMatchObject({ status: 'completed', orderId: 'o1' });
    expect(result.current.error).toBeNull();
  });

  it('reuses the key while a payment is pending (202)', async () => {
    const server = installFakeServer(makeSession());
    const { result } = await mount();

    server.complete = () => json(202, makeSession({ status: 'payment_pending', version: 2, idempotencyKey: 'key-1' }));
    await act(() => result.current.complete());
    await act(() => result.current.complete());

    expect(completes(server).map((r) => r.key)).toEqual(['key-1', 'key-1']);
    expect(completes(server)[1]!.body).toEqual({ version: 2 });
  });

  it('makes a new key after a 402 PAYMENT_FAILED, with the version from the failure', async () => {
    const server = installFakeServer(makeSession());
    const { result } = await mount();

    server.complete = () =>
      json(402, {
        error: { code: 'PAYMENT_FAILED', message: 'card_declined' },
        session: makeSession({ status: 'payment_failed', version: 3, idempotencyKey: 'key-1' }),
      });
    await act(() => result.current.complete());
    expect(result.current.session?.status).toBe('payment_failed');
    expect(result.current.error).toEqual({ code: 'PAYMENT_FAILED', message: 'card_declined' });

    server.complete = () => json(200, makeSession({ status: 'completed', version: 5, orderId: 'o1' }));
    await act(() => result.current.complete());

    const [first, second] = completes(server);
    expect(first).toMatchObject({ key: 'key-1', body: { version: 1 } });
    expect(second).toMatchObject({ key: 'key-2', body: { version: 3 } });
  });

  it('keeps using the new key until another 402', async () => {
    const server = installFakeServer(makeSession());
    const { result } = await mount();
    const failure = (version: number) =>
      json(402, {
        error: { code: 'PAYMENT_FAILED', message: 'card_declined' },
        session: makeSession({ status: 'payment_failed', version }),
      });

    server.complete = () => failure(3);
    await act(() => result.current.complete()); // key-1 fails
    server.complete = () => json(409, { error: { code: 'VERSION_CONFLICT', message: 'x' }, session: makeSession({ version: 6 }) });
    await act(() => result.current.complete()); // key-2 refused
    await act(() => result.current.complete()); // still key-2
    server.complete = () => failure(8);
    await act(() => result.current.complete()); // key-2 fails
    await act(() => result.current.complete()); // key-3

    expect(completes(server).map((r) => r.key)).toEqual(['key-1', 'key-2', 'key-2', 'key-2', 'key-3']);
  });
});

describe('onRemoteUpdate', () => {
  it('is not called by the first load', async () => {
    installFakeServer(makeSession());
    const onRemoteUpdate = vi.fn();
    await mount({ onRemoteUpdate });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    expect(onRemoteUpdate).not.toHaveBeenCalled();
  });

  it('is called once for a newer session over the stream, not for a stale or repeated one', async () => {
    installFakeServer(makeSession());
    const onRemoteUpdate = vi.fn();
    await mount({ onRemoteUpdate });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;

    act(() => source.emit('session', makeSession({ version: 1 }))); // the stream's first frame: same version
    expect(onRemoteUpdate).not.toHaveBeenCalled();

    act(() => source.emit('session', makeSession({ status: 'price_changed', currentPrice: 12000, version: 2 })));
    expect(onRemoteUpdate).toHaveBeenCalledTimes(1);

    act(() => source.emit('session', makeSession({ status: 'price_changed', currentPrice: 12000, version: 2 })));
    act(() => source.emit('session', makeSession({ version: 1 })));
    expect(onRemoteUpdate).toHaveBeenCalledTimes(1);
  });

  it('is called for a newer session found by a refocus refetch', async () => {
    const server = installFakeServer(makeSession());
    const onRemoteUpdate = vi.fn();
    const { result } = await mount({ onRemoteUpdate });

    server.session = makeSession({ status: 'expired', version: 2 });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(result.current.session?.status).toBe('expired'));
    expect(onRemoteUpdate).toHaveBeenCalledTimes(1);
  });

  it("is not called for the reply to this pane's own action", async () => {
    const server = installFakeServer(makeSession());
    const onRemoteUpdate = vi.fn();
    const { result } = await mount({ onRemoteUpdate });

    server.complete = () => json(200, makeSession({ status: 'completed', version: 2, idempotencyKey: 'key-1' }));
    await act(() => result.current.complete());

    expect(result.current.session?.status).toBe('completed');
    expect(onRemoteUpdate).not.toHaveBeenCalled();
  });

  it("is not called for the stream's echo of this pane's own action, even if it lands before the reply", async () => {
    const server = installFakeServer(makeSession());
    const onRemoteUpdate = vi.fn();
    const { result } = await mount({ onRemoteUpdate });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;

    const completed = makeSession({ status: 'completed', version: 2, idempotencyKey: 'key-1' });
    let reply!: () => void;
    server.complete = () =>
      new Promise<Response>((resolve) => {
        reply = () => resolve(json(200, completed));
      });
    let paying!: Promise<unknown>;
    act(() => {
      paying = result.current.complete();
    });

    act(() => source.emit('session', completed)); // the echo, before the reply
    expect(onRemoteUpdate).not.toHaveBeenCalled();

    await act(async () => {
      reply();
      await paying;
    });
    expect(onRemoteUpdate).not.toHaveBeenCalled();
  });

  it('is called again once the own action is done and something else changes the session', async () => {
    const server = installFakeServer(makeSession());
    const onRemoteUpdate = vi.fn();
    const { result } = await mount({ onRemoteUpdate });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;

    server.complete = () => json(200, makeSession({ status: 'payment_pending', version: 2 }));
    await act(() => result.current.complete());
    expect(onRemoteUpdate).not.toHaveBeenCalled();

    act(() => source.emit('session', makeSession({ status: 'completed', version: 3 }))); // settled by the server
    expect(onRemoteUpdate).toHaveBeenCalledTimes(1);
  });

  it('is not called when a pre-rendered state is confirmed, even if the live answer differs', async () => {
    installFakeServer(makeSession({ status: 'expired', version: 4 }));
    const onRemoteUpdate = vi.fn();
    const { result } = await mount({
      initialState: { session: makeSession({ version: 1 }), listing },
      onRemoteUpdate,
    });

    await waitFor(() => expect(result.current.confirmed).toBe(true));
    expect(result.current.session?.status).toBe('expired');
    expect(onRemoteUpdate).not.toHaveBeenCalled();
  });
});

describe('acknowledge', () => {
  it('sends the current version and shows the result', async () => {
    const server = installFakeServer(makeSession({ status: 'price_changed', currentPrice: 12000, version: 2 }));
    const { result } = await mount();

    vi.mocked(fetch).mockImplementationOnce(async (path, init) => {
      server.requests.push({ method: init?.method ?? 'GET', path: String(path), body: JSON.parse(init!.body as string) });
      return json(200, makeSession({ priceSnapshot: 12000, currentPrice: 12000, version: 3 }));
    });
    await act(() => result.current.acknowledge());

    expect(server.requests.find((r) => r.path.endsWith('/acknowledge'))?.body).toEqual({ version: 2 });
    expect(result.current.session).toMatchObject({ status: 'active', priceSnapshot: 12000, version: 3 });
  });
});

describe('complete outcome', () => {
  it("is 'accepted' when the payment is taken", async () => {
    const server = installFakeServer(makeSession());
    const { result } = await mount();
    server.complete = () => json(200, makeSession({ status: 'completed', version: 4, orderId: 'order-1', idempotencyKey: 'key-1' }));
    let outcome;
    await act(async () => {
      outcome = await result.current.complete();
    });
    expect(outcome).toBe('accepted');
  });

  it("is 'rejected' when the other device's payment is in progress", async () => {
    const server = installFakeServer(makeSession());
    const { result } = await mount();
    server.complete = () =>
      json(409, { error: { code: 'PAYMENT_IN_PROGRESS', message: 'in progress' }, session: makeSession({ status: 'payment_pending', version: 3 }) });
    let outcome;
    await act(async () => {
      outcome = await result.current.complete();
    });
    expect(outcome).toBe('rejected');
  });

  it("is 'rejected' when /complete answers completedElsewhere", async () => {
    const server = installFakeServer(makeSession());
    const { result } = await mount();
    server.complete = () =>
      json(200, { ...makeSession({ status: 'completed', version: 4, orderId: 'order-1', idempotencyKey: 'phone-key' }), completedElsewhere: true });
    let outcome;
    await act(async () => {
      outcome = await result.current.complete();
    });
    expect(outcome).toBe('rejected');
  });
});

describe('paidHere', () => {
  const completed = (idempotencyKey: string, extra: object = {}) =>
    makeSession({ status: 'completed', version: 4, orderId: 'order-1', idempotencyKey, ...extra });

  it('is false until the session completes', async () => {
    installFakeServer(makeSession());
    const { result } = await mount();

    expect(result.current.paidHere).toBe(false);
  });

  it("is true when this client's own attempt key produced the order", async () => {
    const server = installFakeServer(makeSession());
    const { result } = await mount();

    server.complete = () => json(200, completed('key-1'));
    await act(() => result.current.complete());

    expect(result.current.session?.status).toBe('completed');
    expect(result.current.paidHere).toBe(true);
  });

  it('is false when /complete answers completedElsewhere', async () => {
    const server = installFakeServer(makeSession());
    const { result } = await mount();

    server.complete = () => json(200, completed('phone-key', { completedElsewhere: true }));
    await act(() => result.current.complete());

    expect(result.current.session).toMatchObject({ status: 'completed', orderId: 'order-1' });
    expect(result.current.paidHere).toBe(false);
  });

  it('is false when the completed session arrives over SSE', async () => {
    installFakeServer(makeSession());
    const { result } = await mount();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => FakeEventSource.instances[0]!.emit('session', completed('phone-key')));

    expect(result.current.session?.status).toBe('completed');
    expect(result.current.paidHere).toBe(false);
  });

  it('is false when the completed session arrives from a refetch', async () => {
    const server = installFakeServer(makeSession());
    const { result } = await mount();

    server.session = completed('phone-key');
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(result.current.session?.status).toBe('completed'));
    expect(result.current.paidHere).toBe(false);
  });

  it('stays true when our own completed order is re-delivered over SSE', async () => {
    const server = installFakeServer(makeSession());
    const { result } = await mount();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    server.complete = () => json(200, completed('key-1'));
    await act(() => result.current.complete());
    act(() => FakeEventSource.instances[0]!.emit('session', completed('key-1')));

    expect(result.current.paidHere).toBe(true);
  });
});

describe('action errors', () => {
  const conflict = (code: string, session: CheckoutSession) =>
    json(409, { error: { code, message: code }, session });

  it('clears a stale VERSION_CONFLICT once a newer version arrives', async () => {
    const server = installFakeServer(makeSession());
    const { result } = await mount();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    server.complete = () => conflict('VERSION_CONFLICT', makeSession({ version: 2 }));
    await act(() => result.current.complete());
    expect(result.current.error?.code).toBe('VERSION_CONFLICT');
    expect(result.current.session?.version).toBe(2);

    act(() => FakeEventSource.instances[0]!.emit('session', makeSession({ status: 'price_changed', version: 3 })));

    expect(result.current.error).toBeNull();
    expect(result.current.session?.version).toBe(3);
  });

  it('clears PAYMENT_IN_PROGRESS when the other device finishes', async () => {
    const server = installFakeServer(makeSession());
    const { result } = await mount();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    server.complete = () => conflict('PAYMENT_IN_PROGRESS', makeSession({ status: 'payment_pending', version: 2 }));
    await act(() => result.current.complete());
    expect(result.current.error?.code).toBe('PAYMENT_IN_PROGRESS');

    act(() =>
      FakeEventSource.instances[0]!.emit(
        'session',
        makeSession({ status: 'completed', version: 3, orderId: 'o1', idempotencyKey: 'phone-key' }),
      ),
    );

    expect(result.current.error).toBeNull();
  });

  it('keeps the error when the same or an older version is re-delivered', async () => {
    const server = installFakeServer(makeSession());
    const { result } = await mount();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    server.complete = () => conflict('VERSION_CONFLICT', makeSession({ version: 2 }));
    await act(() => result.current.complete());

    act(() => FakeEventSource.instances[0]!.emit('session', makeSession({ version: 2 })));
    act(() => FakeEventSource.instances[0]!.emit('session', makeSession({ version: 1 })));

    expect(result.current.error?.code).toBe('VERSION_CONFLICT');
  });

  it('clears an error when a refetch returns a newer version', async () => {
    const server = installFakeServer(makeSession());
    const { result } = await mount();

    server.complete = () => Promise.reject(new TypeError('Failed to fetch'));
    await act(() => result.current.complete());
    expect(result.current.error?.code).toBe('NETWORK_ERROR');

    server.session = makeSession({ version: 2 });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(result.current.error).toBeNull());
  });
});

describe('initialState (a pre-rendered page)', () => {
  const prerendered = (overrides: Partial<CheckoutSession> = {}): ResumeInitialState => ({
    session: makeSession(overrides),
    listing,
  });

  it('starts from it: no loading state, the session and listing at once, price unconfirmed', async () => {
    const state = installFakeServer(makeSession());
    state.gate = new Promise(() => undefined); // the live answer never comes in this test

    const hook = renderHook(() => useCheckoutSession('s1', { client: CLIENT, initialState: prerendered() }));

    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.session).toMatchObject({ id: 's1', status: 'active' });
    expect(hook.result.current.listing).toEqual(listing);
    expect(hook.result.current.confirmed).toBe(false);
    expect(hook.result.current.error).toBeNull();
  });

  it('does not fetch the listing, but still fetches the session and then opens SSE', async () => {
    const state = installFakeServer(makeSession());
    await mount({ initialState: prerendered() });

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(sessionFetches(state)).toHaveLength(1);
    expect(state.requests.filter((r) => r.path.startsWith('/api/listings/'))).toEqual([]);
    expect(FakeEventSource.instances[0]!.url).toBe('/api/sessions/s1/events?clientId=pane-1&surface=web');
  });

  it('stays unconfirmed until the first live response, then confirms', async () => {
    const state = installFakeServer(makeSession());
    let release!: () => void;
    state.gate = new Promise<void>((resolve) => (release = resolve));
    const { result } = await mount({ initialState: prerendered() });
    expect(result.current.confirmed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(0); // the stream waits for the live fetch

    release();

    await waitFor(() => expect(result.current.confirmed).toBe(true));
    expect(result.current.session).toMatchObject({ status: 'active', version: 1 });
  });

  it('lets the live session replace the pre-rendered one: price changed', async () => {
    const state = installFakeServer(makeSession({ status: 'price_changed', currentPrice: 12000, version: 2 }));
    let release!: () => void;
    state.gate = new Promise<void>((resolve) => (release = resolve));
    const { result } = await mount({ initialState: prerendered() }); // pre-rendered: active at $100
    expect(result.current.session).toMatchObject({ status: 'active', currentPrice: 10000 });

    release();

    await waitFor(() => expect(result.current.confirmed).toBe(true));
    expect(result.current.session).toMatchObject({ status: 'price_changed', currentPrice: 12000, version: 2 });
  });

  it('lets the live session replace the pre-rendered one: expired', async () => {
    installFakeServer(makeSession({ status: 'expired', version: 2 }));
    const { result } = await mount({ initialState: prerendered() });

    await waitFor(() => expect(result.current.session?.status).toBe('expired'));
    expect(result.current.confirmed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(FakeEventSource.instances).toHaveLength(0); // finished: no stream
  });

  it('the first live answer wins even if its version is older (the server was reset or restarted)', async () => {
    installFakeServer(makeSession({ version: 1, priceSnapshot: 9000, currentPrice: 9000 }));
    const { result } = await mount({
      initialState: prerendered({ version: 5, priceSnapshot: 10000, currentPrice: 10000 }),
    });

    await waitFor(() => expect(result.current.confirmed).toBe(true));
    expect(result.current.session).toMatchObject({ version: 1, priceSnapshot: 9000 });
  });

  it('after that, older updates are ignored again', async () => {
    installFakeServer(makeSession({ version: 3 }));
    const { result } = await mount({ initialState: prerendered({ version: 2 }) });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await waitFor(() => expect(result.current.confirmed).toBe(true));

    act(() => FakeEventSource.instances[0]!.emit('session', makeSession({ version: 2, priceSnapshot: 1 })));

    expect(result.current.session).toMatchObject({ version: 3, priceSnapshot: 10000 });
  });

  it('drops the pre-rendered session if the live fetch says it no longer exists', async () => {
    const state = installFakeServer(makeSession());
    state.sessionReply = () => json(404, { error: { code: 'SESSION_NOT_FOUND', message: 'no session s1' } });
    const { result } = await mount({ initialState: prerendered() });

    await waitFor(() => expect(result.current.session).toBeUndefined());
    expect(result.current.error).toMatchObject({ code: 'SESSION_NOT_FOUND' });
    expect(result.current.loading).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('keeps the pre-rendered session, still unconfirmed, when the live fetch fails for another reason', async () => {
    const state = installFakeServer(makeSession());
    state.sessionReply = () => json(500, { error: { code: 'BOOM', message: 'x' } });
    const { result } = await mount({ initialState: prerendered() });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(result.current.session).toMatchObject({ id: 's1' });
    expect(result.current.confirmed).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('ignores an initial state that is for a different session', async () => {
    const state = installFakeServer(makeSession());
    state.gate = new Promise(() => undefined);

    const { result } = renderHook(() =>
      useCheckoutSession('s1', { client: CLIENT, initialState: { session: makeSession({ id: 'other' }), listing } }),
    );

    expect(result.current.loading).toBe(true);
    expect(result.current.session).toBeUndefined();
    expect(result.current.confirmed).toBe(true); // nothing pre-rendered to doubt
  });

  it('without an initial state nothing is unconfirmed, and the listing is fetched', async () => {
    const state = installFakeServer(makeSession());
    const { result } = await mount();

    expect(result.current.confirmed).toBe(true);
    await waitFor(() => expect(result.current.listing).toEqual(listing));
    expect(state.requests.some((r) => r.path === '/api/listings/l1')).toBe(true);
  });

  it('fetches the listing when the pre-rendered state has none', async () => {
    const state = installFakeServer(makeSession());
    const { result } = renderHook(() =>
      useCheckoutSession('s1', { client: CLIENT, initialState: { session: makeSession() } }),
    );

    expect(result.current.listing).toBeUndefined(); // first render: nothing pre-rendered to show
    await waitFor(() => expect(result.current.listing).toEqual(listing));
    expect(state.requests.some((r) => r.path === '/api/listings/l1')).toBe(true);
  });

  it('pays with the freshest version once confirmed, not the pre-rendered one', async () => {
    const state = installFakeServer(makeSession({ version: 2 }));
    state.complete = () =>
      json(200, makeSession({ status: 'completed', version: 3, orderId: 'o1', idempotencyKey: 'key-1' }));
    const { result } = await mount({ initialState: prerendered({ version: 1 }) });
    await waitFor(() => expect(result.current.confirmed).toBe(true));

    await act(async () => {
      await result.current.complete();
    });

    expect(completes(state)[0]!.body).toEqual({ version: 2 });
  });
});
