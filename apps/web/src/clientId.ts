import type { Surface } from '@checkout/shared';
import type { ClientInfo } from './api';

const STORAGE_KEY = 'checkout.clientId';

/**
 * A random UUID. `crypto.randomUUID` only exists in secure contexts, and the demo is also opened over plain
 * http on a LAN address (a phone scanning the QR code), where it is missing; `getRandomValues` is not.
 */
export function randomUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A fresh id. Each simulated device (pane) makes one, once. */
export const newClientId = randomUuid;

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
