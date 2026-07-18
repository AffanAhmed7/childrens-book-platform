import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { detectFaces, detectPageCharacters, cropBox } from "./faceDetect";
import type { BookPage } from "./templates";
import { mapWithConcurrency } from "./pool";
import { runReplicate, fetchToBuffer } from "./replicate";
import { REPAINT_PROMPT, type SceneTemplate } from "./scenes";
import type { CharacterInput, FaceBox } from "./types";

export class PersonalizeError extends Error {}

// The "scene" recipe: repaint the whole illustration as the child, then swap for
// exact identity, restore to blend swap artifacts, and heal any leftover specks.
// See docs/DEMO_PLAN.md for why this beats masked-inpaint / face-region-only.
//
// Model versions are pinned: the version-based /predictions endpoint requires it,
// and it stops behaviour drifting if an owner pushes an update.
const FACE_SWAP_VERSION = "278a81e7ebb22db98bcba54de985d22cc1abeead2754eb1f2af717247be69b34";
const CODEFORMER_VERSION = "cc4956dd26fa5a7185d5660cc9100fab1b8070a1d1654a8bb5eb6d443b020bb2";

const dataUri = (buf: Buffer, ext = "png") => `data:image/${ext};base64,${buf.toString("base64")}`;

// Repaint is the pipeline's expensive call (~$0.039, google/nano-banana billed
// per-image regardless of how many times the same template+photo pair is
// repainted). Dev/demo runs (npm run personalize) re-test the same photo against
// the same template repeatedly while tuning swap/restore/heal, so cache the
// repaint output on disk keyed by exactly what determines it: the cropped
// template bytes, the prompt, and the photo. In production this cache key never
// repeats — childPhotoUrl mints a fresh signed URL per call — so it doesn't fire
// there; production's dedup is worker.ts's page-level objectExists(key) skip,
// which already avoids ever re-paying for an already-rendered page.
const REPAINT_CACHE_DIR = path.resolve(process.cwd(), ".cache/repaint");

// nano-banana-2-lite is a cost/latency comparison candidate (~$0.0336/image,
// ~4s vs. nano-banana's ~$0.039/90-170s) — unverified on our painterly
// templates, so it's opt-in, not the default. See docs/DEMO_PLAN.md.
export type RepaintModel = "nano-banana" | "nano-banana-2-lite";

// google/nano-banana's `aspect_ratio` input defaults to "match_input_image", but
// `image_input` carries TWO images (the template crop AND the child's photo) and
// it resolves against the PHOTO. Measured on MC_1: a 0.80 portrait crop with a
// 1.50 photo returned a 1.50 landscape frame; nano-banana re-composed the scene
// to fill it and the face shrank from 32.7% to 19.8% of frame width, at which
// point the swap model's detector failed 5/5. A square photo on the same page
// distorted less and swapped fine. Left alone, whether a page renders depends on
// the shape of the selfie a parent happens to upload. Pinning the ratio to the
// template crop makes output geometry independent of the photo. The input is an
// enum, so snap to the nearest supported value.
const NANO_BANANA_RATIOS: ReadonlyArray<readonly [string, number]> = [
  ["1:1", 1], ["2:3", 2 / 3], ["3:2", 3 / 2], ["3:4", 3 / 4], ["4:3", 4 / 3],
  ["4:5", 4 / 5], ["5:4", 5 / 4], ["9:16", 9 / 16], ["16:9", 16 / 9], ["21:9", 21 / 9],
];

export function nearestAspectRatio(width: number, height: number): string {
  const target = width / Math.max(1, height);
  return NANO_BANANA_RATIOS.reduce((best, cur) =>
    Math.abs(cur[1] - target) < Math.abs(best[1] - target) ? cur : best,
  )[0];
}

async function templateAspectRatio(templateBuf: Buffer): Promise<string> {
  const meta = await sharp(templateBuf).metadata();
  return nearestAspectRatio(meta.width ?? 1, meta.height ?? 1);
}

function repaintCacheKey(templateBuf: Buffer, photoUri: string, model: RepaintModel): string {
  return createHash("sha256").update(model).update(REPAINT_PROMPT).update(templateBuf).update(photoUri).digest("hex");
}

