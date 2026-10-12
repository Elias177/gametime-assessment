import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Every test starts from the seed state: no sessions, full stock, seed price, real clock.
// This needs the server to run with DEV_TOOLS=1 (`pnpm dev` and the Playwright config set it).
test.beforeEach(async ({ request }) => {
  const res = await request.post('/api/dev/reset');
  expect(res.status(), 'POST /api/dev/reset must return 204: is the server running with DEV_TOOLS=1?').toBe(204);
});

/** Start a checkout and wait until both panes are live on it. */
async function startCheckout(page: Page) {
  await page.goto('/');
  await page.getByTestId('start-checkout').click();
  const desktop = page.getByTestId('desktop-pane');
  const phone = page.getByTestId('phone-pane');
  await expect(desktop.getByTestId('connection')).toContainText('live');
  await expect(phone.getByTestId('connection')).toContainText('live');
  return { desktop, phone, chaos: page.getByTestId('chaos-panel') };
}

test('starts a checkout and shows the split-screen demo, live over SSE', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('start-checkout').click();

  await expect(page).toHaveURL(/\/checkout\/[\w-]+$/);
  const desktop = page.getByTestId('desktop-pane');
  const pane = desktop.getByTestId('checkout-pane');
  await expect(pane).toHaveAttribute('data-status', 'active');
  await expect(pane.getByRole('heading', { name: 'The Midnight Orchestra' })).toBeVisible();
  await expect(desktop.getByTestId('listing')).toContainText('Harbor Hall');
  await expect(desktop.getByTestId('price')).toHaveText('$100.00');
  await expect(desktop.getByTestId('countdown')).toContainText('Seats held for');
  await expect(desktop.getByTestId('pay')).toBeEnabled();
  // The stream is up through the Vite /api proxy.
  await expect(desktop.getByTestId('connection')).toContainText('live');

  // The phone frame is a second client on the same checkout, with the sticky Pay bar.
  const phone = page.getByTestId('phone-pane');
  await expect(phone.getByTestId('origin-label')).toHaveText('Opened from link');
  await expect(phone.getByTestId('pay')).toBeEnabled();
  await expect(phone.getByTestId('connection')).toContainText('live');
});

test('each pane is its own client: distinct ids and surfaces on every request', async ({ page }) => {
  const seen = new Map<string, Set<string>>(); // surface -> client ids
  page.on('request', (request) => {
    if (!request.url().includes('/api/sessions/')) return;
    const url = new URL(request.url());
    const clientId = request.headers()['x-client-id'] ?? url.searchParams.get('clientId');
    const surface = request.headers()['x-surface'] ?? url.searchParams.get('surface');
    expect([request.url(), Boolean(clientId && surface)]).toEqual([request.url(), true]);
    seen.set(surface!, (seen.get(surface!) ?? new Set()).add(clientId!));
  });

  await page.goto('/');
  await page.getByTestId('start-checkout').click();
  await expect(page.getByTestId('phone-pane').getByTestId('connection')).toContainText('live');
  await expect(page.getByTestId('desktop-pane').getByTestId('connection')).toContainText('live');

  expect([...seen.keys()].sort()).toEqual(['mobile', 'web']);
  expect(seen.get('web')!.size).toBe(1);
  expect(seen.get('mobile')!.size).toBe(1);
  expect([...seen.get('web')!][0]).not.toBe([...seen.get('mobile')!][0]);
});

test('paying on the desktop pane shows "Completed on another device" in the phone frame', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('start-checkout').click();
  const desktop = page.getByTestId('desktop-pane');
  const phone = page.getByTestId('phone-pane');
  await expect(phone.getByTestId('connection')).toContainText('live');

  await desktop.getByTestId('pay').click();

  await expect(desktop.getByTestId('confirmation')).toContainText('Order confirmed');
  await expect(phone.getByTestId('completed-elsewhere')).toContainText('Completed on another device');
  await expect(phone.getByTestId('pay')).toHaveCount(0);

  // Both panes show the same receipt: the order number (copyable) and what was charged.
  const orderId = (await desktop.getByTestId('order-id').textContent())!;
  expect(orderId.length).toBeGreaterThan(0);
  await expect(phone.getByTestId('order-id')).toHaveText(orderId);
  await expect(desktop.getByTestId('receipt-total')).toHaveText('$100.00');
  await expect(phone.getByTestId('receipt-total')).toHaveText('$100.00');
  await expect(desktop.getByTestId('copy-order')).toBeVisible();
});

