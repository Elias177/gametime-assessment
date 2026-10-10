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
