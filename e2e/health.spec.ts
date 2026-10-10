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
    await expect(chaos.getByTestId('chaos-behavior')).toHaveText('Next payment: pending');

    await desktop.getByTestId('pay').click();
    await expect(desktop.getByTestId('processing')).toBeVisible();
    await expect(phone.getByTestId('processing')).toBeVisible();

    await chaos.getByTestId('chaos-settle-failed').click();
    await expect(desktop.getByTestId('payment-failed')).toBeVisible();
    await expect(phone.getByTestId('payment-failed')).toBeVisible();
  });
});

test('Reset demo goes back to the start screen', async ({ page }) => {
  const { chaos } = await startCheckout(page);

  await chaos.getByTestId('chaos-reset').click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('start-screen')).toBeVisible();
});

test('API is reachable through the dev proxy', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.ok()).toBe(true);
  expect((await res.json()).status).toBe('ok');
});
