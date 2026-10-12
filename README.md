# Checkout continuity prototype

A fan starts checkout on one device and finishes it on another (web to mobile and vice versa) without
losing their seats, paying a price they didn't agree to, or paying twice.

This is a focused end-to-end slice, not a checkout clone: one listing, an in-memory
backend with stubbed inventory, pricing, and payment, and a React app that shows a
desktop pane and a phone pane side by side so both devices can be watched at once.

On scope: the core came first (the state machine, the session API, and `/complete`
hardening against retries and racing devices). Live sync, the mobile view, the chaos
panel, pre-rendering and analytics were built on top of it, and the whole thing took
longer than the suggested 2–3 hours. `AI_AUDIT.MD` shows the order things were built in.

## Quick start

Requirements: Node 22+, pnpm 9 (`corepack enable` picks up the version pinned in
`package.json`).

```bash
pnpm install
pnpm exec playwright install chromium   # only needed for e2e tests
pnpm dev
```

`pnpm dev` starts the API on http://localhost:3001 and the web app on
http://localhost:5173 (Vite proxies `/api` to the server). Open
http://localhost:5173 and click **Start checkout**.

### Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Server + web together, with dev tools on |
| `pnpm test` | Vitest unit and API tests in every package |
| `pnpm typecheck` | `tsc` in every package |
| `pnpm e2e` | Playwright tests (starts `pnpm dev` itself if nothing is running) |

### Environment

| Variable | Default | Effect |
| --- | --- | --- |
| `DEV_TOOLS` | off (`pnpm dev` sets it to `1`) | Mounts `/api/dev/*` and shows the dev drawer. Without it those routes don't exist. Never set it in a real deployment: the dev routes have no auth. |
| `PAYMENT_BEHAVIOR` | `succeed` | Initial stub payment outcome: `succeed`, `fail` or `pending`. |
| `PORT` | `3001` | API port. |

If `pnpm dev` or `pnpm e2e` fails with `EADDRINUSE` on 3001, a previous server is still
running (look for a stray `tsx watch` process). E2e tests also fail at their reset step
if a server is running without `DEV_TOOLS=1`.

## Demo walkthrough

1. **Start checkout.** The split view opens: desktop pane on the left, phone frame on the
   right. Each pane is a separate client with its own client id, its own hook, and its own
   SSE stream, exactly as two real devices would be. Each is captioned with the device it
   stands for, and when one is updated by the other (or by the server) a ring fades around it
   and its caption says "Synced just now". The pane that acted never shows it. Above the
   desktop pane, a numbered **action log** lists what each pane did and every status it
   moved to, in plain sentences, oldest first, plus the dev tools actions. When a payment
   is pending it asks how it should end (Succeed / Fail), and once the order is placed it
   offers New Checkout.
