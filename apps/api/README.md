# apps/api — Fastify backend

TypeScript + Fastify service that owns multi-character sessions, presigned R2 uploads, the
BullMQ pipeline worker, the SSE status stream, and the OpenAPI docs.

**Status:** face-swap architecture (see [PROJECT_PLAN.md §17](../../PROJECT_PLAN.md) for the
pivot history from the original generate-then-composite design). Multi-character face-swap has
been run successfully end-to-end through the real API — see "Known state" below for exactly
what's verified and what isn't yet.

## Setup

```bash
cd apps/api
cp .env.example .env      # fill in the keys below — see PROJECT_PLAN.md §9
npm install
npx prisma migrate deploy
npm run dev                # http://localhost:3001, docs at /docs
```

Required: `DATABASE_URL`, `R2_*` (upload loop); `REDIS_URL` (must be `rediss://`, TLS —
Upstash rejects plain `redis://`) and `REPLICATE_API_TOKEN` (the pipeline itself — face
detection is local/free, the swap call is the only paid step).

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
| POST | `/api/sessions/:id/characters/:characterId/upload-confirm` | record the upload; enqueues the pipeline (mode `"preview"`) once *every* character in the session has uploaded |
| POST | `/api/sessions/:id/render-full` | enqueues the rest of the book (mode `"full"`) — pages already rendered for the preview are reused, not re-paid for |
| GET | `/api/sessions/:id/pages` | lists every page in the book with its render status and signed URL if ready |
| GET | `/api/sessions/:id/status` | **SSE** — live progress per character/step, plus the final `done`/`error` event |

`test/e2e.http` and `test/e2e-day2.mjs` predate the multi-character pivot and don't match the
current API shape. Live scripts:
- `test/e2e-single.mjs <photo> [childName]` — one character, preview pages only.
- `test/e2e-multichar.mjs <storyId> <photo> <slot> <name> [<photo> <slot> <name> ...]` — N characters.
- `demo/demo.mts` — narrated walkthrough of one page, for a screen recording (`--open` shows each step's image).

## Pipeline

One BullMQ job per session, mode `"preview"` (just the pages flagged `preview: true` in
`templates.ts`) or `"full"` (the whole book, reusing any page already rendered). Per
**character**, in parallel: `validate → skin_tone`. Once every character is ready, one `swap`
step renders every page for that mode, up to `PAGE_CONCURRENCY` (default 3) pages in flight —
each page may itself issue one swap call per drawn character on it, in parallel.

1. **validate** (`validate.ts`) — exactly one face detected in the raw upload (blazeface,
   confidence ≥ 0.9) + minimum resolution (200×200).
2. **skin_tone** (`skinTone.ts`) — sampled from a cheek/chin band inside the detected face box
   (narrower than the full box, to avoid hair/eyes/shadow pulling the average toward grey),
   cached on the `Character` row so a later "full" render doesn't re-sample.
3. **swap** *(per page, per drawn character on it)* — `personalize.ts` detects every drawn
   character on the page (`faceDetect.ts`, blazeface — see "multi-character detection" below),
   crops a padded region around each one, sends it to Replicate's face-swap model
   (`faceSwap.ts`) with the child's photo as the source face, and pastes the swapped crop back
   through a feathered elliptical mask (`personalize.ts`'s `faceOverlay`) so only the face
   changes, not the surrounding art. Pages are rendered up to `PAGE_CONCURRENCY` at a time
   (`pool.ts`); a page already in R2 (from a prior preview/attempt) is skipped, not re-paid for.
4. **tone matching** *(optional, off by default — see `ToneSettings` in `templates.ts`)* —
   `tone.ts`'s colour-distance recolouring shifts the drawn character's skin/hair toward the
   child's own tone, sampled from the child's photo and from the page's *original* (pre-swap)
   artwork. Pure pixel maths, no extra API cost. Off by default because it's a partial/soft
   nudge by design (preserves the illustrator's shading rather than flat-filling) and hasn't
   been validated end-to-end with tone actually enabled — see "Known state."

Any step failure sets `status = failed` and emits an SSE `error` event (with the `slot` it
happened on, if applicable) with a user-facing message; the full error is always logged
server-side (`worker.ts`'s `runStep`) even when the SSE message is generic.

### Notable implementation choices

- **Engine: face-swap onto finished artwork, not generate-then-composite.** Replaces an
  earlier architecture that generated a stylized portrait per child (via a paid or free
  diffusion model) and pasted it into a template. That approach fought diffusion drift
  (identity, pose) and needed per-template calibration. Swapping the child's face onto a
  character the illustrator already drew and posed needs none of that — pose, lighting, hair
  and headgear are correct by construction. See `faceSwap.ts` and
  [PROJECT_PLAN.md §17](../../PROJECT_PLAN.md) for the full history.
- **Model: `codeplugtech/face-swap` (InsightFace inswapper) on Replicate**, ~$0.007/run, CPU,
  seconds. **Licensing is unresolved:** inswapper is published for non-commercial/research use;
  InsightFace sell a separate commercial licence, which this paid product needs before launch.
- **Face detection:** `@tensorflow/tfjs` (pure JS/WASM) + `blazeface` instead of `face-api.js`,
  which needs the native `canvas` package — a real build risk on Windows. Shared by
  `validate.ts` (exactly-one-face check on a raw photo) and `personalize.ts`
  (`detectPageCharacters`, finding every drawn character on a page) via `faceDetect.ts`.
- **Multi-character detection on a page:** a single whole-page blazeface pass is enough for a
  solo-character page, but misses one of two children standing side by side in a wide frame,
  and is sensitive to the *exact* crop width in a non-systematic way. `detectPageCharacters`
  runs several overlapping crop windows and merges/dedupes whatever any of them find.
- **Template art must be a soft-shaded/painterly style, not flat vector/cartoon.** The swap
  model's own internal face detector (separate from our blazeface check) reliably fails to
  find a face in flat-colour/thick-outline illustration, regardless of face size or pose — it
  reports `status: "succeeded"` with no output, visible only in `prediction.logs` as "No face
  found." Confirmed on the original `two-children-park.png` (replaced by
  `two-children-park-v2.png`, generated to match `workshop`'s working painterly style). Brief
  any future template art (or generation prompt) accordingly before investing in it.
- **Job retries:** single job per session, `attempts: 1` (no automatic BullMQ retry) — a
  failure surfaces immediately via the `error` SSE event. Within a single swap call,
  `retry.ts`'s `fetchWithRetry` retries network errors, 5xx, and 429 (rate-limited) with
  backoff honouring `Retry-After` when present — 4xx other than 429 is not retried, since the
  request itself is wrong and retrying won't help.

## Known state / what's verified vs. not

**Verified, through the real API (not just direct-call scripts):** a full multi-character
session — create → upload 2 different children's photos → confirm → SSE through
`validate`/`skin_tone`/`swap` → `done` — completed cleanly and produced correct per-character
face swaps on both a single-character and a two-character page.

**Not yet verified:**
- `render-full` (rendering the rest of the book after the preview) has not been run even once.
- Tone matching (`tone.skin`/`tone.hair`) has only been checked with synthetic target colours
  on local assets, never through the real session flow with `tone` enabled.
- Only two of the book's five pages (`workshop`, `park`) have template art confirmed compatible
  with the swap model. The other three (`astronaut`, `pilot`, `architect`) were found to be
  screenshots of a reference competitor app with foreign UI baked into the image pixels, not
  usable template art at all — they need replacing, not just a compatibility check.
