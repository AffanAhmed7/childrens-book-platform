# infra — deployment notes

Lightweight deployment reference (no heavy IaC for a 3-day prototype).

| Component | Host | Notes |
|-----------|------|-------|
| API + worker | Railway or Render | env vars set in dashboard; Node 20 |
| Web (test UI) | Vercel | `NEXT_PUBLIC_API_BASE_URL` → API URL |
| Postgres | Neon | `DATABASE_URL` |
| Redis | Upstash | `REDIS_URL` |
| Object storage | Cloudflare R2 | bucket + access keys; CORS allows web origin for presigned PUT |

Deployment happens on Day 3. Secrets are configured as host environment variables, never in
git. See [PROJECT_PLAN.md §9 & §11](../PROJECT_PLAN.md).