2. **Continue on phone.** The desktop pane shows a `/resume/:sessionId` link with Copy and
   "Open in new tab" buttons, and a QR code for it (not on `localhost`, which a phone
   can't reach). Opened on a real phone (or a second browser), it renders only the mobile
   view.
3. **Dev drawer** (the left drawer titled Gametime "In time" Demo, always open on screens
   1240px and wider; on narrower ones a sticky top bar with a menu button opens it over a
   scrim, and `Esc` closes it) drives every state change from the server side in its
   Actions tab: expire the hold, raise or drop the price, sell out the listing, choose the
   next payment outcome (shown coloured under the title), settle a pending payment (only
   offered while one is pending), and New Checkout (wipe everything and return to the
   start screen). Both panes update live, with no reload. Once an order is placed only
   New Checkout is left and the Scenarios tab is disabled.
4. **Scenarios** (the drawer's "Scenarios" tab) are guided walkthroughs built from those
   actions: price goes up then pay, a declined payment then a retry, a slow payment that
   settles later, two devices paying at once, seats selling out, the hold running out.
   "Run this step" does the step for real and stays disabled until it is done: a chaos
   action, or a press of Pay or Accept new price on a pane (through the same code as the
   button). A step that only waits until both panes show a status runs no action, so its
   button says "Continue" (it also finishes by itself once both panes show that status). A
   step that can't be done says why and can be run again. You can also do a step yourself
   instead of pressing the button (the same chaos action from the Actions tab, or Pay or
   Accept new price on a pane) and the scenario marks it done and moves on. Each scenario
   starts from a fresh checkout: the "Scenarios" button (at the top of a scenario and at its
   end) goes back to the list on a new checkout, started in place. The page and the drawer
   stay as they are, unlike New Checkout, which wipes everything and returns to the start
   screen. Scenarios that place an order end there (the Scenarios tab is disabled once an
   order exists), so use New Checkout for the next one. "Seats sell out" ends with its own
   New Checkout button, since a new checkout is impossible with no seats left.
5. **Event log** (the drawer's "Events" tab) shows analytics events as they happen and the
   cross-device vs single-device conversion metric.

### Opening the resume link on a real phone

`pnpm dev` only listens on `localhost`. To try the link on a phone on the same Wi-Fi,
run the two apps in separate terminals with the web app exposed on your network:

```bash
pnpm exec cross-env DEV_TOOLS=1 pnpm --filter @checkout/server dev
pnpm --filter @checkout/web dev --host
```

Then open the app on your computer at `http://<your-LAN-IP>:5173` (not `localhost`),
because the "Continue on phone" link is built from the address the desktop page was
opened with. The API stays on your computer; Vite proxies it.

## Architecture

```
apps/web         React + Vite. Desktop and mobile views, useCheckoutSession hook,
                 dev drawer (actions, scenarios, event log), action log,
                 pre-render plugin for /resume.
apps/server      Hono on Node. Checkout service, stub services, SSE, expiry
                 scheduler, analytics, dev routes.
packages/shared  Types, the pure session state machine, formatting, and the
                 pre-render HTML builder. Used by both apps.
```

**The server is the source of truth** for status, hold expiry, the agreed price, the
version, and the order. The client holds only UI state, its client id, and the
idempotency key of the payment attempt in progress. The countdown on screen is display
only; the server decides when a hold has expired.

**Inventory, pricing, and payment are stubs behind interfaces** (`InventoryService`,
`PricingService`, `PaymentService`, plus `SessionStore`, `ListingCatalog`,
`AnalyticsSink`, `Clock` and `Timers`), so each can be swapped for a real implementation
without touching the checkout logic.

**The state machine is a pure function**, `transition(session, event, now)`, in
`packages/shared`. It never throws and never does I/O; illegal transitions return a typed
error. Everything with side effects lives in `CheckoutService`.

### State model

| Status \ Event | PRICE_CHANGED | PRICE_ACKNOWLEDGED | HOLD_EXPIRED | INVENTORY_LOST | PAYMENT_STARTED | PAYMENT_SUCCEEDED | PAYMENT_FAILED |
| --- | --- | --- | --- | --- | --- | --- | --- |
| active | active / price_changed | — | expired | unavailable | payment_pending | — | — |
| price_changed | active / price_changed | active | expired | unavailable | — | — | — |
| payment_pending | — | — | — | — | — | completed | payment_failed |
| completed | — | — | — | — | — | — | — |
| payment_failed | active / price_changed | — | expired | unavailable | payment_pending | — | — |
| expired | — | — | — | — | — | — | — |
| unavailable | — | — | — | — | — | — | — |

(Generated by `transitionTableMarkdown()` in `packages/shared`.) A price at or below the
agreed price is applied automatically (the UI shows it as a "Price drop! You save $X"
banner with the old price crossed out); a price above it moves the session to
`price_changed`, and payment is blocked until the fan accepts the new price.

### How a session stays in sync across devices

- **Re-evaluated on every read.** Each GET, action, or SSE connect re-checks the hold,
  inventory, and price before answering, so a resumed session is never stale.
- **Pushed over SSE.** `GET /api/sessions/:id/events` sends the current session, then
  every saved change, with a heartbeat every 15s. The stream closes once the session is
  finished.
- **Time-driven expiry.** An expiry scheduler refreshes each session at its
  `holdExpiresAt`, so a lapsed hold reaches every open device even if nobody is
  interacting.
- **Fallbacks.** The client refetches when the window regains focus and falls back to
  polling every 5s if SSE fails. Updates older than the version on screen are ignored.

### Price changes, stale inventory, and duplicate payments

- **Price changes.** The session records the price the fan agreed to (`priceSnapshot`)
  separately from the latest price. An increase needs explicit acceptance, and the
  acceptance must carry the version the fan saw, so nobody accepts a price they weren't
  shown. Payment always charges the agreed price.
- **Stale inventory.** A lost hold moves the session to `unavailable` on the next read
  or push. Starting a payment pins the hold, so it can't lapse while the payment is in
  flight; on failure it is unpinned and returns to its normal expiry.
- **Duplicate payments.** `/complete` requires an `Idempotency-Key` header and the
  session `version`, and the two layers cover different cases:
  - *Same intent repeated* (timeout retry, double click): the same key returns the
    original result, even though the retry's version is now stale.
  - *Different intents racing* (phone and laptop, different keys): the version check
    rejects stale clients early, and the store's compare-and-set on save makes sure
    exactly one request can move the session into payment. The other device is told
    `PAYMENT_IN_PROGRESS`, or gets the finished order with `completedElsewhere: true`.
  - The key sent to the payment provider is scoped to the session
    (`<sessionId>:<clientKey>`), so two sessions that happen to reuse a client key can't
    be deduplicated into one charge.
  - The client keeps one key per payment attempt and makes a new one only after a
    definite failure (402), so a retry after an unknown outcome is a replay, never a
    second charge.

### Pre-rendered resume link

A fan tapping the resume link on a slow phone should see their checkout before
JavaScript loads. For `/resume/:sessionId`, a Vite dev-server plugin fetches the session
and listing (500ms budget) and injects a summary (event, seats, last-seen price, hold
time) plus the data as JSON. The app then mounts from that data with no loading state
and no layout shift. The price is labelled "Confirming price…" and Pay stays locked
until the first live response, so a stale price is never presented as final.

This is much cheaper than full SSR. Full SSR would render and hydrate the whole view,
at the cost of a server render path and the risk of hydration mismatches.

## Analytics

Events are tracked on the server at the point where a change is saved, never in the UI,
so they can't be faked or counted twice. A request that loses a race records nothing.
Each event is attributed to the client that caused it, or to `system` for the
scheduler, dev actions, and pre-render reads.

Events: `session_created`, `session_resumed`, `price_change_shown`,
`price_change_accepted`, `price_change_auto_applied`, `hold_expired`, `inventory_lost`,
`completion_conflict`, `payment_failed`, `completed`.

**Key metric:** conversion for cross-device sessions vs single-device sessions
(`conversionByDevice`), plus median minutes from create to complete. If continuity
works, cross-device conversion should be close to single-device conversion; a gap
points at where fans drop off when they switch devices (`hold_expired` and
`price_change_shown` without `price_change_accepted` are the first places to look).

## Testing

- **Unit** (Vitest): every legal and illegal state transition, formatting, the
  pre-render builder, the conversion metric, hooks, and views.
- **API** (Vitest + Supertest): sessions, `/complete` hardening including a concurrent
  race and a deterministic compare-and-set race, payment holds, SSE, the scheduler, dev
  routes and analytics. A deterministic settlement race (`settlement-race.test.ts`) holds
  two settlements of the same pending payment (a GET refresh and a dev settle, or two
  refreshes) at a barrier until both have read `payment_pending`, then checks that exactly
  one save wins, with one `completed` event, one inventory confirm and one order id.
- **E2e** (Playwright, `e2e/checkout.spec.ts`, `analytics.spec.ts`,
  `resume-prerender.spec.ts`): the split demo, resume link, every recovery state driven
  through the chaos panel, pre-rendering with JavaScript off and on, and a cross-device
  purchase showing up in the metric. Two flows cover payment races and retries: two real
  devices (separate browser contexts on `/resume/:id`) press Pay at the same moment,
  five times in a row, and end with one order, one `completed` event, one device on
  "Order confirmed", the other on "Completed on another device", and no error banner;
  and a failed payment followed by Try again sends a new `Idempotency-Key` and ends with
  one `payment_failed` and one `completed` event.

## Tradeoffs and known gaps

- **In-memory and single-process.** Sessions, SSE subscriptions, expiry timers,
  analytics, and its per-session tracking all live in one Node process. They're lost on
  restart and wouldn't be shared across instances. Analytics tracking is only cleared by
  a dev reset.
- **State changes on read, plus the scheduler.** Only hold expiry is time-driven. A
  price change or lost inventory reaches devices on the next read, action, focus
  refetch, poll, or dev refresh, not on its own.
- **Pending payments never time out.** A payment stuck in `pending` keeps the seats
  pinned indefinitely. A real system would time it out and reconcile with the provider.
- **Only the latest idempotency key is remembered.** After a retry with a new key, a
  replay of an earlier failed key is no longer recognized.
- **No authentication.** Anyone with the session link can view the session and its
  order. `X-Client-Id` is whatever the caller sends, so analytics attribution is not
  verified (the state changes it describes are).
- **Pre-rendering is dev-server only.** The production build is a static bundle; the
  shared builder is ready for the server to use, but that path isn't wired up.
- **The pre-render read is a real read.** It re-evaluates the session, so it can save an
  expiry.
- **The split demo inflates the cross-device metric.** The phone pane is a second client
  from the moment it loads, so every demo session counts as cross-device.
- **The payment-reason text is local.** A failure reason is only shown on the device that
  paid; other devices show a generic message.
- **A redundant save when a pending payment settles.** `refresh()` saves again after
  `applyPayment` has already saved. That second compare-and-set always fails and is
  ignored, so it's harmless, but it's wasted work and would be cleaned up.
- **"Find other tickets" resets the whole demo** when dev tools are on, wiping every
  session including the other pane's.
- **`pnpm dev` always turns dev tools on.** Running the server directly
  (`pnpm --filter @checkout/server start`) leaves them off.

## With more time

- Signed, expiring resume tokens bound to the fan's account, instead of a bare session id.
- Universal links / app links so the resume link opens the native app.
- Redis (or similar) for sessions with TTLs, pub/sub for SSE fan-out across instances,
  and a distributed timer for expiry.
- Push price and inventory changes from their sources instead of waiting for a read.
- A timeout and provider reconciliation for pending payments.
- Production pre-rendering, or full SSR, for the resume route.
- A real analytics pipeline behind `AnalyticsSink`.

## How I used AI

This was built with Claude Code, one task at a time, with each step reviewed before the
next. `AI_AUDIT.MD` records every task: what was asked, decisions made along the way,
results, test counts, and known gaps.
