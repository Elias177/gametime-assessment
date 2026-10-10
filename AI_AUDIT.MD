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
