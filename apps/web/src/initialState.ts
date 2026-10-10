import type { ResumeInitialState } from '@checkout/shared';

const SCRIPT_ID = 'initial-state';

/**
 * Take the state a server pre-rendered the page with: parse the `#initial-state` JSON script and
 * remove it. Removed even when unusable, so a bad one can't linger. Returns undefined when there
 * is none or it isn't a session, and the app then loads normally.
 */
export function readInitialState(doc: Document = document): ResumeInitialState | undefined {
  const script = doc.getElementById(SCRIPT_ID);
  if (!script) return undefined;
  const text = script.textContent;
  script.remove();

  try {
    const state = JSON.parse(text ?? '') as Partial<ResumeInitialState> | null;
    return typeof state?.session?.id === 'string' ? (state as ResumeInitialState) : undefined;
  } catch {
    return undefined;
  }
}
