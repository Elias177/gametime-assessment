import type { ChaosAction } from './ChaosPanel';
import type { PaneName, PaneOp, PaneStatus } from './paneControls';

/**
 * Every step is something the demo does when the presenter presses the step button ("Run this step",
 * or "Continue" for an `expect`, which runs no action):
 * - `run`: a chaos action on the server;
 * - `pane`: what a person would press on one or more panes (Pay, Accept new price), done through
 *   the pane's own buttons' code after waiting until that pane can do it;
 * - `expect`: wait until both panes show a status, and fail with what they do show if they don't.
 */
export type ScenarioStep =
  | { kind: 'run'; label: string; action: ChaosAction }
  | { kind: 'pane'; label: string; panes: readonly PaneName[]; op: PaneOp }
  | { kind: 'expect'; label: string; status: PaneStatus };

export interface Scenario {
  id: string;
  title: string;
  summary: string;
  steps: readonly ScenarioStep[];
  /**
   * The scenario leaves nothing a plain new session can use (the seats are gone), so its end button
   * is New Checkout, which resets the demo, instead of Scenarios.
   */
  endsWithReset?: boolean;
}

/** Each one starts from a fresh checkout (use New Checkout). */
export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'price-jump',
    title: 'Price goes up, then pay',
    summary: 'Both panes ask for the new price before anyone can pay.',
    steps: [
      { kind: 'run', label: 'Raise the price by $12', action: { type: 'price', deltaCents: 1200 } },
      { kind: 'expect', label: 'Both panes show the price change', status: 'price_changed' },
      { kind: 'pane', label: 'Accept the new price on the desktop pane', panes: ['desktop'], op: 'accept-price' },
      { kind: 'pane', label: 'Pay on the phone pane', panes: ['phone'], op: 'pay' },
      { kind: 'expect', label: 'Both panes show the completed order', status: 'completed' },
    ],
  },
  {
    id: 'payment-retry',
    title: 'Declined payment, then a retry',
    summary: 'A failure shows on both panes, and the retry is a new attempt.',
    steps: [
      { kind: 'run', label: 'Make the next payment fail', action: { type: 'behavior', behavior: 'fail' } },
      { kind: 'pane', label: 'Pay on the desktop pane', panes: ['desktop'], op: 'pay' },
      { kind: 'expect', label: 'Both panes show the failed payment', status: 'payment_failed' },
      { kind: 'run', label: 'Make the next payment succeed', action: { type: 'behavior', behavior: 'succeed' } },
      { kind: 'pane', label: 'Try again on the desktop pane', panes: ['desktop'], op: 'pay' },
      { kind: 'expect', label: 'Both panes show the completed order', status: 'completed' },
    ],
  },
  {
    id: 'pending-settles',
    title: 'Slow payment that settles later',
    summary: 'Both panes wait on the provider, then follow its answer.',
    steps: [
      { kind: 'run', label: 'Make the next payment stay pending', action: { type: 'behavior', behavior: 'pending' } },
      { kind: 'pane', label: 'Pay on the desktop pane', panes: ['desktop'], op: 'pay' },
      { kind: 'expect', label: 'Both panes show the payment processing', status: 'payment_pending' },
      // The setting is sticky, so put it back before the order is placed: after that the Scenarios tab
      // is off and nothing more can be run. The payment already pending is not affected by it.
      { kind: 'run', label: 'Make the next payment succeed again', action: { type: 'behavior', behavior: 'succeed' } },
      { kind: 'run', label: 'Settle it as succeeded', action: { type: 'settle', outcome: 'succeeded' } },
      { kind: 'expect', label: 'Both panes show the completed order', status: 'completed' },
    ],
  },
  {
    id: 'double-pay',
    title: 'Two devices pay at once',
    summary: 'One order and one charge, whoever is first.',
    steps: [
      { kind: 'pane', label: 'Pay on the desktop and phone panes at the same moment', panes: ['desktop', 'phone'], op: 'pay' },
      { kind: 'expect', label: 'Both panes show one completed order', status: 'completed' },
    ],
  },
  {
    id: 'sold-out',
    title: 'Seats sell out',
    summary: 'The checkout ends in a dead end on both panes.',
    endsWithReset: true,
    steps: [
      { kind: 'run', label: 'Sell out the listing', action: { type: 'sell-out' } },
      { kind: 'expect', label: 'Both panes say the seats are no longer available', status: 'unavailable' },
    ],
  },
  {
    id: 'hold-expires',
    title: 'The hold runs out',
    summary: 'Both panes say so, and offer to start again.',
    steps: [
      { kind: 'run', label: 'Expire the hold', action: { type: 'expire' } },
      { kind: 'expect', label: 'Both panes say the hold ran out', status: 'expired' },
    ],
  },
];
