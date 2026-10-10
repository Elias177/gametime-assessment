import type { Surface } from '@checkout/shared';
import type { ClientInfo } from './api';

const STORAGE_KEY = 'checkout.clientId';

/** A fresh id. Each simulated device (pane) makes one, once. */
export const newClientId = () => crypto.randomUUID();

let fallbackId: string | undefined;

/**
 * The id of this browser tab: stable across reloads and across the start screen and the pane it
 * leads to, so "Started on this device" still matches after navigating. A tab is one real device,
 * so it needs only one. Storage can be blocked; then the id lasts until the page is reloaded.
 */
export function tabClientId(): string {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored) return stored;
    const created = newClientId();
    sessionStorage.setItem(STORAGE_KEY, created);
    return created;
  } catch {
    return (fallbackId ??= newClientId());
  }
}

export const tabClient = (surface: Surface): ClientInfo => ({ clientId: tabClientId(), surface });
