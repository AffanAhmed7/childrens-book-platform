# Personalized Children's Book Platform — Prototype

Photo-to-illustration pipeline: parents upload their children's photos and receive an
illustrated **preview** of those children composited into a story scene. This repository is
the **prototype** scope: one template scene, true multi-character (2+ children in one
scene), proving a template-and-composite architecture rather than the full multi-page/
multi-theme library. See [PROJECT_PLAN.md §17](PROJECT_PLAN.md) for the pivot from the
original single-character scope.

> Full engineering plan: **[PROJECT_PLAN.md](PROJECT_PLAN.md)** — read this first.

## What it does

```
per character: upload → face validation → portrait generation → background removal
             → skin-tone extraction
once all characters are ready: composite onto the scene template → live status (SSE)
             → preview image
```

## Repository layout

```
childrens-book-platform/
├── PROJECT_PLAN.md      # master engineering plan (scope, schedule, risks, acceptance)
├── README.md            # you are here
├── docs/
│   └── CLIENT_UPDATE.md # client-facing progress note (local-only, git-ignored)
├── apps/
│   ├── api/             # Fastify + TypeScript backend (.env.example lives here), BullMQ worker, SSE, OpenAPI
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
Cloudflare R2 · `@tensorflow/tfjs` + blazeface (face detection) · remove.bg · a free Hugging
Face Space (InstantID, portrait generation) · Sharp (compositing) · Next.js 14 + Tailwind
(deferred). Full rationale in [PROJECT_PLAN.md §3](PROJECT_PLAN.md); deviations from the
original proposal in `apps/api/README.md`.

## Getting started

```bash
# prerequisites: Node 20 (see .nvmrc), a Postgres + R2 (Day 1) and Redis + API keys (Day 2+)
cd apps/api
cp .env.example .env        # then fill in DATABASE_URL + R2_* — see PROJECT_PLAN.md §9
npm install
npx prisma migrate dev --name init
npm run dev                 # http://localhost:3001 — docs at /docs
```

This is an **API-only** engagement. API docs (OpenAPI/Swagger UI) are served at `/docs` and
serve as the interactive demo surface; `apps/api/test/e2e-multichar.mjs` drives the current
multi-character loop end-to-end.

## Status

Core loop built and verified end-to-end, including a mid-build pivot to multi-character +
template compositing — see [PROJECT_PLAN.md §17](PROJECT_PLAN.md) for what changed and why,
and `apps/api/README.md`'s "Known state" section for what's verified vs. still pending a
final combined confirmation. [docs/CLIENT_UPDATE.md](docs/CLIENT_UPDATE.md) has the latest
client-facing update.

## Scope boundary

In scope: multi-character upload → per-character pipeline → template compositing → one
preview image, documented API (**API-only**; browser test UI deferred). Out of scope
(Phase 2+): the full multi-page/multi-theme template library, cart/checkout, 300 DPI print
PDF, print-provider integration, admin dashboard, GDPR deletion workflow, auth, email, full
i18n. See [PROJECT_PLAN.md §2, §16 & §17](PROJECT_PLAN.md).

---
Prototype engagement · Owner: Affan Ahmed · Client: _private engagement_
