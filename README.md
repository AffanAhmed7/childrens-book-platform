# Personalized Children's Book Platform — Prototype

Photo-to-illustration pipeline: a parent uploads a child's photo and receives a single
illustrated **preview** of that child placed into a story scene. This repository is the
**prototype** scope only (one character, one story, one preview image).

> Full engineering plan: **[PROJECT_PLAN.md](PROJECT_PLAN.md)** — read this first.

## What it does

```
upload → face validation → background removal → portrait generation
       → skin-tone extraction → compositing → live status (SSE) → preview image
```

## Repository layout

```
childrens-book-platform/
├── PROJECT_PLAN.md      # master engineering plan (scope, schedule, risks, acceptance)
├── README.md            # you are here
├── .env.example         # required environment variables (no secrets)
├── docs/
│   └── CLIENT_UPDATE.md # client-facing progress note
├── apps/
│   ├── api/             # Fastify + TypeScript backend, BullMQ worker, SSE, OpenAPI
│   └── web/             # (DEFERRED) Next.js test UI — API-only engagement this phase
├── packages/
│   └── shared/          # shared TS types, status vocabulary, user-facing copy
├── infra/               # deployment notes / IaC-lite (Railway/Vercel/Neon/Upstash/R2)
└── assets/
    ├── templates/       # scene template PNG(s) from client
    ├── style-refs/      # illustration style reference images from client
    └── test-photos/     # consented QA photos (git-ignored)
```

## Tech stack

Node 20 · TypeScript · Fastify · Prisma + Postgres (Neon) · BullMQ + Redis (Upstash) ·
Cloudflare R2 · face-api.js · remove.bg · Replicate (portrait) · Sharp · Next.js 14 +
Tailwind. Full rationale in [PROJECT_PLAN.md §3](PROJECT_PLAN.md).

## Getting started (fills in during Day 1 build)

```bash
# prerequisites: Node 20 (see .nvmrc), a Redis + Postgres + R2 + API keys (see .env.example)
cp .env.example .env        # then fill in secrets
# api
cd apps/api && npm install && npx prisma migrate dev && npm run dev
```

This is an **API-only** engagement. API docs (OpenAPI/Swagger UI) are served at `/docs` and
serve as the interactive demo surface; `test/e2e.http` and `test/e2e.mjs` drive the full loop.

## Status

Prototype build in progress — see [PROJECT_PLAN.md §10](PROJECT_PLAN.md) for the 3-day
schedule and [docs/CLIENT_UPDATE.md](docs/CLIENT_UPDATE.md) for the latest client update.

## Scope boundary

In scope: the single upload→preview loop above + documented API (**API-only** this phase; browser test UI deferred).
Out of scope (Phase 2+): multi-character, multi-page, cart/checkout, 300 DPI print PDF,
print-provider integration, admin dashboard, GDPR deletion workflow, auth, email, full i18n.
See [PROJECT_PLAN.md §2 & §16](PROJECT_PLAN.md).

---
Prototype engagement · Owner: Affan Ahmed · Client: _private engagement_
