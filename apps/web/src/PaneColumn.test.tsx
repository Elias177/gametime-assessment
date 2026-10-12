// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneColumn, usePulse } from './PaneColumn';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('usePulse', () => {
  it('starts idle, turns on at notify, and turns off after 2.5s', () => {
    const { result } = renderHook(() => usePulse());
    expect(result.current).toMatchObject({ count: 0, active: false });

    act(() => result.current.notify());
    expect(result.current).toMatchObject({ count: 1, active: true });

    act(() => {
      vi.advanceTimersByTime(2499);
    });
    expect(result.current.active).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.active).toBe(false);
    expect(result.current.count).toBe(1); // the ring's key stays; only the notice goes
  });

  it('restarts the notice when notified again, and counts every update', () => {
    const { result } = renderHook(() => usePulse());

    act(() => result.current.notify());
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    act(() => result.current.notify());
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(result.current).toMatchObject({ count: 2, active: true }); // 4s in, but the second notify is only 2s old
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.active).toBe(false);
  });

  it('does not update state after unmount', () => {
    const { result, unmount } = renderHook(() => usePulse());
    act(() => result.current.notify());
    unmount();

    expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
  });
});

function Harness() {
  const pulse = usePulse();
  return (
    <>
      <button type="button" data-testid="poke" onClick={pulse.notify} />
      <PaneColumn
        className="demo-col-phone"
        frameClass="phone-frame"
        testId="phone-pane"
        label="Phone"
        detail="simulated second device"
        frameLabel="Phone preview"
        pulse={pulse}
      >
        <p>pane</p>
      </PaneColumn>
    </>
  );
}

describe('PaneColumn', () => {
  it('names the device under the frame and labels the frame', () => {
    render(<Harness />);

    const frame = screen.getByTestId('phone-pane');
    expect(frame.getAttribute('aria-label')).toBe('Phone preview');
    expect(frame.textContent).toBe('pane');
    expect(frame.parentElement!.querySelector('.pane-caption')!.textContent).toContain('Phone');
    expect(frame.parentElement!.querySelector('.pane-caption')!.textContent).toContain('simulated second device');
  });

  it('has no ring and an empty (but present) status region until the pane is updated', () => {
    render(<Harness />);

    expect(screen.queryByTestId('phone-pane-ring')).toBeNull();
    const synced = screen.getByTestId('phone-pane-synced');
    expect(synced.getAttribute('role')).toBe('status');
    expect(synced.textContent).toBe('');
  });

  it('shows a ring inside the frame and says "Synced just now", then the words go away', () => {
    render(<Harness />);

    act(() => screen.getByTestId('poke').click());

    expect(screen.getByTestId('phone-pane').contains(screen.getByTestId('phone-pane-ring'))).toBe(true);
    expect(screen.getByTestId('phone-pane-ring').getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByTestId('phone-pane-synced').textContent).toBe('Synced just now');

    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(screen.getByTestId('phone-pane-synced').textContent).toBe('');
  });

  it('replaces the ring element on each update, which restarts its animation', () => {
    render(<Harness />);

    act(() => screen.getByTestId('poke').click());
    const first = screen.getByTestId('phone-pane-ring');
    act(() => screen.getByTestId('poke').click());

    expect(screen.getByTestId('phone-pane-ring')).not.toBe(first);
  });
});
