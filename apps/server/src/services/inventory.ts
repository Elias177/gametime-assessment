import type { Clock } from '../clock';

export interface Hold {
  ownerId: string;
  listingId: string;
  expiresAt: Date;
}

export type HoldResult =
  | { ok: true; hold: Hold }
  | { ok: false; reason: 'SOLD_OUT' | 'UNKNOWN_LISTING' };

/** `lost` = the hold no longer exists or was revoked by the seller side. */
export type HoldStatus = 'held' | 'expired' | 'lost';

export interface InventoryService {
  /** Reserve one unit for `ownerId` (a session id) for `ttlMs`. */
  hold(listingId: string, ownerId: string, ttlMs: number): HoldResult;
  status(ownerId: string): HoldStatus;
  /**
   * Keep the hold live past its TTL, until `confirm`, `release` or `unpin`. Used while a payment
   * is in flight, so the unit can't be sold to someone else mid-charge.
   */
  pin(ownerId: string): void;
  /** Drop the pin: the hold goes back to expiring at its original TTL (which may already have passed). */
  unpin(ownerId: string): void;
  /** Give the unit back. Safe to call repeatedly. */
  release(ownerId: string): void;
  /** Consume the unit permanently after a successful sale. */
  confirm(ownerId: string): void;
}

interface StoredHold extends Hold {
  lost: boolean;
  pinned: boolean;
}

export class InMemoryInventoryService implements InventoryService {
  private readonly stock = new Map<string, number>();
  private readonly holds = new Map<string, StoredHold>();

  constructor(
    private readonly clock: Clock,
    initialStock: Record<string, number> = {},
  ) {
    for (const [listingId, units] of Object.entries(initialStock)) this.stock.set(listingId, units);
  }

  hold(listingId: string, ownerId: string, ttlMs: number): HoldResult {
    if (!this.stock.has(listingId)) return { ok: false, reason: 'UNKNOWN_LISTING' };
    if (this.available(listingId) <= 0) return { ok: false, reason: 'SOLD_OUT' };

    const hold: StoredHold = {
      ownerId,
      listingId,
      expiresAt: new Date(this.clock.now().getTime() + ttlMs),
      lost: false,
      pinned: false,
    };
    this.holds.set(ownerId, hold);
    return { ok: true, hold: { ownerId, listingId, expiresAt: hold.expiresAt } };
  }

  status(ownerId: string): HoldStatus {
    const hold = this.holds.get(ownerId);
    if (!hold || hold.lost) return 'lost';
    if (hold.pinned) return 'held';
    return this.clock.now().getTime() >= hold.expiresAt.getTime() ? 'expired' : 'held';
  }

  pin(ownerId: string): void {
    const hold = this.holds.get(ownerId);
    if (hold && !hold.lost) hold.pinned = true;
  }

  unpin(ownerId: string): void {
    const hold = this.holds.get(ownerId);
    if (hold) hold.pinned = false;
  }

  release(ownerId: string): void {
    this.holds.delete(ownerId);
  }

  confirm(ownerId: string): void {
    const hold = this.holds.get(ownerId);
    if (!hold) return;
    this.stock.set(hold.listingId, Math.max(0, (this.stock.get(hold.listingId) ?? 0) - 1));
    this.holds.delete(ownerId);
  }

  /** Units neither sold nor under a live (unexpired or pinned) hold. */
  available(listingId: string): number {
    const now = this.clock.now().getTime();
    let held = 0;
    for (const hold of this.holds.values()) {
      const live = !hold.lost && (hold.pinned || hold.expiresAt.getTime() > now);
      if (hold.listingId === listingId && live) held += 1;
    }
    return (this.stock.get(listingId) ?? 0) - held;
  }

  setStock(listingId: string, units: number): void {
    this.stock.set(listingId, units);
  }

  /** Simulate the listing selling out elsewhere: zero stock and invalidate every hold on it. */
  revokeStock(listingId: string): void {
    this.stock.set(listingId, 0);
    for (const hold of this.holds.values()) {
      if (hold.listingId === listingId) hold.lost = true;
    }
  }
}
