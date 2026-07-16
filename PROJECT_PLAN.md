# Development Plan — Personalized Children's Book Platform

**Prototype: Photo-to-Illustration Pipeline**
Client: _private engagement_ · Engagement: Prototype build · Delivery window: **3 days**

---

## Decision Log

| Date | Decision | Effect |
|------|----------|--------|
| 2026-07-15 | **API-only** engagement — browser test UI **not** built this phase | `apps/web` deferred; Swagger UI at `/docs` is the interactive demo surface; a scripted `test/e2e.http` collection drives QA (§8, §10, §14) |
| 2026-07-15 | GitHub repo: **public**, owner's account, `gh` CLI setup | See §11 |
| 2026-07-16 | Face detection: `@tensorflow/tfjs` + `blazeface` instead of `face-api.js` | Avoids the native `canvas` package, a real build risk on Windows under this deadline; bounding boxes are sufficient for single-face validation. See `apps/api/README.md` |
| 2026-07-16 | Portrait model: free public Hugging Face Space (`InstantX/InstantID`), not Replicate | No card/budget available. Verified end-to-end with a real photo — good watercolor-style, identity-preserving results. Trade-off: shared free GPU queue (latency ranges seconds-to-minutes), community-maintained. Replicate version preserved in git history if a paid, more reliable path is wanted later. See `apps/api/README.md` |
| 2026-07-16 | Pipeline job: single BullMQ job per session, `attempts: 1` (no auto-retry), not per-step retry differentiation | Per-step retry policy would need BullMQ flows (linked jobs) — more machinery than a 3-day prototype warrants; failures surface immediately via the `error` SSE event |
| 2026-07-16 | **Scope pivot: multi-character + template-based compositing**, superseding the single-character "generate one preview" design | Client wants a small-scale proof of Imagitime's actual architecture (one stylized portrait per child, reused via fast compositing — not regenerated per page) plus **true multi-character** now, not deferred. New Session→many Character data model, per-character upload endpoints, and a new `composite` pipeline step. Full detail in the approved plan; see §17 below and `apps/api/README.md` |

---

## 0. How to read this document

This is the single source of truth for the prototype build. It expands the client
proposal into an executable engineering plan. Every item in the proposal's
"Included in Prototype" list is mapped to a concrete task, owner, file, and
acceptance check below.

