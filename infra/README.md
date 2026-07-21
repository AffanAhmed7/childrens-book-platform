# infra — deployment notes

Lightweight deployment reference (no heavy IaC for a 3-day prototype).

> **⚠️ NOTHING IS DEPLOYED.** This is a target-state reference, not a description of
> running infrastructure. The prototype is local-only — no hosted API, no shareable
> `/docs` URL. It is the one outstanding deliverable in
> [PROJECT_PLAN.md §14](../PROJECT_PLAN.md).
>
> The Web/Vercel row is for the **deferred** `apps/web` UI, which is unbuilt. The homepage
> that exists today (`npm run homepage`) runs locally and needs none of the components
> in this table except a Replicate token.

| Component | Host | Notes |
|-----------|------|-------|
| API + worker | Railway or Render | env vars set in dashboard; Node 20 |
| Web (test UI) | Vercel | `NEXT_PUBLIC_API_BASE_URL` → API URL |
| Postgres | Neon | `DATABASE_URL` |
| Redis | Upstash | `REDIS_URL` |
| Object storage | Cloudflare R2 | bucket + access keys; CORS allows web origin for presigned PUT |

Secrets are configured as host environment variables, never in git. The authoritative key
list is `apps/api/.env.example` — **not** PROJECT_PLAN.md §9, which still lists a
`REMOVEBG_API_KEY` and a `REPLICATE_MODEL_VERSION` that the code does not use.

Deployment was scheduled for Day 3 and did not happen; it remains open.
