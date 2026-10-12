import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Chaos } from './ChaosPanel';
import type { PaneControls, PaneName, PaneOp, PaneStatus } from './paneControls';

const PANES: readonly PaneName[] = ['desktop', 'phone'];
const PANE_LABEL: Record<PaneName, string> = { desktop: 'Desktop', phone: 'Phone' };
const OP_TEXT: Record<PaneOp, string> = { pay: 'pressed Pay', 'accept-price': 'accepted the new price' };
/** What a pane moving to a status means, in words a person would use. */
const STATUS_TEXT: Record<PaneStatus, string> = {
  active: 'is ready to pay again',
  price_changed: 'was told the price changed',
  payment_pending: 'is waiting for the payment to go through',
  completed: 'shows the order as confirmed',
  payment_failed: 'was told the payment failed',
  expired: 'was told the seat hold ran out',
  unavailable: 'was told the seats are gone',
};
const MAX_ENTRIES = 100;

/** Where the checkout stands, when it needs the presenter: a payment to settle, or an order to leave. */
type Prompt = 'settle' | 'placed' | null;

function usePrompt(controls: PaneControls): Prompt {
  const read = (): Prompt => {
    const statuses = PANES.map((name) => controls.statusOf(name));
    if (statuses.includes('payment_pending')) return 'settle';
    return statuses.includes('completed') ? 'placed' : null;
  };
  const [prompt, setPrompt] = useState(read);
  useEffect(() => {
    setPrompt(read());
    return controls.onStatus(() => setPrompt(read()));
    // `read` only closes over `controls`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controls]);
  return prompt;
}

interface Entry {
  /** The action's number, counting from 1 in this checkout. */
  n: number;
  /** Who did it: a pane, or the dev tools. */
  who: PaneName | 'dev';
  text: string;
}

/**
 * What happened in this demo, numbered, oldest at the top and newest at the bottom like a chat: what each pane did (Pay, Accept) and each
 * status a pane moved to, including the ones the other device or the server caused. A pane first
 * showing its checkout is not an action, so it is not listed. After the last entry, when the
 * dev tools are on, it can ask for what comes next: settle a pending payment, or reset once the order
 * is placed. It only listens to the panes' registry, so it holds no checkout state.
 */
export function ActionLog({ controls, chaos }: { controls: PaneControls; chaos: Chaos }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const count = useRef(0);
  const list = useRef<HTMLOListElement>(null);
  /** Follow new entries down, unless the person has scrolled up to read older ones. */
  const stickToBottom = useRef(true);
  // The buttons are dev tools actions, so they are only offered while the dev tools are on.
  const wanted = usePrompt(controls);
  const prompt = chaos.behavior ? wanted : null;

  useEffect(() => {
    const add = (who: Entry['who'], text: string) => {
      // The number is taken here, not in the updater: React may run an updater twice.
      const entry = { n: ++count.current, who, text };
      setEntries((current) => [...current, entry].slice(-MAX_ENTRIES));
    };

    const seen = new Map<PaneName, PaneStatus | undefined>(PANES.map((name) => [name, controls.statusOf(name)]));
    const stopStatus = controls.onStatus(() => {
      for (const name of PANES) {
        const status = controls.statusOf(name);
        const before = seen.get(name);
        if (status === before) continue;
        seen.set(name, status);
        if (status && before) add(name, STATUS_TEXT[status]);
      }
    });
    const stopAction = controls.onAction((name, op) => add(name, OP_TEXT[op]));
    // A note already names who did it ("Dev tools raised the price by $12").
    const stopNote = controls.onNote((text) => add('dev', text));
    return () => {
      stopStatus();
      stopAction();
      stopNote();
    };
  }, [controls]);

  useLayoutEffect(() => {
    const el = list.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [entries, prompt]);

  // The log's height follows the desktop pane beside it, which animates (the phone section opening).
  // Keep the newest entries in view on every frame of that, not just when an entry is added.
  const hasList = entries.length > 0 || prompt !== null;
  useLayoutEffect(() => {
    const el = list.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasList]);

  const onScroll = () => {
    const el = list.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  return (
    <div className="demo-col demo-col-log">
      <section className="action-log" aria-label="Action log" data-testid="action-log">
        {entries.length === 0 && !prompt ? (
          <p className="muted">Nothing yet. Press a button on either device.</p>
        ) : (
          <ol role="log" ref={list} onScroll={onScroll}>
            {entries.map((entry) => (
              <li key={entry.n} data-who={entry.who}>
                <span className="action-log-n">{entry.n}.</span>
                <span>
                  {entry.who === 'dev' ? (
                    entry.text
                  ) : (
                    <>
                      <strong>{PANE_LABEL[entry.who]}</strong> {entry.text}
                    </>
                  )}
                </span>
              </li>
            ))}
            {prompt === 'settle' && (
              <li className="action-log-prompt" data-testid="log-prompt-settle">
                <span className="action-log-n" aria-hidden="true" />
                <div className="action-log-prompt-body">
                  <span>The payment is pending. How should it end?</span>
                  <span className="action-log-buttons">
                    <button type="button" className="success" data-testid="log-settle-succeeded" disabled={chaos.busy} onClick={() => void chaos.perform({ type: 'settle', outcome: 'succeeded' })}>
                      Succeed
                    </button>
                    <button type="button" className="danger" data-testid="log-settle-failed" disabled={chaos.busy} onClick={() => void chaos.perform({ type: 'settle', outcome: 'failed' })}>
                      Fail
                    </button>
                  </span>
                </div>
              </li>
            )}
            {prompt === 'placed' && (
              <li className="action-log-prompt" data-testid="log-prompt-placed">
                <span className="action-log-n" aria-hidden="true" />
                <div className="action-log-prompt-body">
                  <span>Order placed. Nothing more to do here except start a new checkout.</span>
                  <span className="action-log-buttons">
                    <button type="button" className="danger" data-testid="log-reset" disabled={chaos.busy} onClick={() => void chaos.perform({ type: 'reset' })}>
                      New Checkout
                    </button>
                  </span>
                </div>
              </li>
            )}
          </ol>
        )}
      </section>
      <p className="pane-caption">
        <strong>Action log</strong>
        <span className="muted">everything done in this demo</span>
      </p>
    </div>
  );
}
