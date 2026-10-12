// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientInfo } from './api';
import { useChaos } from './ChaosPanel';
import { DevDrawer } from './DevDrawer';
import { createPaneControls } from './paneControls';

const CLIENT: ClientInfo = { clientId: 'pane-1', surface: 'web' };
const EMPTY_STATS = { sessions: 0, completed: 0, conversionRate: null, medianMinutesToComplete: null };

/** The drawer as the demo makes it: with its chaos actions made outside it. */
function Drawer({ controls }: { controls: ReturnType<typeof createPaneControls> }) {
  const chaos = useChaos('s1', CLIENT);
  return <DevDrawer chaos={chaos} controls={controls} />;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function installServer(dev = true) {
  let behavior = 'succeed';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/dev/status') {
        return dev ? json(200, { enabled: true, paymentBehavior: behavior, clockOffsetMs: 0 }) : json(404, {});
      }
      if (path === '/api/dev/events') {
        return json(200, { events: [], metric: { crossDevice: EMPTY_STATS, singleDevice: EMPTY_STATS } });
      }
      if (path === '/api/dev/payment-behavior') {
        behavior = JSON.parse(init!.body as string).behavior;
        return json(200, {});
      }
      if (path === '/api/sessions/s1') return json(200, { id: 's1', listingId: 'l1' });
      if (path.startsWith('/api/dev/')) return json(200, {}); // any other dev action succeeds
      return json(404, {});
    }),
  );
}

