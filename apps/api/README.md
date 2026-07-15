# apps/api — Fastify backend

TypeScript + Fastify service that owns sessions, presigned R2 uploads, the BullMQ pipeline
worker, the SSE status stream, and the OpenAPI docs.

**Status:** Day 1 done — sessions + presigned upload + confirm. BullMQ pipeline, SSE status,
and the remaining pipeline steps land Day 2–3 (see [PROJECT_PLAN.md](../../PROJECT_PLAN.md)).

## Setup

```bash
cd apps/api
cp .env.example .env      # fill in DATABASE_URL + R2_* (see PROJECT_PLAN.md §9)
npm install
npx prisma migrate dev --name init
npm run dev                # http://localhost:3001, docs at /docs
```

Without `DATABASE_URL`/`R2_*` set, the server still boots (so you can browse `/docs`), but
any route touching the database or storage will fail with a clear error until they're set.

## Endpoints (Day 1)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | liveness check |
| GET | `/docs` | Swagger UI (OpenAPI) |
| POST | `/api/sessions` | create a session (`locale`, `storyId`, `childName`) |
| GET | `/api/sessions/:id` | inspect a session + character (QA convenience, not in original spec) |
| POST | `/api/sessions/:id/upload-url` | get a presigned R2 PUT URL for a given `contentType` |
| POST | `/api/sessions/:id/upload-confirm` | record the uploaded object key, mark session `uploaded` |

`test/e2e.http` walks the full Day 1 flow (VS Code REST Client / JetBrains HTTP Client).

**Coming Day 2–3:** BullMQ `pipeline` queue (`validate → remove_bg → skin_tone → portrait →
composite`), `GET /api/sessions/:id/status` (SSE), `GET /api/sessions/:id/preview`.

See [PROJECT_PLAN.md §6–§7](../../PROJECT_PLAN.md) for the full pipeline and API contract.
