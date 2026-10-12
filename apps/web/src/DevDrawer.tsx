import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ChaosPanel, describeChaos } from './ChaosPanel';
import type { Chaos } from './ChaosPanel';
import { EventLog } from './EventLog';
import type { PaneControls, PaneStatus } from './paneControls';
import { ScenariosView } from './ScenariosView';

const TABS = [
  { id: 'actions', label: 'Actions' },
  { id: 'scenarios', label: 'Scenarios' },
  { id: 'events', label: 'Events' },
] as const;

type TabId = (typeof TABS)[number]['id'];

const TITLE = 'Gametime "In time" Demo';

/** Keep in step with the 1240px breakpoint in styles.css, where the page has room for the drawer beside it. */
const WIDE = '(min-width: 1240px)';

/** Whether the viewport is wide enough for the drawer to sit beside the page (true where it can't be asked). */
function useWide() {
  const query = () => (typeof window.matchMedia === 'function' ? window.matchMedia(WIDE) : null);
  const [wide, setWide] = useState(() => query()?.matches ?? true);
  useEffect(() => {
    const list = query();
    if (!list?.addEventListener) return;
    const onChange = () => setWide(list.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, []);
  return wide;
}

/** Whether either pane is showing this status: a pending payment (something to settle), or a placed order. */
function useAnyPaneAt(controls: PaneControls, status: PaneStatus): boolean {
  const read = () => (['desktop', 'phone'] as const).some((name) => controls.statusOf(name) === status);
  const [pending, setPending] = useState(read);
  useEffect(() => {
    setPending(read());
    return controls.onStatus(() => setPending(read()));
    // `read` only closes over `controls`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controls]);
  return pending;
}

/**
 * The demo's dev tools in one drawer on the left edge: the chaos actions, guided scenarios built
 * from them, and the analytics log. On wide screens it is always open and the page makes room for
 * it. On narrow ones it is closed behind a menu button in a top bar and, when opened, overlays the
 * page behind a scrim. It stays hidden unless the server says dev tools are on. All tabs stay
 * mounted so the log keeps polling and the latest chaos result and scenario progress survive a tab
 * switch.
 */
export function DevDrawer({
  chaos,
  controls,
}: {
  /** The chaos actions for this session; made by the demo, which shares them with the action log. */
  chaos: Chaos;
  /** The two panes of the split demo, which scenario steps press buttons on. */
  controls: PaneControls;
}) {
  const { behavior } = chaos;
  const paymentPending = useAnyPaneAt(controls, 'payment_pending');
  const orderPlaced = useAnyPaneAt(controls, 'completed');

  // Every action the server accepted, from a button here or from a scenario, goes in the action log.
  const performed = chaos.performed;
  useEffect(() => {
    if (performed) controls.reportNote(`Dev tools ${describeChaos(performed.action)}`);
  }, [controls, performed]);
  const wide = useWide();
  const [menuOpen, setMenuOpen] = useState(false);
  const open = wide || menuOpen;
  const [tab, setTab] = useState<TabId>('actions');
  // Scenarios are for getting an order placed or breaking one on the way; after it is placed there is nothing to run.
  const disabledTabs: readonly TabId[] = orderPlaced ? ['scenarios'] : [];
  const tabOff = (id: TabId) => disabledTabs.includes(id);
  useEffect(() => {
    if (orderPlaced) setTab((current) => (current === 'scenarios' ? 'actions' : current));
  }, [orderPlaced]);
  const menuButton = useRef<HTMLButtonElement>(null);
  const tabButtons = useRef<Record<TabId, HTMLButtonElement | null>>({ actions: null, scenarios: null, events: null });
  const wasMenuOpen = useRef(false);

  // The menu only matters on narrow screens: forget it once there is room for the drawer.
  useEffect(() => {
    if (wide) setMenuOpen(false);
  }, [wide]);

  // Move focus into the drawer when the menu opens it, and back to the menu button when it closes.
  useEffect(() => {
    if (wasMenuOpen.current !== menuOpen) {
      if (menuOpen) tabButtons.current[tab]?.focus();
      else menuButton.current?.focus();
    }
    wasMenuOpen.current = menuOpen;
    // Only a change of `menuOpen` should move focus, not a tab switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && menuOpen) setMenuOpen(false);
  };

  const onTabKeyDown = (event: KeyboardEvent, index: number) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const step = event.key === 'ArrowRight' ? 1 : TABS.length - 1;
    let at = (index + step) % TABS.length;
    while (tabOff(TABS[at]!.id)) at = (at + step) % TABS.length; // skip a disabled tab
    const next = TABS[at]!;
    setTab(next.id);
    tabButtons.current[next.id]?.focus();
  };

  return (
    <>
      {!wide && (
        <>
          <div className="dev-bar" hidden={behavior === undefined}>
            <button
              ref={menuButton}
              type="button"
              className="dev-bar-menu"
              data-testid="chaos-toggle"
              aria-label="Dev tools menu"
              aria-expanded={menuOpen}
              aria-controls="dev-drawer-body"
              onClick={() => setMenuOpen((v) => !v)}
            >
              <span className="menu-icon" aria-hidden="true" />
            </button>
            <span className="dev-bar-title">{TITLE}</span>
          </div>
          {/* The drawer overlays the page here, so a click outside it closes it. */}
          <div
            className="dev-drawer-scrim"
            data-testid="dev-drawer-scrim"
            data-open={menuOpen}
            hidden={behavior === undefined}
            aria-hidden="true"
            onClick={() => setMenuOpen(false)}
          />
        </>
      )}
      <aside
        className="dev-drawer"
        data-testid="dev-drawer"
        data-open={open}
        aria-label="Dev tools"
        hidden={behavior === undefined}
        onKeyDown={onKeyDown}
      >
        <header className="dev-drawer-header">
          <div>
            <h2>{TITLE}</h2>
            <p className="dev-drawer-status">
              Next payment: <span data-testid="drawer-behavior" data-behavior={behavior}>
                {behavior}
              </span>
            </p>
          </div>
          {!wide && (
            <button
              type="button"
              className="dev-drawer-close"
              data-testid="drawer-close"
              aria-label="Close dev tools"
              onClick={() => setMenuOpen(false)}
            >
              ×
            </button>
          )}
        </header>

        <div className="dev-drawer-body" id="dev-drawer-body">
          <div className="dev-tabs" role="tablist" aria-label="Dev tools">
            {TABS.map((t, index) => (
              <button
                key={t.id}
                ref={(el) => {
                  tabButtons.current[t.id] = el;
                }}
                type="button"
                role="tab"
                id={`dev-tab-${t.id}`}
                data-testid={`dev-tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`dev-panel-${t.id}`}
                tabIndex={tab === t.id ? 0 : -1}
                disabled={tabOff(t.id)}
                onClick={() => setTab(t.id)}
                onKeyDown={(e) => onTabKeyDown(e, index)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div role="tabpanel" id="dev-panel-actions" aria-labelledby="dev-tab-actions" hidden={tab !== 'actions'}>
            <ChaosPanel chaos={chaos} paymentPending={paymentPending} orderPlaced={orderPlaced} />
          </div>
          <div role="tabpanel" id="dev-panel-scenarios" aria-labelledby="dev-tab-scenarios" hidden={tab !== 'scenarios'}>
            <ScenariosView chaos={chaos} controls={controls} />
          </div>
          <div role="tabpanel" id="dev-panel-events" aria-labelledby="dev-tab-events" hidden={tab !== 'events'}>
            <EventLog />
          </div>
        </div>
      </aside>
    </>
  );
}
