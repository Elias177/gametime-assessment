// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Chaos, ChaosResult } from './ChaosPanel';
import { createPaneControls } from './paneControls';
import type { PaneControls, PaneStatus } from './paneControls';
import { SCENARIOS } from './scenarios';
import type { Scenario } from './scenarios';
import { ScenariosView } from './ScenariosView';

afterEach(cleanup);

const OK: ChaosResult = { ok: true, text: 'done' };

function fakeChaos(
  perform: Chaos['perform'] = vi.fn(async () => OK),
  busy = false,
  performed: Chaos['performed'] = null,
  newCheckout: Chaos['newCheckout'] = vi.fn(async () => OK),
): Chaos {
  return { behavior: 'succeed', busy, result: null, perform, newCheckout, performed };
}

/** Two registered panes that record what was pressed, both showing `status`. */
function fakePanes(status: PaneStatus = 'active') {
  const controls = createPaneControls();
  const pressed: string[] = [];
  for (const name of ['desktop', 'phone'] as const) {
    controls.register(name, {
      pay: async () => void pressed.push(`${name}:pay`),
      acceptPrice: async () => void pressed.push(`${name}:accept`),
    });
    controls.reportStatus(name, status);
  }
  return { controls, pressed };
}

const SELL_OUT_THEN_CHECK: Scenario = {
  id: 'demo',
  title: 'Demo scenario',
  summary: 'A chaos step then a check.',
  steps: [
    { kind: 'run', label: 'Sell out the listing', action: { type: 'sell-out' } },
    { kind: 'expect', label: 'Both panes say the seats are gone', status: 'unavailable' },
  ],
};

function renderDemo(options: { chaos?: Chaos; controls?: PaneControls; scenario?: Scenario; timeoutMs?: number } = {}) {
  render(
    <ScenariosView
      chaos={options.chaos ?? fakeChaos()}
      controls={options.controls ?? fakePanes('active').controls}
      scenarios={[options.scenario ?? SELL_OUT_THEN_CHECK]}
      timeoutMs={options.timeoutMs ?? 50}
    />,
  );
  fireEvent.click(screen.getByTestId('scenario-start-demo'));
}

const state = (i: number) => screen.getByTestId(`scenario-step-${i}`).getAttribute('data-state');
const runButton = () => screen.getByTestId('scenario-run') as HTMLButtonElement;

describe('SCENARIOS', () => {
  it('has unique ids, a title and summary each, and at least one step', () => {
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    for (const s of SCENARIOS) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.summary.length).toBeGreaterThan(0);
      expect(s.steps.length).toBeGreaterThan(0);
    }
  });

  it('puts the payment behavior back to succeed if a scenario makes payments fail or stay pending', () => {
    for (const s of SCENARIOS) {
      const behaviors = s.steps.flatMap((step) =>
        step.kind === 'run' && step.action.type === 'behavior' ? [step.action.behavior] : [],
      );
      if (behaviors.some((b) => b !== 'succeed')) expect(behaviors.at(-1)).toBe('succeed');
    }
  });

  it('ends every scenario that does something with a check of where it ended up', () => {
    for (const s of SCENARIOS) {
      const last = s.steps.filter((step) => !(step.kind === 'run' && step.action.type === 'behavior')).at(-1);
      expect(last?.kind, s.id).toBe('expect');
    }
  });

  it('uses no em-dashes in what the presenter reads', () => {
    for (const s of SCENARIOS) {
      for (const text of [s.title, s.summary, ...s.steps.map((step) => step.label)]) expect(text).not.toContain('—');
    }
  });
});

