# apps/api — Fastify backend + the personalization engine

TypeScript service that owns multi-character sessions, presigned R2 uploads, the BullMQ
pipeline worker, the SSE status stream, the OpenAPI docs — and the image engine itself.

## Setup

```bash
cd apps/api
cp .env.example .env      # fill in the keys below
npm install
npx prisma migrate deploy
npm run dev                # http://localhost:3001, docs at /docs
```

Required: `DATABASE_URL`, `R2_*` (the upload loop); `REDIS_URL` (must be `rediss://`, TLS —
Upstash rejects plain `redis://`) and `REPLICATE_API_TOKEN` (the engine — face detection is
local and free; the repaint, swap and restore calls are the paid steps).

Without a given key set the server still boots, so `/docs` stays browsable; the specific
routes and steps that need it fail clearly instead (a 500, a 503 on `/status`, or a skipped
enqueue with a logged warning) rather than crashing the process.

## How the engine works

One recipe, five stages, in `src/pipeline/`. Every stage exists because something specific
failed without it — each stage file documents what was tried and rejected, which is worth
reading before changing any of them.

| # | Stage | File | Cost | What it does |
|---|-------|------|------|--------------|
| 1 | repaint | `stages/repaint.ts` | ~$0.039 | Redraws the whole illustration as this child (`google/nano-banana`) |
| 2 | swap | `stages/swap.ts` | ~$0.006 | Pins the likeness to exactly this child (InsightFace inswapper) |
| 3 | restore | `stages/restore.ts` | small | Blends the swap back into the painterly art (CodeFormer) |
| 4 | heal | `stages/heal.ts` | free | Removes small near-white swap specks, locally |
| 5 | eyes | `stages/eyes.ts` | free | Paints the repaint's eyes back over the swap's, locally |

Roughly **$0.045 per page, per character**, and ~90–170s wall time.

Cost and latency live in *different* stages, which is easy to get backwards. Measured from the
Replicate account's real prediction history: the **repaint dominates cost** ($0.039 flat) but
is fast at ~9–12s; the **swap dominates latency** at ~55–90s. Don't optimize the repaint for
speed or the swap for cost.

**Why repaint-then-swap.** The repaint SEES the photograph, so one generic prompt personalizes
any child with no per-child hair/skin text, and because it redraws the artwork cohesively there
are no seams or halos. The swap alone is not enough — measured, it changed only ~0.43% of a
page, leaving the wrong hair, an unwanted headband and pale hands. It is the identity stage,
not the engine.

**Two approaches were tried and rejected.** Masked inpainting (FLUX Fill) to preserve the
illustrator's exact pixels left visible seams and a bright halo around the hair on
open-background pages; the client rejected it outright. Before that, generating a portrait and
compositing it in fought pose and identity drift and needed per-template hand-calibration for
every page. Neither should be revisited — see [PROJECT_PLAN.md](../../PROJECT_PLAN.md) for the
full history.

### Page routing

`personalize.ts` is the only entry point. It routes on how many characters a page draws:

- **Solo pages** repaint the whole page in one call. No detection, no cropping, no
  compositing — the simplest path and the most proven.
- **Multi-character pages** give each drawn character their own generous crop, personalize each
  one individually against their own photo (so every child gets the solo recipe), then feather
  the finished crops back onto the original page. The crop geometry and the blending are in
  `compose.ts` and both took real measurement to get right.

Faces map to character slots **left to right** unless a page overrides that with `slots`. A
drawn character with no child mapped to them is left exactly as the illustrator drew them.

### File map

```
src/pipeline/
  catalog.ts      the ONE registry of pages and books — add a page here, nowhere else
  personalize.ts  the engine entry point; routes solo vs. multi-character
  compose.ts      multi-character crop geometry + feathered compositing
  faceDetect.ts   local blazeface detection (free)
  validate.ts     photo validation for uploads
  replicate.ts    Replicate client (prediction polling, "No face found" retries)
  retry.ts        HTTP retry policy (network, 5xx, 429)
  pool.ts         bounded-concurrency map
  dataUri.ts      Buffer → data URI
  types.ts        shared types
  stages/         the five stages above, one file each
```

