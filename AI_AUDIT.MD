# AI Audit

Log of what was asked and the results, one entry per task.

## Task 1: Save project instructions as CLAUDE.MD

**Asked:** Save the checkout-continuity project brief (stack, principles, states) as `CLAUDE.MD`.

**Result:**
- Created `CLAUDE.MD` at the repo root with the brief, organized into intro/stack, Principles, and States sections.
- Created this `AI_AUDIT.MD`.

**Typecheck / tests:** Not run. The pnpm workspace (`apps/web`, `apps/server`, `packages/shared`) doesn't exist yet, so there is nothing to check. The task only added two markdown files.

**Next:** Waiting for the next task. Likely candidate: scaffold the pnpm workspace and the `packages/shared` state machine.
## Task 2: Scaffold the workspace

**Asked:** Scaffold the workspace from CLAUDE.MD. Root scripts `dev` (server + web together), `test`, `typecheck`, `e2e`. Vite proxies `/api` to the server. Add a health endpoint and a web page that calls it. No features yet.

**Result:**
- pnpm workspace (`pnpm-workspace.yaml`): `apps/web`, `apps/server`, `packages/shared`.
- `packages/shared` (`@checkout/shared`): exports the `HealthResponse` type. Consumed as TS source, no build step.
- `apps/server` (`@checkout/server`): Hono on Node via `@hono/node-server`, run with `tsx`. `createApp()` in `src/app.ts` is separate from `src/index.ts`, so tests don't need a listening port. `GET /api/health` returns `{status:'ok', time}`. Port 3001, or `PORT`.
- `apps/web` (`@checkout/web`): React + Vite. Vite proxies `/api` to `http://localhost:3001`. `App.tsx` fetches `/api/health` and shows "Server status: ok" or an error.
- Root scripts: `dev` (concurrently), `test` and `typecheck` (`pnpm -r`), `e2e` (Playwright; its `webServer` starts `pnpm dev`).
- Tests: Supertest API test for the health endpoint, and a Playwright e2e that loads the page and checks it shows the server status via the proxy.
- Replaced the WebStorm placeholder root `package.json` and `tsconfig.json`. Appended build/test output to `.gitignore`.

**Typecheck / tests:** `pnpm typecheck` passed (3 packages). `pnpm test` passed (1 Supertest test; shared and web have no tests yet, so they run with `--passWithNoTests`). `pnpm e2e` passed (1 test, which also exercises `pnpm dev`).

**Environment notes:**
- pnpm wasn't installed, so I ran `npm i -g pnpm@9.15.9` and pinned it in `packageManager`.
- Installed the Playwright Chromium browser.
- Leftover placeholder files `src/index.ts` and `package-lock.json` were not removed (the delete was blocked). They are unused and should be deleted. `package-lock.json` conflicts with pnpm.

**Next:** Waiting for the next task. Likely candidate: the pure session state machine in `packages/shared`.

## Task 3: Fix WebStorm warnings

**Asked:** Fix the WebStorm inspection warnings: unresolved `/src/main.tsx` in `apps/web/index.html`, and vulnerable `vitest@2.1.9` and `vite@5.4.21` (CVE-2026-47429, -84373, -53632, -53571, -39365).

**Result:**
- `apps/web/index.html`: script src changed from `/src/main.tsx` to `./src/main.tsx` so the IDE resolves it. Vite handles both the same way.
- Upgraded across the workspace: `vitest` 2.1.9 → 5.0.3, `vite` 5.4.21 → 8.3.4, `@vitejs/plugin-react` → 6.1.2 (required for Vite 8).

**Typecheck / tests:** `pnpm -r typecheck` passed. `pnpm -r test` passed (1 Supertest test). `pnpm --filter @checkout/web build` passed on Vite 8. Playwright e2e not re-run.

**Next:** Waiting for the next task. Re-run `pnpm e2e` to confirm the dev server works on Vite 8.


## Task 3: CheckoutSession type and pure `transition()`

**Asked:** In `packages/shared`, define `CheckoutSession` and a pure `transition(session, event, now)`. Events: PRICE_CHANGED, PRICE_ACKNOWLEDGED, HOLD_EXPIRED, INVENTORY_LOST, PAYMENT_STARTED, PAYMENT_SUCCEEDED, PAYMENT_FAILED. Illegal transitions return a typed error and never throw. Price decreases auto-apply; increases go to `price_changed` and need acknowledgment. Vitest tests for every legal and illegal transition, plus an exportable markdown transition table.

**Result** (all in `packages/shared/src`):
- `session.ts`: `SessionStatus`, `PriceChange`, `CheckoutSession`, `SessionEvent`. Prices are integer cents, and `holdExpiresAt` is an ISO string.
- `transition.ts`: `transition()` returns `{ok:true, session}` or `{ok:false, error}`. Error codes: `ILLEGAL_TRANSITION`, `HOLD_NOT_EXPIRED`, `HOLD_ELAPSED`, `INVALID_PRICE`. It never mutates its input, bumps `version` on each real change, and unknown events or statuses return `ILLEGAL_TRANSITION` instead of throwing.
- `transition-table.ts`: declarative `TRANSITIONS` table (the single source for tests and docs), `isLegal()`, and `transitionTableMarkdown()`.
- `transition.test.ts`: 73 tests: all 49 status x event pairs, price rules, hold-expiry guards, payment flow, invariants, markdown output.
- Exports added to `index.ts`.