test('the pane that did not act is marked "Synced just now"; the one that paid is not', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('start-checkout').click();
  const desktop = page.getByTestId('desktop-pane');
  const phone = page.getByTestId('phone-pane');
  await expect(desktop.getByTestId('connection')).toContainText('live');
  await expect(phone.getByTestId('connection')).toContainText('live');
  await expect(page.getByTestId('phone-pane-ring')).toHaveCount(0); // loading both panes is not a sync

  await desktop.getByTestId('pay').click();

  await expect(page.getByTestId('phone-pane-synced')).toHaveText('Synced just now');
  await expect(phone.getByTestId('phone-pane-ring')).toHaveCount(1);
  await expect(page.getByTestId('desktop-pane-synced')).toHaveText('');
  await expect(page.getByTestId('desktop-pane-ring')).toHaveCount(0);
  await expect(page.getByTestId('phone-pane-synced')).toHaveText('', { timeout: 5000 }); // and it goes away
});

/** The two left-hand cards (log + desktop) against the phone card, and the log on its own. Heights settle over ~0.3s. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const h = (selector: string) => Math.round(document.querySelector(selector)!.getBoundingClientRect().height);
    return { left: h('.demo-col-left'), phone: h('.demo-col-phone'), log: h('[data-testid=action-log]') };
  });
}

async function settled(page: Page) {
  // Every transition on the page (the section opening, the log following it) has finished.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState === 'finished' || a.playState === 'idle'));
  return measure(page);
}

test('Continue on phone opens and closes smoothly, and the action log gives up the height so the columns stay level', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('start-checkout').click();
  const section = page.getByTestId('phone-link');
  const toggle = page.getByTestId('desktop-pane').getByTestId('continue-on-phone');

  await expect(toggle).toBeVisible();
  await expect(section).toBeHidden();
  const closed = await settled(page);
  expect(closed.left).toBe(closed.phone);

  await toggle.click();
  // The log does not jump to its final height: partway through it is between the two.
  await expect.poll(async () => (await measure(page)).log, { intervals: [30] }).toBeLessThan(closed.log);
  await expect(section).toBeVisible();
  const open = await settled(page);
  expect(open.left).toBe(open.phone);
  expect(open.log).toBeLessThan(closed.log);
  // On localhost a phone could not open the link, so there is the link to copy and no QR.
  await expect(page.getByTestId('phone-qr')).toHaveCount(0);
  await expect(section.getByRole('textbox')).toHaveValue(/localhost:5173\/resume\//);

  await toggle.click();
  await expect(section).toBeHidden();
  const back = await settled(page);
  expect(back).toEqual(closed);
});

test.describe('on an address a phone can reach', () => {
  // Serve the app under a made-up public host name by forwarding its requests to the dev server.
  test.beforeEach(async ({ context }) => {
    await context.route(/^http:\/\/demo\.example:5173\//, (route) => {
      const request = route.request();
      const headers = Object.fromEntries(Object.entries(request.headers()).map(([k, v]) => [k, v.replace('demo.example', 'localhost')]));
      return route.continue({ url: request.url().replace('demo.example', 'localhost'), headers });
    });
  });

  test('Continue on phone shows a QR code of the link, and the columns stay level', async ({ page }) => {
    await page.goto('http://demo.example:5173/');
    await page.getByTestId('start-checkout').click();
    const toggle = page.getByTestId('desktop-pane').getByTestId('continue-on-phone');
    const qr = page.getByTestId('phone-qr');

    await expect(toggle).toBeVisible();
    await expect(qr).toBeHidden();
    const closed = await settled(page);

    await toggle.click();
    await expect(qr).toBeVisible();
    const link = await page.getByTestId('phone-link').getByRole('textbox').inputValue();
    expect(link).toMatch(/^http:\/\/demo\.example:5173\/resume\//);
    await expect(qr).toHaveAttribute('data-value', link);
    const open = await settled(page);
    expect(open.left).toBe(open.phone);
    expect(open.log).toBeLessThan(closed.log);

    await toggle.click();
    await expect(qr).toBeHidden();
    expect(await settled(page)).toEqual(closed);
  });
});

test('the resume link opens only the mobile view, as a second device', async ({ page, context }) => {
  await page.goto('/');
  await page.getByTestId('start-checkout').click();
  await page.getByTestId('desktop-pane').getByTestId('continue-on-phone').click();
  const link = await page.getByTestId('phone-link').getByRole('textbox').inputValue();
  expect(link).toMatch(/\/resume\/[\w-]+$/);

  const second = await context.newPage();
  await second.goto(link);
  await expect(second.getByTestId('checkout-pane')).toHaveAttribute('data-status', 'active');
  await expect(second.getByTestId('checkout-pane')).toHaveCount(1);
  await expect(second.getByTestId('desktop-pane')).toHaveCount(0);
  await expect(second.getByTestId('phone-pane')).toHaveCount(0);
  await expect(second.getByTestId('origin-label')).toHaveText('Opened from link');
  await expect(second.getByTestId('pay')).toBeEnabled();
  // Dev controls belong to the demo, not to a phone.
  await expect(second.getByTestId('chaos-panel')).toHaveCount(0);
});

test.describe('recovery states, forced with the chaos panel', () => {
  test('price_changed: both panes show it; accept, then pay', async ({ page }) => {
    const { desktop, phone, chaos } = await startCheckout(page);

    await chaos.getByTestId('chaos-price-up').click();

    // Desktop: inline banner with old and new price, Pay locked.
    await expect(desktop.getByTestId('checkout-pane')).toHaveAttribute('data-status', 'price_changed');
    await expect(desktop.getByTestId('price-banner')).toContainText('from $100.00 to $112.00');
    await expect(desktop.getByTestId('price-old')).toHaveText('$100.00');
    await expect(desktop.getByTestId('pay')).toBeDisabled();
    // Phone: the same state in a bottom sheet.
    await expect(phone.getByRole('dialog')).toBeVisible();
    await expect(phone.getByTestId('price-banner')).toContainText('from $100.00 to $112.00');
    await expect(phone.getByTestId('pay')).toBeDisabled();

    // Accepting on the desktop clears it on both, at the new price.
    await desktop.getByTestId('accept-price').click();
    await expect(desktop.getByTestId('checkout-pane')).toHaveAttribute('data-status', 'active');
    await expect(phone.getByTestId('checkout-pane')).toHaveAttribute('data-status', 'active');
    await expect(phone.getByRole('dialog')).toHaveCount(0);
    await expect(desktop.getByTestId('pay')).toHaveText('Pay $112.00');
    await expect(phone.getByTestId('pay')).toHaveText('Pay $112.00');

    await desktop.getByTestId('pay').click();
    await expect(desktop.getByTestId('confirmation')).toContainText('Order confirmed');
    await expect(phone.getByTestId('completed-elsewhere')).toContainText('Completed on another device');
  });

  test('a price drop is applied silently on both panes', async ({ page }) => {
    const { desktop, phone, chaos } = await startCheckout(page);

    await chaos.getByTestId('chaos-price-down').click();

    await expect(desktop.getByTestId('pay')).toHaveText('Pay $95.00');
    await expect(phone.getByTestId('pay')).toHaveText('Pay $95.00');
    await expect(desktop.getByTestId('checkout-pane')).toHaveAttribute('data-status', 'active');
    await expect(phone.getByRole('dialog')).toHaveCount(0);
  });

  test('expired: both panes say the hold ran out', async ({ page }) => {
    const { desktop, phone, chaos } = await startCheckout(page);

    await chaos.getByTestId('chaos-expire').click();

    await expect(desktop.getByTestId('checkout-pane')).toHaveAttribute('data-status', 'expired');
    await expect(desktop.getByTestId('expired')).toContainText('Your hold ran out');
    await expect(desktop.getByRole('button', { name: 'Start again' })).toBeVisible();
    await expect(desktop.getByTestId('pay')).toHaveCount(0);
    await expect(phone.getByRole('dialog')).toBeVisible();
    await expect(phone.getByTestId('expired')).toContainText('Your hold ran out');
    await expect(phone.getByRole('button', { name: 'Start again' })).toBeVisible();
    await expect(phone.getByTestId('pay')).toHaveCount(0);
  });

  test('unavailable: both panes show the dead end', async ({ page }) => {
    const { desktop, phone, chaos } = await startCheckout(page);

    await chaos.getByTestId('chaos-sell-out').click();

    await expect(desktop.getByTestId('checkout-pane')).toHaveAttribute('data-status', 'unavailable');
    await expect(desktop.getByTestId('unavailable')).toContainText('These seats are no longer available');
    await expect(desktop.getByRole('button', { name: 'Find other tickets' })).toBeVisible();
    await expect(phone.getByRole('dialog')).toBeVisible();
    await expect(phone.getByTestId('unavailable')).toContainText('These seats are no longer available');
    await expect(phone.getByRole('button', { name: 'Find other tickets' })).toBeVisible();
    await expect(phone.getByTestId('pay')).toHaveCount(0);
  });

  test('a pending payment settles as failed on both panes', async ({ page }) => {
    const { desktop, phone, chaos } = await startCheckout(page);
    await chaos.getByTestId('chaos-behavior-pending').click();
    await expect(page.getByTestId('drawer-behavior')).toHaveText('pending');

    await desktop.getByTestId('pay').click();
    await expect(desktop.getByTestId('processing')).toBeVisible();
    await expect(phone.getByTestId('processing')).toBeVisible();

    await chaos.getByTestId('chaos-settle-failed').click();
    await expect(desktop.getByTestId('payment-failed')).toBeVisible();
    await expect(phone.getByTestId('payment-failed')).toBeVisible();
  });
});

test.describe('guided scenarios: the only thing the test does is press the step button', () => {
  /** Open the Scenarios tab, start one, and press Run for each of its steps in turn. */
  async function runScenario(page: Page, id: string, steps: number, placesOrder = false) {
    await page.getByTestId('dev-tab-scenarios').click();
    await page.getByTestId(`scenario-start-${id}`).click();
    const run = page.getByTestId('scenario-run');
    for (let i = 0; i < steps; i++) {
      const step = page.getByTestId(`scenario-step-${i}`);
      await expect(step).not.toHaveAttribute('data-state', 'todo');
      // A step that only checks the panes ("Continue") finishes by itself; the others need the button.
      if ((await step.getAttribute('data-state')) === 'current' && (await run.textContent()) === 'Run this step') {
        await run.click();
      }
      await expect(step).toHaveAttribute('data-state', 'done');
    }
    if (placesOrder) {
      // Once the order is placed there is nothing left to run: the Scenarios tab is off and Actions is shown.
      await expect(page.getByTestId('dev-tab-scenarios')).toBeDisabled();
      await expect(page.getByTestId('dev-tab-actions')).toHaveAttribute('aria-selected', 'true');
    } else {
      await expect(page.getByTestId('scenario-complete')).toBeVisible();
    }
  }

  test('price goes up, the scenario accepts it and pays, and the button is blocked while a step runs', async ({ page }) => {
    const { desktop, phone } = await startCheckout(page);

    await runScenario(page, 'price-jump', 5, true);

    // The scenario really paid, on the phone, after really accepting on the desktop.
    await expect(phone.getByTestId('confirmation')).toContainText('Order confirmed');
    await expect(desktop.getByTestId('completed-elsewhere')).toContainText('Completed on another device');
    await expect(phone.getByTestId('receipt-total')).toHaveText('$112.00');

    // The Scenarios tab is off now, so the way on is New Checkout in the Actions tab (back to the start screen).
    await page.getByTestId('chaos-reset').click();
    await expect(page.getByTestId('start-screen')).toBeVisible();
    const next = await startCheckout(page);

    // The next scenario runs on the new checkout.
    await runScenario(page, 'payment-retry', 6, true);
    await expect(next.desktop.getByTestId('confirmation')).toContainText('Order confirmed');
  });

  test('the seats sold out: the scenario ends with New Checkout, which resets and gets the seats back', async ({ page }) => {
    await startCheckout(page);

    await runScenario(page, 'sold-out', 2);
    await expect(page.getByTestId('scenario-back-end')).toHaveCount(0);
    await page.getByTestId('scenario-new-checkout').click();

    await expect(page.getByTestId('start-screen')).toBeVisible();
  });

  test('a declined payment shows on both panes, then the scenario retries and it goes through', async ({ page }) => {
    const { desktop, phone } = await startCheckout(page);

    await runScenario(page, 'payment-retry', 6, true);

    await expect(desktop.getByTestId('confirmation')).toContainText('Order confirmed');
    await expect(phone.getByTestId('completed-elsewhere')).toContainText('Completed on another device');
  });

  test('a slow payment settles, and the scenario puts the payment behavior back', async ({ page, request }) => {
    const { desktop, phone } = await startCheckout(page);

    await runScenario(page, 'pending-settles', 6, true);

    await expect(desktop.getByTestId('confirmation')).toContainText('Order confirmed');
    await expect(phone.getByTestId('completed-elsewhere')).toContainText('Completed on another device');
    const status = await (await request.get('/api/dev/status')).json();
    expect(status.paymentBehavior).toBe('succeed');
  });

  test('two panes pay at the same moment: one order, one "completed elsewhere"', async ({ page }) => {
    const { desktop, phone } = await startCheckout(page);

    await runScenario(page, 'double-pay', 2, true);

    const confirmations =
      (await desktop.getByTestId('confirmation').count()) + (await phone.getByTestId('confirmation').count());
    expect(confirmations).toBe(1);
    const elsewhere =
      (await desktop.getByTestId('completed-elsewhere').count()) + (await phone.getByTestId('completed-elsewhere').count());
    expect(elsewhere).toBe(1);
    await expect(desktop.getByTestId('order-id')).toHaveText((await phone.getByTestId('order-id').textContent())!);
  });

  test('doing a step yourself marks it done: the price rise from the Actions tab, Accept and Pay on the panes', async ({ page }) => {
    const { desktop, phone, chaos } = await startCheckout(page);
    await page.getByTestId('dev-tab-scenarios').click();
    await page.getByTestId('scenario-start-price-jump').click();
    const step = (i: number) => page.getByTestId(`scenario-step-${i}`);
    const current = (i: number) => expect(step(i)).toHaveAttribute('aria-current', 'step');

    // Step 1 (raise the price): do it from the Actions tab instead of pressing Run.
    await current(0);
    await page.getByTestId('dev-tab-actions').click();
    await chaos.getByTestId('chaos-price-up').click();
    await page.getByTestId('dev-tab-scenarios').click();
    await expect(page.getByTestId('scenario-note')).toContainText('You did that step yourself');

    // Step 2 only checks the panes, so it finishes by itself once both show the price change.
    await current(2);

    // Step 3 (accept the price): click the button on the pane itself.
    await desktop.getByTestId('accept-price').click();
    await current(3);

    // Step 4 (pay): click Pay on the *other* pane than the one named; the order is the same.
    await desktop.getByTestId('pay').click();
    await expect(desktop.getByTestId('confirmation')).toContainText('Order confirmed');

    // Step 5 checks both panes show the order, and finishes by itself: no Continue press anywhere.
    await expect(step(4)).toHaveAttribute('data-state', 'done');
    await expect(page.getByTestId('dev-tab-scenarios')).toBeDisabled();
    await expect(phone.getByTestId('completed-elsewhere')).toContainText('Completed on another device');
  });

  test('a manual press on a pane does not skip a step the scenario is running itself', async ({ page }) => {
    const { desktop } = await startCheckout(page);
    await page.getByTestId('dev-tab-scenarios').click();
    await page.getByTestId('scenario-start-payment-retry').click();
    const step = (i: number) => page.getByTestId(`scenario-step-${i}`);

    // Run the first two steps with the button: make payments fail, then pay on the desktop.
    await page.getByTestId('scenario-run').click();
    await expect(step(1)).toHaveAttribute('aria-current', 'step');
    await page.getByTestId('scenario-run').click();

    // The scenario's own press must not be counted twice: the check after it finishes by itself and
    // the scenario stops at the next step (make the next payment succeed), not past it.
    await expect(step(3)).toHaveAttribute('aria-current', 'step');
    await expect(step(4)).toHaveAttribute('data-state', 'todo');
    await expect(page.getByTestId('scenario-note')).toHaveCount(0);
    await expect(desktop.getByTestId('payment-failed')).toBeVisible();
  });

  test('the button is disabled and reads "Running…" while a step waits for the panes', async ({ page }) => {
    await startCheckout(page);
    await page.getByTestId('dev-tab-scenarios').click();
    await page.getByTestId('scenario-start-sold-out').click();
    const run = page.getByTestId('scenario-run');

    // Hold the sell-out reply, so the step is demonstrably in progress.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/api/dev/sell-out', async (route) => {
      await held;
      await route.continue();
    });

    await run.click();
    await expect(run).toBeDisabled();
    await expect(run).toHaveText('Running…');
    await expect(page.getByTestId('scenario-back')).toBeDisabled();

    release();
    // The next step only waits for the panes to show "unavailable", so no button press is needed.
    await expect(page.getByTestId('scenario-step-1')).toHaveAttribute('data-state', 'done');
    await expect(page.getByTestId('scenario-complete')).toBeVisible();
  });
});

