import { useEffect, useState } from 'react';

const EVENT = 'app:navigate';

export function navigate(path: string): void {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new Event(EVENT));
}

/** Current location pathname, updating on `navigate()` and the back/forward buttons. */
export function usePath(): string {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener(EVENT, update);
    window.addEventListener('popstate', update);
    return () => {
      window.removeEventListener(EVENT, update);
      window.removeEventListener('popstate', update);
    };
  }, []);
  return path;
}
