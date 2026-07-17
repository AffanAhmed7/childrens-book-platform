// Personalize ONE template with ONE real kid photo — the proven demo recipe.
//
//   npx tsx demo/personalize.mts <templateKey> <photo.jpg> <out.png> [--no-swap]
//
// templateKey is one of the keys in TEMPLATES below (plane | astronaut | workshop),
// which also carries the crop that removes the competitor UI chrome baked into
// the source images.
//
// RECIPE (why this and not the others — see docs/DEMO_PLAN.md):
//   1. google/nano-banana  — repaint the WHOLE scene as this kid. It SEES the
//      photo, so any kid works with a generic prompt (no per-kid hair/skin text).
//      It redraws cohesively → no seams, no halos (unlike masked inpainting).
//      ~$0.039.
//   2. codeplugtech/face-swap — sharpen identity to exactly this child. ~$0.006.
//   Total ~$0.045/image, 2 calls, ~20s.
//
// Cheaper-but-brittle alternative (flux-kontext, ~$0.031) is documented in
// DEMO_PLAN.md; it needs a per-kid text description and broke style on the
// astronaut, so it is NOT the demo path.
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import "dotenv/config";

const FACE_SWAP_VERSION = "278a81e7ebb22db98bcba54de985d22cc1abeead2754eb1f2af717247be69b34";
const CODEFORMER_VERSION = "cc4956dd26fa5a7185d5660cc9100fab1b8070a1d1654a8bb5eb6d443b020bb2";
const token = process.env.REPLICATE_API_TOKEN;
if (!token) throw new Error("REPLICATE_API_TOKEN missing (run from apps/api with .env present)");

// Per-template crop that strips the competitor app chrome (French buttons, the
// ">" carousel arrow) baked into the pixels. Verify these against the actual
// files before the demo — see DEMO_PLAN.md "chrome crops".
const TEMPLATES: Record<string, { file: string; crop?: { left: number; top: number; width: number; height: number } }> = {
  plane: { file: "../../assets/templates/temp_2.jpeg", crop: { left: 0, top: 112, width: 810, height: 649 } },
  astronaut: { file: "../../assets/templates/temp_1.jpeg", crop: { left: 0, top: 0, width: 800, height: 750 } },
  workshop: { file: "../../assets/templates/WhatsApp Image 2026-07-16 at 8.50.37 AM (2).jpeg", crop: { left: 0, top: 0, width: 800, height: 739 } }, // crop removes the ">" carousel arrow (verified)
};

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [templateKey, photoPath, outPath] = args;
const doSwap = !process.argv.includes("--no-swap");
// --restore: run CodeFormer face-restoration after the swap to blend away the
// "double eye" ghost the swap can leave on the illustrated face.
const doRestore = process.argv.includes("--restore");
// --repaint-from <path>: skip the nano-banana call and reuse an existing repaint
// as the step-1 output (so you can re-run only the swap without paying to repaint).
const repaintFromIdx = process.argv.indexOf("--repaint-from");
const repaintFrom = repaintFromIdx !== -1 ? process.argv[repaintFromIdx + 1] : undefined;
const tpl = TEMPLATES[templateKey];
if (!tpl || !photoPath || !outPath) {
  console.error(`usage: npx tsx demo/personalize.mts <${Object.keys(TEMPLATES).join("|")}> <photo> <out.png> [--no-swap]`);
  process.exit(1);
}

const dataUri = (buf: Buffer, ext = "png") => `data:image/${ext};base64,${buf.toString("base64")}`;

async function replicate(path: string, payload: Record<string, unknown>): Promise<string> {
  // Version-based `predictions` endpoint wants { version, input } at top level;
  // model-scoped `models/.../predictions` wants just { input }. Detect by `version`.
  const body = "version" in payload ? payload : { input: payload };
  const res = await fetch(`https://api.replicate.com/v1/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "wait" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Replicate ${path} -> ${res.status}: ${await res.text()}`);
  let pred = await res.json();
  while (!["succeeded", "failed", "canceled"].includes(pred.status)) {
    await new Promise((r) => setTimeout(r, 2000));
    pred = await (await fetch(pred.urls.get, { headers: { Authorization: `Bearer ${token}` } })).json();
  }
  if (pred.status !== "succeeded" || !pred.output) throw new Error(`failed: ${pred.error ?? ""}\n${(pred.logs ?? "").slice(-300)}`);
  const url = Array.isArray(pred.output) ? pred.output[0] : pred.output;
  return url;
}

