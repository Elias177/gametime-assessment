import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

// These run against the Vite dev server, which pre-renders /resume/:id (the production path is not wired).
// The server must run with DEV_TOOLS=1 (`pnpm dev` and the Playwright config set it).
test.beforeEach(async ({ request }) => {
  const res = await request.post('/api/dev/reset');
  expect(res.status(), 'POST /api/dev/reset must return 204: is the server running with DEV_TOOLS=1?').toBe(204);
});

const HTML = { Accept: 'text/html' };

async function createSession(request: APIRequestContext) {
  const res = await request.post('/api/sessions', {
    headers: { 'X-Client-Id': 'e2e-desktop', 'X-Surface': 'web' },
    data: { listingId: 'demo-listing' },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('a fan opening /resume/:id sees the event and price before any script runs', async ({ page, request }) => {
    const id = await createSession(request);

    await page.goto(`/resume/${id}`);

    await expect(page.getByTestId('prerender-event')).toHaveText('The Midnight Orchestra');
    await expect(page.getByTestId('prerender')).toContainText('Harbor Hall, San Francisco');
    await expect(page.getByTestId('prerender')).toContainText('Friday, June 14, 2030 at 7:30 PM'); // venue time
    await expect(page.getByTestId('prerender')).toContainText('Section Orchestra Left, Row F, Seats 12, 13');
    await expect(page.getByTestId('prerender-price')).toHaveText('$100.00');
    await expect(page.getByTestId('prerender-hold')).toContainText(/^Hold expires at \d{1,2}:\d{2} (AM|PM) [A-Z]{2,5}$/);
    // Nothing has confirmed the price, and the page says so.
    await expect(page.getByTestId('prerender')).toContainText('Confirming price…');
    // No app ran: there is no live view and no Pay button.
    await expect(page.getByTestId('origin-label')).toHaveCount(0);
    await expect(page.getByTestId('pay')).toHaveCount(0);
  });
});

test.describe('with JavaScript', () => {
  test('the summary is replaced by the live view and "Confirming price…" goes away', async ({ page, request }) => {
    const id = await createSession(request);

    await page.goto(`/resume/${id}`);

    await expect(page.getByTestId('origin-label')).toHaveText('Opened from link');
    await expect(page.getByTestId('pay')).toBeEnabled();
    await expect(page.getByTestId('pay')).toHaveText('Pay $100.00');
    await expect(page.getByTestId('connection')).toContainText('live');
    await expect(page.getByTestId('prerender')).toHaveCount(0); // the shell is gone
    await expect(page.getByText('Confirming price…')).toHaveCount(0);
    await expect(page.locator('#initial-state')).toHaveCount(0); // consumed and removed
    await expect(page.getByTestId('checkout-pane')).toHaveCount(1);
  });

  test('the real view starts from the pre-rendered state: price labelled, Pay locked, until the live answer', async ({
    page,
    request,
  }) => {
    const id = await createSession(request);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Hold only the app's own fetch of the session (the stream URL has another segment).
    await page.route(`**/api/sessions/${id}`, async (route) => {
      await gate;
      await route.continue();
    });

    await page.goto(`/resume/${id}`);

    // The live view is already up (no loading screen), showing the last-seen price as unconfirmed.
    await expect(page.getByTestId('origin-label')).toBeVisible();
    await expect(page.getByTestId('prerender')).toHaveCount(0);
    await expect(page.getByTestId('confirming-price')).toHaveText('Confirming price…');
    await expect(page.getByTestId('price')).toHaveText('$100.00');
    await expect(page.getByTestId('pay')).toBeDisabled();
    await expect(page.getByText('Loading your checkout…')).toHaveCount(0);

    release();

    await expect(page.getByTestId('confirming-price')).toHaveCount(0);
    await expect(page.getByTestId('pay')).toBeEnabled();
  });

  test('if the session changed since the prefetch, the normal UI takes over', async ({ page, request }) => {
    const id = await createSession(request);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(`**/api/sessions/${id}`, async (route) => {
      await gate;
      await route.continue();
    });
    await page.goto(`/resume/${id}`);
    await expect(page.getByTestId('confirming-price')).toBeVisible();

    // The price rises after the page was pre-rendered, before the live fetch answers.
    expect((await request.post('/api/dev/price', { data: { listingId: 'demo-listing', deltaCents: 1200 } })).ok()).toBe(true);
    release();

    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByTestId('price-banner')).toContainText('from $100.00 to $112.00');
    await expect(page.getByTestId('confirming-price')).toHaveCount(0);
    await expect(page.getByTestId('pay')).toBeDisabled();
  });
});

test('the summary and the live view line up: the content does not move when it is replaced', async ({
  browser,
  baseURL,
  request,
}) => {
  const id = await createSession(request);
  const viewport = { width: 390, height: 780 };
  const boxes = async (javaScriptEnabled: boolean) => {
    const context = await browser.newContext({ baseURL, viewport, javaScriptEnabled });
    const page = await context.newPage();
    await page.goto(`/resume/${id}`);
    const [title, price] = javaScriptEnabled
      ? [page.getByRole('heading', { name: 'The Midnight Orchestra' }), page.getByTestId('price')]
      : [page.getByTestId('prerender-event'), page.getByTestId('prerender-price')];
    if (javaScriptEnabled) await expect(page.getByTestId('confirming-price')).toHaveCount(0);
    const result = { title: (await title.boundingBox())!, price: (await price.boundingBox())! };
    await context.close();
    return result;
  };

  const shell = await boxes(false);
  const live = await boxes(true);

  for (const key of ['title', 'price'] as const) {
    expect(Math.abs(shell[key].x - live[key].x), `${key} x`).toBeLessThanOrEqual(1);
    expect(Math.abs(shell[key].y - live[key].y), `${key} y`).toBeLessThanOrEqual(1);
  }
});

test.describe('the server only pre-renders what is worth showing', () => {
  test('an active session is pre-rendered', async ({ request }) => {
    const id = await createSession(request);

    const res = await request.get(`/resume/${id}`, { headers: HTML });

    const body = await res.text();
    expect(body).toContain('data-testid="prerender"');
    expect(body).toContain('id="initial-state"');
    expect(body).toContain('The Midnight Orchestra');
  });

  test('a missing session gets the normal page', async ({ request }) => {
    const body = await (await request.get('/resume/does-not-exist', { headers: HTML })).text();

    expect(body).not.toContain('prerender');
    expect(body).not.toContain('initial-state');
    expect(body).toContain('<div id="root"></div>');
  });

  test('a finished session gets the normal page', async ({ request }) => {
    const id = await createSession(request);
    expect((await request.post(`/api/dev/expire/${id}`)).ok()).toBe(true);

    const body = await (await request.get(`/resume/${id}`, { headers: HTML })).text();

    expect(body).not.toContain('prerender');
    expect(body).not.toContain('initial-state');
  });

  test('the split demo and the start page are not pre-rendered', async ({ request }) => {
    const id = await createSession(request);

    for (const path of ['/', `/checkout/${id}`]) {
      const body = await (await request.get(path, { headers: HTML })).text();
      expect([path, body.includes('prerender')]).toEqual([path, false]);
    }
  });
});
