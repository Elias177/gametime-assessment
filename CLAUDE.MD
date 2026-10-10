# Checkout-continuity prototype

We're building a checkout-continuity prototype. People start checkout on one device and resume on another (web ↔ mobile).

Stack: pnpm workspace. `apps/web` = React + Vite + TypeScript. `apps/server` = Hono on Node,
in-memory storage. `packages/shared` = types and the pure session state machine, used by both.
Tests: Vitest (unit), Supertest (API), Playwright (e2e).

## Principles

- Backend is the source of truth for session status, expiry, price snapshot, version, and order.
  The client only holds UI state and the session id/token.
- Inventory, pricing, and payment are stubbed behind interfaces (InventoryService,
  PricingService, PaymentService) so they're swappable.
- The state machine is pure functions with no I/O, so it's trivially testable.
- Keep scope small: focused end-to-end slice over a broad checkout clone.
- After each task: run typecheck + tests, then summarize what changed and what's next. Save this into a local AI_AUDIT.MD that will contain what I ask you to do and the results.
  Don't start the next task unless asked.

## States

active, price_changed, payment_pending, completed, payment_failed, expired, unavailable.
