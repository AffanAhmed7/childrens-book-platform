# packages/shared — placeholder, EMPTY

> **Nothing was ever built here.** This directory contains only this README. It is kept
> as a slot for the future, not as a dependency — nothing imports it, and the workspace
> builds fine without it.

The original plan was to share framework-agnostic TypeScript between `api` and `web`:
status unions, pipeline step names, SSE copy strings, API DTOs. That never happened,
because `apps/web` was deferred on 2026-07-15 and an API-only build has nothing to share
*with*. Putting the types here anyway would have added a build step and an indirection
for a single consumer.

**Where those things actually live today, all in `apps/api`:**

| Planned to live here | Actually lives in |
|---|---|
| Session/Character status unions, pipeline step names | `src/pipeline/types.ts` |
| User-facing SSE copy strings | `src/messages.ts` |
| API request/response DTOs | `src/routes/sessions.ts` (TypeBox schemas, which also generate the OpenAPI docs) |

**If the browser UI is ever built**, that is the point at which extracting the status
vocabulary and the copy strings into this package earns its keep — a second consumer is
exactly the condition that is missing today.
