import type { CheckoutSession } from '@checkout/shared';

export type PaneName = 'desktop' | 'phone';
/** What a scenario can do on a pane: the same two actions a person has on its buttons. */
export type PaneOp = 'pay' | 'accept-price';
export type PaneStatus = CheckoutSession['status'];
/**
 * How a Pay press ended when two devices pay at once: this pane's payment was taken up by the server
 * ('accepted'), or the other device's payment got there first ('rejected').
 */
export type PayOutcome = 'accepted' | 'rejected';

export interface PaneHandle {
  pay(): Promise<void>;
  acceptPrice(): Promise<void>;
}

/**
 * A way for the dev drawer to see and drive the two panes of the split demo. Each pane registers
 * its actions (the very ones its buttons call, so a step does exactly what a click would) and
 * reports its status as it changes. Nothing here is state of the checkout: the server still owns
 * that, and the status is only what the pane is showing right now.
 */
export interface PaneControls {
  register(name: PaneName, handle: PaneHandle | undefined): void;
  reportStatus(name: PaneName, status: PaneStatus | undefined): void;
  statusOf(name: PaneName): PaneStatus | undefined;
  /** Run an action on a pane as if its button was pressed; resolves when its request is done. */
  perform(name: PaneName, op: PaneOp): Promise<void>;
  /**
   * A pane finished an action: pressed by a person or done by `perform`, it reports both the same
   * way. (A listener that only cares about a person's presses ignores them while it is performing.)
   */
  reportAction(name: PaneName, op: PaneOp, outcome?: PayOutcome): void;
  /** Hear every reported action. Returns the function that stops listening. */
  onAction(listener: (name: PaneName, op: PaneOp, outcome?: PayOutcome) => void): () => void;
  /** Something happened that is not a pane's own action (a dev tools button), described in words. */
  reportNote(text: string): void;
  /** Hear every note. Returns the function that stops listening. */
  onNote(listener: (text: string) => void): () => void;
  /** Hear every status a pane reports. Returns the function that stops listening. */
  onStatus(listener: () => void): () => void;
  /** Resolves true as soon as every named pane's status is accepted, or false after `timeoutMs`. */
  waitFor(names: readonly PaneName[], accept: (status: PaneStatus | undefined) => boolean, timeoutMs: number): Promise<boolean>;
}

export function createPaneControls(): PaneControls {
  const handles = new Map<PaneName, PaneHandle>();
  const statuses = new Map<PaneName, PaneStatus | undefined>();
  const listeners = new Set<() => void>();
  const actionListeners = new Set<(name: PaneName, op: PaneOp, outcome?: PayOutcome) => void>();
  const noteListeners = new Set<(text: string) => void>();

  return {
    register(name, handle) {
      if (handle) handles.set(name, handle);
      else handles.delete(name);
    },

    reportStatus(name, status) {
      statuses.set(name, status);
      for (const listener of [...listeners]) listener();
    },

    statusOf: (name) => statuses.get(name),

    async perform(name, op) {
      const handle = handles.get(name);
      if (!handle) throw new Error(`The ${name} pane is not on the page`);
      await (op === 'pay' ? handle.pay() : handle.acceptPrice());
    },

    reportAction(name, op, outcome) {
      for (const listener of [...actionListeners]) listener(name, op, outcome);
    },

    onAction(listener) {
      actionListeners.add(listener);
      return () => void actionListeners.delete(listener);
    },

    reportNote(text) {
      for (const listener of [...noteListeners]) listener(text);
    },

    onNote(listener) {
      noteListeners.add(listener);
      return () => void noteListeners.delete(listener);
    },

    onStatus(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    waitFor(names, accept, timeoutMs) {
      const satisfied = () => names.every((name) => accept(statuses.get(name)));
      if (satisfied()) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const finish = (result: boolean) => {
          clearTimeout(timer);
          listeners.delete(check);
          resolve(result);
        };
        const check = () => {
          if (satisfied()) finish(true);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        listeners.add(check);
      });
    },
  };
}
