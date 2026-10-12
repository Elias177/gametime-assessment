import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

const SYNCED_MS = 2500;

/**
 * Tracks "this pane was just updated from outside". `notify` restarts it, so two updates close
 * together run one longer notice, and `count` changes every time (it re-keys the ring animation).
 */
export function usePulse() {
  const [count, setCount] = useState(0);
  const [active, setActive] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const notify = useCallback(() => {
    setCount((c) => c + 1);
    setActive(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setActive(false), SYNCED_MS);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  return { count, active, notify };
}

export type Pulse = ReturnType<typeof usePulse>;

/**
 * One device in the split demo: the pane (in `frameClass`), and under it a caption saying which
 * device it is. When the pane is updated by the other device or the server, a ring fades around the
 * frame and the caption says "Synced just now" for a moment (the text is the signal for anyone who
 * cannot see the ring, and the region is always in the page so it gets announced).
 */
export function PaneColumn({
  className,
  frameClass,
  testId,
  label,
  detail,
  frameLabel,
  pulse,
  children,
}: {
  className: string;
  frameClass: string;
  testId: string;
  label: string;
  detail: string;
  /** Accessible name for the frame, when the visible caption alone is not enough. */
  frameLabel?: string;
  pulse: Pulse;
  children: ReactNode;
}) {
  return (
    <div className={`demo-col ${className}`}>
      <div className={frameClass} data-testid={testId} aria-label={frameLabel}>
        {children}
        {pulse.count > 0 && <span key={pulse.count} className="handoff-ring" aria-hidden="true" data-testid={`${testId}-ring`} />}
      </div>
      <p className="pane-caption">
        <strong>{label}</strong>
        <span className="muted">{detail}</span>
        <span className="synced" role="status" data-testid={`${testId}-synced`}>
          {pulse.active ? 'Synced just now' : ''}
        </span>
      </p>
    </div>
  );
}