**Rules I chose** (not specified in the brief; change if wrong):
- Price rule: compare the new price to `priceSnapshot` (the price the buyer agreed to). At or below it, it auto-applies and the session returns to `active`. Above it, the session stays `price_changed` or moves there, and needs acknowledgment.
- An unchanged price is a no-op success (no version bump).
- `payment_pending` rejects price changes, hold expiry and inventory loss. The payment outcome decides.
- `PAYMENT_STARTED` from `price_changed` is illegal; the buyer must acknowledge first.
- `payment_failed` accepts `PAYMENT_STARTED` for a retry, `HOLD_EXPIRED` and `INVENTORY_LOST`, but not `PRICE_CHANGED`.
- `HOLD_EXPIRED` is only valid when `now >= holdExpiresAt`. `PAYMENT_STARTED` and `PRICE_ACKNOWLEDGED` are rejected once the hold has lapsed.

**Typecheck / tests:** `pnpm typecheck` passed (3 packages). `pnpm test` passed (shared 73, server 1). `pnpm e2e` passed (1).

**Transition table** (paste into the README):

| Status \ Event | PRICE_CHANGED | PRICE_ACKNOWLEDGED | HOLD_EXPIRED | INVENTORY_LOST | PAYMENT_STARTED | PAYMENT_SUCCEEDED | PAYMENT_FAILED |
| --- | --- | --- | --- | --- | --- | --- | --- |
| active | active / price_changed | — | expired | unavailable | payment_pending | — | — |
| price_changed | active / price_changed | active | expired | unavailable | — | — | — |
| payment_pending | — | — | — | — | — | completed | payment_failed |
| completed | — | — | — | — | — | — | — |
| payment_failed | — | — | expired | unavailable | payment_pending | — | — |
| expired | — | — | — | — | — | — | — |
| unavailable | — | — | — | — | — | — | — |

**Next:** Waiting for the next task. Likely candidate: the server's session store and the `InventoryService`, `PricingService` and `PaymentService` interfaces with stubs.


## Task 4: Stub services, session store and session routes

**Asked:** In `apps/server`, add in-memory InventoryService (holds with TTL), PricingService and PaymentService (configurable succeed/fail/pending), each behind an interface. Add a SessionStore. Routes: `POST /api/sessions`, `GET /api/sessions/:id` (re-evaluates expiry/price/inventory on read and returns computed `changes`), `POST /api/sessions/:id/acknowledge`, `POST /api/sessions/:id/complete`. Inject `now` via a Clock. Supertest coverage for happy path, expiry on resume, price increase on resume, sold-out.

**Result** (`apps/server/src`):
- `clock.ts`: `Clock` interface, `SystemClock`, and `ManualClock` (tests move time with `advance()`).
- `services/inventory.ts`: `InventoryService` (`hold`/`status`/`release`/`confirm`) and an in-memory impl. Holds have a TTL, are keyed by session id, and expired holds stop counting against stock. `revokeStock()` simulates a sell-out elsewhere.
- `services/pricing.ts`: `PricingService.getPrice()` and an in-memory impl with `setPrice()`.
- `services/payment.ts`: `PaymentService` (`charge`, `lookup`) and an in-memory impl. Behaviour is `succeed`, `fail` or `pending`, charges are idempotent per key, and `settle()` resolves a pending charge.
- `store.ts`: `SessionStore` with compare-and-set `save(next, expectedVersion)`, plus an in-memory impl.
- `checkout-service.ts`: orchestration around the pure state machine. `refresh()` re-evaluates a session on every read and write: hold expiry, then inventory, then price (or the payment lookup when pending), and persists the result.
- `deps.ts`: `AppDeps` and `createInMemoryDeps()`. `app.ts`: routes. `index.ts`: demo data (`demo-listing`, 5 units, $100.00) and a `PAYMENT_BEHAVIOR` env var.

**API:**
- `POST /api/sessions {listingId}`: 201 with the session, 409 `SOLD_OUT`, 404 `LISTING_NOT_FOUND`.
- `GET /api/sessions/:id`: 200 with the re-evaluated session. `changes[]` is the persisted price audit trail, appended to when a re-evaluation finds a price change.
- `POST /api/sessions/:id/acknowledge {version}`: 200, or 409 `VERSION_CONFLICT` if the session moved on since the buyer saw it.
- `POST /api/sessions/:id/complete {idempotencyKey}` (or an `Idempotency-Key` header): 200 completed, 202 payment pending, 402 payment failed, 409 illegal transition. Replaying the same key returns the earlier result without charging again.
- Errors look like `{error:{code,message}, session?}`.