test('New Checkout goes back to the start screen', async ({ page }) => {
  const { chaos } = await startCheckout(page);

  await chaos.getByTestId('chaos-reset').click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('start-screen')).toBeVisible();
});

test('retry after a failed payment uses a new idempotency key', async ({ page, request }) => {
  const { desktop } = await startCheckout(page);
  const keys: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/complete')) keys.push(req.headers()['idempotency-key']!);
  });
  const sessionId = new URL(page.url()).pathname.split('/').pop()!;

  const fail = await request.post('/api/dev/payment-behavior', { data: { behavior: 'fail' } });
  expect(fail.ok()).toBe(true);
  await desktop.getByTestId('pay').click();
  await expect(desktop.getByTestId('payment-failed')).toContainText('card declined');

  const succeed = await request.post('/api/dev/payment-behavior', { data: { behavior: 'succeed' } });
  expect(succeed.ok()).toBe(true);
  await desktop.getByTestId('try-again').click();
  await expect(desktop.getByTestId('confirmation')).toContainText('Order confirmed');

  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBeTruthy();
  expect(keys[0]).not.toBe(keys[1]);

  const { events } = (await (await request.get('/api/dev/events')).json()) as { events: { name: string; sessionId: string }[] };
  const mine = events.filter((e) => e.sessionId === sessionId);
  expect(mine.filter((e) => e.name === 'payment_failed')).toHaveLength(1);
  expect(mine.filter((e) => e.name === 'completed')).toHaveLength(1);
});

