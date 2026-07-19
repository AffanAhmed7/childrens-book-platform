# Demo runbook

How to run the personalization demo, written for someone who has never touched
this repo. Two pipelines, both real — what you see is genuine model output.

- **Single character** — one photo becomes three different scenes.
- **Multi character** — two photos become two pages, each with two people on it,
  detected and personalized independently.

---

## 1. One-time setup

```bash
npm install                # from the repo root
cd apps/api
cp .env.example .env       # then edit it (see below)
```

You need **one** secret in `apps/api/.env`:

```
REPLICATE_API_TOKEN=r8_your_token_here
```

Get it from https://replicate.com/account/api-tokens. The account must have
credit — see Troubleshooting.

Node 20+ required (`node -v`).

### You need to supply your own photos

`assets/test-photos/` is **intentionally empty in git** — it held photos of a real
child, and consent-sensitive images do not belong in a repository. Nothing is
broken; you just need to bring your own.

Put two photos there before testing (any names — these are only used by the CLI
examples in section 7):

- one **child** photo → used for single-character scenes, and as the LEFT
  character in multi-character pages
- one **adult** photo → used as the RIGHT character in multi-character pages

Best results: front-facing, well lit, one clear face, no sunglasses. The web UI
takes photos straight from your computer, so it needs nothing in this folder.

---

## 2. The web demo (use this in front of a client)

```bash
cd apps/api
npm run demo:web
```

Open **http://localhost:5174**.

- Pick a tab: *Single character* or *Two characters*.
- Drop in a photo (JPEG or PNG). Multi mode takes two — **left character first,
  then right**. On both current pages that means the child first, the adult second.
- Hit **Generate**. Each scene shows its live stage and a running clock; the
  page shows an estimated total.
- Click any finished image to enlarge, or use *Download full size*.

It works with **any** person's photo — nothing is hard-coded to a particular face.

### How long it takes

| Mode | Scenes | Budget for |
|---|---|---|
| Single character | plane, astronaut, workshop | **3–5 minutes** |
| Multi character | mc_2, mc_3 | **3–4 minutes** |

Scenes run in parallel (3 at a time), so total time is roughly the slowest
scene rather than the sum — but parallel scenes contend for the same Replicate
account, so it scales worse than you would hope. A measured multi-character run
took **3:00**.

Two things make YOUR first run slower than any number quoted here:

- **No cache.** `apps/api/.cache/` is gitignored, so a fresh clone re-generates
  every repaint from scratch. Re-running the same photo and scene afterwards is
  much faster and free.
- **Cold start.** The first request loads the face-detection model.

**That is a long silence in a meeting.** Do a throwaway run before the client
arrives — it warms the cache and confirms your token works. Then either talk
through the stages while it runs (section 4) or present the pre-generated
images instead.

---

## 3. The safety net — pre-generated images

`apps/api/demo/keep-demo/` is committed to the repo and needs **no API, no
network, no credit**. If anything at all goes wrong, open these:

| File | What it is |
|---|---|
| `STATUS-all.png` | Everything at a glance — all 5 pages. Best single opener. |
| `MULTI-before-after.png` | Template art vs personalized, both multi pages. Strongest asset. |
| `plane/astronaut/workshop.png` | Single-character scenes (source photo: `assets/test-photos/kid.png`) |
| `mc_2.png`, `mc_3.png` | Multi-character pages (sources: `3.jpg` + `man.png`) |

**If you only have five minutes and one shot, present these and don't generate
live.** They are real pipeline outputs, not mockups.

---

## 4. Suggested flow

1. **Open on `STATUS-all.png`** full-screen. Say nothing for a beat. Let them look.
2. **The pitch.** One ordinary photo in; the whole illustration is repainted as
   that person — not a face pasted into a hole. Point at the astronaut: the skin
   tone carries to the hands, the art style is untouched.
3. **Then `MULTI-before-after.png`.** Two people on one page, each detected and
   personalized separately. The white-haired old man becomes a young man. That is
   the harder engineering and the better story.
4. **Live run, only if the room can absorb ~3 minutes.** Take a photo on the
   spot, run *Single character*, and narrate the stages while it works:
   repaint → face match → blend → clean up → eyes.

**Lead with the astronaut** if you can only show one single-character scene, and
**mc_3 (the cover)** for multi.

---

## 5. Known rough edges — steer around these

Be aware of these; don't volunteer them, but don't be caught out either.

- **Hair length.** The repaint tends to lengthen short hair into a chin-length
  bob. Visible on plane and workshop. The astronaut's helmet hides it — another
  reason to lead with astronaut.
- **Don't zoom into eyes** on mc_3. The two irises are slightly different colours.
- **Don't zoom into hands** on workshop; they read slightly paler than the face.
- **Eye colour on multi pages** comes from the illustration, not the photo. The
  likeness carries through face shape, skin tone and hair. This is a deliberate
  trade — see `restoreEyeRegion` in `src/pipeline/stages/eyes.ts`.
- **Every run is non-deterministic.** The same photo and scene will not reproduce
  a previous result. If you get a good one, save it immediately.
- **Photos work best** front-facing, well-lit, one clear face. Sunglasses, heavy
  shadow or extreme angles raise the failure rate.

---

## 6. Troubleshooting

**`402 Insufficient credit`** — the Replicate account is out of money. Nothing in
the code can fix this. Top up at https://replicate.com/account/billing#billing
and wait a few minutes. Fall back to section 3.

**`Couldn't find a usable face in the photo or the artwork`** — the face-swap
model could not read a face. Retry once; if it persists, use a different photo
(front-facing, well lit). This is the least reliable step in the pipeline.

**Port 5174 already in use** — `set DEMO_WEB_PORT=5180` (Windows) or
`DEMO_WEB_PORT=5180` (macOS/Linux) before `npm run demo:web`.

**It hangs with no progress** — check the terminal running `npm run demo:web`;
Replicate errors surface there.

---

## 7. Command-line alternative

The same pipelines without the browser. Output lands in `apps/api/demo/output/`.

Replace `<child.jpg>` / `<adult.jpg>` with your own photos (see section 1 —
`assets/test-photos/` ships empty on purpose).

One command drives everything — `--page` picks which page(s), and the page's own
character count decides whether it needs one photo or two.

```bash
cd apps/api

# Every page
npm run personalize -- ../../assets/test-photos/<child.jpg>

# One page, with intermediate stage frames
npm run personalize -- ../../assets/test-photos/<child.jpg> --page astronaut --debug

# A two-character page (child photo FIRST, then adult — left to right)
npm run personalize -- ../../assets/test-photos/<child.jpg> ../../assets/test-photos/<adult.jpg> --page mc_2

# Free: check face detection and crops without spending any credit
npm run personalize -- ../../assets/test-photos/<child.jpg> ../../assets/test-photos/<adult.jpg> --page mc_2 --detect-only
```

Page ids are `astronaut`, `plane`, `workshop` (one child) and `mc_2`, `mc_3`
(two children), or `all`. They are defined in `apps/api/src/pipeline/catalog.ts`.

`--detect-only` costs nothing and is the right way to sanity-check a new template
before spending money on it.

> **`apps/api/demo/output/` is gitignored and every run overwrites in place.**
> Copy anything worth keeping into `demo/keep-demo/` before regenerating.

---

## 8. What it costs

Roughly **4–6 cents per scene** (one nano-banana repaint plus a face swap). A
full single-character run is about 15 cents; a multi-character page about 10.
Repaints are cached on disk in `apps/api/.cache/`, so re-running the same photo
and scene is free.
