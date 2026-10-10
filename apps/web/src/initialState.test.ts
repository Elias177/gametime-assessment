// @vitest-environment jsdom
import { serializeInitialState } from '@checkout/shared';
import type { CheckoutSession, Listing } from '@checkout/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { readInitialState } from './initialState';

const listing: Listing = {
  id: 'l1',
  eventName: 'The Midnight Orchestra',
  venue: 'Harbor Hall',
  date: '2030-06-14T19:30:00-07:00',
  section: 'A',
  row: 'F',
  seats: ['12'],
};

const session: CheckoutSession = {
  id: 's1',
  listingId: 'l1',
  createdAt: '2030-01-01T00:00:00.000Z',
  originClientId: 'c1',
  originSurface: 'web',
  status: 'active',
  priceSnapshot: 10000,
  currentPrice: 10000,
  holdExpiresAt: '2030-01-01T00:10:00.000Z',
  version: 1,
  changes: [],
};

function put(text: string) {
  const script = document.createElement('script');
  script.type = 'application/json';
  script.id = 'initial-state';
  script.textContent = text;
  document.body.append(script);
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('readInitialState', () => {
  it('parses the state and removes the script', () => {
    put(serializeInitialState({ session, listing }));

    expect(readInitialState()).toEqual({ session, listing });
    expect(document.getElementById('initial-state')).toBeNull();
  });

  it('round-trips data that was escaped to be safe inside a script tag', () => {
    const hostile = { ...listing, eventName: '</script><script>alert(1)</script> <!-- x' };
    put(serializeInitialState({ session, listing: hostile }));

    expect(readInitialState()!.listing!.eventName).toBe(hostile.eventName);
  });

  it('works without a listing', () => {
    put(serializeInitialState({ session }));

    expect(readInitialState()).toEqual({ session });
  });

  it('returns undefined when the page was not pre-rendered', () => {
    expect(readInitialState()).toBeUndefined();
  });

  it.each([
    ['malformed JSON', '{oops'],
    ['empty', ''],
    ['null', 'null'],
    ['not a session', '{"hello":"world"}'],
    ['a session without an id', '{"session":{"status":"active"}}'],
  ])('returns undefined for %s, and still removes the script', (_name, text) => {
    put(text);

    expect(readInitialState()).toBeUndefined();
    expect(document.getElementById('initial-state')).toBeNull();
  });
});
