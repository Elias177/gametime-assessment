import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPaneControls } from './paneControls';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createPaneControls', () => {
  it('remembers the last status each pane reported', () => {
    const controls = createPaneControls();
    expect(controls.statusOf('desktop')).toBeUndefined();

    controls.reportStatus('desktop', 'active');
    controls.reportStatus('phone', 'expired');
    controls.reportStatus('desktop', 'completed');

    expect(controls.statusOf('desktop')).toBe('completed');
    expect(controls.statusOf('phone')).toBe('expired');
  });

  it('performs pay and accept-price through the pane that registered', async () => {
    const controls = createPaneControls();
    const pay = vi.fn().mockResolvedValue(undefined);
    const acceptPrice = vi.fn().mockResolvedValue(undefined);
    controls.register('phone', { pay, acceptPrice });

    await controls.perform('phone', 'pay');
    expect(pay).toHaveBeenCalledOnce();
    expect(acceptPrice).not.toHaveBeenCalled();

    await controls.perform('phone', 'accept-price');
    expect(acceptPrice).toHaveBeenCalledOnce();
  });

  it('waits for the action to finish before perform resolves', async () => {
    const controls = createPaneControls();
    let finish!: () => void;
    controls.register('desktop', {
      pay: () => new Promise<void>((resolve) => (finish = resolve)),
      acceptPrice: async () => undefined,
    });

    let done = false;
    const performed = controls.perform('desktop', 'pay').then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);

    finish();
    await performed;
    expect(done).toBe(true);
  });

  it('rejects with a clear message for a pane that is not registered, or has gone', async () => {
    const controls = createPaneControls();
    await expect(controls.perform('phone', 'pay')).rejects.toThrow('The phone pane is not on the page');

    controls.register('phone', { pay: async () => undefined, acceptPrice: async () => undefined });
    controls.register('phone', undefined);
    await expect(controls.perform('phone', 'pay')).rejects.toThrow('The phone pane is not on the page');
  });

  describe('reported actions', () => {
    it('tells every listener which pane did what', () => {
      const controls = createPaneControls();
      const a = vi.fn();
      const b = vi.fn();
      controls.onAction(a);
      controls.onAction(b);

      controls.reportAction('phone', 'pay');
      controls.reportAction('desktop', 'accept-price');

      expect(a.mock.calls).toEqual([['phone', 'pay'], ['desktop', 'accept-price']]);
      expect(b.mock.calls).toEqual(a.mock.calls);
    });

    it('stops telling a listener once it has stopped listening, and only that one', () => {
      const controls = createPaneControls();
      const stays = vi.fn();
      const goes = vi.fn();
      controls.onAction(stays);
      const stop = controls.onAction(goes);

      stop();
      controls.reportAction('desktop', 'pay');

      expect(goes).not.toHaveBeenCalled();
      expect(stays).toHaveBeenCalledOnce();
    });

    it('is fine with nobody listening, and with a listener that stops itself while being told', () => {
      const controls = createPaneControls();
      expect(() => controls.reportAction('desktop', 'pay')).not.toThrow();

      const calls: string[] = [];
      const stop = controls.onAction(() => {
        calls.push('first');
        stop();
      });
      controls.onAction(() => calls.push('second'));
      controls.reportAction('desktop', 'pay');
      controls.reportAction('desktop', 'pay');

      expect(calls).toEqual(['first', 'second', 'second']);
    });
  });

  describe('waitFor', () => {
    it('resolves true at once when the panes already match', async () => {
      const controls = createPaneControls();
      controls.reportStatus('desktop', 'expired');
      controls.reportStatus('phone', 'expired');

      await expect(controls.waitFor(['desktop', 'phone'], (s) => s === 'expired', 1000)).resolves.toBe(true);
    });

    it('resolves true as soon as the last pane gets there, not before', async () => {
      const controls = createPaneControls();
      controls.reportStatus('desktop', 'expired');
      controls.reportStatus('phone', 'active');
      let result: boolean | undefined;
      void controls.waitFor(['desktop', 'phone'], (s) => s === 'expired', 1000).then((r) => (result = r));

      await vi.advanceTimersByTimeAsync(500);
      expect(result).toBeUndefined();

      controls.reportStatus('phone', 'expired');
      await vi.advanceTimersByTimeAsync(0);
      expect(result).toBe(true);
    });

    it('resolves false after the timeout, and stops listening', async () => {
      const controls = createPaneControls();
      controls.reportStatus('desktop', 'active');
      let result: boolean | undefined;
      void controls.waitFor(['desktop'], (s) => s === 'expired', 1000).then((r) => (result = r));

      await vi.advanceTimersByTimeAsync(999);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toBe(false);

      controls.reportStatus('desktop', 'expired'); // too late: must not throw or resolve again
      expect(result).toBe(false);
    });

    it('does not count a pane that has gone away (undefined) as matching a status', async () => {
      const controls = createPaneControls();
      controls.reportStatus('desktop', 'expired');
      controls.reportStatus('phone', undefined);

      const waiting = controls.waitFor(['desktop', 'phone'], (s) => s === 'expired', 100);
      await vi.advanceTimersByTimeAsync(100);

      await expect(waiting).resolves.toBe(false);
    });
  });
});