- **Section 1–2** — scope lock (what we build, what we explicitly do not)
- **Section 3–8** — the technical design (stack, architecture, data, pipeline, API, frontend)
- **Section 9** — infrastructure & secrets provisioning (the parts that need client/us action)
- **Section 10** — the compressed **3-day** build schedule (proposal's 5–7 day plan, resequenced)
- **Section 11** — Git & GitHub workflow and the commit cadence
- **Section 12** — testing & acceptance criteria (definition of "done")
- **Section 13** — risk register & fallback plan (the portrait-generation risk)
- **Section 14** — deliverables checklist mapped 1:1 to the proposal
- **Section 15** — what we need from the client, and by when
- **Section 16** — explicitly deferred scope (Phase 2+)

---

## 1. Scope — Included in Prototype

The prototype is a single end-to-end loop for **one child character, one story, one
preview image**:

> upload → face validation → background removal → portrait generation → skin-tone
> extraction → compositing → live SSE status → one preview image → test UI + API docs

| # | Capability | Proposal source |
|---|------------|-----------------|
| 1 | Photo upload (presigned, direct-to-storage) | Included list |
| 2 | Face validation (detect exactly one usable face, check resolution/type) | Included list |
| 3 | Background removal | Included list |
| 4 | Portrait / illustrated-character generation (off-the-shelf, **not** fine-tuned) | Included list + risk disclosure |
| 5 | Skin-tone extraction | Included list |
| 6 | Compositing character onto a scene template | Included list |
| 7 | Live status via Server-Sent Events | Included list |
| 8 | One final preview image | Included list |
| 9 | ~~Browser test UI~~ → **deferred** (client confirmed **API-only**, 2026-07-15) | Included list |
| 10 | Documented API (OpenAPI/Swagger) — **primary interface & demo surface** | Included list |

## 2. Scope — Explicitly OUT (do not build)

Multi-character · multi-page preview · cart/checkout (Stripe) · 300 DPI CMYK print PDF ·
print-provider integration (Gelato/Lulu) · admin dashboard · GDPR deletion workflow +
audit log · auth/accounts · transactional email (Resend) · full i18n rollout beyond the
single test locale.

These are tracked in **Section 16** so the client sees they are deliberately deferred,
not forgotten.

---

## 3. Tech Stack (locked)

| Layer | Choice | Notes |
|-------|--------|-------|
| Runtime | **Node.js 20 LTS** (dev machine runs 22 — pinned via `.nvmrc`/`engines`) | matches BullMQ/Sharp ecosystem |
| Language | **TypeScript** (strict) | shared types across api/web |
| API framework | **Fastify** | native async, first-class SSE, `@fastify/swagger` for docs |
| Database | **PostgreSQL** (Neon free tier) | UUID sessions |
| ORM | **Prisma** | fast schema iteration + typed client |
| Queue | **BullMQ + Redis** (Upstash free tier) | per-step retry/backoff |
| Object storage | **Cloudflare R2** (S3-compatible) | presigned PUT/GET, no egress fee |
| Face detection | **face-api.js** (self-hosted, $0) → fallback **AWS Rekognition** if accuracy insufficient | cost-first |
| Background removal | **remove.bg API** | as specified |
| Skin-tone extraction | **Sharp** (pixel sampling) | no external API |
| Portrait generation | **Replicate** — ControlNet / IP-Adapter / InstantID / PhotoMaker class model | off-the-shelf, **flagged risk** |
| Compositing | **Sharp** | template + portrait → JPG |
| Realtime status | **Server-Sent Events** (native) | one-way stream; no socket.io |
| Frontend | **Next.js 14 (App Router) + Tailwind** | test UI only for prototype |
| Hosting | API: Railway/Render · Web: Vercel · Redis: Upstash · DB: Neon · Storage: R2 | free/cheap tiers |

**Stack deviations from the proposal:** none. Node 22 on the dev box is a superset of
Node 20; we pin `engines.node` to `>=20` and target 20 LTS behavior.

---

## 4. Architecture Overview

```
┌────────────┐   presigned PUT    ┌──────────────┐
│  Next.js   │ ─────────────────▶ │  Cloudflare  │
│  test UI   │                    │      R2      │
│ (Vercel)   │ ◀───── preview ─── │  (objects)   │
└─────┬──────┘   signed GET       └──────▲───────┘
      │  REST (create/confirm)           │ read/write keys
      │  SSE  (status stream)            │
      ▼                                  │
┌───────────────────────────┐   enqueue  │
│      Fastify API          │ ─────────┐ │
│  (Railway/Render)         │          │ │
│  - /api/sessions          │          ▼ │
│  - /upload-url /confirm   │   ┌─────────────────┐
│  - /status (SSE)          │   │  BullMQ worker  │
│  - /preview               │   │  pipeline queue │
│  - /docs (OpenAPI)        │◀──│  validate →     │
└──────────┬────────────────┘   │  remove_bg →    │
           │ Prisma             │  skin_tone →    │
           ▼                    │  portrait →     │
     ┌───────────┐  progress    │  composite      │
     │ Postgres  │◀─────────────│  (updates rows, │
     │  (Neon)   │              │   emits events) │
     └───────────┘              └───────┬─────────┘
           ▲                            │ external calls
           │  Redis pub/sub for SSE     ├─▶ remove.bg
     ┌───────────┐                      ├─▶ Replicate
     │  Redis    │◀─────────────────────┘   (ControlNet…)
     │ (Upstash) │
     └───────────┘
```

**Key flows**

1. **Upload** — UI asks API for a presigned R2 PUT URL, uploads the photo directly to
   R2 (bytes never transit our API), then confirms; confirm writes `rawKey` and enqueues
   the pipeline job.
2. **Processing** — one BullMQ job runs the five steps sequentially; each step updates the
   `Character` row and publishes a progress event on Redis.
3. **Status** — the SSE endpoint subscribes to that session's Redis channel and streams
   `status` / `done` / `error` events to the browser.
4. **Result** — the final composited preview is written to R2; UI shows it via a signed GET
   URL (`/preview` provides the same URL as a polling fallback if the SSE connection drops).

---

## 5. Data Model (Prisma — prototype-scoped)

```prisma
model Session {
  id        String   @id @default(uuid())
  locale    String   @default("fr")
  storyId   String
  childName String
  status    String   @default("created") // created | uploaded | validated | processing | done | failed
  createdAt DateTime @default(now())
  character Character?
}

model Character {
  id          String  @id @default(uuid())
  sessionId   String  @unique
  session     Session @relation(fields: [sessionId], references: [id])
  role        String  @default("child") // fixed to "child" for prototype
  rawKey      String? // R2 key, original upload
  noBgKey     String? // after remove.bg
  skinToneHex String? // sampled skin tone
  portraitKey String? // illustrated asset, transparent bg
  previewKey  String? // final composited preview
  jobId       String? // BullMQ job id for status lookup
}
```

Status vocabulary is shared as a TypeScript union in `packages/shared` so API, worker, and
UI never drift.

---

## 6. Pipeline (BullMQ)

**One queue** (`pipeline`), **one job per session** running five sequential steps. Multi-queue
with dead-letter routing is a Phase-2 concern — out of scope here.

| Step | Action | Writes | Emits (SSE `status`) |
|------|--------|--------|----------------------|
| `validate` | face-api.js: exactly one detectable face; check min resolution + mime | — (fail → `status=failed`) | "Checking your photo…" |
| `remove_bg` | remove.bg API on the raw image | `noBgKey` | "Preparing your characters…" |
| `skin_tone` | Sharp: sample face-region pixels, average → hex | `skinToneHex` | "Matching skin tone…" |
| `portrait` | Replicate ControlNet/IP-Adapter call, poll to completion | `portraitKey` | "Creating your illustrated characters…" |
| `composite` | Sharp: load scene template + portrait, position/scale, export JPG | `previewKey` | "Building your story pages…" |

Rules:
- Each step is wrapped in `try/catch`. On failure: set `status = failed`, emit an `error`
  event with a **user-facing** message (never a raw stack trace) plus the failing `step`.
- BullMQ per-job retry: `attempts: 2`, exponential backoff — but **not** for `validate`
  (a bad photo won't get better on retry; fail fast and ask the user to re-upload).
- Progress is published to Redis channel `session:{id}` which the SSE route subscribes to.
- The exact user-facing copy strings are centralized in `packages/shared/messages.ts` so
  they match the proposal wording and are ready for i18n later.

---

## 7. Backend API Surface

```
POST /api/sessions
  body: { locale, storyId, childName }
  → 201 { sessionId }

POST /api/sessions/:id/upload-url
  → 200 { uploadUrl, objectKey }        # presigned R2 PUT, 60s expiry

POST /api/sessions/:id/upload-confirm
  body: { objectKey }
  → 200 { ok: true }                    # writes rawKey, enqueues pipeline job

GET  /api/sessions/:id/status           # text/event-stream (SSE)
  event: status  data: { step, message }
  event: done    data: { previewUrl }
  event: error   data: { step, message }

GET  /api/sessions/:id/preview
  → 200 { previewUrl }                  # signed R2 GET, polling fallback for SSE drops

GET  /docs                              # Swagger UI (OpenAPI 3) — "documented API" deliverable
```

**Validation & hardening (prototype-appropriate):** request bodies validated by Fastify
JSON schema (feeds OpenAPI for free); upload URLs constrained to expected content-type and
size; object keys namespaced by session id (`sessions/{id}/raw`, `/nobg`, `/portrait`,
`/preview`); permissive CORS limited to the Vercel preview origin.

OpenAPI is generated automatically from route schemas via `@fastify/swagger` +
`@fastify/swagger-ui` — near-zero manual doc effort, always in sync.

---

## 8. Client / Demo Interface — API-only (test UI deferred)

> **Decision 2026-07-15:** the client confirmed an **API-only** engagement, so the Next.js
> browser test UI is **deferred to a later phase**. The demo and QA surface for this build is:
>
> - **Swagger UI at `/docs`** — interactive, click-to-run documentation of every endpoint.
> - **`test/e2e.http`** — a checked-in REST Client collection that walks the full
>   create → upload → confirm → status(SSE) → preview loop against a running API.
> - **`test/e2e.mjs`** — a small Node script for an automated end-to-end pass in CI/QA,
>   including an `EventSource` consumer that prints each SSE `status` event and the final
>   `done`/`error`.
>
> The reference UI design below is retained for the future phase when the browser UI is added.

### (Reference — deferred) Next.js test UI, single page

No auth, no routing complexity. One page, four states:

1. **Form** — story dropdown (one hardcoded story) + child-name input → `POST /api/sessions`.
2. **Upload** — file input → request presigned URL → `PUT` directly to R2 → `POST upload-confirm`.
3. **Status** — open `EventSource('/api/sessions/:id/status')`, render the five steps as a
   checklist that lights up in order, using the exact proposal copy
   ("Preparing your characters…", "Creating your illustrated characters…",
   "Building your story pages…"). Polling fallback on SSE error.
4. **Result** — show the final preview image + a "Try another photo" reset button.

Client-side guards: image type/size check before requesting an upload URL; disabled submit
while a pipeline is in flight; graceful error card on the `error` SSE event.

---

## 9. Infrastructure & Secrets Provisioning

All chosen services have free tiers. **Account creation requires the client's/owner's own
sign-in** — I will not create third-party accounts or enter credentials on your behalf. For
each service below I'll provide exact setup steps; you create the account and paste the key
into our shared secret store (or send securely), and I wire it in.

| Service | Purpose | Who provisions | Secret(s) produced |
|---------|---------|----------------|--------------------|
| Neon | Postgres | you (or me with your login) | `DATABASE_URL` |
| Upstash | Redis | you | `REDIS_URL` |
| Cloudflare R2 | Object storage | you | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` |
| remove.bg | Background removal | you | `REMOVEBG_API_KEY` |
| Replicate | Portrait generation | you | `REPLICATE_API_TOKEN`, `REPLICATE_MODEL_VERSION` |
| Railway/Render | API hosting | you/me | — |
| Vercel | Web hosting | you/me | — |

**`.env` contract** (see `.env.example` in repo root):

```
DATABASE_URL=
REDIS_URL=
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=
REMOVEBG_API_KEY=
REPLICATE_API_TOKEN=
REPLICATE_MODEL_VERSION=
```

Secrets are **never** committed. `.env` is git-ignored; only `.env.example` (keys, no values)
is tracked. On the hosts, secrets are set as environment variables in the dashboard.

---

## 10. Build Schedule — Compressed to 3 Days

The proposal budgets 5–7 working days; we're targeting **3**. This is achievable only if the
client assets (Section 15) arrive at kickoff. The plan front-loads the risk step
(portrait generation) so we discover model quality on Day 2, leaving Day 3 for iteration.

### Day 1 — Foundation & the upload loop
- Monorepo scaffold (`apps/api`, `apps/web`, `packages/shared`), TypeScript strict, tooling.
- Provision Neon, Upstash, R2 (or wire the keys you provide).
- Prisma schema + first migration; typed client.
- Fastify app + health check + `@fastify/swagger` mounted at `/docs`.
- `POST /api/sessions`, `POST /upload-url`, `POST /upload-confirm` (presigned R2, writes `rawKey`).
- `test/e2e.http` collection covering create → upload-url → PUT → confirm.
- **Milestone D1:** a photo can be uploaded to R2 via the API (Swagger/`.http`) and a session row exists.

### Day 2 — Pipeline, status stream & the risk step
- BullMQ queue + worker wiring; `validate` (face-api.js) and job enqueue on confirm.
- SSE `GET /status` (Redis subscribe); verified with the `test/e2e.mjs` `EventSource` consumer.
- `remove_bg` (remove.bg) and `skin_tone` (Sharp) steps, results persisted to R2/DB.
- **`portrait` (Replicate)** integration — the flagged risk — tested against the style
  references so we learn quality early.
- **Milestone D2:** live status streams end-to-end through skin-tone; a first illustrated
  portrait exists from a real photo.

### Day 3 — Compositing, hardening, docs, polish
- `composite` (Sharp): portrait onto scene template → preview JPG → `previewKey`; wire the
  `done` SSE event with the signed preview URL.
- Portrait-quality iteration (try alternate Replicate models per Section 13 if needed).
- Error handling: `error` SSE event with user-facing messages; `/preview` polling fallback verified.
- OpenAPI docs reviewed at `/docs`; README run instructions; deploy API to host (Railway/Render).
- Full end-to-end pass with real photo(s) via `test/e2e.mjs`; demo walkthrough on Swagger `/docs`.
- **Milestone D3 (Delivery):** upload → preview works end-to-end, API deployed, documented.

> If portrait quality is still below bar at end of Day 3, we ship the best achieved result
> **clearly labeled as pre-fine-tuning quality** (per the proposal's disclosure) with a
> documented failure mode to scope the fine-tuning phase — see Section 13.

---

## 11. Git & GitHub Workflow

- **Repo:** a dedicated GitHub repository for the prototype (name/visibility confirmed with
  client — recommend **private** for client work).
- **Branching:** trunk-based for a solo 3-day sprint. Short-lived feature branches per major
  piece (`feat/upload-loop`, `feat/pipeline`, `feat/portrait`, `feat/compositing`) merged to
  `main` via small commits; `main` stays runnable.
- **Commit cadence (the "timely commits" requirement):** commit at every working checkpoint
  — roughly per API endpoint, per pipeline step, per UI state. Conventional Commits style
  (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`). Each commit message states what
  and why. Target several commits per build session, not one giant end-of-day dump.
- **Tags/milestones:** tag `d1-upload-loop`, `d2-pipeline`, `d3-delivery` at each milestone.
- **Secrets never committed**; `.gitignore` covers `.env`, `node_modules`, build output,
  Prisma local artifacts, and R2/model caches.
- **Co-authorship** footer on commits as configured.

---

## 12. Testing & Acceptance Criteria (Definition of Done)

A capability is "done" only when its acceptance check passes on a **real** photo.

| Capability | Acceptance check |
|-----------|------------------|
| Upload | Photo lands in R2 under `sessions/{id}/raw`; session row `status=uploaded`. |
| Face validation | One-face photo passes; zero-face and multi-face photos fail with a clear message; below-min-resolution fails. |
| Background removal | `noBgKey` object has transparent background. |
| Skin tone | `skinToneHex` is a plausible skin-tone hex sampled from the face region. |
| Portrait | `portraitKey` is an illustrated, transparent-background character resembling the child (quality caveat per Section 13). |
| Compositing | `previewKey` JPG shows the character placed/scaled correctly in the scene template. |
| SSE status | `test/e2e.mjs` `EventSource` logs all five steps with the exact copy; `done`/`error` handled. |
| Preview | Final image renders in the UI; `/preview` returns the same signed URL. |
| API docs | `/docs` renders OpenAPI for every endpoint. |

**Test method (API-only):** scripted E2E via `test/e2e.http` (Swagger UI for interactive
runs) and `test/e2e.mjs` (automated pass with an `EventSource` SSE consumer), against a
fixture photo for repeatable QA. Automated unit tests are minimal by design for a 3-day
prototype — focused on the two pure functions worth locking down (skin-tone sampling,
compositing geometry).

---

## 13. Risk Register & Fallback Plan

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| **Portrait quality below bar** (off-the-shelf model, no fine-tune) — *the flagged risk* | Med–High | High | Front-loaded to Day 2. Try 2–3 alternate Replicate models (IP-Adapter, InstantID, PhotoMaker) before declaring blocked. Document exact failure mode (likeness loss / style mismatch / artifacts). Ship best result labeled pre-fine-tuning; scope fine-tuning precisely. |
| Client assets late (template, style refs, test photo) | Med | High (breaks 3-day timeline) | Requested at kickoff (Section 15); Day 1 has no hard dependency on them; portrait/composite (Day 2–3) do. Escalate immediately if not received by end of Day 1. |
| face-api.js accuracy too low | Low–Med | Med | Fallback to AWS Rekognition (`DetectFaces`) behind the same interface; swap is isolated to the `validate` step. |
| remove.bg free-tier limits / cost | Low | Low | Free credits sufficient for prototype QA volume; cache results; batch nothing. |
| Replicate cold starts / latency | Med | Low | Async job already tolerates minutes; SSE keeps user informed; poll with backoff. |
| SSE connection drops (proxies/timeouts) | Med | Low | `/preview` polling fallback + auto-reconnect on the `EventSource`. |
| Third-party account/keys blocked on client action | Med | Med | Section 9 lists exactly what's needed; I provide setup steps; I cannot create accounts or enter credentials for you. |

---

## 14. Deliverables Checklist (mapped to proposal)

- [ ] Photo upload (presigned, direct-to-R2)
- [ ] Face validation (single face + resolution/type)
- [ ] Background removal (remove.bg)
- [ ] Skin-tone extraction (Sharp)
- [ ] Portrait / illustrated-character generation (Replicate, off-the-shelf)
- [ ] Compositing onto scene template (Sharp)
- [ ] Live SSE status with the specified copy
- [ ] One final preview image
- [x] ~~Browser test UI~~ — **deferred** (client confirmed API-only, 2026-07-15); Swagger UI at `/docs` + `test/e2e.http` serve as the demo/QA surface
- [ ] Documented API (OpenAPI at `/docs`) — primary interface
- [ ] Deployed prototype (API) with a shareable Swagger `/docs` demo URL
- [ ] GitHub repo with timely, meaningful commit history
- [ ] This plan + README + architecture/API/risk docs

---

## 15. What I Need From You (kickoff blockers)

From the proposal's "What I need from you," due **as early as possible** to protect the 3-day
timeline:

1. **Scene template PNG** — one scene with a transparent placeholder region where the
   character is composited. (Needed by Day 2–3.)
2. **3–5 illustration style reference images** — to pick/tune the Replicate model to your
   art direction. (Needed by Day 2 — drives the risk step.)
3. **Confirm test UI scope** — browser test UI (recommended) **vs** API-only. Default: include the UI.
4. **One test photo of a child** — for our own QA before the demo (a stock/consented photo is fine).
5. **Service accounts / API keys** — Neon, Upstash, R2, remove.bg, Replicate (Section 9), or
   confirm you want me to set up the free-tier accounts under an account you own.
6. **GitHub** — desired repo name + **public or private** (recommend private) + which GitHub
   account owns it.

## 16. Explicitly Deferred to Later Phases

~~Multi-character compositing~~ — **pulled forward into scope, see §17** (2026-07-16).
Multi-page preview (the full 24-page/14-theme library) · Stripe cart/checkout · 300 DPI CMYK
print PDF + Gelato/Lulu integration · admin dashboard · GDPR deletion cron + audit log ·
auth/accounts · Resend transactional email · full next-intl i18n rollout beyond the single
test locale.

These are captured here so scope is transparent and nothing reads as "missing" — each is a
named Phase-2+ item, not an omission.

---

## 17. Multi-Character Pivot (2026-07-16)

Mid-build, the client sent reference material (screenshots of the Imagitime competitor app —
see decision log) revealing the real target architecture, and asked for two changes to the
originally-scoped single-character/"generate one preview" prototype:

1. **Don't regenerate a new image per page.** Imagitime's own claims (2-minute preview,
   24+ pages) only make sense if the expensive step — turning a real photo into an
   illustrated likeness — runs **once per child**, and each page is a fast compositing
   operation reusing pre-made artwork, not a full diffusion regeneration per page.
2. **True multi-character, now** — 2+ different real children combined in one scene,
   confirmed as a hard requirement (not deferred), even though Imagitime's own product only
   shows one recurring child across many page themes.

Confirmed with the client: no real template art exists yet (the client's screenshots weren't
usable artwork), so a placeholder template is being used, swappable later with no code
changes; today's target is proving the architecture at small scale (one template, two
character slots), not the full 24-page/14-theme library.

