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
