import { expect, test } from '@playwright/test';

// Needs the server to run with DEV_TOOLS=1 (`pnpm dev` and the Playwright config set it).
test.beforeEach(async ({ request }) => {
  const res = await request.post('/api/dev/reset');
  expect(res.status(), 'POST /api/dev/reset must return 204: is the server running with DEV_TOOLS=1?').toBe(204);
});

test('start on desktop, open on the phone pane, pay on the phone: cross-device conversion is 1 of 1', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('start-checkout').click();
  const phone = page.getByTestId('phone-pane');
  await expect(page.getByTestId('desktop-pane').getByTestId('connection')).toContainText('live');
  await expect(phone.getByTestId('connection')).toContainText('live');
  await page.getByTestId('dev-tab-events').click();
  const log = page.getByTestId('event-log');

  await phone.getByTestId('pay').click();
  await expect(phone.getByTestId('confirmation')).toContainText('Order confirmed');

  // The log polls every 2s, so give it a few polls.
  // The desktop's own first load counts too (crossDevice false); the phone's is the one that is true.
  const resumed = log.locator('[data-event="session_resumed"]', { hasText: 'crossDevice: true' });
  await expect(resumed).toHaveCount(1, { timeout: 10_000 });
  await expect(resumed).toContainText('mobile');
  await expect(log.locator('[data-event="session_resumed"]', { hasText: 'crossDevice: false' })).toHaveCount(1);
  const completed = log.locator('[data-event="completed"]');
  await expect(completed).toContainText('crossDevice: true, paidOnSurface: mobile');
  await expect(log.getByTestId('metric-cross-device')).toContainText('1 of 1 completed');
  await expect(log.getByTestId('metric-cross-device')).toContainText('rate 100%');
  await expect(log.getByTestId('metric-single-device')).toContainText('0 of 0 completed');

  // Newest first: the sale is above the visit, which is above the creation.
  await expect(log.getByTestId('event-row').first()).toHaveAttribute('data-event', 'completed');
  await expect(log.getByTestId('event-row').last()).toHaveAttribute('data-event', 'session_created');
});

test('the event log is not on the phone-only resume page', async ({ page, context }) => {
  await page.goto('/');
  await page.getByTestId('start-checkout').click();
  await page.getByTestId('desktop-pane').getByTestId('continue-on-phone').click();
  const link = await page.getByTestId('phone-link').getByRole('textbox').inputValue();

  const second = await context.newPage();
  await second.goto(link);

  await expect(second.getByTestId('checkout-pane')).toBeVisible();
  await expect(second.getByTestId('event-log')).toHaveCount(0);
});