describe('ScenariosView', () => {
  it('lists every scenario with its summary', () => {
    render(<ScenariosView chaos={fakeChaos()} controls={createPaneControls()} />);

    for (const s of SCENARIOS) {
      const button = screen.getByTestId(`scenario-start-${s.id}`);
      expect(button.textContent).toContain(s.title);
      expect(button.textContent).toContain(s.summary);
    }
  });

  it('starting one shows its steps with the first as the current step, and no Done button', () => {
    renderDemo();

    expect(screen.getByRole('heading', { name: 'Demo scenario' })).toBeTruthy();
    expect(state(0)).toBe('current');
    expect(state(1)).toBe('todo');
    expect(screen.getByTestId('scenario-step-0').getAttribute('aria-current')).toBe('step');
    expect(runButton().textContent).toBe('Run this step');
    expect(screen.queryByText('Done')).toBeNull();
  });

  it('a chaos step fires its action and moves on once the server accepted it', async () => {
    const perform = vi.fn(async () => OK);
    renderDemo({ chaos: fakeChaos(perform) });

    fireEvent.click(runButton());

    await waitFor(() => expect(state(1)).toBe('current'));
    expect(perform).toHaveBeenCalledExactlyOnceWith({ type: 'sell-out' });
    expect(state(0)).toBe('done');
  });

  it('blocks the button, and the way out, for as long as the step is running', async () => {
    let finish!: (r: ChaosResult) => void;
    const perform = vi.fn(() => new Promise<ChaosResult>((resolve) => (finish = resolve)));
    renderDemo({ chaos: fakeChaos(perform) });

    fireEvent.click(runButton());

    await waitFor(() => expect(runButton().disabled).toBe(true));
    expect(runButton().textContent).toBe('Running…');
    expect(state(0)).toBe('running');
    expect(screen.getByTestId('scenarios').getAttribute('aria-busy')).toBe('true');
    expect((screen.getByTestId('scenario-back') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(runButton()); // a second click does nothing
    expect(perform).toHaveBeenCalledOnce();

    await act(async () => finish(OK));

    await waitFor(() => expect(state(1)).toBe('current'));
    expect(runButton().disabled).toBe(false);
    expect(runButton().textContent).toBe('Continue'); // the next step only checks, so it is not "Run"
    expect((screen.getByTestId('scenario-back') as HTMLButtonElement).disabled).toBe(false);
  });

  it('says "Run this step" when the step runs an action and "Continue" when it only checks', async () => {
    const { controls } = fakePanes('active');
    renderDemo({
      controls,
      scenario: {
        id: 'demo',
        title: 'Demo scenario',
        summary: 's',
        steps: [
          { kind: 'run', label: 'Sell out', action: { type: 'sell-out' } },
          { kind: 'expect', label: 'Both panes show the price change', status: 'price_changed' },
          { kind: 'pane', label: 'Pay on the phone pane', panes: ['phone'], op: 'pay' },
          { kind: 'expect', label: 'Both panes show the completed order', status: 'completed' },
        ],
      },
    });

    expect(runButton().textContent).toBe('Run this step'); // a chaos action
    fireEvent.click(runButton());
    await waitFor(() => expect(state(1)).toBe('current'));

    expect(runButton().textContent).toBe('Continue'); // only waits for the panes
    fireEvent.click(runButton());
    await waitFor(() => expect(runButton().disabled).toBe(true));
    act(() => {
      controls.reportStatus('desktop', 'price_changed');
      controls.reportStatus('phone', 'price_changed');
    });
    await waitFor(() => expect(state(2)).toBe('current'));
    act(() => {
      controls.reportStatus('desktop', 'active');
      controls.reportStatus('phone', 'active');
    });

    expect(runButton().textContent).toBe('Run this step'); // presses Pay on a pane
    fireEvent.click(runButton());
    await waitFor(() => expect(state(3)).toBe('current'));

    expect(runButton().textContent).toBe('Continue');
  });

  it('still reads "Running…" while a check step waits, and goes back to "Continue" if it fails', async () => {
    renderDemo({ controls: fakePanes('active').controls, timeoutMs: 40 });
    fireEvent.click(runButton());
    await waitFor(() => expect(state(1)).toBe('current'));

    fireEvent.click(runButton());
    await waitFor(() => expect(runButton().textContent).toBe('Running…'));

    expect(await screen.findByTestId('scenario-error')).toBeTruthy();
    expect(runButton().textContent).toBe('Continue');
  });

  it('is also blocked while another chaos action is in flight', () => {
    renderDemo({ chaos: fakeChaos(undefined, true) });

    expect(runButton().disabled).toBe(true);
  });

  it('a refused step stays put, shows why, and can be run again', async () => {
    const perform = vi
      .fn<Chaos['perform']>()
      .mockResolvedValueOnce({ ok: false, text: 'SOLD_OUT: nothing to sell' })
      .mockResolvedValueOnce(OK);
    renderDemo({ chaos: fakeChaos(perform) });

    fireEvent.click(runButton());
    expect((await screen.findByTestId('scenario-error')).textContent).toBe('SOLD_OUT: nothing to sell');
    expect(state(0)).toBe('current');
    expect(runButton().disabled).toBe(false);

    fireEvent.click(runButton());
    await waitFor(() => expect(state(1)).toBe('current'));
    expect(screen.queryByTestId('scenario-error')).toBeNull();
  });

  it('a pane step presses the real button of that pane, then moves on', async () => {
    const { controls, pressed } = fakePanes('active');
    renderDemo({
      controls,
      scenario: {
        id: 'demo',
        title: 'Demo scenario',
        summary: 's',
        steps: [{ kind: 'pane', label: 'Pay on the phone pane', panes: ['phone'], op: 'pay' }],
      },
    });

    fireEvent.click(runButton());

    await waitFor(() => expect(screen.getByTestId('scenario-complete')).toBeTruthy());
    expect(pressed).toEqual(['phone:pay']);
  });

  it('an expect step waits for the panes and fails with what they show if they never get there', async () => {
    renderDemo({ controls: fakePanes('active').controls, timeoutMs: 30 });
    fireEvent.click(runButton()); // the chaos step passes
    await waitFor(() => expect(state(1)).toBe('current'));

    fireEvent.click(runButton());

    expect(await screen.findByTestId('scenario-error')).toBeTruthy();
    expect(screen.getByTestId('scenario-error').textContent).toBe(
      'Expected both panes to show "unavailable", but the desktop pane shows "active" and the phone pane shows "active".',
    );
    expect(state(1)).toBe('current');
  });

  it('an expect step passes once the panes get there while it waits', async () => {
    const { controls } = fakePanes('active');
    renderDemo({ controls, timeoutMs: 2000 });
    fireEvent.click(runButton());
    await waitFor(() => expect(state(1)).toBe('current'));

    fireEvent.click(runButton());
    await waitFor(() => expect(runButton().disabled).toBe(true));
    act(() => {
      controls.reportStatus('desktop', 'unavailable');
      controls.reportStatus('phone', 'unavailable');
    });

    await waitFor(() => expect(screen.getByTestId('scenario-complete')).toBeTruthy());
  });

  async function finishDemo(chaos: Chaos) {
    const { controls } = fakePanes('active');
    renderDemo({ chaos, controls });
    fireEvent.click(runButton());
    await waitFor(() => expect(state(1)).toBe('current'));
    act(() => {
      controls.reportStatus('desktop', 'unavailable');
      controls.reportStatus('phone', 'unavailable');
    });
    await screen.findByTestId('scenario-complete');
  }

  it('finishing offers Restart and Scenarios, and no New Checkout', async () => {
    const perform = vi.fn(async () => OK);
    await finishDemo(fakeChaos(perform));

    expect(screen.getByTestId('scenario-complete').textContent).toContain('Scenario complete');
    expect(state(0)).toBe('done');
    expect(state(1)).toBe('done');
    expect(screen.queryByTestId('scenario-run')).toBeNull();
    expect(screen.getByRole('button', { name: 'Restart' })).toBeTruthy();
    expect(screen.getByTestId('scenario-back-end').textContent).toBe('Scenarios');
    expect(screen.queryByTestId('scenario-reset')).toBeNull();
    expect(screen.queryByRole('button', { name: /new checkout/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /all scenarios/i })).toBeNull();
    expect(perform).not.toHaveBeenCalledWith({ type: 'reset' });
  });

  it('Scenarios at the end starts a new checkout, then shows the list', async () => {
    const newCheckout = vi.fn(async () => OK);
    await finishDemo(fakeChaos(undefined, false, null, newCheckout));

    fireEvent.click(screen.getByTestId('scenario-back-end'));

    await waitFor(() => expect(screen.getByTestId('scenario-start-demo')).toBeTruthy());
    expect(newCheckout).toHaveBeenCalledOnce();
  });

  it('a scenario that sells out offers New Checkout instead of Scenarios, and it resets the demo', async () => {
    const perform = vi.fn(async () => OK);
    const newCheckout = vi.fn(async () => OK);
    const { controls } = fakePanes('active');
    renderDemo({ chaos: fakeChaos(perform, false, null, newCheckout), controls, scenario: { ...SELL_OUT_THEN_CHECK, endsWithReset: true } });
    fireEvent.click(runButton());
    await waitFor(() => expect(state(1)).toBe('current'));
    act(() => {
      controls.reportStatus('desktop', 'unavailable');
      controls.reportStatus('phone', 'unavailable');
    });
    await screen.findByTestId('scenario-complete');

    expect(screen.queryByTestId('scenario-back-end')).toBeNull();
    expect(screen.getByTestId('scenario-new-checkout').textContent).toBe('New Checkout');

    fireEvent.click(screen.getByTestId('scenario-new-checkout'));

    await waitFor(() => expect(screen.getByTestId('scenario-start-demo')).toBeTruthy());
    expect(perform).toHaveBeenLastCalledWith({ type: 'reset' });
    expect(newCheckout).not.toHaveBeenCalled();
  });

  it('the Seats sell out scenario is the one that ends with New Checkout', () => {
    expect(SCENARIOS.filter((s) => s.endsWithReset).map((s) => s.id)).toEqual(['sold-out']);
  });

  it('Scenarios at the top of a scenario does the same, even part way through', async () => {
    const newCheckout = vi.fn(async () => OK);
    renderDemo({ chaos: fakeChaos(undefined, false, null, newCheckout) });
    expect(screen.getByTestId('scenario-back').textContent).toBe('Scenarios');

    fireEvent.click(screen.getByTestId('scenario-back'));

    await waitFor(() => expect(screen.getByTestId('scenario-start-demo')).toBeTruthy());
    expect(newCheckout).toHaveBeenCalledOnce();
  });

  it('Restart stays on the same checkout (it does not start a new one)', async () => {
    const newCheckout = vi.fn(async () => OK);
    await finishDemo(fakeChaos(undefined, false, null, newCheckout));

    fireEvent.click(screen.getByTestId('scenario-restart'));

    expect(state(0)).toBe('current');
    expect(screen.queryByTestId('scenario-complete')).toBeNull();
    expect(newCheckout).not.toHaveBeenCalled();
  });

  it('stays where it is, with the reason, when a new checkout can not be made', async () => {
    const newCheckout = vi.fn(async () => ({ ok: false, text: 'The seats are sold out. Use New Checkout in the Actions tab to get them back.' }));
    await finishDemo(fakeChaos(undefined, false, null, newCheckout));

    fireEvent.click(screen.getByTestId('scenario-back-end'));

    expect((await screen.findByTestId('scenario-error')).textContent).toContain('The seats are sold out');
    expect(screen.getByTestId('scenario-complete')).toBeTruthy(); // not taken to the list
    expect(screen.queryByTestId('scenario-start-demo')).toBeNull();
    expect((screen.getByTestId('scenario-back-end') as HTMLButtonElement).disabled).toBe(false); // can try again
  });

  it('blocks every button while the new checkout is being made', async () => {
    let finish!: (r: ChaosResult) => void;
    const newCheckout = vi.fn(() => new Promise<ChaosResult>((resolve) => (finish = resolve)));
    await finishDemo(fakeChaos(undefined, false, null, newCheckout));

    fireEvent.click(screen.getByTestId('scenario-back-end'));

    await waitFor(() => expect((screen.getByTestId('scenario-back-end') as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByTestId('scenario-restart') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('scenario-back') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('scenario-back-end')); // a second press does nothing
    expect(newCheckout).toHaveBeenCalledOnce();

    await act(async () => finish(OK));
    await waitFor(() => expect(screen.getByTestId('scenario-start-demo')).toBeTruthy());
  });

  it('going back to the list clears an error, and a new start begins at step one', async () => {
    const perform = vi.fn(async () => ({ ok: false, text: 'boom' }));
    renderDemo({ chaos: fakeChaos(perform) });
    fireEvent.click(runButton());
    await screen.findByTestId('scenario-error');

    fireEvent.click(screen.getByTestId('scenario-back'));
    fireEvent.click(await screen.findByTestId('scenario-start-demo'));

    expect(screen.queryByTestId('scenario-error')).toBeNull();
    expect(state(0)).toBe('current');
  });

  it('marks finished steps for screen readers', async () => {
    renderDemo();
    fireEvent.click(runButton());

    await waitFor(() => expect(state(0)).toBe('done'));
    expect(screen.getByTestId('scenario-step-0').textContent).toBe('Done: Sell out the listing');
  });
});

describe('when the presenter does a step themselves', () => {
  const NOTE = 'You did that step yourself, so it is marked done.';
  const ACTIONS: Scenario = {
    id: 'demo',
    title: 'Demo scenario',
    summary: 's',
    steps: [
      { kind: 'run', label: 'Raise the price by $12', action: { type: 'price', deltaCents: 1200 } },
      { kind: 'run', label: 'Sell out', action: { type: 'sell-out' } },
      { kind: 'expect', label: 'Both panes say unavailable', status: 'unavailable' },
    ],
  };
  const PANES: Scenario = {
    id: 'demo',
    title: 'Demo scenario',
    summary: 's',
    steps: [
      { kind: 'pane', label: 'Accept on desktop', panes: ['desktop'], op: 'accept-price' },
      { kind: 'pane', label: 'Pay on phone', panes: ['phone'], op: 'pay' },
      { kind: 'pane', label: 'Pay on both', panes: ['desktop', 'phone'], op: 'pay' },
      { kind: 'expect', label: 'Both completed', status: 'completed' },
    ],
  };

  /** Start the scenario; `withPerformed` is the Actions tab reporting an action the presenter did. */
  function mount(scenario: Scenario, options: { controls?: PaneControls; performed?: Chaos['performed']; perform?: Chaos['perform'] } = {}) {
    const controls = options.controls ?? fakePanes('active').controls;
    const view = (performed: Chaos['performed']) => (
      <ScenariosView chaos={fakeChaos(options.perform, false, performed)} controls={controls} scenarios={[scenario]} timeoutMs={50} />
    );
    const utils = render(view(options.performed ?? null));
    fireEvent.click(screen.getByTestId('scenario-start-demo'));
    return { controls, withPerformed: (performed: Chaos['performed']) => utils.rerender(view(performed)), unmount: utils.unmount };
  }

  describe('a chaos action from the Actions tab', () => {
    it('marks the current run step done, says so, and moves on', () => {
      const { withPerformed } = mount(ACTIONS);

      withPerformed({ action: { type: 'price', deltaCents: 1200 }, seq: 1 });

      expect(state(0)).toBe('done');
      expect(state(1)).toBe('current');
      expect(screen.getByTestId('scenario-note').textContent).toBe(NOTE);
    });

    it('ignores a different action, or the same type with different details', () => {
      const { withPerformed } = mount(ACTIONS);

      withPerformed({ action: { type: 'sell-out' }, seq: 1 });
      withPerformed({ action: { type: 'price', deltaCents: -500 }, seq: 2 });

      expect(state(0)).toBe('current');
      expect(screen.queryByTestId('scenario-note')).toBeNull();
    });

    it('counts one action once, and the next step needs its own action', () => {
      const { withPerformed } = mount(ACTIONS);

      withPerformed({ action: { type: 'price', deltaCents: 1200 }, seq: 1 });
      withPerformed({ action: { type: 'price', deltaCents: 1200 }, seq: 2 }); // again: not the step now current

      expect(state(1)).toBe('current');
      withPerformed({ action: { type: 'sell-out' }, seq: 3 });
      expect(state(2)).toBe('current');
    });

    it('does not count an action that was already done before the scenario started', () => {
      mount(ACTIONS, { performed: { action: { type: 'price', deltaCents: 1200 }, seq: 4 } });

      expect(state(0)).toBe('current');
    });

    it('does not count the scenario\'s own action as the presenter\'s (no double step)', async () => {
      let finish!: (r: ChaosResult) => void;
      const perform = vi.fn(() => new Promise<ChaosResult>((resolve) => (finish = resolve)));
      const { withPerformed } = mount(ACTIONS, { perform });

      fireEvent.click(runButton());
      await waitFor(() => expect(runButton().disabled).toBe(true));
      withPerformed({ action: { type: 'price', deltaCents: 1200 }, seq: 1 }); // what perform reports as it finishes
      await act(async () => finish(OK));

      await waitFor(() => expect(state(1)).toBe('current')); // one step on, not two
      expect(screen.queryByTestId('scenario-note')).toBeNull();
    });

    it('does nothing when the current step is not that kind of step', () => {
      const { withPerformed } = mount({ ...ACTIONS, steps: [{ kind: 'expect', label: 'Check', status: 'completed' }] });

      withPerformed({ action: { type: 'price', deltaCents: 1200 }, seq: 1 });

      expect(state(0)).toBe('current');
    });

    it('clears the note when the next step is run from the button', async () => {
      const { withPerformed } = mount(ACTIONS);
      withPerformed({ action: { type: 'price', deltaCents: 1200 }, seq: 1 });
      expect(screen.getByTestId('scenario-note')).toBeTruthy();

      fireEvent.click(runButton());

      await waitFor(() => expect(state(2)).toBe('current'));
      expect(screen.queryByTestId('scenario-note')).toBeNull();
    });
  });

  describe('an expect step', () => {
    const FLOW: Scenario = {
      id: 'demo',
      title: 'Demo scenario',
      summary: 's',
      steps: [
        { kind: 'run', label: 'Raise the price', action: { type: 'price', deltaCents: 1200 } },
        { kind: 'expect', label: 'Both show the price change', status: 'price_changed' },
        { kind: 'pane', label: 'Accept on desktop', panes: ['desktop'], op: 'accept-price' },
        { kind: 'expect', label: 'Both completed', status: 'completed' },
      ],
    };

    it('is done on its own once both panes show its status, so steps done by hand carry on', () => {
      const { controls, withPerformed } = mount(FLOW);

      withPerformed({ action: { type: 'price', deltaCents: 1200 }, seq: 1 });
      expect(state(1)).toBe('current');

      act(() => {
        controls.reportStatus('desktop', 'price_changed');
        controls.reportStatus('phone', 'price_changed');
      });
      expect(state(1)).toBe('done');
      expect(state(2)).toBe('current');

      act(() => controls.reportAction('desktop', 'accept-price'));
      expect(state(3)).toBe('current');

      act(() => {
        controls.reportStatus('desktop', 'completed');
        controls.reportStatus('phone', 'completed');
      });
      expect(screen.getByTestId('scenario-complete')).toBeTruthy();
    });

    it('waits while only one pane shows the status', () => {
      const { controls, withPerformed } = mount(FLOW);
      withPerformed({ action: { type: 'price', deltaCents: 1200 }, seq: 1 });

      act(() => controls.reportStatus('desktop', 'price_changed'));

      expect(state(1)).toBe('current');
    });
  });

  describe('Pay or Accept pressed on a pane', () => {
    it('marks the step done when that button was pressed', () => {
      const { controls } = mount(PANES);

      act(() => controls.reportAction('desktop', 'accept-price'));

      expect(state(0)).toBe('done');
      expect(state(1)).toBe('current');
      expect(screen.getByTestId('scenario-note').textContent).toBe(NOTE);
    });

    it('ignores the other button, and presses before the step is current', () => {
      const { controls } = mount(PANES);

      act(() => controls.reportAction('desktop', 'pay')); // step 1 wants Accept
      expect(state(0)).toBe('current');

      act(() => controls.reportAction('desktop', 'accept-price'));
      act(() => controls.reportAction('desktop', 'accept-price')); // step 2 wants Pay
      expect(state(1)).toBe('current');
    });

    it('counts a press on either pane for a step that names one pane', () => {
      const { controls } = mount(PANES);
      act(() => controls.reportAction('desktop', 'accept-price'));

      act(() => controls.reportAction('desktop', 'pay')); // step 2 says the phone pane, but a pay is a pay

      expect(state(1)).toBe('done');
      expect(state(2)).toBe('current');
    });

    it('needs a press on each pane for a step that names both, in any order, not one pane twice', () => {
      const { controls } = mount(PANES);
      act(() => controls.reportAction('desktop', 'accept-price'));
      act(() => controls.reportAction('phone', 'pay'));
      expect(state(2)).toBe('current');

      act(() => controls.reportAction('phone', 'pay'));
      act(() => controls.reportAction('phone', 'pay'));
      expect(state(2)).toBe('current');

      act(() => controls.reportAction('desktop', 'pay'));
      expect(state(2)).toBe('done');
      expect(state(3)).toBe('current');
    });

    it('a step on both panes is done after one press once neither pane has a button left', async () => {
      // One press, then the order completes and no Pay is left on either pane.
      const { controls } = mount({ ...PANES, steps: [PANES.steps[2]!, PANES.steps[3]!] });
      act(() => controls.reportAction('desktop', 'pay'));
      expect(state(0)).toBe('current');

      act(() => {
        controls.reportStatus('desktop', 'completed');
        controls.reportStatus('phone', 'completed');
      });

      await waitFor(() => expect(state(0)).toBe('done'));
    });

    it('does not count the scenario\'s own press as the presenter\'s (no double step)', async () => {
      // Panes that report their action as they finish, like the real ones do.
      const controls = createPaneControls();
      for (const name of ['desktop', 'phone'] as const) {
        controls.register(name, {
          pay: async () => controls.reportAction(name, 'pay'),
          acceptPrice: async () => controls.reportAction(name, 'accept-price'),
        });
        controls.reportStatus(name, 'price_changed');
      }
      mount(PANES, { controls });

      fireEvent.click(runButton()); // Accept on the desktop pane

      await waitFor(() => expect(state(1)).toBe('current')); // exactly one step on
      expect(screen.queryByTestId('scenario-note')).toBeNull();
      expect(state(2)).toBe('todo');
    });

    it('stops listening when the view goes away', () => {
      const { controls, unmount } = mount(PANES);
      unmount();

      expect(() => controls.reportAction('desktop', 'accept-price')).not.toThrow();
    });
  });
});
