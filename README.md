# Personalized Children's Book Platform — Prototype

Photo-to-illustration pipeline: parents upload their children's photos and receive an
illustrated **preview** of those children drawn into a story page. This repository is the
**prototype** scope — a handful of pages, true multi-character (2+ children on one page) —
proving the engine rather than the full multi-page/multi-theme library.

> **Architecture and current state: [apps/api/README.md](apps/api/README.md) — read this
> first.** It is the live architecture document.
>
> [PROJECT_PLAN.md](PROJECT_PLAN.md) is the kickoff engineering plan and is a **historical
> record**: it describes two architectures that were built and replaced, and names several
> files that no longer exist. It carries a banner saying so, and each superseded section is
> flagged individually. Its §14 (deliverables) is kept current; everything else is history.
> [docs/DEMO_RUNBOOK.md](docs/DEMO_RUNBOOK.md) is how you actually run a demo.

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
├── PROJECT_PLAN.md      # kickoff plan — HISTORICAL RECORD, see the banner at its top
├── README.md            # you are here
├── docs/
│   ├── DEMO_RUNBOOK.md  # how to run a demo — start here for that
│   ├── DEMO_PLAN.md     # superseded 2026-07-17 demo plan, kept for its findings
│   └── CLIENT_UPDATE.md # client-facing progress note (local-only, git-ignored)
├── apps/
│   ├── api/             # Fastify + TypeScript backend (.env.example lives here), BullMQ
│   │                    #   worker, SSE, OpenAPI — AND the engine, in src/pipeline/
│   │   └── demo/        # standalone browser + CLI demo harness (no DB/Redis/S3 needed)
│   └── web/             # (DEFERRED, empty) Next.js test UI — API-only engagement
├── packages/
│   └── shared/          # (EMPTY placeholder — never populated; see its README)
├── infra/               # deployment notes (nothing is deployed yet)
└── assets/
    ├── templates/       # page artwork — 2 illustrator pages + 3 competitor screenshots
    ├── style-refs/      # illustration style reference images from client
    └── test-photos/     # consented QA photos (git-ignored — a fresh clone has none)
```

## Tech stack

Node 20 · TypeScript · Fastify · Prisma + Postgres (Neon) · BullMQ + Redis (Upstash) ·
Cloudflare R2 · `@tensorflow/tfjs` + blazeface (local face detection) · Replicate
(`google/nano-banana` repaint, InsightFace inswapper swap, CodeFormer restore) · Sharp
(local image work) · Next.js 14 + Tailwind (deferred).

## Getting started

**Just want to see it work?** The demo harness needs only a Replicate token — no Postgres,
no Redis, no storage:

```bash
cd apps/api && npm install
cp .env.example .env         # fill in REPLICATE_API_TOKEN only
npm run demo:web             # http://localhost:5174
```

See [docs/DEMO_RUNBOOK.md](docs/DEMO_RUNBOOK.md) — including the pre-generated images in
`apps/api/demo/keep-demo/`, which need no API, network or credit at all.

**The full production API** additionally needs Postgres, R2 and Redis:

```bash
# prerequisites: Node 20 (see .nvmrc)
cd apps/api
cp .env.example .env         # DATABASE_URL, R2_*, REDIS_URL, REPLICATE_API_TOKEN
npm install
npx prisma migrate deploy
npm run dev                  # http://localhost:3001 — docs at /docs
```

`apps/api/.env.example` is the authoritative key list. This is an **API-only** engagement:
OpenAPI/Swagger UI at `/docs` is the interactive API surface, and
`apps/api/test/e2e-multichar.mjs` drives the multi-character loop end-to-end against a
running server.

## Status

Core loop built and verified end-to-end, single- and multi-character, through both the real
API and a browser demo UI. See `apps/api/README.md`'s "Known state" for exactly what is
verified and the open risks — the licensing one blocks selling, not building.
[docs/DEMO_RUNBOOK.md](docs/DEMO_RUNBOOK.md) is the client-demo procedure.

Two honest caveats. **The prototype is not deployed** — it is local-only, with no shareable
demo URL; that is the one outstanding deliverable. And since the 2026-07-19 consolidation the
paid render path has been re-verified only for free (typecheck, face detection across all five
pages, server boot), not by a fresh paid render — so **do a throwaway warm-up run before any
client demo**, which also warms the repaint cache.

## Scope boundary

In scope: multi-character upload → per-character pipeline → personalized pages, documented
API (**API-only**; browser test UI deferred, though a standalone demo UI ships in
`apps/api/demo/`). Out of scope
(Phase 2+): the full multi-page/multi-theme template library, cart/checkout, 300 DPI print
PDF, print-provider integration, admin dashboard, GDPR deletion workflow, auth, email, full
i18n. See [PROJECT_PLAN.md §2, §16 & §17](PROJECT_PLAN.md).

---
Prototype engagement · Owner: Affan Ahmed · Client: _private engagement_
