# apps/web — Next.js test UI  (DEFERRED)

> **Deferred (2026-07-15) — this folder is empty and nothing here is built.** The client
> confirmed an **API-only** engagement for this phase. It is retained as the placeholder
> for a future UI phase; the design below is the reference for it.
>
> **Do not confuse this with the homepage that does exist.** A client-facing browser UI
> shipped separately at `apps/api/homepage` (`npm run homepage`, port 5174) — a
> self-contained Fastify page with no Postgres/Redis/BullMQ/S3 dependency, calling the
> same pipeline functions production calls. That is the client-facing surface today;
> see [docs/DEMO_RUNBOOK.md](../../docs/DEMO_RUNBOOK.md). It is *not* this Next.js app and
> does not implement the flow described below.
>
> The API's own demo/QA surface is Swagger UI at `/docs` plus `apps/api/test/e2e-single.mjs`
> and `e2e-multichar.mjs`. (The `test/e2e.http` and `test/e2e.mjs` scripts named in
> PROJECT_PLAN.md §8 were never written.)

Next.js 14 (App Router) + Tailwind single-page test UI.

**Flow:** story form → presigned upload to R2 → live SSE status checklist → preview image +
"Try another photo". No auth, no cart — just the prototype loop.

See [PROJECT_PLAN.md §8](../../PROJECT_PLAN.md) for the page states — but note that
document is a historical record, and the status copy it describes has changed: the
pipeline reports **two** user-facing steps (`validate`, `render`), not five. The live
strings are in `apps/api/src/messages.ts`.
