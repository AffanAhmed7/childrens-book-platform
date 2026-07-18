// Feed ONE page + ONE photo PER DRAWN CHARACTER, get the finished page out —
// drives src/pipeline/scene.ts's personalizePage (the multi-character path).
//
//   npx tsx demo/personalize-page.mts <page-image> <photo1> <photo2> [...] [--out <dir>] [--debug] [--detect-only] [--lite]
//
// Photos map to the DRAWN characters in left-to-right order, so pass them in the
// order they appear on the page.
//
//   # free, no API calls — confirm detection before spending credits
//   npx tsx demo/personalize-page.mts ../../assets/templates/MC_1.jpeg \
//     ../../assets/test-photos/3.jpg ../../assets/test-photos/man.png --detect-only
//
// --detect-only runs just the local blazeface pass and writes the crops that
// WOULD be repainted (plus a boxes overlay), so the crop framing and the
// left-to-right assignment can be checked for $0.
// --debug also writes each character's intermediate stages. Stage frames are
// numbered per character in completion order (personalizePage's onStage doesn't
// say which character a frame belongs to), so <stage>.1/.2 is completion order,
// not necessarily left-to-right.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { detectPageCharacters } from "../src/pipeline/faceDetect";
import { characterCrop, personalizePage, type RepaintModel } from "../src/pipeline/scene";
import type { BookPage } from "../src/pipeline/templates";
import type { CharacterInput } from "../src/pipeline/types";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
};
const outDir = flag("--out") ?? "demo/output";
const debug = argv.includes("--debug");
const detectOnly = argv.includes("--detect-only");
const lite = argv.includes("--lite");
const repaintModel: RepaintModel = lite ? "nano-banana-2-lite" : "nano-banana";

// Positionals, minus the values consumed by --out.
const outValue = flag("--out");
const positionals = argv.filter((a, i) => !a.startsWith("--") && !(outValue !== undefined && argv[i - 1] === "--out"));
const [pagePath, ...photoPaths] = positionals;

if (!pagePath || photoPaths.length === 0) {
  console.error("usage: npx tsx demo/personalize-page.mts <page-image> <photo1> [photo2 ...] [--out <dir>] [--debug] [--detect-only] [--lite]");
  process.exit(1);
}

const pageId = path.basename(pagePath, path.extname(pagePath)).toLowerCase();
await mkdir(outDir, { recursive: true });

// Photos become data URIs — the same shape production passes as a signed URL.
const dataUri = (buf: Buffer, ext: string) => `data:image/${ext};base64,${buf.toString("base64")}`;
const characters: CharacterInput[] = await Promise.all(
  photoPaths.map(async (p, i) => ({
    slot: `child_${i + 1}`,
    photoUrl: dataUri(await readFile(p), p.toLowerCase().endsWith(".png") ? "png" : "jpeg"),
  })),
);

// Explicit slots: drawn character i (left-to-right) gets photo i.
const page: BookPage = { id: pageId, imagePath: pagePath, slots: characters.map((c) => c.slot) };

const original = await readFile(pagePath);
const meta = await sharp(original).metadata();
const faces = await detectPageCharacters(original);

console.log(`page ${pageId}  ${meta.width}x${meta.height}`);
console.log(`detected ${faces.length} drawn character(s), left-to-right:`);
faces.forEach((f, i) => {
  const photo = photoPaths[i];
  console.log(
    `  ${i + 1}. box=[${f.left},${f.top} ${f.width}x${f.height}]  <- ${photo ?? "(no photo — left as drawn)"}`,
  );
});
if (faces.length !== photoPaths.length) {
  console.warn(`WARNING: ${faces.length} face(s) detected but ${photoPaths.length} photo(s) given — extras are ignored.`);
}

if (detectOnly) {
  // Same crop geometry personalizePage uses (characterCrop clamps each crop to
  // the midpoint between neighbouring faces), so what's written here is exactly
  // what would be sent to repaint.
  const boxes: sharp.OverlayOptions[] = [];
  for (const [i, face] of faces.entries()) {
    const crop = characterCrop(face, faces, meta.width ?? 0, meta.height ?? 0);
    const cropPath = path.join(outDir, `${pageId}.crop.${i + 1}.png`);
    await writeFile(cropPath, await sharp(original).extract(crop).png().toBuffer());
    console.log(`  -> ${cropPath}  (crop [${crop.left},${crop.top} ${crop.width}x${crop.height}])`);
    const outline = Buffer.from(
      `<svg width="${crop.width}" height="${crop.height}"><rect x="1" y="1" width="${crop.width - 2}" height="${crop.height - 2}" fill="none" stroke="#ff0000" stroke-width="4"/></svg>`,
    );
    boxes.push({ input: outline, left: crop.left, top: crop.top });
  }
  const boxesPath = path.join(outDir, `${pageId}.boxes.png`);
  await writeFile(boxesPath, await sharp(original).composite(boxes).png().toBuffer());
  console.log(`  -> ${boxesPath}  (crop rectangles overlaid)`);
  console.log("\ndetect-only: no API calls made, no credits spent");
  process.exit(0);
}

const stageCounts = new Map<string, number>();
const t0 = Date.now();
const out = await personalizePage(page, characters, {
  repaintModel,
  onStage: async (stage, buf) => {
    const n = (stageCounts.get(stage) ?? 0) + 1;
    stageCounts.set(stage, n);
    if (debug) await writeFile(path.join(outDir, `${pageId}${lite ? ".lite" : ""}.${stage}.${n}.png`), buf);
    console.log(`  ${stage} ok (character ${n} of ${faces.length} to finish this stage)`);
  },
});

const outPath = path.join(outDir, `${pageId}${lite ? ".lite" : ""}.png`);
await writeFile(outPath, out);
console.log(`\n-> ${outPath}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