/** Stage 1 — repaint the whole scene as this child (google/nano-banana by default). */
export async function repaintScene(templateBuf: Buffer, photoUri: string, model: RepaintModel = "nano-banana"): Promise<Buffer> {
  const cacheFile = path.join(REPAINT_CACHE_DIR, `${repaintCacheKey(templateBuf, photoUri, model)}.png`);
  try {
    const cached = await readFile(cacheFile);
    console.error(`[repaint] cache hit (${model}), skipping repaint call -> ${cacheFile}`);
    return cached;
  } catch {
    // Cache miss — fall through to the real call.
  }

  const url =
    model === "nano-banana-2-lite"
      ? await runReplicate("models/google/nano-banana-2-lite/predictions", {
          input: { prompt: REPAINT_PROMPT, images: [dataUri(templateBuf), photoUri], match_input_image: true, output_format: "png" },
        })
      : await runReplicate("models/google/nano-banana/predictions", {
          input: {
            prompt: REPAINT_PROMPT,
            image_input: [dataUri(templateBuf), photoUri],
            output_format: "png",
            aspect_ratio: await templateAspectRatio(templateBuf),
          },
        });
  const result = await fetchToBuffer(url);

  await mkdir(REPAINT_CACHE_DIR, { recursive: true });
  await writeFile(cacheFile, result);
  return result;
}

/** Stage 2 — sharpen identity to exactly this child (codeplugtech/face-swap).
 * noFaceRetries: 4 — this model's own face detector false-negatives ("No face
 * found") on some target/photo pairs far more than others; see runReplicate's
 * noFaceRetries doc. UNRESOLVED, not just mitigated: on MC_1.jpeg with photo
 * test-photos/3.jpg, one character's face has now failed roughly 17 of 18
 * real attempts, across many different repaint generations and crop-geometry
 * versions, including two full 5-attempt runs (this constant's retry budget)
 * that both failed all 5 — so 4 retries is NOT proven to reliably recover
 * this specific photo/character pairing; treat any success on it as fortunate,
 * not expected. The other character on the same page succeeds essentially
 * every time, so this isn't a crop/prompt regression — every other fix in
 * this file (crop overlap, limb bleed, aspect ratio, ghost-halo compositing)
 * is separately confirmed and unaffected by this. Root cause still open:
 * possibly this one photo, possibly this swap model being weaker on
 * children's faces generally — untested, needs one real repaint+swap trial
 * with a different child photo to distinguish. Retries are cheap insurance
 * for ordinary flakiness either way, just don't read a high retry count as a
 * reliability guarantee for every child photo. */
export async function swapIdentity(targetBuf: Buffer, photoUri: string): Promise<Buffer> {
  const url = await runReplicate(
    "predictions",
    { version: FACE_SWAP_VERSION, input: { input_image: dataUri(targetBuf), swap_image: photoUri } },
    4,
  );
  return fetchToBuffer(url);
}

/** Stage 3 — face restoration to blend the swap's "double-eye" ghost. High
 * codeformer_fidelity keeps it close to the painterly face (less photographic
 * drift); background_enhance off so only the face region is touched. */
export async function restoreFace(imageBuf: Buffer): Promise<Buffer> {
  const url = await runReplicate("predictions", {
    version: CODEFORMER_VERSION,
    input: { image: dataUri(imageBuf), codeformer_fidelity: 0.8, background_enhance: false, face_upsample: false, upscale: 1 },
  });
  return fetchToBuffer(url);
}

interface Speck {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  pixels: number; // count
}

/** 4-connected components of a bright-pixel mask, restricted to a region. */
function findClusters(bright: Uint8Array, W: number, x0: number, y0: number, x1: number, y1: number): Speck[] {
  const seen = new Uint8Array(bright.length);
  const specks: Speck[] = [];
  const stack: number[] = [];
  for (let sy = y0; sy < y1; sy += 1) {
    for (let sx = x0; sx < x1; sx += 1) {
      const start = sy * W + sx;
      if (!bright[start] || seen[start]) continue;
      let minX = sx, maxX = sx, minY = sy, maxY = sy, count = 0;
      stack.push(start);
      seen[start] = 1;
      while (stack.length) {
        const p = stack.pop() as number;
        const px = p % W, py = (p - px) / W;
        count += 1;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = px + dx, ny = py + dy;
          if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1) continue;
          const np = ny * W + nx;
          if (bright[np] && !seen[np]) {
            seen[np] = 1;
            stack.push(np);
          }
        }
      }
      specks.push({ minX, maxX, minY, maxY, pixels: count });
    }
  }
  return specks;
}