**Decisions to review:**
- `acknowledge` requires the session `version`. Without it, a price that moved between the buyer's last view and their click would be accepted silently.
- **Changed `packages/shared`:** `payment_failed` now accepts `PRICE_CHANGED` (goes to `active` or `price_changed`). Otherwise a retry after a failed payment would charge a stale price. This is a change to the Task 3 table; the updated row is below, with a test added.
- `changes[]` is the persisted price trail, not a per-read diff. Expiry and sold-out show up as `status` (`expired`, `unavailable`).
- The client holds only the session id (a random UUID); there is no separate token yet.

**Known gaps:**
- The hold is not extended when payment starts. A slow `pending` payment can outlive the hold, and the unit could be re-held by someone else before `confirm()`.
- The store is in memory, so state is lost on restart.

**Typecheck / tests:** `pnpm typecheck` passed. `pnpm test` passed (shared 74, server 18: 17 new session tests and the health test). `pnpm e2e` passed (1).

**Updated transition table row** (replaces the `payment_failed` row from Task 3):

| Status \ Event | PRICE_CHANGED | PRICE_ACKNOWLEDGED | HOLD_EXPIRED | INVENTORY_LOST | PAYMENT_STARTED | PAYMENT_SUCCEEDED | PAYMENT_FAILED |
| --- | --- | --- | --- | --- | --- | --- | --- |
| payment_failed | active / price_changed | — | expired | unavailable | payment_pending | — | — |

**Next:** Waiting for the next task. Likely candidate: the web UI for starting, resuming and completing a session.


## Task 5: Harden `POST /api/sessions/:id/complete`

**Asked:** Require an `Idempotency-Key` header and the client's `version`. Same key returns the same order. Stale version returns 409 with the fresh session. Already-completed session returns 200 with the existing order and `completedElsewhere: true`. Supertest test firing two completes concurrently with different keys, asserting exactly one order. Explain in a comment why both layers are needed.

