// Feed N kid/adult photos, get every multi-character page personalized —
// the multi-character counterpart to demo/personalize-scene.mts. That script
// drives ONE photo through personalizeScene across SCENES (single drawn
// character per page); this one drives MULTIPLE photos through
// personalizePage across MULTI_SCENES (multiple drawn characters per page).
// Both pipelines are kept side by side deliberately — a book can mix
// single- and multi-character pages, and each has its own proven recipe path.
//
//   npx tsx demo/personalize-book.mts <photo1> <photo2> [...] [--scene mc_2|mc_3|all] [--out <dir>] [--debug] [--lite] [--no-swap]
//
// Photos map to the drawn characters in left-to-right order (same convention
// as personalize-page.mts) and that mapping is used for EVERY scene in the
// run — all MULTI_SCENES entries currently share the same 2-characters,
// left-to-right cast. Default runs all multi-character scenes (mc_2, mc_3).
// --debug also writes each character's intermediate stages per scene.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { MULTI_SCENES, getMultiScene } from "../src/pipeline/scenes";
import { personalizePage, type RepaintModel } from "../src/pipeline/scene";
import type { BookPage } from "../src/pipeline/templates";
import type { CharacterInput } from "../src/pipeline/types";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
};
const sceneArg = flag("--scene") ?? "all";
const outDir = flag("--out") ?? "demo/output";
const debug = argv.includes("--debug");
const lite = argv.includes("--lite");
// --no-swap stops after the repaint (no swap/restore/heal). The repaint already
// SEES the photo, so it carries likeness on its own; skipping the swap trades
// some identity sharpness for the elimination of the swap's eye-geometry
// artifact — a small realistic eye composited into the repaint's larger cartoon
// eye socket leaves the original iris visible as a dark ring. Output goes to
// <scene>.norepaintswap.png so it never overwrites the swapped result.
const noSwap = argv.includes("--no-swap");
const repaintModel: RepaintModel = lite ? "nano-banana-2-lite" : "nano-banana";

const outValue = flag("--out");
const sceneValue = flag("--scene");
const positionals = argv.filter(
  (a, i) =>
    !a.startsWith("--") &&
    !(outValue !== undefined && argv[i - 1] === "--out") &&
    !(sceneValue !== undefined && argv[i - 1] === "--scene"),
);
const photoPaths = positionals;

if (photoPaths.length === 0) {
  console.error(
    "usage: npx tsx demo/personalize-book.mts <photo1> [photo2 ...] [--scene mc_2|mc_3|all] [--out <dir>] [--debug] [--lite] [--no-swap]",
  );
  process.exit(1);
}

const keys = sceneArg === "all" ? Object.keys(MULTI_SCENES) : [sceneArg];
await mkdir(outDir, { recursive: true });

const dataUri = (buf: Buffer, ext: string) => `data:image/${ext};base64,${buf.toString("base64")}`;
const characters: CharacterInput[] = await Promise.all(
  photoPaths.map(async (p, i) => ({
    slot: `child_${i + 1}`,
    photoUrl: dataUri(await readFile(p), p.toLowerCase().endsWith(".png") ? "png" : "jpeg"),
  })),
);

for (const key of keys) {
  const scene = getMultiScene(key);
  const page: BookPage = {
    id: scene.id,
    imagePath: scene.imagePath,
    slots: characters.map((c) => c.slot),
    expectedCharacterCount: scene.expectedCharacterCount,
  };
  console.log(`\n=== ${key}${lite ? " (nano-banana-2-lite)" : ""} ===`);
  const t0 = Date.now();
  const stageCounts = new Map<string, number>();
  const out = await personalizePage(page, characters, {
    repaintModel,
    swap: !noSwap,
    onStage: async (stage, buf) => {
      const n = (stageCounts.get(stage) ?? 0) + 1;
      stageCounts.set(stage, n);
      if (debug) await writeFile(path.join(outDir, `${key}${lite ? ".lite" : ""}.${stage}.${n}.png`), buf);
      console.log(`  ${stage} ok (character ${n})`);
    },
  });
  const outPath = path.join(outDir, `${key}${lite ? ".lite" : ""}${noSwap ? ".noswap" : ""}.png`);
  await writeFile(outPath, out);
  console.log(`  -> ${outPath}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
console.log("\ndone");