/** Median skin colour of the ring of non-bright pixels around a speck's bbox. */
function ringMedianColour(
  data: Buffer,
  W: number,
  H: number,
  C: number,
  bright: Uint8Array,
  s: Speck,
  ring: number,
): [number, number, number] | null {
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  let ringTotal = 0, ringDark = 0;
  for (let y = s.minY - ring; y <= s.maxY + ring; y += 1) {
    for (let x = s.minX - ring; x <= s.maxX + ring; x += 1) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const inBbox = x >= s.minX && x <= s.maxX && y >= s.minY && y <= s.maxY;
      if (inBbox) continue;
      const i = (y * W + x) * C;
      const r = data[i] ?? 0, g = data[i + 1] ?? 0, b = data[i + 2] ?? 0;
      ringTotal += 1;
      if (Math.min(r, g, b) < 70) ringDark += 1; // dark neighbour = edge of an eye/mouth, not skin
      if (bright[y * W + x]) continue; // sample skin tone from the non-bright ring pixels only
      rs.push(r); gs.push(g); bs.push(b);
    }
  }
  // Skin gate: heal only a speck that sits ON skin. A speck ringed by dark pixels
  // is an eye catchlight (dark iris) or a tooth highlight (dark mouth) — leave it.
  if (rs.length < 6 || ringTotal === 0 || ringDark / ringTotal > 0.5) return null;
  const mid = (arr: number[]) => arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)] ?? 0;
  const median: [number, number, number] = [mid(rs), mid(gs), mid(bs)];
  // Warm mid-tone sanity — never paint a bright/near-white or unnaturally cool patch.
  if (median[0] < median[2] || Math.min(...median) > 225) return null;
  return median;
}

/** A feathered elliptical patch of solid `colour`, sized to cover the speck. */
async function healPatch(colour: [number, number, number], s: Speck, pad: number): Promise<sharp.OverlayOptions> {
  const pw = s.maxX - s.minX + 1 + 2 * pad;
  const ph = s.maxY - s.minY + 1 + 2 * pad;
  const cx = pw / 2, cy = ph / 2, rx = pw / 2, ry = ph / 2;
  const rgba = Buffer.alloc(pw * ph * 4);
  for (let y = 0; y < ph; y += 1) {
    for (let x = 0; x < pw; x += 1) {
      const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
      const alpha = d >= 1 ? 0 : d < 0.55 ? 255 : Math.round(255 * (1 - (d - 0.55) / 0.45));
      const i = (y * pw + x) * 4;
      rgba[i] = colour[0]; rgba[i + 1] = colour[1]; rgba[i + 2] = colour[2]; rgba[i + 3] = alpha;
    }
  }
  const png = await sharp(rgba, { raw: { width: pw, height: ph, channels: 4 } }).png().toBuffer();
  return { input: png, left: s.minX - pad, top: s.minY - pad };
}

/**
 * Stage 4 — remove small bright swap artifacts (the "white dot under the eye")
 * generically, for any child. The swap can leave tiny near-white specks on the
 * face skin; CodeFormer preserves them. This finds the personalized face via
 * blazeface, protects the eyes / mouth / nose (their highlights are legitimate)
 * using the landmarks, then heals any remaining small near-white cluster on skin
 * with the median tone of the skin ringing it.
 *
 * Fail-safe by design: if no face or no landmarks are found, or nothing looks
 * like an artifact, the image is returned unchanged — it never invents an edit.
 */
