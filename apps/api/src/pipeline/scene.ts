import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { detectFaces } from "./faceDetect";
import { runReplicate, fetchToBuffer } from "./replicate";
import { REPAINT_PROMPT, type SceneTemplate } from "./scenes";
import type { FaceBox } from "./types";

// The "scene" recipe: repaint the whole illustration as the child, then swap for
// exact identity, restore to blend swap artifacts, and heal any leftover specks.
// See docs/DEMO_PLAN.md for why this beats masked-inpaint / face-region-only.
//
// Model versions are pinned: the version-based /predictions endpoint requires it,
// and it stops behaviour drifting if an owner pushes an update.
const FACE_SWAP_VERSION = "278a81e7ebb22db98bcba54de985d22cc1abeead2754eb1f2af717247be69b34";
const CODEFORMER_VERSION = "cc4956dd26fa5a7185d5660cc9100fab1b8070a1d1654a8bb5eb6d443b020bb2";

const dataUri = (buf: Buffer, ext = "png") => `data:image/${ext};base64,${buf.toString("base64")}`;

// Repaint is the pipeline's expensive, slow call (~$0.039, 90-170s — google/nano
// -banana billed per-image regardless of how many times the same template+photo
// pair is repainted). Dev/demo runs (npm run personalize) re-test the same photo
// against the same template repeatedly while tuning swap/restore/heal, so cache
// the repaint output on disk keyed by exactly what determines it: the cropped
// template bytes, the prompt, and the photo. Not used by the production per-page
// pipeline (personalize.ts), which never calls repaintScene.
const REPAINT_CACHE_DIR = path.resolve(process.cwd(), ".cache/repaint");

// nano-banana-2-lite is a cost/latency comparison candidate (~$0.0336/image,
// ~4s vs. nano-banana's ~$0.039/90-170s) — unverified on our painterly
// templates, so it's opt-in, not the default. See docs/DEMO_PLAN.md.
export type RepaintModel = "nano-banana" | "nano-banana-2-lite";

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
          input: { prompt: REPAINT_PROMPT, image_input: [dataUri(templateBuf), photoUri], output_format: "png" },
        });
  const result = await fetchToBuffer(url);

  await mkdir(REPAINT_CACHE_DIR, { recursive: true });
  await writeFile(cacheFile, result);
  return result;
}

/** Stage 2 — sharpen identity to exactly this child (codeplugtech/face-swap). */
export async function swapIdentity(targetBuf: Buffer, photoUri: string): Promise<Buffer> {
  const url = await runReplicate("predictions", {
    version: FACE_SWAP_VERSION,
    input: { input_image: dataUri(targetBuf), swap_image: photoUri },
  });
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

export interface PersonalizeSceneOptions {
  swap?: boolean; // default true
  restore?: boolean; // default true (only runs when swap ran)
  heal?: boolean; // default true (only runs when swap ran)
  repaintModel?: RepaintModel; // default "nano-banana"
  // Called after each stage with a copy of the intermediate — lets a CLI save
  // debug frames without the engine knowing about the filesystem.
  onStage?: (stage: "repaint" | "swap" | "restore" | "heal", image: Buffer) => void | Promise<void>;
}

/**
 * Personalizes one scene template with one child's photo, end to end.
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
  const { swap = true, restore = true, heal = true, repaintModel = "nano-banana", onStage } = opts;

  let templateBuf: Buffer = await readFile(scene.imagePath);
  if (scene.crop) templateBuf = await sharp(templateBuf).extract(scene.crop as FaceBox).png().toBuffer();
  const photoUri = dataUri(photoBuf, photoExt);

  let result = await repaintScene(templateBuf, photoUri, repaintModel);
  await onStage?.("repaint", result);

  if (swap) {
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
  }

  return result;
}
