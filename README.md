# Personalized Children's Book Platform — Prototype

Photo-to-illustration pipeline: parents upload their children's photos and receive an
illustrated **preview** of those children drawn into a story page. This repository is the
**prototype** scope — a handful of pages, true multi-character (2+ children on one page) —
proving the engine rather than the full multi-page/multi-theme library.

> Architecture and current state: **[apps/api/README.md](apps/api/README.md)** — read this
> first. [PROJECT_PLAN.md](PROJECT_PLAN.md) is the original engineering plan and is now
> largely a historical record; it describes two architectures that were tried and replaced.

## What it does

```
per character: upload → face validation (local, free)
per page:      repaint the illustration as this child → swap for exact identity
               → restore → heal → eye fix
               → live status (SSE) → preview image
```

The repaint stage sees the photograph directly, so one generic prompt personalizes any child
with no per-child tuning and no per-template calibration. Multi-character pages crop each
drawn character out, personalize them individually, and feather the results back onto the
page. Full detail in [apps/api/README.md](apps/api/README.md).

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
Cloudflare R2 · `@tensorflow/tfjs` + blazeface (local face detection) · Replicate
(`google/nano-banana` repaint, InsightFace inswapper swap, CodeFormer restore) · Sharp
(local image work) · Next.js 14 + Tailwind (deferred).

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

Core loop built and verified end-to-end, single- and multi-character, through both the real
API and a browser demo UI. See `apps/api/README.md`'s "Known state" for exactly what is
verified and the open risks — the licensing one blocks selling, not building.
[docs/DEMO_RUNBOOK.md](docs/DEMO_RUNBOOK.md) is the client-demo procedure.

## Scope boundary

In scope: multi-character upload → per-character pipeline → personalized pages, documented
API (**API-only**; browser test UI deferred, though a standalone demo UI ships in
`apps/api/demo/`). Out of scope
(Phase 2+): the full multi-page/multi-theme template library, cart/checkout, 300 DPI print
PDF, print-provider integration, admin dashboard, GDPR deletion workflow, auth, email, full
i18n. See [PROJECT_PLAN.md §2, §16 & §17](PROJECT_PLAN.md).

---
Prototype engagement · Owner: Affan Ahmed · Client: _private engagement_