export async function healSwapArtifacts(imageBuf: Buffer): Promise<Buffer> {
  const { faces } = await detectFaces(imageBuf);
  if (faces.length === 0) return imageBuf;
  // The personalized child is the most prominent face on the page.
  const face = [...faces].sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0];
  const lm = face?.landmarks;
  if (!face || !lm) return imageBuf; // without landmarks we can't protect eye/teeth highlights — don't risk it

  const { data, info } = await sharp(imageBuf).removeAlpha().toColorspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, C = info.channels;

  const fb = face.box;
  const x0 = Math.max(0, fb.left), x1 = Math.min(W, fb.left + fb.width);
  const y0 = Math.max(0, fb.top), y1 = Math.min(H, fb.top + fb.height);

  // The eyes are NOT protected by a distance disc: measured, the blazeface eye
  // landmark is ~14px off the actual catchlight, and swap artifacts (tear-track
  // streaks) sit only 3-11px below the eye — so any disc big enough to cover the
  // catchlight also swallows the artifact. The ring-skin gate (in ringMedianColour)
  // is the reliable discriminator instead: a real catchlight is ringed by dark iris
  // (protected), an artifact is ringed by skin (healed). Only the nose specular and
  // the teeth — bright features ringed by skin/lips, which the ring gate can't tell
  // from an artifact — still need an explicit disc.
  const eyeDist = Math.hypot(lm.leftEye.x - lm.rightEye.x, lm.leftEye.y - lm.rightEye.y) || fb.width * 0.3;
  const discs = [
    { x: lm.mouth.x, y: lm.mouth.y, r: eyeDist * 0.4 },
    { x: lm.noseTip.x, y: lm.noseTip.y, r: eyeDist * 0.25 },
  ];
  const protectedPx = (x: number, y: number) => discs.some((d) => Math.hypot(x - d.x, y - d.y) < d.r);

  // Near-white, low-saturation pixels on the face skin = candidate specks.
  const bright = new Uint8Array(W * H);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (protectedPx(x, y)) continue;
      const i = (y * W + x) * C;
      const r = data[i] ?? 0, g = data[i + 1] ?? 0, b = data[i + 2] ?? 0;
      const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
      if (mn > 200 && mx - mn < 40) bright[y * W + x] = 1;
    }
  }
  // Dilate by 1px so a streak fragmented by anti-aliasing heals as one clean patch
  // instead of a scatter of overlapping dots.
  const dilated = new Uint8Array(W * H);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (!bright[y * W + x]) continue;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx, ny = y + dy;
        if (nx >= x0 && nx < x1 && ny >= y0 && ny < y1) dilated[ny * W + nx] = 1;
      }
    }
  }

  // Keep only small clusters — real swap specks / tear-streaks are small; a large
  // bright blob is more likely a legitimate highlight we should leave alone.
  const specks = findClusters(dilated, W, x0, y0, x1, y1)
    .filter((s) => s.pixels >= 3 && s.pixels <= 200 && s.maxX - s.minX <= 40 && s.maxY - s.minY <= 40)
    .sort((a, b) => b.pixels - a.pixels)
    .slice(0, 15);
  if (specks.length === 0) return imageBuf;

  const overlays: sharp.OverlayOptions[] = [];
  for (const s of specks) {
    const colour = ringMedianColour(data, W, H, C, bright, s, 4);
    if (process.env.HEAL_DEBUG) {
      console.error(`speck bbox=[${s.minX},${s.minY},${s.maxX},${s.maxY}] px=${s.pixels} -> ${colour ? `HEAL ${colour}` : "reject"}`);
    }
    if (colour) overlays.push(await healPatch(colour, s, 3));
  }
  if (overlays.length === 0) return imageBuf;
  return sharp(imageBuf).composite(overlays).png().toBuffer();
}

// How far the eye patch reaches, as a multiple of the inter-eye distance. The
// swap's malformed iris is WIDER than the eye it replaced, so a patch sized to
// the eye alone leaves a brown crescent below it (measured on MC_3: clean only
// from ~0.65 x 0.58 up; 0.42 x 0.34 and 0.55 x 0.48 both left a visible ring).
const EYE_PATCH_RX = 0.65;
const EYE_PATCH_RY = 0.58;
const EYE_PATCH_FEATHER = 0.35; // fraction of the radius spent fading out

/**
 * Stage 5 — put the repaint's eyes back over the swap's.
 *
 * The swap model aligns the photo's face to the repaint's landmarks. On a
 * children's-book child those landmarks describe a large stylised eye, so the
 * photo's much smaller real eye lands inside it and the repaint's original iris
 * survives around the edge as a dark ring — the "small eye floating in a brown
 * disc" artifact. It is produced INSIDE the swap output, so it is not a
 * compositing bug here: CodeFormer cannot repair it at any fidelity (swept
 * 0.8/0.5/0.3/0.1 — it degrades, losing the pupil entirely by 0.1), and
 * healSwapArtifacts deliberately only touches NEAR-WHITE specks while this
 * artifact is dark.
 *
 * Painting the repaint's eye region back is the one lever that removes it
 * cleanly. The cost is honest and worth stating: the child keeps the
 * illustration's eye colour and shape rather than the photograph's, so identity
 * comes from face shape, skin and hair instead. Runs LAST so nothing downstream
 * can reintroduce the artifact.
 *
 * Fail-safe: no face or no landmarks means the image is returned untouched.
 */
