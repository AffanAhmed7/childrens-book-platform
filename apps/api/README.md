# apps/api — Fastify backend

TypeScript + Fastify service that owns sessions, presigned R2 uploads, the BullMQ pipeline
worker, the SSE status stream, and the OpenAPI docs. To be scaffolded on Day 1.

**Responsibilities**
- REST: `POST /api/sessions`, `/upload-url`, `/upload-confirm`, `GET /preview`
- SSE: `GET /api/sessions/:id/status`
- Worker: `pipeline` queue — `validate → remove_bg → skin_tone → portrait → composite`
- Docs: `@fastify/swagger` + `swagger-ui` at `/docs`
- Data: Prisma client against Postgres (Neon)

See [PROJECT_PLAN.md §6–§7](../../PROJECT_PLAN.md) for the pipeline and API contract.
