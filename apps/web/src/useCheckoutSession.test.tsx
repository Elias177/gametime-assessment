// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { CheckoutSession, Listing } from '@checkout/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  body?: { version?: number };
}

/** Programmable fake server: `complete` decides what POST /complete answers. */
function installFakeServer(initial: CheckoutSession) {
  const state = {
    session: initial,
    requests: [] as Recorded[],
    complete: (): Response | Promise<Response> => json(200, initial),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      state.requests.push({
        method: init?.method ?? 'GET',
        path,
        key: headers['Idempotency-Key'],
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      if (path.endsWith('/complete')) return state.complete();
      if (path.startsWith('/api/listings/')) return json(200, listing);
      if (path.startsWith('/api/sessions/')) return json(200, state.session);
      return json(404, { error: { code: 'NOT_FOUND', message: path } });
    }),
  );
  return state;
}

const completes = (state: ReturnType<typeof installFakeServer>) =>
  state.requests.filter((r) => r.path.endsWith('/complete'));
const sessionFetches = (state: ReturnType<typeof installFakeServer>) =>
  state.requests.filter((r) => r.method === 'GET' && r.path === '/api/sessions/s1');

async function mount(options: { pollMs?: number } = {}) {
  let n = 0;
  const hook = renderHook(() => useCheckoutSession('s1', { newKey: () => `key-${++n}`, ...options }));
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

describe('loading and live updates', () => {
  it('fetches the session and its listing, then subscribes to SSE', async () => {
    installFakeServer(makeSession());
    const { result } = await mount();

    expect(result.current.session).toMatchObject({ id: 's1', status: 'active' });
    await waitFor(() => expect(result.current.listing).toEqual(listing));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(FakeEventSource.instances[0]!.url).toBe('/api/sessions/s1/events');
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