export async function restoreEyeRegion(swappedBuf: Buffer, repaintBuf: Buffer): Promise<Buffer> {
  const { faces } = await detectFaces(swappedBuf);
  if (faces.length === 0) return swappedBuf;
  const face = [...faces].sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0];
  const lm = face?.landmarks;
  if (!face || !lm) return swappedBuf;

  const meta = await sharp(swappedBuf).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (W === 0 || H === 0) return swappedBuf;

  // The repaint is the same crop, but restore/heal upstream may have changed the
  // pixel grid — align defensively before sampling.
  const repaintRaw = await sharp(repaintBuf).resize(W, H, { fit: "fill" }).removeAlpha().toColourspace("srgb").raw().toBuffer();
  const swapRaw = await sharp(swappedBuf).removeAlpha().toColourspace("srgb").raw().toBuffer();

  const eyeDist = Math.hypot(lm.leftEye.x - lm.rightEye.x, lm.leftEye.y - lm.rightEye.y) || face.box.width * 0.3;
  const rx = eyeDist * EYE_PATCH_RX;
  const ry = eyeDist * EYE_PATCH_RY;

  const out = Buffer.from(swapRaw);
  for (const eye of [lm.leftEye, lm.rightEye]) {
    const x0 = Math.max(0, Math.floor(eye.x - rx));
    const x1 = Math.min(W, Math.ceil(eye.x + rx));
    const y0 = Math.max(0, Math.floor(eye.y - ry));
    const y1 = Math.min(H, Math.ceil(eye.y + ry));
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const d = Math.hypot((x - eye.x) / rx, (y - eye.y) / ry);
        if (d >= 1) continue;
        const a = d < 1 - EYE_PATCH_FEATHER ? 1 : (1 - d) / EYE_PATCH_FEATHER;
        const i = (y * W + x) * 3;
        for (let c = 0; c < 3; c += 1) {
          out[i + c] = Math.round((swapRaw[i + c] ?? 0) * (1 - a) + (repaintRaw[i + c] ?? 0) * a);
        }
      }
    }
  }
  return sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

export interface PersonalizeSceneOptions {
  swap?: boolean; // default true
  restore?: boolean; // default true (only runs when swap ran)
  heal?: boolean; // default true (only runs when swap ran)
  eyeFix?: boolean; // default true (only runs when swap ran) — see restoreEyeRegion
  repaintModel?: RepaintModel; // default "nano-banana"
  // Called after each stage with a copy of the intermediate — lets a CLI save
  // debug frames without the engine knowing about the filesystem.
  onStage?: (stage: "repaint" | "swap" | "restore" | "heal" | "eyes", image: Buffer) => void | Promise<void>;
}

/**
 * The recipe, on any in-memory crop: repaint the whole buffer as this child,
 * then (optionally) swap for exact identity, restore to blend swap artifacts,
 * and heal any leftover specks.
 *
 * @param templateBuf the art to repaint (a whole scene, or a crop of one)
 * @param photoUri    URL or data URI of the child's photo (the face source)
 */
export async function personalizeBuffer(
  templateBuf: Buffer,
  photoUri: string,
  opts: PersonalizeSceneOptions = {},
): Promise<Buffer> {
  const { swap = true, restore = true, heal = true, eyeFix = true, repaintModel = "nano-banana", onStage } = opts;

  let result = await repaintScene(templateBuf, photoUri, repaintModel);
  await onStage?.("repaint", result);

  if (swap) {
    // Kept for restoreEyeRegion — it needs the pre-swap eyes to paint back.
    const repainted = result;
    result = await swapIdentity(result, photoUri);
    await onStage?.("swap", result);

    if (restore) {
      result = await restoreFace(result);
      await onStage?.("restore", result);
    }
    if (heal) {
      result = await healSwapArtifacts(result);
      await onStage?.("heal", result);
    }
    // Last, so neither restore nor heal can reintroduce the iris ring.
    if (eyeFix) {
      result = await restoreEyeRegion(result, repainted);
      await onStage?.("eyes", result);
    }
  }

  return result;
}

/**
 * Personalizes one scene template with one child's photo, end to end. Thin
 * wrapper around personalizeBuffer for the demo CLI, which works from a local
 * template file + photo bytes rather than an already-loaded page/crop.
 *
 * @param scene    a SceneTemplate from scenes.ts (carries the chrome crop)
 * @param photoBuf the child's photo bytes
 * @param photoExt "png" | "jpeg" (how to tag the data URI handed to the models)
 */
