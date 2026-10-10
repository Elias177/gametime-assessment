import { useEffect, useState } from 'react';
import type { HealthResponse } from '@checkout/shared';

type State =
  | { kind: 'loading' }
  | { kind: 'ok'; health: HealthResponse }
  | { kind: 'error'; message: string };

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    fetch('/api/health')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<HealthResponse>;
      })
      .then((health) => setState({ kind: 'ok', health }))
      .catch((err: Error) => setState({ kind: 'error', message: err.message }));
  }, []);

  return (
    <main>
      <h1>Checkout</h1>
      <p data-testid="health">
        {state.kind === 'loading' && 'Checking server…'}
        {state.kind === 'ok' && `Server status: ${state.health.status}`}
        {state.kind === 'error' && `Server unreachable: ${state.message}`}
      </p>
    </main>
  );
}