**Architecture:** Step A (per child, already-built `portrait` step) generates one stylized
reference portrait via the free HF Space. Step B (new `composite` step) crops that portrait's
face and blends it — via a soft feathered mask, not a hard-edged paste — onto a fixed
template's face slot using Sharp. No AI call for Step B, so adding pages later is cheap and
fast. Full reasoning (including why a literal ML face-swap tool wasn't used) is in the
approved plan and `apps/api/README.md`.

**Data model:** `Session` now has many `Character` (was 1:1); each `Character` has a `slot`
(matches a template face region) and its own `childName`. `Session.previewKey` holds the
final composited page.

**API:** `POST /api/sessions` now takes a `characters[]` array; upload endpoints move to
`/api/sessions/:id/characters/:characterId/upload-url|upload-confirm`; the pipeline enqueues
only once every character in the session has uploaded; SSE `status`/`error` events carry a
`slot` field.

**Template:** `assets/templates/two-children-park.png`, generated via the free
`black-forest-labs/FLUX.1-schnell` Hugging Face Space (no artist available yet). Its two face
slots were auto-detected with the existing blazeface model and hardcoded in `composite.ts`
(both faces were only found by detecting each half of the image separately — see
`apps/api/README.md` for why).

**Verification status:** the full pipeline (both characters through validate → portrait →
remove_bg → skin_tone → composite → done) was run successfully end-to-end once, proving the
architecture and multi-character mechanics work — but that run used the *first-pass* prompt
and compositing, which had visible quality issues (hard rectangular seams, stray
props/accessories bleeding into a crop from a too-elaborate generated scene). Both were fixed
(feathered-mask blending; a tightened headshot-only prompt), and the tightened prompt alone
was independently confirmed to produce a clean plain headshot.

A second **combined** confirmation run then failed repeatedly with a generic error at the
portrait step. Root-caused (after adding proper error logging — see `worker.ts`) to the real
cause: **the free HF Space runs on ZeroGPU, which gives anonymous/unauthenticated callers
only ~2 minutes of GPU quota per day** ([HF docs](https://huggingface.co/docs/hub/en/spaces-zerogpu)).
This session made 10+ calls to it while testing — comfortably enough to exhaust that quota,
after which the Space itself rejects further requests. This is **not a code or network bug**
— every individual piece (upload, call, poll, the generation itself) was independently
re-verified to work correctly right up until quota ran out. Two real, valuable fixes came out
of chasing this down regardless: an unhandled `ioredis` connection error was found to crash
the whole server (now has an error handler — see `src/redis.ts`), and worker step failures
now log their full error/cause to the console instead of only a generic message reaching the
SSE event (`src/worker.ts`), so this kind of root cause is immediately visible next time
without needing to re-derive it.

**Practical implication:** the anonymous free-tier path is fine for prototyping but not for
repeated demo/production use — 2 minutes/day is roughly 1-3 generations. Options if this
becomes a blocker: sign in with a free HF account for the API calls (3.5 min/day instead of
2 — a marginal improvement, not a fix), wait for the daily quota reset, or switch to a paid
model (Replicate version preserved in git history, or HF PRO at $9/mo for 25 min/day). **Once
today's quota resets, re-run `node test/e2e-multichar.mjs <photo1> child_1 <name1> <photo2>
child_2 <name2>` once** to get the final combined visual confirmation before a client demo —
expected to succeed cleanly based on every component's individual verification.

---

*Owner: Affan Ahmed · Prototype engagement (client confidential) · This document is versioned
in the repo and updated as the build progresses.*