`compose.ts` has an important split: `characterCrop` decides **what the models receive** and any
change to it needs full repaint+swap re-verification, while `cropOverlay` only decides **how the
finished result is blended back** and cannot affect reliability. Fix cosmetic seam problems in
`cropOverlay`, never in `characterCrop`.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | liveness check |
| GET | `/docs` | Swagger UI (OpenAPI) |
| POST | `/api/sessions` | create a session with one or more characters (`storyId`, `characters: [{slot, childName}]`) |
| GET | `/api/sessions/:id` | inspect a session and its characters |
| POST | `/api/sessions/:id/characters/:characterId/upload-url` | presigned R2 PUT URL for that character's photo |
| POST | `/api/sessions/:id/characters/:characterId/upload-confirm` | record the upload; enqueues the pipeline (mode `"preview"`) once *every* character has uploaded |
| POST | `/api/sessions/:id/render-full` | enqueues the rest of the book (mode `"full"`); pages already rendered for the preview are reused, not re-paid for |
| GET | `/api/sessions/:id/pages` | every page in the book with render status and a signed URL if ready |
| GET | `/api/sessions/:id/status` | **SSE** — live progress per character/step, plus the final `done`/`error` event |

## Production job flow

One BullMQ job per session, mode `"preview"` (only pages flagged `preview: true` in
`catalog.ts`) or `"full"` (the whole book, reusing anything already rendered). Preview mode is
the main cost lever — most visitors never buy, so we don't pay to render their whole book.

Per **character**, in parallel: `validate` (exactly one face, blazeface confidence ≥ 0.9, and
at least 200×200 — local, free, and it confirms the photo is usable before anything is spent).
Once every character is ready, one `render` step renders every page for that mode, up to
`PAGE_CONCURRENCY` (default 3) pages in flight. Each page may itself issue the full stage chain
per drawn character.

A page already in R2, from a prior preview or a retried attempt, is skipped rather than
re-paid for. Any step failure sets `status = failed` and emits an SSE `error` event with a
user-facing message; the full error is always logged server-side, even when the SSE message is
generic.

Jobs use `attempts: 1` — no automatic BullMQ retry, so a failure surfaces immediately. Retries
happen at the HTTP level inside a call (`retry.ts`) and for the swap model's own false-negative
face detection (`replicate.ts`'s `noFaceRetries`).

## Demo harness

`demo/` runs the identical engine with no Postgres, Redis, BullMQ or S3 — so a client demo
can't be taken down by infrastructure that has nothing to do with what's being shown.

```bash
npm run demo:web                          # browser UI on :5174, live per-stage progress
npm run personalize -- kid.jpg            # CLI, every page
npm run personalize -- kid.jpg dad.png --page mc_2
npm run personalize -- kid.jpg dad.png --detect-only   # FREE preflight, no API calls
```

`--detect-only` runs only local detection and writes the crops that *would* be sent for
repainting. Always run it before paid work when crop geometry has changed.

See [docs/DEMO_RUNBOOK.md](../../docs/DEMO_RUNBOOK.md) for the full client-demo procedure.

Test scripts against the real API:
- `test/e2e-single.mjs <photo> [childName]` — one character, preview pages only.
- `test/e2e-multichar.mjs <storyId> <photo> <slot> <name> [...]` — N characters.
- `test/list-past-runs.mjs` — inspect previous sessions and their rendered pages.

## Known state

**Verified end-to-end through the real API:** a full multi-character session — create → upload
two different children's photos → confirm → SSE through `validate`/`render` → `done` —
producing correct per-character results on both a solo and a two-character page. The browser
demo UI has been verified the same way from a fresh clone.

**Open risks, in priority order:**

1. **Licensing.** The swap model (InsightFace inswapper) is published for non-commercial and
   research use only. InsightFace sell a separate commercial licence, which this paid product
   needs before launch. Most open face-swap tools (roop, facefusion, SimSwap) derive from the
   same model and inherit the restriction. **This blocks selling, not building.**
2. **The single-character page art is not shippable.** `astronaut`, `plane` and `workshop` are
   screenshots of a competitor's preview flow with French UI chrome baked into the pixels
   (which is what the `crop` field in `catalog.ts` strips). They demonstrate the engine fine,
   but they need replacing with real illustration.
3. **Non-determinism, undersampled.** Each verified result rests on one or two runs, and the
   same photo and page will not reproduce a previous output. Past "confirmed" fixes have hidden
   real bugs exactly this way. Anything reliability-related needs N≥5 runs before it is settled.
4. **`render-full`** (rendering the rest of the book after a preview) has not been exercised
   through the real API.

**Template art must be soft-shaded/painterly, not flat vector or chibi.** The swap model's own
internal face detector — separate from our blazeface check — reliably fails on flat-colour,
thick-outline art and on chibi proportions (giant anime eyes, round blob head), reporting
`status: "succeeded"` with no output and only "No face found" in the logs. The repaint prompt
now forces realistic facial geometry to counter this, but brief any new template art
accordingly before investing in it.

**Do not try to fix child facial geometry with prompt text.** It has failed three times over —
hair length, doubled eyebrows, and eye size. Even a concrete "each eye is one fifth of the face
width" instruction did not shrink a child's eyes, though the adult character on the same page
complied. Eye size is fixed downstream in `stages/eyes.ts` instead.
