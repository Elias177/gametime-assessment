import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUuid } from './clientId';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => vi.unstubAllGlobals());

describe('randomUuid', () => {
  it('makes a v4 UUID', () => {
    expect(randomUuid()).toMatch(UUID_V4);
  });

  it('still works where crypto.randomUUID is missing (plain http on a LAN address)', () => {
    vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
    const a = randomUuid();
    expect(a).toMatch(UUID_V4);
    expect(randomUuid()).not.toBe(a);
  });
});
