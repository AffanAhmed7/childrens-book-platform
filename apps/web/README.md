# apps/web — Next.js test UI  (DEFERRED)

> **Deferred (2026-07-15):** the client confirmed an **API-only** engagement for this phase,
> so this browser UI is **not built now**. The API's Swagger UI at `/docs` plus the
> `test/e2e.http` / `test/e2e.mjs` scripts are the demo/QA surface. This folder is retained
> as the placeholder for the future UI phase; the design below is the reference for it.

Next.js 14 (App Router) + Tailwind single-page test UI.

**Flow:** story form → presigned upload to R2 → live SSE status checklist → preview image +
"Try another photo". No auth, no cart — just the prototype loop.

See [PROJECT_PLAN.md §8](../../PROJECT_PLAN.md) for the page states and exact status copy.
