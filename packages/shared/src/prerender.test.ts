import { describe, expect, it } from 'vitest';
import { formatClockTime, formatEventDate, formatPrice, formatSeats } from './format';
import type { Listing } from './listing';
import { canPrerender, escapeHtml, injectResumeSummary, renderResumeSummary, serializeInitialState } from './prerender';
import type { CheckoutSession } from './session';
import { SESSION_STATUSES } from './session';

const listing: Listing = {
  id: 'l1',
  eventName: 'The Midnight Orchestra',
  venue: 'Harbor Hall, San Francisco',
  date: '2030-06-14T19:30:00-07:00', // 02:30 UTC the next day
  timeZone: 'America/Los_Angeles',
  section: 'Orchestra Left',
  row: 'F',
  seats: ['12', '13'],
};

const session: CheckoutSession = {
  id: 's1',
  listingId: 'l1',
  createdAt: '2030-06-14T19:00:00.000Z',
  originClientId: 'c1',
  originSurface: 'web',
  status: 'active',
  priceSnapshot: 10000,
  currentPrice: 10000,
  holdExpiresAt: '2030-06-14T20:10:00-07:00', // 8:10 PM in Los Angeles, 03:10 UTC
  version: 1,
  changes: [],
};

const INDEX = `<!doctype html>
<html lang="en">
  <head>
    <title>Checkout</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./src/main.tsx"></script>
  </body>
</html>`;

/** The JSON inside the injected initial-state script, parsed the way the browser will. */
function initialStateOf(html: string) {
  const match = /<script type="application\/json" id="initial-state">([\s\S]*?)<\/script>/.exec(html);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!) as { session: CheckoutSession; listing?: Listing };
}