export async function personalizeScene(
  scene: SceneTemplate,
  photoBuf: Buffer,
  photoExt: "png" | "jpeg",
  opts: PersonalizeSceneOptions = {},
): Promise<Buffer> {
  let templateBuf: Buffer = await readFile(scene.imagePath);
  if (scene.crop) templateBuf = await sharp(templateBuf).extract(scene.crop as FaceBox).png().toBuffer();
  return personalizeBuffer(templateBuf, dataUri(photoBuf, photoExt), opts);
}

// How much wider than a face-swap crop (cropBox's 1.1x default) a repaint crop
// needs to be: repaint redraws hair and visible skin, not just the face, so it
// needs the child's whole head and some shoulder/arm in frame. Bigger than the
// swap-only crop, short of tone.ts's characterRegion (which was sized to grab
// hands/arms for colour sampling, not to bound a redraw).
const REPAINT_CROP_PADDING_X = 1.8;
const REPAINT_CROP_PADDING_Y = 2.2;

// How much of the gap to a horizontal neighbour a crop is allowed to reach
// into, as a fraction of the gap between the two faces. NOT 0.5 (the
// midpoint): measured on MC_1.jpeg (417x502, faces ~78px, 72px face-to-face
// gap), a raised hand reaching toward the other character starts ~20px into
// the gap from the near face's edge (~28% of the gap) — well short of the
// midpoint. At the midpoint clamp, the repaint crop for the boy caught the
// man's fingertips; nano-banana's repaint then hallucinated a second,
// partial head from that fragment (same hairstyle as the real boy, cut off
// at the crop edge), and the swap model's face detector picked between the
// two inconsistently — "Couldn't find a usable face" on 4 of 5 real repaint+
// swap attempts against the exact same crop. 0.25 was confirmed clean by
// bisecting the actual crop width against that hand (safe up to ~198px,
// artifact visible at 200px; 0.25 of the 72px gap lands at 196px).
const NEIGHBOR_CLAIM_FRACTION = 0.25;

// The proven single-character scenes (scenes.ts SCENES) all crop landscape or
// square — astronaut 800x750 (1.07), workshop 800x739 (1.08), plane 810x649
// (1.25) — never taller than wide. A standing character clamped tight against
// a neighbour is the opposite: cropBox's Y padding (2.2x face height) is
// unconstrained by a neighbour the way X is, so on MC_1.jpeg the clamped crop
// came out 196x470 — ratio 0.42, over twice as tall as the widest proven crop
// is narrow. nano-banana returned visibly inconsistent output geometry on it
// (896x1152 for this crop vs. a clean 1024x1024 square for the unclamped
// neighbour) and hallucinated a small unexplained artifact near the horizon —
// then the swap model's face detector failed on 8 of 10 real attempts against
// several different repaints of this same crop, vs. the square neighbour
// crop succeeding essentially every time. Capping height to width kept in the
// proven range fixes the shape without touching NEIGHBOR_CLAIM_FRACTION.
const MAX_HEIGHT_TO_WIDTH = 1.25;

/**
 * The repaint crop for one drawn character, bounded so it can never reach a
 * neighbouring character's face — or, close enough, their gesturing hand —
 * and shaped like the crops the recipe is actually proven on.
 *
 * The padding in cropBox is generous by design — repaint redraws hair and
 * shoulders, not just the face. On a page where characters stand close
 * together that padding overruns the neighbour, and a crop holding any hint
 * of a second character has no defined behaviour: REPAINT_PROMPT describes a
 * single child ("Redraw the illustrated child"), and swapIdentity picks a
 * face on its own. Measured on MC_1.jpeg, the unclamped crops were 318px and
 * 302px wide and each contained BOTH characters' full faces, overlapping
 * across half the page.
 *
 * Clamping each crop to NEIGHBOR_CLAIM_FRACTION of the gap to its horizontal
 * neighbours keeps well clear of a neighbour's face and their outstretched
 * limbs. Capping the resulting height to MAX_HEIGHT_TO_WIDTH x that (now
 * possibly narrow) width, split evenly above/below the face's own vertical
 * centre, keeps the crop's proportions in the range the recipe is proven on
 * instead of an extreme portrait sliver. This exact split (centred, not
 * biased toward more headroom) is the one CONFIRMED end-to-end on MC_1.jpeg —
 * both characters swapped successfully first try. A later attempt to bias
 * more room above the face (to fix an unrelated feather-seam cosmetic issue,
 * see cropOverlay) changed what nano-banana/the swap model actually received
 * and swap reliability regressed — reverted. Any future change to this split
 * needs its own full repaint+swap re-verification, not just a visual check;
 * fix cosmetic seam issues in cropOverlay instead, which only touches how the
 * finished result is blended back in and can never affect what gets sent to
 * the API. Horizontal clamp only: detectPageCharacters sorts left-to-right
 * and book pages place characters side by side, so a vertical neighbour
 * clamp would be untested generality.
 */
