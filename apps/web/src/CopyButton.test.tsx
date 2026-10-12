// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopyButton } from './CopyButton';

function stubClipboard(writeText: () => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const click = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button'));
  });
};

describe('CopyButton', () => {
  it('copies the text, says "Copied!" and announces it, then goes back after 2s', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    render(<CopyButton text="order-9" announce="Order number copied" />);
    expect(screen.getByRole('button').textContent).toBe('Copy');
    expect(screen.getByRole('status').textContent).toBe('');

    await click();

    expect(writeText).toHaveBeenCalledExactlyOnceWith('order-9');
    expect(screen.getByRole('button').textContent).toBe('Copied!');
    expect(screen.getByRole('status').textContent).toBe('Order number copied');

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole('button').textContent).toBe('Copy');
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('uses the label it is given', () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    render(<CopyButton text="x" label="Copy link" />);

    expect(screen.getByRole('button').textContent).toBe('Copy link');
  });

  it('restarts the 2s when copied again', async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    render(<CopyButton text="x" />);

    await click();
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    await click();
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });

    expect(screen.getByRole('button').textContent).toBe('Copied!'); // 3s in, but the last copy is 1.5s old
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole('button').textContent).toBe('Copy');
  });

  it('stays quiet when the clipboard is blocked', async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error('denied')));
    render(<CopyButton text="x" />);

    await click();

    expect(screen.getByRole('button').textContent).toBe('Copy');
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('does not touch state after unmount', async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    const { unmount } = render(<CopyButton text="x" />);
    await click();
    unmount();

    expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
  });
});
