import type { Listing } from '@checkout/shared';

export interface ListingCatalog {
  get(id: string): Listing | undefined;
}

export class InMemoryListingCatalog implements ListingCatalog {
  private readonly listings = new Map<string, Listing>();

  constructor(initial: Listing[] = []) {
    for (const listing of initial) this.listings.set(listing.id, listing);
  }

  get(id: string): Listing | undefined {
    return this.listings.get(id);
  }
}
