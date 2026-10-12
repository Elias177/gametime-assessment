import type { Chaos, ChaosAction, ChaosResult } from './ChaosPanel';
import type { PaneControls, PaneName, PaneOp, PaneStatus } from './paneControls';
import type { ScenarioStep } from './scenarios';

/** Whether two chaos actions are the same action (same type and the same details). */
export function sameAction(a: ChaosAction, b: ChaosAction): boolean {
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  return [...keys].every((key) => x[key] === y[key]);
}

/** How long a step waits for a pane to get ready, or for both to show a status, before it fails. */
export const STEP_TIMEOUT_MS = 5000;

/** The statuses in which a pane's button for each action is there and enabled. */
const READY: Record<PaneOp, readonly PaneStatus[]> = {
  pay: ['active', 'payment_failed'],
  'accept-price': ['price_changed'],
};

/** Whether a pane showing `status` has the button for `op` there and enabled. */
export const canPress = (op: PaneOp, status: PaneStatus | undefined) => status !== undefined && READY[op].includes(status);

const OP_WORDS: Record<PaneOp, string> = { pay: 'pay', 'accept-price': 'accept the price' };

const BOTH: readonly PaneName[] = ['desktop', 'phone'];

const say = (status: PaneStatus | undefined) => (status ? `"${status.replace(/_/g, ' ')}"` : 'nothing');

/** What the panes show, for an error message. */
const showing = (controls: PaneControls, names: readonly PaneName[]) =>
  names.map((name) => `the ${name} pane shows ${say(controls.statusOf(name))}`).join(' and ');

/**
 * Do one scenario step and say how it went. Never throws: a step that can't be done answers with
 * `ok: false` and a sentence that says why, so the presenter can fix it and press the button again.
 */
export async function runStep(
  step: ScenarioStep,
  deps: { chaos: Chaos; controls: PaneControls; timeoutMs?: number },
): Promise<ChaosResult> {
  const { chaos, controls, timeoutMs = STEP_TIMEOUT_MS } = deps;

  switch (step.kind) {
    case 'run':
      return chaos.perform(step.action);

    case 'pane': {
      const ready = await controls.waitFor(step.panes, (s) => s !== undefined && READY[step.op].includes(s), timeoutMs);
      if (!ready) {
        return { ok: false, text: `Can't ${OP_WORDS[step.op]} yet: ${showing(controls, step.panes)}.` };
      }
      try {
        // Together, so two panes really do press at the same moment.
        await Promise.all(step.panes.map((name) => controls.perform(name, step.op)));
      } catch (error) {
        return { ok: false, text: error instanceof Error ? error.message : 'The pane could not do that' };
      }
      return { ok: true, text: step.label };
    }

    case 'expect': {
      const reached = await controls.waitFor(BOTH, (s) => s === step.status, timeoutMs);
      if (!reached) {
        return { ok: false, text: `Expected both panes to show ${say(step.status)}, but ${showing(controls, BOTH)}.` };
      }
      return { ok: true, text: step.label };
    }
  }
}
