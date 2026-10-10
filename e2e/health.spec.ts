import { expect, test } from '@playwright/test';

test('starts a checkout and shows the pane, live over SSE', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('start-checkout').click();

  await expect(page).toHaveURL(/\/checkout\/[\w-]+$/);
  const pane = page.getByTestId('checkout-pane');
  await expect(pane).toBeVisible();
  await expect(pane).toHaveAttribute('data-status', 'active');
  await expect(pane.getByRole('heading', { name: 'The Midnight Orchestra' })).toBeVisible();
  await expect(page.getByTestId('listing')).toContainText('Harbor Hall');
  await expect(page.getByTestId('price')).toHaveText('$100.00');
  await expect(page.getByTestId('countdown')).toContainText('Seats held for');
  await expect(page.getByTestId('pay')).toBeEnabled();
  // The stream is up through the Vite /api proxy.
  await expect(page.getByTestId('connection')).toContainText('live');
});

test('the resume link opens the same checkout', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('start-checkout').click();
  await page.getByTestId('continue-on-phone').click();
  const link = await page.getByTestId('phone-link').getByRole('textbox').inputValue();
  expect(link).toMatch(/\/resume\/[\w-]+$/);

  await page.goto(link);
  await expect(page.getByTestId('checkout-pane')).toHaveAttribute('data-status', 'active');
});

test('API is reachable through the dev proxy', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.ok()).toBe(true);
  expect((await res.json()).status).toBe('ok');
});