**Result:**
- `apps/server/src/checkout-service.ts`: `complete(id, key, version)` now checks, in order:
  1. 400 if the key or `version` is missing or invalid.
  2. Replay of the stored key: 200 with the same order (or 202 if still pending).
  3. Completed under another key: 200 with the existing session plus `completedElsewhere: true`.
  4. `version` differs from the freshly re-evaluated session: 409 `VERSION_CONFLICT` with the fresh session. No charge.
  5. Otherwise `PAYMENT_STARTED`, compare-and-set save, charge, outcome.
  6. If the compare-and-set is lost, re-run steps 2-3 on the latest session (a double click with the same key still gets the winner's result), else 409 `VERSION_CONFLICT`.
  The comment above `complete()` explains why both layers are needed.
- `apps/server/src/app.ts`: the key now comes only from the `Idempotency-Key` header; the body `idempotencyKey` field is gone (breaking vs Task 4; no client uses it yet).
- Tests: new `test/complete.test.ts` (11 tests) and shared `test/helpers.ts`; `sessions.test.ts` updated to the new contract.

**Why both layers (summary of the code comment):** the key means "same request again", for retries and double clicks, and version alone can't serve it because a retry after success carries a stale version. The version means "request made from an out-of-date view", for example two devices with different keys, and the key can't catch it. The explicit version check also isn't enough: two requests can both read version N before either saves, so the store's compare-and-set on `save` is the real guard.

**Test findings:**
- The HTTP concurrency test (two Supertest requests, different keys, same version) passes and asserts exactly one charge, one `orderId`, one consumed unit, and a loser that got either 409 or `completedElsewhere`. In practice the version check catches the loser first, so it would still pass without the store's compare-and-set. I confirmed this by temporarily disabling the version check in `store.save()` (reverted afterwards).
- I added a deterministic test that calls `CheckoutService.complete` twice with `Promise.all` and counts failed `save()` calls. It fails when the compare-and-set is disabled and passes with it (exactly one failed save and one charge).
- The server suite passed on 5 repeated runs.

**Typecheck / tests:** `pnpm typecheck` passed. `pnpm test` passed (shared 74, server 28). `pnpm e2e` passed (1).

**Caveats:**
- There is still no separate order store, so "exactly one order" is asserted via one charge, one `orderId` and one consumed unit.
- A replay is matched against the session's most recent key only. If a buyer retried with a new key after a failed payment, the earlier failed key is no longer recognized as a replay.

**Next:** Waiting for the next task. Likely candidate: the web UI for starting, resuming and completing a session.


## Task 6: Reject different-key attempts during payment

**Asked:** Reject different-key attempts during payment with 409 `PAYMENT_IN_PROGRESS`.

**Result:**
- `apps/server/src/checkout-service.ts`: `existingOutcome()` now returns 409 `PAYMENT_IN_PROGRESS` (with the current session) when the session is `payment_pending` under a different key. It runs before the version check, so the error is the same whether the caller's version is current or stale. Previously a current version gave `ILLEGAL_TRANSITION` and a stale one gave `VERSION_CONFLICT`.
- The same-key replay still gets 202, and 200 once the payment settles.
- A request that loses the compare-and-set race to an in-flight payment now also gets `PAYMENT_IN_PROGRESS` instead of `VERSION_CONFLICT`. I updated the two tests that expected the old code.
- New test: a different key during a pending payment gets 409 `PAYMENT_IN_PROGRESS` with a current and with a stale version, with no second charge, and the original key still completes after the payment settles.

**Typecheck / tests:** `pnpm typecheck` passed. `pnpm test` passed (shared 74, server 29). `pnpm e2e` passed (1).

**Next:** Waiting for the next task.


## Task 7: Same-key replay after a failed payment returns the original failure

**Asked:** Same-key replay after a failed payment returns the original failure.

**Result:**
- `apps/server/src/checkout-service.ts`: `existingOutcome()` is now async. For a `payment_failed` session whose stored key matches the request, it looks up the recorded outcome and returns the same 402 `PAYMENT_FAILED` (original reason, current session). This runs before the version check, so a stale version doesn't matter. The session is not changed and nothing is charged. Before, a replay with a current version re-ran `PAYMENT_STARTED` and bumped the version twice, and a replay with a stale version got `VERSION_CONFLICT`.
- A new key is still a new attempt.
- New test: after a failure, replaying the same key with a stale and with a current version returns a body equal to the original 402, with no new charge and no version change, even after the provider is switched to succeed. A new key then succeeds with a second charge.

**Typecheck / tests:** `pnpm typecheck` passed. `pnpm test` passed (shared 74, server 30). `pnpm e2e` passed (1).

**Caveat:** replay matching still uses only the session's latest key, so after a retry with a new key the earlier failed key is no longer recognized.

**Next:** Waiting for the next task.


## Task 8: Pass the idempotency key to `PaymentService.charge` for provider-level dedupe

**Asked:** Pass idempotency key to `PaymentService.charge` for provider-level dedupe.

**Finding:** `charge()` already received the key, but it was the client's raw key. Client keys are only unique per session, so two sessions sending the same key (for example `pay-1`) shared one provider-level key. The provider treated the second session's charge as a replay of the first. I reproduced this: the second session got a completed order and an order id but was never charged.

**Result:**
- `apps/server/src/services/payment.ts`: new `providerKey(sessionId, clientKey)` (`"<sessionId>:<clientKey>"`), and `ChargeRequest.idempotencyKey` is documented as the provider-level dedupe key.
- `apps/server/src/checkout-service.ts`: the key sent to `charge()` and the keys used for `lookup()` (failed-payment replay and pending-payment settlement) are all built with `providerKey`. The session still stores and compares the client's raw key, so the API is unchanged.
- Tests: two sessions reusing a client key are each charged once with distinct provider keys and distinct orders (this test failed before the fix); a retry of the same request sends the same provider key. Existing tests that read or settle provider keys now use `providerKey()`.

**Typecheck / tests:** `pnpm typecheck` passed. `pnpm test` passed (shared 74, server 32). `pnpm e2e` passed (1).

**Next:** Waiting for the next task.


## Task 9: Keep the inventory hold in place while payment is pending

**Asked:** A session in `payment_pending` keeps going after its hold lapses, but `available()` stops counting that hold, so another session can take the same unit and both can complete. Add `pin(ownerId)` to `InventoryService`, call it on `PAYMENT_STARTED`, make `available()`/`status()` treat a pinned hold as live until `confirm()` or `release()`, and release the hold on payment failure. Regression test with stock 1: A goes pending, time passes the TTL, B's create returns 409 `SOLD_OUT`, A settles to completed.

**Decision (asked, user chose):** "Release on failure" conflicts with retry from `payment_failed`: a released hold makes the next read mark the session `unavailable`. Chosen: on failure, **unpin** instead of releasing. The hold returns to its normal TTL, so the buyer can retry until it lapses. If the TTL has already passed, the unit is free immediately and the session expires on its next read. `release()` is still used on expiry and inventory loss.

**Result:**
- `apps/server/src/services/inventory.ts`: `pin(ownerId)` and `unpin(ownerId)` on the interface and the in-memory impl. A pinned hold counts in `available()` and reports `held` from `status()` regardless of TTL, until `confirm`, `release` or `unpin`. A hold that was revoked (`lost`) can't be pinned back to life.
- `apps/server/src/checkout-service.ts`: `complete()` pins right after the `PAYMENT_STARTED` save succeeds. `applyPayment()` unpins on failure (and `confirm()` on success, as before). This covers both the direct charge result and a pending payment settled on a later read.
- `apps/server/test/payment-hold.test.ts` (new, 8 tests):
  - the regression from the request (stock 1, A pending, TTL passes twice over, B gets 409 `SOLD_OUT`, A settles to completed, the unit stays sold);
  - failure within the TTL: the unit stays held and A can retry;
  - failure after the TTL: the unit frees up, B can create a session, and A's next read is `expired`;
  - unit tests for pin, confirm, release, unpin, a revoked hold, and an unknown owner.
- Mutation check: with the `pin()` call removed, the regression test fails (restored afterwards).

**Typecheck / tests:** `pnpm typecheck` passed. `pnpm test` passed (shared 74, server 40). `pnpm e2e` passed (1).

**Caveat:** a payment that stays `pending` forever now holds the unit forever. There is no timeout on pending payments yet.

**Next:** Waiting for the next task.


## Task 10: Change notification, SSE, listing catalog, and the `useCheckoutSession` hook

**Asked:** Server-side change notification and SSE; a small listing catalog with `GET /api/listings/:id`; a web hook that loads, subscribes to SSE, refetches on focus, polls if SSE fails, and keeps one idempotency key per payment attempt. Tests for store emission, scheduler plus SSE, and key rotation.

**Result, server** (`apps/server/src`):
- `store.ts`: `SessionStore.subscribe(id, fn)` returns an unsubscribe. The in-memory store emits a copy of the session after every successful `create` and `save` (a lost compare-and-set emits nothing). A throwing listener can't fail the write.
- `checkout-service.ts`: public `refreshById(id)`; an `onCreated` hook.
- `scheduler.ts`: `ExpiryScheduler` calls `refreshById` at each session's `holdExpiresAt`. It re-arms on every store change, does not schedule while `payment_pending` (the hold is pinned; settlement re-arms), re-arms itself if a timer fires early, and unsubscribes and cancels once the session is finished.
- `timers.ts`: `Timers` interface plus `SystemTimers`. `ManualClock` now implements `Timers`, so `clock.advance()` fires due timers in tests.
- `app.ts`: `GET /api/sessions/:id/events` uses `streamSSE`: the re-evaluated session first, then every change as `event: session` (id = version, older versions skipped), a heartbeat comment every `heartbeatMs` (default 15s), and cleanup on disconnect. The stream closes once the session is finished. Unknown session gives 404.
- `GET /api/listings/:id`; `services/listings.ts` (`ListingCatalog`). `demo-listing` is seeded in `index.ts` (The Midnight Orchestra, Harbor Hall, Orchestra Left, row F, seats 12 and 13). `Listing` and `isTerminalStatus` live in `packages/shared`.

**Result, web** (`apps/web/src`):
- `api.ts`: typed fetch wrappers that resolve with the HTTP outcome and reject only on network failure.
- `useCheckoutSession(id)` returns `{session, listing, loading, error, connection, acknowledge, complete}`. It does the first fetch, then subscribes to SSE, falls back to polling (`pollMs`, default 5s) if the stream fails, refetches on window focus, ignores sessions older than the one shown, and stops streaming once the session is finished.
- Idempotency key: one per payment attempt, kept across network errors, 409s (including `PAYMENT_IN_PROGRESS`) and 202s. A 409 only updates the version (always taken from the freshest session). A new key is made only after a 402 `PAYMENT_FAILED`.
- New devDeps: `jsdom`, `@testing-library/react`, `@testing-library/dom`.

**Tests added:** server 16 (`realtime.test.ts`): store emission (create, save, lost CAS, unsubscribe, throwing listener); the scheduler expiring a session with no request, cancelling when finished, and re-arming after a pending payment fails; SSE initial state and headers, a streamed change, scheduler-driven expiry arriving at a subscriber, heartbeat, disconnect cleanup, final-state-then-close, 404; listings 200 and 404. Web 12 (`useCheckoutSession.test.tsx`): loading, SSE updates and stale-update rejection, polling fallback, focus refetch, 404, five key-reuse cases, key rotation after 402 (twice), acknowledge. Mutation checks: with the scheduler's `onCreated` hook disabled, 3 scheduler/SSE tests fail; with the 402 key reset removed, 2 hook tests fail.

**Typecheck / tests:** `pnpm typecheck` passed. `pnpm test` passed (shared 74, server 56, web 12). `pnpm e2e` passed (1). Manual check: with `pnpm dev` running, `curl -N localhost:5173/api/sessions/<id>/events` received the initial event through the Vite proxy, and `/api/listings/demo-listing` returned the seeded listing.

**Known gaps:**
- Only the hold lapsing is time-driven. A price change or lost inventory still shows up only when something calls `refresh()` (a GET, an action, a focus refetch, polling). An open SSE stream does not trigger a refresh by itself.
- The scheduler and subscriptions are in-process, so they don't span multiple server instances.
- The web app has no UI using the hook yet.

**Next:** Waiting for the next task.


## Task 11: Desktop checkout pane

**Asked:** Two hook changes (`paidHere`; clear an action error when a newer session version arrives), then the desktop checkout pane in `apps/web` (listing summary, price, hold countdown, Pay button, per-state UI, connection indicator, "Start checkout" entry screen, "Continue on phone" link with copy button), and a smoke e2e that starts checkout and sees the pane.

**Hook changes** (`apps/web/src/useCheckoutSession.ts`):
- `paidHere` is true only when the session is `completed` and its stored `idempotencyKey` equals this client's own attempt key. A session completed under another key (a `completedElsewhere` response, an SSE event, or a refetch) gives false. The key is kept in memory, so after a page reload a past payment from this device is reported as another device.
- A strictly newer version clears the shown error. The same or an older version does not. Because an action's own failure applies the session first and sets the error after, a fresh 409 or 402 keeps its message.
- Fix found while checking in a real browser: the server closes the SSE stream after a final status, and the hook was treating that close as a failure and switching the indicator to "polling". It no longer does for finished sessions.

**UI** (`apps/web/src`): `CheckoutView.tsx` (presentational), `CheckoutPane.tsx` (hook wiring, "Start again"), `StartScreen.tsx`, `App.tsx` (tiny router: `/` entry, `/checkout/:id` pane, `/resume/:id` renders the same pane for now), `navigate.ts`, `format.ts`, `useCountdown.ts` (display only), `styles.css`.
- Summary: event, venue, date, section/row/seats. Price: `priceSnapshot`, and old price struck through with `currentPrice` while `price_changed`. Hold countdown shown while `active`, `price_changed` and `payment_failed` (hidden while a payment is pending, since the hold is pinned).
- States: `active` (Pay enabled); `price_changed` (banner with old and new price, "Accept new price", Pay disabled); `payment_pending` (spinner, Pay locked; a `PAYMENT_IN_PROGRESS` reply reads "A payment is already in progress on another device"); `payment_failed` (reason, "Try again"); `expired` ("Your hold ran out", "Start again" creates a new session for the same listing); `unavailable` (dead end, "Find other tickets"); `completed` (order confirmation with order id, or "Completed on another device").
- Connection indicator: live / polling / connecting. "Continue on phone" reveals a `/resume/:sessionId` link with a Copy button.
- Added an optional `timeZone` to `Listing` (seeded as `America/Los_Angeles`) so the event date shows in the venue's time rather than the viewer's. Without it, the browser showed 10:30 PM for a 7:30 PM event.

**Tests:** hook, 10 new (`paidHere` for own key, `completedElsewhere`, SSE, refetch, re-delivery; error clearing on newer version, kept on same or older, cleared by a refetch; stream close after a final status). View, 15 (`CheckoutView.test.tsx`), one per state plus the error wording, busy state, connection label and phone link. e2e, 3 (`e2e/health.spec.ts`): start checkout and see the pane with price, countdown, enabled Pay and a "live" indicator; the resume link opens the same checkout; `/api/health` through the proxy.
- Real-browser check (scratch Playwright script, screenshots read): desktop pays, the confirmation shows, and a second browser on the resume link receives "Completed on another device" over SSE.

**Typecheck / tests:** `pnpm typecheck` passed. `pnpm test` passed (shared 74, server 56, web 39). `pnpm e2e` passed (3).

**Known gaps / notes:**
- `/resume/:id` currently renders the same pane; a phone-specific layout is not built.
- Not exercised in a browser: the price-changed, payment-failed, expired and unavailable states (covered by the view tests only), since the demo server has no way to trigger them.
- Each "Start checkout" holds one of the 5 demo units for 10 minutes, so repeated manual runs will hit sold out until holds lapse or the server restarts.
- The countdown uses the client clock, so a skewed device clock shows a wrong time (display only).

**Next:** Waiting for the next task.


## Task 12: Split-screen demo, mobile view, and client origin

**Asked:** Add `/resume/:sessionId` and a split-screen demo (desktop pane left, phone-frame pane right), each pane a separate client with its own `clientId` and hook instance; opening `/resume/:id` directly renders only the mobile view. Server: add `createdAt`, `originClientId`, `originSurface` to `CheckoutSession` at create time; send `X-Client-Id` / `X-Surface` on every API call (SSE: query params); read them in `app.ts` and pass them to the service for analytics later. Mobile UI: same states, recoveries in a bottom sheet, header "Opened from link" / "Started on this device", sticky Pay button.

**Shared / server:**
- `CheckoutSession` gains `createdAt` (ISO, from the injected clock), `originClientId` and `originSurface`. New `Surface` (`web | mobile`), `SURFACES`, `isSurface`.
- `app.ts` reads `X-Client-Id` / `X-Surface` (SSE: `?clientId=&surface=`) and passes a `ClientContext` to every service method. `create` requires both and returns 400 `INVALID_REQUEST` if the client id is missing or the surface is not `web|mobile`, because the origin is stored on the session. Other calls tolerate a missing or unknown value (the context is simply empty), so a bad analytics header cannot break checkout.
- `CheckoutService` calls an optional `onRequest({action, sessionId, client})` hook on every request (`create`, `get`, `stream`, `acknowledge`, `complete`). Nothing consumes it yet; it exists so analytics can attach later, and so tests can see what the service received. `createApp(deps, {onRequest})` passes it through.
- The origin is set once at create and never changed by later requests from other clients.

**Web:**
- `api.ts`: every call takes a `ClientInfo` and sends the two headers; `eventsUrl()` puts them in the SSE query. `useCheckoutSession(id, {client, ...})` now requires `client`.
- `clientId.ts`: `newClientId()`, and `tabClientId()` (sessionStorage, so it survives reloads and matches between the start screen and the pane; falls back to memory if storage is blocked).
- Routes: `/checkout/:id` is the split demo (`SplitDemo`): the desktop pane uses the tab's id (surface `web`), the phone frame gets a fresh id made once with `useState` (surface `mobile`); each runs its own `useCheckoutSession`. `/resume/:id` renders only the mobile view, full screen, using the tab's id (surface `mobile`).
- `CheckoutPane` picks the layout from `client.surface`. `MobileCheckoutView`: header "Opened from link" or "Started on this device" (`session.originClientId === client.clientId`), the same summary/price/countdown, inline processing and completed states, a sticky Pay bar, and a bottom sheet (`role="dialog"`) for the four recovery states (`price_changed`, `payment_failed`, `expired`, `unavailable`). The sheet has no dismiss because it is the only way forward. Shared pieces (`PriceBlock`, `CompletedPanel`, `ProcessingPanel`, `ListingSummary`, `alertFor`) were extracted from `CheckoutView` and reused. "Start again" on `/resume` stays on `/resume`.

**Tests added:** server 7 (`origin.test.ts`): origin recorded at create; unchanged when another client reads/completes; 400s for a missing client id, a missing or unknown surface; a refused create takes no hold; headers reach the service on every call; a bad surface on a read does not fail it; SSE query params reach the service. Web 23: hook 3 (headers on every call, SSE URL, same id across re-renders; the existing SSE URL test updated), `MobileCheckoutView.test.tsx` 13, `App.test.tsx` 7 (split shows both layouts, distinct client ids and surfaces on every request including SSE, "Opened from link" on the phone even in the starting tab, `/resume` mobile-only, "Started on this device" when the tab's id is the origin). e2e now 5: split demo is live, per-pane client ids, paying on the desktop shows "Completed on another device" in the phone frame, the resume link opens only the mobile view as a second page, health. Existing tests that build sessions were updated for the new fields. Mutation check: giving both panes the same client id fails 2 App tests.

**Typecheck / tests:** `pnpm typecheck` passed. `pnpm test` passed (shared 74, server 63, web 62). `pnpm e2e` passed (5).
- Real-browser check (scratch Playwright script, screenshots read): split layout, the 390px `/resume` page with its sticky Pay bar, and the completed-elsewhere states. With `PAYMENT_BEHAVIOR=fail`, a failed payment from the phone pane shows the bottom sheet over a dimmed page while the desktop pane shows its inline failure panel.

**Known gaps / notes:**
- The `price_changed`, `expired` and `unavailable` sheets are covered by unit tests only; the demo has no way to trigger them. `payment_failed` was seen in a browser.
- A `payment_failed` reason is only known to the client that paid (it comes from that client's 402), so other panes show the generic "Your payment didn't go through."
- Clients are not authenticated: `X-Client-Id` is whatever the caller says, so it is for analytics only, never for access control.
- A phone started on `/` navigates to `/checkout/:id`, which shows the split demo even on a small screen; only `/resume/:id` is phone-only.
- Phone-frame size is fixed (390x780); the frame scrolls its own content.

**Next:** Waiting for the next task.


## Task 13: Dev-only controls (chaos panel)

**Asked:** Dev-only controls behind `DEV_TOOLS=1` (set in the root dev script and the Playwright webServer command, never on by default, dev routes never mounted without it). Server: `OffsetClock`, `SessionStore.list()` plus a helper that refreshes live sessions, and a `/api/dev` router (expire, price, sell-out, payment-behavior, settle, reset, status) with Supertest coverage including SSE and "404 when off". Web: a collapsible Chaos panel under the split demo (not `/resume`), shown only when the server reports dev tools; view tests; e2e for the recovery states that Task 11/12 flagged as unit-tested only; `/api/dev/reset` at the start of every e2e test.

**Server:**
- `OffsetClock` (`clock.ts`): wraps a clock (system by default), adds `advance(ms)`, `reset()`, `offsetMs`. `index.ts` uses it as the clock for every service only when `DEV_TOOLS === '1'`.
- `SessionStore.list()` (copies) and `InMemorySessionStore.clear()`. `CheckoutService.refreshLive(listingId?)` refreshes every non-terminal session (optionally one listing) through `refreshById`, so changes are saved and pushed to SSE. The scheduler's real timers are never relied on after a clock jump.
- `ExpiryScheduler.clear()`; `reset()` on the in-memory inventory, pricing and payment services (each restores the seed it was built with; payment also clears outcomes, recorded charges and restores the initial behavior); `InMemoryPaymentService.getBehavior()`.
- `dev.ts`, mounted by `createApp(deps, {devTools: {deps, clock}})` only when that option is passed, so without it `/api/dev/*` is a plain 404. No client headers needed. Endpoints:
  - `GET /status` -> `{enabled, paymentBehavior, clockOffsetMs}`.
  - `POST /expire/:sessionId`: advance the clock to 1ms past that session's `holdExpiresAt` (no advance if already past), then refresh all live sessions. Note this is global: it also lapses any other hold that ends sooner.
  - `POST /price {listingId, deltaCents}`: integer delta, price floored at 0, then refresh live sessions on that listing.
  - `POST /sell-out {listingId}`: `revokeStock`, then refresh live sessions on that listing.
  - `POST /payment-behavior {behavior}`; `POST /settle/:sessionId {outcome}` (`payment.settle` on `providerKey(id, idempotencyKey)`, then `refreshById`; 409 `NOT_PAYMENT_PENDING` otherwise, with the session attached).
  - `POST /reset` -> 204: scheduler cleared first, then store, inventory, pricing, payment and the clock offset.
  - Errors use the normal shape: 400 `INVALID_REQUEST`, 404 `SESSION_NOT_FOUND` / `LISTING_NOT_FOUND`. Body is validated before the session is looked up.

**Web:**
- `ChaosPanel.tsx`: `ChaosPanelView` (presentational) and `ChaosPanel` (container). Buttons: Expire hold, Price +$12, Price -$5, Sell out, Next payment succeed/fail/pending (active one marked with `aria-pressed` and shown as "Next payment: X"), Settle pending succeed/fail, Reset demo. The result or error of each action shows for 4s. The panel collapses (the active behavior and the result stay visible). Reset navigates to `/`.
- The container asks `GET /api/dev/status` and renders nothing unless it answers with `enabled`; only then does it fetch the session (to learn its listing for price and sell-out), so a normal server sees one 404 and nothing else. Mounted under the split demo only, aimed at the current session. It changes the server and does nothing else to the panes: both update through their own SSE streams, with no reload.
- `api.ts`: `getDevStatus`, `devAction`; client headers are now optional.

**Tests added:** server 29 (`dev.test.ts`): `OffsetClock`, `store.list()`; every `/api/dev` route 404s when off while `/api/health` still works; each endpoint's happy path, validation (400), unknown id (404) and 409; expire refreshes other live sessions and does not move the clock if already lapsed; price clamp at 0 and other listings untouched; sell-out blocks new checkouts; behavior steers `/complete`; reset restores sessions, stock, price, behavior, clock, recorded charges and scheduler timers; an open SSE stream receives the change for expire, price, sell-out and settle. Web 28: `ChaosPanel.test.tsx` (view: every button's action, labels, active behavior, result/alert, busy disables via the fieldset, collapse; container: hidden when off, no extra requests when off, endpoints and bodies, error and offline results, result clears after 4s, reset navigates, failed reset does not) and 3 in `App.test.tsx` (panel under the split demo when on, absent when off, absent and never requested on `/resume`). e2e now 11: price_changed on both panes then accept and pay, a price drop applied silently, expired, unavailable, a pending payment settled as failed (all on desktop and the phone sheet), Reset demo returns to the start screen, no chaos panel on `/resume`, plus the earlier ones. `/api/dev/reset` runs before each e2e test and fails loudly if it is not a 204.
- Mutation check: with `refreshLive` doing nothing, 8 server tests fail (including the 4 SSE ones). The first version passed most of them because they read through `GET`, which re-evaluates on its own; the helper now reads the store directly.
- Real check: started `src/index.ts` without `DEV_TOOLS`: `/api/dev/status` and `/api/dev/reset` returned 404, `/api/health` 200.

**Typecheck / tests:** `pnpm typecheck` passed. `pnpm test` passed (shared 74, server 92, web 90). `pnpm e2e` passed (11), both reusing a running server and cold with Playwright starting it.

**Notes / known gaps:**
- New dev dependency `cross-env` (root): `DEV_TOOLS=1 cmd` does not work in Windows shells. Root `dev` is now `cross-env DEV_TOOLS=1 concurrently ...`, so **`pnpm dev` always has dev tools on**; the server itself still defaults to off (`node`/`tsx src/index.ts` alone). Playwright runs `pnpm exec cross-env DEV_TOOLS=1 pnpm dev`, and `workers: 1` was added because every test resets the one shared server.
- `reuseExistingServer` is still true. A server left running without `DEV_TOOLS` makes every e2e test fail at the reset check. I hit this once from an orphaned server left on port 3001 (killed it; a cold run then passed and left nothing running).
- Dev tools have no auth: they exist only with `DEV_TOOLS=1` and must not be set in a real deployment.
- Reset removes sessions without telling open streams or other tabs; a stale tab gets a 404 on its next fetch. The panel's tab goes to the start screen.
- Open sessions in a pending payment ignore Expire hold (the hold is pinned), by design.

**Next:** Waiting for the next task.
