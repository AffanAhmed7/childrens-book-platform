# apps/api — Fastify backend

TypeScript + Fastify service that owns sessions, presigned R2 uploads, the BullMQ pipeline
worker, the SSE status stream, and the OpenAPI docs.

**Status:** Day 1 + Day 2 done — sessions, presigned upload/confirm, the BullMQ pipeline
(validate → remove_bg → skin_tone → portrait), and live SSE status. Compositing + the final
preview (`done` event) land Day 3 (see [PROJECT_PLAN.md](../../PROJECT_PLAN.md)).

## Setup

```bash
cd apps/api
cp .env.example .env      # fill in the keys below — see PROJECT_PLAN.md §9
npm install
npx prisma migrate dev --name init
npm run dev                # http://localhost:3001, docs at /docs
```

Required for Day 1 (upload loop): `DATABASE_URL`, `R2_*`.
Required for Day 2 (pipeline): `REDIS_URL` (must be `rediss://`, TLS — Upstash rejects plain
`redis://`), `REMOVEBG_API_KEY`. Portrait generation needs no key (free HF Space).

Without a given key set, the server still boots (so you can browse `/docs`) — the specific
routes/steps that need it fail clearly instead (a 500, a 503 on `/status`, or a skipped
enqueue with a logged warning) rather than crashing the process.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | liveness check |
| GET | `/docs` | Swagger UI (OpenAPI) |
| POST | `/api/sessions` | create a session (`locale`, `storyId`, `childName`) |
| GET | `/api/sessions/:id` | inspect a session + character (QA convenience, not in original spec) |
| POST | `/api/sessions/:id/upload-url` | get a presigned R2 PUT URL for a given `contentType` |
| POST | `/api/sessions/:id/upload-confirm` | record the object key, mark `uploaded`, enqueue the pipeline job |
| GET | `/api/sessions/:id/status` | **SSE** — live progress through the pipeline steps |

`test/e2e.http` walks the Day 1 upload flow. `test/e2e-day2.mjs` drives the full Day 2 loop
including the SSE stream: `node test/e2e-day2.mjs ./path/to/photo.jpg`.

## Pipeline (Day 2)

One BullMQ job per session, steps run sequentially, each publishing an SSE `status` event
and persisting its result:

1. **validate** — exactly one face detected + minimum resolution
2. **remove_bg** — background removed via remove.bg, stored as `noBgKey`
3. **skin_tone** — sampled from the face region, stored as `skinToneHex`
4. **portrait** — illustrated portrait via a free Hugging Face Space, stored as `portraitKey`

Any step failure sets `status = failed` and emits an SSE `error` event with a user-facing
message. **Coming Day 3:** `composite` (portrait onto scene template → `previewKey`) and the
`done` SSE event with the final preview URL.

### Notable implementation choices (deviations from the original proposal)

- **Face detection:** uses `@tensorflow/tfjs` (pure JS/WASM) + `blazeface` instead of
  `face-api.js`, which requires the native `canvas` package — a real native-build risk on
  Windows under a 3-day deadline. Gives bounding boxes (no landmarks), which is all "exactly
  one usable face" validation needs.
- **Portrait model:** no card/budget available, so this uses the free public Hugging Face
  Space `InstantX/InstantID` (same InstantID technique originally planned for Replicate),
  called via Gradio's HTTP API (upload → call → poll → download), rather than a paid API.
  Verified end-to-end with a real photo — produces genuinely good watercolor-style,
  identity-preserving results. Trade-off: shared free GPU queue, so latency varies a lot
  (observed: a few seconds in one run, several minutes in another under load); the poll
  request uses a 15-minute `undici` timeout (not the 5-minute Node default) to tolerate
  that. It's also a community-maintained demo that could change or go down without notice —
  if that becomes a problem, swap to a paid model (Replicate code preserved in git history
  at the commit before this change). The style prompt/preset ("Watercolor") is a first pass
  pending the client's actual style references; expect to iterate per the plan's flagged risk.
- **Job retries:** single job per session, `attempts: 1` (no automatic retry) rather than
  the plan's per-step retry policy — differentiating retry behavior per step would need
  BullMQ flows (multiple linked jobs), which is more machinery than a 3-day prototype
  warrants. A failed job surfaces immediately via the `error` SSE event instead.

See [PROJECT_PLAN.md §6–§7](../../PROJECT_PLAN.md) for the full pipeline and API contract.