test('two real devices pressing Pay at the same moment: one charge, one order, no error banner', async ({
  browser,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const baseURL = testInfo.project.use.baseURL;

  for (let run = 1; run <= 5; run++) {
    const reset = await request.post('/api/dev/reset');
    expect(reset.status(), `run ${run}: reset`).toBe(204);
    const created = await request.post('/api/sessions', {
      data: { listingId: 'demo-listing' },
      headers: { 'X-Client-Id': `origin-${run}`, 'X-Surface': 'web' },
    });
    expect(created.status(), `run ${run}: create`).toBe(201);
    const sessionId = ((await created.json()) as { id: string }).id;

    const contexts = await Promise.all([browser.newContext({ baseURL }), browser.newContext({ baseURL })]);
    try {
      const pages = await Promise.all(contexts.map((c) => c.newPage()));
      const completeReplies: { status: number; body: { error?: { code: string }; completedElsewhere?: boolean } }[][] = [[], []];
      pages.forEach((p, i) =>
        p.on('response', async (res) => {
          if (res.request().method() !== 'POST' || !res.url().endsWith('/complete')) return;
          const body = await res.json().catch(() => ({}));
          completeReplies[i]!.push({ status: res.status(), body });
        }),
      );

      await Promise.all(pages.map((p) => p.goto(`/resume/${sessionId}`)));
      const pay = pages.map((p) => p.getByTestId('pay'));
      await Promise.all(pay.map((b) => expect(b).toBeEnabled()));
      await Promise.all(pages.map((p) => expect(p.getByTestId('connection')).toContainText('live')));

      // Both buttons are live; press them together. If the other device's sale reaches this page
      // first, its Pay button is already gone and the click gives up: that is the other ordering.
      const clicks = await Promise.allSettled(pay.map((b) => b.click({ timeout: 3000 })));
      expect(clicks.filter((c) => c.status === 'fulfilled').length, `run ${run}: at least one Pay click landed`).toBeGreaterThan(0);

      // Exactly one device paid.
      await expect
        .poll(async () => (await Promise.all(pages.map((p) => p.getByTestId('confirmation').count()))).reduce((a, b) => a + b, 0), {
          message: `run ${run}: exactly one confirmation`,
        })
        .toBe(1);
      const winner = (await pages[0]!.getByTestId('confirmation').count()) === 1 ? 0 : 1;
      const loser = 1 - winner;

      // The other one ends on "Completed on another device" once the stream catches up.
      await expect(pages[loser]!.getByTestId('completed-elsewhere')).toContainText('Completed on another device');
      await expect(pages[winner]!.getByTestId('confirmation')).toContainText('Order confirmed');

      // What the loser was told along the way: the sale already happened, or a payment is in flight.
      for (const reply of completeReplies[loser]!) {
        const ok =
          (reply.status === 200 && reply.body.completedElsewhere === true) ||
          (reply.status === 409 && reply.body.error?.code === 'PAYMENT_IN_PROGRESS');
        expect(ok, `run ${run}: loser reply ${JSON.stringify(reply)}`).toBe(true);
      }

      // One order, shown identically on both devices.
      const orderIds = await Promise.all(pages.map((p) => p.getByTestId('order-id').textContent()));
      expect(orderIds[0]).toBeTruthy();
      expect(orderIds[0]).toBe(orderIds[1]);

      // Neither device ends on an error banner.
      await Promise.all(pages.map((p) => expect(p.getByTestId('error')).toHaveCount(0)));

      // One charge: the server recorded exactly one completed event for the session.
      const { events } = (await (await request.get('/api/dev/events')).json()) as { events: { name: string; sessionId: string }[] };
      expect(
        events.filter((e) => e.sessionId === sessionId && e.name === 'completed'),
        `run ${run}: completed events`,
      ).toHaveLength(1);
    } finally {
      await Promise.all(contexts.map((c) => c.close()));
    }
  }
});

test('API is reachable through the dev proxy', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.ok()).toBe(true);
  expect((await res.json()).status).toBe('ok');
});
