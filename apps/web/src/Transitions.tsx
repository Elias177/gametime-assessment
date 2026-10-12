import { useRef } from 'react';
import type { CheckoutSession } from '@checkout/shared';
import type { ReactNode } from 'react';

/**
 * True once `value` has differed from what it was on first render, and from then on. Animations key
 * off this so a page that loads in some state does not animate into it: only a change does.
 * (Idempotent, so reading and writing the ref during render is safe.)
 */
function useHasChanged(value: unknown): boolean {
  const first = useRef(value);
  const changed = useRef(false);
  if (!Object.is(first.current, value)) changed.current = true;
  return changed.current;
}

/**
 * Which panel a status shows. Active and price_changed share the Pay button, so they share a key:
 * the button stays mounted (and keeps focus) when the price changes under it.
 */
export function panelKeyFor(status: CheckoutSession['status']): string {
  return status === 'active' || status === 'price_changed' ? 'pay' : status;
}

/**
 * The part of the checkout that changes with the status. A new `panelKey` replaces it, and the new
 * content fades in (opacity only, and only when the user has not asked for reduced motion).
 */
export function StatusSwap({ panelKey, children }: { panelKey: string; children: ReactNode }) {
  const changed = useHasChanged(panelKey);
  return (
    <div key={panelKey} className={changed ? 'status-swap swap-in' : 'status-swap'} data-testid="status-swap">
      {children}
    </div>
  );
}

/** Wraps a value so it flashes when `value` changes, not when it first appears. */
export function FlashOnChange({ value, children }: { value: string | number; children: ReactNode }) {
  const changed = useHasChanged(value);
  return (
    <span key={value} className={changed ? 'flash-on-change flash' : 'flash-on-change'} data-testid="flash">
      {children}
    </span>
  );
}