export function characterCrop(face: FaceBox, faces: FaceBox[], width: number, height: number): FaceBox {
  const crop = cropBox(face, width, height, REPAINT_CROP_PADDING_X, REPAINT_CROP_PADDING_Y);
  const faceRight = face.left + face.width;
  let left = crop.left;
  let right = crop.left + crop.width;

  for (const other of faces) {
    if (other === face) continue;
    const otherRight = other.left + other.width;
    if (otherRight <= face.left) {
      const gap = face.left - otherRight;
      left = Math.max(left, Math.round(face.left - gap * NEIGHBOR_CLAIM_FRACTION)); // neighbour to the left
    } else if (other.left >= faceRight) {
      const gap = other.left - faceRight;
      right = Math.min(right, Math.round(faceRight + gap * NEIGHBOR_CLAIM_FRACTION)); // neighbour to the right
    }
  }
  const cropWidth = Math.max(1, right - left);

  let top = crop.top;
  let bottom = crop.top + crop.height;
  const maxHeight = cropWidth * MAX_HEIGHT_TO_WIDTH;
  if (bottom - top > maxHeight) {
    const faceCenterY = face.top + face.height / 2;
    top = Math.max(0, Math.round(faceCenterY - maxHeight / 2));
    bottom = Math.min(height, Math.round(faceCenterY + maxHeight / 2));
  }

  return { left, top, width: cropWidth, height: Math.max(1, bottom - top) };
}

// A page may have more crop/repaint calls in flight than PAGE_CONCURRENCY
// pages are already running — cap per-page character concurrency too so a
// pathological many-character page can't spike total in-flight Replicate calls.
const CHARACTER_CONCURRENCY = 3;

/**
 * Feathers a finished (repainted) crop back onto its rectangular slot: full
 * opacity in the middle, fading to transparent within a margin of each edge.
 * Wider than the old face-only ellipse the swap-only pipeline used, because
 * repaint changes hair/skin over the whole crop, not just the face.
 *
 * `fit: "cover"` (scale to fill, centre-cropping the overhang), not "fill":
 * nano-banana doesn't preserve the input crop's aspect ratio (a 185x232,
 * ratio-0.80 input crop came back a flat 1024x1024 square on MC_1.jpeg).
 * "fill" would stretch/squish that mismatch to force an exact fit, warping
 * proportions and shifting the head off the position the crop was measured
 * for. "cover" keeps proportions correct and, since nano-banana keeps the
 * face roughly centred in its own output, keeps the centre-cropped face
 * aligned with where the slot expects it.
 *
 * The top margin is much smaller than the other three sides. The crop's top
 * edge sits well above the character's face (headroom for hair — see
 * characterCrop), but repaint redraws hair a different colour/volume than the
 * original illustration's, so the original and repainted hair silhouettes
 * don't occupy the same pixels near that edge. A 15%-margin fade there blends
 * partially-transparent ORIGINAL content with partially-transparent REPAINTED
 * content across the whole band — confirmed as a visible ghost/double-exposure
 * halo above the character's head on MC_1.jpeg. A near-hard cut (small fixed
 * margin) avoids the blend entirely: outside the crop is the unchanged
 * original background, inside is fully the repainted character, and the seam
 * itself sits in what is, in every case observed so far, plain background.
 *
 * The SAME tight margin applies to left/right, not just top: characterCrop's
 * neighbour clamp pulls the crop in close on whichever side faces another
 * character, so that character's own face and hands end up close to that
 * edge too — on MC_1.jpeg the man's crop is clamped tight against the boy's
 * side, and his face/raised hand sat inside the wide 15% left-margin fade,
 * showing the identical ghost/double-edge next to his face and waving arm.
 * Only the bottom margin stays generous: it fades into torso/clothing, which
 * repaint leaves unchanged (REPAINT_PROMPT), so there's no silhouette
 * mismatch to blend there and a wide, smooth fade is safe.
 *
 * NOT changed: crop geometry (characterCrop) — that governs what nano-banana
 * and the swap model actually receive, already reverified end-to-end; this
 * function only touches how the finished result is blended into the page, so
 * it's free to iterate on without any risk to swap reliability.
 */
