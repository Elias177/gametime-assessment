export interface PricingService {
  /** Current price in integer cents, or undefined for an unknown listing. */
  getPrice(listingId: string): number | undefined;
}

export class InMemoryPricingService implements PricingService {
  private readonly prices = new Map<string, number>();

  constructor(initialPrices: Record<string, number> = {}) {
    for (const [listingId, cents] of Object.entries(initialPrices)) this.prices.set(listingId, cents);
  }

  getPrice(listingId: string): number | undefined {
    return this.prices.get(listingId);
  }

  setPrice(listingId: string, cents: number): void {
    this.prices.set(listingId, cents);
  }
}