describe('escapeHtml', () => {
  it('escapes the five characters that matter in text and quoted attributes', () => {
    expect(escapeHtml(`<a href="x">Tom & 'Jerry'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;',
    );
  });
});

describe('renderResumeSummary', () => {
  it('shows the event, venue, date, seats, price, and when the hold expires', () => {
    const html = renderResumeSummary({ session, listing });

    expect(html).toContain('The Midnight Orchestra');
    expect(html).toContain('Harbor Hall, San Francisco');
    expect(html).toContain('Section Orchestra Left, Row F, Seats 12, 13');
    expect(html).toContain('$100.00');
    expect(html).toContain('Hold expires at 8:10 PM PDT');
    expect(html).toContain('Opened from link');
  });

  it('labels the price as unconfirmed, since it is only as fresh as the prefetch', () => {
    expect(renderResumeSummary({ session, listing })).toContain('Confirming price…');
  });

  it("formats the date in the listing's time zone, not the server's or UTC", () => {
    const html = renderResumeSummary({ session, listing });

    expect(html).toContain('Friday, June 14, 2030 at 7:30 PM'); // not "Saturday, June 15 ... 2:30 AM" (UTC)
    expect(html).not.toContain('June 15');
    expect(html).toContain(formatEventDate(listing.date, 'America/Los_Angeles'));
  });

  it('falls back to UTC, naming it, when the listing has no time zone', () => {
    const html = renderResumeSummary({ session, listing: { ...listing, timeZone: undefined } });

    expect(html).toContain('Saturday, June 15, 2030 at 2:30 AM UTC');
    expect(html).toContain('Hold expires at 3:10 AM UTC');
  });

  it('copes with a missing listing: a generic title, a placeholder, UTC times', () => {
    const html = renderResumeSummary({ session });

    expect(html).toContain('Your tickets');
    expect(html).toContain('Loading event details…');
    expect(html).not.toContain('Venue');
    expect(html).toContain('$100.00');
    expect(html).toContain('Hold expires at 3:10 AM UTC');
  });

  it('escapes every listing field, so a hostile name cannot add markup', () => {
    const hostile: Listing = {
      ...listing,
      eventName: '<script>alert(1)</script> & "friends"',
      venue: '<img src=x onerror=alert(2)>',
      section: '<b>A</b>',
      row: "'R'",
      seats: ['<i>1</i>'],
    };

    const html = renderResumeSummary({ session, listing: hostile });

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<i>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;friends&quot;');
  });

  it('shows the new price once it moved, as the Pay button would', () => {
    const html = renderResumeSummary({ session: { ...session, status: 'price_changed', currentPrice: 11200 }, listing });

    expect(html).toContain('$112.00');
    expect(html).not.toContain('$100.00');
  });

  it('makes no promise about the hold while a payment is pending', () => {
    const html = renderResumeSummary({ session: { ...session, status: 'payment_pending' }, listing });

    expect(html).not.toContain('Hold expires');
  });

  it('is inline-styled: it needs no stylesheet to be laid out', () => {
    const html = renderResumeSummary({ session, listing });

    expect(html).not.toContain('class=');
    expect(html).toContain('style="');
  });
});

describe('serializeInitialState', () => {
  it('escapes "<" so no value can close the script tag', () => {
    const json = serializeInitialState({
      session,
      listing: { ...listing, eventName: '</script><script>alert(1)</script><!--' },
    });

    expect(json).not.toContain('<');
    expect(JSON.parse(json).listing.eventName).toBe('</script><script>alert(1)</script><!--'); // still the same data
  });

  it('escapes U+2028 and U+2029', () => {
    const ls = String.fromCharCode(0x2028);
    const ps = String.fromCharCode(0x2029);

    const json = serializeInitialState({ session, listing: { ...listing, eventName: `a${ls}b${ps}c` } });

    expect(json).not.toContain(ls);
    expect(json).not.toContain(ps);
    expect(JSON.parse(json).listing.eventName).toBe(`a${ls}b${ps}c`);
  });
});

describe('injectResumeSummary', () => {
  it('puts the summary inside #root and the state in an initial-state script', () => {
    const html = injectResumeSummary(INDEX, { session, listing });

    expect(html).toMatch(/<div id="root"><div data-testid="prerender"/);
    expect(html).toContain('The Midnight Orchestra');
    expect(initialStateOf(html)).toEqual({ session, listing });
    expect(html.indexOf('id="initial-state"')).toBeLessThan(html.indexOf('src="./src/main.tsx"'));
    expect(html).toContain('<script type="module" src="./src/main.tsx"></script>'); // the app script is untouched
  });

  it('adds the base page styles to <head> so there is no margin or font jump', () => {
    const html = injectResumeSummary(INDEX, { session, listing });

    expect(html.indexOf('id="prerender-base"')).toBeGreaterThan(html.indexOf('<head>'));
    expect(html.indexOf('id="prerender-base"')).toBeLessThan(html.indexOf('</head>'));
  });

  it('cannot be broken out of by a value containing </script>', () => {
    const html = injectResumeSummary(INDEX, {
      session,
      listing: { ...listing, eventName: '</script><script>window.pwned=1</script>' },
    });

    // Only the two real closing tags: the initial-state script and the app script.
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html).not.toContain('<script>window.pwned');
    expect(initialStateOf(html).listing!.eventName).toBe('</script><script>window.pwned=1</script>');
  });

  it('keeps "$&" and "$1" in data literal (String.replace patterns must not expand)', () => {
    const html = injectResumeSummary(INDEX, { session, listing: { ...listing, eventName: 'Pay $& $1 $$' } });

    expect(html).toContain('Pay $&amp; $1 $$');
    expect(initialStateOf(html).listing!.eventName).toBe('Pay $& $1 $$');
  });

  it('works without a listing', () => {
    const html = injectResumeSummary(INDEX, { session });

    expect(html).toContain('Your tickets');
    expect(initialStateOf(html)).toEqual({ session });
  });

  it.each(SESSION_STATUSES.filter((s) => ['completed', 'expired', 'unavailable'].includes(s)))(
    'returns the page untouched for a finished (%s) session',
    (status) => {
      expect(canPrerender({ ...session, status })).toBe(false);
      expect(injectResumeSummary(INDEX, { session: { ...session, status }, listing })).toBe(INDEX);
    },
  );

  it.each(['active', 'price_changed', 'payment_pending', 'payment_failed'] as const)(
    'injects for a %s session',
    (status) => {
      expect(canPrerender({ ...session, status })).toBe(true);
      expect(injectResumeSummary(INDEX, { session: { ...session, status }, listing })).not.toBe(INDEX);
    },
  );

  it('returns the page untouched when there is no empty #root to fill', () => {
    const noRoot = INDEX.replace('<div id="root"></div>', '<div id="app"></div>');
    const filled = INDEX.replace('<div id="root"></div>', '<div id="root"><p>already</p></div>');

    expect(injectResumeSummary(noRoot, { session, listing })).toBe(noRoot);
    expect(injectResumeSummary(filled, { session, listing })).toBe(filled);
  });
});

describe('shared formatting', () => {
  it('formats prices, seats and clock times', () => {
    expect(formatPrice(11250)).toBe('$112.50');
    expect(formatSeats({ section: 'A', row: '1', seats: ['5'] })).toBe('Section A, Row 1, Seat 5');
    expect(formatSeats(listing)).toBe('Section Orchestra Left, Row F, Seats 12, 13');
    expect(formatClockTime('2030-06-14T20:10:00-07:00', 'America/Los_Angeles')).toBe('8:10 PM PDT');
    expect(formatClockTime('2030-06-14T20:10:00-07:00')).toBe('3:10 AM UTC');
  });
});
