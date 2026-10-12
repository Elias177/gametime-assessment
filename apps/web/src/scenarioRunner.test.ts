import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chaos, ChaosResult } from './ChaosPanel';
import { createPaneControls } from './paneControls';
import type { PaneControls, PaneName, PaneStatus } from './paneControls';
import { runStep, sameAction } from './scenarioRunner';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const OK: ChaosResult = { ok: true, text: 'done' };

function setup(statuses: Partial<Record<PaneName, PaneStatus>> = {}) {
  const controls = createPaneControls();
  const pressed: string[] = [];
  for (const name of ['desktop', 'phone'] as const) {
    controls.register(name, {
      pay: async () => void pressed.push(`${name}:pay`),
      acceptPrice: async () => void pressed.push(`${name}:accept`),
    });
    controls.reportStatus(name, statuses[name] ?? 'active');
  }
  const chaos: Chaos = { behavior: 'succeed', busy: false, result: null, perform: vi.fn(async () => OK), newCheckout: vi.fn(async () => OK), performed: null };
  return { controls, chaos, pressed };
}

const deps = (s: ReturnType<typeof setup>) => ({ chaos: s.chaos, controls: s.controls as PaneControls, timeoutMs: 1000 });

describe('sameAction', () => {
  it('is true for the same type and details, whatever order they were written in', () => {
    expect(sameAction({ type: 'expire' }, { type: 'expire' })).toBe(true);
    expect(sameAction({ type: 'price', deltaCents: 1200 }, { deltaCents: 1200, type: 'price' })).toBe(true);
    expect(sameAction({ type: 'behavior', behavior: 'fail' }, { type: 'behavior', behavior: 'fail' })).toBe(true);
  });

  it('is false for a different type or different details', () => {
    expect(sameAction({ type: 'expire' }, { type: 'sell-out' })).toBe(false);
    expect(sameAction({ type: 'price', deltaCents: 1200 }, { type: 'price', deltaCents: -500 })).toBe(false);
    expect(sameAction({ type: 'behavior', behavior: 'fail' }, { type: 'behavior', behavior: 'pending' })).toBe(false);
    expect(sameAction({ type: 'settle', outcome: 'succeeded' }, { type: 'settle', outcome: 'failed' })).toBe(false);
  });
});

describe('runStep: run', () => {
  it('performs the chaos action and returns its result as is', async () => {
    const s = setup();
    (s.chaos.perform as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, text: 'SOLD_OUT: no' });

    const result = await runStep({ kind: 'run', label: 'x', action: { type: 'sell-out' } }, deps(s));

    expect(s.chaos.perform).toHaveBeenCalledExactlyOnceWith({ type: 'sell-out' });
    expect(result).toEqual({ ok: false, text: 'SOLD_OUT: no' });
  });
});

describe('runStep: pane', () => {
  it('presses pay on the pane when it is ready', async () => {
    const s = setup();

    const result = await runStep({ kind: 'pane', label: 'Pay', panes: ['phone'], op: 'pay' }, deps(s));

    expect(result.ok).toBe(true);
    expect(s.pressed).toEqual(['phone:pay']);
  });

  it('presses on every named pane, for a pay at the same moment', async () => {
    const s = setup();

    await runStep({ kind: 'pane', label: 'Pay both', panes: ['desktop', 'phone'], op: 'pay' }, deps(s));

    expect([...s.pressed].sort()).toEqual(['desktop:pay', 'phone:pay']);
  });

  it('lets pay run from a failed payment too (Try again)', async () => {
    const s = setup({ desktop: 'payment_failed' });

    const result = await runStep({ kind: 'pane', label: 'Try again', panes: ['desktop'], op: 'pay' }, deps(s));

    expect(result.ok).toBe(true);
  });

  it('waits for the pane to get ready, then presses', async () => {
    const s = setup({ phone: 'price_changed' }); // Pay is locked until the price is accepted
    let result: ChaosResult | undefined;
    void runStep({ kind: 'pane', label: 'Pay', panes: ['phone'], op: 'pay' }, deps(s)).then((r) => (result = r));

    await vi.advanceTimersByTimeAsync(300);
    expect(s.pressed).toEqual([]);
    expect(result).toBeUndefined();

    s.controls.reportStatus('phone', 'active');
    await vi.advanceTimersByTimeAsync(0);

    expect(s.pressed).toEqual(['phone:pay']);
    expect(result?.ok).toBe(true);
  });

  it('accept-price is ready only on a price_changed pane', async () => {
    const s = setup({ desktop: 'price_changed' });

    expect((await runStep({ kind: 'pane', label: 'Accept', panes: ['desktop'], op: 'accept-price' }, deps(s))).ok).toBe(true);
    expect(s.pressed).toEqual(['desktop:accept']);
  });

  it('fails, without pressing anything, and says what the pane shows when it never gets ready', async () => {
    const s = setup({ desktop: 'expired' });
    const pending = runStep({ kind: 'pane', label: 'Pay', panes: ['desktop'], op: 'pay' }, deps(s));

    await vi.advanceTimersByTimeAsync(1000);

    await expect(pending).resolves.toEqual({ ok: false, text: `Can't pay yet: the desktop pane shows "expired".` });
    expect(s.pressed).toEqual([]);
  });

  it("presses on neither pane if only one is ready, so a 'both at once' step never goes half way", async () => {
    const s = setup({ phone: 'expired' });
    const pending = runStep({ kind: 'pane', label: 'Pay both', panes: ['desktop', 'phone'], op: 'pay' }, deps(s));

    await vi.advanceTimersByTimeAsync(1000);

    expect((await pending).ok).toBe(false);
    expect(s.pressed).toEqual([]);
  });

  it('turns a pane that cannot act into a failed result, not a throw', async () => {
    const s = setup();
    s.controls.register('phone', undefined);

    const result = await runStep({ kind: 'pane', label: 'Pay', panes: ['phone'], op: 'pay' }, deps(s));

    expect(result).toEqual({ ok: false, text: 'The phone pane is not on the page' });
  });
});

describe('runStep: expect', () => {
  it('passes at once when both panes already show the status', async () => {
    const s = setup({ desktop: 'completed', phone: 'completed' });

    expect((await runStep({ kind: 'expect', label: 'Done', status: 'completed' }, deps(s))).ok).toBe(true);
  });

  it('waits until the second pane gets there', async () => {
    const s = setup({ desktop: 'completed', phone: 'active' });
    let result: ChaosResult | undefined;
    void runStep({ kind: 'expect', label: 'Done', status: 'completed' }, deps(s)).then((r) => (result = r));

    await vi.advanceTimersByTimeAsync(400);
    expect(result).toBeUndefined();
    s.controls.reportStatus('phone', 'completed');
    await vi.advanceTimersByTimeAsync(0);

    expect(result?.ok).toBe(true);
  });

  it('fails after the timeout, saying what each pane shows', async () => {
    const s = setup({ desktop: 'payment_failed', phone: 'active' });
    const pending = runStep({ kind: 'expect', label: 'Done', status: 'completed' }, deps(s));

    await vi.advanceTimersByTimeAsync(1000);

    await expect(pending).resolves.toEqual({
      ok: false,
      text: 'Expected both panes to show "completed", but the desktop pane shows "payment failed" and the phone pane shows "active".',
    });
  });
});
