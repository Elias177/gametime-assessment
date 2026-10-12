import { useEffect, useRef, useState } from 'react';
import type { Chaos } from './ChaosPanel';
import type { PaneControls, PaneName } from './paneControls';
import { canPress, runStep, sameAction, STEP_TIMEOUT_MS } from './scenarioRunner';
import { SCENARIOS } from './scenarios';
import type { Scenario } from './scenarios';

/**
 * Guided scenarios for the drawer: pick one, then press the button for each step in turn. A step
 * really does what it says (a chaos action, or a press of Pay or Accept on a pane: "Run this step";
 * or just waiting for both panes to show a status, which runs no action: "Continue") and the button
 * stays disabled until it is done. If the presenter does a step themselves instead (the same chaos
 * action from the Actions tab, or Pay or Accept on a pane), the scenario notices and marks it done.
 * A step that fails
 * stays where it is with the reason shown, so it can be run again. Progress is kept while the
 * drawer is on another tab.
 */
export function ScenariosView({
  chaos,
  controls,
  scenarios = SCENARIOS,
  timeoutMs,
}: {
  chaos: Chaos;
  controls: PaneControls;
  scenarios?: readonly Scenario[];
  /** How long a step may wait for the panes (tests make it short). */
  timeoutMs?: number;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set when a step was marked done because the presenter did it themselves. */
  const [note, setNote] = useState<string | null>(null);
  // Read by the listeners below, which must not count this view's own presses and actions.
  const runningRef = useRef(false);
  const seenAction = useRef(chaos.performed?.seq);
  const pressed = useRef(new Set<PaneName>());

  const active = scenarios.find((s) => s.id === activeId);
  const current = active?.steps[step];

  const start = (id: string) => {
    setActiveId(id);
    setStep(0);
    setError(null);
    setNote(null);
  };
  /**
   * Back to the list, on a fresh checkout: a new session in place (the page and the drawer stay), so
   * the next scenario starts from an untouched checkout. Stays where it is, with the reason, if one
   * can't be made. Counts as busy, so nothing else is pressed meanwhile.
   */
  const backToList = async () => {
    setError(null);
    setNote(null);
    setRunning(true);
    runningRef.current = true;
    try {
      const result = await chaos.newCheckout();
      if (result.ok) setActiveId(null);
      else setError(result.text);
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  };

  /** Reset the demo (seats back, new checkout), then show the list. */
  const resetToList = async () => {
    setError(null);
    setNote(null);
    setRunning(true);
    runningRef.current = true;
    try {
      const result = await chaos.perform({ type: 'reset' });
      if (result.ok) setActiveId(null);
      else setError(result.text);
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  };

  /** The presenter did step `from` themselves: mark it done (once, however many events say so). */
  const doneByHand = (from: number) => {
    setStep((i) => (i === from ? i + 1 : i));
    setError(null);
    setNote('You did that step yourself, so it is marked done.');
  };

  // A chaos action done from the Actions tab that is the current step's action.
  const performedSeq = chaos.performed?.seq;
  useEffect(() => {
    if (performedSeq === seenAction.current) return;
    seenAction.current = performedSeq;
    if (runningRef.current || !chaos.performed || current?.kind !== 'run') return;
    if (sameAction(chaos.performed.action, current.action)) doneByHand(step);
    // Only a new action should be looked at; the rest is read as it is at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [performedSeq]);

  // Buttons pressed on the panes themselves. A step on one pane counts a press on either pane (the
  // outcome is the same); a step on both panes needs a press on each.
  useEffect(() => {
    pressed.current = new Set();
  }, [activeId, step]);
  useEffect(() => {
    if (current?.kind !== 'pane') return;
    return controls.onAction((pane, op) => {
      if (runningRef.current || op !== current.op) return;
      pressed.current.add(pane);
      const done = current.panes.length === 1 || current.panes.every((p) => pressed.current.has(p));
      if (done) return doneByHand(step);
      // By hand the panes can't be pressed at the same moment: the first press may settle things so
      // the other pane has no button left (two devices paying, the second finds it was completed
      // elsewhere). Once neither pane can press any more, the step is as done as it will get.
      const stepOp = current.op;
      void controls
        .waitFor(current.panes, (s) => !canPress(stepOp, s), timeoutMs ?? STEP_TIMEOUT_MS)
        .then((settled) => settled && doneByHand(step));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controls, current, step]);

  // An `expect` step needs no action, so it is done as soon as both panes show its status, however
  // they got there (a step run here, or done by hand). Without this, doing the steps by hand would
  // stall on the wait between two of them.
  useEffect(() => {
    if (current?.kind !== 'expect') return;
    const { status } = current;
    const from = step;
    const check = () => {
      if (runningRef.current) return; // the button is waiting for this itself
      if (controls.statusOf('desktop') === status && controls.statusOf('phone') === status) {
        setStep((i) => (i === from ? i + 1 : i));
        setError(null);
      }
    };
    check();
    return controls.onStatus(check);
  }, [controls, current, step]);

  if (!active) {
    return (
      <section className="scenarios" data-testid="scenarios" aria-label="Scenarios">
        <p className="muted">Each one starts from a fresh checkout.</p>
        <ul className="scenario-list">
          {scenarios.map((s) => (
            <li key={s.id}>
              <button type="button" data-testid={`scenario-start-${s.id}`} onClick={() => start(s.id)}>
                <strong>{s.title}</strong>
                <span className="muted">{s.summary}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  const finished = current === undefined;

  const runCurrent = async () => {
    if (!current || running) return;
    setError(null);
    setNote(null);
    const from = step;
    setRunning(true);
    runningRef.current = true;
    try {
      const result = await runStep(current, { chaos, controls, timeoutMs });
      if (result.ok) setStep((i) => (i === from ? i + 1 : i));
      else setError(result.text);
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  };

  return (
    <section className="scenarios" data-testid="scenarios" aria-label="Scenarios" aria-busy={running}>
      <button type="button" className="link" data-testid="scenario-back" disabled={running} onClick={() => void backToList()}>
        Scenarios
      </button>
      <h3 className="scenario-title">{active.title}</h3>

      <ol className="scenario-steps">
        {active.steps.map((s, i) => {
          const state = i < step ? 'done' : i === step ? (running ? 'running' : 'current') : 'todo';
          return (
            <li
              key={i}
              data-state={state}
              data-testid={`scenario-step-${i}`}
              aria-current={i === step && !finished ? 'step' : undefined}
            >
              {state === 'done' && <span className="visually-hidden">Done: </span>}
              {s.label}
            </li>
          );
        })}
      </ol>

      {note && !error && (
        <p className="muted" role="status" data-testid="scenario-note">
          {note}
        </p>
      )}

      {error && (
        <p className="banner error" role="alert" data-testid="scenario-error">
          {error}
        </p>
      )}

      {!finished && (
        <button
          type="button"
          className="primary"
          data-testid="scenario-run"
          disabled={running || chaos.busy}
          onClick={() => void runCurrent()}
        >
          {running ? 'Running…' : current.kind === 'expect' ? 'Continue' : 'Run this step'}
        </button>
      )}

      {finished && (
        <div className="scenario-end">
          <p className="banner ok" role="status" data-testid="scenario-complete">
            Scenario complete. {active.endsWithReset ? 'New Checkout' : 'Scenarios'} starts a new checkout for the next one.
          </p>
          <div className="scenario-end-actions">
            <button type="button" data-testid="scenario-restart" disabled={running} onClick={() => start(active.id)}>
              Restart
            </button>
            {active.endsWithReset ? (
              <button type="button" data-testid="scenario-new-checkout" disabled={running} onClick={() => void resetToList()}>
                New Checkout
              </button>
            ) : (
              <button type="button" data-testid="scenario-back-end" disabled={running} onClick={() => void backToList()}>
                Scenarios
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
