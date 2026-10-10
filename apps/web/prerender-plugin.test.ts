import type { CheckoutSession, Listing } from '@checkout/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prerenderResume } from './prerender-plugin';

const listing: Listing = {
  id: 'l1',
  eventName: 'The Midnight Orchestra',
  venue: 'Harbor Hall, San Francisco',
  date: '2030-06-14T19:30:00-07:00',
  timeZone: 'America/Los_Angeles',
  section: 'Orchestra Left',
  row: 'F',
  seats: ['12', '13'],
};

const session = (overrides: Partial<CheckoutSession> = {}): CheckoutSession => ({
  id: 's1',
  listingId: 'l1',
  createdAt: '2030-06-14T19:00:00.000Z',
  originClientId: 'c1',
  originSurface: 'web',
  status: 'active',
  priceSnapshot: 10000,
  currentPrice: 10000,
  holdExpiresAt: '2030-06-14T20:10:00-07:00',
  version: 1,
  changes: [],
  ...overrides,
});

const INDEX = '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Run the plugin's dev middleware against a fake API; resolves with what `transformIndexHtml` returns downstream. */
function setup(api: Fetch, timeoutMs = 50) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return api(url, init);
    }),
  );
  const plugin = prerenderResume({ apiOrigin: 'http://api.test', timeoutMs });
  let handler!: (req: object, res: object, next: () => void) => void;
  (plugin.configureServer as (server: unknown) => void)({ middlewares: { use: (h: typeof handler) => (handler = h) } });
  const transform = plugin.transformIndexHtml as (html: string) => string;

  const request = (url: string, { method = 'GET', accept = 'text/html,application/xhtml+xml' } = {}) =>
    new Promise<string>((resolve) => {
      handler({ method, url, headers: { accept } }, {}, () => resolve(transform(INDEX)));
    });
  return { request, calls, plugin };
}

const okApi =
  (s = session(), l: Listing | null = listing): Fetch =>
  async (url) => {
    if (url.includes('/api/listings/')) return l ? json(200, l) : json(404, {});
    return json(200, s);
  };

afterEach(() => vi.unstubAllGlobals());

describe('prerenderResume', () => {
  it('only runs while serving (the dev server)', () => {
    expect(prerenderResume({ apiOrigin: 'http://x' }).apply).toBe('serve');
  });

  it('reads the session and listing with X-Prefetch: 1 and no client headers, and injects the summary', async () => {
    const { request, calls } = setup(okApi());

    const html = await request('/resume/s1');

    expect(calls.map((c) => c.url)).toEqual(['http://api.test/api/sessions/s1', 'http://api.test/api/listings/l1']);
    for (const call of calls) expect(call.headers).toEqual({ 'X-Prefetch': '1' });
    expect(html).toContain('data-testid="prerender"');
    expect(html).toContain('The Midnight Orchestra');
    expect(html).toContain('$100.00');
    expect(html).toContain('id="initial-state"');
  });

  it('handles a trailing slash and a query string', async () => {
    const { request, calls } = setup(okApi());

    expect(await request('/resume/s1/')).toContain('prerender');
    expect(await request('/resume/s1?utm=sms')).toContain('prerender');
    expect(calls.filter((c) => c.url.endsWith('/api/sessions/s1'))).toHaveLength(2);
  });

  it.each([
    ['the start page', '/', {}],
    ['the split demo', '/checkout/s1', {}],
    ['a deeper path', '/resume/s1/extra', {}],
    ['no id', '/resume/', {}],
    ['a module request', '/src/main.tsx', {}],
    ['an API call', '/api/sessions/s1', {}],
    ['a POST', '/resume/s1', { method: 'POST' }],
    ['a non-HTML request (fetch/asset)', '/resume/s1', { accept: 'application/json' }],
  ])('does nothing for %s', async (_name, url, init) => {
    const { request, calls } = setup(okApi());

    const html = await request(url, init);

    expect(calls).toEqual([]);
    expect(html).toBe(INDEX);
  });

  it('serves the normal page when the session is missing', async () => {
    const { request } = setup(async () => json(404, { error: { code: 'SESSION_NOT_FOUND' } }));
    expect(await request('/resume/nope')).toBe(INDEX);
  });

  it.each(['completed', 'expired', 'unavailable'] as const)('serves the normal page for a %s session', async (status) => {
    const { request } = setup(okApi(session({ status })));
    expect(await request('/resume/s1')).toBe(INDEX);
  });

  it('serves the normal page when the API errors or is unreachable', async () => {
    expect(await setup(async () => json(500, {})).request('/resume/s1')).toBe(INDEX);
    expect(await setup(async () => Promise.reject(new TypeError('connection refused'))).request('/resume/s1')).toBe(INDEX);
    expect(await setup(async () => new Response('<html>', { status: 200 })).request('/resume/s1')).toBe(INDEX); // not JSON
  });

  it('serves the normal page when the API is slower than the budget, without waiting for it', async () => {
    // Never answers on its own; only the abort signal ends it.
    const hang: Fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason));
      });
    const { request } = setup(hang, 40);

    const started = Date.now();
    const html = await request('/resume/s1');

    expect(html).toBe(INDEX);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('shares one budget across both reads: a slow listing cannot extend the wait', async () => {
    const slowListing: Fetch = (url, init) =>
      url.includes('/api/listings/')
        ? new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)))
        : Promise.resolve(json(200, session()));
    const { request } = setup(slowListing, 40);

    const started = Date.now();
    const html = await request('/resume/s1');

    // The session is good, so it is pre-rendered, just without event details.
    expect(html).toContain('Your tickets');
    expect(html).toContain('Loading event details…');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('still pre-renders when only the listing fails', async () => {
    const { request } = setup(okApi(session(), null));

    const html = await request('/resume/s1');

    expect(html).toContain('Your tickets');
    expect(html).toContain('"session"');
    expect(html).not.toContain('"listing"');
  });

  it('keeps concurrent requests apart: each page gets its own session', async () => {
    const api: Fetch = async (url) => {
      if (url.includes('/api/listings/')) return json(200, listing);
      const id = url.split('/').pop()!;
      await new Promise((resolve) => setTimeout(resolve, id === 'slow' ? 20 : 1));
      return json(200, session({ id, priceSnapshot: id === 'slow' ? 11100 : 22200 }));
    };
    const { request } = setup(api, 500);

    const [slow, fast] = await Promise.all([request('/resume/slow'), request('/resume/fast')]);

    expect(slow).toContain('$111.00');
    expect(slow).not.toContain('$222.00');
    expect(fast).toContain('$222.00');
    expect(fast).not.toContain('$111.00');
  });

  it('does not leak one request’s state into a later request that has none', async () => {
    const { request } = setup(okApi());

    expect(await request('/resume/s1')).toContain('prerender');
    expect(await request('/')).toBe(INDEX);
  });

  it('url-encodes the session id it sends to the API', async () => {
    const { request, calls } = setup(okApi());

    await request('/resume/a%2Fb');

    expect(calls[0]!.url).toBe('http://api.test/api/sessions/a%2Fb');
  });
});
