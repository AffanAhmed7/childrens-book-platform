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

| Mode | Scenes | Realistic wall time |
|---|---|---|
| Single character | plane, astronaut, workshop | **~3 minutes** |
| Multi character | mc_2, mc_3 | **~2.5 minutes** |

Scenes run in parallel (3 at a time), so total time is roughly the slowest
scene, not the sum. The countdown in the UI uses measured averages.

**That is a long silence in a meeting.** Plan for it — talk through the stages
while it runs (see section 4), or present the pre-generated images instead.

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
  trade — see `restoreEyeRegion` in `src/pipeline/scene.ts`.
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

```bash
cd apps/api

# Single character — all three scenes
npx tsx demo/personalize-scene.mts ../../assets/test-photos/kid.png

# Just one scene, with intermediate stage frames
npx tsx demo/personalize-scene.mts <photo> --scene astronaut --debug

# Multi character — both pages (child photo first, then adult)
npx tsx demo/personalize-book.mts ../../assets/test-photos/3.jpg ../../assets/test-photos/man.png

# Free: check face detection and crops without spending any credit
npx tsx demo/personalize-page.mts ../../assets/templates/MC_2.jpeg <photo1> <photo2> --detect-only
```

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