// --- Prepare template (crop chrome) + photo ---
let templateBuf = await readFile(tpl.file);
if (tpl.crop) templateBuf = await sharp(templateBuf).extract(tpl.crop).png().toBuffer();
const photoBuf = await readFile(photoPath);
const photoExt = photoPath.toLowerCase().endsWith(".png") ? "png" : "jpeg";

// --- Step 1: nano-banana repaint (generic prompt — it sees the photo) ---
let resultBuf: Buffer;
if (repaintFrom) {
  console.log(`1/2 repaint reused from ${repaintFrom} (no nano-banana call)`);
  resultBuf = await readFile(repaintFrom);
} else {
  console.log("1/2 repaint (google/nano-banana) ...");
  const prompt = `The first image is a children's book illustration of a child. The second image is a photograph of a real child. Redraw the illustrated child so they clearly and recognisably become the specific child in the photograph.

CHANGE these to match the photograph exactly:
- FACE: same face shape, features, skin tone and proportions as the photo, so it is unmistakably this specific child (keep a warm children's-book expression).
- SKIN TONE: match the child's skin colour from the photo across ALL visible skin — face, ears, neck, hands and arms. The hands and arms must be the SAME skin tone as the face; do NOT leave them the illustration's original lighter tone.
- HAIR: give them the SAME hairstyle as in the photograph. Look carefully at the photo and copy the hair's real length, cut, shape, volume, hairline and colour. Match the LENGTH precisely: if the child in the photo has SHORT hair that does not cover the ears or reach the neck, draw short hair that does not cover the ears or reach the neck — do NOT lengthen it into a bob, chin-length or longer style. If the photo shows long hair, draw long hair. If the original illustration has a different hairstyle, or any headband, hair clip, ribbon or hair accessory that this child does NOT have in the photo, REMOVE it completely and redraw the hair from scratch to match the photo. Do not keep the illustration's original hair length or shape.

KEEP everything else identical to the first illustration: the same scene, the same pose and body position, the same clothing (other than hair accessories), the same background, the same composition and camera angle, and the identical soft painterly children's book illustration art style.`;
  const repaintUrl = await replicate("models/google/nano-banana/predictions", {
    prompt,
    image_input: [dataUri(templateBuf), dataUri(photoBuf, photoExt)],
    output_format: "png",
  });
  resultBuf = Buffer.from(await (await fetch(repaintUrl)).arrayBuffer());
  // Persist the repaint immediately so a step-2 failure never wastes it —
  // re-run with `--repaint-from <this file>` to retry only the swap.
  await writeFile(`${outPath}.repaint.png`, resultBuf);
}

// --- Step 2: face-swap for exact identity ---
if (doSwap) {
  console.log(`2/${doRestore ? 3 : 2} identity (codeplugtech/face-swap) ...`);
  const swapUrl = await replicate("predictions", {
    version: FACE_SWAP_VERSION,
    input: { input_image: dataUri(resultBuf), swap_image: dataUri(photoBuf, photoExt) },
  });
  resultBuf = Buffer.from(await (await fetch(swapUrl)).arrayBuffer());
} else {
  console.log("2/2 skipped (--no-swap) — nano-banana only, weaker identity");
}

// --- Step 3 (optional): face restoration to blend away swap "double-eye" ---
// High codeformer_fidelity keeps it close to the painterly face (less photographic
// drift); background_enhance off so only the face region is touched.
if (doSwap && doRestore) {
  await writeFile(`${outPath}.swapped.png`, resultBuf); // keep pre-restore, in case restore over-realifies
  console.log("3/3 restore (sczhou/codeformer) ...");
  const restoreUrl = await replicate("predictions", {
    version: CODEFORMER_VERSION,
    input: { image: dataUri(resultBuf), codeformer_fidelity: 0.8, background_enhance: false, face_upsample: false, upscale: 1 },
  });
  resultBuf = Buffer.from(await (await fetch(restoreUrl)).arrayBuffer());
}

await writeFile(outPath, resultBuf);
const cost = repaintFrom ? "0.006" : doSwap ? (doRestore ? "0.05" : "0.045") : "0.039";
console.log(`done -> ${outPath}  (~$${cost})`);
