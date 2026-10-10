import { formatClockTime, formatEventDate, formatPrice, formatSeats } from './format';
import type { Listing } from './listing';
import { isTerminalStatus } from './session';
import type { CheckoutSession } from './session';

/**
 * Pure HTML for the pre-rendered /resume summary. No I/O: it takes the already-fetched state and
 * the built `index.html` and returns a string, so the same code runs inside the Vite dev server
 * today and could run in the Hono server tomorrow.
 *
 * How the Hono server would use it (not wired up): serve `apps/web/dist` as static files; for
 * `GET /resume/:id` read `dist/index.html` once, fetch the session and listing from its own
 * store and catalog (no HTTP hop, so no timeout dance), and respond with
 * `injectResumeSummary(indexHtml, { session, listing })`, falling back to the untouched
 * `indexHtml` when the session is missing or terminal.
 */

/** What the page needs to start from: the session and, when known, its listing. */
export interface ResumeInitialState {
  session: CheckoutSession;
  listing?: Listing;
}

/** A finished session has nothing left to resume, so the normal page (and its terminal UI) is the right answer. */
export function canPrerender(session: CheckoutSession): boolean {
  return !isTerminalStatus(session.status);
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape text for an HTML text node or a quoted attribute. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

/**
 * JSON for the body of a `<script type="application/json">`. Escaping every "<" means no value
 * can ever write `</script>` (or `<!--`) and break out of the tag; U+2028/2029 are escaped too
 * because older parsers treat them as line breaks.
 */
export function serializeInitialState(state: ResumeInitialState): string {
  return JSON.stringify(state)
    .replace(/</g, '\\u003c')
    .replaceAll(String.fromCharCode(0x2028), '\\u2028')
    .replaceAll(String.fromCharCode(0x2029), '\\u2029');
}

// The summary is inline-styled because it must look right before any stylesheet or script runs.
// The values mirror the mobile view in apps/web/src/styles.css (.mobile-full, .mobile-header,
// .mobile-body, .listing, .price); keep them in step so the swap to the live view does not jump.
const MUTED = '#5d6677';
const LINE = '#dfe3ea';
const STYLE = {
  screen: 'position:relative;min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;background:#fff;color:#1c2330',
  pane: 'flex:1;display:flex;flex-direction:column;min-height:0;background:#fff',
  header: `display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid ${LINE}`,
  origin: 'font-size:.875rem;font-weight:600',
  body: 'flex:1;display:grid;align-content:start;gap:16px;padding:16px',
  title: 'margin:0;font-size:1.25rem;line-height:1.25',
  listing: 'display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0',
  term: `color:${MUTED}`,
  detail: 'margin:0',
  price: 'font-size:1.75rem',
  confirming: `font-size:.875rem;font-weight:normal;color:${MUTED}`,
  muted: `margin:0;color:${MUTED}`,
};

/** Page-level rules the stylesheet would normally supply (the summary can't rely on it being loaded). */
const BASE_STYLE =
  "<style id=\"prerender-base\">*{box-sizing:border-box}html,body{margin:0}body{background:#f5f6f8;color:#1c2330;font:16px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif}</style>";

/** The amount a buyer would pay right now: the new price once it moved, else the one they agreed to. */
function shownPrice(session: CheckoutSession): number {
  return session.status === 'price_changed' ? session.currentPrice : session.priceSnapshot;
}

/**
 * Inner HTML of `#root`: the mobile view's header, event, seats, price and hold, from the
 * last-seen state. The price is labelled "Confirming price…" because it is only as fresh as the
 * prefetch; the live view replaces this as soon as the page's own fetch answers.
 */
export function renderResumeSummary({ session, listing }: ResumeInitialState): string {
  const zone = listing?.timeZone;
  const details = listing
    ? `<dl style="${STYLE.listing}">` +
      `<dt style="${STYLE.term}">Venue</dt><dd style="${STYLE.detail}">${escapeHtml(listing.venue)}</dd>` +
      `<dt style="${STYLE.term}">Date</dt><dd style="${STYLE.detail}">${escapeHtml(formatEventDate(listing.date, zone))}</dd>` +
      `<dt style="${STYLE.term}">Seats</dt><dd style="${STYLE.detail}">${escapeHtml(formatSeats(listing))}</dd>` +
      '</dl>'
    : `<p style="${STYLE.muted}">Loading event details…</p>`;
  // A pending payment pins the hold, so there is no expiry to promise.
  const hold =
    session.status === 'payment_pending'
      ? ''
      : `<p style="${STYLE.muted}" data-testid="prerender-hold">Hold expires at ${escapeHtml(formatClockTime(session.holdExpiresAt, zone))}</p>`;

  return (
    `<div data-testid="prerender" style="${STYLE.screen}"><section style="${STYLE.pane}">` +
    `<header style="${STYLE.header}"><span style="${STYLE.origin}">Opened from link</span></header>` +
    `<div style="${STYLE.body}">` +
    `<h1 style="${STYLE.title}" data-testid="prerender-event">${escapeHtml(listing?.eventName ?? 'Your tickets')}</h1>` +
    details +
    `<div style="${STYLE.price}"><strong data-testid="prerender-price">${escapeHtml(formatPrice(shownPrice(session)))}</strong>` +
    ` <span style="${STYLE.confirming}">Confirming price…</span></div>` +
    hold +
    '</div></section></div>'
  );
}

const ROOT = /<div id="root"><\/div>/;

/**
 * Put the summary and the initial-state JSON into `index.html`. Returns the page untouched when
 * there is nothing worth pre-rendering (a finished session) or nowhere to put it (no empty
 * `#root`), so the caller can always serve the result.
 */
export function injectResumeSummary(html: string, state: ResumeInitialState): string {
  if (!canPrerender(state.session) || !ROOT.test(html)) return html;

  // Replacer functions, not strings: the content may contain `$&` or `$1`, which String.replace
  // would otherwise expand.
  const withRoot = html.replace(
    ROOT,
    () =>
      `<div id="root">${renderResumeSummary(state)}</div>\n    ` +
      `<script type="application/json" id="initial-state">${serializeInitialState(state)}</script>`,
  );
  return withRoot.replace('</head>', () => `    ${BASE_STYLE}\n  </head>`);
}