async function cropOverlay(finishedCrop: Buffer, crop: FaceBox): Promise<sharp.OverlayOptions> {
  const normalized = await sharp(finishedCrop)
    .resize(crop.width, crop.height, { fit: "cover", position: "centre" })
    .ensureAlpha()
    .toBuffer();

  const marginTight = (size: number) => Math.max(4, Math.round(size * 0.04));
  const marginLeft = marginTight(crop.width);
  const marginRight = marginTight(crop.width);
  const marginTop = marginTight(crop.height);
  const marginBottom = Math.max(4, Math.round(crop.height * 0.15));
  const edgeFade = (pos: number, size: number, marginStart: number, marginEnd: number) => {
    if (pos < marginStart) return pos / marginStart;
    if (pos > size - marginEnd) return (size - pos) / marginEnd;
    return 1;
  };

  const rgba = Buffer.alloc(crop.width * crop.height * 4);
  const { data: src, info } = await sharp(normalized).raw().toBuffer({ resolveWithObject: true });
  for (let y = 0; y < crop.height; y += 1) {
    const fy = edgeFade(y, crop.height, marginTop, marginBottom);
    for (let x = 0; x < crop.width; x += 1) {
      const fx = edgeFade(x, crop.width, marginLeft, marginRight);
      const si = (y * crop.width + x) * info.channels;
      const di = (y * crop.width + x) * 4;
      rgba[di] = src[si] ?? 0;
      rgba[di + 1] = src[si + 1] ?? 0;
      rgba[di + 2] = src[si + 2] ?? 0;
      rgba[di + 3] = Math.round(255 * Math.max(0, Math.min(1, fx * fy)));
    }
  }
  const png = await sharp(rgba, { raw: { width: crop.width, height: crop.height, channels: 4 } }).png().toBuffer();
  return { input: png, left: crop.left, top: crop.top };
}

/**
 * Personalizes one book page with any number of drawn characters, end to end.
 *
 * One drawn character: the whole page is repainted directly (proven — same
 * recipe as the single-character demo templates), no compositing needed.
 *
 * More than one: each drawn character gets its own generous crop, repainted
 * and swapped individually against their own photo (so every child keeps the
 * fully-proven single-child prompt/recipe), then the finished crops are
 * feathered back onto the original page background. VERIFIED end-to-end on
 * MC_1.jpeg and MC_2.jpeg (2026-07-18) — see characterCrop and cropOverlay
 * for the crop-geometry and compositing fixes that got it there, and
 * swapIdentity's noFaceRetries doc for the one still-open reliability risk
 * (not a bug in this function — a specific child photo's swap success rate
 * against the third-party face-swap model).
 */
export async function personalizePage(
  page: BookPage,
  characters: CharacterInput[],
  opts: PersonalizeSceneOptions = {},
): Promise<Buffer> {
  const original = await readFile(page.imagePath);

  const drawnFaces = await detectPageCharacters(original, page.expectedCharacterCount);
  if (drawnFaces.length === 0) {
    throw new PersonalizeError(`No character face detected on page "${page.id}".`);
  }

  const slotOrder = page.slots ?? characters.map((c) => c.slot);
  const assignments: { face: FaceBox; character: CharacterInput }[] = [];
  for (let i = 0; i < drawnFaces.length; i += 1) {
    const slot = slotOrder[i];
    const character = slot ? characters.find((c) => c.slot === slot) : undefined;
    const face = drawnFaces[i];
    if (character && face) assignments.push({ face, character });
  }
  if (assignments.length === 0) {
    throw new PersonalizeError(`No character on page "${page.id}" maps to an uploaded child.`);
  }

  if (assignments.length === 1) {
    const only = assignments[0] as { face: FaceBox; character: CharacterInput };
    return personalizeBuffer(original, only.character.photoUrl, opts);
  }

  const meta = await sharp(original).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  const allFaces = assignments.map((a) => a.face);
  const overlays = await mapWithConcurrency(assignments, CHARACTER_CONCURRENCY, async ({ face, character }) => {
    const crop = characterCrop(face, allFaces, width, height);
    const cropBuffer = await sharp(original).extract(crop).png().toBuffer();
    const finished = await personalizeBuffer(cropBuffer, character.photoUrl, opts);
    return cropOverlay(finished, crop);
  });

  return sharp(original).ensureAlpha().composite(overlays).png().toBuffer();
}
