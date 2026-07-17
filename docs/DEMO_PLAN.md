# Demo plan — 3 templates × any real kid photo

**Goal:** for tomorrow's demo, personalize the 3 templates in `assets/templates/`
with any real child photo and get a good, cohesive result each time.

## The recipe (proven, cohesive — the one that looked right)

Per template: **repaint the whole scene as the kid (nano-banana) → face-swap for
identity.** Run it with:

```bash
cd apps/api
npx tsx demo/personalize.mts plane      ../../assets/test-photos/kid.png out-plane.png
npx tsx demo/personalize.mts astronaut  ../../assets/test-photos/kid.png out-astro.png
npx tsx demo/personalize.mts workshop   ../../assets/test-photos/kid.png out-work.png
```

- **Step 1 — `google/nano-banana`** repaints the whole illustration as the kid.
  It *sees the photo*, so **any kid works with one generic prompt — no per-kid
  hair/skin text.** It redraws cohesively, so there are **no seams or halos**.
  ~$0.039.
- **Step 2 — `codeplugtech/face-swap`** sharpens identity to exactly this child.
  ~$0.006.
- **~$0.045/image, 2 calls, ~20s.** Whole demo (3 images) ≈ $0.14.

`--no-swap` runs nano-banana only (1 call, ~$0.039, weaker identity).

## Why this and not the other approaches (do NOT re-litigate in the demo)

- **Masked inpainting (FLUX Fill) was a wrong turn.** It preserves the original
  art pixel-perfectly, but that is the wrong optimization here (the templates are
  competitor screenshots anyway). It left **visible seams and a bright halo**
  around the hair on open-background templates (the plane). The client rejected it.
- **flux-kontext (~$0.031)** is cheaper but **blind to the photo** (needs a written
  per-kid hair/skin description) and **broke art style on the astronaut** (flat
  cel-shaded face on a painterly body). Keep as a *production* cost-optimization to
  revisit with caching; not the demo path.
- **face-swap alone** can't touch hair/headband/skin-on-body — leaves the wrong
  hairstyle. Necessary for identity, not sufficient alone.

## Status per template

| template | file | status | note |
|---|---|---|---|
| plane | `temp_2.jpeg` | **proven** | nano-banana+swap looked great (the result the client loved). One artifact: original girl's pink headband survives the repaint (nano-banana keeps template accessories) — flag if client wants it gone |
| astronaut | `temp_1.jpeg` | **verified 2026-07-17** | nano-banana+swap works cleanly, strong identity in the helmet. No FLUX-Fill fallback needed |
| workshop | `WhatsApp Image ... (2).jpeg` | **verified 2026-07-17** | nano-banana+swap clean, strong identity; chrome crop now set (see below) |

**Done 2026-07-17:** ran all 3 with `kid.png` — all three look demo-ready (finals in
`apps/api/demo/output/demo-{plane,astronaut,workshop}.png`). Workshop crop set; astronaut
verified (no FLUX-Fill fallback needed). Also fixed two bugs in `demo/personalize.mts`
found on the first real swap run:
- The `replicate()` helper always wrapped its arg in `{ input }`, which is correct for the
  model-scoped nano-banana endpoint but broke the version-based `predictions` (face-swap) call
  (`version is required` 422). It now sends `{ version, input }` at top level when a `version`
  key is present. **The `--no-swap` path had hidden this — the swap had never actually been run
  through this script before.**
- Step 1's repaint is now written to `<out>.repaint.png` immediately, so a step-2 failure no
  longer wastes the ~$0.039 nano-banana call. Re-run just the swap with `--repaint-from <file>`.

## Chrome crops (competitor UI baked into pixels — must be cropped)

Set in `demo/personalize.mts` → `TEMPLATES`:
- **plane** `temp_2.jpeg`: `{left:0, top:112, width:810, height:649}` (verified)
- **astronaut** `temp_1.jpeg`: `{left:0, top:0, width:800, height:750}` (verified)
- **workshop** `WhatsApp Image ... (2).jpeg`: `{left:0, top:0, width:800, height:739}` (verified — removes the `>` carousel arrow; no top chrome on this one).

## Known limits / say-if-asked

- Identity is a strong *resemblance* at small face sizes, not a perfect lock
  (source photos are low-res; the swap has less to work with the smaller the face).
- **Licensing:** the face-swap model (InsightFace inswapper) is non-commercial/
  research licensed. Fine for a demo; must be resolved before selling.
- The 3 templates are competitor screenshots — real illustrator art is needed for
  a shippable product.
