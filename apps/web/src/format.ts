/** Integer cents to a display price. */
export function formatPrice(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

/** Event start in the venue's own time zone when known, so every viewer sees the same wall-clock time. */
export function formatEventDate(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'full',
    timeStyle: 'short',
    ...(timeZone && { timeZone }),
  }).format(new Date(iso));
}

/** Milliseconds to m:ss (or h:mm:ss). */
export function formatCountdown(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
