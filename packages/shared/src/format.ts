import type { Listing } from './listing';

/**
 * Display formatting shared by the web app and the pre-rendered summary, so the summary and the
 * live view can never disagree about how a price, a date or a seat line reads.
 */

/** Integer cents to a display price. */
export function formatPrice(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

/**
 * Event start in the venue's own time zone when known, so every viewer sees the same wall-clock
 * time. With no zone it is UTC and says so: the runtime's own zone would differ between the
 * server that pre-renders a page and the browser that shows it.
 */
export function formatEventDate(iso: string, timeZone?: string): string {
  const format = (zone: string) =>
    new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: zone }).format(new Date(iso));
  return timeZone ? format(timeZone) : `${format('UTC')} UTC`;
}

/** "Section A, Row F, Seats 12, 13". */
export function formatSeats(listing: Pick<Listing, 'section' | 'row' | 'seats'>): string {
  const noun = listing.seats.length === 1 ? 'Seat' : 'Seats';
  return `Section ${listing.section}, Row ${listing.row}, ${noun} ${listing.seats.join(', ')}`;
}

/**
 * A clock time with its zone name ("7:44 PM PDT"). A server cannot know the reader's zone, so
 * this names the zone it used (the venue's, else UTC) instead of leaving it to be guessed.
 */
export function formatClockTime(iso: string, timeZone = 'UTC'): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone,
  }).format(new Date(iso));
}
