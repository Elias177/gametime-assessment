import { useEffect, useRef, useState } from 'react';

const COPIED_MS = 2000;

/**
 * Copies `text` to the clipboard and says so for a moment ("Copied!"), both on the button and in a
 * status region for screen readers. If the clipboard is blocked nothing happens: the text is still
 * on the page to select.
 */
export function CopyButton({
  text,
  testId,
  label = 'Copy',
  announce = 'Copied to clipboard',
}: {
  text: string;
  testId?: string;
  label?: string;
  /** What a screen reader hears after a successful copy. */
  announce?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      // Clipboard can be blocked; the text stays selectable.
    }
  };

  return (
    <>
      <button type="button" data-testid={testId} onClick={() => void copy()}>
        {copied ? 'Copied!' : label}
      </button>
      <span className="visually-hidden" role="status">
        {copied ? announce : ''}
      </span>
    </>
  );
}
