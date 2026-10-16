// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Chaos } from './ChaosPanel';
import { ActionLog } from './ActionLog';
import { createPaneControls } from './paneControls';

afterEach(cleanup);

/** Chaos as the log sees it: dev tools on (unless told otherwise), and every action recorded. */
function stubChaos(over: Partial<Chaos> = {}): Chaos {
  return {
    behavior: 'succeed',
    busy: false,
    result: null,
    performed: null,
    perform: vi.fn(async () => ({ ok: true, text: '' })),
    newCheckout: vi.fn(async () => ({ ok: true, text: '' })),
    ...over,
  };
}


/** The numbered entries (not the question at the end, if there is one). */
const entries = () =>
  within(screen.getByRole('log'))
    .getAllByRole('listitem')
    .filter((li) => li.hasAttribute('data-who'))
    .map((li) => li.textContent ?? '');

describe('ActionLog', () => {
  it('stays on the newest entries while its height changes, unless the reader has scrolled up', () => {
    let resize: () => void = () => {};
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    try {
      const controls = createPaneControls();
      render(<ActionLog controls={controls} chaos={stubChaos()} />);
      act(() => controls.reportAction('phone', 'pay'));
      const list = screen.getByRole('log');
      Object.defineProperty(list, 'scrollHeight', { value: 500, configurable: true });
      Object.defineProperty(list, 'clientHeight', { value: 100, configurable: true });

      act(() => resize()); // the log got shorter (the phone section opened beside it)
      expect(list.scrollTop).toBe(500);

      list.scrollTop = 0; // reader scrolls up to older entries
      fireEvent.scroll(list);
      act(() => resize());
      expect(list.scrollTop).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('starts empty', () => {
    render(<ActionLog controls={createPaneControls()} chaos={stubChaos()} />);
    expect(screen.queryByRole('log')).toBeNull();
    expect(screen.getByText(/nothing yet/i)).toBeTruthy();
  });

  it('numbers actions and status changes in plain words, oldest first', () => {
    const controls = createPaneControls();
    render(<ActionLog controls={controls} chaos={stubChaos()} />);

    act(() => controls.reportStatus('desktop', 'active')); // opening is not an action
    act(() => controls.reportAction('phone', 'pay'));
    act(() => controls.reportStatus('phone', 'active'));
    act(() => controls.reportStatus('phone', 'payment_pending'));
    act(() => controls.reportStatus('phone', 'payment_pending')); // no change: not logged

    expect(entries()).toEqual([
      '1.Phone pressed Pay',
      '2.Phone is waiting for the payment to go through',
    ]);
  });

  it('says which device won the pay race and which was rejected', () => {
    const controls = createPaneControls();
    render(<ActionLog controls={controls} chaos={stubChaos()} />);
    act(() => controls.reportAction('desktop', 'pay', 'accepted'));
    act(() => controls.reportAction('phone', 'pay', 'rejected'));
    expect(entries()).toEqual([
      '1.Desktop pressed Pay: its payment was accepted first',
      '2.Phone pressed Pay: rejected, the other device was already paying',
    ]);
  });

  it('does not log a pane opening, or show times', () => {
    const controls = createPaneControls();
    const { container } = render(<ActionLog controls={controls} chaos={stubChaos()} />);
    act(() => controls.reportStatus('desktop', 'active'));
    act(() => controls.reportStatus('phone', 'active'));
    expect(screen.queryByRole('log')).toBeNull();
    expect(container.querySelector('time')).toBeNull();
  });

  it('says what a price change means', () => {
    const controls = createPaneControls();
    render(<ActionLog controls={controls} chaos={stubChaos()} />);
    act(() => controls.reportStatus('desktop', 'active'));
    act(() => controls.reportStatus('desktop', 'price_changed'));
    expect(entries()[0]).toBe('1.Desktop was told the price changed');
  });

  it('numbers without gaps under StrictMode', () => {
    const controls = createPaneControls();
    render(
      <StrictMode>
        <ActionLog controls={controls} chaos={stubChaos()} />
      </StrictMode>,
    );
    act(() => controls.reportAction('desktop', 'pay'));
    act(() => controls.reportAction('phone', 'accept-price'));
    expect(entries()).toEqual(['1.Desktop pressed Pay', '2.Phone accepted the new price']);
  });

  it('lists dev tools actions under their own name, in order with the rest', () => {
    const controls = createPaneControls();
    render(<ActionLog controls={controls} chaos={stubChaos()} />);
    act(() => controls.reportNote('Dev tools raised the price by $12'));
    act(() => controls.reportAction('phone', 'accept-price'));
    expect(entries()).toEqual(['1.Dev tools raised the price by $12', '2.Phone accepted the new price']);
  });

  describe('what comes next', () => {
    it('offers to settle a pending payment, and the buttons settle it', () => {
      const chaos = stubChaos();
      const controls = createPaneControls();
      render(<ActionLog controls={controls} chaos={chaos} />);
      act(() => controls.reportStatus('desktop', 'active'));
      act(() => controls.reportAction('desktop', 'pay'));
      act(() => controls.reportStatus('desktop', 'payment_pending'));

      expect(screen.getByTestId('log-prompt-settle')).toBeTruthy();
      fireEvent.click(screen.getByTestId('log-settle-failed'));
      expect(chaos.perform).toHaveBeenCalledWith({ type: 'settle', outcome: 'failed' });
      fireEvent.click(screen.getByTestId('log-settle-succeeded'));
      expect(chaos.perform).toHaveBeenCalledWith({ type: 'settle', outcome: 'succeeded' });
    });

    it('swaps the settle question for the reset once the order is placed', () => {
      const chaos = stubChaos();
      const controls = createPaneControls();
      render(<ActionLog controls={controls} chaos={chaos} />);
      act(() => controls.reportStatus('desktop', 'active'));
      act(() => controls.reportStatus('desktop', 'payment_pending'));
      act(() => controls.reportStatus('desktop', 'completed'));

      expect(screen.queryByTestId('log-prompt-settle')).toBeNull();
      expect(screen.getByTestId('log-prompt-placed').textContent).toContain('Order placed');
      fireEvent.click(screen.getByTestId('log-reset'));
      expect(chaos.perform).toHaveBeenCalledWith({ type: 'reset' });
    });

    it('asks nothing while the checkout is just active', () => {
      const controls = createPaneControls();
      render(<ActionLog controls={controls} chaos={stubChaos()} />);
      act(() => controls.reportStatus('desktop', 'active'));
      expect(screen.queryByTestId('log-prompt-settle')).toBeNull();
      expect(screen.queryByTestId('log-prompt-placed')).toBeNull();
    });

    it('offers no buttons when the dev tools are off, and disables them while an action runs', () => {
      const controls = createPaneControls();
      const { rerender } = render(<ActionLog controls={controls} chaos={stubChaos({ behavior: undefined })} />);
      act(() => controls.reportStatus('desktop', 'payment_pending'));
      expect(screen.queryByTestId('log-prompt-settle')).toBeNull();

      rerender(<ActionLog controls={controls} chaos={stubChaos({ busy: true })} />);
      expect((screen.getByTestId('log-settle-failed') as HTMLButtonElement).disabled).toBe(true);
    });
  });
});
