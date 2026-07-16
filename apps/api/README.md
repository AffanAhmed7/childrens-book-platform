# apps/api — Fastify backend

TypeScript + Fastify service that owns multi-character sessions, presigned R2 uploads, the
BullMQ pipeline worker, the SSE status stream, and the OpenAPI docs.

**Status:** Day 1–3 core loop done, including a mid-build architecture pivot to
template-based multi-character compositing (see [PROJECT_PLAN.md §17](../../PROJECT_PLAN.md)).
Full pipeline verified end-to-end once; a second combined confirmation of the latest quality
fixes is pending stable network conditions — see "Known state" below before treating this as
demo-ready.

## Setup

```bash
cd apps/api
cp .env.example .env      # fill in the keys below — see PROJECT_PLAN.md §9
npm install
npx prisma migrate dev --name init
npm run dev                # http://localhost:3001, docs at /docs
```

Required: `DATABASE_URL`, `R2_*` (upload loop); `REDIS_URL` (must be `rediss://`, TLS —
Upstash rejects plain `redis://`), `REMOVEBG_API_KEY` (pipeline). Portrait generation needs
no key (free HF Space).

Without a given key set, the server still boots (so you can browse `/docs`) — the specific
routes/steps that need it fail clearly instead (a 500, a 503 on `/status`, or a skipped
enqueue with a logged warning) rather than crashing the process.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | liveness check |
| GET | `/docs` | Swagger UI (OpenAPI) |
| POST | `/api/sessions` | create a session with one or more characters (`storyId`, `characters: [{slot, childName}]`) |
| GET | `/api/sessions/:id` | inspect a session + all its characters (QA convenience, not in original spec) |
| POST | `/api/sessions/:id/characters/:characterId/upload-url` | presigned R2 PUT URL for that character's photo |
| POST | `/api/sessions/:id/characters/:characterId/upload-confirm` | record the upload; enqueues the pipeline once *every* character in the session has uploaded |
| GET | `/api/sessions/:id/status` | **SSE** — live progress per character/step, plus the final `composite` step and `done` event |

`test/e2e.http` walks the original single-upload flow (pre-dates the multi-character
pivot — kept for reference, not representative of the current API shape).
`test/e2e-multichar.mjs` drives the current flow end-to-end:
`node test/e2e-multichar.mjs <photo1> child_1 <name1> <photo2> child_2 <name2>`.

## Pipeline

One BullMQ job per session. For **each character**, sequentially: `validate → portrait →
remove_bg → skin_tone`. Once every character has finished, one final **`composite`** step
combines them into the session's single preview image.

1. **validate** — exactly one face detected in the raw upload + minimum resolution
2. **portrait** — illustrated reference portrait via a free Hugging Face Space, stored as
   that character's `portraitKey`
3. **remove_bg** — background removed from the *generated portrait* (not the raw upload —
   see below), stored as `noBgKey`
4. **skin_tone** — sampled from the raw upload's face region, stored as `skinToneHex`
   (informational; not yet fed back into generation)
5. **composite** *(session-level, once)* — crops each character's face from their `noBgKey`
   portrait and blends it (soft feathered mask, not a hard paste) onto its slot in the fixed
   template, via Sharp — no AI call, so this step is fast and cheap regardless of character
   count. Result stored as `Session.previewKey`; publishes the `done` SSE event with a signed
   preview URL.

Any step failure sets `status = failed` and emits an SSE `error` event (with the `slot` it
happened on) with a user-facing message.

### Notable implementation choices (deviations from the original proposal)

- **Face detection:** `@tensorflow/tfjs` (pure JS/WASM) + `blazeface` instead of
  `face-api.js`, which needs the native `canvas` package — a real build risk on Windows under
  this deadline. Shared between `validate.ts` (exactly-one-face check) and `composite.ts`
  (locating a face within a generated portrait to crop it) via `src/pipeline/faceDetect.ts`.
- **Portrait model:** no card/budget available, so this uses the free public Hugging Face
  Space `InstantX/InstantID`, called via Gradio's HTTP API (upload → call → poll → download).
  The style prompt is constrained to a **plain headshot only** (no props/accessories, looking
  at camera) — the output gets face-detected and cropped for compositing, and a busier scene
  pulls stray content (sunglasses, instruments, etc.) into that crop. Trade-off: shared free
  GPU queue, so latency varies a lot (seconds to several minutes observed); the poll request
  uses a 15-minute `undici` timeout, not Node's 5-minute default. Community-maintained — if
  it becomes unreliable, swap to a paid model (Replicate version in git history before this
  file's multi-character-pivot commits).
- **Compositing, not re-generation, per page:** the expensive step (photo → illustrated
  likeness) runs once per character; adding template pages later is just more `composite`
  calls, not more generation calls. A literal ML face-swap tool (e.g. InsightFace inswapper)
  was deliberately not used for this — see [PROJECT_PLAN.md §17](../../PROJECT_PLAN.md) for
  why Sharp-based masked compositing was chosen instead.
- **Template:** `assets/templates/two-children-park.png`, generated via the free
  `black-forest-labs/FLUX.1-schnell` Space (no artist available yet) — swappable for real art
  later; only `TEMPLATE_PATH`/`TEMPLATE_SLOTS` in `composite.ts` need to change. Its two face
  slots were hand-verified by running blazeface against the image: detecting **both** faces
  at once failed (the model only found one), but detecting each half of the image separately
  found both reliably — a known blazeface limitation with multiple faces in one frame, not an
  issue for compositing since the template is static and its slots are computed once, not at
  request time.
- **Job retries:** single job per session, `attempts: 1` (no automatic retry) — a failure
  surfaces immediately via the `error` SSE event rather than needing BullMQ flows for
  per-step retry differentiation.

## Known state / what to verify next

The full pipeline (2 characters → composite → `done`) has been run successfully end-to-end.
A follow-up pass fixed two visible quality issues from that run (hard rectangular seams at
the paste edges; stray props bleeding into a face crop from a too-busy generated scene) via
feathered-mask compositing and a tightened portrait prompt. Each fix was verified
individually, but a second **combined** full run to visually confirm both fixes together was
interrupted by intermittent local network instability (timeouts across Neon, Upstash, and
the HF Space in the same window). Re-run before a client demo:

```bash
node test/e2e-multichar.mjs <photo1> child_1 <name1> <photo2> child_2 <name2>
```

See [PROJECT_PLAN.md §6–§7, §17](../../PROJECT_PLAN.md) for the full pipeline, API contract,
and multi-character pivot writeup.
