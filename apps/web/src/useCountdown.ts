import { useEffect, useState } from 'react';

/**
 * Milliseconds left until `deadlineIso`, ticking once a second. Display only: the server decides
 * when a hold actually expires, so reaching zero here changes nothing until the server says so.
 */
export function useCountdown(deadlineIso: string, tickMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(timer);
  }, [deadlineIso, tickMs]);
  return Math.max(0, Date.parse(deadlineIso) - now);
}
