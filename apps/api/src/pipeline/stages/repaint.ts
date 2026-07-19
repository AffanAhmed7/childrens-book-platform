import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { runReplicate, fetchToBuffer } from "../replicate";
import { dataUri } from "../dataUri";

// STAGE 1 of 5 — redraw the whole illustration as this child.
//
// This is the stage that does the real work. nano-banana SEES the photograph, so
// one generic prompt personalizes any child with no per-child hair/skin text, and
// because it redraws the artwork cohesively there are no seams or halos. The
// later stages only clean up after it.
//
// It is also the expensive stage (~$0.039/image) and the slow one (~90-170s).

export type RepaintModel = "nano-banana" | "nano-banana-2-lite";

// The single generic repaint prompt. Every clause here was added to fix a
// specific observed failure, so treat it as tuned configuration rather than
// prose — and note that prompt hardening has repeatedly FAILED to control the
// child's facial geometry (hair length, eyebrows, eye size all resisted it).
// Eye size in particular is fixed downstream by the eyes stage, not here.
// Changing this text busts the repaint cache, since it is part of the cache key.
export const REPAINT_PROMPT = `The first image is a children's book illustration of a child. The second image is a photograph of a real child. Redraw the illustrated child so they clearly and recognisably become the specific child in the photograph.

CHANGE these to match the photograph exactly:
- FACE: same face shape, features, skin tone and proportions as the photo, so it is unmistakably this specific child (keep a warm children's-book expression). The face must be anatomically correct and clean: exactly two eyes and exactly one eyebrow per eye, each a single unbroken shape. Do NOT draw a second, faint, offset or overlapping eyebrow above or near the real one, and do NOT draw a second, ghosted or partially-transparent eye near the real one — these are mistakes to actively avoid, not a style choice.
- EYE SIZE (most important): copy the eye size and shape directly from the photograph. Each eye must be roughly ONE FIFTH of the face's width — the proportion in a real human face — and the coloured iris must be a small circle, not a large glossy disc. Large round eyes spanning a third or more of the face width are WRONG. This applies with FULL FORCE to children: a child's eyes in this illustration must be the same realistic size as the child's eyes in the photograph, NOT the large cute cartoon eyes a children's book would normally use, and NOT the eye size in the original illustration. If the original illustration draws this character with big round anime or chibi eyes, deliberately shrink them to realistic human proportions.
- OTHER FACIAL PROPORTIONS: the nose and mouth must be clearly drawn and properly defined, not shrunk to tiny marks, and the head, jaw and cheek shape must follow real human proportions rather than a rounded cartoon ball. Together with the eye rule above this overrides the art-style match below, for facial geometry only.
- SKIN TONE: match the child's skin colour from the photo across ALL visible skin — face, ears, neck, hands, fingers and arms. Every visible hand and finger, including ones gripping, holding or touching an object, must be repainted the SAME skin tone as the face. This is the single most common mistake to avoid: do NOT leave hands, fingers or arms paler or a different colour than the face.
- HAIR: give them the SAME hairstyle as in the photograph. Look carefully at the photo and copy the hair's real length, cut, shape, volume, hairline and colour. Match the LENGTH precisely: if the child in the photo has SHORT hair that does not cover the ears or reach the neck, draw short hair that does not cover the ears or reach the neck — do NOT lengthen it into a bob, chin-length or longer style. If the photo shows long hair, draw long hair. If the original illustration has a different hairstyle, or any headband, hair clip, ribbon or hair accessory that this child does NOT have in the photo, REMOVE it completely and redraw the hair from scratch to match the photo. Do not keep the illustration's original hair length or shape.

KEEP everything else identical to the first illustration: the same scene, the same pose and body position, the same clothing (other than hair accessories), the same background, the same composition and camera angle, and the identical soft painterly children's book illustration art style — except for the facial proportions above, which must stay realistically human even where the original art is more stylised.`;

// google/nano-banana's `aspect_ratio` input defaults to "match_input_image", but
// `image_input` carries TWO images (the template crop AND the child's photo) and
// it resolves against the PHOTO. Measured: a 0.80 portrait crop with a 1.50 photo
// returned a 1.50 landscape frame; nano-banana re-composed the scene to fill it
// and the face shrank from 32.7% to 19.8% of frame width, at which point the swap
// model's detector failed 5/5. A square photo on the same page distorted less and
// swapped fine. Left alone, whether a page renders depends on the shape of the
// selfie a parent happens to upload. Pinning the ratio to the template crop makes
// output geometry independent of the photo. The input is an enum, so snap to the
// nearest supported value.
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

// Repaint is billed per image regardless of how many times the same
// template+photo pair is repainted, and dev/demo runs re-test the same pair
// repeatedly while tuning the later stages — so cache the output on disk, keyed
// by exactly what determines it: model, prompt, cropped template bytes, photo.
//
// In production this key never repeats (childPhotoUrl mints a fresh signed URL
// per call), so the cache simply never fires there; production's dedup is the
// worker's page-level objectExists() skip, which already avoids re-paying for an
// already-rendered page.
const REPAINT_CACHE_DIR = path.resolve(process.cwd(), ".cache/repaint");

function cacheKey(templateBuf: Buffer, photoUri: string, model: RepaintModel): string {
  return createHash("sha256").update(model).update(REPAINT_PROMPT).update(templateBuf).update(photoUri).digest("hex");
}

/** Redraw `templateBuf` as the child in `photoUri`. */
export async function repaintScene(
  templateBuf: Buffer,
  photoUri: string,
  model: RepaintModel = "nano-banana",
): Promise<Buffer> {
  const cacheFile = path.join(REPAINT_CACHE_DIR, `${cacheKey(templateBuf, photoUri, model)}.png`);
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
