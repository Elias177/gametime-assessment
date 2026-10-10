import { expect, test } from '@playwright/test';

test('web page reaches the server through the /api proxy', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('health')).toHaveText('Server status: ok');
});
