import { AsyncLocalStorage } from 'node:async_hooks';
// A relative path on purpose: Vite loads this file while reading vite.config.ts, and leaves bare
// workspace imports ("@checkout/shared") external, which plain Node cannot load (TypeScript source,
// extensionless imports). Relative imports are bundled into the config, so this works.
import { injectResumeSummary } from '../../packages/shared/src/prerender';
import type { CheckoutSession, Listing, ResumeInitialState } from '@checkout/shared';
import type { Plugin } from 'vite';

/*
 * README note: why pre-render /resume/:sessionId, and what full SSR would add.
 *
 * A fan taps a link on a phone, often on a slow connection. A plain SPA answers with an empty
 * `<div id="root">`: the screen stays blank until the JavaScript bundle has downloaded, parsed and
 * run, and then until the app's own fetch for the session comes back. Two network round trips sit
 * between the tap and anything on screen. Here the server has already looked the session up, so
 * the very first HTML response contains the event, seats, price and when the hold ends. It
 * paints with the document (no script needed, so it even shows if the bundle fails to load) and
 * the fan can confirm they are in the right place while the app boots. The price is labelled
 * "Confirming price…" until the live fetch answers, so a stale number is never presented as final;
 * if the session has meanwhile changed or expired, the normal UI simply takes over.
 *
 * Full SSR would go further: render the whole React view on the server (with its buttons, sheets
 * and state) and hydrate it in the browser, so what is on screen is already the real, interactive
 * component tree and there is no swap at all. The cost is a server render path that runs React
 * (or an equivalent) for every request, plus hydration-mismatch risk: server and client must
 * produce identical markup, and anything that differs (time zones, `Date.now()`, locale, a price
 * that moved) causes warnings or a discarded tree. This summary avoids both by being a small
 * static snapshot that the client replaces rather than adopts.
 */

/** Longest the page will wait for the API. Past this it is better to serve the plain page. */
export const PREFETCH_TIMEOUT_MS = 500;

const RESUME_PATH = /^\/resume\/([^/?#]+)\/?(?:[?#].*)?$/;

export interface PrerenderOptions {
  /** Where the API lives (the same server `/api` is proxied to). */
  apiOrigin: string;
  /** Overall budget for the session and listing reads. */
  timeoutMs?: number;
}

/**
 * Read the session and its listing for the pre-render. Sends `X-Prefetch: 1` and nothing that
 * identifies a client, so the server can tell this is the page server asking and not a fan, and
 * analytics can skip it. Resolves undefined if the session is missing or anything fails or is slow.
 */
async function prefetch(apiOrigin: string, sessionId: string, timeoutMs: number): Promise<ResumeInitialState | undefined> {
  const signal = AbortSignal.timeout(timeoutMs); // one deadline for both reads
  const get = (path: string) => fetch(`${apiOrigin}${path}`, { headers: { 'X-Prefetch': '1' }, signal });
  try {
    const sessionRes = await get(`/api/sessions/${encodeURIComponent(sessionId)}`);
    if (!sessionRes.ok) return undefined;
    const session = (await sessionRes.json()) as CheckoutSession;

    // Without the listing the summary is still useful (the app fetches it), so its failure is not fatal.
    const listing = await get(`/api/listings/${encodeURIComponent(session.listingId)}`)
      .then((res) => (res.ok ? (res.json() as Promise<Listing>) : undefined))
      .catch(() => undefined);
    return { session, listing };
  } catch {
    return undefined; // network error, abort (timeout) or bad JSON: serve the normal page
  }
}

/**
 * Dev-server pre-render of `/resume/:sessionId`. A middleware fetches the state, and
 * `transformIndexHtml` (which has no access to the request) receives it through AsyncLocalStorage:
 * it is scoped to this request, so concurrent requests cannot see each other's session.
 *
 * Production is not wired: the built `dist/index.html` is static. See `injectResumeSummary` for how
 * the Hono server would produce the same page from the built file.
 */
export function prerenderResume(options: PrerenderOptions): Plugin {
  const store = new AsyncLocalStorage<ResumeInitialState | undefined>();
  const timeoutMs = options.timeoutMs ?? PREFETCH_TIMEOUT_MS;

  return {
    name: 'prerender-resume',
    apply: 'serve',

    configureServer(server) {
      // Registered directly (not returned as a post-hook) so it runs before Vite's own HTML
      // handling, which is what calls transformIndexHtml.
      server.middlewares.use((req, _res, next) => {
        const match = req.method === 'GET' ? RESUME_PATH.exec(req.url ?? '') : null;
        if (!match || !req.headers.accept?.includes('text/html')) return next();

        const sessionId = decodeURIComponent(match[1]!);
        void prefetch(options.apiOrigin, sessionId, timeoutMs).then((state) => store.run(state, next));
      });
    },

    transformIndexHtml(html) {
      const state = store.getStore();
      return state ? injectResumeSummary(html, state) : html;
    },
  };
}
