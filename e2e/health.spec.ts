import { expect, test } from '@playwright/test';

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
});

test('API is reachable through the dev proxy', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.ok()).toBe(true);
  expect((await res.json()).status).toBe('ok');
});