async function renderDrawer() {
  render(<Drawer controls={createPaneControls()} />);
  const drawer = screen.getByTestId('dev-drawer');
  await waitFor(() => expect(drawer.hasAttribute('hidden')).toBe(false));
  return drawer;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DevDrawer', () => {
  it('opens the settle buttons only while a pane has a pending payment', async () => {
    installServer();
    const controls = createPaneControls();
    render(<Drawer controls={controls} />);
    await waitFor(() => expect(screen.getByTestId('dev-drawer').hasAttribute('hidden')).toBe(false));
    const settle = screen.getByTestId('chaos-settle');
    expect(settle.getAttribute('data-open')).toBe('false');

    act(() => controls.reportStatus('phone', 'payment_pending'));
    expect(settle.getAttribute('data-open')).toBe('true');

    act(() => controls.reportStatus('phone', 'completed'));
    expect(settle.getAttribute('data-open')).toBe('false');
  });

  it('stays hidden, with no handle to find, when the server has dev tools off', async () => {
    installServer(false);
    render(<Drawer controls={createPaneControls()} />);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId('dev-drawer').hasAttribute('hidden')).toBe(true);
  });

  it('is always open on a wide screen: titled, with the next payment under the title, and nothing to close it', async () => {
    installServer();
    const drawer = await renderDrawer();

    expect(drawer.getAttribute('data-open')).toBe('true');
    expect(drawer.querySelector('header h2')!.textContent).toBe('Gametime "In time" Demo');
    expect(drawer.querySelector('.dev-drawer-status')!.textContent).toBe('Next payment: succeed');
    expect(screen.queryByTestId('chaos-toggle')).toBeNull();
    expect(screen.queryByTestId('drawer-close')).toBeNull();
    expect(screen.queryByTestId('dev-drawer-scrim')).toBeNull();
    expect(document.getElementById('dev-drawer-body')).toBeTruthy();
    expect(drawer.contains(document.activeElement)).toBe(false);

    fireEvent.keyDown(drawer, { key: 'Escape' });
    expect(drawer.getAttribute('data-open')).toBe('true');
  });

  it('colours the status and the behavior buttons by what the next payment will do', async () => {
    installServer();
    await renderDrawer();
    const status = screen.getByTestId('drawer-behavior');
    expect(status.getAttribute('data-behavior')).toBe('succeed');
    expect(screen.getByTestId('chaos-behavior-succeed').getAttribute('data-behavior')).toBe('succeed');
    expect(screen.getByTestId('chaos-behavior-fail').getAttribute('data-behavior')).toBe('fail');
    expect(screen.getByTestId('chaos-behavior-pending').getAttribute('data-behavior')).toBe('pending');

    fireEvent.click(screen.getByTestId('chaos-behavior-fail'));

    await waitFor(() => expect(status.getAttribute('data-behavior')).toBe('fail'));
  });

  it('keeps the next-payment behavior current', async () => {
    installServer();
    await renderDrawer();
    expect(screen.getByTestId('drawer-behavior').textContent).toBe('succeed');

    fireEvent.click(await screen.findByTestId('chaos-behavior-fail'));

    await waitFor(() => expect(screen.getByTestId('drawer-behavior').textContent).toBe('fail'));
  });

  describe('on a narrow screen', () => {
    async function renderNarrow() {
      installServer();
      vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query }));
      return renderDrawer();
    }

    it('starts closed behind a menu button in a top bar', async () => {
      const drawer = await renderNarrow();
      const menu = screen.getByTestId('chaos-toggle');

      expect(drawer.getAttribute('data-open')).toBe('false');
      expect(menu.getAttribute('aria-expanded')).toBe('false');
      expect(menu.getAttribute('aria-controls')).toBe('dev-drawer-body');
      expect(document.querySelector('.dev-bar-title')!.textContent).toBe('Gametime "In time" Demo');
    });

    it('opens from the menu button and moves focus into the drawer', async () => {
      const drawer = await renderNarrow();

      fireEvent.click(screen.getByTestId('chaos-toggle'));

      expect(drawer.getAttribute('data-open')).toBe('true');
      expect(screen.getByTestId('chaos-toggle').getAttribute('aria-expanded')).toBe('true');
      expect(document.activeElement).toBe(screen.getByTestId('dev-tab-actions'));
    });

    it('closes with its close button, returning focus to the menu button', async () => {
      const drawer = await renderNarrow();
      fireEvent.click(screen.getByTestId('chaos-toggle'));

      fireEvent.click(screen.getByTestId('drawer-close'));

      expect(drawer.getAttribute('data-open')).toBe('false');
      expect(document.activeElement).toBe(screen.getByTestId('chaos-toggle'));
    });

    it('closes on Escape, returning focus to the menu button', async () => {
      const drawer = await renderNarrow();
      fireEvent.click(screen.getByTestId('chaos-toggle'));

      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });

      expect(drawer.getAttribute('data-open')).toBe('false');
      expect(document.activeElement).toBe(screen.getByTestId('chaos-toggle'));
    });

    it('closes when the scrim behind it is clicked', async () => {
      const drawer = await renderNarrow();
      fireEvent.click(screen.getByTestId('chaos-toggle'));
      const scrim = screen.getByTestId('dev-drawer-scrim');
      expect(scrim.getAttribute('data-open')).toBe('true');

      fireEvent.click(scrim);

      expect(drawer.getAttribute('data-open')).toBe('false');
      expect(scrim.getAttribute('data-open')).toBe('false');
    });

    it('does nothing on Escape when it is already closed', async () => {
      const drawer = await renderNarrow();

      fireEvent.keyDown(screen.getByTestId('chaos-toggle'), { key: 'Escape' });

      expect(drawer.getAttribute('data-open')).toBe('false');
      expect(document.activeElement).not.toBe(screen.getByTestId('chaos-toggle'));
    });
  });

  it('switches between Actions and Events, keeping both mounted', async () => {
    installServer();
    await renderDrawer();
    await screen.findByTestId('event-log');

    const actions = document.getElementById('dev-panel-actions')!;
    const events = document.getElementById('dev-panel-events')!;
    expect(actions.hasAttribute('hidden')).toBe(false);
    expect(events.hasAttribute('hidden')).toBe(true);
    expect(screen.getByTestId('dev-tab-actions').getAttribute('aria-selected')).toBe('true');

    fireEvent.click(screen.getByTestId('dev-tab-events'));
    expect(actions.hasAttribute('hidden')).toBe(true);
    expect(events.hasAttribute('hidden')).toBe(false);
    expect(screen.getByTestId('dev-tab-events').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('chaos-panel')).toBeTruthy(); // still mounted
    expect(screen.getByTestId('event-log')).toBeTruthy();
  });

  it('moves between the tabs with the arrow keys, wrapping at the ends', async () => {
    installServer();
    await renderDrawer();

    fireEvent.keyDown(screen.getByTestId('dev-tab-actions'), { key: 'ArrowRight' });
    expect(screen.getByTestId('dev-tab-scenarios').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByTestId('dev-tab-scenarios'));

    fireEvent.keyDown(screen.getByTestId('dev-tab-scenarios'), { key: 'ArrowRight' });
    expect(screen.getByTestId('dev-tab-events').getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(screen.getByTestId('dev-tab-events'), { key: 'ArrowRight' });
    expect(screen.getByTestId('dev-tab-actions').getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(screen.getByTestId('dev-tab-actions'), { key: 'ArrowLeft' });
    expect(screen.getByTestId('dev-tab-events').getAttribute('aria-selected')).toBe('true');
  });

  it('runs a scenario step through the same chaos actions, and keeps its progress across a tab switch', async () => {
    installServer();
    await renderDrawer();
    fireEvent.click(screen.getByTestId('dev-tab-scenarios'));

    fireEvent.click(screen.getByTestId('scenario-start-hold-expires'));
    fireEvent.click(screen.getByTestId('scenario-run'));

    await waitFor(() => expect(screen.getByTestId('scenario-step-1').getAttribute('aria-current')).toBe('step'));
    const calls = (fetch as unknown as { mock: { calls: Array<[string, RequestInit?]> } }).mock.calls;
    expect(calls.filter(([, init]) => init?.method === 'POST').map(([path]) => path)).toEqual(['/api/dev/expire/s1']);

    fireEvent.click(screen.getByTestId('dev-tab-actions'));
    fireEvent.click(screen.getByTestId('dev-tab-scenarios'));

    expect(screen.getByTestId('scenario-step-1').getAttribute('aria-current')).toBe('step'); // still on step 2
    expect(screen.getByTestId('chaos-result').textContent).toBe('Hold expired'); // the Actions tab saw it too
  });

  it('marks a scenario step done when the same action is done from the Actions tab instead', async () => {
    installServer();
    await renderDrawer();
    fireEvent.click(screen.getByTestId('dev-tab-scenarios'));
    fireEvent.click(screen.getByTestId('scenario-start-hold-expires')); // step 1: expire the hold

    fireEvent.click(screen.getByTestId('dev-tab-actions'));
    fireEvent.click(await screen.findByTestId('chaos-expire')); // the presenter does it themselves
    await screen.findByTestId('chaos-result');
    fireEvent.click(screen.getByTestId('dev-tab-scenarios'));

    expect(screen.getByTestId('scenario-step-0').getAttribute('data-state')).toBe('done');
    expect(screen.getByTestId('scenario-step-1').getAttribute('aria-current')).toBe('step');
    expect(screen.getByTestId('scenario-note').textContent).toContain('You did that step yourself');
  });

  it('keeps the chaos result across a tab switch', async () => {
    installServer();
    await renderDrawer();
    fireEvent.click(await screen.findByTestId('chaos-behavior-pending'));
    await screen.findByTestId('chaos-result');

    fireEvent.click(screen.getByTestId('dev-tab-events'));
    fireEvent.click(screen.getByTestId('dev-tab-actions'));

    expect(screen.getByTestId('chaos-result').textContent).toBe('Next payment will pending');
  });

  it('tells the action log about each chaos action the server accepted', async () => {
    installServer();
    const controls = createPaneControls();
    const notes: string[] = [];
    controls.onNote((text) => notes.push(text));
    render(<Drawer controls={controls} />);

    fireEvent.click(await screen.findByTestId('chaos-behavior-fail'));
    await waitFor(() => expect(notes).toEqual(['Dev tools set the next payment to fail']));
  });

  it('once an order is placed, hides the other chaos groups and disables the Scenarios tab', async () => {
    installServer();
    const controls = createPaneControls();
    render(<Drawer controls={controls} />);
    await screen.findByTestId('chaos-expire');
    const scenarios = screen.getByTestId('dev-tab-scenarios') as HTMLButtonElement;
    expect(scenarios.disabled).toBe(false);

    act(() => controls.reportStatus('desktop', 'completed'));
    expect(screen.getByTestId('chaos-breakers').getAttribute('data-open')).toBe('false');
    expect(scenarios.disabled).toBe(true);
    expect((screen.getByTestId('chaos-reset') as HTMLButtonElement).disabled).toBe(false);

    // A new checkout brings everything back.
    act(() => controls.reportStatus('desktop', undefined));
    expect(screen.getByTestId('chaos-breakers').getAttribute('data-open')).toBe('true');
    expect(scenarios.disabled).toBe(false);
  });

  it('moves off the Scenarios tab when the order is placed, and the arrow keys skip it', async () => {
    installServer();
    const controls = createPaneControls();
    render(<Drawer controls={controls} />);
    await screen.findByTestId('chaos-expire');
    fireEvent.click(screen.getByTestId('dev-tab-scenarios'));

    act(() => controls.reportStatus('phone', 'completed'));
    expect(screen.getByTestId('dev-tab-actions').getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(screen.getByTestId('dev-tab-actions'), { key: 'ArrowRight' });
    expect(screen.getByTestId('dev-tab-events').getAttribute('aria-selected')).toBe('true');
  });
});
